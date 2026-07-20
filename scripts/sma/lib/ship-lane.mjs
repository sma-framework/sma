/**
 * ship-lane.mjs — the SMA ship lanes (9.4-08, BL-177). The founder's 2026-07-13 ask
 * («shipment of 90-100 commits takes around 1h — is it normal?» + «can we add
 * /sma-quick-ship … to move it to prod not to wait so long?»). The 1h/90-commit
 * diagnosis (9.4-RESEARCH-ECONOMY §4): the gates cost ~10 minutes; the hour was BATCH
 * SIZE and passive BABYSITTING. So the treatment is cadence + a background watch, NEVER
 * a weaker gate — the quality-ratchet law from 06/07 stays armed over both lanes.
 *
 * This module is a READ-ONLY checker / drafter / recorder. It NEVER pushes, tags, or
 * deploys — pushing stays inside the founder-ordered skill rituals (substrate law + the
 * /sma-ship sole-push-path boundary, D-9.3-24d). Four surfaces:
 *   1. checkQuickPrecondition — the deterministic entry gate: origin-delta <= maxDelta
 *      commits AND no migrations in the delta AND no FOREIGN push-claim. Any failing leg
 *      refuses «this is a full /sma-ship: <legs>» (the batch.mjs {allowed, reason} refusal
 *      shape). Over-refusal is the SAFE direction (a false refuse just routes to the full
 *      lane, exactly the guard's intent).
 *   2. draftChangelog — a PURE function that groups the origin-delta commits by
 *      conventional-commit prefix (feat/fix/docs/refactor/test/chore/other) into a
 *      founder-readable draft; the same input is byte-identical run-to-run. The FULL lane
 *      consumes it too (token savings scale with batch size).
 *   3. appendShipLaneRun / readShipLaneRuns / laneStats / laneReport — the lane outcome
 *      ledger (ship-lanes.jsonl in the EXISTING spendDir; the economy.mjs lanes.jsonl fold
 *      posture, but a SEPARATE file: lane BUDGETS and ship OUTCOMES are different records).
 *      A run is appended {outcome:'pending'} AT PUSH TIME and finalized (last-wins on the
 *      same startedAt) when the background watch returns; an interrupted watch leaves an
 *      ORPHANED pending run visible to the next session (grill CH-9.4-08-2).
 *   4. shipLaneSelftest — canned-git fixtures proving all of the above, returns 1/0.
 *
 * Consume-never-reimplement (D-9.3-02): the CLI injects slots.checkPushClaim (the exact
 * triplet the airbag + merge-gate consume) and a DI execGit (slots.mjs defaultExecGit
 * pattern); this lib spawns nothing and reads no .sma/ directly in tests. The refusal shape
 * mirrors batch.mjs verbatim. Node built-ins only. Zero LLM, zero network, zero
 * child_process, zero push/tag/deploy anywhere in this module.
 */

import { mkdirSync, appendFileSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ═══════════════════════════ the deterministic precondition ══════════════════════

/**
 * The default migration-path globs. Covers any `migrations/` directory at any depth
 * (`**​/migrations/**`) plus the platform's own `src/migrations/` (BL-154 lives there).
 * The platform skill passes nothing — these defaults hold. Over-refusal is safe: any
 * doubt routes the delta to the full lane.
 */
export const DEFAULT_MIGRATIONS_GLOBS = ['**/migrations/**', 'src/migrations/**']

/** Convert a minimal glob (`**​/`, `**`, `*`) to an anchored RegExp. Path-segment aware. */
function globToRegExp(glob) {
  let re = '^'
  let i = 0
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?' // zero-or-more leading dirs
      i += 3
    } else if (glob.startsWith('**', i)) {
      re += '.*'
      i += 2
    } else if (glob[i] === '*') {
      re += '[^/]*'
      i += 1
    } else {
      const c = glob[i]
      re += /[.+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c
      i += 1
    }
  }
  return new RegExp(`${re}$`)
}

/** True when `path` matches any of the migration globs. */
function isMigrationPath(path, globs) {
  const p = String(path || '').replace(/\\/g, '/').trim()
  if (!p) return false
  return (globs || DEFAULT_MIGRATIONS_GLOBS).some((g) => {
    try {
      return globToRegExp(g).test(p)
    } catch {
      return false
    }
  })
}

