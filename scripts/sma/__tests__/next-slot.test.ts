/**
 * Tests for scripts/sma/lib/slots.mjs (Phase 49 Plan 06).
 *
 * R9 external-state slots — the three shared counters that have burned this repo:
 *   Task 1 — nextMigrationSlot: fetch + numeric max + atomic claim + loser-gets-N+1
 *     - Test 1: numbers parse numerically (098, 099 -> 100; never lexicographic '0100')
 *     - Test 2: max(local, origin) — origin has 067, local has 066 -> next is 68
 *     - Test 3: two concurrent calls -> exactly one {number:N, won} + one {number:N+1, won, warn}
 *     - Test 4: a slot in cooldown is skipped — the next free number is offered
 *     - Test 5: the injected git runner received ONLY read subcommands (P5)
 *
 * A DI git runner (fakeGit) records every subcommand so tests never touch the network
 * and can assert the read-only invariant. Claims go to a per-test temp dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  nextMigrationSlot,
  nextReleaseVersion,
  verifyReleaseStillFree,
  acquirePushClaim,
  releasePushClaim,
  checkPushClaim,
  nextCounterSlot,
  extractMaxByRegex,
  markSlotConsumed,
  slotNameForKind,
  COUNTER_KINDS,
  SORTED_INSERT_RULE,
} from '../lib/slots.mjs'
import { claimSlot, markConsumed, isConsumed, reconcileExpiredClaim } from '../lib/claims.mjs'
import { readJournal } from '../lib/journal.mjs'
import { readFileSync, writeFileSync as writeFileSyncNode, existsSync } from 'node:fs'
import { PUSH_CLAIM_TTL_MS, SLOT_CLAIM_TTL_MS } from '../lib/constants.mjs'

let claimsDir: string
let migPath: string

/**
 * makeFakeGit — a DI runner. `blobs` maps 'origin/main:<path>' -> file text (for `show`);
 * `tags` is the list returned by `tag -l`. Records EVERY args array it receives.
 */
function makeFakeGit(opts: { blobs?: Record<string, string>; tags?: string[]; failFetch?: boolean } = {}) {
  const calls: string[][] = []
  const runner = (args: string[]) => {
    calls.push(args)
    const [sub] = args
    if (sub === 'fetch') {
      if (opts.failFetch) throw new Error('offline')
      return ''
    }
    if (sub === 'show') {
      const ref = args[1]
      return (opts.blobs && opts.blobs[ref]) ?? ''
    }
    if (sub === 'tag') {
      return (opts.tags ?? []).join('\n')
    }
    if (sub === 'rev-parse' || sub === 'log') {
      return ''
    }
    throw new Error(`unexpected git subcommand in test: ${sub}`)
  }
  return { runner, calls }
}

/** Build a synthetic src/migrations/index.ts body with the given three-digit prefixes. */
function migrationsFile(prefixes: string[]): string {
  const entries = prefixes.map((p) => `  { name: '${p}_synthetic_fixture_migration', up: async () => {}, down: async () => {} },`)
  return `export const prodMigrations = [\n${entries.join('\n')}\n]\n`
}

beforeEach(() => {
  claimsDir = mkdtempSync(join(tmpdir(), 'sma-slots-claims-'))
  const d = mkdtempSync(join(tmpdir(), 'sma-slots-mig-'))
  migPath = join(d, 'index.ts')
})

afterEach(() => {
  rmSync(claimsDir, { recursive: true, force: true })
})

const READ_SUBCOMMANDS = new Set(['fetch', 'show', 'tag', 'rev-parse', 'log'])

