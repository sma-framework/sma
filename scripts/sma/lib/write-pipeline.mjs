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
 * NAME-COLLISION NOTICE. `evidence` and `risk` are step NAMES here (positions 6
 * and 7 of the sequence); their implementations are called `attachEvidence` and
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
 * PURITY POSTURE. Filesystem effects live in exactly four places: `observe`
 * (journal append), `persist` (corpus write), `stage` (drafts write) and the
 * one-time `readCorpus` that runs before the walk.
 * Every other step is a pure function over the state object, so the remaining
 * steps can be built and tested in isolation. The corpus is READ once, up
 * front, into `state.corpus` — `compare` never touches the disk.
 *
 * Node built-ins only; every directory is dependency-injectable.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { appendEvent, lineHash } from './journal.mjs'
import { atomicWriteRaw } from './fs-atomics.mjs'
import { parseNote, serializeNote } from './frontmatter.mjs'
import { scanForSecrets } from './flight.mjs'
import { findContradictions } from './consolidate.mjs'
import {
  INTERPRETATION_MODES,
  MEMORY_TYPES,
  TRUTH_MODES,
  hasEvidence,
  resolveApprovalPath,
  validateId,
  validateRecord,
} from './schema-v2.mjs'

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

/** Structural corpus files that are never records (mirrors loader.mjs/consolidate.mjs). */
const STRUCTURAL_FILES = new Set(['MEMORY.md', 'ARCHIVE.md', 'TAGS.md'])

/**
 * The ONLY approval path this pipeline may satisfy without a human. Everything
 * else — including the other "automatic" path, which is automatic about
 * DRAFTING, not about believing — is staged for review.
 */
const AUTO_PERSIST_PATH = 'auto-ttl'

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

// ── step 5: compare ─────────────────────────────────────────────────────────

/**
 * compare(state) — hold the record up against what the corpus already says.
 *
 * ONE thing blocks: an exact id collision, because two records cannot share an
 * identity and the id law makes the id the filename. Everything else is a FLAG.
 * A contradiction is not an error — it is the most valuable thing this step can
 * find, and refusing the record would leave the corpus holding the older belief
 * with nothing recorded against it. The flags travel in the trace so a human
 * (or the review verb of a later plan) can act on them.
 *
 * Contradictions come from `findContradictions` in consolidate.mjs — the ONE
 * detector in this codebase. That detector reads the v1 note vocabulary
 * (kind/tags/description), so a schema-v2 record is PROJECTED onto it here:
 * claim -> description, retrieval.areas -> tags, and truth mode -> kind. A v1
 * note in the corpus is already in that shape and passes through untouched.
 *
 * Pure: it reads `state.corpus`, never the disk.
 */
export function compare(state) {
  const corpus = Array.isArray(state.corpus) ? state.corpus : []
  const id = String(state.record.id ?? '')
  const file = `${id}.md`

  const collision = corpus.find((n) => n.file === file || String(n.frontmatter?.id ?? '') === id)
  if (collision) {
    return reject(state, 'compare', {
      reason: 'a record already holds this id — two records cannot share one identity',
      id,
      file: collision.file,
    })
  }

  const claimKey = normalizeClaim(state.record.claim)
  const duplicateClaims = corpus
    .filter((n) => claimKey !== '' && normalizeClaim(n.frontmatter?.claim ?? n.frontmatter?.description) === claimKey)
    .map((n) => n.file)
    .sort()

  const notes = [...corpus.map((n) => ({ ...n, frontmatter: forContradiction(n.frontmatter) })), {
    file,
    frontmatter: forContradiction(state.record),
    body: state.body,
  }]
  const contradictions = findContradictions({ notes, registry: state.opts.registry }).filter((c) =>
    c.files.includes(file),
  )

  const declared = asList(state.record.supersedes).map(stemOf)
  const known = new Set(corpus.map((n) => stemOf(n.file)))
  const unresolvedSupersedes = declared.filter((s) => !known.has(s)).sort()
  const supersessionCandidates = unique([
    ...declared.filter((s) => known.has(s)).map((s) => `${s}.md`),
    ...duplicateClaims,
  ]).sort()

  const temporalOverlaps = corpus
    .filter((n) => sharesArea(state.record, n.frontmatter) && windowsOverlap(state.record, n.frontmatter))
    .map((n) => n.file)
    .sort()

  const detail = { contradictions, duplicateClaims, supersessionCandidates, unresolvedSupersedes, temporalOverlaps }
  const flagged =
    contradictions.length || duplicateClaims.length || supersessionCandidates.length ||
    unresolvedSupersedes.length || temporalOverlaps.length
  state.flags = { ...state.flags, ...detail }
  return trace(state, 'compare', flagged ? 'flagged' : 'ok', detail)
}

