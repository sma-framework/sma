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
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectInventory,
  collectScanFiles,
  planStatus,
  resolveDeclaredPath,
  applyRewrites,
  compilePattern,
  evaluateInventory,
  renderReport,
  toJson,
  countRedWithoutVerdict,
  parseVerdicts,
  isTestFile,
  PLAN_STATUS,
  DEFAULT_SCAN_ROOTS,
  DEFAULT_BROAD_LIMIT,
  VERDICT_KINDS,
  RED_REASONS,
  YELLOW_REASONS,
  EXIT_CODES,
  HONEST_BOUNDARY,
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
    expect(inv.counts.links, 'одна структурная связь объявлена').toBe(1)
    expect(inv.counts.artifacts, 'две записи path+contains объявлены').toBe(2)
    expect(inv.counts.prose, 'две строки прозой объявлены').toBe(2)
    expect(inv.counts.patternless, 'записей без следа в фикстуре нет').toBe(0)

    // ЗАМОК ОТ ПУСТОТЫ. Сборщик, чей разбор перестал что-либо находить, зеленеет молча —
    // ровно так сторож перестаёт сторожить, и никто этого не замечает.
    expect(inv.counts.links).toBeGreaterThan(0)
    expect(inv.counts.artifacts).toBeGreaterThan(0)
    expect(inv.counts.prose).toBeGreaterThan(0)
    expect(inv.counts.scanFiles).toBeGreaterThan(0)

    expect(inv.links.map((l: { pattern: string }) => l.pattern)).toEqual(['WIRE_MARKER_ALPHA'])
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

/* ==========================================================================
 * ВЫЧИСЛИТЕЛЬ ВЕРДИКТОВ — обе половины прибора.
 *
 * Прибор, умеющий только зеленеть, бесполезен; прибор, умеющий только краснеть,
 * бесполезен ровно так же. Поэтому каждая фикстура проверяется на СВОЙ ожидаемый
 * исход, а не «лишь бы не упало»: мёртвое обязано покраснеть поимённо, живое —
 * позеленеть, широкое — пожелтеть, пустое и малформатное — остановить прогон.
 *
 * Главная опасность здесь измерена, а не выдумана: на прежней строгости «0 красных»
 * достижимо за вечер и не стоит ничего. Поэтому у трёх несущих замков стоят КОНТРОЛИ,
 * без которых тест сторожил бы пустоту: у сужения — доказательство, что след жив в
 * дереве (иначе кейс проходил бы и без сужения); у порога широты — прогон того же
 * случая с порогом по умолчанию (иначе порог мог бы ни на что не влиять); у каталога
 * планов — мутация, включающая его в зону поиска (иначе замок мог бы отсутствовать).
 * ========================================================================== */

type EvalOpts = {
  roots?: string[]
  broadLimit?: number
  verdicts?: unknown
  rewrites?: Array<{ prefix: string; target: string }>
}

function evaluate(name: string, opts: EvalOpts = {}) {
  const { root, plansDir } = caseDirs(name)
  const roots = opts.roots ?? ['.']
  const inventory = collectInventory({ plansDir, treeDir: root, roots, rewrites: opts.rewrites })
  const evaluation = evaluateInventory({
    inventory,
    treeDir: root,
    roots,
    broadLimit: opts.broadLimit,
    verdicts: opts.verdicts,
  })
  return { root, plansDir, inventory, evaluation }
}

const LIB = fileURLToPath(new URL('../lib/wires.mjs', import.meta.url))
const VERDICTS_FILE = join(FIXTURES, 'verdicts', 'verdicts.jsonl')

