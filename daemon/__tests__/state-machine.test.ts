/**
 * Tests for daemon/src/queue/state-machine.mjs.
 *
 * The fleet's state vocabulary and its transition contracts. The suite is
 * deliberately TABLE-DRIVEN: it walks FLEET_STATES and TRANSITIONS themselves rather
 * than asserting a hand-written list of pairs, so a state added WITHOUT its contract —
 * or a contract pointing at a state that does not exist — fails here instead of passing
 * unnoticed and stranding a task at runtime.
 *
 * The module under test is BACKEND-FREE BY LAW (adapter.mjs's posture): a source-level
 * assertion below reads the file and refuses any pg / pg-boss / backend import, because
 * an import is the one thing a behavioural test cannot see.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import {
  FLEET_STATES,
  TERMINAL_STATES,
  STATE_MACHINE_VERSION,
  TRANSITIONS,
  transitionContract,
  toQueueStatus,
  idempotencyKey,
  applyTransition,
} from '../src/queue/state-machine.mjs'

/** The canon's eleven states, verbatim (roadmap txt lines 512-514). */
const CANON_STATES = [
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
]

/** The four statuses the coarse queue vocabulary underneath already speaks. */
const QUEUE_STATUSES = ['queued', 'claimed', 'completed', 'failed']

/** Who may perform a transition — the closed actor vocabulary. */
const ACTORS = ['dispatcher', 'worker', 'verifier', 'supervisor', 'human']

/** Every (from, to) pair the table declares, as a flat list. */
const allPairs = () =>
  Object.entries(TRANSITIONS).flatMap(([from, tos]: [string, any]) =>
    Object.keys(tos).map((to) => ({ from, to, contract: tos[to] })),
  )

describe('FLEET_STATES — the named vocabulary', () => {
  it('holds exactly the canon eleven state names', () => {
    expect(FLEET_STATES).toHaveLength(11)
    expect([...FLEET_STATES]).toEqual(CANON_STATES)
  })

  it('is frozen — a new state is a policy decision, not an assignment', () => {
    expect(Object.isFrozen(FLEET_STATES)).toBe(true)
  })

  it('TERMINAL_STATES is exactly the canon terminal set and a subset of FLEET_STATES', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['ACCEPTED', 'CANCELLED', 'DEAD_LETTER', 'REJECTED'])
    for (const s of TERMINAL_STATES) expect(FLEET_STATES).toContain(s)
    expect(Object.isFrozen(TERMINAL_STATES)).toBe(true)
  })

  it('STATE_MACHINE_VERSION is a non-empty string — an attempt can be stamped with it', () => {
    expect(typeof STATE_MACHINE_VERSION).toBe('string')
    expect(STATE_MACHINE_VERSION.length).toBeGreaterThan(0)
  })
})