/** Parse `git log --oneline`-style output into a non-empty-line count. */
function countLogLines(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean).length
}

/** Parse `git diff --name-only` output into a clean path list. */
function parseDiffPaths(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/**
 * checkQuickPrecondition({execGit, checkPushClaim, self, base, maxDelta, migrationsGlobs})
 *   -> {allowed, reasons[], delta, migrations[], pushClaim}
 *
 * Three DETERMINISTIC legs over `git` + one consumed claim check, EVERY failing leg
 * reported (never just the first):
 *   1. delta count  — commits in `origin/<base>..HEAD` must be <= maxDelta.
 *   2. migration    — no delta path may match a migration glob.
 *   3. push-claim   — no LIVE FOREIGN push-claim (own/absent is fine).
 * A refusal's reasons all carry the «this is a full /sma-ship: <leg>» prefix (batch.mjs
 * refusal shape). execGit + checkPushClaim are injected; this function spawns nothing.
 *
 * @param {object} o
 * @param {(args:string[])=>string} o.execGit         DI git runner (slots.defaultExecGit)
 * @param {()=>object} o.checkPushClaim               DI claim inspector (slots.checkPushClaim)
 * @param {string} [o.self]                            this terminal's id (own-claim discriminator)
 * @param {string} [o.base='main']                     the origin base branch
 * @param {number} [o.maxDelta=5]                       the max eligible commit delta
 * @param {string[]} [o.migrationsGlobs]               override migration globs (defaults hold)
 * @returns {{allowed:boolean, reasons:string[], delta:number, migrations:string[], pushClaim:object}}
 */
export function checkQuickPrecondition(o = {}) {
  const {
    execGit,
    checkPushClaim,
    self,
    base = 'main',
    maxDelta = 5,
    migrationsGlobs = DEFAULT_MIGRATIONS_GLOBS,
  } = o
  const range = `origin/${base}..HEAD`
  const REFUSE = 'this is a full /sma-ship'
  const reasons = []

  // leg 1 — delta count.
  let delta = 0
  try {
    delta = countLogLines(execGit(['log', '--oneline', range]))
  } catch {
    delta = 0 // fail-open on the count read; the migration/claim legs still gate
  }
  if (delta > maxDelta) {
    reasons.push(`${REFUSE}: delta ${delta} > ${maxDelta} commits — review + ship the full lane`)
  }

  // leg 2 — migration paths in the delta.
  let migrations = []
  try {
    migrations = parseDiffPaths(execGit(['diff', '--name-only', range])).filter((p) =>
      isMigrationPath(p, migrationsGlobs),
    )
  } catch {
    migrations = []
  }
  if (migrations.length) {
    reasons.push(`${REFUSE}: migration in the delta (${migrations.join(', ')}) — migrations require the full lane`)
  }

  // leg 3 — a live FOREIGN push-claim (own/absent passes).
  let pushClaim = { live: false }
  try {
    pushClaim = (typeof checkPushClaim === 'function' && checkPushClaim()) || { live: false }
  } catch {
    pushClaim = { live: false }
  }
  const foreign = !!pushClaim.live && (!self || pushClaim.who !== self)
  if (foreign) {
    const who = pushClaim.who || 'another terminal'
    reasons.push(`${REFUSE}: a push is already in progress (${who}) — wait for it to finish`)
  }

  return { allowed: reasons.length === 0, reasons, delta, migrations, pushClaim }
}

// ═══════════════════════════ the changelog drafter ══════════════════════════════

/** The conventional-commit groups, in stable render order; everything else -> 'other'. */
const CHANGELOG_GROUPS = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'style', 'chore']
const GROUP_LABELS = {
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Performance',
  refactor: 'Refactors',
  docs: 'Docs',
  test: 'Tests',
  style: 'Style',
  chore: 'Chores',
  other: 'Other',
}

/** Classify a commit subject to its conventional group ('other' when unparseable). */
function classifySubject(subject) {
  const m = /^([a-z]+)(?:\([^)]*\))?!?:/i.exec(String(subject || '').trim())
  const type = m ? m[1].toLowerCase() : null
  return type && CHANGELOG_GROUPS.includes(type) ? type : 'other'
}

