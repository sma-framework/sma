/**
 * capability-envelope.mjs — what a task may touch, DECLARED and VALIDATED: the bound
 * on what a worker may be handed (fleet invariant two; docs/FLEET-INVARIANTS.md §3.2).
 *
 * WHY THIS FILE EXISTS: today a task declares its lane, its provider, its model, its
 * effort and its story points — and nothing at all about what it may touch. A worker's
 * reach is bounded by convention: the checkout it stands in, the settings that checkout
 * carries, and the habit of the person who wrote the prompt. Convention is not a boundary
 * that can be checked, replayed, or shown to have held. This module gives every task an
 * explicit envelope over the canon's eight dimensions, and a fail-closed validator that
 * refuses anything it cannot read.
 *
 * BACKEND-FREE AND EFFECT-FREE BY LAW (adapter.mjs's posture, adopted verbatim): no
 * backend, no filesystem, no network, no clock, no state between calls. The only import
 * is `node:crypto`, for the digest. The daemon's runtime dependencies are exactly `pg`
 * and `pg-boss`; this module adds none. Every function here is pure over its inputs and
 * never mutates its argument.
 *
 * THE POSTURE IS schema-v2.mjs's (`APPROVAL_PATHS` / `resolveApprovalPath`): a frozen
 * closed vocabulary plus a pure resolver that fails CLOSED. The threat model's line is
 * the reason — «a subsystem that decides what may be believed, where it may sit, or what
 * may be destroyed must refuse». This one decides what a worker may do to the world, so a
 * missing key, an unknown key, a malformed value and an undeclared destination are all
 * refusals. An unrecognised permission is not a permit.
 *
 * ═══════════ PUSH AND MERGE ARE NOT GRANTABLE — BY CONSTRUCTION, NOT BY BRANCH ═══════
 * Canon invariant 2: «Worker не имеет push/merge capability независимо от prompt». The
 * human-only set below is a module constant the validator reads; there is no parameter,
 * option or input path that moves a member out of it, and `defaultEnvelope` puts the whole
 * set into every lane's envelope. `ship-lane.mjs` states the same law from the other side —
 * that module is a read-only checker that never pushes, tags or deploys. This is the
 * structural half of that sentence. The refusal TOKENS are `push` and `merge`, matched as a
 * case-insensitive substring across every granting dimension, exactly as
 * `state-machine.mjs` matches them: over-refusing a path or tool whose NAME contains
 * "push" is the correct direction of error for a gate of this kind, and a caller who hits
 * it narrows or renames the entry rather than widening the gate.
 *
 * WHAT THIS MODULE DOES NOT DO, SAID OUT LOUD: nothing enforces these envelopes yet. The
 * runner spawns a worker in a per-task worktree, and the worker's real permission surface
 * is the CHECKOUT's `.claude/settings.json` (args.mjs guards that surface against being
 * swapped out, and TERMINAL_PARITY_PATHS names what the session inherits by standing
 * there). So today the REAL reach of a prod worker is wider than the envelope below says.
 * The envelope is the declaration a receipt can be checked against and the shape a future
 * enforcement point consumes; it is not, on its own, an enforcement point. Reading it as
 * one would be the exact "promise the layer below cannot keep" the fleet already refuses
 * to make elsewhere.
 */

import { createHash } from 'node:crypto'

// ── the closed vocabularies ──

/**
 * The canon's eight capability dimensions, verbatim (roadmap txt: «read paths, write
 * paths, allowed tools, network destinations, secret scopes, budget, max runtime,
 * human-only actions»). Frozen: a ninth dimension is a policy decision that must also
 * teach the validator and every lane default what to say about it.
 */
export const CAPABILITY_KEYS = Object.freeze([
  'readPaths',
  'writePaths',
  'allowedTools',
  'networkDestinations',
  'secretScopes',
  'budget',
  'maxRuntime',
  'humanOnlyActions',
])

/**
 * The four lanes the task shape declares. RESTATED rather than imported so this module
 * stays import-free beyond `node:crypto` — and the test suite compares this list against
 * `adapter.mjs`'s `TASK_LANES`, so the duplication cannot drift. (Same technique
 * `state-machine.mjs` uses for the queue statuses.)
 */
export const ENVELOPE_LANES = Object.freeze(['prod', 'research', 'paperwork', 'forge'])

/**
 * Actions no envelope may ever grant to a worker. `push` and `merge` are fleet invariant
 * 2; `tag` and `deploy` join them because `ship-lane.mjs` states the same boundary in the
 * same breath («never pushes, tags, or deploys») and an envelope that denied two of the
 * three would read as a permit for the third.
 */
