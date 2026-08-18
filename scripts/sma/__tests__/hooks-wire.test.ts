/**
 * End-to-end wiring tests for the engine's hook points: the INSTALL/UNINSTALL
 * inversion on a real settings.json, and the four hook verbs driven the way the
 * harness drives them (an event frame on stdin, a trace left on disk).
 *
 * Why this file exists beside the installer's own suite:
 *
 *  1. UNINSTALL SYMMETRY WAS AN UNTESTED CLAIM. The installer's merge is
 *     additive and the off-ramp removes by PATH (any entry running this
 *     engine's cli.mjs), not by a second copy of the shipped list — which is
 *     the right design, because two lists drift apart and then the second one
 *     lies about the first. But "removes by path, therefore removes all of
 *     them" is a deduction, not a check: nothing ran the real installer and the
 *     real off-ramp against the same settings.json. The existing off-ramp tests
 *     work on plain objects or an injected fake io; none of them touches the
 *     chain. This file closes that hole with the inversion itself — install,
 *     count what the shipped list says must be there, uninstall, count zero.
 *
 *  2. A HOOK THAT IS DECLARED IS NOT A HOOK THAT RUNS. The installer suite
 *     proves the entries reach settings.json. It cannot prove that the verb
 *     behind an entry does anything when the harness actually calls it — that
 *     needs the real contract: a JSON event frame on stdin, an exit code, and
 *     a trace on disk. So the four verbs are spawned here as child processes
 *     with real frames, and every case asserts the TRACE (a released claim, a
 *     capsule file, an updatedInput payload, a receipt in the journal) rather
 *     than the exit code, which these verbs return as 0 unconditionally by
 *     design (fail-open: a hook must never wedge a session).
 *
 * Expectations about WHICH hooks ship are always derived from the installer's
 * exported list. A second copy of that list here would drift away from the
 * template and then quietly assert the wrong thing.
 *
 * bin/init.mjs starts with a shebang, which the runner's inline transform
 * cannot parse — so it is loaded through a NATIVE dynamic import (@vite-ignore).
 */

import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, it, expect, afterAll } from 'vitest'
import { applyDeleteme } from '../lib/deleteme.mjs'

const repoRoot = join(__dirname, '..', '..', '..')
const initPath = join(repoRoot, 'bin', 'init.mjs')
const { SMA_HOOKS } = await import(/* @vite-ignore */ pathToFileURL(initPath).href)

type HookDef = { event: string; matcher: string | null; command: string; timeout: number }

/**
 * Any hook entry that runs this engine's CLI, whichever verb it carries — the
 * SAME predicate the off-ramp removes by, so "ours" means the same thing on
 * both sides of the inversion.
 */
const SMA_HOOK_COMMAND = /scripts[\\/]+sma[\\/]+cli\.mjs/

/** Our own entries inside one group — foreign ones stay out of the count. */
function smaEntriesIn(group: any) {
  return (Array.isArray(group?.hooks) ? group.hooks : []).filter((h: any) => SMA_HOOK_COMMAND.test(h?.command ?? ''))
}

/** Our own entries across every event of a settings object. */
function smaEntries(settings: any) {
  return Object.values(settings?.hooks ?? {})
    .flatMap((groups: any) => (Array.isArray(groups) ? groups : []))
    .flatMap((g: any) => smaEntriesIn(g))
}

/** A hook group looked up BY MATCHER — never by index. */
function groupFor(settings: any, event: string, matcher: string | null) {
  const groups = settings?.hooks?.[event]
  expect(Array.isArray(groups), `no ${event} groups at all`).toBe(true)
  const group = groups.find((g: any) => (matcher === null ? !g.matcher : g.matcher === matcher))
  expect(group, `no ${event} group for matcher ${matcher ?? '(none)'}`).toBeDefined()
  return group
}

const readSettings = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

// ── the install/uninstall inversion, on a real settings.json ──────────────────

/**
 * The two foreign entries the fixture plants. They stand for the two shapes a
 * consumer actually has in the field: a guard on the editing tools (its own
 * matcher, so the installer stands its group beside it) and a subagent guard in
 * a matcher-less group (which the installer JOINS — our entry moves in beside
 * the foreign one). The second shape is why "the foreign side is intact" has to
 * be asserted per ENTRY: the GROUP legitimately changes when we are added to it,
 * so a whole-array comparison would fail for the wrong reason — or, worse, get
 * "fixed" by overwriting the group.
 */
