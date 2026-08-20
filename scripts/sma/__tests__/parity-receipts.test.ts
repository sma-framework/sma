/**
 * Tests for scripts/sma/lib/parity-receipts.mjs — the five receipts of one run.
 *
 * THE SHAPE OF THIS SUITE IS THE POINT. A checker that only ever sees a complete run proves
 * nothing, because a checker hard-wired to print «five out of five» would pass that test too.
 * So every receipt gets its own matrix: the state that earns it, the state that sinks it, and
 * the state in which the DATA ITSELF is missing — because the failure this module exists to
 * refuse is not a red run, it is a green verdict pronounced over an empty directory.
 *
 * The module is pure: it is handed the four artifacts already parsed, so nothing here touches
 * a disk, a real `.sma/runs` or a clock it does not control.
 */

import { describe, it, expect } from 'vitest'

import {
  PARITY_RECEIPTS,
  PARITY_RECEIPT_COUNT,
  evaluateParity,
  summarize,
  isFulfilled,
  allowedToolsInArgs,
  disallowedToolsInArgs,
} from '../lib/parity-receipts.mjs'
import { humanOnlyDenials } from '../../../daemon/src/queue/capability-envelope.mjs'

// Шаблоны запрета берутся у САМОГО продукта: список, переписанный здесь руками, согласился
// бы с ним в день написания и разошёлся бы в любой следующий, а сверять было бы нечего.
const DENIALS = humanOnlyDenials({ humanOnlyActions: ['push', 'merge', 'tag', 'deploy'] }).patterns

const STARTED = '2026-08-01T10:00:00.000Z'
const ENDED = '2026-08-01T10:20:00.000Z'

const RUN = {
  schema: 'sma-run/1',
  attemptId: 'demo-task#1',
  taskId: 'demo-task',
  attempt: 1,
  workerId: 'max-1',
  startedAt: STARTED,
  endedAt: ENDED,
  args: [
    '-p',
    '--output-format',
    'stream-json',
    '--allowedTools',
    'Read Write Bash',
    '--disallowedTools',
    DENIALS.join(' '),
  ],
  envelope: {
    allowedTools: ['Read', 'Write', 'Bash'],
    humanOnlyActions: ['push', 'merge', 'tag', 'deploy'],
    hash: 'e3b0c442',
  },
  rules: { claudeMd: 'materialized' },
  skillsInCopy: { skills: 3, agents: 2 },
}

const GUARDS = [
  { ts: '2026-08-01T10:00:05.000Z', kind: 'hook_started', hookName: 'sma-guard', hookEvent: 'SessionStart' },
  { ts: '2026-08-01T10:00:06.000Z', kind: 'hook_response', hookName: 'sma-guard', hookEvent: 'SessionStart', exitCode: 0 },
]

const RECEIPT = {
  schema: 'sma-receipt/1',
  outcome: 'completed',
  verdict: 'green',
  gate: 'reverify',
  memoryLayer: { index: true, reads: ['role.md'], loadCalls: 0, reflexes: [], failed: [] },
  rules: { claudeMd: 'materialized' },
  skillsInCopy: { skills: 3, agents: 2 },
  parity: null,
}

const WORKER = { id: 'max-1', lane: 'prod', provider: 'claude' }

/** Evaluate a full run with the named parts replaced (a `null` part is an ABSENT artifact). */
function evalWith(over: Record<string, any> = {}) {
  const data: Record<string, any> = { run: RUN, guards: GUARDS, receipt: RECEIPT, worker: WORKER }
  for (const [k, v] of Object.entries(over)) data[k] = v
  const results = evaluateParity(data as any)
  return {
    results,
    of: (id: string) => results.find((r: any) => r.id === id)!,
    sum: summarize(results),
  }
}

/** A copy of the run with one branch replaced — the fixtures stay frozen for every case. */
const runWith = (over: Record<string, any>) => ({ ...RUN, ...over })
const receiptWith = (over: Record<string, any>) => ({ ...RECEIPT, ...over })

