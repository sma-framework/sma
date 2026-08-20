/**
 * Tests for the release: a gate anybody may run, and a publication only a person may reach.
 *
 * THE ONE SENTENCE EVERYTHING HERE IS WRITTEN AGAINST: nothing leaves this machine without a
 * person, and a person's word is not a checkbox. The gate is run by the DAEMON from exit
 * codes — never by a worker, because «the model said it was green» must not be the thing that
 * opens the most expensive door in the product — and the publication carries two locks of
 * DIFFERENT KINDS: a machine fact (the receipt of a run this daemon itself watched) and a
 * human fact (the version string typed out in full).
 *
 * GREP-VISIBLE INVARIANTS (each one is a case below, named in the same words):
 *   1.  THE GATE REPORTS EVERY STEP AS IT FINISHES — a gate that spoke only at the end would
 *       be a spinner with extra words.
 *   2.  A RED RUN HANDS OUT NO RECEIPT — the only possible use of one is the field that must
 *       not accept it.
 *   3.  TWO GATE RUNS AT ONCE IS A REFUSAL, not two gates.
 *   4.  PUBLICATION WITHOUT A GREEN RECEIPT IS IMPOSSIBLE — absent, malformed, unknown and
 *       red are four separate cases and all four refuse.
 *   5.  PUBLICATION WITHOUT THE EXACT VERSION IS IMPOSSIBLE — near-misses are refusals.
 *   6.  THE LOCKS ARE CHECKED BEFORE ANYTHING RUNS — a refused publication reaches no verb.
 *   7.  A SECOND PUBLICATION IS A REFUSAL — 409, never a second release.
 *   8.  A WORKER HAS NO PATH TO THIS DOOR — checked in the assembly, not promised in a comment.
 *   9.  THE SLOTS ARE FILLED — PENDING_ROUTES is empty and both doors answer.
 *
 * Every collaborator is injected. No child process, no socket, no `.sma/` on this machine.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

import {
  createFrontServer,
  PENDING_ROUTES,
  SHIP_GATE_RECEIPT_FORMAT,
  SHIP_PUBLISH_RECEIPT_FORMAT,
} from '../src/front/server.mjs'

const TOKEN = 'k'.repeat(64)
const VERSION = '5.3.0'
const GREEN_RECEIPT = 'ship-gate:G-1770000000000'

const GREEN_CHECKS = [
  { step: 'консеквенции', ok: true, detail: 'открытых блокирующих событий нет' },
  { step: 'корпус', ok: true, detail: 'критических находок нет' },
  { step: 'бейдж', ok: true, detail: 'бейдж совпадает со снимком' },
]

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body, remote = '10.0.0.11' } = o
  const payload = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
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

/** A front wired with the four release collaborators, every one of them a recording fake. */
function mkFront(over: any = {}) {
  const emitted: any[] = []
  const steps: any[] = []
  const published: any[] = []
  const verified: any[] = []

  const front = createFrontServer({
    config: { token: TOKEN },
    deps: {
      hub: { emit: (e: any) => emitted.push(e) },
      runShipGate:
        over.runShipGate ??
        (async ({ onStep }: any) => {
          const checks = over.checks ?? GREEN_CHECKS
          for (const c of checks) {
            steps.push(c.step)
            onStep({ taskId: 'G-1770000000000', step: c.step, ok: c.ok })
          }
          const ok = checks.every((c: any) => c.ok)
          return { taskId: 'G-1770000000000', ok, checks, ...(ok ? { receipt: GREEN_RECEIPT } : {}) }
        }),
      verifyGateReceipt:
        over.verifyGateReceipt ??
        ((r: string) => {
          verified.push(r)
          return r === GREEN_RECEIPT ? { green: true } : { green: false, reason: 'этот прогон воротам неизвестен' }
        }),
      releaseVersion: over.releaseVersion ?? (() => VERSION),
      publishRelease:
        over.publishRelease ??
        (async (a: any) => {
          published.push(a)
          return over.publishResult ?? { ok: true, receipt: `ship-publish:${a.version}@полоса=ok+отметка ворот=abc123def456` }
        }),
      ...over.deps,
    },
  })
  return { front, emitted, steps, published, verified }
}

