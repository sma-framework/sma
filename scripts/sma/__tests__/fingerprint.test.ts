/**
 * Tests for the live work fingerprint + claim trust repair (49.3-13, D-49.3-21/22/23).
 *
 * 14 behaviors:
 *   1  recordTouch — self-capture, NEVER a git read, windowed + capped
 *   2  buildFingerprint — the canonical fingerprint shape
 *   3  ambientDigest — the ~10-min renewTime-age throttle + determinism
 *   4  overlapInjection — immediate, FULL fingerprint on scope overlap, no self-inject
 *   5  BL-158 — attention ≠ fully-active (WARN text + the split count)
 *   6  verifyClaimEvidence — self-verifying live vs stale banner
 *   7  the fingerprint STREAM — mayDeny:false, no-op when alone, fail-open, renewTime-only
 *   8  sessionEnd — release own claims only, idempotent, «сессия завершена»
 *   9  commitEvidenceRelease — clean AND post-renew commit ANDed, no TTL wait
 *   10 idle-timer REJECTED — no elapsed-idle release path exists
 *   11 cooldown reads «недавно освобождён», NEVER «занято»
 *   12 reapStaleObservable — a throwing reap is fail-open BUT journals a countable signal
 *   13 staleWarnShare — deterministic noise percentage over a fixture journal
 *   14 ask demand stub — prints the target fingerprint + journals; askUnmetCount counts unmet
 *
 * Everything is DI: temp dirs (mkdtempSync) for the journal/claims, injected classify/git,
 * no real .sma writes, no shell-out, no token spend.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  recordTouch,
  buildFingerprint,
  ambientDigest,
  overlapInjection,
  renderFingerprint,
  staleWarnShare,
  ask,
  askUnmetCount,
  FP_STATUS_VALUES,
} from '../lib/fingerprint.mjs'
import { buildWarnText, countSessionTiers, verifyClaimEvidence } from '../lib/collision.mjs'
import { reapStaleObservable, classifyStaleness } from '../lib/registry.mjs'
import { sessionEnd, commitEvidenceRelease, cooldownText, claimSlot, readClaims, releaseSlot } from '../lib/claims.mjs'
import { appendEvent, journalTail } from '../lib/journal.mjs'
import {
  HEARTBEAT_INTERVAL_MS,
  FINGERPRINT_FILES_WINDOW_MS,
  FINGERPRINT_FILES_MAX,
  AMBIENT_DIGEST_MS,
} from '../lib/constants.mjs'
import { PRE_CHECKS } from '../lib/pre.mjs'

const NOW = Date.parse('2026-07-09T12:00:00Z')

/** A live-session lease fixture (renewTime fresh unless overridden). */
function lease(over: any = {}) {
  return {
    holderIdentity: 'Мозг',
    pid: 1234,
    scope: { globs: over.globs ?? [], description: over.desc ?? '' },
    status: 'working',
    renewTime: new Date(NOW - (over.ageMs ?? 60000)).toISOString(),
    acquireTime: new Date(NOW - 600000).toISOString(),
    filesRecent: over.filesRecent ?? [],
    intent: over.intent ?? '',
    fpStatus: over.fpStatus ?? 'working',
    label: over.label ?? '',
    _file: over._file ?? 'мозг.json',
    ...over.extra,
  }
}

