/**
 * Tests for daemon/src/intake/backlog-scan.mjs + daemon/src/report.mjs.
 *
 * The two edges of the tick:
 *   - INTAKE  (backlog-scan): the origin project's parse contract ported 1:1 + the DoR split
 *     (missing `sp:N` → notReady «нет оценки»; `sp:N` > 13 → notReady «>13 SP…»;
 *     neither is EVER enqueued) + the data-age label.
 *   - OUTBOUND (report): the notify.mjs posture — explicit-pick allowlist (9 keys),
 *     off-by-default (no URL → zero fetch), response never read.
 */

import { describe, it, expect } from 'vitest'

import {
  headlineOf,
  parseBacklogContent,
  promiseOf,
  queuePriority,
  scanBacklog,
  toTask,
} from '../src/intake/backlog-scan.mjs'
import { CAP_TEXT, CAP_TITLE, createMemoryQueue, validateTask } from '../src/queue/adapter.mjs'
import { reportTaskEvent, ALLOWED_REPORT_KEYS } from '../src/report.mjs'

// 4-5 real-shaped BACKLOG lines: an open+estimated one, a research-flavoured one, a
// CLOSED one, a PHASE-promoted one, one WITHOUT `sp:N`, and one with `sp:21` (>13).
const BACKLOG_FIXTURE = [
  '# Idea Board',
  '',
  '## Backlog',
  '',
  '- [ ] **BL-300** · Парсер источника — сделать X и Y ради Z. `size:S` `area:tech` `added:2026-07-17` `sp:3`',
  '- [ ] **BL-301** · Ресёрч рынка — изучить конкурентов ради позиционирования. `size:M` `area:content` `added:2026-07-17` `sp:5`',
  '- [x] **BL-302** · Закрытая задача — уже сделана. `size:S` `area:crm` `added:2026-07-10` `sp:2`',
  '- [ ] **BL-303** · Промо-фаза — большая работа. `size:L` `area:crm` `added:2026-07-17` `phase:60` `sp:8`',
  '- [ ] **BL-304** · Задача без оценки — что-то нужное. `size:M` `area:tech` `added:2026-07-17`',
  '- [ ] **BL-305** · Слишком крупная — целый эпик ради всего. `size:L` `area:tech` `added:2026-07-17` `sp:21`',
  'not a backlog line, ignored',
  '',
  '## Something Else',
  '- [ ] **BL-999** · Outside the backlog section. `sp:3`',
  ''
].join('\n')

describe('parseBacklogContent — faithful platform parser port', () => {
  it('extracts id/title/size/area/phase/open + storyPoints per line, only under ## Backlog', () => {
    const items = parseBacklogContent(BACKLOG_FIXTURE)
    const ids = items.map((i) => i.id)
    expect(ids).toEqual(['BL-300', 'BL-301', 'BL-302', 'BL-303', 'BL-304', 'BL-305'])
    // BL-999 is outside the ## Backlog section → never parsed
    expect(ids).not.toContain('BL-999')

    const bl300 = items.find((i) => i.id === 'BL-300')
    expect(bl300.title).toBe('Парсер источника')
    expect(bl300.description).toBe('сделать X и Y ради Z.')
    expect(bl300.open).toBe(true)
    expect(bl300.size).toBe('S')
    expect(bl300.area).toBe('tech')
    expect(bl300.storyPoints).toBe(3)

    expect(items.find((i) => i.id === 'BL-302').open).toBe(false) // [x] closed
    expect(items.find((i) => i.id === 'BL-303').phase).toBe('60') // phase-promoted
    expect(items.find((i) => i.id === 'BL-304').storyPoints).toBeNull() // no sp tag
    expect(items.find((i) => i.id === 'BL-305').storyPoints).toBe(21)
  })

  it('чужая серия реестра парсится: префикс дома не обязан называться BL', () => {
    // A scanner that only knew one house's prefix read every other house's
    // backlog as empty — the whole intake silently idle.
    const items = parseBacklogContent(
      '## Backlog\n- [ ] **AB2-17** · Чужая серия — работа как работа. `size:S` `sp:3`\n- [ ] **x-1** · строчный мусор — не id',
    )
    expect(items.map((i) => i.id)).toEqual(['AB2-17'])
    expect(items[0].storyPoints).toBe(3)
    expect(items[0].title).toBe('Чужая серия')
  })

  it('is CRLF-safe and never throws on malformed input', () => {
    const crlf = BACKLOG_FIXTURE.replace(/\n/g, '\r\n')
    expect(parseBacklogContent(crlf).map((i) => i.id)).toContain('BL-300')
    expect(() => parseBacklogContent('## Backlog\n- garbage line **not-an-id**')).not.toThrow()
    expect(parseBacklogContent('')).toEqual([])
    // @ts-expect-error — hostile non-string input must not throw
    expect(() => parseBacklogContent(null)).not.toThrow()
  })
})

