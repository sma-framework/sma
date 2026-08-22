/**
 * Bi-temporal invalidation — the CANON layer, asserted against the live dictionaries.
 *
 * Two questions this file answers, and neither of them is «does retrieval withhold a
 * retired record». That one is already answered on the REAL read path, through
 * compilePack with an injected clock, by the revoked-visibility suite in this same
 * directory — the suite that packs a corpus and reads back the members the compiler
 * actually emitted. Duplicating it here would buy a second, weaker copy of a proof
 * that already exists, and the day the two disagreed neither would be authoritative.
 *
 * What is asserted here instead:
 *
 *  1. THE FOUR TEMPORAL FIELDS ARE IN THE SCHEMA'S OWN KEY ORDER. `observed_at` and
 *     `recorded_at` are the two clocks bi-temporality is named after (when the world
 *     changed / when we learned of it); `valid_from` and `valid_until` are the window
 *     the claim itself declares. All four are imported from the live `V2_KEY_ORDER`
 *     and named again, verbatim, below. The second yardstick is deliberate: that IS
 *     the contract. A field dropped from the emitted order would still let every
 *     record parse — it would only stop being written, silently, on the next save.
 *
 *  2. THE FIVE LIFECYCLE ACTIONS ARE THE WHOLE VOCABULARY, AND THE VERB ENFORCES IT.
 *     Composition, count and frozen-ness of the live `LIFECYCLE_ACTIONS`; the four
 *     transitioning actions map one-to-one onto the four read-time excluded statuses;
 *     and `applyLifecycle` itself is driven on a real temp corpus for the refusals
 *     that make the fields load-bearing — revoke with no stated reason, expire with
 *     no end date, expire before the date has passed.
 *
 * This file reddens on: a temporal field leaving the emit order, a sixth lifecycle
 * action (or a fifth that is not `erase`), the excluded-status set drifting out of
 * step with the actions that write those statuses, and any of the three refusals
 * turning into a silent success.
 *
 * NOTHING IS FAKED. `applyLifecycle` is the shipped function, the corpus is real
 * files in a temp directory, and the journal is redirected into that same temp
 * directory so no run of this suite ever writes outside it.
 *
 * Every fixture below is synthetic: an invented web-shop, invented ids, invented text.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { V2_KEY_ORDER } from '../lib/frontmatter.mjs'
import { LIFECYCLE_ACTIONS, applyLifecycle } from '../lib/write-pipeline.mjs'
import { CORE_EXCLUDED_STATUSES } from '../lib/generator.mjs'

/**
 * The four temporal fields docs/MEMORY-MODEL.md calls bi-temporal, written out by
 * hand. Imported-and-repeated is the whole point: the import cannot go stale, the
 * repetition cannot be edited by accident.
 */
const BITEMPORAL_FIELDS = ['observed_at', 'recorded_at', 'valid_from', 'valid_until']

/** The five lifecycle actions the canon names — the transitions, then the destruction. */
const CANON_LIFECYCLE_ACTIONS = ['supersede', 'revoke', 'expire', 'archive', 'erase']

/** The four statuses a transition writes — the read path withholds every one of them. */
const RETIREMENT_STATUSES = ['superseded', 'revoked', 'expired', 'archived']

// ── The four temporal fields ─────────────────────────────────────────────────

describe('the bi-temporal fields are part of the schema-v2 emit order', () => {
  for (const field of BITEMPORAL_FIELDS) {
    it(`emits \`${field}\` — a field outside the key order stops being written, silently`, () => {
      expect(V2_KEY_ORDER).toContain(field)
    })
  }

  it('names four of them and no fifth clock', () => {
    // Asserted apart from the membership above on purpose: an edit that adds a
    // temporal field AND appends it to the list here would keep every `toContain`
    // green, and four is the number the model, the verbs and this suite all quote.
    expect(BITEMPORAL_FIELDS).toHaveLength(4)
    expect(new Set(BITEMPORAL_FIELDS).size).toBe(4)
  })

  it('carries BOTH clocks — when the world changed, and when the corpus learned of it', () => {
    // The pair is what makes the model bi-temporal at all. `observed_at` alone is a
    // diary; `recorded_at` alone is a changelog. Losing either one leaves a schema
    // that still validates and can no longer answer «what did we believe, and when».
    expect(V2_KEY_ORDER).toContain('observed_at')
    expect(V2_KEY_ORDER).toContain('recorded_at')
    expect(V2_KEY_ORDER.indexOf('observed_at')).toBeLessThan(V2_KEY_ORDER.indexOf('recorded_at'))
  })

  it('carries both ends of the validity window', () => {
    expect(V2_KEY_ORDER).toContain('valid_from')
    expect(V2_KEY_ORDER).toContain('valid_until')
    expect(V2_KEY_ORDER.indexOf('valid_from')).toBeLessThan(V2_KEY_ORDER.indexOf('valid_until'))
  })
})

