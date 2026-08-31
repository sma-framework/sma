/**
 * moot-outcome.test.ts — «ПРЕДМЕТА НЕТ» КАК ПЕРВОКЛАССНЫЙ КОНЕЦ РАБОТЫ.
 *
 * У завершённой работы было три двери: квитанция за код, документ за прозу, ответ без правки.
 * Ни одна не умела сказать то единственное, чем кончается возвращённая карточка, чья жалоба
 * уже закрыта: ПРЕДМЕТА НЕТ. Такой конец существовал только как отсутствие — «сделано, но
 * коммитов нет», — а отсутствие на карточке читается как провал.
 *
 * ЦЕНА ИЗМЕРЕНА 31.08.2026: работнику, не нашедшему предмета, дешевле было создать файл и тест
 * о существовании этого файла, чем вернуться ни с чем. В тот же день другой работник на такой
 * же карточке нашёл коммит, закрывший жалобу, назвал его и не тронул ни строки — значит
 * поведение достижимо, но держалось на добросовестности, а не на устройстве.
 *
 * ЧТО ЗАПЕРТО ЗДЕСЬ. Что у исхода есть своё СЛОВО (`moot:`, отдельное от `answer:`), своя
 * КВИТАНЦИЯ, называющая чем проверяли, и что улику проверяет ДЕМОН, а не работник на слово:
 * непроверенное заявление квитанции не даёт и молча не проходит.
 */

import { describe, it, expect } from 'vitest'

import { parseMootMarker, markerLinesFrom, MOOT_MARKERS } from '../src/front/journal.mjs'
import { parseReceiptProof } from '../src/front/state.mjs'
import { receiptProofLabel } from '../../spa/src/shell/format'
import { tick } from '../src/loop.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { buildTaskPrompt } from '../src/runner/args.mjs'

describe('parseMootMarker — вывод и улика, оба обязательны', () => {
  it('читает вывод и все улики', () => {
    expect(
      parseMootMarker([
        'шум',
        `${MOOT_MARKERS.moot} жалоба закрыта 28.08`,
        `${MOOT_MARKERS.evidence} d253a83b`,
        `${MOOT_MARKERS.evidence} daemon/src/loop.mjs`,
      ]),
    ).toEqual({ reason: 'жалоба закрыта 28.08', evidence: ['d253a83b', 'daemon/src/loop.mjs'] })
  })

  it('ВЫВОД БЕЗ УЛИКИ — не ответ: это слово, которым можно пройти гейт', () => {
    expect(parseMootMarker([`${MOOT_MARKERS.moot} предмета нет`])).toBeNull()
  })

  it('улика без вывода тоже ничего не значит', () => {
    expect(parseMootMarker([`${MOOT_MARKERS.evidence} d253a83b`])).toBeNull()
  })

  it('снимает кавычки и обратные апострофы, которыми модели по привычке оборачивают путь', () => {
    const out = parseMootMarker([`${MOOT_MARKERS.moot} устарело`, `${MOOT_MARKERS.evidence} \`docs/DETAILS.md\``])
    expect(out!.evidence).toEqual(['docs/DETAILS.md'])
  })

  it('находит маркеры ВНУТРИ кадра потока, а не только в голых строках', () => {
    const frame = JSON.stringify({
      message: { content: [{ text: `итог\n${MOOT_MARKERS.moot} баг не воспроизводится\n${MOOT_MARKERS.evidence} abc1234` }] },
    })
    const out = parseMootMarker(markerLinesFrom([frame], ['APPROACH_', 'LESSON_', 'MOOT']))
    expect(out).toEqual({ reason: 'баг не воспроизводится', evidence: ['abc1234'] })
  })
})

describe('квитанция «предмета нет» доезжает до карточки своим словом', () => {
  it('разбирается в своё доказательство с названной уликой', () => {
    const proof = parseReceiptProof('moot:BL-7#1@d253a83b')
    expect(proof).toEqual({ kind: 'moot', ref: 'moot:BL-7#1@d253a83b', evidence: 'd253a83b' })
  })

  it('на карточке это СВОЁ слово, а не «ответ без правки кода»', () => {
    const moot = receiptProofLabel(parseReceiptProof('moot:BL-7#1@d253a83b') as any)
    const answer = receiptProofLabel(parseReceiptProof('answer:BL-7#1') as any)
    expect(moot).toContain('Предмета нет')
    expect(moot).toContain('d253a83b') // чем проверяли — видно, не открывая поток
    expect(moot).not.toBe(answer)
  })
})

describe('работнику СКАЗАНО, что такой конец существует', () => {
  const prompt = buildTaskPrompt({ task: { id: 'BL-1', title: 'проверить жалобу', acceptance: 'а' } })

  it('задание называет исход и оба его маркера', () => {
    expect(prompt).toContain(MOOT_MARKERS.moot)
    expect(prompt).toContain(MOOT_MARKERS.evidence)
  })

  it('задание называет и оба правила о форме работы', () => {
    // Механизм, о котором потребитель не знает, для него не существует — а оба этих правила
    // отклоняют попытку, и узнавать о них из красной строки поздно.
    expect(prompt).toContain('Тест обязан говорить о продукте, а не о себе')
    expect(prompt).toContain('Новый каталог верхнего уровня')
  })
})

