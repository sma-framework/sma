/**
 * Contract: the seven approval doors of the risk ladder, named in the words of the
 * model they implement, each asserted against the LIVE ladder.
 *
 * WHY A SECOND FILE. schema-v2.test.ts already proves the ladder BEHAVES — escalation
 * wins over everything, an unreadable record falls closed, every path is reachable.
 * None of that is repeated here. What this file adds is the other direction: that each
 * door still means the CLASS OF KNOWLEDGE it was created for. A refactor can keep every
 * behavioural test green while quietly moving, say, a standing rule off the human door;
 * the names below are what would catch it.
 *
 * The names are the doc's, not an internal register's: docs/MEMORY-LIFECYCLE.md §3
 * carries the same seven doors in the same order, exactly as links.test.ts pins the edge
 * vocabulary to docs/MEMORY-MODEL.md §10.
 *
 * NOT A FAKE. Every assertion runs the real `resolveApprovalPath` over the real,
 * imported `APPROVAL_PATHS` — a stand-in dictionary would only ever prove itself.
 * The list of names below is a deliberate verbatim second measure: written out by hand
 * so that a change to the module's list must be re-typed here, consciously, to stay green.
 *
 * Every record below is synthetic: an invented web-shop, invented ids, invented refs.
 */

import { describe, it, expect } from 'vitest'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { APPROVAL_PATHS, hasLifetimeWindow, resolveApprovalPath } from '../lib/schema-v2.mjs'

/** The seven doors docs/MEMORY-LIFECYCLE.md §3 documents, in the doc's order. */
const CANON_LADDER: Array<[string, string]> = [
  ['a low-risk observation of the task in flight, automatic behind a lifetime window', 'auto-ttl'],
  ['a candidate lesson, drafted automatically and believed by nobody yet', 'auto-draft'],
  ['a procedural recommendation, held to an evidence threshold and a review', 'evidence-review'],
  ['a reflex-grade standing rule, which a person admits', 'human-approval'],
  ["the owner's own preference, versioned and owner-controlled", 'owner-versioned'],
  ['a decision policy, versioned and replayable', 'versioned-replay'],
  ['a security-grade rule, governed and human-only', 'governed-human-only'],
]

/** docs/MEMORY-LIFECYCLE.md as shipped, read from the tree rather than paraphrased. */
function lifecycleDoc(): string {
  return readFileSync(fileURLToPath(new URL('../../../docs/MEMORY-LIFECYCLE.md', import.meta.url)), 'utf8')
}

// ── each canonical class, on the live ladder ─────────────────────────────────

describe('the seven approval doors, each asserted on the live ladder', () => {
  it('a low-risk working observation rides the automatic TTL door', () => {
    expect(
      resolveApprovalPath({
        memory_type: 'working',
        truth_mode: 'observed',
        sensitivity: 'internal',
        risk: 'low',
      }),
    ).toBe('auto-ttl')
  })

  it('a candidate lesson out of an episode is drafted automatically, never believed', () => {
    expect(
      resolveApprovalPath({
        memory_type: 'episodic',
        truth_mode: 'hypothesis',
        sensitivity: 'internal',
        risk: 'low',
      }),
    ).toBe('auto-draft')
  })

  it('a settled procedural recommendation is held to an evidence threshold', () => {
    expect(
      resolveApprovalPath({
        memory_type: 'procedural',
        truth_mode: 'factual',
        sensitivity: 'internal',
        risk: 'medium',
      }),
    ).toBe('evidence-review')
  })

  it('a reflex-grade standing rule is admitted by a person', () => {
    expect(
      resolveApprovalPath({
        memory_type: 'normative',
        truth_mode: 'normative',
        sensitivity: 'internal',
        risk: 'high',
      }),
    ).toBe('human-approval')
  })

  it("the owner's own preference stays owner-controlled and versioned", () => {
    expect(
      resolveApprovalPath({
        memory_type: 'preference',
        truth_mode: 'decision',
        sensitivity: 'internal',
        risk: 'low',
      }),
    ).toBe('owner-versioned')
  })

  it('a decision policy is versioned and replayable', () => {
    expect(
      resolveApprovalPath({
        memory_type: 'semantic',
        truth_mode: 'decision',
        sensitivity: 'internal',
        risk: 'medium',
      }),
    ).toBe('versioned-replay')
  })

  it('a security-grade rule is governed and human-only', () => {
    expect(
      resolveApprovalPath({
        memory_type: 'normative',
        truth_mode: 'normative',
        sensitivity: 'sensitive',
        risk: 'high',
      }),
    ).toBe('governed-human-only')
  })
})

// ── the one automatic door has two locks, not one ────────────────────────────

describe('the automatic door is bolted twice — the path alone opens nothing', () => {
  const observation = {
    id: 'checkout-latency-this-run',
    memory_type: 'working',
    truth_mode: 'observed',
    sensitivity: 'internal',
    risk: 'low',
    claim: 'The checkout page answered in 310 ms during this run.',
  }

  it('an observation WITH an end date is bounded in time', () => {
    const bounded = { ...observation, valid_until: '2026-12-31' }
    expect(resolveApprovalPath(bounded)).toBe('auto-ttl')
    expect(hasLifetimeWindow(bounded)).toBe(true)
  })

  it('the same observation WITHOUT one is unbounded — the ladder says auto, the window does not', () => {
    // The path is granted and the second lock is still shut: the write pipeline's risk
    // step asks hasLifetimeWindow before the single automatic path may write anything.
    // An observation that never expires is not the class this door was opened for.
    expect(resolveApprovalPath(observation)).toBe('auto-ttl')
    expect(hasLifetimeWindow(observation)).toBe(false)
  })

  it('an empty retention block bounds nothing and must not read as an expiry', () => {
    expect(hasLifetimeWindow({ ...observation, retention: {} })).toBe(false)
  })
})

// ── the dictionary itself ────────────────────────────────────────────────────

describe('APPROVAL_PATHS — the closed door vocabulary (docs/MEMORY-LIFECYCLE.md §3)', () => {
  it('carries exactly the seven doors the document names, in the document order', () => {
    expect([...APPROVAL_PATHS]).toEqual(CANON_LADDER.map(([, path]) => path))
  })

  it('is exactly seven doors long — an eighth is a schema decision, not a refactor', () => {
    expect(APPROVAL_PATHS).toHaveLength(7)
  })

  it('is frozen, so no caller can widen the ladder at runtime', () => {
    expect(Object.isFrozen(APPROVAL_PATHS)).toBe(true)
  })

  it('every canonical class named above resolves to a door that exists in the list', () => {
    for (const [name, path] of CANON_LADDER) {
      expect([...APPROVAL_PATHS], `the door for ${name} must be a member`).toContain(path)
    }
  })
})

// ── the two gaps the document owes the reader ────────────────────────────────

describe('the two doors the ladder deliberately does not have stay written down', () => {
  it('names the missing deterministic-proof alternative to the human door', () => {
    expect(lifecycleDoc()).toContain(
      'A deterministic-proof door for reflex-grade rules is deliberately NOT built.',
    )
  })

  it('names the missing wire from a decision-policy record to the replay exam', () => {
    expect(lifecycleDoc()).toContain(
      'A wire from a decision-policy record to the replay exam is deliberately NOT built.',
    )
  })

  it('gives each gap a condition that reopens it, not an open-ended postponement', () => {
    // "Revisit when …" is the checkable half: a gap without one is an excuse.
    const revisits = lifecycleDoc().match(/\*\*Revisit when\*\*/g) ?? []
    expect(revisits.length).toBeGreaterThanOrEqual(2)
  })
})
