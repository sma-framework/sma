/**
 * Tests for daemon/src/control.mjs — the штатные stop and restart.
 *
 * WHAT IS ACTUALLY AT RISK HERE, and therefore what these cases are about:
 *
 *   1. KILLING THE WRONG PROCESS. The daemon runs as `node`, and so does half of a
 *      developer's machine. Every case below drives the stop through an injected `signal`
 *      spy and asserts WHICH pid it reached — and, more often, that it reached nobody: a
 *      record naming another door, a record whose process is gone, no record at all. There
 *      is also one case with no seams in it at all, reading the module's own source: no
 *      process-table verb may appear in it, because a kill-by-name cannot be caught by a
 *      behavioural test that never gives the module a process table to walk.
 *   2. AN ABSENCE REPORTED AS A FAILURE. «Stop» asks for a state. A machine already in that
 *      state must exit 0, or every script around it learns to ignore the exit code.
 *   3. A RESTART THAT REPORTS ON THE SPAWN. The boot failure worth catching (an unreachable
 *      queue) happens after the process starts and before the door opens, so the restart is
 *      asserted on the DOOR: it waits, and it says which way it ended.
 *   4. WORK KILLED IN SILENCE. A live attempt loses its turn, its tokens and its receipt when
 *      the daemon dies, so the refusal-without---force is a case, and so is the fact that
 *      --force goes through and says it did.
 *
 * Nothing real is touched: no socket is opened, no process is signalled, no clock waits. The
 * record cases use a temp directory and the real filesystem, because «what did it leave on
 * disk» is the whole question there.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  stopDaemon,
  restartDaemon,
  liftCommand,
  identifyProcess,
  liveWork,
  doorUrl,
  exitCodeFor,
  pidRecordPath,
  writePidRecord,
  readPidRecord,
  clearPidRecord,
  PID_RECORD_FILE,
} from '../src/control.mjs'

const CONFIG = { bind: '127.0.0.1', port: 7777, token: 'a'.repeat(64) }

/** A door that answers 200 with the given state (null = «answered, said nothing readable»). */
const doorUp = (state: any = { workers: [] }) => async () => ({
  answered: true,
  status: 200,
  state,
  reason: '',
})
/** A door nobody is behind. */
const doorDown = () => async () => ({ answered: false, status: 0, state: null, reason: 'ECONNREFUSED' })

/** A clock and a sleep that agree with each other and never wait. */
function fakeTime(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    },
  }
}

/** The seams every stop case shares: a signal spy, a record, a liveness table. */
function harness(o: any = {}) {
  const signalled: Array<{ pid: number; sig: string }> = []
  const cleared: number[] = []
  const alive = new Set<number>(o.alive ?? [])
  const time = fakeTime()
  return {
    signalled,
    cleared,
    alive,
    time,
    deps: {
      config: o.config ?? CONFIG,
      force: o.force ?? false,
      probe: o.probe ?? doorDown(),
      readRecord: () => (o.record === undefined ? null : o.record),
      clearRecord: () => {
        cleared.push(1)
      },
      isAlive: (pid: number) => alive.has(pid),
      signal: (pid: number, sig: string) => {
        signalled.push({ pid, sig })
        if (o.survivesTerm && sig === 'SIGTERM') return
        if (o.survivesKill) return
        alive.delete(pid)
      },
      sleep: time.sleep,
      now: time.now,
      graceMs: o.graceMs ?? 1000,
      killWaitMs: 500,
      pollMs: 100,
    },
  }
}

const RECORD = { pid: 4242, bind: '127.0.0.1', port: 7777, startedAt: '2026-08-27T00:00:00.000Z', path: '/tmp/x' }

