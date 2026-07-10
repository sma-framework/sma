/**
 * Tests for the `sma pre` PreToolUse multiplexer (Phase 9.2 Plan 02).
 *
 * Task 1 — the dispatch core (lib/pre.mjs): behaviors 1-8.
 * Task 2 — the CLI surface (cli.mjs cmdPre / cmdPreBench / legacy delegation): 9-14.
 *
 * Everything is DI so tests never touch the real .sma, never shell out, and never
 * spawn under vitest. The default PRE_CHECKS streams go SILENT when their lib deps
 * are absent (deps = {}), so runPre-logic tests exercise pushed stub streams; the
 * parity test (1) uses the REAL collision module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import * as collision from '../lib/collision.mjs'
import {
  PRE_CHECKS,
  buildCtx,
  runPre,
  mergeOutput,
  appendPerfSample,
  computePercentile,
} from '../lib/pre.mjs'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sma-pre-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** dirs rooted at a throwaway temp .sma so any write lands in temp, never real .sma. */
function tmpDirs() {
  const root = join(tmp, '.sma')
  return {
    smaRoot: root,
    sessionsDir: join(root, 'sessions'),
    claimsDir: join(root, 'claims'),
    journalDir: join(root, 'journal'),
    reflexDir: join(root, 'reflex'),
    gatesDir: join(root, 'gates'),
    perfDir: join(root, 'perf'),
  }
}

/** A ctx with all deps absent (real streams silent) + a null git probe (no shell). */
async function silentCtx(evt: any, over: any = {}) {
  return buildCtx({
    evt,
    dirs: tmpDirs(),
    env: over.env ?? {},
    now: over.now,
    deps: over.deps ?? {},
    headShaProbe: async () => null,
  })
}

/** Restore PRE_CHECKS to its 3 canonical streams after any test mutates it. */
const BASE_LEN = PRE_CHECKS.length
afterEach(() => {
  PRE_CHECKS.length = BASE_LEN
})

