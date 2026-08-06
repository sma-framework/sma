/**
 * memory-revoked-visibility.test.ts — the ACC-2 regression of phase 11.
 *
 * ACC-2 in one sentence: «a revoked record never enters active context» — a test,
 * not a promise. Every later plan of this phase edits the memory read path, so the
 * assertion has to exist BEFORE those edits or the claim is unfalsifiable.
 *
 * WHY THIS ASSERTS THROUGH compilePack AND NOT visibilityVerdict. The filter is
 * already unit-tested where it lives (generator.test.ts). What ACC-2 claims is
 * stronger and different: that no CALLER can reach a retired record. A test on the
 * predicate alone would stay green on the day a caller stopped asking it — which is
 * precisely the regression this file exists to catch. So the pack is compiled with
 * the REAL resolvePeriphery (compilePack's default `resolve`), and the assertions
 * read the members the compiler actually emitted.
 *
 * THE FIXTURE IS RANK-NEUTRAL ON PURPOSE. Every note below carries the same claim,
 * the same use-when, the same area and the same kind, and its file name names the
 * same task. Nothing distinguishes them except the lifecycle field under test, so an
 * absence cannot be explained away as «it ranked lower» — and the budget-cut trace is
 * asserted empty for the same reason.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. It changes no product source. The last
 * describe block records, as an executable fact, that `archived` and a bare
 * `status: expired` are NOT withheld by the read-time filter today —
 * CORE_EXCLUDED_STATUSES holds exactly `superseded` and `revoked`. That gap is real
 * and it belongs to the plan that owns generator.mjs. Asserting the true
 * behaviour here (rather than the wished-for one) is what makes that change
 * visible as a change instead of silent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compilePack } from '../lib/context-pack.mjs'

const EMDASH = String.fromCharCode(0x2014)

/** The one instant every visibility question below is asked at (no wall clock). */
const NOW = '2026-08-04T00:00:00Z'

/** The one task text every fixture note matches on every axis it declares. */
const TASK = 'fix the crm handler'

let dir: string
let corpusDir: string

const TAGS = `## area\n- crm ${EMDASH} customer relationship\n\n## kind\n- reference ${EMDASH} a reference note\n`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-revoked-'))
  corpusDir = join(dir, 'memory')
  mkdirSync(corpusDir, { recursive: true })
  writeFileSync(join(corpusDir, 'TAGS.md'), TAGS, 'utf8')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A fixture note. `description`, `use-when`, `tags`, `kind` and the file name are
 * identical across the whole corpus — only `extra` (the lifecycle fields) and the
 * importance tier differ, so the only variable in the experiment is the one under test.
 */
function writeNote(file: string, extra: string[], importance: number) {
  const fm = [
    '---',
    'description: the rule for fixing the crm handler',
    'kind: reference',
    'tags: [crm]',
    'use-when: fixing the crm handler',
    `importance: ${importance}`,
    ...extra,
    '---',
    'body',
  ]
  writeFileSync(join(corpusDir, file), fm.join('\n') + '\n', 'utf8')
}

/**
 * The corpus under test. Two ACTIVE records — one above the CORE threshold and one
 * below it — so both output points of the read path are exercised; and the retired
 * ones mirrored at BOTH tiers where the tier could hide the answer: a revoked record
 * with importance 9 would ride into CORE if the status filter had stayed at CORE
 * membership only, which is exactly the shape the retrieval baseline once caught.
 */
function writeCorpus() {
  writeNote('crm-handler-active-core.md', ['status: active'], 9)
  writeNote('crm-handler-active-periphery.md', ['status: active', 'valid_from: 2026-01-01', 'valid_until: 2027-01-01'], 5)
  writeNote('crm-handler-revoked-core.md', ['status: revoked'], 9)
  writeNote('crm-handler-revoked-periphery.md', ['status: revoked'], 5)
  writeNote('crm-handler-superseded.md', ['status: superseded'], 5)
  // ONE variable per note, which is this file's own stated discipline. This note
  // carried `status: expired` AND a past `valid_until` until 2026-08-04 — two
  // signals for one question, and it only stayed readable while the status half
  // was inert. Once CORE_EXCLUDED_STATUSES widened to all four
  // retirements the status began winning first, and the two tests below stopped
  // measuring the clock they are named after. The note is `active` so that the
  // window, and nothing else, decides its fate.
  writeNote('crm-handler-expired-window.md', ['status: active', 'valid_until: 2026-01-01'], 5)
}