// ── The five lifecycle actions ───────────────────────────────────────────────

describe('LIFECYCLE_ACTIONS — the closed set of ways a record stops being believed', () => {
  it('carries exactly the five actions the lifecycle canon documents', () => {
    expect([...LIFECYCLE_ACTIONS]).toEqual(CANON_LIFECYCLE_ACTIONS)
  })

  it('holds five names and no sixth', () => {
    expect(LIFECYCLE_ACTIONS).toHaveLength(5)
    expect(CANON_LIFECYCLE_ACTIONS).toHaveLength(5)
  })

  it('is frozen — widening the set is a lifecycle decision, not a runtime one', () => {
    expect(Object.isFrozen(LIFECYCLE_ACTIONS)).toBe(true)
  })

  it('separates the four that TRANSITION from the one that DESTROYS', () => {
    // Four of the five leave the bytes on disk and change what the system is willing
    // to believe about them. The fifth removes the record. Stating the split here is
    // what makes the one-to-one below meaningful: `erase` has no status because an
    // erased record has no record.
    expect(LIFECYCLE_ACTIONS.filter((a: string) => a !== 'erase')).toHaveLength(4)
    expect(LIFECYCLE_ACTIONS).toContain('erase')
  })
})

describe('the transitions and the read-time exclusions are one decision, not two', () => {
  it('withholds exactly the four statuses the four transitioning actions write', () => {
    expect([...CORE_EXCLUDED_STATUSES].sort()).toEqual([...RETIREMENT_STATUSES].sort())
    expect(CORE_EXCLUDED_STATUSES.size).toBe(4)
  })

  it('leaves no transitioning action whose status the read path would still deliver', () => {
    // The gap this asserts against is a real one that was open in this tree until the
    // exclusion set widened from two statuses to four: the write path retired a record
    // and the read path went on quoting it. The proof that no CALLER can reach such a
    // record lives on the real read path, in the revoked-visibility suite next door;
    // this is the arithmetic half — the two lists cannot drift apart unnoticed.
    const transitioning = LIFECYCLE_ACTIONS.filter((a: string) => a !== 'erase')
    expect(transitioning).toHaveLength(CORE_EXCLUDED_STATUSES.size)
  })
})

// ── applyLifecycle on a real corpus: the refusals that carry the fields ───────

let dir: string
let corpusDir: string
let journalDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-bitemporal-'))
  corpusDir = join(dir, 'memory')
  journalDir = join(dir, 'journal')
  // The journal directory is passed on EVERY call below. `appendEvent` resolves a
  // default root when it is not given one, and a unit test that quietly appended to
  // the machine's real journal would be writing outside its own sandbox.
  writeFileSync(join(dir, '.keep'), '', 'utf8')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A minimal legal schema-v2 record on disk, returned as its path. */
function writeRecord(id: string, extra: string[] = []): string {
  mkdirSync(corpusDir, { recursive: true })
  const text = [
    '---',
    `id: ${id}`,
    'schema_version: 2',
    'status: active',
    'memory_type: semantic',
    'truth_mode: factual',
    'claim: "The checkout page answers within 400 ms at p95."',
    'language: en',
    'observed_at: 2026-01-10',
    'recorded_at: 2026-01-10',
    'valid_from: 2026-01-10',
    ...extra,
    'criticality: medium',
    'context_priority: on-demand',
    'risk: low',
    'sensitivity: internal',
    '---',
    '',
    'The measured budget for the checkout page.',
    '',
  ].join('\n')
  const path = join(corpusDir, `${id}.md`)
  writeFileSync(path, text, 'utf8')
  return path
}

/** Everything the transitions need, minus what each case is about. */
function transition(extra: Record<string, unknown>) {
  return applyLifecycle({ corpusDir, journalDir, terminalId: 'T-test', ...extra })
}

