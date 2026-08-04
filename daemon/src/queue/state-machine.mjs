/**
 * state-machine.mjs — the fleet's NAMED state vocabulary and its transition contracts
 * (Phase 11 Plan 04; canon §10 «V5 fleet: надежная orchestration»).
 *
 * WHY THIS FILE EXISTS: the fleet speaks four statuses — queued, claimed, completed,
 * failed — plus a dead-letter queue. Four values collapse three genuinely different
 * situations into one bit: work PRODUCED but not yet checked, work being VERIFYING,
 * and work WAITING_HUMAN. Nothing can be asserted about a fleet whose vocabulary cannot
 * express what is true, so this module gives the canon's eleven states names, a contract
 * per legal transition, and a version an attempt can be stamped with.
 *
 * IT WRAPS THE QUEUE, IT DOES NOT REPLACE IT. pg-boss stays the coarse truth: it still
 * answers "is this job checked out". `toQueueStatus` maps every fine state back down onto
 * the four-value vocabulary `pgboss-backend.mjs` already speaks (STATE_TO_STATUS), so the
 * two layers can never disagree about what is running. There is no second queue here, no
 * new persistence layer, and no UPDATE of a boss table — that last one is the backend's
 * own stated law and this module is not the place to break it.
 *
 * BACKEND-FREE BY LAW (adapter.mjs's posture, adopted verbatim): this module imports NO
 * backend — not pg-boss, not pg, not pgboss-backend.mjs, not even adapter.mjs. It opens no
 * connection, touches no filesystem and holds no state between calls. Every function here
 * is pure over its inputs. The only import is `node:crypto`, for a hash. The daemon's
 * runtime dependencies are exactly `pg` and `pg-boss`; this module adds none.
 *
 * ═══════════ AT-LEAST-ONCE, NOT EXACTLY-ONCE — THE REASON FOR THIS SHAPE ═══════════
 * The fleet promises AT-LEAST-ONCE delivery. It does not promise exactly-once, and this
 * module must never be read as providing it: the queue underneath cannot keep that promise,
 * and a promise the layer below cannot keep is worse than none. What makes at-least-once
 * survivable is the canon's practical semantics — immutable attempts, idempotent effects,
 * and transactional state transitions. That is why every contract below declares its
 * `externalEffects` EXPLICITLY rather than by omission: a redelivered transition whose
 * effect was never declared is exactly the case canon invariant 4 exists to survive («истечение
 * lease не означает, что внешний side effect не произошел»).
 *
 * ═══════════ WHICH INVARIANTS LIVE HERE, AND WHICH DELIBERATELY DO NOT ════════════
 * Four of the canon's seven invariants are decidable from a SINGLE transition, and
 * `applyTransition` enforces them as refusals:
 *   1 — ACCEPTED requires a verification receipt AND an authorized disposition, so no
 *       worker can accept its own work.
 *   2 — no transition may grant push or merge capability; no input turns it on.
 *   5 — a redelivery under an existing idempotency key reports itself as already applied
 *       instead of running the effect a second time.
 *   7 — a dead-letter task does not return to READY without an explicit disposition.
 * The other three are properties of the LEDGER and the RUNNER across many transitions, and
 * no single-transition function can see them: at most one active lease per task alongside
 * many immutable attempts (3); a lease expiry never implying the external effect did not
 * happen (4); and the policy / memory-snapshot / model / harness stamp being fixed on the
 * attempt (6). They are property-tested in PLAN 11-08. Do not mistake this module for the
 * whole guarantee — it is the part of it a pure function can hold, and it says so out loud.
 *
 * THE CONTRACT SHAPE is the canon's, field for field (roadmap txt line 515 onward):
 *   actor · preconditions · idempotency_key · writes · external_effects · timeout ·
 *   retry_policy · next_states
 * `nextStates` are the states reachable AFTER landing in `to`. They are written out per
 * contract rather than derived, so the table reads as the canon writes it — and the test
 * suite compares every one of them against the destination's own outgoing set, so the
 * duplication cannot drift. One deliberate difference from the canon's worked example
 * (RUNNING→PRODUCED, next_states [VERIFYING, RETRYABLE]): CANCELLED is reachable from every
 * non-terminal state, so it appears in every non-terminal `nextStates`. A human may stop
 * work at any point before it is finished; the canon's own diagram draws that edge.
 */

