/**
 * Tests for the federation module — the daemon's FIRST outbound daemon→daemon contour
 * (Plan 9.7-13; D-9.7-01 / D-9.7-03 / D-9.7-04 / D-9.7-07).
 *
 * The UNIT groups drive createFederation through an INJECTED fetch, so no socket is
 * opened there: aggregation of two peers, the offline degrade (last snapshot + its age),
 * the url guard at construction, the token-never-serializes law and the frozen proxy list.
 *
 * The LIVE group at the bottom injects NOTHING: two real front servers, two ports, two
 * tokens, the real fetch. That is the D-9.7-03 verification — the contour proved by live
 * processes on this machine before any second computer exists.
 */

import { describe, it, expect, afterEach } from 'vitest'

import { createFrontServer } from '../src/front/server.mjs'
import { deriveState } from '../src/front/state.mjs'
import {
  createFederation,
  InvalidPeerUrlError,
  UnknownPeerError,
  ProxyPathNotAllowedError,
  PeerUnreachableError,
  PROXYABLE_PATHS,
} from '../src/front/federation.mjs'

const TOKEN_A = 'peer-a-secret-value'
const TOKEN_B = 'peer-b-secret-value'
const NOW = 1_700_000_000_000

/** A minimal fetch Response stand-in: text() is what the module reads (verbatim relay). */
function res(status: number, body: any) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  }
}

/** A peer /api/state payload in the 9.7-02 frozen shape (only the fields we merge). */
function peerState(o: { machine: string; title: string; project: string; queueId: string; doneId: string }) {
  return {
    kpis: { workersBusy: 1, workersTotal: 2, queued: 1, awaitingApproval: 1, spentTodayEur: 1.5, windowsOpen: 1 },
    queue: [{ id: o.queueId, title: 'q', status: 'queued', project: o.project, machine: o.machine, position: 1 }],
    awaiting: [
      { id: `${o.queueId}-w`, title: 'w', status: 'awaiting_approval', project: o.project, machine: o.machine, position: 1 },
    ],
    workers: [{ id: 'max-1', lane: 'prod', presence: 'работает', account: 'max-1', window: { pct5h: 1, pctWeek: 2, estimated: true } }],
    done: [{ id: o.doneId, title: 'd', project: o.project, machine: o.machine, commits: [] }],
    machines: [{ id: o.machine, title: o.title, role: 'self', online: true }],
    projects: [{ id: o.project, name: o.project, taskCounts: { total: 2 } }],
    activeProject: o.project,
    federation: { role: 'peer', hubReachable: true },
    spend: { accounts: [], apiFallback: { capEur: 0 } },
    costs: { series: [], apiFallback: { capEur: 0 } },
  }
}

/** The hub's OWN derive payload (one machine, its own rows). */
function selfState() {
  return {
    kpis: { workersBusy: 0, workersTotal: 1, queued: 2, awaitingApproval: 1, spentTodayEur: 0.5, windowsOpen: 1 },
    queue: [{ id: 'BL-self', title: 's', status: 'queued', project: 'home', machine: 'this-pc', position: 1 }],
    awaiting: [{ id: 'BL-self-w', title: 'sw', status: 'awaiting_approval', project: 'home', position: 1 }],
    workers: [{ id: 'self-1', lane: 'prod', presence: 'свободен', account: 'max-9', window: { pct5h: 0, pctWeek: 0, estimated: true } }],
    done: [],
    machines: [{ id: 'this-pc', title: 'Этот ПК', role: 'self', online: true }],
    projects: [{ id: 'home', name: 'Дом', taskCounts: { total: 2 } }],
    activeProject: 'home',
    federation: { role: 'hub', hubReachable: true },
    spend: { accounts: [], apiFallback: { capEur: 0 } },
    costs: { series: [], apiFallback: { capEur: 0 } },
  }
}

const twoPeerConfig = {
  machineId: 'this-pc',
  machineTitle: 'Этот ПК',
  federation: {
    role: 'hub',
    peers: [
      { id: 'mac-mini', title: 'Mac mini', url: 'http://10.0.0.4:7777', token: TOKEN_A },
      { id: 'studio', title: 'Studio', url: 'http://10.0.0.5:7777/', token: TOKEN_B },
    ],
  },
}

