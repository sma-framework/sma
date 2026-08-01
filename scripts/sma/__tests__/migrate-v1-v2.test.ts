/**
 * Tests for scripts/sma/lib/migrate-v1-v2.mjs — the PREVIEW-ONLY v1 -> v2
 * migration engine.
 *
 * THE test of this module is the first one: after a full preview run, every byte
 * of every canonical corpus file is unchanged. Migration is preview-only by law —
 * the tool proposes, a human accepts one file at a time, and until then the v1
 * note stays canonical. A migration that can silently rewrite the corpus it is
 * migrating is not a migration, it is data loss with a report attached.
 *
 * Fixtures are in-test temp corpora (the shape lint.test.ts settled on): a
 * fixture the shared grammar would refuse can then never silently become a test
 * subject, and the committed fixture tree stays free of records other suites
 * (the delivery leak scan, the installer layout freeze) would have to reason about.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseNote, serializeNote } from '../lib/frontmatter.mjs'
import { validateRecord } from '../lib/schema-v2.mjs'
import { EPISODES_DIRNAME, episodeArchiveFields, readEpisodes } from '../lib/episodes.mjs'
import {
  previewMigration,
  applyProposal,
  DRAFT_KIND,
  DRAFT_MARKER_KEYS,
  DRAFTS_DIRNAME,
  KIND_TRANSFORM,
} from '../lib/migrate-v1-v2.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// A FIXED clock: the only non-deterministic input the transform has is "today",
// and it is injected so two runs on different days still produce equal bytes.
const NOW = new Date('2026-08-01T12:00:00Z')

let root: string
let corpusDir: string
let draftsDir: string

/** Write a raw note file into the corpus (raw, so v1 shapes stay verbatim). */
function note(file: string, text: string) {
  writeFileSync(join(corpusDir, file), text)
}

/** Recursive {relative path -> bytes} snapshot of the CANONICAL corpus (drafts/ excluded). */
function snapshotCanonical(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'drafts') continue // the ONE directory a preview may write into
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) Object.assign(out, snapshotCanonical(path, base))
    else out[relative(base, path).split('\\').join('/')] = readFileSync(path, 'utf8')
  }
  return out
}

/** The proposal for one source file. */
function proposalFor(report: any, file: string) {
  const p = report.proposals.find((x: any) => x.source_file === file)
  if (!p) throw new Error(`no proposal for ${file} (got: ${report.proposals.map((x: any) => x.source_file).join(', ')})`)
  return p
}

// ── the fixture corpus ───────────────────────────────────────────────────────

/** A LIVE single-claim v1 note — the v2-markup disposition. */
const LIVE_NOTE = `---
description: Every payment retry must send the idempotency key of the original attempt
kind: bug-lesson
tags: [security, testing]
use-when: touching checkout retry or the payment client
use-when-pattern: src/checkout/**
importance: 9
---
The incident narrative lives in the linked episode.
This note carries the durable rule and its check.
`

/** A RETIRED v1 note (declares its own supersession) — the episode-archive disposition. */
const SUPERSEDED_NOTE = `---
description: The old gateway is the default for card payments
kind: decision
tags: [finance]
use-when: choosing a payment gateway
importance: 7
valid_from: 2026-01-10
superseded_by: decision_new_gateway
superseded_at: 2026-07-01
---
Chosen on 2026-01-10 after a bake-off.

- The old gateway was cheaper per transaction.
- Its retry semantics were undocumented.
- We accepted that trade for one quarter.
`

/** A v1 note whose KIND is history — episode-archive by kind, not by supersession. */
const EPISODIC_NOTE = `---
description: The night the index regeneration ran twice
kind: episodic
tags: [memory]
use-when: reading the regeneration incident
importance: 3
---
Two terminals regenerated the index at once.
Nothing was lost; the second run was byte-identical.
`