import { createHash } from 'node:crypto'

// ── the closed vocabularies ──

/**
 * The canon's eleven fleet states, verbatim (roadmap txt lines 512-514). Frozen: adding a
 * state is a policy decision that must also add its contracts, and the suite fails when it
 * does not.
 */
export const FLEET_STATES = Object.freeze([
  'READY',
  'CLAIMED',
  'RUNNING',
  'PRODUCED',
  'VERIFYING',
  'WAITING_HUMAN',
  'ACCEPTED',
  'REJECTED',
  'RETRYABLE',
  'DEAD_LETTER',
  'CANCELLED',
])

/**
 * The four states a task never leaves. DEAD_LETTER is terminal ON PURPOSE: canon invariant 7
 * («dead-letter task не возвращается в READY без явного disposition») is honoured by the
 * RETRYABLE→READY edge, which is where a retry legitimately re-enters the queue. Once a task
 * has been dead-lettered, no transition moves it — a human disposition opens a NEW attempt
 * through the queue's own enqueue path, and this module refuses the shortcut by name.
 */
export const TERMINAL_STATES = Object.freeze(['ACCEPTED', 'REJECTED', 'DEAD_LETTER', 'CANCELLED'])

/**
 * The version an attempt is stamped with (canon invariant 6; plan 11-05 writes it into the
 * attempt ledger). Bumped whenever the vocabulary or a contract changes, so an old attempt
 * stays readable as what it actually ran under.
 */
export const STATE_MACHINE_VERSION = 'fleet-sm-1'

/** The queue statuses underneath — kept in agreement with pgboss-backend.mjs by the tests. */
const QUEUE_STATUSES = Object.freeze(['queued', 'claimed', 'completed', 'failed'])

/** Who may perform a transition. A contract names exactly one. */
const ACTORS = Object.freeze(['dispatcher', 'worker', 'verifier', 'supervisor', 'human'])

/**
 * What counts as an authorized disposition for ACCEPTED (canon invariant 1). A closed
 * vocabulary on purpose: free text here would let «the worker says it is fine» pass for a
 * human decision, which is the exact elevation this invariant exists to stop.
 */
const AUTHORIZED_DISPOSITIONS = Object.freeze(['human-approved', 'authorized-policy'])

/**
 * Capability tokens no transition may ever grant (canon invariant 2 + the human-only push
 * law). Matched as a SUBSTRING, case-insensitively: over-refusing a capability named
 * `merge-report-read` is the correct direction of error for a gate that decides what a
 * worker may do to the world — «a subsystem that decides ... must refuse».
 */
const FORBIDDEN_CAPABILITY_TOKENS = Object.freeze(['push', 'merge'])

/**
 * The only preconditions this module can decide from a single transition's inputs.
 * Everything else a contract names is reported back as deferred, so a caller can see what
 * it still owes rather than reading silence as a pass.
 */
const DECIDABLE_PRECONDITIONS = Object.freeze([
  'verification_receipt_present',
  'authorized_disposition_present',
])

// ── the transition contract table ──

/** The human abort edge, available from every non-terminal state (canon diagram). */
const cancelContract = () =>
  Object.freeze({
    actor: 'human',
    preconditions: Object.freeze(['human_requested_stop']),
    writes: Object.freeze(['cancellation_record']),
    externalEffects: Object.freeze([]),
    retryPolicy: 'none',
    nextStates: Object.freeze([]),
  })

/**
 * TRANSITIONS[from][to] → the contract. A pair absent from this table is not a transition;
 * `applyTransition` refuses it rather than performing it silently. Terminal states carry no
 * entry at all — that absence IS the terminality, and the suite checks both directions.
 */
