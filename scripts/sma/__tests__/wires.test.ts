/**
 * Тесты сборщика описи связей (scripts/sma/lib/wires.mjs).
 *
 * Прибор этого рода врёт по умолчанию, и это не фигура речи: замер описи, повторённый
 * тремя пробниками, дал три разных числа. Поэтому сборщик закрывается тестами ровно на
 * те места, где он способен соврать незаметно:
 *   (а) счёт трёх форм — структурные связи, записи artifacts, проза;
 *   (б) дискриминатор — один и тот же текст плана даёт РАЗНЫЕ вердикты в зависимости
 *       от наличия парной сводки, и «сводки нет» это молчание, а не зелень;
 *   (в) резолюция путей с переписыванием чужого корня;
 *   (г) каталог планов не сканируется — след, найденный в собственном объявлении,
 *       это не след;
 *   (д) корень, которым дали одиночный ФАЙЛ, читается, а не пропускается молча;
 *   (е) опись читает ОДИН парсер: ручной разбор текста совпадает с разбором сборщика.
 * Плюс замок от пустоты: опись, из которой ничего не распарсилось, обязана краснеть,
 * а не рапортовать «претензий ноль».
 *
 * Все фикстуры синтетические — ни одного реального имени, ни одного номера.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectInventory,
  collectScanFiles,
  planStatus,
  resolveDeclaredPath,
  applyRewrites,
  compilePattern,
  PLAN_STATUS,
  DEFAULT_SCAN_ROOTS,
  WALK_EXCLUSIONS,
  PLANS_ARE_NOT_CODE,
} from '../lib/wires.mjs'

const FIXTURES = fileURLToPath(new URL('../fixtures/wires/', import.meta.url))

/**
 * Каталоги одной фикстуры. Корень обхода — ВЕСЬ каталог случая, и планы лежат внутри
 * него: ровно так устроено настоящее дерево, и только так исключение каталога планов
 * несёт нагрузку. Прогон с корнем `tree` проходил бы и без исключения — то есть впустую.
 */
function caseDirs(name: string) {
  const root = join(FIXTURES, name)
  return { root, plansDir: join(root, 'plans'), treeDir: root, roots: ['.'] }
}

function collect(name: string, extra: Record<string, unknown> = {}) {
  const { plansDir, treeDir, roots } = caseDirs(name)
  return collectInventory({ plansDir, treeDir, roots, ...extra })
}

/** Текст блока must_haves из frontmatter — для сравнения «текст тот же, вердикт другой». */
function mustHavesBlock(planPath: string): string {
  const text = readFileSync(planPath, 'utf8').replace(/\r\n/g, '\n')
  const from = text.indexOf('must_haves:')
  const end = text.indexOf('\n---\n', from)
  return text.slice(from, end === -1 ? undefined : end)
}

describe('сборщик описи — счёт трёх форм (а)', () => {
  it('на живой фикстуре собрано ровно столько, сколько объявлено, в каждой из трёх форм', () => {
    const inv = collect('live')

    expect(inv.counts.plans).toBe(1)
    expect(inv.counts.links, 'две структурные связи объявлены').toBe(2)
    expect(inv.counts.artifacts, 'две записи path+contains объявлены').toBe(2)
    expect(inv.counts.prose, 'две строки прозой объявлены').toBe(2)
    expect(inv.counts.patternless, 'записей без следа в фикстуре нет').toBe(0)

    // ЗАМОК ОТ ПУСТОТЫ. Сборщик, чей разбор перестал что-либо находить, зеленеет молча —
    // ровно так сторож перестаёт сторожить, и никто этого не замечает.
    expect(inv.counts.links).toBeGreaterThan(0)
    expect(inv.counts.artifacts).toBeGreaterThan(0)
    expect(inv.counts.prose).toBeGreaterThan(0)
    expect(inv.counts.scanFiles).toBeGreaterThan(0)

    expect(inv.links.map((l: { pattern: string }) => l.pattern)).toEqual([
      'WIRE_MARKER_ALPHA',
      'WIRE_MARKER_DECLARED_ONLY',
    ])
    expect(inv.prose.every((p: { text: string }) => typeof p.text === 'string')).toBe(true)
  })

  it('проза остаётся прозой: она СЧИТАЕТСЯ и названа, но не попадает в проверяемые связи', () => {
    const inv = collect('live')
    const proseText = inv.prose.map((p: { text: string }) => p.text).join(' | ')
    expect(proseText).toContain('прозой')
    // Ни одна прозаическая строка не притворилась структурной записью.
    for (const link of inv.links) {
      expect(typeof link.pattern).toBe('string')
      expect(link.pattern).not.toContain('прозой')
    }
  })

  it('соседний корпус запретов назван числом и НЕ проверяется этой командой', () => {
    const inv = collect('live')
    expect(inv.counts.prohibitionsPlans).toBe(1)
    // Никакого вердикта по запретам сборщик не выносит — только счёт.
    expect(inv).not.toHaveProperty('prohibitionVerdicts')
  })
})