// ── 1: recordTouch — self-capture, never git ─────────────────────────────────
describe('recordTouch (self-capture, D-49.3-21a)', () => {
  it('appends the passed filePath with a ts, drops entries older than the window, never reads git', () => {
    const git = vi.fn(() => 'SHOULD NOT BE CALLED')
    const old = { path: 'src/old.ts', ts: NOW - FINGERPRINT_FILES_WINDOW_MS - 1 } // outside window
    const fresh = { path: 'src/recent.ts', ts: NOW - 1000 }
    const l = lease({ filesRecent: [old, fresh] })

    const out = recordTouch({ lease: l, filePath: 'src/new.ts', now: NOW, git } as any)

    const paths = out.map((e) => e.path)
    expect(paths).toContain('src/new.ts') // the self-captured touch
    expect(paths).toContain('src/recent.ts') // still inside the window
    expect(paths).not.toContain('src/old.ts') // dropped — older than the window
    expect(git).not.toHaveBeenCalled() // attribution is SELF-CAPTURE only, never git status
  })

  it('caps to the most-recent FINGERPRINT_FILES_MAX entries on a burst', () => {
    const many = Array.from({ length: FINGERPRINT_FILES_MAX + 5 }, (_, i) => ({ path: `f${i}.ts`, ts: NOW - i }))
    const out = recordTouch({ lease: lease({ filesRecent: many }), filePath: 'latest.ts', now: NOW })
    expect(out.length).toBe(FINGERPRINT_FILES_MAX)
    expect(out[out.length - 1].path).toBe('latest.ts')
  })
})

// ── 2: buildFingerprint — shape ──────────────────────────────────────────────
describe('buildFingerprint (shape, D-49.3-21)', () => {
  it('returns {terminalId, phasePlan, filesRecent, lastEvents<=3, claims, intent, status}', () => {
    const l = lease({
      globs: ['src/**'],
      intent: 'чиню тест dispatcher, не трогайте sender.ts',
      fpStatus: 'working',
      label: 'phase:49.3',
      filesRecent: [{ path: 'src/a.ts', ts: NOW - 1000 }],
    })
    const tail = [{ type: 'collision' }, { type: 'claim' }, { type: 'release' }, { type: 'reflex' }]
    const fp = buildFingerprint({ lease: l, journalTail: tail, now: NOW })

    expect(fp.terminalId).toBe('мозг')
    expect(fp.phasePlan).toBe('phase:49.3')
    expect(fp.filesRecent).toEqual(['src/a.ts'])
    expect(fp.lastEvents).toEqual(['claim', 'release', 'reflex']) // last 3 only
    expect(fp.claims).toEqual(['src/**'])
    expect(fp.intent).toBe('чиню тест dispatcher, не трогайте sender.ts')
    expect(FP_STATUS_VALUES).toContain(fp.status)
  })

  it('intent is empty string when unset, never invented', () => {
    const fp = buildFingerprint({ lease: lease({}), now: NOW })
    expect(fp.intent).toBe('')
  })
})

// ── 3: ambientDigest — throttle + determinism ────────────────────────────────
describe('ambientDigest (throttle, D-49.3-21c)', () => {
  const sessions = [
    lease({ _file: 'a.json', extra: { holderIdentity: 'A' }, intent: 'правлю pre.mjs', fpStatus: 'working' }),
    lease({ _file: 'b.json', extra: { holderIdentity: 'B' }, label: 'phase:50', fpStatus: 'idle' }),
  ]

  it('returns one line per LIVE terminal when the cadence elapsed; deterministic', () => {
    const a = ambientDigest({ sessions, lastDigestAt: NOW - AMBIENT_DIGEST_MS - 1, now: NOW })
    const b = ambientDigest({ sessions, lastDigestAt: NOW - AMBIENT_DIGEST_MS - 1, now: NOW })
    expect(a.skipped).toBe(false)
    expect((a as any).lines.length).toBe(2)
    expect((a as any).text).toBe((b as any).text) // identical inputs -> identical text
  })

  it('is {skipped:true} inside the cadence window (a renewTime-age compare, never a timer)', () => {
    const r = ambientDigest({ sessions, lastDigestAt: NOW - 1000, now: NOW })
    expect(r.skipped).toBe(true)
  })
})

