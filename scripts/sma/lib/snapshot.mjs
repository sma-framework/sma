/**
 * snapshot.mjs — the terminal→CRM reporter (R12, D-49-04/05/11, P1).
 *
 * Two exports carry the contract:
 *   buildSnapshotPayload() — reads THIS terminal's own lease + its own journal
 *     tail + a memory-health summary and assembles the online-mirror payload by
 *     an EXPLICIT key allowlist. No object spread of raw local state ever reaches
 *     the payload (P1): a note body, an env dump, a file's contents present in the
 *     local files never survive serialization — they are simply not picked.
 *   sendSnapshot() — POSTs the payload to the CRM receiver (49-07) with the
 *     x-sma-token header and a 5s AbortController timeout. It is FAIL-OPEN (C9,
 *     R12): every failure (no token, network error, non-2xx, timeout) is swallowed
 *     to a journal 'snapshot-fail' event + {sent:false}. Killing the network never
 *     affects the terminal's local work — the whole point of the one-way mirror.
 *
 * runSnapshot() is the CLI entry (cli.mjs `snapshot` subcommand, 49-10): build →
 * send → return a small JSON status. It too never throws.
 *
 * ── ONE-WAY MIRROR (D-49-05) ────────────────────────────────────────────────
 * The authoritative coordination state is the repo's `.sma/` filesystem. This
 * module only projects a bounded, allowlisted view of it toward the CRM so the
 * founder can SEE the terminals. Nothing here reads the mirror back to make a
 * decision.
 *
 * ── DAEMON-FREE (D-49-11) ───────────────────────────────────────────────────
 * The cadence is driven by registry.heartbeat: a successful (non-skipped)
 * heartbeat spawns a detached one-shot `node scripts/sma/cli.mjs snapshot` and
 * unrefs it (fire-and-forget). This module is the body that short-lived child
 * runs; there is no long-lived process.
 *
 * COMMENT-TEXT DISCIPLINE (SMA-3): scripts/sma/** is grepped for the two-word git
 * deploy verb — this file only ever mentions 'push' alone (never the pair).
 *
 * Node built-ins only; zero npm deps. The fetch impl + fs dirs + identity are all
 * dependency-injectable for tests.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveTerminalIdentity, smaRoot } from './registry.mjs'
import { readJsonSafe } from './fs-atomics.mjs'
import { journalTail, appendEvent, readJournal } from './journal.mjs'
import { readLedger, hitRate } from './calibration.mjs'
import { buildBook, windowSpend, readBudget } from './spend.mjs'
import { SESSIONS_DIR, JOURNAL_DIR, CALIBRATION_DIR, SPEND_DIR, JOURNAL_TAIL_FOR_SNAPSHOT } from './constants.mjs'

/**
 * The EXPLICIT allowlist — the exact field set the receiving route (49-07,
 * ALLOWED_KEYS) persists. The payload is assembled by named picks from this set;
 * nothing outside it ever reaches the wire.
 */
const PAYLOAD_KEYS = [
  'terminalId',
  'holderIdentity',
  'pid',
  'status',
  'scopeGlobs',
  'scopeDescription',
  'blockers',
  'acquireTime',
  'renewTime',
  'sentAt',
  'collisionFeed',
  'memoryHealth',
  // ── v2 (49.1-25, B21) — the extended cockpit blocks ──────────────────────────
  // Each is assembled from the SAME shared `.sma/` sources `sma report` (49.1-24)
  // reads: one data layer, two projections (static HTML / home cockpit). A failing
  // reader nulls its block (the cockpit renders a provisioning/empty hint from null,
  // never a fabricated zero — feedback_no_fake_dashboard_data).
  'schemaVersion',
  'predictions',
  'calibration',
  'reflexFires',
  'gates',
  'corpusHealth',
  // ── 49.2-09 (D-49.2-13) — the deterministic spend ledger block ───────────────
  'spend',
]

