/**
 * invariants.test.ts — the fleet's SEVEN invariants, attacked by seeded random sequences.
 *
 * WHY THIS FILE EXISTS: `state-machine.test.ts` and `capability-envelope.test.ts` prove
 * that each module refuses the cases their authors thought of. Neither proves anything
 * about a SEQUENCE — and every one of the canon's seven invariants is a property of a
 * history, not of a call. This suite generates histories nobody wrote by hand and checks
 * all seven after every single step of every one of them.
 *
 * ═════════ REPLAYABILITY IS THE POINT — A FAILURE YOU CANNOT REPRODUCE IS NOISE ═══════
 * Every random choice descends from `INVARIANT_SEED`, a module-level constant. There is no
 * clock, no environment input and no unseeded source of randomness anywhere in this file:
 * the generator is a 32-bit integer mixer, `recordedAt` is derived from the step index, and
 * the temp directories hold nothing that feeds a decision. Running the suite twice produces
 * a byte-identical trace, and a dedicated case asserts exactly that. Every failure message
 * carries the seed, the sequence number and the step index, so a person can replay the
 * sequence and stop at the step that broke.
 *
 * ═════════ THE MUTATION BATTERY — WHY THIS SUITE'S SILENCE MEANS SOMETHING ════════════
 * A property suite that always passes is indistinguishable from one that checks nothing.
 * So each of the seven checkers is ALSO run against a deliberately broken world — a
 * transition table with one contract loosened to permit an illegal jump, a forged double
 * lease, a ledger whose stamp was rewritten between rows — and asserted to REPORT the
 * violation. Seven mutations, seven detections. The battery is not decoration; it is the
 * only reason a green run is evidence.
 *
 * ═════════ NO DATABASE, NO NETWORK, NO NEW DEPENDENCY ═════════════════════════════════
 * The suite drives the REAL modules — `state-machine.mjs`, `capability-envelope.mjs`,
 * `attempt-ledger.mjs` — and reimplements none of them. The ledger writes to a temp
 * directory and is read back through its own reader. No Postgres, no queue backend, no
 * property-testing library: the generator below is thirty lines, and adding a package is a
 * founder decision, not a plan's.
 *
 * WHAT THE HAND-ROLLED HARNESS DOES NOT GIVE US, SAID PLAINLY: automatic case
 * minimisation. A library would shrink a forty-step counterexample to the three steps that
 * matter. Here a failure arrives as a seed, a sequence number and a step index, and the
 * shrinking is done by a person re-running with a smaller `STEPS_PER_SEQUENCE`. That is the
 * accepted cost of adding no dependency, and it is recorded here rather than discovered.
 *
 * INVARIANT 5, EXACTLY AS THIS SUITE READS IT. The canon writes: «retry использует тот же
 * idempotency key для одного effect или создает новый attempt без повторного effect». The
 * enforceable half — the half a machine can decide — is that ONE effect is applied at most
 * once per (task, attempt, transition), that a redelivery under an existing key reports
 * itself as already applied rather than running again, and that the key is a deterministic
 * function of exactly that triple, so no redelivery can mint itself a fresh one. The other
 * half — that a NEW attempt does not repeat the effect — is not decidable here and is named
 * as a non-goal in `docs/FLEET-INVARIANTS.md`: a new attempt of a task legitimately spawns
 * a worker process again, and calling that a violation would make the invariant unusable.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FLEET_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  STATE_MACHINE_VERSION,
  transitionContract,
  applyTransition,
  idempotencyKey,
  toQueueStatus,
} from '../src/queue/state-machine.mjs'
import {
  ENVELOPE_LANES,
  HUMAN_ONLY_ACTIONS,
  defaultEnvelope,
  validateEnvelope,
  envelopeAllows,
} from '../src/queue/capability-envelope.mjs'
import { recordAttempt, readAttempts, memorySnapshotHash } from '../src/queue/attempt-ledger.mjs'

// ── the seed, and the sizes of the search ─────────────────────────────────────

/**
 * THE SEED. Every random choice in this file descends from it. Printed in every failure
 * message; change it only to widen the search, never to make a red run green — a seed
 * chosen so that nothing fails is a suite that proves nothing.
 */
export const INVARIANT_SEED = 20260804

/** How many independent histories are generated, and how long each one is. */
export const SEQUENCES = 12
export const STEPS_PER_SEQUENCE = 40
export const TASKS_PER_SEQUENCE = 4

/** The stamp fields canon invariant 6 fixes at attempt creation. */
const STAMP_FIELDS = Object.freeze(['policyVersion', 'memorySnapshotHash', 'planHash', 'harnessVersion'])

/** The dispositions `applyTransition` accepts for ACCEPTED (canon invariant 1). */
const AUTHORIZED_DISPOSITIONS = Object.freeze(['human-approved', 'authorized-policy'])

