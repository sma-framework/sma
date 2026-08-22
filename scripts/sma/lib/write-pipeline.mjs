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
 * (the risky-operation burden of proof) or with a record's own `risk` field. The
 * same rule gives step 11 the implementation name `proposeConsolidation`, because
 * `consolidate` is a module this file imports from. `compare` reuses
 * `findContradictions` from consolidate.mjs — the ONE contradiction
 * implementation in this codebase; a second one must never exist.
 *
 * THE WALK DOES NOT STOP AT THE CORPUS DOOR. A persisted record continues
 * through index (9), measure (10), consolidate (11) and lifecycle (12); only the
 * last of those declares the terminal outcome. Staging and refusal remain
 * terminal at the step that decided them, so the four tail steps run on exactly
 * one path: the one where something was actually written.
 *
 * CONSOLIDATION PROPOSES, IT NEVER MERGES. Step 11 writes a draft proposal and
 * has no corpus write path at all. Auto-merge and auto-promote are the canon
 * anti-patterns; a machine that quietly rewrites two beliefs into one has
 * decided something a human never reviewed.
 *
 * ERASE IS DELEGATED, NOT PERFORMED HERE. `applyLifecycle` performs five
 * actions: supersede, revoke, expire, archive — and erase, which it hands to
 * erase.mjs. It used to REFUSE erase with a pointer to the policy that owned the
 * question; that policy is now settled (physical removal from the corpus, the
 * working tree and every derived index, verified — with git history stated as an
 * untouched exception rather than promised), so the refusal became a delegation.
 * The destructive effect still has no code path IN THIS FILE: it lives in one
 * named module of its own, which is the purity posture stated immediately below
 * rather than an exception to it.
 *
 * PURITY POSTURE. Filesystem effects live in named places only: `observe`
 * (journal append), `persist` (corpus write), `stage` (drafts write), `index`
 * (generated index artifacts), `measure` (journal append), `proposeConsolidation`
 * (drafts write), `applyLifecycle` (the transition pair-write) and the one-time
 * `readCorpus` that runs before the walk. Every other step is a pure function
 * over the state object. The corpus is READ once, up front, into `state.corpus`
 * — `compare` never touches the disk.
 *
 * Node built-ins only; every directory is dependency-injectable, and so is the
 * read-only git runner the index build takes its anchor from.
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { appendEvent, lineHash } from './journal.mjs'
import { atomicWriteRaw } from './fs-atomics.mjs'
import { parseNote, serializeNote } from './frontmatter.mjs'
import { scanForSecrets } from './flight.mjs'
import { findContradictions } from './consolidate.mjs'
import { buildAreaIndexes, buildIndex, computeDateMap } from './generator.mjs'
import { eraseRecord } from './erase.mjs'
import {
  INTERPRETATION_MODES,
  MEMORY_TYPES,
  TRUTH_MODES,
  hasEvidence,
  hasLifetimeWindow,
  resolveApprovalPath,
  storagePlacementDenial,
  validateId,
  validateRecord,
} from './schema-v2.mjs'
import { localStorePath } from './local-store.mjs'

/**
 * The canon write sequence. Twelve names, one order, frozen. All twelve are
 * implemented in this module and every one of them runs: there is no registered
 * boundary left that stands in for a step nobody built. This sentence used to say
 * the opposite about the last four long after they shipped, which is the reason a
 * contract suite now walks the whole sequence on a real record and reads this
 * docblock — a comment that describes code it no longer matches is a lie the
 * compiler cannot catch.
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

/**
 * The marker on a step-11 draft. A DIFFERENT kind from a staged record, because
 * it is a different thing: a staged record is a candidate belief awaiting review,
 * a consolidation proposal is a question about two beliefs that already exist.
 */
export const CONSOLIDATION_DRAFT_KIND = 'consolidation-proposal'

/** The id prefix of a consolidation proposal, so the id law still holds for it. */
const CONSOLIDATION_ID_PREFIX = 'consolidation-'

/**
 * The journal record kind step 10 appends. It is a HOOK POINT for the
 * measurement track and nothing more: this module computes no metric from it.
 */
export const RETRIEVAL_TRACE_KIND = 'retrieval-trace'

/** The corpus subdirectory drafts live in (the product-wide drafts dir, predict.mjs's too). */
export const DRAFTS_DIRNAME = 'drafts'

/**
 * Keys that exist only while a record is a draft — stripped before anything is
 * written into the corpus, by whichever door is applying it. Defined HERE, next
 * to the step that mints them, and imported by migrate-v1-v2.mjs rather than
 * re-listed there: two lists would drift the first time either side grew a key
 * and the drift would be invisible (a marker that reached the corpus reads like
 * an ordinary unknown field).
 */
export const DRAFT_MARKER_KEYS = Object.freeze(['draft_kind', 'draft_source', 'draft_disposition'])

/**
 * A draft is UNTRUSTED INPUT on a filesystem boundary: it may have been
 * hand-edited before acceptance (that is the whole point of staging it), pasted
 * in, or produced by a future tool. Both values that reach `join(corpusDir, …)`
 * are therefore charset-gated before any write, so an apply can only ever
 * resolve INSIDE the corpus.
 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SAFE_SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/

/** The generated always-load index the step-9 rebuild writes. */
const INDEX_FILENAME = 'MEMORY.md'

/** The build anchor used when no git runner is injected (deterministic, never a guess). */
const EPOCH_COMMIT = '0000000'

/** The default terminal identity of a pipeline journal file. */
const DEFAULT_TERMINAL = 'write-pipeline'

