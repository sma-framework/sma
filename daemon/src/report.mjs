/**
 * report.mjs — the outbound report-back edge (Phase 9.5 Plan 07, Task 1;
 * D-9.5-06, D-9.5-11 item 3; researcher Q3).
 *
 * THE ONE OUTBOUND SEAM FOR TASK EVENTS. Its posture is COPIED VERBATIM from
 * scripts/sma/lib/notify.mjs (the sanctioned waiting-for-human webhook, D-9.3-13) —
 * the same product-side boundary, made total here:
 *   - OUTBOUND EVENTS ONLY. A task lifecycle event fires exactly ONE HTTP POST to a
 *     USER-configured URL. Nothing else ever leaves.
 *   - NO REMOTE CONTROL. The response object is IGNORED by construction — this module
 *     never reads response.body / .json() / .text(). There is no inbound socket, no
 *     listener, no server, no polling loop anywhere in it (the guard greps this posture).
 *   - EXPLICIT-PICK PAYLOAD. The body is assembled by named picks from
 *     ALLOWED_REPORT_KEYS only — event-only facts, never diff hunks, transcripts,
 *     tokens, or task content. A ctx carrying hostile extras yields a body WITHOUT them
 *     because they are simply never picked.
 *   - OFF BY DEFAULT. No configured webhookUrl means NO network call, ever. Silence is
 *     the default posture (config.webhookUrl is '' out of the box — config.mjs).
 *   - FAIL-OPEN. Every failure is swallowed to a journal event + a safe return — a
 *     webhook error can NEVER block the tick (2s AbortController timeout on the POST).
 *
 * Q3 (researcher, planned default pending grill): report-back is a PRODUCT-SIDE
 * configurable webhook seam; the platform Telegram bot is its FIRST consumer. The pilot
 * W1 keeps its own Telegram plumbing (out of this plan) — this module is the generic seam.
 *
 * Node built-ins only (global fetch + AbortController); fetch / clock / journal are all
 * dependency-injected so tests never touch the network. Zero deps.
 */

/**
 * The EXPLICIT payload allowlist — the exact + ONLY key set a report body carries.
 * The ninth key `queuedForHours` is the DELIBERATE D-9.5-11 item-3 expansion carrying
 * the aging signal (event 'task.aging'). EXPANDING THIS LIST IS A DECISION ANCHORED IN A
 * D-число, never a convenience — a new key means a new decision, documented here first.
 */
export const ALLOWED_REPORT_KEYS = Object.freeze([
  'event',
  'taskId',
  'title',
  'lane',
  'receiptVerdict',
  'branch',
  'attempt',
  'ts',
  'queuedForHours',
])

/** Per-POST AbortController timeout — a hung receiver never blocks the tick. */
export const REPORT_TIMEOUT_MS = 2000

/**
 * reportTaskEvent({config, event, fetchImpl, clock, journal}) → {delivered, reason?}.
 * POSTs ONLY the ALLOWED_REPORT_KEYS picked from `event`. No config.webhookUrl → zero
 * fetch calls (OFF BY DEFAULT). The response is never read. Any error is swallowed to a
 * journal event and returned as {delivered:false} — never thrown, never blocking.
 *
 * @param {{
 *   config?:{webhookUrl?:string},
 *   event?:object,
 *   fetchImpl?:Function,
 *   clock?:()=>number,
 *   journal?:(e:object)=>void,
 * }} opts
 * @returns {Promise<{delivered:boolean, reason?:string}>}
 */
export async function reportTaskEvent({ config = {}, event = {}, fetchImpl, clock = Date.now, journal } = {}) {
  const url = typeof config.webhookUrl === 'string' ? config.webhookUrl.trim() : ''
  if (!url || !/^https?:\/\//i.test(url)) return { delivered: false, reason: 'no-url' } // OFF BY DEFAULT

  // EXPLICIT-PICK payload — event-only facts; a default ts from the injected clock.
  const built = { ...event }
  if (built.ts === undefined) built.ts = new Date(clock()).toISOString()
  const payload = {}
  for (const k of ALLOWED_REPORT_KEYS) if (built[k] !== undefined) payload[k] = built[k] // named picks only

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof doFetch !== 'function') return { delivered: false, reason: 'no-fetch' }

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS) : null
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    })
    if (timer) clearTimeout(timer)
    // NO REMOTE CONTROL — read res.ok/status ONLY; the body is never touched.
    const ok = !!(res && (res.ok === true || (typeof res.status === 'number' && res.status >= 200 && res.status < 300)))
    return { delivered: ok, reason: ok ? undefined : 'bad-status' }
  } catch (err) {
    if (timer) clearTimeout(timer)
    if (typeof journal === 'function') {
      try {
        journal({ type: 'report-error', event: payload.event, error: String((err && err.message) || err).slice(0, 200) })
      } catch {
        /* fail-open — a journal failure never affects the tick */
      }
    }
    return { delivered: false, reason: 'error' }
  }
}
