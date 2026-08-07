/**
 * Tests for the coordination panel — who else has this checkout open, what they reserved, and
 * where two reservations met.
 *
 * WHY THESE DOORS EXIST AT ALL: a shared checkout has always been the product's assumption, and
 * the leases, the reservations and the collisions have always been on disk. What was missing was
 * a reader that is not a status line, and a way to take a dead reservation away without opening
 * a terminal. Neither is a new mechanism.
 *
 * GREP-VISIBLE INVARIANTS (each one is a case below, named in the same words):
 *   1.  THE SNAPSHOT IS READ, NEVER REMEMBERED — sessions, reservations and today's collisions
 *       come off the ledger on every call, through the runtime's OWN readers.
 *   2.  A COLLISION IS VISIBLE, OR THE PANEL IS DECORATION — a journalled collision reaches the
 *       answer with both actors and the ground they met on.
 *   3.  NO RESERVATION IS CLEARED WITHOUT A REASON — an empty one is a 400 and the verb is
 *       never reached, because a foreign clear is a risky operation with a written record.
 *   4.  A NAME THAT COULD READ AS A FLAG NEVER REACHES THE COMMAND — the reservation's name is
 *       held to a grammar before anything is assembled from it.
 *   5.  THE SLOTS ARE FILLED — the two keys are gone from PENDING_ROUTES, and the doors answer.
 *
 * Every ledger read and every verb is injected. No temp directory, no child process, no socket,
 * and no `.sma/` on this machine is opened by this file.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'

import { createFrontServer, PENDING_ROUTES, CLAIM_CLEAR_RECEIPT_FORMAT } from '../src/front/server.mjs'
import { deriveCoordination } from '../src/front/state.mjs'

const TOKEN = 'k'.repeat(64)
const PROJECT = '/proj'
const NOW = 1770000000000

/** The connected project — a registry entry that NAMES A FOLDER is what «connected» means. */
const CONNECTED = { projects: [{ id: 'p1', name: 'мастерская', path: PROJECT }], activeProject: 'p1' }

/** The ledger as the runtime's own readers hand it over: raw facts, no formatting. */
const LEDGER = {
  sessions: [
    { id: 'P12 Оля', title: 'правит фронт', since: new Date(NOW - 2 * 3600000).toISOString() },
    { id: 'P11 Ким', title: 'считает память', ageMs: 45 * 60000 },
  ],
  claims: [
    { name: 'front-doors', globs: ['daemon/src/front/**'], desc: 'двери фронта', ageMs: 3 * 3600000 },
    { name: 'push', globs: [], desc: 'scope-claim:push', ageMs: 5 * 86400000 },
  ],
  collisions: [{ a: 'P12 Оля', b: 'P11 Ким', overlap: ['daemon/src/front/state.mjs'] }],
}

const BACKLOG_FILE = [
  '# Backlog проекта',
  '',
  '> Свободный текст, который не является строкой доски и не должен на неё попасть.',
  '',
  '## Backlog',
  '',
  '- [ ] **AB-205** · Вторая волна методологий очереди — по данным пилота решить, что докручиваем. `size:M` `area:os` `added:2026-07-17`',
  '- [ ] **QQQ-7** · Работник «вайрфреймер» на базе внешнего инструмента. `size:M` `added:2026-07-16`',
  '- [x] **AB-100** · Уже сделано, и доска не история. `added:2026-05-01`',
  '- **ZZ-1** — Строка без чекбокса тоже строка. `added:2026-08-01`',
  '- просто пункт списка без идентификатора',
  '',
].join('\n')

function fakeFs(files: Record<string, string>) {
  const map = new Map(Object.entries(files).map(([k, v]) => [k.replace(/\\/g, '/'), v]))
  return {
    readdirSync() {
      throw new Error('ENOENT')
    },
    readFileSync(p: string) {
      const k = String(p).replace(/\\/g, '/')
      if (!map.has(k)) throw new Error(`ENOENT: ${k}`)
      return map.get(k) as string
    },
    statSync() {
      throw new Error('ENOENT')
    },
    files: map,
  }
}