describe('toTask — backlog line → canonical task shape', () => {
  it('maps source/priority/storyPoints/acceptance from the line', () => {
    const [item] = parseBacklogContent(BACKLOG_FIXTURE).filter((i) => i.id === 'BL-300')
    const task = toTask(item)
    expect(task.id).toBe('BL-300')
    expect(task.source).toBe('backlog')
    expect(task.title).toBe('Парсер источника')
    expect(task.priority).toBe(2) // size:S → 2
    expect(task.storyPoints).toBe(3)
    expect(task.acceptance).toBe('сделать X и Y ради Z.') // the post-delimiter detail
    expect(task.lane).toBe('prod') // area:tech default
  })

  it('routes a research-flavoured line to the research lane and size drives priority', () => {
    const [item] = parseBacklogContent(BACKLOG_FIXTURE).filter((i) => i.id === 'BL-301')
    const task = toTask(item)
    expect(task.lane).toBe('research')
    expect(task.priority).toBe(1) // size:M → 1
  })
})

describe('scanBacklog — git fetch + age label + the DoR notReady split', () => {
  const makeDeps = ({ backlog = BACKLOG_FIXTURE, commitTs = '1700000000', now = 1700003600000 } = {}) => {
    const gitCalls: string[][] = []
    const execGit = (args: string[]) => {
      gitCalls.push(args)
      if (args[0] === 'log') return `${commitTs}\n`
      return ''
    }
    const fsImpl = { readFileSync: () => backlog }
    return { deps: { repoDir: '/repo', execGit, clock: () => now, fsImpl }, gitCalls }
  }

  it('git-fetches, enqueues ONLY ready open items, and labels the data age', async () => {
    const { deps, gitCalls } = makeDeps()
    const res = await scanBacklog(deps)

    // git fetch ran before the read (freshness on the mini)
    expect(gitCalls.some((c) => c[0] === 'fetch')).toBe(true)

    // ready items: BL-300 + BL-301 only. Closed (302), phase-promoted (303),
    // untagged (304) and >13 (305) are NEVER enqueued.
    expect(res.items.map((t: any) => t.id)).toEqual(['BL-300', 'BL-301'])
    expect(res.items.map((t: any) => t.id)).not.toContain('BL-304')
    expect(res.items.map((t: any) => t.id)).not.toContain('BL-305')

    // dataAgeMs derives from the last commit touching BACKLOG.md
    expect(res.dataAgeMs).toBe(1700003600000 - 1700000000 * 1000)
  })

  it('splits notReady with reasons: missing estimate vs >13 SP', async () => {
    const { deps } = makeDeps()
    const res = await scanBacklog(deps)
    const byId = Object.fromEntries(res.notReady.map((n: any) => [n.id, n.reason]))
    expect(byId['BL-304']).toMatch(/нет оценки/)
    expect(byId['BL-305']).toMatch(/>13 SP/)
    // never both surfaced AND enqueued
    expect(res.items.find((t: any) => t.id === 'BL-304')).toBeUndefined()
    expect(res.items.find((t: any) => t.id === 'BL-305')).toBeUndefined()
  })

  it('never throws when git fetch fails — still reads the local BACKLOG', async () => {
    const execGit = (args: string[]) => {
      if (args[0] === 'fetch') throw new Error('offline')
      if (args[0] === 'log') return '1700000000\n'
      return ''
    }
    const deps = { repoDir: '/repo', execGit, clock: () => 1700003600000, fsImpl: { readFileSync: () => BACKLOG_FIXTURE } }
    const res = await scanBacklog(deps)
    expect(res.items.map((t: any) => t.id)).toEqual(['BL-300', 'BL-301'])
  })
})

