/**
 * Tests for scripts/sma/lib/gates.mjs (Phase 49.1 Plan 16, Task 2 — B9/B10, D-49.1-12).
 *
 * The checkable HARD-RULE inventory promoted from prose to PreToolUse WARN gates.
 * ALL gates advisory WARN (permissionDecision allow); soft-deny is 49.1-17.
 *
 * REAL-SHAPE fixtures (CR-01, RESEARCH Pitfall 1): Edit/Write events carry ABSOLUTE
 * Windows paths and Bash events carry realistic command strings, mirroring what
 * Claude Code actually delivers on the PreToolUse hook stdin. A relative-path or
 * toy-command fixture would happily green a dead matcher.
 *
 *   - Test 1: each of the 8 gates fires exactly its WARN on a matching real-shape
 *     event AND stays silent on a near-miss (targeted `git add path`, agent DoD, etc.)
 *   - Test 2: GATE-DODHONESTY fires on a human-kind dimension with status pass;
 *     an agent-kind pass never fires.
 *   - Test 3: SMA_GATE_ADDALL_OFF=1 silences ONLY that gate; SMA_GATES_DISABLE=1 all.
 *   - Test 4: every fire produces a journal entry {type:'gate', gateId, target, terminal}.
 *   - Test 5: an internal exception in one gate is contained (others still evaluate).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GATES, checkEvent } from '../lib/gates.mjs'
import { readJournal } from '../lib/journal.mjs'

// A realistic Windows repo-root shape (synthetic — no live machine paths in fixtures).
const REPO_ROOT = 'C:\\Users\\dev\\projects\\example-app'
const abs = (rel: string) => REPO_ROOT + '\\' + rel.replace(/\//g, '\\')

function bash(command: string) {
  return { tool_name: 'Bash', tool_input: { command } }
}
function edit(rel: string, extra: Record<string, unknown> = {}) {
  return { tool_name: 'Edit', tool_input: { file_path: abs(rel), ...extra } }
}
function write(rel: string, content: string) {
  return { tool_name: 'Write', tool_input: { file_path: abs(rel), content } }
}

/** Run checkEvent with a fresh seen-store, no journaling unless a dir is passed. */
function run(evt: unknown, opts: { env?: Record<string, string>; journalDir?: string; terminalId?: string } = {}) {
  return checkEvent({
    evt,
    root: REPO_ROOT,
    env: opts.env ?? {},
    seen: {},
    journalDir: opts.journalDir,
    terminalId: opts.terminalId,
  })
}

function ids(res: { warns: Array<{ gateId: string }> }) {
  return res.warns.map((w) => w.gateId)
}

const DOD_HUMAN_PASS = JSON.stringify({
  dimensions: [
    { key: 'code_complete', kind: 'auto', status: 'pass' },
    { key: 'user_accepted', kind: 'human', status: 'pass' },
  ],
})
const DOD_AGENT_PASS = JSON.stringify({
  dimensions: [
    { key: 'code_complete', kind: 'auto', status: 'pass' },
    { key: 'user_accepted', kind: 'human', status: 'pending' },
  ],
})