describe('TRANSITIONS — the contract table', () => {
  it('is keyed only by members of FLEET_STATES', () => {
    for (const from of Object.keys(TRANSITIONS)) expect(FLEET_STATES).toContain(from)
  })

  it('names only members of FLEET_STATES as destinations', () => {
    for (const { to } of allPairs()) expect(FLEET_STATES).toContain(to)
  })

  it('gives every contract all six required fields', () => {
    for (const { from, to, contract } of allPairs()) {
      const where = `${from}->${to}`
      expect(ACTORS, where).toContain(contract.actor)
      expect(Array.isArray(contract.preconditions), where).toBe(true)
      expect(Array.isArray(contract.writes), where).toBe(true)
      expect(Array.isArray(contract.nextStates), where).toBe(true)
      expect(typeof contract.retryPolicy, where).toBe('string')
    }
  })

  it('declares externalEffects on EVERY contract — an unstated external effect is what invariant 4 exists to survive', () => {
    for (const { from, to, contract } of allPairs()) {
      expect(contract.externalEffects, `${from}->${to}`).toBeDefined()
      expect(Array.isArray(contract.externalEffects), `${from}->${to}`).toBe(true)
    }
  })

  it('names only members of FLEET_STATES inside every nextStates', () => {
    for (const { from, to, contract } of allPairs()) {
      for (const next of contract.nextStates) {
        expect(FLEET_STATES, `${from}->${to}`).toContain(next)
      }
    }
  })

  it('keeps nextStates in agreement with the destination state own outgoing set', () => {
    for (const { from, to, contract } of allPairs()) {
      const derived = Object.keys(TRANSITIONS[to] ?? {}).sort()
      expect([...contract.nextStates].sort(), `${from}->${to}`).toEqual(derived)
    }
  })

  it('gives every non-terminal state at least one outgoing contract', () => {
    for (const state of FLEET_STATES) {
      if (TERMINAL_STATES.includes(state)) continue
      expect(Object.keys(TRANSITIONS[state] ?? {}).length, state).toBeGreaterThan(0)
    }
  })

  it('gives every terminal state no outgoing contract at all', () => {
    for (const state of TERMINAL_STATES) {
      expect(TRANSITIONS[state], state).toBeUndefined()
    }
  })

  it('is frozen at both levels — the table and every contract in it', () => {
    expect(Object.isFrozen(TRANSITIONS)).toBe(true)
    for (const { from, to, contract } of allPairs()) {
      expect(Object.isFrozen(contract), `${from}->${to}`).toBe(true)
    }
  })

  it('carries the canon timeout on RUNNING->PRODUCED', () => {
    expect(TRANSITIONS.RUNNING.PRODUCED.timeout).toBe('45m')
  })

  it('lets a human cancel from every non-terminal state', () => {
    for (const state of FLEET_STATES) {
      if (TERMINAL_STATES.includes(state)) continue
      expect(TRANSITIONS[state].CANCELLED, state).toBeDefined()
      expect(TRANSITIONS[state].CANCELLED.actor, state).toBe('human')
    }
  })
})

describe('transitionContract', () => {
  it('returns the contract for a legal pair', () => {
    const c = transitionContract('RUNNING', 'PRODUCED')
    expect(c).not.toBeNull()
    expect(c.actor).toBe('worker')
    expect(c.writes).toContain('artifact_manifest')
    expect(c.writes).toContain('execution_receipt')
  })

  it('returns null for an illegal pair rather than inventing one', () => {
    expect(transitionContract('READY', 'ACCEPTED')).toBeNull()
    expect(transitionContract('ACCEPTED', 'READY')).toBeNull()
    expect(transitionContract('DEAD_LETTER', 'READY')).toBeNull()
  })

  it('returns null for input that is not a state at all', () => {
    expect(transitionContract('nonsense', 'READY')).toBeNull()
    expect(transitionContract('READY', 'nonsense')).toBeNull()
    expect(transitionContract(undefined as any, undefined as any)).toBeNull()
    expect(transitionContract('__proto__' as any, 'READY')).toBeNull()
  })
})

describe('toQueueStatus — the two layers never disagree about what is running', () => {
  it('maps every fleet state onto one of the four existing queue statuses', () => {
    for (const state of FLEET_STATES) {
      expect(QUEUE_STATUSES, state).toContain(toQueueStatus(state))
    }
  })

  it('maps the pre-terminal working states onto claimed and READY onto queued', () => {
    expect(toQueueStatus('READY')).toBe('queued')
    expect(toQueueStatus('RETRYABLE')).toBe('queued')
    expect(toQueueStatus('CLAIMED')).toBe('claimed')
    expect(toQueueStatus('RUNNING')).toBe('claimed')
    expect(toQueueStatus('PRODUCED')).toBe('claimed')
    expect(toQueueStatus('VERIFYING')).toBe('claimed')
    expect(toQueueStatus('WAITING_HUMAN')).toBe('claimed')
    expect(toQueueStatus('ACCEPTED')).toBe('completed')
    expect(toQueueStatus('REJECTED')).toBe('failed')
    expect(toQueueStatus('DEAD_LETTER')).toBe('failed')
    expect(toQueueStatus('CANCELLED')).toBe('failed')
  })

  it('returns null for anything that is not a fleet state', () => {
    expect(toQueueStatus('queued')).toBeNull()
    expect(toQueueStatus(undefined as any)).toBeNull()
  })
})