describe('вычислитель — мёртвое краснеет поимённо (1, 2)', () => {
  it('(1) закрытый план без предъявления: код 1, каждая находка названа, причины различены', () => {
    const { evaluation: ev } = evaluate('closed-dead')

    expect(ev.exitCode).toBe(EXIT_CODES.red)
    expect(ev.counts.red, 'связь + игла в существующем файле + нерезолвящийся путь').toBe(3)
    expect(Object.keys(ev.counts.redByReason).sort()).toEqual([
      'needle-missing-in-file',
      'path-unresolved',
      'trace-missing-everywhere',
    ])
    expect(ev.counts.green).toBe(0)

    // Человек обязан ПОДТВЕРЖДАТЬ, а не расследовать: у каждой находки есть план,
    // след и причина словами.
    for (const r of ev.red) {
      expect(r.planId).toBe('fixture-closed-dead')
      expect(r.kind === 'link' ? r.pattern : r.declaredPath).toBeTruthy()
      expect(RED_REASONS[r.reason].ru).toBeTruthy()
    }
  })

  it('(2) сужение до названного файла ловит переезд, которого дерево-широкий поиск не видит', () => {
    const { evaluation: ev, inventory: inv } = evaluate('dead')

    expect(ev.exitCode).toBe(EXIT_CODES.red)
    const link = ev.red.find((r: { kind: string }) => r.kind === 'link')
    expect(link.reason).toBe('trace-missing-in-named-file')
    expect(link.namedSide).toBe('from')
    expect(String(link.namedFile)).toContain('code.txt')

    // КОНТРОЛЬ, без которого кейс проходил бы и БЕЗ сужения: след действительно жив в
    // дереве, и поиск по дереву целиком назвал бы эту связь зелёной.
    const alive = inv.scanFiles.filter((f: string) => readFileSync(f, 'utf8').includes('WIRE_MARKER_MOVED'))
    expect(alive.length).toBeGreaterThan(0)
    expect(link.treeFiles).toBeGreaterThan(0)
  })
})

describe('вычислитель — живое зеленеет (3), не построенное молчит (4)', () => {
  it('(3) живая фикстура: код 0, красных нет, зелень стоит на названных файлах', () => {
    const { root } = caseDirs('live')
    const { evaluation: ev } = evaluate('live', {
      rewrites: [{ prefix: '../synthetic-elsewhere', target: root }],
    })

    expect(ev.counts.red).toBe(0)
    expect(ev.exitCode).toBe(EXIT_CODES.clean)
    expect(ev.counts.green, 'одна связь и две записи artifacts').toBe(3)
    expect(ev.green.map((g: { evidence: string }) => g.evidence).sort()).toEqual([
      'artifact-needle',
      'artifact-needle',
      'named-file',
    ])
  })

  it('прибор судит ТО дерево, которое ему дали: без переписывания корня чужой путь краснеет', () => {
    const { evaluation: ev } = evaluate('live')
    expect(ev.exitCode).toBe(EXIT_CODES.red)
    expect(ev.counts.redByReason['path-unresolved']).toBe(1)
  })

  it('(4) плана без сводки не судят: ни зелени, ни красноты — молчание', () => {
    const closed = evaluate('closed-dead').evaluation
    const ahead = evaluate('not-built').evaluation

    expect(ahead.exitCode).toBe(EXIT_CODES.clean)
    expect(ahead.counts.red).toBe(0)
    expect(ahead.counts.green, 'молчание — это НЕ зелень').toBe(0)
    expect(ahead.counts.ahead, 'связь и две записи artifacts ушли в «работа впереди»').toBe(3)

    // Пара к closed-dead: блок объявления тот же буква в букву, вердикт другой.
    expect(closed.counts.red).toBe(3)
  })
})

describe('вычислитель — широкий след не доказательство (5)', () => {
  it('(5) след, найденный шире порога, — жёлтый: не зелёный и не красный', () => {
    const tight = evaluate('broad', { broadLimit: 2 }).evaluation

    expect(tight.exitCode).toBe(EXIT_CODES.clean)
    expect(tight.counts.green, 'широкий след зелёным не считается').toBe(0)
    expect(tight.counts.broad).toBe(1)
    expect(tight.yellow.broad[0].pattern).toBe('WIRE_BROAD_TOKEN')
    expect(tight.yellow.broad[0].treeFiles).toBe(3)

    // КОНТРОЛЬ: порог обязан на что-то влиять. Тот же случай на пороге по умолчанию —
    // зелёный. Без этой половины тест проходил бы и при пороге, который ничего не режет.
    const loose = evaluate('broad').evaluation
    expect(loose.counts.broad).toBe(0)
    expect(loose.counts.green).toBe(1)

    expect(DEFAULT_BROAD_LIMIT, 'порог — объявленная константа, а не число из воздуха').toBe(20)
    expect(YELLOW_REASONS.broad.ru).toBeTruthy()
  })

  it('порог напечатан в отчёте — иначе число красных невоспроизводимо', () => {
    const { root, inventory, evaluation } = evaluate('broad', { broadLimit: 2 })
    const text = renderReport({ treeDir: root, commit: 'fixture-commit', evaluation, inventory })
    expect(text).toContain('broad-trace limit: 2 files')
    expect(text).toContain('WIRE_BROAD_TOKEN')
    // «3+» честнее «3»: перешагнув порог, счёт останавливается — точное число широкого
    // следа уже ничего не решает, а досчитывать его по всему дереву стоит времени.
    expect(text).toContain('found in 3+ files (limit 2)')
  })
})