// ─────────────────────────── ЖИВОЙ ТИК ───────────────────────────

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

const WORKERS = [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/claude' }, enabled: true }]

/** Копия, которую попытка доказуемо не тронула: ноль коммитов от базы, чистое дерево. */
function makeDeps({ adapter, clock, lines, catFile }: any) {
  const journal: any[] = []
  return {
    journal,
    deps: {
      adapter,
      journal: (e: any) => journal.push(e),
      ledger: { recordAttempt: (a: any) => a, readAttempts: () => [] },
      config: { workers: WORKERS, agingHours: 24, backlogScanMinutes: 60, repoDir: '/repo', pipeline: { enabled: true } },
      routing: { resolveRoute },
      windows: () => true,
      buildArgs: () => ({ bin: 'exec', args: ['-'], env: {}, prompt: 'p' }),
      verbRunner: async (_bin: string, argv: string[]) => {
        const verb = argv[1]
        if (verb === 'preflight') return { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) }
        if (verb === 'worktree') {
          return { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/moot', branch: 'wt/moot', expectedBase: 'base0' }) }
        }
        return { code: 0, stdout: '{}' }
      },
      execGit: (argv: string[]) => {
        if (argv[0] === 'rev-list') return '0' // попытка доказуемо ничего не положила на ветку
        if (argv[0] === 'status') return '' // и дерево чисто
        if (argv[0] === 'cat-file') return catFile ?? 'commit'
        return ''
      },
      fsImpl: {
        existsSync: () => false,
        readFileSync: () => {
          throw new Error('ENOENT')
        },
        readdirSync: () => [],
        mkdirSync: () => {},
        writeFileSync: () => {},
        rmSync: () => {},
      },
      spawnWorker: (spec: any) => {
        for (const l of lines) spec.onLine?.(l)
        spec.onExit?.({ code: 0, signal: null })
        return { pid: 1, kill: () => {} }
      },
      report: async () => {},
      clock,
    },
  }
}

const TASK = { source: 'backlog', title: 't', lane: 'prod', storyPoints: 1, acceptance: 'a' }
const NOTE_AND_LESSON = ['APPROACH_NOTE: проверил жалобу, правок не потребовалось', 'LESSON_NONE: разбор без правки']

describe('выходной гейт: «предмета нет» — конец наравне со «сделано»', () => {
  it('подтверждённая улика даёт СВОЮ квитанцию, и строка ждёт человека, а не краснеет', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue({ id: 'BL-MOOT', ...TASK })
    const { deps, journal } = makeDeps({
      adapter,
      clock: c.clock,
      lines: [...NOTE_AND_LESSON, `${MOOT_MARKERS.moot} жалоба закрыта 28.08`, `${MOOT_MARKERS.evidence} d253a83b`],
    })

    const res = await tick(deps)

    expect(res.completed).toBe('BL-MOOT')
    const [row] = await adapter.list({})
    expect(row.status).toBe('awaiting_approval')
    const said = journal.find((e) => e.type === 'task.moot')
    expect(said, 'исход, о котором молчит журнал, человеку не виден').toBeTruthy()
    expect(said.receiptRef).toMatch(/^moot:.*@d253a83b$/)
    expect(said.detail).toContain('жалоба закрыта 28.08')
  })

  it('НЕПОДТВЕРЖДЁННАЯ улика квитанции не даёт — и понижение СКАЗАНО ВСЛУХ', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue({ id: 'BL-WORD', ...TASK })
    const { deps, journal } = makeDeps({
      adapter,
      clock: c.clock,
      catFile: 'error', // такого коммита в копии нет
      lines: [...NOTE_AND_LESSON, `${MOOT_MARKERS.moot} предмета нет`, `${MOOT_MARKERS.evidence} deadbee`],
    })

    const res = await tick(deps)

    // Попытка остаётся честным ОТВЕТОМ — заявление её не портит и не улучшает.
    expect(res.completed).toBe('BL-WORD')
    expect(journal.some((e) => e.type === 'task.moot')).toBe(false)
    const said = journal.find((e) => e.type === 'task.moot_unproven')
    expect(said, 'молчаливое понижение выглядит как «работник ничего не заявлял»').toBeTruthy()
    const answered = journal.find((e) => e.type === 'task.answered')
    expect(String(answered.receiptRef)).toMatch(/^answer:/)
  })

  it('заявление БЕЗ улики не проходит вовсе — парсер его не признаёт', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue({ id: 'BL-BARE', ...TASK })
    const { deps, journal } = makeDeps({
      adapter,
      clock: c.clock,
      lines: [...NOTE_AND_LESSON, `${MOOT_MARKERS.moot} предмета нет`],
    })

    await tick(deps)

    expect(journal.some((e) => e.type === 'task.moot')).toBe(false)
    expect(journal.some((e) => e.type === 'task.moot_unproven')).toBe(false)
    expect(String(journal.find((e) => e.type === 'task.answered').receiptRef)).toMatch(/^answer:/)
  })
})
