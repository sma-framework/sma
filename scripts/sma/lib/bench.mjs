/**
 * bench.mjs — the W0 measurement harness (9.2-01, D-9.2-02).
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
 *     canary-catch. Renaming one breaks P9.2-S1..S8 and plans 02-10.
 *   - Every measure returns {metric, value:number, unit, n, method, status} with
 *     status in {measured, registered, insufficient-data, pending-instrument} —
 *     never undefined/null value, never a throw (tolerant posture, journal.mjs).
 *   - Every command a metric executes (retro verify + scorecard check_command)
 *     passes predict.mjs isSafeCommand BEFORE any spawn; a non-matching command
 *     scores skipped-unsafe and the runner is NEVER invoked (extends T-9.1-14).
 *
 * SECURITY (T-9.2-01/02, mitigate): plan claims/verify strings can arrive from
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
import { benchProviders as airbagBench } from './airbag.mjs'

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

/**
 * AUX_METRICS — non-scorecard metrics that resolve through `bench --metric` but are
 * NOT part of the immutable 8-entry scorecard. `airbag-latency` (9.2-05, P9.2-05-B)
 * is the ms-level airbag SLO instrument; the 8-entry contract stays exactly 8.
 */
export const AUX_METRICS = [
  { id: 'airbag-latency', scorecard: 'P05-B', unit: 'ms', measure: (ctx = {}) => measureAirbagLatency(ctx) },
]

/** Look up a registry entry by its contract id (scorecard first, then aux). */
export function metricById(id) {
  return SCORECARD_METRICS.find((m) => m.id === id) ?? AUX_METRICS.find((m) => m.id === id) ?? null
}

/**
 * measureAirbagLatency(opts) -> P9.2-05-B base. p95 of airbag snapshot elapsedMs
 * over ok receipts (9.2-05), computed by the ONE airbag.benchProviders path so it
 * never drifts from `sma airbag stats`. Empty → 0.
 */
export function measureAirbagLatency(opts = {}) {
  const lat = airbagBench({
    journalDir: opts.dirs && opts.dirs.journalDir,
    readJournalFn: opts.journalReader,
    now: opts.now,
    windowDays: opts.windowDays,
  }).latency
  return result('airbag-latency', { value: lat.value, unit: 'ms', n: lat.n, method: lat.method, status: lat.status })
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
 * standing `bash -c "cd <path> && <inner>"` idiom (the 9.1 plan convention) into
 * its cwd + inner command; a plain command passes through with cwd=null. `safe` is
 * the predict.mjs isSafeCommand verdict on the INNER command — the boundary every
 * caller must honor BEFORE any spawn (T-9.2-01).
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
 * measureFalseDoneRate(opts) -> S1 base. Blind by construction (D-9.2-11): a
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
        planUnverifiable += 1 // skipped-unsafe: runner NEVER invoked (T-9.2-01)
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
        'blind retro re-verify of completed plans: contains-grep each must_haves artifact + run each allowlisted <verify> command on the tree; SUMMARY body never read (D-9.2-11)',
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

  // Airbag-RECEIPT primary (9.2-05, D-9.2-08): once airbag receipts exist they are
  // the canonical per-firing log — coverage = ok receipts / all airbag firings, and a
  // firing with ok:false counts AGAINST coverage (honest denominator). Only when NO
  // airbag receipts exist yet (the whole pre-airbag window) do we fall through to the
  // gate-firing proxy below — which is why the plan-01 base tests (which inject gate
  // events with no airbag receipts) are unaffected.
  try {
    const cov = airbagBench({
      journalDir: opts.dirs && opts.dirs.journalDir,
      readJournalFn: opts.journalReader,
      now: opts.now,
      windowDays,
    }).coverage
    if (cov.n > 0) {
      return result('airbag-coverage', {
        value: cov.value,
        unit: 'percent',
        n: cov.n,
        method: `ok airbag receipts / all airbag firings in the last ${windowDays}d (9.2-05 receipt-primary)`,
        status: 'measured',
      })
    }
  } catch {
    /* fall through to the pre-airbag gate-firing proxy */
  }

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
 * the absolute phantom count (the scoring shape for P9.2-S4's `== 0`).
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
      if (fileM) {
        // dogfood SUMMARYs annotate each file with a trailing ` (description)`; take
        // the leading path TOKEN before any whitespace and strip trailing punctuation.
        const token = unquoteScalar(fileM[1]).split(/\s+/)[0].replace(/[),.;]+$/, '')
        // keep only CONCRETE file paths — reject globs / prose / labels so the S4
        // denominator is honest (a `scripts/sma/**` glob or a "PRODUCT repo: ..."
        // prose note is not a single verifiable committed file).
        if (isConcretePath(token)) files.push(token)
      }
    }
  }
  // The commit convention tags the NUMERIC plan id (`feat(9.1-26): ...`), not the
  // full phase dir name — derive `9.1` from `9.1-sma-v2-...` so the git grep hits.
  const phaseNum = phase != null ? (/^(\d+(?:\.\d+)?)/.exec(String(phase)) || [])[1] ?? String(phase) : null
  const planId = phaseNum != null && plan != null ? `${phaseNum}-${plan}` : phaseNum != null ? String(phaseNum) : ''
  return { planId, files }
}

