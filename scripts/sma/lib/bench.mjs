/**
 * bench.mjs — the W0 measurement harness (49.2-01, D-49.2-02).
 *
 * A DETERMINISTIC, ZERO-LLM metric runner over the V2 journals, git history, and
 * throwaway clones. It is the phase's founding instrument: the 8-metric 10x
 * scorecard is measured BEFORE any spine build, and the bases are frozen BEFORE
 * any multiplier target is spoken (the receipts feature must pass its OWN test
 * first — the grill's core finding).
 *
 * THE CONTRACT (key_links, non-negotiable):
 *   - SCORECARD_METRICS exports EXACTLY 8 entries whose ids match the scorecard
 *     check_commands VERBATIM: false-done-rate, airbag-coverage, compaction-exam,
 *     phantom-writes, time-to-context-ratio, cross-machine-drill, self-cost,
 *     canary-catch. Renaming one breaks P49.2-S1..S8 and plans 02-10.
 *   - Every measure returns {metric, value:number, unit, n, method, status} with
 *     status in {measured, registered, insufficient-data, pending-instrument} —
 *     never undefined/null value, never a throw (tolerant posture, journal.mjs).
 *   - Every command a metric executes (retro verify + scorecard check_command)
 *     passes predict.mjs isSafeCommand BEFORE any spawn; a non-matching command
 *     scores skipped-unsafe and the runner is NEVER invoked (extends T-49.1-14).
 *
 * SECURITY (T-49.2-01/02, mitigate): plan claims/verify strings can arrive from
 * untrusted imports; the SAFE_COMMAND allowlist is the boundary. All clone/replay
 * work (tasks 2/3) happens inside mkdtemp throwaway dirs — the source repo is
 * read-only to bench, its git refs never touched.
 *
 * Node built-ins only; everything dependency-injected ({dirs, runCommand, gitLog,
 * now, readFile, ...}) so tests never shell out or touch git. NO LLM, NO network.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { isSafeCommand } from './predict.mjs'

// ── the 8-metric registry contract ───────────────────────────────────────────
//
// Each entry: { id, scorecard: 'S1'..'S8', unit, measure }. `measure(ctx)` is a
// thin adapter that pulls what it needs from a uniform ctx and returns the honest
// {metric, value, unit, n, method, status} shape. Plans 02-10 and phase-close
// scoring consume these by id — the ids are the CONTRACT.

/** The four honest status values a measure may report. */
export const BENCH_STATUS = ['measured', 'registered', 'insufficient-data', 'pending-instrument']

/** Git gates whose firing risks tree loss (S2 airbag-coverage denominator). */
export const DESTRUCTIVE_GATES = ['GATE-CHECKOUT', 'GATE-STASH', 'GATE-ADDALL']

/** Uniform empty-result helper — never returns a null/undefined value. */
function result(metric, { value = 0, unit, n = 0, method, status }) {
  return { metric, value: Number.isFinite(value) ? value : 0, unit, n, method, status }
}

/**
 * SCORECARD_METRICS — the 8-entry contract (CONTEXT §scorecard). Order is S1..S8.
 * Each `measure(ctx)` is tolerant: a missing input yields an honest empty status,
 * never a throw. ctx carries every injectable dep; a measure reads only its own.
 */
export const SCORECARD_METRICS = [
  {
    id: 'false-done-rate',
    scorecard: 'S1',
    unit: 'percent',
    measure: (ctx = {}) => measureFalseDoneRate(ctx),
  },
  {
    id: 'airbag-coverage',
    scorecard: 'S2',
    unit: 'percent',
    measure: (ctx = {}) => measureGitLossRecoverability(ctx),
  },
  {
    id: 'compaction-exam',
    scorecard: 'S3',
    unit: 'percent',
    measure: (ctx = {}) => measureCompactionExam(ctx),
  },
  {
    id: 'phantom-writes',
    scorecard: 'S4',
    unit: 'count',
    measure: (ctx = {}) => measurePhantomWrites({ ...ctx, mode: ctx.mode ?? 'count' }),
  },
  {
    id: 'time-to-context-ratio',
    scorecard: 'S5',
    unit: 'ratio',
    measure: (ctx = {}) => measureTimeToContext(ctx),
  },
  {
    id: 'cross-machine-drill',
    scorecard: 'S6',
    unit: 'percent',
    measure: () => measureCrossMachineDrill(),
  },
  {
    id: 'self-cost',
    scorecard: 'S7',
    unit: 'ms-per-tool-call',
    measure: (ctx = {}) => readSelfCostBase(ctx),
  },
  {
    id: 'canary-catch',
    scorecard: 'S8',
    unit: 'percent',
    measure: () => measureCanaryCatch(),
  },
]