// ── fake req/res ──

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body, remote = '10.0.0.11' } = o
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
  }
  return res
}

async function call(front: any, o: any) {
  const req = mkReq({
    ...o,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(o.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(o.headers || {}),
    },
  })
  const res = mkRes()
  await front.handle(req, res)
  return res
}

/** A front wired with the coordination collaborators, all of them recording fakes. */
function mkFront(over: any = {}) {
  const cleared: any[] = []
  const enqueued: any[] = []
  const emitted: any[] = []
  const io = over.fsImpl ?? fakeFs({ [`${PROJECT}/.planning/BACKLOG.md`]: BACKLOG_FILE })
  const ledger = over.ledger === undefined ? LEDGER : over.ledger

  const front = createFrontServer({
    config: { token: TOKEN, ...(over.config ?? CONNECTED) },
    deps: {
      fsImpl: io,
      clock: () => NOW,
      hub: { emit: (e: any) => emitted.push(e) },
      adapter: {
        enqueue: async (t: any) => {
          enqueued.push(t)
          return { id: t.id, coalesced: false }
        },
      },
      deriveCoordination: (args: any) => deriveCoordination({ ...args, readLedger: () => ledger }),
      clearClaim: async (a: any) => {
        cleared.push(a)
        return over.clearResult ?? { cleared: true, by: 'P12 Оля' }
      },
      ...over.deps,
      fsImpl: io,
    },
  })
  return { front, cleared, enqueued, emitted, io }
}

// ═══════════════ THE SNAPSHOT IS READ, NEVER REMEMBERED ═══════════════

describe('GET /api/coordination — THE SNAPSHOT IS READ, NEVER REMEMBERED', () => {
  it('A COLLISION IS VISIBLE, OR THE PANEL IS DECORATION', async () => {
    const { front } = mkFront()
    const res = await call(front, { url: '/api/coordination' })

    expect(res.statusCode).toBe(200)
    const snap = JSON.parse(res.body)
    expect(snap.collisions).toEqual([
      { a: 'P12 Оля', b: 'P11 Ким', overlap: ['daemon/src/front/state.mjs'] },
    ])
  })

  it('the reservations carry the ground they cover and how long they have held it', async () => {
    const { front } = mkFront()
    const snap = JSON.parse((await call(front, { url: '/api/coordination' })).body)
    expect(snap.claims).toEqual([
      { name: 'front-doors', globs: ['daemon/src/front/**'], desc: 'двери фронта', age: '3 ч' },
      { name: 'push', globs: [], desc: 'scope-claim:push', age: '5 дн' },
    ])
    // the two age sources — a duration the reader measured and a moment it reported — read the same
    expect(snap.sessions.map((s: any) => s.age)).toEqual(['2 ч', '45 мин'])
  })

  it('a quiet checkout, an unreadable ledger and no project connected are all the same empty panel', () => {
    const empty = { sessions: [], claims: [], collisions: [] }
    expect(deriveCoordination({ config: CONNECTED, readLedger: () => empty })).toEqual(empty)
    expect(
      deriveCoordination({
        config: CONNECTED,
        readLedger: () => {
          throw new Error('EACCES')
        },
      }),
    ).toEqual(empty)
    expect(deriveCoordination({ config: CONNECTED })).toEqual(empty) // nothing wired to read with
    expect(deriveCoordination({ config: {}, readLedger: () => LEDGER })).toEqual(empty)
  })

  it('nothing of this machine rides out — no path, no pid, no session file name', async () => {
    const { front } = mkFront()
    const res = await call(front, { url: '/api/coordination' })
    expect(res.body).not.toContain(PROJECT)
    expect(res.body).not.toContain('.sma')
    expect(res.body).not.toContain('pid')
  })
})

// ═══════════════ NO RESERVATION IS CLEARED WITHOUT A REASON ═══════════════