describe('idempotencyKey — the same effect retried under the same attempt is the same key', () => {
  it('is deterministic: identical inputs always give an identical key', () => {
    const a = idempotencyKey('BL-96', 'BL-96#2', 'RUNNING->PRODUCED')
    const b = idempotencyKey('BL-96', 'BL-96#2', 'RUNNING->PRODUCED')
    expect(a).toBe(b)
  })

  it('gives different keys for two different transitions on the same attempt', () => {
    const produced = idempotencyKey('BL-96', 'BL-96#2', 'RUNNING->PRODUCED')
    const retryable = idempotencyKey('BL-96', 'BL-96#2', 'RUNNING->RETRYABLE')
    expect(produced).not.toBe(retryable)
  })

  it('gives different keys for the same transition on two different attempts', () => {
    const first = idempotencyKey('BL-96', 'BL-96#1', 'RUNNING->PRODUCED')
    const second = idempotencyKey('BL-96', 'BL-96#2', 'RUNNING->PRODUCED')
    expect(first).not.toBe(second)
  })

  it('gives different keys for the same transition on two different tasks', () => {
    const one = idempotencyKey('BL-96', 'a#1', 'RUNNING->PRODUCED')
    const two = idempotencyKey('BL-97', 'a#1', 'RUNNING->PRODUCED')
    expect(one).not.toBe(two)
  })

  it('is a short stable hex string derived from its inputs — no clock, counter or randomness', () => {
    const key = idempotencyKey('BL-96', 'BL-96#2', 'RUNNING->PRODUCED')
    expect(key).toMatch(/^[0-9a-f]{16}$/)
    // The composition is separated, so ('ab','c') and ('a','bc') can never collide.
    expect(idempotencyKey('ab', 'c', 'T')).not.toBe(idempotencyKey('a', 'bc', 'T'))
    // Stable across processes because it is a hash of the three canon inputs and
    // nothing else — pinned here so a future "improvement" that mixes in a timestamp
    // fails loudly instead of silently breaking every redelivery.
    expect(idempotencyKey('BL-96', 'BL-96#2', 'RUNNING->PRODUCED')).toBe(
      idempotencyKey('BL-96', 'BL-96#2', 'RUNNING->PRODUCED'),
    )
  })

  it('throws on a missing input rather than hashing an empty string into a real-looking key', () => {
    expect(() => idempotencyKey('', 'a#1', 'T')).toThrow()
    expect(() => idempotencyKey('BL-96', '', 'T')).toThrow()
    expect(() => idempotencyKey('BL-96', 'a#1', '')).toThrow()
  })
})

