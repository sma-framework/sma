/**
 * Tests for scripts/sma/lib/reflex.mjs (Phase 49.1 Plan 10, Task 1 — B1/B2).
 *
 * P2 reflex consumer core: deriveTags + matchReflexes + applyFatigue + formatWarn.
 *
 * CR-01 discipline (RESEARCH Pitfall 1): the stdin fixture is REAL-SHAPE — an
 * absolute Windows path in the mock hook payload, mirroring what Claude Code
 * actually delivers. A relative-path fixture would happily green a dead feature
 * (the exact CR-01 regression class already fixed once in collision.mjs/cli.mjs).
 *
 *   - Test 1 (CR-01 class): real-shape Edit event (absolute C:\ path into
 *     src/migrations) matches a bug-lesson tagged area:payload -> 1 candidate.
 *   - Test 2: same event twice in one session -> second call yields ZERO warns
 *     (per-session dedup via the seen-store).
 *   - Test 3: importance 9 -> verbose; 5 -> one-liner; 2 -> silent.
 *   - Test 4: SMA_REFLEX_DISABLE=1 -> zero warns regardless of matches.
 *   - Test 5: use-when-pattern "src/migrations/**" does NOT fire on src/crm/foo.ts
 *     even when tags overlap (precision hint narrows, never widens).
 *   - Test 6: loader failure (injected throw) -> empty result, never throws.
 *   - Test 7: per-note opt-out (reflex: off) -> the note never fires.
 *   - Test 8: explain-once-then-pointer — same note, new targetClass -> pointer tier.
 *   - Test 9: seen-store is session-scoped — a new session_id resets it.
 *   - Test 10: Bash command-verb heuristics -> operation tags (migration class).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  deriveTags,
  matchReflexes,
  applyFatigue,
  formatWarn,
  loadSeen,
  saveSeen,
} from '../lib/reflex.mjs'
import * as loader from '../lib/loader.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(__dirname, 'fixtures', 'real-shape-edit.json')
const CLI = join(__dirname, '..', 'cli.mjs')

const TAGS_MD = `# TAGS

## area
- payload — CMS, схема, миграции. · aliases: migrations, migration
- crm — CRM surfaces.
- tech — infra, git, build. · aliases: git

## kind
- bug-lesson — a lesson from a bug. · aliases: lesson
- procedural-rule — a how-to rule.

## phase
- Open facet: phase:NN.
`

function note(dir: string, name: string, fm: Record<string, unknown>, body = 'body\n') {
  const lines = ['---']
  for (const [k, v] of Object.entries(fm)) {
    if (k === 'tags' && Array.isArray(v)) lines.push(`tags: [${v.join(', ')}]`)
    else lines.push(`${k}: ${v}`)
  }
  lines.push('---')
  writeFileSync(join(dir, name), lines.join('\n') + '\n' + body, 'utf8')
}

/** A synthetic candidate for the pure applyFatigue tests. */
function cand(noteId: string, importance: number) {
  return {
    noteId,
    file: `${noteId}.md`,
    importance,
    description: `rule ${noteId}`,
    useWhen: 'when relevant',
    body: '## How to apply\nDo the thing carefully.\n',
  }
}

let corpusDir: string
let tagsPath: string

beforeEach(() => {
  corpusDir = mkdtempSync(join(tmpdir(), 'sma-reflex-'))
  tagsPath = join(corpusDir, 'TAGS.md')
  writeFileSync(tagsPath, TAGS_MD, 'utf8')

  // The one promoted bug-lesson the base corpus carries: area payload, about migrations.
  note(
    corpusDir,
    'lesson-migration.md',
    {
      description: 'Every schema change needs a registered migration',
      kind: 'bug-lesson',
      tags: ['payload'],
      'use-when': 'touching migrations',
      importance: 6,
    },
    '## How to apply\nRegister the migration in src/migrations/index.ts before pushing.\n',
  )
})

afterEach(() => {
  rmSync(corpusDir, { recursive: true, force: true })
})