describe('nextMigrationSlot — numeric max + atomic claim (R9a, B21)', () => {
  it('Test 1: numbers parse numerically (098, 099 -> 100, never lexicographic)', () => {
    writeFileSync(migPath, migrationsFile(['097', '098', '099']))
    const { runner } = makeFakeGit({ blobs: { 'origin/main:src/migrations/index.ts': migrationsFile(['097', '098', '099']) } })
    const res = nextMigrationSlot({ execGit: runner, migrationsPath: migPath, by: 'alice', session: 's-a', claimsDir })
    expect(res.won).toBe(true)
    expect(res.number).toBe(100)
    expect(res.name).toContain('100')
  })

  it('Test 2: max(local, origin) — origin 067 wins over local 066 -> next is 68', () => {
    writeFileSync(migPath, migrationsFile(['065', '066']))
    const { runner } = makeFakeGit({ blobs: { 'origin/main:src/migrations/index.ts': migrationsFile(['065', '066', '067']) } })
    const res = nextMigrationSlot({ execGit: runner, migrationsPath: migPath, by: 'alice', session: 's-a', claimsDir })
    expect(res.won).toBe(true)
    expect(res.number).toBe(68)
  })

  it('Test 3: two concurrent calls -> exactly one N + one N+1 (warn naming the first claimant)', async () => {
    writeFileSync(migPath, migrationsFile(['070']))
    const blob = { 'origin/main:src/migrations/index.ts': migrationsFile(['070']) }
    const g1 = makeFakeGit({ blobs: blob })
    const g2 = makeFakeGit({ blobs: blob })

    const [r1, r2] = await Promise.all([
      Promise.resolve().then(() => nextMigrationSlot({ execGit: g1.runner, migrationsPath: migPath, by: 'alice', session: 's-a', claimsDir })),
      Promise.resolve().then(() => nextMigrationSlot({ execGit: g2.runner, migrationsPath: migPath, by: 'bob', session: 's-b', claimsDir })),
    ])

    const numbers = [r1.number, r2.number].sort((a, b) => a - b)
    expect(numbers).toEqual([71, 72])
    expect(r1.won).toBe(true)
    expect(r2.won).toBe(true)
    // Exactly one carries the N+1 warn.
    const withWarn = [r1, r2].filter((r) => r.warn)
    expect(withWarn).toHaveLength(1)
    expect(withWarn[0].number).toBe(72)
    // The warn names the first claimant (the holder of slot 71).
    expect(String(withWarn[0].warn)).toMatch(/alice|bob/)
  })

  it('Test 4: a slot in cooldown is skipped — the next free number is offered (B27)', () => {
    writeFileSync(migPath, migrationsFile(['080']))
    const blob = { 'origin/main:src/migrations/index.ts': migrationsFile(['080']) }
    // Pre-claim + release 081 so it enters cooldown.
    claimSlot('migration-081', { by: 'x', session: 's', expectedPrev: null, reason: 'initial' }, { claimsDir })
    // Manually drop a fresh cooldown marker for migration-081.
    writeFileSync(join(claimsDir, '.cooldown-migration-081'), String(Date.now()))
    rmSync(join(claimsDir, 'migration-081'), { recursive: true, force: true })

    const { runner } = makeFakeGit({ blobs: blob })
    const res = nextMigrationSlot({ execGit: runner, migrationsPath: migPath, by: 'alice', session: 's-a', claimsDir })
    expect(res.won).toBe(true)
    expect(res.number).toBe(82) // 081 skipped (cooling down), 082 offered
  })

  it('Test 5: the injected git runner received ONLY read subcommands (P5)', () => {
    writeFileSync(migPath, migrationsFile(['090']))
    const { runner, calls } = makeFakeGit({ blobs: { 'origin/main:src/migrations/index.ts': migrationsFile(['090']) } })
    nextMigrationSlot({ execGit: runner, migrationsPath: migPath, by: 'alice', session: 's-a', claimsDir })
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) {
      expect(READ_SUBCOMMANDS.has(args[0])).toBe(true)
    }
  })

  it('WR-03: slot claim events land in journalDir, NOT the claims dir', () => {
    const journalDir = mkdtempSync(join(tmpdir(), 'sma-slots-journal-'))
    try {
      writeFileSync(migPath, migrationsFile(['090']))
      const { runner } = makeFakeGit({ blobs: { 'origin/main:src/migrations/index.ts': migrationsFile(['090']) } })
      const res = nextMigrationSlot({
        execGit: runner,
        migrationsPath: migPath,
        by: 'alice',
        terminalId: 'alice',
        session: 's-a',
        claimsDir,
        journalDir,
      })
      expect(res.won).toBe(true)
      // The 'claim' event must be in the journal dir, and the claims dir must hold
      // ONLY the lock entry (no .jsonl journal line).
      const journalFiles = readdirSync(journalDir).filter((f) => f.endsWith('.jsonl'))
      expect(journalFiles).toContain('alice.jsonl')
      const claimsJsonl = readdirSync(claimsDir).filter((f) => f.endsWith('.jsonl'))
      expect(claimsJsonl).toHaveLength(0)
    } finally {
      rmSync(journalDir, { recursive: true, force: true })
    }
  })

  it('SORTED_INSERT_RULE is an exported non-empty string documenting the git-conflict rule (B21)', () => {
    expect(typeof SORTED_INSERT_RULE).toBe('string')
    expect(SORTED_INSERT_RULE.length).toBeGreaterThan(20)
  })
})