describe('вычислитель — красный гасится только вердиктом человека (6, 7)', () => {
  it('(6) записанный вердикт гасит красный, протухший — виден и посчитан', () => {
    const roots = ['tree']
    const jsonl = readFileSync(VERDICTS_FILE, 'utf8')

    const before = evaluate('verdicts', { roots }).evaluation
    expect(before.exitCode).toBe(EXIT_CODES.red)
    expect(before.counts.red).toBe(1)

    const after = evaluate('verdicts', { roots, verdicts: jsonl }).evaluation
    expect(after.exitCode).toBe(EXIT_CODES.clean)
    expect(after.counts.red).toBe(0)
    expect(after.counts.reviewed).toBe(1)
    expect(after.reviewed[0].verdict).toBe('misdeclared')
    expect(after.reviewed[0].author).toBe('fixture-reviewer')
    expect(after.reviewed[0].rationale).toBeTruthy()
    expect(after.reviewed[0].verdictLabel).toBe(VERDICT_KINDS.misdeclared.ru)

    // Вердикт, не совпавший ни с одним текущим красным, не выброшен молча.
    expect(after.counts.staleVerdicts).toBe(1)
    expect(after.staleVerdicts[0].pattern).toBe('WIRE_MARKER_NEVER_DECLARED')

    const text = renderReport({
      treeDir: caseDirs('verdicts').root,
      commit: 'fixture-commit',
      evaluation: after,
      inventory: evaluate('verdicts', { roots, verdicts: jsonl }).inventory,
    })
    expect(text).toContain('REVIEWED BY A HUMAN')
    expect(text).toContain('fixture-reviewer')
    expect(text).toContain('STALE VERDICTS')
  })

  it('(7) вердикт без автора или без обоснования — малформат: код 2, красный НЕ погашен', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sma-wires-verdicts-'))
    try {
      const file = join(dir, 'verdicts.jsonl')
      writeFileSync(
        file,
        JSON.stringify({
          kind: 'link',
          plan: 'fixture-verdicts',
          pattern: 'WIRE_MARKER_LOST',
          verdict: 'misdeclared',
          rationale: 'автора у этой записи нет',
        }) + '\n',
        'utf8',
      )
      const ev = evaluate('verdicts', { roots: ['tree'], verdicts: readFileSync(file, 'utf8') }).evaluation

      expect(ev.exitCode).toBe(EXIT_CODES.unreadable)
      expect(ev.counts.verdictErrors).toBeGreaterThan(0)
      expect(ev.verdictErrors[0].line).toBe(1)
      expect(ev.verdictErrors[0].error).toMatch(/author/)
      expect(ev.counts.reviewed, 'малформатная запись ничего не гасит').toBe(0)
      expect(ev.counts.red).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('словарь вердиктов закрыт, а чужое слово — малформат', () => {
    expect(Object.keys(VERDICT_KINDS).sort()).toEqual([
      'deferred',
      'misdeclared',
      'regression-filed',
      'renamed',
    ])
    for (const k of Object.keys(VERDICT_KINDS)) {
      expect(VERDICT_KINDS[k].en, 'машинное имя и английская подпись').toBeTruthy()
      expect(VERDICT_KINDS[k].ru, 'русское слово для отчёта').toBeTruthy()
    }

    const outside = parseVerdicts(
      JSON.stringify({
        kind: 'link',
        plan: 'p',
        pattern: 'x',
        verdict: 'да всё там в порядке',
        author: 'a',
        rationale: 'r',
      }),
    )
    expect(outside.records).toHaveLength(0)
    expect(outside.errors[0].error).toMatch(/closed vocabulary/)

    const noReason = parseVerdicts(
      JSON.stringify({ kind: 'link', plan: 'p', pattern: 'x', verdict: 'renamed', author: 'a' }),
    )
    expect(noReason.records).toHaveLength(0)
    expect(noReason.errors[0].error).toMatch(/rationale/)
  })

  it('журнал вердиктов: комментарии и пустые строки пропускаются, битая строка названа номером', () => {
    const good = JSON.stringify({
      kind: 'link',
      plan: 'p',
      pattern: 'x',
      verdict: 'deferred',
      author: 'a',
      rationale: 'r',
    })
    const { records, errors } = parseVerdicts(['# заголовок журнала', '', 'это не json', good].join('\n'))
    expect(records).toHaveLength(1)
    expect(records[0].line).toBe(4)
    expect(errors).toHaveLength(1)
    expect(errors[0].line).toBe(3)
  })
})

describe('вычислитель — пустота останавливает, а не зеленеет (8)', () => {
  it('(8) опись, из которой ничего не распарсилось, — код 2, а не «0 красных»', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sma-wires-empty-'))
    try {
      writeFileSync(
        join(dir, 'fixture-empty-PLAN.md'),
        ['---', 'phase: wires-fixture', 'type: fixture', '---', '', '# план без единого объявления', ''].join('\n'),
        'utf8',
      )
      writeFileSync(join(dir, 'fixture-empty-SUMMARY.md'), '---\nphase: wires-fixture\n---\n', 'utf8')
      mkdirSync(join(dir, 'tree'), { recursive: true })
      writeFileSync(join(dir, 'tree', 'code.txt'), 'какой-то настоящий код\n', 'utf8')

      const inventory = collectInventory({ plansDir: dir, treeDir: dir, roots: ['tree'] })
      const evaluation = evaluateInventory({ inventory, treeDir: dir, roots: ['tree'] })

      expect(inventory.counts.links + inventory.counts.artifacts).toBe(0)
      expect(evaluation.parsedNothing).toBe(true)
      expect(evaluation.exitCode).toBe(EXIT_CODES.unreadable)
      expect(evaluation.counts.red).toBe(0)
      // Ноль красных при нуле разобранных записей — это ПОЛОМКА, и отчёт говорит это словами,
      // а не рапортует чистое дерево.
      expect(renderReport({ treeDir: dir, evaluation, inventory })).toContain('THE INVENTORY DOES NOT READ')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('отчёт — воспроизводим и полон (9, 10)', () => {
  it('(9) два вызова на одних данных дают побайтно равную строку', () => {
    const { root, inventory, evaluation } = evaluate('closed-dead')
    const args = { treeDir: root, commit: 'fixture-commit', evaluation, inventory }

    const a = renderReport(args)
    const b = renderReport(args)
    expect(Buffer.byteLength(a, 'utf8')).toBe(Buffer.byteLength(b, 'utf8'))
    expect(Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))).toBe(0)

    // И полный прогон целиком — сбор, вердикт, отчёт — тоже повторяется байт в байт.
    const again = evaluate('closed-dead')
    expect(
      renderReport({ treeDir: again.root, commit: 'fixture-commit', evaluation: again.evaluation, inventory: again.inventory }),
    ).toBe(a)

    // Источников недетерминизма в самой библиотеке нет.
    const src = readFileSync(LIB, 'utf8')
    expect(src).not.toMatch(/new Date|Date\.now\(|Math\.random/)
    expect(src).not.toMatch(/\.localeCompare\(/)
  })

  it('(10) счётчик красных без вердикта равен длине красной группы и жёлтых не считает', () => {
    const dead = evaluate('closed-dead').evaluation
    expect(countRedWithoutVerdict(dead)).toBe(dead.red.length)
    expect(countRedWithoutVerdict(dead)).toBe(3)

    const reviewed = evaluate('verdicts', {
      roots: ['tree'],
      verdicts: readFileSync(VERDICTS_FILE, 'utf8'),
    }).evaluation
    expect(countRedWithoutVerdict(reviewed)).toBe(0)

    const broad = evaluate('broad', { broadLimit: 2 }).evaluation
    expect(broad.counts.broad).toBe(1)
    expect(countRedWithoutVerdict(broad), 'жёлтое — не красное').toBe(0)
  })

  it('шапка отчёта несёт пять чисел воспроизводимости', () => {
    const { root, inventory, evaluation } = evaluate('closed-dead')
    const head = renderReport({ treeDir: root, commit: 'fixture-commit', evaluation, inventory })
      .split('\n')
      .slice(0, 9)
      .join('\n')

    expect(head, 'дерево под проверкой и его коммит').toContain(resolve(root))
    expect(head).toContain('fixture-commit')
    expect(head, 'каталог планов').toContain(resolve(join(root, 'plans')))
    expect(head, 'набор корней обхода').toContain('walk roots (1 declared, 1 present)')
    expect(head, 'порог широты').toContain('broad-trace limit: 20 files')
    expect(head, 'счёт разобранного по формам').toContain('parsed: 1 structural links, 2 artifact records')
    expect(head).toContain('1 with a summary (judged)')
    expect(head).toContain('prohibitions block')

    // Коммит не передан — говорится прямо, строка не пропадает.
    expect(renderReport({ treeDir: root, evaluation, inventory })).toContain('commit not established')
  })

  it('корень, которого нет, назван в отчёте отброшенным, а не пропущен молча', () => {
    const { root, plansDir } = caseDirs('closed-dead')
    const roots = ['.', 'такого-корня-нет']
    const inventory = collectInventory({ plansDir, treeDir: root, roots })
    const evaluation = evaluateInventory({ inventory, treeDir: root, roots })

    expect(evaluation.roots.missing).toEqual(['такого-корня-нет'])
    expect(renderReport({ treeDir: root, evaluation, inventory })).toContain('absent — not walked')
  })

  it('честная граница прибора печатается в конце каждого отчёта', () => {
    const { root, inventory, evaluation } = evaluate('live')
    const text = renderReport({ treeDir: root, commit: 'fixture-commit', evaluation, inventory })

    expect(text.trimEnd().endsWith(HONEST_BOUNDARY)).toBe(true)
    expect(HONEST_BOUNDARY).toMatch(/A string is not a call/)
    expect(HONEST_BOUNDARY).toMatch(/RECEIVER/)
  })

  it('красные сгруппированы по причине, и каждая группа названа словами', () => {
    const { root, inventory, evaluation } = evaluate('closed-dead')
    const text = renderReport({ treeDir: root, commit: 'fixture-commit', evaluation, inventory })

    expect(text).toContain('RED — declared, closed, and not there (3)')
    expect(text).toContain(RED_REASONS['trace-missing-everywhere'].ru)
    expect(text).toContain(RED_REASONS['needle-missing-in-file'].ru)
    expect(text).toContain(RED_REASONS['path-unresolved'].ru)
    expect(text).toContain('fixture-closed-dead')
    expect(text, 'человек подтверждает, а не расследует').toContain('suggested:')
  })
})

describe('жёлтое видно, а не спрятано', () => {
  it('ярус «след в тестах» считается и называется, но вердикта не меняет', () => {
    const { root } = caseDirs('live')
    const ev = evaluate('live', { rewrites: [{ prefix: '../synthetic-elsewhere', target: root }] }).evaluation

    // В фикстуре нет ни одного тестового файла — значит ярус обязан сработать...
    expect(ev.counts.noTestTrace).toBe(1)
    // ...и при этом НИЧЕГО не покрасить: та же связь стоит в зелёных.
    expect(ev.counts.red).toBe(0)
    const flagged = ev.yellow.noTestTrace[0]
    expect(ev.green.some((g: { pattern: string }) => g.pattern === flagged.pattern)).toBe(true)

    expect(isTestFile(join('scripts', '__tests__', 'x.ts'))).toBe(true)
    expect(isTestFile('x.test.ts')).toBe(true)
    expect(isTestFile(join('scripts', 'lib', 'x.mjs'))).toBe(false)
  })

  it('машинный вывод несёт жёлтые поимённо там, где текст даёт число', () => {
    const machine = toJson(evaluate('broad', { broadLimit: 2 }).evaluation)
    expect(machine.yellow.broad[0].pattern).toBe('WIRE_BROAD_TOKEN')
    expect(machine.counts.broad).toBe(1)
    expect(machine.honestBoundary).toBe(HONEST_BOUNDARY)

    const prose = toJson(evaluate('live').evaluation)
    expect(prose.counts.prose).toBe(2)
    expect(prose.yellow.prose[0].text).toContain('прозой')
  })
})

describe('каталог планов не доказательство — замок на стороне вердикта', () => {
  it('след, живущий только в собственном объявлении, краснеет; включи планы в обход — позеленеет', () => {
    const { root, plansDir, evaluation: ev, inventory } = evaluate('self-declared')
    const planPath = join(plansDir, 'fixture-self-declared-PLAN.md')

    // Без этой строки тест был бы пустым: маркер обязан реально стоять в плане.
    expect(readFileSync(planPath, 'utf8')).toContain('WIRE_MARKER_SELF_DECLARED')

    const link = ev.red.find((r: { kind: string }) => r.kind === 'link')
    expect(link.reason).toBe('trace-missing-everywhere')
    expect(ev.counts.green, 'контроль: зона поиска не пуста').toBe(1)

    // МУТАЦИЯ ПРЯМО ЗДЕСЬ: добавим файл плана в зону поиска — и прибор поздравит сам
    // себя собственным объявлением. Красный станет зелёным, то есть замок несёт вес.
    const mutated = evaluateInventory({
      inventory: { ...inventory, scanFiles: [...inventory.scanFiles, planPath] },
      treeDir: root,
      roots: ['.'],
    })
    expect(mutated.counts.red).toBe(0)
    expect(mutated.counts.green).toBe(2)
  })
})
