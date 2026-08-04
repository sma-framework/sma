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
 *   - LINK_TYPES · checkLinks(record) -> string[] — the closed typed-edge vocabulary
 *   - PRIVATE_FACET_PATTERN · isPrivateFacet(value)
 *   - APPROVAL_PATHS · resolveApprovalPath({memory_type, truth_mode, sensitivity, risk})
 *   - STORAGE_CLASSES · resolveStorageClass(record, {now}) · hasLifetimeWindow(record) ·
 *     storagePlacementDenial(record, {targetDir, localDir}) — where a record may sit
 *   - GRACE_HORIZON
 *
 * Node built-ins only. Every function here is PURE: no fs, no clock, no network.
 * Expiry ("is this valid_until in the past?") is a LINT concern precisely
 * because it needs a clock; this module must stay replayable and testable.
 * `resolveStorageClass` takes an OPTIONAL `now` and never reaches for one:
 * nothing here calls Date.now(), and an absent clock reports the lifetime window
 * as `unknown` rather than guessing. The clock never decides a class.
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
 * The typed-edge vocabulary (docs/MEMORY-MODEL.md §10), verbatim and in the
 * doc's order. An edge is a `{type, ref}` pair inside a record's `links` array.
 *
 * Closed on purpose. The grammar (frontmatter.mjs) has always enforced the SHAPE
 * of `links`; until this enum existed nothing enforced the NAMES, so the field
 * accepted any spelling and every later query over it inherited that doubt.
 *
 * `superseded_by` is deliberately NOT a member: §10 lists eleven names and the
 * back-pointer is not among them. The supersession pair lives in the TOP-LEVEL
 * `supersedes`/`superseded_by` fields (§5), written as a pair by the write
 * pipeline's applyLifecycle — it is not an edge anyone writes into `links`.
 */
export const LINK_TYPES = Object.freeze([
  'derived_from',
  'supports',
  'contradicts',
  'supersedes',
  'caused_by',
  'applies_to',
  'exception_to',
  'requires',
  'verified_by',
  'owned_by',
  'part_of',
])

/**
 * Installation-private facet shape: a phase-numbered value such as `phase:8` or
 * `phase:12.3`. Phase numbers are meaningless outside the installation
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

/**
 * Truth modes that are authored judgment: the record must carry its provenance.
 * EXPORTED because the write pipeline gates on exactly this set (its step 6
 * refuses to let a provenance-free judgment become active memory) — a second
 * list of interpretation modes in another module is precisely the drift this
 * vocabulary module exists to prevent.
 */
export const INTERPRETATION_MODES = Object.freeze(['inferred', 'hypothesis', 'decision', 'normative'])

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

  // ── Structure: the typed-edge vocabulary ──────────────────────────────────
  errors.push(...checkLinks(record))

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

/**
 * checkLinks(record) -> string[]
 *
 * The legality pass over a record's typed edges. Absence is legal — a record
 * that claims no edges claims nothing false. Malformation is not: an entry whose
 * `type` is outside LINK_TYPES, or whose `ref` is missing or not a string, is
 * refused by NAME so the finding says which value offended.
 *
 * Fail-closed, in the sense the threat model gives the word: this decides what
 * may be believed about the graph, so an edge it cannot read is refused rather
 * than skipped. Every bad entry is reported, not just the first — a validator
 * that stops at the first finding teaches its user to fix errors one per run.
 *
 * PURE: no fs, no clock, and the record it judges is never mutated.
 *
 * @param {unknown} record — a parsed v2 frontmatter object
 * @returns {string[]} error messages (empty when every edge is legal)
 */
