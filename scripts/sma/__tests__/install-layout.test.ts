/**
 * Regression tests for the installed sma-core payload being SELF-CONTAINED.
 *
 * The defect: sma-core/bin/lib/command-roster.cjs did a top-level
 * `require('../../../scripts/fix-slash-commands.cjs')`. In the source tree that
 * resolves to <repo>/scripts/ (exists); in an install sma-core lands under
 * <configDir>/ (e.g. .claude/sma-core) and the same relative path points at
 * <configDir>/scripts/ — never delivered by the installer — so EVERY
 * `node .claude/sma-core/bin/sma-tools.cjs <anything>` died at require time
 * with MODULE_NOT_FOUND, killing the whole query layer in consumer installs.
 *
 * These tests copy the real sma-core/ payload into an install-shaped temp tree
 * (sma-core under .claude/, NO sibling scripts/, NO package.json) and spawn a
 * real node process against it:
 *   Test 1 — sma-tools.cjs boots from the install layout: --help exits 0 and
 *            prints usage; stderr carries no MODULE_NOT_FOUND.
 *   Test 2 — the query layer actually dispatches: `query current-timestamp date`
 *            exits 0 and returns a date, `query generate-slug` returns a slug.
 *   Test 3 — command-roster.cjs itself loads from the install layout; the
 *            roster degrades to [] without a commands/sma tree and the pure
 *            transforms still work.
 *   Test 4 — dev-tree parity: scripts/fix-slash-commands.cjs re-exports the
 *            same transforms (dependency now points dev → sma-core, not the
 *            reverse), so the one-shot walker and the runtime cannot drift.
 *
 * ── the PRESET group ────────────────────────────────────────────────────────
 *
 * Tests 1-4 answer "does the delivered payload WORK". The preset group answers
 * the other half — "is the delivered payload the RIGHT SET": what a stranger
 * running `npx sma-framework` receives, named item by item, and what they must
 * never receive.
 *
 * The product ships a memory SYSTEM (agents, command skills, a corpus skeleton,
 * a neutral voice) and never a memory CONTENT: not one note of the author's
 * corpus, not the owner's distilled voice. Those are the same asset class — a
 * person's accumulated judgement — and the boundary between "the system ships"
 * and "someone's mind ships" cannot rest on nobody having made a mistake yet.
 * So it is machine-checked, by FORM: a note is a `.md` with a leading `---`
 * frontmatter fence; the skeleton files carry none, and a fresh install must
 * contain zero of the former.
 *
 * These tests run the REAL installer into a temp project (the init-hooks.test.ts
 * end-to-end pattern), because the question is what the installer DELIVERS, not
 * what the source tree contains:
 *   Test 5 — the roster is frozen BY NAME: the exact agent list, the exact skill
 *            list, the exact corpus skeleton. Adding or dropping a preset item
 *            without saying so out loud turns this red on purpose.
 *   Test 6 — zero content notes: no frontmatter-bearing `.md` in the installed
 *            corpus; the index is honestly generated at 0 notes and is
 *            regen-identical (`build-index --check` exits 0 on a fresh install).
 *   Test 7 — the voice: the neutral base policy is in the shipped package, and
 *            NO owner distillate (`distilled-policy.md`) is anywhere in it. The
 *            neutral base is the only policy that ever ships; the owner's voice
 *            is learned on the user's own machine, from the user's own
 *            decisions, and lives in their runtime data dir.
 *   Test 8 — leak scan of the delivery: no house marker (private backlog ids,
 *            the house phase numbering, workspace/author identity) survives in
 *            anything the installer writes into a consumer project.
 */

import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const require = createRequire(import.meta.url)
const repoRoot = join(__dirname, '..', '..', '..')

let tmp: string
let projDir: string
let smaTools: string
let rosterPath: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sma-install-layout-'))
  projDir = join(tmp, 'proj')
  mkdirSync(join(projDir, '.claude'), { recursive: true })
  // Install-shaped: ONLY the sma-core payload under .claude/ — exactly what
  // bin/init.mjs delivers. No .claude/scripts/, no package.json.
  cpSync(join(repoRoot, 'sma-core'), join(projDir, '.claude', 'sma-core'), { recursive: true })
  smaTools = join(projDir, '.claude', 'sma-core', 'bin', 'sma-tools.cjs')
  rosterPath = join(projDir, '.claude', 'sma-core', 'bin', 'lib', 'command-roster.cjs')
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function runNode(args: string[], cwd: string) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 25000 })
}