/** The replay recipe printed with every failure. */
const where = (sequence: number, step: number) =>
  `[seed=${INVARIANT_SEED} sequence=${sequence} step=${step}] ` +
  `replay: runSequence(${sequence}, dir) and stop after step ${step}`

// ── the deterministic generator (no clock, no environment, no unseeded source) ──

/**
 * A 32-bit integer mixer. Seeded from an integer, it produces the identical stream on
 * every machine and every run — which is the whole reason a property failure here is a bug
 * report somebody can act on rather than a rumour.
 */
function makeRng(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(rng: () => number, list: readonly T[]): T => list[Math.floor(rng() * list.length)]

// ── temp dirs (the ledger is REAL; only its location is temporary) ────────────

const tmpDirs: string[] = []
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
})

/**
 * One real memory-corpus digest, computed once. It is a REAL value from the shipped
 * function rather than a literal, so an attempt stamp in this suite carries the same kind
 * of thing a production stamp carries.
 */
const CORPUS_DIGEST: string = (() => {
  const dir = mkTmp('sma-inv-corpus-')
  writeFileSync(join(dir, 'a-note.md'), '---\nid: a-note\n---\n\nA canonical record.\n')
  return memorySnapshotHash({ corpusDir: dir })
})()

// ── the simulated fleet ───────────────────────────────────────────────────────

type Stamp = Record<string, string>

interface AttemptModel {
  attemptId: string
  attemptNo: number
  stamp: Stamp
  openedAtStep: number
}

interface EffectRecord {
  key: string
  effect: string
  transition: string
  attemptId: string
  applied: boolean
  step: number
}

interface TaskModel {
  taskId: string
  lane: string
  state: string
  envelope: any
  attempts: AttemptModel[]
  activeLeases: string[]
  appliedKeys: Set<string>
  effectLog: EffectRecord[]
  effectKeysEver: Set<string>
  history: { from: string; to: string; step: number; attemptId: string; disposition: string | null }[]
  leaseExpiries: number
  acceptedWith: { receiptRef?: string; disposition?: string } | null
  /** Anything that SHOULD have been refused and was not. A checker reports each by name. */
  breaches: { invariant: number; detail: string }[]
}

interface World {
  ledgerDir: string
  tasks: TaskModel[]
}

function newTask(rng: () => number, id: string, step = 0): TaskModel {
  const lane = pick(rng, ENVELOPE_LANES)
  return {
    taskId: `BL-${id}`,
    lane,
    state: 'READY',
    envelope: defaultEnvelope(lane),
    attempts: [],
    activeLeases: [],
    appliedKeys: new Set<string>(),
    effectLog: [],
    effectKeysEver: new Set<string>(),
    history: [],
    leaseExpiries: 0,
    acceptedWith: null,
    breaches: [],
  }
}

function openAttempt(t: TaskModel, step: number): AttemptModel {
  const attemptNo = t.attempts.length + 1
  const att: AttemptModel = {
    attemptId: `${t.taskId}#${attemptNo}`,
    attemptNo,
    // FIXED HERE, AT CREATION, AND NEVER TOUCHED AGAIN — that is canon invariant 6, and
    // checker six reads the durable ledger back to see whether it held.
    stamp: {
      policyVersion: `policy-v${attemptNo}`,
      memorySnapshotHash: CORPUS_DIGEST,
      planHash: `plan-${t.taskId}-${attemptNo}`,
      harnessVersion: `harness-1.${attemptNo}`,
    },
    openedAtStep: step,
  }
  t.attempts.push(att)
  return att
}

const currentAttempt = (t: TaskModel, step: number): AttemptModel =>
  t.attempts.length === 0 ? openAttempt(t, step) : t.attempts[t.attempts.length - 1]

/** Deterministic, derived from the step index — never from a clock. */
const stampedAt = (step: number) => `2026-08-04T00:${String(Math.floor(step / 60) % 60).padStart(2, '0')}:${String(step % 60).padStart(2, '0')}.000Z`

// ── the actions the generator may take ────────────────────────────────────────

const ACTION_KINDS = Object.freeze([
  'legal-transition',
  'legal-transition',
  'legal-transition',
  'illegal-transition',
  'duplicate-delivery',
  'lease-expiry',
  'worker-death',
  'new-attempt',
  'hostile-grant',
  'envelope-probe',
])

/**
 * Apply one generated action to one task through the REAL modules. Never throws on a
 * refusal — a refusal is the expected answer for most of these. When something that MUST
 * be refused is APPLIED instead, the breach is recorded on the task so the checker names
 * the invariant it broke rather than the line it happened on.
 */