describe('nextReleaseVersion — V1.N numeric counter (R9b, B22)', () => {
  it('Test 1: tags [V1.8, V1.9] -> next is V1.10 (numeric compare, SPEC-mandated case)', () => {
    const { runner } = makeFakeGit({ tags: ['V1.8', 'V1.9'] })
    const res = nextReleaseVersion({ execGit: runner })
    expect(res.version).toBe('V1.10')
  })

  it('Test 2: tags [V1.47] -> V1.48; fetch --tags precedes the tag listing (order asserted)', () => {
    const { runner, calls } = makeFakeGit({ tags: ['V1.47'] })
    const res = nextReleaseVersion({ execGit: runner })
    expect(res.version).toBe('V1.48')
    // The fetch --tags call must come BEFORE the tag -l listing (B22).
    const fetchIdx = calls.findIndex((c) => c[0] === 'fetch' && c.includes('--tags'))
    const listIdx = calls.findIndex((c) => c[0] === 'tag')
    expect(fetchIdx).toBeGreaterThanOrEqual(0)
    expect(listIdx).toBeGreaterThan(fetchIdx)
  })

  it('Test 3: verifyReleaseStillFree returns false when a fresh list now contains the version (B22)', () => {
    const { runner } = makeFakeGit({ tags: ['V1.47', 'V1.48'] })
    expect(verifyReleaseStillFree('V1.48', { execGit: runner })).toBe(false)
    const g2 = makeFakeGit({ tags: ['V1.47'] })
    expect(verifyReleaseStillFree('V1.48', { execGit: g2.runner })).toBe(true)
  })
})

