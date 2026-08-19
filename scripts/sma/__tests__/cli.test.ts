/**
 * Tests for scripts/sma/cli.mjs.
 *
 * The deterministic CLI's two hook-facing / policy contracts (the parts a wrong
 * implementation could actually break):
 *   - Test 1: collision-check with an Edit inside a FOREIGN session's claimed glob
 *     → hookSpecificOutput naming the owner, permissionDecision 'allow', exit 0.
 *   - Test 2: collision-check over a corrupted .sma/ → exit 0, no output (P4 —
 *     the R7 'deliberately-broken registry dir' acceptance).
 *   - Test 3: collision-check with a Bash git-deploy command while a live foreign
 *     push-claim exists → additionalContext carries the push-claim WARN, still
 *     'allow', exit 0 (the second channel). The command string is built by
 *     concatenation so THIS source never carries the adjacent two-word phrase.
 *   - Test 4: force-clear <claim> WITHOUT --yes → prints the holder block and
 *     refuses (exit 1, nothing removed).
 *   - Test 5: force-clear <claim> --yes + evidence (--reason + --checked, the
 *     burden-of-proof gate) → the claim dir is removed and the
 *     journal gains a 'steal' event with full provenance.
 *   - Test 6: force-clear <claim> --yes WITHOUT evidence → refuses (exit 1,
 *     «требует доказательства», claim survives) — the same gate.
 *
 * Every test spawns the real CLI (execFileSync node cli.mjs) against a per-test
 * temp .sma root via the SMA_ROOT_OVERRIDE env hook — no network, no shared state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
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

import { lexicalCapability, LEXICAL_INDEX_FILE } from '../lib/fts-index.mjs'

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

describe('cli.mjs collision-check (PreToolUse contract, P4)', () => {
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
    // adjacent two-word phrase (the escaped-verb discipline).
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

describe('cli.mjs force-clear (terraform-style force-unlock)', () => {
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

  it('Test 5: WITH --yes + evidence → claim removed + journal gains a steal event with provenance', () => {
    seedClaim('push-in-progress', {
      by: 'Фабрика',
      pid: 31240,
      session: null,
      at: iso(Date.now() - 30000),
      expectedPrev: null,
      reason: 'push-in-progress:V1.48',
    })

    // The evidence gate: a foreign-claim clear now needs --reason + --checked ON TOP of --yes.
    const { stdout, status } = runCli(
      ['force-clear', 'push-in-progress', '--yes', '--reason', 'test cleanup', '--checked', 'holder inspected'],
      { terminalName: 'Мозг' },
    )

    expect(status).toBe(0)
    expect(stdout).toContain('Фабрика') // former holder still printed
    // The claim dir is gone.
    expect(existsSync(join(smaRoot, 'claims', 'push-in-progress'))).toBe(false)

    // The journal carries a 'steal' event with full provenance.
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

  it('Test 6: WITH --yes but WITHOUT evidence → refuses (exit 1, «требует доказательства», claim survives)', () => {
    seedClaim('push-in-progress', {
      by: 'Фабрика',
      pid: 31240,
      session: null,
      at: iso(Date.now() - 30000),
      expectedPrev: null,
      reason: 'push-in-progress:V1.48',
    })

    // --yes alone no longer suffices for a foreign clear — the burden-of-proof gate blocks it.
    const { stdout, status } = runCli(['force-clear', 'push-in-progress', '--yes'], { terminalName: 'Мозг' })

    expect(status).toBe(1)
    expect(stdout).toContain('требует доказательства')
    // Nothing removed — the claim dir survives.
    expect(existsSync(join(smaRoot, 'claims', 'push-in-progress'))).toBe(true)
  })
})

describe('cli.mjs claim + force-clear round-trip', () => {
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

    // A DIFFERENT terminal force-clears it (the foreign-removal path) — with the
    // burden-of-proof evidence (--reason + --checked) on top of --yes.
    const fc = runCli(
      ['force-clear', 'my-scope', '--yes', '--reason', 'test cleanup', '--checked', 'holder inspected'],
      { terminalName: 'Мозг' },
    )
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

describe('cli.mjs window-stable identity across sequential hook PROCESSES (R7 regression)', () => {
  // The lesson from a real regression: exercise the REAL hook seam — two separate `node cli.mjs`
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

  it('two windows sharing a NAME but DIFFERENT session_ids -> TWO distinct leases (concurrent-windows rule preserved)', () => {
    runCli(['collision-check'], { stdin: editStdin('window-alpha'), terminalName: 'exec' })
    runCli(['collision-check'], { stdin: editStdin('window-beta'), terminalName: 'exec' })
    expect(sessionFileCount()).toBe(2)
  })
})

describe('cli.mjs subagent-receipts --stat (honest stat surface)', () => {
  /** Seed a journal .jsonl with the given events under .sma/journal/. */
  function seedJournal(terminalId: string, events: Record<string, unknown>[]) {
    const dir = join(smaRoot, 'journal')
    mkdirSync(dir, { recursive: true })
    const lines = events.map((e, i) => JSON.stringify({ seq: i + 1, terminal: terminalId, ...e })).join('\n') + '\n'
    writeFileSync(join(dir, `${terminalId}.jsonl`), lines)
  }

  /** One pack + one receipt carrying the given tier counts. */
  function seedReceipts(counts: Record<string, number>, transcriptSha = 'sha-1') {
    seedJournal('alpha', [
      { ts: new Date().toISOString(), type: 'subagent-pack', detail: { durationMs: 100 } },
      { ts: new Date().toISOString(), type: 'subagent-receipt', detail: { transcriptSha, counts } },
    ])
  }

  it('Test 1: --stat phantomsAsserted prints the asserted-tier count as the LAST stdout line, exit 0', () => {
    seedReceipts({ verified: 1, phantomToolCall: 0, phantomAsserted: 3 })
    const { stdout, status } = runCli(['subagent-receipts', '--stat', 'phantomsAsserted'], { terminalName: 'Мозг' })
    expect(status).toBe(0)
    expect(stdout.trim().split('\n').pop()).toBe('3')
  })

  it('Test 2: the existing keys are unregressed — coverage / phantoms / pack-p95 still resolve', () => {
    seedReceipts({ verified: 1, phantomToolCall: 2, phantomAsserted: 5 })
    const cov = runCli(['subagent-receipts', '--stat', 'coverage'], { terminalName: 'Мозг' })
    expect(cov.status).toBe(0)
    expect(cov.stdout.trim().split('\n').pop()).toBe('100') // 1 receipt / 1 pack

    const ph = runCli(['subagent-receipts', '--stat', 'phantoms'], { terminalName: 'Мозг' })
    expect(ph.status).toBe(0)
    expect(ph.stdout.trim().split('\n').pop()).toBe('2') // tool-call tier only

    const p95 = runCli(['subagent-receipts', '--stat', 'pack-p95'], { terminalName: 'Мозг' })
    expect(p95.status).toBe(0)
    expect(p95.stdout.trim().split('\n').pop()).toBe('100')
  })

  it('Test 3: an unknown --stat key exits 1 and writes NOTHING to stdout (no fabricated 0 a scorer could read)', () => {
    seedReceipts({ verified: 1, phantomToolCall: 0, phantomAsserted: 0 })
    const { stdout, status } = runCli(['subagent-receipts', '--stat', 'bogus'], { terminalName: 'Мозг' })
    expect(status).toBe(1)
    expect(stdout).toBe('') // the vacuous-pass seam is closed: empty stdout, error on stderr
  })
})