/** Project a schema-v2 record onto the v1 vocabulary the shared detector reads. */
function forContradiction(frontmatter) {
  const fm = frontmatter ?? {}
  if (!isV2(fm)) return fm
  return {
    ...fm,
    // The kind axis exists in the v1 model to separate truth-bearing notes from
    // how-to prose. Every v2 record is truth-bearing by the one-claim law, so
    // the projection is total: a decision or a standing rule is a `decision`,
    // every other mode asserts a state of the world and is a `status`.
    kind: fm.truth_mode === 'decision' || fm.truth_mode === 'normative' ? 'decision' : 'status',
    tags: areasOf(fm),
    description: typeof fm.claim === 'string' ? fm.claim : '',
  }
}

// ── step 6: evidence ────────────────────────────────────────────────────────

/**
 * attachEvidence(state) — step 6 of the sequence — the provenance gate. (Named for what
 * it does; `evidence` is the step NAME, and evidence.mjs is a different module.)
 *
 * An authored judgment that cannot say who stands behind it, or that claims to
 * be active while carrying nothing that would re-verify it, is NOT allowed to
 * become active memory. It is not discarded either — discarding it would lose
 * the observation. It is DOWNGRADED: status `draft`, truth mode `hypothesis`,
 * staged for review. The trace keeps the mode it was declared in, so nothing
 * about the caller's intent is silently rewritten.
 *
 * A re-derivable mode (`observed`/`factual`) is untouched here: its discipline
 * is a check it can re-run, not a person who vouches for it, and that discipline
 * is enforced at the door by validateRecord.
 */
export function attachEvidence(state) {
  const declaredMode = state.record.truth_mode
  if (!INTERPRETATION_MODES.includes(declaredMode)) {
    return trace(state, 'evidence', 'ok', {
      reason: 'a re-derivable mode carries its own check — the interpretation discipline does not apply',
      truth_mode: declaredMode,
    })
  }

  const authority = state.record.source?.authority
  const missing = []
  if (!isNonEmpty(authority)) missing.push('source.authority')
  if (String(state.record.status ?? '').trim() === 'active' && !hasEvidence(state.record)) missing.push('evidence')

  if (!missing.length) {
    return trace(state, 'evidence', 'ok', { authority, truth_mode: declaredMode })
  }

  state.record.status = 'draft'
  state.record.truth_mode = 'hypothesis'
  return stage(state, 'evidence', {
    reason:
      'an authored judgment without provenance can never be active memory — downgraded to a draft hypothesis and staged for review',
    missing,
    downgraded_from: declaredMode,
  })
}

// ── step 7: risk ────────────────────────────────────────────────────────────

/**
 * assignRisk(state) — step 7 of the sequence. Ask the approval ladder which door this
 * record is entitled to, and take the answer literally.
 *
 * Exactly ONE answer opens the automatic door: `auto-ttl` — a low-risk working
 * observation. Every other path, including `auto-draft` (which is automatic
 * about DRAFTING, not about believing), stages the record. On top of the
 * ladder's verdict the automatic door checks the two facts it depends on
 * directly, plus an expiry: a memory written with no human in the loop must be
 * able to fall out of the corpus on its own, or an unreviewed belief becomes
 * permanent by default.
 */
export function assignRisk(state) {
  const r = state.record
  const approvalPath = resolveApprovalPath({
    memory_type: r.memory_type,
    truth_mode: r.truth_mode,
    sensitivity: r.sensitivity,
    risk: r.risk,
  })
  state.flags.approvalPath = approvalPath

  // The ladder already refuses anything but a low-risk working observation here;
  // the one door that writes without a human does not rely on a single lock.
  const automatic = approvalPath === AUTO_PERSIST_PATH && r.memory_type === 'working' && r.risk === 'low'
  if (!automatic) {
    return stage(state, 'risk', {
      approval_path: approvalPath,
      reason: 'this class of record is not written without review',
    })
  }
  if (!hasRetentionWindow(r)) {
    return stage(state, 'risk', {
      approval_path: approvalPath,
      reason: 'the automatic path requires a retention/ttl window — an unreviewed memory must be able to expire',
    })
  }
  return trace(state, 'risk', 'ok', { approval_path: approvalPath })
}