// ── 4: overlapInjection — immediate + full + no self-inject ───────────────────
describe('overlapInjection (channel 2, D-49.3-21c)', () => {
  const B = lease({ _file: 'b.json', extra: { holderIdentity: 'B' }, globs: ['src/crm/**'], intent: 'B работает тут' })
  const sessions = [lease({ _file: 'a.json', extra: { holderIdentity: 'A' } }), B]

  it("returns the FULL fingerprint of terminal B when A's touch is inside B's scope", () => {
    const out = overlapInjection({ ownTouch: 'src/crm/x.ts', sessions, selfTerminalId: 'a', now: NOW })
    expect(out.length).toBe(1)
    expect(out[0].terminalId).toBe('b')
    expect(out[0].intent).toBe('B работает тут')
  })

  it('returns [] when there is no overlap, and never self-injects', () => {
    expect(overlapInjection({ ownTouch: 'docs/readme.md', sessions, selfTerminalId: 'a', now: NOW })).toEqual([])
    // A touching A's own scope never injects A
    const selfScope = [lease({ _file: 'a.json', extra: { holderIdentity: 'A' }, globs: ['src/**'] })]
    expect(overlapInjection({ ownTouch: 'src/x.ts', sessions: selfScope, selfTerminalId: 'a', now: NOW })).toEqual([])
  })
})

// ── 5: BL-158 — attention ≠ fully-active ─────────────────────────────────────
describe('BL-158 attention split (D-49.3-22f)', () => {
  it('the WARN text for an attention owner reads «внимание», a fresh owner reads «занято»', () => {
    const fresh = buildWarnText({ tier: 'warn', who: 'A', pid: 1, operation: 'x', scope: 'src/**', since: null, staleness: 'fresh', howToClear: 'wait' })
    const att = buildWarnText({ tier: 'warn', who: 'A', pid: 1, operation: 'x', scope: 'src/**', since: null, staleness: 'attention', howToClear: 'wait' })
    expect(fresh.startsWith('занято')).toBe(true)
    expect(att.startsWith('внимание')).toBe(true)
    expect(att).toContain('[attention]') // the raw tier is carried inline
  })

  it('countSessionTiers counts fresh and attention SEPARATELY (no boolean collapse)', () => {
    const sessions = [
      lease({ _file: 'f.json', ageMs: 60000 }), // fresh (<9 min)
      lease({ _file: 'g.json', ageMs: HEARTBEAT_INTERVAL_MS * 4 }), // attention (>9 min, <45 min)
    ]
    const c = countSessionTiers(sessions, { now: NOW })
    expect(c.fresh).toBe(1)
    expect(c.attention).toBe(1)
    expect(c.active).toBe(2)
  })
})

// ── 6: verifyClaimEvidence — self-verifying banner ───────────────────────────
describe('verifyClaimEvidence (self-verifying banner, D-49.3-22)', () => {
  it('STALE when clean vs HEAD AND a post-renew in-scope commit landed -> «можно работать»', () => {
    const r = verifyClaimEvidence({ claim: { by: 'A' }, scopeDirtyVsHead: false, commitInScopeAfterRenew: 'abc1234def', mtimeAgeMin: 20 })
    expect(r.live).toBe(false)
    expect(r.text).toContain('claim устарел')
    expect(r.text).toContain('abc1234')
    expect(r.text).toContain('можно работать')
  })

  it('LIVE when dirty (or no commit) -> «занято … правки N мин назад, намерение …»', () => {
    const r = verifyClaimEvidence({ claim: { by: 'A', intent: 'правлю dispatcher' }, scopeDirtyVsHead: true, mtimeAgeMin: 2 })
    expect(r.live).toBe(true)
    expect(r.text).toContain('занято')
    expect(r.text).toContain('правки 2 мин назад')
    expect(r.text).toContain('намерение: правлю dispatcher')
  })
})

