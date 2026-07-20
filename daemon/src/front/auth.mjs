/**
 * auth.mjs — timing-safe bearer/cookie auth + a per-remote failure-window rate
 * limiter for the roster front (Phase 9.5 Plan 08, Task 1; D-9.5-05a, T-9.5-24).
 *
 * ═══════════════════════ POSTURE: notify.mjs INVERTED ═════════════════════════════
 * notify.mjs is the sanctioned OUTBOUND-only path: no server, no listener, response
 * never read. This module powers the daemon's FIRST sanctioned INBOUND surface, so it
 * inverts that discipline into an equally-total defensive posture:
 *   - TOKEN ON EVERY ROUTE. Nothing here is reachable without the bearer token the
 *     founder holds — compared with crypto.timingSafeEqual on equal-length buffers so
 *     the comparison leaks no timing oracle (T-9.5-24). A length mismatch returns
 *     false WITHOUT calling timingSafeEqual (which throws on unequal lengths) — never
 *     an exception, never a per-byte early exit.
 *   - QUERY STRING IS NEVER A CREDENTIAL SOURCE. authed() reads the Authorization
 *     header OR the HttpOnly session cookie ONLY. A `?token=` is honoured EXACTLY once,
 *     by the GET / bootstrap in server.mjs, to mint the cookie — never by authed(), so
 *     /api/events rejects a query-string token even when it is correct (T-9.5-34).
 *   - HttpOnly + SameSite=Strict COOKIE. The bootstrap exchange is the only place the
 *     token ever rides a URL; from then on it lives in a cookie JS cannot read.
 *   - FAILURE RATE LIMIT. Repeated auth failures from one remote address trip a 429
 *     (V2) — the limiter holds only ephemeral failure timestamps (transient security
 *     state, the notify.mjs cooldown analog), never task truth.
 *
 * Node built-ins only (node:crypto). clock is dependency-injected so the rate-limit
 * window is deterministic in tests. Zero deps; zero network.
 */

import { timingSafeEqual } from 'node:crypto'

/** The session cookie name (HttpOnly; minted by the GET / ?token= bootstrap). */
export const COOKIE_NAME = 'sma_session'

/**
 * tokenEquals(got, expected) — timing-safe string compare. Returns false (never throws)
 * on a length mismatch or an empty token; only equal-length non-empty buffers reach
 * timingSafeEqual (which requires equal lengths). No per-byte early exit, no oracle.
 *
 * @param {*} got
 * @param {*} expected
 * @returns {boolean}
 */
export function tokenEquals(got, expected) {
  const a = Buffer.from(String(got ?? ''))
  const b = Buffer.from(String(expected ?? ''))
  if (a.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * parseCookies(header) — a permissive Cookie-header parser → { name: value } (values
 * URL-decoded). A malformed segment is skipped, never thrown. Never returns a prototype.
 *
 * @param {string|undefined} header
 * @returns {Record<string,string>}
 */
export function parseCookies(header) {
  const out = Object.create(null)
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (!k) continue
    let v = part.slice(i + 1).trim()
    try {
      v = decodeURIComponent(v)
    } catch {
      /* keep the raw value on a bad %-escape (never throw) */
    }
    out[k] = v
  }
  return out
}

/** bearerToken(req) — the token from `Authorization: Bearer <t>`, or '' when absent. */
export function bearerToken(req) {
  const h = req && req.headers && req.headers.authorization
  if (typeof h !== 'string') return ''
  const m = h.match(/^Bearer\s+(.+)$/)
  return m ? m[1].trim() : ''
}

/** cookieToken(req) — the session-cookie token, or '' when absent. */
export function cookieToken(req) {
  const cookies = parseCookies(req && req.headers && req.headers.cookie)
  return cookies[COOKIE_NAME] || ''
}

/**
 * authed(req, expectedToken) — TRUE iff the request carries the correct token via the
 * Authorization header OR the session cookie (both timing-safe). The query string is
 * NEVER consulted (that is the bootstrap's job alone — T-9.5-34).
 *
 * @param {object} req
 * @param {string} expectedToken
 * @returns {boolean}
 */
export function authed(req, expectedToken) {
  if (!expectedToken) return false // a daemon with no token accepts nobody (fail-closed)
  const bt = bearerToken(req)
  if (bt && tokenEquals(bt, expectedToken)) return true
  const ct = cookieToken(req)
  if (ct && tokenEquals(ct, expectedToken)) return true
  return false
}

/**
 * sessionCookie(token) — the Set-Cookie value minted once on the ?token= bootstrap.
 * HttpOnly (JS cannot read it) + SameSite=Strict (never sent cross-site) + Path=/.
 *
 * @param {string} token
 * @returns {string}
 */
export function sessionCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(String(token ?? ''))}; HttpOnly; SameSite=Strict; Path=/`
}

/**
 * createFailureLimiter({windowMs, maxFailures, clock}) — a per-remote-address auth-
 * failure window (V2, T-9.5-24). record(addr) stamps one failure; isLimited(addr) is
 * true once the failures within the rolling window EXCEED maxFailures (so the
 * (maxFailures+1)-th failure trips it — the 11th at the default 10). Holds only
 * ephemeral timestamps; a restart forgets them (never task truth).
 *
 * @param {{windowMs?:number, maxFailures?:number, clock?:()=>number}} [opts]
 * @returns {{record:(addr:string)=>number, isLimited:(addr:string)=>boolean}}
 */
export function createFailureLimiter({ windowMs = 60000, maxFailures = 10, clock = Date.now } = {}) {
  /** addr -> failure timestamps (ms) within the window */
  const hits = new Map()

  function live(addr, now) {
    const arr = hits.get(addr)
    if (!arr) return []
    const kept = arr.filter((t) => now - t < windowMs)
    if (kept.length) hits.set(addr, kept)
    else hits.delete(addr)
    return kept
  }

  return {
    record(addr) {
      const now = clock()
      const kept = live(addr, now)
      kept.push(now)
      hits.set(addr, kept)
      return kept.length
    },
    isLimited(addr) {
      return live(addr, clock()).length > maxFailures
    },
  }
}
