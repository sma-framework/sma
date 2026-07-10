/**
 * notify.mjs — the claim PULSE + the edge-triggered outbound waiting-for-human
 * webhook (9.3-07, D-9.3-13).
 *
 * THE ONE NEW SANCTIONED OUTBOUND PATH (beside snapshot.mjs's one-way CRM mirror),
 * explicitly permitted by D-9.3-13 and policed by the security guard from this
 * commit on. The boundary is deliberate and total:
 *   - OUTBOUND EVENTS ONLY. A transition INTO waiting-for-human fires exactly ONE
 *     HTTP POST to a USER-configured URL. Nothing else ever leaves.
 *   - NO REMOTE CONTROL. The response object is ignored by construction — this
 *     module never reads response.body / .json() / .text(). There is no inbound
 *     socket, no listener, no server, no polling loop anywhere in it. The guard
 *     greps for exactly this posture (no node http server, no inbound surface).
 *   - EXPLICIT-PICK PAYLOAD. The body is assembled by named picks from
 *     ALLOWED_WEBHOOK_KEYS only (the snapshot.mjs discipline) — event-only facts,
 *     never message text, diff hunks, file contents, transcript paths, or env.
 *   - OFF BY DEFAULT. No configured URL means NO network call, ever. Silence is
 *     the default posture; SMA_NOTIFY_DISABLE is the hard kill-switch.
 *
 * NO PARALLEL STORE (D-9.3-02): the pulse rides the EXISTING session lease field
 * `fpStatus` (registry.FP_STATUS_VALUES / FP_STATUS on the lease, shipped 9.3-13)
 * — NOT a new duplicate field. registry's WORK axis `status` (working|blocked|idle|
 * done — what the session SAYS) stays untouched; the pulse is the ATTENTION axis.
 * `pulseSince` is the companion transition timestamp. `idle` is DERIVED at read time
 * from lease staleness (derivePulse) and is NEVER written by anyone (files+git law).
 *
 * FAIL-OPEN (carried C9/P4): setPulse + firePulseWebhook swallow every failure to a
 * journal event + a safe return — a webhook error can never block the caller's hook
 * exit. Node built-ins only (global fetch + AbortController); fetch/now/env/identity
 * are all dependency-injected for tests.
 */

import { join, dirname, basename } from 'node:path'
import { readFileSync } from 'node:fs'

import { atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'

/** The three pulse states. Identical to registry.FP_STATUS_VALUES by contract (the
 * pulse rides the lease `fpStatus` field — no parallel store). 'idle' is derived-only. */
export const PULSE_VALUES = ['working', 'waiting-for-human', 'idle']

/** The EXPLICIT payload allowlist — the exact + ONLY key set the webhook body carries.
 * Assembled by named picks (never a filtered spread), so message/diff/file/env content
 * present in the caller's ctx is simply NOT picked (proven by the hostile-extras test). */
export const ALLOWED_WEBHOOK_KEYS = ['event', 'terminalId', 'workLabel', 'repo', 'ts', 'smaVersion']

/** Edge-trigger cooldown: at most ONE delivery per this window per terminal (flap guard). */
export const WEBHOOK_COOLDOWN_MS = 300000 // 5 min

/** Per-POST AbortController timeout — a hung receiver never blocks the caller. */
export const WEBHOOK_TIMEOUT_MS = 2000 // 2 s

/** Staleness threshold for the DERIVED idle pulse: no heartbeat renew in this long = idle. */
export const PULSE_IDLE_AFTER_MS = 600000 // 10 min

/**
 * setPulse(next, opts) — transition this terminal's attention pulse on its own lease.
 * 'idle' is REJECTED as a write (derived-only). Reads the prior pulse from the own lease,
 * patches `fpStatus` + `pulseSince`, and — ONLY on a genuine transition INTO
 * waiting-for-human — awaits firePulseWebhook (every failure swallowed). Returns
 * {changed, prev}. Never throws.
 *
 * @param {'working'|'waiting-for-human'} next
 * @param {{
 *   dirs?:object, identity?:{terminalId?:string}, fetchImpl?:Function,
 *   now?:number|Function, env?:object, sessionToken?:string|null, leaseIo?:{read?:Function, write?:Function}
 * }} [opts]
 * @returns {Promise<{changed:boolean, prev?:string, rejected?:boolean, error?:boolean}>}
 */
export async function setPulse(next, opts = {}) {
  try {
    if (next === 'idle' || !PULSE_VALUES.includes(next)) return { changed: false, rejected: true }
    const dirs = opts.dirs || {}
    const identity = opts.identity || {}
    const now = resolveNow(opts.now)
    const nowIso = new Date(now).toISOString()
    const sessionsDir = dirs.sessionsDir
    const terminalId = identity.terminalId
    if (!sessionsDir || !terminalId) return { changed: false }

    const leaseIo = opts.leaseIo || {}
    const readLease = typeof leaseIo.read === 'function' ? leaseIo.read : (f) => readJsonSafe(f)
    const writeLease = typeof leaseIo.write === 'function' ? leaseIo.write : (f, o) => atomicWriteJson(f, o)
    const file = join(sessionsDir, `${terminalId}.json`)

    const lease = readLease(file) || {}
    const prev = PULSE_VALUES.includes(lease.fpStatus) ? lease.fpStatus : 'working'
    const changed = prev !== next

    if (changed) {
      lease.fpStatus = next // the EXISTING attention axis on the lease (no parallel store)
      lease.pulseSince = nowIso
      try {
        writeLease(file, lease)
      } catch {
        /* fail-open — a lease-write failure never blocks the caller */
      }
    }

    // Edge-trigger: ONLY a real transition INTO waiting-for-human fires the webhook.
    if (changed && next === 'waiting-for-human') {
      try {
        await firePulseWebhook(
          { terminalId, workLabel: leaseLabel(lease), repoRoot: dirs.repoRoot },
          { dirs, fetchImpl: opts.fetchImpl, now, env: opts.env, identity, sessionToken: opts.sessionToken },
        )
      } catch {
        /* swallow — the webhook can never wedge setPulse (fail-open) */
      }
    }

    return { changed, prev }
  } catch {
    return { changed: false, error: true }
  }
}

/**
 * firePulseWebhook(ctx, opts) — the single edge-triggered outbound POST. Resolves the
 * URL (kill-switch first, then the test-6 order); cooldown-dedups against last-webhook.json;
 * builds the body by EXPLICIT PICK of ALLOWED_WEBHOOK_KEYS only; POSTs with an AbortController
 * timeout; IGNORES the response object beyond res.ok for the {delivered} boolean (never reads
 * the body); journals webhook-sent / webhook-error. No URL -> zero fetch calls. Never throws.
 *
 * @param {{terminalId?:string, workLabel?:string, repoRoot?:string}} ctx
 * @param {{dirs?:object, fetchImpl?:Function, now?:number|Function, env?:object, identity?:object, sessionToken?:string|null}} [opts]
 * @returns {Promise<{delivered:boolean, reason?:string}>}
 */
export async function firePulseWebhook(ctx = {}, opts = {}) {
  const env = opts.env || process.env
  // Hard kill-switch FIRST — before any URL resolution or fs touch.
  if (isOn(env.SMA_NOTIFY_DISABLE)) return { delivered: false, reason: 'disabled' }

  const dirs = opts.dirs || {}
  const url = resolveWebhookUrl({ dirs, env })
  if (!url) return { delivered: false, reason: 'no-url' } // OFF BY DEFAULT — no call ever

  const now = resolveNow(opts.now)
  const lastFile = dirs.statuslineDir ? join(dirs.statuslineDir, 'last-webhook.json') : null

  // Cooldown dedup — flapping into waiting-for-human inside the window fires once.
  if (lastFile) {
    const last = readJsonSafe(lastFile)
    if (last && Number.isFinite(last.firedAt) && now - last.firedAt < WEBHOOK_COOLDOWN_MS) {
      return { delivered: false, reason: 'cooldown' }
    }
  }

  // EXPLICIT-PICK payload — event-only facts. A ctx carrying hostile extras (message,
  // diff, transcriptPath, env) yields a body WITHOUT them because they are never picked.
  const built = {
    event: 'waiting-for-human',
    terminalId: typeof ctx.terminalId === 'string' ? ctx.terminalId : '',
    workLabel: typeof ctx.workLabel === 'string' ? ctx.workLabel.slice(0, 120) : '',
    repo: repoBasename(ctx.repoRoot),
    ts: new Date(now).toISOString(),
    smaVersion: resolveSmaVersion(),
  }
  const payload = {}
  for (const k of ALLOWED_WEBHOOK_KEYS) payload[k] = built[k] // named picks only

  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch
  if (typeof fetchImpl !== 'function') return { delivered: false, reason: 'no-fetch' }

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS) : null
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    })
    if (timer) clearTimeout(timer)
    // NO REMOTE CONTROL — read res.ok/status ONLY; the body is never touched.
    const ok = !!(res && (res.ok === true || (typeof res.status === 'number' && res.status >= 200 && res.status < 300)))
    if (ok && lastFile) {
      try {
        atomicWriteJson(lastFile, { firedAt: now, terminalId: payload.terminalId })
      } catch {
        /* fail-open — a missed cooldown marker only risks one extra POST next window */
      }
    }
    await journalNotify(opts, 'webhook-sent', { event: payload.event })
    return { delivered: ok }
  } catch (err) {
    if (timer) clearTimeout(timer)
    await journalNotify(opts, 'webhook-error', { error: String((err && err.message) || err).slice(0, 200) })
    return { delivered: false, reason: 'error' }
  }
}