describe('install layout — sma-tools boots (Test 1)', () => {
  it('the premise holds: the install tree has no scripts/ next to sma-core', () => {
    expect(existsSync(join(projDir, '.claude', 'scripts'))).toBe(false)
  })

  it('--help exits 0 with usage, no MODULE_NOT_FOUND', () => {
    const res = runNode([smaTools, '--help'], projDir)
    expect(res.stderr ?? '').not.toContain('Cannot find module')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Usage: sma-tools')
  })
})

describe('install layout — query layer dispatches (Test 2)', () => {
  it('query current-timestamp date returns a date', () => {
    const res = runNode([smaTools, 'query', 'current-timestamp', 'date'], projDir)
    expect(res.stderr ?? '').not.toContain('Cannot find module')
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('query generate-slug returns a slug', () => {
    const res = runNode([smaTools, 'query', 'generate-slug', 'Install Layout Works'], projDir)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('install-layout-works')
  })
})

describe('install layout — command-roster is self-contained (Test 3)', () => {
  it('loads without a sibling scripts/ dir; empty roster degrades to []; transforms work', () => {
    const probe = join(tmp, 'probe.cjs')
    writeFileSync(probe, [
      'const r = require(process.argv[2]);',
      'process.stdout.write(JSON.stringify({',
      '  names: r.readSmaCommandNames(),',
      "  toHyphen: r.transformContentToHyphen('run /sma:plan-phase now', ['plan-phase']),",
      "  toColon: r.transformContent('run /sma-plan-phase now', ['plan-phase']),",
      "  emptyNoop: r.transformContentToHyphen('run /sma:plan-phase now', []),",
      '}));',
    ].join('\n'))
    const res = runNode([probe, rosterPath], projDir)
    expect(res.stderr ?? '').not.toContain('Cannot find module')
    expect(res.status).toBe(0)
    const out = JSON.parse(res.stdout)
    expect(Array.isArray(out.names)).toBe(true)
    expect(out.names).toEqual([]) // no commands/sma tree in this install shape
    expect(out.toHyphen).toBe('run /sma-plan-phase now')
    expect(out.toColon).toBe('run /sma:plan-phase now')
    expect(out.emptyNoop).toBe('run /sma:plan-phase now') // empty registry must never rewrite
  })
})

// ─────────────────────────── the preset roster ───────────────────────────────

/**
 * THE PRESET, FROZEN BY NAME.
 *
 * Deliberately a literal list and not `readdirSync(sourceDir)` — a list derived
 * from the source can never disagree with the source, which is exactly the
 * disagreement worth catching. Changing what a stranger receives should cost one
 * edit here and a sentence in the commit message; that is the whole mechanism.
 */
const PRESET_AGENTS = [
  'sma-advisor-researcher.md',
  'sma-ai-researcher.md',
  'sma-assumptions-analyzer.md',
  'sma-code-fixer.md',
  'sma-code-reviewer.md',
  'sma-codebase-mapper.md',
  'sma-debug-session-manager.md',
  'sma-debugger.md',
  'sma-doc-classifier.md',
  'sma-doc-synthesizer.md',
  'sma-doc-verifier.md',
  'sma-doc-writer.md',
  'sma-domain-researcher.md',
  'sma-eval-auditor.md',
  'sma-eval-planner.md',
  'sma-executor.md',
  'sma-framework-selector.md',
  'sma-integration-checker.md',
  'sma-intel-updater.md',
  'sma-mempalace-curator.md',
  'sma-nyquist-auditor.md',
  'sma-pattern-mapper.md',
  'sma-phase-researcher.md',
  'sma-plan-checker.md',
  'sma-planner.md',
  'sma-project-researcher.md',
  'sma-research-synthesizer.md',
  'sma-roadmapper.md',
  'sma-security-auditor.md',
  'sma-ui-auditor.md',
  'sma-ui-checker.md',
  'sma-ui-researcher.md',
  'sma-user-profiler.md',
  'sma-verifier.md',
]

const PRESET_SKILLS = [
  'sma-debug',
  'sma-deleteme',
  'sma-discuss-phase',
  'sma-execute-phase',
  'sma-fast',
  'sma-help',
  'sma-pause-work',
  'sma-plan-phase',
  'sma-progress',
  'sma-quick',
  'sma-resume-work',
  'sma-start',
  'sma-update',
  'sma-verify-work',
]

/** The corpus skeleton: structure only. Any THIRD file here is content. */
const PRESET_MEMORY = ['MEMORY.md', 'TAGS.md']

/**
 * House markers — the private-workspace vocabulary that must never cross into a
 * delivery. Narrow on purpose: the product legitimately talks about blocker ids
 * (`BL-901` in a fixture, `BL-01` in an enforcement example), so the scan hunts
 * the PRIVATE families only — the house backlog counter, the house phase
 * numbering that predates the public 1..11 scheme, and author/workspace identity.
 */
const HOUSE_MARKERS: [string, RegExp][] = [
  ['house backlog id', /\bSB-\d{2,3}\b/],
  ['house phase numbering', /\b49\.\d\b/],
  ['house decision id', /\bD-49\b/],
  ['private workspace path', /sma-dev[\\/]\.planning/],
  ['author identity', /Junisa|Maslov|Матвей Маслов/],
  ['downstream consumer name', /mass-platform-institut/],
]

/** Every file under `dir`, recursively, as absolute paths. */
function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(p, out)
    else if (entry.isFile()) out.push(p)
  }
  return out
}

