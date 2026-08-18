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
 * The invariant these cases hold is "exactly one SMA chain PER MATCHER", not
 * "one PreToolUse group in total": the template also wires the subagent context
 * pack on the Task tool, which is its own PreToolUse matcher group. Groups are
 * therefore always looked up BY MATCHER, never by array index, so a foreign
 * group living in the same event cannot shift what a case reads. Expectations
 * are derived from the installer's exported SMA_HOOKS — a second copy of that
 * list here would drift away from the template and then lie about it.
 *
 *   Test 1 — fresh merge: every shipped hook lands once, in the group its
 *            matcher names; the editing multiplexer and the subagent pack are
 *            two separate PreToolUse groups
 *   Test 2 — update over the old 3-spawn chains: they are removed, exactly one
 *            multiplexer entry remains
 *   Test 3 — update over BOTH the old chains and the multiplexer: dedups to
 *            exactly one multiplexer entry
 *   Test 4 — a foreign (non-SMA) hook entry survives byte-identically, both
 *            beside the multiplexer and inside a matcher-less group we join
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
const { mergeHooks, removeStaleSmaHooks, SMA_HOOKS } = await import(/* @vite-ignore */ pathToFileURL(initPath).href)

type HookDef = { event: string; matcher: string | null; command: string; timeout: number }

/** Any hook entry that runs this engine's CLI, whichever verb it carries. */
const SMA_HOOK_COMMAND = /scripts[\\/]+sma[\\/]+cli\.mjs/

/**
 * The one definition the installer ships for an event + matcher. Throws rather
 * than silently returning the first of several, so a duplicated template entry
 * surfaces here instead of quietly weakening every expectation below.
 */
function defFor(event: string, matcher: string | null): HookDef {
  const found = (SMA_HOOKS as HookDef[]).filter(
    (d) => d.event === event && (matcher === null ? !d.matcher : d.matcher === matcher),
  )
  if (found.length !== 1) {
    throw new Error(
      `the installer ships ${found.length} entries for ${event}/${matcher ?? '(no matcher)'} — expected exactly one`,
    )
  }
  return found[0]
}

/** The settings.json entry the installer emits for a definition. */
// The matcher the shipped list uses for a subagent spawn. Read from the list rather
// than spelled here: the spawn tool was renamed between releases and the entry now
// carries both names, so a literal in this file would be a second truth that starts
// lying to the first the next time the name moves.
const SPAWN_MATCHER = (SMA_HOOKS as any[]).find((h) => String(h.command).endsWith('pretask-pack')).matcher

function entryOf(def: HookDef) {
  return { type: 'command', command: def.command, timeout: def.timeout }
}

/** A hook group looked up BY MATCHER — never by index. */
function groupFor(settings: any, event: string, matcher: string | null) {
  const groups = settings?.hooks?.[event]
  expect(Array.isArray(groups), `no ${event} groups at all`).toBe(true)
  const group = groups.find((g: any) => (matcher === null ? !g.matcher : g.matcher === matcher))
  expect(group, `no ${event} group for matcher ${matcher ?? '(none)'}`).toBeDefined()
  return group
}

/** Our own entries inside one group — the foreign ones stay out of the count. */
function smaEntriesIn(group: any) {
  return (Array.isArray(group?.hooks) ? group.hooks : []).filter((h: any) => SMA_HOOK_COMMAND.test(h?.command ?? ''))
}

/** Our own entries across every event of a settings object. */
function smaEntries(settings: any) {
  return Object.values(settings?.hooks ?? {})
    .flatMap((groups: any) => (Array.isArray(groups) ? groups : []))
    .flatMap((g: any) => smaEntriesIn(g))
}

const PRE_CMD = defFor('PreToolUse', 'Edit|Write|Bash').command

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
  return { matcher: 'Edit|Write|Bash', hooks: [entryOf(defFor('PreToolUse', 'Edit|Write|Bash'))] }
}

function taskPackGroup() {
  return { matcher: SPAWN_MATCHER, hooks: [entryOf(defFor('PreToolUse', SPAWN_MATCHER))] }
}

