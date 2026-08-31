/**
 * Tests for tools/terminal-parity-check.mjs — ONE command over ONE run directory.
 *
 * THE SHAPE OF THIS SUITE IS THE POINT. A checker that only ever sees a complete run proves
 * nothing, because a checker hard-wired to print «six out of six» would pass that test too.
 * So every receipt gets a fixture in which exactly one fact is wrong or missing, and the suite
 * asserts that THAT line — and only that line — stops being green, and that the command's exit
 * code stops being 0. Fixtures live in an injected in-memory filesystem: no disk is touched,
 * no real `.sma/runs` is read, and no process is spawned.
 *
 * IT ALSO TESTS THE WIRE, NOT ONLY THE RESULT. The verdict is computed in a shared module so
 * that this command and the daemon can never disagree about what «the hooks fired» means. A
 * suite that only checked the printed lines would stay green on the day somebody quietly gave
 * the command a private second copy of the logic — so one test reads the command's own source
 * and asserts the import and the call, and another asserts that what is printed equals what
 * the module returns for the same data.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, it, expect } from 'vitest'

import {
  PARITY_RECEIPTS,
  PARITY_RECEIPT_COUNT,
  evaluateParity,
} from '../../scripts/sma/lib/parity-receipts.mjs'
import {
  runCheck,
  parseArgv,
  formatReport,
  latestRunDir,
  LABEL,
  USAGE,
} from '../../tools/terminal-parity-check.mjs'
import { humanOnlyDenials } from '../src/queue/capability-envelope.mjs'

const PROJECT = '/proj'
const RUNS = `${PROJECT}/.sma/runs`
const DIR = `${RUNS}/demo-task_1`
const CONFIG = '/cfg/config.json'
const LEDGER = '/ledger/demo-task.jsonl'

const STARTED = '2026-08-01T10:00:00.000Z'
const ENDED = '2026-08-01T10:20:00.000Z'

/** An in-memory fs with OS-agnostic keys (join() yields backslashes on win32). */
function fakeFs(files: Record<string, string>, mtimes: Record<string, number> = {}) {
  const norm = (p: string) => String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  const table = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]))
  const enoent = (k: string) => Object.assign(new Error(`ENOENT: ${k}`), { code: 'ENOENT' })
  return {
    existsSync: (p: string) => {
      const k = norm(p)
      if (table.has(k)) return true
      for (const key of table.keys()) if (key.startsWith(`${k}/`)) return true
      return false
    },
    readFileSync: (p: string) => {
      const k = norm(p)
      if (!table.has(k)) throw enoent(k)
      return table.get(k) as string
    },
    readdirSync: (p: string) => {
      const base = norm(p)
      const out = new Set<string>()
      for (const key of table.keys()) {
        if (key.startsWith(`${base}/`)) out.add(key.slice(base.length + 1).split('/')[0])
      }
      if (!out.size) throw enoent(base)
      return [...out]
    },
    statSync: (p: string) => ({ mtimeMs: mtimes[norm(p)] ?? 0 }),
  }
}