function applyAction(kind: string, t: TaskModel, world: World, rng: () => number, step: number): string {
  const outgoing: any = (TRANSITIONS as any)[t.state]

  if (kind === 'legal-transition') {
    if (!outgoing) return 'skipped-terminal'
    const to = pick(rng, Object.keys(outgoing))
    const contract = transitionContract(t.state, to)
    if (!contract) return 'skipped-no-contract'
    const att = t.state === 'READY' && to === 'CLAIMED' ? openAttempt(t, step) : currentAttempt(t, step)

    // Deliberately withhold the receipt or the disposition a third of the time: the
    // invariant-1 falsification attempt is a caller trying to accept work on its own say-so.
    const withhold = rng() < 0.34
    const receiptRef = to === 'ACCEPTED' && withhold ? undefined : `reverify:${t.taskId}:${att.attemptNo}`
    const disposition =
      to === 'ACCEPTED' && withhold ? undefined : to === 'ACCEPTED' ? pick(rng, AUTHORIZED_DISPOSITIONS) : undefined

    const result: any = applyTransition({
      state: t.state,
      to,
      actor: contract.actor,
      taskId: t.taskId,
      attemptId: att.attemptId,
      attempt: att.attemptNo,
      receiptRef,
      disposition,
      appliedKeys: t.appliedKeys,
    })

    if (result.applied) {
      if (to === 'ACCEPTED' && withhold) {
        t.breaches.push({ invariant: 1, detail: `${t.state} -> ACCEPTED applied with no receipt and no authorized disposition` })
      }
      land(t, world, result, contract, to, step, { receiptRef, disposition })
      return `applied:${t.state}`
    }
    return result.alreadyApplied ? 'already-applied' : 'refused'
  }

  if (kind === 'illegal-transition') {
    const illegal = FLEET_STATES.filter((s: string) => !(outgoing && outgoing[s]))
    if (illegal.length === 0) return 'skipped-none-illegal'
    const to = pick(rng, illegal)
    const att = currentAttempt(t, step)
    const result: any = applyTransition({
      state: t.state,
      to,
      actor: 'dispatcher',
      taskId: t.taskId,
      attemptId: att.attemptId,
      attempt: att.attemptNo,
      appliedKeys: t.appliedKeys,
    })
    if (result.applied) {
      t.breaches.push({ invariant: 7, detail: `${t.state} -> ${to} was APPLIED although no contract declares it` })
    }
    return `illegal-refused:${to}`
  }

  if (kind === 'duplicate-delivery') {
    const last = t.history[t.history.length - 1]
    if (!last) return 'skipped-no-history'
    const contract = transitionContract(last.from, last.to)
    if (!contract) return 'skipped-no-contract'
    // A REDELIVERY is the same message again: the same task, the SAME attempt, the same
    // transition. Replaying under a different attempt id would be a NEW attempt performing
    // the same transition, which canon invariant 5 explicitly permits — so the attempt id
    // is taken from the history entry rather than from whatever attempt is current now.
    const att = t.attempts.find((a) => a.attemptId === last.attemptId) ?? currentAttempt(t, step)
    const result: any = applyTransition({
      state: last.from,
      to: last.to,
      actor: contract.actor,
      taskId: t.taskId,
      attemptId: att.attemptId,
      attempt: att.attemptNo,
      receiptRef: `reverify:${t.taskId}:${att.attemptNo}`,
      disposition: last.disposition ?? undefined,
      appliedKeys: t.appliedKeys,
    })
    // The redelivery must report itself as ALREADY APPLIED — not run the effect a second
    // time, and not be refused either: the effect DID happen (canon invariant 5).
    if (result.applied) {
      t.breaches.push({
        invariant: 5,
        detail: `a redelivery of ${last.from} -> ${last.to} under attempt ${att.attemptId} was APPLIED a second time`,
      })
      land(t, world, result, contract, last.to, step, {})
    } else if (result.alreadyApplied) {
      for (const effect of contract.externalEffects) {
        t.effectLog.push({
          key: result.idempotencyKey,
          effect,
          transition: `${last.from}->${last.to}`,
          attemptId: att.attemptId,
          applied: false,
          step,
        })
      }
    }
    return result.alreadyApplied ? 'redelivery-already-applied' : 'redelivery-refused'
  }

  if (kind === 'lease-expiry') {
    if (t.activeLeases.length === 0) return 'skipped-no-lease'
    t.activeLeases = []
    t.leaseExpiries += 1
    // The supervisor notices and moves the task to RETRYABLE where that edge exists. The
    // effects already recorded are NOT touched — canon invariant 4 is precisely that an
    // expiry says nothing about whether the outside world changed.
    const contract = transitionContract(t.state, 'RETRYABLE')
    if (contract) {
      const att = currentAttempt(t, step)
      const result: any = applyTransition({
        state: t.state,
        to: 'RETRYABLE',
        actor: contract.actor,
        taskId: t.taskId,
        attemptId: att.attemptId,
        attempt: att.attemptNo,
        appliedKeys: t.appliedKeys,
      })
      if (result.applied) land(t, world, result, contract, 'RETRYABLE', step, {})
    }
    return 'lease-expired'
  }

  if (kind === 'worker-death') {
    // The worker vanishes. No transition fires, no row is written, the lease simply stops
    // being refreshed. What must survive is the EVIDENCE: the attempt rows already in the
    // ledger (canon invariant 4 / the repudiation half of it).
    if (t.activeLeases.length === 0) return 'skipped-no-lease'
    t.activeLeases = []
    return 'worker-died'
  }

  if (kind === 'new-attempt') {
    if (t.state !== 'RETRYABLE') return 'skipped-not-retryable'
    const contract = transitionContract('RETRYABLE', 'READY')
    if (!contract) return 'skipped-no-contract'
    const att = openAttempt(t, step) // the precondition `new_attempt_created`, honoured
    const result: any = applyTransition({
      state: 'RETRYABLE',
      to: 'READY',
      actor: contract.actor,
      taskId: t.taskId,
      attemptId: att.attemptId,
      attempt: att.attemptNo,
      appliedKeys: t.appliedKeys,
    })
    if (result.applied) land(t, world, result, contract, 'READY', step, {})
    return 'new-attempt'
  }

  if (kind === 'hostile-grant') {
    // No input widens what a worker may do (canon invariant 2). The grant list is the
    // shape a prompt-borne escalation would take.
    const grant = pick(rng, ['git push', 'MERGE', 'push-to-origin', 'auto-merge', 'Push', 'merge --no-ff'])
    const to = outgoing ? pick(rng, Object.keys(outgoing)) : 'CLAIMED'
    const contract = transitionContract(t.state, to)
    const att = currentAttempt(t, step)
    const result: any = applyTransition({
      state: t.state,
      to,
      actor: contract ? contract.actor : 'dispatcher',
      taskId: t.taskId,
      attemptId: att.attemptId,
      attempt: att.attemptNo,
      receiptRef: `reverify:${t.taskId}`,
      disposition: 'human-approved',
      grants: [grant],
      appliedKeys: t.appliedKeys,
    })
    if (result.applied) {
      t.breaches.push({ invariant: 2, detail: `a transition carrying the grant "${grant}" was APPLIED` })
    }
    // The same escalation attempted through the envelope instead of the transition.
    const widened = { ...t.envelope, allowedTools: [...t.envelope.allowedTools, grant] }
    if (validateEnvelope(widened).valid) {
      t.breaches.push({ invariant: 2, detail: `an envelope declaring "${grant}" in allowedTools VALIDATED` })
    }
    return 'hostile-grant-refused'
  }

  // envelope-probe: the permit check, asked the forbidden question directly.
  const action = pick(rng, [...HUMAN_ONLY_ACTIONS, 'push', 'merge'])
  if (envelopeAllows(t.envelope, { action })) {
    t.breaches.push({ invariant: 2, detail: `envelopeAllows permitted the human-only action "${action}"` })
  }
  if (envelopeAllows(t.envelope, { action: 'write', path: '../../etc/passwd' })) {
    t.breaches.push({ invariant: 2, detail: 'envelopeAllows resolved a path traversal instead of refusing it' })
  }
  return `envelope-probe:${action}`
}

