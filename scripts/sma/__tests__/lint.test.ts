/**
 * Tests for scripts/sma/lib/lint.mjs (Phase 49 Plan 08).
 *
 * memory-lint (R5) — the one deterministic checker for the whole memory layer,
 * cloned structurally from the security guard's checks.mjs array pattern. Each
 * check class is proven by a mini-corpus fixture under fixtures/lint/<case>/.
 *
 * Task 1 (tests 1–7): MEM-VOCAB, MEM-ALIAS, MEM-SCHEMA, MEM-ORPHAN, MEM-DUPE,
 *   MEM-TAGCHAOS + determinism / clean-tree-exit-0.
 *
 * Lint is READ-ONLY (C4): the fixtures live on disk and are never mutated by a
 * check. Tests that need a MUTATED corpus (e.g. R1 same-commit tag registration)
 * copy the fixture into a temp dir first, so the committed fixtures stay pristine.
 */

import { describe, it, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, cpSync, rmSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import { LINT_CHECKS, runLint } from '../lib/lint.mjs'
import { parseNote, serializeNote } from '../lib/frontmatter.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIX = join(__dirname, 'fixtures', 'lint')

/** Run lint over a named committed fixture case (read-only). */
function lintCase(name: string) {
  const dir = join(FIX, name)
  return runLint({
    corpusDir: dir,
    tagsPath: join(dir, 'TAGS.md'),
    indexPath: join(dir, 'MEMORY.md'),
  })
}

/** Copy a fixture case into a fresh temp dir so a test may mutate it. */
function copyCase(name: string): string {
  const dst = mkdtempSync(join(tmpdir(), `sma-lint-${name}-`))
  cpSync(join(FIX, name), dst, { recursive: true })
  return dst
}

function findingsOf(res: { findings: Array<{ checkId: string }> }, id: string) {
  return res.findings.filter((f) => f.checkId === id)
}

describe('memory-lint core (49-08 task 1)', () => {
  it('Test 1 (vocab): unregistered tag → CRITICAL naming the tag; same-commit registration passes', () => {
    const res = lintCase('vocab')
    const vocab = findingsOf(res, 'MEM-VOCAB')
    expect(vocab.length).toBeGreaterThanOrEqual(1)
    expect(vocab.every((f) => f.tier === 'critical')).toBe(true)
    // The finding message must contain the offending tag verbatim (R1 acceptance).
    expect(vocab.some((f) => f.message.includes('nonexistent-tag'))).toBe(true)
    expect(res.critical).toBeGreaterThanOrEqual(1)

    // Same-commit registration: add the tag to a temp copy's TAGS.md → clean.
    const tmp = copyCase('vocab')
    try {
      // Register under a fresh area facet so loadTagsRegistry picks it up.
      appendFileSync(join(tmp, 'TAGS.md'), '\n## area\n\n- nonexistent-tag — now registered.\n')
      const res2 = runLint({
        corpusDir: tmp,
        tagsPath: join(tmp, 'TAGS.md'),
        indexPath: join(tmp, 'MEMORY.md'),
      })
      expect(findingsOf(res2, 'MEM-VOCAB')).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('Test 1b (vocab, no registry): a corpus WITHOUT TAGS.md → ONE structural CRITICAL naming the path, never a crash or a per-tag flood', () => {
    const tmp = copyCase('vocab')
    try {
      rmSync(join(tmp, 'TAGS.md'), { force: true })
      const res = runLint({
        corpusDir: tmp,
        tagsPath: join(tmp, 'TAGS.md'),
        indexPath: join(tmp, 'MEMORY.md'),
      })
      const vocab = findingsOf(res, 'MEM-VOCAB')
      expect(vocab).toHaveLength(1)
      expect(vocab[0].tier).toBe('critical')
      expect(vocab[0].message).toContain('TAGS.md')
      expect(vocab[0].message).toContain('not found')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('Test 2 (alias): tag uses an alias where the canonical exists → WARN suggesting the canonical', () => {
    const res = lintCase('alias')
    const alias = findingsOf(res, 'MEM-ALIAS')
    expect(alias.length).toBeGreaterThanOrEqual(1)
    expect(alias.every((f) => f.tier === 'warn')).toBe(true)
    // The alias 'gsd' resolves to canonical 'workflow'.
    expect(alias.some((f) => f.message.includes('gsd') && f.message.includes('workflow'))).toBe(true)
  })

  it('Test 3 (schema): missing use-when / importance out of 1–10 → CRITICAL naming field + file', () => {
    const res = lintCase('schema')
    const schema = findingsOf(res, 'MEM-SCHEMA')
    expect(schema.length).toBeGreaterThanOrEqual(1)
    expect(schema.every((f) => f.tier === 'critical')).toBe(true)
    expect(schema.some((f) => f.message.includes('use-when'))).toBe(true)
    expect(schema.some((f) => f.message.includes('importance'))).toBe(true)
    expect(schema.every((f) => f.file.includes('reference_missing_fields.md'))).toBe(true)
  })

  it('Test 4 (orphans): index↔files mismatch → one finding per direction', () => {
    const res = lintCase('orphan')
    const orph = findingsOf(res, 'MEM-ORPHAN')
    // Direction 1: absent file referenced by the index.
    expect(orph.some((f) => f.message.includes('reference_absent.md'))).toBe(true)
    // Direction 2: on-disk file absent from the index.
    expect(orph.some((f) => f.message.includes('reference_present.md'))).toBe(true)
    expect(orph.length).toBeGreaterThanOrEqual(2)
  })

  it('Test 5 (dupes): near-identical normalized bodies → content-hash WARN pairing them', () => {
    const res = lintCase('dupe')
    const dupe = findingsOf(res, 'MEM-DUPE')
    expect(dupe.length).toBeGreaterThanOrEqual(1)
    expect(dupe.every((f) => f.tier === 'warn')).toBe(true)
    expect(dupe.some((f) => f.message.includes('reference_one.md') && f.message.includes('reference_two.md'))).toBe(true)
  })

  it('Test 6 (tag-chaos, B4): near-duplicate / single-use / overbroad tags → WARNs', () => {
    const res = lintCase('tagchaos')
    const chaos = findingsOf(res, 'MEM-TAGCHAOS')
    expect(chaos.every((f) => f.tier === 'warn')).toBe(true)
    // near-duplicate (testing / tests)
    expect(chaos.some((f) => f.message.includes('testing') && f.message.includes('tests'))).toBe(true)
    // single-use tag (lonely)
    expect(chaos.some((f) => f.message.includes('lonely'))).toBe(true)
    // overbroad tag (common, >40% of the corpus)
    expect(chaos.some((f) => f.message.includes('common'))).toBe(true)
  })

  it('Test 7 (determinism): double-run deep-equal; clean tree exits 0 semantics', () => {
    const a = lintCase('clean')
    const b = lintCase('clean')
    expect(a).toEqual(b)
    expect(a.critical).toBe(0)
    expect(a.findings.filter((f) => f.tier === 'critical')).toHaveLength(0)

    // The vocab (non-clean) case is also deterministic across runs.
    const c1 = lintCase('vocab')
    const c2 = lintCase('vocab')
    expect(c1).toEqual(c2)
  })

  it('LINT_CHECKS is the deterministic array-of-check-objects shape (structural clone of checks.mjs)', () => {
    expect(Array.isArray(LINT_CHECKS)).toBe(true)
    for (const c of LINT_CHECKS) {
      expect(typeof c.id).toBe('string')
      expect(typeof c.title).toBe('string')
      expect(['critical', 'warn', 'info']).toContain(c.tier)
      expect(typeof c.run).toBe('function')
    }
    // Every core check class is present.
    const ids = LINT_CHECKS.map((c) => c.id)
    for (const id of ['MEM-VOCAB', 'MEM-ALIAS', 'MEM-SCHEMA', 'MEM-ORPHAN', 'MEM-DUPE', 'MEM-TAGCHAOS']) {
      expect(ids).toContain(id)
    }
  })
})

describe('memory-lint supersession / regen / duplication (49-08 task 2)', () => {
  it('Test 8 (supersession): broken target → CRITICAL; asymmetric back-pointer → WARN; superseded_at without _by → WARN', () => {
    const res = lintCase('supersede')
    const sup = findingsOf(res, 'MEM-SUPERSEDE')
    // supersedes → absent file = CRITICAL
    expect(sup.some((f) => f.tier === 'critical' && f.message.includes('reference_ghost.md'))).toBe(true)
    // A.superseded_by=B without B.supersedes=A = WARN (back-pointer asymmetry)
    expect(sup.some((f) => f.tier === 'warn' && f.message.toLowerCase().includes('back'))).toBe(true)
    // superseded_at present without superseded_by = WARN
    expect(sup.some((f) => f.tier === 'warn' && f.message.includes('superseded_at'))).toBe(true)
  })

  it('Test 9 (artifact-regen, pre-flip): no GENERATED header → neutral pending-flip info, not a failure', () => {
    const res = lintCase('regen-preflip')
    const regen = findingsOf(res, 'MEM-REGEN')
    expect(regen.length).toBeGreaterThanOrEqual(1)
    expect(regen.every((f) => f.tier === 'info')).toBe(true)
    expect(regen.some((f) => f.message.toLowerCase().includes('pending flip'))).toBe(true)
    // Pre-flip must not raise a critical — load-bearing for 49-11's self-check.
    expect(regen.filter((f) => f.tier === 'critical')).toHaveLength(0)
  })

  it('Test 10 (artifact-regen, post-flip): hand-edited GENERATED artifact → CRITICAL; byte-identical → clean', () => {
    const dir = join(FIX, 'regen-postflip')
    // Injected generator returns content DIFFERENT from the committed artifact.
    const mismatch = runLint({
      corpusDir: dir,
      tagsPath: join(dir, 'TAGS.md'),
      indexPath: join(dir, 'MEMORY.md'),
      generate: () => 'DIFFERENT CONTENT THAN THE COMMITTED ARTIFACT\n',
    })
    const mRegen = findingsOf(mismatch, 'MEM-REGEN')
    expect(mRegen.some((f) => f.tier === 'critical' && f.file.includes('MEMORY.md'))).toBe(true)

    // Byte-identical regeneration → clean (echo the committed artifact back).
    const identical = runLint({
      corpusDir: dir,
      tagsPath: join(dir, 'TAGS.md'),
      indexPath: join(dir, 'MEMORY.md'),
      generate: (committed: string) => committed,
    })
    expect(findingsOf(identical, 'MEM-REGEN').filter((f) => f.tier === 'critical')).toHaveLength(0)
  })

  it('Test 10b (artifact-regen): generator unavailable → WARN, never a crash', () => {
    const dir = join(FIX, 'regen-postflip')
    // No generate injected and no generator.mjs present yet → degrade to WARN.
    const res = runLint({
      corpusDir: dir,
      tagsPath: join(dir, 'TAGS.md'),
      indexPath: join(dir, 'MEMORY.md'),
    })
    const regen = findingsOf(res, 'MEM-REGEN')
    expect(regen.some((f) => f.tier === 'warn' && f.message.toLowerCase().includes('generator'))).toBe(true)
  })

  it('Test 11 (CLAUDE.md dup): note description matches a normalized CLAUDE.md line → WARN', () => {
    const dir = join(FIX, 'claudedup')
    const res = runLint({
      corpusDir: dir,
      tagsPath: join(dir, 'TAGS.md'),
      indexPath: join(dir, 'MEMORY.md'),
      claudeMdPath: join(dir, 'CLAUDE.md'),
    })
    const dup = findingsOf(res, 'MEM-CLAUDEDUP')
    expect(dup.length).toBeGreaterThanOrEqual(1)
    expect(dup.every((f) => f.tier === 'warn')).toBe(true)
  })

  it('Test 12 (bug-lesson form, D-9-15): missing Why / How to apply → CRITICAL; well-formed passes', () => {
    const res = lintCase('buglesson')
    const bug = findingsOf(res, 'MEM-BUGLESSON')
    expect(bug.length).toBeGreaterThanOrEqual(1)
    expect(bug.every((f) => f.tier === 'critical')).toBe(true)
    expect(bug.some((f) => f.file.includes('feedback_broken_lesson.md'))).toBe(true)
    // The well-formed bug-lesson fixture is NOT flagged.
    expect(bug.some((f) => f.file.includes('feedback_good_lesson.md'))).toBe(false)
  })

  it('Test 13 (wikilinks, D-9-15): [[link]] to a non-existent note → CRITICAL; valid links pass', () => {
    const res = lintCase('wikilink')
    const wl = findingsOf(res, 'MEM-WIKILINK')
    expect(wl.length).toBeGreaterThanOrEqual(1)
    expect(wl.every((f) => f.tier === 'critical')).toBe(true)
    expect(wl.some((f) => f.message.includes('nonexistent_note') && f.file.includes('reference_has_links.md'))).toBe(true)
    // The valid [[link]] to an existing note is NOT flagged.
    expect(wl.some((f) => f.message.includes('reference_target'))).toBe(false)
  })
})

// ── 9.1-09 Task 1: PRED lint family (pre-registration integrity) + predicted_from ──

/** Read-only git runner for the temp-repo fixtures (same shape the CLI injects). */
const execGit = (args: string[], opts: { cwd?: string } = {}): string =>
  execFileSync('git', args, { encoding: 'utf8', ...opts }) as string

/** git commit in a temp fixture repo without relying on global user config. */
function gitCommit(cwd: string, msg: string) {
  execGit(['add', '.'], { cwd })
  execGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg], { cwd })
}

/** Render a fixture PLAN.md carrying the given predictions entries (raw YAML lines). */
function planWithPredictions(entries: string): string {
  return `---\nphase: test\nplan: 01\npredictions:\n${entries}---\n\n<objective>x</objective>\n`
}

const GOOD_ENTRY =
  '  - id: P1\n' +
  '    claim: "lint stays green"\n' +
  '    metric: exit_code\n' +
  '    check_command: "node scripts/sma/cli.mjs lint --json"\n' +
  '    comparator: "=="\n' +
  '    threshold: 0\n' +
  '    horizon: "plan close"\n' +
  '    domain: tech.memory\n'

/** Run lint over the clean corpus fixture with a plansDir injected (PRED checks). */
function runPredLint(plansDir: string, extra: Record<string, unknown> = {}) {
  const dir = join(FIX, 'clean')
  return runLint({
    corpusDir: dir,
    tagsPath: join(dir, 'TAGS.md'),
    indexPath: join(dir, 'MEMORY.md'),
    plansDir,
    ...extra,
  })
}

describe('PRED lint family (9.1-09 task 1)', () => {
  it('Test 1 (PRED-NOMETRIC): predictions entry missing check_command → CRITICAL naming the field', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sma-pred-nometric-'))
    try {
      const entry =
        '  - id: P1\n    claim: "x"\n    metric: exit_code\n    comparator: "=="\n' +
        '    threshold: 0\n    horizon: "h"\n    domain: tech.test\n'
      writeFileSync(join(tmp, '9.1-09-PLAN.md'), planWithPredictions(entry))
      const res = runPredLint(tmp)
      const f = findingsOf(res, 'PRED-NOMETRIC')
      expect(f.length).toBeGreaterThanOrEqual(1)
      expect(f.every((x) => x.tier === 'critical')).toBe(true)
      expect(f.some((x) => x.message.includes('check_command'))).toBe(true)
      // A plan whose entries are complete raises no PRED-NOMETRIC finding.
      writeFileSync(join(tmp, '9.1-09-PLAN.md'), planWithPredictions(GOOD_ENTRY))
      expect(findingsOf(runPredLint(tmp), 'PRED-NOMETRIC')).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('Test 2 (PRED-POSTEDIT): block edited after first commit → CRITICAL; unrelated frontmatter edit with UNCHANGED block → no finding', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sma-pred-postedit-'))
    try {
      execGit(['init', '-q'], { cwd: tmp })
      const edited = join(tmp, '9.1-01-PLAN.md')
      const untouched = join(tmp, '9.1-02-PLAN.md')
      writeFileSync(edited, planWithPredictions(GOOD_ENTRY))
      writeFileSync(untouched, planWithPredictions(GOOD_ENTRY))
      gitCommit(tmp, 'first commit locks the predictions')
      // HARKing: raise the threshold AFTER the plan's first commit.
      writeFileSync(edited, planWithPredictions(GOOD_ENTRY.replace('threshold: 0', 'threshold: 5')))
      // Unrelated frontmatter edit; the predictions block itself is byte-unchanged.
      writeFileSync(untouched, planWithPredictions(GOOD_ENTRY).replace('plan: 01', 'plan: 02'))
      const res = runPredLint(tmp, { execGit })
      const f = findingsOf(res, 'PRED-POSTEDIT')
      expect(f.some((x) => x.tier === 'critical' && x.file.includes('9.1-01-PLAN.md'))).toBe(true)
      // The no-false-positive case (Pitfall 3): unrelated edit is NOT flagged.
      expect(f.some((x) => x.file.includes('9.1-02-PLAN.md'))).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('Test 3 (PRED-DUPDOD): check_command duplicating a DoD dimension check → WARN', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sma-pred-dupdod-'))
    try {
      writeFileSync(join(tmp, '9.1-09-PLAN.md'), planWithPredictions(GOOD_ENTRY))
      // Whitespace differs → the compare must normalize before matching.
      writeFileSync(
        join(tmp, '9.1-DOD.json'),
        JSON.stringify({
          schemaVersion: 1,
          dimensions: [
            { key: 'tests_pass', kind: 'auto', command: 'node  scripts/sma/cli.mjs   lint --json' },
          ],
        }),
      )
      const res = runPredLint(tmp)
      const f = findingsOf(res, 'PRED-DUPDOD')
      expect(f.length).toBeGreaterThanOrEqual(1)
      expect(f.every((x) => x.tier === 'warn')).toBe(true)
      expect(f.some((x) => x.message.includes('P1'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('Test 4 (predicted_from): round-trips through parse+serialize unchanged', () => {
    const note = {
      frontmatter: {
        description: 'a standalone claim of at least five words',
        kind: 'bug-lesson',
        tags: ['workflow'],
        'use-when': 'when reviewing the missed prediction',
        importance: 5,
        predicted_from: '9.1-08-P1',
      },
      body: 'body text\n',
    }
    const text = serializeNote(note)
    expect(text).toContain('predicted_from: 9.1-08-P1')
    const round = parseNote(text, { file: 'draft.md' })
    expect(round.frontmatter?.predicted_from).toBe('9.1-08-P1')
    // Byte-identical second serialization = the normalized emit path is stable.
    expect(serializeNote({ frontmatter: round.frontmatter!, body: round.body })).toBe(text)
  })
})

// ── 9.2-08 Task 2: CONS lint family (the consequences block is law) ─────────

const CONS_ENTRY =
  '  - id: CONS-1\n' +
  '    trigger: "class-A miss on P1"\n' +
  '    blocks: "sma ship for the product repo"\n' +
  '    until: "founder disposition recorded"\n'

/** A PLAN.md carrying the given predictions + consequences raw YAML blocks. */
function planWith({ predictions, consequences }: { predictions?: string; consequences?: string }): string {
  let fm = '---\nphase: test\nplan: 01\n'
  if (predictions) fm += `predictions:\n${predictions}`
  if (consequences) fm += `consequences:\n${consequences}`
  return fm + '---\n\n<objective>x</objective>\n'
}

describe('CONS lint family (9.2-08 task 2)', () => {
  it('Test 1 (CONS-SCHEMA): entry missing `until` → CRITICAL naming the field; valid → silent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sma-cons-schema-'))
    try {
      const missingUntil = '  - id: CONS-1\n    trigger: "t"\n    blocks: "b"\n'
      writeFileSync(join(tmp, '9.2-08-PLAN.md'), planWith({ consequences: missingUntil }))
      const res = runPredLint(tmp)
      const f = findingsOf(res, 'CONS-SCHEMA')
      expect(f.length).toBeGreaterThanOrEqual(1)
      expect(f.every((x) => x.tier === 'critical')).toBe(true)
      expect(f.some((x) => x.message.includes('until'))).toBe(true)
      // A fully valid block raises nothing.
      writeFileSync(join(tmp, '9.2-08-PLAN.md'), planWith({ consequences: CONS_ENTRY }))
      expect(findingsOf(runPredLint(tmp), 'CONS-SCHEMA')).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('Test 2 (CONS-POSTEDIT): block edited after first commit → CRITICAL; no execGit → info degrade', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sma-cons-postedit-'))
    try {
      execGit(['init', '-q'], { cwd: tmp })
      const edited = join(tmp, '9.2-08-PLAN.md')
      writeFileSync(edited, planWith({ consequences: CONS_ENTRY }))
      gitCommit(tmp, 'first commit locks the consequences')
      // Renegotiate the law AFTER the first commit.
      writeFileSync(edited, planWith({ consequences: CONS_ENTRY.replace('founder disposition recorded', 'anyone can clear it') }))
      const res = runPredLint(tmp, { execGit })
      const f = findingsOf(res, 'CONS-POSTEDIT')
      expect(f.some((x) => x.tier === 'critical' && x.file.includes('9.2-08-PLAN.md'))).toBe(true)

      // No execGit injected → single info-degrade finding (PRED-POSTEDIT parity).
      const degraded = runPredLint(tmp)
      const info = findingsOf(degraded, 'CONS-POSTEDIT')
      expect(info.length).toBeGreaterThanOrEqual(1)
      expect(info.every((x) => x.tier === 'info')).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('Test 3 (CONS-POSTEDIT): an unrelated frontmatter edit with UNCHANGED block → no finding', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sma-cons-postedit2-'))
    try {
      execGit(['init', '-q'], { cwd: tmp })
      const p = join(tmp, '9.2-08-PLAN.md')
      writeFileSync(p, planWith({ consequences: CONS_ENTRY }))
      gitCommit(tmp, 'lock the law')
      // Only the `plan:` line changes; the consequences block is byte-unchanged.
      writeFileSync(p, planWith({ consequences: CONS_ENTRY }).replace('plan: 01', 'plan: 02'))
      const res = runPredLint(tmp, { execGit })
      expect(findingsOf(res, 'CONS-POSTEDIT').filter((x) => x.tier === 'critical')).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('Test 4 (CONS-NOBLOCK): predictions but no consequences → WARN; both → silent; neither → silent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sma-cons-noblock-'))
    try {
      // predictions only → warn.
      writeFileSync(join(tmp, '9.2-08-PLAN.md'), planWith({ predictions: GOOD_ENTRY }))
      const warnRes = findingsOf(runPredLint(tmp), 'CONS-NOBLOCK')
      expect(warnRes.length).toBeGreaterThanOrEqual(1)
      expect(warnRes.every((x) => x.tier === 'warn')).toBe(true)

      // both → silent.
      writeFileSync(join(tmp, '9.2-08-PLAN.md'), planWith({ predictions: GOOD_ENTRY, consequences: CONS_ENTRY }))
      expect(findingsOf(runPredLint(tmp), 'CONS-NOBLOCK')).toHaveLength(0)

      // neither → silent (V2 corpus stays green, fail-open law).
      writeFileSync(join(tmp, '9.2-08-PLAN.md'), planWith({}))
      expect(findingsOf(runPredLint(tmp), 'CONS-NOBLOCK')).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})

// ── 9.2-03 Task 3: RECEIPT-PROSE lint (a machine «done» needs a receipt) ─────

const HEX64 = 'a'.repeat(64)

/** A SUMMARY.md carrying the given coverage + receipts raw YAML blocks.
 * `subsystem: sma…` marks it as an SMA-regime summary (RECEIPT-PROSE is SMA-only). */
function summaryWith({ coverage, receipts }: { coverage?: string; receipts?: string }): string {
  let fm = '---\nphase: test\nplan: 03\nsubsystem: sma.test\n'
  if (coverage) fm += `coverage:\n${coverage}`
  if (receipts) fm += `receipts:\n${receipts}`
  return fm + '---\n\n# summary body\n'
}

describe('RECEIPT-PROSE lint (9.2-03 task 3)', () => {
  it('Case 1: a 9.2 SUMMARY with a machine coverage item and no receipts → CRITICAL', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sma-receipt-prose-1-'))
    try {
      const coverage = '  - id: cov-1\n    description: a machine claim\n    human_judgment: false\n'
      writeFileSync(join(tmp, '9.2-03-SUMMARY.md'), summaryWith({ coverage }))
      const f = findingsOf(runPredLint(tmp), 'RECEIPT-PROSE')
      expect(f.length).toBeGreaterThanOrEqual(1)
      expect(f.every((x) => x.tier === 'critical')).toBe(true)
      expect(f.some((x) => x.message.includes('cov-1'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('Case 2: the same coverage item WITH a matching allowlisted receipt → clean', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sma-receipt-prose-2-'))
    try {
      const coverage = '  - id: cov-1\n    human_judgment: false\n'
      const receipts =
        '  - id: R1\n    assertion: the chain verifies\n' +
        '    check_command: pnpm sma chain-verify --count breaks\n' +
        `    expected_sha256: ${HEX64}\n    coverage_id: cov-1\n`
      writeFileSync(join(tmp, '9.2-03-SUMMARY.md'), summaryWith({ coverage, receipts }))
      expect(findingsOf(runPredLint(tmp), 'RECEIPT-PROSE')).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('Case 3: a 9.1 (pre-cutover) SUMMARY with an uncovered machine item → NO finding', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sma-receipt-prose-3-'))
    try {
      const coverage = '  - id: cov-1\n    human_judgment: false\n'
      writeFileSync(join(tmp, '9.1-09-SUMMARY.md'), summaryWith({ coverage }))
      expect(findingsOf(runPredLint(tmp), 'RECEIPT-PROSE')).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('Case 4: a receipt with a non-allowlisted check_command → CRITICAL', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sma-receipt-prose-4-'))
    try {
      const coverage = '  - id: cov-1\n    human_judgment: false\n'
      const receipts =
        '  - id: R1\n    assertion: evades the boundary\n' +
        '    check_command: git push --force origin main\n' +
        `    expected_sha256: ${HEX64}\n    coverage_id: cov-1\n`
      writeFileSync(join(tmp, '9.2-03-SUMMARY.md'), summaryWith({ coverage, receipts }))
      const f = findingsOf(runPredLint(tmp), 'RECEIPT-PROSE')
      expect(f.length).toBeGreaterThanOrEqual(1)
      expect(f.every((x) => x.tier === 'critical')).toBe(true)
      expect(f.some((x) => x.message.includes('non-allowlisted'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('Case 5 (regime gate): a non-SMA (9.2+) summary with an uncovered machine item → NO finding', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sma-receipt-prose-5-'))
    try {
      // A GSD medical-phase summary (numerically >= 9.2 but subsystem is not sma…):
      // the receipts law is SMA-only; the shared dogfood phase-number namespace must
      // never retro-fail unrelated medical phases (9.2-03 Rule-3 deviation).
      const fm =
        '---\nphase: 53\nplan: 05\nsubsystem: operator-tools, remi-bridge\n' +
        'coverage:\n  - id: T1\n    human_judgment: false\n---\n\n# summary body\n'
      writeFileSync(join(tmp, '53-05-SUMMARY.md'), fm)
      expect(findingsOf(runPredLint(tmp), 'RECEIPT-PROSE')).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})

// ── 9.1-13 Task 1: FI-9/FI-11 size lints (budgets are law) ──────────────────

import { CORE_BUDGET, NOTE_BUDGET, ALWAYS_LOAD_BUDGET, STATE_BUDGET } from '../lib/constants.mjs'

/** A filler line of exactly n bytes (ASCII 'x' padding + trailing \n). */
function filler(n: number): string {
  return 'x'.repeat(Math.max(0, n - 1)) + '\n'
}

/** Minimal TAGS.md so buildContext's registry load succeeds. */
const SIZE_TAGS_MD = '# TAGS\n\n## area\n- tech — infra.\n\n## kind\n- reference — a lookup fact.\n'

/** Build a MEMORY.md whose CORE section is ~coreBytes and total is ~totalBytes. */
function sizeIndex(coreBytes: number, tailBytes = 64): string {
  const coreHeading = '## Ядро (всегда загружается)\n\n'
  const corePad = filler(coreBytes - Buffer.byteLength(coreHeading, 'utf8'))
  return `# MEMORY\n\n${coreHeading}${corePad}\n## Индекс (по одной строке на факт)\n\n${filler(tailBytes)}`
}

/** Write a schema-valid note file padded to ~bytes total. */
function sizedNote(dir: string, name: string, bytes: number) {
  const head = [
    '---',
    'description: a standalone reference claim of enough words',
    'kind: reference',
    'tags: [tech]',
    'use-when: sizing the note budget lints',
    'importance: 5',
    '---',
    '',
  ].join('\n')
  const body = filler(bytes - Buffer.byteLength(head, 'utf8'))
  writeFileSync(join(dir, name), head + body, 'utf8')
}

/** Run lint over a throwaway dir with the given MEMORY.md text + extra opts. */
function lintSized(setup: (dir: string) => void, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sma-lint-size-'))
  try {
    writeFileSync(join(dir, 'TAGS.md'), SIZE_TAGS_MD, 'utf8')
    setup(dir)
    return runLint({
      corpusDir: dir,
      tagsPath: join(dir, 'TAGS.md'),
      indexPath: join(dir, 'MEMORY.md'),
      ...extra,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}

describe('size lints — WARN at 80%, critical at 100% (9.1-13 task 1)', () => {
  it('Test 1 (MEM-CORESIZE): warn at ~5.1 KB CORE (83% of budget), critical at ~6.5 KB', () => {
    // 5.1 KB CORE — inside [80%, 100%) of CORE_BUDGET=6144 → WARN.
    const warned = lintSized((dir) => {
      writeFileSync(join(dir, 'MEMORY.md'), sizeIndex(5222), 'utf8')
    })
    const w = findingsOf(warned, 'MEM-CORESIZE')
    expect(w.length).toBe(1)
    expect(w[0].tier).toBe('warn')

    // 6.5 KB CORE — at/over 100% of the budget → CRITICAL.
    const critical = lintSized((dir) => {
      writeFileSync(join(dir, 'MEMORY.md'), sizeIndex(6656), 'utf8')
    })
    const c = findingsOf(critical, 'MEM-CORESIZE')
    expect(c.length).toBe(1)
    expect(c[0].tier).toBe('critical')
    expect(String(CORE_BUDGET)).toBe('6144')
  })

  it('Test 2 (MEM-NOTESIZE): critical on a 9 KB note, silent at 6 KB', () => {
    const res = lintSized((dir) => {
      writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n', 'utf8')
      sizedNote(dir, 'reference_big.md', 9 * 1024) // 9216 ≥ NOTE_BUDGET=8192 → critical
      sizedNote(dir, 'reference_small.md', 6 * 1024) // 6144 = 75% → silent (< 80%)
    })
    const f = findingsOf(res, 'MEM-NOTESIZE')
    expect(f.length).toBe(1)
    expect(f[0].tier).toBe('critical')
    expect(f[0].file).toBe('reference_big.md')
    expect(String(NOTE_BUDGET)).toBe('8192')
  })

  it('Test 3 (MEM-INDEXSIZE): measures the ALWAYS-LOAD payload only — INDEX-<area>.md files never count', () => {
    // 13 KB MEMORY.md ≥ ALWAYS_LOAD_BUDGET=12288 → critical.
    const over = lintSized((dir) => {
      writeFileSync(join(dir, 'MEMORY.md'), sizeIndex(4096, 13 * 1024 - 4200), 'utf8')
    })
    expect(findingsOf(over, 'MEM-INDEXSIZE').some((f) => f.tier === 'critical')).toBe(true)

    // A small MEMORY.md stays silent even with a 20 KB on-demand INDEX-tech.md beside it.
    const withArea = lintSized((dir) => {
      writeFileSync(join(dir, 'MEMORY.md'), sizeIndex(1024, 64), 'utf8')
      writeFileSync(join(dir, 'INDEX-tech.md'), filler(20 * 1024), 'utf8')
    })
    expect(findingsOf(withArea, 'MEM-INDEXSIZE')).toHaveLength(0)
    expect(String(ALWAYS_LOAD_BUDGET)).toBe('12288')
  })

  it('Test 4 (STATE-SIZE): warn at 33 KB, critical at 41 KB against an injected statePath', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'sma-lint-state-'))
    try {
      const statePath = join(stateDir, 'STATE.md')

      writeFileSync(statePath, filler(33 * 1024), 'utf8') // 33792 ∈ [80%, 100%) of 40960 → warn
      const warned = lintSized((dir) => {
        writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n', 'utf8')
      }, { statePath })
      const w = findingsOf(warned, 'STATE-SIZE')
      expect(w.length).toBe(1)
      expect(w[0].tier).toBe('warn')

      writeFileSync(statePath, filler(41 * 1024), 'utf8') // 41984 ≥ 40960 → critical
      const critical = lintSized((dir) => {
        writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n', 'utf8')
      }, { statePath })
      const c = findingsOf(critical, 'STATE-SIZE')
      expect(c.length).toBe(1)
      expect(c[0].tier).toBe('critical')

      // No statePath injected → the check degrades to silence (never a crash).
      const none = lintSized((dir) => {
        writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n', 'utf8')
      })
      expect(findingsOf(none, 'STATE-SIZE')).toHaveLength(0)
      expect(String(STATE_BUDGET)).toBe('40960')
    } finally {
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('Test 5: every critical size finding names `sma trim` as the auto-repair', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'sma-lint-repair-'))
    try {
      const statePath = join(stateDir, 'STATE.md')
      writeFileSync(statePath, filler(41 * 1024), 'utf8')
      const res = lintSized((dir) => {
        // Over-budget CORE inside an over-budget MEMORY.md + an over-budget note.
        writeFileSync(join(dir, 'MEMORY.md'), sizeIndex(6656, 13 * 1024 - 6800), 'utf8')
        sizedNote(dir, 'reference_big.md', 9 * 1024)
      }, { statePath })
      const sizeCriticals = res.findings.filter(
        (f) =>
          f.tier === 'critical' &&
          ['MEM-CORESIZE', 'MEM-NOTESIZE', 'MEM-INDEXSIZE', 'STATE-SIZE'].includes(f.checkId),
      )
      expect(sizeCriticals.length).toBe(4)
      expect(sizeCriticals.every((f) => f.message.includes('sma trim'))).toBe(true)
    } finally {
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})

// ── 9.1-12 Task 2: bi-temporal fields + MEM-CONTRADICT (B5) ─────────────────

describe('bi-temporal fields + MEM-CONTRADICT (9.1-12 task 2)', () => {
  it('Test 1 (bi-temporal): valid_from/valid_until round-trip through parse+serialize', () => {
    const note = {
      frontmatter: {
        description: 'a standalone decision claim of at least five words',
        kind: 'decision',
        tags: ['tech'],
        'use-when': 'when choosing the production bundler',
        importance: 6,
        valid_from: '2026-06-01',
        valid_until: '2026-07-01',
      },
      body: 'body text\n',
    }
    const text = serializeNote(note)
    expect(text).toContain('valid_from: 2026-06-01')
    expect(text).toContain('valid_until: 2026-07-01')
    const round = parseNote(text, { file: 'decision.md' })
    expect(round.frontmatter?.valid_from).toBe('2026-06-01')
    expect(round.frontmatter?.valid_until).toBe('2026-07-01')
    // Byte-identical second serialization = the normalized emit path is stable.
    expect(serializeNote({ frontmatter: round.frontmatter!, body: round.body })).toBe(text)
  })

  it('Test 2 (MEM-CONTRADICT): unlinked same-subject conflicting decision pair → CRITICAL naming both files + fix path', () => {
    const res = lintCase('contradict')
    const con = findingsOf(res, 'MEM-CONTRADICT')
    expect(con.length).toBeGreaterThanOrEqual(1)
    expect(con.every((f) => f.tier === 'critical')).toBe(true)
    expect(
      con.some(
        (f) =>
          f.message.includes('decision_bundler_yes.md') &&
          f.message.includes('decision_bundler_no.md'),
      ),
    ).toBe(true)
    // The finding carries the resolution instruction (supersession fix path).
    expect(con.some((f) => f.message.includes('valid_until'))).toBe(true)
  })

  it('Test 3 (MEM-CONTRADICT): the SAME pair with valid_until on the older note → no finding (supersession resolves)', () => {
    const tmp = copyCase('contradict')
    try {
      const older = join(tmp, 'decision_bundler_no.md')
      const { frontmatter, body } = parseNote(readFileSync(older, 'utf8'), {
        file: 'decision_bundler_no.md',
      })
      writeFileSync(older, serializeNote({ frontmatter: { ...frontmatter!, valid_until: '2026-07-01' }, body }))
      const res = runLint({
        corpusDir: tmp,
        tagsPath: join(tmp, 'TAGS.md'),
        indexPath: join(tmp, 'MEMORY.md'),
      })
      expect(findingsOf(res, 'MEM-CONTRADICT')).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('Test 4 (MEM-CONTRADICT): conflicting notes of kind outside decision/status never fire', () => {
    const res = lintCase('contradict')
    const con = findingsOf(res, 'MEM-CONTRADICT')
    // The reference_port pair conflicts textually but kind=reference — ignored.
    expect(con.some((f) => f.message.includes('reference_port_one.md'))).toBe(false)
    expect(con.some((f) => f.message.includes('reference_port_two.md'))).toBe(false)
  })
})

// ── 9.1-14 Task 2: MEM-SECRET — screen secrets at the corpus door (T-9.1-27) ─

/**
 * Run lint over a single schema-valid note whose BODY is `body`. The note is
 * indexed (no orphan noise) and the corpus is a throwaway temp dir, so the
 * committed fixtures stay untouched (C4 read-only).
 */
function lintBody(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'sma-lint-secret-'))
  try {
    writeFileSync(join(dir, 'TAGS.md'), SIZE_TAGS_MD, 'utf8')
    writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n- [probe](reference_probe.md)\n', 'utf8')
    const head = [
      '---',
      'description: a standalone reference claim of enough words',
      'kind: reference',
      'tags: [tech]',
      'use-when: probing the MEM-SECRET screen',
      'importance: 5',
      '---',
      '',
    ].join('\n')
    writeFileSync(join(dir, 'reference_probe.md'), head + body, 'utf8')
    return runLint({
      corpusDir: dir,
      tagsPath: join(dir, 'TAGS.md'),
      indexPath: join(dir, 'MEMORY.md'),
    })
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}

describe('MEM-SECRET — corpus-door secret screen (9.1-14 task 2)', () => {
  it('Test 1 (secret shapes): AWS key id, sk- token, and a base64/opaque run each → MEM-SECRET critical', () => {
    // AWS-style access key id.
    const aws = findingsOf(lintBody('deploy key AKIAIOSFODNN7EXAMPLE was rotated\n'), 'MEM-SECRET')
    expect(aws.length).toBeGreaterThanOrEqual(1)
    expect(aws.every((f) => f.tier === 'critical')).toBe(true)
    expect(aws.every((f) => f.file === 'reference_probe.md')).toBe(true)

    // sk- prefixed API token.
    const sk = findingsOf(lintBody('the token was sk-abcdef0123456789ABCDEFxyz not redacted\n'), 'MEM-SECRET')
    expect(sk.some((f) => f.tier === 'critical')).toBe(true)

    // A 44-char base64/opaque high-entropy run (a leaked secret value).
    const b64 = findingsOf(lintBody('value=Zm9vYmFyQmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWpr\n'), 'MEM-SECRET')
    expect(b64.some((f) => f.tier === 'critical')).toBe(true)
  })

  it('Test 2 (env var NAME, no value): quoting SMA_SNAPSHOT_TOKEN with no value → no MEM-SECRET (names are fine)', () => {
    const res = lintBody('Set the `SMA_SNAPSHOT_TOKEN` env var and the OAUTH_STATE_SECRET name before boot.\n')
    expect(findingsOf(res, 'MEM-SECRET')).toHaveLength(0)
  })

  it('Test 3 (git sha allowlist): ordinary prose with a 40-hex git sha → no MEM-SECRET', () => {
    const res = lintBody('Recover from the pre-clobber commit 258eb21c0ffee1234567890abcdef1234567890ab in history.\n')
    expect(findingsOf(res, 'MEM-SECRET')).toHaveLength(0)
  })

  it('Test 4 (clean prose): a plain reference note body raises no MEM-SECRET (false-positive floor)', () => {
    const res = lintBody('The dispatcher resolves the preferred channel by country before sending a message.\n')
    expect(findingsOf(res, 'MEM-SECRET')).toHaveLength(0)
  })

  it('MEM-SECRET is registered in LINT_CHECKS as a critical check', () => {
    const c = LINT_CHECKS.find((x) => x.id === 'MEM-SECRET')
    expect(c).toBeTruthy()
    expect(c!.tier).toBe('critical')
  })
})