describe('stop — finding OUR process', () => {
  it('signals exactly the recorded pid when the record agrees with the door in the config', async () => {
    const h = harness({ record: RECORD, alive: [4242], probe: doorUp() })
    const res = await stopDaemon(h.deps)

    expect(res.outcome).toBe('stopped')
    expect(res.code).toBe(0)
    expect(h.signalled).toEqual([{ pid: 4242, sig: 'SIGTERM' }])
    expect(res.lines.join(' ')).toContain('4242')
    expect(h.cleared.length).toBe(1) // the card is taken back down
  })

  it('refuses a record that names ANOTHER door, and signals nobody', async () => {
    const foreign = { ...RECORD, pid: 999, port: 8888 }
    const h = harness({ record: foreign, alive: [999], probe: doorUp() })
    const res = await stopDaemon(h.deps)

    expect(res.outcome).toBe('unnamed')
    expect(res.code).toBe(1)
    expect(h.signalled).toEqual([])
    expect(res.lines.join(' ')).toContain('8888')
  })

  it('refuses when the door answers and NO record exists — a guess is not an identification', async () => {
    const h = harness({ record: null, probe: doorUp() })
    const res = await stopDaemon(h.deps)

    expect(res.outcome).toBe('unnamed')
    expect(res.code).toBe(1)
    expect(h.signalled).toEqual([])
    // The refusal has to say what to do next, or it is just a wall.
    expect(res.lines.join(' ')).toMatch(/супервизор/i)
  })

  it('refuses when the door answers but the recorded process is dead — somebody else holds it', async () => {
    const h = harness({ record: RECORD, alive: [], probe: doorUp() })
    const res = await stopDaemon(h.deps)

    expect(res.outcome).toBe('unnamed')
    expect(h.signalled).toEqual([])
    expect(h.cleared.length).toBe(1) // the stale record is swept even when nothing is killed
  })

  it('identifyProcess is a pure decision over the record and the door — never over a name', () => {
    expect(identifyProcess({ config: CONFIG, record: RECORD, isAlive: () => true })).toEqual({ pid: 4242, refusal: '' })
    expect(identifyProcess({ config: CONFIG, record: null, isAlive: () => true }).refusal).toBe('no-record')
    expect(identifyProcess({ config: CONFIG, record: { ...RECORD, port: 1 }, isAlive: () => true }).refusal).toBe(
      'other-door',
    )
    expect(identifyProcess({ config: CONFIG, record: RECORD, isAlive: () => false }).refusal).toBe('gone')
  })

  it('the module contains NO process-table hunt — the defect a behavioural test cannot reach', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/control.mjs', import.meta.url)), 'utf8')
    // A stop that matched a binary name would need one of these to do it. None may appear —
    // and the check is on the whole file, comments included, so a helper cannot creep in
    // behind a «temporarily» in a comment either.
    for (const verb of ['tasklist', 'taskkill', 'pkill', 'killall', 'wmic', 'netstat', 'lsof', 'ps -ef', 'ps aux']) {
      expect(src.toLowerCase().includes(verb), `control.mjs mentions ${verb}`).toBe(false)
    }
  })
})

describe('stop — an absence is a calm success', () => {
  it('nothing running, nothing recorded → exits 0 and says so', async () => {
    const h = harness({ record: null, probe: doorDown() })
    const res = await stopDaemon(h.deps)

    expect(res.outcome).toBe('not-running')
    expect(res.code).toBe(0)
    expect(h.signalled).toEqual([])
    expect(res.lines.join(' ')).toContain('уже не работает')
  })

  it('a stale record with a silent door is swept, and still exits 0', async () => {
    const h = harness({ record: RECORD, alive: [], probe: doorDown() })
    const res = await stopDaemon(h.deps)

    expect(res.outcome).toBe('not-running')
    expect(res.code).toBe(0)
    expect(h.cleared.length).toBe(1)
    expect(h.signalled).toEqual([])
  })

  it('a process that ends between the look and the signal is not an error either', async () => {
    const h = harness({ record: RECORD, alive: [4242], probe: doorUp() })
    h.deps.signal = () => {
      const err: any = new Error('no such process')
      err.code = 'ESRCH'
      throw err
    }
    const res = await stopDaemon(h.deps)

    expect(res.outcome).toBe('not-running')
    expect(res.code).toBe(0)
  })
})