/**
 * True for a concrete committed-file path verifiable against THIS repo's git: has a
 * slash; no space/glob/paren; and NOT a `../` cross-repo escape (a sibling-repo path
 * cannot be graded against local git — excluding it keeps the S4 denominator honest
 * rather than inflating phantoms with dual-repo-split artifacts).
 */
function isConcretePath(s) {
  return typeof s === 'string' && /\//.test(s) && !/[\s*()]/.test(s) && !/^\.\.[\\/]/.test(s)
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
  // a real capture has n>0; an empty/zero capture is NOT a measurement (pending).
  if (!obj || !Number.isFinite(obj.msPerToolCall) || !(Number(obj.n) > 0)) {
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

// ════════════════════════════════════════════════════════════════════════════
// Task 2 — the harness: A/B throwaway-clone replay + hook timing (S7), the
// compaction exam (S3), and the ttc first-edit recorder (S5 instrument).
// ════════════════════════════════════════════════════════════════════════════

import { mkdtempSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { atomicWriteJson, atomicWriteRaw } from './fs-atomics.mjs'

/** The wired hook set the A/B replay drives (from .claude/settings.json). */
export const PRE_TOOL_HOOKS = ['collision-check', 'reflex-check', 'gates-check']
export const POST_TOOL_HOOKS = ['stall-check']

/** SLO budget (D-9.2-04): a hook whose p95 exceeds this HURTS. */
export const HOOK_BUDGET_MS = 300

/** A stdout that looks like an advisory WARN on the neutral fixture = a hurt. */
function looksLikeWarn(stdout) {
  const s = String(stdout ?? '')
  return /additionalContext|SMA-гейт|SMA-стоп-сигнал|"warn"/i.test(s)
}

function percentile(samples, p) {
  if (!samples.length) return 0
  const s = [...samples].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]
}

/**
 * abRun(opts) -> the A/B delta report. Creates TWO throwaway clones
 * (`git clone --local <src> <mkdtemp>/with|without`), replays the fixture hook
 * script spawning each hook in the `with` clone and SKIPPING it in `without`
 * (the delta IS the SMA layer), and records wall-ms per event. The report carries
 * per-hook p50/p95, spawns-per-tool-call, total overhead ms, AND a `hurts` array —
 * negative results are FIRST-CLASS output (the honest-bench clause): any hook whose
 * p95 exceeds HOOK_BUDGET_MS, or that emits an unexpected WARN on the neutral
 * fixture, lands in `hurts`.
 *
 * SECURITY (T-9.2-02): the source repo receives ONLY the read-class clone call;
 * every hook spawn runs with cwd under a mkdtemp clone, never the source root. The
 * injected exec records every invocation so tests can assert this.
 *
 * @param {{srcRoot:string, fixturePath?:string, fixture?:object[], exec:Function,
 *          hrtime:Function, mkdtempFn?:Function, cliPath?:string, readFile?:Function}} opts
 */
export function abRun(opts = {}) {
  const exec = opts.exec
  const hrtime = typeof opts.hrtime === 'function' ? opts.hrtime : () => 0
  if (typeof exec !== 'function') throw new Error('abRun requires an injected exec')
  const mk = opts.mkdtempFn ?? (() => mkdtempSync(join(tmpdir(), 'sma-ab-')))
  const cliPath = opts.cliPath ?? 'scripts/sma/cli.mjs'
  const events = loadFixture(opts)

  const withDir = mk('with')
  const withoutDir = mk('without')
  // read-class clone of the source into each throwaway root (never mutate src)
  exec('git', ['clone', '--local', opts.srcRoot, withDir], {})
  exec('git', ['clone', '--local', opts.srcRoot, withoutDir], {})

  const timings = {} // hook -> [ms]
  const warned = new Set()
  const toolHookSet = new Set([...PRE_TOOL_HOOKS, ...POST_TOOL_HOOKS])
  let toolHookSpawns = 0 // per-tool-call hooks only (session-start excluded)
  let toolCalls = 0

  for (const ev of events) {
    const hook = ev && ev.hook
    if (!hook) continue
    if (POST_TOOL_HOOKS.includes(hook)) toolCalls += 1
    // `without` skips the SMA hook entirely — the delta is the SMA layer.
    const before = hrtime()
    const res = exec(process.execPath ?? 'node', [cliPath, hook], {
      cwd: withDir,
      input: JSON.stringify(ev.stdinPayload ?? {}),
    })
    const after = hrtime()
    const elapsed = Math.max(0, after - before)
    ;(timings[hook] ??= []).push(elapsed)
    if (toolHookSet.has(hook)) toolHookSpawns += 1
    if (looksLikeWarn(res && res.stdout)) warned.add(hook)
  }

  const perHook = {}
  const hurts = []
  for (const [hook, samples] of Object.entries(timings)) {
    const p50 = percentile(samples, 50)
    const p95 = percentile(samples, 95)
    perHook[hook] = { p50, p95, count: samples.length }
    if (p95 > HOOK_BUDGET_MS) hurts.push({ hook, reason: 'p95-over-budget', p95 })
    if (warned.has(hook)) hurts.push({ hook, reason: 'unexpected-warn-on-neutral-fixture' })
  }

  const totalOverheadMs = Object.values(timings)
    .flat()
    .reduce((a, b) => a + b, 0)
  return {
    perHook,
    spawnsPerToolCall: toolCalls > 0 ? round2(toolHookSpawns / toolCalls) : toolHookSpawns,
    totalOverheadMs,
    toolCalls,
    clones: { withDir, withoutDir },
    hurts,
  }
}

/** Load the fixture events from an injected array or a JSONL fixture path. */
function loadFixture(opts) {
  if (Array.isArray(opts.fixture)) return opts.fixture
  const raw = opts.fixturePath ? readText(opts.fixturePath, opts.readFile) : null
  if (!raw) return []
  const out = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* fail-open — skip corrupt fixture line */
    }
  }
  return out
}