// ── the SSRF guard: a peer url is validated at CONSTRUCTION, never at call time ──

describe('createFederation — the peer-url guard (T-9.7-32)', () => {
  it('refuses a non-http(s) peer url with a named error', () => {
    expect(() =>
      createFederation({
        config: { federation: { role: 'hub', peers: [{ id: 'bad', url: 'file:///etc/passwd', token: TOKEN_A }] } },
        fetchImpl: async () => res(200, {}),
      }),
    ).toThrow(InvalidPeerUrlError)
  })

  it('refuses a loopback / link-local peer url by default', () => {
    for (const url of ['http://127.0.0.1:7777', 'http://localhost:7777', 'http://[::1]:7777', 'http://169.254.169.254/']) {
      expect(() =>
        createFederation({
          config: { federation: { role: 'hub', peers: [{ id: 'loop', url, token: TOKEN_A }] } },
          fetchImpl: async () => res(200, {}),
        }),
      ).toThrow(InvalidPeerUrlError)
    }
  })

  it('accepts a loopback peer ONLY under the explicit same-host verification flag (D-9.7-03)', () => {
    const fed = createFederation({
      config: {
        federation: {
          role: 'hub',
          allowLoopbackPeers: true,
          peers: [{ id: 'loop', url: 'http://127.0.0.1:7777', token: TOKEN_A }],
        },
      },
      fetchImpl: async () => res(200, {}),
    })
    expect(fed.peerStatus().map((m: any) => m.id)).toEqual(['loop'])
  })

  it('accepts a PRIVATE-MESH address — that is the sanctioned deployment', () => {
    const fed = createFederation({ config: twoPeerConfig, fetchImpl: async () => res(200, {}) })
    expect(fed.peerStatus().map((m: any) => m.id)).toEqual(['mac-mini', 'studio'])
  })
})

// ── poll + aggregate ──

