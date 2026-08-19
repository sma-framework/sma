/**
 * Tests for scripts/sma/lib/statusline.mjs + the cli.mjs statusline surface.
 *
 * The native-statusline SEGMENT: a pure, degradable, cheap function over injected +
 * cached local state, plus the managed settings install/wrap/uninstall that NEVER
 * clobbers the adopter's own statusLine command.
 *
 * Task 1 (lib — DI unit tests):
 *   - Test 1: renderSegment is pure + deterministic over a fully-injected state.
 *   - Test 2: graceful degradation — null spend/gates/preds render '—', never a throw.
 *   - Test 3: two-tier TTL cache — fast loaders called once within TTL; the preds scan
 *     refreshes on its own slower TTL; a corrupt cache triggers a silent rebuild.
 *   - Test 4: parseStatusStdin quarantine — vendor shape -> extras; garbage -> {}.
 *   - Test 5: unscored-predictions math over a fixture phases tree + ledger.
 *
 * Task 3 (CLI surface) tests 7-9 live at the bottom of this file (install/uninstall/wrap).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import {
  renderSegment,
  readStatuslineState,
  refreshCache,
  parseStatusStdin,
  countUnscoredPredictions,
  isSmaStatuslineCmd,
  resolveWrappedCommand,
  runWrappedCommand,
  composeStatusline,
  STATUSLINE_TTL_MS,
  PREDS_TTL_MS,
  WRAPPED_TIMEOUT_MS,
} from '../lib/statusline.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-statusline-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

describe('statusline.mjs — Task 1 (pure render + cache + adapters)', () => {
  it('Test 1: renderSegment is deterministic over a fully-injected working state', () => {
    const state = { pulse: 'working', claim: '9.3-07', collisions: 0, windowPct: 42, gates: 1, unscored: 3 }
    const out = renderSegment(state)
    expect(out).toBe('sma ▸working · claim 9.3-07 · coll 0 · win 42% · gates 1 · preds 3')
    // pure: same input -> same output
    expect(renderSegment(state)).toBe(out)
    // plain ASCII beside the pulse glyph (only the leading ▸ is non-ASCII, plus the · separators)
    expect(out.startsWith('sma ▸working')).toBe(true)
  })

  it('Test 2: null spend/gates/preds render as "—"; never throws on any partial state', () => {
    const degraded = renderSegment({ pulse: 'working', claim: '9.3-07', collisions: 2, windowPct: null, gates: null, unscored: null })
    expect(degraded).toBe('sma ▸working · claim 9.3-07 · coll 2 · win — · gates — · preds —')
    // never throws on ANY partial state, including {}
    expect(() => renderSegment({})).not.toThrow()
    expect(renderSegment({})).toContain('sma ')
    // an unclaimed lease renders claim —
    expect(renderSegment({ pulse: 'idle', collisions: 0 })).toContain('claim —')
  })

  it('Test 3: two-tier TTL cache — fast loaders once within TTL; preds on the slower TTL; corrupt cache rebuilds', async () => {
    const statuslineDir = join(dir, 'statusline')
    let fastCalls = 0
    let predsCalls = 0
    const loaders = {
      loadSpend: () => {
        fastCalls += 1
        return 42
      },
      loadGates: () => 1,
      loadUnscored: () => {
        predsCalls += 1
        return 3
      },
    }
    const dirs = { statuslineDir }
    let clock = 1_000_000
    const now = () => clock

    // first call: both tiers cold -> loaders run
    await readStatuslineState({ dirs, summary: { collisions: 0 }, loaders, now })
    expect(fastCalls).toBe(1)
    expect(predsCalls).toBe(1)

    // second call INSIDE both TTLs -> cache hit, no loader runs
    clock += Math.floor(STATUSLINE_TTL_MS / 2)
    const warm = await readStatuslineState({ dirs, summary: { collisions: 0 }, loaders, now })
    expect(fastCalls).toBe(1)
    expect(predsCalls).toBe(1)
    expect(warm.windowPct).toBe(42)
    expect(warm.gates).toBe(1)
    expect(warm.unscored).toBe(3)

    // advance past the FAST TTL but NOT the preds TTL -> fast refreshes, preds does not
    clock += STATUSLINE_TTL_MS + 1
    await readStatuslineState({ dirs, summary: { collisions: 0 }, loaders, now })
    expect(fastCalls).toBe(2)
    expect(predsCalls).toBe(1)

    // advance past the PREDS TTL -> the expensive scan refreshes too
    clock += PREDS_TTL_MS + 1
    await readStatuslineState({ dirs, summary: { collisions: 0 }, loaders, now })
    expect(predsCalls).toBe(2)

    // a corrupt cache.json triggers a silent full rebuild (never a throw)
    writeFileSync(join(statuslineDir, 'cache.json'), '{ this is not json')
    const beforeFast = fastCalls
    const rebuilt = await readStatuslineState({ dirs, summary: { collisions: 0 }, loaders, now })
    expect(fastCalls).toBe(beforeFast + 1)
    expect(rebuilt.windowPct).toBe(42)
  })

  it('Test 4: parseStatusStdin extracts vendor extras; garbage/empty/unfamiliar -> {}', () => {
    const vendor = JSON.stringify({
      model: { id: 'claude-opus', display_name: 'Opus 4.8' },
      workspace: { current_dir: '/repo' },
      cost: { total_cost_usd: 0.4, used_pct: 71 },
    })
    const extras = parseStatusStdin(vendor)
    expect(extras.modelName).toBe('Opus 4.8')
    expect(extras.contextPct).toBe(71)

    expect(parseStatusStdin('')).toEqual({})
    expect(parseStatusStdin('not json at all {{{')).toEqual({})
    expect(parseStatusStdin(JSON.stringify([1, 2, 3]))).toEqual({})
    expect(parseStatusStdin(JSON.stringify({ unrelated: true }))).toEqual({})
    expect(() => parseStatusStdin(undefined as unknown as string)).not.toThrow()
  })

  it('Test 4b: the context percentage is read from the DOCUMENTED context_window shape', () => {
    // the vendor documents context_window.used_percentage — the older tolerated shapes
    // were never present on a real payload, so the parser promised what it never did.
    const documented = JSON.stringify({
      model: { display_name: 'Opus' },
      context_window: { used_percentage: 37.5, remaining_percentage: 62.5, total_input_tokens: 12345 },
    })
    expect(parseStatusStdin(documented).contextPct).toBe(37.5)
    // camelCase from a future rename is tolerated too (foreign names are taken as a set)
    expect(parseStatusStdin(JSON.stringify({ context_window: { usedPercentage: 12 } })).contextPct).toBe(12)
    expect(parseStatusStdin(JSON.stringify({ contextWindow: { used_percentage: 5 } })).contextPct).toBe(5)
    // the documented field wins over the older tolerated one when both are present
    expect(parseStatusStdin(JSON.stringify({ context_window: { used_percentage: 37 }, cost: { used_pct: 71 } })).contextPct).toBe(37)

    // and the pre-existing tolerance survives: no context data -> no key, never a throw
    expect(parseStatusStdin(JSON.stringify({ context_window: {} })).contextPct).toBeUndefined()
    expect(parseStatusStdin(JSON.stringify({ context_window: 'nonsense' })).contextPct).toBeUndefined()
    expect(parseStatusStdin(JSON.stringify({ unrelated: true })).contextPct).toBeUndefined()
  })

  it('Test 5: unscored-predictions math — 3 plan ids, 1 scored -> 2 unscored; malformed plan is skipped', async () => {
    const phasesDir = join(dir, 'phases')
    const calibrationDir = join(dir, 'calibration')
    mkdirSync(join(phasesDir, '99-alpha'), { recursive: true })
    mkdirSync(join(phasesDir, '99-beta'), { recursive: true })
    mkdirSync(calibrationDir, { recursive: true })

    // plan A carries two prediction ids
    writeFileSync(
      join(phasesDir, '99-alpha', '99-01-PLAN.md'),
      ['---', 'predictions:', '  - id: PX-1', '    claim: a', '  - id: PX-2', '    claim: b', '---', '', 'body'].join('\n'),
    )
    // plan B carries one prediction id
    writeFileSync(
      join(phasesDir, '99-beta', '99-02-PLAN.md'),
      ['---', 'predictions:', '  - id: PX-3', '    claim: c', '---', '', 'body'].join('\n'),
    )
    // a malformed plan must be skipped, never fatal
    writeFileSync(join(phasesDir, '99-beta', '99-03-PLAN.md'), '---\nthis: [is: broken\n')

    // the ledger holds a verdict for exactly ONE of the three ids
    writeFileSync(
      join(calibrationDir, 'sma.perf.jsonl'),
      JSON.stringify({ id: 'PX-2', domain: 'sma.perf', verdict: 'hit' }) + '\n',
    )

    const unscored = await countUnscoredPredictions({ phasesDir, calibrationDir })
    expect(unscored).toBe(2)

    // a phases dir that does not exist -> null (renders '—'), never a throw
    expect(await countUnscoredPredictions({ phasesDir: join(dir, 'nope'), calibrationDir })).toBe(null)
  })

  it('refreshCache forces a rebuild past the TTL', async () => {
    const statuslineDir = join(dir, 'sl2')
    let calls = 0
    const loaders = { loadSpend: () => (calls += 1, 10), loadGates: () => 0, loadUnscored: () => 0 }
    const dirs = { statuslineDir }
    const now = () => 5_000_000
    await readStatuslineState({ dirs, summary: {}, loaders, now })
    expect(calls).toBe(1)
    // same clock, but force -> loader runs again
    await refreshCache({ dirs, summary: {}, loaders, now })
    expect(calls).toBe(2)
  })
})

// ── The window axis: the subscription reading must REACH the state ────────────

/**
 * The vendor pipes `rate_limits.five_hour.used_percentage` on stdin at every render.
 * «Parsed» and «reached the consumer» are different claims: the reading used to be
 * parsed and then handed to the daemon snapshot ONLY, while the win axis was fed by a
 * spend-against-a-money-cap figure that nobody sets — so the axis was dead by
 * construction. These cases assert the WIRE (stdin -> parse -> inject -> state), not
 * that the renderer can print a number.
 */
