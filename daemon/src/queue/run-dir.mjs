/**
 * daemon/src/queue/run-dir.mjs — THE RUN DIRECTORY OF ONE ATTEMPT.
 *
 * WHAT IT IS. Every attempt leaves a small directory in the connected project —
 * `<projectDir>/.sma/runs/<attemptId>/` — holding four files:
 *
 *   run.json        what the attempt was GIVEN: the command line, the names of the
 *                   environment variables, the envelope, the copy it ran in, the personal
 *                   layer, the servers, and what the session's own opening frame said back;
 *   guards.jsonl    one line per hook the CLI started and answered, and one per tool the
 *                   guards refused — the evidence that something was actually watching;
 *   transcript.jsonl a REFERENCE to the attempt's transcript in the ledger, with its digest,
 *                   its line count and its size — never a second copy of it;
 *   receipt.json    how the try ENDED: the outcome, the gate that decided it, the verdict,
 *                   the lesson, and the memory layer as the stream observed it.
 *
 * WHY A DIRECTORY AND NOT A LOG LINE. The claim a person actually wants checked is «the
 * worker really ran under my rules, with my memory, behind my guards». That claim is made of
 * facts that are scattered across a stream, an operator log and a ledger row, each of which
 * is overwritten, rotated or capped on its own schedule. Gathered into one directory named by
 * the attempt, they become a thing a checking tool can READ — and a thing a person can look
 * at a month later without asking anybody to remember anything.
 *
 * WHY THE TRANSCRIPT IS A REFERENCE. The ledger already holds megabytes of stream per day.
 * A copy beside it would double the disk for nothing and would drift the moment either half
 * were touched. The reference carries the digest of the file at the moment of writing, so a
 * transcript that was replaced afterwards can be told apart from one that was not.
 *
 * SECRETS ARE ABSENT BY CONSTRUCTION, NOT BY FILTERING. `run.json` carries the NAMES of the
 * environment variables the spawn was handed and never their values; the prompt is reduced to
 * a digest and a size. `sanitizeRun` is the second belt, not the first: it is handed the
 * values the caller knows to be secret and redacts any string that still contains one.
 *
 * ROTATION LEAVES A TRACE. The directory is bounded (200 by default) because an unbounded one
 * is a disk failure waiting for a busy week. Every removal writes one line to the operator's
 * log naming what was removed — «it can be rolled back» and «it is visible what was removed»
 * are two different guarantees, and a silent sweep only ever provides the first.
 *
 * EVERYTHING HERE IS FAIL-OPEN. A run directory that cannot be written is a lost record, not
 * a lost attempt: every entry point reports through the injected `log` and returns an honest
 * absence rather than throwing into the tick.
 */

import { createHash } from 'node:crypto'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'

import { safeName } from './attempt-ledger.mjs'
import { ATTEMPT_LOG_LINE_CAP } from '../front/journal.mjs'

/** The schema tag on `run.json` — a reader must never have to guess which shape it holds. */
export const RUN_SCHEMA = 'sma-run/1'
/** The schema tag on `receipt.json`. */
export const RECEIPT_SCHEMA = 'sma-receipt/1'
/** How many attempt directories the project keeps before the oldest are swept. */
export const RUN_DIRS_KEEP = 200
/** The four names, in one place: the writer and any reader agree by construction. */
export const RUN_FILES = Object.freeze(['run.json', 'guards.jsonl', 'transcript.jsonl', 'receipt.json'])

/**
 * The shape of an environment variable name whose VALUE must never be written anywhere.
 * Deliberately broad: a name nobody thought of is a leak, and a name matched by mistake costs
 * only that one value being treated as a secret.
 */
export const SECRET_ENV_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION_ID)/i

/** The mark a redacted string leaves — visible in a file, useless to anybody who finds it. */
const REDACTED = '[redacted]'

/** A value short enough to appear inside ordinary prose is not treated as a secret needle. */
const MIN_SECRET_LEN = 8