describe('createFederation — pollPeers + aggregateState (D-9.7-01)', () => {
  it('polls each peer\'s OWN /api/state with ITS bearer token and aggregates both', async () => {
    const calls: Array<{ url: string; auth: string }> = []
    const fetchImpl = async (url: string, init: any) => {
      calls.push({ url: String(url), auth: init.headers.authorization })
      if (String(url).includes('10.0.0.4')) {
        return res(200, peerState({ machine: 'self', title: 'Mac mini', project: 'shop', queueId: 'BL-A1', doneId: 'BL-A0' }))
      }
      return res(200, peerState({ machine: 'self', title: 'Studio', project: 'lab', queueId: 'BL-B1', doneId: 'BL-B0' }))
    }
    const fed = createFederation({ config: twoPeerConfig, fetchImpl, clock: () => NOW })

    await fed.pollPeers()

    // the transport is the peer's EXISTING front contract — no special federated door
    expect(calls.map((c) => c.url).sort()).toEqual(['http://10.0.0.4:7777/api/state', 'http://10.0.0.5:7777/api/state'])
    expect(calls.find((c) => c.url.includes('10.0.0.4'))!.auth).toBe(`Bearer ${TOKEN_A}`)
    expect(calls.find((c) => c.url.includes('10.0.0.5'))!.auth).toBe(`Bearer ${TOKEN_B}`)

    const agg = fed.aggregateState(selfState())

    // machines = self + every peer, in the 9.7-02 frozen shape (id/title/role/online)
    expect(agg.machines.map((m: any) => [m.id, m.role, m.online])).toEqual([
      ['this-pc', 'self', true],
      ['mac-mini', 'peer', true],
      ['studio', 'peer', true],
    ])
    // rows flow in tagged with the REGISTRY machine id (the key a proxy addresses)
    expect(agg.queue.map((q: any) => [q.id, q.machine])).toEqual([
      ['BL-self', 'this-pc'],
      ['BL-A1', 'mac-mini'],
      ['BL-B1', 'studio'],
    ])
    expect(agg.done.map((d: any) => [d.id, d.machine])).toEqual([
      ['BL-A0', 'mac-mini'],
      ['BL-B0', 'studio'],
    ])
    expect(agg.workers.map((w: any) => w.machine)).toEqual(['this-pc', 'mac-mini', 'studio'])
    // the rows a person still owes a decision to travel the same way the queue does —
    // otherwise the hub would count decisions it cannot show
    expect(agg.awaiting.map((a: any) => [a.id, a.machine])).toEqual([
      ['BL-self-w', 'this-pc'],
      ['BL-A1-w', 'mac-mini'],
      ['BL-B1-w', 'studio'],
    ])
    // counts add up across the whole federation
    expect(agg.kpis.queued).toBe(4) // 2 self + 1 + 1
    expect(agg.kpis.workersTotal).toBe(5)
    expect(agg.kpis.awaitingApproval).toBe(3) // 1 self + 1 + 1 — as many as the list shows
    expect(agg.kpis.awaitingApproval).toBe(agg.awaiting.length)
    // the payload key set is UNCHANGED — 9.7-13 fills the 9.7-02 shape, never redefines it
    expect(Object.keys(agg).sort()).toEqual(Object.keys(selfState()).sort())
  })

  it('an unreachable peer degrades to online:false and KEEPS its last snapshot with an age', async () => {
    let up = true
    const fetchImpl = async () => {
      if (!up) throw new Error(`connect ECONNREFUSED (token was ${TOKEN_A})`) // a hostile message on purpose
      return res(200, peerState({ machine: 'self', title: 'Mac mini', project: 'shop', queueId: 'BL-A1', doneId: 'BL-A0' }))
    }
    let now = NOW
    const fed = createFederation({
      config: { federation: { role: 'hub', peers: [twoPeerConfig.federation.peers[0]] } },
      fetchImpl,
      clock: () => now,
    })

    await fed.pollPeers()
    expect(fed.peerStatus()[0]).toMatchObject({ id: 'mac-mini', online: true, lastSeenSec: 0 })

    up = false
    now = NOW + 42_000
    await expect(fed.pollPeers()).resolves.toBeTruthy() // fail-open: never throws outward

    const status = fed.peerStatus()[0]
    expect(status.online).toBe(false)
    expect(status.lastSeenSec).toBe(42)

    // the LAST successful snapshot is still visible — the documented exception to
    // «derive, never store» (T-9.7-34): in memory, age-labelled, lost on restart
    const agg = fed.aggregateState(selfState())
    expect(agg.queue.map((q: any) => q.id)).toEqual(['BL-self', 'BL-A1'])
    expect(agg.machines[1]).toMatchObject({ id: 'mac-mini', online: false, lastSeenSec: 42 })
  })

  it('a peer that answers non-2xx is offline, and pollPeers still resolves', async () => {
    const fed = createFederation({
      config: { federation: { role: 'hub', peers: [twoPeerConfig.federation.peers[0]] } },
      fetchImpl: async () => res(401, 'unauthorized'),
      clock: () => NOW,
    })
    await fed.pollPeers()
    expect(fed.peerStatus()[0].online).toBe(false)
    expect(fed.peerStatus()[0].lastSeenSec).toBeUndefined() // never seen → no age to claim
  })

  it('a peer with a snapshot but no self-machine entry still aggregates (fail-open shape)', async () => {
    const fed = createFederation({
      config: { federation: { role: 'hub', peers: [twoPeerConfig.federation.peers[0]] } },
      fetchImpl: async () => res(200, { queue: [{ id: 'BL-X', status: 'queued' }] }),
      clock: () => NOW,
    })
    await fed.pollPeers()
    const agg = fed.aggregateState(selfState())
    expect(agg.queue.map((q: any) => q.machine)).toEqual(['this-pc', 'mac-mini'])
  })

  it('a snapshot from an OLDER daemon that has no decisions list contributes nothing to it', async () => {
    const fed = createFederation({
      config: { federation: { role: 'hub', peers: [twoPeerConfig.federation.peers[0]] } },
      fetchImpl: async () => res(200, { queue: [{ id: 'BL-X', status: 'queued' }] }), // no awaiting key
      clock: () => NOW,
    })
    await fed.pollPeers()
    const agg = fed.aggregateState(selfState())
    // fail-open: the merge holds, and the hub still shows its own decision
    expect(agg.awaiting.map((a: any) => [a.id, a.machine])).toEqual([['BL-self-w', 'this-pc']])
  })
})

