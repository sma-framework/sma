/**
 * federation-pairing.test.ts — MACHINE INTRODUCTION, the one moment a daemon token
 * leaves its own machine.
 *
 * The wizard PREPARES; the human APPLIES. The hub mints a ONE-SHOT invitation and hands
 * back a sentence a person can carry to the second machine; the daemon itself opens no
 * socket, runs no command and configures no network. Everything that makes that safe is
 * proved here by mechanism:
 *
 *   ONE SHOT — a second join with the same invitation is refused, and the refusal costs
 *   the founder a re-pair rather than the attacker a peer. The invitation is burned on
 *   consume whether or not it was still live, so a replay can never find it alive later.
 *
 *   TTL — an invitation left lying around dies on its own. An expired one is refused with
 *   the SAME message as an unknown one: a caller cannot learn which tokens ever existed.
 *
 *   TIMING-SAFE — the compare walks the whole book through auth.mjs's `tokenEquals`; a
 *   Map lookup would answer in a length-dependent time and leak a prefix oracle.
 *
 *   NOTHING WRITTEN UNTIL EVERYTHING CHECKS — the SSRF guard runs against the joining
 *   url BEFORE the registry write, so a loopback / metadata address never reaches disk.
 *
 *   NO SECRET IN A READ — /api/machines carries presence, never a token.
 *
 * The config write seam is injected (env + homedir + fsImpl), so the suite writes into a
 * temp home and can watch the atomic write happen: a `.tmp-` sibling, then a rename onto
 * the target — never a torn config a restart would refuse to load.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFrontServer } from '../src/front/server.mjs'
import {
  createFederation,
  createPairingBook,
  generatePairingToken,
  consumePairingToken,
  buildPairingInstruction,
  PairingTokenError,
  PAIRING_TTL_MS,
} from '../src/front/federation.mjs'
import { addPeer, removePeer, UnknownPeerError, InvalidFederationError } from '../src/config.mjs'

const TOKEN = 'a'.repeat(64)
const PEER_TOKEN = 'peer-daemon-secret-value-9f3c'
const NOW = 1_700_000_000_000

// ── fake req/res (no socket; the same seam front-auth.test.ts drives) ──

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body, remote = '10.0.0.1' } = o
  const payload = body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req: any = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = { ...headers }
  req.socket = { remoteAddress: remote }
  return req
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, any>,
    body: '',
    headersSent: false,
    writeHead(code: number, h?: any) {
      res.statusCode = code
      res.headersSent = true
      if (h) for (const [k, v] of Object.entries(h)) res.headers[k.toLowerCase()] = v
      return res
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      res.ended = true
      return res
    },
    write(c: any) {
      res.body += String(c)
      return true
    },
  }
  return res
}

const jsonHeaders = () => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' })
const bearer = () => ({ authorization: `Bearer ${TOKEN}` })

async function call(front: any, reqOpts: any) {
  const req = mkReq(reqOpts)
  const res = mkRes()
  await front.handle(req, res)
  return res
}

// ── a hub daemon wired exactly as the composition root wires one ──

let home: string
let clockNow: number
const homedir = () => home

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sma-pairing-'))
  clockNow = NOW
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const clock = () => clockNow

/** The config as a HUB daemon holds it: a role, a (possibly empty) peer registry. */
function hubConfig(peers: any[] = []) {
  return {
    token: TOKEN,
    bind: '127.0.0.1',
    port: 7777,
    machineId: 'this-pc',
    machineTitle: 'Этот ПК',
    workers: [],
    federation: { role: 'hub', peers },
  }
}

/** The whole wiring main.mjs performs for the machines group, with the write seam injected. */
function mkHub(config: any = hubConfig(), extra: any = {}) {
  const events: any[] = []
  const federation = createFederation({ config, clock, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) })
  const front = createFrontServer({
    config,
    deps: {
      clock,
      federation,
      addPeer,
      removePeer,
      env: {},
      homedir,
      hub: { emit: (e: any) => events.push(e) },
      ...extra,
    },
  })
  return { front, federation, config, events }
}

