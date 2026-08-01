/**
 * Tests for scripts/sma/lib/write-pipeline.mjs — the canon write pipeline.
 *
 * The pipeline IS the trust boundary between "something happened" and "the
 * system now believes this". These tests pin the order and the two refusals
 * that make the boundary real:
 *
 *   - STEP ORDER IS LAW. PIPELINE_STEPS is a frozen 12-name list; every name
 *     has a registered implementation, and the four that this plan does not
 *     build yet throw loudly instead of silently doing nothing.
 *   - REDACTION PRECEDES ALL PERSISTENCE. A record carrying a secret-shaped
 *     token is refused at step 3 — not scrubbed and stored, refused — and the
 *     assertion is filesystem-level: zero files under the corpus AND zero under
 *     drafts. The journal keeps the refusal, without the content.
 *   - CLASSIFICATION IS THE CALLER'S, NEVER THE MACHINE'S. An out-of-vocabulary
 *     memory_type is a rejection naming the offending value, never a guess.
 *   - ONE DURABLE CLAIM. A list of claims is several records; the pipeline says
 *     so and refuses, with the split instruction in the trace.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PIPELINE_STEPS,
  PIPELINE_DRAFT_KIND,
  STEPS,
  createPipelineState,
  observe,
  classify,
  redact,
  extract,
  compare,
  attachEvidence,
  assignRisk,
  persist,
  runPipeline,
} from '../lib/write-pipeline.mjs'
import { parseNote, serializeNote } from '../lib/frontmatter.mjs'
import { validateRecord } from '../lib/schema-v2.mjs'

let root: string
let corpusDir: string
let draftsDir: string
let journalDir: string

/** The canonical AWS documentation example key — the same fixture flight.test.ts uses. */
const SEEDED_SECRET = 'AKIAIOSFODNN7EXAMPLE'

/**
 * A well-formed working observation: the ONE class this pipeline may persist
 * automatically (working + observed + low risk + a retention window + a
 * fingerprint that lets the claim be re-checked later).
 */
function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'working-queue-adapter-drain-window',
    schema_version: '2',
    status: 'active',
    memory_type: 'working',
    truth_mode: 'observed',
    claim: 'The queue adapter drains the nightly backlog in under two minutes on this machine',
    language: 'en',
    sensitivity: 'internal',
    risk: 'low',
    retention: 'P30D',
    fingerprint: { product_version: 'v5.0.4' },
    retrieval: { areas: ['queue'] },
    ...overrides,
  }
}

function makeEvent(recordOverrides: Record<string, unknown> = {}, body = '\nObserved during the nightly drill.\n') {
  return { record: validRecord(recordOverrides), body }
}

function opts() {
  return { corpusDir, draftsDir, journalDir, terminalId: 'test-pipeline', now: '2026-08-01T12:00:00.000Z' }
}

/** Every regular file under a directory (the "nothing was written" assertion). */
function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort()
}

function stepsOf(trace: Array<{ step: string }>): string[] {
  return trace.map((t) => t.step)
}

function traceStep(trace: Array<{ step: string }>, step: string): any {
  return trace.find((t) => t.step === step)
}

/** Put a schema-v2 record into the fixture corpus, written by the shared serializer. */
function seedCorpus(frontmatter: Record<string, unknown>, body = '\nSeeded.\n') {
  const text = serializeNote({ frontmatter, body, schemaVersion: 2 })
  writeFileSync(join(corpusDir, `${frontmatter.id}.md`), text)
}

function readNote(path: string) {
  return parseNote(readFileSync(path, 'utf8'), { file: path })
}