describe('statusline window axis — the subscription reading reaches the axis', () => {
  const VENDOR_PCT = 23.5

  it('W1: an injected vendor reading wins over both the cached and the freshly loaded spend figure', async () => {
    const statuslineDir = join(dir, 'sl-w1')
    const loaders = { loadSpend: () => 42, loadGates: () => 1, loadUnscored: () => 0 }
    const dirs = { statuslineDir }
    const now = () => 5_000_000

    // cold call without a reading -> the spend fallback fills the axis and warms the cache
    const cold = await readStatuslineState({ dirs, summary: {}, loaders, now })
    expect(cold.windowPct).toBe(42)

    // same clock (cache warm), now WITH the vendor reading -> the reading wins
    const withVendor = await readStatuslineState({ dirs, summary: {}, loaders, now, vendorWindowPct: VENDOR_PCT })
    expect(withVendor.windowPct).toBe(VENDOR_PCT) // fractional survives — the vendor documents 0..100 with decimals

    // a non-finite «reading» is not a reading (garbage never displaces the fallback)
    const garbage = await readStatuslineState({ dirs, summary: {}, loaders, now, vendorWindowPct: Number.NaN })
    expect(garbage.windowPct).toBe(42)
  })

  it('W2: no vendor reading + a real spend-cap fixture -> the spend fallback still fills the axis', async () => {
    const spendDir = join(dir, 'spend-w2')
    mkdirSync(spendDir, { recursive: true })
    writeFileSync(join(spendDir, 'budget.json'), JSON.stringify({ windowHours: 5, capUsd: 10 }))
    const state = await readStatuslineState({
      dirs: { statuslineDir: join(dir, 'sl-w2'), spendDir, repoRoot: join(dir, 'w2-repo') },
      summary: {},
      now: () => 1,
    })
    expect(Number.isFinite(state.windowPct)).toBe(true) // the pre-existing fallback path is untouched
  })

  it('W3: neither a vendor reading nor a cap -> null, which renders as the honest dash', async () => {
    const state = await readStatuslineState({
      dirs: { statuslineDir: join(dir, 'sl-w3'), repoRoot: join(dir, 'w3-repo') },
      summary: {},
      now: () => 1,
    })
    expect(state.windowPct).toBeNull()
    expect(renderSegment(state)).toContain('win —')
  })

  it('W4: the vendor reading is NEVER written to cache.json — a call without stdin tells the truth', async () => {
    const statuslineDir = join(dir, 'sl-w4')
    const loaders = { loadSpend: () => 7, loadGates: () => 0, loadUnscored: () => 0 }
    const now = () => 9_000_000
    await readStatuslineState({ dirs: { statuslineDir }, summary: {}, loaders, now, vendorWindowPct: VENDOR_PCT })

    const cache = JSON.parse(readFileSync(join(statuslineDir, 'cache.json'), 'utf8'))
    expect(cache.fast.windowPct).toBe(7) // the cache keeps the spend figure only
    expect(JSON.stringify(cache)).not.toContain(String(VENDOR_PCT))

    // a later call WITHOUT the reading falls back to that cached figure — no stale vendor value
    const later = await readStatuslineState({ dirs: { statuslineDir }, summary: {}, loaders, now })
    expect(later.windowPct).toBe(7)
  })

  it('W5 (wire): the same stdin bytes travel parse -> inject -> state through the real command', () => {
    const payload = JSON.stringify({
      model: { display_name: 'Opus', id: 'claude-opus' },
      workspace: { current_dir: '/repo' },
      rate_limits: {
        five_hour: { used_percentage: VENDOR_PCT, resets_at: 1786552800 },
        seven_day: { used_percentage: 58, resets_at: 1786993200 },
      },
    })

    // half one — the parse the entry point performs
    const parsed = parseStatusStdin(payload)
    expect(parsed.rateLimits?.five_hour?.usedPercentage).toBe(VENDOR_PCT)

    // half two — the SAME bytes on the real command's stdin come out inside the axis.
    // HOME/USERPROFILE are redirected so neither the adopter's own statusline nor a real
    // daemon store is touched by the spawn (os.homedir reads them).
    const repoW5 = join(dir, 'w5-repo')
    const homeW5 = join(dir, 'w5-home')
    mkdirSync(join(repoW5, '.sma'), { recursive: true })
    mkdirSync(homeW5, { recursive: true })
    const run = (input: string): string =>
      execFileSync(process.execPath, [CLI, 'statusline'], {
        env: { ...process.env, SMA_ROOT_OVERRIDE: join(repoW5, '.sma'), HOME: homeW5, USERPROFILE: homeW5 },
        input,
        encoding: 'utf8',
      })

    expect(run(payload)).toContain(`win ${VENDOR_PCT}%`) // the reading reached the axis
    expect(run('{}')).toContain('win —') // and without it the axis is honestly empty
  })
})