describe('stop — it waits, and it says what ended it', () => {
  it('escalates to SIGKILL when the polite signal is ignored, and names that', async () => {
    const h = harness({ record: RECORD, alive: [4242], probe: doorUp(), survivesTerm: true })
    const res = await stopDaemon(h.deps)

    expect(res.outcome).toBe('killed')
    expect(res.code).toBe(0)
    expect(h.signalled.map((s) => s.sig)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(res.lines.join(' ')).toContain('SIGKILL')
  })

  it('a process that survives even SIGKILL is a refusal, and the record is KEPT', async () => {
    const h = harness({ record: RECORD, alive: [4242], probe: doorUp(), survivesTerm: true, survivesKill: true })
    const res = await stopDaemon(h.deps)

    expect(res.outcome).toBe('refused')
    expect(res.code).toBe(1)
    expect(h.cleared.length).toBe(0)
  })

  it('a silent door with a live recorded process is stopped, and the blindness is stated', async () => {
    const h = harness({ record: RECORD, alive: [4242], probe: doorDown() })
    const res = await stopDaemon(h.deps)

    expect(res.outcome).toBe('stopped')
    expect(h.signalled).toEqual([{ pid: 4242, sig: 'SIGTERM' }])
    expect(res.lines.join(' ')).toContain('спросить некого')
  })
})

describe('stop — a live attempt is work', () => {
  const busyState = {
    workers: [
      { id: 'max-1', taskId: 'R-77', taskTitle: 'ночная задача' },
      { id: 'max-2' },
    ],
  }

  it('refuses while a worker holds a task, names it, and signals nobody', async () => {
    const h = harness({ record: RECORD, alive: [4242], probe: doorUp(busyState) })
    const res = await stopDaemon(h.deps)

    expect(res.outcome).toBe('live-work')
    expect(res.code).toBe(2) // its own code: a refusal a flag would change
    expect(h.signalled).toEqual([])
    const said = res.lines.join(' ')
    expect(said).toContain('R-77')
    expect(said).toContain('--force')
  })

  it('--force goes through, and SAYS which work it is killing', async () => {
    const h = harness({ record: RECORD, alive: [4242], probe: doorUp(busyState), force: true })
    const res = await stopDaemon(h.deps)

    expect(res.outcome).toBe('stopped')
    expect(h.signalled).toEqual([{ pid: 4242, sig: 'SIGTERM' }])
    expect(res.lines.join(' ')).toContain('R-77')
  })

  it('a door that answers without a readable state cannot be asked, and says that instead of assuming idle', async () => {
    const probe = async () => ({ answered: true, status: 401, state: null, reason: '' })
    const h = harness({ record: RECORD, alive: [4242], probe })
    const res = await stopDaemon(h.deps)

    expect(res.outcome).toBe('stopped')
    expect(res.lines.join(' ')).toContain('вслепую')
  })

  it('liveWork reads the roster, which is the one list naming a held task', () => {
    expect(liveWork(busyState)).toEqual([{ worker: 'max-1', taskId: 'R-77', title: 'ночная задача' }])
    expect(liveWork({ workers: [] })).toEqual([])
    expect(liveWork(null)).toEqual([])
  })
})

describe('restart — the door is the verdict', () => {
  /** A probe that is down for the first `downFor` knocks and up afterwards. */
  function risingDoor(downFor: number) {
    let n = 0
    return async () => {
      n += 1
      return n <= downFor
        ? { answered: false, status: 0, state: null, reason: 'ECONNREFUSED' }
        : { answered: true, status: 200, state: { workers: [] }, reason: '' }
    }
  }

  it('stops, lifts, waits for the door and reports that it came up', async () => {
    const lifted: any[] = []
    const time = fakeTime()
    const res = await restartDaemon({
      config: CONFIG,
      // the stop's own probe answers first (the daemon is up), then the lift's knocks
      probe: risingDoor(3),
      stop: async () => ({ outcome: 'stopped', lines: ['остановлен'], code: 0 }),
      lift: { cmd: 'node', args: ['main.mjs'], cwd: '.' },
      spawnLift: (l: any) => lifted.push(l),
      sleep: time.sleep,
      now: time.now,
      pollMs: 500,
      doorTimeoutMs: 30000,
    })

    expect(res.outcome).toBe('up')
    expect(res.code).toBe(0)
    expect(lifted.length).toBe(1)
    const said = res.lines.join(' ')
    expect(said).toContain('дверь')
    expect(said).toMatch(/поднялся/)
  })

  it('a lift whose door never answers is a FAILURE, not a success with a spawn in it', async () => {
    const time = fakeTime()
    const res = await restartDaemon({
      config: CONFIG,
      probe: doorDown(),
      stop: async () => ({ outcome: 'not-running', lines: [], code: 0 }),
      lift: { cmd: 'node', args: ['main.mjs'], cwd: '.' },
      spawnLift: () => {},
      sleep: time.sleep,
      now: time.now,
      pollMs: 1000,
      doorTimeoutMs: 5000,
    })

    expect(res.outcome).toBe('no-door')
    expect(res.code).toBe(1)
    expect(res.lines.join(' ')).toContain('не ответила')
  })

  it('does not start a second process when the supervisor already relifted one', async () => {
    const lifted: any[] = []
    const res = await restartDaemon({
      config: CONFIG,
      probe: doorUp(),
      stop: async () => ({ outcome: 'stopped', lines: [], code: 0 }),
      spawnLift: (l: any) => lifted.push(l),
      sleep: async () => {},
      now: () => 0,
    })

    expect(res.outcome).toBe('up-supervised')
    expect(res.code).toBe(0)
    expect(lifted).toEqual([])
  })

  it('a stop that was refused stops the restart too — nothing is lifted over live work', async () => {
    const lifted: any[] = []
    const res = await restartDaemon({
      config: CONFIG,
      probe: doorUp(),
      stop: async () => ({ outcome: 'live-work', lines: ['идёт работа'], code: 2 }),
      spawnLift: (l: any) => lifted.push(l),
      sleep: async () => {},
      now: () => 0,
    })

    expect(res.outcome).toBe('live-work')
    expect(res.code).toBe(2)
    expect(lifted).toEqual([])
    expect(res.lines.join(' ')).toContain('сначала остановка')
  })

  it('the lift is the SUPERVISOR’S own, per platform — never a third way to start', () => {
    const win = liftCommand({ platform: 'win32', smaHome: 'C:/sma' })
    expect(win.cmd).toBe('powershell')
    expect(win.args.join(' ')).toContain('start-daemon-windows.ps1') // the Scheduled Task's target

    const mac = liftCommand({ platform: 'darwin', smaHome: '/Users/worker/sma', nodeBin: '/opt/homebrew/bin/node' })
    expect(mac.cmd).toBe('/opt/homebrew/bin/node')
    expect(mac.args[0]).toContain(join('daemon', 'src', 'main.mjs')) // the plist's ProgramArguments
  })
})

describe('the record on disk', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sma-control-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('states the DOOR it bound, not just a number', () => {
    const config = { ...CONFIG, dataDir: dir }
    const path = writePidRecord({ config, pid: 31337, now: () => Date.parse('2026-08-27T10:00:00Z') })

    expect(path).toBe(join(dir, PID_RECORD_FILE))
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    expect(raw).toMatchObject({ pid: 31337, bind: '127.0.0.1', port: 7777 })
    expect(raw.startedAt).toBe('2026-08-27T10:00:00.000Z')

    const read = readPidRecord({ config })
    expect(read).toMatchObject({ pid: 31337, port: 7777, bind: '127.0.0.1' })

    expect(clearPidRecord({ config })).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(readPidRecord({ config })).toBeNull()
  })

  it('a torn or shapeless record is an ABSENT record, never a throw', () => {
    const config = { ...CONFIG, dataDir: dir }
    const path = pidRecordPath(config)
    writePidRecord({ config, pid: 5 })
    // half a write, the way a machine that lost power leaves one
    rmSync(path, { force: true })
    expect(readPidRecord({ config })).toBeNull()

    writePidRecord({ config, pid: 5 })
    const fsImpl = { readFileSync: () => '{"pid":' }
    expect(readPidRecord({ config, fsImpl })).toBeNull()
    expect(readPidRecord({ config, fsImpl: { readFileSync: () => '{"pid":"нет"}' } })).toBeNull()
  })
})