/** The corpus neighbour used by the compare tests: the same subject, asserted positively. */
const NEIGHBOUR = {
  id: 'working-queue-adapter-nightly-drain',
  schema_version: '2',
  status: 'active',
  memory_type: 'working',
  truth_mode: 'observed',
  claim: 'The queue adapter must always drain the nightly backlog on this machine',
  language: 'en',
  sensitivity: 'internal',
  risk: 'low',
  retention: 'P30D',
  fingerprint: { product_version: 'v5.0.3' },
  retrieval: { areas: ['queue'] },
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sma-write-pipeline-'))
  corpusDir = join(root, 'memory')
  draftsDir = join(corpusDir, 'drafts')
  journalDir = join(root, 'journal')
  mkdirSync(corpusDir, { recursive: true })
  mkdirSync(draftsDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('PIPELINE_STEPS — the canon order is law', () => {
  it('Test 1: exports exactly the 12 canon step names, in order, frozen', () => {
    expect(PIPELINE_STEPS).toEqual([
      'observe',
      'classify',
      'redact',
      'extract',
      'compare',
      'evidence',
      'risk',
      'persist',
      'index',
      'measure',
      'consolidate',
      'lifecycle',
    ])
    expect(Object.isFrozen(PIPELINE_STEPS)).toBe(true)
  })

  it('Test 2: every step name has a registered implementation', () => {
    for (const name of PIPELINE_STEPS) {
      expect(typeof STEPS[name]).toBe('function')
    }
  })

  it('Test 3: the four unbuilt steps throw not-implemented rather than silently passing', () => {
    const state = createPipelineState(makeEvent(), opts())
    for (const name of ['index', 'measure', 'consolidate', 'lifecycle']) {
      expect(() => STEPS[name](state)).toThrow(/not implemented/i)
    }
  })
})

describe('step 1 observe — nothing runs before the event is on the record', () => {
  it('Test 4: appends ONE journal event and traces the step', () => {
    const state = createPipelineState(makeEvent(), opts())
    observe(state)

    expect(stepsOf(state.trace)).toEqual(['observe'])
    expect(state.trace[0].outcome).toBe('ok')

    const files = filesIn(journalDir)
    expect(files).toEqual(['test-pipeline.jsonl'])
    const lines = readFileSync(join(journalDir, 'test-pipeline.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const evt = JSON.parse(lines[0])
    expect(evt.detail.stage).toBe('observe')
  })

  it('Test 5: journals a POINTER, never the content — the claim text is not in the journal', () => {
    const event = makeEvent({ claim: `A quite distinctive sentence about ${SEEDED_SECRET} nobody should ever read here` })
    observe(createPipelineState(event, opts()))

    const raw = readFileSync(join(journalDir, 'test-pipeline.jsonl'), 'utf8')
    expect(raw).not.toContain(SEEDED_SECRET)
    expect(raw).not.toContain('quite distinctive sentence')
    // the pointer is a content hash, so the same claim is still recognisable later
    expect(JSON.parse(raw.trim()).detail.content_ref).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('step 2 classify — the caller classifies, the machine never guesses', () => {
  it('Test 6: a valid pair passes and is traced with the two values', () => {
    const state = createPipelineState(makeEvent(), opts())
    classify(state)

    expect(state.outcome).toBeNull()
    expect(state.trace.at(-1)).toMatchObject({
      step: 'classify',
      outcome: 'ok',
      detail: { memory_type: 'working', truth_mode: 'observed' },
    })
  })

  it('Test 7: an out-of-vocabulary memory_type is REJECTED and the trace names the value', () => {
    const state = createPipelineState(makeEvent({ memory_type: 'muscle' }), opts())
    classify(state)

    expect(state.outcome).toBe('rejected')
    const last = state.trace.at(-1)
    expect(last.step).toBe('classify')
    expect(last.outcome).toBe('rejected')
    expect(JSON.stringify(last.detail)).toContain('muscle')
  })

  it('Test 8: a missing truth_mode is REJECTED — there is no inferred default', () => {
    const state = createPipelineState(makeEvent({ truth_mode: undefined }), opts())
    classify(state)

    expect(state.outcome).toBe('rejected')
    expect(state.trace.at(-1)).toMatchObject({ step: 'classify', outcome: 'rejected' })
  })

  it('Test 9: rejection at classify writes NOTHING anywhere', () => {
    const result = runPipeline(makeEvent({ memory_type: 'muscle' }), opts())

    expect(result.outcome).toBe('rejected')
    expect(filesIn(corpusDir)).toEqual([])
    expect(filesIn(draftsDir)).toEqual([])
  })
})

describe('step 3 redact — the gate that stands before ALL persistence', () => {
  it('Test 10: THE mandatory case — a secret-shaped token in the claim is refused, and zero files exist', () => {
    const event = makeEvent({ claim: `The deploy token is ${SEEDED_SECRET} for the nightly job` })
    const result = runPipeline(event, opts())

    expect(result.outcome).toBe('rejected')

    // the whole point: not in the corpus, and NOT in drafts either
    expect(filesIn(corpusDir)).toEqual([])
    expect(filesIn(draftsDir)).toEqual([])

    const redactStep = result.trace.find((t) => t.step === 'redact')
    expect(redactStep.outcome).toBe('rejected')
    expect(JSON.stringify(redactStep.detail)).toContain('aws-access-key')
  })

  it('Test 11: the refusal is journalled, and the journal carries neither the secret nor the claim', () => {
    const event = makeEvent({ claim: `The deploy token is ${SEEDED_SECRET} for the nightly job` })
    runPipeline(event, opts())

    const raw = readFileSync(join(journalDir, 'test-pipeline.jsonl'), 'utf8')
    expect(raw).not.toContain(SEEDED_SECRET)
    expect(raw).not.toContain('deploy token')

    const events = raw.trim().split('\n').map((l) => JSON.parse(l))
    const refusal = events.find((e) => e.detail?.stage === 'redact')
    expect(refusal).toBeTruthy()
    expect(refusal.detail.outcome).toBe('rejected')
    expect(refusal.detail.rules).toContain('aws-access-key')
  })

  it('Test 12: a secret hiding in the BODY is caught too — the scan walks the whole record', () => {
    const event = makeEvent({}, `\nRan the drill with Bearer abcDEF1234567890token in the header.\n`)
    const result = runPipeline(event, opts())

    expect(result.outcome).toBe('rejected')
    expect(filesIn(corpusDir)).toEqual([])
    expect(filesIn(draftsDir)).toEqual([])
  })

  it('Test 13: a secret nested in a block value is caught too', () => {
    const event = makeEvent({ source: { authority: 'self-observed', refs: [`vault ${SEEDED_SECRET}`] } })
    const result = runPipeline(event, opts())

    expect(result.outcome).toBe('rejected')
    expect(filesIn(corpusDir)).toEqual([])
  })

  it('Test 14: a NON-secret personal shape is scrubbed in place, not refused', () => {
    const state = createPipelineState(
      makeEvent({ claim: 'The nightly report is mailed to someone@example.com after every drill' }),
      opts(),
    )
    redact(state)

    expect(state.outcome).toBeNull()
    expect(state.record.claim).not.toContain('someone@example.com')
    expect(state.record.claim).toContain('[redacted:personal-email]')
    expect(state.trace.at(-1)).toMatchObject({ step: 'redact', outcome: 'redacted' })
  })

  it('Test 15: clean content passes through byte-identical', () => {
    const event = makeEvent()
    const state = createPipelineState(event, opts())
    const before = state.record.claim
    redact(state)

    expect(state.record.claim).toBe(before)
    expect(state.trace.at(-1)).toMatchObject({ step: 'redact', outcome: 'ok' })
  })
})

describe('step 4 extract — one durable claim, or none', () => {
  it('Test 16: a single string claim passes', () => {
    const state = createPipelineState(makeEvent(), opts())
    extract(state)

    expect(state.outcome).toBeNull()
    expect(state.trace.at(-1)).toMatchObject({ step: 'extract', outcome: 'ok' })
  })

  it('Test 17: an ARRAY of claims is rejected with the instruction to split', () => {
    const state = createPipelineState(
      makeEvent({ claim: ['The queue drains in two minutes', 'The worker restarts cleanly'] }),
      opts(),
    )
    extract(state)

    expect(state.outcome).toBe('rejected')
    const last = state.trace.at(-1)
    expect(last.step).toBe('extract')
    expect(JSON.stringify(last.detail)).toMatch(/split/i)
  })

  it('Test 18: a bullet list smuggled into one string is rejected the same way', () => {
    const state = createPipelineState(
      makeEvent({ claim: 'Two things are true\n- the queue drains fast\n- the worker restarts' }),
      opts(),
    )
    extract(state)

    expect(state.outcome).toBe('rejected')
    expect(JSON.stringify(state.trace.at(-1).detail)).toMatch(/split/i)
  })

  it('Test 19: an empty claim is rejected — a record with nothing to say is not a record', () => {
    const state = createPipelineState(makeEvent({ claim: '   ' }), opts())
    extract(state)

    expect(state.outcome).toBe('rejected')
  })
})

describe('the walk — steps 1-4 run in the canon order', () => {
  it('Test 20: a valid event produces exactly one trace entry per step, in order', () => {
    const state = createPipelineState(makeEvent(), opts())
    observe(state)
    classify(state)
    redact(state)
    extract(state)

    expect(stepsOf(state.trace)).toEqual(['observe', 'classify', 'redact', 'extract'])
    expect(state.outcome).toBeNull()
  })

  it('Test 21: a rejection stops the walk — no step after it leaves a trace entry', () => {
    const result = runPipeline(makeEvent({ memory_type: 'muscle' }), opts())

    expect(stepsOf(result.trace)).toEqual(['observe', 'classify'])
    expect(result.outcome).toBe('rejected')
  })
})

describe('step 5 compare — what the corpus already says', () => {
  it('Test 22: an opposing claim in the corpus is FLAGGED, not blocked — the record still lands', () => {
    seedCorpus(NEIGHBOUR)
    const event = makeEvent({ claim: 'The queue adapter never drains the nightly backlog on this machine' })
    const result = runPipeline(event, opts())

    const step = traceStep(result.trace, 'compare')
    expect(step.outcome).toBe('flagged')
    expect(step.detail.contradictions).toHaveLength(1)
    expect(step.detail.contradictions[0].files).toContain('working-queue-adapter-nightly-drain.md')

    // non-blocking: a contradiction is a review signal, not a refusal
    expect(result.outcome).toBe('persisted-active')
  })

  it('Test 23: an exact-id duplicate is REJECTED and nothing is written', () => {
    seedCorpus(validRecord({ claim: 'Something else entirely about the drain window' }))
    const before = filesIn(corpusDir)

    const result = runPipeline(makeEvent(), opts())

    expect(result.outcome).toBe('rejected')
    const step = traceStep(result.trace, 'compare')
    expect(step.outcome).toBe('rejected')
    expect(JSON.stringify(step.detail)).toContain('working-queue-adapter-drain-window')
    expect(filesIn(corpusDir)).toEqual(before)
    expect(filesIn(draftsDir)).toEqual([])
  })

  it('Test 24: the same claim under a different id is flagged, not blocked', () => {
    seedCorpus({ ...NEIGHBOUR, claim: validRecord().claim })
    const result = runPipeline(makeEvent(), opts())

    const step = traceStep(result.trace, 'compare')
    expect(step.detail.duplicateClaims).toContain('working-queue-adapter-nightly-drain.md')
    expect(result.outcome).toBe('persisted-active')
  })

  it('Test 25: a named supersedes target is a supersession candidate; a missing one is flagged unresolved', () => {
    seedCorpus(NEIGHBOUR)

    const resolved = runPipeline(makeEvent({ supersedes: 'working-queue-adapter-nightly-drain' }), opts())
    const okStep = traceStep(resolved.trace, 'compare')
    expect(okStep.detail.supersessionCandidates).toContain('working-queue-adapter-nightly-drain.md')
    expect(okStep.detail.unresolvedSupersedes).toEqual([])

    rmSync(join(corpusDir, 'working-queue-adapter-drain-window.md'), { force: true })
    const dangling = runPipeline(makeEvent({ supersedes: 'a-record-that-was-never-written' }), opts())
    expect(traceStep(dangling.trace, 'compare').detail.unresolvedSupersedes).toContain(
      'a-record-that-was-never-written',
    )
  })

  it('Test 26: overlapping validity windows over a shared area are flagged', () => {
    seedCorpus({ ...NEIGHBOUR, valid_from: '2026-01-01', valid_until: '2026-12-31' })
    const result = runPipeline(makeEvent({ valid_from: '2026-06-01', valid_until: '2026-09-01' }), opts())

    const step = traceStep(result.trace, 'compare')
    expect(step.detail.temporalOverlaps).toContain('working-queue-adapter-nightly-drain.md')
  })
})

describe('step 6 evidence — a judgment without provenance never becomes active memory', () => {
  /** An authored judgment: the class the interpretation discipline governs. */
  function interpretation(overrides: Record<string, unknown> = {}) {
    return {
      id: 'procedural-prefer-the-queue-adapter',
      schema_version: '2',
      status: 'active',
      memory_type: 'procedural',
      truth_mode: 'inferred',
      claim: 'Background work should go through the queue adapter rather than an inline call',
      language: 'en',
      sensitivity: 'internal',
      risk: 'low',
      retrieval: { areas: ['queue'] },
      ...overrides,
    }
  }

  it('Test 27: THE canonical case — no source.authority means draft/hypothesis, staged, never active', () => {
    const result = runPipeline({ record: interpretation(), body: '\nA judgment.\n' }, opts())

    expect(result.outcome).toBe('staged-draft')
    expect(result.record.status).toBe('draft')
    expect(result.record.truth_mode).toBe('hypothesis')

    // it exists as a draft, and NOT in the corpus
    expect(filesIn(corpusDir)).toEqual([])
    expect(filesIn(draftsDir)).toEqual(['procedural-prefer-the-queue-adapter.md'])

    const step = traceStep(result.trace, 'evidence')
    expect(step.outcome).toBe('staged')
    expect(JSON.stringify(step.detail)).toMatch(/authority/)
    expect(step.detail.downgraded_from).toBe('inferred')
  })

  it('Test 28: the staged draft carries the pipeline marker', () => {
    const result = runPipeline({ record: interpretation(), body: '\nA judgment.\n' }, opts())
    const note = readNote(result.path)

    expect(note.frontmatter.draft_kind).toBe(PIPELINE_DRAFT_KIND)
    expect(note.frontmatter.status).toBe('draft')
  })

  it('Test 29: authority WITH none-recorded evidence is still staged — an honest nothing is nothing', () => {
    const result = runPipeline(
      {
        record: interpretation({
          source: { authority: 'self-observed' },
          evidence: [{ type: 'note', ref: 'none-recorded' }],
        }),
        body: '\nA judgment.\n',
      },
      opts(),
    )

    expect(result.outcome).toBe('staged-draft')
    expect(JSON.stringify(traceStep(result.trace, 'evidence').detail)).toMatch(/evidence/)
    expect(filesIn(corpusDir)).toEqual([])
  })

  it('Test 29b: a record the GRAMMAR refuses is refused with the reason — never an exception, never a file', () => {
    // `evidence` as a bare scalar: the validator's none-recorded rule reads it,
    // the v2 grammar does not accept it. The write boundary must say so.
    const result = runPipeline(
      {
        record: interpretation({ source: { authority: 'self-observed' }, evidence: 'none-recorded' }),
        body: '\nA judgment.\n',
      },
      opts(),
    )

    expect(result.outcome).toBe('rejected')
    expect(JSON.stringify(result.trace.at(-1).detail)).toMatch(/evidence/)
    expect(filesIn(corpusDir)).toEqual([])
    expect(filesIn(draftsDir)).toEqual([])
  })

  it('Test 30: a fact-mode record passes the evidence step untouched', () => {
    const state = createPipelineState(makeEvent(), opts())
    state.corpus = []
    attachEvidence(state)

    expect(state.outcome).toBeNull()
    expect(state.record.status).toBe('active')
    expect(state.record.truth_mode).toBe('observed')
    expect(traceStep(state.trace, 'evidence').outcome).toBe('ok')
  })
})

describe('step 7 risk — only one class of record may be written without a human', () => {
  it('Test 31: a normative rule is staged for the human path, never persisted', () => {
    const result = runPipeline(
      {
        record: {
          id: 'normative-never-add-all',
          schema_version: '2',
          status: 'active',
          memory_type: 'normative',
          truth_mode: 'normative',
          claim: 'Staging must name explicit paths in this repository',
          language: 'en',
          sensitivity: 'internal',
          risk: 'medium',
          source: { authority: 'owner-instruction' },
          evidence: [{ type: 'doc', ref: 'CONTRIBUTING.md' }],
          retrieval: { areas: ['git'] },
        },
        body: '\nA standing rule.\n',
      },
      opts(),
    )

    expect(result.outcome).toBe('staged-draft')
    expect(traceStep(result.trace, 'risk').detail.approval_path).toBe('human-approval')
    expect(filesIn(corpusDir)).toEqual([])
    expect(filesIn(draftsDir)).toEqual(['normative-never-add-all.md'])
  })

  it('Test 32: an auto-path record with NO retention window is staged — an automatic write needs an expiry', () => {
    const result = runPipeline(makeEvent({ retention: undefined }), opts())

    expect(result.outcome).toBe('staged-draft')
    const step = traceStep(result.trace, 'risk')
    expect(step.outcome).toBe('staged')
    expect(JSON.stringify(step.detail)).toMatch(/retention|ttl/i)
    expect(filesIn(corpusDir)).toEqual([])
  })

  it('Test 33: the resolved approval path is always in the trace', () => {
    const result = runPipeline(makeEvent(), opts())
    expect(traceStep(result.trace, 'risk')).toMatchObject({
      outcome: 'ok',
      detail: { approval_path: 'auto-ttl' },
    })
  })
})

describe('step 8 persist — the only door into the corpus', () => {
  it('Test 34: the happy path persists, with one trace entry for each of the eight steps', () => {
    const result = runPipeline(makeEvent(), opts())

    expect(result.outcome).toBe('persisted-active')
    expect(stepsOf(result.trace)).toEqual([
      'observe',
      'classify',
      'redact',
      'extract',
      'compare',
      'evidence',
      'risk',
      'persist',
    ])
    expect(filesIn(corpusDir)).toEqual(['working-queue-adapter-drain-window.md'])
    expect(filesIn(draftsDir)).toEqual([])
    expect(result.path).toBe(join(corpusDir, 'working-queue-adapter-drain-window.md'))
  })

  it('Test 35: what landed on disk parses back and validates with zero errors', () => {
    const result = runPipeline(makeEvent(), opts())
    const note = readNote(result.path)

    expect(note.schemaVersion).toBe(2)
    expect(validateRecord(note.frontmatter).errors).toEqual([])
    expect(note.frontmatter.id).toBe('working-queue-adapter-drain-window')
    expect(note.frontmatter.status).toBe('active')
  })

  it('Test 36: a validation failure at the door stages the record — the corpus is never half-written', () => {
    // observed is a re-derivable mode: without a fingerprint or a verification
    // plan the record cannot carry its own check, so the validator refuses it.
    const result = runPipeline(makeEvent({ fingerprint: undefined }), opts())

    expect(result.outcome).toBe('staged-draft')
    expect(filesIn(corpusDir)).toEqual([])
    expect(filesIn(draftsDir)).toEqual(['working-queue-adapter-drain-window.md'])

    const step = traceStep(result.trace, 'persist')
    expect(step.outcome).toBe('staged')
    expect(step.detail.errors.join(' ')).toMatch(/fingerprint|verification/)
  })

  it('Test 37: persist never clobbers an existing corpus file', () => {
    seedCorpus(validRecord({ claim: 'The original sentence that must survive' }))
    const original = readFileSync(join(corpusDir, 'working-queue-adapter-drain-window.md'), 'utf8')

    // corpus injected as empty, so compare cannot catch the collision — persist must
    const state = createPipelineState(makeEvent(), { ...opts(), corpus: [] })
    for (const step of [observe, classify, redact, extract, compare, attachEvidence, assignRisk, persist]) step(state)

    expect(state.outcome).toBe('staged-draft')
    expect(readFileSync(join(corpusDir, 'working-queue-adapter-drain-window.md'), 'utf8')).toBe(original)
  })

  it('Test 38: the id law holds at the write path — the file stem IS the id', () => {
    const result = runPipeline(makeEvent(), opts())
    const note = readNote(result.path)
    expect(result.path.endsWith(`${note.frontmatter.id}.md`)).toBe(true)
  })

  it('Test 39: the terminal outcome is journalled', () => {
    runPipeline(makeEvent(), opts())
    const events = readFileSync(join(journalDir, 'test-pipeline.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))

    expect(events.some((e) => e.detail?.stage === 'persist' && e.detail?.outcome === 'persisted-active')).toBe(true)
  })
})
