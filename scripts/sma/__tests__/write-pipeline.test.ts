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
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PIPELINE_STEPS,
  STEPS,
  createPipelineState,
  observe,
  classify,
  redact,
  extract,
  runPipeline,
} from '../lib/write-pipeline.mjs'

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