/** v2 feed bound (per-feed item cap) + the overall payload byte cap. */
const V2_FEED_CAP = 20
const PAYLOAD_SIZE_CAP = 64 * 1024

/** collisionFeed item shape — exactly these keys survive per journal entry. */
const COLLISION_ITEM_KEYS = ['type', 'actors', 'scope', 'ts']

/** memoryHealth shape — only numeric/hash summary keys, never corpus text. */
const MEMORY_HEALTH_KEYS = ['lintCritical', 'lintWarn', 'corpusFiles', 'indexCommit', 'indexBuiltAt']

// The receiver URL is env-only (SMA_SNAPSHOT_URL) — the engine ships with NO
// built-in endpoint. A default would silently point every external install's
// telemetry (and its secret token header) at whoever hardcoded it.
const SEND_TIMEOUT_MS = 5000

/**
 * pickCollisionItem(evt) → a bounded {type,actors,scope,ts} object. Every other
 * key on the raw journal line (detail, seq, terminal, note bodies) is dropped by
 * construction — the feed carries coordination metadata only (P1).
 */
function pickCollisionItem(evt) {
  const item = {}
  item.type = typeof evt?.type === 'string' ? evt.type : 'warn'
  item.actors = Array.isArray(evt?.actors) ? evt.actors : []
  item.scope = evt?.scope ?? null
  item.ts = typeof evt?.ts === 'string' ? evt.ts : null
  // Guard: return ONLY the four known keys (defensive against future evt shapes).
  const out = {}
  for (const k of COLLISION_ITEM_KEYS) out[k] = item[k]
  return out
}

/**
 * pickMemoryHealth(raw) → {lintCritical,lintWarn,corpusFiles,indexCommit,
 * indexBuiltAt} narrowed to the known keys, or null when the source is absent.
 */
function pickMemoryHealth(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  for (const k of MEMORY_HEALTH_KEYS) {
    if (k in raw) out[k] = raw[k]
  }
  return out
}

/**
 * defaultLoadMemoryHealth({corpusDir}) — best-effort summary of the memory corpus
 * health: lint criticals/warnings via a lazy import of lint.mjs (try/catch →
 * null on any failure), corpus file count, and the index commit/built-at parsed
 * from the committed MEMORY.md GENERATED marker line (absent on the pre-flip
 * hand-authored index → those two stay undefined). Never throws.
 * @param {{corpusDir?:string}} [opts]
 * @returns {object|null}
 */
export async function defaultLoadMemoryHealth(opts = {}) {
  const corpusDir = opts.corpusDir ?? join('.claude', 'memory')
  const health = {}
  // (a) lint summary — lazy import; degrade to no lint keys on any failure.
  try {
    const lint = await import('./lint.mjs')
    const report = lint.runLint({
      corpusDir,
      tagsPath: join(corpusDir, 'TAGS.md'),
      indexPath: join(corpusDir, 'MEMORY.md'),
      claudeMdPath: 'CLAUDE.md',
    })
    const findings = Array.isArray(report?.findings) ? report.findings : []
    health.lintCritical = findings.filter((f) => f && f.tier === 'critical').length
    health.lintWarn = findings.filter((f) => f && f.tier === 'warn').length
  } catch {
    /* fail-open — omit lint keys */
  }
  // (b) corpus file count + index anchor from MEMORY.md marker line (read-only).
  try {
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(corpusDir).filter((f) => f.endsWith('.md'))
    health.corpusFiles = files.length
  } catch {
    /* fail-open */
  }
  try {
    const indexText = readFileSync(join(corpusDir, 'MEMORY.md'), 'utf8')
    // GENERATED marker: '<!-- GENERATED by ... at commit <hash> — ... -->'
    const m = indexText.match(/GENERATED by[^]*?at commit\s+([0-9a-f]{7,40})/i)
    if (m) health.indexCommit = m[1]
    const built = indexText.match(/built(?:At|-at)?\s*[:=]\s*([0-9T:.\-Z]+)/i)
    if (built) health.indexBuiltAt = built[1]
  } catch {
    /* fail-open — pre-flip hand-authored index has no marker */
  }
  return Object.keys(health).length ? health : null
}