describe('reflex.mjs — deriveTags + matchReflexes (B2)', () => {
  it('Test 1 (CR-01 class): real-shape absolute-path Edit event -> 1 warn candidate', () => {
    const evt = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    // The fixture MUST be real-shape: an absolute Windows path (CR-01 lesson).
    expect(evt.tool_input.file_path).toMatch(/^[A-Za-z]:\\/)

    const { tags, target } = deriveTags(evt.tool_input, evt.cwd)
    expect(target).toBe('src/migrations/index.ts') // relativized BEFORE matching

    const candidates = matchReflexes({ tags, target, corpusDir, tagsPath, loader })
    expect(candidates).toHaveLength(1)
    expect(candidates[0].noteId).toBe('lesson-migration')
  })

  it('Test 5: use-when-pattern narrows — no fire on src/crm/foo.ts despite tag overlap', () => {
    note(
      corpusDir,
      'lesson-crm-narrow.md',
      {
        description: 'A crm-tagged lesson scoped to migrations only',
        kind: 'bug-lesson',
        tags: ['crm'],
        'use-when': 'migration edits',
        'use-when-pattern': 'src/migrations/**',
        importance: 6,
      },
    )
    const evt = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    const filePath = String(evt.tool_input.file_path).replace(
      'src\\migrations\\index.ts',
      'src\\crm\\foo.ts',
    )
    const { tags, target } = deriveTags({ file_path: filePath }, evt.cwd)
    expect(target).toBe('src/crm/foo.ts')
    const candidates = matchReflexes({ tags, target, corpusDir, tagsPath, loader })
    expect(candidates).toHaveLength(0)
  })

  it('Test 6: loader failure (injected throw) -> empty result, never throws (fail-open)', () => {
    const throwingLoader = {
      resolvePeriphery() {
        throw new Error('boom')
      },
    }
    const res = matchReflexes({
      tags: ['migrations'],
      target: 'src/migrations/index.ts',
      corpusDir,
      tagsPath,
      loader: throwingLoader,
    })
    expect(res).toEqual([])
  })

  it('Test 7: per-note opt-out (reflex: off) -> the note never fires', () => {
    note(corpusDir, 'lesson-optout.md', {
      description: 'An opted-out lesson',
      kind: 'bug-lesson',
      tags: ['payload'],
      'use-when': 'never, it opted out',
      reflex: 'off',
      importance: 9,
    })
    const evt = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    const { tags, target, targetClass } = deriveTags(evt.tool_input, evt.cwd)
    const candidates = matchReflexes({ tags, target, corpusDir, tagsPath, loader })
    const { warns } = applyFatigue({ candidates, targetClass, sessionSeen: {}, env: {} })
    expect(warns.map((w: any) => w.noteId)).not.toContain('lesson-optout')
    expect(warns.map((w: any) => w.noteId)).toContain('lesson-migration')
  })

  it('Test 10: Bash command-verb heuristics -> operation tags', () => {
    const { tags, targetClass } = deriveTags(
      { command: 'pnpm payload migrate:create && git add src/migrations/index.ts' },
      'C:\\repo',
    )
    expect(tags).toContain('migration')
    expect(tags).toContain('git')
    expect(targetClass).toMatch(/^bash:/)
  })
})

describe('reflex.mjs — applyFatigue (launch-blocking battery, Pitfall 2)', () => {
  it('Test 2: same event twice in one session -> second call returns ZERO warns (dedup)', () => {
    const evt = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    const { tags, target, targetClass } = deriveTags(evt.tool_input, evt.cwd)
    const candidates = matchReflexes({ tags, target, corpusDir, tagsPath, loader })
    expect(candidates.length).toBeGreaterThan(0)

    const first = applyFatigue({ candidates, targetClass, sessionSeen: {}, env: {} })
    expect(first.warns).toHaveLength(1)
    const second = applyFatigue({ candidates, targetClass, sessionSeen: first.seen, env: {} })
    expect(second.warns).toHaveLength(0)
  })

  it('Test 3: importance tiers — 9 verbose, 5 one-liner, 2 silent', () => {
    const { warns } = applyFatigue({
      candidates: [cand('hi', 9), cand('mid', 5), cand('lo', 2)],
      targetClass: 'src/migrations',
      sessionSeen: {},
      env: {},
    })
    const hi = warns.find((w: any) => w.noteId === 'hi')
    const mid = warns.find((w: any) => w.noteId === 'mid')
    expect(hi).toBeDefined()
    expect(hi.tier).toBe('verbose')
    expect(hi.text).toContain('\n') // multi-line: rule + How-to-apply extract
    expect(hi.text).toContain('Do the thing carefully')
    expect(mid).toBeDefined()
    expect(mid.tier).toBe('oneliner')
    expect(mid.text).not.toContain('\n')
    expect(warns.find((w: any) => w.noteId === 'lo')).toBeUndefined() // silent tier
  })

  it('Test 4: SMA_REFLEX_DISABLE=1 -> zero warns regardless of matches (kill-switch)', () => {
    const { warns } = applyFatigue({
      candidates: [cand('hi', 9), cand('mid', 5)],
      targetClass: 'src/migrations',
      sessionSeen: {},
      env: { SMA_REFLEX_DISABLE: '1' },
    })
    expect(warns).toHaveLength(0)
  })

  it('Test 8: explain-once-then-pointer — same note, new targetClass -> pointer', () => {
    const c = [cand('hi', 9)]
    const r1 = applyFatigue({ candidates: c, targetClass: 'a', sessionSeen: {}, env: {} })
    expect(r1.warns[0].tier).toBe('verbose')
    const r2 = applyFatigue({ candidates: c, targetClass: 'b', sessionSeen: r1.seen, env: {} })
    expect(r2.warns).toHaveLength(1)
    expect(r2.warns[0].tier).toBe('pointer')
    expect(r2.warns[0].text).toContain('hi') // one-line pointer names the note
  })
})

