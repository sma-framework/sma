/**
 * Tests for scripts/sma/cli.mjs (Phase 49 Plan 10).
 *
 * The deterministic CLI's two hook-facing / policy contracts (the parts a wrong
 * implementation could actually break):
 *   - Test 1: collision-check with an Edit inside a FOREIGN session's claimed glob
 *     → hookSpecificOutput naming the owner, permissionDecision 'allow', exit 0.
 *   - Test 2: collision-check over a corrupted .sma/ → exit 0, no output (P4 —
 *     the R7 'deliberately-broken registry dir' acceptance).
 *   - Test 3: collision-check with a Bash git-deploy command while a live foreign
 *     push-claim exists → additionalContext carries the push-claim WARN, still
 *     'allow', exit 0 (D-49-02 second channel). The command string is built by
 *     concatenation so THIS source never carries the adjacent two-word phrase.
 *   - Test 4: force-clear <claim> WITHOUT --yes → prints the holder block and
 *     refuses (exit 1, nothing removed).
 *   - Test 5: force-clear <claim> --yes → the claim dir is removed and the
 *     journal gains a 'steal' event with full provenance (D-49-09).
 *
 * Every test spawns the real CLI (execFileSync node cli.mjs) against a per-test
 * temp .sma root via the SMA_ROOT_OVERRIDE env hook — no network, no shared state.
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

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'cli.mjs')

const iso = (ms: number) => new Date(ms).toISOString()

let smaRoot: string

/** Seed a session lease file under .sma/sessions/<terminalId>.json. */
function seedSession(terminalId: string, lease: Record<string, unknown>) {
  const dir = join(smaRoot, 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${terminalId}.json`), JSON.stringify(lease, null, 2))
}

/** Seed a claim dir with provenance.json under .sma/claims/<name>/. */
function seedClaim(name: string, provenance: Record<string, unknown>) {
  const dir = join(smaRoot, 'claims', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'provenance.json'), JSON.stringify(provenance, null, 2))
}

/**
 * Run the CLI. Returns {stdout, status}. execFileSync throws on non-zero exit;
 * we capture the thrown error's status + stdout so a non-zero exit is testable.
 */
function runCli(
  args: string[],
  opts: { stdin?: string; terminalName?: string } = {},
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      input: opts.stdin ?? '',
      encoding: 'utf8',
      env: {
        ...process.env,
        SMA_ROOT_OVERRIDE: smaRoot,
        SMA_TERMINAL_NAME: opts.terminalName ?? 'Мозг',
      },
    })
    return { stdout, status: 0 }
  } catch (err: any) {
    return { stdout: (err.stdout ?? '').toString(), status: typeof err.status === 'number' ? err.status : 1 }
  }
}

/** A fresh foreign session lease (renewTime = now) claiming src/**. */
function freshForeignLease() {
  const now = Date.now()
  return {
    holderIdentity: 'Фабрика',
    pid: 31240,
    scope: { globs: ['src/**'], description: 'рефакторинг' },
    status: 'working',
    blockers: [],
    acquireTime: iso(now - 60000),
    renewTime: iso(now),
    leaseDurationSeconds: 1800,
    transitions: 1,
  }
}

beforeEach(() => {
  smaRoot = join(mkdtempSync(join(tmpdir(), 'sma-cli-')), '.sma')
  mkdirSync(smaRoot, { recursive: true })
})

afterEach(() => {
  try {
    rmSync(dirname(smaRoot), { recursive: true, force: true })
  } catch {
    /* best-effort cleanup */
  }
})

describe('cli.mjs collision-check (PreToolUse contract, D-49-02/P4)', () => {
  it('Test 1: Edit inside a foreign claimed glob → allow + additionalContext names the owner, exit 0', () => {
    seedSession('fabrika', freshForeignLease())
    const stdin = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/crm/foo.ts' } })
    const { stdout, status } = runCli(['collision-check'], { stdin, terminalName: 'Мозг' })

    expect(status).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow')
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Фабрика')
    // NEVER a deny decision anywhere in the output (P4).
    expect(stdout).not.toContain('"deny"')
  })

  it('Test 2: corrupted .sma/ → exit 0, no output (P4 deliberately-broken registry dir)', () => {
    // A garbage session file + a claims path that is a FILE where a dir is expected.
    mkdirSync(join(smaRoot, 'sessions'), { recursive: true })
    writeFileSync(join(smaRoot, 'sessions', 'broken.json'), '{ this is : not json')
    writeFileSync(join(smaRoot, 'claims'), 'not-a-directory')

    const stdin = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/crm/foo.ts' } })
    const { stdout, status } = runCli(['collision-check'], { stdin, terminalName: 'Мозг' })

    expect(status).toBe(0)
    expect(stdout.trim()).toBe('')
  })

  it('Test 3: Bash git-deploy command with a live foreign push-claim → push WARN, allow, exit 0', () => {
    // A live foreign push-in-progress claim (fresh 'at').
    seedClaim('push-in-progress', {
      by: 'Фабрика',
      pid: 31240,
      session: null,
      at: iso(Date.now() - 30000),
      expectedPrev: null,
      reason: 'push-in-progress:V1.48',
    })
    // Build the deploy command by concatenation so THIS file never carries the
    // adjacent two-word phrase (SMA-3 discipline).
    const deployCmd = 'git ' + 'push' + ' origin main'
    const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command: deployCmd } })
    const { stdout, status } = runCli(['collision-check'], { stdin, terminalName: 'Мозг' })

    expect(status).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow')
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Фабрика')
    expect(stdout).not.toContain('"deny"')
  })
})

describe('cli.mjs force-clear (D-49-09 terraform force-unlock)', () => {
  it('Test 4: WITHOUT --yes → prints the holder block and refuses (exit 1, nothing removed)', () => {
    seedClaim('push-in-progress', {
      by: 'Фабрика',
      pid: 31240,
      session: null,
      at: iso(Date.now() - 30000),
      expectedPrev: null,
      reason: 'push-in-progress:V1.48',
    })

    const { stdout, status } = runCli(['force-clear', 'push-in-progress'], { terminalName: 'Мозг' })

    expect(status).toBe(1)
    // Holder block printed FIRST (who / operation / since).
    expect(stdout).toContain('Фабрика')
    expect(stdout).toContain('push-in-progress:V1.48')
    // The claim dir is still on disk — nothing was removed.
    expect(existsSync(join(smaRoot, 'claims', 'push-in-progress'))).toBe(true)
  })

  it('Test 5: WITH --yes → claim removed + journal gains a steal event with provenance', () => {
    seedClaim('push-in-progress', {
      by: 'Фабрика',
      pid: 31240,
      session: null,
      at: iso(Date.now() - 30000),
      expectedPrev: null,
      reason: 'push-in-progress:V1.48',
    })

    const { stdout, status } = runCli(['force-clear', 'push-in-progress', '--yes'], { terminalName: 'Мозг' })

    expect(status).toBe(0)
    expect(stdout).toContain('Фабрика') // former holder still printed
    // The claim dir is gone.
    expect(existsSync(join(smaRoot, 'claims', 'push-in-progress'))).toBe(false)

    // The journal carries a 'steal' event with full provenance (D-49-09).
    const journalDir = join(smaRoot, 'journal')
    const files = readdirSync(journalDir).filter((f) => f.endsWith('.jsonl'))
    expect(files.length).toBeGreaterThan(0)
    const events = files
      .flatMap((f) => readFileSync(join(journalDir, f), 'utf8').split('\n'))
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const steal = events.find((e) => e.type === 'steal')
    expect(steal).toBeTruthy()
    expect(steal.scope).toBe('push-in-progress')
    expect(steal.detail.formerHolder).toBe('Фабрика')
    expect(steal.detail.by).toBe('Мозг')
    expect(steal.detail.target).toBe('push-in-progress')
    expect(typeof steal.detail.at).toBe('string')
  })
})

describe('cli.mjs claim + force-clear round-trip (WR-02)', () => {
  it('claim creates a claims-dir entry that force-clear can actually remove', () => {
    // Фабрика claims a scope; the claims-dir entry is named after the scope slug — the
    // exact string a collision WARN would suggest to force-clear.
    const claim = runCli(['claim', 'my-scope', '--globs', 'src/**', '--desc', 'my-scope'], {
      terminalName: 'Фабрика',
    })
    expect(claim.status).toBe(0)
    // the WARN-suggested command names the slug
    expect(claim.stdout).toContain('force-clear my-scope')
    expect(existsSync(join(smaRoot, 'claims', 'my-scope'))).toBe(true)

    // A DIFFERENT terminal force-clears it (the D-49-09 foreign-removal path).
    const fc = runCli(['force-clear', 'my-scope', '--yes'], { terminalName: 'Мозг' })
    expect(fc.status).toBe(0)
    expect(fc.stdout).toContain('Фабрика') // former holder printed
    expect(existsSync(join(smaRoot, 'claims', 'my-scope'))).toBe(false)
  })

  it('release removes the OWN claims-dir entry (no leftover for force-clear to find)', () => {
    runCli(['claim', 'feat-x', '--globs', 'src/**', '--desc', 'feat-x'], { terminalName: 'Фабрика' })
    expect(existsSync(join(smaRoot, 'claims', 'feat-x'))).toBe(true)
    const rel = runCli(['release', 'feat-x'], { terminalName: 'Фабрика' })
    expect(rel.status).toBe(0)
    expect(existsSync(join(smaRoot, 'claims', 'feat-x'))).toBe(false)
  })
})

describe('cli.mjs window-stable identity across sequential hook PROCESSES (R7/D-49-01 regression)', () => {
  // The CR-01 lesson: exercise the REAL hook seam — two separate `node cli.mjs`
  // invocations are two real processes with DIFFERENT pids, mirroring how Claude Code
  // spawns a fresh one-shot hook per tool call. The stdin `session_id` is the stable
  // window token both invocations of one window share.
  const editStdin = (sessionId: string) =>
    JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/crm/foo.ts' }, session_id: sessionId })

  function sessionFileCount(): number {
    try {
      return readdirSync(join(smaRoot, 'sessions')).filter((f) => f.endsWith('.json')).length
    } catch {
      return 0
    }
  }

  it('two SEQUENTIAL collision-check processes, SAME session_id -> ONE lease (not two)', () => {
    const stdin = editStdin('window-alpha')
    const a = runCli(['collision-check'], { stdin, terminalName: 'exec' })
    const b = runCli(['collision-check'], { stdin, terminalName: 'exec' })
    expect(a.status).toBe(0)
    expect(b.status).toBe(0)
    // Pre-fix: two distinct pids -> two files. Fixed: one window token -> ONE renewed lease.
    expect(sessionFileCount()).toBe(1)
  })

  it('two windows sharing a NAME but DIFFERENT session_ids -> TWO distinct leases (WR-05 preserved)', () => {
    runCli(['collision-check'], { stdin: editStdin('window-alpha'), terminalName: 'exec' })
    runCli(['collision-check'], { stdin: editStdin('window-beta'), terminalName: 'exec' })
    expect(sessionFileCount()).toBe(2)
  })
})

describe('cli.mjs status — collision counter is bounded to today (WR-04)', () => {
  /** Seed a journal .jsonl file with the given events under .sma/journal/. */
  function seedJournal(terminalId: string, events: Record<string, unknown>[]) {
    const dir = join(smaRoot, 'journal')
    mkdirSync(dir, { recursive: true })
    const lines = events.map((e, i) => JSON.stringify({ seq: i + 1, terminal: terminalId, ...e })).join('\n') + '\n'
    writeFileSync(join(dir, `${terminalId}.jsonl`), lines)
  }

  it('counts only TODAY-dated collision events, not the full append-only history', () => {
    const today = new Date().toISOString()
    seedJournal('mozg', [
      { ts: '2026-01-01T09:00:00.000Z', type: 'collision', scope: 'src/**' }, // old — ignored
      { ts: '2026-02-15T09:00:00.000Z', type: 'collision', scope: 'src/**' }, // old — ignored
      { ts: today, type: 'collision', scope: 'src/**' }, // today — counted
      { ts: today, type: 'claim', scope: 'x' }, // not a collision — ignored
    ])

    const { stdout, status } = runCli(['status', '--json'], { terminalName: 'Мозг' })
    expect(status).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.collisions).toBe(1) // ONLY today's collision, not 3
  })
})
