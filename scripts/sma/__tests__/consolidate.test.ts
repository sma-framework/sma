/**
 * Tests for scripts/sma/lib/consolidate.mjs (Phase 9.1 Plan 12, Task 1 — B5/FI-9).
 *
 * P3 consolidation core — a PROPOSE-ONLY review pass over the memory corpus
 * (runLint contract: pure read + structured return, ZERO disk writes; the CLI
 * layer renders, a human applies):
 *
 *   - Test 1: two near-duplicate notes (same area+kind, high body token overlap)
 *     → ONE merge proposal naming both files.
 *   - Test 2: an episodic note whose tags matched >= 3 distinct task-tag-sets in
 *     the usage ledger → a PROMOTE proposal (episodic → procedural-rule);
 *     a note with fewer distinct sets is NOT proposed.
 *   - Test 3: two decision notes, same area+kind, conflicting claims, unlinked
 *     → a CONTRADICT proposal naming both files.
 *   - Test 4: digest() over a fixture usage+journal window → reflection summary
 *     listing top-cited notes and repeated incident classes.
 *   - Test 5: propose() performs ZERO disk writes — the fixture tree is
 *     byte-identical before/after AND the module source imports no write API.
 *
 * 11-POST (D-11-DEFER-11 / D-11-DEFER-12) — the detector was measured, not read,
 * and both halves of what the measurement found are pinned here:
 *
 *   - Test 6: the kind gate admits the kinds schema v2 actually produces. The
 *     shipped set was {decision, status} while the live corpus holds ZERO records
 *     of either kind — the candidate set was empty BEFORE the first claim was
 *     ever compared, so `[]` meant "the detector did not look", not "the corpus
 *     is clean". Test 6b pins that the gate still EXISTS: widening is not removal.
 *   - Test 7: the polarity vocabulary answers Russian. Every marker shipped was
 *     English on a corpus whose normative records are Russian, so `polarity()`
 *     returned null for claims that plainly state an obligation or a prohibition.
 *   - Test 7b: the honest limit, stated rather than papered over — a pair opposed
 *     by VERB ANTONYMY is still not detected, and no marker list reaches it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { propose, digest, findContradictions, detectClaimConflict } from '../lib/consolidate.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const TAGS_MD = `# TAGS — closed faceted vocabulary (fixture)

## area

- tech — infrastructure, build, types, migrations.
- memory — memory system: notes, index, tags.

## kind

- decision — a locked decision with provenance.
- status — a point-in-time status snapshot.
- episodic — a single-event record (promotion candidate).
- procedural-rule — a durable how-to rule.
- normative — a standing rule the project is held to.
- semantic — a durable fact.
- reference — a lookup fact.

## phase

- Open facet: \`phase:NN\` — optional free-form tag.
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

/** Write a JSONL file from an array of event objects. */
function jsonl(path: string, events: Array<Record<string, unknown>>) {
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
}

/** Recursive snapshot of a tree: relpath → file content (write-detection oracle). */
function snapshotTree(root: string, base = root): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(root).sort()) {
    const p = join(root, name)
    if (statSync(p).isDirectory()) Object.assign(out, snapshotTree(p, base))
    else out[p.slice(base.length)] = readFileSync(p, 'utf8')
  }
  return out
}

let tmp: string
let corpusDir: string
let usageDir: string
let journalDir: string
let tagsPath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sma-consolidate-'))
  corpusDir = join(tmp, 'corpus')
  usageDir = join(tmp, 'usage')
  journalDir = join(tmp, 'journal')
  mkdirSync(corpusDir, { recursive: true })
  mkdirSync(usageDir, { recursive: true })
  mkdirSync(journalDir, { recursive: true })
  tagsPath = join(corpusDir, 'TAGS.md')
  writeFileSync(tagsPath, TAGS_MD, 'utf8')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
})

const opts = () => ({ corpusDir, tagsPath, usageDir, journalDir })