const publish = (front: any, body: any) => call(front, { method: 'POST', url: '/api/ship/publish', body })
const gate = (front: any, body: any = {}) => call(front, { method: 'POST', url: '/api/ship/gate', body })

// ═══════════════ THE GATE REPORTS EVERY STEP AS IT FINISHES ═══════════════

describe('POST /api/ship/gate — THE GATE REPORTS EVERY STEP AS IT FINISHES', () => {
  it('every step leaves a hint carrying the run and the step, and the report comes back whole', async () => {
    const { front, emitted } = mkFront()
    const res = await gate(front)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.taskId).toBe('G-1770000000000')
    expect(body.checks).toEqual(GREEN_CHECKS)
    expect(body.receipt).toBe(GREEN_RECEIPT)

    const hints = emitted.filter((e) => e.event === 'ship.gate')
    expect(hints).toHaveLength(3)
    expect(hints.map((h) => h.step)).toEqual(['консеквенции', 'корпус', 'бейдж'])
    for (const h of hints) expect(h.taskId).toBe('G-1770000000000')
    // the hint says WHERE the gate is and nothing else — the verdict is read back through
    // the answer, which is the one place it is authoritative
    for (const h of hints) expect(Object.keys(h).sort()).toEqual(['event', 'step', 'taskId'])
  })

  it('the body is EMPTY by contract — a stray field is a 400 and the gate never runs', async () => {
    const { front, steps } = mkFront()
    for (const body of [{ force: true }, { step: 'бейдж' }, { verb: 'preship' }]) {
      expect((await gate(front, body)).statusCode).toBe(400)
    }
    expect(steps).toEqual([])
  })

  it('A RED RUN HANDS OUT NO RECEIPT — a red gate has nothing to give the publication door', async () => {
    const { front } = mkFront({
      checks: [
        { step: 'консеквенции', ok: true, detail: 'открытых блокирующих событий нет' },
        { step: 'корпус', ok: false, detail: '2 критических находок' },
        { step: 'бейдж', ok: true, detail: 'бейдж совпадает со снимком' },
      ],
    })
    const body = JSON.parse((await gate(front)).body)
    expect(body.ok).toBe(false)
    expect(body.receipt).toBeUndefined()
    expect('receipt' in body).toBe(false)
    // the red step still travels, with the reason it was red
    expect(body.checks[1]).toEqual({ step: 'корпус', ok: false, detail: '2 критических находок' })
  })

  it('TWO GATE RUNS AT ONCE IS A REFUSAL — 409 naming the run already in flight', async () => {
    const { front } = mkFront({ runShipGate: async () => ({ busy: true, taskId: 'G-1769999999999' }) })
    const res = await gate(front)
    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('G-1769999999999')
  })

  it('a gate that THROWS is a 409 with its own words, never a 500', async () => {
    const { front } = mkFront({
      runShipGate: async () => {
        throw new Error('в проекте нет рантайма SMA')
      },
    })
    const res = await gate(front)
    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('нет рантайма')
  })
})

// ═══════════════ PUBLICATION WITHOUT A GREEN RECEIPT IS IMPOSSIBLE ═══════════════