describe('parity-receipts — the roster', () => {
  it('names five receipts in one fixed order, and the order is the printed order', () => {
    expect(PARITY_RECEIPTS.map((r) => r.id)).toEqual(['hooks', 'memory', 'rules', 'skills', 'rights'])
    expect(PARITY_RECEIPT_COUNT).toBe(5)
    expect(Object.isFrozen(PARITY_RECEIPTS)).toBe(true)
    for (const r of PARITY_RECEIPTS) expect(String(r.title).length).toBeGreaterThan(10)
  })

  it('evaluateParity always answers with the five, in that order, whatever it was handed', () => {
    for (const data of [{}, { run: RUN }, { receipt: RECEIPT }]) {
      const results = evaluateParity(data as any)
      expect(results.map((r: any) => r.id)).toEqual(PARITY_RECEIPTS.map((r) => r.id))
      expect(results).toHaveLength(PARITY_RECEIPT_COUNT)
    }
  })
})

describe('parity-receipts — a complete run', () => {
  it('earns five OK — and the fifth is green only because BOTH halves of the envelope travelled', () => {
    const { of, sum } = evalWith()
    expect(of('hooks').status).toBe('ok')
    expect(of('memory').status).toBe('ok')
    expect(of('rules').status).toBe('ok')
    expect(of('skills').status).toBe('ok')
    expect(of('rights').status).toBe('ok')
    expect(sum).toMatchObject({ fulfilled: 5, total: 5, warn: 0, ok: 5, failed: [] })
  })

  it('the rights receipt names BOTH numbers it compared, so a green light is readable', () => {
    const rights = evalWith().of('rights')
    expect(rights.detail).toContain('3 инструментов')
    expect(rights.detail).toContain(`${DENIALS.length} запретов`)
  })
})

describe('parity-receipts — an empty directory earns nothing', () => {
  it('no run.json and no receipt.json → five FAIL, each naming the data it did not get', () => {
    const results = evaluateParity({} as any)
    for (const r of results) {
      expect(r.status).toBe('fail')
      expect(r.detail).toContain('данных нет')
    }
    expect(summarize(results)).toMatchObject({ fulfilled: 0, warn: 0, ok: 0 })
    expect(summarize(results).failed).toEqual(['hooks', 'memory', 'rules', 'skills', 'rights'])
  })

  it('half the data is still no data: a run without a receipt sinks all five', () => {
    const { results } = evalWith({ receipt: null })
    expect(results.every((r: any) => r.status === 'fail')).toBe(true)
    expect(results[0].detail).toContain('receipt.json')
  })
})

describe('parity-receipts — (a) hooks: an answer inside this run’s own window', () => {
  it('a hook_response inside the window earns it', () => {
    expect(evalWith().of('hooks')).toMatchObject({ status: 'ok' })
    expect(evalWith().of('hooks').detail).toMatch(/1/)
  })

  it('a start with no answer is a FAILURE that says so — never a silent pass', () => {
    const started = [GUARDS[0]]
    const r = evalWith({ guards: started }).of('hooks')
    expect(r.status).toBe('fail')
    expect(r.detail).toMatch(/хук запущен, ответа нет/)
  })

  it('an answer OUTSIDE the window does not count — the window is what makes it this run’s', () => {
    const stale = [{ ts: '2026-07-31T09:00:00.000Z', kind: 'hook_response', hookName: 'sma-guard' }]
    expect(evalWith({ guards: stale }).of('hooks').status).toBe('fail')
  })

  it('a run still going (no endedAt) is measured up to now, not refused', () => {
    const live = [{ ts: new Date().toISOString(), kind: 'hook_response', hookName: 'sma-guard' }]
    const r = evalWith({ run: runWith({ endedAt: null }), guards: live }).of('hooks')
    expect(r.status).toBe('ok')
  })

  it('an empty guard log is a finding (no hook spoke), a missing one is missing data', () => {
    expect(evalWith({ guards: [] }).of('hooks').detail).not.toContain('данных нет')
    expect(evalWith({ guards: [] }).of('hooks').status).toBe('fail')
    const absent = evalWith({ guards: null }).of('hooks')
    expect(absent.status).toBe('fail')
    expect(absent.detail).toContain('данных нет')
    expect(absent.detail).toContain('guards.jsonl')
  })

  it('a run.json without startedAt cannot draw a window at all', () => {
    const r = evalWith({ run: runWith({ startedAt: null }) }).of('hooks')
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('данных нет')
    expect(r.detail).toMatch(/startedAt/)
  })
})