// ── the cost history: every point learns which machine spent it ──

describe('createFederation — the cost history merges like the rows do', () => {
  const costPoint = (over: object = {}) => ({
    day: '2026-08-01',
    account: 'клод-основной',
    tokensIn: 10,
    tokensOut: 5,
    eur: 0.25,
    ...over,
  })

  async function hubWithCosts() {
    const fetchImpl = async () => {
      const state: any = peerState({ machine: 'self', title: 'Mac mini', project: 'shop', queueId: 'BL-A1', doneId: 'BL-A0' })
      state.costs = {
        series: [costPoint({ account: 'кодекс', eur: 1.5 })],
        apiFallback: { todayEur: 1.5, monthEur: 9, capEur: 0, switchMode: 'api' },
      }
      return res(200, state)
    }
    const fed = createFederation({
      config: { federation: { role: 'hub', peers: [twoPeerConfig.federation.peers[0]] }, machineId: 'this-pc' },
      fetchImpl,
      clock: () => NOW,
    })
    await fed.pollPeers()
    const own: any = selfState()
    own.costs = {
      series: [costPoint()],
      apiFallback: { todayEur: 0.25, monthEur: 4, capEur: 400, switchMode: 'subscription' },
    }
    return fed.aggregateState(own)
  }

  it('tags the hub\'s own points and the peer\'s points with their machines', async () => {
    const agg = await hubWithCosts()
    expect(agg.costs.series.map((p: any) => [p.account, p.machine])).toEqual([
      ['клод-основной', 'this-pc'],
      ['кодекс', 'mac-mini'],
    ])
  })

  it('adds the api-fallback money up, and keeps ONE household ceiling', async () => {
    const agg = await hubWithCosts()
    expect(agg.costs.apiFallback.todayEur).toBe(1.75)
    expect(agg.costs.apiFallback.monthEur).toBe(13)
    expect(agg.costs.apiFallback.capEur).toBe(400) // the hub's setting, never a sum
  })

  it('leaves the payload key set untouched', async () => {
    const agg = await hubWithCosts()
    expect(Object.keys(agg).sort()).toEqual(Object.keys(selfState()).sort())
    expect(Object.keys(agg.costs).sort()).toEqual(['apiFallback', 'series'])
  })
})

// ── T-9.7-31: the peer token never leaves the outgoing header ──

