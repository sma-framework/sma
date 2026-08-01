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
 *   - validateId(id, filePath) -> string|null
 *   - PRIVATE_FACET_PATTERN · isPrivateFacet(value)
 *
 * Node built-ins only. Every function here is PURE: no fs, no clock, no network.
 * Expiry ("is this valid_until in the past?") is a LINT concern precisely
 * because it needs a clock; this module must stay replayable and testable.
 */

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