describe('parity-receipts — (b) memory: the daemon counted it, this module believes it', () => {
  it('a read index earns it', () => {
    expect(evalWith().of('memory')).toMatchObject({ status: 'ok' })
    expect(evalWith().of('memory').detail).toMatch(/индекс прочитан/)
  })

  it('no index but load calls earns it, and says how many', () => {
    const receipt = receiptWith({ memoryLayer: { index: false, reads: [], loadCalls: 2, reflexes: [], failed: [] } })
    const r = evalWith({ receipt }).of('memory')
    expect(r.status).toBe('ok')
    expect(r.detail).toMatch(/load 2/)
  })

  it('a failed read is a failed receipt, and the reason is printed rather than swallowed', () => {
    const receipt = receiptWith({
      memoryLayer: { index: false, reads: [], loadCalls: 0, reflexes: [], failed: [{ kind: 'index', id: 'MEMORY.md', reason: 'read failed' }] },
    })
    const r = evalWith({ receipt }).of('memory')
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('read failed')
    expect(r.detail).toContain('MEMORY.md')
  })

  it('a receipt without a memory layer is missing data, not an absent read', () => {
    const r = evalWith({ receipt: receiptWith({ memoryLayer: null }) }).of('memory')
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('данных нет')
    expect(r.detail).toMatch(/memoryLayer/)
  })
})

describe('parity-receipts — (c) rules: the project’s own instructions reached the copy', () => {
  it('materialized and tracked both earn it, and the word is printed', () => {
    for (const claudeMd of ['materialized', 'tracked']) {
      const r = evalWith({ receipt: receiptWith({ rules: { claudeMd } }) }).of('rules')
      expect(r.status).toBe('ok')
      expect(r.detail).toContain(claudeMd)
    }
  })

  it('absent is a failure — a copy without the rules is a worker without them', () => {
    const r = evalWith({ receipt: receiptWith({ rules: { claudeMd: 'absent' } }) }).of('rules')
    expect(r.status).toBe('fail')
    expect(r.detail).not.toContain('данных нет')
  })

  it('falls back to run.json when the receipt carries no rules — one fact, two places', () => {
    const r = evalWith({ receipt: receiptWith({ rules: null }) }).of('rules')
    expect(r.status).toBe('ok')
    expect(r.detail).toMatch(/run\.json/)
  })

  it('neither place → missing data, never a default OK', () => {
    const r = evalWith({ receipt: receiptWith({ rules: null }), run: runWith({ rules: null }) }).of('rules')
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('данных нет')
  })
})

describe('parity-receipts — (d) skills: a project with none says so honestly', () => {
  it('skills and agents in the copy earn it', () => {
    const r = evalWith().of('skills')
    expect(r.status).toBe('ok')
    expect(r.detail).toMatch(/3/)
    expect(r.detail).toMatch(/2/)
  })

  it('a project with neither directory is n/a WITH THE REASON — counted, never a pass', () => {
    for (const skillsInCopy of [null, { skills: 0, agents: 0 }]) {
      const r = evalWith({ receipt: receiptWith({ skillsInCopy }), run: runWith({ skillsInCopy }) }).of('skills')
      expect(r.status).toBe('n-a')
      expect(r.detail).toContain('.claude/skills')
      expect(r.detail).toContain('.claude/agents')
      expect(isFulfilled(r)).toBe(true)
    }
  })

  it('agents alone are enough — a project may carry no skills and still carry agents', () => {
    const skillsInCopy = { skills: 0, agents: 4 }
    const r = evalWith({ receipt: receiptWith({ skillsInCopy }) }).of('skills')
    expect(r.status).toBe('ok')
  })
})