export const TRANSITIONS = Object.freeze({
  READY: Object.freeze({
    CLAIMED: Object.freeze({
      actor: 'dispatcher',
      preconditions: Object.freeze(['worker_lane_open', 'no_active_lease']),
      writes: Object.freeze(['lease', 'attempt_row']),
      externalEffects: Object.freeze([]),
      retryPolicy: 'create_new_attempt',
      nextStates: Object.freeze(['RUNNING', 'RETRYABLE', 'CANCELLED']),
    }),
    CANCELLED: cancelContract(),
  }),

  CLAIMED: Object.freeze({
    RUNNING: Object.freeze({
      actor: 'worker',
      preconditions: Object.freeze(['active_lease_matches_attempt', 'capability_envelope_present']),
      writes: Object.freeze(['attempt_row']),
      // A worker process starts here: a real thing happens outside the queue, and it may
      // have happened even if the lease later expires (canon invariant 4).
      externalEffects: Object.freeze(['worker_process_started']),
      retryPolicy: 'create_new_attempt',
      nextStates: Object.freeze(['PRODUCED', 'RETRYABLE', 'CANCELLED']),
    }),
    RETRYABLE: Object.freeze({
      actor: 'supervisor',
      preconditions: Object.freeze(['lease_expired_or_worker_failed']),
      writes: Object.freeze(['attempt_row', 'failure_reason']),
      externalEffects: Object.freeze([]),
      retryPolicy: 'create_new_attempt',
      nextStates: Object.freeze(['READY', 'DEAD_LETTER', 'CANCELLED']),
    }),
    CANCELLED: cancelContract(),
  }),

  RUNNING: Object.freeze({
    // The canon's worked example (roadmap txt lines 516-530), field for field.
    PRODUCED: Object.freeze({
      actor: 'worker',
      preconditions: Object.freeze(['active_lease_matches_attempt', 'capability_allows_write_scope']),
      writes: Object.freeze(['artifact_manifest', 'execution_receipt']),
      externalEffects: Object.freeze([]),
      timeout: '45m',
      retryPolicy: 'create_new_attempt',
      nextStates: Object.freeze(['VERIFYING', 'RETRYABLE', 'CANCELLED']),
    }),
    RETRYABLE: Object.freeze({
      actor: 'supervisor',
      preconditions: Object.freeze(['lease_expired_or_worker_failed']),
      writes: Object.freeze(['attempt_row', 'failure_reason']),
      externalEffects: Object.freeze([]),
      retryPolicy: 'create_new_attempt',
      nextStates: Object.freeze(['READY', 'DEAD_LETTER', 'CANCELLED']),
    }),
    CANCELLED: cancelContract(),
  }),

  PRODUCED: Object.freeze({
    VERIFYING: Object.freeze({
      actor: 'verifier',
      preconditions: Object.freeze(['artifact_manifest_present']),
      writes: Object.freeze(['verification_run']),
      externalEffects: Object.freeze([]),
      retryPolicy: 'create_new_attempt',
      nextStates: Object.freeze(['ACCEPTED', 'REJECTED', 'WAITING_HUMAN', 'RETRYABLE', 'CANCELLED']),
    }),
    RETRYABLE: Object.freeze({
      actor: 'supervisor',
      preconditions: Object.freeze(['lease_expired_or_worker_failed']),
      writes: Object.freeze(['attempt_row', 'failure_reason']),
      externalEffects: Object.freeze([]),
      retryPolicy: 'create_new_attempt',
      nextStates: Object.freeze(['READY', 'DEAD_LETTER', 'CANCELLED']),
    }),
    CANCELLED: cancelContract(),
  }),

  VERIFYING: Object.freeze({
    // Canon invariant 1 lives on this edge: a verification receipt AND an authorized
    // disposition, or the transition is refused.
    ACCEPTED: Object.freeze({
      actor: 'verifier',
      preconditions: Object.freeze(['verification_receipt_present', 'authorized_disposition_present']),
      writes: Object.freeze(['acceptance_record', 'execution_receipt']),
      externalEffects: Object.freeze([]),
      retryPolicy: 'none',
      nextStates: Object.freeze([]),
    }),
    REJECTED: Object.freeze({
      actor: 'verifier',
      preconditions: Object.freeze(['verification_receipt_present']),
      writes: Object.freeze(['rejection_record', 'failure_reason']),
      externalEffects: Object.freeze([]),
      retryPolicy: 'none',
      nextStates: Object.freeze([]),
    }),
    WAITING_HUMAN: Object.freeze({
      actor: 'verifier',
      preconditions: Object.freeze(['decision_required_by_human']),
      writes: Object.freeze(['awaiting_approval_row']),
      // The human is told. A notification, once sent, cannot be unsent.
      externalEffects: Object.freeze(['human_notification']),
      retryPolicy: 'none',
      nextStates: Object.freeze(['ACCEPTED', 'REJECTED', 'CANCELLED']),
    }),
    RETRYABLE: Object.freeze({
      actor: 'supervisor',
      preconditions: Object.freeze(['lease_expired_or_worker_failed']),
      writes: Object.freeze(['attempt_row', 'failure_reason']),
      externalEffects: Object.freeze([]),
      retryPolicy: 'create_new_attempt',
      nextStates: Object.freeze(['READY', 'DEAD_LETTER', 'CANCELLED']),
    }),
    CANCELLED: cancelContract(),
  }),

  WAITING_HUMAN: Object.freeze({
    ACCEPTED: Object.freeze({
      actor: 'human',
      preconditions: Object.freeze(['verification_receipt_present', 'authorized_disposition_present']),
      writes: Object.freeze(['acceptance_record', 'execution_receipt']),
      externalEffects: Object.freeze([]),
      retryPolicy: 'none',
      nextStates: Object.freeze([]),
    }),
    REJECTED: Object.freeze({
      actor: 'human',
      preconditions: Object.freeze(['human_disposition_present']),
      writes: Object.freeze(['rejection_record', 'failure_reason']),
      externalEffects: Object.freeze([]),
      retryPolicy: 'none',
      nextStates: Object.freeze([]),
    }),
    CANCELLED: cancelContract(),
  }),

  RETRYABLE: Object.freeze({
    // The ONE legitimate way back into the queue — and it is a NEW attempt, never a rerun
    // of the old one (canon invariant 3: many immutable attempts, at most one active lease).
    READY: Object.freeze({
      actor: 'dispatcher',
      preconditions: Object.freeze(['retry_budget_remaining', 'new_attempt_created']),
      writes: Object.freeze(['attempt_row']),
      externalEffects: Object.freeze([]),
      retryPolicy: 'create_new_attempt',
      nextStates: Object.freeze(['CLAIMED', 'CANCELLED']),
    }),
    DEAD_LETTER: Object.freeze({
      actor: 'dispatcher',
      preconditions: Object.freeze(['retry_budget_exhausted']),
      writes: Object.freeze(['dead_letter_row', 'failure_reason']),
      externalEffects: Object.freeze(['dead_letter_enqueue', 'human_notification']),
      retryPolicy: 'none',
      nextStates: Object.freeze([]),
    }),
    CANCELLED: cancelContract(),
  }),
})