/**
 * draftChangelog({commits}) -> a founder-readable grouped markdown draft. PURE: the same
 * {commits} always yields the identical string. Groups by conventional prefix in the fixed
 * CHANGELOG_GROUPS order (then 'other'), preserving first-seen order WITHIN each group; the
 * scope (`feat(economy):`) is kept in the rendered line. The caller supplies parsed
 * `git log --format` output as [{sha, subject}]. The FULL lane consumes this too.
 *
 * @param {{commits:Array<{sha?:string, subject:string}>}} o
 * @returns {string}
 */
export function draftChangelog(o = {}) {
  const commits = Array.isArray(o.commits) ? o.commits : []
  const buckets = new Map()
  for (const g of [...CHANGELOG_GROUPS, 'other']) buckets.set(g, [])
  for (const c of commits) {
    const subject = String((c && c.subject) || '').trim()
    if (!subject) continue
    buckets.get(classifySubject(subject)).push(subject)
  }
  const total = commits.filter((c) => String((c && c.subject) || '').trim()).length
  const lines = ['## Changelog draft', '', `${total} commit(s) grouped by type — edit for wording, never invent content.`, '']
  for (const g of [...CHANGELOG_GROUPS, 'other']) {
    const items = buckets.get(g)
    if (!items.length) continue
    lines.push(`### ${GROUP_LABELS[g]} (${items.length})`)
    for (const s of items) lines.push(`- ${s}`)
    lines.push('')
  }
  return lines.join('\n')
}

// ═══════════════════════════ the lane outcome ledger ════════════════════════════

/** ship-lanes.jsonl lives in the EXISTING spendDir — NO new .sma subdir (D-9.3-02). */
function shipLaneFile(spendDir) {
  return join(spendDir, 'ship-lanes.jsonl')
}

/** Milliseconds in 24h — a pending run older than this is an ORPHANED watch. */
export const ORPHAN_PENDING_MS = 24 * 60 * 60 * 1000

/**
 * appendShipLaneRun({spendDir, run}) — append ONE run record to ship-lanes.jsonl. A run is
 * {lane:'quick'|'full', startedAt, endedAt?, outcome:'green'|'red'|'pending'}. Append-only;
 * a run is written {outcome:'pending'} AT PUSH TIME and finalized by a later record with the
 * SAME startedAt (last-wins fold, see readShipLaneRuns). Returns the written record.
 *
 * @param {{spendDir:string, run:object}} o
 * @returns {object}
 */
export function appendShipLaneRun({ spendDir, run } = {}) {
  mkdirSync(spendDir, { recursive: true })
  const record = { ...run, recordedAt: (run && run.recordedAt) || new Date().toISOString() }
  appendFileSync(shipLaneFile(spendDir), `${JSON.stringify(record)}\n`)
  return record
}

/** Default fs reader (tests inject; the CLI lets it fall through to the real file). */
function defaultReadFile(path) {
  return readFileSync(path, 'utf8')
}

/**
 * readShipLaneRuns({spendDir, readFile}) -> {runs, corrupt}. Tolerant JSONL reader
 * (journal.mjs posture: a corrupt line is skip-and-counted, never a throw). Folds records
 * by `startedAt` — LAST wins, so a {pending} appended at push time is superseded by the
 * finalized {green|red} record with the same startedAt. First-seen order is preserved.
 *
 * @param {{spendDir:string, readFile?:Function}} o
 * @returns {{runs:object[], corrupt:number}}
 */
export function readShipLaneRuns({ spendDir, readFile } = {}) {
  const rf = typeof readFile === 'function' ? readFile : defaultReadFile
  let raw
  try {
    raw = rf(shipLaneFile(spendDir))
  } catch {
    return { runs: [], corrupt: 0 }
  }
  let corrupt = 0
  const order = []
  const byKey = new Map()
  for (const line of String(raw).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec
    try {
      rec = JSON.parse(trimmed)
    } catch {
      corrupt += 1
      continue
    }
    if (!rec || typeof rec !== 'object' || !rec.startedAt) {
      corrupt += 1
      continue
    }
    const key = rec.startedAt
    if (!byKey.has(key)) order.push(key)
    // last-wins fold: merge so a later finalize overrides pending's outcome/endedAt.
    const prev = byKey.get(key) || {}
    byKey.set(key, { ...prev, ...rec })
  }
  return { runs: order.map((k) => byKey.get(k)), corrupt }
}