/** Look up a registry entry by its contract id (used by the CLI + plans 02-10). */
export function metricById(id) {
  return SCORECARD_METRICS.find((m) => m.id === id) ?? null
}

// ── shared narrow readers (frontmatter.mjs posture: hand-rolled, no YAML lib) ──

/** Read a file as utf8; any error -> null (fail-open, journal.mjs posture). */
function readText(path, readFile) {
  const fn = readFile ?? ((p) => readFileSync(p, 'utf8'))
  try {
    return fn(path)
  } catch {
    return null
  }
}

/** Slice the leading `---` frontmatter block into lines (CRLF-normalized), or []. */
function frontmatterLines(text) {
  if (typeof text !== 'string') return []
  const t = text.replace(/\r\n/g, '\n')
  if (!t.startsWith('---\n')) return []
  const close = t.indexOf('\n---\n', 3)
  if (close === -1) return []
  return t.slice(4, close + 1).split('\n')
}

/**
 * parseMustHaveArtifacts(planText) -> [{path, contains}]. Narrow line reader for
 * the `must_haves.artifacts` list (predict.mjs's own-extractor posture — NO new
 * YAML lib, frontmatter.mjs cannot parse this nested shape and throws by design).
 */
export function parseMustHaveArtifacts(planText) {
  const lines = frontmatterLines(planText)
  const out = []
  let i = 0
  // find `  artifacts:` under must_haves (2-space indent)
  while (i < lines.length && !/^  artifacts:\s*$/.test(lines[i])) i++
  if (i >= lines.length) return out
  i++
  let current = null
  for (; i < lines.length; i++) {
    const line = lines[i]
    // a dedent to <=2 spaces that is a new key closes the block
    if (/^ {0,2}\S/.test(line) && line.trim() !== '') break
    const pathM = /^\s*- path:\s*(.+?)\s*$/.exec(line)
    const containsM = /^\s*contains:\s*(.+?)\s*$/.exec(line)
    if (pathM) {
      current = { path: unquoteScalar(pathM[1]), contains: null }
      out.push(current)
    } else if (containsM && current) {
      current.contains = unquoteScalar(containsM[1])
    }
  }
  return out
}

