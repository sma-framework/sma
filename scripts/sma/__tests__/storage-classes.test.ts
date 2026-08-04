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

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import {
  SENSITIVITY_CLASSES,
  STORAGE_CLASSES,
  resolveStorageClass,
  storagePlacementDenial,
} from '../lib/schema-v2.mjs'
import { LOCAL_STORE_DIRNAME, ensureLocalStore, localStorePath } from '../lib/local-store.mjs'
import { createPipelineState, persist, runPipeline } from '../lib/write-pipeline.mjs'
import { listNoteFiles, readNotes } from '../lib/generator.mjs'

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

// ── the local store ──────────────────────────────────────────────────────────

/** A minimal, legal v2 note on disk — enough for the corpus reader to keep it. */
function noteText(id: string) {
  return [
    '---',
    `id: ${id}`,
    'schema_version: 2',
    'status: active',
    'memory_type: semantic',
    'truth_mode: factual',
    `claim: The ${id} depot opens at 06:00.`,
    'language: en',
    'sensitivity: internal',
    '---',
    '',
    'Body.',
    '',
  ].join('\n')
}

describe('local-store — a directory that keeps itself out of git', () => {
  it('resolves to a path OUTSIDE the corpus directory, so a corpus reader never walks it', () => {
    const repoRoot = tmpRoot()
    const store = localStorePath({ repoRoot })
    const corpusDir = join(repoRoot, '.claude', 'memory')
    expect(store.startsWith(corpusDir + sep)).toBe(false)
    expect(store).toContain(LOCAL_STORE_DIRNAME)
    expect(store.startsWith(repoRoot + sep)).toBe(true)
  })

  it('is a pure path computation: it creates nothing and repeats itself exactly', () => {
    const repoRoot = tmpRoot()
    const first = localStorePath({ repoRoot })
    const second = localStorePath({ repoRoot })
    expect(second).toBe(first)
    expect(existsSync(first)).toBe(false)
  })

  it('creates the store on first use and writes a marker that ignores everything in it', () => {
    const repoRoot = tmpRoot()
    const result = ensureLocalStore({ repoRoot })
    expect(result.created).toBe(true)
    expect(result.marker).toBe('written')
    expect(existsSync(result.path)).toBe(true)
    const marker = readFileSync(result.markerPath, 'utf8')
    // A directory that ignores its own contents — including the marker itself.
    expect(marker.split(/\r?\n/).map((l) => l.trim())).toContain('*')
  })

  it('is a no-op the second time and never rewrites an existing marker', () => {
    const repoRoot = tmpRoot()
    ensureLocalStore({ repoRoot })
    const writes: string[] = []
    const spy = {
      existsSync,
      mkdirSync,
      readFileSync,
      renameSync,
      writeFileSync: (p: string, text: string) => {
        writes.push(String(p))
        return writeFileSync(p, text)
      },
    }
    const second = ensureLocalStore({ repoRoot, fsImpl: spy })
    expect(second.created).toBe(false)
    expect(second.marker).toBe('unchanged')
    expect(second.wrote).toBe(false)
    expect(writes).toEqual([])
  })

  it('restores a marker somebody deleted', () => {
    const repoRoot = tmpRoot()
    const first = ensureLocalStore({ repoRoot })
    rmSync(first.markerPath)
    const restored = ensureLocalStore({ repoRoot })
    expect(restored.created).toBe(false)
    expect(restored.marker).toBe('written')
    expect(existsSync(restored.markerPath)).toBe(true)
  })

  it('leaves a marker whose content differs and reports the difference instead of overwriting it', () => {
    const repoRoot = tmpRoot()
    const first = ensureLocalStore({ repoRoot })
    const tightened = '# tightened by hand\n*\n!.keep\n'
    writeFileSync(first.markerPath, tightened)
    const again = ensureLocalStore({ repoRoot })
    expect(again.marker).toBe('differs')
    expect(again.wrote).toBe(false)
    expect(readFileSync(first.markerPath, 'utf8')).toBe(tightened)
    expect(String(again.note)).toMatch(/differ/i)
  })

  it('keeps a corpus read identical with and without the store beside it', () => {
    const withStore = tmpRoot()
    const withoutStore = tmpRoot()
    for (const root of [withStore, withoutStore]) {
      const corpusDir = join(root, '.claude', 'memory')
      mkdirSync(corpusDir, { recursive: true })
      writeFileSync(join(corpusDir, 'depot-north.md'), noteText('depot-north'))
      writeFileSync(join(corpusDir, 'depot-south.md'), noteText('depot-south'))
    }
    const store = ensureLocalStore({ repoRoot: withStore })
    writeFileSync(join(store.path, 'courier-token.md'), noteText('courier-token'))

    const corpusA = join(withStore, '.claude', 'memory')
    const corpusB = join(withoutStore, '.claude', 'memory')
    expect(listNoteFiles(corpusA)).toEqual(listNoteFiles(corpusB))
    expect(readNotes(corpusA).length).toBe(readNotes(corpusB).length)
    // And the local record really is on disk — the equality above is not vacuous.
    expect(readdirSync(store.path).sort()).toContain('courier-token.md')
  })
})

// ── the placement gate ───────────────────────────────────────────────────────