describe('POST /api/ship/publish — PUBLICATION WITHOUT A GREEN RECEIPT IS IMPOSSIBLE', () => {
  it('absent, malformed, unknown and red — four refusals, and not one of them publishes', async () => {
    const { front, published } = mkFront()
    const bodies = [
      { confirm: VERSION }, // no receipt at all
      { gateReceipt: '', confirm: VERSION },
      { gateReceipt: 'ship-gate:G-1; rm -rf /', confirm: VERSION }, // shape refused before anything
      { gateReceipt: 'ship-gate:G-9999999999999', confirm: VERSION }, // well-formed, unknown
      { gateReceipt: 'not-a-receipt-at-all', confirm: VERSION },
    ]
    for (const body of bodies) {
      const res = await publish(front, body)
      expect(res.statusCode).toBe(400)
    }
    expect(published).toEqual([])
  })

  it('a receipt of a run that went RED is refused in the record’s own words', async () => {
    const { front, published } = mkFront({
      verifyGateReceipt: () => ({ green: false, reason: 'этот прогон ворот не был зелёным' }),
    })
    const res = await publish(front, { gateReceipt: GREEN_RECEIPT, confirm: VERSION })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('не был зелёным')
    expect(published).toEqual([])
  })

  it('THE LOCKS ARE CHECKED BEFORE ANYTHING RUNS — the gate is asked, the publisher is not', async () => {
    const { front, verified, published } = mkFront()
    await publish(front, { gateReceipt: 'ship-gate:G-1', confirm: VERSION })
    expect(verified).toEqual(['ship-gate:G-1'])
    expect(published).toEqual([])
  })
})

// ═══════════════ PUBLICATION WITHOUT THE EXACT VERSION IS IMPOSSIBLE ═══════════════

describe('POST /api/ship/publish — PUBLICATION WITHOUT THE EXACT VERSION IS IMPOSSIBLE', () => {
  it('a near-miss is a miss: whitespace, a v, a shortened number, an empty string', async () => {
    const { front, published } = mkFront()
    for (const confirm of ['', ' 5.3.0', '5.3.0 ', 'v5.3.0', '5.3', '5.3.1', 'да', 'true']) {
      const res = await publish(front, { gateReceipt: GREEN_RECEIPT, confirm })
      expect(res.statusCode).toBe(400)
    }
    expect(published).toEqual([])
  })

  it('a machine that states no version publishes NOTHING — 409, and the publisher is not called', async () => {
    const { front, published } = mkFront({ releaseVersion: () => null })
    const res = await publish(front, { gateReceipt: GREEN_RECEIPT, confirm: VERSION })
    expect(res.statusCode).toBe(409)
    expect(published).toEqual([])
  })

  it('the confirm field is not a checkbox — `true` is a refusal like any other wrong string', async () => {
    const { front, published } = mkFront()
    for (const confirm of [true, 1, null, {}, ['5.3.0']]) {
      expect((await publish(front, { gateReceipt: GREEN_RECEIPT, confirm })).statusCode).toBe(400)
    }
    expect(published).toEqual([])
  })

  it('BOTH LOCKS TOGETHER PUBLISH — and the version the daemon named is the one that travels', async () => {
    const { front, published, emitted } = mkFront()
    const res = await publish(front, { gateReceipt: GREEN_RECEIPT, confirm: VERSION })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toEqual({
      ok: true,
      version: VERSION,
      receipt: 'ship-publish:5.3.0@полоса=ok+отметка ворот=abc123def456',
    })
    // the publisher was handed the version the DAEMON read, plus the receipt that unlocked it
    expect(published).toEqual([{ version: VERSION, gateReceipt: GREEN_RECEIPT }])
    expect(emitted.filter((e) => e.event === 'ship.published')).toEqual([{ event: 'ship.published', version: VERSION }])
  })

  it('no field beyond the two exists — an extra key is a 400 before either lock is asked', async () => {
    const { front, verified, published } = mkFront()
    for (const extra of [{ force: true }, { lane: 'quick' }, { verb: 'push' }, { version: '9.9.9' }]) {
      const res = await publish(front, { gateReceipt: GREEN_RECEIPT, confirm: VERSION, ...extra })
      expect(res.statusCode).toBe(400)
    }
    expect(verified).toEqual([])
    expect(published).toEqual([])
  })
})

// ═══════════════ A SECOND PUBLICATION IS A REFUSAL ═══════════════

