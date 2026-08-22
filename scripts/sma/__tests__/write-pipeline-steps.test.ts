/**
 * Contract: the twelve canon steps of the write pipeline — the list, the sentence
 * above it, and the fact that every name on it actually runs on a real record.
 *
 * WHY A SECOND FILE. write-pipeline.test.ts proves what each step DOES: what
 * observe journals, what redact refuses, what persist writes. None of that is
 * repeated here. What this file adds is the layer above the behaviour:
 *
 *   - THE DOCBLOCK IS PART OF THE CONTRACT. The comment over `PIPELINE_STEPS`
 *     claimed for months that positions nine to twelve were "registered
 *     boundaries that throw until built" — long after all four had shipped and
 *     while the suite next door was green on every one of them. A behavioural
 *     test cannot catch that: the code was right and the sentence describing it
 *     was wrong, and a reader who trusted the sentence would have believed the
 *     pipeline stops at the corpus door. So the sentence is read from the source
 *     here and asserted, including the NUMBER it names, which is derived from the
 *     live list rather than typed twice.
 *
 *   - EXECUTABILITY, NOT REGISTRATION. That a name has an entry in the step table
 *     proves only that something is bound to it. This file walks the whole
 *     sequence through `runPipeline` on a minimal valid record and requires the
 *     returned trace to name all twelve, in canon order, with no outcome that
 *     reads as an unbuilt boundary — the wire, not the calculation.
 *
 *   - THE DURABLE TRACE AGREES WITH THE WALK. The `retrieval-trace` record step
 *     ten leaves in the journal is asserted to be the same walk, and its honest
 *     limit is pinned rather than glossed: it is written mid-sequence, so it can
 *     only ever carry the steps that ran BEFORE it. That is a fact about the hook
 *     point, and pinning it means a future change that quietly drops steps from
 *     the summary is a failure rather than a shrug.
 *
 *   - THE DECISION NEXT TO IT STAYS WRITTEN DOWN. `docs/MEMORY-LIFECYCLE.md`
 *     records that outcome attribution is deliberately not built and under what
 *     condition that is revisited. A decision nobody can find is a decision that
 *     rots back into silence, so the document is read here too.
 *
 * The step names below are a deliberate verbatim second measure, in the words of
 * docs/MEMORY-LIFECYCLE.md §1: changing the shipped list must be re-typed here,
 * consciously, to stay green. The list itself is IMPORTED — a literal standing in
 * for the module would only ever prove itself.
 *
 * Every record below is synthetic: an invented queue adapter, invented ids.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PIPELINE_STEPS, RETRIEVAL_TRACE_KIND, runPipeline } from '../lib/write-pipeline.mjs'

/** The twelve steps docs/MEMORY-LIFECYCLE.md §1 names, in the document's order. */
const CANON_STEPS = [
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
]

/** Number words zero..twelve, so the docblock's count is checked against the live list. */
const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
]