/** An ALREADY-v2 record — the skip disposition. */
function alreadyV2(): string {
  return serializeNote({
    schemaVersion: 2,
    frontmatter: {
      id: 'mem-already-v2',
      schema_version: '2',
      status: 'active',
      memory_type: 'semantic',
      truth_mode: 'factual',
      claim: 'The corpus is read through one shared parser',
      language: 'en',
      sensitivity: 'internal',
      fingerprint: { product_version: 'v5.0.4' },
      retrieval: { areas: ['memory'] },
    },
    body: 'A record already authored in schema v2.\n',
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sma-migrate-v2-'))
  corpusDir = join(root, '.claude', 'memory')
  draftsDir = join(corpusDir, 'drafts')
  mkdirSync(corpusDir, { recursive: true })

  note('feedback_retry_idempotency.md', LIVE_NOTE)
  note('decision_old_gateway.md', SUPERSEDED_NOTE)
  note('project_night_log.md', EPISODIC_NOTE)
  note('mem-already-v2.md', alreadyV2())

  // Structural files — never migration targets, never touched.
  note('MEMORY.md', '# Memory\n\n- [Retry](feedback_retry_idempotency.md) — idempotency key\n')
  note('TAGS.md', '## area\n\n- memory — the memory system.\n')
  note('INDEX-memory.md', '# INDEX memory\n\n- [Retry](feedback_retry_idempotency.md)\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('previewMigration — the never-writes-v1 law', () => {
  it('Test 1: leaves EVERY canonical corpus byte identical after a full preview run', () => {
    const before = snapshotCanonical(corpusDir)

    const report = previewMigration({ corpusDir, draftsDir, now: NOW })

    const after = snapshotCanonical(corpusDir)
    expect(after).toEqual(before)
    // and the run actually did something — an empty run would pass vacuously.
    expect(report.proposals.length).toBeGreaterThan(0)
    expect(readdirSync(draftsDir).length).toBeGreaterThan(0)
  })

  it('Test 2: writes NOTHING outside the drafts directory', () => {
    previewMigration({ corpusDir, draftsDir, now: NOW })

    const canonicalNames = readdirSync(corpusDir).sort()
    expect(canonicalNames).toEqual([
      'INDEX-memory.md',
      'MEMORY.md',
      'TAGS.md',
      'decision_old_gateway.md',
      'drafts',
      'feedback_retry_idempotency.md',
      'mem-already-v2.md',
      'project_night_log.md',
    ])
    // no episodes/ conjured, no source note removed, no temp file left behind
    expect(existsSync(join(corpusDir, 'episodes'))).toBe(false)
    expect(readdirSync(draftsDir).every((f) => f.startsWith('migration--'))).toBe(true)
  })
})

describe('previewMigration — dispositions', () => {
  it('Test 3: a live single-claim note gets a v2-markup proposal', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    const p = proposalFor(report, 'feedback_retry_idempotency.md')

    expect(p.disposition).toBe('v2-markup')
    expect(existsSync(p.draft_path)).toBe(true)
    expect(p.validation.errors).toEqual([])
    expect(p.diff).toContain('--- a/feedback_retry_idempotency.md')
    expect(p.diff).toContain('+++ b/feedback_retry_idempotency.md')
  })

  it('Test 4: a note declaring its own supersession gets an episode-archive proposal', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    const p = proposalFor(report, 'decision_old_gateway.md')

    expect(p.disposition).toBe('episode-archive')
    expect(p.target_path.split('\\').join('/')).toContain('episodes/decision_old_gateway.md')
    expect(p.validation.errors).toEqual([])
  })

  it('Test 5: a note whose KIND is history is archived too — the kind map routes it', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    expect(proposalFor(report, 'project_night_log.md').disposition).toBe('episode-archive')
  })

  it('Test 6: an already-v2 record and every structural file are skipped', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })

    const v2 = proposalFor(report, 'mem-already-v2.md')
    expect(v2.disposition).toBe('skip')
    expect(v2.draft_path).toBeNull()
    expect(v2.reason).toMatch(/already schema v2/i)

    const seen = report.proposals.map((p: any) => p.source_file)
    expect(seen).not.toContain('MEMORY.md')
    expect(seen).not.toContain('TAGS.md')
    expect(seen).not.toContain('INDEX-memory.md')
  })
})