// ── Composition with a pre-existing user statusline (segment-not-takeover) ─────

describe('statusline composition — user line first, SMA segment appended', () => {
  const SEGMENT = 'sma ▸working · claim x · coll 0 · win — · gates — · preds —'

  it('composes wrapped + SMA: user-scope auto-detect finds a foreign command and the user line prints FIRST', () => {
    const home = join(dir, 'home')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'node my-own-statusline.js' } }),
    )
    const resolved = resolveWrappedCommand({ dirs: { statuslineDir: join(dir, 'no-config') }, homedirFn: () => home })
    expect(resolved).not.toBeNull()
    expect(resolved!.command).toBe('node my-own-statusline.js')
    expect(resolved!.source).toBe('user-scope')

    // ANSI-colored wrapped output passes through untouched, user line FIRST
    const ansiLine = '[38;5;213mctx 42%[0m | 5h 12%'
    const execFn = () => ansiLine + '\nsecond line ignored\n'
    const userLine = runWrappedCommand(resolved!.command, { stdin: '{}', execFn })
    expect(userLine).toBe(ansiLine)
    const composed = composeStatusline(userLine, SEGMENT)
    expect(composed).toBe(ansiLine + ' · ' + SEGMENT)
    expect(composed.indexOf(ansiLine)).toBe(0) // wrapped line is primary — always first
  })

  it('explicit wrapped-command.json config WINS over the user-scope auto-detect', () => {
    const statuslineDir = join(dir, 'sl-config')
    mkdirSync(statuslineDir, { recursive: true })
    writeFileSync(join(statuslineDir, 'wrapped-command.json'), JSON.stringify({ command: 'configured-cmd' }))
    const home = join(dir, 'home2')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { command: 'user-scope-cmd' } }))
    const resolved = resolveWrappedCommand({ dirs: { statuslineDir }, homedirFn: () => home })
    expect(resolved).toEqual({ command: 'configured-cmd', source: 'config' })
  })

  it('self-reference guard: a user-scope command that is our own invocation is SKIPPED (no recursion)', () => {
    const home = join(dir, 'home3')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'node scripts/sma/cli.mjs statusline' } }),
    )
    expect(isSmaStatuslineCmd('node scripts/sma/cli.mjs statusline')).toBe(true)
    expect(isSmaStatuslineCmd('node scripts\\sma\\cli.mjs statusline --wrap')).toBe(true)
    expect(isSmaStatuslineCmd('node "C:/Users/x/.claude/statusline.js"')).toBe(false)
    expect(resolveWrappedCommand({ dirs: {}, homedirFn: () => home })).toBe(null)
    // an absent/missing home settings is also a clean null (fail-open)
    expect(resolveWrappedCommand({ dirs: {}, homedirFn: () => join(dir, 'nope') })).toBe(null)
  })

  it('timeout / throwing wrapped command fail-opens to the SMA segment alone', () => {
    const execFn = () => {
      const err = new Error('ETIMEDOUT') as Error & { code?: string }
      err.code = 'ETIMEDOUT'
      throw err
    }
    const userLine = runWrappedCommand('hangs-forever', { stdin: '{}', execFn, timeoutMs: 5 })
    expect(userLine).toBe('')
    expect(composeStatusline(userLine, SEGMENT)).toBe(SEGMENT) // segment alone, never a blank line
    // empty output composes to segment alone too
    expect(composeStatusline(runWrappedCommand('silent', { execFn: () => '' }), SEGMENT)).toBe(SEGMENT)
    // bounded, but with real headroom for a node-based user statusline on Windows
    // (~815 ms measured bare-node startup on the reference machine — see WRAPPED_TIMEOUT_MS)
    expect(WRAPPED_TIMEOUT_MS).toBeGreaterThanOrEqual(1500)
    expect(WRAPPED_TIMEOUT_MS).toBeLessThanOrEqual(3000)
  })

  it('stdin passthrough is byte-identical to what Claude Code piped to us', () => {
    const raw = '{"model":{"display_name":"Fable"},"cost":{"used_pct":71},"unicode":"тест ▸"}'
    let seenInput = ''
    let seenTimeout = 0
    const execFn = (_cmd: string, o: { input: string; timeout: number }) => {
      seenInput = o.input
      seenTimeout = o.timeout
      return 'ok\n'
    }
    runWrappedCommand('user-cmd', { stdin: raw, execFn })
    expect(seenInput).toBe(raw) // byte-identical — re-serialization never mangles their payload
    expect(seenTimeout).toBe(WRAPPED_TIMEOUT_MS)
  })
})

