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
 *     → windowState                 (the same store, read as the ACCOUNT that owns it)
 *     → deriveState via GET /api/state, through the real front server and its real auth
 *
 * and asserts the two percentages the terminal showed come out the far end — both on the
 * terminal's own block and on the WORKER ROW «Команда» draws its card from. Both seams are
 * wired here EXACTLY as the composition root wires them, so this test fails if either is
 * removed.
 *
 * THE HOP THAT WAS MISSING WAS NOT A CALCULATION, IT WAS A NAME. The reading reached the store
 * and stopped there: nothing in the payload said which account it belonged to, so every card
 * said «нет данных» while a fresh measurement of that very subscription lay one file away. The
 * config directory is that name — the daemon hands it to the sessions it spawns, the status
 * line records the one it is signed into, and equal directories are the same subscription. So
 * the attribution tests here are the point of the file: it travels on a match, and on nothing
 * else.
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
import {
  terminalWindowState,
  windowState,
  markWindowObserved,
  TERMINAL_WINDOWS_FILE as READER_FILE,
} from '../src/policy/windows.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { deriveState } from '../src/front/state.mjs'

const TOKEN = 'b'.repeat(64)
const NOW = Date.parse('2026-08-12T13:07:00.000Z')

/** The config directory the daemon hands this account's sessions — and the whole of the identity. */
const ACCOUNT_DIR = 'C:\\Users\\owner\\.sma-accounts\\local-1'
/** A second account's directory: the same machine, a different subscription. */
const OTHER_DIR = 'C:\\Users\\owner\\.sma-accounts\\max-2'

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

/**
 * GET /api/state off a server wired to a data dir the way the composition root wires it —
 * BOTH window seams, because the two answer different questions off the same store: one what
 * the terminal said, one what is known about the account a worker rides.
 *
 * `configDir` is the account profile's own, exactly as it stands in a real daemon config; a
 * call that omits it drives the case of an account that carries no identity at all.
 */