/** Strip one layer of surrounding quotes + a trailing comment. */
function unquoteScalar(raw) {
  let t = String(raw).trim()
  if (t.startsWith('"') || t.startsWith("'")) {
    const q = t[0]
    const end = t.indexOf(q, 1)
    if (end > 0) return t.slice(1, end)
  }
  return t.replace(/\s+#.*$/, '')
}

/** Extract every `<verify><automated>CMD</automated>` command string from a plan body. */
export function parseVerifyCommands(planText) {
  if (typeof planText !== 'string') return []
  const out = []
  const re = /<automated>\s*([\s\S]*?)\s*<\/automated>/g
  let m
  while ((m = re.exec(planText)) !== null) {
    const cmd = m[1].trim()
    if (cmd) out.push(cmd)
  }
  return out
}

/**
 * normalizeVerifyCommand(cmd) -> {cwd, inner, safe}. Deterministically unwraps the
 * standing `bash -c "cd <path> && <inner>"` idiom (the 49.1 plan convention) into
 * its cwd + inner command; a plain command passes through with cwd=null. `safe` is
 * the predict.mjs isSafeCommand verdict on the INNER command — the boundary every
 * caller must honor BEFORE any spawn (T-49.2-01).
 */
export function normalizeVerifyCommand(cmd) {
  const raw = String(cmd ?? '').trim()
  let cwd = null
  let inner = raw
  const m = /^bash\s+-c\s+"cd\s+(.+?)\s+&&\s+([\s\S]+?)"\s*$/.exec(raw)
  if (m) {
    cwd = m[1].trim()
    inner = m[2].trim()
  }
  return { cwd, inner, safe: isSafeCommand(inner) }
}

// ── S1: false-done-rate (blind, claims-only) ─────────────────────────────────

/**
 * measureFalseDoneRate(opts) -> S1 base. Blind by construction (D-49.2-11): a
 * verdict derives from PLAN claims only — must_haves artifacts (contains-grep) +
 * normalized `<verify>` commands — and NEVER reads a SUMMARY body. Completion is
 * SUMMARY-file EXISTENCE only, checked through an injected existence probe whose
 * body-read method is never called.
 *
 * false-done = completion-marked AND (an artifact contains-grep fails OR a runnable
 * claim command fails). A claim command that fails isSafeCommand is skipped-unsafe
 * and counted as UNVERIFIABLE (honest denominator — unverifiable is NOT false-done).
 *
 * @param {{planPaths?:string[], cloneRoot?:string, runCommand?:Function,
 *          readFile?:Function, summaryAccess?:{exists:Function}}} opts
 * @returns {{metric,value,unit,n,method,status,detail,unverifiable}}
 */
export function measureFalseDoneRate(opts = {}) {
  const planPaths = Array.isArray(opts.planPaths) ? opts.planPaths : []
  const runCommand = typeof opts.runCommand === 'function' ? opts.runCommand : null
  const summaryAccess = opts.summaryAccess ?? { exists: () => false }
  const remap = makeRemap(opts.cloneRoot)

  const detail = []
  let completedCount = 0
  let falseDone = 0
  let unverifiable = 0

  for (const planPath of planPaths) {
    const text = readText(remap(planPath), opts.readFile) ?? readText(planPath, opts.readFile)
    // completion = SUMMARY EXISTENCE only — blind (never .readBody)
    const completed = summaryAccess.exists(summaryPathFor(planPath)) === true
    const artifacts = parseMustHaveArtifacts(text ?? '')
    let artifactOk = true
    for (const a of artifacts) {
      if (!a.path) continue
      const body = readText(remap(a.path), opts.readFile)
      if (body == null || (a.contains && !body.includes(a.contains))) {
        artifactOk = false
        break
      }
    }

    let claimsOk = true
    let planUnverifiable = 0
    for (const cmd of parseVerifyCommands(text ?? '')) {
      const norm = normalizeVerifyCommand(cmd)
      if (!norm.safe) {
        planUnverifiable += 1 // skipped-unsafe: runner NEVER invoked (T-49.2-01)
        continue
      }
      if (!runCommand) continue
      let ok = false
      try {
        const res = runCommand(norm.inner, { cwd: opts.cloneRoot ?? norm.cwd })
        ok = res === true || res === 0 || (res && res.ok === true)
      } catch {
        ok = false
      }
      if (!ok) claimsOk = false
    }

    if (planUnverifiable > 0) unverifiable += 1
    const isFalseDone = completed && (!artifactOk || !claimsOk)
    if (completed) completedCount += 1
    if (isFalseDone) falseDone += 1
    detail.push({ plan: planPath, completed, artifactOk, claimsOk, unverifiable: planUnverifiable, falseDone: isFalseDone })
  }

  const n = completedCount
  const value = n > 0 ? round2((falseDone / n) * 100) : 0
  const status = n > 0 ? 'measured' : 'insufficient-data'
  return {
    ...result('false-done-rate', {
      value,
      unit: 'percent',
      n,
      method:
        'blind retro re-verify of completed plans: contains-grep each must_haves artifact + run each allowlisted <verify> command on the tree; SUMMARY body never read (D-49.2-11)',
      status,
    }),
    detail,
    unverifiable,
  }
}

/** Map a plan path to its SUMMARY path (…-PLAN.md -> …-SUMMARY.md). */
function summaryPathFor(planPath) {
  return String(planPath).replace(/-PLAN\.md$/i, '-SUMMARY.md')
}

/** Build a path remapper into a clone root; identity when no clone root given. */
function makeRemap(cloneRoot) {
  if (!cloneRoot) return (p) => p
  return (p) => {
    const s = String(p)
    // strip a leading `../` chain and any absolute prefix — join onto the clone
    const rel = s.replace(/^([A-Za-z]:)?[\\/]+/, '').replace(/^(\.\.[\\/])+/, '')
    return join(cloneRoot, rel)
  }
}

// ── S2: git-loss recoverability (airbag arrives plan 05) ─────────────────────

/**
 * measureGitLossRecoverability(opts) -> S2 base. Tolerant-reads the coordination
 * journal for destructive-git GATE firings in the window and computes recoverability
 * = firings-preceded-by-a-snapshot / firings. Today the numerator is STRUCTURALLY 0
 * (no airbag mechanism exists — it arrives plan 05), so the firing COUNT is the log
 * and value is 0. Honest: registered when there is nothing yet to protect.
 *
 * @param {{dirs?:object, windowDays?:number, now?:number, journalReader?:Function}} opts
 */
export function measureGitLossRecoverability(opts = {}) {
  const windowDays = Number.isFinite(opts.windowDays) ? opts.windowDays : 30
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000

  let events = []
  try {
    const reader = opts.journalReader
    if (typeof reader === 'function') {
      const r = reader({ journalDir: opts.dirs && opts.dirs.journalDir })
      events = Array.isArray(r) ? r : Array.isArray(r && r.events) ? r.events : []
    }
  } catch {
    events = []
  }

  let firings = 0
  let snapshotted = 0
  for (const e of events) {
    if (!e || e.type !== 'gate' || !e.detail) continue
    const gateId = e.detail.gateId
    if (!DESTRUCTIVE_GATES.includes(gateId)) continue
    const ts = Date.parse(e.ts)
    if (Number.isFinite(ts) && ts < cutoff) continue
    firings += 1
    // an airbag snapshot preceding the firing would carry detail.snapshot — none exist yet
    if (e.detail.snapshot) snapshotted += 1
  }

  const value = firings > 0 ? round2((snapshotted / firings) * 100) : 0
  const status = firings > 0 ? 'measured' : 'registered'
  return result('airbag-coverage', {
    value,
    unit: 'percent',
    n: firings,
    method: `destructive-gate firings in the last ${windowDays}d = ${firings}; airbag snapshot mechanism arrives plan 05 (numerator structurally 0 until then)`,
    status,
  })
}

// ── S4: phantom subagent writes ──────────────────────────────────────────────

/**
 * measurePhantomWrites(opts) -> S4 base. For each dogfood-phase SUMMARY: parse the
 * claimed created/modified files and cross-check each against the plan-id-grepped
 * commits' --name-only file sets (injected gitLog provider). A claimed file that no
 * plan-id commit touched is a PHANTOM. share = phantoms/claims; mode:'count' returns
 * the absolute phantom count (the scoring shape for P49.2-S4's `== 0`).
 *
 * @param {{summaryPaths?:string[], gitLog?:Function, mode?:string, readFile?:Function}} opts
 */
export function measurePhantomWrites(opts = {}) {
  const summaryPaths = Array.isArray(opts.summaryPaths) ? opts.summaryPaths : []
  const gitLog = typeof opts.gitLog === 'function' ? opts.gitLog : () => []
  const mode = opts.mode === 'share' ? 'share' : 'count'

  let claims = 0
  let phantoms = 0
  const detail = []
  for (const sp of summaryPaths) {
    const text = readText(sp, opts.readFile)
    const parsed = parseSummaryClaims(text ?? '')
    let touched = new Set()
    try {
      const commits = gitLog(parsed.planId) || []
      for (const c of commits) for (const f of (c && c.files) || []) touched.add(normalizeRel(f))
    } catch {
      touched = new Set()
    }
    for (const f of parsed.files) {
      claims += 1
      const isPhantom = !touched.has(normalizeRel(f))
      if (isPhantom) phantoms += 1
      detail.push({ planId: parsed.planId, file: f, phantom: isPhantom })
    }
  }

  const value = mode === 'share' ? (claims > 0 ? round2((phantoms / claims) * 100) : 0) : phantoms
  const status = claims > 0 ? 'measured' : 'insufficient-data'
  return {
    ...result('phantom-writes', {
      value,
      unit: mode === 'share' ? 'percent' : 'count',
      n: claims,
      method: `claimed created/modified files in ${summaryPaths.length} dogfood SUMMARY(ies) cross-checked against plan-id-grepped commit --name-only sets; phantom = claimed but no plan-id commit touched it`,
      status,
    }),
    detail,
  }
}

/** Normalize a repo-relative path for set comparison (slashes + lowercase drive). */
function normalizeRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

/**
 * parseSummaryClaims(text) -> {planId, files[]}. Narrow reader for a SUMMARY's
 * `phase`/`plan` scalars + a `key-files:` block (created:/modified: dash-lists).
 * Hand-rolled (frontmatter.mjs throws on the nested key-files shape by design).
 */
export function parseSummaryClaims(text) {
  const lines = frontmatterLines(text)
  let phase = null
  let plan = null
  const files = []
  let inKeyFiles = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const phaseM = /^phase:\s*(.+?)\s*$/.exec(line)
    const planM = /^plan:\s*(.+?)\s*$/.exec(line)
    if (phaseM) phase = unquoteScalar(phaseM[1])
    if (planM) plan = unquoteScalar(planM[1])
    if (/^key-files:\s*$/.test(line)) {
      inKeyFiles = true
      continue
    }
    if (inKeyFiles) {
      // stop at the next top-level key
      if (/^\S/.test(line) && !/^key-files:/.test(line)) inKeyFiles = false
      const fileM = /^\s*-\s*(.+?)\s*$/.exec(line)
      if (fileM) files.push(unquoteScalar(fileM[1]))
    }
  }
  const planId = phase != null && plan != null ? `${phase}-${plan}` : phase != null ? String(phase) : ''
  return { planId, files }
}