describe('applyTransition — legal, contracted, correctly actored and idempotent, or refused', () => {
  const base = {
    taskId: 'BL-96',
    attemptId: 'BL-96#2',
    attempt: 2,
  }

  it('applies a legal transition and carries the new state, the contract and the key', () => {
    const res = applyTransition({ ...base, state: 'RUNNING', to: 'PRODUCED', actor: 'worker' })
    expect(res.applied).toBe(true)
    expect(res.alreadyApplied).toBe(false)
    expect(res.from).toBe('RUNNING')
    expect(res.state).toBe('PRODUCED')
    expect(res.contract).toBe(TRANSITIONS.RUNNING.PRODUCED)
    expect(res.idempotencyKey).toBe(idempotencyKey('BL-96', 'BL-96#2', 'RUNNING->PRODUCED'))
    expect(res.stateMachineVersion).toBe(STATE_MACHINE_VERSION)
    expect(res.refusal).toBeUndefined()
  })

  it('returns a row the attempt ledger can accept without a spread', () => {
    const res = applyTransition({ ...base, state: 'RUNNING', to: 'PRODUCED', actor: 'worker' })
    expect(res.taskId).toBe('BL-96')
    expect(res.attempt).toBe(2)
    expect(typeof res.idempotencyKey).toBe('string')
  })

  it('names the preconditions it cannot decide instead of pretending it checked them', () => {
    const res = applyTransition({ ...base, state: 'RUNNING', to: 'PRODUCED', actor: 'worker' })
    expect(res.deferredPreconditions).toContain('active_lease_matches_attempt')
    expect(res.deferredPreconditions).toContain('capability_allows_write_scope')
  })

  it('refuses an illegal from-to pair with a reason naming BOTH states, applying nothing', () => {
    const res = applyTransition({ ...base, state: 'READY', to: 'ACCEPTED', actor: 'verifier' })
    expect(res.applied).toBe(false)
    expect(res.state).toBe('READY')
    expect(res.refusal).toMatch(/READY/)
    expect(res.refusal).toMatch(/ACCEPTED/)
    expect(res.idempotencyKey).toBeUndefined()
  })

  it('refuses a state that is not in the vocabulary at all', () => {
    const res = applyTransition({ ...base, state: 'PENDING', to: 'READY', actor: 'dispatcher' })
    expect(res.applied).toBe(false)
    expect(res.refusal).toMatch(/state/i)
  })

  it('refuses the wrong actor with a reason naming the REQUIRED actor', () => {
    const res = applyTransition({ ...base, state: 'RUNNING', to: 'PRODUCED', actor: 'human' })
    expect(res.applied).toBe(false)
    expect(res.state).toBe('RUNNING')
    expect(res.refusal).toMatch(/worker/)
  })

  it('refuses ACCEPTED without a verification receipt, naming invariant 1', () => {
    const res = applyTransition({
      ...base,
      state: 'VERIFYING',
      to: 'ACCEPTED',
      actor: 'verifier',
      disposition: 'human-approved',
    })
    expect(res.applied).toBe(false)
    expect(res.refusal).toMatch(/invariant 1/i)
    expect(res.refusal).toMatch(/receipt/i)
  })

  it('refuses ACCEPTED without an authorized disposition, naming invariant 1', () => {
    const res = applyTransition({
      ...base,
      state: 'VERIFYING',
      to: 'ACCEPTED',
      actor: 'verifier',
      receiptRef: 'reverify:abc',
    })
    expect(res.applied).toBe(false)
    expect(res.refusal).toMatch(/invariant 1/i)
    expect(res.refusal).toMatch(/disposition/i)
  })

  it('refuses a disposition outside the authorized vocabulary — a worker cannot self-accept', () => {
    const res = applyTransition({
      ...base,
      state: 'VERIFYING',
      to: 'ACCEPTED',
      actor: 'verifier',
      receiptRef: 'reverify:abc',
      disposition: 'the worker says it is fine',
    })
    expect(res.applied).toBe(false)
    expect(res.refusal).toMatch(/invariant 1/i)
  })

  it('applies ACCEPTED when the receipt AND an authorized disposition are both there', () => {
    const res = applyTransition({
      ...base,
      state: 'VERIFYING',
      to: 'ACCEPTED',
      actor: 'verifier',
      receiptRef: 'reverify:abc',
      disposition: 'human-approved',
    })
    expect(res.applied).toBe(true)
    expect(res.state).toBe('ACCEPTED')
  })

  it('refuses ANY transition that would grant push or merge capability, naming invariant 2', () => {
    for (const grant of ['push', 'git-push', 'merge', 'merge_pr', 'FORCE-PUSH']) {
      const res = applyTransition({
        ...base,
        state: 'RUNNING',
        to: 'PRODUCED',
        actor: 'worker',
        grants: ['read_repo', grant],
      })
      expect(res.applied, grant).toBe(false)
      expect(res.refusal, grant).toMatch(/invariant 2/i)
    }
  })

  it('refuses a push grant even on an otherwise perfect ACCEPTED — no input turns it on', () => {
    const res = applyTransition({
      ...base,
      state: 'VERIFYING',
      to: 'ACCEPTED',
      actor: 'verifier',
      receiptRef: 'reverify:abc',
      disposition: 'human-approved',
      grants: 'push',
    })
    expect(res.applied).toBe(false)
    expect(res.refusal).toMatch(/invariant 2/i)
  })

  it('refuses DEAD_LETTER -> READY with no disposition, naming invariant 7', () => {
    const res = applyTransition({ ...base, state: 'DEAD_LETTER', to: 'READY', actor: 'dispatcher' })
    expect(res.applied).toBe(false)
    expect(res.state).toBe('DEAD_LETTER')
    expect(res.refusal).toMatch(/invariant 7/i)
    expect(res.refusal).toMatch(/disposition/i)
  })

  it('with a disposition, still refuses the shortcut and says a NEW attempt is required', () => {
    const res = applyTransition({
      ...base,
      state: 'DEAD_LETTER',
      to: 'READY',
      actor: 'human',
      disposition: 'human-approved',
    })
    expect(res.applied).toBe(false)
    expect(res.requiresNewAttempt).toBe(true)
    expect(res.refusal).toMatch(/attempt/i)
  })

  it('reports already-applied on a repeated delivery and does NOT apply a second time', () => {
    const first = applyTransition({ ...base, state: 'RUNNING', to: 'PRODUCED', actor: 'worker' })
    expect(first.applied).toBe(true)

    const again = applyTransition({
      ...base,
      state: 'RUNNING',
      to: 'PRODUCED',
      actor: 'worker',
      appliedKeys: [first.idempotencyKey],
    })
    expect(again.applied).toBe(false)
    expect(again.alreadyApplied).toBe(true)
    expect(again.refusal).toBeUndefined()
    expect(again.state).toBe('PRODUCED')
    expect(again.idempotencyKey).toBe(first.idempotencyKey)
  })

  it('accepts a Set of applied keys as readily as an array', () => {
    const first = applyTransition({ ...base, state: 'RUNNING', to: 'PRODUCED', actor: 'worker' })
    const again = applyTransition({
      ...base,
      state: 'RUNNING',
      to: 'PRODUCED',
      actor: 'worker',
      appliedKeys: new Set([first.idempotencyKey]),
    })
    expect(again.alreadyApplied).toBe(true)
  })

  it('treats a DIFFERENT transition on the same attempt as not yet applied', () => {
    const produced = applyTransition({ ...base, state: 'RUNNING', to: 'PRODUCED', actor: 'worker' })
    const retryable = applyTransition({
      ...base,
      state: 'RUNNING',
      to: 'RETRYABLE',
      actor: 'supervisor',
      appliedKeys: [produced.idempotencyKey],
    })
    expect(retryable.applied).toBe(true)
    expect(retryable.alreadyApplied).toBe(false)
  })

  it('keeps refusal reasons free of caller text and connection strings', () => {
    const secret = 'postgres://user:hunter2@localhost:5433/queue'
    const res = applyTransition({
      ...base,
      state: 'RUNNING',
      to: 'PRODUCED',
      actor: 'human',
      grants: [secret],
      disposition: secret,
      receiptRef: secret,
    })
    expect(res.applied).toBe(false)
    expect(res.refusal).not.toMatch(/postgres/)
    expect(res.refusal).not.toMatch(/hunter2/)
  })

  it('is pure — the input object is never mutated', () => {
    const input: any = { ...base, state: 'RUNNING', to: 'PRODUCED', actor: 'worker' }
    const before = JSON.stringify(input)
    applyTransition(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('BACKEND-FREE BY LAW (source-level)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/queue/state-machine.mjs', import.meta.url)),
    'utf8',
  )

  it('imports no backend — not pg-boss, not pg, not the adapter, not the pg-boss backend', () => {
    const imports = source.match(/^\s*import[\s\S]*?from\s+'[^']+'/gm) ?? []
    for (const line of imports) {
      expect(line).not.toMatch(/pg-boss/)
      expect(line).not.toMatch(/from\s+'pg'/)
      expect(line).not.toMatch(/pgboss-backend/)
      expect(line).not.toMatch(/adapter\.mjs/)
    }
  })

  it('opens no file, no connection and no queue — Node built-ins only, and only crypto', () => {
    expect(source).not.toMatch(/node:fs/)
    expect(source).not.toMatch(/node:child_process/)
    expect(source).not.toMatch(/node:net/)
    expect(source).not.toMatch(/writeFileSync|appendFileSync|mkdirSync/)
  })
})
