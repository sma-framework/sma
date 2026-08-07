/**
 * terminal-journal.mjs — the record of what still gets done at a terminal, kept by the
 * machine rather than by anybody's memory.
 *
 * WHY THIS FILE EXISTS. The bar this release is judged against is a plain sentence: for
 * five working days in a row the work is started from the app, and the only things left at
 * a command line are the four kinds that were agreed to stay there — a measuring run, git
 * history surgery, removing the framework from a project, and starting or debugging the
 * daemon itself. A sentence like that is either proved by evidence collected AS IT HAPPENS
 * or it is proved by someone remembering their own week, which is not evidence at all. So
 * every terminal session leaves one line here, and the report below counts the lines that
 * are not one of the four. The number it prints last IS the claim.
 *
 * TWO MODES, ONE FILE
 *   log     append one line. Meant to be a SessionStart hook, so nobody has to remember it.
 *   report  read the lines, put each in one of the four kinds or outside them, print the
 *           table, and finish with the count of the ones outside.
 *
 * THREE THINGS IT REFUSES TO DO
 *   1. It never breaks a terminal. `log` catches everything and exits 0 — an unwritable
 *      directory, a full disk, a file someone made read-only. A journal that can stop a
 *      person from starting their session would be worse than no journal.
 *   2. It never counts the machine's own sessions. A session the daemon spawns carries
 *      SMA_HEADLESS in its environment (daemon/src/runner/args.mjs puts it in every env it
 *      builds, both lanes) — that session IS the work being done from the app, and writing
 *      it down as a terminal run would drown the evidence in the very thing it is measuring.
 *      One import, one name: the constant is imported from where it is set, never retyped.
 *   3. It never answers "zero" out of an empty hand. A journal that does not exist is not
 *      a clean week; `report` says so and exits 3 instead of printing a number nobody
 *      earned.
 *
 * WHAT A LINE SAYS, AND WHO SAYS IT. `{ts, cwd, cmd}` is the spine; `why` and `source` are
 * added when they are known. The kind of a run is decided from `why` first and `cmd` after
 * it, because a session start knows WHEN a terminal opened and cannot know WHAT FOR: that
 * word comes from the person, either as the tail of a manual call
 * (`node supervisor/terminal-journal.mjs log rebasing the release branch`) or from
 * SMA_TERMINAL_REASON in the environment of a terminal opened on purpose for one of the
 * four. An unlabelled session is counted OUTSIDE, deliberately: the burden is on the run
 * that wants to be excused, not on the report.
 *
 * WHERE IT LIVES. `~/.sma-daemon/terminal-sessions.ndjson`, beside the daemon's own
 * machine-local state, overridable with SMA_TERMINAL_JOURNAL (which is how the tests point
 * it at a temporary directory). It is never committed: it is a record of one machine's
 * week, it holds the working directories and the words its owner typed, and the repository
 * has no business carrying either.
 *
 * USAGE
 *   node supervisor/terminal-journal.mjs log [what this terminal is for]
 *   node supervisor/terminal-journal.mjs report [--since YYYY-MM-DD]
 *
 * EXIT CODES: log always 0. report — 0 read and counted, 3 no journal to read, 1 unexpected.
 *
 * Node built-ins only.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HEADLESS_ENV } from '../daemon/src/runner/args.mjs'

/** The environment variable that moves the journal (tests, and a machine with another home). */
export const JOURNAL_ENV = 'SMA_TERMINAL_JOURNAL'

/** The environment variable a person sets when a terminal is opened for one of the four. */
export const REASON_ENV = 'SMA_TERMINAL_REASON'

/**
 * WHITELIST — the four kinds of terminal work that were agreed to stay at a terminal,
 * in the order they are tried. Each is described by MEANING: what the person is doing,
 * not which internal item asked for it.
 *
 * They are patterns over a short human phrase, so they are generous on purpose — a kind
 * that fails to match makes the report cry wolf, and a report that cries wolf gets ignored,
 * which is the only failure mode that costs the whole exercise. The rule they enforce is
 * the closed list itself: FOUR entries, and a fifth is a decision by the machine's owner,
 * not a line added here.
 */
export const WHITELIST = Object.freeze([
  {
    id: 'measurement',
    label: 'a measuring run (baseline / replay)',
    test: /\b(baseline|replay|bench|benchmark|measure)\b|замер/i,
  },
  {
    id: 'history-surgery',
    label: 'git history surgery',
    test: /\b(rebase|filter-branch|filter-repo|cherry-pick|bisect|reflog)\b|\breset\s+--hard\b|\bpush\s+--?f(orce)?\b|force-with-lease|истори|хирург/i,
  },
  {
    id: 'framework-removal',
    label: 'removing the framework from a project',
    test: /\bdeleteme\b|\buninstall\b|снос/i,
  },
  {
    id: 'daemon-repair',
    label: 'starting or debugging the daemon itself',
    test: /\b(daemon|supervisor|smoke|pg-sandbox)\b|демон/i,
  },
])

