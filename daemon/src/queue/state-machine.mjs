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