/**
 * measureSelfCost(opts) -> S7 base. Replays the wired hook set over the fixture
 * (injected exec + hrtime) and aggregates the per-tool-call combined node cost:
 * the 3 PreToolUse + 1 PostToolUse spawns. Deterministic, zero-LLM. Persists
 * `.sma/bench/selfcost.json` so readSelfCostBase can surface it in `bench --json`.
 *
 * @param {{exec:Function, hrtime:Function, fixturePath?:string, fixture?:object[],
 *          dirs?:object, cliPath?:string, readFile?:Function, persist?:boolean, writeFn?:Function}} opts
 */
export function measureSelfCost(opts = {}) {
  const exec = opts.exec
  const hrtime = typeof opts.hrtime === 'function' ? opts.hrtime : () => 0
  const cliPath = opts.cliPath ?? 'scripts/sma/cli.mjs'
  const events = loadFixture(opts)
  const hookSet = new Set([...PRE_TOOL_HOOKS, ...POST_TOOL_HOOKS])

  let totalMs = 0
  let toolCalls = 0
  let spawns = 0
  for (const ev of events) {
    const hook = ev && ev.hook
    if (!hookSet.has(hook)) continue
    if (POST_TOOL_HOOKS.includes(hook)) toolCalls += 1
    const before = hrtime()
    if (typeof exec === 'function') exec(process.execPath ?? 'node', [cliPath, hook], { input: JSON.stringify(ev.stdinPayload ?? {}) })
    const after = hrtime()
    totalMs += Math.max(0, after - before)
    spawns += 1
  }

  const msPerToolCall = toolCalls > 0 ? round2(totalMs / toolCalls) : 0
  const n = toolCalls
  if (opts.persist !== false && opts.dirs && opts.dirs.benchDir) {
    try {
      const write = opts.writeFn ?? atomicWriteJson
      write(join(opts.dirs.benchDir, 'selfcost.json'), { msPerToolCall, n, spawnsPerToolCall: toolCalls > 0 ? round2(spawns / toolCalls) : spawns, capturedAt: new Date(opts.now ?? Date.now()).toISOString() })
    } catch {
      /* persistence is best-effort — the measure still returns */
    }
  }
  return result('self-cost', {
    value: msPerToolCall,
    unit: 'ms-per-tool-call',
    n,
    method: 'hook wall-time proxy; spend-share instrument arrives plan 09',
    status: n > 0 ? 'measured' : 'insufficient-data',
  })
}