async function stateFrom(dataDir: string, now = NOW, configDir?: string) {
  const account = { name: 'local-1', ...(configDir ? { configDir } : {}) }
  const front = createFrontServer({
    config: { token: TOKEN, workers: [{ id: 'local-1', lane: 'prod', account }] },
    deps: {
      deriveState,
      adapter: { list: async () => [] },
      // the SAME closures main.mjs builds — if that wiring is dropped, this test goes red
      windows: (subject: any) =>
        windowState({ account: subject && subject.account ? subject.account : subject, clock: () => now, dataDir }),
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

  it('reaches the WORKER CARD of the account the terminal is signed into — the two lines carry numbers', async () => {
    const dataDir = mkDataDir()
    const parsed = parseStatusStdin(VENDOR_STDIN)
    recordTerminalWindows({
      rateLimits: parsed.rateLimits,
      dataDir,
      clock: () => NOW,
      env: { CLAUDE_CONFIG_DIR: ACCOUNT_DIR }, // the session that rendered the status line
    })

    const payload = await stateFrom(dataDir, NOW, ACCOUNT_DIR)

    // «Команда» draws the card off this row: both windows, said and numbered
    const [worker] = payload.workers
    expect(worker.window.fiveHour).toEqual({
      status: 'open',
      resetsAt: '2026-08-12T16:19:00.000Z',
      pct: 7,
      source: 'terminal', // said by another mouth, and the payload says so
    })
    expect(worker.window.week).toEqual({
      status: 'open',
      resetsAt: '2026-08-17T15:07:00.000Z',
      pct: 58,
      source: 'terminal',
    })
    // the «Аккаунты»/«Расходы» row rides the same read
    expect(payload.spend.accounts[0].fiveHour.pct).toBe(7)
    expect(payload.spend.accounts[0].week.pct).toBe(58)
  })

  it('does NOT reach an account signed into a different config directory — that is another plan', async () => {
    const dataDir = mkDataDir()
    recordTerminalWindows({
      rateLimits: parseStatusStdin(VENDOR_STDIN).rateLimits,
      dataDir,
      clock: () => NOW,
      env: { CLAUDE_CONFIG_DIR: OTHER_DIR },
    })

    const payload = await stateFrom(dataDir, NOW, ACCOUNT_DIR)

    // «нет данных» — and NOT a zero, which would read as «the quota is free»
    expect(payload.workers[0].window.fiveHour).toEqual({ status: 'unknown', resetsAt: null, pct: null })
    expect(payload.workers[0].window.week).toEqual({ status: 'unknown', resetsAt: null, pct: null })
    // …while the terminal's own block still states the reading, under its own name
    expect(payload.spend.terminal.fiveHour.pct).toBe(7)
  })

  it('does NOT reach an account that carries no config directory — an absent identity matches nothing', async () => {
    const dataDir = mkDataDir()
    recordTerminalWindows({
      rateLimits: parseStatusStdin(VENDOR_STDIN).rateLimits,
      dataDir,
      clock: () => NOW,
      env: { CLAUDE_CONFIG_DIR: ACCOUNT_DIR },
    })

    const payload = await stateFrom(dataDir) // the account profile names no directory
    expect(payload.workers[0].window.fiveHour.pct).toBeNull()
    expect(payload.workers[0].window.week.pct).toBeNull()
    expect(payload.workers[0].window.fiveHour.status).toBe('unknown')
  })

  it('an account nothing has been heard about anywhere still says «нет данных», never zero', async () => {
    const payload = await stateFrom(mkDataDir(), NOW, ACCOUNT_DIR) // no snapshot, no account file
    expect(payload.workers[0].window.fiveHour).toEqual({ status: 'unknown', resetsAt: null, pct: null })
    expect(payload.workers[0].window.week).toEqual({ status: 'unknown', resetsAt: null, pct: null })
  })

  /**
   * THE ACCOUNT'S OWN WORD IS NEVER DISPLACED. The refusal on the work stream is about THIS
   * account by construction; a friendlier status-line reading of the same plan, taken a minute
   * earlier, must not talk over it — the borrowed reading fills silence and nothing else.
   */
  it('fills only the silent window: a reading the account itself carries keeps its place', async () => {
    const dataDir = mkDataDir()
    markWindowObserved({
      dataDir,
      accountName: 'local-1',
      observation: { limitType: 'five_hour', status: 'rejected', resetsAt: Date.parse('2026-08-12T16:19:00.000Z') },
      clock: () => NOW,
    })
    recordTerminalWindows({
      rateLimits: parseStatusStdin(VENDOR_STDIN).rateLimits,
      dataDir,
      clock: () => NOW,
      env: { CLAUDE_CONFIG_DIR: ACCOUNT_DIR },
    })

    const payload = await stateFrom(dataDir, NOW, ACCOUNT_DIR)
    const win = payload.workers[0].window
    expect(win.fiveHour.status).toBe('exhausted') // the refusal stands
    expect(win.fiveHour.pct).toBeNull() // and it is not dressed up with somebody else's number
    expect(win.fiveHour.source).toBeUndefined() // an account's own reading is unlabelled
    expect(win.week.pct).toBe(58) // the window it said nothing about is filled
    expect(payload.workers[0].presence).toBe('ждёт окно') // and a refusal still stops the routing
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

  it('writes down WHOSE plan it is — the config directory the session is signed into', () => {
    const dataDir = mkDataDir()
    recordTerminalWindows({
      rateLimits: parseStatusStdin(VENDOR_STDIN).rateLimits,
      dataDir,
      clock: () => NOW,
      env: { CLAUDE_CONFIG_DIR: ACCOUNT_DIR },
    })
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'windows', READER_FILE), 'utf8'))
    expect(onDisk.configDir).toBe(ACCOUNT_DIR)
  })

  it('falls back to the default config directory, the way Claude Code itself resolves it', () => {
    const dataDir = mkDataDir()
    recordTerminalWindows({
      rateLimits: parseStatusStdin(VENDOR_STDIN).rateLimits,
      dataDir,
      clock: () => NOW,
      env: {},
      homedirFn: () => 'C:\\Users\\owner',
    })
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'windows', READER_FILE), 'utf8'))
    expect(onDisk.configDir).toBe(join('C:\\Users\\owner', '.claude'))
  })

  /**
   * A RECORD IS ONE TERMINAL'S, WHOLE. Merging a second account's reading into the first
   * account's leftovers would produce a file that is half one plan and half another while its
   * single `configDir` field claims to name the writer — which is precisely the misattribution
   * that field was added to make impossible.
   */
  it('a reading from another config directory replaces rather than joins', () => {
    const dataDir = mkDataDir()
    recordTerminalWindows({
      rateLimits: parseStatusStdin(VENDOR_STDIN).rateLimits, // five_hour AND seven_day
      dataDir,
      clock: () => NOW,
      env: { CLAUDE_CONFIG_DIR: ACCOUNT_DIR },
    })
    recordTerminalWindows({
      rateLimits: { five_hour: { usedPercentage: 3, resetsAt: Date.parse('2026-08-12T17:00:00.000Z') } },
      dataDir,
      clock: () => NOW + 1000,
      env: { CLAUDE_CONFIG_DIR: OTHER_DIR },
    })

    const onDisk = JSON.parse(readFileSync(join(dataDir, 'windows', READER_FILE), 'utf8'))
    expect(onDisk.configDir).toBe(OTHER_DIR)
    expect(Object.keys(onDisk.observed)).toEqual(['five_hour']) // the first account's week is gone
    expect(terminalWindowState({ dataDir, clock: () => NOW + 1000 }).week.status).toBe('unknown')
  })

  it('the throttle survives the new field: an unchanged reading from the same terminal is not rewritten', () => {
    const dataDir = mkDataDir()
    const limits = parseStatusStdin(VENDOR_STDIN).rateLimits
    const env = { CLAUDE_CONFIG_DIR: ACCOUNT_DIR }
    recordTerminalWindows({ rateLimits: limits, dataDir, clock: () => NOW, env })
    expect(recordTerminalWindows({ rateLimits: limits, dataDir, clock: () => NOW + 5_000, env })).toBeNull()
  })

  it('writes nothing at all when no daemon is configured on this machine', () => {
    const home = mkDataDir() // an empty home: no ~/.sma-daemon/config.json in it
    expect(resolveDaemonDataDir({ env: {}, homedirFn: () => home })).toBeNull()
    expect(recordTerminalWindows({ rateLimits: parseStatusStdin(VENDOR_STDIN).rateLimits, dataDir: null })).toBeNull()
  })
})