describe('consolidate.mjs — propose() merge proposals (9.1-12 test 1)', () => {
  it('Test 1: two near-duplicate notes (same area+kind, high body overlap) → one MERGE naming both', () => {
    note(
      corpusDir,
      'rule_sandbox_one.md',
      {
        description: 'Run the migration sandbox verification before pushing schema changes.',
        kind: 'procedural-rule',
        tags: ['tech'],
        'use-when': 'before pushing schema changes',
        importance: 5,
      },
      'Run the migration sandbox verification pass before pushing any schema change to the production database cluster.\n',
    )
    note(
      corpusDir,
      'rule_sandbox_two.md',
      {
        description: 'Run the migration sandbox verification pass before schema pushes land.',
        kind: 'procedural-rule',
        tags: ['tech'],
        'use-when': 'before schema pushes land',
        importance: 4,
      },
      'Run the migration sandbox verification pass before pushing any schema change to the production postgres cluster.\n',
    )
    note(
      corpusDir,
      'reference_unrelated.md',
      {
        description: 'A lookup fact about memory note indexing and tag facets.',
        kind: 'reference',
        tags: ['memory'],
        'use-when': 'looking up index facts',
        importance: 3,
      },
      'A completely different body about memory note indexing, tag facets and the generated index anchor.\n',
    )

    const res = propose(opts())
    expect(res.merges).toHaveLength(1)
    expect(res.merges[0].files).toContain('rule_sandbox_one.md')
    expect(res.merges[0].files).toContain('rule_sandbox_two.md')
    expect(res.merges[0].similarity).toBeGreaterThanOrEqual(0.5)
    // The unrelated note is never proposed for merging.
    expect(JSON.stringify(res.merges)).not.toContain('reference_unrelated.md')
  })
})

describe('consolidate.mjs — schema-v2 records are read', () => {
  // Every question this module asks a note is in v1 field names, and a
  // schema-v2 record answers none of them: no kind, no tags, no description.
  // The result was not an error but a SILENCE — with an empty tag list no pair
  // can ever share an area, so `sma consolidate` reported a spotless corpus on a
  // migrated one. Same fixture as Test 1, written in the other grammar.
  function v2(name: string, claim: string, body: string) {
    writeFileSync(
      join(corpusDir, name),
      `---
schema_version: 2
claim: ${claim}
memory_type: procedural
truth_mode: normative
context_priority: on-demand
retrieval:
  areas: [tech]
  hint: before pushing schema changes
---
${body}`,
      'utf8',
    )
  }

  it('finds a near-duplicate pair among migrated records', () => {
    v2(
      'rule_v2_one.md',
      'Run the migration sandbox verification before pushing schema changes.',
      'Run the migration sandbox verification pass before pushing any schema change to the production database cluster.\n',
    )
    v2(
      'rule_v2_two.md',
      'Run the migration sandbox verification pass before schema pushes land.',
      'Run the migration sandbox verification pass before pushing any schema change to the production postgres cluster.\n',
    )

    const res = propose(opts())
    expect(res.merges).toHaveLength(1)
    expect(res.merges[0].files).toEqual(['rule_v2_one.md', 'rule_v2_two.md'])
    // The pair is named by the kind the (memory_type, truth_mode) pair means —
    // not by the collapsed memory_type, and not by an empty string.
    expect(res.merges[0].kind).toBe('procedural-rule')
  })

  it('reads a migrated record CLAIM when checking for contradictions', () => {
    const decision = (name: string, claim: string) =>
      writeFileSync(
        join(corpusDir, name),
        `---
schema_version: 2
claim: ${claim}
memory_type: semantic
truth_mode: decision
kind: decision
context_priority: on-demand
tags: [tech]
retrieval:
  areas: [tech]
---
body
`,
        'utf8',
      )
    // `kind`/`tags` are stated here on purpose: the full v1-kind inverse for
    // semantic records is NOT part of this projection (only the procedural pair
    // is), so this fixture isolates the ONE thing under test — that the claim
    // itself is read where a v1 note would have said description.
    decision('decision_v2_a.md', 'The sandbox verification always runs before a schema push.')
    decision('decision_v2_b.md', 'The sandbox verification never runs before a schema push.')

    const res = propose(opts())
    expect(res.contradictions).toHaveLength(1)
    expect(res.contradictions[0].files).toEqual(['decision_v2_a.md', 'decision_v2_b.md'])
  })
})

