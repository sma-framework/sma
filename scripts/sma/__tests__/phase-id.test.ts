/**
 * Regression tests for phase-directory identity and ROADMAP phase parsing.
 *
 * Two defects, one symptom — "Phase not found" for a directory that plainly
 * exists, and a phase number silently reused by `phase add`:
 *
 *   (1) Greedy phase token. extractPhaseToken accumulated EVERY leading
 *       digit-starting segment of a directory name, so `09-49-7-search-rewrite`
 *       yielded the token `09-49-7`, which equals no normalized phase. The whole
 *       query layer that keys off it — find-phase, phase-plan-index, phases
 *       list, state/roadmap phase resolution — reported the directory missing.
 *       The token now stops at the first leading run that already spells a
 *       complete phase number; longer runs survive as alternative candidates so
 *       milestone-decomposed ids (`01-02-name`) still resolve by their full id.
 *
 *   (2) Hand-made `phase-N-slug` directories. Real trees are written by hand as
 *       `phase-8-user-accounts`; the resolver read `phase` as a project_code and
 *       compared the unpadded `8` against the padded `08`, so it never matched.
 *       The label is now recognized and candidates are compared normalized.
 *
 *   (3) English-only ROADMAP scan. The scans that COUNT used phase numbers
 *       matched `Phase N:` only, with the colon immediately after the number. A
 *       roadmap written in another language, or a heading carrying an aside
 *       (`### Phase 8 (revised): …`), counted as zero phases — and `phase add`
 *       then handed out a number that was already taken.
 *
 * The pure cases exercise the helper directly; the end-to-end cases spawn the
 * REAL sma-tools binary against a temp project, because the defect was only
 * ever visible through the query layer.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const require = createRequire(import.meta.url)
const repoRoot = join(__dirname, '..', '..', '..')
const smaTools = join(repoRoot, 'sma-core', 'bin', 'sma-tools.cjs')

const { splitPhaseDirName, extractPhaseToken, phaseTokenMatches, normalizePhaseName } = require(
  join(repoRoot, 'sma-core', 'bin', 'lib', 'phase-id.cjs'),
)

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sma-phase-id-'))
})

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

/** A project with the given phase directories and ROADMAP body. */
function makeProject(name: string, phaseDirs: string[], roadmap: string): string {
  const proj = join(tmp, name)
  mkdirSync(join(proj, '.planning', 'phases'), { recursive: true })
  for (const dir of phaseDirs) mkdirSync(join(proj, '.planning', 'phases', dir), { recursive: true })
  writeFileSync(join(proj, '.planning', 'ROADMAP.md'), roadmap, 'utf8')
  return proj
}

/**
 * Run sma-tools against `proj` and parse its JSON output.
 *
 * The spawn result is CHECKED before it is parsed. `JSON.parse(res.stdout)` on a
 * child that never printed throws `SyntaxError: Unexpected end of JSON input` —
 * a message that names neither the command, nor its exit code, nor the stderr
 * that would say why, and that is the exact red on record for this file under
 * full-suite load. A starved, killed or crashed child is a
 * legitimate failure; it just has to arrive readable. Nothing is retried and
 * nothing is swallowed: this converts an opaque crash into a diagnosis.
 */
function tools(proj: string, args: string[]): Record<string, unknown> {
  const res = spawnSync(process.execPath, [smaTools, ...args, '--cwd', proj], { encoding: 'utf8' })
  expect(res.stderr).not.toMatch(/MODULE_NOT_FOUND/)
  const stdout = res.stdout ?? ''
  if (res.error || res.status !== 0 || stdout.trim() === '') {
    throw new Error(
      `sma-tools ${args.join(' ')} gave no parseable stdout — ` +
        `status=${res.status} signal=${res.signal} spawnError=${res.error ? res.error.message : 'none'}\n` +
        `stdout: ${JSON.stringify(stdout.slice(0, 300))}\n` +
        `stderr: ${JSON.stringify((res.stderr ?? '').slice(0, 600))}`,
    )
  }
  return JSON.parse(stdout) as Record<string, unknown>
}

// ── the token: directory name -> phase id + slug ────────────────────────────

describe('splitPhaseDirName — the phase number, and where the slug starts', () => {
  // [directory, token, slug]
  const cases: [string, string, string][] = [
    // canonical shapes — unchanged
    ['08-user-accounts', '08', 'user-accounts'],
    ['49-foundation', '49', 'foundation'],
    ['49.5-orchestration', '49.5', 'orchestration'],
    ['12A-hotfix', '12A', 'hotfix'],
    ['CK-08-user-accounts', 'CK-08', 'user-accounts'],
    // a slug that itself starts with digit segments must not be eaten
    ['09-49-7-search-rewrite', '09', '49-7-search-rewrite'],
    ['08-1-30-49-7-batch-import', '08', '1-30-49-7-batch-import'],
    // hand-made directories that spell the word out
    ['phase-8-user-accounts', '8', 'user-accounts'],
    ['phase-7-checkout-flow', '7', 'checkout-flow'],
    // no number at all — the whole name is the token, as before
    ['no-number-here', 'no-number-here', ''],
  ]

  for (const [dir, token, slug] of cases) {
    it(`reads "${dir}" as token "${token}" + slug "${slug}"`, () => {
      const split = splitPhaseDirName(dir)
      expect(split.token).toBe(token)
      expect(split.slug).toBe(slug)
      expect(extractPhaseToken(dir)).toBe(token)
    })
  }

  it('keeps every longer leading run as an alternative candidate', () => {
    // A milestone-decomposed id and a digit-leading slug are the same string
    // shape, so the directory answers to both readings and the caller picks.
    expect(splitPhaseDirName('01-02-decomposed').candidates).toEqual(['01', '01-02'])
    expect(splitPhaseDirName('09-49-7-search-rewrite').candidates).toEqual(['09', '09-49', '09-49-7'])
  })
})