describe('POST /api/ship/publish — A SECOND PUBLICATION IS A REFUSAL', () => {
  it('a publication already in flight answers 409, never a second release', async () => {
    const { front } = mkFront({ publishRelease: async () => ({ busy: true }) })
    const res = await publish(front, { gateReceipt: GREEN_RECEIPT, confirm: VERSION })
    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('in flight')
  })

  it('a publisher that refuses says why, and nothing is announced as having shipped', async () => {
    const { front, emitted } = mkFront({ publishResult: { ok: false, reason: 'отметка ворот: верб отказал' } })
    const res = await publish(front, { gateReceipt: GREEN_RECEIPT, confirm: VERSION })
    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('отметка ворот')
    expect(emitted.filter((e) => e.event === 'ship.published')).toEqual([])
  })

  it('a publisher that THROWS is a 409 with its words, never a 500 and never a half-claim', async () => {
    const { front, emitted } = mkFront({
      publishRelease: async () => {
        throw new Error('рабочее дерево грязное')
      },
    })
    const res = await publish(front, { gateReceipt: GREEN_RECEIPT, confirm: VERSION })
    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('грязное')
    expect(emitted.filter((e) => e.event === 'ship.published')).toEqual([])
  })
})

// ═══════════════ A WORKER HAS NO PATH TO THIS DOOR ═══════════════

describe('the release doors — A WORKER HAS NO PATH TO THIS DOOR', () => {
  it('the tick is assembled from an object that names NEITHER release collaborator', () => {
    const main = readFileSync(fileURLToPath(new URL('../src/main.mjs', import.meta.url)), 'utf8')
    const start = main.indexOf('const tickDeps = {')
    expect(start).toBeGreaterThan(0)
    // the tick's own dependency literal, up to the line that closes it
    const tickDeps = main.slice(start, main.indexOf('\n  }', start))
    for (const name of ['publishRelease', 'runShipGate', 'verifyGateReceipt', 'releaseVersion']) {
      expect(tickDeps).not.toContain(name)
    }
  })

  it('the publication is not reachable through the verb runner of a task', () => {
    const main = readFileSync(fileURLToPath(new URL('../src/main.mjs', import.meta.url)), 'utf8')
    // `verbRunner` is the MERGE runner, and merging is local. A door that a task's runner
    // could reach would make «работник не получает выката» a comment instead of a shape.
    const verbRunnerLine = main.split('\n').find((l) => l.includes('verbRunner: (m) =>')) ?? ''
    expect(verbRunnerLine, 'the door closure that calls the merge ritual was not found at all').not.toBe('')
    expect(verbRunnerLine).toContain('runMerge')
    expect(verbRunnerLine).not.toContain('publish')
    // A THIRD CLAIM, and the one whose absence let a hole sit here in plain sight: the line
    // must hand the ritual a runner that PRODUCTION has. It used to pass an injection slot
    // straight through, so on a daemon built the way production builds it the gate ran no
    // tests at all — while this very case stayed green, because a line can name a merge and
    // still hand it nothing to run.
    expect(verbRunnerLine, 'the merge ritual is handed a test runner that production wires').toContain(
      'mergeTestRunner',
    )
  })

  it('the receipt formats are exported as WORDS, so a reader greps the format not an example', () => {
    expect(SHIP_GATE_RECEIPT_FORMAT).toBe('ship-gate:<run>')
    expect(SHIP_PUBLISH_RECEIPT_FORMAT).toBe('ship-publish:<version>@<run>')
  })
})

// ═══════════════ THE SLOTS ARE FILLED ═══════════════

describe('the last two slots — THE SLOTS ARE FILLED', () => {
  it('PENDING_ROUTES is EMPTY: every declared route of the release is a live door', () => {
    expect(PENDING_ROUTES.size).toBe(0)
  })

  it('a daemon wired with neither collaborator answers 501 — «not available here»', async () => {
    const bare = createFrontServer({ config: { token: TOKEN }, deps: {} })
    expect((await gate(bare)).statusCode).toBe(501)
    expect((await publish(bare, { gateReceipt: GREEN_RECEIPT, confirm: VERSION })).statusCode).toBe(501)
  })

  it('both doors are auth-gated exactly like every other', async () => {
    const { front } = mkFront()
    for (const url of ['/api/ship/gate', '/api/ship/publish']) {
      const res = mkRes()
      await front.handle(mkReq({ method: 'POST', url, body: {}, headers: { 'content-type': 'application/json' } }), res)
      expect(res.statusCode).toBe(401)
    }
  })
})