describe('Task 1 — dispatch core', () => {
  it('Test 1 (collision parity): merged runPre warns == the legacy single-stream path', async () => {
    const dirs = tmpDirs()
    const other = {
      _file: 'other-terminal.json',
      holderIdentity: 'P9.2 Other',
      scope: { globs: ['scripts/sma/lib/**'] },
    }
    const stubRegistry = {
      resolveTerminalIdentity: () => ({ terminalId: 'me', holderIdentity: 'P9.2 Me' }),
      heartbeat: () => {},
      readSessions: () => ({ sessions: [other], warnings: [] }),
      displayIdentity: ({ holderIdentity }: any) => holderIdentity || '—',
    }
    const evt = {
      session_id: 'w1',
      tool_name: 'Edit',
      tool_input: { file_path: 'scripts/sma/lib/collision.mjs' },
    }
    const ctx = await buildCtx({ evt, dirs, env: {}, deps: { collision, registry: stubRegistry }, headShaProbe: async () => null })

    // legacy single-stream expected: run the collision channel directly.
    const expected = collision
      .checkScopeCollision(['scripts/sma/lib/collision.mjs'], {
        sessions: [other],
        selfTerminalId: 'me',
        root: ctx.repoRoot,
      })
      .map((w: any) => collision.buildWarnText(w))

    const { warns, deny } = await runPre(ctx)
    expect(expected.length).toBeGreaterThan(0) // a real collision fired
    expect(warns).toEqual(expected)
    expect(deny).toBeNull()
  })

  it('Test 2 (deny merge + posture protection): gates denies; a non-gates deny downgrades to a warn', async () => {
    // (a) a mayDeny:true stream surfaces a real deny, carrying collected warns.
    const denyStream = {
      id: 'stub-gate',
      tools: ['Edit'],
      killSwitchEnv: null,
      mayDeny: true,
      run: () => ({ warns: ['gate-warn'], deny: { text: 'DENIED by gate' } }),
    }
    PRE_CHECKS.push(denyStream)
    let ctx = await silentCtx({ tool_name: 'Edit', tool_input: {} })
    let res = await runPre(ctx)
    expect(res.deny).toEqual({ text: 'DENIED by gate' })
    let out = mergeOutput(res)
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('DENIED by gate')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('gate-warn')
    PRE_CHECKS.length = BASE_LEN

    // (b) a mayDeny:false stream returning a deny gets DOWNGRADED to a warn line.
    const rogue = {
      id: 'stub-rogue',
      tools: ['Edit'],
      killSwitchEnv: null,
      mayDeny: false,
      run: () => ({ warns: [], deny: { text: 'should never deny' } }),
    }
    PRE_CHECKS.push(rogue)
    ctx = await silentCtx({ tool_name: 'Edit', tool_input: {} })
    res = await runPre(ctx)
    expect(res.deny).toBeNull()
    expect(res.warns).toContain('should never deny')
    out = mergeOutput(res)
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow')
  })

  it('Test 3 (per-stream fail-open): a throwing stream is recorded error, later streams still run', async () => {
    const thrower = { id: 'boom', tools: ['Edit'], killSwitchEnv: null, mayDeny: false, run: () => { throw new Error('boom') } }
    const after = { id: 'after', tools: ['Edit'], killSwitchEnv: null, mayDeny: false, run: () => ({ warns: ['after-ran'] }) }
    PRE_CHECKS.push(thrower, after)
    const ctx = await silentCtx({ tool_name: 'Edit', tool_input: {} })
    let res: any
    expect(() => { /* runPre never throws */ }).not.toThrow()
    res = await runPre(ctx)
    const boomSample = res.sample.checks.find((c: any) => c.id === 'boom')
    expect(boomSample.error).toBe(true)
    expect(res.warns).toContain('after-ran')
  })

  it('Test 4 (kill-switches): SMA_PRE_DISABLE no-ops all streams; SMA_REFLEX_DISABLE skips only reflex', async () => {
    // SMA_PRE_DISABLE=1 → no stream is invoked at all.
    const spy = vi.fn(() => ({ warns: ['nope'] }))
    PRE_CHECKS.push({ id: 'spy', tools: ['Edit'], killSwitchEnv: null, mayDeny: false, run: spy })
    let ctx = await silentCtx({ tool_name: 'Edit', tool_input: {} }, { env: { SMA_PRE_DISABLE: '1' } })
    let res = await runPre(ctx)
    expect(spy).not.toHaveBeenCalled()
    expect(res.warns).toEqual([])
    expect(res.deny).toBeNull()
    PRE_CHECKS.length = BASE_LEN

    // SMA_REFLEX_DISABLE=1 → the reflex stream is skipped; gates + collision still run.
    const reflexSpy = vi.fn(() => ({ tags: ['x'], target: 't', targetClass: 'c' }))
    const gatesSpy = vi.fn(() => ({ warns: [{ text: 'gate-fired' }], seen: {} }))
    const deps = {
      reflex: { deriveTags: reflexSpy, loadSeen: () => ({ keys: {}, notes: {} }), saveSeen: () => {} },
      loader: {},
      gates: { checkEvent: gatesSpy },
    }
    ctx = await buildCtx({ evt: { tool_name: 'Edit', tool_input: { file_path: 'a/b.ts' } }, dirs: tmpDirs(), env: { SMA_REFLEX_DISABLE: '1' }, deps, headShaProbe: async () => null })
    res = await runPre(ctx)
    expect(reflexSpy).not.toHaveBeenCalled() // reflex stream skipped by its kill-switch
    expect(gatesSpy).toHaveBeenCalledTimes(1) // gates still runs
    expect(res.warns).toContain('gate-fired')
  })

  it('Test 5 (seen-store once): one load, one save, both stream mutations persisted', async () => {
    const loaded = { session: 'w', keys: {}, notes: {} }
    const loadSeen = vi.fn(() => loaded)
    const saveSeen = vi.fn()
    const deps = {
      reflex: {
        loadSeen,
        saveSeen,
        deriveTags: () => ({ tags: ['x'], target: 't', targetClass: 'c' }),
        matchReflexes: () => [{ noteId: 'n', importance: 9 }],
        applyFatigue: (o: any) => {
          o.sessionSeen.keys['reflex::c'] = 1 // mutate the SHARED seen
          return { warns: [{ text: 'reflex-warn', noteId: 'n', tier: 'oneliner' }], seen: o.sessionSeen }
        },
      },
      loader: {},
      gates: {
        checkEvent: (o: any) => {
          o.seen.keys['gate::t'] = 1 // mutate the SAME shared seen
          return { warns: [], seen: o.seen }
        },
      },
      journal: { appendEvent: () => {} },
    }
    const ctx = await buildCtx({ evt: { session_id: 'w', tool_name: 'Edit', tool_input: { file_path: 'a/b.ts' } }, dirs: tmpDirs(), env: {}, deps, headShaProbe: async () => null })
    await runPre(ctx)
    expect(loadSeen).toHaveBeenCalledTimes(1)
    expect(saveSeen).toHaveBeenCalledTimes(1)
    const saved = saveSeen.mock.calls[0][0]
    expect(saved.keys['reflex::c']).toBe(1)
    expect(saved.keys['gate::t']).toBe(1)
  })

  it('Test 6 (soft time-budget): a stream over budget skips the remaining streams', async () => {
    const clock = { t: 0 }
    const now = () => clock.t
    const slow = { id: 'slow', tools: ['Edit'], killSwitchEnv: null, mayDeny: false, run: () => { clock.t += 5000; return { warns: ['slow-warn'] } } }
    const late = { id: 'late', tools: ['Edit'], killSwitchEnv: null, mayDeny: false, run: () => ({ warns: ['late-warn'] }) }
    PRE_CHECKS.push(slow, late)
    const ctx = await silentCtx({ tool_name: 'Edit', tool_input: {} }, { env: { SMA_PRE_BUDGET_MS: '100' }, now })
    const res = await runPre(ctx)
    expect(res.warns).toContain('slow-warn')
    expect(res.warns).not.toContain('late-warn')
    const lateSample = res.sample.checks.find((c: any) => c.id === 'late')
    expect(lateSample.skipped).toBe(true)
  })

  it('Test 7 (ordering + registration contract): warns emit in PRE_CHECKS order; a stub stream registers', async () => {
    const a = { id: 'sa', tools: ['Edit'], killSwitchEnv: null, mayDeny: false, run: () => ({ warns: ['A'] }) }
    const b = { id: 'sb', tools: ['Edit'], killSwitchEnv: 'SMA_STUB_DISABLE', mayDeny: false, run: () => ({ warns: ['B'] }) }
    PRE_CHECKS.push(a, b)
    const ctx = await silentCtx({ tool_name: 'Edit', tool_input: {} })
    const res = await runPre(ctx)
    expect(res.warns).toEqual(['A', 'B']) // registration + array order
  })

  it('Test 8 (percentile math): nearest-rank over 20 known samples', () => {
    const vals = Array.from({ length: 20 }, (_, i) => i + 1) // 1..20
    expect(computePercentile(vals, 95)).toBe(19) // ceil(0.95*20)=19 → index 18 → 19
    expect(computePercentile(vals, 50)).toBe(10)
    expect(computePercentile(vals, 100)).toBe(20)
    expect(computePercentile([], 95)).toBe(0)
  })

  it('appendPerfSample writes one JSONL line via injected fs (no real disk)', () => {
    const writes: string[] = []
    appendPerfSample(
      { ts: 'x', toolName: 'Edit', totalMs: 5, checks: [] },
      { perfDir: '/virtual', appendFn: (_f: string, line: string) => writes.push(line), statFn: () => ({ size: 10 }), mkdirFn: () => {} },
    )
    expect(writes.length).toBe(1)
    expect(JSON.parse(writes[0]).toolName).toBe('Edit')
  })
})

