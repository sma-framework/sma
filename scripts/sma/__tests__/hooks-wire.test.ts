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

import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, it, expect, afterAll } from 'vitest'
import { applyDeleteme } from '../lib/deleteme.mjs'

const repoRoot = join(__dirname, '..', '..', '..')
const initPath = join(repoRoot, 'bin', 'init.mjs')
const cliPath = join(repoRoot, 'scripts', 'sma', 'cli.mjs')
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

// ── the hook verbs, driven the way the harness drives them ────────────────────

/** The window token both the claim and the SessionEnd frame carry. */
const WINDOW_TOKEN = 'probe-window-hook-contract'

/**
 * The environment a hook child runs in. Two things it must NOT inherit:
 *
 *  - the kill-switches. Each of these verbs has one, and every one of them is a
 *    SILENT exit 0: with a switch set from the outside the case would spawn a
 *    process, read exit 0, and pass while the verb did nothing at all. They are
 *    deleted, not overridden with '0', so a truthiness change cannot revive them.
 *  - a window NAME. Identity is the name when one is set and a token-derived
 *    fallback when it is not, so an inherited name would make the case depend on
 *    the operator's shell rather than on the frame it feeds in.
 *
 * The state root is pinned to the temp tree: without that pin the verbs resolve
 * the root through git and could write into the checkout running the tests. And
 * the detached reporter child is disabled — it has nothing to report to here,
 * and on this platform a stray detached child is a stray console window.
 */
function hookEnv(proj: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  for (const key of [
    'SMA_FLIGHT_DISABLE',
    'SMA_FLIGHT_NATIVE',
    'SMA_PACK_DISABLE',
    'SMA_RECEIPTS_DISABLE',
    'SMA_TERMINAL_NAME',
  ]) {
    delete env[key]
  }
  env.SMA_ROOT_OVERRIDE = join(proj, '.sma')
  env.SMA_WINDOW_TOKEN = WINDOW_TOKEN
  env.SMA_DISABLE_SNAPSHOT_SPAWN = '1'
  return { ...env, ...extra }
}

/**
 * Run one verb the way a hook is run: a JSON event frame on stdin, nothing else.
 * No child `timeout:` — the case's own deadline is the single clock. A spawn
 * failure or a kill is reported as itself, never as a product verdict.
 */
function runHook(verb: string, frame: unknown, proj: string, extra: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [cliPath, verb], {
    cwd: proj,
    encoding: 'utf8',
    input: frame === undefined ? '' : JSON.stringify(frame),
    env: hookEnv(proj, extra),
  })
  if (res.error || res.signal) {
    throw new Error(
      `${verb} did not complete — signal=${res.signal} ` +
        `spawnError=${res.error ? res.error.message : 'none'}\nstderr: ${(res.stderr ?? '').slice(0, 600)}`,
    )
  }
  return res
}

/** Every journal line of the temp tree, parsed. */
function journalEvents(proj: string) {
  const dir = join(proj, '.sma', 'journal')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l)),
    )
}

const listDir = (p: string) => (existsSync(p) ? readdirSync(p) : [])

/**
 * The claim SLOTS in a claims directory. A released slot leaves a dot-prefixed
 * cooldown marker behind (so the scope reads «recently freed» rather than «busy»
 * for a short while), and that marker is evidence of a release, not a surviving
 * claim — so slots are counted without it, and the marker is asserted separately.
 */
const claimSlots = (p: string) => listDir(p).filter((f) => !f.startsWith('.'))