/**
 * gatherCalibration(calibrationDir) → {predictions, calibration}. Reads the shared
 * calibration ledger (49.1-08) and projects (a) recent verdicts newest-first and
 * (b) per-domain hit-rate. An absent/empty ledger yields BOTH blocks null (honest
 * empty — the cockpit renders a provisioning hint, not a fabricated 0%). Fail-open.
 */
function gatherCalibration(calibrationDir) {
  try {
    const { records } = readLedger({ calibrationDir })
    if (!Array.isArray(records) || records.length === 0) return { predictions: null, calibration: null }

    const predictions = records
      .filter((r) => r && r.ts)
      .sort((a, b) => (a.ts < b.ts ? 1 : -1)) // newest first
      .slice(0, V2_FEED_CAP)
      .map((r) => ({ domain: r.domain ?? 'unknown', verdict: r.verdict ?? '—', ts: r.ts }))

    const byDomain = new Map()
    for (const r of records) {
      const d = r.domain ?? 'unknown'
      if (!byDomain.has(d)) byDomain.set(d, [])
      byDomain.get(d).push(r)
    }
    const calibration = [...byDomain.entries()].map(([domain, recs]) => {
      const hr = hitRate(recs)
      return { domain, rate: hr.rate, n: hr.n, hits: hr.hits, misses: hr.misses }
    })
    return { predictions: predictions.length ? predictions : null, calibration: calibration.length ? calibration : null }
  } catch {
    return { predictions: null, calibration: null } // fail-open
  }
}

/**
 * gatherJournalFires(journalDir) → {reflexFires, gates}. Reads the shared journal
 * and projects the reflex (49.1-10) + gate (49.1-16) firings newest-first, each
 * narrowed to display scalars. No such events → the block is null. Fail-open.
 */
function gatherJournalFires(journalDir) {
  try {
    const { events } = readJournal({ journalDir })
    if (!Array.isArray(events)) return { reflexFires: null, gates: null }

    const reflex = events
      .filter((e) => e && e.type === 'reflex')
      .slice(-V2_FEED_CAP)
      .reverse() // newest first
      .map((e) => ({
        noteId: (e.detail && e.detail.noteId) || '—',
        target: e.scope ?? (e.detail && e.detail.target) ?? '',
        tier: (e.detail && e.detail.tier) || '',
        actor: Array.isArray(e.actors) ? e.actors.join(', ') : '',
        ts: e.ts ?? '',
      }))

    const gate = events
      .filter((e) => e && e.type === 'gate')
      .slice(-V2_FEED_CAP)
      .reverse() // newest first
      .map((e) => ({
        gateId: (e.detail && e.detail.gateId) || '—',
        target: e.scope ?? (e.detail && e.detail.target) ?? '',
        actor: Array.isArray(e.actors) ? e.actors.join(', ') : '',
        ts: e.ts ?? '',
      }))

    return { reflexFires: reflex.length ? reflex : null, gates: gate.length ? gate : null }
  } catch {
    return { reflexFires: null, gates: null } // fail-open
  }
}

/**
 * gatherSpend({spendDir, repoRoot, now}) → the bounded spend block, or null. Reads the
 * deterministic spend book (via the incremental cache) + the window budget and projects
 * ONLY aggregates by the SAME explicit-pick discipline (P1): window usd vs cap, the top-5
 * models, the drift/unpriced counters, and the pricing version. NO file paths, NO log
 * lines, NO session ids beyond what the registry already mirrors. Fail-open → null (the
 * cockpit renders a provisioning hint from null, never a fabricated zero).
 */