/** A record that may expire on its own: a retention window, or an explicit end date. */
function hasRetentionWindow(record) {
  const retention = record.retention
  if (isNonEmpty(retention)) return true
  if (retention && typeof retention === 'object' && (isNonEmpty(retention.ttl) || isNonEmpty(retention.until))) {
    return true
  }
  return isNonEmpty(record.valid_until)
}

// ── step 8: persist ─────────────────────────────────────────────────────────

/**
 * persist(state) — the only door into the corpus, and it is a gate, not a pipe.
 *
 * Validation runs BEFORE the write, and a failure stages the record instead of
 * writing it: there is no path here that produces a half-valid corpus file. The
 * write itself goes through the atomic primitive, so a reader sees the previous
 * state or the new one and never a torn file. An occupied id is never
 * overwritten — compare normally catches that, and this is the second lock.
 */
export function persist(state) {
  const record = state.record
  const target = join(state.dirs.corpusDir, `${String(record.id ?? '')}.md`)

  const idError = validateId(record.id, target)
  const { errors } = validateRecord(record)
  const all = [...(idError ? [idError] : []), ...errors]
  if (all.length) {
    return stage(state, 'persist', {
      reason: 'the corpus door validates first — a record that fails it is staged, never half-written',
      errors: all,
    })
  }
  if (existsSync(target)) {
    return stage(state, 'persist', {
      reason: 'a file already occupies this id — the pipeline never clobbers a record it did not write',
      errors: [],
    })
  }

  const rendered = renderV2(record, state.body)
  if (rendered.error) {
    return reject(state, 'persist', {
      reason: 'the record is legal but not writable in the schema-v2 grammar',
      errors: [rendered.error],
    })
  }

  atomicWriteRaw(target, rendered.text)
  state.path = target
  state.outcome = 'persisted-active'
  journal(state, { stage: 'persist', outcome: 'persisted-active', id: record.id, path: target })
  return trace(state, 'persist', 'persisted', { path: target })
}

// ── the staging boundary (the second of the three fs effects) ───────────────

/**
 * stage(state, step, detail) — put the record in drafts and end the walk.
 *
 * A draft is NOT the corpus: it carries `status: draft` and the
 * `draft_kind: pipeline-write` marker, and no corpus reader indexes the drafts
 * directory. Never clobbers — a draft a human may already have edited is worth
 * more than the one this run would write.
 */
function stage(state, step, detail) {
  const record = { ...state.record, status: 'draft', draft_kind: PIPELINE_DRAFT_KIND }
  const target = join(state.dirs.draftsDir, `${String(record.id ?? '')}.md`)

  const idError = validateId(record.id, target)
  if (idError) {
    return reject(state, step, { ...detail, reason: `cannot stage a draft: ${idError}` })
  }

  let draft = 'staged'
  if (existsSync(target)) {
    draft = 'draft-exists'
  } else {
    // The grammar can refuse a record the validator accepts (a v2 block written
    // in the wrong shape). That must surface as a refusal with the reason, never
    // as an exception escaping the pipeline into the caller.
    const rendered = renderV2(record, state.body)
    if (rendered.error) {
      return reject(state, step, { ...detail, reason: `cannot stage a draft — ${rendered.error}` })
    }
    atomicWriteRaw(target, rendered.text)
  }

  state.record = record
  state.path = target
  state.outcome = 'staged-draft'
  journal(state, { stage: step, outcome: 'staged-draft', id: record.id, path: target, draft })
  return trace(state, step, 'staged', { ...detail, path: target, draft })
}