/** Fine state → the coarse queue status underneath. Frozen; every fleet state has an entry. */
const STATE_TO_QUEUE_STATUS = Object.freeze({
  READY: 'queued',
  // A retryable task is on its way back to the queue and is counted there, exactly as
  // pg-boss counts its own `retry` state as queued.
  RETRYABLE: 'queued',
  CLAIMED: 'claimed',
  // PRODUCED / VERIFYING / WAITING_HUMAN are the three situations the four-status
  // vocabulary collapses: the job is still checked out, and the queue underneath is
  // right to call all three `claimed` — it is this module that can tell them apart.
  RUNNING: 'claimed',
  PRODUCED: 'claimed',
  VERIFYING: 'claimed',
  WAITING_HUMAN: 'claimed',
  ACCEPTED: 'completed',
  REJECTED: 'failed',
  DEAD_LETTER: 'failed',
  CANCELLED: 'failed',
})

// ── the readers ──

/** True when `value` is one of the eleven states (prototype-safe: a list, not a lookup). */
function isFleetState(value) {
  return typeof value === 'string' && FLEET_STATES.includes(value)
}

/**
 * transitionContract(from, to) → the contract for a legal pair, or null.
 *
 * Null is the answer for an illegal pair AND for input that is not a state at all — a
 * caller asking about a transition that does not exist gets nothing, never an invented
 * contract. PURE.
 *
 * @param {string} from
 * @param {string} to
 * @returns {object|null}
 */