/** What a line is called when it matches none of the four. */
export const OUTSIDE = 'outside'

/** The journal file: the override first, the daemon's own directory otherwise. */
export function journalPath(env = process.env) {
  const override = env && typeof env[JOURNAL_ENV] === 'string' ? env[JOURNAL_ENV].trim() : ''
  return override || join(homedir(), '.sma-daemon', 'terminal-sessions.ndjson')
}

/**
 * classify(text) → the id of the kind this run belongs to, or 'outside'.
 * Empty text is outside — see the header: an unlabelled run is not excused by default.
 */
export function classify(text) {
  const subject = typeof text === 'string' ? text : ''
  if (!subject.trim()) return OUTSIDE
  for (const kind of WHITELIST) {
    if (kind.test.test(subject)) return kind.id
  }
  return OUTSIDE
}

/** The human phrase a line is judged by: the stated reason first, the command after it. */
export function subjectOf(entry) {
  const why = entry && typeof entry.why === 'string' ? entry.why : ''
  const cmd = entry && typeof entry.cmd === 'string' ? entry.cmd : ''
  return [why, cmd].filter((s) => s.trim()).join(' ')
}

/**
 * buildEntry() — the line about to be written. `event` is the hook's stdin JSON when there
 * was one: its `cwd` is the directory the session was opened in (more truthful than this
 * process's own) and its `source` separates a fresh start from a resume.
 */
export function buildEntry({ argv = [], env = process.env, cwd = process.cwd(), now = new Date(), event = null } = {}) {
  const tail = argv.join(' ').trim()
  const reason = env && typeof env[REASON_ENV] === 'string' ? env[REASON_ENV].trim() : ''
  const eventCwd = event && typeof event.cwd === 'string' && event.cwd.trim() ? event.cwd.trim() : ''
  const source = event && typeof event.source === 'string' && event.source.trim() ? event.source.trim() : ''
  const entry = { ts: new Date(now).toISOString(), cwd: eventCwd || cwd, cmd: tail }
  if (reason) entry.why = reason
  if (source) entry.source = source
  return entry
}

/**
 * appendEntry(file, entry) → true when the line is on disk. Never throws: this is the
 * function a terminal start waits for, and it is allowed to fail silently and to fail alone.
 */
export function appendEntry(file, entry) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** Read the hook's stdin JSON if there is one. A terminal (a TTY) is never read from. */
function readEventJson() {
  try {
    if (process.stdin && process.stdin.isTTY) return null
    const raw = readFileSync(0, 'utf8')
    if (!raw || !raw.trim()) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * runLog(argv, deps) → 0, always. Two ways it writes nothing and still says 0: a session
 * the daemon spawned (that is the app working, not a terminal), and any failure at all.
 */
export function runLog(argv = [], { env = process.env, cwd = process.cwd(), now = new Date(), event = undefined, file = null } = {}) {
  try {
    if (env && typeof env[HEADLESS_ENV] === 'string' && env[HEADLESS_ENV].trim()) return 0
    const evt = event === undefined ? readEventJson() : event
    appendEntry(file || journalPath(env), buildEntry({ argv, env, cwd, now, event: evt }))
  } catch {
    /* a journal never breaks a terminal */
  }
  return 0
}

/**
 * readLines(text) → one record per non-empty line, in file order. A line that is not JSON
 * is KEPT with `entry: null`: a journal nobody can parse is a finding, and dropping it
 * would quietly improve the number this command exists to report.
 */
export function readLines(text) {
  const out = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.trim()) continue
    try {
      const entry = JSON.parse(raw)
      out.push({ raw, entry: entry && typeof entry === 'object' ? entry : null })
    } catch {
      out.push({ raw, entry: null })
    }
  }
  return out
}

/**
 * buildReport(lines, {since}) → the rows and the three counts.
 *
 * `since` compares the DATE of the ISO timestamp as text — same shape, same order, no
 * timezone invented on the way. A malformed line has no timestamp to compare and is kept
 * whatever the window is: it cannot prove it belongs to another week.
 */
export function buildReport(lines, { since = null } = {}) {
  const rows = []
  for (const { raw, entry } of lines) {
    if (!entry) {
      rows.push({ ts: '', cwd: '', text: raw.slice(0, 60), category: OUTSIDE, malformed: true })
      continue
    }
    const ts = typeof entry.ts === 'string' ? entry.ts : ''
    if (since && ts.slice(0, 10) < since) continue
    const text = subjectOf(entry)
    rows.push({ ts, cwd: typeof entry.cwd === 'string' ? entry.cwd : '', text, category: classify(text), malformed: false })
  }
  const outside = rows.filter((r) => r.category === OUTSIDE).length
  return { rows, total: rows.length, whitelisted: rows.length - outside, outside }
}