// ═══════════════ THE TRIAGE THE LINE ITSELF CARRIES ═══════════════
//
// Все фикстуры ниже — ВЫДУМАННЫЕ номера в формате реестра, а не строки чьего-то реестра:
// проверяется формат строки, а не чужой список задач.

/** Четыре строки одного веса и разной срочности — материал для порядка выдачи. */
const TRIAGE_FIXTURE = [
  '## Backlog',
  '- [ ] **BL-030** · Мелкая обычная — сделать её тоже. `size:S` `added:2026-09-02` `sp:1`',
  '- [ ] **BL-031** · Крупная критическая — без неё стоит всё. `size:L` `added:2026-09-02` `sp:2` `priority:critical`',
  '- [ ] **BL-032** · Крупная спешная — горит, но не всё. `size:L` `added:2026-09-02` `sp:2` `priority:urgent`',
  '- [ ] **BL-033** · Крупная важная — важно и не горит. `size:L` `added:2026-09-02` `sp:2` `priority:high`',
].join('\n')

/**
 * Строка в форме карточки реестра 02.09: НАЗВАНИЕ ЗАГЛАВНЫМИ, скобка с обстоятельствами,
 * «ЗАМЕРЕНО: …», обещание по пунктам «(а)(б)(в)». Абзацем — как их и пишут.
 */
const LONG_HEAD = 'ДОСКА ПОКАЗЫВАЕТ НЕДЕЛЬНОЕ ОКНО НА СУТКИ УСТАРЕВШИМ: ДЕМОН ЧИТАЕТ ТОЛЬКО ТО ОКНО, ЧТО НАЗВАНО В СОБЫТИИ'
const LONG_LINE =
  `- [ ] **BL-040** · ${LONG_HEAD} (вопрос владельца 02.09: «окно недели 7%, почему 67?»). ` +
  'ЗАМЕРЕНО 02.09: строка состояния терминала говорит 7%, собственное чтение того же счёта несёт 0.67 от вчерашнего ' +
  'дня, и доска трижды повторила «67%»; поле сводных окон не читается вовсе, недельное окно обновляется только когда ' +
  'поставщик называет его в событии, то есть раз в сутки и реже. ' +
  'ЧТО ПОСТРОИТЬ: (а) каждое событие о потолке обновляет ОБА окна из сводных; ' +
  '(б) свежее чтение того же счёта главнее старого, откуда бы оно ни пришло; ' +
  '(в) на доске рядом с процентом стоит возраст чтения словами. ' +
  '`size:M` `added:2026-09-02` `sp:5` `priority:urgent`'

/** Обещание, которое одной строкой в потолок не влезает: три пункта примерно по 900 знаков. */
const BULK = 'слова обещания, которых много и все до одного нужны; '.repeat(18)
const HUGE_PROMISE_LINE =
  '- [ ] **BL-041** · КАРТОЧКА С ОБЕЩАНИЕМ ДЛИННЕЕ ПОТОЛКА (вскрыто живым прогоном). ' +
  `ЧТО ПОСТРОИТЬ: (а) ${BULK}(б) ${BULK}(в) ${BULK}` +
  '`size:S` `added:2026-09-02` `sp:3`'

const scanOf = (backlog: string, extra: Record<string, unknown> = {}) =>
  scanBacklog({
    repoDir: '/repo',
    execGit: (args: string[]) => (args[0] === 'log' ? '1700000000\n' : ''),
    clock: () => 1700003600000,
    fsImpl: { readFileSync: () => backlog },
    ...extra,
  } as any)