describe('deploy-signal advisory claim — queue-never-cancel (R9c, B23, P3)', () => {
  it('Test 4: A acquires, B checks -> B gets {live:true, warn} with A identity + acquireTime; nothing cancelled', () => {
    const acq = acquirePushClaim({ by: 'terminalA', session: 's-a', plannedVersion: 'V1.48', claimsDir })
    expect(acq.acquired).toBe(true)

    const check = checkPushClaim({ by: 'terminalB', claimsDir })
    expect(check.live).toBe(true)
    expect(check.warn).toBeTruthy()
    expect(check.who).toBe('terminalA')
    expect(typeof check.since).toBe('string')
    expect(check.plannedVersion).toBe('V1.48')

    // Queue-never-cancel: A's claim is STILL present after B's check.
    const stillThere = checkPushClaim({ by: 'terminalC', claimsDir })
    expect(stillThere.live).toBe(true)
    expect(stillThere.who).toBe('terminalA')
  })

  it('Test 5: an expired claim -> {live:false, stale:true, needsHuman:true} — flagged, not auto-deleted (P3)', () => {
    // Acquire, then age the provenance beyond the TTL via a fake now.
    acquirePushClaim({ by: 'terminalA', session: 's-a', plannedVersion: 'V1.48', claimsDir })
    const future = Date.now() + PUSH_CLAIM_TTL_MS + 60000
    const check = checkPushClaim({ by: 'terminalB', claimsDir, now: future })
    expect(check.live).toBe(false)
    expect(check.stale).toBe(true)
    expect(check.needsHuman).toBe(true)
    // Not auto-deleted: the claim dir survives the stale check.
    const again = checkPushClaim({ by: 'terminalC', claimsDir, now: future })
    expect(again.stale).toBe(true)
  })

  it('releasePushClaim releases the OWN claim (post-confirm path)', () => {
    acquirePushClaim({ by: 'terminalA', session: 's-a', plannedVersion: 'V1.48', claimsDir })
    const rel = releasePushClaim({ by: 'terminalA', claimsDir })
    expect(rel.released).toBe(true)
    // After release the slot is free (cooldown aside — a fresh check reports not-live).
    const check = checkPushClaim({ by: 'terminalB', claimsDir })
    expect(check.live).toBe(false)
  })
})

describe('P5 — no push subcommand across the whole module (T-49-06-01)', () => {
  it('every git call in nextReleaseVersion + verify is a read subcommand', () => {
    const { runner, calls } = makeFakeGit({ tags: ['V1.10'] })
    nextReleaseVersion({ execGit: runner })
    verifyReleaseStillFree('V1.11', { execGit: runner })
    for (const args of calls) {
      expect(READ_SUBCOMMANDS.has(args[0])).toBe(true)
    }
  })
})

// ── B11 — all-counter slots (bl / action / decision / phase) ────────────────────────
//
// Fixtures mirror the LIVE .planning source files' parse-relevant syntax verbatim (the
// `- [ ] **BL-NNN** ·` / `**A-NNN**` bullets, `D-49.1-NN` decision tags, `### Phase N`
// headings) per feedback_test_fixtures_mirror_live_files — a dead scanner is caught.

// Verbatim-format excerpt of .planning/BACKLOG.md (## Backlog section).
const BACKLOG_FIXTURE = `## Backlog

- [ ] **BL-120** · Пример пункта бэклога — что и зачем в одном предложении. \`size:M\` \`area:crm\` \`added:2026-07-03\`
- [ ] **BL-121** · Ещё один пункт бэклога — описание в одном предложении. \`size:S\` \`area:tech\` \`added:2026-07-03\`
`

// Verbatim-format excerpt of .planning/ACTIONS.md with the A-202 outlier ID present.
const ACTIONS_FIXTURE = `## Actions

- [ ] **A-054** · Настроить ключ у партнёра — как это закрыть. \`owner:ops\` \`area:tech\` \`added:2026-07-03\`
- [ ] **A-202** · Аномальный номер, вбитый вручную выше реального максимума. \`owner:ops\` \`area:tech\` \`added:2026-07-03\`
`

// Verbatim-format excerpt of a phase *-CONTEXT.md decision block.
const CONTEXT_FIXTURE = `## Decisions

- **D-49.1-14** · Первое решение фазы.
- **D-49.1-15** · Второе решение фазы.
`

// Verbatim-format excerpt of .planning/ROADMAP.md phase headings (incl. a dotted N.M).
const ROADMAP_FIXTURE = `### Phase 52: Search — Indexing Pipeline

### Phase 53: Reports — Export Engine

### Phase 49.1: SMA V2 — Predictions, Reflexes, Enforcement
`