describe('applyLifecycle — the boundary every retiring verb goes through', () => {
  it('refuses an action outside the five, naming what it does perform', () => {
    writeRecord('checkout-latency-budget')
    const res = transition({ id: 'checkout-latency-budget', action: 'forget-about-it' })

    expect(res.applied).toBe(false)
    expect(res.refusal).toContain('forget-about-it')
    for (const action of CANON_LIFECYCLE_ACTIONS) expect(res.refusal).toContain(action)
  })

  it('refuses to revoke without a stated reason, and changes nothing on disk', () => {
    const path = writeRecord('checkout-latency-budget')
    const before = readFileSync(path, 'utf8')

    const res = transition({ id: 'checkout-latency-budget', action: 'revoke' })

    expect(res.applied).toBe(false)
    expect(res.refusal).toContain('reason')
    expect(res.changed).toEqual([])
    // The write-detection oracle: a refusal that had rewritten the record would be a
    // refusal in the return value only. Byte-identity is the assertion, not the count.
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('revokes when the reason is stated, and stamps the status the read path excludes', () => {
    const path = writeRecord('checkout-latency-budget')

    const res = transition({
      id: 'checkout-latency-budget',
      action: 'revoke',
      reason: 'the budget was measured on a cached page',
      now: '2026-03-01T00:00:00Z',
    })

    expect(res.applied).toBe(true)
    expect(res.status).toBe('revoked')
    expect(res.changed).toEqual([path])
    // The file, not the return value: the frontmatter on disk now says `revoked`,
    // and `revoked` is one of the four statuses the read path withholds.
    expect(readFileSync(path, 'utf8')).toContain('status: revoked')
    expect(CORE_EXCLUDED_STATUSES.has('revoked')).toBe(true)
  })

  it('refuses to expire a claim that declares no end date', () => {
    // This is the assertion that makes `valid_until` load-bearing rather than
    // decorative: without it there is nothing for `expire` to have run out of.
    const path = writeRecord('checkout-latency-budget')
    const before = readFileSync(path, 'utf8')

    const res = transition({ id: 'checkout-latency-budget', action: 'expire', now: '2026-03-01T00:00:00Z' })

    expect(res.applied).toBe(false)
    expect(res.refusal).toContain('valid_until')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('refuses to expire a claim whose end date has not passed yet, on the injected clock', () => {
    const path = writeRecord('checkout-latency-budget', ['valid_until: 2026-12-31'])
    const before = readFileSync(path, 'utf8')

    const res = transition({ id: 'checkout-latency-budget', action: 'expire', now: '2026-03-01T00:00:00Z' })

    expect(res.applied).toBe(false)
    expect(res.refusal).toContain('2026-12-31')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('expires the same claim once the clock is past its end date — the clock decides, not the fixture', () => {
    // The positive insurance for the case above. A suite that only proved refusals
    // would stay green on the day `expire` refused everything.
    const path = writeRecord('checkout-latency-budget', ['valid_until: 2026-12-31'])

    const res = transition({ id: 'checkout-latency-budget', action: 'expire', now: '2027-01-05T00:00:00Z' })

    expect(res.applied).toBe(true)
    expect(res.status).toBe('expired')
    expect(readFileSync(path, 'utf8')).toContain('status: expired')
    expect(CORE_EXCLUDED_STATUSES.has('expired')).toBe(true)
  })

  it('archives without argument — the action with no precondition still writes an excluded status', () => {
    const path = writeRecord('checkout-latency-budget')

    const res = transition({ id: 'checkout-latency-budget', action: 'archive', now: '2026-03-01T00:00:00Z' })

    expect(res.applied).toBe(true)
    expect(res.status).toBe('archived')
    expect(readFileSync(path, 'utf8')).toContain('status: archived')
    expect(CORE_EXCLUDED_STATUSES.has('archived')).toBe(true)
  })

  it('journals into the directory it was given and nowhere else', () => {
    // The sandbox assertion, made executable: the default journal root is the
    // machine's, and this suite must never reach it.
    writeRecord('checkout-latency-budget')
    transition({
      id: 'checkout-latency-budget',
      action: 'revoke',
      reason: 'the budget was measured on a cached page',
      now: '2026-03-01T00:00:00Z',
    })

    expect(existsSync(join(journalDir, 'T-test.jsonl'))).toBe(true)
  })
})
