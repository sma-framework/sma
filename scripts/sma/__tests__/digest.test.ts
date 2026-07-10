/**
 * Tests for scripts/sma/lib/digest.mjs (Phase 49.1 Plan 18, Task 2 — B12).
 *
 * The session-start cross-terminal digest — pure assembly over INJECTED sources into a
 * budgeted RU block. No network: the git-log runner is injected; sessions / push claim /
 * escalations are passed in.
 *   - Test 1: commits since my last heartbeat, grouped by author (terminal-name).
 *   - Test 2: other sessions' live claims render with their NAMED identity («P52 Anna: …»).
 *   - Test 3: a live push-claim renders the push signal line.
 *   - Test 4: escalations render «истории ошибок в области X»; an empty ledger omits it.
 *   - Test 5: any single source failing degrades to a partial digest, never throws.
 *   - Budget: the full fixture stays <= DIGEST_BUDGET_BYTES.
 */

import { describe, it, expect } from 'vitest'

import { buildDigest, sinceLastHeartbeat, DIGEST_BUDGET_BYTES } from '../lib/digest.mjs'

const SELF = { terminalId: 'tom', lastHeartbeat: '2026-07-06T09:00:00.000Z' }

// An injected git-log runner returning `%an\t%s` lines (what defaultGitLogRunner shells).
function fakeGitLog(sinceIso: string | null) {
  return ['Tom\tfeat: slots', 'Tom\tfix: race', 'Anna\tdocs: readme'].join('\n')
}

describe('sinceLastHeartbeat — parse author-tab-subject lines', () => {
  it('parses commits from an injected runner', () => {
    const commits = sinceLastHeartbeat({ self: SELF, gitLog: fakeGitLog })
    expect(commits).toEqual([
      { author: 'Tom', subject: 'feat: slots' },
      { author: 'Tom', subject: 'fix: race' },
      { author: 'Anna', subject: 'docs: readme' },
    ])
  })

  it('no runner / no output -> [] (never throws)', () => {
    expect(sinceLastHeartbeat({ self: SELF })).toEqual([])
    expect(sinceLastHeartbeat({ self: SELF, gitLog: () => { throw new Error('git error') } })).toEqual([])
  })
})

describe('buildDigest — cross-terminal briefing (B12)', () => {
  it('Test 1: commits since last heartbeat, grouped by terminal-name', () => {
    const text = buildDigest({ self: SELF, gitLog: fakeGitLog })
    expect(text).toContain('Коммиты с прошлого heartbeat: 3')
    expect(text).toContain('Tom: 2')
    expect(text).toContain('Anna: 1')
  })

  it('Test 2: other sessions render with their named identity «P52 Anna: <scope>»', () => {
    const text = buildDigest({
      self: SELF,
      sessions: [
        { holderIdentity: 'Anna', label: 'phase:52', scope: { globs: ['src/crm/**'], description: 'inbox' } },
      ],
    })
    expect(text).toContain('P52 Anna: inbox')
  })

  it('Test 3: a live push-claim renders the push signal line', () => {
    const text = buildDigest({
      self: SELF,
      pushClaim: { live: true, who: 'Tom', plannedVersion: 'V1.55' },
    })
    expect(text).toContain('Отправка в origin: Tom готовит V1.55')
  })

  it('Test 4: escalations render «истории ошибок в области X»', () => {
    const text = buildDigest({
      self: SELF,
      escalations: [{ domain: 'payload', n: 5, misses: 3 }],
    })
    expect(text).toContain('истории ошибок в области payload')
    expect(text).toContain('(3 из 5)')
  })

  it('Test 4b: an empty escalation ledger omits the section entirely (honest empty)', () => {
    const text = buildDigest({ self: SELF, gitLog: fakeGitLog, escalations: [] })
    expect(text).not.toContain('истории ошибок')
  })

  it('nothing worth surfacing -> empty string (caller omits the section)', () => {
    expect(buildDigest({ self: SELF })).toBe('')
    expect(buildDigest({ self: SELF, sessions: [], escalations: [] })).toBe('')
  })

  it('Test 5: a single failing source degrades to a partial digest, never throws', () => {
    let text = ''
    expect(() => {
      text = buildDigest({
        self: SELF,
        gitLog: () => {
          throw new Error('git blew up')
        },
        sessions: [{ holderIdentity: 'Anna', label: 'phase:52', scope: { description: 'inbox' } }],
        pushClaim: { live: true, who: 'Tom', plannedVersion: 'V1.55' },
        escalations: [{ domain: 'payload', n: 5, misses: 3 }],
      })
    }).not.toThrow()
    // git failed, but the other three sources still assembled.
    expect(text).not.toContain('Коммиты с прошлого heartbeat')
    expect(text).toContain('P52 Anna: inbox')
    expect(text).toContain('Отправка в origin: Tom')
    expect(text).toContain('истории ошибок в области payload')
  })

  it('budget: the full fixture stays within DIGEST_BUDGET_BYTES (<=1536)', () => {
    const text = buildDigest({
      self: SELF,
      gitLog: fakeGitLog,
      sessions: [
        { holderIdentity: 'Anna', label: 'phase:52', scope: { description: 'inbox' } },
        { holderIdentity: 'Angie', label: 'phase:51', scope: { globs: ['src/files/**'], description: 'R2 migration' } },
      ],
      pushClaim: { live: true, who: 'Tom', plannedVersion: 'V1.55' },
      escalations: [
        { domain: 'payload', n: 6, misses: 4 },
        { domain: 'migrations', n: 5, misses: 3 },
      ],
    })
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(DIGEST_BUDGET_BYTES)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1536)
  })

  it('a runaway session list is clamped to the byte budget', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      holderIdentity: `Name${i}`,
      label: `phase:${i}`,
      scope: { description: `очень длинное описание области работы номер ${i} с деталями` },
    }))
    const text = buildDigest({ self: SELF, sessions: many, maxBytes: 1536 })
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1536)
  })
})
