/**
 * federation.mjs — the daemon's FIRST sanctioned OUTBOUND daemon→daemon contour
 * (Plan 9.7-13; D-9.7-01 / D-9.7-03 / D-9.7-04 / D-9.7-07).
 *
 * ═══════════════════ A NEW CLASS OF BEHAVIOUR, DECLARED ══════════════════════════
 * Until this file, the daemon held exactly ONE outbound path — notify.mjs, which posts
 * and never reads the answer — and exactly one inbound surface (the front). This module
 * opens a THIRD kind: an outbound call whose RESPONSE IS CONSUMED. That is a genuine new
 * trust edge, so it carries its laws in the open, the way auth.mjs and notify.mjs do:
 *
 *   1. THE TOKEN LIVES IN THE OUTGOING HEADER AND NOWHERE ELSE (T-9.7-31). It is never
 *      put in a url, never in a status object, never in an event frame, and never in an
 *      error message — transport errors are reduced to a fixed CODE (`unreachable` /
 *      `http_status` / `bad_payload`) before anything is stored, so there is no string
 *      path along which a token or a peer url could reach a payload even if the runtime
 *      handed us a hostile message. The peer side compares with the EXISTING
 *      auth.mjs `tokenEquals`/Bearer door — no new comparator is introduced anywhere.
 *
 *   2. AGGREGATION IS FAIL-OPEN (the backlog-scan.mjs posture). A peer that is down, slow,
 *      unauthorized or answering garbage NEVER breaks the founder's own view: pollPeers
 *      resolves always, and the hub's own rows are rendered regardless.
 *
 *   3. THE OFFLINE SNAPSHOT IS A DOCUMENTED EXCEPTION TO «DERIVE, NEVER STORE»
 *      (T-9.7-34). state.mjs stores nothing; here the hub keeps each peer's LAST
 *      successful /api/state response IN PROCESS MEMORY so an unreachable machine's work
 *      stays visible instead of vanishing mid-night. The exception is bounded three ways:
 *      it is in memory only (never on disk — the disk must not become a second source of
 *      truth), it is always age-labelled (`lastSeenSec` next to `online:false`), and a hub
 *      restart honestly loses it (peers are re-polled within one tick).
 *
 *   4. THE HUB NEVER RE-PLAYS A PEER'S LOGIC (D-9.7-07). proxyAction re-issues the SAME
 *      request against the peer's own handler with the peer's token and relays the peer's
 *      status and body VERBATIM. CAS races, merge gates and validation stay where the task
 *      actually lives. The proxyable paths are a FROZEN set of three — proxying an
 *      arbitrary path is structurally impossible, not merely discouraged (T-9.7-33).
 *
 * ═══════════════════ PROTOCOL: POLL, OVER THE EXISTING FRONT ═════════════════════
 * The hub polls each peer's ORDINARY `GET /api/state` on the same 2-5s rhythm the SPA
 * already uses. There is no persistent socket between daemons in V5.1 (no reconnect and
 * no backpressure failure modes to own) and the peer grows NO federated door — its
 * attack surface is the same thirty routes it had before. Push aggregation is recorded as
 * a possible V5.2 improvement, not a V5.1 requirement.
 *
 * ═══════════════════ SSRF GUARD, AND THE ONE ESCAPE HATCH (T-9.7-32) ═════════════
 * A peer url is validated ONCE, at construction: http(s) only, and loopback / link-local
 * hosts are refused — a peer registry is written by a human through the pairing wizard, so
 * a same-host or metadata-service address in it means something is wrong. PRIVATE MESH
 * addresses (10/8, 172.16/12, 192.168/16, and a VPN's own range) are the SANCTIONED
 * deployment and pass. The single escape hatch is `federation.allowLoopbackPeers: true`,
 * which exists for the D-9.7-03 two-daemons-on-one-machine verification run and is
 * documented as such: a production federation runs over a private mesh, and a bare daemon
 * port exposed to the internet is forbidden.
 *
 * ═══════════════════ WHAT THIS MODULE DELIBERATELY DOES NOT MERGE ════════════════
 * The project REGISTRY stays the hub's own. A peer's rows arrive carrying their project id
 * as a label (rows already carry `project` from 9.7-02), but a foreign registry is not
 * spliced into `projects[]` — how a foreign project reads on screen is the «Машины и
 * проекты» screen's decision (plan 9.7-18), and inventing it here would freeze it wrong.
 * Federation is COMPUTER-TO-COMPUTER only (D-9.7-02): no phone is part of this contour.
 *
 * Node built-ins only (URL, fetch, AbortSignal). fetchImpl and clock are dependency-
 * injected, so the unit suite opens no socket and the live two-daemon suite opens real
 * ones. Zero new deps.
 */

