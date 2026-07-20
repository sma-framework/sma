/**
 * Tests for subagent-receipts.mjs — transcript claim extraction + tree verification
 * + the shared-journal receipt (Phase 9.2 Plan 04, Task 2).
 *
 * Everything is DI: readFn feeds a fixture transcript string, runGit/statFile are
 * injected stubs (never git, never the real fs), appendEvent is a spy. Deterministic.
 */

import { describe, it, expect } from 'vitest'
import { join, resolve } from 'node:path'

import {
  VERDICTS,
  NEGATION_STOPLIST,
  extractClaimedWrites,
  verifyWrites,
  writeReceipt,
  correlateSpawn,
  receiptStats,
  receiptStatsSchemaOk,
  dedupeByTranscriptSha,
} from '../lib/subagent-receipts.mjs'

/** A minimal Claude-Code-shaped transcript JSONL fixture (as a string). */
function transcript(lines: any[]): string {
  return lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
}

const FIXTURE = transcript([
  // a successful Write tool_use…
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'Write', input: { file_path: 'scripts/sma/a.mjs' } }],
    },
  },
  // …its ok tool_result (is_error absent).
  {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
  },
  // an Edit that ERRORED (is_error true).
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_2', name: 'Edit', input: { file_path: 'scripts/sma/b.mjs' } }],
    },
  },
  {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', is_error: true, content: 'boom' }] },
  },
  '{ this is a corrupt line',
  // the FINAL assistant message asserts writes + mentions a read-only path.
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'I created scripts/sma/c.mjs and updated scripts/sma/a.mjs.\nI also read scripts/sma/d.mjs for context.\nVersion bumped to 3.14 here.',
        },
      ],
    },
  },
])

describe('Task 2 — extractClaimedWrites', () => {
  it('Test 1: tool_use writes yield tool-call claims with toolResultOk from the paired result; corrupt lines counted', () => {
    const { claims, corrupt } = extractClaimedWrites('t.jsonl', { readFn: () => FIXTURE })
    expect(corrupt).toBe(1) // the one corrupt line, skipped not thrown

    const tool = claims.filter((c) => c.tier === 'tool-call')
    expect(tool).toEqual([
      { path: 'scripts/sma/a.mjs', tier: 'tool-call', toolResultOk: true },
      { path: 'scripts/sma/b.mjs', tier: 'tool-call', toolResultOk: false }, // errored result
    ])
  })

  it('Test 2: asserted-tier extraction from the FINAL message only — write-verb lines, not read-mentions or versions', () => {
    const { claims } = extractClaimedWrites('t.jsonl', { readFn: () => FIXTURE })
    const asserted = claims.filter((c) => c.tier === 'asserted').map((c) => c.path)
    expect(asserted).toContain('scripts/sma/c.mjs') // "created …c.mjs"
    expect(asserted).toContain('scripts/sma/a.mjs') // "updated …a.mjs"
    expect(asserted).not.toContain('scripts/sma/d.mjs') // "read …d.mjs" has no write verb → not a claim
    // the "3.14" version is not a path token (letter-initial extension guard)
    expect(asserted.some((p) => p.includes('3.14'))).toBe(false)
  })
})

