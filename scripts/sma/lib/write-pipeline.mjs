/**
 * write-pipeline.mjs — THE WRITE PIPELINE: the boundary between "something
 * happened" and "the system now believes this".
 *
 * STEP ORDER IS LAW. `PIPELINE_STEPS` is the canon sequence and this module
 * walks it in that order, never another: an event is journalled before it is
 * classified, classified before it is scrubbed, scrubbed before it is examined,
 * examined before it is weighed, and weighed before a single byte is written.
 * Re-ordering the list is not a refactor — it is a change to what the system is
 * allowed to believe.
 *
 * REDACTION PRECEDES ALL PERSISTENCE — INCLUDING DRAFTS. Step 3 runs before any
 * write path exists in the walk. A secret-class hit is a HARD STOP: the record
 * is refused, the journal keeps the refusal (rule names only, never content),
 * and no file is created in the corpus OR in drafts. "Redact then store" would
 * put the secret one `git log -p` away; this module never does that.
 *
 * THE MACHINE NEVER CLASSIFIES. `memory_type` and `truth_mode` arrive from the
 * caller and are checked against the closed vocabularies of schema-v2.mjs. An
 * unreadable value is a rejection that names it — never a guess, never a
 * default. Auto-classification is the anti-pattern this design exists to refuse.
 *
 * NAME-COLLISION NOTICE. `evidence` and `risk` are step NAMES here (canon §7
 * positions 6 and 7); their implementations are `attachEvidence` and
 * `assignRisk` so that nothing in this file can be confused with `evidence.mjs`
 * (the risky-operation burden of proof) or with a record's own `risk` field.
 * `compare` reuses `findContradictions` from consolidate.mjs — the ONE
 * contradiction implementation in this codebase; a second one must never exist.
 *
 * SCOPE. This module implements steps 1-8. Steps 9-12 (index, measure,
 * consolidate, lifecycle) are REGISTERED as named boundaries that throw
 * `not implemented` — a loud gap beats a silent no-op that looks like success.
 * They are unreachable today because every step-8 path is terminal.
 *
 * PURITY POSTURE. Filesystem effects live in exactly three places: `observe`
 * (journal append), `persist` (corpus write) and `stageDraft` (drafts write).
 * Every other step is a pure function over the state object, so the remaining
 * steps can be built and tested in isolation. The corpus is READ once, up
 * front, into `state.corpus` — `compare` never touches the disk.
 *
 * Node built-ins only; every directory is dependency-injectable.
 */

import { join } from 'node:path'

import { appendEvent, lineHash } from './journal.mjs'
import { scanForSecrets } from './flight.mjs'
import { MEMORY_TYPES, TRUTH_MODES } from './schema-v2.mjs'

/**
 * The canon write sequence. Twelve names, one order, frozen. Positions 1-8 are
 * implemented here; 9-12 are registered boundaries that throw until built.
 */