describe('nextCounterSlot — all-counter slots (B11, FI-5)', () => {
  let planningRoot: string

  beforeEach(() => {
    planningRoot = mkdtempSync(join(tmpdir(), 'sma-counter-planning-'))
  })
  afterEach(() => {
    rmSync(planningRoot, { recursive: true, force: true })
  })

  it('COUNTER_KINDS lists the four new kinds', () => {
    expect(COUNTER_KINDS).toEqual(expect.arrayContaining(['bl', 'action', 'decision', 'phase']))
  })

  it('Test 1: next-slot bl over a BACKLOG fixture (incl. BL-121) returns BL-122', () => {
    const backlogPath = join(planningRoot, 'BACKLOG.md')
    writeFileSync(backlogPath, BACKLOG_FIXTURE)
    const res = nextCounterSlot('bl', { backlogPath, by: 'alice', claimsDir })
    expect(res.won).toBe(true)
    expect(res.number).toBe(122)
    expect(res.id).toBe('BL-122')
  })

  it('Test 2: next-slot action with the A-202 outlier present returns max+1 (A-203)', () => {
    const actionsPath = join(planningRoot, 'ACTIONS.md')
    writeFileSync(actionsPath, ACTIONS_FIXTURE)
    const res = nextCounterSlot('action', { actionsPath, by: 'alice', claimsDir })
    expect(res.won).toBe(true)
    expect(res.number).toBe(203)
    expect(res.id).toBe('A-203') // outliers never collide again — numeric max wins
  })

  it('Test 3: next-slot decision --phase 49.1 scans the phase CONTEXT.md and returns the next', () => {
    const contextPath = join(planningRoot, '49.1-CONTEXT.md')
    writeFileSync(contextPath, CONTEXT_FIXTURE)
    const res = nextCounterSlot('decision', { phase: '49.1', contextPath, by: 'alice', claimsDir })
    expect(res.won).toBe(true)
    expect(res.number).toBe(16)
    expect(res.id).toBe('D-49.1-16')
  })

  it('decision without --phase is refused (no source to scan)', () => {
    const res = nextCounterSlot('decision', { by: 'alice', claimsDir })
    expect(res.won).toBe(false)
    expect(String(res.warn)).toMatch(/phase/i)
  })

  it('Test 4: next-slot phase scans ### Phase headings (incl. dotted N.M) -> next integer', () => {
    const roadmapPath = join(planningRoot, 'ROADMAP.md')
    writeFileSync(roadmapPath, ROADMAP_FIXTURE)
    const res = nextCounterSlot('phase', { roadmapPath, by: 'alice', claimsDir })
    expect(res.won).toBe(true)
    expect(res.number).toBe(54) // max integer heading (53) + 1; the dotted 49.1 never wins
    expect(res.id).toBe('54')
  })

  it('Test 5: two concurrent claims of the SAME kind resolve to different numbers', async () => {
    const backlogPath = join(planningRoot, 'BACKLOG.md')
    writeFileSync(backlogPath, BACKLOG_FIXTURE)
    const [r1, r2] = await Promise.all([
      Promise.resolve().then(() => nextCounterSlot('bl', { backlogPath, by: 'alice', session: 's-a', claimsDir })),
      Promise.resolve().then(() => nextCounterSlot('bl', { backlogPath, by: 'bob', session: 's-b', claimsDir })),
    ])
    expect(r1.won).toBe(true)
    expect(r2.won).toBe(true)
    const numbers = [r1.number, r2.number].sort((a, b) => a - b)
    expect(numbers).toEqual([122, 123]) // one gets 122, the loser retries at 123
    const withWarn = [r1, r2].filter((r) => r.warn)
    expect(withWarn).toHaveLength(1)
    expect(withWarn[0].number).toBe(123)
  })

  it('dry-run reports the next number WITHOUT claiming (read-only, no slot held)', () => {
    const backlogPath = join(planningRoot, 'BACKLOG.md')
    writeFileSync(backlogPath, BACKLOG_FIXTURE)
    const res = nextCounterSlot('bl', { backlogPath, by: 'alice', claimsDir, dryRun: true })
    expect(res.won).toBe(true)
    expect(res.dryRun).toBe(true)
    expect(res.number).toBe(122)
    // A follow-up real claim still gets 122 (dry-run held nothing).
    const real = nextCounterSlot('bl', { backlogPath, by: 'alice', claimsDir })
    expect(real.number).toBe(122)
  })

  it('a missing source file fails open to the first slot (empty -> BL-1)', () => {
    const res = nextCounterSlot('bl', { backlogPath: join(planningRoot, 'nope.md'), by: 'alice', claimsDir })
    expect(res.won).toBe(true)
    expect(res.number).toBe(1)
  })

  it('extractMaxByRegex is integer-domain (BL-9 < BL-10, never lexicographic)', () => {
    expect(extractMaxByRegex('**BL-9** **BL-10**', /\*\*BL-(\d+)\*\*/g)).toBe(10)
    expect(extractMaxByRegex('', /\*\*BL-(\d+)\*\*/g)).toBe(-1)
  })

  it('scanners never MUTATE the source file (read-only prohibition)', () => {
    const backlogPath = join(planningRoot, 'BACKLOG.md')
    writeFileSync(backlogPath, BACKLOG_FIXTURE)
    nextCounterSlot('bl', { backlogPath, by: 'alice', claimsDir })
    expect(readFileSync(backlogPath, 'utf8')).toBe(BACKLOG_FIXTURE) // byte-identical
  })
})

