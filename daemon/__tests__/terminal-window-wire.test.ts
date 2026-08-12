/**
 * THE WIRE, NOT THE ARITHMETIC.
 *
 * The window figure a person reads on his own status line arrives on the status line command's
 * stdin, and every hop between there and the screen is a place it can be dropped — it WAS being
 * dropped, at the very first one, by an adapter that parsed the payload and kept two display
 * extras out of it. A test that only checked the parsing, or only checked the window store,
 * would have gone green through all of that.
 *
 * So this file drives the whole run in one go, with no stubs between the ends:
 *
 *   the provider's own stdin JSON
 *     → parseStatusStdin            (scripts/sma/lib/statusline.mjs — the quarantined adapter)
 *     → recordTerminalWindows       (the durable snapshot, in the daemon's window store)
 *     → terminalWindowState         (daemon/src/policy/windows.mjs — the read side)
 *     → deriveState via GET /api/state, through the real front server and its real auth
 *
 * and asserts the two percentages the terminal showed come out the far end. The seam between
 * the last two hops is wired here EXACTLY as the composition root wires it, so this test fails
 * if that wiring is removed.
 *
 * The rest of the file is the honesty of the empty cases, which matter as much as the number:
 * a window whose reset has passed must go quiet and name the moment of the last reading, and a
 * machine that has never reported must say so — because a zero on this screen is read as «the
 * quota is free», which is the one wrong answer that looks like an answer.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import {
  parseStatusStdin,
  recordTerminalWindows,
  resolveDaemonDataDir,
  TERMINAL_WINDOWS_FILE as WRITER_FILE,
} from '../../scripts/sma/lib/statusline.mjs'
import { terminalWindowState, TERMINAL_WINDOWS_FILE as READER_FILE } from '../src/policy/windows.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { deriveState } from '../src/front/state.mjs'

const TOKEN = 'b'.repeat(64)
const NOW = Date.parse('2026-08-12T13:07:00.000Z')

const tmps: string[] = []
function mkDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sma-terminal-window-'))
  tmps.push(dir)
  return dir
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true })
})

/**
 * What Claude Code pipes to a statusLine command on a subscription, after the first model reply
 * of a session — the documented shape, with the two figures the founder's own line was showing:
 * «5h 7% (3h 12m left) | 7d 58% (5d 2h left)». `resets_at` is Unix SECONDS.
 */
const VENDOR_STDIN = JSON.stringify({
  hook_event_name: 'Status',
  session_id: 'abc-123',
  model: { id: 'claude-opus-4-1', display_name: 'Opus' },
  workspace: { current_dir: '/repo', project_dir: '/repo' },
  rate_limits: {
    five_hour: { used_percentage: 7, resets_at: Math.floor(Date.parse('2026-08-12T16:19:00.000Z') / 1000) },
    seven_day: { used_percentage: 58, resets_at: Math.floor(Date.parse('2026-08-17T15:07:00.000Z') / 1000) },
  },
})

// ── the front server, driven with fake req/res (no socket) ──

function mkReq(url: string) {
  const req: any = Readable.from([])
  req.method = 'GET'
  req.url = url
  req.headers = { authorization: `Bearer ${TOKEN}` }
  req.socket = { remoteAddress: '127.0.0.1' }
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
    setHeader(k: string, v: any) {
      res.headers[k.toLowerCase()] = v
    },
    getHeader(k: string) {
      return res.headers[k.toLowerCase()]
    },
    write(c: any) {
      res.body += String(c)
      return true
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      res.ended = true
      return res
    },
  }
  return res
}

/** GET /api/state off a server wired to a data dir the way the composition root wires it. */
async function stateFrom(dataDir: string, now = NOW) {
  const front = createFrontServer({
    config: { token: TOKEN, workers: [{ id: 'local-1', lane: 'prod', account: { name: 'local-1' } }] },
    deps: {
      deriveState,
      adapter: { list: async () => [] },
      // the SAME closure main.mjs builds — if that wiring is dropped, this test goes red
      terminalWindows: () => terminalWindowState({ clock: () => now, dataDir }),
      clock: () => now,
    },
  })
  const res = mkRes()
  await front.handle(mkReq('/api/state'), res)
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body)
}