describe('init hooks — a fresh merge ships one chain per matcher (Test 1)', () => {
  it('lands every shipped hook once, in the group its matcher names', () => {
    const settings: any = {}
    const { added, removedStale } = mergeHooks(settings)
    expect(removedStale).toBe(0)
    expect(added).toBe(SMA_HOOKS.length)

    for (const def of SMA_HOOKS as HookDef[]) {
      expect(groupFor(settings, def.event, def.matcher).hooks).toEqual([entryOf(def)])
    }
    // the editing pipeline stays ONE chain and the subagent pack is a SEPARATE
    // PreToolUse group rather than a wider matcher on the multiplexer
    expect(settings.hooks.PreToolUse).toHaveLength(2)
    expect(groupFor(settings, 'PreToolUse', 'Edit|Write|Bash')).toEqual(multiplexerGroup())
    expect(groupFor(settings, 'PreToolUse', SPAWN_MATCHER)).toEqual(taskPackGroup())
    // the matcher-less events get exactly one group each
    for (const event of ['SessionStart', 'PostToolUse', 'SessionEnd', 'PreCompact', 'SubagentStop']) {
      expect(settings.hooks[event]).toHaveLength(1)
    }
    // nothing of ours beyond the shipped list, and no stale per-stream command
    expect(smaEntries(settings)).toHaveLength(SMA_HOOKS.length)
    expect(JSON.stringify(settings)).not.toMatch(/collision-check|reflex-check|gates-check/)
  })

  it('is idempotent: a second merge adds nothing and changes nothing', () => {
    const settings: any = {}
    mergeHooks(settings)
    const afterFirst = JSON.stringify(settings)
    const again = mergeHooks(settings)
    expect(again.added).toBe(0)
    expect(again.removedStale).toBe(0)
    expect(JSON.stringify(settings)).toBe(afterFirst)
    expect(smaEntries(settings)).toHaveLength(SMA_HOOKS.length)
  })
})

describe('init hooks — update heals the legacy 3-spawn chains (Test 2)', () => {
  it('removes all six stale entries and leaves exactly one multiplexer entry', () => {
    const settings: any = { hooks: { PreToolUse: legacyChainGroups() } }
    const { removedStale } = mergeHooks(settings)
    expect(removedStale).toBe(6)
    // the emptied legacy groups are gone; what is left is one chain per matcher
    expect(settings.hooks.PreToolUse).toHaveLength(2)
    expect(groupFor(settings, 'PreToolUse', 'Edit|Write|Bash')).toEqual(multiplexerGroup())
    expect(groupFor(settings, 'PreToolUse', SPAWN_MATCHER)).toEqual(taskPackGroup())
  })
})