/** The filesystem seam: injected in tests, the real one in a daemon. */
function io(fsImpl) {
  const f = fsImpl && typeof fsImpl === 'object' ? fsImpl : {}
  return {
    mkdirSync: f.mkdirSync || mkdirSync,
    writeFileSync: f.writeFileSync || writeFileSync,
    readFileSync: f.readFileSync || readFileSync,
    readdirSync: f.readdirSync || readdirSync,
    renameSync: f.renameSync || renameSync,
    rmSync: f.rmSync || rmSync,
    statSync: f.statSync || statSync,
  }
}

/** Report through the injected log; a log that throws is still not allowed to cost a run. */
function say(log, entry) {
  if (typeof log !== 'function') return
  try {
    log(entry)
  } catch {
    /* even the complaint is fail-open */
  }
}

/** How many outstanding tool calls one stream remembers before it forgets the oldest. */
export const PENDING_TOOLS_CAP = 2000

/**
 * createToolPairing({cap}) — the little bookkeeping that turns «работник попросил файл» into
 * «файл вернулся»: a bounded map of tool calls waiting for their result, plus the set of calls
 * a guard already refused so a frame and its failed result never become two records.
 *
 * WHY IT LIVES HERE AND NOT IN THE TICK. `loop.mjs` holds no keyed collection by law — the
 * daemon is a poll over durable state and every in-process registry it ever grew became a
 * thing that disagreed with the database after a restart. The law names its own way out: a
 * keyed lookup belongs in a helper module. This is that module — the pairing exists only to
 * fill the attempt's own record, and it dies with the stream that made it.
 *
 * BOUNDED ON PURPOSE. A session that asks for thousands of tools and is cut off before their
 * results arrive must not grow this forever; the oldest entry is dropped, which costs one
 * unpaired observation and never a night of memory.
 *
 * @param {{cap?:number}} [opts]
 */
export function createToolPairing({ cap = PENDING_TOOLS_CAP } = {}) {
  const asked = new Map()
  const refused = new Set()
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : PENDING_TOOLS_CAP
  return {
    /** Remember one asked-for call. An id-less block is simply not remembered. */
    remember(id, entry) {
      if (typeof id !== 'string' || id === '') return
      if (asked.size >= limit) {
        const oldest = asked.keys().next()
        if (!oldest.done) asked.delete(oldest.value)
      }
      asked.set(id, entry)
    },
    /** The call this result answers, removed as it is handed over — a result arrives once. */
    take(id) {
      if (typeof id !== 'string' || id === '') return null
      const entry = asked.get(id) ?? null
      asked.delete(id)
      return entry
    },
    /** Was this call already recorded as refused by a guard? */
    refused(id) {
      return typeof id === 'string' && refused.has(id)
    },
    /** Record it as refused, so the failed result that follows adds no second line. */
    markRefused(id) {
      if (typeof id === 'string' && id !== '') refused.add(id)
    },
  }
}

/** `<projectDir>/.sma/runs` — the ONE place this product keeps the runs of a project. */
export function runsDirOf(projectDir) {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') return null
  return join(projectDir, '.sma', 'runs')
}

/**
 * The values of `env` whose NAMES say they are secret — the needles `sanitizeRun` looks for.
 * The caller passes the spawn's own environment: nothing else knows which of its names the
 * account happens to use for a token on this host.
 *
 * @param {Record<string,string>} [env]
 * @returns {string[]}
 */
export function secretValuesOf(env) {
  if (!env || typeof env !== 'object') return []
  const out = []
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LEN) continue
    if (SECRET_ENV_RE.test(name)) out.push(value)
  }
  return out
}

/**
 * sanitizeRun(run, {secretValues}) — the SECOND belt over a record that already carries no
 * secret by construction. Any string anywhere in the object that contains one of the given
 * values is replaced whole: a partially masked token is still a token in two pieces.
 *
 * @param {object} run
 * @param {{secretValues?:string[]}} [opts]
 * @returns {object} a copy, never the argument
 */