/**
 * The journal event type every pipeline stage appends under. EXPORTED because
 * it is the one machine trace that a note walked this pipeline: the corpus lint
 * reads the journal for exactly these events, and a second copy of the string on
 * the reading side would be a second opinion about what the proof looks like.
 */
export const JOURNAL_EVENT_TYPE = 'memory-write'

/**
 * The outcomes that mean the record REACHED the corpus (as opposed to being
 * observed, staged as a draft or refused). Same reason for living here: the
 * writer names them, the reader never re-guesses them.
 */
export const CORPUS_LANDED_OUTCOMES = Object.freeze(['persisted-active', 'applied'])

/** Structural corpus files that are never records (mirrors loader.mjs/consolidate.mjs). */
const STRUCTURAL_FILES = new Set(['MEMORY.md', 'ARCHIVE.md', 'TAGS.md'])

/**
 * The per-area index files step 9 generates. They live IN the corpus directory
 * and are machine artifacts, so the corpus read must skip them exactly like the
 * generator does — otherwise this pipeline would start comparing new records
 * against its own output.
 */
const GENERATED_INDEX_RE = /^INDEX-[^/\\]+\.md$/

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
 *     persisted,  // true once step 8 wrote the record — the flag that keeps the
 *                 //   walk going into steps 9-12 instead of ending at the door
 *     flags,      // findings that inform later steps but do not stop the walk
 *     redactions, // [{rule, class}] applied to the content
 *     corpus,     // [{file, frontmatter, body}] read ONCE, before the walk
 *     dirs,       // {corpusDir, draftsDir, journalDir, localDir}
 *     opts,       // {terminalId, now, registry, execGit}
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
    persisted: false,
    flags: {},
    redactions: [],
    corpus: opts.corpus ?? null,
    dirs: {
      corpusDir,
      draftsDir: opts.draftsDir ?? join(corpusDir, DRAFTS_DIRNAME),
      journalDir: opts.journalDir ?? null,
      // Where this-machine-only material belongs. A PATH, computed, never created
      // here: this module does not own the store's creation, only the refusal to
      // write past it. Same relative-to-cwd default posture as corpusDir.
      localDir: opts.localDir ?? localStorePath({ repoRoot: opts.repoRoot ?? '.' }),
    },
    opts: {
      terminalId: opts.terminalId ?? DEFAULT_TERMINAL,
      now: opts.now ?? null,
      registry: opts.registry ?? undefined,
      // The read-only git runner the index build takes its anchor from. Absent
      // means the deterministic epoch anchor: this module never shells out on
      // its own, so a memory write cannot become a process spawn by surprise.
      execGit: typeof opts.execGit === 'function' ? opts.execGit : null,
      // A caller's REASON to stage this record whatever its class entitles it to.
      // It exists because some facts are true of the DESTINATION, not of the
      // record: only the caller knows whose corpus this is. Normalised to
      // {reason} or null right here, so the risk step reads one shape and a key
      // with no reason in it cannot become a silent forced stage — the door is
      // opened by a reason a person can read, never by the presence of an option.
      forceStage: forcedStageReason(opts.forceStage),
    },
  }
}

/**
 * The reason inside a forceStage option, or null when there is none. A non-string,
 * an empty string or whitespace is NOT a reason: a forced stage that could not say
 * why would be indistinguishable from a bug in the caller.
 */