describe('приоритет строки: пометка срочности старше размера, и путь один на скан и на дверь', () => {
  it('parseBacklogContent читает priority: и deps: — теги, которых он раньше не видел вовсе', () => {
    const items = parseBacklogContent(
      '## Backlog\n- [ ] **BL-050** · Работа — делать. `size:M` `sp:3` `priority:critical` `deps:BL-051,BL-052`',
    )
    expect(items[0].priority).toBe('critical')
    expect(items[0].deps).toEqual(['BL-051', 'BL-052'])
  })

  it('critical > urgent > high > обычный, а размер — только второй ключ внутри полосы', () => {
    // крупная критическая обязана обгонять мелкую без пометки: до починки размер решал всё
    expect(queuePriority({ size: 'L', priority: 'critical' })).toBeGreaterThan(queuePriority({ size: 'S', priority: null }))
    expect(queuePriority({ size: 'L', priority: 'critical' })).toBeGreaterThan(queuePriority({ size: 'S', priority: 'urgent' }))
    expect(queuePriority({ size: 'L', priority: 'urgent' })).toBeGreaterThan(queuePriority({ size: 'S', priority: 'high' }))
    expect(queuePriority({ size: 'L', priority: 'high' })).toBeGreaterThan(queuePriority({ size: 'S', priority: null }))
    // …и внутри одной полосы размер по-прежнему решает
    expect(queuePriority({ size: 'S', priority: 'high' })).toBeGreaterThan(queuePriority({ size: 'M', priority: 'high' }))
    // строка без пометки стоит ровно там же, где стояла всегда
    expect(queuePriority({ size: 'S', priority: null })).toBe(2)
    expect(queuePriority({ size: 'M', priority: null })).toBe(1)
    expect(queuePriority({ size: 'L', priority: null })).toBe(0)
    // незнакомое слово — обычная работа, а не отказ: словарь реестра ведёт человек
    expect(queuePriority({ size: 'S', priority: 'потом' })).toBe(2)
  })

  it('ОЧЕРЕДЬ ВЫДАЁТ ПО СРОЧНОСТИ: claimNext отдаёт critical, urgent, high и только потом мелкую', async () => {
    const { items } = await scanOf(TRIAGE_FIXTURE)
    const q = createMemoryQueue({ clock: () => 1700003600000, expireMs: 60_000 })
    // мелкая обычная ставится ПЕРВОЙ — если бы решало время прихода, она бы и уехала первой
    for (const task of items) await q.enqueue(task)

    const order: string[] = []
    for (let i = 0; i < items.length; i += 1) order.push((await q.claimNext(`w${i}`, {})).id)
    expect(order).toEqual(['BL-031', 'BL-032', 'BL-033', 'BL-030'])
  })
})

describe('deps: карточка не минтится, пока названная ею карточка открыта', () => {
  const WAITING = [
    '## Backlog',
    '- [ ] **BL-060** · Вторая половина шва — делать после первой. `size:S` `sp:2` `deps:BL-061`',
    '- [ ] **BL-061** · Первая половина шва — сначала она. `size:S` `sp:2`',
  ].join('\n')

  it('зависимость открыта — строка не в очереди, и на неё есть причина словами', async () => {
    const res = await scanOf(WAITING)
    expect(res.items.map((t: any) => t.id)).toEqual(['BL-061'])
    const waiting = res.notReady.find((n: any) => n.id === 'BL-060')
    expect(waiting.reason).toContain('BL-061')
    expect(waiting.reason).toMatch(/ждёт зависимости/)
  })

  it('зависимость закрыта — строка минтится как обычно', async () => {
    const res = await scanOf(WAITING.replace('- [ ] **BL-061**', '- [x] **BL-061**'))
    expect(res.items.map((t: any) => t.id)).toEqual(['BL-060'])
    expect(res.notReady).toEqual([])
  })

  it('названная карточка, которой в реестре нет, не держит: придуманное ожидание навсегда — хуже', async () => {
    const res = await scanOf('## Backlog\n- [ ] **BL-062** · Работа — делать. `size:S` `sp:2` `deps:BL-999`')
    expect(res.items.map((t: any) => t.id)).toEqual(['BL-062'])
  })
})