/** The pipeline module as shipped, read from the tree with line endings normalized. */
function pipelineSource(): string {
  const path = fileURLToPath(new URL('../lib/write-pipeline.mjs', import.meta.url))
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

/**
 * The docblock immediately above the exported step list — the sentence under test,
 * FLATTENED. Comment leaders and the wrap are stripped and the whitespace collapsed,
 * because a sentence in a source comment is broken across lines wherever the column
 * limit happened to fall: asserting the raw text would make this suite red on a
 * re-wrap that changed no word, and green on a re-worded claim that kept the wrap.
 */
function stepsDocblock(): string {
  const src = pipelineSource()
  const declaration = src.indexOf('export const PIPELINE_STEPS')
  expect(declaration).toBeGreaterThan(-1)
  const opens = src.lastIndexOf('/**', declaration)
  expect(opens).toBeGreaterThan(-1)
  return src
    .slice(opens, declaration)
    .replace(/^\s*\/?\*+\/?/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** docs/MEMORY-LIFECYCLE.md as shipped, read from the tree rather than paraphrased. */
function lifecycleDoc(): string {
  const path = fileURLToPath(new URL('../../../docs/MEMORY-LIFECYCLE.md', import.meta.url))
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

let root: string
let corpusDir: string
let draftsDir: string
let journalDir: string

const TERMINAL = 'steps-contract'
const NOW = '2026-08-22T09:00:00.000Z'

/**
 * The one class this pipeline may persist without a human: a low-risk working
 * observation carrying a retention window and a fingerprint to re-check it by.
 */
function validEvent() {
  return {
    record: {
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
    },
    body: '\nObserved during the nightly drill.\n',
  }
}

function opts() {
  return { corpusDir, draftsDir, journalDir, terminalId: TERMINAL, now: NOW }
}

/** Every journal line the walk appended, parsed. */
function journalEvents(): any[] {
  const path = join(journalDir, `${TERMINAL}.jsonl`)
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf8').trim()
  return raw === '' ? [] : raw.split('\n').map((line) => JSON.parse(line))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sma-pipeline-steps-'))
  corpusDir = join(root, '.claude', 'memory')
  draftsDir = join(corpusDir, 'drafts')
  journalDir = join(root, 'journal')
  mkdirSync(corpusDir, { recursive: true })
  mkdirSync(draftsDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ── the list itself ──────────────────────────────────────────────────────────

describe('PIPELINE_STEPS — the canon sequence (docs/MEMORY-LIFECYCLE.md §1)', () => {
  it('carries exactly the twelve steps the document names, in the document order', () => {
    expect([...PIPELINE_STEPS]).toEqual(CANON_STEPS)
  })

  it('is exactly twelve steps long — a thirteenth is a canon decision, not a refactor', () => {
    expect(PIPELINE_STEPS).toHaveLength(12)
  })

  it('is frozen, so no caller can re-order or extend the sequence at runtime', () => {
    expect(Object.isFrozen(PIPELINE_STEPS)).toBe(true)
  })
})

// ── the sentence above the list ──────────────────────────────────────────────

describe('the docblock over the sequence describes the code that is actually there', () => {
  it('states that ALL twelve are implemented — the "throws until built" claim is gone', () => {
    const block = stepsDocblock()
    expect(block).toMatch(/all twelve are implemented/i)
    expect(block).not.toMatch(/until built/i)
    expect(block).not.toMatch(/not implemented/i)
    expect(block).not.toMatch(/registered boundaries that/i)
  })

  it('does not single out a tail of the sequence as unbuilt', () => {
    const block = stepsDocblock()
    // the exact shape of the old lie: a range of positions said to be waiting
    expect(block).not.toMatch(/9\s*[-–]\s*12/)
    expect(block).not.toMatch(/positions?\s+1\s*[-–]\s*8/i)
  })

  it('names the same count the live list has, so the two cannot drift apart', () => {
    expect(stepsDocblock().toLowerCase()).toContain(NUMBER_WORDS[PIPELINE_STEPS.length])
  })
})

// ── executability: every name on the list actually runs ──────────────────────

describe('every canon step RUNS — proven by a full walk, not by the step table', () => {
  it('a full run over a valid record executes all twelve, in canon order', () => {
    const result = runPipeline(validEvent(), opts())

    expect(result.outcome).toBe('persisted-active')
    expect(result.trace.map((entry: any) => entry.step)).toEqual(CANON_STEPS)
  })

  it('no executed step reports an unbuilt boundary — each one declares a real outcome', () => {
    const result = runPipeline(validEvent(), opts())

    for (const entry of result.trace as any[]) {
      expect(typeof entry.outcome, `step ${entry.step} must declare an outcome`).toBe('string')
      expect(entry.outcome, `step ${entry.step} must not be empty`).not.toBe('')
      expect(entry.outcome, `step ${entry.step} must not read as unbuilt`).not.toMatch(
        /not[-\s]?implemented|unbuilt|todo|stub/i,
      )
    }
  })

  it('the walk that ran is the whole list — nothing was skipped and nothing ran twice', () => {
    const result = runPipeline(validEvent(), opts())
    const walked = result.trace.map((entry: any) => entry.step)

    expect(new Set(walked).size).toBe(walked.length)
    for (const name of PIPELINE_STEPS) {
      expect(walked, `${name} must have run`).toContain(name)
    }
  })
})

// ── the durable trace, and the honest limit of the hook point ────────────────

describe('the retrieval-trace record in the journal is the same walk', () => {
  it('leaves exactly one trace record naming the record that was written', () => {
    runPipeline(validEvent(), opts())

    const traces = journalEvents().filter((event) => event.detail?.kind === RETRIEVAL_TRACE_KIND)
    expect(traces).toHaveLength(1)
    expect(traces[0].detail.record_id).toBe('working-queue-adapter-drain-window')
  })

  it('names the steps that ran BEFORE it — the hook is mid-sequence and cannot see past itself', () => {
    const result = runPipeline(validEvent(), opts())
    const trace = journalEvents().find((event) => event.detail?.kind === RETRIEVAL_TRACE_KIND)

    const named = trace.detail.trace_summary.map((entry: string) => entry.split(':')[0])
    // step 10 appends this record before it traces itself, so the durable summary is
    // exactly the prefix up to measure: the three that follow (measure, consolidate,
    // lifecycle) live in the returned trace above and nowhere in the journal line.
    expect(named).toEqual(CANON_STEPS.slice(0, CANON_STEPS.indexOf('measure')))
    expect(named).toEqual(result.trace.map((entry: any) => entry.step).slice(0, named.length))
    for (const name of named) {
      expect(PIPELINE_STEPS, `${name} must be a canon step name`).toContain(name)
    }
  })

  it('carries the SHAPE of the walk and never the claim itself', () => {
    runPipeline(validEvent(), opts())
    const trace = journalEvents().find((event) => event.detail?.kind === RETRIEVAL_TRACE_KIND)

    expect(JSON.stringify(trace)).not.toContain(validEvent().record.claim)
    for (const entry of trace.detail.trace_summary as string[]) {
      expect(entry).toMatch(/^[a-z]+:[a-z-]+$/)
    }
  })
})

// ── the decision recorded beside the measurement step ────────────────────────

describe('what step 10 deliberately does not do stays written down', () => {
  it('records that outcome attribution is not built', () => {
    expect(lifecycleDoc()).toContain('Outcome attribution is deliberately NOT built')
  })

  it('gives that gap a condition that reopens it, not an open-ended postponement', () => {
    expect(lifecycleDoc()).toContain(
      'how this work ended with this memory, and how it ended',
    )
  })
})