// ── Task 3 — the CLI managed-install surface (spawned through cli.mjs) ─────────

/** Run `node cli.mjs statusline <args>` against a throwaway repo via SMA_ROOT_OVERRIDE. */
function runStatusline(smaRoot: string, args: string[], input = ''): string {
  return execFileSync(process.execPath, [CLI, 'statusline', ...args], {
    env: { ...process.env, SMA_ROOT_OVERRIDE: smaRoot },
    input,
    encoding: 'utf8',
  })
}

describe('statusline CLI — Task 3 (managed install never clobbers the adopter)', () => {
  let repo: string
  let smaRoot: string
  let settingsPath: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'sma-slcli-'))
    smaRoot = join(repo, '.sma')
    mkdirSync(smaRoot, { recursive: true })
    mkdirSync(join(repo, '.claude'), { recursive: true })
    settingsPath = join(repo, '.claude', 'settings.json')
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true, maxRetries: 3 })
  })

  it('Test 7: install preserves + wraps a pre-existing user statusLine; idempotent; uninstall restores verbatim', () => {
    const userStatusLine = { type: 'command', command: 'my-own-statusline.sh' }
    const fixture = { statusLine: userStatusLine, hooks: { Stop: [{ id: 1 }] }, model: 'opus' }
    writeFileSync(settingsPath, JSON.stringify(fixture, null, 2))

    runStatusline(smaRoot, ['install'])
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'))
    // the original was preserved verbatim, the live command is the wrap variant
    const wrapped = JSON.parse(readFileSync(join(smaRoot, 'statusline', 'wrapped-command.json'), 'utf8'))
    expect(wrapped.original).toEqual(userStatusLine)
    // the WHOLE written entry is the canonical one, including the refresh timer: without it
    // an idle window never repaints for anything raised in a neighbouring window
    expect(after.statusLine).toEqual({
      type: 'command',
      command: 'node scripts/sma/cli.mjs statusline --wrap',
      padding: 0,
      refreshInterval: 60,
    })
    // every non-statusLine key deep-equal survived
    expect(after.hooks).toEqual(fixture.hooks)
    expect(after.model).toBe('opus')

    // a SECOND install is a no-op (idempotent) — the entry already IS the canonical one
    const out2 = runStatusline(smaRoot, ['install'])
    expect(out2).toContain('без изменений')
    const after2 = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(after2.statusLine).toEqual(after.statusLine)

    // uninstall restores the user's original statusLine object verbatim
    runStatusline(smaRoot, ['uninstall'])
    const restored = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(restored.statusLine).toEqual(userStatusLine)
    expect(restored.hooks).toEqual(fixture.hooks)
  })

  it('Test 8: install on an empty fixture sets the direct command; uninstall removes it; non-JSON is never written', () => {
    const fixture = { hooks: { Stop: [{ id: 2 }] } } // no statusLine key
    writeFileSync(settingsPath, JSON.stringify(fixture, null, 2))

    runStatusline(smaRoot, ['install'])
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(after.statusLine).toEqual({
      type: 'command',
      command: 'node scripts/sma/cli.mjs statusline', // direct, no --wrap
      padding: 0,
      refreshInterval: 60,
    })
    expect(after.hooks).toEqual(fixture.hooks)

    // uninstall REMOVES the key we added (hadNone recorded)
    runStatusline(smaRoot, ['uninstall'])
    const restored = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect('statusLine' in restored).toBe(false)
    expect(restored.hooks).toEqual(fixture.hooks)

    // a fixture that fails strict JSON.parse is NEVER written; install prints the snippet + exits 0
    const broken = '{ "hooks": [ this is not json'
    writeFileSync(settingsPath, broken)
    const out = runStatusline(smaRoot, ['install'])
    expect(out).toContain('statusLine')
    expect(readFileSync(settingsPath, 'utf8')).toBe(broken) // untouched
  })

  it('Test 9: wrap mode with a failing child command prints the segment alone', () => {
    // seed a wrapped command that exits non-zero
    mkdirSync(join(smaRoot, 'statusline'), { recursive: true })
    writeFileSync(
      join(smaRoot, 'statusline', 'wrapped-command.json'),
      JSON.stringify({ command: 'node -e "process.exit(1)"', original: { type: 'command', command: 'x' }, hadNone: false }),
    )
    const out = runStatusline(smaRoot, ['--wrap'], '')
    // the user still gets a statusline — the segment renders alone (no crash, one line)
    expect(out).toContain('sma ')
    expect(out.trim().split('\n').length).toBe(1)
    expect(out).not.toContain(' · sma ') // no leading child line prepended (child failed)
  })
})