describe('длинное название не повод для отказа: абзац карточки режется, а не выбрасывается', () => {
  it('строка реестра в форме 02.09 ДОХОДИТ ДО ОЧЕРЕДИ: ворота её принимают', async () => {
    const { items, notReady } = await scanOf(`## Backlog\n${LONG_LINE}`)
    expect(items).toHaveLength(1)
    expect(notReady).toEqual([])
    // до починки ровно здесь ворота отвечали «название: N знаков при потолке 200»
    expect(() => validateTask(items[0])).not.toThrow()
  })

  it('заголовок — первая фраза карточки, остальное уходит в описание', async () => {
    const { items } = await scanOf(`## Backlog\n${LONG_LINE}`)
    const task = items[0] as any
    expect(task.title).toBe(LONG_HEAD)
    expect(task.title.length).toBeLessThanOrEqual(CAP_TITLE)
    // ни одного слова не потеряно: обстоятельства и замер лежат в описании
    expect(task.description).toContain('ЗАМЕРЕНО 02.09')
    expect(task.description).toContain('окно недели 7%')
    // …и срочность, объявленная строкой, доехала вместе с ней
    expect(task.priority).toBe(queuePriority({ size: 'M', priority: 'urgent' }))
  })

  it('приписка в голове строки — не заголовок: он берётся после неё, а сама она едет в описание', () => {
    const cut = headlineOf(
      `(ЗАКРЫТА ЧАСТЬ 02.09: половина работы уже слита, ${'подробности приёмки; '.repeat(12)}) · ` +
        'НАСТОЯЩЕЕ НАЗВАНИЕ КАРТОЧКИ ЗАГЛАВНЫМИ (обстоятельство). ЗАМЕРЕНО: дальше подробности.',
    )
    expect(cut.title).toBe('НАСТОЯЩЕЕ НАЗВАНИЕ КАРТОЧКИ ЗАГЛАВНЫМИ')
    expect(cut.tail).toContain('ЗАКРЫТА ЧАСТЬ 02.09')
  })

  it('первая фраза сама длиннее потолка — режется по слову и говорит об этом многоточием', () => {
    const cut = headlineOf(`${'длинноеслово '.repeat(40)}конец фразы.`)
    expect(cut.title.length).toBeLessThanOrEqual(CAP_TITLE)
    expect(cut.title.endsWith('…')).toBe(true)
    expect(cut.tail).toContain('конец фразы')
  })

  it('тире ВНУТРИ приписной скобки не делит строку: заголовком становится название, не обрывок', () => {
    // Замерено живым прогоном: у карточки с приписной скобкой в голове первое тире попадало
    // внутрь скобки, и в очередь ехал обрывок «(ЧАСТЬ СЕЛА 02.09: работа флота abc1234».
    const [item] = parseBacklogContent(
      '## Backlog\n- [ ] **BL-042** · (ЧАСТЬ СЕЛА 02.09: работа флота abc1234 — слито def5678) · ' +
        'НАСТОЯЩЕЕ НАЗВАНИЕ КАРТОЧКИ — и пояснение за структурным тире. `size:S` `sp:2`',
    )
    expect(item.title).toBe('(ЧАСТЬ СЕЛА 02.09: работа флота abc1234 — слито def5678) · НАСТОЯЩЕЕ НАЗВАНИЕ КАРТОЧКИ')
    expect(item.description).toBe('и пояснение за структурным тире.')
    // …а обычная строка делится ровно там же, где делилась всегда
    const [plain] = parseBacklogContent('## Backlog\n- [ ] **BL-043** · Название — пояснение. `sp:2`')
    expect(plain.title).toBe('Название')
    expect(plain.description).toBe('пояснение.')
  })

  it('короткая строка не трогается вовсе: разбор — лечение длины, а не вторая грамматика', () => {
    expect(headlineOf('Обычное короткое название. И вторая фраза.')).toEqual({
      title: 'Обычное короткое название. И вторая фраза.',
      tail: '',
    })
  })

  it('обещание длиннее потолка режется по пунктам автора, а не отбрасывается', async () => {
    const { items, notReady } = await scanOf(`## Backlog\n${HUGE_PROMISE_LINE}`)
    expect(notReady).toEqual([])
    const task = items[0] as any
    // до починки эта строка отвечала «признаки успеха: N знаков при потолке 2000» и не ехала
    expect(Array.isArray(task.acceptance)).toBe(true)
    expect(task.acceptance.length).toBeGreaterThanOrEqual(3)
    expect(task.acceptance.some((s: string) => s.startsWith('(а)'))).toBe(true)
    expect(task.acceptance.some((s: string) => s.startsWith('(б)'))).toBe(true)
    expect(task.acceptance.some((s: string) => s.startsWith('(в)'))).toBe(true)
    for (const item of task.acceptance) expect(item.length).toBeLessThanOrEqual(CAP_TEXT)
    expect(() => validateTask(task)).not.toThrow()
  })

  it('обещание без единого маркера подрезается вслух, а не выбрасывается', () => {
    const out = promiseOf('сплошной текст без пунктов, '.repeat(120))
    expect(typeof out).toBe('string')
    expect((out as string).length).toBeLessThanOrEqual(CAP_TEXT)
    expect((out as string).endsWith('…')).toBe(true)
  })
})

