/**
 * Tests for the three storage classes: the resolver, the local store, and the
 * placement gate inside the write pipeline's corpus door.
 *
 * ONE STORY, one file. `STORAGE_CLASSES`/`resolveStorageClass` in
 * scripts/sma/lib/schema-v2.mjs answer the single question "who will see this
 * record"; scripts/sma/lib/local-store.mjs is where the answer "only this
 * machine" physically lives; and `storagePlacementDenial`, consulted by
 * `persist`, is what makes the answer a boundary rather than a label. A class
 * that nothing enforces is a tag on a file sitting in the same directory as
 * everything else.
 *
 * NAME-COLLISION GUARD: `sensitivity` here is the record's own four-value
 * confidentiality vocabulary. It is NOT the storage class — three classes are
 * DERIVED from it plus the record's lifetime fields, and no fifth sensitivity
 * value was added for the derived one.
 *
 * Every fixture below is synthetic: an invented courier company, invented ids,
 * invented refs. No corpus text, no real paths, no personal data.
 */

import { describe, it, expect, afterEach } from 'vitest'

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { SENSITIVITY_CLASSES, STORAGE_CLASSES, resolveStorageClass } from '../lib/schema-v2.mjs'

// ── fixtures ─────────────────────────────────────────────────────────────────

/** A legal, unremarkable v2 record: no class declared, no lifetime window. */
function plainRecord(over: Record<string, unknown> = {}) {
  return {
    id: 'courier-route-cutoff',
    schema_version: 2,
    status: 'active',
    memory_type: 'semantic',
    truth_mode: 'factual',
    claim: 'The evening courier run closes at 18:00 local time.',
    language: 'en',
    ...over,
  }
}

const TMP_ROOTS: string[] = []

function tmpRoot(prefix = 'sma-storage-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TMP_ROOTS.push(dir)
  return dir
}

afterEach(() => {
  while (TMP_ROOTS.length) {
    const dir = TMP_ROOTS.pop() as string
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leftover temp dir is not a test failure */
    }
  }
})

// ── the vocabulary ───────────────────────────────────────────────────────────

describe('STORAGE_CLASSES — three classes on the who-sees-it axis', () => {
  it('has exactly three members and is frozen', () => {
    expect(STORAGE_CLASSES).toHaveLength(3)
    expect(Object.isFrozen(STORAGE_CLASSES)).toBe(true)
  })

  it('names the three by who sees the record', () => {
    expect([...STORAGE_CLASSES].sort()).toEqual(['ephemeral', 'shared', 'this-machine-only'])
  })

  it('is ordered lightest to strictest, like the approval ladder', () => {
    expect(STORAGE_CLASSES[0]).toBe('shared')
    expect(STORAGE_CLASSES[STORAGE_CLASSES.length - 1]).toBe('this-machine-only')
  })

  it('leaves SENSITIVITY_CLASSES at exactly four — the ephemeral class is NOT a fifth value', () => {
    expect(SENSITIVITY_CLASSES).toHaveLength(4)
    expect([...SENSITIVITY_CLASSES]).not.toContain('ephemeral')
  })
})

// ── the resolver ─────────────────────────────────────────────────────────────