describe('hook contract: session lifecycle', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sma-hooks-session-'))
  const proj = join(tmp, 'proj')
  mkdirSync(proj, { recursive: true })

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  })

  it('the SessionEnd frame releases the claims that window took, and says so in the journal', () => {
    // the claim is taken by a child carrying the SAME window token the frame will
    // carry as its session id — the identity these two runs share is the whole
    // point: a mismatch releases nothing and still exits 0.
    const claim = spawnSync(
      process.execPath,
      [cliPath, 'claim', 'wire-probe', '--globs', 'src/**', '--desc', 'hook wire check'],
      { cwd: proj, encoding: 'utf8', env: hookEnv(proj) },
    )
    expect({ status: claim.status, stderr: (claim.stderr ?? '').slice(0, 300) }).toMatchObject({ status: 0 })
    const claimsDir = join(proj, '.sma', 'claims')
    const before = claimSlots(claimsDir)
    expect(before, 'the claim this window took should be on disk before the hook runs').toHaveLength(1)
    const slot = before[0]

    const res = runHook('session-end', { session_id: WINDOW_TOKEN, hook_event_name: 'SessionEnd', reason: 'other' }, proj)
    expect(res.status).toBe(0)

    // the exit code proves nothing here (this verb exits 0 whatever happens) —
    // the trace does: the claim slot is gone and the release is journalled with
    // the reason that names the trigger.
    expect(claimSlots(claimsDir), 'the claim should be released by the hook').toEqual([])
    expect(listDir(claimsDir), 'a release drops a cooldown marker — the trace of a REAL release').toContain(
      `.cooldown-${slot}`,
    )
    const release = journalEvents(proj).filter((e) => e.type === 'release' && e.detail?.reason === 'session-ended')
    expect(release).toHaveLength(1)
    expect(release[0].scope).toBe(slot)
  }, 60000)

  it('the PreCompact frame writes a capsule, and the post-compaction SessionStart hands it back', () => {
    const res = runHook('precompact-capsule', { session_id: WINDOW_TOKEN, hook_event_name: 'PreCompact', trigger: 'auto' }, proj)
    expect(res.status).toBe(0)

    // exit 0 over an EMPTY capsule directory is the failure this asserts against:
    // every kill-switch on this verb is a silent success, so the file is the check.
    const capsuleDir = join(proj, '.sma', 'flight', 'capsules')
    const capsules = listDir(capsuleDir)
    expect(capsules, 'PreCompact must leave a capsule on disk, not just exit 0').toHaveLength(1)
    const capsule = readFileSync(join(capsuleDir, capsules[0]), 'utf8')

    // the restore arm: a SessionStart frame that says the session resumed from a
    // compaction gets the capsule body back. Identified by lines taken FROM the
    // written file rather than by a literal — the capsule's wording is not the
    // contract, its round trip is.
    const lines = capsule.split('\n').filter((l) => l.trim())
    const stamp = lines.find((l) => l.trim().startsWith('- ts:'))
    expect(stamp, 'the capsule should carry a timestamp line to identify it by').toBeTruthy()

    const start = runHook('session-start', { session_id: WINDOW_TOKEN, source: 'compact' }, proj)
    expect(start.status).toBe(0)
    const out = JSON.parse(start.stdout)
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
    const context = out.hookSpecificOutput.additionalContext
    expect(context).toContain(lines[0])
    expect(context).toContain(stamp)
  }, 60000)
})