/** Active minutes of a run (endedAt - startedAt), or null when unmeasurable. */
function activeMinutes(run) {
  const a = run && run.startedAt ? Date.parse(run.startedAt) : NaN
  const b = run && run.endedAt ? Date.parse(run.endedAt) : NaN
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.max(0, Math.round(((b - a) / 60000) * 100) / 100)
}

/** Nearest-rank percentile over a numeric list ([] -> null). Deterministic. */
function percentile(values, pct) {
  const arr = (values || []).filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b)
  if (!arr.length) return null
  const rank = Math.ceil((pct / 100) * arr.length)
  const idx = Math.min(arr.length - 1, Math.max(0, rank - 1))
  return arr[idx]
}

/**
 * laneReport({runs, now}) -> {pending, orphaned, finalized}. Pending runs are listed FIRST
 * (an interrupted background watch is visible to the NEXT session, never silent), and any
 * pending run older than 24h is flagged as an ORPHANED watch (grill CH-9.4-08-2).
 *
 * @param {{runs:object[], now?:number}} o
 * @returns {{pending:object[], orphaned:object[], finalized:object[]}}
 */
export function laneReport({ runs, now } = {}) {
  const clock = Number.isFinite(now) ? now : Date.now()
  const pending = []
  const orphaned = []
  const finalized = []
  for (const r of runs || []) {
    if (r && r.outcome === 'pending') {
      pending.push(r)
      const started = r.startedAt ? Date.parse(r.startedAt) : NaN
      if (Number.isFinite(started) && clock - started > ORPHAN_PENDING_MS) orphaned.push(r)
    } else if (r) {
      finalized.push(r)
    }
  }
  return { pending, orphaned, finalized }
}

/**
 * laneStats({runs, now}) -> the two paired scorer signals with documented sentinels:
 *   - quickActiveP50Min: p50 active minutes of FINALIZED quick runs; the 9999 sentinel when
 *     fewer than 3 quick runs exist (P9.4-08-B honest-miss: a lane nobody used saved
 *     nothing).
 *   - quickRedMinusFullRedPct: (quickRedPct - fullRedPct). 0 when the quick side has NO
 *     finalized runs (no data, guard idle); when quick has runs but full has none it returns
 *     quickRedPct ALONE so the ratchet guard fires on the FIRST quick red with no full
 *     baseline (P9.4-08-C — teeth from day one).
 * Pending runs count toward NEITHER stat. Deterministic.
 *
 * @param {{runs:object[], now?:number}} o
 * @returns {{quickActiveP50Min:number, quickRedMinusFullRedPct:number, quickRuns:number, fullRuns:number}}
 */
export function laneStats({ runs } = {}) {
  const finalized = (runs || []).filter((r) => r && (r.outcome === 'green' || r.outcome === 'red'))
  const quick = finalized.filter((r) => r.lane === 'quick')
  const full = finalized.filter((r) => r.lane === 'full')

  // quick-active-p50-min — 9999 when < 3 quick runs (honest miss).
  let quickActiveP50Min
  if (quick.length < 3) {
    quickActiveP50Min = 9999
  } else {
    const mins = quick.map(activeMinutes).filter((m) => Number.isFinite(m))
    const p = percentile(mins, 50)
    quickActiveP50Min = p == null ? 9999 : p
  }

  // quick-red-minus-full-red-pct — sentinel directions per the behavior contract.
  const redPct = (list) => (list.length ? Math.round((list.filter((r) => r.outcome === 'red').length / list.length) * 10000) / 100 : null)
  const quickRed = redPct(quick)
  const fullRed = redPct(full)
  let quickRedMinusFullRedPct
  if (quickRed == null) {
    quickRedMinusFullRedPct = 0 // no quick data -> guard idle
  } else if (fullRed == null) {
    quickRedMinusFullRedPct = quickRed // no full baseline -> quick red rate alone
  } else {
    quickRedMinusFullRedPct = Math.round((quickRed - fullRed) * 100) / 100
  }

  return { quickActiveP50Min, quickRedMinusFullRedPct, quickRuns: quick.length, fullRuns: full.length }
}

