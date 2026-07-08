/**
 * grill.mjs — the /sma-grill adversarial challenge ledger + build gate + the
 * budget-aware pre-push planner (49.2-07, D-49.2-11, the founder's /grillme ritual
 * absorbed into architecture).
 *
 * The LAW (D-49.2-11): an unresolved grill challenge blocks the build. A challenge
 * closes ONLY by
 *   - conversion — naming a predictionId that parsePredictions actually finds in the
 *     plan AND validatePrediction accepts (the teeth: verified against the committed
 *     plan, never trusted);
 *   - withdrawal (with a reason); or
 *   - a founder accepted-risk disposition (with non-empty disposition text).
 * Anything else keeps the challenge open and the gate blocked.
 *
 * The cross-examination CONVERSATION is the SKILL's job at plan time (never here) —
 * this module is the deterministic BOOKKEEPING under it. Substrate law: files only,
 * zero LLM, no network, NO child_process (pure over injected state — the CLI supplies
 * changedFiles from git diff and the planIndex from scanning .planning; the lib never
 * shells out and never reads .planning itself). Every dir is dependency-injected.
 *
 * Ledger shape (mirrors journal.mjs structurally): one append-only JSONL per planId
 * under dirs.grillDir — a per-plan file avoids the shared-append race (SPEC R10).
 * Event-sourced: a status change is a NEW line; readChallenges FOLDS later status
 * lines over the earlier registration by challenge id. A corrupt line is
 * skip-and-counted, never a throw (fail-open C9).
 */

import { appendFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { parsePredictions, validatePrediction } from './predict.mjs'
import { hitRate } from './calibration.mjs'

/** planId → safe JSONL filename (dots kept; path-hostile chars normalized). */
function planFileName(planId) {
  return `${String(planId ?? 'unknown').replace(/[^\w.-]+/g, '_')}.jsonl`
}

/** Read + parse one plan's ledger, skipping corrupt lines (journal.mjs posture). */
function parseFile(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { lines: [], corrupt: 0 }
  }
  const lines = []
  let corrupt = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      lines.push(JSON.parse(trimmed))
    } catch {
      corrupt += 1 // fail-open — skip-and-count, never throw (C9)
    }
  }
  return { lines, corrupt }
}

/** A registration line carries a `promise`; a status line does not. */
function isRegistration(line) {
  return line != null && typeof line.promise === 'string'
}

/**
 * foldChallenges(lines) -> Map<id, challenge>. Registration lines establish the
 * base; later status lines override status/predictionId/disposition/reason. A
 * `status:'landed'` line sets `landed:true` WITHOUT changing the resolved status.
 * A status line for an unknown id is ignored (fail-open).
 */
function foldChallenges(lines) {
  const byId = new Map()
  for (const line of lines) {
    if (isRegistration(line)) {
      byId.set(line.id, { ...line })
      continue
    }
    const cur = byId.get(line && line.id)
    if (!cur) continue // orphan status line — ignore
    if (line.status === 'landed' || line.landed === true) {
      cur.landed = true // landed is a flag, never a status transition
    } else if (line.status != null) {
      cur.status = line.status
    }
    if (line.predictionId != null) cur.predictionId = line.predictionId
    if (line.disposition != null) cur.disposition = line.disposition
    if (line.reason != null) cur.reason = line.reason
    if (line.by != null) cur.resolvedBy = line.by
    if (line.ts != null) cur.resolvedAt = line.ts
  }
  return byId
}

/** Append one JSON line to the plan's ledger file (mkdir-p first). */
function appendLine(grillDir, planId, record) {
  mkdirSync(grillDir, { recursive: true })
  appendFileSync(join(grillDir, planFileName(planId)), JSON.stringify(record) + '\n')
  return record
}

/**
 * registerChallenge({planId, promise, attack, raisedBy}, {grillDir}) -> the written
 * record. Appends {id:'CH-<planId>-<seq>', planId, promise, attack, status:'open',
 * raisedBy, ts, seq}. seq = (# existing registration lines) + 1.
 *
 * @param {{planId:string, promise:string, attack:string, raisedBy?:string}} args
 * @param {{grillDir:string, now?:string}} opts
 * @returns {object}
 */
export function registerChallenge({ planId, promise, attack, raisedBy }, opts = {}) {
  const grillDir = opts.grillDir
  const { lines } = parseFile(join(grillDir, planFileName(planId)))
  const seq = lines.filter(isRegistration).length + 1
  const record = {
    id: `CH-${planId}-${seq}`,
    planId,
    promise: String(promise ?? ''),
    attack: String(attack ?? ''),
    status: 'open',
    raisedBy: raisedBy ?? 'unknown',
    ts: opts.now ?? new Date().toISOString(),
    seq,
  }
  return appendLine(grillDir, planId, record)
}

/**
 * readChallenges({planId}, {grillDir}) -> {challenges, corrupt}. Folds the
 * event-sourced ledger into current challenge state. Missing file -> empty.
 *
 * @param {{planId:string}} args
 * @param {{grillDir:string}} opts
 * @returns {{challenges: object[], corrupt: number}}
 */