// ─────────────────── Task 2 — CLI surface (via real spawn) ───────────────────
// These shell out to the actual cli.mjs the way the harness does. Kept separate
// from the DI unit tests; each spawns the process-under-test with a temp SMA root.

const CLI = join(__dirname, '..', 'cli.mjs')
function runCli(args: string[], input = '', env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      input,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return { code: 0, stdout }
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: (e.stdout as string) || '' }
  }
}

describe('Task 2 — CLI surface', () => {
  it('Test 9 (hook contract): garbage stdin exits 0 with no output', () => {
    const res = runCli(['pre'], 'not json at all {{{', { SMA_ROOT_OVERRIDE: join(tmp, '.sma') })
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe('')
  })

  it('Test 9b (silent success): empty object stdin exits 0 with no output', () => {
    const res = runCli(['pre'], '{}', { SMA_ROOT_OVERRIDE: join(tmp, '.sma') })
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe('')
  })

  it('Test 10 (single output): pre on a fixture prints at most ONE JSON line', () => {
    const fixture = JSON.stringify({ session_id: 'w', tool_name: 'Write', tool_input: { file_path: join(tmp, 'fresh.txt'), content: 'x' } })
    const res = runCli(['pre'], fixture, { SMA_ROOT_OVERRIDE: join(tmp, '.sma') })
    expect(res.code).toBe(0)
    const lines = res.stdout.split('\n').filter((l) => l.trim())
    expect(lines.length).toBeLessThanOrEqual(1)
    for (const l of lines) {
      const obj = JSON.parse(l)
      expect(obj.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    }
  })

  it('Test 11 (legacy delegation): collision-check still exits 0 (single-stream back-compat)', () => {
    const fixture = JSON.stringify({ session_id: 'w', tool_name: 'Edit', tool_input: { file_path: join(tmp, 'x.ts') } })
    for (const cmd of ['collision-check', 'reflex-check', 'gates-check']) {
      const res = runCli([cmd], fixture, { SMA_ROOT_OVERRIDE: join(tmp, '.sma') })
      expect(res.code).toBe(0)
    }
  })

  it('Test 12 (spawn-count metric): counts scripts/sma PreToolUse entries in a settings fixture', () => {
    const three = join(tmp, 'three.json')
    const one = join(tmp, 'one.json')
    const write = (p: string, obj: any) => require('node:fs').writeFileSync(p, JSON.stringify(obj))
    write(three, {
      hooks: {
        PreToolUse: [
          { matcher: 'Edit|Write', hooks: [
            { type: 'command', command: 'node scripts/sma/cli.mjs collision-check' },
            { type: 'command', command: 'node scripts/sma/cli.mjs reflex-check' },
            { type: 'command', command: 'node scripts/sma/cli.mjs gates-check' },
          ] },
          { matcher: 'Bash', hooks: [
            { type: 'command', command: 'node scripts/sma/cli.mjs collision-check' },
          ] },
        ],
      },
    })
    write(one, {
      hooks: { PreToolUse: [{ matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: 'node scripts/sma/cli.mjs pre' }] }] },
    })
    const r3 = runCli(['pre-bench', '--metric', 'spawn-count', '--settings', three])
    expect(r3.stdout.trim().split('\n').pop()).toBe('3')
    const r1 = runCli(['pre-bench', '--metric', 'spawn-count', '--settings', one])
    expect(r1.stdout.trim().split('\n').pop()).toBe('1')
  })

  it('Test 13 (parity metric): pre-bench --metric parity prints 0 over the golden fixtures', () => {
    const res = runCli(['pre-bench', '--metric', 'parity'], '', { SMA_ROOT_OVERRIDE: join(tmp, '.sma') })
    expect(res.stdout.trim().split('\n').pop()).toBe('0')
  })

  // 30s timeout: this test spawns 8 REAL node processes by design; under multi-terminal
  // machine load the default 5s trips on cold-boot variance alone (seen 5.7s on 2026-07-08).
  it('Test 14 (bench percentile plumbing): pre-bench --runs prints a stats table and a bare p95 last line', () => {
    const res = runCli(['pre-bench', '--runs', '8'], '', { SMA_ROOT_OVERRIDE: join(tmp, '.sma') })
    expect(res.code).toBe(0)
    const lines = res.stdout.split('\n').filter((l) => l.trim())
    const last = lines[lines.length - 1]
    expect(last).toMatch(/^\d+$/) // bare integer p95 last line (the scorer contract)
    expect(res.stdout).toMatch(/p95/i) // human stats table present
  }, 30000)
})