/**
 * Land an applied transition on the model AND in the durable ledger. This is the only
 * place the model's state moves, so every state change carries a real ledger row written
 * through the real `recordAttempt`.
 */
function land(
  t: TaskModel,
  world: World,
  result: any,
  contract: any,
  to: string,
  step: number,
  extra: { receiptRef?: string; disposition?: string },
): void {
  const att = t.attempts.find((a) => a.attemptId === result.attemptId) ?? currentAttempt(t, step)

  for (const effect of contract.externalEffects) {
    t.effectLog.push({
      key: result.idempotencyKey,
      effect,
      transition: `${t.state}->${to}`,
      attemptId: result.attemptId,
      applied: true,
      step,
    })
    t.effectKeysEver.add(result.idempotencyKey)
  }
  t.appliedKeys.add(result.idempotencyKey)
  t.history.push({ from: t.state, to, step, attemptId: result.attemptId, disposition: extra.disposition ?? null })

  if (t.state === 'READY' && to === 'CLAIMED') t.activeLeases = [`lease-${att.attemptId}`]
  if (to === 'RETRYABLE' || TERMINAL_STATES.includes(to) || to === 'READY') t.activeLeases = []
  if (to === 'ACCEPTED') t.acceptedWith = { receiptRef: extra.receiptRef, disposition: extra.disposition }

  recordAttempt(world.ledgerDir, {
    taskId: t.taskId,
    attempt: att.attemptNo,
    outcome: TERMINAL_STATES.includes(to) ? (to === 'ACCEPTED' ? 'completed' : 'failed') : undefined,
    receiptRef: extra.receiptRef,
    ...att.stamp,
    stateMachineVersion: result.stateMachineVersion,
    idempotencyKey: result.idempotencyKey,
    capabilityEnvelope: t.envelope,
    recordedAt: stampedAt(step),
  } as any)

  t.state = to
}

// ═══════════════════ THE SEVEN CHECKERS — one function per invariant ══════════
//
// Each returns `null` when the invariant holds, or a sentence naming what broke. They take
// the transition TABLE as an argument so the mutation battery can hand them a loosened one.