/** The label a category is printed under. */
function labelOf(id) {
  const kind = WHITELIST.find((k) => k.id === id)
  return kind ? kind.label : 'OUTSIDE THE LIST'
}

/**
 * formatReport(report) → the printed text. Its LAST line is the count of runs outside the
 * list and nothing else, so the claim can be read by a command as well as by a person.
 */
export function formatReport(report, { since = null } = {}) {
  const out = []
  out.push(since ? `terminal runs since ${since}` : 'terminal runs (whole journal)')
  out.push('')
  for (const row of report.rows) {
    const when = row.ts ? row.ts.replace('T', ' ').slice(0, 16) : '(no timestamp)'
    const mark = row.category === OUTSIDE ? '  !' : '   '
    const what = row.malformed ? `unreadable line: ${row.text}` : row.text || '(no label)'
    out.push(`${mark} ${when}  ${labelOf(row.category)}`)
    out.push(`      ${what}`)
    if (row.cwd) out.push(`      in ${row.cwd}`)
  }
  if (!report.rows.length) out.push('   (no runs in this window)')
  out.push('')
  for (const kind of WHITELIST) {
    out.push(`  ${String(report.rows.filter((r) => r.category === kind.id).length).padStart(4)}  ${kind.label}`)
  }
  out.push(`  ${String(report.outside).padStart(4)}  OUTSIDE THE LIST`)
  out.push('')
  out.push(`total ${report.total}    within the list ${report.whitelisted}    outside ${report.outside}`)
  out.push(String(report.outside))
  return out.join('\n')
}

/**
 * runReport(opts, print) → the exit code. 3 when there is no journal: absence of a record
 * is not a record of absence, and this command will not print a number it did not read.
 */
export function runReport({ since = null, env = process.env, file = null } = {}, print = console.log, printErr = console.error) {
  const path = file || journalPath(env)
  if (!existsSync(path)) {
    printErr(`ERROR no journal at ${path} — nothing is proved by its absence.`)
    printErr('      Register the SessionStart hook (see supervisor/setup-windows.md) and run this again.')
    return 3
  }
  const text = readFileSync(path, 'utf8')
  const report = buildReport(readLines(text), { since })
  print(formatReport(report, { since }))
  return 0
}

/** parseReportArgs(argv) — explicit-pick: an unknown flag is refused, never ignored. */
export function parseReportArgs(argv) {
  const opts = { since: null, help: false }
  const rest = [...argv]
  while (rest.length) {
    const flag = rest.shift()
    switch (flag) {
      case '--since': {
        const v = rest.shift()
        if (v === undefined) throw new Error('--since needs a value (YYYY-MM-DD)')
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--since wants YYYY-MM-DD, got "${v}"`)
        opts.since = v
        break
      }
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        throw new Error(`unknown option "${flag}" (try --help)`)
    }
  }
  return opts
}

const USAGE = `
node supervisor/terminal-journal.mjs log [what this terminal is for]
node supervisor/terminal-journal.mjs report [--since YYYY-MM-DD]

  log     append one line about this terminal session. Registered as a SessionStart hook it
          costs nobody a thought; called by hand, everything after "log" is the reason this
          terminal was opened. Sessions the daemon spawns are not recorded — they are the
          work being done from the app. Never fails, never delays a session.

  report  put every line in one of the four kinds of work that may stay at a terminal — a
          measuring run, git history surgery, removing the framework, starting or debugging
          the daemon — or outside them, and print the counts. The LAST line printed is the
          number of runs outside the list.

  --since YYYY-MM-DD   only lines from that date onwards
`

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const [, , mode, ...rest] = process.argv
  if (mode === 'log') {
    process.exit(runLog(rest))
  } else if (mode === 'report') {
    let opts
    try {
      opts = parseReportArgs(rest)
    } catch (err) {
      console.error(`ERROR ${String((err && err.message) || err)}`)
      process.exit(1)
    }
    if (opts.help) {
      console.log(USAGE.trim())
      process.exit(0)
    }
    try {
      process.exit(runReport({ since: opts.since }))
    } catch (err) {
      console.error(`ERROR ${String((err && err.message) || err)}`)
      process.exit(1)
    }
  } else {
    console.log(USAGE.trim())
    process.exit(mode === '--help' || mode === '-h' || mode === undefined ? 0 : 1)
  }
}