/** The ONLY paths a hub may re-issue on a peer's behalf (T-9.7-33). Frozen on purpose. */
export const PROXYABLE_PATHS = Object.freeze(new Set(['/api/approve', '/api/return', '/api/enqueue']))

/** Poll budget for one peer's /api/state — a slow peer must not stall the founder's poll. */
export const POLL_TIMEOUT_MS = 4000

/** Proxy budget — an approve runs a real merge on the peer, so it gets a longer rope. */
export const PROXY_TIMEOUT_MS = 20000

/** Named error: a peer url that the SSRF guard refuses (T-9.7-32). */
export class InvalidPeerUrlError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvalidPeerUrlError'
  }
}

/** Named error: an action addressed to a machine id that is not in the registry. */
export class UnknownPeerError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnknownPeerError'
  }
}

/** Named error: a path outside the frozen proxy list (T-9.7-33). */
export class ProxyPathNotAllowedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProxyPathNotAllowedError'
  }
}

/** Named error: the peer could not be reached / timed out. Carries a 502-shaped status. */
export class PeerUnreachableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PeerUnreachableError'
    this.status = 502
  }
}

/** Failure CODES — the only failure information that is ever retained (never a message). */
const FAIL_UNREACHABLE = 'unreachable'
const FAIL_HTTP_STATUS = 'http_status'
const FAIL_BAD_PAYLOAD = 'bad_payload'

/** The kpi counters that are additive across a federation (everything else stays local). */
const SUMMABLE_KPIS = Object.freeze(['workersBusy', 'workersTotal', 'queued', 'awaitingApproval', 'windowsOpen'])

/**
 * isLocalOrLinkLocal(hostname) — TRUE for the host families a peer registry must never
 * contain: loopback (127/8, ::1, localhost), the unspecified address, and link-local
 * (169.254/16 — which includes the cloud metadata service — and fe80::/10). PRIVATE MESH
 * ranges are intentionally NOT here: they are the sanctioned deployment.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isLocalOrLinkLocal(hostname) {
  const h = String(hostname ?? '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (h === '' || h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  if (h.startsWith('fe80:') || h.startsWith('fe80::')) return true
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 127) return true // loopback
    if (a === 0) return true // "this host on this network"
    if (a === 169 && b === 254) return true // link-local incl. the metadata service
  }
  return false
}

/**
 * normalizePeer(peer, {allowLoopback}) — validate ONE registry entry and freeze the shape
 * this module works with. Throws InvalidPeerUrlError (never a bare Error) so a caller can
 * tell a configuration refusal from a transport failure.
 */