describe('federation — the peer token never serializes (T-9.7-31)', () => {
  it('no status, no aggregate and no error message ever contains a peer token', async () => {
    const fetchImpl = async () => {
      throw new Error(`socket hang up while sending Bearer ${TOKEN_A}`) // worst case
    }
    const fed = createFederation({ config: twoPeerConfig, fetchImpl, clock: () => NOW })
    await fed.pollPeers()

    const serialized = JSON.stringify({ status: fed.peerStatus(), agg: fed.aggregateState(selfState()) })
    expect(serialized).not.toContain(TOKEN_A)
    expect(serialized).not.toContain(TOKEN_B)
    expect(serialized).not.toContain('10.0.0.4') // no peer url leaks into the payload either

    let thrown: any = null
    try {
      await fed.proxyAction({ machineId: 'mac-mini', path: '/api/approve', body: { taskId: 'BL-1' } })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(PeerUnreachableError)
    expect(String(thrown.message)).not.toContain(TOKEN_A)
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain(TOKEN_A)
  })
})

// ── the closed proxy list (T-9.7-33) ──

describe('federation — proxyAction (D-9.7-07)', () => {
  const okState = async () => res(200, { ok: true, taskId: 'BL-1', merged: true })

  it('exposes EXACTLY the three proxyable paths, frozen', () => {
    expect([...PROXYABLE_PATHS].sort()).toEqual(['/api/approve', '/api/enqueue', '/api/return'])
    expect(Object.isFrozen(PROXYABLE_PATHS)).toBe(true)
  })

  it("re-issues the request with the PEER's token and relays its status + body verbatim", async () => {
    const seen: any[] = []
    const fetchImpl = async (url: string, init: any) => {
      seen.push({ url: String(url), method: init.method, auth: init.headers.authorization, body: init.body })
      return res(200, { ok: true, taskId: 'BL-1', merged: true })
    }
    const fed = createFederation({ config: twoPeerConfig, fetchImpl, clock: () => NOW })
    const out = await fed.proxyAction({ machineId: 'mac-mini', path: '/api/approve', body: { taskId: 'BL-1' } })

    expect(seen[0].url).toBe('http://10.0.0.4:7777/api/approve')
    expect(seen[0].method).toBe('POST')
    expect(seen[0].auth).toBe(`Bearer ${TOKEN_A}`)
    expect(JSON.parse(seen[0].body)).toEqual({ taskId: 'BL-1' })
    expect(out).toEqual({ status: 200, body: { ok: true, taskId: 'BL-1', merged: true } })
  })

  it("relays a peer REFUSAL verbatim — the hub never re-plays the peer's CAS logic", async () => {
    const fed = createFederation({
      config: twoPeerConfig,
      fetchImpl: async () => res(409, { error: 'approve race lost (already handled)' }),
      clock: () => NOW,
    })
    const out = await fed.proxyAction({ machineId: 'mac-mini', path: '/api/approve', body: { taskId: 'BL-1' } })
    expect(out.status).toBe(409)
    expect(out.body).toEqual({ error: 'approve race lost (already handled)' })
  })

  it('refuses an unknown machine with a named error', async () => {
    const fed = createFederation({ config: twoPeerConfig, fetchImpl: okState, clock: () => NOW })
    await expect(fed.proxyAction({ machineId: 'ghost', path: '/api/approve', body: {} })).rejects.toThrow(UnknownPeerError)
  })

  it('refuses ANY path outside the frozen list — arbitrary proxying is structurally impossible', async () => {
    const fed = createFederation({ config: twoPeerConfig, fetchImpl: okState, clock: () => NOW })
    for (const path of ['/api/state', '/api/mcp/toggle', '/api/approve/../state', '/', '/api/agent/toggle']) {
      await expect(fed.proxyAction({ machineId: 'mac-mini', path, body: {} })).rejects.toThrow(ProxyPathNotAllowedError)
    }
  })

  it('refuses a non-POST method (the three actions are POST-only)', async () => {
    const fed = createFederation({ config: twoPeerConfig, fetchImpl: okState, clock: () => NOW })
    await expect(fed.proxyAction({ machineId: 'mac-mini', method: 'GET', path: '/api/approve', body: {} })).rejects.toThrow(
      ProxyPathNotAllowedError,
    )
  })

  it('turns a peer timeout into a named 502-shaped error, never a raw transport throw', async () => {
    const fed = createFederation({
      config: twoPeerConfig,
      fetchImpl: async () => {
        throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
      },
      clock: () => NOW,
    })
    const err: any = await fed.proxyAction({ machineId: 'mac-mini', path: '/api/return', body: {} }).catch((e) => e)
    expect(err).toBeInstanceOf(PeerUnreachableError)
    expect(err.status).toBe(502)
  })
})

// ════════════════ THE LIVE TWO-DAEMON CONTOUR (D-9.7-03) ═══════════════════════════
//
// Everything above proves the module's SHAPE against a fake. This group proves the
// CONTOUR: two real front servers on two ephemeral ports, two different configs, two
// different tokens, and the REAL global fetch between them — no fetchImpl is injected
// anywhere below. The known trap is a federation that works only on paper, so the wire is
// what is under test: real sockets, real bearer auth on the peer side, a real connection
// refusal for the offline case. The founder's own poll goes through the hub's real
// GET /api/state, so the aggregator seam is exercised end to end and not just in isolation.
//
// Running this on ONE machine is the whole point: it is the cheap honest verification that
// lands before any second computer is bought. Repeating it on real hardware is a separate
// smoke, not a substitute for this one.

const HUB_TOKEN = 'hub-live-token-value'
const PEER_TOKEN = 'peer-live-token-value'

/** Listen on an ephemeral loopback port; resolve the port actually bound. */
function listenEphemeral(server: any): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

/** Close a live server AND its keep-alive sockets, so the next fetch is refused at once. */
function closeServer(server: any): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    server.close(() => resolve())
  })
}

