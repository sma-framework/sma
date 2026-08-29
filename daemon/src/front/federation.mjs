/**
 * federation.mjs — the daemon's FIRST sanctioned OUTBOUND daemon→daemon contour:
 * one machine's view of the others.
 *
 * ═══════════════════ A NEW CLASS OF BEHAVIOUR, DECLARED ══════════════════════════
 * Until this file, the daemon held exactly ONE outbound path — notify.mjs, which posts
 * and never reads the answer — and exactly one inbound surface (the front). This module
 * opens a THIRD kind: an outbound call whose RESPONSE IS CONSUMED. That is a genuine new
 * trust edge, so it carries its laws in the open, the way auth.mjs and notify.mjs do:
 *
 *   1. THE TOKEN LIVES IN THE OUTGOING HEADER AND NOWHERE ELSE. It is never
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
 *   3. THE OFFLINE SNAPSHOT IS A DOCUMENTED EXCEPTION TO «DERIVE, NEVER STORE».
 *      state.mjs stores nothing; here the hub keeps each peer's LAST
 *      successful /api/state response IN PROCESS MEMORY so an unreachable machine's work
 *      stays visible instead of vanishing mid-night. The exception is bounded three ways:
 *      it is in memory only (never on disk — the disk must not become a second source of
 *      truth), it is always age-labelled (`lastSeenSec` next to `online:false`), and a hub
 *      restart honestly loses it (peers are re-polled within one tick).
 *
 *   4. THE HUB NEVER RE-PLAYS A PEER'S LOGIC. proxyAction re-issues the SAME
 *      request against the peer's own handler with the peer's token and relays the peer's
 *      status and body VERBATIM. CAS races, merge gates and validation stay where the task
 *      actually lives. The proxyable paths are a FROZEN set of three — proxying an
 *      arbitrary path is structurally impossible, not merely discouraged.
 *
 * ═══════════════════ PROTOCOL: POLL, OVER THE EXISTING FRONT ═════════════════════
 * The hub polls each peer's ORDINARY `GET /api/state` on the same 2-5s rhythm the SPA
 * already uses. There is no persistent socket between daemons in V5.1 (no reconnect and
 * no backpressure failure modes to own) and the peer grows NO federated door — its
 * attack surface is the same route table it had before. Push aggregation is recorded as
 * a possible V5.2 improvement, not a V5.1 requirement.
 *
 * ═══════════════════ SSRF GUARD, AND THE ONE ESCAPE HATCH ════════════════════════
 * A peer url is validated ONCE, at construction: http(s) only, and loopback / link-local
 * hosts are refused — a peer registry is written by a human through the pairing wizard, so
 * a same-host or metadata-service address in it means something is wrong. PRIVATE MESH
 * addresses (10/8, 172.16/12, 192.168/16, and a VPN's own range) are the SANCTIONED
 * deployment and pass. The single escape hatch is `federation.allowLoopbackPeers: true`,
 * which exists for the two-daemons-on-one-machine verification run and is
 * documented as such: a production federation runs over a private mesh, and a bare daemon
 * port exposed to the internet is forbidden.
 *
 * ═══════════════════ WHAT THIS MODULE DELIBERATELY DOES NOT MERGE ════════════════
 * The project REGISTRY stays the hub's own. A peer's rows arrive carrying their project id
 * as a label (rows already carry `project` from 9.7-02), but a foreign registry is not
 * spliced into `projects[]` — how a foreign project reads on screen is the «Машины и
 * проекты» screen's decision, and inventing it here would freeze it wrong.
 * Federation is COMPUTER-TO-COMPUTER only: no phone is part of this contour.
 *
 * ═══════════════════ INTRODUCTION: THE WIZARD PREPARES, THE HUMAN APPLIES ════════
 * A peer registry entry carries the PEER'S OWN DAEMON TOKEN — the one moment a token
 * leaves the machine that minted it. The pairing book below is what
 * makes that moment safe, and it is deliberately small:
 *
 *   - The hub mints a ONE-SHOT invitation (32 bytes of crypto randomness) with a TTL and
 *     hands back a SENTENCE for a person to carry — never a command it runs itself. The
 *     daemon opens no socket to the second machine, configures no network and executes
 *     nothing: the human types the command on the other machine, so the mesh stays the
 *     human's own deliberate act.
 *   - The invitation is BURNED ON CONSUME whether or not it was still alive, so a replay
 *     can never find it live a moment later. An expired token and a token that never
 *     existed are refused with the SAME message: no caller may map which ever existed.
 *   - The compare walks the WHOLE book through auth.mjs's `tokenEquals` — a `Map.get`
 *     would answer in a length-dependent time and hand out a prefix oracle for free.
 *   - The book lives in PROCESS MEMORY with no disk behind it, so a hub restart honestly
 *     invalidates every unused invitation. That is the safe default, not an omission.
 *
 * Node built-ins only (URL, fetch, AbortSignal, crypto). fetchImpl and clock are
 * dependency-injected, so the unit suite opens no socket and the live two-daemon suite
 * opens real ones. Zero new deps.
 */