function gatherSpend({ spendDir, repoRoot, now } = {}) {
  try {
    if (!spendDir) return null
    const book = buildBook({ spendDir, repoRoot, env: process.env, now, persist: true })
    const budget = readBudget({ spendDir })
    const win = windowSpend({ book, now, windowHours: budget.windowHours })
    const pct = budget.capUsd ? Math.round((win.usd / budget.capUsd) * 1000) / 10 : null
    const topModels = Object.entries(book.byModel || {})
      .sort((a, b) => b[1].usd - a[1].usd)
      .slice(0, 5)
      .map(([model, v]) => ({ model: String(model).slice(0, 64), usd: v.usd }))
    return {
      windowUsd: win.usd,
      capUsd: Number.isFinite(budget.capUsd) ? budget.capUsd : null,
      pct,
      windowHours: budget.windowHours,
      topModels,
      counters: { unrecognized: book.counters.unrecognized, unpriced: book.counters.unpriced },
      pricingVersion: book.pricingVersion,
      updatedAt: book.builtAt,
    }
  } catch {
    return null // fail-open — a spend-read failure never wedges the reporter
  }
}

/**
 * capPayloadSize(payload, cap) — enforce the byte cap by dropping the OLDEST item
 * from the largest newest-first feed until the serialized payload fits. Feeds are
 * already item-bounded to V2_FEED_CAP; this is the belt-and-braces size guard so a
 * flood of long strings can never blow the wire budget (Test 4). Mutates + returns.
 */
function capPayloadSize(payload, cap) {
  const feeds = ['predictions', 'reflexFires', 'gates']
  let guard = 0
  while (Buffer.byteLength(JSON.stringify(payload), 'utf8') > cap && guard < 10000) {
    guard += 1
    let target = null
    let max = 0
    for (const f of feeds) {
      if (Array.isArray(payload[f]) && payload[f].length > max) {
        max = payload[f].length
        target = f
      }
    }
    if (!target || payload[target].length === 0) break
    payload[target] = payload[target].slice(0, -1) // drop the oldest (tail of newest-first)
  }
  return payload
}

/**
 * buildSnapshotPayload(opts) — assemble the online-mirror payload by explicit
 * allowlist picks (P1). Reads own lease (registry sessions dir) + own journal
 * tail (bounded to 20) + a memory-health summary. sentAt = now ISO.
 *
 * @param {{
 *   identity?:{holderIdentity:string,terminalId:string,pid:number},
 *   sessionsDir?:string, journalDir?:string, calibrationDir?:string, now?:number,
 *   memoryHealth?:object|null, loadMemoryHealth?:Function
 * }} [opts]
 * @returns {object} an allowlist-clean payload (schemaVersion 2)
 */
