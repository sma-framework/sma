/**
 * Tests for scripts/sma/lib/snapshot.mjs (Phase 49 Plan 13, Task 1).
 *
 * The terminal→CRM reporter (R12, D-49-04/05/11, P1):
 *   - Test 1: buildSnapshotPayload output keys are EXACTLY the allowlist (deep,
 *     incl. nested collisionFeed item keys) — nothing else survives serialization (P1).
 *   - Test 2: collisionFeed is the OWN journal tail bounded to 20; memoryHealth
 *     carries only numeric/hash summary keys.
 *   - Test 3: sendSnapshot against an unreachable URL resolves WITHOUT throwing,
 *     journals a 'snapshot-fail' event, returns {sent:false} (fail-open, R12).
 *   - Test 4: with SMA_SNAPSHOT_TOKEN unset, sendSnapshot no-ops cleanly
 *     ({sent:false, reason:'no-token'}).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSnapshotPayload, sendSnapshot, runSnapshot } from '../lib/snapshot.mjs'

// The EXACT allowlist the receiving route (49-07) persists — the payload must be a
// subset of this set, and nothing else.
const ALLOWED_KEYS = [
  'terminalId',
  'holderIdentity',
  'pid',
  'status',
  'scopeGlobs',
  'scopeDescription',
  'blockers',
  'acquireTime',
  'renewTime',
  'sentAt',
  'collisionFeed',
  'memoryHealth',
  // v2 (49.1-25, B21) — the extended cockpit blocks.
  'schemaVersion',
  'predictions',
  'calibration',
  'reflexFires',
  'gates',
  'corpusHealth',
]

const COLLISION_ITEM_KEYS = ['type', 'actors', 'scope', 'ts']
const MEMORY_HEALTH_KEYS = ['lintCritical', 'lintWarn', 'corpusFiles', 'indexCommit', 'indexBuiltAt']

let root: string
let sessionsDir: string
let journalDir: string
let calibrationDir: string

const identity = { holderIdentity: 'Мозг', terminalId: 'mozg', pid: 111 }

/** Write a full B15 lease for the identity so buildSnapshotPayload has an own session. */
function writeLease(extra = {}) {
  const lease = {
    holderIdentity: identity.holderIdentity,
    pid: identity.pid,
    scope: { globs: ['src/**', 'scripts/**'], description: 'edit sma' },
    status: 'working',
    blockers: ['ждёт ключ SMA_SNAPSHOT_TOKEN'],
    acquireTime: '2026-07-02T10:00:00.000Z',
    renewTime: '2026-07-02T10:03:00.000Z',
    leaseDurationSeconds: 1800,
    transitions: 2,
    ...extra,
  }
  writeFileSync(join(sessionsDir, `${identity.terminalId}.json`), JSON.stringify(lease))
}