/** The config as it actually landed on disk — the only proof a write happened. */
function onDisk() {
  const path = join(home, '.sma-daemon', 'config.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

/** Mint an invitation through the door and return it. */
async function pair(front: any) {
  const res = await call(front, { method: 'POST', url: '/api/machine/pair', headers: jsonHeaders(), body: {} })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body)
}

/** A well-formed join body for the second machine. */
function joinBody(pairingToken: string, over: any = {}) {
  return {
    pairingToken,
    machine: { id: 'mac-mini', name: 'Mac mini', url: 'http://10.0.0.4:7777', token: PEER_TOKEN, ...over },
  }
}

// ══════════════════════════ the pairing book (unit) ══════════════════════════

describe('federation.mjs — the pairing book: one shot, and a life of its own', () => {
  it('mints a high-entropy invitation with a TTL; two invitations are never equal', () => {
    const book = new Map()
    const a = generatePairingToken({ book, clock })
    const b = generatePairingToken({ book, clock })
    expect(a.token).toMatch(/^[0-9a-f]{64}$/) // 32 bytes of crypto randomness
    expect(a.token).not.toBe(b.token)
    expect(a.expiresAt).toBe(NOW + PAIRING_TTL_MS)
    expect(book.size).toBe(2)
  })

  it('an invitation is ONE-SHOT: the same token is refused the second time', () => {
    const book = new Map()
    const { token } = generatePairingToken({ book, clock })
    expect(consumePairingToken(token, { book, clock })).toMatchObject({ expiresAt: NOW + PAIRING_TTL_MS })
    expect(book.size).toBe(0) // consumed means GONE, not marked
    expect(() => consumePairingToken(token, { book, clock })).toThrow(PairingTokenError)
  })

  it('an expired invitation is refused by its named error — and is burned all the same', () => {
    const book = new Map()
    const { token } = generatePairingToken({ book, clock })
    clockNow = NOW + PAIRING_TTL_MS + 1
    let caught: any = null
    try {
      consumePairingToken(token, { book, clock })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PairingTokenError)
    expect(caught.reason).toBe('expired')
    expect(book.size).toBe(0) // a replay must not find it alive a moment later
  })

  it('an unknown token reads EXACTLY like an expired one — no oracle over which ever existed', () => {
    const book = new Map()
    const { token } = generatePairingToken({ book, clock })
    const expiredMsg = (() => {
      clockNow = NOW + PAIRING_TTL_MS + 1
      try {
        consumePairingToken(token, { book, clock })
      } catch (e: any) {
        return e.message
      }
      return null
    })()
    let unknownMsg: string | null = null
    try {
      consumePairingToken('f'.repeat(64), { book, clock })
    } catch (e: any) {
      unknownMsg = e.message
    }
    expect(expiredMsg).toBeTruthy()
    expect(unknownMsg).toBe(expiredMsg)
  })

  it('the compare is TIMING-SAFE: consume walks the book through auth.mjs tokenEquals', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/front/federation.mjs', import.meta.url)), 'utf8')
    const consume = src.slice(src.indexOf('export function consumePairingToken'))
    expect(consume).toMatch(/tokenEquals\(/) // never `book.get(token)` — that leaks a prefix oracle
    // a token that differs in ONE character is refused like any other stranger
    const book = new Map()
    const { token } = generatePairingToken({ book, clock })
    const nearMiss = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')
    expect(() => consumePairingToken(nearMiss, { book, clock })).toThrow(PairingTokenError)
    expect(book.size).toBe(1) // a near miss burns nothing
  })

  it('createPairingBook binds one private book — two hubs never share an invitation', () => {
    const a = createPairingBook({ clock })
    const b = createPairingBook({ clock })
    const { token } = a.generatePairingToken()
    expect(() => b.consumePairingToken(token)).toThrow(PairingTokenError)
    expect(a.consumePairingToken(token)).toBeTruthy()
  })

  it('the instruction is TEXT for a human: the command is quoted, never run', () => {
    const text = buildPairingInstruction({ hubUrl: 'http://10.0.0.2:7777', pairingToken: 'abc123', expiresSec: 900 })
    expect(text).toContain('http://10.0.0.2:7777/api/machine/add')
    expect(text).toContain('abc123')
    expect(text).toMatch(/15 минут|900/) // the human is told how long it lives
  })
})

// ══════════════════════════ POST /api/machine/pair ══════════════════════════

describe('POST /api/machine/pair — the hub mints the invitation', () => {
  it('a hub answers {pairingToken, instruction, expiresSec} and quotes the hub token as a PLACEHOLDER', async () => {
    const { front } = mkHub()
    const out = await pair(front)
    expect(out.pairingToken).toMatch(/^[0-9a-f]{64}$/)
    expect(out.expiresSec).toBe(PAIRING_TTL_MS / 1000)
    expect(out.instruction).toContain('/api/machine/add')
    // THE HUB'S OWN TOKEN NEVER RIDES OUT — the instruction names it, it does not carry it
    expect(JSON.stringify(out)).not.toContain(TOKEN)
  })

  it('a standalone daemon refuses to pair — introduction is a hub act (400, named)', async () => {
    const config: any = { token: TOKEN, workers: [] } // no federation block at all
    const front = createFrontServer({ config, deps: { clock, addPeer, removePeer, env: {}, homedir } })
    const res = await call(front, { method: 'POST', url: '/api/machine/pair', headers: jsonHeaders(), body: {} })
    expect(res.statusCode).toBe(400)
  })

  it('a hub with no federation engine wired → 501, never a silent no-op', async () => {
    const config = hubConfig()
    const front = createFrontServer({ config, deps: { clock, addPeer, removePeer, env: {}, homedir } })
    const res = await call(front, { method: 'POST', url: '/api/machine/pair', headers: jsonHeaders(), body: {} })
    expect(res.statusCode).toBe(501)
  })

  it('an unknown body key is refused before an invitation is minted', async () => {
    const { front, federation } = mkHub()
    const res = await call(front, {
      method: 'POST',
      url: '/api/machine/pair',
      headers: jsonHeaders(),
      body: { role: 'hub', command: 'rm -rf /' },
    })
    expect(res.statusCode).toBe(400)
    // and nothing was minted: the very next join with a guessed token fails
    expect(() => federation.consumePairingToken('0'.repeat(64))).toThrow(PairingTokenError)
  })
})

// ══════════════════════════ POST /api/machine/add ══════════════════════════

describe('POST /api/machine/add — the join, and everything it refuses', () => {
  it('a valid join lands the peer in the config ATOMICALLY and makes it live without a restart', async () => {
    const { front, federation, config, events } = mkHub()
    const { pairingToken } = await pair(front)

    const res = await call(front, { method: 'POST', url: '/api/machine/add', headers: jsonHeaders(), body: joinBody(pairingToken) })
    expect(res.statusCode).toBe(200)

    // (1) it reached DISK, through the atomic writer
    const disk = onDisk()
    expect(disk.federation.peers).toHaveLength(1)
    expect(disk.federation.peers[0]).toMatchObject({ id: 'mac-mini', url: 'http://10.0.0.4:7777', token: PEER_TOKEN })

    // (2) the in-process config moved too — the very next read must not serve the old registry
    expect(config.federation.peers).toHaveLength(1)

    // (3) the peer is LIVE: an action can be addressed to it now, not after a restart
    expect(federation.peerIds).toContain('mac-mini')

    // (4) the presence hint fired
    expect(events.map((e) => e.event)).toContain('machine.presence')

    // (5) NO SECRET IN THE ANSWER
    expect(res.body).not.toContain(PEER_TOKEN)
    expect(res.body).not.toContain(TOKEN)
  })

  it('the registry write is a temp sibling then a rename — never a torn config', async () => {
    const calls: string[] = []
    const fsImpl = {
      mkdirSync: (p: any) => calls.push(`mkdir ${p}`),
      writeFileSync: (p: any) => calls.push(`write ${p}`),
      renameSync: (a: any, b: any) => calls.push(`rename ${a} -> ${b}`),
      chmodSync: () => calls.push('chmod'),
    }
    const { front } = mkHub(hubConfig(), { fsImpl })
    const { pairingToken } = await pair(front)
    const res = await call(front, { method: 'POST', url: '/api/machine/add', headers: jsonHeaders(), body: joinBody(pairingToken) })
    expect(res.statusCode).toBe(200)
    const written = calls.find((c) => c.startsWith('write '))!
    const renamed = calls.find((c) => c.startsWith('rename '))!
    expect(written).toMatch(/\.tmp-/) // a sibling, never the target itself
    expect(renamed).toMatch(/config\.json$/) // and only the rename lands on the target
    expect(calls.indexOf(written)).toBeLessThan(calls.indexOf(renamed))
  })

  it('the SAME invitation cannot join twice — the second attempt writes NOTHING', async () => {
    const { front, config } = mkHub()
    const { pairingToken } = await pair(front)
    expect((await call(front, { method: 'POST', url: '/api/machine/add', headers: jsonHeaders(), body: joinBody(pairingToken) })).statusCode).toBe(200)

    const second = await call(front, {
      method: 'POST',
      url: '/api/machine/add',
      headers: jsonHeaders(),
      body: joinBody(pairingToken, { id: 'studio', name: 'Studio', url: 'http://10.0.0.5:7777' }),
    })
    expect(second.statusCode).toBeGreaterThanOrEqual(400)
    expect(second.statusCode).toBeLessThan(500)
    expect(config.federation.peers.map((p: any) => p.id)).toEqual(['mac-mini']) // the intruder is not there
    expect(onDisk().federation.peers).toHaveLength(1)
  })

  it('an EXPIRED invitation is refused and nothing is written', async () => {
    const { front, config } = mkHub()
    const { pairingToken } = await pair(front)
    clockNow = NOW + PAIRING_TTL_MS + 1000
    const res = await call(front, { method: 'POST', url: '/api/machine/add', headers: jsonHeaders(), body: joinBody(pairingToken) })
    expect(res.statusCode).toBe(400)
    expect(config.federation.peers).toHaveLength(0)
    expect(onDisk()).toBeNull() // not a single write happened
  })

  it('a loopback / metadata url is refused BEFORE the write', async () => {
    for (const url of ['http://127.0.0.1:7777', 'http://localhost:7777', 'http://169.254.169.254/']) {
      const { front, config } = mkHub()
      const { pairingToken } = await pair(front)
      const res = await call(front, {
        method: 'POST',
        url: '/api/machine/add',
        headers: jsonHeaders(),
        body: joinBody(pairingToken, { url }),
      })
      expect(res.statusCode, url).toBe(400)
      expect(config.federation.peers, url).toHaveLength(0)
    }
  })

  it('a smuggled key inside `machine` dies at the parse, before the invitation is even read', async () => {
    const { front } = mkHub()
    const { pairingToken } = await pair(front)
    const res = await call(front, {
      method: 'POST',
      url: '/api/machine/add',
      headers: jsonHeaders(),
      body: { pairingToken, machine: { id: 'x', url: 'http://10.0.0.9:7777', token: 't', command: 'rm -rf /' } },
    })
    expect(res.statusCode).toBe(400)
  })

  it('a machine id outside the slug grammar → 400 (the id is the key an action is addressed to)', async () => {
    for (const id of ['Mac Mini', '../etc', 'x'.repeat(65), '']) {
      const { front } = mkHub()
      const { pairingToken } = await pair(front)
      const res = await call(front, {
        method: 'POST',
        url: '/api/machine/add',
        headers: jsonHeaders(),
        body: joinBody(pairingToken, { id }),
      })
      expect(res.statusCode, id).toBe(400)
    }
  })

  it('an empty peer token → 400: a peer the hub cannot authenticate to is not a peer', async () => {
    const { front } = mkHub()
    const { pairingToken } = await pair(front)
    const res = await call(front, {
      method: 'POST',
      url: '/api/machine/add',
      headers: jsonHeaders(),
      body: joinBody(pairingToken, { token: '' }),
    })
    expect(res.statusCode).toBe(400)
  })
})

// ══════════════════════════ GET /api/machines ══════════════════════════

describe('GET /api/machines — presence, never a secret', () => {
  it('lists this machine and its peers with no token anywhere in the payload', async () => {
    const config = hubConfig([{ id: 'mac-mini', name: 'Mac mini', url: 'http://10.0.0.4:7777', token: PEER_TOKEN }])
    const { front } = mkHub(config)
    const res = await call(front, { url: '/api/machines', headers: bearer() })
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.machines[0]).toMatchObject({ id: 'this-pc', role: 'self', online: true })
    expect(out.machines[1]).toMatchObject({ id: 'mac-mini', role: 'peer', online: false })
    // the serialization proof: neither a peer token nor the hub's own token is reachable
    expect(res.body).not.toContain(PEER_TOKEN)
    expect(res.body).not.toContain(TOKEN)
    expect(res.body).not.toContain('10.0.0.4') // and no url either — an id is the addressee
  })

  it('a standalone daemon still answers: exactly one machine, its own', async () => {
    const config: any = { token: TOKEN, machineId: 'solo', machineTitle: 'Один', workers: [] }
    const front = createFrontServer({ config, deps: { clock } })
    const res = await call(front, { url: '/api/machines', headers: bearer() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).machines).toHaveLength(1)
  })
})

