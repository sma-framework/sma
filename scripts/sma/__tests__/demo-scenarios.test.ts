/**
 * demo-scenarios.test.ts — the single-machine, script-executable version of the
 * four SPEC demo acceptance scenarios (Phase 49 Plan 16, R8/R9/R10).
 *
 * The SPEC (49-SPEC.md) names four demo acceptances that are, in production, run
 * across two REAL parallel terminals. Those live 2-terminal reruns stay a founder
 * verify item (VALIDATION Manual-Only map). This file is their deterministic,
 * anyone-can-rerun proxy: each demo spawns the REAL CLI (`node scripts/sma/cli.mjs
 * …`) as one or two child processes against a per-demo temp `.sma` root, with the
 * terminal identity + root injected via env, and asserts on stdout JSON/text, exit
 * codes, and the on-disk `.sma` state (claim dirs, journal lines).
 *
 * The four demos map 1:1 to the SPEC acceptance sentences:
 *   - Demo 1 (R9 migration race): two children run `next-slot migration` concurrently
 *     against ONE temp root + an OFFLINE git stub (a temp cwd that is NOT a git repo,
 *     so the CLI's read-only `git fetch`/`git show` fail-open) → exactly one gets N,
 *     the other's output carries a WARN naming the first holder AND the value N+1.
 *   - Demo 2 (R9 push-during-push): process A acquires the deploy-signal advisory
 *     claim; process B's collision-check over a deploy command carries A's
 *     holderIdentity + acquireTime; A's claim is still present afterward (queue,
 *     never cancel, B23).
 *   - Demo 3 (R8 collision): a session file for terminal «Фабрика» claims a glob;
 *     collision-check invoked AS terminal B with a path inside it → stdout
 *     additionalContext names «Фабрика», permissionDecision 'allow', exit 0
 *     (WARNED, NOT blocked).
 *   - Demo 4 (R10 journal): after the mutating demos, readJournal over each temp root
 *     returns the corresponding events, each with actor + ISO timestamp; a fresh
 *     empty root returns zero events without error.
 *
 * Every demo owns its own temp root — no cross-demo shared state. Node built-ins +
 * the real CLI only; no network (offline by construction).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readJournal } from '../lib/journal.mjs'
import { readClaims } from '../lib/claims.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'cli.mjs')

const iso = (ms: number) => new Date(ms).toISOString()

/**
 * Spawn the real CLI. Returns {stdout, status}. execFileSync throws on non-zero
 * exit; we capture the thrown error's stdout + status so a non-zero exit is
 * testable. `cwd` lets a demo run the CLI OUTSIDE a git repo (the offline stub for
 * Demo 1's read-only git fetch/show — they fail and the slot logic falls back to
 * the local file, deterministically).
 */
function runCli(
  args: string[],
  opts: { root: string; terminalName: string; stdin?: string; cwd?: string } = {
    root: '',
    terminalName: '',
  },
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      input: opts.stdin ?? '',
      encoding: 'utf8',
      cwd: opts.cwd,
      env: {
        ...process.env,
        SMA_ROOT_OVERRIDE: opts.root,
        SMA_TERMINAL_NAME: opts.terminalName,
      },
    })
    return { stdout, status: 0 }
  } catch (err: any) {
    return {
      stdout: (err.stdout ?? '').toString(),
      status: typeof err.status === 'number' ? err.status : 1,
    }
  }
}

/** Make a fresh temp `.sma` root; returns {root, parent}. */
function makeRoot(prefix: string): { root: string; parent: string } {
  const parent = mkdtempSync(join(tmpdir(), prefix))
  const root = join(parent, '.sma')
  mkdirSync(root, { recursive: true })
  return { root, parent }
}