describe('the small decisions the commands rest on', () => {
  it('a wildcard bind is REACHED at the loopback — nobody can connect to 0.0.0.0', () => {
    expect(doorUrl({ bind: '0.0.0.0', port: 7777 })).toBe('http://127.0.0.1:7777')
    expect(doorUrl({ bind: '127.0.0.1', port: 7777 })).toBe('http://127.0.0.1:7777')
    expect(doorUrl({ bind: '192.168.1.5', port: 8080 })).toBe('http://192.168.1.5:8080')
  })

  it('the exit codes are a closed contract a script can read', () => {
    expect(exitCodeFor('not-running')).toBe(0)
    expect(exitCodeFor('stopped')).toBe(0)
    expect(exitCodeFor('killed')).toBe(0)
    expect(exitCodeFor('up')).toBe(0)
    expect(exitCodeFor('up-supervised')).toBe(0)
    expect(exitCodeFor('live-work')).toBe(2)
    expect(exitCodeFor('unnamed')).toBe(1)
    expect(exitCodeFor('no-door')).toBe(1)
    expect(exitCodeFor('refused')).toBe(1)
  })
})

describe('the wire — the daemon leaves the card, and takes it back', () => {
  /**
   * A SOURCE assertion, and its limit is stated rather than implied: it proves the calls are
   * written in the composition root, not that a boot performed them. The boot itself needs a
   * live Postgres, so the honest coverage available here is «the wiring exists», exactly as
   * for the collaborators the root sweep checks by construction.
   */
  it('main.mjs writes the record when the door binds and clears it on stop', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/main.mjs', import.meta.url)), 'utf8')
    expect(src).toContain('writePidRecord')
    expect(src).toContain('clearPidRecord')
    // written from INSIDE the listen callback — the record is a claim about a bound address
    expect(src).toMatch(/front\.listen\(\(\)\s*=>\s*\{[\s\S]{0,600}writePidRecord/)
  })
})