describe('phaseTokenMatches — which directory answers to which phase', () => {
  const resolves: [string, string][] = [
    ['09-49-7-search-rewrite', '9'],
    ['08-1-30-49-7-batch-import', '8'],
    ['phase-8-user-accounts', '8'],
    ['phase-7-checkout-flow', '7'],
    ['49.5-orchestration', '49.5'],
    ['49-foundation', '49'],
    ['08-user-accounts', '08'],
    ['CK-08-user-accounts', '8'],
    // milestone-decomposed: the full id still resolves, and so does its head
    ['01-02-decomposed', '1-2'],
    ['01-02-decomposed', '1'],
  ]

  for (const [dir, query] of resolves) {
    it(`"${dir}" resolves for phase ${query}`, () => {
      expect(phaseTokenMatches(dir, normalizePhaseName(query))).toBe(true)
    })
  }

  const rejects: [string, string][] = [
    // digits belonging to the slug are not a phase number of their own
    ['09-49-7-search-rewrite', '49'],
    ['phase-8-user-accounts', '9'],
    // no prefix bleeding: phase 10 is not phase 1
    ['10-user-accounts', '1'],
  ]

  for (const [dir, query] of rejects) {
    it(`"${dir}" does not answer to phase ${query}`, () => {
      expect(phaseTokenMatches(dir, normalizePhaseName(query))).toBe(false)
    })
  }
})

// ── end to end: the query layer finds the directory on disk ─────────────────

describe('the query layer resolves the directories the token fix unblocked', () => {
  it('find-phase locates a directory whose slug starts with digit segments', () => {
    const proj = makeProject('digit-slug', ['09-49-7-search-rewrite', '49.5-orchestration', '49-foundation'], '# Roadmap\n')
    expect(tools(proj, ['find-phase', '9'])).toMatchObject({
      found: true,
      directory: '.planning/phases/09-49-7-search-rewrite',
      phase_number: '09',
    })
    expect(tools(proj, ['find-phase', '49.5'])).toMatchObject({ found: true, phase_number: '49.5' })
    expect(tools(proj, ['find-phase', '49'])).toMatchObject({ found: true, phase_number: '49' })
  })

  it('find-phase locates a hand-made phase-N- directory', () => {
    const proj = makeProject('spelled-out', ['phase-8-user-accounts', 'phase-7-checkout-flow'], '# Roadmap\n')
    expect(tools(proj, ['find-phase', '8'])).toMatchObject({
      found: true,
      directory: '.planning/phases/phase-8-user-accounts',
      phase_number: '8',
      phase_name: 'user-accounts',
    })
    expect(tools(proj, ['find-phase', '7'])).toMatchObject({ found: true, phase_number: '7' })
  })

  it('phase-plan-index reads the plans of a digit-slug directory', () => {
    const proj = makeProject('plan-index', ['08-1-30-49-7-batch-import'], '# Roadmap\n')
    writeFileSync(join(proj, '.planning', 'phases', '08-1-30-49-7-batch-import', '08-01-PLAN.md'), '# Plan\n', 'utf8')
    const index = tools(proj, ['phase-plan-index', '8'])
    expect(index['error']).toBeUndefined()
    expect(index).toMatchObject({ phase: '08' })
    expect(index['plans']).toHaveLength(1)
  })
})

// ── the ROADMAP scan counts a phase whatever language it is written in ──────

describe('phase add counts existing phases in localized and annotated headings', () => {
  // Each roadmap declares phase 8 in a different shape; every shape must be
  // counted, so the next phase is 9 and never a reused number.
  const roadmaps: [string, string][] = [
    ['english heading', '# Roadmap\n\n### Phase 8: Accounts\n\n**Goal:** x\n'],
    ['cyrillic heading', '# Roadmap\n\n### Фаза 8: Учётные записи\n\n**Goal:** x\n'],
    ['english heading with an aside', '# Roadmap\n\n### Phase 8 (extra): Accounts\n\n**Goal:** x\n'],
    ['cyrillic heading with an aside', '# Roadmap\n\n### Фаза 8 (доп): Учётные записи\n\n**Goal:** x\n'],
    // regression: a parenthetical AFTER the colon is title text, as before
    ['aside after the colon', '# Roadmap\n\n### Phase 8: (rewritten — see notes)\n\n**Goal:** x\n'],
    ['english bullet', '# Roadmap\n\n- [ ] **Phase 8: Accounts**\n'],
    ['cyrillic bullet', '# Roadmap\n\n- [ ] **Фаза 8: Учётные записи**\n'],
  ]

  for (const [label, roadmap] of roadmaps) {
    it(`counts phase 8 in a ${label} and hands out 9`, () => {
      const proj = makeProject(`roadmap-${label.replace(/\s+/g, '-')}`, [], roadmap)
      expect(tools(proj, ['phase', 'add', 'next step'])).toMatchObject({ phase_number: 9 })
    })
  }
})