// ── S3 compaction exam: deterministic extraction + normalized-keyword grading ─

/** The 10 exam question ids, in order (mirror fixtures/bench/compaction-exam.md). */
export const EXAM_QUESTIONS = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10']

/**
 * buildAnswerKey(state) -> [{ q, prompt, answer, keywords }]. DETERMINISTIC
 * extraction: the SAME state yields the SAME key on every run (no LLM, no clock).
 * Each question's required-keyword list is derived from its extracted answer —
 * grading is normalized keyword matching against these, never judgment.
 *
 * @param {object} state  { activePlan, nextTask, filesModified, claims, journalTail,
 *                          gates, nextMigration, phaseWave, lockedDecisions, predictions }
 */
export function buildAnswerKey(state = {}) {
  const s = state
  const kw = (v) => tokenizeKeywords(v)
  const rows = [
    { q: 'Q1', prompt: 'active plan id', answer: str(s.activePlan) },
    { q: 'Q2', prompt: 'next undone task', answer: str(s.nextTask) },
    { q: 'Q3', prompt: 'current plan files_modified', answer: joinList(s.filesModified) },
    { q: 'Q4', prompt: 'active claims + holders', answer: joinList(s.claims) },
    { q: 'Q5', prompt: 'last 3 journal events', answer: joinList(s.journalTail) },
    { q: 'Q6', prompt: 'open gates / soft-denies', answer: joinList(s.gates) },
    { q: 'Q7', prompt: 'next free migration slot', answer: str(s.nextMigration) },
    { q: 'Q8', prompt: 'current phase + wave', answer: str(s.phaseWave) },
    { q: 'Q9', prompt: 'locked D-XX ids constraining the active task', answer: joinList(s.lockedDecisions) },
    { q: 'Q10', prompt: "active plan's prediction ids + thresholds", answer: joinList(s.predictions) },
  ]
  return rows.map((r) => ({ ...r, keywords: kw(r.answer) }))
}

/**
 * examNew(opts) -> { key, path }. Builds the deterministic answer key from the
 * injected state and writes it to `.sma/bench/exam/<ts>-key.json`. Repeated runs
 * with the same state + ts produce a byte-identical key (test 4 determinism).
 *
 * @param {{dirs?:object, state:object, now?:number|string, writeFn?:Function}} opts
 */
export function examNew(opts = {}) {
  const key = buildAnswerKey(opts.state)
  const ts = typeof opts.now === 'string' ? opts.now : new Date(opts.now ?? Date.now()).toISOString()
  const stamp = ts.replace(/[:.]/g, '-')
  const payload = { ts, questions: key }
  let path = null
  if (opts.dirs && opts.dirs.benchDir) {
    path = join(opts.dirs.benchDir, 'exam', `${stamp}-key.json`)
    const write = opts.writeFn ?? atomicWriteJson
    write(path, payload)
  }
  return { key: payload, path }
}