/** 1 — ACCEPTED requires a verification receipt AND an authorized disposition. */
function invariantOneAcceptedIsNeverSelfCertified(world: World): string | null {
  for (const t of world.tasks) {
    for (const b of t.breaches) if (b.invariant === 1) return `INVARIANT 1 (accepted needs a receipt): ${b.detail}`
    if (t.state !== 'ACCEPTED') continue
    const a = t.acceptedWith
    if (!a || !a.receiptRef || !AUTHORIZED_DISPOSITIONS.includes(String(a.disposition))) {
      return `INVARIANT 1 (accepted needs a receipt): task ${t.taskId} is ACCEPTED with receipt=${String(a?.receiptRef)} disposition=${String(a?.disposition)}`
    }
  }
  return null
}

/** 2 — no sequence of inputs produces a worker envelope that permits push or merge. */
function invariantTwoNoEnvelopeGrantsPushOrMerge(world: World): string | null {
  for (const t of world.tasks) {
    for (const b of t.breaches) if (b.invariant === 2) return `INVARIANT 2 (no push/merge capability): ${b.detail}`
    const verdict = validateEnvelope(t.envelope)
    if (!verdict.valid) {
      return `INVARIANT 2 (no push/merge capability): task ${t.taskId} holds an envelope its own validator refuses — ${verdict.refusal}`
    }
    for (const action of HUMAN_ONLY_ACTIONS) {
      if (envelopeAllows(t.envelope, { action })) {
        return `INVARIANT 2 (no push/merge capability): task ${t.taskId}'s envelope permits "${action}"`
      }
    }
    for (const key of ['readPaths', 'writePaths', 'allowedTools', 'networkDestinations', 'secretScopes']) {
      for (const entry of t.envelope[key] ?? []) {
        const low = String(entry).toLowerCase()
        if (low.includes('push') || low.includes('merge')) {
          return `INVARIANT 2 (no push/merge capability): task ${t.taskId} declares "${entry}" under ${key}`
        }
      }
    }
  }
  return null
}

/** 3 — at most one ACTIVE lease per task; any number of immutable attempts. */
function invariantThreeAtMostOneActiveLease(world: World): string | null {
  for (const t of world.tasks) {
    for (const b of t.breaches) if (b.invariant === 3) return `INVARIANT 3 (one active lease): ${b.detail}`
    if (t.activeLeases.length > 1) {
      return `INVARIANT 3 (one active lease): task ${t.taskId} holds ${t.activeLeases.length} active leases (${t.activeLeases.join(', ')})`
    }
    const ids = new Set(t.attempts.map((a) => a.attemptId))
    if (ids.size !== t.attempts.length) {
      return `INVARIANT 3 (one active lease): task ${t.taskId} has ${t.attempts.length} attempts but only ${ids.size} distinct attempt ids — an attempt was reused instead of created`
    }
    for (let i = 0; i < t.attempts.length; i += 1) {
      if (t.attempts[i].attemptNo !== i + 1) {
        return `INVARIANT 3 (one active lease): task ${t.taskId}'s attempt list is not append-only at index ${i}`
      }
    }
  }
  return null
}

/** 4 — a lease expiry never unsays an external effect. */
function invariantFourLeaseExpiryDoesNotUnsayAnEffect(world: World): string | null {
  for (const t of world.tasks) {
    for (const b of t.breaches) if (b.invariant === 4) return `INVARIANT 4 (an expiry unsays nothing): ${b.detail}`
    const present = new Set(t.effectLog.filter((e) => e.applied).map((e) => e.key))
    for (const key of t.effectKeysEver) {
      if (!present.has(key)) {
        return `INVARIANT 4 (an expiry unsays nothing): task ${t.taskId} recorded effect key ${key} and then lost it after ${t.leaseExpiries} lease expiries`
      }
    }
  }
  return null
}

/** 5 — a retried effect reuses its key and is applied at most once per attempt. */
function invariantFiveOneEffectIsAppliedOnce(world: World): string | null {
  for (const t of world.tasks) {
    for (const b of t.breaches) if (b.invariant === 5) return `INVARIANT 5 (an effect is applied once): ${b.detail}`
    const appliedPerTriple = new Map<string, number>()
    for (const e of t.effectLog) {
      // The key must BE the deterministic function of the triple — a redelivery cannot
      // mint itself a fresh one by asking again.
      const expected = idempotencyKey(t.taskId, e.attemptId, e.transition)
      if (e.key !== expected) {
        return `INVARIANT 5 (an effect is applied once): task ${t.taskId} recorded effect ${e.effect} under key ${e.key}, but the triple (${t.taskId}, ${e.attemptId}, ${e.transition}) keys to ${expected}`
      }
      if (!e.applied) continue
      const triple = `${e.attemptId}|${e.transition}|${e.effect}`
      const n = (appliedPerTriple.get(triple) ?? 0) + 1
      appliedPerTriple.set(triple, n)
      if (n > 1) {
        return `INVARIANT 5 (an effect is applied once): task ${t.taskId} applied ${e.effect} ${n} times for one attempt and one transition (${triple})`
      }
    }
  }
  return null
}