describe('Task 2 — verifyWrites verdict matrix', () => {
  const repoRoot = resolve('/repo')

  function runGitFactory(map: Record<string, string>) {
    return (cmd: string, args: string[]) => {
      // literal '--' must precede the path
      expect(args).toContain('--')
      const path = args[args.length - 1]
      const key = `${cmd}:${path}`
      return map[key] ?? ''
    }
  }

  it('Test 3: exists+dirty / exists+clean+commit / exists+clean+nocommit / missing / errored / outside-repo', () => {
    const claims = [
      { path: 'dirty.mjs', tier: 'tool-call', toolResultOk: true },
      { path: 'committed.mjs', tier: 'tool-call', toolResultOk: true },
      { path: 'unchanged.mjs', tier: 'tool-call', toolResultOk: true },
      { path: 'gone.mjs', tier: 'tool-call', toolResultOk: true },
      { path: 'errored.mjs', tier: 'tool-call', toolResultOk: false },
      { path: '../outside.mjs', tier: 'tool-call', toolResultOk: true },
      { path: null, tier: 'tool-call', toolResultOk: true },
    ]
    const existing = new Set(['dirty.mjs', 'committed.mjs', 'unchanged.mjs', 'errored.mjs'].map((p) => join(repoRoot, p)))
    const runGit = runGitFactory({
      'status:dirty.mjs': ' M dirty.mjs',
      'status:committed.mjs': '',
      'status:unchanged.mjs': '',
      'log:committed.mjs': 'abc123',
      'log:unchanged.mjs': '',
    })
    const out = verifyWrites(claims, {
      repoRoot,
      spawnedAt: '2026-07-08T00:00:00Z',
      runGit,
      statFile: (abs: string) => existing.has(abs),
    })
    const byPath = Object.fromEntries(out.map((r) => [String(r.path), r.verdict]))
    expect(byPath['dirty.mjs']).toBe('verified')
    expect(byPath['committed.mjs']).toBe('verified')
    expect(byPath['unchanged.mjs']).toBe('phantom-unchanged')
    expect(byPath['gone.mjs']).toBe('phantom-missing')
    expect(byPath['errored.mjs']).toBe('divergent')
    expect(byPath['../outside.mjs']).toBe('unverifiable')
    expect(byPath['null']).toBe('unverifiable') // malformed null path never throws
    // every verdict is a member of the fixed enum
    for (const r of out) expect(VERDICTS).toContain(r.verdict)
  })

  it('Test 4: runGit receives arg arrays with a literal "--" before the path — no shell string built', () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const runGit = (cmd: string, args: string[]) => {
      calls.push({ cmd, args })
      return cmd === 'status' ? '' : '' // clean + no commit
    }
    verifyWrites([{ path: 'src/x.ts', tier: 'tool-call', toolResultOk: true }], {
      repoRoot,
      spawnedAt: '2026-07-08T00:00:00Z',
      runGit,
      statFile: () => true,
    })
    // status call: ['--porcelain', '--', 'src/x.ts']
    const status = calls.find((c) => c.cmd === 'status')!
    expect(status.args.indexOf('--')).toBe(status.args.length - 2)
    expect(status.args[status.args.length - 1]).toBe('src/x.ts')
    // log call: ['--since=…', '--format=%H', '--', 'src/x.ts']
    const log = calls.find((c) => c.cmd === 'log')!
    expect(log.args).toContain('--')
    expect(log.args.indexOf('--')).toBe(log.args.length - 2)
    expect(log.args[log.args.length - 1]).toBe('src/x.ts')
    expect(log.args.some((a) => a.startsWith('--since='))).toBe(true)
  })
})

describe('Task 2 — verifyWrites repoRoot normalization (Windows regression)', () => {
  it('normalizes a forward-slashed repoRoot so paths inside it are not falsely unverifiable', () => {
    // production repoRoot arrives forward-slashed (registry.smaRoot normalizes to '/');
    // resolve(path) yields OS separators. verifyWrites must resolve both sides.
    const fwd = resolve('/repo').replace(/\\/g, '/') // e.g. 'C:/repo' on Windows
    const out = verifyWrites([{ path: 'inside.mjs', tier: 'tool-call', toolResultOk: true }], {
      repoRoot: fwd,
      spawnedAt: '2026-07-08T00:00:00Z',
      runGit: (cmd: string) => (cmd === 'status' ? ' M inside.mjs' : ''),
      statFile: () => true,
    })
    expect(out[0].verdict).toBe('verified') // NOT 'unverifiable'
  })
})