export const HUMAN_ONLY_ACTIONS = Object.freeze(['push', 'merge', 'tag', 'deploy'])

/**
 * The tokens whose mere appearance in a GRANTING dimension refuses the envelope. Kept to
 * the two invariant-two names, matched exactly as `state-machine.mjs` matches them, so
 * the two modules speak one law rather than two dialects of it.
 */
const FORBIDDEN_CAPABILITY_TOKENS = Object.freeze(['push', 'merge'])

/**
 * The dimensions that GRANT something, and are therefore scanned for the forbidden
 * tokens. `humanOnlyActions` is deliberately absent: it is the DENIAL list, and scanning
 * it would refuse every well-formed envelope for containing the very words it exists to
 * forbid. `budget` and `maxRuntime` are scalars and grant no named capability.
 */
const GRANTING_KEYS = Object.freeze([
  'readPaths',
  'writePaths',
  'allowedTools',
  'networkDestinations',
  'secretScopes',
])

/** The dimensions carried as a list of non-empty strings. */
const LIST_KEYS = Object.freeze([...GRANTING_KEYS, 'humanOnlyActions'])

/** The canon's own duration notation — the transition contracts write `timeout: 45m`. */
const DURATION_RE = /^\d+[mh]$/

/**
 * The verbs `envelopeAllows` can answer. Anything else is refused rather than guessed:
 * a gate that returns `true` for a question it did not understand is not a gate.
 */
const REQUEST_ACTIONS = Object.freeze(['read', 'write', 'tool', 'network', 'spend'])

// ── the lane defaults ──

/**
 * The tool vocabulary. IDENTICAL FOR EVERY LANE, on purpose and against the temptation to
 * look thorough: all four lanes today run the same CLI in the same worktree under the same
 * `.claude/settings.json`, and every lane commits its own work, so every lane really does
 * hold the same tools. Differentiating them here would be a decoration, not a boundary —
 * the lanes differ in WRITE SCOPE, and that is where this table differentiates them.
 */
const LANE_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'])

/**
 * The canon's RUNNING→PRODUCED timeout, the one runtime number this codebase has actually
 * written down (state-machine.mjs `timeout: '45m'`). It is used for every lane because a
 * per-lane cap would need a measurement of real run durations that we do not have; an
 * invented per-lane number would read as evidence and be none.
 */
const LANE_MAX_RUNTIME = '45m'

/** The forge's three draft directories, verbatim from `forge/forge.mjs` DRAFT_DIRS. */
const FORGE_DRAFT_DIRS = Object.freeze(['.claude/agents', '.claude/skills', '.claude/harness/mcp-requests'])

/**
 * Per-lane WRITE scope — the honest part of the differentiation, each grounded in what the
 * lane actually produces today:
 *   prod      — changes the product; it writes anywhere in its worktree.
 *   research  — reads widely and writes little: findings, not source.
 *   paperwork — planning artifacts and documentation (backlog-scan routes `.planning`,
 *               «документ» and docs-only work into this lane).
 *   forge     — drafts one definition file; `forge.mjs` already contracts exactly where.
 */
const LANE_WRITE_PATHS = Object.freeze({
  prod: Object.freeze(['.']),
  research: Object.freeze(['docs']),
  paperwork: Object.freeze(['.planning', 'docs']),
  forge: FORGE_DRAFT_DIRS,
})

/**
 * The envelope an unknown lane gets: nothing. `resolveApprovalPath`'s rule, applied here —
 * a task whose class cannot be determined is treated as the most restrictive plausible
 * class. A lane name arriving from a prompt, a config typo or a future release must not be
 * able to widen anything by being unrecognised.
 */
const LOCKED_ENVELOPE = Object.freeze({
  readPaths: Object.freeze([]),
  writePaths: Object.freeze([]),
  allowedTools: Object.freeze([]),
  networkDestinations: Object.freeze([]),
  secretScopes: Object.freeze([]),
  budget: 0,
  maxRuntime: '0m',
  humanOnlyActions: HUMAN_ONLY_ACTIONS,
})

