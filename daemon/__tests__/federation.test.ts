/**
 * Tests for the federation module — the daemon's FIRST outbound daemon→daemon contour
 * (Plan 9.7-13, Task 1; D-9.7-01 / D-9.7-03 / D-9.7-04 / D-9.7-07).
 *
 * The unit group drives createFederation through an INJECTED fetch, so no socket is
 * opened here: aggregation of two peers, the offline degrade (last snapshot + its age),
 * the SSRF guard at construction, and the token-never-serializes law.
 *
 * The live two-daemon group (Task 3) is separate and deliberately uses the REAL fetch.
 */

import { describe, it, expect } from 'vitest'

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
    kpis: { workersBusy: 0, workersTotal: 1, queued: 2, awaitingApproval: 0, spentTodayEur: 0.5, windowsOpen: 1 },
    queue: [{ id: 'BL-self', title: 's', status: 'queued', project: 'home', machine: 'this-pc', position: 1 }],
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
    // counts add up across the whole federation
    expect(agg.kpis.queued).toBe(4) // 2 self + 1 + 1
    expect(agg.kpis.workersTotal).toBe(5)
    expect(agg.kpis.awaitingApproval).toBe(2)
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