describe('reflex.mjs — seen-store (session-scoped cooldown)', () => {
  let reflexDir: string
  beforeEach(() => {
    reflexDir = mkdtempSync(join(tmpdir(), 'sma-reflex-seen-'))
  })
  afterEach(() => {
    rmSync(reflexDir, { recursive: true, force: true })
  })

  it('Test 9: round-trips per terminal; a NEW session_id resets the store', () => {
    const seen = { session: 's1', keys: { 'hi::a': 1 }, notes: { hi: 1 } }
    saveSeen(seen, { reflexDir, terminalId: 'term' })

    const same = loadSeen({ reflexDir, terminalId: 'term', sessionToken: 's1' })
    expect(same.keys?.['hi::a']).toBe(1)

    const fresh = loadSeen({ reflexDir, terminalId: 'term', sessionToken: 's2' })
    expect(fresh.keys?.['hi::a']).toBeUndefined() // session-scoped, not corpus-scoped
  })
})

describe('reflex.mjs — formatWarn', () => {
  it('verbose carries rule + how-to-apply + note id; pointer is a one-line reference', () => {
    const c = cand('lesson-x', 9)
    const verbose = formatWarn(c, 'verbose')
    expect(verbose).toContain('lesson-x')
    expect(verbose).toContain('rule lesson-x')
    expect(verbose).toContain('Do the thing carefully')
    const pointer = formatWarn(c, 'pointer')
    expect(pointer).not.toContain('\n')
    expect(pointer).toContain('lesson-x')
  })
})

describe('cli.mjs reflex-check (hook consumer, Task 2)', () => {
  let repoRoot: string
  let smaRoot: string

  function runCli(args: string[], stdin: string): { stdout: string; status: number } {
    try {
      const stdout = execFileSync('node', [CLI, ...args], {
        input: stdin,
        encoding: 'utf8',
        env: {
          ...process.env,
          SMA_ROOT_OVERRIDE: smaRoot,
          SMA_TERMINAL_NAME: 'Мозг',
          SMA_REFLEX_DISABLE: '',
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

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'sma-reflex-cli-'))
    smaRoot = join(repoRoot, '.sma')
    mkdirSync(smaRoot, { recursive: true })
    const corpus = join(repoRoot, '.claude', 'memory')
    mkdirSync(corpus, { recursive: true })
    writeFileSync(join(corpus, 'TAGS.md'), TAGS_MD, 'utf8')
    note(
      corpus,
      'lesson-migration.md',
      {
        description: 'Every schema change needs a registered migration',
        kind: 'bug-lesson',
        tags: ['payload'],
        'use-when': 'touching migrations',
        importance: 6,
      },
      '## How to apply\nRegister the migration in src/migrations/index.ts before pushing.\n',
    )
  })

  afterEach(() => {
    try {
      rmSync(repoRoot, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  it('garbage stdin -> exit 0, no output (fail-open proof)', () => {
    const { stdout, status } = runCli(['reflex-check'], 'this is not json {{{')
    expect(status).toBe(0)
    expect(stdout).toBe('')
  })

  it('real-shape replay against a seeded matching note -> additionalContext, allow', () => {
    // Real-shape stdin: ABSOLUTE Windows path under the temp repo root (CR-01).
    const stdin = JSON.stringify({
      session_id: 'cli-session-1',
      cwd: repoRoot,
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(repoRoot, 'src', 'migrations', 'index.ts') },
    })
    const { stdout, status } = runCli(['reflex-check'], stdin)
    expect(status).toBe(0)
    const out = JSON.parse(stdout)
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow') // NEVER deny (D-49.1-12)
    expect(out.hookSpecificOutput.additionalContext).toContain('lesson-migration')
  })

  it('second identical replay in the SAME session -> no output (dedup persisted)', () => {
    const stdin = JSON.stringify({
      session_id: 'cli-session-2',
      cwd: repoRoot,
      tool_name: 'Edit',
      tool_input: { file_path: join(repoRoot, 'src', 'migrations', 'index.ts') },
    })
    const a = runCli(['reflex-check'], stdin)
    expect(a.stdout).not.toBe('')
    const b = runCli(['reflex-check'], stdin)
    expect(b.status).toBe(0)
    expect(b.stdout).toBe('')
  })

  it('SMA_REFLEX_DISABLE=1 -> exit 0, no output even with a matching note', () => {
    const stdin = JSON.stringify({
      session_id: 'cli-session-3',
      cwd: repoRoot,
      tool_name: 'Edit',
      tool_input: { file_path: join(repoRoot, 'src', 'migrations', 'index.ts') },
    })
    try {
      const stdout = execFileSync('node', [CLI, 'reflex-check'], {
        input: stdin,
        encoding: 'utf8',
        env: { ...process.env, SMA_ROOT_OVERRIDE: smaRoot, SMA_REFLEX_DISABLE: '1' },
      })
      expect(stdout).toBe('')
    } catch {
      throw new Error('reflex-check must exit 0 under the kill-switch')
    }
  })
})