describe('consolidate.mjs — propose() promotion counters (9.1-12 test 2)', () => {
  it('Test 2: episodic note cited by >= 3 distinct task-tag-sets → PROMOTE (episodic → procedural-rule)', () => {
    note(corpusDir, 'episodic_incident_z.md', {
      description: 'One incident record about the flaky sandbox verification on Windows.',
      kind: 'episodic',
      tags: ['tech'],
      'use-when': 'reviewing sandbox flakes',
      importance: 3,
    })
    note(corpusDir, 'episodic_quiet.md', {
      description: 'Another incident record cited by too few distinct task tag sets.',
      kind: 'episodic',
      tags: ['memory'],
      'use-when': 'reviewing quiet incidents',
      importance: 3,
    })

    jsonl(join(usageDir, 'term-1.jsonl'), [
      { ts: '2026-07-01T00:00:00.000Z', terminal: 'term-1', seq: 1, noteId: 'episodic_incident_z.md', kind: 'load', session: 's1', tags: ['tech', 'bug-lesson'] },
      { ts: '2026-07-02T00:00:00.000Z', terminal: 'term-1', seq: 2, noteId: 'episodic_incident_z.md', kind: 'load', session: 's2', tags: ['memory', 'workflow'] },
      { ts: '2026-07-03T00:00:00.000Z', terminal: 'term-1', seq: 3, noteId: 'episodic_incident_z.md', kind: 'load', session: 's3', tags: ['tech', 'release'] },
      // Same tag-set as seq 1 in a different order — must NOT count as a 4th distinct set.
      { ts: '2026-07-04T00:00:00.000Z', terminal: 'term-1', seq: 4, noteId: 'episodic_incident_z.md', kind: 'load', session: 's4', tags: ['bug-lesson', 'tech'] },
      { ts: '2026-07-01T06:00:00.000Z', terminal: 'term-1', seq: 5, noteId: 'episodic_quiet.md', kind: 'load', session: 's1', tags: ['tech'] },
      { ts: '2026-07-02T06:00:00.000Z', terminal: 'term-1', seq: 6, noteId: 'episodic_quiet.md', kind: 'load', session: 's2', tags: ['memory'] },
    ])

    const res = propose(opts())
    const promoted = res.promotions.find((p: { file: string }) => p.file === 'episodic_incident_z.md')
    expect(promoted).toBeDefined()
    expect(promoted.to).toBe('procedural-rule')
    expect(promoted.distinctTagSets).toBe(3)
    // Below-threshold note is NOT proposed (promotion, never time-decay — FI-9).
    expect(res.promotions.some((p: { file: string }) => p.file === 'episodic_quiet.md')).toBe(false)
  })
})

describe('consolidate.mjs — propose() contradiction detection (9.1-12 test 3)', () => {
  it('Test 3: two decision notes, same area+kind, conflicting claims, unlinked → CONTRADICT naming both', () => {
    note(corpusDir, 'decision_bundler_yes.md', {
      description: 'Always use webpack for the production build bundler pipeline.',
      kind: 'decision',
      tags: ['tech'],
      'use-when': 'choosing the production bundler',
      importance: 6,
    })
    note(corpusDir, 'decision_bundler_no.md', {
      description: 'Never use webpack for the production build bundler pipeline.',
      kind: 'decision',
      tags: ['tech'],
      'use-when': 'choosing the production bundler',
      importance: 6,
    })

    const res = propose(opts())
    expect(res.contradictions).toHaveLength(1)
    expect(res.contradictions[0].files).toContain('decision_bundler_yes.md')
    expect(res.contradictions[0].files).toContain('decision_bundler_no.md')
    expect(res.contradictions[0].kind).toBe('decision')
  })

  it('Test 3b: the same pair with valid_until on one note (supersession) → no CONTRADICT', () => {
    note(corpusDir, 'decision_bundler_yes.md', {
      description: 'Always use webpack for the production build bundler pipeline.',
      kind: 'decision',
      tags: ['tech'],
      'use-when': 'choosing the production bundler',
      importance: 6,
    })
    note(corpusDir, 'decision_bundler_no.md', {
      description: 'Never use webpack for the production build bundler pipeline.',
      kind: 'decision',
      tags: ['tech'],
      'use-when': 'choosing the production bundler',
      importance: 6,
      valid_until: '2026-07-01',
    })

    const res = propose(opts())
    expect(res.contradictions).toHaveLength(0)
  })

  it('findContradictions is exported (single shared implementation for lint MEM-CONTRADICT)', () => {
    expect(typeof findContradictions).toBe('function')
  })
})