export function buildSnapshotPayload(opts = {}) {
  const identity = opts.identity ?? resolveTerminalIdentity({})
  const sessionsDir = opts.sessionsDir ?? SESSIONS_DIR
  const journalDir = opts.journalDir ?? JOURNAL_DIR
  const calibrationDir = opts.calibrationDir ?? CALIBRATION_DIR
  const nowIso = new Date(opts.now ?? Date.now()).toISOString()

  // Own lease (fail-open to a minimal shape if absent/corrupt).
  const lease = readJsonSafe(join(sessionsDir, `${identity.terminalId}.json`)) || {}
  const scope = lease.scope && typeof lease.scope === 'object' ? lease.scope : {}

  // Own journal tail, bounded, mapped to the allowlisted item shape.
  let feed = []
  try {
    const tail = journalTail(identity.terminalId, JOURNAL_TAIL_FOR_SNAPSHOT, { journalDir })
    feed = (Array.isArray(tail) ? tail : []).slice(-JOURNAL_TAIL_FOR_SNAPSHOT).map(pickCollisionItem)
  } catch {
    feed = [] // fail-open
  }

  // Memory-health summary: injected value takes precedence, else the injected
  // loader (sync), else null. The async default loader is used by runSnapshot.
  let healthRaw = null
  if ('memoryHealth' in opts) healthRaw = opts.memoryHealth
  else if (typeof opts.loadMemoryHealth === 'function') {
    try {
      healthRaw = opts.loadMemoryHealth()
    } catch {
      healthRaw = null
    }
  }
  const memoryHealth = pickMemoryHealth(healthRaw)

  // ── explicit picks — NEVER spread the lease or any raw local object ──────────
  const payload = {}
  payload.terminalId = identity.terminalId
  payload.holderIdentity = lease.holderIdentity ?? identity.holderIdentity
  payload.pid = typeof lease.pid === 'number' ? lease.pid : identity.pid
  payload.status = typeof lease.status === 'string' ? lease.status : 'working'
  payload.scopeGlobs = Array.isArray(scope.globs) ? scope.globs : []
  payload.scopeDescription = typeof scope.description === 'string' ? scope.description : ''
  payload.blockers = Array.isArray(lease.blockers) ? lease.blockers : []
  payload.acquireTime = typeof lease.acquireTime === 'string' ? lease.acquireTime : null
  payload.renewTime = typeof lease.renewTime === 'string' ? lease.renewTime : null
  payload.sentAt = nowIso
  payload.collisionFeed = feed
  payload.memoryHealth = memoryHealth

  // ── v2 blocks (49.1-25, B21) — the SAME shared sources `sma report` reads ─────
  payload.schemaVersion = 2
  const { predictions, calibration } = gatherCalibration(calibrationDir)
  payload.predictions = predictions
  payload.calibration = calibration
  const { reflexFires, gates } = gatherJournalFires(journalDir)
  payload.reflexFires = reflexFires
  payload.gates = gates
  // corpusHealth carries the same memory-health summary the report's corpus panel
  // shows (defaultLoadMemoryHealth) — null when the source is absent.
  payload.corpusHealth = memoryHealth
  // ── 49.2-09 (D-49.2-13) — the deterministic spend ledger block (aggregates only) ──
  payload.spend = gatherSpend({ spendDir: opts.spendDir ?? SPEND_DIR, repoRoot: opts.repoRoot, now: opts.now ?? Date.now() })

  // Defensive: strip any key that is not in the allowlist (belt + braces, P1).
  for (const k of Object.keys(payload)) {
    if (!PAYLOAD_KEYS.includes(k)) delete payload[k]
  }

  // Size guard (Test 4): keep the wire payload under the byte cap, oldest-first.
  return capPayloadSize(payload, PAYLOAD_SIZE_CAP)
}

/**
 * sendSnapshot(opts) — POST the payload to the CRM receiver, fail-open.
 * Resolves to {sent:true, status} on a 2xx, else {sent:false, reason}. NEVER
 * throws and NEVER rejects: a caught error is swallowed to a 'snapshot-fail'
 * journal event + {sent:false}. With no token → {sent:false, reason:'no-token'}
 * and fetch is never called (C9, R12).
 *
 * @param {{
 *   url?:string, token?:string, fetchImpl?:Function, payload?:object,
 *   identity?:object, sessionsDir?:string, journalDir?:string, now?:number
 * }} [opts]
 * @returns {Promise<{sent:boolean, status?:number, reason?:string}>}
 */
