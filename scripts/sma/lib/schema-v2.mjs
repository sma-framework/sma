/**
 * schema-v2.mjs — the memory RECORD schema vocabulary (Memory Model 1.0).
 *
 * NAME-COLLISION GUARD — read before importing anything from here. This module
 * defines what a MEMORY RECORD may say and what it must carry. Three existing
 * modules use the same English words for entirely different subjects and must
 * NOT be reused, imported, or extended for record validation:
 *   - evidence.mjs    — burden-of-proof records for RISKY OPS (force-push, allowlist edits);
 *   - fingerprint.mjs — terminal/session coordination identity;
 *   - claims.mjs      — the slot gate (who holds which work scope).
 * Here, `evidence` is what would re-verify a claim, `fingerprint` is the state
 * of the world a claim describes, and a `claim` is the one durable sentence a
 * record carries. Same words, different universes.
 *
 * Layering: frontmatter.mjs decides SHAPE (grammar) and never enum legality;
 * this module decides LEGALITY and never parses text. The dependency runs one
 * way only — schema-v2.mjs imports V2_KEY_ORDER from frontmatter.mjs, never the
 * reverse (no cycles).
 *
 * Exports (consumed by the corpus lint, the migration and the write pipeline):
 *   - MEMORY_TYPES · TRUTH_MODES · SENSITIVITY_CLASSES · AUTHORITY_LEVELS ·
 *     STATUS_VALUES · RISK_LEVELS · CONTEXT_PRIORITIES — frozen closed vocabularies
 *   - validateRecord(frontmatter, {migratedFromV1}) -> {errors, warnings}
 *   - validateFingerprint(fingerprint) -> string[]
 *   - validateId(id, filePath) -> string|null
 *   - PRIVATE_FACET_PATTERN · isPrivateFacet(value)
 *   - APPROVAL_PATHS · resolveApprovalPath({memory_type, truth_mode, sensitivity, risk})
 *   - GRACE_HORIZON
 *
 * Node built-ins only. Every function here is PURE: no fs, no clock, no network.
 * Expiry ("is this valid_until in the past?") is a LINT concern precisely
 * because it needs a clock; this module must stay replayable and testable.
 */

import { V2_KEY_ORDER } from './frontmatter.mjs'

/**
 * What kind of knowledge the record carries (docs/MEMORY-MODEL.md §2).
 * Hard-coded rather than registry-driven: unlike the retrieval areas in TAGS.md,
 * these values are design-locked and widening them is a schema decision.
 */
export const MEMORY_TYPES = Object.freeze([
  'working',
  'semantic',
  'episodic',
  'procedural',
  'prospective',
  'normative',
  'preference',
])

/** The epistemic standing of the claim (docs/MEMORY-MODEL.md §3). */
export const TRUTH_MODES = Object.freeze([
  'observed',
  'inferred',
  'factual',
  'hypothesis',
  'decision',
  'normative',
])

/**
 * Which storage class may hold the record (docs/MEMORY-MODEL.md §7).
 * `encrypted-required` states the REQUIREMENT, not an implemented cipher: the
 * lint refuses to let such a record sit in a git-backed class.
 */
export const SENSITIVITY_CLASSES = Object.freeze([
  'public',
  'internal',
  'sensitive',
  'encrypted-required',
])

/**
 * Who stands behind an interpretation. `owner-instruction` exists so a verbatim
 * quote of the owner stops being the only way to express authority — provenance
 * smuggled into prose is exactly what this enum retires.
 */
export const AUTHORITY_LEVELS = Object.freeze([
  'owner-instruction',
  'external-review',
  'self-observed',
  'inferred',
])

/**
 * Lifecycle states (docs/MEMORY-MODEL.md §6). `draft` is last for ordering
 * stability, not by importance: it is the state an interpretation without
 * provenance falls back to instead of masquerading as established knowledge.
 */
export const STATUS_VALUES = Object.freeze([
  'active',
  'superseded',
  'revoked',
  'expired',
  'archived',
  'draft',
])

/** What approval acting on the record requires (docs/MEMORY-MODEL.md §8). */
export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical'])

/** Load always, or only when asked for (docs/MEMORY-MODEL.md §8). */
export const CONTEXT_PRIORITIES = Object.freeze(['always', 'on-demand'])