describe('init hooks — chains AND multiplexer dedup to one (Test 3)', () => {
  it('drops the stale chains, keeps the existing multiplexer, adds no duplicate', () => {
    const settings: any = { hooks: { PreToolUse: [...legacyChainGroups(), multiplexerGroup()] } }
    const { removedStale } = mergeHooks(settings)
    expect(removedStale).toBe(6)
    expect(settings.hooks.PreToolUse).toHaveLength(2)
    expect(groupFor(settings, 'PreToolUse', 'Edit|Write|Bash')).toEqual(multiplexerGroup())
    expect(groupFor(settings, 'PreToolUse', SPAWN_MATCHER)).toEqual(taskPackGroup())
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

describe('init hooks — the Task matcher carries exactly one engine entry', () => {
  it('a re-merge grows neither the subagent pack group nor the editing chain', () => {
    const settings: any = {}
    mergeHooks(settings)
    mergeHooks(settings)
    const task = groupFor(settings, 'PreToolUse', SPAWN_MATCHER)
    expect(task.hooks).toEqual([entryOf(defFor('PreToolUse', SPAWN_MATCHER))])
    expect(smaEntriesIn(task)).toHaveLength(1)
    // one Task group, and the editing multiplexer is untouched by its arrival
    expect(settings.hooks.PreToolUse.filter((g: any) => g.matcher === SPAWN_MATCHER)).toHaveLength(1)
    expect(groupFor(settings, 'PreToolUse', 'Edit|Write|Bash')).toEqual(multiplexerGroup())
  })

  it('joins a project that already runs its own hook on the Task matcher', () => {
    const foreign = { type: 'command', command: 'node my-task-audit.mjs', timeout: 20 }
    const settings: any = { hooks: { PreToolUse: [{ matcher: SPAWN_MATCHER, hooks: [foreign] }] } }
    const foreignBytes = JSON.stringify(foreign)
    mergeHooks(settings)
    const task = groupFor(settings, 'PreToolUse', SPAWN_MATCHER)
    expect(JSON.stringify(task.hooks[0])).toBe(foreignBytes)
    expect(smaEntriesIn(task)).toEqual([entryOf(defFor('PreToolUse', SPAWN_MATCHER))])
  })
})

describe('init hooks — a foreign matcher-less group survives the merge that joins it', () => {
  it('the engine entry moves INTO the foreign group; the foreign ENTRY stays byte-identical', () => {
    // the shape a consumer with its own subagent guard has in the field
    const foreign = { type: 'command', command: 'node .claude/guards/regression-scan.mjs', timeout: 30 }
    const settings: any = { hooks: { SubagentStop: [{ hooks: [foreign] }] } }
    const foreignBytes = JSON.stringify(foreign)

    mergeHooks(settings)
    // one matcher-less group still: ours is added TO it, not stood beside it
    expect(settings.hooks.SubagentStop).toHaveLength(1)
    const group = groupFor(settings, 'SubagentStop', null)
    expect(group.hooks).toHaveLength(2)
    // the GROUP legitimately changed — the foreign ENTRY did not
    expect(JSON.stringify(group.hooks[0])).toBe(foreignBytes)
    expect(smaEntriesIn(group)).toEqual([entryOf(defFor('SubagentStop', null))])

    // a second install adds no second engine entry next to it
    mergeHooks(settings)
    const after = groupFor(settings, 'SubagentStop', null)
    expect(after.hooks).toHaveLength(2)
    expect(JSON.stringify(after.hooks[0])).toBe(foreignBytes)
    expect(smaEntriesIn(after)).toHaveLength(1)
  })
})

describe('init hooks — a matcher that moved leaves no second live copy', () => {
  // The stale-COMMAND list cannot cover this: there the command changed and the matcher
  // stayed. Here the command is one we still ship and the matcher moved under it, so the
  // leftover entry is byte-identical to a legitimate one and every existing install would
  // keep firing it forever — two processes on one event, from a door we abandoned.
  it('drops our own entry from the abandoned matcher and keeps exactly one', () => {
    const def = (SMA_HOOKS as any[]).find((h) => String(h.command).endsWith('pretask-pack'))
    const abandoned = 'Task' // the spelling shipped before the spawn tool was renamed
    expect(abandoned).not.toBe(def.matcher) // the case is only meaningful while they differ
    const settings: any = {
      hooks: {
        PreToolUse: [{ matcher: abandoned, hooks: [{ type: 'command', command: def.command, timeout: def.timeout }] }],
      },
    }

    mergeHooks(settings)

    const ours = settings.hooks.PreToolUse.flatMap((g: any) => g.hooks).filter((h: any) => h.command === def.command)
    expect(ours, 'one command, one door').toHaveLength(1)
    expect(settings.hooks.PreToolUse.filter((g: any) => g.matcher === abandoned)).toHaveLength(0)
    expect(groupFor(settings, 'PreToolUse', def.matcher).hooks).toEqual([entryOf(def)])
  })

  it('a foreign entry sharing the abandoned matcher survives byte-identically', () => {
    const def = (SMA_HOOKS as any[]).find((h) => String(h.command).endsWith('pretask-pack'))
    const foreign = { type: 'command', command: 'node other/guard.mjs watch', timeout: 3 }
    const settings: any = {
      hooks: {
        PreToolUse: [
          { matcher: 'Task', hooks: [{ type: 'command', command: def.command, timeout: def.timeout }, foreign] },
        ],
      },
    }

    mergeHooks(settings)

    const kept = settings.hooks.PreToolUse.find((g: any) => g.matcher === 'Task')
    expect(kept, 'the group stays alive for its foreign occupant').toBeTruthy()
    expect(kept.hooks).toEqual([foreign])
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

      // fresh install: every shipped hook reaches the file exactly once, one
      // spawn chain per matcher (the consumer guard invariant)
      const fresh = run()
      expect({ status: fresh.status, stderr: (fresh.stderr ?? '').slice(0, 400) }).toMatchObject({ status: 0 })
      const s1 = JSON.parse(readFileSync(settingsPath, 'utf8'))
      for (const def of SMA_HOOKS as HookDef[]) {
        expect(groupFor(s1, def.event, def.matcher).hooks).toEqual([entryOf(def)])
      }
      expect(smaEntries(s1)).toHaveLength(SMA_HOOKS.length)
      expect(s1.hooks.PreToolUse).toHaveLength(2)
      expect(groupFor(s1, 'PreToolUse', 'Edit|Write|Bash')).toEqual(multiplexerGroup())
      expect(groupFor(s1, 'PreToolUse', SPAWN_MATCHER)).toEqual(taskPackGroup())

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
      // groups read BY MATCHER: the foreign hook survives byte-identically in
      // its own group, ONE multiplexer chain remains, and the subagent pack is
      // restored as its own group
      expect(groupFor(s2, 'PreToolUse', 'Edit|Write').hooks).toEqual([guard])
      expect(groupFor(s2, 'PreToolUse', 'Edit|Write|Bash')).toEqual(multiplexerGroup())
      expect(groupFor(s2, 'PreToolUse', SPAWN_MATCHER)).toEqual(taskPackGroup())
      expect(s2.hooks.PreToolUse).toHaveLength(3)
      expect(smaEntries(s2)).toHaveLength(SMA_HOOKS.length)
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  }, 120000)
})