// ── S5: time-to-context ──────────────────────────────────────────────────────

/**
 * measureTimeToContext(opts) -> S5 base. Reads `.sma/bench/ttc/*.json` first-edit
 * markers (written by task 2's recordFirstEdit): each {sessionToken, registeredAt,
 * firstEditAt}. Computes median(firstEditAt - registeredAt) ms. n<5 -> insufficient
 * data (n stated, value = median-so-far). mode:'ratio' needs a frozen base (frozen
 * base / current) and returns pending-instrument until one is supplied.
 *
 * @param {{dirs?:object, mode?:string, frozenBase?:number, readFile?:Function, readdir?:Function}} opts
 */
export function measureTimeToContext(opts = {}) {
  const ttcDir = opts.dirs && opts.dirs.benchDir ? join(opts.dirs.benchDir, 'ttc') : null
  const readdir = opts.readdir ?? ((d) => readdirSync(d))
  const deltas = []
  if (ttcDir) {
    let files = []
    try {
      files = readdir(ttcDir).filter((f) => f.endsWith('.json'))
    } catch {
      files = []
    }
    for (const f of files) {
      const obj = readJson(join(ttcDir, f), opts.readFile)
      if (!obj) continue
      const reg = Date.parse(obj.registeredAt)
      const edit = Date.parse(obj.firstEditAt)
      if (Number.isFinite(reg) && Number.isFinite(edit) && edit >= reg) deltas.push(edit - reg)
    }
  }
  const n = deltas.length
  const med = median(deltas)

  if (opts.mode === 'ratio') {
    if (!Number.isFinite(opts.frozenBase) || opts.frozenBase <= 0 || n === 0) {
      return result('time-to-context-ratio', {
        value: 0,
        unit: 'ratio',
        n,
        method: 'ratio = frozen 2-week base / current median; pending a frozen base (freeze 2026-07-21)',
        status: 'pending-instrument',
      })
    }
    return result('time-to-context-ratio', {
      value: med > 0 ? round2(opts.frozenBase / med) : 0,
      unit: 'ratio',
      n,
      method: 'frozen 2-week median / current median on same-risk-class tasks',
      status: 'measured',
    })
  }

  return result('time-to-context-ratio', {
    value: med,
    unit: 'ms',
    n,
    method: 'median(firstEditAt - registeredAt) over .sma/bench/ttc markers; needs n>=5 to count as measured',
    status: n >= 5 ? 'measured' : 'insufficient-data',
  })
}

