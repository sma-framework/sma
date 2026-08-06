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
 *   - THE WALK DOES NOT STOP AT THE CORPUS DOOR. A persisted record continues
 *     through index (the SAME generator path the build-index verb uses), measure
 *     (one retrieval-trace hook point in the journal), consolidate and lifecycle.
 *   - CONSOLIDATION PROPOSES, NEVER MERGES. A flagged contradiction produces a
 *     draft proposal and zero corpus mutations.
 *   - A SUPERSESSION IS SYMMETRIC OR IT IS NOTHING. Both pointers are rendered
 *     before either is written, and ERASE is refused with a policy pointer —
 *     there is no deletion code path in this module to reach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PIPELINE_STEPS,
  PIPELINE_DRAFT_KIND,
  CONSOLIDATION_DRAFT_KIND,
  LIFECYCLE_ACTIONS,
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
  applyLifecycle,
  applyStagedDraft,
  runPipeline,
} from '../lib/write-pipeline.mjs'
import { applyProposal } from '../lib/migrate-v1-v2.mjs'
import { parseNote, serializeNote } from '../lib/frontmatter.mjs'
import { buildIndex } from '../lib/generator.mjs'
import { validateRecord } from '../lib/schema-v2.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs')

let root: string
let corpusDir: string
let draftsDir: string
let journalDir: string

/** Spawn the real CLI against the per-test temp .sma root. Never throws. */
function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, SMA_ROOT_OVERRIDE: join(root, '.sma') },
    })
    return { stdout, stderr: '', status: 0 }
  } catch (err: any) {
    return { stdout: String(err?.stdout ?? ''), stderr: String(err?.stderr ?? ''), status: err?.status ?? 1 }
  }
}

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

/** Every journal line this pipeline appended, parsed. */
function journalEvents(): any[] {
  const path = join(journalDir, 'test-pipeline.jsonl')
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf8').trim()
  return raw === '' ? [] : raw.split('\n').map((l) => JSON.parse(l))
}

/** The generated index as it stands on disk. */
function indexText(): string {
  return readFileSync(join(corpusDir, 'MEMORY.md'), 'utf8')
}