/** Compile with the REAL loader — no `resolve` double anywhere in this file. */
function compile(extra: Record<string, unknown> = {}) {
  return compilePack({
    taskText: TASK,
    commit: 'c',
    corpusDir,
    tagsPath: join(corpusDir, 'TAGS.md'),
    now: NOW,
    ...extra,
  })
}

type Member = { type: string; sub?: string; id: string }

const noteIds = (res: { members: Member[] }) => res.members.filter((m) => m.type === 'note').map((m) => m.id)
const noteIdsOfTier = (res: { members: Member[] }, sub: string) =>
  res.members.filter((m) => m.type === 'note' && m.sub === sub).map((m) => m.id)

/** Every id the pack actually shipped, from the manifest rather than the member list. */
const manifestNoteIds = (res: { manifest: { members: { type: string; id: string }[] } }) =>
  res.manifest.members.filter((m) => m.type === 'note').map((m) => m.id)

describe('ACC-2 — a retired record never reaches the pack (compilePack, real read path)', () => {
  it('withholds revoked and superseded records from BOTH core and periphery', () => {
    writeCorpus()
    const res = compile()

    const packed = noteIds(res)
    expect(packed).not.toContain('crm-handler-revoked-core.md')
    expect(packed).not.toContain('crm-handler-revoked-periphery.md')
    expect(packed).not.toContain('crm-handler-superseded.md')

    // …and not by way of the other tier, either: neither section names them.
    expect(noteIdsOfTier(res, 'core')).toEqual(['crm-handler-active-core.md'])
    expect(noteIdsOfTier(res, 'periphery')).not.toContain('crm-handler-revoked-periphery.md')

    // the manifest — the artifact a consumer reads back — agrees with the members
    expect(manifestNoteIds(res)).toEqual(packed)

    // and the rendered page never prints their names
    expect(res.packMd).not.toContain('crm-handler-revoked-core.md')
    expect(res.packMd).not.toContain('crm-handler-revoked-periphery.md')
    expect(res.packMd).not.toContain('crm-handler-superseded.md')
  })

  it('withholds a record whose valid_until has passed, on the injected clock', () => {
    writeCorpus()
    expect(noteIds(compile())).not.toContain('crm-handler-expired-window.md')

    // the same record, asked about at an instant INSIDE its window, is delivered —
    // so the exclusion above is the clock doing its job, not the fixture being unloved
    const early = compile({ now: '2025-12-31T00:00:00Z' })
    expect(noteIds(early)).toContain('crm-handler-expired-window.md')
  })

  it('keeps an active, in-window, in-scope record — the boundary this phase must not widen', () => {
    writeCorpus()
    // a scope question IS asked; a record that declares no world constrains nothing
    const res = compile({ scope: { repo: 'sma', environment: 'dev' } })

    const packed = noteIds(res)
    expect(packed).toContain('crm-handler-active-core.md')
    expect(packed).toContain('crm-handler-active-periphery.md')
    expect(res.packMd).toContain('crm-handler-active-core.md')
    expect(res.packMd).toContain('crm-handler-active-periphery.md')

    // a test that only proved exclusions would stay green if a later plan
    // over-filtered the corpus to nothing — this is the assertion that fails first
    expect(packed.length).toBeGreaterThanOrEqual(2)
  })

  it('names every withheld id and the field that withheld it, so memory-explain keeps a reason to print', () => {
    writeCorpus()
    const trace: { step: string; id?: string; verdict?: string; reason?: string; detail?: Record<string, unknown> }[] = []
    compile({ trace })

    const withheld = trace.filter((e) => e.step === 'visibility' && e.verdict === 'rejected')
    const byId = new Map(withheld.map((e) => [e.id, e]))

    expect([...byId.keys()].sort()).toEqual([
      'crm-handler-expired-window.md',
      'crm-handler-revoked-core.md',
      'crm-handler-revoked-periphery.md',
      'crm-handler-superseded.md',
    ])

    expect(byId.get('crm-handler-revoked-core.md')).toMatchObject({
      reason: 'status-retired',
      detail: { field: 'status', value: 'revoked' },
    })
    expect(byId.get('crm-handler-revoked-periphery.md')).toMatchObject({
      reason: 'status-retired',
      detail: { field: 'status', value: 'revoked' },
    })
    expect(byId.get('crm-handler-superseded.md')).toMatchObject({
      reason: 'status-retired',
      detail: { field: 'status', value: 'superseded' },
    })
    expect(byId.get('crm-handler-expired-window.md')).toMatchObject({
      reason: 'expired',
      detail: { field: 'valid_until', value: '2026-01-01' },
    })

    // no note was cut by the budget in this corpus — so no absence above can be
    // explained by economy rather than by the visibility verdict that names it
    expect(trace.filter((e) => e.step === 'budget' && e.verdict === 'rejected')).toEqual([])
  })
})