/**
 * defaultEnvelope(lane) → a complete, frozen envelope for one of the four lanes; the
 * LOCKED envelope for anything else. Every key of `CAPABILITY_KEYS` is present, and the
 * result validates.
 *
 * `networkDestinations` and `secretScopes` are empty for every lane and that is a
 * statement, not an omission: the provider traffic and the credentials a worker session
 * uses belong to the ACCOUNT the harness spawns it under, not to the task, so no task-level
 * destination or secret scope is declared. `budget` is null for the same kind of reason —
 * the economy ledger owns the real lane budget, this envelope declares none of its own, and
 * `envelopeAllows` therefore refuses every spend rather than reading "no budget" as
 * "unlimited".
 *
 * PURE. The returned object and its lists are frozen, so a caller cannot widen its own
 * permit in place.
 *
 * @param {string} lane
 * @returns {object} a complete capability envelope
 */
export function defaultEnvelope(lane) {
  const writePaths = typeof lane === 'string' ? LANE_WRITE_PATHS[lane] : undefined
  if (!writePaths) return LOCKED_ENVELOPE
  return Object.freeze({
    // Every lane stands in a worktree of the repository it was given and reads it; the
    // terminal-parity paths (.claude/settings.json, .claude/memory, .claude/skills,
    // CLAUDE.md — args.mjs TERMINAL_PARITY_PATHS) are inside that root by construction.
    readPaths: Object.freeze(['.']),
    writePaths,
    allowedTools: LANE_TOOLS,
    networkDestinations: Object.freeze([]),
    secretScopes: Object.freeze([]),
    budget: null,
    maxRuntime: LANE_MAX_RUNTIME,
    humanOnlyActions: HUMAN_ONLY_ACTIONS,
  })
}

// ── the validator ──

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Refusals are RETURNED, never thrown: this is a policy answer, not a programmer error. */
function refuse(reason, key) {
  return Object.freeze({ valid: false, refusal: `refused: ${reason}`, ...(key === undefined ? {} : { key }) })
}

const ACCEPTED = Object.freeze({ valid: true, refusal: null })

function isNonEmptyStringList(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim() !== '')
}

/**
 * validateEnvelope(env) → `{valid:true, refusal:null}` or `{valid:false, refusal, key?}`.
 *
 * Order matters and is deliberate:
 *   0. the human-only scan runs FIRST, before shape, before completeness — exactly as
 *      `applyTransition` checks fleet invariant two before anything else can matter. A
 *      half-built envelope must not be able to smuggle a push capability past the gate by
 *      failing some other check first and being retried without it.
 *   1. missing key — a dimension left unsaid is not a dimension left open.
 *   2. unknown key — refused, never ignored.
 *   3. shape per dimension.
 *   4. the human-only set is complete — an envelope that quietly dropped `push` from its
 *      own denial list is refused, so no input path moves a member out of the constant.
 *
 * PURE: the envelope is never mutated.
 *
 * @param {unknown} env
 * @returns {{valid:boolean, refusal:string|null, key?:string}}
 */
export function validateEnvelope(env) {
  if (!isPlainObject(env)) {
    return refuse('an envelope must be a plain object naming every capability dimension')
  }

  // 0. fleet invariant two, first and unconditionally.
  for (const key of GRANTING_KEYS) {
    const value = env[key]
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      const lowered = String(entry).toLowerCase()
      for (const token of FORBIDDEN_CAPABILITY_TOKENS) {
        if (lowered.includes(token)) {
          return refuse(
            `"${key}" declares "${token}", which crosses the human-only boundary (canon invariant 2): ` +
              'a worker holds no push or merge capability regardless of any prompt, task text or ' +
              'envelope input — narrow or rename the entry, the gate does not widen',
            key,
          )
        }
      }
    }
  }

  // 1. completeness.
  for (const key of CAPABILITY_KEYS) {
    if (!Object.hasOwn(env, key)) {
      return refuse(`the envelope is missing "${key}" — an undeclared dimension is not an open one`, key)
    }
  }

  // 2. unknown keys.
  for (const key of Object.keys(env)) {
    if (!CAPABILITY_KEYS.includes(key)) {
      return refuse(
        `"${key}" is outside the closed vocabulary (${CAPABILITY_KEYS.join(' · ')}) — an ` +
          'unrecognised permission is not a permit',
        key,
      )
    }
  }

  // 3. shape.
  for (const key of LIST_KEYS) {
    if (!isNonEmptyStringList(env[key])) {
      return refuse(`"${key}" must be a list of non-empty strings (an empty list is a valid, closed declaration)`, key)
    }
  }
  if (!(env.budget === null || (typeof env.budget === 'number' && Number.isFinite(env.budget) && env.budget >= 0))) {
    return refuse('"budget" must be a non-negative number, or null to declare no budget of its own', 'budget')
  }
  if (typeof env.maxRuntime !== 'string' || !DURATION_RE.test(env.maxRuntime)) {
    return refuse('"maxRuntime" must be a duration such as "45m" or "2h" — a runtime with no unit bounds nothing', 'maxRuntime')
  }

  // 4. the human-only set is complete.
  for (const action of HUMAN_ONLY_ACTIONS) {
    if (!env.humanOnlyActions.includes(action)) {
      return refuse(
        `"humanOnlyActions" dropped "${action}": the human-only boundary is a module constant ` +
          `(${HUMAN_ONLY_ACTIONS.join(' · ')}) and no envelope input moves a member out of it`,
        'humanOnlyActions',
      )
    }
  }

  return ACCEPTED
}