export async function sendSnapshot(opts = {}) {
  const identity = opts.identity ?? resolveTerminalIdentity({})
  const journalDir = opts.journalDir ?? JOURNAL_DIR

  const token = opts.token ?? process.env.SMA_SNAPSHOT_TOKEN
  if (!token || (typeof token === 'string' && !token.trim())) {
    // No token → clean no-op. Not a failure, not journaled — the founder simply
    // has not provisioned SMA_SNAPSHOT_TOKEN yet (operator step).
    return { sent: false, reason: 'no-token' }
  }

  const url = opts.url ?? process.env.SMA_SNAPSHOT_URL
  if (!url || (typeof url === 'string' && !url.trim())) {
    // Token set but no receiver URL → clean no-op, same contract as no-token.
    return { sent: false, reason: 'no-url' }
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch

  let payload = opts.payload
  if (!payload) {
    try {
      payload = buildSnapshotPayload({
        identity,
        sessionsDir: opts.sessionsDir,
        journalDir,
        now: opts.now,
      })
    } catch {
      return failOpen(journalDir, identity, 'build-failed')
    }
  }

  if (typeof fetchImpl !== 'function') {
    return failOpen(journalDir, identity, 'no-fetch')
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), SEND_TIMEOUT_MS) : null
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sma-token': token },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    })
    if (timer) clearTimeout(timer)
    const ok = res && (res.ok === true || (typeof res.status === 'number' && res.status >= 200 && res.status < 300))
    if (ok) return { sent: true, status: res && res.status }
    return failOpen(journalDir, identity, `http-${(res && res.status) || 'unknown'}`)
  } catch (err) {
    if (timer) clearTimeout(timer)
    return failOpen(journalDir, identity, err && err.name === 'AbortError' ? 'timeout' : 'network')
  }
}

/** Journal a 'snapshot-fail' event (best-effort) and return {sent:false, reason}. */
function failOpen(journalDir, identity, reason) {
  try {
    appendEvent(
      { type: 'snapshot-fail', actors: [identity.holderIdentity], detail: { reason } },
      { terminalId: identity.terminalId, journalDir },
    )
  } catch {
    /* even the journal write is best-effort — never wedge the terminal */
  }
  return { sent: false, reason }
}

/**
 * runSnapshot(flags) — the CLI entry (cli.mjs `snapshot`). Build the payload
 * (with the async default memory-health loader) then send it. Never throws.
 *
 * WR-06: PREFER caller-supplied dirs (flags.sessionsDir / flags.journalDir) over the
 * module's own smaRoot() derivation, so SMA_ROOT_OVERRIDE — which the CLI resolves once
 * and threads down — is honored here too. Without this, a test/tooling override was
 * silently ignored by this ONE subcommand and it read (and journaled snapshot-fail
 * events into) the REAL repo `.sma/`.
 * @param {object} [flags]
 * @returns {Promise<{sent:boolean, reason?:string, status?:number}>}
 */
export async function runSnapshot(flags = {}) {
  try {
    // TOKEN GATE FIRST — before ANY heavy work (R7 fix step 4). An unprovisioned
    // checkout (SMA_SNAPSHOT_TOKEN unset, the A-047 deferral) must exit near-free on
    // every detached-snapshot beat: WITHOUT this early return, defaultLoadMemoryHealth()
    // ran a full 205-note corpus lint on each spawn, which — amplified by the (now-fixed)
    // dead heartbeat throttle — imposed a per-Edit/Write CPU tax. sendSnapshot re-checks
    // the token (defense in depth); this only skips the expensive build.
    const token = flags.token ?? process.env.SMA_SNAPSHOT_TOKEN
    if (!token || (typeof token === 'string' && !token.trim())) {
      return { sent: false, reason: 'no-token' }
    }
    const identity = resolveTerminalIdentity({})
    const root = join(smaRoot(), '.sma')
    const sessionsDir = flags.sessionsDir ?? join(root, 'sessions')
    const journalDir = flags.journalDir ?? join(root, 'journal')
    const calibrationDir = flags.calibrationDir ?? join(root, 'calibration')
    const spendDir = flags.spendDir ?? join(root, 'spend')
    const repoRoot = smaRoot() // repo root for local-session-log discovery (D-49.2-13)
    const memoryHealth = await defaultLoadMemoryHealth({})
    const payload = buildSnapshotPayload({ identity, sessionsDir, journalDir, calibrationDir, spendDir, repoRoot, memoryHealth })
    return await sendSnapshot({ payload, identity, sessionsDir, journalDir })
  } catch {
    return { sent: false, reason: 'run-failed' } // fail-open — the reporter never wedges a session
  }
}