/** Append n journal lines (as raw JSONL) so journalTail has something to bound. */
function writeJournal(n: number) {
  const lines = []
  for (let i = 1; i <= n; i++) {
    lines.push(
      JSON.stringify({
        ts: `2026-07-02T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
        terminal: identity.terminalId,
        seq: i,
        type: 'collision',
        actors: [identity.holderIdentity, 'Фабрика'],
        scope: { globs: ['src/**'] },
        // a NON-allowlisted nested field that must be dropped from the feed items:
        detail: { noteBody: 'секрет который не должен утечь', globs: ['src/**'] },
      }),
    )
  }
  writeFileSync(join(journalDir, `${identity.terminalId}.jsonl`), lines.join('\n') + '\n')
}

/** Append calibration ledger records for a domain (49.1-25 v2 fixtures). */
function writeCalibration(domain: string, records: Array<{ verdict: string; ts: string }>) {
  const lines = records.map((r) => JSON.stringify({ domain, verdict: r.verdict, ts: r.ts }))
  writeFileSync(join(calibrationDir, `${domain}.jsonl`), lines.join('\n') + '\n')
}

/** Append reflex + gate journal fires so the v2 blocks have something to gather. */
function writeReflexAndGateJournal() {
  const lines = [
    JSON.stringify({
      ts: '2026-07-02T11:00:00.000Z',
      terminal: identity.terminalId,
      seq: 1,
      type: 'reflex',
      actors: ['P49 Том'],
      scope: 'src/pay/checkout.ts',
      detail: { noteId: 'feedback_x', target: 'src/pay/checkout.ts', tier: 'high' },
    }),
    JSON.stringify({
      ts: '2026-07-02T11:05:00.000Z',
      terminal: identity.terminalId,
      seq: 2,
      type: 'gate',
      actors: ['P49 Том'],
      scope: 'src/migrations/index.ts',
      detail: { gateId: 'MIGRATION-SLOT', target: 'src/migrations/index.ts' },
    }),
  ]
  writeFileSync(join(journalDir, `${identity.terminalId}.jsonl`), lines.join('\n') + '\n')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sma-snapshot-'))
  sessionsDir = join(root, 'sessions')
  journalDir = join(root, 'journal')
  calibrationDir = join(root, 'calibration')
  mkdirSync(sessionsDir, { recursive: true })
  mkdirSync(journalDir, { recursive: true })
  mkdirSync(calibrationDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('buildSnapshotPayload — allowlist serializer (Test 1, P1)', () => {
  it('output keys are EXACTLY a subset of the allowlist — no extra keys survive', () => {
    writeLease()
    writeJournal(3)
    const payload = buildSnapshotPayload({
      identity,
      sessionsDir,
      journalDir,
      // no memoryHealth source available → null, still allowlist-clean
      loadMemoryHealth: () => null,
    })

    // every payload key is in the allowlist (no leaked keys)
    for (const k of Object.keys(payload)) {
      expect(ALLOWED_KEYS).toContain(k)
    }
    // core identity + timing keys present
    expect(payload.terminalId).toBe('mozg')
    expect(payload.holderIdentity).toBe('Мозг')
    expect(payload.pid).toBe(111)
    expect(payload.status).toBe('working')
    expect(payload.scopeGlobs).toEqual(['src/**', 'scripts/**'])
    expect(payload.scopeDescription).toBe('edit sma')
    expect(payload.blockers).toEqual(['ждёт ключ SMA_SNAPSHOT_TOKEN'])
    expect(payload.acquireTime).toBe('2026-07-02T10:00:00.000Z')
    expect(payload.renewTime).toBe('2026-07-02T10:03:00.000Z')
    expect(typeof payload.sentAt).toBe('string')
  })

  it('each collisionFeed item is EXACTLY {type,actors,scope,ts} — nested bodies dropped', () => {
    writeLease()
    writeJournal(3)
    const payload = buildSnapshotPayload({ identity, sessionsDir, journalDir, loadMemoryHealth: () => null })

    expect(Array.isArray(payload.collisionFeed)).toBe(true)
    expect(payload.collisionFeed.length).toBe(3)
    for (const item of payload.collisionFeed) {
      const keys = Object.keys(item).sort()
      expect(keys).toEqual([...COLLISION_ITEM_KEYS].sort())
      // the smuggled note body from the raw journal line must NOT be present
      expect(JSON.stringify(item)).not.toContain('секрет')
    }
  })

  it('a fixture with extra local data present never reaches the payload (P1 deep-key)', () => {
    // A lease carrying an extra secret-ish field alongside the real fields.
    writeLease({ secretEnvDump: 'DATABASE_URL=postgres://leak', localFileContents: 'PHI text' })
    writeJournal(1)
    const payload = buildSnapshotPayload({ identity, sessionsDir, journalDir, loadMemoryHealth: () => null })
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('secretEnvDump')
    expect(serialized).not.toContain('DATABASE_URL')
    expect(serialized).not.toContain('localFileContents')
    expect(serialized).not.toContain('PHI text')
  })
})

describe('buildSnapshotPayload — bounded feed + narrowed health (Test 2)', () => {
  it('collisionFeed is the OWN journal tail bounded to 20', () => {
    writeLease()
    writeJournal(35) // more than the bound
    const payload = buildSnapshotPayload({ identity, sessionsDir, journalDir, loadMemoryHealth: () => null })
    expect(payload.collisionFeed.length).toBe(20)
  })

  it('memoryHealth carries only the known numeric/hash summary keys', () => {
    writeLease()
    writeJournal(1)
    const payload = buildSnapshotPayload({
      identity,
      sessionsDir,
      journalDir,
      loadMemoryHealth: () => ({
        lintCritical: 0,
        lintWarn: 3,
        corpusFiles: 42,
        indexCommit: 'abc1234',
        indexBuiltAt: '2026-07-02T09:00:00.000Z',
        // smuggled extra key that must be dropped:
        rawCorpusText: 'весь текст корпуса',
      }),
    })
    const keys = Object.keys(payload.memoryHealth).sort()
    expect(keys).toEqual([...MEMORY_HEALTH_KEYS].sort())
    expect(JSON.stringify(payload.memoryHealth)).not.toContain('rawCorpusText')
    expect(JSON.stringify(payload.memoryHealth)).not.toContain('весь текст')
  })
})

describe('buildSnapshotPayload — v2 cockpit blocks (49.1-25, B21)', () => {
  it('Test 1: payload gains predictions/calibration/reflexFires/gates/corpusHealth + schemaVersion 2; session block unchanged', () => {
    writeLease()
    writeReflexAndGateJournal()
    writeCalibration('payments', [
      { verdict: 'hit', ts: '2026-07-02T10:00:00.000Z' },
      { verdict: 'miss', ts: '2026-07-02T10:10:00.000Z' },
      { verdict: 'hit', ts: '2026-07-02T10:20:00.000Z' },
    ])
    const payload = buildSnapshotPayload({
      identity,
      sessionsDir,
      journalDir,
      calibrationDir,
      loadMemoryHealth: () => ({ lintCritical: 0, lintWarn: 1, corpusFiles: 42, indexCommit: 'abc1234' }),
    })

    // schemaVersion + every v2 key present, all within the allowlist.
    expect(payload.schemaVersion).toBe(2)
    for (const k of Object.keys(payload)) expect(ALLOWED_KEYS).toContain(k)

    // predictions: recent verdicts (newest first), each {domain, verdict, ts}.
    expect(Array.isArray(payload.predictions)).toBe(true)
    expect(payload.predictions[0].domain).toBe('payments')
    expect(payload.predictions[0].verdict).toBe('hit')
    expect(payload.predictions[0].ts).toBe('2026-07-02T10:20:00.000Z')

    // calibration: per-domain hit-rate (2 hits / 1 miss => rate 2/3).
    expect(Array.isArray(payload.calibration)).toBe(true)
    const pay = payload.calibration.find((c: any) => c.domain === 'payments')
    expect(pay.n).toBe(3)
    expect(pay.hits).toBe(2)
    expect(pay.misses).toBe(1)
    expect(pay.rate).toBeCloseTo(2 / 3, 5)

    // reflexFires + gates gathered from the journal.
    expect(Array.isArray(payload.reflexFires)).toBe(true)
    expect(payload.reflexFires[0].noteId).toBe('feedback_x')
    expect(payload.reflexFires[0].tier).toBe('high')
    expect(Array.isArray(payload.gates)).toBe(true)
    expect(payload.gates[0].gateId).toBe('MIGRATION-SLOT')

    // corpusHealth carries the memory-health summary.
    expect(payload.corpusHealth).toBeTruthy()
    expect(payload.corpusHealth.corpusFiles).toBe(42)

    // Session block unchanged (v1 fields intact).
    expect(payload.terminalId).toBe('mozg')
    expect(payload.scopeGlobs).toEqual(['src/**', 'scripts/**'])
    expect(payload.collisionFeed).toBeDefined()
  })

  it('Test 2: each absent source yields an explicit null block (not zeros)', () => {
    writeLease()
    // No journal reflex/gate fires, no calibration ledger, no memory health.
    const payload = buildSnapshotPayload({
      identity,
      sessionsDir,
      journalDir,
      calibrationDir,
      loadMemoryHealth: () => null,
    })
    expect(payload.schemaVersion).toBe(2)
    expect(payload.predictions).toBeNull()
    expect(payload.calibration).toBeNull()
    expect(payload.reflexFires).toBeNull()
    expect(payload.gates).toBeNull()
    expect(payload.corpusHealth).toBeNull()
  })

  it('Test 3: named identity ("P49 Том" + work label) rides in the session block (FI-10)', () => {
    writeLease({ holderIdentity: 'P49 Том', scope: { globs: ['src/**'], description: 'платёжный модуль' } })
    const payload = buildSnapshotPayload({
      identity,
      sessionsDir,
      journalDir,
      calibrationDir,
      loadMemoryHealth: () => null,
    })
    expect(payload.holderIdentity).toBe('P49 Том')
    expect(payload.scopeDescription).toBe('платёжный модуль')
  })

  it('Test 4: payload stays under the 64 KB cap; feeds truncate oldest-first', () => {
    writeLease()
    // A large calibration ledger + many reflex fires to push size up.
    const many = Array.from({ length: 500 }, (_, i) => ({
      verdict: i % 2 ? 'hit' : 'miss',
      ts: `2026-07-02T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
    }))
    writeCalibration('payments', many)
    const reflexLines = Array.from({ length: 500 }, (_, i) =>
      JSON.stringify({
        ts: `2026-07-02T12:${String(i % 60).padStart(2, '0')}:00.000Z`,
        terminal: identity.terminalId,
        seq: i,
        type: 'reflex',
        actors: ['P49 Том'],
        scope: 'src/some/very/long/path/that/adds/bytes/checkout.ts',
        detail: { noteId: `feedback_note_${i}`, target: 'src/some/very/long/path', tier: 'high' },
      }),
    )
    writeFileSync(join(journalDir, `${identity.terminalId}.jsonl`), reflexLines.join('\n') + '\n')

    const payload = buildSnapshotPayload({
      identity,
      sessionsDir,
      journalDir,
      calibrationDir,
      loadMemoryHealth: () => null,
    })
    const size = Buffer.byteLength(JSON.stringify(payload), 'utf8')
    expect(size).toBeLessThanOrEqual(64 * 1024)
    // The feeds were bounded (not the full 500 items).
    expect(payload.predictions.length).toBeLessThan(500)
    expect(payload.reflexFires.length).toBeLessThan(500)
  })
})