/**
 * examGrade(opts) -> { score, perQuestion }. Normalized keyword matching (casefold,
 * trim) of the operator's answers against each question's required-keyword list from
 * the key; a question passes when ALL its required keywords appear in the answer.
 * Appends ONE JSONL result line to `.sma/bench/exam/results.jsonl` (fs-atomics), so
 * measureCompactionExam (S3) reads it. Zero LLM.
 *
 * @param {{key:object, answers:object, dirs?:object, now?:number, readFile?:Function, appendFn?:Function}} opts
 */
export function examGrade(opts = {}) {
  const questions = (opts.key && Array.isArray(opts.key.questions) ? opts.key.questions : []).filter(Boolean)
  const answers = opts.answers && typeof opts.answers === 'object' ? opts.answers : {}
  const perQuestion = []
  let passed = 0
  for (const q of questions) {
    const given = normalizeText(answers[q.q])
    const required = Array.isArray(q.keywords) ? q.keywords : []
    const ok = required.length > 0 && required.every((k) => given.includes(k))
    if (ok) passed += 1
    perQuestion.push({ q: q.q, ok, required })
  }
  const score = questions.length ? Math.round((passed / questions.length) * 100) : 0

  // append one JSONL result line (via fs-atomics read-modify-write).
  if (opts.dirs && opts.dirs.benchDir) {
    try {
      const file = join(opts.dirs.benchDir, 'exam', 'results.jsonl')
      const line = JSON.stringify({ ts: new Date(opts.now ?? Date.now()).toISOString(), score, n: questions.length, keyTs: opts.key && opts.key.ts }) + '\n'
      if (typeof opts.appendFn === 'function') {
        opts.appendFn(file, line)
      } else {
        const prior = readText(file, opts.readFile) ?? ''
        atomicWriteRaw(file, prior + line)
      }
    } catch {
      /* best-effort append — grading result still returned */
    }
  }
  return { score, perQuestion }
}

// ── S5 instrument: ttc first-edit recorder (rides the stall-check path) ───────

/**
 * recordFirstEdit(opts) -> { written:boolean, path?:string }. On the FIRST Edit|Write
 * of a session, writes ONE marker { sessionToken, registeredAt, firstEditAt } to
 * `.sma/bench/ttc/<session>.json`; a second Edit is a no-op (marker exists -> early
 * return, no rewrite). Fully tolerant (never throws) — the caller wraps it in a
 * try/catch on the hook path so a bench bug can never break stall-check (T-9.2-03).
 *
 * @param {{toolName:string, sessionToken:string, dirs?:object, now?:number,
 *          registeredAtFor?:Function, existsFn?:Function, writeFn?:Function}} opts
 */
export function recordFirstEdit(opts = {}) {
  try {
    const toolName = opts.toolName
    if (toolName !== 'Edit' && toolName !== 'Write') return { written: false }
    if (!opts.dirs || !opts.dirs.benchDir) return { written: false }
    const stem = String(opts.sessionToken || 'unknown').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || 'unknown'
    const file = join(opts.dirs.benchDir, 'ttc', `${stem}.json`)
    const existsFn = opts.existsFn ?? existsSync
    if (existsFn(file)) return { written: false, path: file } // no-op: first edit already recorded

    const nowIso = new Date(opts.now ?? Date.now()).toISOString()
    let registeredAt = nowIso
    if (typeof opts.registeredAt === 'string' && opts.registeredAt.trim()) {
      registeredAt = opts.registeredAt.trim()
    } else {
      try {
        if (typeof opts.registeredAtFor === 'function') {
          const r = opts.registeredAtFor(opts.sessionToken)
          if (typeof r === 'string' && r.trim()) registeredAt = r.trim()
        }
      } catch {
        /* fail-open — fall back to now */
      }
    }
    const write = opts.writeFn ?? atomicWriteJson
    write(file, { sessionToken: String(opts.sessionToken || 'unknown'), registeredAt, firstEditAt: nowIso })
    return { written: true, path: file }
  } catch {
    return { written: false } // fail-open — a recorder bug NEVER breaks the hook
  }
}

// ── exam text normalization helpers ──────────────────────────────────────────