describe('Task 2 — receipt + stats', () => {
  it('Test 5: writeReceipt appends EXACTLY ONE subagent-receipt event with counts + spawn correlation; missing spawn → null', () => {
    const verdicts = [
      { path: 'a.mjs', tier: 'tool-call', verdict: 'verified' },
      { path: 'b.mjs', tier: 'tool-call', verdict: 'phantom-missing' },
      { path: 'c.mjs', tier: 'asserted', verdict: 'phantom-unchanged' },
      { path: 'd.mjs', tier: 'tool-call', verdict: 'divergent' },
    ]
    // correlateSpawn picks the nearest-in-time unconsumed record for the window.
    const records = [
      { windowToken: 'w1', at: '2026-07-08T00:00:00Z', consumed: false },
      { windowToken: 'w1', at: '2026-07-08T00:05:00Z', consumed: false },
      { windowToken: 'w1', at: '2026-07-08T00:04:00Z', consumed: true }, // consumed → ignored
    ]
    const spawn = correlateSpawn(records, { windowToken: 'w1', at: '2026-07-08T00:04:30Z' })
    expect(spawn.at).toBe('2026-07-08T00:05:00Z') // nearest unconsumed

    let calls = 0
    let captured: any = null
    const appendEvent = (rec: any) => {
      calls += 1
      captured = rec
    }
    const rec = writeReceipt(
      { verdicts, transcriptSha: 'deadbeef', spawn },
      { appendEvent, terminalId: 't-1', journalDir: '/j' },
    )
    expect(calls).toBe(1) // EXACTLY one journal append
    expect(captured.type).toBe('subagent-receipt')
    expect(captured.detail.transcriptSha).toBe('deadbeef')
    expect(captured.detail.spawn.at).toBe('2026-07-08T00:05:00Z')
    expect(captured.detail.counts).toEqual({
      verified: 1,
      phantomToolCall: 1, // b.mjs
      phantomAsserted: 1, // c.mjs
      divergent: 1,
      unverifiable: 0,
    })
    expect(rec.detail.claims).toHaveLength(4)

    // a missing spawn record still lands a receipt with spawn:null (fail-open honest).
    expect(correlateSpawn([], { windowToken: 'w1' })).toBe(null)
    const rec2 = writeReceipt({ verdicts: [], transcriptSha: null, spawn: null }, {})
    expect(rec2.detail.spawn).toBe(null)
  })

  it('Test 6: receiptStats — coverage, phantoms (tool-call only), asserted separate, pack-p95; honest empty', () => {
    const events = [
      { type: 'subagent-pack', detail: { durationMs: 100 } },
      { type: 'subagent-pack', detail: { durationMs: 200 } },
      {
        type: 'subagent-receipt',
        detail: { counts: { verified: 2, phantomToolCall: 1, phantomAsserted: 3, divergent: 0, unverifiable: 0 } },
      },
      // only 1 receipt for 2 spawns → coverage 50
    ]
    const s = receiptStats(events)
    expect(s.coverage).toBe(50)
    expect(s.phantoms).toBe(1) // tool-call phantom only
    expect(s.phantomsAsserted).toBe(3) // counted separately, excluded from `phantoms`
    expect(s.packP95).toBe(200)
    expect(s.empty).toBe(false)

    // honest empty state: zero spawns → coverage 100, phantoms 0, pack-p95 0, empty
    const e = receiptStats([])
    expect(e).toMatchObject({ coverage: 100, phantoms: 0, packP95: 0, empty: true })
  })
})

// ── BL-172 (2026-07-10): the --schema-check contract — receipts pin STRUCTURE, never accruing state ──

describe('receiptStatsSchemaOk — deterministic report-shape check (BL-172)', () => {
  it('accepts the honest-empty stats AND a heavily-populated stats object — accrual never changes the verdict', () => {
    expect(receiptStatsSchemaOk(receiptStats([]))).toBe(true)
    const packs = Array.from({ length: 594 }, (_, i) => ({ type: 'subagent-pack', detail: { durationMs: i } }))
    const recs = Array.from({ length: 594 }, () => ({
      type: 'subagent-receipt',
      detail: { counts: { phantomToolCall: 1, phantomAsserted: 2 } },
    }))
    expect(receiptStatsSchemaOk(receiptStats([...packs, ...recs]))).toBe(true)
  })

  it('rejects a missing key, a non-finite number, a non-boolean empty, and a non-object', () => {
    const good = receiptStats([])
    const { packP95: _dropped, ...missingKey } = good
    expect(receiptStatsSchemaOk(missingKey)).toBe(false)
    expect(receiptStatsSchemaOk({ ...good, phantoms: NaN })).toBe(false)
    expect(receiptStatsSchemaOk({ ...good, coverage: 'high' })).toBe(false)
    expect(receiptStatsSchemaOk({ ...good, empty: 'yes' })).toBe(false)
    expect(receiptStatsSchemaOk(null)).toBe(false)
    expect(receiptStatsSchemaOk([])).toBe(false)
  })
})