const jsonl = (rows: any[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

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
    // одно имя — один аргумент, как их кладёт сборщик: шаблон запрета несёт пробел внутри себя
    '--allowedTools',
    'Read',
    'Write',
    'Bash',
    '--disallowedTools',
    ...humanOnlyDenials({ humanOnlyActions: ['push', 'merge', 'tag', 'deploy'] }).patterns,
    // модель и усилие — те же флаги, что кладёт сборщик запуска
    '--model',
    'sonnet',
    '--effort',
    'high',
  ],
  envelope: {
    allowedTools: ['Read', 'Write', 'Bash'],
    humanOnlyActions: ['push', 'merge', 'tag', 'deploy'],
    hash: 'e3b0c442',
  },
  // то, что профиль обещал этой попытке, — записано рядом с командной строкой, как конверт
  profile: { model: 'sonnet', effort: 'high' },
  task: { model: null, effort: null },
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

const CONFIG_JSON = {
  workers: [{ id: 'max-1', lane: 'prod', provider: 'claude', model: 'sonnet', effort: 'high' }],
}

/** The transcript is ONE line: a reference to the ledger, carrying the digest of the file. */
const LEDGER_TEXT = jsonl([{ line: 'первая строка потока' }, { line: 'вторая' }])
const STALE_SHA = 'f'.repeat(64)

const shaOf = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

function ledgerRefLine(sha: string, path: string | null = LEDGER) {
  return jsonl([
    { kind: 'ledger-ref', ledgerPath: path, sha256: sha, lines: 2, bytes: LEDGER_TEXT.length, truncatedLines: 0 },
  ])
}

/** The complete run: every artifact present, every receipt earnable. */
function fullFiles(over: Record<string, any> = {}) {
  const files: Record<string, string> = {
    [`${DIR}/run.json`]: JSON.stringify(RUN),
    [`${DIR}/guards.jsonl`]: jsonl(GUARDS),
    [`${DIR}/transcript.jsonl`]: ledgerRefLine(shaOf(LEDGER_TEXT)),
    [`${DIR}/receipt.json`]: JSON.stringify(RECEIPT),
    [LEDGER]: LEDGER_TEXT,
    [CONFIG]: JSON.stringify(CONFIG_JSON),
  }
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete files[k]
    else files[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return files
}

const DEFAULT_ARGV = ['demo-task#1', '--project', PROJECT, '--config', CONFIG]

/** Drive the real CLI entry point over a fixture; return {code, out, errOut}. */
function run(files: Record<string, string>, argv: string[] = DEFAULT_ARGV, mtimes: Record<string, number> = {}) {
  const out: string[] = []
  const errOut: string[] = []
  const code = runCheck(argv, {
    fsImpl: fakeFs(files, mtimes),
    log: (l: string) => out.push(String(l)),
    err: (l: string) => errOut.push(String(l)),
    cwd: '/elsewhere',
  })
  return {
    code,
    out,
    errOut,
    last: out[out.length - 1],
    line: (id: string) => out[PARITY_RECEIPTS.findIndex((r) => r.id === id)],
  }
}

describe('terminal-parity-check — a complete run', () => {
  it('prints six receipts and the bare number: six green when both halves of the envelope travelled', () => {
    const r = run(fullFiles())
    expect(r.out).toHaveLength(PARITY_RECEIPT_COUNT + 1)
    expect(r.line('hooks')).toMatch(/^OK — /)
    expect(r.line('memory')).toMatch(/^OK — /)
    expect(r.line('rules')).toMatch(/^OK — /)
    expect(r.line('skills')).toMatch(/^OK — /)
    expect(r.line('rights')).toMatch(/^OK — /)
    expect(r.line('profile')).toMatch(/^OK — /)
    expect(r.last).toBe('6')
    expect(Number.isFinite(Number(r.last))).toBe(true) // receipt-hash / scorer contract
    expect(r.code).toBe(0)
  })

  // ЭТО СОСТОЯНИЕ КВИТАНЦИЯ ДЕРЖАЛА ЖЁЛТЫМ ВСЮ СВОЮ ЖИЗНЬ, и жёлтое было правдой: до
  // процесса доезжала только половина конверта. Теперь оно КРАСНОЕ, потому что вторая
  // половина умеет доезжать, и её отсутствие — не оговорка, а провал.
  it('конверт назвал человеческие действия, а запрета в аргументах нет — FAIL, не WARN', () => {
    const withoutDenials = { ...RUN, args: ['-p', '--output-format', 'stream-json', '--allowedTools', 'Read', 'Write', 'Bash'] }
    const r = run(fullFiles({ [`${DIR}/run.json`]: withoutDenials }))
    expect(r.line('rights')).toMatch(/^FAIL — /)
    expect(r.line('rights')).toContain('--disallowedTools')
    expect(r.code).toBe(1)
  })
})

describe('terminal-parity-check — the verdict is computed in the shared module', () => {
  const source = readFileSync(new URL('../../tools/terminal-parity-check.mjs', import.meta.url), 'utf8')

  it('imports the evaluation instead of carrying a second copy of it', () => {
    expect(source).toMatch(/from '\.\.\/scripts\/sma\/lib\/parity-receipts\.mjs'/)
    expect(source).toMatch(/evaluateParity\(/)
    // a private re-implementation would show up as the checks themselves living in the tool
    expect(source).not.toMatch(/function check(Hooks|Memory|Rules|Skills|Rights|Profile)\b/)
  })

  it('prints exactly what the module returned for the same artifacts — one logic, two callers', () => {
    const printed = run(fullFiles()).out.slice(0, PARITY_RECEIPT_COUNT)
    const direct = evaluateParity({
      run: RUN,
      guards: GUARDS,
      receipt: RECEIPT,
      worker: CONFIG_JSON.workers[0],
    })
    const expected = direct.map(
      (res: any, i: number) => `${LABEL[res.status]} — ${PARITY_RECEIPTS[i].title}: ${res.detail}`,
    )
    expect(printed).toEqual(expected)
  })
})

describe('terminal-parity-check — every receipt has its own way of going red', () => {
  it('a hook that was started and never answered → the hooks receipt fails and says so', () => {
    const r = run(fullFiles({ [`${DIR}/guards.jsonl`]: jsonl([GUARDS[0]]) }))
    expect(r.line('hooks')).toMatch(/^FAIL — /)
    expect(r.line('hooks')).toMatch(/ответа нет/)
    expect(r.last).toBe('5')
    expect(r.code).not.toBe(0)
  })

  it('guard entries outside the run window do not count — the window is the receipt', () => {
    const stale = jsonl([{ ts: '2026-07-31T09:00:00.000Z', kind: 'hook_response', hookName: 'sma-guard' }])
    expect(run(fullFiles({ [`${DIR}/guards.jsonl`]: stale })).line('hooks')).toMatch(/^FAIL — /)
  })

  it('a memory layer with no index and no load call → the memory receipt fails', () => {
    const receipt = { ...RECEIPT, memoryLayer: { index: false, reads: [], loadCalls: 0, reflexes: [], failed: [] } }
    const r = run(fullFiles({ [`${DIR}/receipt.json`]: receipt }))
    expect(r.line('memory')).toMatch(/^FAIL — /)
    expect(r.code).not.toBe(0)
  })

  it('rules absent from the copy → the rules receipt fails', () => {
    const receipt = { ...RECEIPT, rules: { claudeMd: 'absent' } }
    const runJson = { ...RUN, rules: { claudeMd: 'absent' } }
    const r = run(fullFiles({ [`${DIR}/receipt.json`]: receipt, [`${DIR}/run.json`]: runJson }))
    expect(r.line('rules')).toMatch(/^FAIL — /)
  })

  it('a project with no skills and no agents → n/a with the reason, and the run stays green', () => {
    const receipt = { ...RECEIPT, skillsInCopy: null }
    const runJson = { ...RUN, skillsInCopy: null }
    const r = run(fullFiles({ [`${DIR}/receipt.json`]: receipt, [`${DIR}/run.json`]: runJson }))
    expect(r.line('skills')).toMatch(/^n\/a — /)
    expect(r.line('skills')).toContain('.claude/skills')
    expect(r.last).toBe('6')
    expect(r.code).toBe(0)
  })

  it('a spawn narrower than the envelope → the rights receipt fails and names the difference', () => {
    const runJson = { ...RUN, args: ['-p', '--allowedTools', 'Read'] }
    const r = run(fullFiles({ [`${DIR}/run.json`]: runJson }))
    expect(r.line('rights')).toMatch(/^FAIL — /)
    expect(r.line('rights')).toContain('Bash')
    expect(r.code).not.toBe(0)
  })

  // СВЕРКА, КОТОРАЯ РАНЬШЕ МОЛЧАЛА. Спавн под чужой моделью замок не пропустит — но пока
  // квитанции о нём не было, отчёт о таком прогоне выглядел бы полным.
  it('a spawn under a model the profile never assigned → the profile receipt fails and names both', () => {
    const runJson = { ...RUN, args: [...RUN.args.slice(0, -4), '--model', 'opus', '--effort', 'high'] }
    const r = run(fullFiles({ [`${DIR}/run.json`]: runJson }))
    expect(r.line('profile')).toMatch(/^FAIL — /)
    expect(r.line('profile')).toContain('opus')
    expect(r.line('profile')).toContain('sonnet')
    expect(r.last).toBe('5')
    expect(r.code).not.toBe(0)
  })

  // Записи, сделанные до того, как обещание стали писать рядом с командной строкой, читаются
  // по работнику из `--config` — слабее, но честно, и источник печатается.
  it('a record written before run.profile existed falls back to the config worker, and says so', () => {
    const { profile, ...older } = RUN as Record<string, any>
    const r = run(fullFiles({ [`${DIR}/run.json`]: older }))
    expect(r.line('profile')).toMatch(/^OK — /)
    expect(r.line('profile')).toContain('конфиг демона')
    expect(r.code).toBe(0)
  })
})

describe('terminal-parity-check — missing data is never a pass', () => {
  it('an empty run directory → six failures, all naming the file they wanted', () => {
    const r = run({ [CONFIG]: JSON.stringify(CONFIG_JSON), [`${DIR}/guards.jsonl`]: '' })
    for (const { id } of PARITY_RECEIPTS) expect(r.line(id)).toMatch(/^FAIL — /)
    expect(r.out.join('\n')).toContain('данных нет')
    expect(r.last).toBe('0')
    expect(r.code).toBe(1)
  })

  it('an older run.json without an envelope, and a receipt without a memory layer, fail honestly', () => {
    const truncatedRun = { attemptId: 'demo-task#1', startedAt: STARTED, endedAt: ENDED, args: ['-p'] }
    const truncatedReceipt = { outcome: 'completed', verdict: 'green' }
    const r = run(fullFiles({ [`${DIR}/run.json`]: truncatedRun, [`${DIR}/receipt.json`]: truncatedReceipt }))
    expect(r.line('memory')).toMatch(/^FAIL — .*данных нет/)
    expect(r.line('rules')).toMatch(/^FAIL — .*данных нет/)
    expect(r.line('rights')).toMatch(/^FAIL — .*данных нет/)
    // запись без обещания профиля и без имени работника: сверять не с чем, и это сказано
    expect(r.line('profile')).toMatch(/^FAIL — .*данных нет/)
    expect(r.line('profile')).toContain('run.profile')
    expect(r.line('hooks')).toMatch(/^OK — /) // the window and the guard log are still there
    expect(r.code).not.toBe(0)
  })

  it('no run directories at all → a named absence on stderr and a non-zero exit', () => {
    const r = run({ [CONFIG]: JSON.stringify(CONFIG_JSON) }, ['--project', PROJECT, '--config', CONFIG])
    expect(r.errOut.join('\n')).toContain('данных нет')
    expect(r.errOut.join('\n')).toContain('.sma/runs')
    expect(r.last).toBe('0')
    expect(r.code).toBe(1)
  })
})

describe('terminal-parity-check — choosing the attempt', () => {
  it('--attempt names the same directory the positional argument would', () => {
    const r = run(fullFiles(), ['--attempt', 'demo-task#1', '--project', PROJECT, '--config', CONFIG])
    expect(r.last).toBe('6')
    expect(r.code).toBe(0)
  })

  it('--project is the base of .sma/runs, so the command runs from anywhere', () => {
    expect(run(fullFiles(), ['demo-task#1', '--project', PROJECT, '--config', CONFIG]).code).toBe(0)
    // the same fixture with no --project looks under the working directory and finds nothing
    expect(run(fullFiles(), ['demo-task#1', '--config', CONFIG]).code).toBe(1)
  })

  it('with no attempt named it takes the LATEST by startedAt, not the first one listed', () => {
    const files = fullFiles()
    const older = `${RUNS}/demo-task_0`
    files[`${older}/run.json`] = JSON.stringify({
      ...RUN,
      attemptId: 'demo-task#0',
      startedAt: '2026-07-01T10:00:00.000Z',
      endedAt: '2026-07-01T10:05:00.000Z',
    })
    files[`${older}/guards.jsonl`] = '' // the older attempt has no hooks: it would score 5
    files[`${older}/receipt.json`] = JSON.stringify(RECEIPT)
    const r = run(files, ['--project', PROJECT, '--config', CONFIG])
    expect(r.last).toBe('6')
    expect(r.code).toBe(0)
  })

  it('a directory whose run.json is unreadable falls back to its own mtime, never to immortality', () => {
    const files: Record<string, string> = {
      [`${RUNS}/broken/run.json`]: '{not json',
      [`${RUNS}/broken/guards.jsonl`]: '',
    }
    const fs = fakeFs(files, { [`${RUNS}/broken`]: 42 })
    expect(String(latestRunDir(fs, RUNS)).replace(/\\/g, '/')).toBe(`${RUNS}/broken`)
    expect(latestRunDir(fs, `${RUNS}/nothing-here`)).toBe(null)
  })
})

describe('terminal-parity-check — the ledger reference', () => {
  it('a matching digest is reported as a note, and the receipts stand on their own', () => {
    const r = run(fullFiles())
    expect(r.errOut.join('\n')).toMatch(/леджер/)
    expect(r.errOut.join('\n')).not.toMatch(/изменился/)
    expect(r.code).toBe(0)
  })

  it('a digest that no longer matches says the ledger changed — and does NOT sink the receipts', () => {
    const r = run(fullFiles({ [`${DIR}/transcript.jsonl`]: ledgerRefLine(STALE_SHA) }))
    expect(r.errOut.join('\n')).toContain('леджер изменился после записи')
    expect(r.last).toBe('6') // the six read run.json, guards.jsonl and receipt.json — not this
    expect(r.code).toBe(0)
  })

  it('a ledger that is gone is reported as unavailable, not as a mismatch', () => {
    const r = run(fullFiles({ [LEDGER]: null }))
    expect(r.errOut.join('\n')).toContain('леджер недоступен')
    expect(r.code).toBe(0)
  })
})

describe('terminal-parity-check — the command contract', () => {
  it('--json prints the object a scorer reads, and still ends on the bare number', () => {
    const r = run(fullFiles(), [...DEFAULT_ARGV, '--json'])
    expect(r.last).toBe('6')
    const parsed = JSON.parse(r.out.slice(0, -1).join('\n'))
    expect(Object.keys(parsed).sort()).toEqual(['attemptId', 'dir', 'exitCode', 'fulfilled', 'receipts'])
    expect(parsed.attemptId).toBe('demo-task#1')
    expect(String(parsed.dir).replace(/\\/g, '/')).toBe(DIR)
    expect(parsed.receipts).toHaveLength(PARITY_RECEIPT_COUNT)
    expect(parsed.receipts.map((x: any) => x.id)).toEqual(PARITY_RECEIPTS.map((x) => x.id))
    expect(parsed.receipts.every((x: any) => typeof x.detail === 'string' && x.detail.length > 0)).toBe(true)
    expect(parsed.fulfilled).toBe(6)
    expect(parsed.exitCode).toBe(0)
    expect(r.code).toBe(0)
  })

  it('an unknown flag is refused with usage and exit 2 — never a quiet success', () => {
    const errOut: string[] = []
    const code = runCheck(['--nope'], { log: () => {}, err: (l: string) => errOut.push(l) })
    expect(code).toBe(2)
    expect(errOut.join('\n')).toContain('--nope')
    expect(errOut.join('\n')).toContain('usage: node tools/terminal-parity-check.mjs')
  })

  it('a flag without its value, or a second attempt id, is refused the same way', () => {
    expect(parseArgv(['--attempt']).error).toBeTruthy()
    expect(parseArgv(['--project', '--json']).error).toBeTruthy()
    expect(parseArgv(['a', 'b']).error).toBeTruthy()
  })

  it('parseArgv accepts the attempt in either shape, and no attempt at all is not an error', () => {
    expect(parseArgv(['demo-task#1'])).toMatchObject({ attemptId: 'demo-task#1', json: false })
    expect(parseArgv(['--attempt', 'demo-task#1', '--json'])).toMatchObject({ attemptId: 'demo-task#1', json: true })
    expect(parseArgv([])).toMatchObject({ attemptId: null, dir: null, project: null })
    expect(parseArgv([]).error).toBeUndefined() // no attempt named is a request, not a mistake
  })

  it('the report always prints six receipts plus the number, in a fixed order', () => {
    const report = formatReport(evaluateParity({}))
    expect(report.lines).toHaveLength(PARITY_RECEIPT_COUNT + 1)
    expect(report.lines.slice(0, PARITY_RECEIPT_COUNT).every((l: string) => /^(OK|WARN|n\/a|FAIL) — /.test(l))).toBe(true)
    expect(report.lines[PARITY_RECEIPT_COUNT]).toBe('0') // an empty run earns nothing
    expect(report.exitCode).not.toBe(0)
  })

  it('the usage text names the six receipts, the flags and the numeric contract', () => {
    for (const { id } of PARITY_RECEIPTS) expect(USAGE).toContain(id)
    expect(USAGE).toContain('0..6')
    expect(USAGE).toContain('--attempt')
    expect(USAGE).toContain('--project')
    expect(USAGE).toContain('--json')
  })
})