/**
 * resolveWebhookUrl(opts) — the URL resolution ORDER (test 6): env SMA_WEBHOOK_URL wins;
 * else dirs.statuslineDir/webhook.json {url}; else the 9.3-01 profile's
 * notifications.webhookUrl (tolerant — absent profile is fine). Only http(s) URLs are
 * accepted; anything else resolves to null. Never throws.
 * @param {{env?:object, dirs?:object}} [opts]
 * @returns {string|null}
 */
export function resolveWebhookUrl(opts = {}) {
  try {
    const env = opts.env || process.env
    const dirs = opts.dirs || {}
    const candidates = []

    if (env && typeof env.SMA_WEBHOOK_URL === 'string') candidates.push(env.SMA_WEBHOOK_URL)

    if (dirs.statuslineDir) {
      const w = readJsonSafe(join(dirs.statuslineDir, 'webhook.json'))
      if (w && typeof w.url === 'string') candidates.push(w.url)
    }

    if (dirs.smaRoot) {
      const profile = readJsonSafe(join(dirs.smaRoot, 'profile.json'))
      const fromProfile = profile && profile.notifications && typeof profile.notifications.webhookUrl === 'string'
        ? profile.notifications.webhookUrl
        : null
      if (fromProfile) candidates.push(fromProfile)
    }

    for (const c of candidates) {
      if (isHttpUrl(c)) return String(c).trim()
    }
    return null
  } catch {
    return null
  }
}

/**
 * derivePulse(lease, opts) — PURE staleness math. A lease whose renewTime is older than
 * PULSE_IDLE_AFTER_MS derives 'idle' REGARDLESS of the written fpStatus (idle is computed,
 * never stored). A fresh lease keeps its written attention pulse (working / waiting-for-human);
 * a fresh lease with no/invalid fpStatus defaults to working. Never throws.
 * @param {object} lease
 * @param {{now?:number|Function}} [opts]
 * @returns {'working'|'waiting-for-human'|'idle'}
 */