describe('parity-receipts — (e) rights: both halves of the envelope, measured separately', () => {
  it('the same set in either order is a match — the flag is a set, not a sequence', () => {
    const run = runWith({ args: ['--allowedTools', 'Bash Read Write', '--disallowedTools', [...DENIALS].reverse().join(' ')] })
    expect(evalWith({ run }).of('rights').status).toBe('ok')
  })

  it('a spawn narrower than the envelope is a FAILURE that names the difference', () => {
    const run = runWith({ args: ['--allowedTools', 'Read', '--disallowedTools', DENIALS.join(' ')] })
    const r = evalWith({ run }).of('rights')
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('Write')
    expect(r.detail).toContain('Bash')
  })

  it('an envelope with tools and a spawn without the flag is a failure, not a warning', () => {
    const run = runWith({ args: ['-p', '--output-format', 'stream-json'] })
    const r = evalWith({ run }).of('rights')
    expect(r.status).toBe('fail')
    expect(r.detail).toMatch(/--allowedTools/)
  })

  // ЭТО СОСТОЯНИЕ КВИТАНЦИЯ УДОСТОВЕРЯЛА РАНЬШЕ — жёлтым с оговоркой. Оно провал: конверт
  // называет действия, оставленные человеку, а до процесса от них не доехало ничего.
  it('конверт запрещает, а в аргументах запрета нет — это ПРОВАЛ, а не предупреждение', () => {
    const run = runWith({ args: ['--allowedTools', 'Read Write Bash'] })
    const r = evalWith({ run }).of('rights')
    expect(r.status).toBe('fail')
    expect(r.detail).toMatch(/--disallowedTools/)
    expect(r.detail).toMatch(/в журнале/)
  })

  it('запрет доехал наполовину — провал с перечислением того, чего нет', () => {
    const run = runWith({ args: ['--allowedTools', 'Read Write Bash', '--disallowedTools', 'Bash(git push:*)'] })
    const r = evalWith({ run }).of('rights')
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('Bash(git merge:*)')
  })

  it('в аргументах запрет, которого конверт не объявлял, — тоже расхождение', () => {
    const run = runWith({
      args: ['--allowedTools', 'Read Write Bash', '--disallowedTools', [...DENIALS, 'Bash(rm:*)'].join(' ')],
    })
    const r = evalWith({ run }).of('rights')
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('Bash(rm:*)')
  })

  it('человеческое действие без единого шаблона запрета — провал: такой запрет не доехал никуда', () => {
    const run = runWith({
      envelope: { allowedTools: ['Read', 'Write', 'Bash'], humanOnlyActions: ['push', 'подписать-релиз'] },
      args: ['--allowedTools', 'Read Write Bash', '--disallowedTools', humanOnlyDenials({ humanOnlyActions: ['push'] }).patterns.join(' ')],
    })
    const r = evalWith({ run }).of('rights')
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('подписать-релиз')
  })

  // Шаблон запрета несёт пробел ВНУТРИ скобок. Читатель, который делит строку по пробелам,
  // разорвёт его на два куска, не совпадающих ни с чем, и объявит расхождение, которого нет.
  it('шаблон с пробелом внутри скобок читается целиком, а не разрывается на куски', () => {
    expect(disallowedToolsInArgs(['--disallowedTools', 'Bash(git push:*) Bash(npm publish:*)'])).toEqual([
      'Bash(git push:*)',
      'Bash(npm publish:*)',
    ])
    expect(allowedToolsInArgs(['--allowedTools', 'Read Grep Bash'])).toEqual(['Read', 'Grep', 'Bash'])
    expect(disallowedToolsInArgs(['-p'])).toBe(null)
  })

  it('конверт без человеческих действий вовсе — зелено, и это сказано словами', () => {
    const run = runWith({ envelope: { allowedTools: ['Read', 'Write', 'Bash'] }, args: ['--allowedTools', 'Read Write Bash'] })
    const r = evalWith({ run }).of('rights')
    expect(r.status).toBe('ok')
    expect(r.detail).toContain('не назвал ни одного человеческого действия')
  })

  it('an envelope that carries no tool list at all is missing data', () => {
    for (const envelope of [null, { hash: 'x' }, { allowedTools: [] }]) {
      const r = evalWith({ run: runWith({ envelope }) }).of('rights')
      expect(r.status).toBe('fail')
      expect(r.detail).toContain('данных нет')
    }
  })

  it('a run.json without an argument array is missing data', () => {
    const r = evalWith({ run: runWith({ args: null }) }).of('rights')
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('данных нет')
  })
})