export function readChallenges({ planId }, opts = {}) {
  const { lines, corrupt } = parseFile(join(opts.grillDir, planFileName(planId)))
  return { challenges: [...foldChallenges(lines).values()], corrupt }
}

const RESOLVE_STATUSES = new Set(['converted', 'withdrawn', 'accepted-risk', 'landed'])

/**
 * resolveChallenge(args, {grillDir}) -> {ok, reason?, challenge?}.
 *
 * The LAW's teeth (D-49.2-11): 'converted' is VERIFIED — parsePredictions(planPath)
 * must contain the named predictionId AND validatePrediction must accept it, else the
 * resolution is rejected and the challenge stays open. 'withdrawn' needs a non-empty
 * reason; 'accepted-risk' needs non-empty disposition text (the founder's words).
 * 'landed' tags a converted challenge whose defect later surfaced pre-push (the yield
 * instrument). Never throws.
 *
 * @param {{planPath:string, planId:string, challengeId:string, status:string,
 *          predictionId?:string, disposition?:string, reason?:string, by?:string}} args
 * @param {{grillDir:string, now?:string}} opts
 * @returns {{ok:boolean, reason?:string, challenge?:object}}
 */
export function resolveChallenge(args = {}, opts = {}) {
  const { planPath, planId, challengeId, status, predictionId, disposition, reason, by } = args
  const grillDir = opts.grillDir

  if (!RESOLVE_STATUSES.has(status)) {
    return { ok: false, reason: `status "${status}" not in {converted, withdrawn, accepted-risk, landed}` }
  }

  const { challenges } = readChallenges({ planId }, { grillDir })
  const existing = challenges.find((c) => c.id === challengeId)
  if (!existing) return { ok: false, reason: `challenge "${challengeId}" not found for plan ${planId}` }

  if (status === 'converted') {
    if (!predictionId) return { ok: false, reason: 'converted requires --prediction <P-id>' }
    const { predictions } = parsePredictions(planPath)
    const entry = predictions.find((p) => p && p.id === predictionId)
    if (!entry) {
      return { ok: false, reason: `prediction "${predictionId}" not found in ${planPath} (conversion must name a real, committed prediction)` }
    }
    const v = validatePrediction(entry)
    if (!v.valid) {
      return { ok: false, reason: `prediction "${predictionId}" is invalid (missing: ${v.missing.join(', ') || '-'}; errors: ${v.errors.join('; ') || '-'})` }
    }
  } else if (status === 'withdrawn') {
    if (!reason || !String(reason).trim()) return { ok: false, reason: 'withdrawn requires a non-empty --reason' }
  } else if (status === 'accepted-risk') {
    if (!disposition || !String(disposition).trim()) {
      return { ok: false, reason: 'accepted-risk requires non-empty disposition text (the founder\'s words)' }
    }
  }

  const record = {
    id: challengeId,
    status,
    ...(predictionId != null ? { predictionId } : {}),
    ...(disposition != null ? { disposition } : {}),
    ...(reason != null ? { reason } : {}),
    by: by ?? 'unknown',
    ts: opts.now ?? new Date().toISOString(),
  }
  appendLine(grillDir, planId, record)
  const folded = readChallenges({ planId }, { grillDir }).challenges.find((c) => c.id === challengeId)
  return { ok: true, challenge: folded }
}

/**
 * grillGate({planPath, planId, dirs}) -> the gate verdict.
 *   {allowed:false, grilled:true, open:[...]}   while any challenge is open
 *   {allowed:true,  grilled:true, open:[]}       when all are resolved
 *   {allowed:true,  grilled:false, open:[]}      for a plan with no grill file
 * The consumer WARNs on grilled:false (an ungrilled plan builds, fail-open), never
 * blocks; it STOPs on allowed:false. Never throws.
 *
 * @param {{planPath?:string, planId:string, dirs:{grillDir:string}}} args
 * @returns {{allowed:boolean, grilled:boolean, open:object[]}}
 */
export function grillGate({ planId, dirs = {} } = {}) {
  try {
    const { lines } = parseFile(join(dirs.grillDir, planFileName(planId)))
    if (!lines.length) return { allowed: true, grilled: false, open: [] }
    const challenges = [...foldChallenges(lines).values()]
    const open = challenges.filter((c) => c.status === 'open')
    return { allowed: open.length === 0, grilled: true, open }
  } catch {
    return { allowed: true, grilled: false, open: [] } // fail-open — never block on a bug
  }
}

// ── the budget-aware pre-push planner ──────────────────────────────────────────

/** Normalize a path for matching: lower-case, backslash → forward-slash. */
function normPath(p) {
  return String(p ?? '').replace(/\\/g, '/').toLowerCase()
}