function forcedStageReason(raw) {
  const reason = raw && typeof raw === 'object' && typeof raw.reason === 'string' ? raw.reason.trim() : ''
  return reason === '' ? null : { reason }
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
 *
 * EXPORTED because the corpus lint asks the same question about material that is
 * ALREADY on disk (this module screens material on its way in). Two copies of
 * these two shapes would drift the first time either side learned a third one.
 * The patterns are global (/g) for the scrubber's sake — a reader that only wants
 * a yes/no must build its own non-global copy, or lastIndex will make the answer
 * depend on call order.
 */
export const PERSONAL_PATTERNS = Object.freeze([
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
 *
 * A CALLER MAY CLOSE THE AUTOMATIC DOOR AND MAY NEVER OPEN IT. The forceStage
 * option is checked FIRST, before the door is even asked about — because what it
 * carries is true of the DESTINATION, not of the record, and the ladder only ever
 * looks at the record. There is no option with the opposite sign anywhere in this
 * module: the one class that may be written without a human is decided here and
 * nowhere else.
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

  // The approval path is resolved and recorded even here, on purpose: the trail
  // then says "this record was ENTITLED to the automatic door and did not get it",
  // which is a different fact from "this record was never entitled" — and the
  // difference is the whole reason a person would read the trace at all.
  if (state.opts.forceStage) {
    return stage(state, 'risk', {
      approval_path: approvalPath,
      reason: state.opts.forceStage.reason,
      forced: true,
    })
  }

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

/**
 * A record that may expire on its own: a retention window, or an explicit end
 * date. Delegated to schema-v2.mjs so the risk gate and the storage-class
 * resolver cannot grow two different ideas of "bounded in time" — the same
 * one-implementation rule that exported INTERPRETATION_MODES and hasEvidence.
 */
function hasRetentionWindow(record) {
  return hasLifetimeWindow(record)
}

// ── the placement gate (asked on BOTH write paths, before either writes) ─────

/**
 * placementDenial(state, targetDir) -> denial detail | null.
 *
 * The legality question — may THIS record be written into THIS directory — is
 * answered by schema-v2.mjs; this is only the call site. Fail-closed by the
 * threat model's rule: a subsystem that decides where something may sit refuses
 * rather than degrades. A denial carries the class, the deciding rule and the
 * destination the record should have gone to instead, so the refusal is
 * something a person can act on rather than a wall.
 */
function placementDenial(state, targetDir) {
  const denial = storagePlacementDenial(state.record, {
    targetDir,
    localDir: state.dirs.localDir ?? undefined,
  })
  if (!denial) return null
  return {
    reason: denial.reason,
    storage_class: denial.storageClass,
    storage_rule: denial.rule,
    target_dir: denial.targetDir,
    local_dir: denial.localDir,
    errors: [],
  }
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
 *
 * A successful write sets `state.persisted` and does NOT set `state.outcome`:
 * the corpus door is not the end of the sequence. Steps 9-12 run on this path
 * and step 12 declares the terminal outcome. Both failure paths (staged,
 * refused) stay terminal where they are decided.
 */
export function persist(state) {
  const record = state.record
  const target = join(state.dirs.corpusDir, `${String(record.id ?? '')}.md`)

  // Placement runs FIRST — before validation, before the never-clobber guard,
  // before any byte. Everything else in this function decides whether a record
  // is good enough to write; this decides whether it may be written HERE at all.
  const denied = placementDenial(state, state.dirs.corpusDir)
  if (denied) return reject(state, 'persist', denied)

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
  state.persisted = true
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

  // THE DRAFTS DIRECTORY IS A GIT-BACKED PATH TOO. Gating only the corpus door
  // would leave the boundary trivially open, because a restricted record never
  // reaches the corpus door in the first place: the approval ladder escalates it
  // and routes it here. So the placement question is asked on BOTH write paths.
  const denied = placementDenial(state, state.dirs.draftsDir)
  if (denied) return reject(state, step, { ...detail, ...denied })

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
  journal(state, {
    stage: step,
    outcome: 'staged-draft',
    id: record.id,
    path: target,
    draft,
    // A FORCED stage carries its reason into the journal too. The trace answers
    // the person holding the terminal; the journal answers everybody after them,
    // and "why did this one not go the ordinary way" must not require re-running
    // anything. Only the forced case adds it — the ordinary reasons are a
    // function of the class and are readable from the record itself.
    ...(detail?.forced === true ? { forced: true, reason: detail.reason } : {}),
  })
  return trace(state, step, 'staged', { ...detail, path: target, draft })
}

// ── step 9: index ───────────────────────────────────────────────────────────

/**
 * index(state) — a record nobody can find is not memory. Step 9 regenerates the
 * always-load index and the per-area catalogs through generator.mjs — the SAME
 * `buildIndex` / `buildAreaIndexes` path the build-index verb uses. Re-rendering
 * them here would create a second index grammar, and the first divergence
 * between the two would be invisible: both files would look plausible.
 *
 * FAIL-OPEN. The record is already on disk; an index that cannot be rebuilt is a
 * stale index, not a failed write. The step degrades with the reason in the
 * trace rather than unwinding a write that already succeeded.
 */
export function index(state) {
  const res = rebuildIndexes(state)
  if (res.error) {
    return trace(state, 'index', 'degraded', {
      reason: 'the index could not be rebuilt — the record is written, the index is stale',
      error: res.error,
    })
  }
  return trace(state, 'index', 'ok', { index: res.index, area_files: res.areaFiles })
}

/** The index write boundary. Returns {index, areaFiles, error} — never throws. */
function rebuildIndexes(state) {
  const corpusDir = state.dirs.corpusDir
  try {
    const args = { corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), ...buildAnchor(state) }
    const generated = buildIndex(args)
    const areas = buildAreaIndexes(args)
    const indexPath = join(corpusDir, INDEX_FILENAME)
    atomicWriteRaw(indexPath, generated)
    for (const a of areas) atomicWriteRaw(join(corpusDir, a.file), a.content)
    return { index: indexPath, areaFiles: areas.map((a) => a.file), error: null }
  } catch (err) {
    return { index: null, areaFiles: [], error: String(err?.message ?? err) }
  }
}

/**
 * The build anchor (commit + per-file dates) the generated index is stamped
 * with. INJECTED, exactly like the build-index verb's: with no runner the anchor
 * is the deterministic epoch, and the index is stamped honestly as unanchored
 * rather than carrying a hash nobody computed.
 */
function buildAnchor(state) {
  const execGit = state.opts.execGit
  if (typeof execGit !== 'function') return { commitHash: EPOCH_COMMIT, dateMap: {} }
  try {
    const dateMap = computeDateMap({ execGit })
    const commitHash = String(execGit(['rev-parse', '--short', 'HEAD']) ?? '').trim() || EPOCH_COMMIT
    return { commitHash, dateMap }
  } catch {
    return { commitHash: EPOCH_COMMIT, dateMap: {} }
  }
}

// ── step 10: measure ────────────────────────────────────────────────────────

/**
 * measure(state) — the HOOK POINT, and deliberately only that.
 *
 * Every persisted write leaves one `retrieval-trace` record in the journal: what
 * was written, when, and the shape of the walk that let it through. No metric is
 * computed here — measuring retrieval is the measurement track's work, and a
 * pipeline that scored itself would be marking its own homework. What this step
 * guarantees is that the data to measure LATER exists at all: a write with no
 * trace is a repudiable write.
 *
 * The record carries a shape, never content: step ids and outcomes, the record
 * id and its path. The claim itself stays where it belongs — in the record.
 */
export function measure(state) {
  const detail = {
    stage: 'measure',
    kind: RETRIEVAL_TRACE_KIND,
    record_id: typeof state.record.id === 'string' ? state.record.id : null,
    written_at: state.opts.now ?? new Date().toISOString(),
    path: state.path,
    trace_summary: state.trace.map((t) => `${t.step}:${t.outcome}`),
  }
  const written = journal(state, detail)
  return trace(state, 'measure', written ? 'ok' : 'degraded', {
    kind: RETRIEVAL_TRACE_KIND,
    record_id: detail.record_id,
  })
}

// ── step 11: consolidate ────────────────────────────────────────────────────

/**
 * proposeConsolidation(state) — step 11 of the sequence. (Named for what it does;
 * `consolidate` is the step NAME and also a module this file imports from.)
 *
 * When step 5 found a contradiction or a near-duplicate, this step writes a
 * PROPOSAL: a draft that names both records and the action a human might take.
 * It never merges, never promotes, never edits either record — the step has no
 * corpus write path at all, and that is the point. Auto-merge is the canon
 * anti-pattern: two beliefs quietly rewritten into one is a decision nobody
 * reviewed, made by the component least able to judge which one was right.
 *
 * Never clobbers: a proposal already on disk may carry a human's edit.
 */
export function proposeConsolidation(state) {
  const contradictions = Array.isArray(state.flags.contradictions) ? state.flags.contradictions : []
  const duplicates = Array.isArray(state.flags.duplicateClaims) ? state.flags.duplicateClaims : []
  if (!contradictions.length && !duplicates.length) {
    return trace(state, 'consolidate', 'ok', null)
  }

  const recordId = String(state.record.id ?? '')
  const paired = unique(
    [...contradictions.flatMap((c) => (Array.isArray(c?.files) ? c.files : [])), ...duplicates]
      .map(stemOf)
      .filter((s) => s !== '' && s !== recordId),
  ).sort()

  const actions = [
    ...(contradictions.length ? ['supersede-or-revoke-one-side'] : []),
    ...(duplicates.length ? ['merge-into-one-record'] : []),
  ]

  const id = `${CONSOLIDATION_ID_PREFIX}${recordId}`
  const target = join(state.dirs.draftsDir, `${id}.md`)
  const idError = validateId(id, target)
  if (idError) {
    return trace(state, 'consolidate', 'degraded', { reason: `cannot stage a proposal: ${idError}` })
  }

  let draft = 'proposed'
  if (existsSync(target)) {
    draft = 'proposal-exists'
  } else {
    const proposal = {
      id,
      schema_version: '2',
      status: 'draft',
      draft_kind: CONSOLIDATION_DRAFT_KIND,
      proposal_action: actions,
      proposal_records: [recordId, ...paired],
      proposed_at: state.opts.now ?? new Date().toISOString(),
    }
    const rendered = renderV2(proposal, consolidationBody(recordId, paired, actions, contradictions))
    if (rendered.error) {
      return trace(state, 'consolidate', 'degraded', { reason: `cannot stage a proposal — ${rendered.error}` })
    }
    atomicWriteRaw(target, rendered.text)
  }

  const detail = { path: target, draft, records: [recordId, ...paired], actions }
  journal(state, { stage: 'consolidate', outcome: 'proposed', ...detail })
  return trace(state, 'consolidate', 'proposed', detail)
}

/** The human-readable half of a proposal: what was found, and who decides. */
function consolidationBody(recordId, paired, actions, contradictions) {
  const lines = [
    '',
    '# Consolidation proposal',
    '',
    '**PROPOSAL ONLY. Nothing has been merged, promoted or rewritten.** The write',
    'pipeline found that a record it just wrote stands in tension with records the',
    'corpus already holds. Deciding which belief survives is a human act; no verb in',
    'this codebase applies a consolidation proposal on its own.',
    '',
    `- written record: \`${recordId}\``,
    ...paired.map((p) => `- already in the corpus: \`${p}\``),
    '',
    `Suggested action: ${actions.join(' · ')}`,
    '',
  ]
  for (const c of contradictions) {
    if (c?.reason) lines.push(`> ${String(c.reason)}`, '')
  }
  return lines.join('\n')
}

// ── step 12: lifecycle ──────────────────────────────────────────────────────

/**
 * lifecycle(state) — the last step, and the one that declares the outcome.
 *
 * It resolves the record's own lifecycle position and completes any supersession
 * the CALLER DECLARED. Completing a declared pointer is not inference and not a
 * merge: the record says `supersedes: X`, and leaving X without the matching
 * `superseded_by` would produce exactly the failure the corpus cannot survive —
 * a half-written chain in which a belief known to be replaced keeps loading as
 * current. Nothing is inferred here: a near-duplicate found by step 5 is a
 * proposal (step 11), never a transition.
 *
 * A transition invalidates the index step 9 just rebuilt, so the rebuild is
 * repeated after it. That is the honest ordering: the canon sequence is fixed,
 * and a step that changes the corpus must leave the index describing the corpus
 * as it now is.
 */
export function lifecycle(state) {
  const corpus = Array.isArray(state.corpus) ? state.corpus : []
  const known = new Set(corpus.map((n) => stemOf(n.file)))
  const declared = unique(asList(state.record.supersedes).map(stemOf)).filter((t) => known.has(t))

  const superseded = []
  const refused = []
  for (const targetId of declared) {
    const res = applyLifecycle({
      corpusDir: state.dirs.corpusDir,
      id: targetId,
      action: 'supersede',
      by: String(state.record.id ?? ''),
      now: state.opts.now,
      journalDir: state.dirs.journalDir,
      terminalId: state.opts.terminalId,
    })
    if (res.applied) superseded.push(targetId)
    else refused.push({ id: targetId, reason: res.refusal })
  }

  let reindexed = false
  if (superseded.length) {
    rebuildIndexes(state)
    reindexed = true
  }

  state.outcome = 'persisted-active'
  return trace(state, 'lifecycle', superseded.length ? 'transitioned' : 'ok', {
    status: state.record.status ?? null,
    superseded,
    refused,
    reindexed,
  })
}

// ── the lifecycle transitions (callable outside the walk) ───────────────────

/**
 * The five lifecycle actions. The first four TRANSITION a record — the bytes stay
 * on disk and what the system is willing to believe about them changes. The
 * fifth, `erase`, destroys: it is delegated wholesale to erase.mjs, so no code
 * path in THIS file removes a file, and a caller still reaches destruction only
 * by naming it.
 */
export const LIFECYCLE_ACTIONS = Object.freeze(['supersede', 'revoke', 'expire', 'archive', 'erase'])

/** action -> the status it writes. */
const LIFECYCLE_STATUS = Object.freeze({
  supersede: 'superseded',
  revoke: 'revoked',
  expire: 'expired',
  archive: 'archived',
})

/**
 * applyLifecycle({corpusDir, id, action, by, reason, now, journalDir, terminalId})
 *   -> {applied, action, id, status, changed, refusal}
 *
 * The lifecycle transitions as a callable boundary — used by step 12 and by any
 * verb that retires a record.
 *
 * SYMMETRY OR NOTHING. `supersede` writes BOTH ends of the chain: the retired
 * record gains `status: superseded` + `superseded_by` + `superseded_at`, and the
 * replacement gains `supersedes`. Both files are rendered and checked BEFORE
 * either is written, so a failure on the second one cannot leave the first
 * rewritten — the pair is prepared atomically even though two files can never be
 * renamed as one.
 *
 * THE GRAMMAR GETS THE LAST WORD. A record the shared serializer cannot re-emit
 * (the corpus lint's round-trip finding) is REFUSED here rather than rewritten
 * into something the emitter invented. A refusal changes nothing.
 *
 * v1 NOTES ARE REFUSED. The v1 grammar has no `status` field: a transition
 * written onto a v1 note would be dropped silently on the way out. Migrate it
 * first — a silent no-op is worse than a stated refusal.
 *
 * @returns {{applied:boolean, action:string, id:string, status?:string, changed:string[], refusal?:string}}
 */
export function applyLifecycle(input = {}) {
  const { corpusDir, id, action, by, reason, now, journalDir, terminalId } = input
  const base = { applied: false, action: String(action ?? ''), id: String(id ?? ''), changed: [] }

  if (!LIFECYCLE_ACTIONS.includes(action)) {
    return {
      ...base,
      refusal: `unknown lifecycle action "${String(action)}" — this module performs ${LIFECYCLE_ACTIONS.join(' · ')} and nothing else`,
    }
  }

  // THE DESTRUCTIVE PATH LEAVES THIS FILE IMMEDIATELY. It is handled before the
  // record is loaded from the corpus, because a this-machine-only record is not
  // IN the corpus: `loadRecord` would refuse it, and the one class of record that
  // most needs erasing would be the one class that could not be erased. The
  // result is returned in the shape every other action returns, extended with
  // what only a destructive operation has to report (the surfaces, the failures,
  // the dangling links it refused to rewrite, and the history exception).
  // `status` is present and null: an erased record has no status, because it has
  // no record.
  if (String(action) === 'erase') {
    const res = eraseRecord({ ...input, id: base.id })
    return { ...res, action: base.action, id: base.id, status: null }
  }

  const subject = loadRecord(corpusDir, id)
  if (subject.error) return { ...base, refusal: subject.error }

  const status = LIFECYCLE_STATUS[action]
  const pending = [] // [{path, frontmatter, body}] — rendered before anything is written

  if (action === 'supersede') {
    const successorId = String(by ?? '').trim()
    if (!successorId) {
      return { ...base, refusal: 'supersede requires "by" — the id of the record that replaces this one' }
    }
    if (successorId === base.id) {
      return { ...base, refusal: 'a record cannot supersede itself' }
    }
    const existing = String(subject.frontmatter.superseded_by ?? '').trim()
    if (existing && existing !== successorId) {
      return {
        ...base,
        refusal: `already superseded by "${existing}" — completing this pointer would break an existing chain`,
      }
    }
    const successor = loadRecord(corpusDir, successorId)
    if (successor.error) return { ...base, refusal: successor.error }

    pending.push({
      path: subject.path,
      frontmatter: {
        ...subject.frontmatter,
        status,
        superseded_by: successorId,
        superseded_at: dateOf(now),
      },
      body: subject.body,
    })
    pending.push({
      path: successor.path,
      frontmatter: {
        ...successor.frontmatter,
        supersedes: collapse(unique([...asList(successor.frontmatter.supersedes).map(stemOf), base.id])),
      },
      body: successor.body,
    })
  } else if (action === 'revoke') {
    if (!isNonEmpty(reason)) {
      return {
        ...base,
        refusal:
          'revoke requires a stated reason — a revocation nobody explained is indistinguishable from an accident, ' +
          'and the reason is journalled rather than written into the record (the schema has no free-text field for it)',
      }
    }
    pending.push({ path: subject.path, frontmatter: { ...subject.frontmatter, status }, body: subject.body })
  } else if (action === 'expire') {
    const until = String(subject.frontmatter.valid_until ?? '').trim()
    if (until === '') {
      return {
        ...base,
        refusal: 'expire requires valid_until on the record — a claim with no end date has not run out of anything',
      }
    }
    const today = dateOf(now)
    if (!(until < today)) {
      return {
        ...base,
        refusal: `valid_until ${until} has not passed as of ${today} — a claim is never expired early`,
      }
    }
    pending.push({ path: subject.path, frontmatter: { ...subject.frontmatter, status }, body: subject.body })
  } else {
    pending.push({ path: subject.path, frontmatter: { ...subject.frontmatter, status }, body: subject.body })
  }

  // Render EVERY file first: the grammar may refuse one of them, and a refusal
  // after a partial write would leave the pair asymmetric — the failure this
  // whole transition exists to prevent.
  const writes = []
  for (const p of pending) {
    const rendered = renderV2(p.frontmatter, p.body)
    if (rendered.error) return { ...base, refusal: rendered.error }
    writes.push({ path: p.path, text: rendered.text })
  }

  const changed = []
  for (const w of writes) {
    if (w.text === readIfPresent(w.path)) continue // nothing to say — nothing written
    atomicWriteRaw(w.path, w.text)
    changed.push(w.path)
  }

  try {
    appendEvent(
      {
        type: JOURNAL_EVENT_TYPE,
        scope: 'memory-corpus',
        detail: { stage: 'lifecycle', action: base.action, id: base.id, status, by: by ?? null, reason: reason ?? null, changed },
      },
      { terminalId: terminalId ?? DEFAULT_TERMINAL, journalDir: journalDir ?? undefined, now: now ?? undefined },
    )
  } catch {
    // fail-open: the transition happened; an unwritable journal degrades the
    // audit trail, it does not un-write the corpus.
  }

  return { ...base, applied: true, status, changed }
}

/**
 * Read one corpus record by id. Returns {path, frontmatter, body} or {error}.
 * A missing record, an unparseable one and a v1 note are all NAMED refusals —
 * this boundary never guesses what a caller meant.
 */
function loadRecord(corpusDir, id) {
  const recordId = String(id ?? '').trim()
  if (recordId === '') return { error: 'a lifecycle transition needs the id of the record it acts on' }
  const path = join(String(corpusDir ?? ''), `${recordId}.md`)
  if (!existsSync(path)) return { error: `no record "${recordId}" in the corpus (${path})` }

  let note
  try {
    note = parseNote(readFileSync(path, 'utf8'), { file: path })
  } catch (err) {
    return { error: `record "${recordId}" does not parse: ${String(err?.message ?? err)}` }
  }
  if (note.frontmatter == null) return { error: `record "${recordId}" has no frontmatter — it is not a record` }
  if (note.schemaVersion !== 2) {
    return {
      error:
        `record "${recordId}" is a schema-v1 note: the v1 grammar has no status field, so the transition would be ` +
        'written and then dropped on the way out — migrate the note to schema v2 first',
    }
  }
  return { path, frontmatter: note.frontmatter, body: note.body ?? '' }
}

/** The file's current text, or null when it is unreadable/absent. */
function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** A transition date: date-only UTC, the same shape the temporal fields carry. */
function dateOf(now) {
  const iso = isNonEmpty(now) ? String(now) : new Date().toISOString()
  return iso.slice(0, 10)
}

/** A one-element list is a scalar; the pointer field stays readable either way. */
function collapse(list) {
  return list.length === 1 ? list[0] : list
}

// ── the registry + the walk ─────────────────────────────────────────────────

/**
 * Every canon step name mapped to its implementation. A name with no
 * implementation would let the walk skip a gate silently. All twelve are built.
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
  index,
  measure,
  consolidate: proposeConsolidation,
  lifecycle,
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
 * @param {{corpusDir?:string, draftsDir?:string, journalDir?:string, localDir?:string,
 *          repoRoot?:string, terminalId?:string, now?:string, corpus?:Array,
 *          registry?:object, forceStage?:{reason:string}}} [opts]
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

// ── the apply door: the way OUT of drafts/ ──────────────────────────────────

/**
 * Strip the draft-only marker keys. Nothing in this list may reach the corpus:
 * a marker that survived the apply would read like an ordinary unknown field
 * and would quietly claim the record is still a draft.
 *
 * @param {object} frontmatter
 * @returns {object} a copy of the record without the markers
 */
export function stripDraftMarkers(frontmatter) {
  const out = { ...frontmatter }
  for (const key of DRAFT_MARKER_KEYS) delete out[key]
  return out
}

/**
 * appliedDraftPath(draftPath) — the CONSUMED-draft marker path. Its presence
 * beside a draft means that draft was already applied, and it is what makes a
 * second apply impossible rather than merely discouraged.
 */
export function appliedDraftPath(draftPath) {
  return String(draftPath).replace(/\.md$/, '.applied.md')
}

/**
 * confirmationRefusal({recordId, declaredSource, confirmFile, subject}) -> string|null
 *
 * THE PER-FILE CONFIRMATION MECHANIC — one implementation, used by every door
 * that moves a draft into the corpus (this module's `applyStagedDraft` and
 * migrate-v1-v2.mjs's `applyProposal`). A second copy would be the usual
 * failure: the day one side learned a new escape the other would still accept
 * it, and the weaker door is the one an attacker (or a slip) reaches for.
 *
 * Three questions, in this order:
 *   1. is the record id legal — letters, digits, dot, dash, underscore, no
 *      separators and no leading dot, so `join(corpusDir, id)` can only ever
 *      land INSIDE the corpus;
 *   2. is the declared source a plain corpus filename, for the same reason;
 *   3. does the confirmation NAME that source. Acceptance has to be typed, and
 *      it has to be typed per file: «accept all» must not be expressible.
 *
 * PURE — it decides, it never writes. A refusal is the message; null means the
 * confirmation holds.
 *
 * @param {{recordId?:string, declaredSource?:string, confirmFile?:string, subject?:string}} [args]
 * @returns {string|null}
 */
export function confirmationRefusal({ recordId, declaredSource, confirmFile, subject = 'proposal' } = {}) {
  const id = String(recordId ?? '').trim()
  if (!SAFE_ID_PATTERN.test(id)) {
    return (
      `id "${id}" is not a legal record id — letters, digits, dot, dash and underscore only, ` +
      'and it must address a file INSIDE the corpus'
    )
  }
  const source = String(declaredSource ?? '').trim()
  if (!SAFE_SOURCE_PATTERN.test(source)) {
    return (
      `draft_source "${source}" is not a plain corpus filename — a ${subject} may only address a note ` +
      'INSIDE the corpus directory'
    )
  }
  const confirmed = basename(String(confirmFile ?? '').trim())
  if (confirmed === '' || confirmed !== source) {
    return (
      `confirmation mismatch: this ${subject} declares source "${source}", the confirmation named ` +
      `"${confirmed || '(nothing)'}" — every apply names its own file`
    )
  }
  return null
}

/** Which door owns a draft this one will not take — named, so a refusal points somewhere. */
function draftKindRefusal(kind) {
  if (kind === CONSOLIDATION_DRAFT_KIND) {
    return (
      `draft_kind "${kind}": a consolidation proposal is a QUESTION about two beliefs that already exist, ` +
      'not a staged record. No verb in this codebase applies one — deciding which belief survives is a human act'
    )
  }
  return `the draft is not a staged pipeline record (draft_kind "${kind || '(none)'}" ≠ "${PIPELINE_DRAFT_KIND}")`
}

/** The reason the last executed step gave for stopping the walk. */
function lastRefusalReason(state) {
  const last = state.trace[state.trace.length - 1]
  return last?.detail?.reason ? `${last.step}: ${last.detail.reason}` : null
}

/**
 * applyStagedDraft({draftPath, corpusDir, confirmFile, …}) -> result
 *
 * THE DOOR OUT OF drafts/. Step 7 stages a record for a reason — a standing
 * rule, a decision, an owner preference is not written without review — and
 * until this function existed that was the end of the road: a draft the owner
 * had confirmed had no path into the corpus at all, because the migration
 * engine's door honestly refuses anything that is not a v2-migration proposal.
 * A pipeline that can only ever stage is a pipeline whose review step is a
 * dead letter.
 *
 * WHAT THE CONFIRMATION REPLACES, AND WHAT IT DOES NOT. The named per-file
 * confirmation stands in for steps 6 (evidence) and 7 (risk) — those two are
 * exactly what routed the record here, and re-running them at the door would
 * refuse it on the ground the human has just answered. It stands in for nothing
 * else: a draft is a file a person may have edited, so steps 2 (classify), 3
 * (redact), 4 (extract) and 5 (compare) are re-asked at the door, against the
 * corpus AS IT IS NOW. REDACTION PRECEDES ALL PERSISTENCE is not a rule about
 * where a record came from.
 *
 * `validateRecord` runs BEFORE any of it: an invalid draft is refused with the
 * validation reasons and nothing anywhere is touched. Once the record is
 * written the walk continues through steps 9-12 exactly as `runPipeline` walks
 * them — the same index rebuild, the same retrieval trace, the same
 * proposes-never-merges consolidation, the same lifecycle completion — because
 * a record that entered by this door is not a lesser record.
 *
 * THE ONLY THING THE DOOR REWRITES is `status: draft -> active`: that status is
 * the mark of the staging, and applying is the act that lifts it. A truth mode
 * the evidence step downgraded stays downgraded — a confirmation is not
 * provenance, and nobody re-earned it.
 *
 * Refusal paths write nothing: every gate is asked before the corpus door is
 * opened, so there is no half-applied state to unwind. Success consumes the
 * draft with the `.applied` marker — the same convention the migration door
 * uses — so a proposal is applied exactly once.
 *
 * THE STAMP THE DOOR MAY ADD. A re-derivable claim must carry its check, and a draft
 * written inside a worker's copy cannot carry the check that names the epoch: the product
 * version and the commit are known to whoever ACCEPTS the work, never to whoever wrote the
 * note in a copy cut for one task. So the caller may hand in `fingerprint {product_version}`,
 * and it is written into the record ONLY when the record brought neither a fingerprint nor a
 * verification of its own — a record that already states how it is checked is never rewritten
 * by this door. The stamp is a version string, never the author's data, and it leaves a trace
 * step, so a reader can see the record was completed here rather than authored here.
 *
 * @param {{draftPath:string, corpusDir:string, confirmFile:string, draftsDir?:string,
 *          fingerprint?:{product_version:string},
 *          journalDir?:string, terminalId?:string, now?:string, execGit?:Function,
 *          registry?:object, localDir?:string, repoRoot?:string}} input
 * @returns {{applied:boolean, outcome:string, target_path:string|null, reason:string,
 *            errors:string[], trace:Array, record:object|null, consumed?:boolean}}
 */
export function applyStagedDraft(input = {}) {
  const { draftPath, corpusDir, confirmFile } = input
  if (typeof draftPath !== 'string' || draftPath.trim() === '') {
    throw new Error('applyStagedDraft: draftPath is required (the staged draft to apply)')
  }
  if (typeof corpusDir !== 'string' || corpusDir.trim() === '') {
    throw new Error('applyStagedDraft: corpusDir is required (the .claude/memory directory)')
  }

  // The state exists BEFORE the gates, for the same reason step 1 runs before
  // every other step: an apply the system refuses must still be a thing the
  // system remembers being asked. The drafts directory defaults to the draft's
  // OWN directory, so a step-11 proposal lands beside the draft it came from.
  const state = createPipelineState(
    {},
    { ...input, corpusDir, draftsDir: input.draftsDir ?? dirname(draftPath) },
  )
  const draftFile = basename(draftPath)
  const refuse = (reason, errors = []) => {
    journal(state, { stage: 'apply', outcome: 'refused', draft: draftFile, reason })
    return { applied: false, outcome: 'refused', target_path: null, reason, errors, trace: state.trace, record: null }
  }
  journal(state, { stage: 'apply', outcome: 'requested', draft: draftFile })

  if (!existsSync(draftPath)) {
    return refuse(
      existsSync(appliedDraftPath(draftPath))
        ? `the draft ${draftFile} was already applied (consumed marker present) — a staged record is applied once`
        : `no draft at ${draftPath}`,
    )
  }

  let parsed
  try {
    parsed = parseNote(readFileSync(draftPath, 'utf8'), { file: draftFile })
  } catch (err) {
    return refuse(`the draft cannot be parsed: ${String(err?.message ?? err)}`)
  }
  if (parsed.frontmatter == null || parsed.schemaVersion !== 2) {
    return refuse('the draft is not a schema-v2 record')
  }

  const fm = parsed.frontmatter
  const kind = String(fm.draft_kind ?? '').trim()
  if (kind !== PIPELINE_DRAFT_KIND) return refuse(draftKindRefusal(kind))

  // A staged record names its OWN destination: the id is the corpus filename by
  // the id law, so that is the file the confirmation has to name. There is no
  // second source to declare — unlike a migration proposal, nothing existed
  // before this draft.
  const recordId = String(fm.id ?? '').trim()
  const confirmRefusal = confirmationRefusal({
    recordId,
    declaredSource: `${recordId}.md`,
    confirmFile,
    subject: 'staged record',
  })
  if (confirmRefusal) return refuse(confirmRefusal)

  const record = stripDraftMarkers(fm)
  if (String(record.status ?? '').trim() === 'draft') record.status = 'active'

  const stampVersion =
    input.fingerprint && typeof input.fingerprint.product_version === 'string'
      ? input.fingerprint.product_version.trim()
      : ''
  if (stampVersion !== '' && record.fingerprint == null && record.verification == null) {
    record.fingerprint = { product_version: stampVersion }
    trace(state, 'apply', 'ok', {
      reason: 'fingerprint stamped by apply — the epoch is known to the acceptance, not to the draft',
      product_version: stampVersion,
      id: recordId,
    })
  }

  const validation = validateRecord(record)
  if (validation.errors.length) {
    return refuse(
      `the staged record does not validate — ${validation.errors.length} error(s): ${validation.errors[0]}`,
      validation.errors,
    )
  }

  // Asked HERE as well as inside `persist`, and deliberately: persist STAGES a
  // record it will not write, and staging is the one thing this door must never
  // do — it would write a second draft on a refusal path.
  const target = join(state.dirs.corpusDir, `${recordId}.md`)
  if (existsSync(target)) {
    return refuse(`a record already holds this identity at ${target} — the door never clobbers a record it did not write`)
  }

  state.record = deepCopy(record)
  state.body = typeof parsed.body === 'string' ? parsed.body : ''
  state.corpus = readCorpus(state.dirs.corpusDir)

  for (const step of [classify, redact, extract, compare]) {
    step(state)
    if (state.outcome !== null) return refuse(lastRefusalReason(state) ?? 'the record was refused before the corpus door')
  }

  persist(state)
  if (!state.persisted) return refuse(lastRefusalReason(state) ?? 'the corpus door refused the record')

  for (const step of [index, measure, proposeConsolidation, lifecycle]) step(state)

  // Consume the draft LAST: a marker written before the record was on disk would
  // close the door on a write that had not happened. A rename that fails leaves
  // the draft in place and the record written — the next apply refuses on the
  // occupied identity, which is a stated refusal rather than a silent double
  // write.
  let consumed = true
  try {
    renameSync(draftPath, appliedDraftPath(draftPath))
  } catch {
    consumed = false
  }

  journal(state, {
    stage: 'apply',
    outcome: 'applied',
    id: recordId,
    path: state.path,
    draft: draftFile,
    consumed,
  })

  return {
    applied: true,
    outcome: state.outcome,
    target_path: state.path,
    reason: consumed
      ? `applied from ${draftFile}, confirmed as ${recordId}.md — the draft is consumed`
      : `applied from ${draftFile}, confirmed as ${recordId}.md — the draft could NOT be marked consumed, remove ${draftFile} by hand`,
    errors: [],
    trace: state.trace,
    record: state.record,
    consumed,
  }
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
    if (!name.endsWith('.md') || STRUCTURAL_FILES.has(name) || GENERATED_INDEX_RE.test(name)) continue
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