// ── 49.1-23 (B17) — idempotent slot reconciliation (the claimed-but-not-consumed gap) ─
//
// A terminal claims a number slot then dies before writing the number into the source.
// The old scan saw the live claim dir and skipped that number forever. Reconcile: an
// UNconsumed claim older than SLOT_CLAIM_TTL_MS is abandoned -> the SAME number reissues.

/** Backdate a claim's provenance.at beyond the TTL (simulate an abandoned, aged claim). */
function ageClaim(claimsDir: string, slotName: string, olderThanMs: number) {
  const provPath = join(claimsDir, slotName, 'provenance.json')
  const prov = JSON.parse(readFileSync(provPath, 'utf8'))
  prov.at = new Date(Date.now() - olderThanMs).toISOString()
  writeFileSyncNode(provPath, JSON.stringify(prov))
}

describe('slot reconciliation — expired unconsumed claims are re-issued (49.1-23, B17)', () => {
  it('reconcileExpiredClaim removes an expired UNconsumed claim, spares a fresh or consumed one', () => {
    // fresh -> spared
    claimSlot('migration-500', { by: 'x', session: 's', expectedPrev: null, reason: 'migration-number' }, { claimsDir })
    expect(reconcileExpiredClaim('migration-500', { claimsDir }).reconciled).toBe(false)
    // aged + unconsumed -> reconciled
    ageClaim(claimsDir, 'migration-500', SLOT_CLAIM_TTL_MS + 60000)
    const rec = reconcileExpiredClaim('migration-500', { claimsDir })
    expect(rec.reconciled).toBe(true)
    expect(existsSync(join(claimsDir, 'migration-500'))).toBe(false)
    // aged + consumed -> spared
    claimSlot('migration-501', { by: 'x', session: 's', expectedPrev: null, reason: 'migration-number' }, { claimsDir })
    markConsumed('migration-501', { claimsDir })
    ageClaim(claimsDir, 'migration-501', SLOT_CLAIM_TTL_MS + 60000)
    expect(reconcileExpiredClaim('migration-501', { claimsDir }).reconciled).toBe(false)
  })

  it('Test 6: nextMigrationSlot RE-ISSUES the number an expired unconsumed claim held (no leak to N+1)', () => {
    const journalDir = mkdtempSync(join(tmpdir(), 'sma-slots-journal-'))
    try {
      writeFileSync(migPath, migrationsFile(['099']))
      const blob = { 'origin/main:src/migrations/index.ts': migrationsFile(['099']) }
      // A ghost terminal claimed 100 but never wrote the migration (no consume) and died.
      claimSlot('migration-100', { by: 'ghost', session: 's', expectedPrev: '099', reason: 'migration-number' }, { claimsDir })
      ageClaim(claimsDir, 'migration-100', SLOT_CLAIM_TTL_MS + 60000)

      const { runner } = makeFakeGit({ blobs: blob })
      const res = nextMigrationSlot({ execGit: runner, migrationsPath: migPath, by: 'alice', terminalId: 'alice', session: 's-a', claimsDir, journalDir })
      expect(res.won).toBe(true)
      expect(res.number).toBe(100) // reconciled — the ghost's abandoned 100 is re-issued, NOT leaked to 101
      expect(res.reconciled).toBe(true)
      // a reconcile event is journaled
      const { events } = readJournal({ journalDir })
      expect(events.some((e) => e.type === 'reconcile' && e.scope === 'migration-100')).toBe(true)
    } finally {
      rmSync(journalDir, { recursive: true, force: true })
    }
  })

  it('Test 7: a CONSUMED expired claim is NOT reconciled — the number stays taken (retry at N+1)', () => {
    writeFileSync(migPath, migrationsFile(['099']))
    const blob = { 'origin/main:src/migrations/index.ts': migrationsFile(['099']) }
    claimSlot('migration-100', { by: 'ghost', session: 's', expectedPrev: '099', reason: 'migration-number' }, { claimsDir })
    markConsumed('migration-100', { claimsDir }) // the number WAS actually used
    ageClaim(claimsDir, 'migration-100', SLOT_CLAIM_TTL_MS + 60000)

    const { runner } = makeFakeGit({ blobs: blob })
    const res = nextMigrationSlot({ execGit: runner, migrationsPath: migPath, by: 'alice', session: 's-a', claimsDir })
    expect(res.won).toBe(true)
    expect(res.number).toBe(101) // consumed -> 100 stays taken, next free is 101
  })

  it('markSlotConsumed maps kind+n to the right slot and writes the consumed marker', () => {
    claimSlot('bl-122', { by: 'x', session: 's', expectedPrev: null, reason: 'bl-number' }, { claimsDir })
    const res = markSlotConsumed('bl', 122, { claimsDir })
    expect(res.consumed).toBe(true)
    expect(res.slot).toBe('bl-122')
    expect(isConsumed('bl-122', { claimsDir })).toBe(true)
    // decision without --phase cannot resolve a slot name
    expect(markSlotConsumed('decision', 16, { claimsDir }).consumed).toBe(false)
    expect(slotNameForKind('decision', 16, { phase: '49.1' })).toBe('decision-49.1-16')
    expect(slotNameForKind('migration', 7)).toBe('migration-007')
  })

  it('nextCounterSlot also reconciles an expired unconsumed counter claim (bl)', () => {
    const planningRoot = mkdtempSync(join(tmpdir(), 'sma-counter-recon-'))
    try {
      const backlogPath = join(planningRoot, 'BACKLOG.md')
      writeFileSync(backlogPath, BACKLOG_FIXTURE) // max BL-121 -> next candidate 122
      claimSlot('bl-122', { by: 'ghost', session: 's', expectedPrev: '121', reason: 'bl-number' }, { claimsDir })
      ageClaim(claimsDir, 'bl-122', SLOT_CLAIM_TTL_MS + 60000)
      const res = nextCounterSlot('bl', { backlogPath, by: 'alice', claimsDir })
      expect(res.won).toBe(true)
      expect(res.number).toBe(122) // the abandoned 122 is re-issued
      expect(res.reconciled).toBe(true)
    } finally {
      rmSync(planningRoot, { recursive: true, force: true })
    }
  })
})