/** Compile a files_modified glob to an anchored regex (`**`→any, `*`→segment). */
function globToRe(glob) {
  const g = normPath(glob)
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*'
        i++
        if (g[i + 1] === '/') i++ // `**/` also matches zero dirs
      } else {
        re += '[^/]*'
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

/** True when a changed file matches any of a plan's files_modified globs. */
function fileMatchesPlan(file, plan) {
  const nf = normPath(file)
  return (plan.files ?? []).some((glob) => {
    const gg = normPath(glob)
    // exact / suffix / glob match — a plan glob may carry a `../` prefix the diff lacks.
    if (nf === gg) return true
    if (gg.includes('*')) return globToRe(gg).test(nf) || (gg.includes('/') && nf.endsWith(gg.split('*')[0].split('/').pop() ?? ''))
    return nf === gg || nf.endsWith('/' + gg) || gg.endsWith('/' + nf) || nf.endsWith(gg)
  })
}

/**
 * prePushPlan({changedFiles, planIndex, ledger, budget, minN, threshold}) -> a
 * deterministic depth plan. Maps changed files → domains via the injected planIndex
 * (files_modified → domains edges; a file mapping to no plan is domain 'unknown'),
 * ranks proven-bad (hitRate<threshold, n>=minN) FIRST, then unproven (n<minN), then
 * proven-good, tie-broken lexicographically by domain, and returns at most `budget`
 * DEEP items (each naming the most recent plan touching that domain as the
 * blind-verify target) plus the rest as LIGHT items. Empty ledger → everything
 * unproven, still deterministic. Zero LLM; pure over injected state.
 *
 * @param {{changedFiles?:string[], planIndex?:object[], ledger?:object[],
 *          budget?:number, minN?:number, threshold?:number}} args
 * @returns {{deep:object[], light:object[], budget:number}}
 */
export function prePushPlan(args = {}) {
  const changedFiles = args.changedFiles ?? []
  const planIndex = args.planIndex ?? []
  const ledger = args.ledger ?? []
  const budget = Number.isFinite(args.budget) ? args.budget : 3
  const minN = Number.isFinite(args.minN) ? args.minN : 5
  const threshold = Number.isFinite(args.threshold) ? args.threshold : 0.6

  // 1. changed files → domains (+ which plans touch each domain, with recency order).
  const domainSet = new Set()
  const domainToPlans = new Map()
  for (const f of changedFiles) {
    const matches = planIndex.filter((p) => fileMatchesPlan(f, p))
    if (!matches.length) {
      domainSet.add('unknown')
      continue
    }
    for (const p of matches) {
      const doms = p.domains && p.domains.length ? p.domains : ['unknown']
      for (const d of doms) {
        domainSet.add(d)
        if (!domainToPlans.has(d)) domainToPlans.set(d, [])
        domainToPlans.get(d).push({ planId: p.planId, order: Number.isFinite(p.order) ? p.order : 0 })
      }
    }
  }

  // 2. per-domain calibration tier from the ledger.
  const byDomain = new Map()
  for (const r of ledger) {
    const d = (r && r.domain) ?? 'unknown'
    if (!byDomain.has(d)) byDomain.set(d, [])
    byDomain.get(d).push(r)
  }

  const ranked = []
  for (const d of domainSet) {
    const { rate, n } = hitRate(byDomain.get(d) ?? [])
    let tier // 0 proven-bad, 1 unproven, 2 proven-good
    if (n >= minN && rate != null && rate < threshold) tier = 0
    else if (n < minN) tier = 1
    else tier = 2
    const plans = (domainToPlans.get(d) ?? [])
      .slice()
      .sort((a, b) => b.order - a.order || (a.planId < b.planId ? 1 : a.planId > b.planId ? -1 : 0))
    ranked.push({ domain: d, tier, n, rate: rate ?? null, plan: plans.length ? plans[0].planId : null })
  }

  ranked.sort((a, b) => a.tier - b.tier || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0))
  return { deep: ranked.slice(0, budget), light: ranked.slice(budget), budget }
}

/**
 * challengeStats({grillDir}) -> {grilledPlans, plansWithLanded, yieldPct}. A plan is
 * "grilled" if its ledger carries >=1 challenge; yield = pct of grilled plans having
 * >=1 challenge with landed:true (set by the --land flow when a pre-push defect traces
 * back to a challenge). Zero grilled plans -> 0. yieldPct is an integer (the
 * P49.2-07-A instrument's numeric-last-line contract). Never throws.
 *
 * @param {{grillDir:string}} opts
 * @returns {{grilledPlans:number, plansWithLanded:number, yieldPct:number}}
 */
export function challengeStats(opts = {}) {
  let files
  try {
    files = readdirSync(opts.grillDir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return { grilledPlans: 0, plansWithLanded: 0, yieldPct: 0 }
  }
  let grilledPlans = 0
  let plansWithLanded = 0
  for (const f of files) {
    const { lines } = parseFile(join(opts.grillDir, f))
    const challenges = [...foldChallenges(lines).values()]
    if (!challenges.length) continue
    grilledPlans += 1
    if (challenges.some((c) => c.landed === true)) plansWithLanded += 1
  }
  const yieldPct = grilledPlans ? Math.round((plansWithLanded / grilledPlans) * 100) : 0
  return { grilledPlans, plansWithLanded, yieldPct }
}