describe('gates.mjs — the checkable HARD-RULE inventory', () => {
  it('registers all 11 gates with the contract shape', () => {
    expect(GATES).toHaveLength(11)
    const seen = new Set<string>()
    for (const g of GATES) {
      expect(typeof g.id).toBe('string')
      expect(Array.isArray(g.tools)).toBe(true)
      expect(typeof g.match).toBe('function')
      expect(typeof g.warn).toBe('string')
      expect(g.warn.length).toBeGreaterThan(20)
      expect(typeof g.killEnv).toBe('string')
      expect(g.killEnv).toBe(`SMA_GATE_${g.id.replace(/^GATE-/, '')}_OFF`)
      seen.add(g.id)
    }
    expect(seen).toEqual(
      new Set([
        'GATE-PUSH',
        'GATE-ADDALL',
        'GATE-STASH',
        'GATE-MEMEDIT',
        'GATE-DODHONESTY',
        'GATE-NEXTBUILD',
        'GATE-CHECKOUT',
        'GATE-MIGNUM',
        'GATE-STATEEDIT',
        'GATE-FORCEPUSH',
        'GATE-ALLOWLIST',
      ]),
    )
  })

  describe('Test 1 — each gate fires on a match and stays silent on a near-miss', () => {
    it('GATE-PUSH fires on a git push; silent on git fetch', () => {
      expect(ids(run(bash('git push origin main')))).toContain('GATE-PUSH')
      expect(ids(run(bash('git fetch origin')))).not.toContain('GATE-PUSH')
    })

    it('GATE-ADDALL fires on bulk stage; silent on an explicit path add', () => {
      expect(ids(run(bash('git add -A')))).toContain('GATE-ADDALL')
      expect(ids(run(bash('git add --all')))).toContain('GATE-ADDALL')
      expect(ids(run(bash('git add .')))).toContain('GATE-ADDALL')
      expect(ids(run(bash('git add src/crm/foo.ts')))).not.toContain('GATE-ADDALL')
    })

    it('GATE-STASH fires on git stash; silent on git status', () => {
      expect(ids(run(bash('git stash push')))).toContain('GATE-STASH')
      expect(ids(run(bash('git status --porcelain')))).not.toContain('GATE-STASH')
    })

    it('GATE-MEMEDIT fires on MEMORY.md / INDEX-*.md; silent on a source note', () => {
      expect(ids(run(edit('.claude/memory/MEMORY.md', { old_string: 'a', new_string: 'b' })))).toContain('GATE-MEMEDIT')
      expect(ids(run(edit('.claude/memory/INDEX-tech.md', { old_string: 'a', new_string: 'b' })))).toContain('GATE-MEMEDIT')
      expect(ids(run(edit('.claude/memory/feedback_foo.md', { old_string: 'a', new_string: 'b' })))).not.toContain('GATE-MEMEDIT')
    })

    it('GATE-DODHONESTY fires on human-pass DoD; silent on agent-only pass', () => {
      expect(ids(run(write('.planning/phases/49-x/49-DOD.json', DOD_HUMAN_PASS)))).toContain('GATE-DODHONESTY')
      expect(ids(run(write('.planning/phases/49-x/49-DOD.json', DOD_AGENT_PASS)))).not.toContain('GATE-DODHONESTY')
    })

    it('GATE-NEXTBUILD fires on next/pnpm build; silent on pnpm sma build-index', () => {
      expect(ids(run(bash('next build')))).toContain('GATE-NEXTBUILD')
      expect(ids(run(bash('pnpm build')))).toContain('GATE-NEXTBUILD')
      expect(ids(run(bash('pnpm run build')))).toContain('GATE-NEXTBUILD')
      expect(ids(run(bash('pnpm sma build-index')))).not.toContain('GATE-NEXTBUILD')
    })

    it('GATE-CHECKOUT fires on checkout --/restore; silent on git checkout -b branch', () => {
      expect(ids(run(bash('git checkout -- src/crm/foo.ts')))).toContain('GATE-CHECKOUT')
      expect(ids(run(bash('git restore src/crm/foo.ts')))).toContain('GATE-CHECKOUT')
      expect(ids(run(bash('git checkout -b feature-x')))).not.toContain('GATE-CHECKOUT')
    })

    it('GATE-MIGNUM fires on src/migrations/index.ts; silent on another src file', () => {
      expect(ids(run(edit('src/migrations/index.ts', { old_string: 'a', new_string: 'b' })))).toContain('GATE-MIGNUM')
      expect(ids(run(edit('src/crm/foo.ts', { old_string: 'a', new_string: 'b' })))).not.toContain('GATE-MIGNUM')
    })

    it('GATE-STATEEDIT fires on a fence-intersecting STATE.md edit; silent outside the fence', () => {
      // fence-intersecting: the new_string carries a managed heading (or a fence marker).
      const fenceEdit = edit('.planning/STATE.md', {
        old_string: 'x',
        new_string: '## Current Position\n\n**Phase: 49.1 — hand-edited by mistake**',
      })
      expect(ids(run(fenceEdit))).toContain('GATE-STATEEDIT')
      const markerWrite = write('.planning/STATE.md', 'noise\n<!-- SMA-MANAGED:START -->\n## Open Blockers\n')
      expect(ids(run(markerWrite))).toContain('GATE-STATEEDIT')
      // outside the fence: a STATE.md edit that touches no managed zone stays silent.
      const outside = edit('.planning/STATE.md', {
        old_string: 'y',
        new_string: '## Session\n\n**Last session:** 2026-07-06',
      })
      expect(ids(run(outside))).not.toContain('GATE-STATEEDIT')
      // a non-STATE.md file with a coincidental heading also stays silent.
      const elsewhere = edit('docs/notes.md', { old_string: 'z', new_string: '## Current Position' })
      expect(ids(run(elsewhere))).not.toContain('GATE-STATEEDIT')
    })
  })

  describe('Test 2 — GATE-DODHONESTY diff parsing', () => {
    it('fires when a human dimension carries status pass', () => {
      const res = run(write('.planning/phases/25/25-DOD.json', DOD_HUMAN_PASS))
      const fired = res.warns.find((w) => w.gateId === 'GATE-DODHONESTY')
      expect(fired).toBeDefined()
      expect(fired!.text).toMatch(/human|founder|основател/i)
    })
    it('does not fire when only auto/agent dimensions are pass', () => {
      expect(ids(run(write('.planning/phases/25/25-DOD.json', DOD_AGENT_PASS)))).not.toContain('GATE-DODHONESTY')
    })
    it('does not fire on a DoD Edit fragment that only touches an auto dimension', () => {
      const frag = '{ "key": "type_check", "kind": "auto", "status": "pass" }'
      expect(ids(run(edit('.planning/phases/25/25-DOD.json', { old_string: 'x', new_string: frag })))).not.toContain(
        'GATE-DODHONESTY',
      )
    })
  })

  describe('Test 3 — kill switches', () => {
    it('SMA_GATE_ADDALL_OFF=1 silences only that gate', () => {
      const res = run(bash('git add -A'), { env: { SMA_GATE_ADDALL_OFF: '1' } })
      expect(ids(res)).not.toContain('GATE-ADDALL')
    })
    it('SMA_GATE_ADDALL_OFF does not silence GATE-STASH', () => {
      const res = run(bash('git stash'), { env: { SMA_GATE_ADDALL_OFF: '1' } })
      expect(ids(res)).toContain('GATE-STASH')
    })
    it('SMA_GATES_DISABLE=1 silences every gate', () => {
      const res = run(bash('git push origin main'), { env: { SMA_GATES_DISABLE: '1' } })
      expect(res.warns).toHaveLength(0)
    })
  })

  describe('Test 4 — every fire is journaled', () => {
    let journalDir: string
    beforeEach(() => {
      journalDir = mkdtempSync(join(tmpdir(), 'sma-gates-jrnl-'))
    })
    afterEach(() => {
      rmSync(journalDir, { recursive: true, force: true })
    })

    it('writes a {type:gate, gateId, target, terminal} entry per fire', () => {
      const res = run(bash('git add -A'), { journalDir, terminalId: 'term-A' })
      expect(ids(res)).toContain('GATE-ADDALL')
      const { events } = readJournal({ journalDir })
      const gateEvents = events.filter((e: any) => e.type === 'gate')
      expect(gateEvents.length).toBeGreaterThanOrEqual(1)
      const ev: any = gateEvents.find((e: any) => e.detail?.gateId === 'GATE-ADDALL')
      expect(ev).toBeDefined()
      expect(ev.terminal).toBe('term-A')
      expect(ev.detail.target).toBeTruthy()
    })
  })

  describe('Test 5 — a throwing gate is contained', () => {
    it('a matcher exception does not stop other gates or throw', () => {
      const bomb = {
        id: 'GATE-BOMB',
        tools: ['Bash'],
        killEnv: 'SMA_GATE_BOMB_OFF',
        warn: 'boom (a self-sufficient warn line for the contract check)',
        match: () => {
          throw new Error('kaboom')
        },
      }
      let res: any
      expect(() => {
        res = checkEvent({
          evt: bash('git add -A'),
          root: REPO_ROOT,
          env: {},
          seen: {},
          gates: [bomb, ...GATES],
        })
      }).not.toThrow()
      // GATE-ADDALL (a real gate after the bomb) still evaluates.
      expect(res.warns.map((w: any) => w.gateId)).toContain('GATE-ADDALL')
      expect(res.warns.map((w: any) => w.gateId)).not.toContain('GATE-BOMB')
    })
  })

  describe('per-session dedup', () => {
    it('fires once per (gate, target) within one seen-store', () => {
      const seen = {}
      const first = checkEvent({ evt: bash('git add -A'), root: REPO_ROOT, env: {}, seen })
      const second = checkEvent({ evt: bash('git add -A'), root: REPO_ROOT, env: {}, seen: first.seen })
      expect(first.warns.map((w) => w.gateId)).toContain('GATE-ADDALL')
      expect(second.warns.map((w) => w.gateId)).not.toContain('GATE-ADDALL')
    })
  })

  // ── soft-deny tier (49.1-17, D-49.1-13) ──────────────────────────────────────
  //
  // The two gates that carry teeth: GATE-PUSH (push without full-gate evidence) and
  // GATE-MEMEDIT (hand-edit of generated MEMORY.md). Deny is DORMANT by default —
  // it exists ONLY when the per-gate arm env is set, and even then a fresh evidence
  // marker or a one-shot override token allows the operation. An exception anywhere
  // in the deny path degrades to allow (fail-open, scorecard metric 7).
  describe('soft-deny tier (49.1-17, D-49.1-13)', () => {
    let gatesDir: string
    let journalDir: string
    beforeEach(() => {
      gatesDir = mkdtempSync(join(tmpdir(), 'sma-gates-sd-'))
      journalDir = mkdtempSync(join(tmpdir(), 'sma-gates-sdj-'))
    })
    afterEach(() => {
      rmSync(gatesDir, { recursive: true, force: true })
      rmSync(journalDir, { recursive: true, force: true })
    })

    const HEAD = 'abc1234def5678'
    const pushEvt = () => bash('git push origin main')
    const memEvt = () => edit('.claude/memory/MEMORY.md', { old_string: 'a', new_string: 'b' })

    // GATE-PUSH + GATE-MEMEDIT (49.1-17) plus the 49.2-07 risky-op gates carry softDeny.
    it('exactly the softDeny-capable gates carry a softDeny capability', () => {
      const withSoft = GATES.filter((g: any) => g.softDeny)
      expect(new Set(withSoft.map((g: any) => g.id))).toEqual(
        new Set(['GATE-PUSH', 'GATE-MEMEDIT', 'GATE-FORCEPUSH', 'GATE-ALLOWLIST']),
      )
      for (const g of withSoft) {
        expect(typeof (g as any).softDeny.armEnv).toBe('string')
        expect(typeof (g as any).softDeny.denyText).toBe('string')
      }
      expect((GATES.find((g: any) => g.id === 'GATE-PUSH') as any).softDeny.armEnv).toBe('SMA_GATE_PUSH_DENY')
      expect((GATES.find((g: any) => g.id === 'GATE-MEMEDIT') as any).softDeny.armEnv).toBe('SMA_GATE_MEMEDIT_DENY')
      expect((GATES.find((g: any) => g.id === 'GATE-FORCEPUSH') as any).softDeny.armEnv).toBe('SMA_GATE_FORCEPUSH_DENY')
      expect((GATES.find((g: any) => g.id === 'GATE-ALLOWLIST') as any).softDeny.armEnv).toBe('SMA_GATE_ALLOWLIST_DENY')
    })

    // Test 1 — dormant default: arm env unset → WARN only (allow), even with no marker.
    it('Test 1: GATE-PUSH with arm env unset → WARN only, no deny, even without evidence marker', () => {
      const res = checkEvent({ evt: pushEvt(), root: REPO_ROOT, env: {}, seen: {}, gatesDir, headSha: HEAD })
      expect(res.deny).toBeFalsy()
      expect(res.warns.map((w) => w.gateId)).toContain('GATE-PUSH')
    })

    // Test 2 — armed + no marker → deny with the instruction text.
    it('Test 2: GATE-PUSH armed + no fullgate marker for HEAD → deny with instruction', () => {
      const res = checkEvent({ evt: pushEvt(), root: REPO_ROOT, env: { SMA_GATE_PUSH_DENY: '1' }, seen: {}, gatesDir, headSha: HEAD })
      expect(res.deny).toBeTruthy()
      expect(res.deny.gateId).toBe('GATE-PUSH')
      expect(res.deny.text).toMatch(/полн|ship|override|гейт|mark-fullgate/i)
    })

    // Test 3 — armed + a fresh fullgate marker for HEAD → allow (evidence satisfies).
    it('Test 3: GATE-PUSH armed + fresh fullgate-<HEAD>.json exists → allow', () => {
      writeFileSync(join(gatesDir, `fullgate-${HEAD}.json`), JSON.stringify({ sha: HEAD, at: new Date().toISOString(), gate: 'full' }))
      const res = checkEvent({ evt: pushEvt(), root: REPO_ROOT, env: { SMA_GATE_PUSH_DENY: '1' }, seen: {}, gatesDir, headSha: HEAD, now: Date.now() })
      expect(res.deny).toBeFalsy()
    })

    // Test 3b — a STALE marker (older than the TTL) does NOT satisfy the gate.
    it('Test 3b: GATE-PUSH armed + stale marker (past TTL) → deny', () => {
      writeFileSync(join(gatesDir, `fullgate-${HEAD}.json`), JSON.stringify({ sha: HEAD, gate: 'full' }))
      // Evaluate as if "now" is far in the future so the just-written file is past TTL.
      const res = checkEvent({ evt: pushEvt(), root: REPO_ROOT, env: { SMA_GATE_PUSH_DENY: '1' }, seen: {}, gatesDir, headSha: HEAD, now: Date.now() + 1000 * 60 * 60 * 24 })
      expect(res.deny).toBeTruthy()
    })

    // Test 4 — armed + one-shot override token → allow ONCE, token consumed, journaled.
    it('Test 4: GATE-PUSH armed + one-shot override token → allow once, consumed, override journaled', () => {
      const tok = join(gatesDir, 'override-GATE-PUSH.json')
      writeFileSync(tok, JSON.stringify({ gateId: 'GATE-PUSH', terminal: 'term-A', reason: 'hotfix release', at: new Date().toISOString() }))
      const res = checkEvent({ evt: pushEvt(), root: REPO_ROOT, env: { SMA_GATE_PUSH_DENY: '1' }, seen: {}, gatesDir, headSha: HEAD, journalDir, terminalId: 'term-A' })
      expect(res.deny).toBeFalsy()
      expect(existsSync(tok)).toBe(false) // consumed
      const { events } = readJournal({ journalDir })
      const ov: any = events.find((e: any) => e.type === 'gate-override' && e.detail?.gateId === 'GATE-PUSH')
      expect(ov).toBeDefined()
      expect(ov.detail.reason).toBe('hotfix release')
      // second attempt, token gone → deny again (one-shot).
      const res2 = checkEvent({ evt: pushEvt(), root: REPO_ROOT, env: { SMA_GATE_PUSH_DENY: '1' }, seen: {}, gatesDir, headSha: HEAD })
      expect(res2.deny).toBeTruthy()
    })

    // Test 5 — an exception inside the deny path degrades to allow (fail-open, never throw).
    it('Test 5: an exception inside the deny path → allow (fail-open degradation)', () => {
      const bomb = {
        id: 'GATE-PUSH',
        tools: ['Bash'],
        killEnv: 'SMA_GATE_PUSH_OFF',
        warn: 'boom (a self-sufficient warn line for the contract check)',
        softDeny: {
          armEnv: 'SMA_GATE_PUSH_DENY',
          denyText: 'x',
          evidence: () => {
            throw new Error('kaboom')
          },
        },
        match: () => true,
      }
      let res: any
      expect(() => {
        res = checkEvent({ evt: pushEvt(), root: REPO_ROOT, env: { SMA_GATE_PUSH_DENY: '1' }, seen: {}, gatesDir, headSha: HEAD, gates: [bomb] })
      }).not.toThrow()
      expect(res.deny).toBeFalsy()
    })

    // Test 6 — GATE-MEMEDIT mirrors tests 1/2/4 (no evidence marker for a hand-edit).
    it('Test 6: GATE-MEMEDIT mirrors dormant / armed-deny / one-shot override', () => {
      // dormant
      expect(checkEvent({ evt: memEvt(), root: REPO_ROOT, env: {}, seen: {}, gatesDir }).deny).toBeFalsy()
      // armed + deny
      const denied = checkEvent({ evt: memEvt(), root: REPO_ROOT, env: { SMA_GATE_MEMEDIT_DENY: '1' }, seen: {}, gatesDir })
      expect(denied.deny).toBeTruthy()
      expect(denied.deny.gateId).toBe('GATE-MEMEDIT')
      // one-shot override token → allow, consumed, journaled
      const tok = join(gatesDir, 'override-GATE-MEMEDIT.json')
      writeFileSync(tok, JSON.stringify({ gateId: 'GATE-MEMEDIT', terminal: 'term-B', reason: 'regen fixup' }))
      const allowed = checkEvent({ evt: memEvt(), root: REPO_ROOT, env: { SMA_GATE_MEMEDIT_DENY: '1' }, seen: {}, gatesDir, journalDir, terminalId: 'term-B' })
      expect(allowed.deny).toBeFalsy()
      expect(existsSync(tok)).toBe(false)
      const { events } = readJournal({ journalDir })
      expect(events.some((e: any) => e.type === 'gate-override' && e.detail?.gateId === 'GATE-MEMEDIT')).toBe(true)
    })

    // Deny is IMPOSSIBLE without the arm env — the acceptance-criteria guard.
    it('deny never occurs unless the arm env is set', () => {
      for (const env of [{}, { SMA_GATE_PUSH_DENY: '0' }, { SMA_GATE_PUSH_DENY: 'false' }]) {
        const res = checkEvent({ evt: pushEvt(), root: REPO_ROOT, env, seen: {}, gatesDir, headSha: HEAD })
        expect(res.deny).toBeFalsy()
      }
    })
  })
})