function normalizePeer(peer, { allowLoopback }) {
  const id = peer && peer.id ? String(peer.id) : ''
  if (!id) throw new InvalidPeerUrlError('a federation peer entry needs an id')
  let u
  try {
    u = new URL(String(peer.url))
  } catch {
    throw new InvalidPeerUrlError(`peer "${id}" has an unparseable url`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new InvalidPeerUrlError(`peer "${id}" url must be http(s), got "${u.protocol}"`)
  }
  if (!allowLoopback && isLocalOrLinkLocal(u.hostname)) {
    throw new InvalidPeerUrlError(
      `peer "${id}" url points at a loopback or link-local address; a federation runs over a private mesh. ` +
        'Set federation.allowLoopbackPeers only for the same-host verification run.',
    )
  }
  if (typeof peer.token !== 'string' || peer.token === '') {
    throw new InvalidPeerUrlError(`peer "${id}" requires a non-empty token`)
  }
  // origin + pathname keeps any base path a reverse proxy adds, without a trailing slash.
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  return { id, title: peer.title || peer.name || id, base, token: peer.token }
}

/** A timeout signal when the runtime offers one; undefined otherwise (never a throw). */
function timeoutSignal(ms) {
  try {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(ms)
      : undefined
  } catch {
    return undefined
  }
}

/** Parse a body verbatim: JSON when it parses, the raw text when it does not. */
function parseBody(text) {
  if (typeof text !== 'string' || text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * createFederation({config, fetchImpl, clock}) — the federation engine for a hub daemon.
 * Every collaborator is injected; constructing it opens no socket and starts no timer (the
 * poll rhythm belongs to the caller — the composition root drives it off the state poll).
 *
 * @param {{config?:object, fetchImpl?:Function, clock?:()=>number}} [opts]
 * @returns {{pollPeers:Function, aggregateState:Function, proxyAction:Function, peerStatus:Function, peerIds:string[]}}
 * @throws {InvalidPeerUrlError} on a peer url the SSRF guard refuses (fail-fast at boot)
 */
export function createFederation({ config = {}, fetchImpl, clock = Date.now } = {}) {
  const fed = (config && config.federation) || {}
  const allowLoopback = fed.allowLoopbackPeers === true
  const peers = (Array.isArray(fed.peers) ? fed.peers : []).map((p) => normalizePeer(p, { allowLoopback }))
  const byId = new Map(peers.map((p) => [p.id, p]))
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (...a) => globalThis.fetch(...a)

  /** peerId → {state, at} — the LAST successful snapshot (in memory; T-9.7-34). */
  const snapshots = new Map()
  /** peerId → boolean — reachability as of the most recent poll. */
  const online = new Map()
  /** peerId → one of the FAIL_* codes — never a message, so nothing can leak through it. */
  const lastFailure = new Map()

  /** GET one peer's own /api/state with ITS bearer token. Resolves; never throws outward. */
  async function pollOne(peer) {
    try {
      const r = await doFetch(`${peer.base}/api/state`, {
        method: 'GET',
        headers: { authorization: `Bearer ${peer.token}`, accept: 'application/json' },
        signal: timeoutSignal(POLL_TIMEOUT_MS),
      })
      if (!r || r.ok === false || (typeof r.status === 'number' && (r.status < 200 || r.status >= 300))) {
        online.set(peer.id, false)
        lastFailure.set(peer.id, FAIL_HTTP_STATUS)
        return
      }
      const state = parseBody(await r.text())
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        online.set(peer.id, false)
        lastFailure.set(peer.id, FAIL_BAD_PAYLOAD)
        return
      }
      snapshots.set(peer.id, { state, at: clock() })
      online.set(peer.id, true)
      lastFailure.delete(peer.id)
    } catch {
      // The caught error is DISCARDED, not inspected: a transport message may quote the
      // outgoing header, and a discarded message cannot leak (T-9.7-31).
      online.set(peer.id, false)
      lastFailure.set(peer.id, FAIL_UNREACHABLE)
    }
  }

  /**
   * pollPeers() — refresh every peer once, concurrently. ALWAYS resolves (fail-open, the
   * backlog-scan posture): a peer's failure degrades that machine, never the poll.
   *
   * @returns {Promise<Array<object>>} the peer statuses after the round
   */
  async function pollPeers() {
    await Promise.all(peers.map((p) => pollOne(p)))
    return peerStatus()
  }

  /**
   * peerStatus() — the machines[] entries for the peers, in the FROZEN 9.7-02 shape
   * {id, title, role, online} plus `lastSeenSec`, the age of the snapshot being shown.
   * A peer never yet reached carries NO age — there is no last-seen moment to claim.
   * No url and no token appear here, by construction (T-9.7-31 / T-9.7-05).
   */
  function peerStatus() {
    const now = clock()
    return peers.map((p) => {
      const snap = snapshots.get(p.id)
      return {
        id: p.id,
        title: p.title,
        role: 'peer',
        online: online.get(p.id) === true,
        ...(snap ? { lastSeenSec: Math.max(0, Math.round((now - snap.at) / 1000)) } : {}),
      }
    })
  }

  /** Rows from a peer, re-tagged with the REGISTRY id — the key an action is addressed to. */
  function rowsOf(peerId, key) {
    const snap = snapshots.get(peerId)
    const list = snap && Array.isArray(snap.state[key]) ? snap.state[key] : []
    return list.map((row) => (row && typeof row === 'object' ? { ...row, machine: peerId } : row))
  }

  /**
   * aggregateState(selfState) — a PURE merge of the hub's own derive with the current peer
   * snapshots. It does not poll (the caller owns the rhythm) and it does not mutate its
   * input. The payload KEY SET is unchanged: 9.7-13 fills the 9.7-02 contract, it never
   * redefines it, so the SPA types the shape once.
   *
   * @param {object} selfState the hub's own deriveState payload
   * @returns {object} the same shape, filled with every peer
   */
  function aggregateState(selfState) {
    const base = selfState && typeof selfState === 'object' ? selfState : {}
    const selfMachines = Array.isArray(base.machines) ? base.machines : []
    const selfId = (selfMachines[0] && selfMachines[0].id) || 'self'

    const tagSelf = (rows) =>
      (Array.isArray(rows) ? rows : []).map((r) => (r && typeof r === 'object' ? { machine: selfId, ...r } : r))

    const out = { ...base }
    out.machines = [...selfMachines, ...peerStatus()]
    for (const key of ['queue', 'done', 'workers']) {
      out[key] = [...tagSelf(base[key]), ...peers.flatMap((p) => rowsOf(p.id, key))]
    }

    // kpis add up across the whole federation — the founder's one window counts one number.
    const kpis = { ...(base.kpis && typeof base.kpis === 'object' ? base.kpis : {}) }
    for (const p of peers) {
      const snap = snapshots.get(p.id)
      const peerKpis = snap && snap.state && typeof snap.state.kpis === 'object' ? snap.state.kpis : null
      if (!peerKpis) continue
      for (const key of SUMMABLE_KPIS) {
        const add = Number(peerKpis[key])
        if (Number.isFinite(add)) kpis[key] = (Number(kpis[key]) || 0) + add
      }
      const spend = Number(peerKpis.spentTodayEur)
      if (Number.isFinite(spend)) {
        kpis.spentTodayEur = Math.round(((Number(kpis.spentTodayEur) || 0) + spend) * 100) / 100
      }
    }
    out.kpis = kpis
    return out
  }

  /**
   * proxyAction({machineId, method, path, body}) — re-issue ONE already-validated founder
   * action against the peer that owns the task, with THAT peer's token, and relay the
   * peer's status and body verbatim (D-9.7-07). The hub adds no logic: the peer's own
   * handler runs its own CAS, its own merge gate and its own validation.
   *
   * @param {{machineId:string, method?:string, path:string, body?:object}} o
   * @returns {Promise<{status:number, body:*}>} the peer's answer, unmodified
   * @throws {UnknownPeerError|ProxyPathNotAllowedError|PeerUnreachableError}
   */
  async function proxyAction({ machineId, method = 'POST', path, body } = {}) {
    const peer = byId.get(String(machineId ?? ''))
    if (!peer) throw new UnknownPeerError(`unknown machine "${machineId}"`)
    if (String(method).toUpperCase() !== 'POST') {
      throw new ProxyPathNotAllowedError(`method "${method}" is not proxyable (the three actions are POST-only)`)
    }
    if (!PROXYABLE_PATHS.has(path)) {
      throw new ProxyPathNotAllowedError(`path "${path}" is not in the frozen proxy list`)
    }
    let r
    try {
      r = await doFetch(`${peer.base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${peer.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: timeoutSignal(PROXY_TIMEOUT_MS),
      })
    } catch {
      // Again: the transport error is discarded, not wrapped — only the peer id travels.
      throw new PeerUnreachableError(`machine "${peer.id}" did not answer`)
    }
    const text = typeof r.text === 'function' ? await r.text() : ''
    return { status: Number(r.status) || 0, body: parseBody(text) }
  }

  return { pollPeers, aggregateState, proxyAction, peerStatus, peerIds: peers.map((p) => p.id) }
}