// ══════════════════════════════ the whole run ══════════════════════════════

describe('the terminal window reading — provider stdin all the way to /api/state', () => {
  it('carries the two percentages, their resets and the moment they were read', async () => {
    const dataDir = mkDataDir()

    const parsed = parseStatusStdin(VENDOR_STDIN)
    recordTerminalWindows({ rateLimits: parsed.rateLimits, dataDir, clock: () => NOW })

    const payload = await stateFrom(dataDir)

    expect(payload.spend.terminal.observed).toBe(true)
    expect(payload.spend.terminal.fiveHour).toEqual({
      status: 'open',
      resetsAt: '2026-08-12T16:19:00.000Z',
      pct: 7,
    })
    expect(payload.spend.terminal.week).toEqual({
      status: 'open',
      resetsAt: '2026-08-17T15:07:00.000Z',
      pct: 58,
    })
    expect(payload.spend.terminal.observedAt).toBe('2026-08-12T13:07:00.000Z')
  })

  it('does not put the terminal\'s reading on any account row — nothing on that stdin names an account', async () => {
    const dataDir = mkDataDir()
    recordTerminalWindows({ rateLimits: parseStatusStdin(VENDOR_STDIN).rateLimits, dataDir, clock: () => NOW })

    const payload = await stateFrom(dataDir)
    for (const account of payload.spend.accounts) {
      expect(account.fiveHour.pct).toBeNull()
      expect(account.week.pct).toBeNull()
    }
  })

  it('goes quiet past the reset and still names the last reading — never back to zero', async () => {
    const dataDir = mkDataDir()
    recordTerminalWindows({ rateLimits: parseStatusStdin(VENDOR_STDIN).rateLimits, dataDir, clock: () => NOW })

    // a day later: both windows the reading described have long since rolled over
    const payload = await stateFrom(dataDir, NOW + 6 * 24 * 60 * 60 * 1000)

    expect(payload.spend.terminal.observed).toBe(true)
    expect(payload.spend.terminal.fiveHour).toEqual({ status: 'unknown', resetsAt: null, pct: null })
    expect(payload.spend.terminal.week).toEqual({ status: 'unknown', resetsAt: null, pct: null })
    // the screen has to say WHEN, so the moment survives the expiry
    expect(payload.spend.terminal.observedAt).toBe('2026-08-12T13:07:00.000Z')
  })

  it('says «never heard» when no snapshot was ever laid down', async () => {
    const payload = await stateFrom(mkDataDir())
    expect(payload.spend.terminal).toEqual({
      observed: false,
      observedAt: null,
      fiveHour: { status: 'unknown', resetsAt: null, pct: null },
      week: { status: 'unknown', resetsAt: null, pct: null },
    })
  })

  it('a daemon assembled without the seam answers honestly empty instead of failing', async () => {
    const front = createFrontServer({
      config: { token: TOKEN, workers: [] },
      deps: { deriveState, adapter: { list: async () => [] }, clock: () => NOW },
    })
    const res = mkRes()
    await front.handle(mkReq('/api/state'), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).spend.terminal.observed).toBe(false)
  })
})

// ══════════════════════════ the adapter's own promises ══════════════════════════

describe('parseStatusStdin — the rate-limit reading', () => {
  it('reads the documented snake_case shape and turns seconds into a real moment', () => {
    const out = parseStatusStdin(VENDOR_STDIN)
    expect(out.rateLimits).toEqual({
      five_hour: { usedPercentage: 7, resetsAt: Date.parse('2026-08-12T16:19:00.000Z') },
      seven_day: { usedPercentage: 58, resetsAt: Date.parse('2026-08-17T15:07:00.000Z') },
    })
  })

  it('tolerates camelCase and a value already in milliseconds', () => {
    const raw = JSON.stringify({
      rateLimits: { fiveHour: { usedPercentage: 12, resetsAt: Date.parse('2026-08-12T16:19:00.000Z') } },
    })
    expect(parseStatusStdin(raw).rateLimits).toEqual({
      five_hour: { usedPercentage: 12, resetsAt: Date.parse('2026-08-12T16:19:00.000Z') },
    })
  })

  it('invents nothing: no rate_limits key, no reading — and a plan without one is normal', () => {
    const raw = JSON.stringify({ model: { display_name: 'Opus' } })
    expect(parseStatusStdin(raw).rateLimits).toBeUndefined()
    expect(parseStatusStdin('not json').rateLimits).toBeUndefined()
    expect(parseStatusStdin('').rateLimits).toBeUndefined()
  })
})

