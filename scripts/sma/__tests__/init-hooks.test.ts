/**
 * Regression tests for the installer's hooks merge (bin/init.mjs).
 *
 * The defect: the CLI has shipped the one-spawn PreToolUse multiplexer (`sma pre`)
 * for a while, but the installer's SMA_HOOKS template still emitted the OLD wiring —
 * six per-stream entries (collision-check / reflex-check / gates-check × 'Edit|Write'
 * and 'Bash'). Because the merge is additive, a consumer that had already migrated
 * its settings.json to the multiplexer got the stale chains RE-ADDED on every
 * reinstall, so every pre-hook double-ran (caught in the field by a consumer's
 * "exactly one PreToolUse spawn chain" guard invariant).
 *
 *   Test 1 — fresh merge: exactly ONE PreToolUse entry (the multiplexer,
 *            matcher Edit|Write|Bash, command `node scripts/sma/cli.mjs pre`)
 *   Test 2 — update over the old 3-spawn chains: they are removed, exactly one
 *            multiplexer entry remains
 *   Test 3 — update over BOTH the old chains and the multiplexer: dedups to
 *            exactly one multiplexer entry
 *   Test 4 — a foreign (non-SMA) hook entry survives byte-identically
 *   Test 5 — end-to-end: the REAL installer (fresh + update run) writes the
 *            healed settings.json in an install-shaped temp project
 *
 * bin/init.mjs starts with a shebang, which vite-node's inline transform cannot
 * parse — so the module is loaded through a NATIVE dynamic import (@vite-ignore).
 */

import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, it, expect } from 'vitest'

const repoRoot = join(__dirname, '..', '..', '..')
const initPath = join(repoRoot, 'bin', 'init.mjs')
const { mergeHooks, removeStaleSmaHooks } = await import(/* @vite-ignore */ pathToFileURL(initPath).href)

const PRE_CMD = 'node scripts/sma/cli.mjs pre'

/** The six entries the installer used to ship before the `pre` multiplexer. */
function legacyChainGroups() {
  return [
    {
      matcher: 'Edit|Write',
      hooks: [
        { type: 'command', command: 'node scripts/sma/cli.mjs collision-check', timeout: 5 },
        { type: 'command', command: 'node scripts/sma/cli.mjs reflex-check', timeout: 5 },
        { type: 'command', command: 'node scripts/sma/cli.mjs gates-check', timeout: 5 },
      ],
    },
    {
      matcher: 'Bash',
      hooks: [
        { type: 'command', command: 'node scripts/sma/cli.mjs collision-check', timeout: 5 },
        { type: 'command', command: 'node scripts/sma/cli.mjs reflex-check', timeout: 5 },
        { type: 'command', command: 'node scripts/sma/cli.mjs gates-check', timeout: 5 },
      ],
    },
  ]
}

function multiplexerGroup() {
  return { matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: PRE_CMD, timeout: 5 }] }
}

describe('init hooks — fresh merge ships the pre multiplexer (Test 1)', () => {
  it('emits exactly ONE PreToolUse entry: matcher Edit|Write|Bash, command `sma pre`', () => {
    const settings: any = {}
    const { added, removedStale } = mergeHooks(settings)
    expect(removedStale).toBe(0)
    expect(added).toBeGreaterThan(0)
    expect(settings.hooks.PreToolUse).toHaveLength(1)
    expect(settings.hooks.PreToolUse[0]).toEqual(multiplexerGroup())
    // no stale per-stream command anywhere in the emitted settings
    expect(JSON.stringify(settings)).not.toMatch(/collision-check|reflex-check|gates-check/)
  })

  it('is idempotent: a second merge adds nothing', () => {
    const settings: any = {}
    mergeHooks(settings)
    const again = mergeHooks(settings)
    expect(again.added).toBe(0)
    expect(again.removedStale).toBe(0)
    expect(settings.hooks.PreToolUse).toHaveLength(1)
  })
})

describe('init hooks — update heals the legacy 3-spawn chains (Test 2)', () => {
  it('removes all six stale entries and leaves exactly one multiplexer entry', () => {
    const settings: any = { hooks: { PreToolUse: legacyChainGroups() } }
    const { removedStale } = mergeHooks(settings)
    expect(removedStale).toBe(6)
    expect(settings.hooks.PreToolUse).toHaveLength(1)
    expect(settings.hooks.PreToolUse[0]).toEqual(multiplexerGroup())
  })
})

describe('init hooks — chains AND multiplexer dedup to one (Test 3)', () => {
  it('drops the stale chains, keeps the existing multiplexer, adds no duplicate', () => {
    const settings: any = { hooks: { PreToolUse: [...legacyChainGroups(), multiplexerGroup()] } }
    const { removedStale } = mergeHooks(settings)
    expect(removedStale).toBe(6)
    expect(settings.hooks.PreToolUse).toHaveLength(1)
    expect(settings.hooks.PreToolUse[0]).toEqual(multiplexerGroup())
    const preEntries = settings.hooks.PreToolUse.flatMap((g: any) => g.hooks).filter((h: any) => h.command === PRE_CMD)
    expect(preEntries).toHaveLength(1)
  })
})