export const PIPELINE_STEPS = Object.freeze([
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

/** The marker every draft this pipeline stages carries, so its origin is greppable. */
export const PIPELINE_DRAFT_KIND = 'pipeline-write'

/** The corpus subdirectory drafts live in (the product-wide drafts dir, predict.mjs's too). */
export const DRAFTS_DIRNAME = 'drafts'

/** The default terminal identity of a pipeline journal file. */
const DEFAULT_TERMINAL = 'write-pipeline'

/** The journal event type every pipeline stage appends under. */
const JOURNAL_EVENT_TYPE = 'memory-write'

// ── the state object (the contract the remaining steps are built against) ────

/**
 * createPipelineState(event, opts) -> state.
 *
 * The single mutable object every step reads and writes. Its shape IS the
 * contract for the steps still to be built:
 *
 *   {
 *     record,     // the schema-v2 frontmatter under construction (a COPY —
 *                 //   the caller's object is never mutated)
 *     body,       // the note body text
 *     trace,      // [{step, outcome, detail}] — one entry per EXECUTED step
 *     outcome,    // null while walking; 'persisted-active'|'staged-draft'|'rejected'
 *     path,       // the file finally written, or null
 *     flags,      // findings that inform later steps but do not stop the walk
 *     redactions, // [{rule, class}] applied to the content
 *     corpus,     // [{file, frontmatter, body}] read ONCE, before the walk
 *     dirs,       // {corpusDir, draftsDir, journalDir}
 *     opts,       // {terminalId, now, registry}
 *   }
 *
 * @param {{record?:object, body?:string}} event
 * @param {object} [opts]
 * @returns {object} state
 */
export function createPipelineState(event = {}, opts = {}) {
  const corpusDir = opts.corpusDir ?? join('.claude', 'memory')
  return {
    record: deepCopy(event.record ?? {}),
    body: typeof event.body === 'string' ? event.body : '',
    trace: [],
    outcome: null,
    path: null,
    flags: {},
    redactions: [],
    corpus: opts.corpus ?? null,
    dirs: {
      corpusDir,
      draftsDir: opts.draftsDir ?? join(corpusDir, DRAFTS_DIRNAME),
      journalDir: opts.journalDir ?? null,
    },
    opts: {
      terminalId: opts.terminalId ?? DEFAULT_TERMINAL,
      now: opts.now ?? null,
      registry: opts.registry ?? undefined,
    },
  }
}

/** Record one executed step. The trace is append-only — a step never edits history. */
function trace(state, step, outcome, detail = null) {
  state.trace.push({ step, outcome, detail })
  return state
}

/** Terminal refusal: mark the outcome and stop the walk. Nothing is ever written after this. */
function reject(state, step, detail) {
  trace(state, step, 'rejected', detail)
  state.outcome = 'rejected'
  return state
}

// ── step 1: observe ─────────────────────────────────────────────────────────

/**
 * observe(state) — append the event to the journal. NOTHING may run before it:
 * an event the system refuses must still be a thing the system remembers being
 * asked, or the refusal is unauditable.
 *
 * What lands in the journal is a POINTER, never the payload. The content has
 * not been through step 3 yet, so writing it here would put an unscrubbed
 * secret on disk — the exact failure the pipeline exists to prevent. The
 * pointer is a sha256 of the claim, which is enough to recognise the same
 * content later without ever storing it.
 *
 * Fail-open: an unwritable journal degrades the trace, it does not stop the
 * pipeline (a memory system that cannot write its log must still refuse
 * secrets).
 */
export function observe(state) {
  const claim = typeof state.record.claim === 'string' ? state.record.claim : JSON.stringify(state.record.claim ?? null)
  const detail = {
    stage: 'observe',
    content_ref: lineHash(claim),
    content_chars: claim.length,
    id: typeof state.record.id === 'string' ? state.record.id : null,
  }
  const written = journal(state, detail)
  return trace(state, 'observe', written ? 'ok' : 'degraded', detail)
}

/** The one journal boundary. Returns false when the append failed (fail-open). */
function journal(state, detail) {
  try {
    appendEvent(
      { type: JOURNAL_EVENT_TYPE, scope: 'memory-corpus', detail },
      {
        terminalId: state.opts.terminalId,
        journalDir: state.dirs.journalDir ?? undefined,
        now: state.opts.now ?? undefined,
      },
    )
    return true
  } catch {
    return false
  }
}

// ── step 2: classify ────────────────────────────────────────────────────────

/**
 * classify(state) — the memory type and the truth mode come from the CALLER and
 * are checked against the closed vocabularies. There is no default and no
 * inference: a machine that may pick its own truth mode can promote a guess to
 * a fact, which is the anti-pattern the memory model forbids outright.
 */
export function classify(state) {
  const memoryType = state.record.memory_type
  const truthMode = state.record.truth_mode

  const bad = []
  if (!MEMORY_TYPES.includes(memoryType)) {
    bad.push({ field: 'memory_type', value: memoryType ?? null, allowed: [...MEMORY_TYPES] })
  }
  if (!TRUTH_MODES.includes(truthMode)) {
    bad.push({ field: 'truth_mode', value: truthMode ?? null, allowed: [...TRUTH_MODES] })
  }
  if (bad.length) {
    return reject(state, 'classify', {
      reason: 'classification must be supplied by the caller and must be in the closed vocabulary',
      invalid: bad,
    })
  }
  return trace(state, 'classify', 'ok', { memory_type: memoryType, truth_mode: truthMode })
}

// ── step 3: redact ──────────────────────────────────────────────────────────

/**
 * Personal shapes that are NOT credentials. A hit here is scrubbed in place and
 * the walk continues: an email address or a home path in a claim is noise to be
 * removed, not evidence of a compromise. Credential shapes come from
 * flight.mjs's SECRET_PATTERNS — the codebase's one redaction vocabulary — and
 * a hit there is a hard stop instead.
 */
const PERSONAL_PATTERNS = Object.freeze([
  { rule: 'personal-email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { rule: 'home-directory-path', re: /(?:\/(?:home|Users)\/[^\s"'`]+|[A-Za-z]:\\Users\\[^\s"'`]+)/g },
])

/**
 * redact(state) — THE GATE. It stands before every write path in this module,
 * and it is the reason the walk is ordered the way it is.
 *
 * Secret-class hit  -> HARD STOP. The record is refused, the refusal is
 *                      journalled with rule names only, and nothing is written
 *                      anywhere — not the corpus, not drafts. A secret that
 *                      reached a git-diffable store is not recoverable by
 *                      deleting the file.
 * Personal-class hit -> scrubbed in place, the walk continues, the trace says
 *                      what was replaced.
 *
 * The scan walks EVERY string leaf of the record plus the body, so a credential
 * hidden in a nested block or an array entry is caught exactly like one in the
 * claim.
 */
