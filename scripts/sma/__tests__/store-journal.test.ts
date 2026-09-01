/**
 * Tests for scripts/sma/lib/store-journal.mjs — ВАХТА НА СКЛАДЕ ЗАВИСИМОСТЕЙ.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. 01.09.2026 склад зависимостей человека опустел в ЧЕТВЁРТЫЙ
 * раз за двое суток, и оба отказа стража (`deps-guard`) при этом не сработали: потрошил не
 * тот, чей путь закрыт. Леджер живой попытки сохранил следы ПОСЛЕ — в 10:10:32Z каталога
 * `node_modules/.bin` основного дерева уже не было, в 10:11:15Z в складе `.pnpm` не было
 * `@jridgewell+sourcemap-codec@1.5.5`, — и ни одной записи о том, что шло в ту минуту.
 * Вахта заводится ровно ради этого промежутка, и проверяется здесь ровно он.
 *
 * ЗДЕСЬ НАСТОЯЩИЕ ССЫЛКИ, А НЕ ПОДДЕЛКА ФАЙЛОВОЙ СИСТЕМЫ: главное обещание вахты — «журнал
 * лежит у СКЛАДА, а не у того, кто смотрит», — целиком держится на том, что `node_modules`
 * копии есть ссылка и цель читается. Подделка, отвечающая «да, ссылка», проверяла бы себя.
 *
 * Песочницы одноразовые (`mkdtemp`), уносятся целиком, и ни одно рабочее дерево в этом
 * файле не участвует.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import {
  storeOwnerOf,
  censusStore,
  noteStoreAccess,
  readStoreJournal,
  storeLosses,
  blameSentence,
  STORE_JOURNAL_REL,
  STORE_SEEN_REL,
} from '../lib/store-journal.mjs'

const IS_WIN = process.platform === 'win32'

let sandbox: string
let mainTree: string
let copyTree: string

/** A dependency directory attached BY REFERENCE — exactly as provisioning attaches it. */
function link(target: string, at: string): void {
  mkdirSync(dirname(at), { recursive: true })
  symlinkSync(target, at, IS_WIN ? 'junction' : 'dir')
}

/** One entry of the pnpm store, in the layout pnpm actually writes. */
function storeEntry(root: string, name: string): void {
  mkdirSync(join(root, 'node_modules', '.pnpm', name, 'node_modules'), { recursive: true })
}

/** A clock the test drives, so every timestamp in the journal is a stated fact. */
function clockFrom(startMs: number): () => number {
  let t = startMs
  return () => {
    t += 1000
    return t
  }
}