describe('sendSnapshot — fail-open (Test 3, R12)', () => {
  it('an unreachable URL resolves without throwing, journals snapshot-fail, returns {sent:false}', async () => {
    writeLease()
    const failingFetch = async () => {
      throw new Error('ECONNREFUSED')
    }
    let res
    await expect(
      (async () => {
        res = await sendSnapshot({
          url: 'http://127.0.0.1:1/never',
          token: 'test-token',
          fetchImpl: failingFetch,
          identity,
          journalDir,
        })
      })(),
    ).resolves.toBeUndefined()

    expect(res).toBeTruthy()
    expect(res.sent).toBe(false)

    // a 'snapshot-fail' event was journaled
    const jl = join(journalDir, `${identity.terminalId}.jsonl`)
    expect(existsSync(jl)).toBe(true)
    const raw = readFileSync(jl, 'utf8')
    expect(raw).toContain('snapshot-fail')
  })
})

describe('sendSnapshot — no token (Test 4)', () => {
  // WR-09: sendSnapshot falls through to process.env.SMA_SNAPSHOT_TOKEN when no token is
  // passed. On any machine where A-047 has provisioned the token, that env var is set,
  // fetch would be called, and the no-token assertion would red the whole pre-push suite.
  // Stash + delete the env var so this test is hermetic regardless of the machine.
  let savedToken: string | undefined
  beforeEach(() => {
    savedToken = process.env.SMA_SNAPSHOT_TOKEN
    delete process.env.SMA_SNAPSHOT_TOKEN
  })
  afterEach(() => {
    if (savedToken === undefined) delete process.env.SMA_SNAPSHOT_TOKEN
    else process.env.SMA_SNAPSHOT_TOKEN = savedToken
  })

  it('with the token unset, no-ops cleanly ({sent:false, reason:"no-token"}) and never calls fetch', async () => {
    let fetchCalled = false
    const spyFetch = async () => {
      fetchCalled = true
      return { ok: true }
    }
    const res = await sendSnapshot({
      url: 'http://example.test/api',
      token: undefined,
      fetchImpl: spyFetch,
      identity,
      journalDir,
    })
    expect(res).toEqual({ sent: false, reason: 'no-token' })
    expect(fetchCalled).toBe(false)
  })
})

describe('runSnapshot — honors supplied dirs (WR-06)', () => {
  // WR-06: runSnapshot must PREFER caller-supplied sessionsDir/journalDir over its own
  // smaRoot() derivation, so SMA_ROOT_OVERRIDE (threaded from the CLI) is honored. Guard
  // the token so the no-token fast-path keeps this hermetic (no real network).
  let savedToken: string | undefined
  beforeEach(() => {
    savedToken = process.env.SMA_SNAPSHOT_TOKEN
    delete process.env.SMA_SNAPSHOT_TOKEN
  })
  afterEach(() => {
    if (savedToken === undefined) delete process.env.SMA_SNAPSHOT_TOKEN
    else process.env.SMA_SNAPSHOT_TOKEN = savedToken
  })

  it('accepts sessionsDir/journalDir and returns cleanly on the no-token path', async () => {
    writeLease()
    writeJournal(1)
    // With no token, the run resolves to no-token WITHOUT touching the real repo `.sma/`
    // or the network — proving the supplied dirs are accepted and threaded, not ignored.
    const res = await runSnapshot({ sessionsDir, journalDir })
    expect(res).toEqual({ sent: false, reason: 'no-token' })
  })
})