// ── 7: the fingerprint STREAM — mayDeny:false, no-op, fail-open, renewTime-only ──
describe('fingerprint stream (fail-open + no-op + renewTime-only liveness)', () => {
  const stream = PRE_CHECKS.find((s) => s.id === 'fingerprint')!

  it('is registered mayDeny:false with the SMA_FINGERPRINT_DISABLE kill-switch', () => {
    expect(stream).toBeTruthy()
    expect(stream.mayDeny).toBe(false)
    expect(stream.killSwitchEnv).toBe('SMA_FINGERPRINT_DISABLE')
  })

  it('is a strict no-op (no warns) when there is no OTHER live terminal', async () => {
    const ctx: any = {
      deps: { fingerprint: { recordTouch, buildFingerprint, ambientDigest, overlapInjection, renderFingerprint } },
      identity: { terminalId: 'мозг' },
      sessions: [lease({ _file: 'мозг.json' })], // only self
      toolName: 'Edit',
      toolInput: { file_path: 'src/x.ts' },
      now: () => NOW,
      seen: { notes: {} },
      repoRoot: '/repo',
    }
    const res = await stream.run(ctx)
    expect(res.warns).toEqual([])
  })

  it('never throws — a poisoned ctx returns {warns:[]} (fail-open)', async () => {
    const res = await stream.run({} as any)
    expect(Array.isArray(res.warns)).toBe(true)
    expect(res.warns).toEqual([])
  })

  it('renewTime-only liveness: a stale-renewTime session with a live pid is NOT counted live', () => {
    const staleButPidAlive = lease({ _file: 'z.json', ageMs: HEARTBEAT_INTERVAL_MS * 20, extra: { pid: process.pid } })
    // classifyStaleness must rate it stale purely on renewTime age (pid never consulted)
    const cls = classifyStaleness(staleButPidAlive, { now: NOW })
    expect(cls.state === 'reap-clean' || cls.state === 'needs-human').toBe(true)
    // and the digest excludes it (no live line)
    const dg = ambientDigest({ sessions: [staleButPidAlive], lastDigestAt: 0, now: NOW })
    expect((dg as any).lines).toEqual([])
  })
})