// ══════════════════════════ POST /api/machine/remove ══════════════════════════

describe('POST /api/machine/remove — letting a machine go', () => {
  it('drops the peer from the config AND from the live registry', async () => {
    const config = hubConfig([{ id: 'mac-mini', name: 'Mac mini', url: 'http://10.0.0.4:7777', token: PEER_TOKEN }])
    const { front, federation, events } = mkHub(config)
    const res = await call(front, { method: 'POST', url: '/api/machine/remove', headers: jsonHeaders(), body: { id: 'mac-mini' } })
    expect(res.statusCode).toBe(200)
    expect(config.federation.peers).toHaveLength(0)
    expect(onDisk().federation.peers).toHaveLength(0)
    expect(federation.peerIds).not.toContain('mac-mini')
    expect(events.map((e) => e.event)).toContain('machine.presence')
  })

  it('an unknown machine → 404 (a named error, not a silent success)', async () => {
    const { front } = mkHub()
    const res = await call(front, { method: 'POST', url: '/api/machine/remove', headers: jsonHeaders(), body: { id: 'ghost' } })
    expect(res.statusCode).toBe(404)
  })

  it('an unknown body key → 400', async () => {
    const { front } = mkHub()
    const res = await call(front, { method: 'POST', url: '/api/machine/remove', headers: jsonHeaders(), body: { id: 'x', force: true } })
    expect(res.statusCode).toBe(400)
  })
})

// ══════════════════════════ the config doors themselves ══════════════════════════

describe('config.mjs — addPeer / removePeer are the ONE write path for the registry', () => {
  it('addPeer appends a validated peer and refuses a duplicate id', () => {
    const cfg = hubConfig()
    const next = addPeer(cfg, { id: 'mac-mini', name: 'Mac mini', url: 'http://10.0.0.4:7777', token: PEER_TOKEN }, { env: {}, homedir })
    expect(next.federation.peers).toHaveLength(1)
    expect(() =>
      addPeer(next, { id: 'mac-mini', name: 'Dup', url: 'http://10.0.0.9:7777', token: 'x' }, { env: {}, homedir }),
    ).toThrow(InvalidFederationError)
  })

  it('removePeer refuses an unknown id with a named error', () => {
    const cfg = hubConfig()
    expect(() => removePeer(cfg, { id: 'ghost' }, { env: {}, homedir })).toThrow(UnknownPeerError)
  })
})