export function transitionContract(from, to) {
  if (!isFleetState(from) || !isFleetState(to)) return null
  const outgoing = TRANSITIONS[from]
  if (!outgoing) return null
  const contract = outgoing[to]
  return contract ?? null
}

/**
 * toQueueStatus(state) → the coarse queue status the fine state maps down onto, or null
 * when `state` is not a fleet state. This is the seam that keeps the two layers honest:
 * the fine vocabulary adds resolution, it never contradicts the queue about whether a job
 * is checked out. PURE.
 *
 * @param {string} state
 * @returns {string|null}
 */
export function toQueueStatus(state) {
  if (!isFleetState(state)) return null
  const status = STATE_TO_QUEUE_STATUS[state]
  return QUEUE_STATUSES.includes(status) ? status : null
}

// ── the idempotency key (canon line 523: task_id + attempt_id + transition) ──

/**
 * `12:some-task-id` — the length, a colon, the value. An injective encoding, so no choice
 * of separator character can be smuggled inside an id to make two different triples hash to
 * one key. Printable on purpose: a NUL byte in source turns the file binary to git.
 */
const lengthPrefixed = (part) => `${part.length}:${part}`

/**
 * idempotencyKey(taskId, attemptId, transition) → a short, stable hex string.
 *
 * DETERMINISTIC BY CONSTRUCTION: a hash of exactly the canon's three inputs and nothing
 * else. No clock, no counter, no randomness — so the same effect retried under the same
 * attempt composes the same key across process restarts, which is the whole mechanism that
 * makes at-least-once delivery survivable (canon invariant 5). The parts are length-prefixed,
 * so ('ab','c') and ('a','bc') can never collide into one key.
 *
 * Throws on a missing part: hashing an empty string would mint a real-looking key for a
 * caller that forgot an id, and a wrong key is worse than a loud failure.
 *
 * @param {string} taskId
 * @param {string} attemptId
 * @param {string} transition — e.g. 'RUNNING->PRODUCED'
 * @returns {string} 16 hex chars
 */
export function idempotencyKey(taskId, attemptId, transition) {
  const parts = [taskId, attemptId, transition]
  for (const part of parts) {
    if (typeof part !== 'string' || part.trim() === '') {
      throw new TypeError(
        'idempotencyKey requires three non-empty strings: taskId, attemptId, transition',
      )
    }
  }
  return createHash('sha256').update(parts.map(lengthPrefixed).join('')).digest('hex').slice(0, 16)
}

// ── the transition applier ──

/** Refusals are RETURNED, never thrown: this is a policy answer, not a programmer error. */
function refusal(reason, extra = {}) {
  return Object.freeze({ applied: false, alreadyApplied: false, refusal: `refused: ${reason}`, ...extra })
}

/**
 * applyTransition(input) → an applied result, an already-applied result, or a refusal.
 *
 * PURE over an INJECTED state value: it reads `input.state`, writes nothing, opens nothing,
 * and never mutates its argument. Persisting the result — and holding the set of keys that
 * have already been applied — belongs to the ledger (plan 11-05), not here.
 *
 * The applied result is shaped so `recordAttempt(ledgerDir, result)` accepts it directly:
 * the ledger's explicit-pick allowlist takes the keys it knows and ignores the rest, so the
 * allowlist discipline survives without a spread at the call site.
 *
 * REFUSAL REASONS CARRY STATE NAMES, ACTOR NAMES AND IDS ONLY (T-11-04-06). Caller-supplied
 * text — a disposition string, a capability name, a receipt reference — is never echoed
 * back, so a connection string handed in by mistake cannot ride out in an error message.
 *
 * @param {{state?:string, to?:string, actor?:string, taskId?:string, attemptId?:string,
 *          attempt?:number, receiptRef?:string, disposition?:string,
 *          grants?:string|string[], appliedKeys?:string[]|Set<string>}} input
 * @returns {object}
 */