describe('строка скана несёт проект того реестра, из которого её прочитали', () => {
  it('проект назван — он на строке; не назван — строка о нём молчит, а не выдумывает', async () => {
    const withProject = await scanOf(TRIAGE_FIXTURE, { project: 'sma-dev' })
    expect(withProject.items.every((t: any) => t.project === 'sma-dev')).toBe(true)
    expect(() => validateTask(withProject.items[0])).not.toThrow()

    const without = await scanOf(TRIAGE_FIXTURE)
    expect(without.items.every((t: any) => t.project === undefined)).toBe(true)
  })
})

describe('reportTaskEvent — outbound notify posture (off by default, allowlist, no read)', () => {
  it('has exactly the 9 allowlisted keys incl. the aging expansion', () => {
    expect(ALLOWED_REPORT_KEYS).toEqual([
      'event', 'taskId', 'title', 'lane', 'receiptVerdict', 'branch', 'attempt', 'ts', 'queuedForHours',
    ])
  })

  it('serializes ONLY allowlisted keys — hostile extras are never picked', async () => {
    let sent: any = null
    const fetchImpl = async (_url: string, opts: any) => {
      sent = JSON.parse(opts.body)
      return { ok: true, status: 200 }
    }
    const res = await reportTaskEvent({
      config: { webhookUrl: 'https://example.test/hook' },
      event: {
        event: 'task.completed',
        taskId: 'BL-300',
        title: 'Парсер источника',
        lane: 'prod',
        receiptVerdict: 'green',
        branch: 'wt/BL-300',
        attempt: 1,
        queuedForHours: 3,
        // hostile extras that must NEVER cross the boundary:
        diff: 'huge diff hunk',
        transcriptPath: '/secret/path',
        oauthToken: 'sk-leak',
      },
      fetchImpl,
      clock: () => 1700003600000,
    })
    expect(res.delivered).toBe(true)
    expect(Object.keys(sent).sort()).toEqual([...ALLOWED_REPORT_KEYS].sort())
    expect(sent.diff).toBeUndefined()
    expect(sent.transcriptPath).toBeUndefined()
    expect(sent.oauthToken).toBeUndefined()
    expect(sent.ts).toBe(new Date(1700003600000).toISOString())
  })

  it('OFF BY DEFAULT — no configured webhookUrl → ZERO fetch calls', async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return { ok: true, status: 200 }
    }
    const res = await reportTaskEvent({ config: {}, event: { event: 'task.completed', taskId: 'BL-1' }, fetchImpl })
    expect(calls).toBe(0)
    expect(res.delivered).toBe(false)
  })

  it('swallows a fetch error to a journal event — never blocks the tick', async () => {
    const journalled: any[] = []
    const fetchImpl = async () => {
      throw new Error('receiver down')
    }
    const res = await reportTaskEvent({
      config: { webhookUrl: 'https://example.test/hook' },
      event: { event: 'task.failed', taskId: 'BL-9' },
      fetchImpl,
      journal: (e: any) => journalled.push(e),
    })
    expect(res.delivered).toBe(false)
    expect(journalled.length).toBe(1)
  })
})