// ── BL-173 (9.4-03): the three false-positive mechanisms killed, with the 9 forensic ──
// rows (9.3-PHANTOM-FORENSICS.md — 0 real phantoms / 4 path artifacts / 5 instrument
// artifacts) as permanent regression fixtures.

describe('forensics — BL-173 asserted-tier precision (9.3-PHANTOM-FORENSICS.md)', () => {
  const repoRoot = resolve('/repo')

  /** runGit dispatcher: status/log from a map, ls-files from a fixed hit list. */
  function runGitWith({ status = {}, log = {}, lsFiles = [] }: {
    status?: Record<string, string>
    log?: Record<string, string>
    lsFiles?: string[]
  }) {
    return (cmd: string, args: string[]) => {
      if (cmd === 'ls-files') return lsFiles.join('\n')
      const path = args[args.length - 1]
      if (cmd === 'status') return status[path] ?? ''
      if (cmd === 'log') return log[path] ?? ''
      return ''
    }
  }

  // ── Mechanism 1: repo-root basename resolution (rows 1/3/4/9) ──

  it('Test 2 (rows 3/4/9): a bare basename asserted in prose cross-matches the SAME receipt’s tool-call full path → verified, never phantom', () => {
    // rows 3, 4 (t-11d14cec) and 9 (t-db76a899): the full path was tool-call-VERIFIED in the
    // same receipt; the bare basename in the final message must resolve to it.
    const claims = [
      { path: '.planning/phases/46.2-x/46.2-DOD.json', tier: 'tool-call', toolResultOk: true },
      { path: '.planning/phases/46.2-x/46.2-VERIFICATION.md', tier: 'tool-call', toolResultOk: true },
      { path: '.planning/DATA-MERGE-PLAN.md', tier: 'tool-call', toolResultOk: true },
      { path: '46.2-DOD.json', tier: 'asserted', toolResultOk: true }, // row 3
      { path: '46.2-VERIFICATION.md', tier: 'asserted', toolResultOk: true }, // row 4
      { path: 'DATA-MERGE-PLAN.md', tier: 'asserted', toolResultOk: true }, // row 9
    ]
    const out = verifyWrites(claims, {
      repoRoot,
      spawnedAt: '2026-07-09T00:00:00Z',
      // tool-call full paths are dirty → verified; ls-files never needed (cross-match wins first)
      runGit: runGitWith({
        status: {
          '.planning/phases/46.2-x/46.2-DOD.json': ' M x',
          '.planning/phases/46.2-x/46.2-VERIFICATION.md': ' M x',
          '.planning/DATA-MERGE-PLAN.md': ' M x',
        },
      }),
      statFile: () => true,
    })
    const asserted = out.filter((r) => r.tier === 'asserted')
    expect(asserted.map((r) => r.verdict)).toEqual(['verified', 'verified', 'verified'])
    for (const r of asserted) expect(r.reason).toBe('basename-crossmatch')
    // and NONE is a phantom
    expect(out.some((r) => String(r.verdict).startsWith('phantom'))).toBe(false)
  })

  it('Test 3a (row 1): a bare basename with NO tool-call match but multiple ls-files hits → unverifiable: ambiguous-basename (never phantom, never verified)', () => {
    // row 1: `deferred-items.md` is a common basename (one per phase dir) — many tree hits.
    const out = verifyWrites([{ path: 'deferred-items.md', tier: 'asserted', toolResultOk: true }], {
      repoRoot,
      spawnedAt: '2026-07-08T00:00:00Z',
      runGit: runGitWith({
        lsFiles: [
          '.planning/phases/53.1-x/deferred-items.md',
          '.planning/phases/9.4-x/deferred-items.md',
        ],
      }),
      statFile: () => false,
    })
    expect(out[0].verdict).toBe('unverifiable')
    expect(out[0].reason).toBe('ambiguous-basename')
  })

  it('Test 3b (row 1 pattern): a bare basename with EXACTLY one ls-files hit verifies against that path', () => {
    const out = verifyWrites([{ path: 'unique-plan.md', tier: 'asserted', toolResultOk: true }], {
      repoRoot,
      spawnedAt: '2026-07-08T00:00:00Z',
      runGit: runGitWith({ lsFiles: ['.planning/unique-plan.md'] }),
      statFile: () => false,
    })
    expect(out[0].verdict).toBe('verified')
    expect(out[0].reason).toBe('basename-lsfiles')
  })

  // ── Mechanism 2: write-verb line sweep (rows 2/7/8) + the positive guard ──

  it('Test 4 (rows 2/7/8): disclaimer / status-report sentences produce NO asserted claim; a genuine first-person write still does', () => {
    const NEG = transcript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              // row 2: stpa.mjs confirmed foreign/untracked (verb «modified» about Users.ts on the line)
              text:
                'I confirmed stpa.mjs is foreign/untracked; I modified src/Users.ts earlier.\n' +
                // row 7: parse-dump.ts modified but not in any commit (a dirty-state report)
                'I confirmed parse-dump.ts and its test are modified but not in any commit.\n' +
                // row 8: STATE.md modified by another terminal — an explicit disclaimer
                'STATE.md was modified by another terminal, not mine; left untouched.',
            },
          ],
        },
      },
    ])
    const negClaims = extractClaimedWrites('t.jsonl', { readFn: () => NEG }).claims.filter(
      (c) => c.tier === 'asserted',
    )
    expect(negClaims.map((c) => c.path)).not.toContain('stpa.mjs')
    expect(negClaims.map((c) => c.path)).not.toContain('parse-dump.ts')
    expect(negClaims.map((c) => c.path)).not.toContain('STATE.md')
    expect(negClaims).toHaveLength(0) // all three lines are status/disclaimer, none a claim

    // the positive guard: a genuine first-person write still lands an asserted claim.
    const POS = transcript([
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Wrote 46.2-DOD.json for the phase.' }] },
      },
    ])
    const posClaims = extractClaimedWrites('t.jsonl', { readFn: () => POS }).claims.filter(
      (c) => c.tier === 'asserted',
    )
    expect(posClaims.map((c) => c.path)).toContain('46.2-DOD.json')
  })

  it('exports NEGATION_STOPLIST with the forensic markers', () => {
    for (const phrase of ['by another terminal', 'not in', 'foreign', 'untracked', 'confirmed']) {
      expect(NEGATION_STOPLIST).toContain(phrase)
    }
  })

  // ── Mechanism 3: duplicate receipts (rows 5/6) ──

  it('Test 1 (rows 5/6): dedupeByTranscriptSha collapses an unchanged transcript re-receipted N times to ONE; distinct shas stay separate', () => {
    const recFor = (sha: string) => ({
      type: 'subagent-receipt',
      detail: { transcriptSha: sha, counts: { verified: 2, phantomToolCall: 0, phantomAsserted: 0 } },
    })
    // rows 5/6: sha d83cceff receipted twice (seq 153/154) — identical claims/counts.
    const events = [
      { type: 'subagent-pack', detail: { durationMs: 100 } },
      recFor('d83cceff'),
      recFor('d83cceff'), // duplicate — must collapse
      recFor('other-sha'),
    ]
    const deduped = dedupeByTranscriptSha(events)
    expect(deduped.filter((e) => e.type === 'subagent-receipt')).toHaveLength(2) // two distinct shas
    // receiptStats counts the deduped set — the duplicate no longer double-counts.
    const s = receiptStats(events)
    expect(s.receipts).toBe(2)
    // receipts with no transcriptSha are NOT collapsed together.
    const noSha = [
      { type: 'subagent-receipt', detail: { counts: {} } },
      { type: 'subagent-receipt', detail: { counts: {} } },
    ]
    expect(dedupeByTranscriptSha(noSha)).toHaveLength(2)
  })

  // ── Mechanism-independent guards ──

  it('Test 5 (no real-phantom blindness): a full path that exists nowhere STILL scores phantom-missing', () => {
    const out = verifyWrites([{ path: 'src/ghost/never-written.ts', tier: 'asserted', toolResultOk: true }], {
      repoRoot,
      spawnedAt: '2026-07-08T00:00:00Z',
      runGit: runGitWith({}),
      statFile: () => false,
    })
    expect(out[0].verdict).toBe('phantom-missing') // the instrument still catches genuine unbacked writes
  })

  it('Test 6 (D2 background-by-default timing): correlateSpawn pairs one receipt per spawn even when the receipt lands AFTER the parent resumed', () => {
    const one = [{ windowToken: 'w', at: '2026-07-13T10:00:00Z', consumed: false }]
    // the background subagent's receipt correlates 30 min after the spawn — still pairs.
    expect(correlateSpawn(one, { windowToken: 'w', at: '2026-07-13T10:30:00Z' }).at).toBe('2026-07-13T10:00:00Z')
    const two = [
      { windowToken: 'w', at: '2026-07-13T10:00:00Z', consumed: false },
      { windowToken: 'w', at: '2026-07-13T10:25:00Z', consumed: false },
    ]
    // order-independent: still the nearest-in-time unconsumed spawn.
    expect(correlateSpawn(two, { windowToken: 'w', at: '2026-07-13T10:30:00Z' }).at).toBe('2026-07-13T10:25:00Z')
  })

  it('Test 7 (schema stability + aggregate): over all 9 forensic rows, phantomsAsserted = 0 and the schema stays valid', () => {
    // Reconstruct the receipts the 9 rows produce AFTER the fixes:
    //   rows 3/4/9 → verified (cross-match); row 1 → unverifiable; rows 2/7/8 → no asserted claim; rows 5/6 → dedupe.
    const crossmatch = verifyWrites(
      [
        { path: '.planning/phases/46.2-x/46.2-DOD.json', tier: 'tool-call', toolResultOk: true },
        { path: '.planning/phases/46.2-x/46.2-VERIFICATION.md', tier: 'tool-call', toolResultOk: true },
        { path: '46.2-DOD.json', tier: 'asserted', toolResultOk: true },
        { path: '46.2-VERIFICATION.md', tier: 'asserted', toolResultOk: true },
      ],
      {
        repoRoot,
        spawnedAt: '2026-07-09T00:00:00Z',
        runGit: runGitWith({
          status: {
            '.planning/phases/46.2-x/46.2-DOD.json': ' M x',
            '.planning/phases/46.2-x/46.2-VERIFICATION.md': ' M x',
          },
        }),
        statFile: () => true,
      },
    )
    const ambiguous = verifyWrites([{ path: 'deferred-items.md', tier: 'asserted', toolResultOk: true }], {
      repoRoot,
      runGit: runGitWith({ lsFiles: ['a/deferred-items.md', 'b/deferred-items.md'] }),
      statFile: () => false,
    })
    const recA = writeReceipt({ verdicts: crossmatch, transcriptSha: 'd83cceff', spawn: null }, {})
    const recADup = writeReceipt({ verdicts: crossmatch, transcriptSha: 'd83cceff', spawn: null }, {}) // rows 5/6 duplicate
    const recB = writeReceipt({ verdicts: ambiguous, transcriptSha: 'b0894ff5', spawn: null }, {})
    const events = [
      { type: 'subagent-pack', detail: { durationMs: 100 } },
      recA,
      recADup,
      recB,
    ]
    const s = receiptStats(events)
    expect(s.phantomsAsserted).toBe(0) // the noise floor is zero on the exact evidence that convicted it
    expect(s.receipts).toBe(2) // the duplicate receipt collapsed
    expect(receiptStatsSchemaOk(s)).toBe(true) // schema unchanged
  })
})