/**
 * The shape of this machine: a main tree that OWNS the store, and a copy that carries it
 * as a link — which is why the copy's `node_modules` reaches the main tree's files.
 */
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'sma-store-journal-'))
  mainTree = join(sandbox, 'sma')
  copyTree = join(sandbox, 'wt-copy')
  mkdirSync(join(mainTree, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(mainTree, 'package.json'), JSON.stringify({ name: 'main', devDependencies: { vitest: '^4' } }))
  storeEntry(mainTree, '@jridgewell+sourcemap-codec@1.5.5')
  storeEntry(mainTree, 'magic-string@0.30.21')
  storeEntry(mainTree, 'vitest@4.1.10')
  mkdirSync(copyTree, { recursive: true })
  writeFileSync(join(copyTree, 'package.json'), JSON.stringify({ name: 'copy' }))
  link(join(mainTree, 'node_modules'), join(copyTree, 'node_modules'))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('storeOwnerOf — чей склад читает этот каталог', () => {
  it('из копии владельцем назван ОСНОВНОЕ дерево, а не копия', () => {
    const owner = storeOwnerOf({ cwd: copyTree })
    expect(owner).not.toBeNull()
    expect(owner!.viaLink).toBe(true)
    expect(owner!.root.toLowerCase()).toBe(mainTree.replace(/\\/g, '/').toLowerCase())
  })

  it('в дереве со своим настоящим складом владелец — оно само', () => {
    const owner = storeOwnerOf({ cwd: mainTree })
    expect(owner!.viaLink).toBe(false)
    expect(owner!.root.toLowerCase()).toBe(mainTree.replace(/\\/g, '/').toLowerCase())
  })

  it('склада нет вовсе — владельца нет, и вахте не над чем стоять', () => {
    expect(storeOwnerOf({ cwd: sandbox })).toBeNull()
  })
})

describe('censusStore — перепись склада', () => {
  it('переписывает и корень, и .pnpm', () => {
    const c = censusStore({ root: mainTree })!
    expect(c.names).toContain('node_modules/.pnpm/@jridgewell+sourcemap-codec@1.5.5')
    expect(c.names).toContain('node_modules/.bin')
  })

  it('кэш сборщика не считается записью склада — иначе журнал утонет в шуме', () => {
    mkdirSync(join(mainTree, 'node_modules', '.vite-temp'), { recursive: true })
    const c = censusStore({ root: mainTree })!
    expect(c.names.some((n) => n.includes('.vite-temp'))).toBe(false)
  })

  it('дерева без склада не описывает вовсе', () => {
    expect(censusStore({ root: sandbox })).toBeNull()
  })
})

describe('вахта: пропажа записи называет ПРОМЕЖУТОК, в котором она случилась', () => {
  it('первое наблюдение — база, а не событие: журнала ещё нет', () => {
    const res = noteStoreAccess({ cwd: mainTree, command: 'git status', actor: 'Окно-1', pid: 11, clock: clockFrom(0) })
    expect(res.recorded).toBe(false)
    expect(existsSync(join(mainTree, ...STORE_JOURNAL_REL.split('/')))).toBe(false)
    expect(existsSync(join(mainTree, ...STORE_SEEN_REL.split('/')))).toBe(true)
  })

  it('склад не изменился — строки нет, но отметка «видел целым» переезжает на нового наблюдателя', () => {
    const clock = clockFrom(0)
    noteStoreAccess({ cwd: mainTree, command: 'git status', actor: 'Окно-1', pid: 11, clock })
    const res = noteStoreAccess({ cwd: mainTree, command: 'npx vitest run', actor: 'попытка-1', pid: 22, clock })
    expect(res.recorded).toBe(false)
    expect(readStoreJournal({ root: mainTree }).entries).toHaveLength(0)
    const seen = JSON.parse(readFileSync(join(mainTree, ...STORE_SEEN_REL.split('/')), 'utf8'))
    expect(seen.command).toBe('npx vitest run')
    expect(seen.actor).toBe('попытка-1')
    expect(seen.pid).toBe(22)
  })

  it('запись исчезла — одна строка журнала называет пропажу, прошлую команду и нынешнюю', () => {
    const clock = clockFrom(0)
    noteStoreAccess({ cwd: mainTree, command: 'git status', actor: 'Окно-1', pid: 11, clock })
    noteStoreAccess({ cwd: mainTree, command: 'npx vitest run tests', actor: 'попытка-1', pid: 22, clock })
    // ровно то, что случилось 01.09: из склада исчезла ОДНА запись
    rmSync(join(mainTree, 'node_modules', '.pnpm', '@jridgewell+sourcemap-codec@1.5.5'), { recursive: true, force: true })
    const res = noteStoreAccess({ cwd: mainTree, command: 'node vitest.mjs run', actor: 'попытка-1', pid: 22, clock })

    expect(res.recorded).toBe(true)
    expect(res.gone).toEqual(['node_modules/.pnpm/@jridgewell+sourcemap-codec@1.5.5'])
    expect(res.came).toEqual([])
    expect(res.entry!.lastIntact.command).toBe('npx vitest run tests')
    expect(res.entry!.lastIntact.pid).toBe(22)
    expect(res.entry!.seenBy.command).toBe('node vitest.mjs run')

    const journal = readStoreJournal({ root: mainTree })
    expect(journal.entries).toHaveLength(1)
    expect(journal.corrupt).toBe(0)
    const sentence = blameSentence(journal.entries[0])
    expect(sentence).toContain('@jridgewell+sourcemap-codec@1.5.5')
    expect(sentence).toContain('npx vitest run tests')
  })

  it('пришедшая запись — это установка, а не потрошение: в пропажи не попадает', () => {
    const clock = clockFrom(0)
    noteStoreAccess({ cwd: mainTree, command: 'git status', actor: 'Окно-1', pid: 11, clock })
    storeEntry(mainTree, 'picocolors@1.1.1')
    const res = noteStoreAccess({ cwd: mainTree, command: 'pnpm install', actor: 'Окно-1', pid: 11, clock })
    expect(res.came).toEqual(['node_modules/.pnpm/picocolors@1.1.1'])
    expect(storeLosses({ root: mainTree })).toHaveLength(0)
  })

  it('наблюдение ИЗ КОПИИ пишет в журнал ВЛАДЕЛЬЦА — иначе соседняя команда не попадёт в один журнал', () => {
    const clock = clockFrom(0)
    noteStoreAccess({ cwd: copyTree, command: 'git log', actor: 'попытка-2', pid: 33, clock })
    rmSync(join(mainTree, 'node_modules', '.bin'), { recursive: true, force: true })
    const res = noteStoreAccess({ cwd: copyTree, command: 'npx vitest run', actor: 'попытка-2', pid: 33, clock })

    expect(res.owner!.toLowerCase()).toBe(mainTree.replace(/\\/g, '/').toLowerCase())
    expect(res.gone).toEqual(['node_modules/.bin'])
    expect(existsSync(join(copyTree, ...STORE_JOURNAL_REL.split('/')))).toBe(false)
    expect(storeLosses({ root: mainTree })).toHaveLength(1)
  })

  it('копия и основное дерево пишут в ОДИН журнал — промежуток сшивается через две сессии', () => {
    const clock = clockFrom(0)
    noteStoreAccess({ cwd: mainTree, command: 'pnpm install', actor: 'Окно-1', pid: 11, clock })
    rmSync(join(mainTree, 'node_modules', '.pnpm', 'magic-string@0.30.21'), { recursive: true, force: true })
    const res = noteStoreAccess({ cwd: copyTree, command: 'npx vitest run', actor: 'попытка-2', pid: 33, clock })
    expect(res.entry!.lastIntact.actor).toBe('Окно-1')
    expect(res.entry!.seenBy.actor).toBe('попытка-2')
  })
})

describe('вахта не имеет права никого остановить', () => {
  it('сломанная файловая система — «ничего не записано», а не исключение', () => {
    const broken = {
      lstatSync: () => {
        throw new Error('диск отвалился')
      },
    }
    expect(() => noteStoreAccess({ cwd: mainTree, command: 'ls', fsImpl: broken as never })).not.toThrow()
    expect(noteStoreAccess({ cwd: mainTree, command: 'ls', fsImpl: broken as never }).recorded).toBe(false)
  })

  it('битая строка журнала пропускается и считается, а не роняет чтение', () => {
    const path = join(mainTree, ...STORE_JOURNAL_REL.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{"gone":["node_modules/.bin"]}\nне json\n')
    const journal = readStoreJournal({ root: mainTree })
    expect(journal.entries).toHaveLength(1)
    expect(journal.corrupt).toBe(1)
  })

  it('журнала нет — пустой ответ, а не отказ', () => {
    expect(readStoreJournal({ root: sandbox })).toEqual({ entries: [], corrupt: 0 })
    expect(storeLosses({ root: sandbox })).toEqual([])
  })
})