export function sanitizeRun(run, { secretValues } = {}) {
  const needles = (Array.isArray(secretValues) ? secretValues : []).filter(
    (v) => typeof v === 'string' && v.length >= MIN_SECRET_LEN,
  )
  const walk = (value) => {
    if (typeof value === 'string') return needles.some((n) => value.includes(n)) ? REDACTED : value
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(value)) out[k] = walk(v)
      return out
    }
    return value
  }
  return walk(run && typeof run === 'object' ? run : {})
}

/** Write one file so a reader never sees half of it; a seam without rename writes directly. */
function writeAtomic(fs, path, text) {
  const tmp = `${path}.tmp`
  try {
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, path)
    return
  } catch {
    /* an in-memory seam may know no rename — the direct write below is the honest fallback */
  }
  fs.writeFileSync(path, text, 'utf8')
}

/**
 * ledgerRef({ledgerPath, fsImpl}) → the ONE line `transcript.jsonl` holds.
 *
 * `truncatedLines` is the count of transcript rows the ledger's line cap cut short. It is
 * written down because it is the difference between «the stream said nothing about this» and
 * «the stream said it and the record could not hold it» — the second is a fact about the
 * STORE, and a checking tool that cannot tell the two apart reports a false absence.
 *
 * A ledger that cannot be read yields a reference that says so, never a throw: the attempt's
 * transcript may have been rotated away, and that is a state of the world, not an error.
 *
 * @param {{ledgerPath?:string, fsImpl?:object}} [args]
 * @returns {{kind:string, ledgerPath:(string|null), sha256:(string|null), lines:number,
 *           bytes:number, truncatedLines:number, unreadable?:boolean}}
 */
export function ledgerRef({ ledgerPath, fsImpl } = {}) {
  const path = typeof ledgerPath === 'string' && ledgerPath.trim() !== '' ? ledgerPath : null
  const base = { kind: 'ledger-ref', ledgerPath: path, sha256: null, lines: 0, bytes: 0, truncatedLines: 0 }
  if (!path) return { ...base, unreadable: true }
  const fs = io(fsImpl)
  let raw
  try {
    raw = String(fs.readFileSync(path, 'utf8'))
  } catch {
    return { ...base, unreadable: true }
  }
  const rows = raw.split('\n').filter((l) => l.trim() !== '')
  let truncated = 0
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row)
      if (typeof parsed.line === 'string' && parsed.line.length >= ATTEMPT_LOG_LINE_CAP) truncated += 1
    } catch {
      /* a row this reader cannot parse is still a row — it is counted and not judged */
    }
  }
  return {
    ...base,
    sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    lines: rows.length,
    bytes: Buffer.byteLength(raw, 'utf8'),
    truncatedLines: truncated,
  }
}

/**
 * writeRunStart({runsDir, attemptId, run, guards, ledgerPath, secretValues, fsImpl, log})
 * → `{dir}` — the three files that are known BEFORE any gate has decided anything.
 *
 * `receipt.json` is deliberately NOT written here. An empty receipt would be indistinguishable
 * from an attempt still running, and the difference between «it has not ended yet» and «it
 * ended and nobody wrote down how» is the whole reason this directory exists.
 *
 * @returns {{dir:(string|null)}}
 */