import { randomBytes } from 'node:crypto'

import { tokenEquals } from './auth.mjs'

/** The ONLY paths a hub may re-issue on a peer's behalf. Frozen on purpose. */
export const PROXYABLE_PATHS = Object.freeze(new Set(['/api/approve', '/api/return', '/api/enqueue']))

/** Poll budget for one peer's /api/state — a slow peer must not stall the founder's poll. */
export const POLL_TIMEOUT_MS = 4000

/** Proxy budget — an approve runs a real merge on the peer, so it gets a longer rope. */
export const PROXY_TIMEOUT_MS = 20000

/** Named error: a peer url that the SSRF guard refuses. */
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

/** Named error: a path outside the frozen proxy list. */
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

/**
 * Named error: an invitation that is unknown, already used or expired. The
 * MESSAGE is a constant — `reason` exists for the daemon's own reading and is never put
 * on the wire, because «expired» versus «never existed» is exactly the difference an
 * attacker would use to map which invitations were ever minted.
 */
export class PairingTokenError extends Error {
  constructor(reason) {
    super(PAIRING_REFUSED)
    this.name = 'PairingTokenError'
    this.reason = reason
  }
}

// ── the pairing book ────────────────────────────────────────────────

/** How long an unused invitation lives. Long enough to walk to the other machine. */
export const PAIRING_TTL_MS = 15 * 60 * 1000

/** The invitation's width — the same 32 bytes the front token itself is minted from. */
const PAIRING_TOKEN_BYTES = 32

/** The ONE refusal sentence every failed consume produces (no oracle, ever). */
const PAIRING_REFUSED = 'the pairing invitation is unknown, already used or expired'

/** A book is a Map token→expiresAt. Anything else is a wiring mistake, not a request. */
function assertBook(book) {
  if (!(book instanceof Map)) throw new TypeError('a pairing book (Map) is required')
}

/**
 * generatePairingToken({book, clock, ttlMs}) → {token, expiresAt}. Mints ONE invitation
 * into the given book and sweeps the ones that have aged out on the way past, so a hub
 * that pairs occasionally never accumulates dead entries.
 *
 * @param {{book:Map, clock?:()=>number, ttlMs?:number}} args
 * @returns {{token:string, expiresAt:number}}
 */
export function generatePairingToken({ book, clock = Date.now, ttlMs = PAIRING_TTL_MS } = {}) {
  assertBook(book)
  const now = clock()
  for (const [t, exp] of book) if (exp <= now) book.delete(t)
  const token = randomBytes(PAIRING_TOKEN_BYTES).toString('hex')
  const expiresAt = now + ttlMs
  book.set(token, expiresAt)
  return { token, expiresAt }
}

/**
 * consumePairingToken(token, {book, clock}) → {expiresAt}, or throws PairingTokenError.
 *
 * ONE SHOT: a match is DELETED before its liveness is judged, so an expired invitation is
 * gone the moment it is presented rather than sitting there for the next attempt. The scan
 * walks every entry with `tokenEquals` and takes NO early exit — the work done is the same
 * whether the first byte matched or none did.
 *
 * @param {string} token
 * @param {{book:Map, clock?:()=>number}} args
 * @returns {{expiresAt:number}}
 * @throws {PairingTokenError}
 */