describe('cli.mjs status — collision counter is bounded to today', () => {
  /** Seed a journal .jsonl file with the given events under .sma/journal/. */
  function seedJournal(terminalId: string, events: Record<string, unknown>[]) {
    const dir = join(smaRoot, 'journal')
    mkdirSync(dir, { recursive: true })
    const lines = events.map((e, i) => JSON.stringify({ seq: i + 1, terminal: terminalId, ...e })).join('\n') + '\n'
    writeFileSync(join(dir, `${terminalId}.jsonl`), lines)
  }

  it('counts only TODAY-dated collision events, not the full append-only history', () => {
    const today = new Date().toISOString()
    seedJournal('alpha', [
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

describe('cli.mjs baseline — the measurement verb (capture | replay)', () => {
  it('names both subcommands in its usage and never crashes without one', () => {
    const { stdout } = runCli(['baseline'])
    expect(stdout).toMatch(/baseline capture/)
    expect(stdout).toMatch(/baseline replay/)
    expect(stdout).toMatch(/--record/)
  })

  it('captures a metric against an EMPTY project without inventing numbers', () => {
    // the temp root has no corpus, no settings, no queue — every branch must be honest
    const cost = runCli(['baseline', 'capture', '--only', 'context-cost', '--json'])
    expect(cost.status).toBe(0)
    expect(JSON.parse(cost.stdout).skipped[0]).toMatchObject({ metric: 'context-cost' })

    const hook = runCli(['baseline', 'hook-latency', '--json'])
    expect(hook.status).toBe(0)
    const report = JSON.parse(hook.stdout).reports[0]
    expect(report.metric).toBe('hook-latency')
    expect(report.runs).toBe(0) // no wired hook here
    expect(report.p95_ms).toBeNull() // and therefore no fabricated milliseconds
    expect(report.check_command).toMatch(/^node scripts\/sma\/cli\.mjs baseline/)

    const recovery = runCli(['baseline', 'worker-recovery', '--json'])
    expect(recovery.status).toBe(0)
    const rec = JSON.parse(recovery.stdout).reports[0]
    expect(rec.status).toBe('environment-unavailable')
    expect('recovery_ms' in rec).toBe(false)
  })

  it('replays an empty receipt store as an honest empty, not a failure', () => {
    const { stdout, status } = runCli(['baseline', 'replay', '--json'])
    expect(status).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ replayed: 0, divergent: 0 })
  })

  it('is documented in both READMEs — the same change, both languages', () => {
    const repoRoot = join(__dirname, '..', '..', '..')
    for (const file of ['README.md', 'README.ru.md']) {
      const text = readFileSync(join(repoRoot, file), 'utf8')
      const commands = text.slice(text.indexOf('## Commands') === -1 ? text.indexOf('## Команды') : text.indexOf('## Commands'))
      expect(commands).toContain('baseline')
    }
  })
})

describe('status — the honest active count (a dead pid never impersonates a live terminal)', () => {
  /** A pid that is guaranteed to have existed and to be gone: spawnSync returns AFTER exit. */
  function deadPid(): number {
    const child = spawnSync('node', ['-e', ''])
    return Number(child.pid)
  }

  it('counts a live named lease as active and a dead-pid lease as stale, not working', () => {
    const gone = deadPid()
    seedSession('fabrika', freshForeignLease())
    // The graveyard shape: a one-shot token-less CLI invocation registered `T-<pid>` and
    // exited. Its renewTime is YOUNG (so the age ladder calls it fresh) but the process it
    // names is gone — pre-fix this was reported as a live working terminal.
    seedSession(`t-${gone}`, { ...freshForeignLease(), holderIdentity: `T-${gone}`, pid: gone })

    const { stdout, status } = runCli(['status', '--json'])
    expect(status).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.activeSessions).toBe(1) // ONLY the named live window
    expect(parsed.staleSessions).toBe(1) // the graveyard entry stays visible, separately
  })

  it('the human line reports both counts and lists only the live window', () => {
    const gone = deadPid()
    seedSession('fabrika', freshForeignLease())
    seedSession(`t-${gone}`, { ...freshForeignLease(), holderIdentity: `T-${gone}`, pid: gone })

    const { stdout, status } = runCli(['status'])
    expect(status).toBe(0)
    expect(stdout).toContain('активных сессий 1')
    expect(stdout).toContain('устаревших 1')
    expect(stdout).toContain('Фабрика') // the live window is listed
    expect(stdout).not.toContain(`T-${gone}`) // the dead one is never listed as working
  })
})

// ── a fresh repository is a NORMAL state, and it must not be greeted with «fatal» ──
//
// `git init` and nothing committed yet is exactly where a new install starts. The memory
// commands take one read-only git pass for note dates and are fail-open about it — but
// execFileSync inherits the child's stderr, so git's «fatal: your current branch 'master'
// does not have any commits yet» landed on the terminal of a person whose very first
// command had in fact just succeeded.

describe('cli.mjs memory commands in a repository with no commits yet', () => {
  it('says nothing on stderr — the fail-open git probe keeps its complaints to itself', () => {
    const repo = mkdtempSync(join(tmpdir(), 'sma-unborn-'))
    try {
      spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' })
      const run = spawnSync('node', [CLI, 'load', '--tags', 'x'], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, SMA_ROOT_OVERRIDE: join(repo, '.sma') },
      })
      expect(run.stderr).not.toMatch(/fatal/i)
      expect(run.stderr.trim()).toBe('')
      expect(run.status).toBe(0) // and the command itself still worked
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

// ── `load` asks the lexical layer, and repairs the index it is about to read ──
//
// The point of the hybrid delivery is a query by WORD reaching a record that carries no
// such tag. Proving it end to end needs an index on disk, and a build of Node that can
// hold one — which is exactly the thing a user may not have. So the wire is asserted in
// two halves: the half that runs everywhere (the option is passed at all) and the half
// that needs the engine.
//
// THE INDEX NO LONGER HAS TO BE THERE FIRST. The delivery asks whether the derived index
// still describes the corpus and rebuilds it when it does not, so the case that used to
// read «no index → the facet answer, and here is why» now reads «no index → one gets
// built, and the word arrives». The degradation channel did not disappear and is not
// asserted on a guess: it is exercised where it can be reached on ANY machine, in the
// suite that owns the rebuild points.

const LEXICAL_CAP = lexicalCapability()
const EMDASH = String.fromCharCode(0x2014)

function seedCorpus(root: string) {
  const corpus = join(root, '.claude', 'memory')
  mkdirSync(corpus, { recursive: true })
  writeFileSync(
    join(corpus, 'TAGS.md'),
    `# TAGS\n\n## area\n- tech ${EMDASH} infra, build.\n- docs ${EMDASH} documentation.\n\n## kind\n- reference ${EMDASH} a lookup fact.\n\n## phase\n- Open facet: phase:NN.\n`,
    'utf8',
  )
  writeFileSync(
    join(corpus, 'core-rule.md'),
    '---\ndescription: the always-loaded rule\nkind: reference\ntags: [tech]\nimportance: 9\n---\nbody\n',
    'utf8',
  )
  // The scenario in one file: the word «pangolin» is in the claim and in NO tag.
  writeFileSync(
    join(corpus, 'pangolin-fact.md'),
    '---\ndescription: the pangolin release ships on tuesdays\nkind: reference\ntags: [docs]\nimportance: 4\n---\nbody\n',
    'utf8',
  )
  return corpus
}

describe('cli.mjs load — the delivery point is asked the words of the query', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'sma-load-lexical-'))
    spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' })
    seedCorpus(repo)
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true, maxRetries: 3 })
  })

  const runLoad = (args: string[]) =>
    spawnSync('node', [CLI, 'load', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, SMA_ROOT_OVERRIDE: join(repo, '.sma'), NODE_OPTIONS: '--no-warnings' },
    })

  it('the words of the query reach the delivery point, on any machine', () => {
    const run = runLoad(['--tags', 'pangolin', '--json'])
    expect(run.status).toBe(0)
    const res = JSON.parse(run.stdout)

    // the option reached the delivery point — a run that never asked carries no such
    // field at all, so its presence is the wire and not a formatting detail
    expect(res.meta.lexical).toBeDefined()
    // the honest warning about a word that is not a registered facet is still there
    expect(res.warnings.join(' ')).toContain('not a registered')
  })

  it.skipIf(!LEXICAL_CAP.module)(
    'a repository that never built an index gets one from the delivery itself, and the WORD arrives',
    () => {
      const dbPath = join(repo, '.sma', 'index', LEXICAL_INDEX_FILE)
      expect(existsSync(dbPath)).toBe(false)

      // nobody rebuilt anything by hand between these two lines
      const res = JSON.parse(runLoad(['--tags', 'pangolin', '--json']).stdout)

      expect(existsSync(dbPath)).toBe(true)
      expect(res.meta.lexical.degraded).toBe(false)
      expect(res.periphery).toContain('pangolin-fact.md')
    },
  )
})

describe('cli.mjs context — the pack compiler is on the same hybrid path as the delivery point', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'sma-context-lexical-'))
    spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' })
    seedCorpus(repo)
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true, maxRetries: 3 })
  })

  const runContext = () =>
    spawnSync('node', [CLI, 'context', 'pangolin work on the tech build', '--json'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, SMA_ROOT_OVERRIDE: join(repo, '.sma'), NODE_OPTIONS: '--no-warnings' },
    })

  it('compiles a pack on a repository that has never built an index — exit 0 on any machine', () => {
    const run = runContext()
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout).members.length).toBeGreaterThan(0)
  })

  it.skipIf(!LEXICAL_CAP.module)('repairs the same index the delivery does, and reaches the record only a word can reach', () => {
    const dbPath = join(repo, '.sma', 'index', LEXICAL_INDEX_FILE)
    expect(existsSync(dbPath)).toBe(false)

    // no hand-typed rebuild anywhere in this case either
    const after = JSON.parse(runContext().stdout)

    expect(existsSync(dbPath)).toBe(true)
    expect(after.members.map((m: { id: string }) => m.id)).toContain('pangolin-fact.md')
  })
})