describe('POST /api/claim/clear — NO RESERVATION IS CLEARED WITHOUT A REASON', () => {
  it('clears the named reservation and answers with a receipt naming the former holder', async () => {
    const { front, cleared, emitted } = mkFront()
    const res = await call(front, {
      method: 'POST',
      url: '/api/claim/clear',
      body: { claim: 'push', reason: 'терминал закрыт неделю назад, правок в диапазоне нет' },
    })

    expect(res.statusCode).toBe(200)
    expect(cleared).toEqual([{ claim: 'push', reason: 'терминал закрыт неделю назад, правок в диапазоне нет' }])
    expect(JSON.parse(res.body)).toEqual({ ok: true, claim: 'push', receipt: 'claim-clear:push@P12 Оля' })
    expect(emitted).toContainEqual({ event: 'coordination.updated' })
  })

  it('an empty, blank or missing reason is a 400 and the verb is NEVER reached', async () => {
    for (const reason of [undefined, '', '   ', null]) {
      const { front, cleared, emitted } = mkFront()
      const body: any = { claim: 'push' }
      if (reason !== undefined) body.reason = reason
      const res = await call(front, { method: 'POST', url: '/api/claim/clear', body })
      expect(res.statusCode, String(reason)).toBe(400)
      expect(res.body).toContain('reason is required')
      expect(cleared, String(reason)).toHaveLength(0)
      expect(emitted, String(reason)).toHaveLength(0)
    }
  })

  it('A NAME THAT COULD READ AS A FLAG NEVER REACHES THE COMMAND', async () => {
    for (const claim of ['--yes', '-rf', '../../other', 'a/b', '', 'x'.repeat(80), 'a b']) {
      const { front, cleared } = mkFront()
      const res = await call(front, { method: 'POST', url: '/api/claim/clear', body: { claim, reason: 'потому что' } })
      expect(res.statusCode, claim).toBe(400)
      expect(cleared, claim).toHaveLength(0)
    }
  })

  it('an unknown key is a 400 before anything runs — no evidence field is smuggled past the verb', async () => {
    const { front, cleared } = mkFront()
    const res = await call(front, {
      method: 'POST',
      url: '/api/claim/clear',
      body: { claim: 'push', reason: 'потому что', evidence: 'ev-1', checked: 'ничего' },
    })
    expect(res.statusCode).toBe(400)
    expect(cleared).toHaveLength(0)
  })

  it('a reason past the cap is refused rather than truncated into a shorter promise', async () => {
    const { front, cleared } = mkFront()
    const res = await call(front, {
      method: 'POST',
      url: '/api/claim/clear',
      body: { claim: 'push', reason: 'д'.repeat(2001) },
    })
    expect(res.statusCode).toBe(400)
    expect(cleared).toHaveLength(0)
  })

  it("the runtime's own refusal travels back, and nothing is announced as having moved", async () => {
    const refusal = 'Принудительная очистка чужого claim — рискованная операция и требует доказательства'
    const { front, emitted } = mkFront({ clearResult: { cleared: false, reason: refusal } })
    const res = await call(front, { method: 'POST', url: '/api/claim/clear', body: { claim: 'push', reason: 'надо' } })
    expect(res.statusCode).toBe(409)
    expect(res.body).toBe(refusal)
    expect(emitted).toHaveLength(0)
  })

  it('the receipt format is a WORD, not only an example of itself', () => {
    expect(CLAIM_CLEAR_RECEIPT_FORMAT).toBe('claim-clear:<claim>@<by>')
  })
})

// ═══════════════════════════ THE SLOTS ARE FILLED ═══════════════════════════

describe('THE SLOTS ARE FILLED — two keys gone, and the doors answer', () => {
  it('neither of the two is named in PENDING_ROUTES any more', () => {
    for (const key of [
      'GET /api/coordination',
      'POST /api/claim/clear',
    ]) {
      expect(PENDING_ROUTES.has(key), key).toBe(false)
    }
  })

  it('a daemon wired with NO collaborator answers «not available here», not a guess', async () => {
    const front = createFrontServer({ config: { token: TOKEN, ...CONNECTED }, deps: {} })
    for (const [method, url] of [
      ['GET', '/api/coordination'],
      ['POST', '/api/claim/clear'],
    ]) {
      const res = await call(front, { method, url, body: method === 'POST' ? {} : undefined })
      expect(res.statusCode, url).toBe(501)
    }
  })
})