describe('storagePlacementDenial — legality of a placement, decided in the one validation authority', () => {
  const corpusDir = join('project', '.claude', 'memory')
  const localDir = join('project', '.sma', LOCAL_STORE_DIRNAME)

  it('permits a shared record aimed at the corpus', () => {
    const denial = storagePlacementDenial(plainRecord({ sensitivity: 'internal' }), {
      targetDir: corpusDir,
      localDir,
    })
    expect(denial).toBeNull()
  })

  it('permits an ephemeral record aimed at the corpus — a deadline is not a secret', () => {
    const denial = storagePlacementDenial(plainRecord({ sensitivity: 'internal', retention: 'P30D' }), {
      targetDir: corpusDir,
      localDir,
    })
    expect(denial).toBeNull()
  })

  it('refuses a this-machine-only record aimed at the corpus, naming the class and where it belongs', () => {
    for (const sensitivity of ['sensitive', 'encrypted-required']) {
      const denial = storagePlacementDenial(plainRecord({ sensitivity }), { targetDir: corpusDir, localDir })
      expect(denial).not.toBeNull()
      expect(denial.storageClass).toBe('this-machine-only')
      expect(denial.targetDir).toBe(corpusDir)
      expect(denial.localDir).toBe(localDir)
      expect(denial.reason).toContain('this-machine-only')
      expect(denial.reason).toContain(LOCAL_STORE_DIRNAME)
    }
  })

  it('permits a this-machine-only record aimed at the local store itself', () => {
    const denial = storagePlacementDenial(plainRecord({ sensitivity: 'sensitive' }), {
      targetDir: localDir,
      localDir,
    })
    expect(denial).toBeNull()
  })

  it('refuses when no local store is known — a destination nobody named is not a permit', () => {
    const denial = storagePlacementDenial(plainRecord({ sensitivity: 'sensitive' }), { targetDir: corpusDir })
    expect(denial).not.toBeNull()
    expect(denial.storageClass).toBe('this-machine-only')
  })

  it('refuses a record whose class could not be read at all', () => {
    const denial = storagePlacementDenial(plainRecord({ sensitivity: 'confidential-ish' }), {
      targetDir: corpusDir,
      localDir,
    })
    expect(denial).not.toBeNull()
    expect(denial.storageClass).toBeNull()
    expect(denial.rule).toBe('unreadable-class')
  })

  it('is pure: it never mutates the record and never touches a filesystem', () => {
    const record = plainRecord({ sensitivity: 'sensitive' })
    const before = JSON.stringify(record)
    storagePlacementDenial(record, { targetDir: corpusDir, localDir })
    expect(JSON.stringify(record)).toBe(before)
    expect(existsSync(localDir)).toBe(false)
  })
})

// ── the write pipeline refuses before it writes ──────────────────────────────

describe('the persist step refuses local-class material before a byte is written', () => {
  function dirs(repoRoot: string) {
    const corpusDir = join(repoRoot, '.claude', 'memory')
    const draftsDir = join(corpusDir, 'drafts')
    mkdirSync(draftsDir, { recursive: true })
    return { corpusDir, draftsDir, localDir: localStorePath({ repoRoot }) }
  }

  it('refuses a this-machine-only record aimed at the corpus, and creates NO file', () => {
    const repoRoot = tmpRoot()
    const d = dirs(repoRoot)
    const record = plainRecord({ sensitivity: 'sensitive' })
    const state = createPipelineState({ record, body: 'Body.' }, { ...d, corpus: [] })
    persist(state)

    expect(state.outcome).toBe('rejected')
    expect(state.persisted).toBe(false)
    expect(existsSync(join(d.corpusDir, 'courier-route-cutoff.md'))).toBe(false)
    expect(readdirSync(d.corpusDir).filter((f) => f.endsWith('.md'))).toEqual([])
    const step = state.trace[state.trace.length - 1]
    expect(step.step).toBe('persist')
    expect(step.outcome).toBe('rejected')
    expect(JSON.stringify(step.detail)).toContain('this-machine-only')
  })

  it('persists a shared record exactly as it does today', () => {
    const repoRoot = tmpRoot()
    const d = dirs(repoRoot)
    // `factual` is machine-rederivable, so the corpus door wants its check —
    // unrelated to placement, but it is what the door asks after the gate.
    const record = plainRecord({ sensitivity: 'internal', fingerprint: { product_version: 'v5.2.0' } })
    const state = createPipelineState({ record, body: 'Body.' }, { ...d, corpus: [] })
    persist(state)

    expect(state.trace[state.trace.length - 1].outcome).toBe('persisted')
    expect(state.persisted).toBe(true)
    expect(existsSync(join(d.corpusDir, 'courier-route-cutoff.md'))).toBe(true)
  })

  it('refuses to STAGE a this-machine-only record either — a draft is a git-backed path too', () => {
    const repoRoot = tmpRoot()
    const d = dirs(repoRoot)
    // Through the whole walk: the approval ladder escalates a restricted record,
    // so staging — not persisting — is the path it actually takes.
    const result = runPipeline(
      { record: plainRecord({ sensitivity: 'sensitive', risk: 'high', retention: 'P30D' }), body: 'Body.' },
      { ...d, corpus: [] },
    )
    expect(result.outcome).toBe('rejected')
    expect(readdirSync(d.draftsDir).filter((f) => f.endsWith('.md'))).toEqual([])
    expect(readdirSync(d.corpusDir).filter((f) => f.endsWith('.md'))).toEqual([])
    expect(JSON.stringify(result.trace)).toContain('this-machine-only')
  })
})