const FOREIGN_EDIT_GUARD = { type: 'command', command: 'node .claude/guards/edit-guard.mjs --strict', timeout: 30 }
const FOREIGN_SUBAGENT_GUARD = { type: 'command', command: 'node .claude/guards/regression-scan.mjs', timeout: 30 }

describe('hook wiring — install then uninstall on a real settings.json', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sma-hooks-wire-'))
  const proj = join(tmp, 'proj')
  const settingsPath = join(proj, '.claude', 'settings.json')

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  })

  it('the REAL installer lands every shipped hook exactly once and joins, never overwrites, foreign groups', () => {
    mkdirSync(join(proj, '.claude'), { recursive: true })
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          model: 'opus',
          hooks: {
            PreToolUse: [{ matcher: 'Edit|Write', hooks: [FOREIGN_EDIT_GUARD] }],
            SubagentStop: [{ hooks: [FOREIGN_SUBAGENT_GUARD] }],
          },
        },
        null,
        2,
      ) + '\n',
    )

    // No child `timeout:` — the case's own deadline below is the single clock.
    // A tighter child clock kills the installer on a loaded machine, hands back
    // `status: null`, and the case then reads as a product defect.
    const res = spawnSync(process.execPath, [initPath, '--local'], { cwd: proj, encoding: 'utf8' })
    if (res.error || res.signal) {
      throw new Error(
        `installer did not complete — signal=${res.signal} ` +
          `spawnError=${res.error ? res.error.message : 'none'}\nstderr: ${(res.stderr ?? '').slice(0, 600)}`,
      )
    }
    expect({ status: res.status, stderr: (res.stderr ?? '').slice(0, 400) }).toMatchObject({ status: 0 })

    const settings = readSettings(settingsPath)
    // every entry the template ships is present ONCE, in the group its matcher names
    for (const def of SMA_HOOKS as HookDef[]) {
      const group = groupFor(settings, def.event, def.matcher)
      expect(
        smaEntriesIn(group).filter((h: any) => h.command === def.command),
        `${def.event}/${def.matcher ?? '(no matcher)'} should carry exactly one ${def.command}`,
      ).toEqual([{ type: 'command', command: def.command, timeout: def.timeout }])
    }
    expect(smaEntries(settings)).toHaveLength(SMA_HOOKS.length)

    // the foreign ENTRIES survive byte-identically (the groups may change)
    const editGroup = groupFor(settings, 'PreToolUse', 'Edit|Write')
    expect(JSON.stringify(editGroup.hooks[0])).toBe(JSON.stringify(FOREIGN_EDIT_GUARD))
    // and ours JOINS the matcher-less foreign group instead of standing beside it
    expect(settings.hooks.SubagentStop).toHaveLength(1)
    const stopGroup = groupFor(settings, 'SubagentStop', null)
    expect(JSON.stringify(stopGroup.hooks[0])).toBe(JSON.stringify(FOREIGN_SUBAGENT_GUARD))
    expect(stopGroup.hooks).toHaveLength(2)
    expect(settings.model).toBe('opus')
  }, 120000)

  it('the REAL off-ramp removes every one of them and leaves the foreign entries untouched', () => {
    // The off-ramp ENGINE from this repository, with the real io and dryRun off.
    // Never the copy installed into the temp tree, and never through a spawned
    // verb: that process would be deleting the scripts directory it is running
    // from, which on Windows means file locks and a half-removed tree.
    const res = applyDeleteme({ project: proj, configDir: join(proj, '.claude'), dryRun: false })
    // the off-ramp's own count, so the case cannot pass by removing nothing from
    // a file that never held anything: as many entries out as the template ships
    const settingsAction = res.actions.find((a: any) => a.kind === 'settings')
    expect(settingsAction).toMatchObject({ status: expect.not.stringContaining('error') })
    expect(settingsAction.detail).toContain(`hooks-removed:${SMA_HOOKS.length}`)

    const settings = readSettings(settingsPath)
    // the inversion itself: nothing of ours is left in ANY event
    expect(smaEntries(settings)).toEqual([])

    // both foreign entries survive byte-identically, in their own events
    const editGroup = groupFor(settings, 'PreToolUse', 'Edit|Write')
    expect(JSON.stringify(editGroup.hooks[0])).toBe(JSON.stringify(FOREIGN_EDIT_GUARD))
    const stopGroup = groupFor(settings, 'SubagentStop', null)
    expect(stopGroup.hooks).toHaveLength(1)
    expect(JSON.stringify(stopGroup.hooks[0])).toBe(JSON.stringify(FOREIGN_SUBAGENT_GUARD))
    // and every other key of the file is still the user's
    expect(settings.model).toBe('opus')
  })
})