describe('init hooks — foreign hooks survive byte-identically (Test 4)', () => {
  it('a non-SMA entry sharing a group with stale entries is untouched; other events too', () => {
    const guard = { type: 'command', command: 'node my-guard.mjs --strict', timeout: 30 }
    const stop = { hooks: [{ type: 'command', command: 'node security-scan.mjs' }] }
    const settings: any = {
      model: 'opus',
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [
              { type: 'command', command: 'node scripts/sma/cli.mjs collision-check', timeout: 5 },
              guard,
            ],
          },
        ],
        Stop: [stop],
      },
    }
    const guardBytes = JSON.stringify(guard)
    const stopBytes = JSON.stringify(stop)
    const { removedStale } = mergeHooks(settings)
    expect(removedStale).toBe(1)
    // the foreign sibling stays in its original group, byte-identical
    const editWrite = settings.hooks.PreToolUse.find((g: any) => g.matcher === 'Edit|Write')
    expect(editWrite.hooks).toHaveLength(1)
    expect(JSON.stringify(editWrite.hooks[0])).toBe(guardBytes)
    // the multiplexer arrives as its own group alongside it
    const mux = settings.hooks.PreToolUse.find((g: any) => g.matcher === 'Edit|Write|Bash')
    expect(mux.hooks).toEqual([{ type: 'command', command: PRE_CMD, timeout: 5 }])
    // foreign event untouched, other settings untouched
    expect(JSON.stringify(settings.hooks.Stop[0])).toBe(stopBytes)
    expect(settings.model).toBe('opus')
  })

  it('removeStaleSmaHooks alone: exact-string match only, near-miss commands survive', () => {
    const settings: any = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'node scripts/sma/cli.mjs collision-check', timeout: 5 },
              { type: 'command', command: 'node other/cli.mjs collision-check' },
            ],
          },
        ],
      },
    }
    expect(removeStaleSmaHooks(settings)).toBe(1)
    expect(settings.hooks.PreToolUse[0].hooks).toEqual([{ type: 'command', command: 'node other/cli.mjs collision-check' }])
  })

  it('removeStaleSmaHooks drops an emptied event key entirely', () => {
    const settings: any = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node scripts/sma/cli.mjs gates-check', timeout: 5 }] }] } }
    expect(removeStaleSmaHooks(settings)).toBe(1)
    expect(settings.hooks.PreToolUse).toBeUndefined()
  })
})

describe('init hooks — the REAL installer heals settings.json (Test 5)', () => {
  it('fresh install writes ONE PreToolUse chain; a re-run over stale chains + a foreign hook heals it', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sma-init-hooks-'))
    try {
      const proj = join(tmp, 'proj')
      mkdirSync(proj, { recursive: true })
      // No child `timeout:` — the case's own 120s below is the single deadline.
      // A duplicate, tighter child clock kills the installer, hands back
      // `status: null`, and the case reads "expected null to be 0": a loaded
      // machine reported as a defect. A kill or a spawn failure now says so.
      const run = () => {
        const res = spawnSync(process.execPath, [initPath, '--local'], { cwd: proj, encoding: 'utf8' })
        if (res.error || res.signal) {
          throw new Error(
            `installer did not complete — signal=${res.signal} ` +
              `spawnError=${res.error ? res.error.message : 'none'}\nstderr: ${(res.stderr ?? '').slice(0, 600)}`,
          )
        }
        return res
      }
      const settingsPath = join(proj, '.claude', 'settings.json')

      // fresh install: exactly one PreToolUse spawn chain (the consumer guard invariant)
      const fresh = run()
      expect({ status: fresh.status, stderr: (fresh.stderr ?? '').slice(0, 400) }).toMatchObject({ status: 0 })
      const s1 = JSON.parse(readFileSync(settingsPath, 'utf8'))
      expect(s1.hooks.PreToolUse).toEqual([multiplexerGroup()])

      // simulate a pre-multiplexer-era install that ALSO already carries the
      // multiplexer and one foreign hook — the double-run field shape
      const guard = { type: 'command', command: 'node my-guard.mjs --strict', timeout: 30 }
      s1.hooks.PreToolUse = [...legacyChainGroups(), multiplexerGroup()]
      s1.hooks.PreToolUse[0].hooks.push(guard)
      writeFileSync(settingsPath, JSON.stringify(s1, null, 2) + '\n')

      const update = run()
      expect({ status: update.status, stderr: (update.stderr ?? '').slice(0, 400) }).toMatchObject({ status: 0 })
      expect(update.stdout).toMatch(/legacy per-stream entries/)
      const s2 = JSON.parse(readFileSync(settingsPath, 'utf8'))
      expect(JSON.stringify(s2)).not.toMatch(/collision-check|reflex-check|gates-check/)
      // the foreign hook survives byte-identically in its group; ONE multiplexer chain remains
      expect(s2.hooks.PreToolUse).toEqual([
        { matcher: 'Edit|Write', hooks: [guard] },
        multiplexerGroup(),
      ])
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  }, 120000)
})