export function checkLinks(record) {
  if (!isPlainObject(record)) return ['links: expected a parsed v2 record object']

  const links = record.links
  if (links === null || links === undefined) return []
  if (!Array.isArray(links)) {
    return ['links: must be an array of {type, ref} entries — a single entry is an array of one']
  }

  const errors = []
  links.forEach((entry, i) => {
    if (!isPlainObject(entry)) {
      errors.push(`links[${i}]: must be a {type, ref} entry — an edge is a typed pair, never a bare string`)
      return
    }
    const { type, ref } = entry
    if (typeof type !== 'string' || !type.trim()) {
      errors.push(`links[${i}].type: required — every edge must name its type (${LINK_TYPES.join(' · ')})`)
    } else if (!LINK_TYPES.includes(type)) {
      errors.push(`links[${i}].type: "${type}" is outside the closed vocabulary (${LINK_TYPES.join(' · ')})`)
    }
    if (typeof ref !== 'string' || !ref.trim()) {
      errors.push(`links[${i}].ref: required and must be a non-empty string — an edge with no target points nowhere`)
    }
  })
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

// ── storage classes: who will see this record ───────────────────────────────

/**
 * The three storage classes, named by the one question a person can answer
 * without a manual: WHO WILL SEE THIS. Ordered lightest to strictest, exactly
 * like APPROVAL_PATHS — "the strictest rule wins" is the later member winning.
 *
 *   'shared'            — «Общее»: lives in the project's git, travels with the
 *                         team and with the repository. The default, and where
 *                         lessons, decisions and rules belong.
 *   'ephemeral'         — «Временное»: goes away by its own deadline. Task
 *                         scratch, the observations of a single run.
 *   'this-machine-only' — «Только на этой машине»: never enters git at all.
 *                         Tokens, private notes, a client's name.
 *
 * THREE, NOT FIVE, and the count is load-bearing. The canon's regulated-data
 * class — together with any separate breakdown of medical versus personal data —
 * is removed from this product by a direct product decision: there is ONE axis
 * here, who sees it. The canon's private-git class is removed too, because for a
 * user that is a private repository rather than a distinct mechanism, and a new
 * entity there only confuses. Neither discard touches the write-time credential
 * scan: that is about a password never reaching the text at all, not about
 * categories of data, and it stays.
 *
 * THE MAPPING, WRITTEN DOWN. The same table is in docs/MEMORY-THREAT-MODEL.md
 * §2.1; if the two ever disagree, this module is right and the document is a bug.
 *
 *   sensitivity                        → storage class      why
 *   ─────────────────────────────────────────────────────────────────────────
 *   (none declared)                    → shared             nothing says otherwise
 *   public                             → shared             everyone may see it
 *   internal                           → shared             the team may; git is the team
 *   sensitive                          → this-machine-only  not where an export can read it
 *   encrypted-required                 → this-machine-only  must not sit in a git-backed class at all
 *   any of the above + a lifetime      → ephemeral          …unless the value is restricted,
 *   window (retention / valid_until)                        in which case the strictest wins
 *   anything else                      → REFUSED            an unreadable label is not a permit
 *
 * The ephemeral class is DERIVED FROM THE LIFETIME FIELDS and never from a fifth
 * `sensitivity` value. "How long may this live?" and "who may see it?" are
 * independent questions; folding them into one field makes both unanswerable.
 * docs/MEMORY-THREAT-MODEL.md §2.1 reasoned that out and this module does not
 * relitigate it. No new frontmatter field is introduced either: all three classes
 * are derived from fields the schema already has, so nobody has to learn one.
 */
export const STORAGE_CLASSES = Object.freeze(['shared', 'ephemeral', 'this-machine-only'])

/** The two `sensitivity` values that may never sit in a git-backed class. */
const RESTRICTED_SENSITIVITY = Object.freeze(['sensitive', 'encrypted-required'])

/**
 * Which lifetime field bounds this record, by name, or null when none does.
 * A `retention` BLOCK counts only when it actually carries a window (`ttl` or
 * `until`): an empty block, or one holding nothing the schema recognises, bounds
 * nothing and must not be mistaken for an expiry.
 */
function lifetimeField(record) {
  if (!isPlainObject(record)) return null
  const retention = record.retention
  if (isPlainObject(retention)) {
    if (isPresent(retention.ttl) || isPresent(retention.until)) return 'retention'
  } else if (isPresent(retention)) {
    return 'retention'
  }
  return isPresent(record.valid_until) ? 'valid_until' : null
}

/**
 * hasLifetimeWindow(record) -> boolean — can this record expire by itself?
 *
 * EXPORTED for the same one-implementation reason as INTERPRETATION_MODES and
 * hasEvidence: the write pipeline's risk step asks exactly this question before
 * it will let the one automatic path write anything, and the storage resolver
 * asks it to derive the ephemeral class. Two answers to "is this bounded in
 * time?" is precisely the drift this vocabulary module exists to prevent.
 *
 * @param {unknown} record
 * @returns {boolean}
 */
export function hasLifetimeWindow(record) {
  return lifetimeField(record) !== null
}

/**
 * Whether the record's horizon has already passed, as far as the CALLER's clock
 * can say. Reported, never decisive: a closed window does not move a record to
 * another class, it only tells the reader what it is looking at. With no clock
 * supplied — the normal case — the answer is `unknown`, never a guess.
 */
function windowState(record, now) {
  const until = record.valid_until
  if (!isPresent(until) || !isPresent(now)) return 'unknown'
  const untilMs = Date.parse(String(until))
  const nowMs = Date.parse(String(now))
  if (Number.isNaN(untilMs) || Number.isNaN(nowMs)) return 'unknown'
  return nowMs > untilMs ? 'closed' : 'open'
}

/** A refusal verdict: no class was assigned, and the reason names what stopped it. */
function classRefusal(field, value, reason) {
  return { storageClass: null, refused: true, rule: 'unreadable-class', field, value, window: 'unknown', reason }
}

/**
 * resolveStorageClass(record, {now}) -> verdict
 *
 * Which of the three classes may hold this record, in the same posture as
 * resolveApprovalPath: strictest rule first, an unknown value refused rather
 * than defaulted, and a verdict that names the field and the rule that decided
 * so a person can argue with it.
 *
 * Precedence:
 *   1. fail-closed — an input that is not a record, or a `sensitivity` outside
 *      the closed four, is REFUSED. An unreadable label is not a permit, and
 *      quietly calling it `shared` would turn a typo into a publication;
 *   2. restricted — `sensitive` or `encrypted-required` resolves to
 *      this-machine-only whatever else the record says, including a lifetime
 *      window: the strictest rule wins;
 *   3. lifetime — a `retention` window or a `valid_until` horizon resolves to
 *      ephemeral, because "who sees it" is answered by "nobody, after the date";
 *   4. default — everything else is shared.
 *
 * PURE: no fs, no network, and no clock of its own. `now` is optional, is used
 * only to REPORT whether a horizon has passed, and never changes the class.
 *
 * @param {unknown} record — a parsed v2 frontmatter object
 * @param {{now?: string}} [opts]
 * @returns {{storageClass: string|null, refused: boolean, rule: string,
 *            field: string|null, value: unknown, window: string, reason: string}}
 */
export function resolveStorageClass(record, opts = {}) {
  if (!isPlainObject(record)) {
    return classRefusal(
      null,
      record,
      'storage class: the input is not a record — a class cannot be read off something that is not a record, and no class means no permission to write anywhere',
    )
  }

  const sensitivity = record.sensitivity
  if (isPresent(sensitivity) && !SENSITIVITY_CLASSES.includes(sensitivity)) {
    return classRefusal(
      'sensitivity',
      sensitivity,
      `storage class: sensitivity "${String(sensitivity)}" is outside the closed vocabulary (${SENSITIVITY_CLASSES.join(' · ')}) — an unreadable label is not a permit, so no class is assigned`,
    )
  }

  const now = opts && typeof opts === 'object' ? opts.now : undefined
  const window = windowState(record, now)
  const lifetime = lifetimeField(record)

  if (RESTRICTED_SENSITIVITY.includes(sensitivity)) {
    return {
      storageClass: 'this-machine-only',
      refused: false,
      rule: 'restricted-class',
      field: 'sensitivity',
      value: sensitivity,
      window,
      reason: lifetime
        ? `storage class: sensitivity "${String(sensitivity)}" is restricted and "${lifetime}" bounds the record in time — the strictest rule wins, so the record is this-machine-only and expires there`
        : `storage class: sensitivity "${String(sensitivity)}" is restricted — the strictest rule wins: this material never enters a git-backed path`,
    }
  }

  if (lifetime) {
    return {
      storageClass: 'ephemeral',
      refused: false,
      rule: 'lifetime-window',
      field: lifetime,
      value: record[lifetime],
      window,
      reason: `storage class: "${lifetime}" bounds the record in time — who sees it is answered by "nobody, after the date"`,
    }
  }

  return {
    storageClass: 'shared',
    refused: false,
    rule: 'default-shared',
    field: null,
    value: null,
    window,
    reason: 'storage class: nothing restricts this record and nothing bounds it in time — the default is the project\'s own git, which is what the team sees',
  }
}

/**
 * Evidence that would actually re-verify something — none-recorded is honest,
 * not evidence. EXPORTED for the same reason as INTERPRETATION_MODES: the write
 * pipeline asks this exact question at its evidence step, and the
 * `none-recorded` rule must have one implementation, not two.
 */
export function hasEvidence(record) {
  const evidence = record.evidence
  if (typeof evidence === 'string') return evidence.trim() !== '' && evidence.trim() !== NO_EVIDENCE
  if (!Array.isArray(evidence)) return false
  return evidence.some((item) =>
    typeof item === 'string'
      ? item.trim() !== '' && item.trim() !== NO_EVIDENCE
      : isPlainObject(item) && isPresent(item.ref) && String(item.ref).trim() !== NO_EVIDENCE,
  )
}