// ── the permit check ──

/** `a/b` form, no drive letter, no traversal segment, no absolute root. */
function normalizePath(p) {
  if (typeof p !== 'string' || p.trim() === '') return null
  const slashed = p.replace(/\\/g, '/').trim()
  // Any drive-letter prefix is refused, slash or no slash: `C:foo` is Windows
  // drive-RELATIVE — it resolves against the drive's own cwd, outside any
  // declared root, and a slash-only test would wave it through as "relative".
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return null // absolute or drive-anchored: outside any declared root
  const segments = slashed.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.includes('..')) return null // a traversal is refused, never resolved
  return segments.join('/')
}

/** True when `path` is `base` itself or lies beneath it — on a SEGMENT boundary, not a prefix. */
function withinDeclaredPath(base, path) {
  const b = normalizePath(base)
  if (b === null) return false
  if (b === '') return true // '.' — the whole root
  return path === b || path.startsWith(`${b}/`)
}

/**
 * envelopeAllows(env, request) → boolean. Never throws; an unanswerable question is a `false`.
 *
 * FAIL-CLOSED ON EVERY LEG: an invalid envelope grants nothing, an action outside the
 * request vocabulary is refused, a human-only action is refused whatever the dimensions
 * say, and a spend against an envelope that declares no budget is refused rather than
 * treated as unlimited.
 *
 * @param {object} env
 * @param {{action?:string, path?:string, tool?:string, destination?:string, amount?:number}} request
 * @returns {boolean}
 */
export function envelopeAllows(env, request = {}) {
  if (!validateEnvelope(env).valid) return false
  if (!isPlainObject(request)) return false

  const action = request.action
  if (typeof action !== 'string' || action.trim() === '') return false

  // The human-only boundary answers before any dimension gets a say.
  if (env.humanOnlyActions.includes(action) || HUMAN_ONLY_ACTIONS.includes(action)) return false
  if (!REQUEST_ACTIONS.includes(action)) return false

  if (action === 'read' || action === 'write') {
    const path = normalizePath(request.path)
    if (path === null) return false
    const declared = action === 'read' ? env.readPaths : env.writePaths
    return declared.some((base) => withinDeclaredPath(base, path))
  }

  if (action === 'tool') {
    return typeof request.tool === 'string' && env.allowedTools.includes(request.tool)
  }

  if (action === 'network') {
    return typeof request.destination === 'string' && env.networkDestinations.includes(request.destination)
  }

  // spend
  if (env.budget === null) return false
  const amount = request.amount
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return false
  return amount <= env.budget
}

// ── the digest ──

/** Recursively key-sorted, so two structurally identical envelopes serialize identically. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (isPlainObject(value)) {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key])
    return out
  }
  return value
}

/**
 * envelopeHash(env) → 64 hex characters over a canonically ordered serialization.
 *
 * DETERMINISTIC BY CONSTRUCTION: no clock, no counter, no randomness — so an attempt row
 * can carry the digest of the envelope the work actually ran under, and a receipt can be
 * checked against it later. Key order in the input object does not move the digest; any
 * VALUE change does, list order included (a reordered list is a different declaration to
 * anything that reads it in order, and pretending otherwise would hide a real change).
 *
 * Throws on a non-object: hashing `null` would mint a real-looking digest for a caller who
 * forgot to build an envelope, and a wrong stamp is worse than a loud failure. It does NOT
 * require a VALID envelope — a receipt must be able to record the digest of the thing that
 * actually ran, including one a validator would refuse.
 *
 * @param {object} env
 * @returns {string} 64 hex chars
 */
export function envelopeHash(env) {
  if (!isPlainObject(env)) {
    throw new TypeError('envelopeHash requires an envelope object')
  }
  return createHash('sha256').update(JSON.stringify(canonical(env))).digest('hex')
}