describe('the other two retirements — the recorded gap, CLOSED on 2026-08-04', () => {
  /**
   * THIS BLOCK WAS DELIBERATELY GREEN ON THE WRONG BEHAVIOUR, and it is now
   * flipped. Until 2026-08-04 `CORE_EXCLUDED_STATUSES` (generator.mjs) held exactly
   * {superseded, revoked} while the WRITE path retired four states —
   * `write-pipeline.mjs` `LIFECYCLE_ACTIONS` and `migrate-v1-v2.mjs`
   * `RETIRED_STATUSES` both name `expired` and `archived` too. A record the pipeline
   * had archived was still delivered, with no verdict in the trace. The block below
   * asserted that true-but-unwanted behaviour on purpose, so that the
   * day the gap closed, it would fail loudly and be flipped by hand instead of the
   * behaviour changing under a silently green suite. That day was 2026-08-04, when
   * the retirement states moved behind a user-facing verb: `memory forget
   * --archive` that leaves the record quotable is a verb that lies about what it did.
   *
   * The assertions are inverted, not deleted. A reader comparing this file across
   * that commit sees exactly which behaviour changed and in which direction.
   */
  it('withholds an archived record, and a status:expired record still inside its window', () => {
    writeCorpus()
    writeNote('crm-handler-archived.md', ['status: archived'], 5)
    writeNote('crm-handler-expired-status-only.md', ['status: expired', 'valid_until: 2027-01-01'], 5)

    const trace: { step: string; id?: string; verdict?: string; reason?: string }[] = []
    const packed = noteIds(compile({ trace }))

    // the assertion ACC-2 always wanted, and the code now earns
    expect(packed).not.toContain('crm-handler-archived.md')
    expect(packed).not.toContain('crm-handler-expired-status-only.md')

    // and the filter SAYS SO: a withheld record leaves a verdict an explainer can print,
    // which is the half of the fix that makes the absence contestable rather than silent
    const withheld = trace.filter((e) => e.step === 'visibility' && e.verdict === 'rejected')
    const withheldIds = withheld.map((e) => e.id)
    expect(withheldIds).toContain('crm-handler-archived.md')
    expect(withheldIds).toContain('crm-handler-expired-status-only.md')
    expect(withheld.find((e) => e.id === 'crm-handler-archived.md')).toMatchObject({
      reason: 'status-retired',
      detail: { field: 'status', value: 'archived' },
    })

    // the two ACTIVE records are still delivered — this widened a filter, it did not empty the pack
    expect(packed).toContain('crm-handler-active-core.md')
    expect(packed).toContain('crm-handler-active-periphery.md')
  })
})