export function consumePairingToken(token, { book, clock = Date.now } = {}) {
  assertBook(book)
  const presented = String(token ?? '')
  let hit = null
  for (const [t] of book) {
    if (tokenEquals(presented, t)) hit = t // no break: the scan is constant in the book size
  }
  if (hit === null) throw new PairingTokenError('unknown')
  const expiresAt = book.get(hit)
  book.delete(hit) // burned on presentation, alive or not
  if (expiresAt <= clock()) throw new PairingTokenError('expired')
  return { expiresAt }
}

/**
 * createPairingBook({clock, ttlMs}) — one PRIVATE book with the two verbs bound to it.
 * Every hub holds its own, so an invitation minted by one process is meaningless to
 * another and a restart honestly forgets what nobody used.
 *
 * @param {{clock?:()=>number, ttlMs?:number}} [opts]
 * @returns {{generatePairingToken:Function, consumePairingToken:Function, size:number}}
 */
export function createPairingBook({ clock = Date.now, ttlMs = PAIRING_TTL_MS } = {}) {
  const book = new Map()
  return {
    generatePairingToken: () => generatePairingToken({ book, clock, ttlMs }),
    consumePairingToken: (token) => consumePairingToken(token, { book, clock }),
    get size() {
      return book.size
    },
  }
}

/**
 * buildPairingInstruction({hubUrl, pairingToken, expiresSec}) — the sentence a human
 * carries to the second machine.
 *
 * IT IS TEXT, NOT A SCRIPT. The daemon never executes it and never sends it anywhere: the
 * founder reads it, walks to the other machine and types it. Everything secret in it is a
 * PLACEHOLDER except the invitation itself — the hub's own token is NAMED so the reader
 * knows what to paste, and never carried, so this string may safely ride a response.
 *
 * @param {{hubUrl:string, pairingToken:string, expiresSec:number}} args
 * @returns {string}
 */