/** 6 — the attempt stamp is fixed at attempt creation and never mutated. */
function invariantSixTheAttemptStampNeverMoves(world: World): string | null {
  for (const t of world.tasks) {
    for (const b of t.breaches) if (b.invariant === 6) return `INVARIANT 6 (the stamp never moves): ${b.detail}`
    const rows = readAttempts(world.ledgerDir, t.taskId)
    const firstSeen = new Map<number, any>()
    for (const row of rows) {
      const prior = firstSeen.get(row.attempt)
      if (!prior) {
        firstSeen.set(row.attempt, row)
      } else {
        for (const f of STAMP_FIELDS) {
          if (row[f] !== prior[f]) {
            return `INVARIANT 6 (the stamp never moves): task ${t.taskId} attempt ${row.attempt} recorded ${f}="${String(prior[f])}" and later "${String(row[f])}"`
          }
        }
      }
      const att = t.attempts.find((a) => a.attemptNo === row.attempt)
      if (att) {
        for (const f of STAMP_FIELDS) {
          if (row[f] !== att.stamp[f]) {
            return `INVARIANT 6 (the stamp never moves): task ${t.taskId} attempt ${row.attempt} carries ${f}="${String(row[f])}" but the attempt was created with "${att.stamp[f]}"`
          }
        }
      }
      if (row.stateMachineVersion !== undefined && row.stateMachineVersion !== STATE_MACHINE_VERSION) {
        return `INVARIANT 6 (the stamp never moves): task ${t.taskId} attempt ${row.attempt} carries stateMachineVersion="${String(row.stateMachineVersion)}", not "${STATE_MACHINE_VERSION}"`
      }
    }
  }
  return null
}

/** 7 — a dead-letter task does not return to READY without an explicit disposition. */
function invariantSevenDeadLetterNeedsADisposition(world: World, table: any = TRANSITIONS): string | null {
  // Half one: the TABLE. A terminal state with an outgoing contract is a way out that
  // nobody has to ask for, which is the invariant broken before any task exists.
  for (const terminal of TERMINAL_STATES) {
    const outgoing = table[terminal]
    if (outgoing && Object.keys(outgoing).length > 0) {
      return `INVARIANT 7 (dead-letter needs a disposition): the transition table declares ${terminal} -> ${Object.keys(outgoing).join(', ')}, but ${terminal} is terminal`
    }
  }
  // Half two: the HISTORY.
  for (const t of world.tasks) {
    for (const b of t.breaches) if (b.invariant === 7) return `INVARIANT 7 (dead-letter needs a disposition): ${b.detail}`
    for (const h of t.history) {
      if (h.from === 'DEAD_LETTER') {
        return `INVARIANT 7 (dead-letter needs a disposition): task ${t.taskId} moved DEAD_LETTER -> ${h.to} at step ${h.step} with disposition=${String(h.disposition)}`
      }
    }
  }
  return null
}

/** The seven, by name. A failure says WHICH invariant broke, never which line. */
const INVARIANTS = Object.freeze([
  { n: 1, name: 'invariantOneAcceptedIsNeverSelfCertified', check: invariantOneAcceptedIsNeverSelfCertified },
  { n: 2, name: 'invariantTwoNoEnvelopeGrantsPushOrMerge', check: invariantTwoNoEnvelopeGrantsPushOrMerge },
  { n: 3, name: 'invariantThreeAtMostOneActiveLease', check: invariantThreeAtMostOneActiveLease },
  { n: 4, name: 'invariantFourLeaseExpiryDoesNotUnsayAnEffect', check: invariantFourLeaseExpiryDoesNotUnsayAnEffect },
  { n: 5, name: 'invariantFiveOneEffectIsAppliedOnce', check: invariantFiveOneEffectIsAppliedOnce },
  { n: 6, name: 'invariantSixTheAttemptStampNeverMoves', check: invariantSixTheAttemptStampNeverMoves },
  { n: 7, name: 'invariantSevenDeadLetterNeedsADisposition', check: invariantSevenDeadLetterNeedsADisposition },
])

function checkAll(world: World, table: any = TRANSITIONS): string | null {
  for (const inv of INVARIANTS) {
    const violation = inv.check(world, table)
    if (violation) return violation
  }
  return null
}

// ── the driver ────────────────────────────────────────────────────────────────