describe('recordTerminalWindows — the durable snapshot', () => {
  it('drops a reading that cannot be dated: a percentage that never expires is worse than silence', () => {
    const dataDir = mkDataDir()
    const written = recordTerminalWindows({
      rateLimits: { five_hour: { usedPercentage: 40 } },
      dataDir,
      clock: () => NOW,
    })
    expect(written).toBeNull()
    expect(terminalWindowState({ dataDir, clock: () => NOW }).observed).toBe(false)
  })

  it('merges: a payload naming one window never deletes what is known about the other', () => {
    const dataDir = mkDataDir()
    recordTerminalWindows({ rateLimits: parseStatusStdin(VENDOR_STDIN).rateLimits, dataDir, clock: () => NOW })
    recordTerminalWindows({
      rateLimits: { five_hour: { usedPercentage: 9, resetsAt: Date.parse('2026-08-12T16:19:00.000Z') } },
      dataDir,
      clock: () => NOW + 60_000,
    })

    const state = terminalWindowState({ dataDir, clock: () => NOW + 60_000 })
    expect(state.fiveHour.pct).toBe(9)
    expect(state.week.pct).toBe(58) // still there
  })

  it('is throttled: an unchanged reading is not rewritten on every turn, but is re-stamped', () => {
    const dataDir = mkDataDir()
    const limits = parseStatusStdin(VENDOR_STDIN).rateLimits
    recordTerminalWindows({ rateLimits: limits, dataDir, clock: () => NOW })

    expect(recordTerminalWindows({ rateLimits: limits, dataDir, clock: () => NOW + 5_000 })).toBeNull()

    const restamped = recordTerminalWindows({ rateLimits: limits, dataDir, clock: () => NOW + 90_000 })
    expect(restamped).not.toBeNull()
    expect(terminalWindowState({ dataDir, clock: () => NOW + 90_000 }).observedAt).toBe(
      new Date(NOW + 90_000).toISOString(),
    )
  })

  it('a full window reads as exhausted, not as a bar that happens to be long', () => {
    const dataDir = mkDataDir()
    recordTerminalWindows({
      rateLimits: { five_hour: { usedPercentage: 100, resetsAt: Date.parse('2026-08-12T16:19:00.000Z') } },
      dataDir,
      clock: () => NOW,
    })
    expect(terminalWindowState({ dataDir, clock: () => NOW }).fiveHour.status).toBe('exhausted')
  })

  it('writes where the daemon reads: one filename, carried by both sides of the contract', () => {
    expect(WRITER_FILE).toBe(READER_FILE)
    const dataDir = mkDataDir()
    recordTerminalWindows({ rateLimits: parseStatusStdin(VENDOR_STDIN).rateLimits, dataDir, clock: () => NOW })
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'windows', READER_FILE), 'utf8'))
    expect(onDisk.source).toBe('statusline')
    expect(onDisk.observed.five_hour.utilization).toBeCloseTo(0.07, 6)
  })

  it('writes nothing at all when no daemon is configured on this machine', () => {
    const home = mkDataDir() // an empty home: no ~/.sma-daemon/config.json in it
    expect(resolveDaemonDataDir({ env: {}, homedirFn: () => home })).toBeNull()
    expect(recordTerminalWindows({ rateLimits: parseStatusStdin(VENDOR_STDIN).rateLimits, dataDir: null })).toBeNull()
  })
})