export function buildPairingInstruction({ hubUrl, pairingToken, expiresSec = PAIRING_TTL_MS / 1000 } = {}) {
  const minutes = Math.max(1, Math.round(Number(expiresSec) / 60))
  const body = JSON.stringify({
    pairingToken,
    machine: {
      id: '<короткое-имя-латиницей>',
      name: '<как называть на экране>',
      url: 'http://<адрес-второй-машины-в-вашей-сети>:7777',
      token: '<токен-демона-второй-машины>',
    },
  })
  return [
    'Знакомство машин делаете Вы — это два шага, и оба на второй машине.',
    '',
    '1) Узнайте её адрес в Вашей частной сети и токен её демона',
    '   (файл ~/.sma-daemon/config.json, поле token).',
    '',
    '2) Выполните там одну команду — она представит вторую машину этому узлу:',
    '',
    `curl -X POST ${hubUrl}/api/machine/add \\`,
    '  -H "Authorization: Bearer <ТОКЕН ЭТОГО УЗЛА>" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '${body}'`,
    '',
    `Приглашение срабатывает ОДИН раз и живёт ${minutes} минут.`,
    'Машины должны видеть друг друга по частной сети: открытый в интернет порт демона запрещён.',
  ].join('\n')
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
  const pairing = createPairingBook({ clock })

  /** peerId → {state, at} — the LAST successful snapshot (in memory). */
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
      // outgoing header, and a discarded message cannot leak.
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
   * No url and no token appear here, by construction.
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
   * input. The merge FILLS the same payload contract the derive publishes — including the
   * list of rows waiting on a person's word — and never invents a shape of its own, so the
   * SPA types the payload once and reads it the same on a hub as on a lone machine.
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
    for (const key of ['queue', 'awaiting', 'done', 'workers']) {
      out[key] = [...tagSelf(base[key]), ...peers.flatMap((p) => rowsOf(p.id, key))]
    }

    // The cost history is nested one level down, so it is merged by hand rather than by the
    // row loop above. Every point learns which machine spent it — that, and only that, is
    // what lets «Расходы» group by machine when there is more than one. The dollar figures add
    // up for the same reason the counts do: one window, one number, one currency — every
    // machine books the provider's own `total_cost_usd` and nobody converts. The ceiling does
    // NOT add up — it is one household setting, and the hub's copy is the household's.
    const selfCosts = base.costs && typeof base.costs === 'object' ? base.costs : {}
    const selfSeries = Array.isArray(selfCosts.series) ? selfCosts.series : []
    const peerSeries = peers.flatMap((p) => {
      const snap = snapshots.get(p.id)
      const list = snap && snap.state && snap.state.costs && Array.isArray(snap.state.costs.series)
        ? snap.state.costs.series
        : []
      return list.map((pt) => (pt && typeof pt === 'object' ? { ...pt, machine: p.id } : pt))
    })
    const fallback = { ...(selfCosts.apiFallback && typeof selfCosts.apiFallback === 'object' ? selfCosts.apiFallback : {}) }
    for (const p of peers) {
      const snap = snapshots.get(p.id)
      const peerFallback =
        snap && snap.state && snap.state.costs && typeof snap.state.costs.apiFallback === 'object'
          ? snap.state.costs.apiFallback
          : null
      if (!peerFallback) continue
      for (const key of ['todayUsd', 'monthUsd']) {
        const add = Number(peerFallback[key])
        if (Number.isFinite(add)) fallback[key] = Math.round(((Number(fallback[key]) || 0) + add) * 100) / 100
      }
    }
    out.costs = {
      ...selfCosts,
      series: [...selfSeries.map((pt) => (pt && typeof pt === 'object' ? { machine: selfId, ...pt } : pt)), ...peerSeries],
      apiFallback: fallback,
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
      const spend = Number(peerKpis.spentTodayUsd)
      if (Number.isFinite(spend)) {
        kpis.spentTodayUsd = Math.round(((Number(kpis.spentTodayUsd) || 0) + spend) * 100) / 100
      }
    }
    out.kpis = kpis
    return out
  }

  /**
   * proxyAction({machineId, method, path, body}) — re-issue ONE already-validated founder
   * action against the peer that owns the task, with THAT peer's token, and relay the
   * peer's status and body verbatim. The hub adds no logic: the peer's own
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

  /**
   * validatePeerUrl(entry) — run the SSRF guard on a CANDIDATE without touching the live
   * registry. The join door calls this BEFORE it writes anything, so a loopback or
   * metadata address never reaches disk.
   *
   * @param {object} entry a {id, url, token} candidate
   * @throws {InvalidPeerUrlError}
   */
  function validatePeerUrl(entry) {
    normalizePeer(entry, { allowLoopback })
  }

  /**
   * registerPeer(entry) — take a freshly-joined machine into the LIVE registry, so the
   * founder can address an action to it immediately instead of after a restart. The same
   * normalization the boot path uses runs here — a peer that arrived through the door is
   * held to exactly the constraints a peer written by hand is.
   *
   * @param {object} entry {id, name|title, url, token}
   * @returns {object} the normalized live entry (never carrying the token outward)
   * @throws {InvalidPeerUrlError}
   */
  function registerPeer(entry) {
    const peer = normalizePeer(entry, { allowLoopback })
    const at = peers.findIndex((p) => p.id === peer.id)
    if (at === -1) peers.push(peer)
    else peers[at] = peer
    byId.set(peer.id, peer)
    return { id: peer.id, title: peer.title }
  }

  /** removePeer(id) — drop a machine from the LIVE registry (and forget its snapshot). */
  function removePeer(id) {
    const key = String(id ?? '')
    const at = peers.findIndex((p) => p.id === key)
    if (at === -1) return false
    peers.splice(at, 1)
    byId.delete(key)
    snapshots.delete(key)
    online.delete(key)
    lastFailure.delete(key)
    return true
  }

  return {
    pollPeers,
    aggregateState,
    proxyAction,
    peerStatus,
    validatePeerUrl,
    registerPeer,
    removePeer,
    generatePairingToken: pairing.generatePairingToken,
    consumePairingToken: pairing.consumePairingToken,
    // a GETTER, not a snapshot: a machine that joined a minute ago is addressable now
    get peerIds() {
      return peers.map((p) => p.id)
    },
  }
}