// ── S3: compaction exam (reads results task 2 writes) ────────────────────────

/**
 * measureCompactionExam(opts) -> S3 base. Reads `.sma/bench/exam/results.jsonl`
 * (graded exam results task 2's examGrade appends). Zero graded results ->
 * insufficient-data (NEVER 0-as-if-measured). The baseline protocol needs >=3
 * graded exams by the freeze to count as measured.
 *
 * @param {{dirs?:object, readFile?:Function}} opts
 */
export function measureCompactionExam(opts = {}) {
  const file = opts.dirs && opts.dirs.benchDir ? join(opts.dirs.benchDir, 'exam', 'results.jsonl') : null
  const scores = []
  if (file) {
    const raw = readText(file, opts.readFile)
    if (raw) {
      for (const line of raw.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const j = JSON.parse(t)
          if (Number.isFinite(j.score)) scores.push(j.score)
        } catch {
          /* fail-open — skip corrupt line */
        }
      }
    }
  }
  const n = scores.length
  const value = n > 0 ? round2(scores.reduce((a, b) => a + b, 0) / n) : 0
  return result('compaction-exam', {
    value,
    unit: 'percent',
    n,
    method: '10-question post-compact exam graded by normalized keyword match, measured BEFORE the capsule exists; needs >=3 graded by freeze',
    status: n >= 3 ? 'measured' : 'insufficient-data',
  })
}