// ── steps 9-12: not yet built ───────────────────────────────────────────────

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
  compare,
  evidence: attachEvidence,
  risk: assignRisk,
  persist,
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

  // The corpus is read ONCE, before the walk, so `compare` stays a pure function
  // over data and the remaining steps can be tested without a filesystem.
  if (state.corpus === null) state.corpus = readCorpus(state.dirs.corpusDir)

  for (const name of PIPELINE_STEPS) {
    STEPS[name](state)
    if (state.outcome !== null) break
  }

  return { record: state.record, body: state.body, trace: state.trace, outcome: state.outcome, path: state.path }
}

// ── the corpus read (the third and last fs effect) ──────────────────────────

/**
 * readCorpus(dir) -> [{file, frontmatter, body}]. FLAT: it lists the corpus
 * directory and keeps regular `.md` files only, so `drafts/` and `episodes/` are
 * skipped by construction, exactly like every other corpus reader. Fail-soft: a
 * note that will not parse is skipped rather than crashing a write — a broken
 * neighbour must not be able to block the whole pipeline.
 */
export function readCorpus(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of entries.sort()) {
    if (!name.endsWith('.md') || STRUCTURAL_FILES.has(name)) continue
    const path = join(dir, name)
    try {
      if (!statSync(path).isFile()) continue
      const note = parseNote(readFileSync(path, 'utf8'), { file: path })
      out.push({ file: name, frontmatter: note.frontmatter ?? {}, body: note.body ?? '' })
    } catch {
      // unreadable neighbour — skipped, never fatal
    }
  }
  return out
}

/**
 * renderV2(record, body) -> {text, error}. The shared serializer is the ONLY
 * way this module turns a record into bytes, and it is allowed to refuse: the
 * v2 grammar rejects a block written in the wrong shape even when the validator
 * called the record legal. That refusal is returned, never thrown — a write
 * path that can throw past its own gates is a write path with no gates.
 */
function renderV2(record, body) {
  try {
    return { text: serializeNote({ frontmatter: record, body, schemaVersion: 2 }), error: null }
  } catch (err) {
    return { text: null, error: String(err?.message ?? err) }
  }
}

// ── small pure helpers ──────────────────────────────────────────────────────

/** A schema-v2 record: it declares the version, or it speaks the v2 vocabulary. */
function isV2(fm) {
  return String(fm?.schema_version ?? '').trim() === '2' || (fm?.claim != null && fm?.memory_type != null)
}

/** A record's retrieval areas (v2), falling back to its tags (v1). */
function areasOf(fm) {
  const areas = fm?.retrieval?.areas
  if (Array.isArray(areas)) return areas.map(String)
  if (isNonEmpty(areas)) return [String(areas)]
  return Array.isArray(fm?.tags) ? fm.tags.map(String) : []
}

/** Two records share at least one retrieval area. */
function sharesArea(a, b) {
  const setB = new Set(areasOf(b))
  return areasOf(a).some((t) => setB.has(t))
}

/**
 * Validity windows that intersect. Only meaningful when BOTH records bound their
 * window at least on one side — two records with no dates at all overlap
 * trivially, and flagging that would be noise, not a finding.
 */
function windowsOverlap(a, b) {
  const bounded = (r) => isNonEmpty(r?.valid_from) || isNonEmpty(r?.valid_until)
  if (!bounded(a) || !bounded(b)) return false
  const from = (r) => (isNonEmpty(r?.valid_from) ? String(r.valid_from) : '')
  const until = (r) => (isNonEmpty(r?.valid_until) ? String(r.valid_until) : '￿')
  return from(a) <= until(b) && from(b) <= until(a)
}

/** Claim identity for the duplicate check: case- and whitespace-insensitive. */
function normalizeClaim(claim) {
  return typeof claim === 'string' ? claim.trim().toLowerCase().replace(/\s+/g, ' ') : ''
}

/** A filename or reference reduced to its stem (the id, per the id law). */
function stemOf(value) {
  const base = String(value ?? '').split(/[\\/]/).pop() ?? ''
  return base.endsWith('.md') ? base.slice(0, -3) : base
}

/** A scalar-or-array field as a list of non-empty strings. */
function asList(value) {
  if (Array.isArray(value)) return value.filter(isNonEmpty).map(String)
  return isNonEmpty(value) ? [String(value)] : []
}

function unique(list) {
  return [...new Set(list)]
}

/** Present and not blank. */
function isNonEmpty(value) {
  return value != null && String(value).trim() !== ''
}

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
