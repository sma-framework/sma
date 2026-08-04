/**
 * Tests for daemon/src/queue/state-machine.mjs (Phase 11 Plan 04).
 *
 * The fleet's state vocabulary and its transition contracts (canon §10). The suite is
 * deliberately TABLE-DRIVEN: it walks FLEET_STATES and TRANSITIONS themselves rather
 * than asserting a hand-written list of pairs, so a state added WITHOUT its contract —
 * or a contract pointing at a state that does not exist — fails here instead of passing
 * unnoticed and stranding a task at runtime (T-11-04-05).
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