describe('previewMigration — the mechanical transform table', () => {
  it('Test 7: kind -> memory_type/truth_mode comes from the exported seed map', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    const draft = parseNote(readFileSync(proposalFor(report, 'feedback_retry_idempotency.md').draft_path, 'utf8'), {
      file: 'draft',
    })

    expect(draft.schemaVersion).toBe(2)
    expect(draft.frontmatter!.memory_type).toBe(KIND_TRANSFORM['bug-lesson'].memory_type)
    expect(draft.frontmatter!.truth_mode).toBe(KIND_TRANSFORM['bug-lesson'].truth_mode)
    expect(KIND_TRANSFORM['bug-lesson'].memory_type).toBe('procedural')
    expect(KIND_TRANSFORM['decision'].memory_type).toBe('semantic')
    expect(KIND_TRANSFORM['decision'].truth_mode).toBe('decision')
    expect(KIND_TRANSFORM['reference'].memory_type).toBe('semantic')
  })

  it('Test 8: tags -> retrieval.areas 1:1, and use-when-pattern -> retrieval.paths', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    const fm = parseNote(readFileSync(proposalFor(report, 'feedback_retry_idempotency.md').draft_path, 'utf8'), {
      file: 'draft',
    }).frontmatter as any

    expect(fm.retrieval.areas).toEqual(['security', 'testing'])
    expect(fm.retrieval.paths).toEqual(['src/checkout/**'])
    expect(fm.retrieval.hint).toBe('touching checkout retry or the payment client')
  })

  it('Test 9: importance splits into context_priority + criticality, and the record is stamped migrated_from v1', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    const fm = parseNote(readFileSync(proposalFor(report, 'feedback_retry_idempotency.md').draft_path, 'utf8'), {
      file: 'draft',
    }).frontmatter as any

    expect(fm.context_priority).toBe('always') // importance 9
    expect(fm.criticality).toBe('high') // importance >= 8
    expect(fm.migrated_from).toBe('v1')
    expect(fm.claim).toBe('Every payment retry must send the idempotency key of the original attempt')
    expect(fm.id).toBe('feedback_retry_idempotency')
    expect(fm.language).toBe('en') // the model requires it on EVERY record
    expect(fm.recorded_at).toBe('2026-08-01')
  })

  it('Test 10: a lower-importance note gets the on-demand / medium defaults', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    const stub = proposalFor(report, 'project_night_log.md').stub
    const fm = parseNote(readFileSync(stub.draft_path, 'utf8'), { file: 'stub' }).frontmatter as any

    expect(fm.context_priority).toBe('on-demand') // importance 3
    expect(fm.criticality).toBe('medium')
  })

  it('Test 11: every staged draft carries the draft_kind marker and parses as schema v2', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })

    const staged = readdirSync(draftsDir).sort()
    expect(staged.length).toBeGreaterThan(0)
    for (const file of staged) {
      const parsed = parseNote(readFileSync(join(draftsDir, file), 'utf8'), { file })
      expect(parsed.schemaVersion).toBe(2)
      expect(parsed.frontmatter!.draft_kind).toBe(DRAFT_KIND)
      expect(parsed.frontmatter!.draft_source).toBeTruthy()
    }
    expect(DRAFT_KIND).toBe('v2-migration')
    expect(DRAFT_MARKER_KEYS).toContain('draft_kind')
  })
})

describe('previewMigration — the episode archive and its claim stub', () => {
  it('Test 12: the episode proposal carries the MINIMAL archive field set and nothing invented', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    const p = proposalFor(report, 'decision_old_gateway.md')
    const parsed = parseNote(readFileSync(p.draft_path, 'utf8'), { file: 'draft' })
    const fm = parsed.frontmatter as any

    expect(fm.memory_type).toBe('episodic')
    expect(fm.status).toBe('superseded')
    expect(fm.superseded_by).toBe('decision_new_gateway')
    expect(fm.superseded_at).toBe('2026-07-01')
    expect(fm.valid_from).toBe('2026-01-10')
    expect(fm.language).toBe('en')
    expect(fm.sensitivity).toBe('internal')
    expect(fm.recorded_at).toBe('2026-08-01')
    // MINIMAL: no claim, no evidence, no fingerprint, no verification invented.
    expect(fm.claim).toBeUndefined()
    expect(fm.evidence).toBeUndefined()
    expect(fm.fingerprint).toBeUndefined()
    expect(fm.verification).toBeUndefined()
    // Every emitted field is either an archive field or a draft marker.
    const allowed = new Set([...episodeArchiveFields, ...DRAFT_MARKER_KEYS])
    expect(Object.keys(fm).filter((k) => !allowed.has(k))).toEqual([])
    // The multi-claim body survives verbatim — episodes are multi-claim-legal.
    expect(parsed.body).toContain('- Its retry semantics were undocumented.')
  })

  it('Test 13: the claim-extraction stub carries derived_from and FAILS validateRecord until filled', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    const p = proposalFor(report, 'decision_old_gateway.md')

    expect(p.stub).toBeTruthy()
    const fm = parseNote(readFileSync(p.stub.draft_path, 'utf8'), { file: 'stub' }).frontmatter as any
    expect(fm.derived_from).toBe('decision_old_gateway')
    expect(fm.status).toBe('draft')
    expect(fm.migrated_from).toBe('v1')
    expect(fm.memory_type).toBe('semantic') // the kind seed still applies to the claim
    expect(fm.truth_mode).toBe('decision')

    // BY DESIGN: an unfilled stub cannot be applied.
    const stripped = { ...fm }
    for (const k of DRAFT_MARKER_KEYS) delete stripped[k]
    const { errors } = validateRecord(stripped)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join(' ')).toMatch(/claim/)
    expect(p.stub.validation.errors.join(' ')).toMatch(/claim/)
    expect(report.summary.stubs_awaiting_extraction).toBeGreaterThan(0)
  })
})