function str(v) {
  return v == null ? '' : String(v)
}
function joinList(v) {
  if (Array.isArray(v)) return v.map(str).join(' ')
  return str(v)
}
function normalizeText(v) {
  return str(v).toLowerCase().replace(/\s+/g, ' ').trim()
}
function tokenizeKeywords(v) {
  const norm = normalizeText(v)
  if (!norm) return []
  // required keywords = distinct meaningful tokens (>=2 chars), bounded set
  const toks = norm.split(/[^a-z0-9.\-/]+/).filter((t) => t.length >= 2)
  return [...new Set(toks)].slice(0, 8)
}

// ════════════════════════════════════════════════════════════════════════════
// Task 3 — aggregate runner, baseline capture, and freeze verification.
// ════════════════════════════════════════════════════════════════════════════

/** The immutable baseline freeze date (D-9.2-02). W1+ plans gate on this. */
export const FREEZE_DATE = '2026-07-21'

/** The two DETERMINISTIC bases that must reproduce on a fresh clone (P9.2-01-C). */
export const DETERMINISTIC_METRICS = ['false-done-rate', 'phantom-writes']

/**
 * runAllMetrics(ctx) -> [{id, scorecard, ...result}] for all 8 registry metrics.
 * Each measure reads only what it needs from the shared ctx; a missing input
 * yields an honest empty status, never a throw. This is the `bench --json` shape.
 */
export function runAllMetrics(ctx = {}) {
  return SCORECARD_METRICS.map((m) => {
    let r
    try {
      r = m.measure(ctx)
    } catch {
      r = result(m.id, { value: 0, unit: m.unit, n: 0, method: 'measure threw — reported as insufficient-data (fail-open)', status: 'insufficient-data' })
    }
    return { id: m.id, scorecard: m.scorecard, ...r }
  })
}

/** coverageCount(metrics) -> count with a real base (measured OR registered) — P9.2-01-A. */
export function coverageCount(metrics) {
  return (Array.isArray(metrics) ? metrics : []).filter(
    (m) => m.status === 'measured' || m.status === 'registered',
  ).length
}

/**
 * captureBaseline(ctx) -> { capturedAt, metrics }. Runs the full 8-metric suite for
 * the baseline artifact. The CLL renders this into 9.2-BASELINE.md; on/after the
 * freeze date it flips status to frozen with git anchors.
 */
export function captureBaseline(ctx = {}) {
  return { capturedAt: new Date(ctx.now ?? Date.now()).toISOString(), metrics: runAllMetrics(ctx) }
}

/**
 * verifyFreeze({ ctx, frozen }) -> { ok, checked }. Recomputes ONLY the deterministic
 * bases (S1 false-done-rate over the frozen plan set, S4 phantom-writes over the frozen
 * phase window) and compares them to the frozen values (exact equality). Timing metrics
 * are excluded by design (P9.2-01-C). Returns ok=true only when every deterministic
 * base reproduces exactly.
 *
 * @param {{ctx:object, frozen:Record<string,number>}} args
 */
export function verifyFreeze({ ctx = {}, frozen = {} } = {}) {
  const checked = []
  let ok = true
  for (const id of DETERMINISTIC_METRICS) {
    const entry = metricById(id)
    if (!entry) continue
    let value = null
    try {
      value = entry.measure(ctx).value
    } catch {
      value = null
    }
    const expected = frozen[id]
    const match = expected != null && value === expected
    if (!match) ok = false
    checked.push({ id, expected: expected ?? null, actual: value, match })
  }
  return { ok, checked }
}

/**
 * isFreezeAllowed(now) -> boolean. The `bench --freeze` date guard: refuses while
 * now < FREEZE_DATE (the CLI honors SMA_BENCH_FORCE=1 to override for a dry run).
 */
export function isFreezeAllowed(now) {
  const t = typeof now === 'number' ? now : Date.parse(String(now))
  return Number.isFinite(t) && t >= Date.parse(`${FREEZE_DATE}T00:00:00Z`)
}

// helper re-exported so the CLI can resolve the default S1 plan set from disk
export { readText as _readText, existsSync as _existsSync, readdirSync as _readdirSync }