export function redact(state) {
  const secretRules = new Set()
  eachString(state.record, (s) => {
    for (const r of scanForSecrets(s).redactions) secretRules.add(r.rule)
  })
  for (const r of scanForSecrets(state.body).redactions) secretRules.add(r.rule)

  if (secretRules.size) {
    const rules = [...secretRules].sort()
    // The journal records the refusal, never the content that caused it.
    journal(state, { stage: 'redact', outcome: 'rejected', rules })
    return reject(state, 'redact', {
      reason: 'secret-class material must never reach a durable store — the record is refused, not scrubbed',
      rules,
    })
  }

  const applied = []
  state.record = mapStrings(state.record, (s) => scrubPersonal(s, applied))
  state.body = scrubPersonal(state.body, applied)

  if (applied.length) {
    state.redactions = applied.map((rule) => ({ rule, class: 'personal' }))
    return trace(state, 'redact', 'redacted', { rules: [...new Set(applied)].sort() })
  }
  return trace(state, 'redact', 'ok', null)
}

/** Replace personal shapes with `[redacted:<rule>]`, collecting the rule names hit. */
function scrubPersonal(text, applied) {
  let out = String(text ?? '')
  for (const p of PERSONAL_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags)
    out = out.replace(re, () => {
      applied.push(p.rule)
      return `[redacted:${p.rule}]`
    })
  }
  return out
}

// ── step 4: extract ─────────────────────────────────────────────────────────

/** A bullet list smuggled into one string — several claims wearing one coat. */
const BULLET_LIST_RE = /\n\s*[-*]\s+\S/

const SPLIT_GUIDANCE =
  'one durable claim per record — split this into separate records, one claim each, and run each through the pipeline'

/**
 * extract(state) — the one-claim law. A record carrying two assertions cannot be
 * superseded, contradicted or expired as a unit: half of it may go stale while
 * the other half stays true, and there is no way to say so. Episodes are where
 * multi-claim narrative belongs (episodes.mjs); a reviewed record is one claim.
 */
export function extract(state) {
  const claim = state.record.claim

  if (Array.isArray(claim)) {
    return reject(state, 'extract', {
      reason: 'claim is a list of claims',
      count: claim.length,
      guidance: SPLIT_GUIDANCE,
    })
  }
  if (typeof claim !== 'string' || claim.trim() === '') {
    return reject(state, 'extract', {
      reason: 'claim: missing or empty — a record with nothing to assert is not a record',
      guidance: SPLIT_GUIDANCE,
    })
  }
  if (BULLET_LIST_RE.test(claim)) {
    return reject(state, 'extract', {
      reason: 'claim carries a bullet list — several claims in one string',
      guidance: SPLIT_GUIDANCE,
    })
  }
  return trace(state, 'extract', 'ok', { chars: claim.trim().length })
}

// ── steps 5-8: not yet built ────────────────────────────────────────────────

function notImplemented(name) {
  return () => {
    throw new Error(
      `write-pipeline: step "${name}" is not implemented yet — it is a registered boundary, not a no-op`,
    )
  }
}

// ── the registry + the walk ─────────────────────────────────────────────────

/**
 * Every canon step name mapped to its implementation. A name with no
 * implementation would let the walk skip a gate silently; a registered thrower
 * cannot.
 */
export const STEPS = Object.freeze({
  observe,
  classify,
  redact,
  extract,
  compare: notImplemented('compare'),
  evidence: notImplemented('evidence'),
  risk: notImplemented('risk'),
  persist: notImplemented('persist'),
  index: notImplemented('index'),
  measure: notImplemented('measure'),
  consolidate: notImplemented('consolidate'),
  lifecycle: notImplemented('lifecycle'),
})

/**
 * runPipeline(event, opts) -> {record, body, trace, outcome, path}.
 *
 * Walks PIPELINE_STEPS in order and stops the moment a step sets a terminal
 * outcome. The trace holds one entry per EXECUTED step, so the returned object
 * answers "why does the system believe this" (or "why did it refuse") without
 * anyone re-running anything.
 *
 * @param {{record:object, body?:string}} event
 * @param {{corpusDir?:string, draftsDir?:string, journalDir?:string,
 *          terminalId?:string, now?:string, corpus?:Array, registry?:object}} [opts]
 */
export function runPipeline(event, opts = {}) {
  const state = createPipelineState(event, opts)

  for (const name of PIPELINE_STEPS) {
    STEPS[name](state)
    if (state.outcome !== null) break
  }

  return { record: state.record, body: state.body, trace: state.trace, outcome: state.outcome, path: state.path }
}

// ── small pure helpers ──────────────────────────────────────────────────────

/** Structured deep copy of plain data (the caller's object is never mutated). */
function deepCopy(value) {
  if (Array.isArray(value)) return value.map(deepCopy)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = deepCopy(v)
    return out
  }
  return value
}

/** Visit every string leaf of a plain-data value. */
function eachString(value, fn) {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.forEach((v) => eachString(v, fn))
  if (value && typeof value === 'object') return Object.values(value).forEach((v) => eachString(v, fn))
}

/** Deep-map every string leaf of a plain-data value. */
function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn)
    return out
  }
  return value
}