function runSequence(
  sequence: number,
  ledgerDir: string,
  onStep?: (world: World, step: number) => void,
): { world: World; trace: string[] } {
  const rng = makeRng(INVARIANT_SEED + sequence * 7919)
  const world: World = { ledgerDir, tasks: [] }
  for (let i = 0; i < TASKS_PER_SEQUENCE; i += 1) world.tasks.push(newTask(rng, `${sequence}-${i}`))

  const trace: string[] = []
  for (let step = 1; step <= STEPS_PER_SEQUENCE; step += 1) {
    const t = pick(rng, world.tasks)
    const kind = pick(rng, ACTION_KINDS)
    const label = applyAction(kind, t, world, rng, step)
    trace.push(`${step}|${t.taskId}|${kind}|${label}|${t.state}`)
    if (onStep) onStep(world, step)
  }
  return { world, trace }
}

// ═════════════════════════════ the suite ══════════════════════════════════════

describe('fleet invariants — the seven, named and callable', () => {
  it('exposes exactly seven named invariant checkers, numbered 1..7', () => {
    expect(INVARIANTS).toHaveLength(7)
    expect(INVARIANTS.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7])
    for (const inv of INVARIANTS) {
      expect(typeof inv.check).toBe('function')
      expect(inv.check.name).toBe(inv.name)
    }
  })

  it('every fleet state maps down onto a queue status — no state strands a task', () => {
    for (const state of FLEET_STATES) expect(toQueueStatus(state)).not.toBeNull()
  })
})

describe('fleet invariants — seeded random sequences (the property run)', () => {
  it(`holds all seven after every step of ${SEQUENCES} sequences x ${STEPS_PER_SEQUENCE} steps`, () => {
    const ledgerDir = mkTmp('sma-inv-ledger-')
    let steps = 0
    for (let sequence = 0; sequence < SEQUENCES; sequence += 1) {
      runSequence(sequence, ledgerDir, (world, step) => {
        steps += 1
        const violation = checkAll(world)
        expect(violation === null ? null : `${where(sequence, step)} — ${violation}`).toBeNull()
      })
    }
    expect(steps).toBe(SEQUENCES * STEPS_PER_SEQUENCE)
  })

  it('is replayable: two runs of the same seed produce a byte-identical trace and the same case count', () => {
    const first = { dir: mkTmp('sma-inv-replay-a-'), traces: [] as string[] }
    const second = { dir: mkTmp('sma-inv-replay-b-'), traces: [] as string[] }
    for (let sequence = 0; sequence < SEQUENCES; sequence += 1) {
      first.traces.push(runSequence(sequence, first.dir).trace.join('\n'))
      second.traces.push(runSequence(sequence, second.dir).trace.join('\n'))
    }
    expect(second.traces).toEqual(first.traces)
    expect(first.traces.join('\n').split('\n')).toHaveLength(SEQUENCES * STEPS_PER_SEQUENCE)
  })

  it('the sequences actually exercise the fleet — applied transitions, refusals, effects and multiple attempts all occur', () => {
    const ledgerDir = mkTmp('sma-inv-coverage-')
    let applied = 0
    let refused = 0
    let redeliveries = 0
    let effects = 0
    let extraAttempts = 0
    const statesSeen = new Set<string>()
    for (let sequence = 0; sequence < SEQUENCES; sequence += 1) {
      const { world, trace } = runSequence(sequence, ledgerDir)
      for (const line of trace) {
        if (line.includes('|applied:')) applied += 1
        if (line.includes('refused')) refused += 1
        if (line.includes('redelivery-already-applied')) redeliveries += 1
      }
      for (const t of world.tasks) {
        effects += t.effectLog.length
        if (t.attempts.length > 1) extraAttempts += 1
        statesSeen.add(t.state)
        for (const h of t.history) statesSeen.add(h.to)
      }
    }
    // A property run that never applies anything proves nothing about anything.
    expect(applied).toBeGreaterThan(50)
    expect(refused).toBeGreaterThan(50)
    // Invariant 5 is only meaningfully checked over histories where a redelivery LANDED.
    // If this ever drops to zero the property run has stopped exercising the invariant.
    expect(redeliveries).toBeGreaterThan(0)
    expect(effects).toBeGreaterThan(10)
    expect(extraAttempts).toBeGreaterThan(0)
    expect(statesSeen.size).toBeGreaterThanOrEqual(6)
  })
})

// ══════════════════ THE MUTATION BATTERY — can this suite fail? ═══════════════
//
// One deliberately broken world per invariant, each asserted to be DETECTED. Without
// these, a green property run would prove only that the driver ran.