export function applyTransition(input = {}) {
  const src = input && typeof input === 'object' ? input : {}
  const { state, to, actor, taskId, attemptId, attempt, receiptRef, disposition, grants, appliedKeys } = src

  const idOk = (v) => typeof v === 'string' && v.trim() !== ''
  if (!idOk(taskId) || !idOk(attemptId)) {
    return refusal('a transition must name the task and the attempt it belongs to (taskId + attemptId)')
  }
  if (!isFleetState(state) || !isFleetState(to)) {
    return refusal(`the from-state and the to-state must both be fleet states (${FLEET_STATES.join(' · ')})`, {
      taskId,
    })
  }

  const at = Object.freeze({ taskId, from: state, state })

  // Canon invariant 2 FIRST, before anything else can matter: no input widens what a worker
  // may do. Checked even on a redelivery, so a replayed message cannot smuggle it in.
  const grantList = typeof grants === 'string' ? [grants] : Array.isArray(grants) ? grants : []
  for (const grant of grantList) {
    const lowered = String(grant).toLowerCase()
    for (const token of FORBIDDEN_CAPABILITY_TOKENS) {
      if (lowered.includes(token)) {
        return refusal(
          `no transition may grant "${token}" capability (canon invariant 2): a worker has no ` +
            'push or merge capability regardless of any prompt, task text or grant list',
          at,
        )
      }
    }
  }

  const hasDisposition = idOk(disposition)

  // Canon invariant 7. DEAD_LETTER is terminal, so this pair has no contract at all — but a
  // caller reaching for it deserves the reason it exists, not a generic "illegal pair".
  if (state === 'DEAD_LETTER' && to === 'READY') {
    if (!hasDisposition) {
      return refusal(
        'DEAD_LETTER -> READY requires an explicit disposition (canon invariant 7): a ' +
          'dead-lettered task never returns to READY on its own',
        at,
      )
    }
    return refusal(
      'DEAD_LETTER -> READY is not a transition on this attempt: an authorized disposition ' +
        'opens a NEW attempt through the queue enqueue path, and this attempt stays ' +
        'dead-lettered (canon invariant 3 — many immutable attempts, at most one active lease)',
      { ...at, requiresNewAttempt: true },
    )
  }

  const contract = transitionContract(state, to)
  if (!contract) {
    return refusal(
      `${state} -> ${to} is not a legal transition: no contract declares it, so it is refused ` +
        'rather than silently performed',
      at,
    )
  }

  if (!ACTORS.includes(actor)) {
    return refusal(
      `${state} -> ${to} requires the "${contract.actor}" actor; the caller named none of ` +
        `${ACTORS.join(' · ')}`,
      at,
    )
  }
  if (actor !== contract.actor) {
    return refusal(`${state} -> ${to} may be performed only by the "${contract.actor}" actor`, at)
  }

  // Canon invariant 1: ACCEPTED is never self-certified.
  if (to === 'ACCEPTED') {
    const hasReceipt = idOk(receiptRef)
    const authorized = AUTHORIZED_DISPOSITIONS.includes(disposition)
    if (!hasReceipt || !authorized) {
      const missing = []
      if (!hasReceipt) missing.push('a verification receipt reference')
      if (!authorized) missing.push(`an authorized disposition (${AUTHORIZED_DISPOSITIONS.join(' · ')})`)
      return refusal(
        `${state} -> ACCEPTED requires ${missing.join(' and ')} (canon invariant 1): no worker ` +
          'accepts its own work',
        at,
      )
    }
  }

  const key = idempotencyKey(taskId, attemptId, `${state}->${to}`)
  const already = appliedKeys instanceof Set ? appliedKeys : new Set(Array.isArray(appliedKeys) ? appliedKeys : [])

  const landed = {
    taskId,
    attemptId,
    attempt,
    from: state,
    state: to,
    actor,
    contract,
    idempotencyKey: key,
    stateMachineVersion: STATE_MACHINE_VERSION,
    externalEffects: contract.externalEffects,
  }

  // Canon invariant 5: the same effect, redelivered under the same attempt, is reported as
  // already applied — NOT run a second time, and NOT refused either. It did happen.
  if (already.has(key)) {
    return Object.freeze({ ...landed, applied: false, alreadyApplied: true })
  }

  return Object.freeze({
    ...landed,
    applied: true,
    alreadyApplied: false,
    // What this module could not decide, said plainly. Plan 11-08 property-tests these.
    deferredPreconditions: Object.freeze(
      contract.preconditions.filter((p) => !DECIDABLE_PRECONDITIONS.includes(p)),
    ),
  })
}