/**
 * Installation-private facet shape: a phase-numbered value such as `phase:8` or
 * `phase:49.5`. House phase numbers are meaningless outside the installation
 * that minted them, so the lint forbids them in records published in a
 * public/preset class — the same mechanic as the release leak scan.
 *
 * Deliberately NOT global: a /g RegExp carries lastIndex between .test() calls
 * and would make membership checks order-dependent.
 */
export const PRIVATE_FACET_PATTERN = /^phase:\d+(?:\.\d+)*$/

/**
 * isPrivateFacet(value) — true when a facet value is installation-private.
 * Tolerant of non-strings: callers sweep heterogeneous arrays (applies_to,
 * retrieval.areas) and a malformed entry is the field validator's problem.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPrivateFacet(value) {
  return typeof value === 'string' && PRIVATE_FACET_PATTERN.test(value.trim())
}

/**
 * validateId(id, filePath) — the id law: `id` MUST equal the file's name
 * without its extension, so a record's identity survives a move, a copy, or a
 * grep. Episode files under episodes/ follow the same rule; the directory is
 * irrelevant, only the stem counts.
 *
 * @param {unknown} id
 * @param {string} filePath
 * @returns {string|null} an error message, or null when the law holds
 */
export function validateId(id, filePath) {
  if (typeof id !== 'string' || !id.trim()) {
    return `id: missing or not a string in ${filePath} — the id law requires id === the filename stem`
  }
  const stem = fileStem(filePath)
  if (id !== stem) {
    return `id: "${id}" does not match the filename stem "${stem}" (${filePath}) — the id law requires id === the filename stem`
  }
  return null
}

/** Last path segment minus one trailing extension; both separators accepted. */
function fileStem(filePath) {
  const segments = String(filePath ?? '').split(/[\\/]/)
  const base = segments[segments.length - 1] ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** Fields every schema-v2 record must carry, whatever else it says. */
const REQUIRED_FIELDS = Object.freeze([
  'id',
  'schema_version',
  'status',
  'memory_type',
  'truth_mode',
  'claim',
  'language',
  'sensitivity',
])

/** Truth modes that are machine-rederivable: the record must carry its check. */
const FACT_MODES = Object.freeze(['observed', 'factual'])

/** Truth modes that are authored judgment: the record must carry its provenance. */
const INTERPRETATION_MODES = Object.freeze(['inferred', 'hypothesis', 'decision', 'normative'])

/** The honest "nothing recorded" value — legal, but it caps a record at draft. */
const NO_EVIDENCE = 'none-recorded'

/**
 * validateRecord(frontmatter, {migratedFromV1}) -> {errors, warnings}
 *
 * The legality pass over a parsed v2 record. Two tiers, by provenance:
 *   - STRUCTURE (required fields, one-claim law, closed vocabularies, fingerprint
 *     shape, external-artifact freshness) is always an ERROR — a record that
 *     breaks it is not a v2 record at all;
 *   - DISCIPLINE (fact carries its check, interpretation carries its provenance)
 *     is an ERROR for a record authored as v2 and a WARNING for one migrated from
 *     v1, which gets a grace period to grow the missing fields rather than being
 *     locked out of the corpus it already lives in.
 * Either signal engages the grace: the caller's `migratedFromV1` option or the
 * record's own `migrated_from: v1` field.
 *
 * PURE by construction — no fs, no clock. "Is this valid_until in the past?" is
 * a lint question because it needs today's date; everything here is replayable.
 *
 * @param {object} frontmatter — a parsed v2 frontmatter object (parseNote output)
 * @param {{migratedFromV1?: boolean}} [opts]
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateRecord(frontmatter, opts = {}) {
  const errors = []
  const warnings = []

  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    errors.push('record: expected a parsed v2 frontmatter object')
    return { errors, warnings }
  }

  const record = frontmatter
  const migrated = opts.migratedFromV1 === true || String(record.migrated_from ?? '').trim() === 'v1'
  /** A discipline finding: error for a native v2 record, warning under the migration grace. */
  const discipline = (message) => (migrated ? warnings : errors).push(message)

  // ── Structure: required fields ────────────────────────────────────────────
  for (const field of REQUIRED_FIELDS) {
    if (!isPresent(record[field])) {
      errors.push(`${field}: required — every schema-v2 record must carry it`)
    }
  }

  if (isPresent(record.schema_version) && Number(record.schema_version) !== 2) {
    errors.push(`schema_version: must be 2 for a schema-v2 record (got "${record.schema_version}")`)
  }

  // One durable claim per record: a list of claims is several records.
  if (isPresent(record.claim) && typeof record.claim !== 'string') {
    errors.push('claim: must be a single string — one durable claim per record')
  }

  // ── Structure: closed vocabularies ────────────────────────────────────────
  checkEnum(errors, record, 'memory_type', MEMORY_TYPES)
  checkEnum(errors, record, 'truth_mode', TRUTH_MODES)
  checkEnum(errors, record, 'status', STATUS_VALUES)
  checkEnum(errors, record, 'sensitivity', SENSITIVITY_CLASSES)
  checkEnum(errors, record, 'risk', RISK_LEVELS)
  checkEnum(errors, record, 'context_priority', CONTEXT_PRIORITIES)

  const source = isPlainObject(record.source) ? record.source : null
  if (source && isPresent(source.authority) && !AUTHORITY_LEVELS.includes(source.authority)) {
    errors.push(
      `source.authority: "${source.authority}" is outside the closed vocabulary (${AUTHORITY_LEVELS.join(' · ')})`,
    )
  }

  // ── Structure: the composite fingerprint ──────────────────────────────────
  if (isPresent(record.fingerprint)) errors.push(...validateFingerprint(record.fingerprint))

  // ── Structure: claims about external artifacts need a horizon ─────────────
  if (!isPresent(record.valid_until) && collectRefs(record).some(isUrlRef)) {
    errors.push(
      'valid_until: required when a source or evidence ref points at an external artifact (URL) — an outside artifact moves without telling us',
    )
  }

  // ── Structure: the field universe (unknown keys survive, but are reported) ─
  for (const key of Object.keys(record)) {
    if (!V2_KEY_ORDER.includes(key)) {
      warnings.push(`${key}: not part of the schema-v2 field universe — kept as-is, but nothing validates it`)
    }
  }

  // ── Discipline: FACT carries its check ────────────────────────────────────
  const truthMode = record.truth_mode
  if (FACT_MODES.includes(truthMode) && !isPresent(record.fingerprint) && !isPresent(record.verification)) {
    discipline(
      `truth_mode: a "${truthMode}" claim is machine-rederivable and must carry verification and/or fingerprint — otherwise it goes stale in silence`,
    )
  }

  // ── Discipline: INTERPRETATION carries its provenance ─────────────────────
  if (INTERPRETATION_MODES.includes(truthMode)) {
    if (!source || !isPresent(source.authority)) {
      discipline(
        `source.authority: a "${truthMode}" claim is authored judgment and must name the authority behind it (${AUTHORITY_LEVELS.join(' · ')})`,
      )
    }
    if (record.status === 'active' && !hasEvidence(record)) {
      discipline(
        `evidence: an active "${truthMode}" claim must carry evidence — without it the record belongs in status draft`,
      )
    }
  }

  return { errors, warnings }
}