describe('federation — TWO LIVE DAEMONS on this machine (D-9.7-03)', () => {
  const teardown: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (teardown.length) await teardown.pop()!()
  })

  /** Build the peer daemon: its own token, its own machine id, its own rows. */
  async function startPeer() {
    const rows = [
      { id: 'BL-P1', status: 'queued', lane: 'prod', title: 'работа пира', priority: 0, enqueuedAt: NOW - 1000 },
      { id: 'BL-P9', status: 'awaiting_approval', lane: 'prod', title: 'ждёт приёмки', priority: 0 },
    ]
    const front = createFrontServer({
      config: {
        token: PEER_TOKEN,
        bind: '127.0.0.1',
        machineId: 'peer-self',
        machineTitle: 'Ноутбук',
        projects: [{ id: 'shop', name: 'Магазин' }],
        activeProject: 'shop',
        workers: [{ id: 'p-1', lane: 'prod', account: { name: 'p-1' } }],
      },
      deps: {
        clock: () => NOW,
        adapter: { list: async () => rows.slice() },
        deriveState,
        // the peer owns its OWN approve logic — the hub must never re-play it
        casExec: async () => ({ rows: [{ id: 'BL-P9' }] }),
        verbRunner: async () => ({ merged: true, receipt: { testsPassed: 3, testsTotal: 3 } }),
        repoDir: '/peer-repo',
      },
    })
    /** Every request the peer actually received, with the bearer it actually carried. */
    const seen: Array<{ url: string; auth: string | undefined }> = []
    front.server.on('request', (req: any) => seen.push({ url: req.url, auth: req.headers.authorization }))
    const port = await listenEphemeral(front.server)
    teardown.push(() => closeServer(front.server))
    return { front, port, seen }
  }

  /** Build the hub daemon around a live peer registry entry + the REAL fetch. */
  async function startHub(peerPort: number, clock: () => number, token = PEER_TOKEN) {
    const federation = createFederation({
      config: {
        federation: {
          role: 'hub',
          // the ONE sanctioned use of the escape hatch: same-host verification
          allowLoopbackPeers: true,
          peers: [{ id: 'peer-1', title: 'Ноутбук', url: `http://127.0.0.1:${peerPort}`, token }],
        },
      },
      clock,
    })
    const rows = [{ id: 'BL-H1', status: 'queued', lane: 'prod', title: 'работа хаба', priority: 0, enqueuedAt: NOW - 500 }]
    const front = createFrontServer({
      config: {
        token: HUB_TOKEN,
        bind: '127.0.0.1',
        machineId: 'this-pc',
        machineTitle: 'Этот ПК',
        projects: [{ id: 'home', name: 'Дом' }],
        activeProject: 'home',
        federation: { role: 'hub' },
        workers: [],
      },
      deps: {
        clock: () => NOW,
        adapter: { list: async () => rows.slice() },
        deriveState,
        aggregator: async (payload: any) => {
          await federation.pollPeers()
          return federation.aggregateState(payload)
        },
      },
    })
    const port = await listenEphemeral(front.server)
    teardown.push(() => closeServer(front.server))
    return { federation, front, port }
  }

  it('a hub aggregates a LIVE peer over a real socket, end to end through its own /api/state', async () => {
    const peer = await startPeer()
    const hub = await startHub(peer.port, () => NOW)

    // the founder's own poll — a real HTTP GET against the hub, with the HUB's token
    const r = await fetch(`http://127.0.0.1:${hub.port}/api/state`, { headers: { authorization: `Bearer ${HUB_TOKEN}` } })
    expect(r.status).toBe(200)
    const payload: any = await r.json()

    expect(payload.machines.map((m: any) => [m.id, m.role, m.online])).toEqual([
      ['this-pc', 'self', true],
      ['peer-1', 'peer', true],
    ])
    // the peer's rows arrived, tagged with the REGISTRY id an action would address
    expect(payload.queue.map((q: any) => [q.id, q.machine])).toEqual([
      ['BL-H1', 'this-pc'],
      ['BL-P1', 'peer-1'],
    ])
    expect(payload.kpis.queued).toBe(2)
    expect(payload.kpis.awaitingApproval).toBe(1) // the peer's, counted in the one window
    // and the decision the peer is holding arrives as a ROW, not only as a number — the
    // day screen shows the task itself, so counting it is not enough
    expect(payload.awaiting.map((a: any) => [a.id, a.machine])).toEqual([['BL-P9', 'peer-1']])

    // the peer was reached on its ORDINARY front contract, with ITS bearer — no special door
    const stateHits = peer.seen.filter((s) => s.url === '/api/state')
    expect(stateHits.length).toBeGreaterThan(0)
    expect(stateHits[0].auth).toBe(`Bearer ${PEER_TOKEN}`)
    // and no peer token or url ever reaches the founder's payload
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain(PEER_TOKEN)
    expect(serialized).not.toContain(`127.0.0.1:${peer.port}`)
  })

  it('KILLING the peer flips it offline on the next poll and keeps its last snapshot, aged', async () => {
    const peer = await startPeer()
    let now = NOW
    const hub = await startHub(peer.port, () => now)

    await hub.federation.pollPeers()
    expect(hub.federation.peerStatus()[0]).toMatchObject({ id: 'peer-1', online: true })

    // a REAL death: sockets destroyed, port released — the next poll is refused by the OS
    await closeServer(peer.front.server)
    now = NOW + 30_000

    await expect(hub.federation.pollPeers()).resolves.toBeTruthy() // still fail-open
    const status = hub.federation.peerStatus()[0]
    expect(status.online).toBe(false)
    expect(status.lastSeenSec).toBe(30)

    // the founder still sees the dead machine's work, explicitly aged (the documented
    // exception to «derive, never store» — in memory, labelled, lost on restart)
    const r = await fetch(`http://127.0.0.1:${hub.port}/api/state`, { headers: { authorization: `Bearer ${HUB_TOKEN}` } })
    const payload: any = await r.json()
    expect(payload.machines[1]).toMatchObject({ id: 'peer-1', online: false })
    expect(payload.machines[1].lastSeenSec).toBeGreaterThanOrEqual(30)
    expect(payload.queue.map((q: any) => q.id)).toEqual(['BL-H1', 'BL-P1'])
  })

  it('proxies an approve to the LIVE peer with the PEER’s token and relays its answer', async () => {
    const peer = await startPeer()
    const hub = await startHub(peer.port, () => NOW)

    const out = await hub.federation.proxyAction({
      machineId: 'peer-1',
      path: '/api/approve',
      body: { taskId: 'BL-P9' },
    })

    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, taskId: 'BL-P9', merged: true })
    // the peer's own merge receipt travelled back VERBATIM — the hub computed nothing
    expect(out.body.receipt).toEqual({ testsPassed: 3, testsTotal: 3 })

    const approveHit = peer.seen.find((s) => s.url === '/api/approve')
    expect(approveHit).toBeTruthy()
    expect(approveHit!.auth).toBe(`Bearer ${PEER_TOKEN}`)
    expect(approveHit!.auth).not.toBe(`Bearer ${HUB_TOKEN}`)
  })

  it('a WRONG peer token is refused by the peer’s own auth door and relayed verbatim (401)', async () => {
    const peer = await startPeer()
    const hub = await startHub(peer.port, () => NOW, 'a-stale-token-value')

    const out = await hub.federation.proxyAction({ machineId: 'peer-1', path: '/api/approve', body: { taskId: 'BL-P9' } })
    expect(out.status).toBe(401)

    await hub.federation.pollPeers()
    expect(hub.federation.peerStatus()[0].online).toBe(false) // and it never looks online
  })
})