// ── The window token: a render must draw THIS window's lease, never another's ──
//
// These are WIRE tests: each one spawns the real `cli.mjs statusline` and asserts what
// the token DOES to the printed line, not that a helper could read a lease. The break they
// pin: the entry point resolved its identity with no token at all, so it looked up a lease
// keyed by its own one-shot child's pid — an id nothing ever writes. The founder's window
// therefore read `claim —` while holding a claim and `·idle` while its lease said working.

describe('statusline identity — the vendor session token reaches the lease lookup', () => {
  const TOKEN = 'a3f9c1e2-0000-4444-8888-1b2c3d4e5f60'
  const TERMINAL = 'B'
  const CLAIM_LABEL = 'the lease this window actually holds'

  /** The registry's own rule: slug(window name) + '-' + sha1(token)[0..8]. */
  const leaseIdFor = (name: string, token: string) =>
    `${name.toLowerCase()}-${createHash('sha1').update(token).digest('hex').slice(0, 8)}`

  let repo: string
  let sessionsDir: string
  let home: string

  beforeEach(() => {
    repo = join(dir, 'ident-repo')
    home = join(dir, 'ident-home')
    sessionsDir = join(repo, '.sma', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    mkdirSync(home, { recursive: true })
    // the lease of the window the vendor frame names — a claim held, attention wanted
    writeFileSync(
      join(sessionsDir, `${leaseIdFor(TERMINAL, TOKEN)}.json`),
      JSON.stringify({
        holderIdentity: TERMINAL,
        pid: process.pid,
        scope: { globs: ['probe/**'], description: 'the scope description behind the label' },
        status: 'working',
        blockers: [],
        label: CLAIM_LABEL,
        fpStatus: 'waiting-for-human',
        filesRecent: [],
        acquireTime: new Date(Date.now() - 60_000).toISOString(),
        renewTime: new Date().toISOString(),
        leaseDurationSeconds: 1800,
        transitions: 0,
      }),
    )
  })

  /** The real command. HOME/USERPROFILE are redirected so no adopter statusline or daemon
   * store is touched; the env token overrides are blanked so ONLY stdin can identify us. */
  const render = (payload: string): string =>
    execFileSync(process.execPath, [CLI, 'statusline'], {
      env: {
        ...process.env,
        SMA_ROOT_OVERRIDE: join(repo, '.sma'),
        HOME: home,
        USERPROFILE: home,
        SMA_TERMINAL_NAME: TERMINAL,
        SMA_WINDOW_TOKEN: '',
        CLAUDE_SESSION_ID: '',
      },
      input: payload,
      encoding: 'utf8',
    })

  const frame = (extra: object = {}) =>
    JSON.stringify({ model: { display_name: 'Opus' }, rate_limits: { five_hour: { used_percentage: 11, resets_at: 1786552800 } }, ...extra })

  it('S1 (wire): a frame carrying session_id draws the claim and the pulse of THAT lease', () => {
    const out = render(frame({ session_id: TOKEN }))
    expect(out).toContain(`claim ${CLAIM_LABEL}`) // the held claim, not a dash
    expect(out).toContain('◆waiting-for-human') // the pulse off the SAME lease
    expect(out).toContain('win 11%') // the reading still rides the same parse
  })

  it('S1b (wire): the camelCase spelling of the token is tolerated the same way', () => {
    expect(render(frame({ sessionId: TOKEN }))).toContain(`claim ${CLAIM_LABEL}`)
  })

  it('S2 (wire): the token of another window never borrows this lease', () => {
    const out = render(frame({ session_id: 'a-completely-different-window' }))
    expect(out).toContain('claim —')
    expect(out).toContain('·idle')
  })

  it('S3 (wire): a frame with no token keeps the old behavior — the honest dash, exit 0', () => {
    const out = render(frame())
    expect(out).toContain('claim —')
    expect(out).toContain('·idle')
    expect(out).toContain('sma ') // still a line; a tokenless manual call never breaks
    expect(out.trim().split('\n').length).toBe(1)
  })

  it('S4: a render writes no lease of its own — the sessions directory is unchanged', () => {
    const before = readdirSync(sessionsDir).sort()
    render(frame({ session_id: TOKEN }))
    render(frame()) // the tokenless path is the one that used to be blamed for the litter
    render(frame({ session_id: 'yet-another-window' }))
    expect(readdirSync(sessionsDir).sort()).toEqual(before) // a reader, never a registrar
  })

  it('S5: parseStatusStdin lifts the token where the vendor puts it, and invents none', () => {
    expect(parseStatusStdin(JSON.stringify({ session_id: TOKEN })).sessionId).toBe(TOKEN)
    expect(parseStatusStdin(JSON.stringify({ sessionId: TOKEN })).sessionId).toBe(TOKEN)
    expect(parseStatusStdin(JSON.stringify({ session_id: '   ' })).sessionId).toBeUndefined()
    expect(parseStatusStdin(JSON.stringify({ session_id: 42 })).sessionId).toBeUndefined()
    expect(parseStatusStdin('{}').sessionId).toBeUndefined()
    expect(parseStatusStdin('not json').sessionId).toBeUndefined()
  })
})