/** Seed a session lease file under <root>/sessions/<terminalId>.json. */
function seedSession(root: string, terminalId: string, lease: Record<string, unknown>) {
  const dir = join(root, 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${terminalId}.json`), JSON.stringify(lease, null, 2))
}

/** Seed a claim dir with provenance.json under <root>/claims/<name>/. */
function seedClaim(root: string, name: string, provenance: Record<string, unknown>) {
  const dir = join(root, 'claims', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'provenance.json'), JSON.stringify(provenance, null, 2))
}

/**
 * Build an offline "git stub": a temp cwd holding a src/migrations/index.ts whose
 * numeric max is `maxNumber`. Running the CLI with cwd here means its read-only
 * `git fetch origin` / `git show origin/main:…` both fail (not a git repo) and the
 * slot logic falls back to this local file — deterministic + offline.
 */
function makeMigrationsCwd(maxNumber: number): string {
  const cwd = mkdtempSync(join(tmpdir(), 'sma-mig-cwd-'))
  const migDir = join(cwd, 'src', 'migrations')
  mkdirSync(migDir, { recursive: true })
  const pad = String(maxNumber).padStart(3, '0')
  // Minimal index.ts the extractMaxNumber regex (name: 'NNN_snake') can parse.
  writeFileSync(
    join(migDir, 'index.ts'),
    `export const prodMigrations = [\n  { name: '${pad}_demo_seed' },\n]\n`,
  )
  return cwd
}

describe('SMA demo scenarios — the four SPEC acceptances on one machine', () => {
  const roots: string[] = []
  const cwds: string[] = []

  beforeEach(() => {
    roots.length = 0
    cwds.length = 0
  })

  afterEach(() => {
    for (const p of [...roots, ...cwds]) {
      try {
        rmSync(p, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
  })

  it('Demo 1 (R9 migration race): concurrent next-slot → one N, the other WARN + N+1', () => {
    const { root, parent } = makeRoot('sma-demo1-')
    roots.push(parent)
    const cwd = makeMigrationsCwd(66) // local max 066 → next free is 067
    cwds.push(cwd)

    // Two children request the next migration number concurrently against ONE root.
    // The atomic mkdir claim gate guarantees exactly one winner at 067; the loser
    // retries at 068 and prints a WARN naming the holder. Because execFileSync is
    // synchronous, "concurrent" here is a tight back-to-back race over the SAME
    // claim dir — the second call sees 067 already held and is pushed to 068.
    const a = runCli(['next-slot', 'migration'], { root, terminalName: 'Мозг', cwd })
    const b = runCli(['next-slot', 'migration'], { root, terminalName: 'Фабрика', cwd })

    const outs = [a.stdout, b.stdout]
    // Exactly one output announces 067 as WON (exit 0, no race WARN).
    const gotN = outs.filter((o) => o.includes('067') && !o.includes('уже занят'))
    // The other announces 068 AND carries the "slot already taken" WARN naming a holder.
    const gotNPlus1 = outs.filter((o) => o.includes('068') && o.includes('уже занят'))

    expect(gotN.length).toBe(1) // exactly one gets N (067)
    expect(gotNPlus1.length).toBe(1) // exactly one gets a WARN + N+1 (068)

    // The winner's claim dir exists on disk with the winner's provenance.
    expect(existsSync(join(root, 'claims', 'migration-067'))).toBe(true)

    // The loser's WARN names the migration slot it lost.
    const loser = outs.find((o) => o.includes('уже занят'))!
    expect(loser).toContain('migration-067')
  })

  it('Demo 2 (R9 push-during-push): B sees A holder + start time; A claim survives', () => {
    const { root, parent } = makeRoot('sma-demo2-')
    roots.push(parent)

    // Process A holds the deploy-signal advisory claim (a fresh 'at').
    const acquiredAt = iso(Date.now() - 45000)
    seedClaim(root, 'push-in-progress', {
      by: 'Фабрика',
      pid: 40111,
      session: null,
      at: acquiredAt,
      expectedPrev: null,
      reason: 'push-in-progress:V1.48',
    })

    // Process B runs a pre-push collision-check over a deploy command.
    // Build the deploy verb by concatenation so THIS source never carries the
    // adjacent two-word literal (SMA-3 discipline).
    const deployCmd = 'git ' + 'push' + ' origin main --follow-tags'
    const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command: deployCmd } })
    const b = runCli(['collision-check'], { root, terminalName: 'Мозг', stdin })

    expect(b.status).toBe(0) // hook-facing: exit 0 always
    const parsed = JSON.parse(b.stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow') // WARN, never deny
    // The WARN carries A's identity AND its start time.
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Фабрика')
    expect(parsed.hookSpecificOutput.additionalContext).toContain(acquiredAt)
    expect(b.stdout).not.toContain('"deny"')

    // Nothing was cancelled — A's claim is STILL present (queue, never cancel, B23).
    expect(existsSync(join(root, 'claims', 'push-in-progress'))).toBe(true)
    const claims = readClaims({ claimsDir: join(root, 'claims') })
    const pc = claims.find((c: any) => c.name === 'push-in-progress')
    expect(pc?.provenance?.by).toBe('Фабрика')
  })

  it('Demo 3 (R8 collision): Edit inside «Фабрика» glob → WARN names owner, allow, exit 0', () => {
    const { root, parent } = makeRoot('sma-demo3-')
    roots.push(parent)

    // A fresh foreign session claiming src/** (renewTime = now → 'fresh').
    const now = Date.now()
    seedSession(root, 'fabrika', {
      holderIdentity: 'Фабрика',
      pid: 40222,
      scope: { globs: ['src/**'], description: 'рефакторинг ядра' },
      status: 'working',
      blockers: [],
      acquireTime: iso(now - 120000),
      renewTime: iso(now),
      leaseDurationSeconds: 1800,
      transitions: 1,
    })

    // Terminal B edits a path INSIDE that glob.
    const stdin = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: 'src/crm/orchestrator/router.ts' },
    })
    const b = runCli(['collision-check'], { root, terminalName: 'Мозг', stdin })

    expect(b.status).toBe(0)
    const parsed = JSON.parse(b.stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow') // WARNED, not blocked
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Фабрика') // owner NAME appears
    // No deny / blocking anywhere in the output (R8 acceptance: NOT blocked).
    expect(b.stdout).not.toContain('"deny"')
  })

  it('Demo 4 (R10 journal): mutating demos leave events with actor + ISO ts; empty root = zero events', () => {
    // (a) A populated root: run the collision demo (Demo 3 shape) so the CLI journals
    //     a 'collision' event with actor + timestamp.
    const { root, parent } = makeRoot('sma-demo4-')
    roots.push(parent)
    const now = Date.now()
    seedSession(root, 'fabrika', {
      holderIdentity: 'Фабрика',
      pid: 40333,
      scope: { globs: ['src/**'], description: 'рефакторинг' },
      status: 'working',
      blockers: [],
      acquireTime: iso(now - 120000),
      renewTime: iso(now),
      leaseDurationSeconds: 1800,
      transitions: 1,
    })
    const stdin = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: 'src/crm/foo.ts' },
    })
    runCli(['collision-check'], { root, terminalName: 'Мозг', stdin })

    const { events } = readJournal({ journalDir: join(root, 'journal') })
    expect(events.length).toBeGreaterThan(0)
    const collision = events.find((e: any) => e.type === 'collision')
    expect(collision).toBeTruthy()
    // Every journalled event carries an actor set + an ISO timestamp.
    expect(Array.isArray(collision.actors)).toBe(true)
    expect(collision.actors).toContain('Фабрика')
    expect(typeof collision.ts).toBe('string')
    expect(Number.isFinite(Date.parse(collision.ts))).toBe(true)

    // (b) A fresh empty root → zero events, no error (empty R10 acceptance).
    const { root: emptyRoot, parent: emptyParent } = makeRoot('sma-demo4-empty-')
    roots.push(emptyParent)
    const empty = readJournal({ journalDir: join(emptyRoot, 'journal') })
    expect(empty.count).toBe(0)
    expect(empty.events).toEqual([])
  })
})