describe('parity-receipts — the arithmetic of a verdict', () => {
  it('fulfilled counts ok, warn and n/a — and never a failure', () => {
    expect(isFulfilled({ id: 'x', status: 'ok', detail: '' })).toBe(true)
    expect(isFulfilled({ id: 'x', status: 'warn', detail: '' })).toBe(true)
    expect(isFulfilled({ id: 'x', status: 'n-a', detail: '' })).toBe(true)
    expect(isFulfilled({ id: 'x', status: 'fail', detail: '' })).toBe(false)
    expect(isFulfilled(null as any)).toBe(false)
  })

  it('summarize names the failed receipts by id, so a report can be read without counting', () => {
    const { sum } = evalWith({ guards: null, receipt: receiptWith({ rules: { claudeMd: 'absent' } }) })
    expect(sum.failed).toEqual(['hooks', 'rules'])
    expect(sum.fulfilled).toBe(3)
    expect(sum.total).toBe(5)
  })

  it('a receipt this module never produced still counts as unfulfilled rather than crashing', () => {
    const sum = summarize([{ id: 'hooks', status: 'ok', detail: '' }] as any)
    expect(sum.total).toBe(5)
    expect(sum.fulfilled).toBe(1)
    expect(sum.failed).toEqual(['memory', 'rules', 'skills', 'rights'])
  })
})

describe('a receipt never states a fact about something nobody looked at', () => {
  // The skills receipt has two very different silences to tell apart: a copy that was counted
  // and held nothing, and a copy that was never counted at all. Only the first one is a project
  // without skills; calling the second one that would put an unchecked claim into a full set.
  const runWith = (extra: Record<string, unknown> = {}) => ({
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    args: ['--allowedTools', 'Read Bash'],
    envelope: { allowedTools: ['Read', 'Bash'] },
    ...extra,
  })
  const receiptWith = (extra: Record<string, unknown> = {}) => ({
    memoryLayer: { index: true, loadCalls: 0 },
    rules: { claudeMd: 'materialized' },
    ...extra,
  })
  const skillsOf = (run: unknown, receipt: unknown) =>
    evaluateParity({ run, guards: [], receipt }).find((r: { id: string }) => r.id === 'skills')

  it('counted and empty is an honest n/a about the project', () => {
    const r = skillsOf(runWith(), receiptWith({ skillsInCopy: { skills: 0, agents: 0 } }))
    expect(r.status).toBe('n-a')
    expect(r.detail).toContain('в проекте нет')
  })

  it('never counted goes red and names what is missing', () => {
    const r = skillsOf(runWith(), receiptWith())
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('данных нет')
    expect(r.detail).not.toContain('в проекте нет')
  })
})