// ═══════════════════════════ the self-proving selftest ══════════════════════════

/** A canned execGit answering `log` + `diff` from fixed strings. */
function cannedGit({ log = '', diff = '' }) {
  return (args) => {
    if (args[0] === 'log') return log
    if (args[0] === 'diff') return diff
    return ''
  }
}

const nLines = (n) => Array.from({ length: n }, (_, i) => `sha${i} subject ${i}`).join('\n') + '\n'

/**
 * shipLaneSelftest() -> 1|0. The canned-git fixture pack covering all five behaviors:
 *   - a 6-commit delta refuses; a clean 3-commit delta is eligible;
 *   - a migration path in the delta refuses;
 *   - a live foreign push-claim refuses;
 *   - changelog on the same fixture twice is byte-identical + grouped;
 *   - a pending run finalized by a same-startedAt outcome folds last-wins, and a stale
 *     pending is orphan-flagged.
 * No real git, no real .sma/. Returns 1 only if every assertion holds.
 * @returns {number}
 */
export function shipLaneSelftest() {
  const root = mkdtempSync(join(tmpdir(), 'sma-shiplane-self-'))
  try {
    // 1. delta count — refuse 6, allow 3.
    const over = checkQuickPrecondition({ execGit: cannedGit({ log: nLines(6), diff: 'a.ts\n' }), checkPushClaim: () => ({ live: false }), maxDelta: 5 })
    if (over.allowed || over.delta !== 6) return 0
    const ok3 = checkQuickPrecondition({ execGit: cannedGit({ log: nLines(3), diff: 'a.ts\n' }), checkPushClaim: () => ({ live: false }), maxDelta: 5 })
    if (!ok3.allowed || ok3.delta !== 3) return 0

    // 2. migration leg.
    const mig = checkQuickPrecondition({ execGit: cannedGit({ log: nLines(2), diff: 'src/migrations/078_x.ts\n' }), checkPushClaim: () => ({ live: false }) })
    if (mig.allowed || mig.migrations.length !== 1) return 0

    // 3. push-claim leg (foreign).
    const foreign = checkQuickPrecondition({ execGit: cannedGit({ log: nLines(2), diff: 'a.ts\n' }), checkPushClaim: () => ({ live: true, who: 'other' }), self: 'me' })
    if (foreign.allowed || !foreign.reasons.join(' ').includes('other')) return 0

    // 4. changelog determinism.
    const commits = [
      { sha: 'a', subject: 'feat(x): one' },
      { sha: 'b', subject: 'fix: two' },
      { sha: 'c', subject: 'weird line' },
    ]
    const d1 = draftChangelog({ commits })
    const d2 = draftChangelog({ commits })
    if (d1 !== d2) return 0
    if (!d1.includes('feat(x): one') || !d1.toLowerCase().includes('other')) return 0

    // 5. records fold + orphan flag.
    const spendDir = join(root, 'spend')
    appendShipLaneRun({ spendDir, run: { lane: 'quick', startedAt: '2026-07-13T10:00:00.000Z', outcome: 'pending' } })
    appendShipLaneRun({ spendDir, run: { lane: 'quick', startedAt: '2026-07-13T10:00:00.000Z', endedAt: '2026-07-13T10:05:00.000Z', outcome: 'green' } })
    appendShipLaneRun({ spendDir, run: { lane: 'quick', startedAt: '2026-07-01T10:00:00.000Z', outcome: 'pending' } })
    writeFileSync(shipLaneFile(spendDir), '{corrupt\n', { flag: 'a' })
    const { runs, corrupt } = readShipLaneRuns({ spendDir })
    if (corrupt !== 1) return 0
    const folded = runs.find((r) => r.startedAt === '2026-07-13T10:00:00.000Z')
    if (!folded || folded.outcome !== 'green') return 0
    const now = Date.parse('2026-07-13T12:00:00.000Z')
    const rep = laneReport({ runs, now })
    if (rep.pending.length !== 1 || rep.orphaned.length !== 1) return 0
    const s = laneStats({ runs, now })
    if (s.quickActiveP50Min !== 9999) return 0 // 1 finalized quick run < 3
    if (s.quickRedMinusFullRedPct !== 0) return 0 // no red yet

    return 1
  } catch {
    return 0
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* best-effort */
    }
  }
}