describe('resolveStorageClass — every record resolves to exactly one class', () => {
  it('defaults an undeclared record to the shared class', () => {
    const verdict = resolveStorageClass(plainRecord())
    expect(verdict.storageClass).toBe('shared')
    expect(verdict.refused).toBeFalsy()
    expect(verdict.rule).toBe('default-shared')
  })

  it('resolves the two open classes to shared', () => {
    for (const sensitivity of ['public', 'internal']) {
      const verdict = resolveStorageClass(plainRecord({ sensitivity }))
      expect(verdict.storageClass).toBe('shared')
    }
  })

  it('resolves each restricted sensitivity value to the this-machine-only class', () => {
    for (const sensitivity of ['sensitive', 'encrypted-required']) {
      const verdict = resolveStorageClass(plainRecord({ sensitivity }))
      expect(verdict.storageClass).toBe('this-machine-only')
      expect(verdict.rule).toBe('restricted-class')
      expect(verdict.field).toBe('sensitivity')
      expect(verdict.value).toBe(sensitivity)
    }
  })

  it('resolves a record with a retention window to the ephemeral class', () => {
    const verdict = resolveStorageClass(plainRecord({ sensitivity: 'internal', retention: 'P30D' }))
    expect(verdict.storageClass).toBe('ephemeral')
    expect(verdict.rule).toBe('lifetime-window')
    expect(verdict.field).toBe('retention')
  })

  it('accepts a retention block spelled {ttl} or {until}', () => {
    for (const retention of [{ ttl: 'P7D' }, { until: '2027-01-01' }]) {
      const verdict = resolveStorageClass(plainRecord({ retention }))
      expect(verdict.storageClass).toBe('ephemeral')
    }
  })

  it('resolves a record with a valid-until horizon to the ephemeral class', () => {
    const verdict = resolveStorageClass(plainRecord({ sensitivity: 'public', valid_until: '2027-03-01' }))
    expect(verdict.storageClass).toBe('ephemeral')
    expect(verdict.field).toBe('valid_until')
  })

  it('does not read an EMPTY retention block as a window — a block with nothing in it bounds nothing', () => {
    const verdict = resolveStorageClass(plainRecord({ retention: {} }))
    expect(verdict.storageClass).toBe('shared')
  })

  it('resolves a record that is both restricted and time-bounded to the strictest class, and says which rule won', () => {
    const verdict = resolveStorageClass(plainRecord({ sensitivity: 'sensitive', valid_until: '2027-03-01' }))
    expect(verdict.storageClass).toBe('this-machine-only')
    expect(verdict.rule).toBe('restricted-class')
    expect(verdict.field).toBe('sensitivity')
    expect(verdict.reason).toMatch(/strict/i)
  })

  it('refuses a sensitivity value outside the four-value vocabulary rather than defaulting it', () => {
    const verdict = resolveStorageClass(plainRecord({ sensitivity: 'confidential-ish' }))
    expect(verdict.refused).toBe(true)
    expect(verdict.storageClass).toBeNull()
    expect(verdict.field).toBe('sensitivity')
    expect(verdict.value).toBe('confidential-ish')
    expect(verdict.reason).toMatch(/confidential-ish/)
  })

  it('refuses an input that is not a record at all', () => {
    for (const notARecord of [null, undefined, 'a string', 42, ['an', 'array']]) {
      const verdict = resolveStorageClass(notARecord as never)
      expect(verdict.refused).toBe(true)
      expect(verdict.storageClass).toBeNull()
    }
  })

  it('always returns a class that is a member of STORAGE_CLASSES, or refuses', () => {
    const records = [
      plainRecord(),
      plainRecord({ sensitivity: 'public' }),
      plainRecord({ sensitivity: 'internal', retention: 'P30D' }),
      plainRecord({ sensitivity: 'sensitive' }),
      plainRecord({ sensitivity: 'encrypted-required', valid_until: '2027-01-01' }),
    ]
    for (const record of records) {
      const verdict = resolveStorageClass(record)
      expect(verdict.refused).toBeFalsy()
      expect(STORAGE_CLASSES).toContain(verdict.storageClass)
    }
  })

  it('is pure: it never mutates the record it judges', () => {
    const record = plainRecord({ sensitivity: 'sensitive', retention: { ttl: 'P7D' } })
    const before = JSON.stringify(record)
    resolveStorageClass(record, { now: '2026-08-04T00:00:00Z' })
    expect(JSON.stringify(record)).toBe(before)
  })

  it('takes its clock as an argument and never lets it change the class', () => {
    const record = plainRecord({ valid_until: '2020-01-01' })
    const withoutClock = resolveStorageClass(record)
    const longAfter = resolveStorageClass(record, { now: '2026-08-04T00:00:00Z' })
    const longBefore = resolveStorageClass(record, { now: '2019-01-01T00:00:00Z' })
    expect(withoutClock.storageClass).toBe('ephemeral')
    expect(longAfter.storageClass).toBe('ephemeral')
    expect(longBefore.storageClass).toBe('ephemeral')
    // The clock only REPORTS whether the window is still open; it decides nothing.
    expect(withoutClock.window).toBe('unknown')
    expect(longAfter.window).toBe('closed')
    expect(longBefore.window).toBe('open')
  })
})