describe('дискриминатор статуса — только парная сводка (б)', () => {
  it('один и тот же блок must_haves даёт РАЗНЫЕ вердикты: со сводкой судим, без — молчание', () => {
    const closed = collect('closed-dead')
    const notBuilt = collect('not-built')

    // Тексты объявлений совпадают буква в букву — иначе тест доказывал бы не то.
    expect(mustHavesBlock(closed.plans[0].path)).toBe(mustHavesBlock(notBuilt.plans[0].path))

    expect(closed.plans[0].status).toBe(PLAN_STATUS.closed)
    expect(closed.plans[0].summaryPath).toBeTruthy()
    expect(notBuilt.plans[0].status).toBe(PLAN_STATUS.ahead)
    expect(notBuilt.plans[0].summaryPath).toBeNull()

    // Статус доезжает до КАЖДОЙ записи — вердикт выносится попланово, не пофазно.
    expect(closed.links.every((l: { planStatus: string }) => l.planStatus === PLAN_STATUS.closed)).toBe(true)
    expect(notBuilt.links.every((l: { planStatus: string }) => l.planStatus === PLAN_STATUS.ahead)).toBe(true)
    expect(closed.artifacts.every((a: { planStatus: string }) => a.planStatus === PLAN_STATUS.closed)).toBe(true)
    expect(notBuilt.artifacts.every((a: { planStatus: string }) => a.planStatus === PLAN_STATUS.ahead)).toBe(true)

    // «Работа впереди» — это НЕ зелень: план без сводки не попал в закрытые.
    expect(notBuilt.counts.plansClosed).toBe(0)
    expect(notBuilt.counts.plansAhead).toBe(1)
  })

  it('дискриминатор смотрит на файл рядом и ни на что больше', () => {
    const { plansDir } = caseDirs('not-built')
    const plan = join(plansDir, 'fixture-not-built-PLAN.md')
    expect(planStatus({ planPath: plan }).status).toBe(PLAN_STATUS.ahead)

    // Тот же план, но сводка есть -> закрыт. Никакого другого источника не спрашивали.
    const closedPlan = join(caseDirs('closed-dead').plansDir, 'fixture-closed-dead-PLAN.md')
    expect(planStatus({ planPath: closedPlan })).toMatchObject({ status: PLAN_STATUS.closed })
  })

  it('сводка без парного плана попадает в аномалии, а не теряется', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sma-wires-orphan-'))
    try {
      writeFileSync(join(dir, 'fixture-orphan-SUMMARY.md'), '---\nphase: wires-fixture\n---\n', 'utf8')
      const inv = collectInventory({ plansDir: dir, treeDir: dir, roots: [] })
      expect(inv.counts.orphanSummaries).toBe(1)
      expect(inv.counts.plans).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('резолюция объявленных путей (в)', () => {
  it('путь с чужим префиксом не резолвится без правила и находит файл с правилом', () => {
    const { root } = caseDirs('live')

    const without = collect('live')
    const foreign = without.artifacts.find((a: { declaredPath: string }) =>
      a.declaredPath.startsWith('../synthetic-elsewhere'),
    )
    expect(foreign, 'запись с чужим префиксом обязана быть в описи, а не пропущена').toBeTruthy()
    expect(foreign.resolution.status).toBe('unresolved')
    expect(without.counts.artifactsUnresolved).toBe(1)

    const withRule = collect('live', {
      rewrites: [{ prefix: '../synthetic-elsewhere', target: root }],
    })
    const fixed = withRule.artifacts.find((a: { declaredPath: string }) =>
      a.declaredPath.startsWith('../synthetic-elsewhere'),
    )
    expect(fixed.resolution.status).toBe('resolved')
    expect(fixed.resolution.rewriteApplied).toMatchObject({ prefix: '../synthetic-elsewhere' })
    expect(String(fixed.resolution.resolved)).toContain('alpha.txt')
    expect(withRule.counts.artifactsUnresolved).toBe(0)
  })

  it('переписывание корня: первое совпадение побеждает', () => {
    const first = applyRewrites('../foreign/lib/a.mjs', [
      { prefix: '../foreign', target: 'first' },
      { prefix: '../foreign', target: 'second' },
    ])
    expect(first.value).toBe(join('first', 'lib', 'a.mjs'))
    expect(applyRewrites('lib/a.mjs', []).applied).toBeNull()
  })

  it('нерезолвящийся путь — отдельная категория, а не тихий пропуск', () => {
    const inv = collect('closed-dead')
    const missing = inv.artifacts.find((a: { declaredPath: string }) => a.declaredPath.includes('never-written'))
    expect(missing, 'путь, которого нет, обязан остаться в описи').toBeTruthy()
    expect(missing.resolution.status).toBe('unresolved')
    expect(missing.resolution.candidates.length).toBeGreaterThan(0)
    expect(inv.counts.artifactsUnresolved).toBe(1)
  })

  it('битый след помечен ошибкой разбора — запись не уронена и не выброшена', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sma-wires-badre-'))
    try {
      const plan = join(dir, 'fixture-badpattern-PLAN.md')
      writeFileSync(
        plan,
        [
          '---',
          'phase: wires-fixture',
          'must_haves:',
          '  key_links:',
          '    - from: "tree/a.txt"',
          '      to: "tree/b.txt"',
          '      via: "след, который не компилируется"',
          '      pattern: "([unclosed"',
          '---',
          '',
        ].join('\n'),
        'utf8',
      )
      let inv: ReturnType<typeof collectInventory>
      expect(() => {
        inv = collectInventory({ plansDir: dir, treeDir: dir, roots: [] })
      }).not.toThrow()
      expect(inv!.counts.links).toBe(1)
      expect(inv!.counts.linksWithBadPattern).toBe(1)
      expect(inv!.links[0].patternError).toMatch(/unparseable pattern/)
      expect(compilePattern('([unclosed').regex).toBeNull()
      expect(compilePattern('WIRE_MARKER_ALPHA').error).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('каталог планов не сканируется (г)', () => {
  it('след, встречающийся ТОЛЬКО в тексте плана, не считается найденным в дереве', () => {
    const { plansDir } = caseDirs('live')
    const inv = collect('live')

    const planText = readFileSync(join(plansDir, 'fixture-live-PLAN.md'), 'utf8')
    // Без этой проверки тест был бы пустым: маркер обязан реально стоять в плане.
    expect(planText).toContain('WIRE_MARKER_DECLARED_ONLY')

    // Ни один файл зоны поиска не содержит маркер — и сам план в зону не попал.
    const hits = inv.scanFiles.filter((f: string) => readFileSync(f, 'utf8').includes('WIRE_MARKER_DECLARED_ONLY'))
    expect(hits, 'маркер найден в зоне поиска — значит сканируется каталог планов').toEqual([])
    expect(inv.scanFiles.some((f: string) => f.includes('plans'))).toBe(false)

    // Контроль против «зона поиска пуста, поэтому ничего и не нашлось».
    const alive = inv.scanFiles.filter((f: string) => readFileSync(f, 'utf8').includes('WIRE_MARKER_ALPHA'))
    expect(alive.length).toBeGreaterThan(0)
  })

  it('исключение каталога планов держится даже когда планы лежат ВНУТРИ корня обхода', () => {
    const { root, plansDir } = caseDirs('live')
    // Корень обхода — весь каталог фикстуры, планы внутри него. Если бы исключение
    // работало только на «каталог планов не среди корней», здесь бы оно и слетело.
    const files = collectScanFiles({ roots: ['.'], treeDir: root, plansDir })
    expect(files.length).toBeGreaterThan(0)
    expect(files.some((f: string) => f.endsWith('-PLAN.md'))).toBe(false)
    expect(files.some((f: string) => f.endsWith('alpha.txt'))).toBe(true)
    expect(PLANS_ARE_NOT_CODE).toBe(true)
  })

  it('набор корней и набор исключений — объявленные константы, а не собранные на лету', () => {
    expect(Object.isFrozen(DEFAULT_SCAN_ROOTS)).toBe(true)
    expect(DEFAULT_SCAN_ROOTS.length).toBeGreaterThan(0)
    expect(WALK_EXCLUSIONS.dirNames).toContain('node_modules')
    expect(WALK_EXCLUSIONS.dirNames).toContain('.git')
    expect(WALK_EXCLUSIONS.paths.some((p: string) => p.includes('app'))).toBe(true)
    // Использованный набор корней возвращается в описи — иначе число невоспроизводимо.
    expect(collect('live').roots).toEqual(['.'])
  })
})

describe('корень-файл читается, а не пропускается молча (д)', () => {
  it('одиночный файл в корнях обхода попадает в зону поиска', () => {
    const { root, plansDir } = caseDirs('live')
    const files = collectScanFiles({ roots: ['tree/alpha.txt'], treeDir: root, plansDir })
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('alpha.txt')
    expect(readFileSync(files[0], 'utf8')).toContain('WIRE_MARKER_ALPHA')
  })

  it('корень, которого нет, — это отсутствие, а не исключение', () => {
    const { root, plansDir } = caseDirs('live')
    expect(() => collectScanFiles({ roots: ['такого-корня-нет'], treeDir: root, plansDir })).not.toThrow()
    expect(collectScanFiles({ roots: ['такого-корня-нет'], treeDir: root, plansDir })).toEqual([])
  })

  it('каталог зависимостей не посещается ни на какой глубине', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sma-wires-junction-'))
    try {
      mkdirSync(join(dir, 'src', 'node_modules'), { recursive: true })
      writeFileSync(join(dir, 'src', 'own.txt'), 'WIRE_MARKER_ALPHA\n', 'utf8')
      writeFileSync(join(dir, 'src', 'node_modules', 'foreign.txt'), 'WIRE_MARKER_ALPHA\n', 'utf8')
      const files = collectScanFiles({ roots: ['src'], treeDir: dir })
      expect(files).toHaveLength(1)
      expect(files[0]).toContain('own.txt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('опись читает ОДИН парсер, не два (е)', () => {
  it('ручной разбор key_links текстом совпадает с разбором через сборщик', () => {
    const { plansDir } = caseDirs('live')
    const planPath = join(plansDir, 'fixture-live-PLAN.md')
    const text = readFileSync(planPath, 'utf8').replace(/\r\n/g, '\n')

    // Ручной разбор — нарочно наивный и независимый: он существует затем, чтобы
    // расхождение с общим парсером было видно, а не затем, чтобы его заменить.
    const lines = text.split('\n')
    const start = lines.findIndex((l) => l === '  key_links:')
    expect(start).toBeGreaterThan(-1)
    const manualLinks: Array<Record<string, string>> = []
    const manualProse: string[] = []
    let current: Record<string, string> | null = null
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i]
      if (l === '' ) continue
      const rec = /^ {4}- ([a-z_]+): "(.*)"$/.exec(l)
      const cont = /^ {6}([a-z_]+): "(.*)"$/.exec(l)
      const prose = /^ {4}- "(.*)"$/.exec(l)
      if (rec) {
        current = { [rec[1]]: rec[2] }
        manualLinks.push(current)
      } else if (cont && current) {
        current[cont[1]] = cont[2]
      } else if (prose) {
        current = null
        manualProse.push(prose[1])
      } else {
        break
      }
    }

    const inv = collect('live')
    expect(manualLinks.length).toBeGreaterThan(0)
    expect(inv.links.map((l: { pattern: string }) => l.pattern)).toEqual(manualLinks.map((l) => l.pattern))
    expect(inv.links.map((l: { from: string }) => l.from)).toEqual(manualLinks.map((l) => l.from))
    expect(inv.links.map((l: { to: string }) => l.to)).toEqual(manualLinks.map((l) => l.to))
    expect(inv.links.map((l: { via: string }) => l.via)).toEqual(manualLinks.map((l) => l.via))
    expect(inv.prose.map((p: { text: string }) => p.text)).toEqual(manualProse)
  })

  it('сборщик не пишет на диск: у него нет ни одного пути записи', () => {
    const src = readFileSync(fileURLToPath(new URL('../lib/wires.mjs', import.meta.url)), 'utf8')
    for (const forbidden of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync']) {
      expect(src, `сборщик обязан быть только читателем, а нашлось ${forbidden}`).not.toContain(forbidden)
    }
    // И читает опись он общим парсером дома, а не шестым самописным.
    expect(src).toContain('parseFrontmatterEntries')
  })

  it('резолюция путей детерминирована: два прогона подряд дают одно и то же', () => {
    const { root } = caseDirs('live')
    const args = { rewrites: [{ prefix: '../synthetic-elsewhere', target: root }] }
    const a = collect('live', args)
    const b = collect('live', args)
    expect(JSON.stringify(a.counts)).toBe(JSON.stringify(b.counts))
    expect(JSON.stringify(a.artifacts)).toBe(JSON.stringify(b.artifacts))
  })
})

describe('фикстура «след переехал» — собрана, но не осуждена', () => {
  it('сборщик доносит и объявление, и разрешённые пути, не вынося вердикта', () => {
    const inv = collect('dead')
    expect(inv.counts.links).toBe(1)
    expect(inv.links[0].pattern).toBe('WIRE_MARKER_MOVED')
    expect(inv.links[0].fromPath.status).toBe('resolved')
    expect(inv.plans[0].status).toBe(PLAN_STATUS.closed)

    // Вычислителя вердиктов здесь нет и быть не должно: сборщик ничего не красит.
    for (const key of ['verdict', 'red', 'failures']) {
      expect(inv).not.toHaveProperty(key)
    }

    // Материал для будущего вердикта на месте: маркер есть в дереве, но не в файле,
    // который названа сама запись.
    const named = readFileSync(String(inv.links[0].fromPath.resolved), 'utf8')
    expect(named).not.toContain('WIRE_MARKER_MOVED')
    const anywhere = inv.scanFiles.some((f: string) => readFileSync(f, 'utf8').includes('WIRE_MARKER_MOVED'))
    expect(anywhere).toBe(true)
  })
})

describe('резолюция одиночного пути — прямой вход', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sma-wires-resolve-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('кандидаты пробуются в объявленном порядке и первый существующий побеждает', () => {
    mkdirSync(join(dir, 'plans'), { recursive: true })
    writeFileSync(join(dir, 'target.txt'), 'x', 'utf8')
    const res = resolveDeclaredPath({ raw: 'target.txt', treeDir: dir, plansDir: join(dir, 'plans') })
    expect(res.status).toBe('resolved')
    expect(res.resolvedBy).toBe('tree')
    expect(res.candidates[0].root).toBe('tree')
    expect(res.candidates.map((c: { root: string }) => c.root)).toEqual(['tree', 'plans-parent', 'workshop'])
  })
})