describe('consolidate.mjs — the kind gate admits what schema v2 produces (D-11-DEFER-11)', () => {
  it('Test 6: two procedural-rule notes with opposing claims → CONTRADICT (the shipped gate saw neither)', () => {
    // MEASURED, not assumed: the live corpus's kind histogram through the
    // product's own projectNoteAxis is {bug-lesson, normative, prospective,
    // preference, procedural-rule, semantic} — not one `decision`, not one
    // `status`. Under the shipped set this pair was filtered out before
    // detectClaimConflict was ever called, and the empty result read as clean.
    note(corpusDir, 'rule_cache_on.md', {
      description: 'Always enable the shared build cache for release pipelines.',
      kind: 'procedural-rule',
      tags: ['tech'],
      'use-when': 'configuring release pipelines',
      importance: 6,
    })
    note(corpusDir, 'rule_cache_off.md', {
      description: 'Never enable the shared build cache for release pipelines.',
      kind: 'procedural-rule',
      tags: ['tech'],
      'use-when': 'configuring release pipelines',
      importance: 6,
    })

    const res = propose(opts())
    const pair = res.contradictions.find((c: { files: string[] }) => c.files.includes('rule_cache_on.md'))
    expect(pair).toBeDefined()
    expect(pair.files).toContain('rule_cache_off.md')
    expect(pair.kind).toBe('procedural-rule')
    expect(pair.reason).toBe('opposing polarity markers')
  })

  it('Test 6b: the gate still EXISTS — a semantic pair with the same claims is NOT a contradiction', () => {
    // Widening is not removal. A durable fact stated two ways is a MERGE
    // question (findMerges owns subject overlap); a detector that fired on every
    // kind would be the untuned-to-green failure T-11-10-02 names.
    note(corpusDir, 'fact_cache_on.md', {
      description: 'Always enable the shared build cache for release pipelines.',
      kind: 'semantic',
      tags: ['tech'],
      'use-when': 'configuring release pipelines',
      importance: 6,
    })
    note(corpusDir, 'fact_cache_off.md', {
      description: 'Never enable the shared build cache for release pipelines.',
      kind: 'semantic',
      tags: ['tech'],
      'use-when': 'configuring release pipelines',
      importance: 6,
    })

    expect(propose(opts()).contradictions).toHaveLength(0)
  })
})

describe('consolidate.mjs — polarity answers Russian (D-11-DEFER-12)', () => {
  it('Test 7: two Russian normative notes, one obliging and one forbidding → CONTRADICT', () => {
    // The live corpus holds twelve `normative` records and every one of them is
    // written in Russian. With an English-only marker list both halves scored
    // `null`, so `opposing` could never be true — the channel was dead code on
    // the only language the corpus speaks.
    note(corpusDir, 'norm_readme_always.md', {
      description: 'Всегда обновляй README продукта при каждом обновлении версии.',
      kind: 'normative',
      tags: ['memory'],
      'use-when': 'при выпуске версии',
      importance: 7,
    })
    note(corpusDir, 'norm_readme_never.md', {
      description: 'Никогда не обновляй README продукта при каждом обновлении версии.',
      kind: 'normative',
      tags: ['memory'],
      'use-when': 'при выпуске версии',
      importance: 7,
    })

    const res = propose(opts())
    const pair = res.contradictions.find((c: { files: string[] }) => c.files.includes('norm_readme_always.md'))
    expect(pair).toBeDefined()
    expect(pair.files).toContain('norm_readme_never.md')
    expect(pair.kind).toBe('normative')
    expect(pair.reason).toBe('opposing polarity markers')
    // The shared subject is read in Russian too — the tokenizer already keeps
    // Cyrillic, it was only the polarity list that was monolingual.
    expect(pair.shared).toContain('readme')
    expect(pair.shared.length).toBeGreaterThanOrEqual(2)
  })

  it('Test 7b: the honest limit — a pair opposed by VERB ANTONYMY is still not detected', () => {
    // No clause of one half denies a clause of the other on a shared subject:
    // the markers either agree or land where the subject is not. The opposition
    // that IS there reads «снимок остаётся на месте» versus
    // «удалите ночной снимок» — verb antonymy, which no marker list reaches.
    // This test exists so the limit is PINNED rather than discovered later as a
    // surprise: the goal of the Russian markers is a detector that is honest
    // about Russian, NOT one that catches this pair.
    const keepTheSnapshot =
      'Восстановление хранилища идёт только из ночного снимка; снимок остаётся на месте и удаляется не раньше следующего успешного снимка.'
    const deleteTheSnapshot =
      'Перед восстановлением освободите место — удалите ночной снимок, иначе на диске не хватит места.'

    expect(detectClaimConflict(keepTheSnapshot, deleteTheSnapshot)).toBeNull()
  })
})