describe('hook contract: subagent pack and receipts', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sma-hooks-subagent-'))
  const proj = join(tmp, 'proj')
  const ORIGINAL_PROMPT = 'ORIGINAL-PROMPT-MARKER'

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  })

  it('the Task frame comes back as an allow decision whose updatedInput carries the pack ahead of the original prompt', () => {
    mkdirSync(join(proj, 'src'), { recursive: true })
    const res = runHook(
      'pretask-pack',
      {
        session_id: WINDOW_TOKEN,
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: { description: 'probe', prompt: ORIGINAL_PROMPT },
      },
      proj,
    )
    expect(res.status).toBe(0)

    const out = JSON.parse(res.stdout)
    const decision = out.hookSpecificOutput
    expect(decision.hookEventName).toBe('PreToolUse')
    expect(decision.permissionDecision).toBe('allow')
    // the pack is PREPENDED, never a replacement: the subagent still gets every
    // byte its caller wrote. Asserted structurally — the pack's own wording is
    // not a contract, and in a sterile tree it is nearly empty anyway.
    expect(decision.updatedInput.prompt.endsWith(ORIGINAL_PROMPT)).toBe(true)
    expect(decision.updatedInput.prompt.length).toBeGreaterThan(ORIGINAL_PROMPT.length)
    // updatedInput REPLACES the tool input wholesale, so every other field the
    // caller sent has to survive the trip or the spawn loses it
    expect(decision.updatedInput.description).toBe('probe')

    // the traces the receipt side and the latency budget are both read from
    const spawnRecords = listDir(join(proj, '.sma', 'subagents'))
    expect(spawnRecords, 'the pack should leave a spawn record for the stop hook to correlate').toHaveLength(1)
    expect(journalEvents(proj).filter((e) => e.type === 'subagent-pack')).toHaveLength(1)
  }, 60000)

  it('the SubagentStop frame receipts the transcript: a real write verified, a claimed-but-absent one flagged', () => {
    // a repository is the instrument here: the verdicts are read off the real
    // tree (existence, dirty state, commits since the spawn), not off the words.
    const git = spawnSync('git', ['init', '-q', '.'], { cwd: proj, encoding: 'utf8' })
    expect({ status: git.status, stderr: (git.stderr ?? '').slice(0, 300) }).toMatchObject({ status: 0 })
    writeFileSync(join(proj, 'src', 'real.txt'), 'data\n') // exists + untracked -> dirty -> verified

    // The minimal transcript shape the extractor reads: a write-tool call with
    // its file path, its successful result, and a FINAL assistant message that
    // claims both files. The absent one is claimed WITH a directory separator on
    // purpose — a bare file name is demoted to "cannot tell" by design, so a
    // fixture using one would make the case pass while proving nothing.
    const transcript = join(proj, 'transcript.jsonl')
    writeFileSync(
      transcript,
      [
        { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: 'src/real.txt' } }] } },
        { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: false }] } },
        { message: { role: 'assistant', content: [{ type: 'text', text: 'Wrote src/real.txt and created src/ghost.txt' }] } },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    )

    const res = runHook(
      'subagent-verify',
      { session_id: WINDOW_TOKEN, hook_event_name: 'SubagentStop', transcript_path: transcript },
      proj,
    )
    expect(res.status).toBe(0)

    // the receipt lands in the shared journal — that, not the printed warning,
    // is the artifact: whether a stop hook's stdout ever reaches a human is the
    // harness's business, while the journal line is ours.
    const receipts = journalEvents(proj).filter((e) => e.type === 'subagent-receipt')
    expect(receipts).toHaveLength(1)
    const claims = receipts[0].detail.claims
    // the two verdicts that matter, asserted apart: a receipt that called both
    // of them the same thing would be worthless in either direction
    expect(claims.filter((c: any) => c.path === 'src/real.txt').map((c: any) => c.verdict)).toContain('verified')
    expect(claims.filter((c: any) => c.path === 'src/real.txt').every((c: any) => c.verdict === 'verified')).toBe(true)
    expect(claims.filter((c: any) => c.path === 'src/ghost.txt').map((c: any) => c.verdict)).toEqual(['phantom-missing'])
    expect(receipts[0].detail.counts.phantomAsserted).toBe(1)

    // the wire between the two hooks: the stop correlated the spawn record the
    // pack wrote in the case above, and marked it consumed so coverage stays honest
    expect(receipts[0].detail.spawn, 'the stop should correlate the pack spawn record').toBeTruthy()
    const records = listDir(join(proj, '.sma', 'subagents'))
    const record = JSON.parse(readFileSync(join(proj, '.sma', 'subagents', records[0]), 'utf8'))
    expect(record.consumed).toBe(true)
  }, 60000)
})