describe('fleet invariants — the mutation battery (each checker is proven able to fail)', () => {
  const emptyWorld = (dir: string): World => ({ ledgerDir: dir, tasks: [] })
  const oneTask = (dir: string): { world: World; t: TaskModel } => {
    const world = emptyWorld(dir)
    const t = newTask(makeRng(1), 'mutant')
    world.tasks.push(t)
    return { world, t }
  }

  it('1 — an ACCEPTED task with no receipt is reported', () => {
    const { world, t } = oneTask(mkTmp('sma-inv-mut1-'))
    t.state = 'ACCEPTED'
    t.acceptedWith = { receiptRef: undefined, disposition: 'worker-says-it-is-fine' }
    expect(invariantOneAcceptedIsNeverSelfCertified(world)).toMatch(/INVARIANT 1/)
    expect(checkAll(world)).toMatch(/INVARIANT 1/)
  })

  it('2 — an envelope widened with a push tool is reported', () => {
    const { world, t } = oneTask(mkTmp('sma-inv-mut2-'))
    t.envelope = { ...t.envelope, allowedTools: [...t.envelope.allowedTools, 'GitPush'] }
    expect(invariantTwoNoEnvelopeGrantsPushOrMerge(world)).toMatch(/INVARIANT 2/)
  })

  it('3 — a task holding two active leases is reported', () => {
    const { world, t } = oneTask(mkTmp('sma-inv-mut3-'))
    t.activeLeases = ['lease-a', 'lease-b']
    expect(invariantThreeAtMostOneActiveLease(world)).toMatch(/INVARIANT 3/)
  })

  it('4 — an effect that was recorded and then retracted is reported', () => {
    const { world, t } = oneTask(mkTmp('sma-inv-mut4-'))
    t.effectKeysEver.add('deadbeefdeadbeef')
    t.leaseExpiries = 1
    expect(invariantFourLeaseExpiryDoesNotUnsayAnEffect(world)).toMatch(/INVARIANT 4/)
  })

  it('5 — one effect applied twice under one attempt and one transition is reported', () => {
    const { world, t } = oneTask(mkTmp('sma-inv-mut5-'))
    const attemptId = `${t.taskId}#1`
    const transition = 'CLAIMED->RUNNING'
    const key = idempotencyKey(t.taskId, attemptId, transition)
    for (let i = 0; i < 2; i += 1) {
      t.effectLog.push({ key, effect: 'worker_process_started', transition, attemptId, applied: true, step: i + 1 })
    }
    expect(invariantFiveOneEffectIsAppliedOnce(world)).toMatch(/INVARIANT 5/)
  })

  it('5b — an effect key that is not the deterministic key of its own triple is reported', () => {
    const { world, t } = oneTask(mkTmp('sma-inv-mut5b-'))
    t.effectLog.push({
      key: 'aaaaaaaaaaaaaaaa',
      effect: 'worker_process_started',
      transition: 'CLAIMED->RUNNING',
      attemptId: `${t.taskId}#1`,
      applied: true,
      step: 1,
    })
    expect(invariantFiveOneEffectIsAppliedOnce(world)).toMatch(/INVARIANT 5/)
  })

  it('6 — a ledger whose stamp changed between two rows of one attempt is reported', () => {
    const dir = mkTmp('sma-inv-mut6-')
    const { world, t } = oneTask(dir)
    openAttempt(t, 1)
    recordAttempt(dir, { taskId: t.taskId, attempt: 1, ...t.attempts[0].stamp, recordedAt: stampedAt(1) } as any)
    recordAttempt(dir, {
      taskId: t.taskId,
      attempt: 1,
      ...t.attempts[0].stamp,
      policyVersion: 'policy-rewritten-after-the-fact',
      recordedAt: stampedAt(2),
    } as any)
    expect(invariantSixTheAttemptStampNeverMoves(world)).toMatch(/INVARIANT 6/)
  })

  it('7 — a transition table loosened to declare DEAD_LETTER -> READY is reported', () => {
    const { world } = oneTask(mkTmp('sma-inv-mut7-'))
    // The mutant: one contract added that lets a dead-lettered task walk back into the
    // queue with nobody deciding anything.
    const loosened = {
      ...TRANSITIONS,
      DEAD_LETTER: {
        READY: {
          actor: 'dispatcher',
          preconditions: [],
          writes: ['attempt_row'],
          externalEffects: [],
          retryPolicy: 'create_new_attempt',
          nextStates: ['CLAIMED'],
        },
      },
    }
    expect(invariantSevenDeadLetterNeedsADisposition(world, TRANSITIONS)).toBeNull()
    expect(invariantSevenDeadLetterNeedsADisposition(world, loosened)).toMatch(/INVARIANT 7/)
    expect(checkAll(world, loosened)).toMatch(/INVARIANT 7/)
  })

  it('7b — a history containing a DEAD_LETTER exit is reported', () => {
    const { world, t } = oneTask(mkTmp('sma-inv-mut7b-'))
    t.history.push({ from: 'DEAD_LETTER', to: 'READY', step: 3, disposition: null })
    expect(invariantSevenDeadLetterNeedsADisposition(world)).toMatch(/INVARIANT 7/)
  })

  it('the real modules still refuse the mutant transition — the loosened table is a TEST fixture only', () => {
    const refused: any = applyTransition({
      state: 'DEAD_LETTER',
      to: 'READY',
      actor: 'dispatcher',
      taskId: 'BL-mutant',
      attemptId: 'BL-mutant#1',
    })
    expect(refused.applied).toBe(false)
    expect(refused.refusal).toMatch(/canon invariant 7/)
    expect(transitionContract('DEAD_LETTER', 'READY')).toBeNull()
  })
})