export function writeRunStart({ runsDir, attemptId, run, guards, ledgerPath, secretValues, fsImpl, log } = {}) {
  if (typeof runsDir !== 'string' || runsDir.trim() === '' || !attemptId) {
    say(log, { type: 'run_dir.error', reason: 'no_runs_dir', attemptId: attemptId ?? null })
    return { dir: null }
  }
  const fs = io(fsImpl)
  const dir = join(runsDir, safeName(attemptId))
  try {
    fs.mkdirSync(dir, { recursive: true })
    const record = sanitizeRun({ schema: RUN_SCHEMA, attemptId: String(attemptId), ...(run || {}) }, { secretValues })
    writeAtomic(fs, join(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`)
    // ALWAYS WRITTEN, EVEN EMPTY: zero lines is the statement «no hook spoke and no tool was
    // refused», which is a finding. A missing file would only say «nobody wrote one».
    const lines = (Array.isArray(guards) ? guards : []).map((g) => JSON.stringify(sanitizeRun(g, { secretValues })))
    writeAtomic(fs, join(dir, 'guards.jsonl'), lines.length ? `${lines.join('\n')}\n` : '')
    writeAtomic(fs, join(dir, 'transcript.jsonl'), `${JSON.stringify({ ...ledgerRef({ ledgerPath, fsImpl }), writtenAt: new Date().toISOString() })}\n`)
    return { dir }
  } catch (err) {
    say(log, { type: 'run_dir.error', attemptId: String(attemptId), error: String((err && err.message) || err) })
    return { dir: null }
  }
}

/**
 * writeRunReceipt({dir, receipt, fsImpl, log}) → did the outcome reach the directory?
 * Called by whoever KNOWS the outcome — the door that completes or refuses the attempt.
 *
 * @returns {boolean}
 */
export function writeRunReceipt({ dir, receipt, fsImpl, log } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return false
  const fs = io(fsImpl)
  try {
    const record = { schema: RECEIPT_SCHEMA, ...(receipt || {}), writtenAt: new Date().toISOString() }
    writeAtomic(fs, join(dir, 'receipt.json'), `${JSON.stringify(record, null, 2)}\n`)
    return true
  } catch (err) {
    say(log, { type: 'run_dir.error', dir, error: String((err && err.message) || err) })
    return false
  }
}

/**
 * pruneRunDirs({runsDir, keep, fsImpl, log}) → `{removed, kept}`.
 *
 * The newest `keep` directories stay; the rest are removed, each one named in the operator's
 * log as it goes. Age is read from `run.json.startedAt` and falls back to the directory's own
 * mtime — a directory whose run.json never landed is exactly the kind of leftover a sweep is
 * for, and it must not be immortal for being unreadable.
 *
 * @param {{runsDir?:string, keep?:number, fsImpl?:object, log?:Function}} [args]
 * @returns {{removed:string[], kept:number}}
 */
export function pruneRunDirs({ runsDir, keep = RUN_DIRS_KEEP, fsImpl, log } = {}) {
  const out = { removed: [], kept: 0 }
  if (typeof runsDir !== 'string' || runsDir.trim() === '') return out
  const limit = Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : RUN_DIRS_KEEP
  const fs = io(fsImpl)

  let names = []
  try {
    names = (fs.readdirSync(runsDir) || []).map((n) => (typeof n === 'string' ? n : n && n.name)).filter(Boolean)
  } catch {
    return out // no runs directory yet is the state we wanted
  }

  const dated = []
  for (const name of names) {
    const path = join(runsDir, name)
    let at = NaN
    try {
      at = Date.parse(String(JSON.parse(String(fs.readFileSync(join(path, 'run.json'), 'utf8'))).startedAt))
    } catch {
      /* an unreadable run.json falls through to the directory's own mtime below */
    }
    if (!Number.isFinite(at)) {
      try {
        at = Number(fs.statSync(path).mtimeMs)
      } catch {
        continue // an entry that vanished under us needs no deleting
      }
    }
    dated.push({ name, path, at: Number.isFinite(at) ? at : 0 })
  }

  dated.sort((a, b) => b.at - a.at) // newest first — the survivors are the head of the list
  out.kept = Math.min(dated.length, limit)
  for (const entry of dated.slice(limit)) {
    try {
      fs.rmSync(entry.path, { recursive: true, force: true })
      out.removed.push(entry.name)
      // THE TRACE THE LAW ASKS FOR: what was removed, by what, and when it had started. A
      // sweep nobody can name afterwards is indistinguishable from a directory that was
      // never written at all.
      say(log, { type: 'run-dir-pruned', dir: entry.path, attemptId: entry.name, startedAt: new Date(entry.at).toISOString() })
    } catch {
      out.kept += 1 // a directory we may not delete is one we keep, never a thrown tick
    }
  }
  return out
}