/** The index the build-index verb would produce RIGHT NOW over the fixture corpus. */
function freshIndex(commitHash = '0000000'): string {
  return buildIndex({ corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), commitHash, dateMap: {} })
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

  it('Test 3: NO step is a not-implemented boundary any more — the canon sequence is fully built', () => {
    for (const name of PIPELINE_STEPS) {
      const state = createPipelineState(makeEvent(), opts())
      expect(() => STEPS[name](state)).not.toThrow()
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
  it('Test 34: the happy path persists — the record is the only NOTE in the corpus, and the walk goes on', () => {
    const result = runPipeline(makeEvent(), opts())

    expect(result.outcome).toBe('persisted-active')
    expect(stepsOf(result.trace).slice(0, 8)).toEqual([
      'observe',
      'classify',
      'redact',
      'extract',
      'compare',
      'evidence',
      'risk',
      'persist',
    ])
    expect(traceStep(result.trace, 'persist').outcome).toBe('persisted')
    // persist no longer ENDS the walk (steps 9-12 run on the persisted path), so the
    // corpus also carries the generated index artifacts that step 9 rebuilds.
    expect(filesIn(corpusDir).filter((f) => f !== 'MEMORY.md' && !f.startsWith('INDEX-'))).toEqual([
      'working-queue-adapter-drain-window.md',
    ])
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

describe('steps 9-12 — the walk continues past the corpus door', () => {
  it('Test 40: the happy path walks ALL TWELVE canon steps and still ends persisted-active', () => {
    const result = runPipeline(makeEvent(), opts())

    expect(result.outcome).toBe('persisted-active')
    expect(stepsOf(result.trace)).toEqual([...PIPELINE_STEPS])
    expect(result.trace).toHaveLength(12)
  })

  it('Test 41: step 9 rebuilds the index through the SAME buildIndex path the build-index verb uses', () => {
    runPipeline(makeEvent(), opts())

    // byte identity with the generator's own output — not a second renderer
    expect(indexText()).toBe(freshIndex())
    // the per-area catalog is rebuilt too, and it names the record that just landed
    expect(existsSync(join(corpusDir, 'INDEX-misc.md'))).toBe(true)
    expect(readFileSync(join(corpusDir, 'INDEX-misc.md'), 'utf8')).toContain(
      'working-queue-adapter-drain-window.md',
    )
  })

  it('Test 42: the build anchor comes from an INJECTED git runner; a broken one degrades, never fails the write', () => {
    const withGit = runPipeline(makeEvent(), {
      ...opts(),
      execGit: (args: string[]) => (args[0] === 'rev-parse' ? 'abc1234\n' : ''),
    })
    expect(withGit.outcome).toBe('persisted-active')
    expect(indexText()).toContain('abc1234')

    rmSync(corpusDir, { recursive: true, force: true })
    mkdirSync(corpusDir, { recursive: true })
    const broken = runPipeline(makeEvent(), {
      ...opts(),
      execGit: () => {
        throw new Error('git is not available here')
      },
    })
    expect(broken.outcome).toBe('persisted-active')
    expect(existsSync(join(corpusDir, 'MEMORY.md'))).toBe(true)
  })

  it('Test 43: step 10 leaves exactly ONE retrieval-trace record — the measurement hook point', () => {
    runPipeline(makeEvent(), opts())

    const traces = journalEvents().filter((e) => e.detail?.kind === 'retrieval-trace')
    expect(traces).toHaveLength(1)
    expect(traces[0].detail.record_id).toBe('working-queue-adapter-drain-window')
    expect(traces[0].detail.written_at).toBe('2026-08-01T12:00:00.000Z')
    expect(traces[0].detail.trace_summary).toContain('persist:persisted')
    // a hook point carries the SHAPE of the write, never its content
    expect(JSON.stringify(traces[0])).not.toContain(validRecord().claim)
  })
})

describe('step 11 consolidate — proposals only, never a merge', () => {
  /** Seed the contradicting neighbour and write the opposing claim through the pipeline. */
  function contradictingRun(extra: Record<string, unknown> = {}) {
    seedCorpus(NEIGHBOUR)
    const before = readFileSync(join(corpusDir, 'working-queue-adapter-nightly-drain.md'), 'utf8')
    const result = runPipeline(
      makeEvent({ claim: 'The queue adapter never drains the nightly backlog on this machine', ...extra }),
      opts(),
    )
    return { result, before }
  }

  it('Test 44: a flagged contradiction produces a consolidation PROPOSAL draft naming both records', () => {
    const { result } = contradictingRun()

    expect(result.outcome).toBe('persisted-active')
    const proposalPath = join(draftsDir, 'consolidation-working-queue-adapter-drain-window.md')
    expect(existsSync(proposalPath)).toBe(true)

    const proposal = readNote(proposalPath)
    expect(proposal.frontmatter.draft_kind).toBe(CONSOLIDATION_DRAFT_KIND)
    expect(proposal.frontmatter.status).toBe('draft')
    expect(proposal.frontmatter.proposal_records).toEqual(
      expect.arrayContaining(['working-queue-adapter-drain-window', 'working-queue-adapter-nightly-drain']),
    )
    expect(String(proposal.frontmatter.proposal_action)).not.toBe('')

    const step = traceStep(result.trace, 'consolidate')
    expect(step.outcome).toBe('proposed')
    expect(step.detail.path).toBe(proposalPath)
  })

  it('Test 45: the proposal changes NOTHING — both records survive, both untouched, nothing merged', () => {
    const { before } = contradictingRun()

    // the flagged neighbour is byte-identical: step 11 has no corpus write path
    expect(readFileSync(join(corpusDir, 'working-queue-adapter-nightly-drain.md'), 'utf8')).toBe(before)
    // and both records are still there, both still active
    const notes = filesIn(corpusDir).filter((f) => f !== 'MEMORY.md' && !f.startsWith('INDEX-'))
    expect(notes).toEqual([
      'working-queue-adapter-drain-window.md',
      'working-queue-adapter-nightly-drain.md',
    ])
    for (const f of notes) {
      expect(readNote(join(corpusDir, f)).frontmatter.status).toBe('active')
    }
  })

  it('Test 46: a clean write proposes nothing — no draft, no noise', () => {
    const result = runPipeline(makeEvent(), opts())

    expect(traceStep(result.trace, 'consolidate').outcome).toBe('ok')
    expect(filesIn(draftsDir)).toEqual([])
  })

  it('Test 47: an existing proposal is never clobbered — a human may already have edited it', () => {
    const proposalPath = join(draftsDir, 'consolidation-working-queue-adapter-drain-window.md')
    writeFileSync(proposalPath, 'a human edited this proposal\n')

    const { result } = contradictingRun()

    expect(readFileSync(proposalPath, 'utf8')).toBe('a human edited this proposal\n')
    expect(traceStep(result.trace, 'consolidate').detail.draft).toBe('proposal-exists')
  })
})

describe('applyLifecycle — the transitions, and the one it refuses', () => {
  const NOW = '2026-08-01T12:00:00.000Z'

  /** A second corpus record to supersede the neighbour with. */
  const SUCCESSOR = {
    ...NEIGHBOUR,
    id: 'working-queue-adapter-drain-window',
    claim: 'The queue adapter drains the nightly backlog in under two minutes on this machine',
  }

  /** Every transition against the fixture corpus + the fixture journal. */
  function lc(input: Record<string, unknown>) {
    return applyLifecycle({ corpusDir, journalDir, terminalId: 'test-pipeline', now: NOW, ...input })
  }

  it('Test 48: supersede sets SYMMETRIC pointers on BOTH records', () => {
    seedCorpus(NEIGHBOUR)
    seedCorpus(SUCCESSOR)

    const res = lc({
      id: 'working-queue-adapter-nightly-drain',
      action: 'supersede',
      by: 'working-queue-adapter-drain-window',
    })

    expect(res.applied).toBe(true)
    const old = readNote(join(corpusDir, 'working-queue-adapter-nightly-drain.md')).frontmatter
    const fresh = readNote(join(corpusDir, 'working-queue-adapter-drain-window.md')).frontmatter

    expect(old.status).toBe('superseded')
    expect(old.superseded_by).toBe('working-queue-adapter-drain-window')
    expect(old.superseded_at).toBe('2026-08-01')
    // the other half of the pointer — a chain readable from either end
    expect([].concat(fresh.supersedes as any)).toContain('working-queue-adapter-nightly-drain')
    expect(res.changed).toHaveLength(2)
  })

  it('Test 49: a superseded record drops OUT of CORE on the next index build', () => {
    seedCorpus({ ...NEIGHBOUR, context_priority: 'always' })
    seedCorpus(SUCCESSOR)

    expect(freshIndex()).toContain('working-queue-adapter-nightly-drain.md')

    lc({
      id: 'working-queue-adapter-nightly-drain',
      action: 'supersede',
      by: 'working-queue-adapter-drain-window',
    })

    // MEMORY.md names a note only when it is CORE; the hard filter drops it
    expect(freshIndex()).not.toContain('working-queue-adapter-nightly-drain.md')
  })

  it('Test 50: erase is PERFORMED — the refusal became a delegation, and the record is gone', () => {
    // The contract this case pins CHANGED. It used to assert
    // that erase was refused with a policy pointer and was not in the vocabulary
    // at all. It is rewritten rather than deleted so the change of contract is
    // visible in a test diff instead of only in an absence: the destructive
    // effect now lives in erase.mjs and the lifecycle delegates to it.
    seedCorpus(NEIGHBOUR)
    expect(existsSync(join(corpusDir, 'working-queue-adapter-nightly-drain.md'))).toBe(true)

    const res = lc({ id: 'working-queue-adapter-nightly-drain', action: 'erase' })

    expect(res.applied).toBe(true)
    expect(res.refusal).toBeUndefined()
    expect(res.changed).toContain(join(corpusDir, 'working-queue-adapter-nightly-drain.md'))
    // read the surface back — the return value is not the evidence
    expect(existsSync(join(corpusDir, 'working-queue-adapter-nightly-drain.md'))).toBe(false)
    // erase is now one of the five things this module can do
    expect(LIFECYCLE_ACTIONS).toContain('erase')
    // and it still refuses to promise the one thing it cannot do
    expect(res.history.touched).toBe(false)
    expect(String(res.history.note)).toMatch(/histor/i)
  })

  it('Test 50b: an unknown action is still refused, naming all five legal ones', () => {
    seedCorpus(NEIGHBOUR)
    const res = lc({ id: 'working-queue-adapter-nightly-drain', action: 'obliterate' })

    expect(res.applied).toBe(false)
    expect(res.refusal).toMatch(/obliterate/)
    for (const action of LIFECYCLE_ACTIONS) expect(res.refusal).toContain(action)
    expect(existsSync(join(corpusDir, 'working-queue-adapter-nightly-drain.md'))).toBe(true)
  })

  it('Test 51: expire refuses a record whose window has not run out, and applies when it has', () => {
    seedCorpus(NEIGHBOUR)
    const noWindow = lc({ id: 'working-queue-adapter-nightly-drain', action: 'expire' })
    expect(noWindow.applied).toBe(false)
    expect(noWindow.refusal).toMatch(/valid_until/)

    seedCorpus({ ...NEIGHBOUR, valid_until: '2026-12-31' })
    const future = lc({ id: 'working-queue-adapter-nightly-drain', action: 'expire' })
    expect(future.applied).toBe(false)
    expect(future.refusal).toMatch(/2026-12-31/)
    expect(readNote(join(corpusDir, 'working-queue-adapter-nightly-drain.md')).frontmatter.status).toBe('active')

    seedCorpus({ ...NEIGHBOUR, valid_until: '2026-07-01' })
    const passed = lc({ id: 'working-queue-adapter-nightly-drain', action: 'expire' })
    expect(passed.applied).toBe(true)
    expect(readNote(join(corpusDir, 'working-queue-adapter-nightly-drain.md')).frontmatter.status).toBe('expired')
  })

  it('Test 52: revoke demands a stated reason, and the reason lands in the journal, not in the record', () => {
    seedCorpus(NEIGHBOUR)

    const bare = lc({ id: 'working-queue-adapter-nightly-drain', action: 'revoke' })
    expect(bare.applied).toBe(false)
    expect(bare.refusal).toMatch(/reason/i)
    expect(readNote(join(corpusDir, 'working-queue-adapter-nightly-drain.md')).frontmatter.status).toBe('active')

    const res = lc({
      id: 'working-queue-adapter-nightly-drain',
      action: 'revoke',
      reason: 'the drill it was drawn from was invalid',
    })
    expect(res.applied).toBe(true)
    expect(readNote(join(corpusDir, 'working-queue-adapter-nightly-drain.md')).frontmatter.status).toBe('revoked')

    const events = journalEvents().filter((e) => e.detail?.stage === 'lifecycle')
    expect(events).toHaveLength(1)
    expect(events[0].detail.action).toBe('revoke')
    expect(events[0].detail.reason).toMatch(/drill it was drawn from/)
  })

  it('Test 53: archive takes a record out of active retrieval without touching a byte of history', () => {
    seedCorpus(NEIGHBOUR)
    const res = lc({ id: 'working-queue-adapter-nightly-drain', action: 'archive' })

    expect(res.applied).toBe(true)
    const note = readNote(join(corpusDir, 'working-queue-adapter-nightly-drain.md'))
    expect(note.frontmatter.status).toBe('archived')
    expect(note.frontmatter.claim).toBe(NEIGHBOUR.claim)
  })

  it('Test 54: an unknown action, an unknown record and a v1 note are refused — never guessed', () => {
    seedCorpus(NEIGHBOUR)

    const unknownAction = lc({ id: 'working-queue-adapter-nightly-drain', action: 'forget' })
    expect(unknownAction.applied).toBe(false)
    expect(unknownAction.refusal).toContain('archive')

    const unknownRecord = lc({ id: 'a-record-that-never-existed', action: 'archive' })
    expect(unknownRecord.applied).toBe(false)
    expect(filesIn(corpusDir)).toEqual(['working-queue-adapter-nightly-drain.md'])

    // a v1 note has no `status` field in its grammar: a transition would be written
    // and then silently dropped by the serializer — so it is refused instead.
    writeFileSync(
      join(corpusDir, 'reference_legacy.md'),
      serializeNote({
        frontmatter: { description: 'A legacy note', kind: 'reference', tags: ['queue'], importance: 3 },
        body: '\nLegacy.\n',
      }),
    )
    const v1 = lc({ id: 'reference_legacy', action: 'archive' })
    expect(v1.applied).toBe(false)
    expect(v1.refusal).toMatch(/schema[- ]v2|migrate/i)
  })

  it('Test 55: a record the GRAMMAR cannot re-emit is refused — the transition is never half-written', () => {
    // the disagreement the corpus lint pins as critical: the validator accepts a
    // bare `evidence` scalar, the v2 grammar refuses to write it back.
    writeFileSync(
      join(corpusDir, 'working-queue-adapter-nightly-drain.md'),
      ['---', 'id: working-queue-adapter-nightly-drain', 'schema_version: 2', 'status: active',
       'memory_type: working', 'truth_mode: observed', 'claim: An unwritable record',
       'language: en', 'evidence: none-recorded', 'sensitivity: internal', '---', '', 'Body.', ''].join('\n'),
    )
    const before = readFileSync(join(corpusDir, 'working-queue-adapter-nightly-drain.md'), 'utf8')

    const res = lc({ id: 'working-queue-adapter-nightly-drain', action: 'archive' })

    expect(res.applied).toBe(false)
    expect(res.refusal).toMatch(/evidence/)
    expect(readFileSync(join(corpusDir, 'working-queue-adapter-nightly-drain.md'), 'utf8')).toBe(before)
  })
})

describe('step 12 lifecycle — a declared supersession leaves no one-sided pointer', () => {
  it('Test 56: the corpus never holds half a supersession after a declared write', () => {
    seedCorpus(NEIGHBOUR)

    const result = runPipeline(makeEvent({ supersedes: 'working-queue-adapter-nightly-drain' }), opts())

    expect(result.outcome).toBe('persisted-active')
    const old = readNote(join(corpusDir, 'working-queue-adapter-nightly-drain.md')).frontmatter
    expect(old.status).toBe('superseded')
    expect(old.superseded_by).toBe('working-queue-adapter-drain-window')
    expect(old.superseded_at).toBe('2026-08-01')

    const step = traceStep(result.trace, 'lifecycle')
    expect(step.detail.superseded).toContain('working-queue-adapter-nightly-drain')
  })

  it('Test 57: the index is rebuilt AFTER the transition that invalidated it', () => {
    seedCorpus({ ...NEIGHBOUR, context_priority: 'always' })

    runPipeline(makeEvent({ supersedes: 'working-queue-adapter-nightly-drain' }), opts())

    // step 9 built an index in which the neighbour was still CORE; step 12 retired it
    // and rebuilt — the file on disk must match the post-transition corpus, not the pre.
    expect(indexText()).toBe(freshIndex())
    expect(indexText()).not.toContain('working-queue-adapter-nightly-drain.md')
  })

  it('Test 58: a supersession that would break an existing chain is refused, not overwritten', () => {
    seedCorpus({
      ...NEIGHBOUR,
      status: 'superseded',
      superseded_by: 'working-queue-adapter-some-other-record',
      superseded_at: '2026-05-01',
    })

    const result = runPipeline(makeEvent({ supersedes: 'working-queue-adapter-nightly-drain' }), opts())

    const old = readNote(join(corpusDir, 'working-queue-adapter-nightly-drain.md')).frontmatter
    expect(old.superseded_by).toBe('working-queue-adapter-some-other-record')
    const step = traceStep(result.trace, 'lifecycle')
    expect(JSON.stringify(step.detail.refused)).toMatch(/already superseded/i)
  })
})

describe('the CLI surface — sma memory write', () => {
  const CLAIM = 'The queue adapter drains the nightly backlog in under two minutes on this machine'

  it('Test 59: --help names the three flags that carry the classification and the claim', () => {
    const res = runCli(['memory', 'write', '--help'])

    expect(res.status).toBe(0)
    const head = res.stdout.split('\n').slice(0, 5).join('\n')
    expect(head).toContain('--type')
    expect(head).toContain('--truth')
    expect(head).toContain('--claim')
  })

  it('Test 60: a value outside the closed vocabulary is refused WITH the allowed list, and nothing is written', () => {
    const res = runCli([
      'memory', 'write', '--corpus', corpusDir,
      '--type', 'muscle', '--truth', 'observed', '--claim', CLAIM,
    ])

    expect(res.status).not.toBe(0)
    expect(`${res.stdout}${res.stderr}`).toContain('--type')
    expect(`${res.stdout}${res.stderr}`).toContain('working')
    expect(filesIn(corpusDir)).toEqual([])
    expect(filesIn(draftsDir)).toEqual([])
  })

  it('Test 61: the verb produces the same outcome as the module, and prints the twelve-step trace', () => {
    const res = runCli([
      'memory', 'write', '--corpus', corpusDir,
      '--type', 'working', '--truth', 'observed', '--claim', CLAIM,
      '--id', 'working-queue-adapter-drain-window',
      '--areas', 'queue', '--retention', 'P30D', '--product-version', 'v5.0.4',
      '--body', 'Observed during the nightly drill.',
    ])

    expect(res.status).toBe(0)
    expect(res.stdout).toContain('persisted-active')
    for (const step of PIPELINE_STEPS) expect(res.stdout).toContain(step)
    expect(res.stdout).toContain(join(corpusDir, 'working-queue-adapter-drain-window.md'))

    const note = readNote(join(corpusDir, 'working-queue-adapter-drain-window.md'))
    expect(validateRecord(note.frontmatter).errors).toEqual([])
    expect(existsSync(join(corpusDir, 'MEMORY.md'))).toBe(true)
  })

  it('Test 62: a judgment without provenance stages a draft through the verb too — the corpus stays empty', () => {
    const res = runCli([
      'memory', 'write', '--corpus', corpusDir,
      '--type', 'procedural', '--truth', 'inferred',
      '--claim', 'Background work should go through the queue adapter rather than an inline call',
      '--id', 'procedural-prefer-the-queue-adapter', '--areas', 'queue',
    ])

    expect(res.status).toBe(0)
    expect(res.stdout).toContain('staged-draft')
    expect(filesIn(corpusDir)).toEqual([])
    expect(filesIn(draftsDir)).toEqual(['procedural-prefer-the-queue-adapter.md'])
    expect(readNote(join(draftsDir, 'procedural-prefer-the-queue-adapter.md')).frontmatter.draft_kind).toBe(
      PIPELINE_DRAFT_KIND,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE APPLY DOOR — the way OUT of drafts/ for a record this pipeline staged.
//
// Staging was always terminal and there was no door: a standing rule the risk
// step legitimately deferred, and that the owner then confirmed, had no path
// into the corpus at all (`memory migrate --apply` refuses it honestly — a
// pipeline-write draft is not a v2-migration proposal). These tests pin the
// door and, first, the dead end that made it necessary.
//
// The fixture rule text is SYNTHETIC. What it reproduces is the live SHAPE —
// normative/normative, an owner-instruction authority, evidence, low risk —
// which is what the approval ladder actually routes into drafts/.
// ─────────────────────────────────────────────────────────────────────────────

/** The class that always stages: a standing rule, owner-stamped, carrying evidence. */
const OWNER_RULE = {
  id: 'normative-release-notes-before-the-tag',
  schema_version: '2',
  status: 'active',
  memory_type: 'normative',
  truth_mode: 'normative',
  claim: 'A release tag is cut only after the release notes for that release are written and reviewed',
  language: 'en',
  source: { authority: 'owner-instruction' },
  evidence: [{ type: 'doc', ref: 'docs/RELEASING.md' }],
  risk: 'low',
  sensitivity: 'internal',
  retrieval: { areas: ['release'] },
}
const OWNER_RULE_BODY = '\nRecorded after the owner confirmed the rule in review.\n'
const OWNER_RULE_FILE = `${OWNER_RULE.id}.md`

/** Stage the owner rule through the REAL pipeline and hand back the draft it wrote. */
function stageOwnerRule(overrides: Record<string, unknown> = {}): string {
  const result = runPipeline({ record: { ...OWNER_RULE, ...overrides }, body: OWNER_RULE_BODY }, opts())
  expect(result.outcome).toBe('staged-draft')
  expect(result.path).toBe(join(draftsDir, OWNER_RULE_FILE))
  return result.path as string
}

/** Hand-edit a staged draft the way a human would before accepting it. */
function editDraft(draftPath: string, mutate: (fm: any, body: string) => { frontmatter: any; body: string }) {
  const note = readNote(draftPath)
  const next = mutate(note.frontmatter, note.body)
  writeFileSync(draftPath, serializeNote({ ...next, schemaVersion: 2 }))
}

describe('the apply door — the dead end it was built to close', () => {
  it('Test 63: the migration door refuses a pipeline-write draft, and now says which door owns it', () => {
    const draftPath = stageOwnerRule()

    const res = applyProposal({ draftPath, corpusDir, confirmFile: OWNER_RULE_FILE })

    // The honest refusal — a staged record is not a migration
    // proposal, and the migration engine was never entitled to apply one.
    expect(res.applied).toBe(false)
    expect(res.reason).toMatch(/not a migration proposal/i)
    expect(res.reason).toContain(PIPELINE_DRAFT_KIND)
    // …and the dead end is now a signpost rather than a wall.
    expect(res.reason).toMatch(/memory write --apply/)
    expect(filesIn(corpusDir)).toEqual([])
    expect(filesIn(draftsDir)).toEqual([OWNER_RULE_FILE])
  })
})

describe('applyStagedDraft — one draft, one named confirmation, one door', () => {
  it('Test 64: an owner-stamped draft named by its own confirmation reaches the corpus, and the draft is consumed', () => {
    const draftPath = stageOwnerRule()

    const res = applyStagedDraft({ draftPath, corpusDir, confirmFile: OWNER_RULE_FILE, ...opts() })

    expect(res.applied).toBe(true)
    expect(res.outcome).toBe('persisted-active')
    expect(res.target_path).toBe(join(corpusDir, OWNER_RULE_FILE))

    // The record is IN the corpus, valid, active, and carries no draft marker.
    const note = readNote(join(corpusDir, OWNER_RULE_FILE))
    expect(validateRecord(note.frontmatter).errors).toEqual([])
    expect(note.frontmatter!.status).toBe('active')
    expect(note.frontmatter!.draft_kind).toBeUndefined()
    expect(note.frontmatter!.truth_mode).toBe('normative')
    expect(note.frontmatter!.claim).toBe(OWNER_RULE.claim)

    // The draft is consumed — the same `.applied` convention the migration door uses.
    expect(filesIn(draftsDir)).toEqual([`${OWNER_RULE.id}.applied.md`])
  })

  it('Test 65: steps 9-12 run after the write — the index is rebuilt and the retrieval trace is journalled', () => {
    const draftPath = stageOwnerRule()

    const res = applyStagedDraft({ draftPath, corpusDir, confirmFile: OWNER_RULE_FILE, ...opts() })

    expect(res.applied).toBe(true)
    expect(stepsOf(res.trace).slice(-4)).toEqual(['index', 'measure', 'consolidate', 'lifecycle'])
    // The SAME generator path the build-index verb walks — not a second grammar.
    expect(indexText()).toBe(freshIndex())
    const areaFiles: string[] = traceStep(res.trace, 'index').detail.area_files
    expect(areaFiles.length).toBeGreaterThan(0)
    expect(readFileSync(join(corpusDir, areaFiles[0]), 'utf8')).toContain(OWNER_RULE.id)
    expect(journalEvents().some((e) => e.detail?.kind === 'retrieval-trace')).toBe(true)
  })

  it('Test 66: step 11 still only PROPOSES — a duplicate claim in the corpus produces a draft, never a merge', () => {
    seedCorpus({
      ...OWNER_RULE,
      id: 'normative-release-notes-first',
      status: 'active',
    })
    const draftPath = stageOwnerRule()

    const res = applyStagedDraft({ draftPath, corpusDir, confirmFile: OWNER_RULE_FILE, ...opts() })

    expect(res.applied).toBe(true)
    expect(traceStep(res.trace, 'consolidate').outcome).toBe('proposed')
    const proposal = join(draftsDir, `consolidation-${OWNER_RULE.id}.md`)
    expect(existsSync(proposal)).toBe(true)
    expect(readNote(proposal).frontmatter!.draft_kind).toBe(CONSOLIDATION_DRAFT_KIND)
    // Both beliefs are still on disk, untouched: nothing was merged.
    expect(readNote(join(corpusDir, 'normative-release-notes-first.md')).frontmatter!.status).toBe('active')
  })

  it('Test 67: the confirmation must name the record\'s own file — a mismatch writes nothing', () => {
    const draftPath = stageOwnerRule()
    const before = readFileSync(draftPath, 'utf8')

    const wrong = applyStagedDraft({ draftPath, corpusDir, confirmFile: 'some-other-record.md', ...opts() })
    const absent = applyStagedDraft({ draftPath, corpusDir, confirmFile: '', ...opts() })

    for (const res of [wrong, absent]) {
      expect(res.applied).toBe(false)
      expect(res.reason).toMatch(/confirmation mismatch/i)
    }
    expect(filesIn(corpusDir)).toEqual([])
    expect(filesIn(draftsDir)).toEqual([OWNER_RULE_FILE])
    expect(readFileSync(draftPath, 'utf8')).toBe(before)
  })

  it('Test 68: validateRecord runs BEFORE any write — an invalid draft is refused with the reasons', () => {
    const draftPath = stageOwnerRule()
    // A human edits the provenance out of the draft before accepting it.
    editDraft(draftPath, (fm, body) => {
      const next = { ...fm }
      delete next.source
      return { frontmatter: next, body }
    })
    const before = readFileSync(draftPath, 'utf8')

    const res = applyStagedDraft({ draftPath, corpusDir, confirmFile: OWNER_RULE_FILE, ...opts() })

    expect(res.applied).toBe(false)
    expect(res.reason).toMatch(/does not validate/i)
    expect(res.errors.join(' ')).toMatch(/source\.authority/)
    expect(filesIn(corpusDir)).toEqual([])
    expect(filesIn(draftsDir)).toEqual([OWNER_RULE_FILE])
    expect(readFileSync(draftPath, 'utf8')).toBe(before)
  })

  it('Test 69: redaction still precedes persistence — a secret hand-edited into a draft is refused, nothing written', () => {
    const draftPath = stageOwnerRule()
    editDraft(draftPath, (fm, body) => ({ frontmatter: fm, body: `${body}\nkey: ${SEEDED_SECRET}\n` }))

    const res = applyStagedDraft({ draftPath, corpusDir, confirmFile: OWNER_RULE_FILE, ...opts() })

    expect(res.applied).toBe(false)
    expect(res.reason).toMatch(/secret-class/i)
    expect(filesIn(corpusDir)).toEqual([])
    expect(filesIn(draftsDir)).toEqual([OWNER_RULE_FILE])
    // The refusal is journalled by RULE NAME, never with the content.
    expect(JSON.stringify(journalEvents())).not.toContain(SEEDED_SECRET)
  })

  it('Test 70: a proposal is applied exactly once — the consumed marker closes the door behind it', () => {
    const draftPath = stageOwnerRule()

    const first = applyStagedDraft({ draftPath, corpusDir, confirmFile: OWNER_RULE_FILE, ...opts() })
    const second = applyStagedDraft({ draftPath, corpusDir, confirmFile: OWNER_RULE_FILE, ...opts() })

    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)
    expect(second.reason).toMatch(/already applied/i)
    expect(filesIn(corpusDir).filter((f) => f === OWNER_RULE_FILE)).toEqual([OWNER_RULE_FILE])
  })

  it('Test 71: a consolidation proposal is NOT a staged record — no verb applies one', () => {
    seedCorpus({ ...OWNER_RULE, id: 'normative-release-notes-first', status: 'active' })
    const applied = applyStagedDraft({
      draftPath: stageOwnerRule(),
      corpusDir,
      confirmFile: OWNER_RULE_FILE,
      ...opts(),
    })
    expect(applied.applied).toBe(true)
    const proposal = join(draftsDir, `consolidation-${OWNER_RULE.id}.md`)

    const res = applyStagedDraft({
      draftPath: proposal,
      corpusDir,
      confirmFile: `consolidation-${OWNER_RULE.id}.md`,
      ...opts(),
    })

    expect(res.applied).toBe(false)
    expect(res.reason).toMatch(/human act/i)
    expect(readFileSync(proposal, 'utf8')).toContain(CONSOLIDATION_DRAFT_KIND)
  })

  it('Test 72: an occupied id is never clobbered — the door refuses and leaves both files alone', () => {
    const draftPath = stageOwnerRule()
    seedCorpus({ ...OWNER_RULE, claim: 'A different belief already holds this identity' }, '\nSeeded first.\n')
    const before = readFileSync(join(corpusDir, OWNER_RULE_FILE), 'utf8')

    const res = applyStagedDraft({ draftPath, corpusDir, confirmFile: OWNER_RULE_FILE, ...opts() })

    expect(res.applied).toBe(false)
    expect(res.reason).toMatch(/identity|already/i)
    expect(readFileSync(join(corpusDir, OWNER_RULE_FILE), 'utf8')).toBe(before)
    expect(filesIn(draftsDir)).toEqual([OWNER_RULE_FILE])
  })

  it('Test 73: the verb route applies the draft end to end — the same door, seen from the terminal', () => {
    const draftPath = stageOwnerRule()

    const refused = runCli([
      'memory', 'write', '--corpus', corpusDir, '--apply', draftPath, '--confirm', OWNER_RULE_FILE,
    ])
    expect(refused.status).not.toBe(0)
    expect(`${refused.stdout}${refused.stderr}`).toContain('--yes')
    expect(filesIn(corpusDir)).toEqual([])

    const res = runCli([
      'memory', 'write', '--corpus', corpusDir, '--apply', draftPath, '--confirm', OWNER_RULE_FILE, '--yes',
    ])

    expect(res.status).toBe(0)
    expect(res.stdout).toContain(join(corpusDir, OWNER_RULE_FILE))
    expect(validateRecord(readNote(join(corpusDir, OWNER_RULE_FILE)).frontmatter).errors).toEqual([])
    expect(filesIn(draftsDir)).toEqual([`${OWNER_RULE.id}.applied.md`])
  })
})