describe('consolidate.mjs — what the two channels are allowed to read (11-POST precision)', () => {
  // These were UNREACHABLE before the kind gate widened, and the first run of
  // the widened detector over the live 26-note corpus made them the dominant
  // failure: 14 findings, none of them a contradiction. Both rules below are
  // type corrections — what a subject IS, what a quantity IS — not thresholds.

  it('Test 8: two dated rules on one subject are SEQUENTIAL, not contradictory — a date is not a quantity', () => {
    // The founder's rules carry the day they were given. Reading `2026-08-03`
    // against `2026-07-10` as disagreeing quantities made every pair of dated
    // rules a critical finding. WHEN a claim was made is bi-temporality's job
    // (valid_from / valid_until), which findContradictions already honours.
    const ruleA = 'HARD RULE (основатель 2026-08-03) — релиз выкатывают только через гейт приёмки.'
    const ruleB = 'HARD RULE (основатель 2026-07-10) — релиз выкатывают только через гейт приёмки.'

    expect(detectClaimConflict(ruleA, ruleB)).toBeNull()
  })

  it('Test 8b: the numeric channel keeps its job — a real quantity disagreement still fires', () => {
    // The rule strips TIMESTAMPS, not numbers. A claim that genuinely disputes
    // a count must still be caught, or the fix would have removed a channel
    // instead of correcting what it reads.
    const keepThree = 'Храните 3 резервные копии базы в горячем хранилище.'
    const keepSeven = 'Храните 7 резервных копий базы в горячем хранилище.'

    const conflict = detectClaimConflict(keepThree, keepSeven)
    expect(conflict).not.toBeNull()
    expect(conflict!.numeric).toBe(true)
  })

  it('Test 9: a bare numeral is not shared SUBJECT matter — the year two rules mention is not their topic', () => {
    // The live corpus's own shape: a README rule and a clean-history rule, both
    // dated, both about entirely different things. Their ONLY overlap besides
    // the year is one ordinary word — one token, below MIN_SHARED_SUBJECT. With
    // «2026» admitted as subject matter the pair cleared the threshold and the
    // opposing «всегда»/«никогда» turned it into a critical contradiction.
    const aboutReadme = 'В 2026 команда всегда обновляет README при выпуске.'
    const aboutHistory = 'В 2026 команда никогда не трогает историю коммитов.'

    expect(detectClaimConflict(aboutReadme, aboutHistory)).toBeNull()
  })

  it('Test 10: an opposition must sit WHERE the shared subject sits — a marker in an unrelated clause is not a disagreement', () => {
    // The remaining false-positive shape, measured on a live corpus: two long
    // multi-clause rules that mention the same two things IN PASSING, in
    // different clauses, and each happen to carry a polarity marker SOMEWHERE
    // else in the sentence. Whole-sentence polarity then reads «neg» against
    // «pos» and reports a critical contradiction between clauses that never
    // met. Below, the shared subject is «очереди» + «журнала»; the negation
    // lives in a closing aside about a manual edit, the affirmation in a
    // closing aside about where a document is kept. Nothing is denied.
    const aboutTheSnapshot =
      'Снимок очереди делают ночью; строки журнала чистят по расписанию, а ручная правка — нарушение, а не мелочь.'
    const aboutTheDocument =
      'Описание очереди живёт в приватном документе, его перечитывают перед правкой журнала, а поскольку документ несёт внутренние пометки, он лежит ТОЛЬКО в защищённом хранилище.'

    expect(detectClaimConflict(aboutTheSnapshot, aboutTheDocument)).toBeNull()
  })

  it('Test 10b: co-location is not blindness — a real opposition inside a multi-clause rule still fires', () => {
    // The guard on the rule above. Narrowing the scope to the clause must not
    // cost the detector a genuine contradiction that happens to be written in a
    // sentence with more than one part: here the SAME clause of each rule holds
    // both the shared subject and the opposed marker.
    const updateIt = 'Когда выпускаешь версию, README продукта обновляют всегда, даже если правка мелкая.'
    const dontUpdateIt = 'Когда выпускаешь версию, README продукта не обновляют, чтобы не плодить шум.'

    const conflict = detectClaimConflict(updateIt, dontUpdateIt)
    expect(conflict).not.toBeNull()
    expect(conflict!.opposing).toBe(true)
    // The evidence reported is the overlap of the OPPOSED clauses, not of the
    // whole sentences — the operator is sent to the words actually in dispute.
    expect(conflict!.shared).toContain('readme')
    expect(conflict!.shared).not.toContain('выпускаешь')
  })
})