export function derivePulse(lease, opts = {}) {
  try {
    const now = resolveNow(opts.now)
    const renewMs = Date.parse(lease && lease.renewTime)
    const age = Number.isFinite(renewMs) ? now - renewMs : Number.POSITIVE_INFINITY
    if (age >= PULSE_IDLE_AFTER_MS) return 'idle' // derived idle — overrides any written pulse
    const written = lease && PULSE_VALUES.includes(lease.fpStatus) ? lease.fpStatus : 'working'
    return written === 'idle' ? 'working' : written // a stored idle (shouldn't exist) reads working when fresh
  } catch {
    return 'idle'
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * journalNotify(opts, type, detail) — best-effort journal of a webhook-sent / webhook-error
 * event. A webhook-error is deduped ONCE PER SESSION via the reflex seen-store idiom (under a
 * 'notify:' key prefix) so a persistently-down receiver does not spam the journal. Fail-open:
 * any failure is swallowed (the journal is a diagnostic, never a gate).
 */
async function journalNotify(opts = {}, type, detail) {
  try {
    const dirs = opts.dirs || {}
    if (!dirs.journalDir) return
    const identity = opts.identity || {}
    const terminalId = identity.terminalId || 'notify'

    if (type === 'webhook-error' && dirs.reflexDir) {
      try {
        const reflex = await import('./reflex.mjs')
        const seen = reflex.loadSeen({ reflexDir: dirs.reflexDir, terminalId, sessionToken: opts.sessionToken })
        if (!seen.keys || typeof seen.keys !== 'object') seen.keys = {}
        const key = 'notify:webhook-error'
        if (seen.keys[key]) {
          seen.keys[key] += 1
          reflex.saveSeen(seen, { reflexDir: dirs.reflexDir, terminalId })
          return // already journaled this session -> skip the duplicate
        }
        seen.keys[key] = 1
        reflex.saveSeen(seen, { reflexDir: dirs.reflexDir, terminalId })
      } catch {
        /* fall through to a plain append if the seen-store is unavailable */
      }
    }

    const journal = await import('./journal.mjs')
    journal.appendEvent({ type, actors: [terminalId], detail }, { terminalId, journalDir: dirs.journalDir })
  } catch {
    /* fail-open — a journal failure never affects the webhook or the caller */
  }
}

/** The short work label carried on the lease (FI-10), else the fingerprint intent, else ''. */
function leaseLabel(lease) {
  if (!lease || typeof lease !== 'object') return ''
  if (typeof lease.label === 'string' && lease.label.trim() && lease.label.trim() !== 'idle') return lease.label.trim()
  if (typeof lease.intent === 'string' && lease.intent.trim()) return lease.intent.trim()
  return ''
}

/** repo basename ONLY — never the full path (an absolute path can leak the user directory). */
function repoBasename(repoRoot) {
  if (typeof repoRoot !== 'string' || !repoRoot.trim()) return ''
  try {
    return basename(repoRoot.replace(/[\\/]+$/, ''))
  } catch {
    return ''
  }
}

/** now as a number: a function is called, a finite number used verbatim, else Date.now(). */
function resolveNow(now) {
  if (typeof now === 'function') return now()
  return Number.isFinite(now) ? now : Date.now()
}

/** True for an env value set to anything truthy (not ''/0/false). */
function isOn(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return !!s && s !== '0' && s !== 'false'
}

/** Only absolute http(s) URLs are accepted (never file:, never a bare host). */
function isHttpUrl(u) {
  if (typeof u !== 'string' || !u.trim()) return false
  try {
    const parsed = new URL(u.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** The sma engine version (from its package.json) for the payload provenance; 'unknown' on any failure. */
function resolveSmaVersion() {
  try {
    const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'))
    // lib/ -> scripts/sma -> scripts -> repo root; the package.json is at the repo root.
    const pkgPath = join(here, '..', '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}