// ── 8-14: claim trust repair + instruments (temp-dir DI) ─────────────────────
describe('claim trust repair', () => {
  let dir: string
  let claimsDir: string
  let journalDir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sma-fp-'))
    claimsDir = join(dir, 'claims')
    journalDir = join(dir, 'journal')
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  // 8
  it('sessionEnd releases ONLY the own session claims, is idempotent, journals «сессия завершена»', () => {
    claimSlot('scope-a', { by: 'Мозг' }, { claimsDir })
    claimSlot('scope-b', { by: 'Фабрика' }, { claimsDir }) // foreign
    const identity = { holderIdentity: 'Мозг', terminalId: 'мозг' }

    const r1 = sessionEnd({ identity, claimsDir, journalDir })
    expect(r1.released).toEqual(['scope-a'])
    // foreign claim untouched
    expect(readClaims({ claimsDir }).map((c) => c.name)).toContain('scope-b')
    // idempotent
    const r2 = sessionEnd({ identity, claimsDir, journalDir })
    expect(r2.released).toEqual([])
    // journaled
    const events = journalTail('мозг', -1, { journalDir })
    expect(events.some((e: any) => e.type === 'release' && e.detail.reason === 'session-ended')).toBe(true)
  })

  // 9
  it('commitEvidenceRelease releases IFF clean AND a post-renew commit (two conditions ANDed)', () => {
    claimSlot('scope-c', { by: 'Мозг' }, { claimsDir })
    // dirty -> not released
    expect(commitEvidenceRelease({ claim: { name: 'scope-c', by: 'Мозг' }, scopeDirtyVsHead: true, commitShaAfterRenew: 'abc', claimsDir, journalDir }).released).toBe(false)
    // clean but no commit -> not released
    expect(commitEvidenceRelease({ claim: { name: 'scope-c', by: 'Мозг' }, scopeDirtyVsHead: false, claimsDir, journalDir }).released).toBe(false)
    // clean AND commit -> released immediately (no TTL wait)
    const r = commitEvidenceRelease({ claim: { name: 'scope-c', by: 'Мозг' }, scopeDirtyVsHead: false, commitShaAfterRenew: 'abc1234', claimsDir, journalDir })
    expect(r.released).toBe(true)
    expect(readClaims({ claimsDir }).map((c) => c.name)).not.toContain('scope-c')
  })

  // 10
  it('there is NO idle-timer release path (D-49.3-22a) — a fresh claim with no evidence is never released', async () => {
    const claims = await import('../lib/claims.mjs')
    const names = Object.keys(claims)
    // no function names the idle-release concept
    expect(names.some((n) => /idle.*release|release.*idle|reapIdle/i.test(n))).toBe(false)
    // and the only auto-release paths refuse without their evidence
    claimSlot('scope-d', { by: 'Мозг' }, { claimsDir })
    expect(commitEvidenceRelease({ claim: { name: 'scope-d', by: 'Мозг' }, scopeDirtyVsHead: false, claimsDir, journalDir }).released).toBe(false)
    expect(readClaims({ claimsDir }).map((c) => c.name)).toContain('scope-d')
  })

  // 11
  it('cooldown text reads «недавно освобождён», NEVER «занято»', () => {
    claimSlot('scope-e', { by: 'Мозг' }, { claimsDir })
    releaseSlot('scope-e', { by: 'Мозг', claimsDir }) // drops the .cooldown marker
    const txt = cooldownText('scope-e', { claimsDir, now: Date.now() })
    expect(txt).toContain('недавно освобождён')
    expect(txt).not.toContain('занято')
  })

  // 12
  it('reapStaleObservable is fail-open on a throwing reap BUT journals a countable reap-fail; success journals the count', () => {
    // throwing reap -> fail-open + reap-fail event
    const bad = reapStaleObservable({ reapFn: () => { throw new Error('boom') }, journalDir, terminalId: 'reaper' })
    expect(bad.ok).toBe(false)
    let events = journalTail('reaper', -1, { journalDir })
    expect(events.some((e: any) => e.type === 'reap-fail')).toBe(true)
    // successful reap -> reap event with the count
    const good = reapStaleObservable({ reapFn: () => ({ reaped: ['t-x', 't-y'], candidates: ['t-x', 't-y'] }), journalDir, terminalId: 'reaper' })
    expect(good.ok).toBe(true)
    events = journalTail('reaper', -1, { journalDir })
    expect(events.some((e: any) => e.type === 'reap' && e.detail.reaped === 2)).toBe(true)
  })

  // 13
  it('staleWarnShare computes a deterministic noise percentage from the journal', () => {
    const base = Date.parse('2026-07-09T10:00:00Z')
    const iso = (offMin: number) => new Date(base + offMin * 60000).toISOString()
    const journal = [
      { type: 'collision', ts: iso(0), scope: 'src/a/**' }, // will be noise (auto-released, no later touch)
      { type: 'release', ts: iso(5), scope: 'src/a/**', detail: { reason: 'session-ended' } },
      { type: 'collision', ts: iso(0), scope: 'src/b/**' }, // NOT noise (never auto-released)
    ]
    const pct = staleWarnShare({ journal, windowDays: 7, now: base + 60 * 60000 })
    expect(pct).toBe(50) // 1 of 2 shown warns was noise
    // deterministic
    expect(staleWarnShare({ journal, windowDays: 7, now: base + 60 * 60000 })).toBe(50)
  })

  // 14
  it('ask prints the target fingerprint + journals; askUnmetCount counts the unmet', () => {
    const live = lease({ _file: 'фабрика.json', extra: { holderIdentity: 'Фабрика' }, intent: 'строю фазу 50', globs: ['src/**'] })
    // answered: the target has a live fingerprint with content
    const r1 = ask({ target: 'фабрика', question: 'что делаешь?', sessions: [live], journalDir, now: NOW })
    expect(r1.answered).toBe(true)
    expect(r1.text).toContain('строю фазу 50')
    // unmet: an unknown target has no fingerprint
    const r2 = ask({ target: 'нет-такого', question: 'а ты кто?', sessions: [live], journalDir, now: NOW })
    expect(r2.answered).toBe(false)
    // the unmet count reflects exactly the one unanswered case
    expect(askUnmetCount({ journalDir })).toBe(1)
  })
})