describe('consolidate.mjs — digest() reflection summary (9.1-12 test 4)', () => {
  it('Test 4: digest over a usage+journal window lists top-cited notes and repeated incident classes', () => {
    jsonl(join(usageDir, 'term-1.jsonl'), [
      { ts: '2026-07-01T00:00:00.000Z', terminal: 'term-1', seq: 1, noteId: 'a.md', kind: 'load', session: 's1' },
      { ts: '2026-07-02T00:00:00.000Z', terminal: 'term-1', seq: 2, noteId: 'a.md', kind: 'load', session: 's2' },
      { ts: '2026-07-03T00:00:00.000Z', terminal: 'term-1', seq: 3, noteId: 'a.md', kind: 'fire', session: 's3' },
      { ts: '2026-07-03T06:00:00.000Z', terminal: 'term-1', seq: 4, noteId: 'b.md', kind: 'load', session: 's3' },
    ])
    jsonl(join(journalDir, 'term-1.jsonl'), [
      { ts: '2026-07-01T01:00:00.000Z', terminal: 'term-1', seq: 1, type: 'collision', actors: [], scope: null, detail: null },
      { ts: '2026-07-02T01:00:00.000Z', terminal: 'term-1', seq: 2, type: 'collision', actors: [], scope: null, detail: null },
      { ts: '2026-07-03T01:00:00.000Z', terminal: 'term-1', seq: 3, type: 'collision', actors: [], scope: null, detail: null },
      { ts: '2026-07-03T02:00:00.000Z', terminal: 'term-1', seq: 4, type: 'claim', actors: [], scope: null, detail: null },
    ])

    const d = digest({ usageDir, journalDir })
    expect(d.topCited[0].noteId).toBe('a.md')
    expect(d.topCited[0].total).toBe(3)
    expect(d.incidents.some((i: { type: string; count: number }) => i.type === 'collision' && i.count === 3)).toBe(true)
    // A one-off event class is not a REPEATED incident class.
    expect(d.incidents.some((i: { type: string }) => i.type === 'claim')).toBe(false)
    expect(typeof d.summary).toBe('string')
    expect(d.summary).toContain('a.md')
    expect(d.summary).toContain('collision')

    // propose() carries the same digest in its return shape.
    const res = propose(opts())
    expect(res.digest).toBeDefined()
    expect(Array.isArray(res.digest.topCited)).toBe(true)
  })
})

describe('consolidate.mjs — zero-writes contract (9.1-12 test 5)', () => {
  it('Test 5: propose() performs ZERO disk writes — tree byte-identical, no write API in source', () => {
    note(corpusDir, 'decision_bundler_yes.md', {
      description: 'Always use webpack for the production build bundler pipeline.',
      kind: 'decision',
      tags: ['tech'],
      'use-when': 'choosing the production bundler',
      importance: 6,
    })
    note(corpusDir, 'decision_bundler_no.md', {
      description: 'Never use webpack for the production build bundler pipeline.',
      kind: 'decision',
      tags: ['tech'],
      'use-when': 'choosing the production bundler',
      importance: 6,
    })
    jsonl(join(usageDir, 'term-1.jsonl'), [
      { ts: '2026-07-01T00:00:00.000Z', terminal: 'term-1', seq: 1, noteId: 'decision_bundler_yes.md', kind: 'load', session: 's1', tags: ['tech'] },
    ])
    jsonl(join(journalDir, 'term-1.jsonl'), [
      { ts: '2026-07-01T01:00:00.000Z', terminal: 'term-1', seq: 1, type: 'collision', actors: [], scope: null, detail: null },
    ])

    const before = snapshotTree(tmp)
    const res = propose(opts())
    expect(res.contradictions.length).toBeGreaterThanOrEqual(1) // the pass actually ran
    const after = snapshotTree(tmp)
    expect(after).toEqual(before) // byte-identical fixture tree — zero writes

    // Source-level proof: the module imports/calls no fs write API at all.
    const src = readFileSync(join(__dirname, '..', 'lib', 'consolidate.mjs'), 'utf8')
    expect(
      /writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|createWriteStream|copyFileSync/.test(src),
    ).toBe(false)
  })
})