/**
 * validateFingerprint(fingerprint) -> string[]
 *
 * The composite stamp: a human-readable product version (which epoch of the
 * product the claim describes) plus, when the claim is bound to files, the paths
 * and a hash over them. A hash without its paths cannot be recomputed, so it
 * cannot detect drift — that combination is rejected rather than trusted.
 *
 * @param {unknown} fingerprint
 * @returns {string[]} error messages (empty when the shape holds)
 */
export function validateFingerprint(fingerprint) {
  const errors = []
  if (!isPlainObject(fingerprint)) {
    return ['fingerprint: must be a block with product_version and optional tree_paths/tree_hash']
  }
  if (typeof fingerprint.product_version !== 'string' || !fingerprint.product_version.trim()) {
    errors.push('fingerprint.product_version: required whenever a fingerprint is present — it names the epoch the claim describes')
  }
  const paths = fingerprint.tree_paths
  if (isPresent(paths) && (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && p.trim()))) {
    errors.push('fingerprint.tree_paths: must be an array of path strings')
  }
  if (isPresent(fingerprint.tree_hash) && !isPresent(paths)) {
    errors.push('fingerprint.tree_hash: requires tree_paths — a hash with no paths cannot be recomputed, so it can never prove drift')
  }
  return errors
}

/** Present = not null/undefined, not blank string, not empty array/object. */
function isPresent(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Enum membership for an optional field: absence is someone else's rule. */
function checkEnum(errors, record, field, registry) {
  const value = record[field]
  if (!isPresent(value)) return
  if (!registry.includes(value)) {
    errors.push(`${field}: "${value}" is outside the closed vocabulary (${registry.join(' · ')})`)
  }
}

/** Every ref the record points at, from source.refs and evidence[]. */
function collectRefs(record) {
  const refs = []
  const source = isPlainObject(record.source) ? record.source : null
  if (source && Array.isArray(source.refs)) refs.push(...source.refs)
  if (Array.isArray(record.evidence)) {
    for (const item of record.evidence) {
      if (typeof item === 'string') refs.push(item)
      else if (isPlainObject(item) && typeof item.ref === 'string') refs.push(item.ref)
    }
  }
  return refs.filter((ref) => typeof ref === 'string')
}

function isUrlRef(ref) {
  return /^https?:\/\//i.test(ref.trim())
}

/**
 * The approval a record needs before it may enter the reviewed corpus, ordered
 * from the lightest to the strictest. Frozen: a new path is a policy decision.
 */
export const APPROVAL_PATHS = Object.freeze([
  'auto-ttl',
  'auto-draft',
  'evidence-review',
  'human-approval',
  'owner-versioned',
  'versioned-replay',
  'governed-human-only',
])

/**
 * The deadline by which a record migrated from v1 must have grown the fields its
 * discipline requires — after it, the warning grace ends and the findings become
 * errors. Deliberately a named horizon rather than a date: the calendar meaning
 * belongs to whoever runs the installation, not to the schema.
 */
export const GRACE_HORIZON = 'measurement-cycle-close'

/**
 * resolveApprovalPath({memory_type, truth_mode, sensitivity, risk}) -> path
 *
 * The risk-based approval ladder as a pure, deterministic function. Precedence:
 *   1. escalation — a sensitive/encrypted-required class or a critical risk
 *      overrides every type-based default;
 *   2. fail-closed — any input missing or outside its closed vocabulary yields
 *      the strictest path, because a record whose class cannot be determined is
 *      treated as the most restrictive plausible class;
 *   3. the mapped classes, strictest first: owner preference, decision policy,
 *      reflex-grade rule, candidate lesson, procedural recommendation, low-risk
 *      observation;
 *   4. anything well-formed but unmapped gets `evidence-review` — a human or an
 *      evidence threshold decides. It is never one of the automatic paths: a gap
 *      in the table must not become a permission.
 *
 * @param {{memory_type?:string, truth_mode?:string, sensitivity?:string, risk?:string}} [record]
 * @returns {string} one of APPROVAL_PATHS
 */
export function resolveApprovalPath(record) {
  if (!isPlainObject(record)) return 'governed-human-only'
  const { memory_type: memoryType, truth_mode: truthMode, sensitivity, risk } = record

  // 1. Escalation — checked BEFORE the vocabulary gate so a known-dangerous
  //    class still escalates even if some other field is malformed.
  if (sensitivity === 'sensitive' || sensitivity === 'encrypted-required') return 'governed-human-only'
  if (risk === 'critical') return 'governed-human-only'

  // 2. Fail closed on anything the ladder cannot read.
  if (
    !MEMORY_TYPES.includes(memoryType) ||
    !TRUTH_MODES.includes(truthMode) ||
    !SENSITIVITY_CLASSES.includes(sensitivity) ||
    !RISK_LEVELS.includes(risk)
  ) {
    return 'governed-human-only'
  }

  // 3. The mapped classes.
  if (memoryType === 'preference') return 'owner-versioned'
  if (truthMode === 'decision') return 'versioned-replay'
  if (memoryType === 'normative' || truthMode === 'normative') return 'human-approval'
  if (
    (memoryType === 'episodic' || memoryType === 'procedural') &&
    (truthMode === 'hypothesis' || truthMode === 'inferred')
  ) {
    return 'auto-draft'
  }
  if (memoryType === 'procedural') return 'evidence-review'
  if (memoryType === 'working' && truthMode === 'observed' && risk === 'low') return 'auto-ttl'

  // 4. Well-formed but unmapped: review, never an automatic path.
  return 'evidence-review'
}

/** Evidence that would actually re-verify something — none-recorded is honest, not evidence. */
function hasEvidence(record) {
  const evidence = record.evidence
  if (typeof evidence === 'string') return evidence.trim() !== '' && evidence.trim() !== NO_EVIDENCE
  if (!Array.isArray(evidence)) return false
  return evidence.some((item) =>
    typeof item === 'string'
      ? item.trim() !== '' && item.trim() !== NO_EVIDENCE
      : isPlainObject(item) && isPresent(item.ref) && String(item.ref).trim() !== NO_EVIDENCE,
  )
}