/** A memory NOTE is a `.md` opening with a `---` frontmatter fence (frontmatter.mjs). */
function isNoteShaped(text: string): boolean {
  return text.startsWith('---\n') || text.startsWith('---\r\n')
}

describe('preset — what a stranger actually receives (Tests 5-8)', () => {
  let ptmp: string
  let proj: string

  beforeAll(() => {
    ptmp = mkdtempSync(join(tmpdir(), 'sma-preset-'))
    proj = join(ptmp, 'consumer')
    mkdirSync(proj, { recursive: true })
    // The REAL installer, exactly as `npx sma-framework init --local` runs it.
    const res = spawnSync(process.execPath, [join(repoRoot, 'bin', 'init.mjs'), '--local'], {
      cwd: proj,
      encoding: 'utf8',
      timeout: 90000,
    })
    if (res.status !== 0) throw new Error(`installer failed (${res.status}): ${res.stderr || res.stdout}`)
  }, 120000)

  afterAll(() => {
    rmSync(ptmp, { recursive: true, force: true })
  })

  // ── Test 5: the roster, by name ───────────────────────────────────────────

  it('delivers EXACTLY the preset agents, by name', () => {
    expect(readdirSync(join(proj, '.claude', 'agents')).sort()).toEqual([...PRESET_AGENTS].sort())
  })

  it('delivers EXACTLY the preset command skills, each a real SKILL.md', () => {
    const skills = readdirSync(join(proj, '.claude', 'skills')).sort()
    expect(skills).toEqual([...PRESET_SKILLS].sort())
    for (const s of skills) {
      const body = readFileSync(join(proj, '.claude', 'skills', s, 'SKILL.md'), 'utf8')
      expect(body).toContain(`name: ${s}`)
      // The skill is a pointer at the engine, so the engine must be pointed AT.
      expect(body).toContain('.claude/sma-core/workflows/')
    }
  })

  it('delivers the engine and the runtime the hooks are wired to', () => {
    expect(existsSync(join(proj, '.claude', 'sma-core', 'bin', 'sma-tools.cjs'))).toBe(true)
    expect(existsSync(join(proj, 'scripts', 'sma', 'cli.mjs'))).toBe(true)
    const settings = JSON.parse(readFileSync(join(proj, '.claude', 'settings.json'), 'utf8'))
    const commands = JSON.stringify(settings.hooks)
    expect(commands).toContain('node scripts/sma/cli.mjs pre')
    expect(commands).toContain('node scripts/sma/cli.mjs session-start')
  })

  it('delivers the memory SYSTEM: the corpus skeleton exists, and is only the skeleton', () => {
    const corpus = join(proj, '.claude', 'memory')
    expect(existsSync(corpus)).toBe(true)
    expect(readdirSync(corpus).sort()).toEqual([...PRESET_MEMORY].sort())
    // The rules block the installer writes points every agent here at session
    // start — a pointer at a file no install creates is the bug this freezes.
    expect(readFileSync(join(proj, 'CLAUDE.md'), 'utf8')).toContain('.claude/memory/MEMORY.md')
    // The closed vocabulary ships, so the very first note has a registry to be
    // checked against (an unregistered tag is a lint critical, not a surprise).
    const tags = readFileSync(join(corpus, 'TAGS.md'), 'utf8')
    for (const facet of ['## area', '## kind', '## phase']) expect(tags).toContain(facet)
    for (const kind of ['procedural-rule', 'decision', 'episodic', 'status', 'reference', 'bug-lesson']) {
      expect(tags).toContain(`- ${kind} —`)
    }
  })

  // ── Test 6: zero content ──────────────────────────────────────────────────

  it('ships ZERO content notes: nothing in the corpus is note-shaped', () => {
    const corpus = join(proj, '.claude', 'memory')
    const notes = readdirSync(corpus)
      .filter((f) => f.endsWith('.md'))
      .filter((f) => isNoteShaped(readFileSync(join(corpus, f), 'utf8')))
    expect(notes).toEqual([])
  })

  it('ships an index that is honestly EMPTY and regen-identical', () => {
    const index = readFileSync(join(proj, '.claude', 'memory', 'MEMORY.md'), 'utf8')
    expect(index).toContain('GENERATED')
    expect(index).toMatch(/заметок: 0 · ядро: 0/)
    // Not a template imitating generated output: regenerating from the corpus
    // reproduces this byte-for-byte, so a fresh install starts lint-clean.
    const check = spawnSync(process.execPath, [join('scripts', 'sma', 'cli.mjs'), 'build-index', '--check'], {
      cwd: proj,
      encoding: 'utf8',
      timeout: 30000,
    })
    expect(check.status).toBe(0)
  })

  it('never clobbers a live corpus: a second install leaves the user\'s note alone', () => {
    const corpus = join(proj, '.claude', 'memory')
    const mine = join(corpus, 'reference_mine.md')
    const body = '---\ndescription: my own note, written by me\nkind: reference\ntags: [tech]\nimportance: 9\n---\n\nMine.\n'
    writeFileSync(mine, body, 'utf8')
    const tagsBefore = readFileSync(join(corpus, 'TAGS.md'), 'utf8')

    const again = spawnSync(process.execPath, [join(repoRoot, 'bin', 'init.mjs'), '--local'], {
      cwd: proj,
      encoding: 'utf8',
      timeout: 90000,
    })
    expect(again.status).toBe(0)
    expect(readFileSync(mine, 'utf8')).toBe(body)
    expect(readFileSync(join(corpus, 'TAGS.md'), 'utf8')).toBe(tagsBefore)

    rmSync(mine)
  }, 120000)

  // ── Test 7: the voice ─────────────────────────────────────────────────────

  it('ships the NEUTRAL base voice and no owner distillate', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    // The published payload is defined by package.json `files` — that list is
    // what a consumer downloads, so it is the honest scope for this question.
    expect(pkg.files).toContain('daemon')
    const neutral = join(repoRoot, 'daemon', 'src', 'policy', 'neutral-policy.md')
    expect(existsSync(neutral)).toBe(true)
    expect(readFileSync(neutral, 'utf8').length).toBeGreaterThan(0)

    // The owner's distilled voice is produced on the user's machine from the
    // user's own decisions and lives in their runtime data dir. It is corpus
    // content by another name, and it ships never.
    const shipped = (pkg.files as string[])
      .map((f) => join(repoRoot, f))
      .filter((p) => existsSync(p))
      .flatMap((p) => (statSync(p).isDirectory() ? walkFiles(p) : [p]))
    const distillates = shipped.filter((p) => /(^|[\\/])distilled-policy\.md$/.test(p))
    expect(distillates).toEqual([])
  })

  // ── Test 8: leak scan of the delivery ─────────────────────────────────────

  it('carries no house marker into a consumer project', () => {
    const delivered = [
      ...walkFiles(join(proj, '.claude')),
      ...walkFiles(join(proj, 'scripts')),
      join(proj, 'CLAUDE.md'),
    ]
    expect(delivered.length).toBeGreaterThan(100) // the scan actually scanned

    const hits: string[] = []
    for (const file of delivered) {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const [label, re] of HOUSE_MARKERS) {
        const m = text.match(re)
        if (m) hits.push(`${relative(proj, file).split(sep).join('/')}: ${label} (${m[0]})`)
      }
    }
    expect(hits).toEqual([])
  })
})

describe('source tree — dev one-shot re-exports the shared transforms (Test 4)', () => {
  it('scripts/fix-slash-commands.cjs and command-roster.cjs expose the SAME functions', () => {
    const devScript = require(join(repoRoot, 'scripts', 'fix-slash-commands.cjs'))
    const roster = require(join(repoRoot, 'sma-core', 'bin', 'lib', 'command-roster.cjs'))
    // Identity, not equivalence: a copy could drift, the same reference cannot.
    expect(devScript.transformContent).toBe(roster.transformContent)
    expect(devScript.transformContentToHyphen).toBe(roster.transformContentToHyphen)
    expect(devScript.buildPattern).toBe(roster.buildPattern)
    expect(devScript.buildColonPattern).toBe(roster.buildColonPattern)
    expect(devScript.readCmdNames).toBe(roster.readSmaCommandNames)
    expect(devScript.SKIP_DIRS).toBeInstanceOf(Set)
  })
})