describe('previewMigration — determinism', () => {
  it('Test 14: two runs over the same fixtures produce byte-identical drafts', () => {
    const a = join(root, 'drafts-a')
    const b = join(root, 'drafts-b')

    previewMigration({ corpusDir, draftsDir: a, now: NOW })
    previewMigration({ corpusDir, draftsDir: b, now: NOW })

    const namesA = readdirSync(a).sort()
    expect(namesA).toEqual(readdirSync(b).sort())
    for (const f of namesA) {
      expect(readFileSync(join(b, f), 'utf8')).toBe(readFileSync(join(a, f), 'utf8'))
    }
  })

  it('Test 15: a re-run NEVER clobbers a human-edited draft', () => {
    const first = previewMigration({ corpusDir, draftsDir, now: NOW })
    const p = proposalFor(first, 'decision_old_gateway.md')
    const edited = readFileSync(p.stub.draft_path, 'utf8').replace('claim: ""', 'claim: The old gateway was the default')
    writeFileSync(p.stub.draft_path, edited)

    const second = previewMigration({ corpusDir, draftsDir, now: NOW })

    expect(readFileSync(p.stub.draft_path, 'utf8')).toBe(edited)
    expect(proposalFor(second, 'decision_old_gateway.md').stub.draft_status).toBe('kept-existing')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// applyProposal — the ONE door from drafts/ into the corpus.
// ─────────────────────────────────────────────────────────────────────────────

describe('applyProposal — explicit, per-file, validated', () => {
  it('Test 16: a MISMATCHED confirmation refuses and writes nothing', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    const p = proposalFor(report, 'feedback_retry_idempotency.md')
    const before = snapshotCanonical(corpusDir)

    const res = applyProposal({
      draftPath: p.draft_path,
      corpusDir,
      confirmFile: 'decision_old_gateway.md', // a real note — just not THIS one
    })

    expect(res.applied).toBe(false)
    expect(res.target_path).toBeNull()
    expect(res.reason).toMatch(/confirmation mismatch/i)
    expect(snapshotCanonical(corpusDir)).toEqual(before)
    expect(existsSync(p.draft_path)).toBe(true) // the draft is NOT consumed
  })

  it('Test 17: an EMPTY confirmation refuses — silence is not consent', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    const p = proposalFor(report, 'feedback_retry_idempotency.md')
    const before = snapshotCanonical(corpusDir)

    for (const confirmFile of ['', undefined, null] as any[]) {
      const res = applyProposal({ draftPath: p.draft_path, corpusDir, confirmFile })
      expect(res.applied).toBe(false)
    }
    expect(snapshotCanonical(corpusDir)).toEqual(before)
  })

  it('Test 18: the correct confirmation applies a v2-markup proposal in place, atomically', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    const p = proposalFor(report, 'feedback_retry_idempotency.md')

    const res = applyProposal({
      draftPath: p.draft_path,
      corpusDir,
      confirmFile: 'feedback_retry_idempotency.md',
    })

    expect(res.applied).toBe(true)
    const applied = readFileSync(join(corpusDir, 'feedback_retry_idempotency.md'), 'utf8')
    const parsed = parseNote(applied, { file: 'feedback_retry_idempotency.md' })
    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.frontmatter!.migrated_from).toBe('v1')
    // No marker key survived into the corpus.
    for (const key of DRAFT_MARKER_KEYS) expect(parsed.frontmatter![key]).toBeUndefined()
    // The body is byte-preserved.
    expect(parsed.body).toBe(LIVE_NOTE.slice(LIVE_NOTE.indexOf('The incident')))
    // It validates, and the grammar can write it back (the lint's round-trip guard).
    expect(validateRecord(parsed.frontmatter!).errors).toEqual([])
    expect(serializeNote({ frontmatter: parsed.frontmatter, body: parsed.body, schemaVersion: 2 })).toBe(applied)
  })

  it('Test 19: a DOUBLE apply is impossible — the draft is consumed', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    const p = proposalFor(report, 'feedback_retry_idempotency.md')
    applyProposal({ draftPath: p.draft_path, corpusDir, confirmFile: 'feedback_retry_idempotency.md' })

    const applied = readFileSync(join(corpusDir, 'feedback_retry_idempotency.md'), 'utf8')
    expect(existsSync(p.draft_path)).toBe(false)

    const second = applyProposal({
      draftPath: p.draft_path,
      corpusDir,
      confirmFile: 'feedback_retry_idempotency.md',
    })
    expect(second.applied).toBe(false)
    expect(second.reason).toMatch(/already applied/i)
    expect(readFileSync(join(corpusDir, 'feedback_retry_idempotency.md'), 'utf8')).toBe(applied)
  })

  it('Test 20: a draft whose validation has ERRORS refuses — an unfilled stub stays a draft', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    const p = proposalFor(report, 'decision_old_gateway.md')
    const before = snapshotCanonical(corpusDir)

    const res = applyProposal({
      draftPath: p.stub.draft_path,
      corpusDir,
      confirmFile: 'decision_old_gateway.md',
    })

    expect(res.applied).toBe(false)
    expect(res.reason).toMatch(/does not validate/i)
    expect(snapshotCanonical(corpusDir)).toEqual(before)
    expect(existsSync(p.stub.draft_path)).toBe(true)
  })

  it('Test 21: a FILLED stub applies as a new record carrying its episode provenance', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    const p = proposalFor(report, 'decision_old_gateway.md')
    writeFileSync(
      p.stub.draft_path,
      readFileSync(p.stub.draft_path, 'utf8').replace(
        'claim: ""',
        'claim: The old gateway is the default for card payments',
      ),
    )

    const res = applyProposal({
      draftPath: p.stub.draft_path,
      corpusDir,
      confirmFile: 'decision_old_gateway.md',
    })

    expect(res.applied).toBe(true)
    const written = parseNote(readFileSync(join(corpusDir, 'decision_old_gateway-claim.md'), 'utf8'), {
      file: 'decision_old_gateway-claim.md',
    })
    expect(written.frontmatter!.derived_from).toBe('decision_old_gateway')
    expect(written.frontmatter!.claim).toBe('The old gateway is the default for card payments')
    expect(written.frontmatter!.draft_kind).toBeUndefined()
  })

  it('Test 22: an episode-archive apply MOVES the note — episodes/ gains it, the corpus loses it', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    const p = proposalFor(report, 'decision_old_gateway.md')

    const res = applyProposal({
      draftPath: p.draft_path,
      corpusDir,
      confirmFile: 'decision_old_gateway.md',
    })

    expect(res.applied).toBe(true)
    expect(existsSync(join(corpusDir, 'decision_old_gateway.md'))).toBe(false)
    expect(existsSync(join(corpusDir, EPISODES_DIRNAME, 'decision_old_gateway.md'))).toBe(true)

    const episodes = readEpisodes({ corpusDir })
    expect(episodes.map((e: any) => e.id)).toEqual(['decision_old_gateway'])
    expect(episodes[0].frontmatter!.status).toBe('superseded')
    expect(episodes[0].body).toContain('- Its retry semantics were undocumented.')

    // The claim-extraction half stays in drafts, awaiting its own acceptance.
    expect(existsSync(p.stub.draft_path)).toBe(true)
    // Every OTHER canonical file is untouched.
    expect(existsSync(join(corpusDir, 'feedback_retry_idempotency.md'))).toBe(true)
    expect(readFileSync(join(corpusDir, 'MEMORY.md'), 'utf8')).toContain('# Memory')
  })

  it('Test 23: a draft that is not a migration proposal refuses', () => {
    mkdirSync(draftsDir, { recursive: true })
    const foreign = join(draftsDir, 'bug-lesson-example-P1.md')
    writeFileSync(
      foreign,
      serializeNote({
        schemaVersion: 2,
        frontmatter: {
          id: 'bug-lesson-example-P1',
          schema_version: '2',
          status: 'draft',
          memory_type: 'procedural',
          truth_mode: 'inferred',
          claim: 'A draft from another staging producer',
          language: 'en',
          sensitivity: 'internal',
          draft_kind: 'bug-lesson',
          draft_source: 'feedback_retry_idempotency.md',
          draft_disposition: 'v2-markup',
        },
        body: 'not mine\n',
      }),
    )
    const before = snapshotCanonical(corpusDir)

    const res = applyProposal({ draftPath: foreign, corpusDir, confirmFile: 'feedback_retry_idempotency.md' })

    expect(res.applied).toBe(false)
    expect(res.reason).toMatch(/not a migration proposal/i)
    expect(snapshotCanonical(corpusDir)).toEqual(before)
  })

  it('Test 24: a draft id that could address a file OUTSIDE the corpus refuses', () => {
    // A draft is untrusted input on a filesystem boundary: it may have been
    // hand-edited, generated by a future tool, or pasted in. `id` is joined
    // onto the corpus path, so a separator in it writes wherever it likes.
    mkdirSync(draftsDir, { recursive: true })
    const before = snapshotCanonical(corpusDir)
    const escapes = ['../escaped', '..\\escaped', 'sub/escaped', '.hidden']

    for (const [i, badId] of escapes.entries()) {
      const path = join(draftsDir, `migration--hostile-${i}.md`)
      writeFileSync(
        path,
        serializeNote({
          schemaVersion: 2,
          frontmatter: {
            id: badId,
            schema_version: '2',
            status: 'draft',
            // migrated_from engages the grace, so the discipline findings are
            // warnings: the ONLY thing left that can refuse this draft is a real
            // id gate, not an incidental validation error.
            migrated_from: 'v1',
            memory_type: 'semantic',
            truth_mode: 'inferred',
            claim: 'a claim with a hostile identity',
            language: 'en',
            sensitivity: 'internal',
            draft_kind: DRAFT_KIND,
            draft_source: 'feedback_retry_idempotency.md',
            draft_disposition: 'claim-stub',
          },
          body: 'hostile\n',
        }),
      )
      const res = applyProposal({ draftPath: path, corpusDir, confirmFile: 'feedback_retry_idempotency.md' })
      expect(res.applied).toBe(false)
      expect(res.reason).toMatch(/is not a legal record id/i)
    }

    expect(snapshotCanonical(corpusDir)).toEqual(before)
    expect(existsSync(join(root, '.claude', 'escaped.md'))).toBe(false)
    expect(existsSync(join(root, 'escaped.md'))).toBe(false)
  })

  it('Test 25: a draft_source that is not a plain corpus filename refuses', () => {
    mkdirSync(draftsDir, { recursive: true })
    const before = snapshotCanonical(corpusDir)
    const path = join(draftsDir, 'migration--traversal.md')
    writeFileSync(
      path,
      serializeNote({
        schemaVersion: 2,
        frontmatter: {
          id: 'traversal',
          schema_version: '2',
          status: 'active',
          migrated_from: 'v1',
          memory_type: 'semantic',
          truth_mode: 'inferred',
          claim: 'a proposal pointing outside the corpus',
          language: 'en',
          sensitivity: 'internal',
          draft_kind: DRAFT_KIND,
          draft_source: '../../MEMORY.md',
          draft_disposition: 'v2-markup',
        },
        body: 'traversal\n',
      }),
    )

    const res = applyProposal({ draftPath: path, corpusDir, confirmFile: '../../MEMORY.md' })

    expect(res.applied).toBe(false)
    expect(res.reason).toMatch(/is not a plain corpus filename/i)
    expect(snapshotCanonical(corpusDir)).toEqual(before)
  })

  it('Test 26: a v2-markup draft whose id disagrees with its target refuses (the id law)', () => {
    const report = previewMigration({ corpusDir, draftsDir, now: NOW })
    const p = proposalFor(report, 'feedback_retry_idempotency.md')
    writeFileSync(
      p.draft_path,
      readFileSync(p.draft_path, 'utf8').replace('id: feedback_retry_idempotency', 'id: something_else'),
    )
    const before = snapshotCanonical(corpusDir)

    const res = applyProposal({
      draftPath: p.draft_path,
      corpusDir,
      confirmFile: 'feedback_retry_idempotency.md',
    })

    expect(res.applied).toBe(false)
    expect(res.reason).toMatch(/id law|filename stem/i)
    expect(snapshotCanonical(corpusDir)).toEqual(before)
  })

  it('Test 27: NO bulk-apply path exists — one apply function, one draft at a time', async () => {
    const mod = (await import('../lib/migrate-v1-v2.mjs')) as Record<string, unknown>
    const appliers = Object.keys(mod).filter((k) => /appl/i.test(k) && typeof mod[k] === 'function')
    expect(appliers).toEqual(['applyProposal'])
    expect(Object.keys(mod).some((k) => /(All|Batch|Bulk)$/.test(k))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The `memory migrate` verb — the same laws, seen from the command line.
// ─────────────────────────────────────────────────────────────────────────────

describe('sma memory migrate', () => {
  const CLI = join(__dirname, '..', 'cli.mjs')
  const run = (args: string[]) => {
    try {
      return execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err: any) {
      return `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
  }

  it('Test 28: --help names both --preview and --apply', () => {
    const out = run(['memory', 'migrate', '--help'])
    const head = out.split('\n').slice(0, 5).join('\n')
    expect(head).toMatch(/--preview/)
    expect(head).toMatch(/--apply/)
  })

  it('Test 29: the default action previews — the corpus is byte-identical afterwards', () => {
    const before = snapshotCanonical(corpusDir)

    const out = run(['memory', 'migrate', '--corpus', corpusDir])

    expect(snapshotCanonical(corpusDir)).toEqual(before)
    expect(out).toMatch(/PREVIEW/)
    expect(out).toMatch(/v2-markup/)
    expect(out).toMatch(/episode-archive/)
    expect(existsSync(join(corpusDir, DRAFTS_DIRNAME, 'migration--feedback_retry_idempotency.md'))).toBe(true)
  })

  it('Test 30: --apply without --confirm and --yes refuses, and writes nothing', () => {
    run(['memory', 'migrate', '--corpus', corpusDir])
    const before = snapshotCanonical(corpusDir)
    const draft = join(corpusDir, DRAFTS_DIRNAME, 'migration--feedback_retry_idempotency.md')

    const noConfirm = run(['memory', 'migrate', '--corpus', corpusDir, '--apply', draft, '--yes'])
    const noYes = run([
      'memory',
      'migrate',
      '--corpus',
      corpusDir,
      '--apply',
      draft,
      '--confirm',
      'feedback_retry_idempotency.md',
    ])

    for (const out of [noConfirm, noYes]) expect(out).toMatch(/--confirm/)
    expect(snapshotCanonical(corpusDir)).toEqual(before)
  })

  it('Test 31: --apply with the full triple applies exactly one file', () => {
    run(['memory', 'migrate', '--corpus', corpusDir])
    const draft = join(corpusDir, DRAFTS_DIRNAME, 'migration--feedback_retry_idempotency.md')

    const out = run([
      'memory',
      'migrate',
      '--corpus',
      corpusDir,
      '--apply',
      draft,
      '--confirm',
      'feedback_retry_idempotency.md',
      '--yes',
    ])

    expect(out).toMatch(/применено/)
    expect(parseNote(readFileSync(join(corpusDir, 'feedback_retry_idempotency.md'), 'utf8'), { file: 'x' }).schemaVersion).toBe(2)
    // The OTHER proposal is untouched — one apply, one file.
    expect(parseNote(readFileSync(join(corpusDir, 'decision_old_gateway.md'), 'utf8'), { file: 'y' }).schemaVersion).toBe(1)
  })
})