// ── S7: self-cost (base persisted by task 2's measureSelfCost) ───────────────

/**
 * readSelfCostBase(opts) -> S7 base. Reads a persisted `.sma/bench/selfcost.json`
 * (written by task 2's measureSelfCost timing run). Absent -> pending-instrument
 * (the timing harness has not run yet). NEVER fabricates a cost.
 *
 * @param {{dirs?:object, readFile?:Function}} opts
 */
export function readSelfCostBase(opts = {}) {
  const file = opts.dirs && opts.dirs.benchDir ? join(opts.dirs.benchDir, 'selfcost.json') : null
  const obj = file ? readJson(file, opts.readFile) : null
  if (!obj || !Number.isFinite(obj.msPerToolCall)) {
    return result('self-cost', {
      value: 0,
      unit: 'ms-per-tool-call',
      n: 0,
      method: 'hook wall-time proxy; run `sma bench --metric self-cost` (timing harness) to capture; spend-share instrument arrives plan 09',
      status: 'pending-instrument',
    })
  }
  return result('self-cost', {
    value: round2(obj.msPerToolCall),
    unit: 'ms-per-tool-call',
    n: Number.isFinite(obj.n) ? obj.n : 0,
    method: 'measured hook wall-time per simulated tool call (3 PreToolUse + 1 PostToolUse spawns)',
    status: 'measured',
  })
}

// ── S6 / S8: registered slots (no mechanism exists yet) ──────────────────────

/** S6 cross-machine-drill: mechanism is the V3.1 git bus. Base 0, registered. */
export function measureCrossMachineDrill() {
  return result('cross-machine-drill', {
    value: 0,
    unit: 'percent',
    n: 0,
    method: 'no mechanism exists — cross-machine git bus is V3.1; slot registered now, scored when the bus ships',
    status: 'registered',
  })
}

/** S8 canary-catch: blind verifier + canary audit arrive plan 10. Base 0, registered. */
export function measureCanaryCatch() {
  return result('canary-catch', {
    value: 0,
    unit: 'percent',
    n: 0,
    method: 'no mechanism exists — blind verifier + planted-canary audit arrive plan 10',
    status: 'registered',
  })
}

// ── small deterministic numeric helpers ──────────────────────────────────────

function median(arr) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

function round2(x) {
  return Math.round(Number(x) * 100) / 100
}

function readJson(path, readFile) {
  const raw = readText(path, readFile)
  if (raw == null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// helper re-exported so the CLI can resolve the default S1 plan set from disk
export { readText as _readText, existsSync as _existsSync, readdirSync as _readdirSync }
