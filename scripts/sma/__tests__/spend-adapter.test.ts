/**
 * Tests for scripts/sma/lib/spend-adapter.mjs (Phase 49.2 Plan 09, Task 1).
 *
 * The versioned log-format adapter — the ONLY module in the tree that knows the
 * vendor's local session-transcript shape (D-49.2-13 quarantine). All vendor-drift
 * risk is confined here; a Claude Code log-format change is a one-file fix.
 *
 *   - Test 1 (normalize): a v1 assistant transcript line → the canonical event with
 *     camelCase, ccusage / OTel `claude_code.token.usage`-compatible field names.
 *   - Test 2 (dedup): two lines sharing (message.id, requestId) → ONE event.
 *   - Test 3 (cost precedence): line costUSD wins verbatim; missing → computed from the
 *     static pricing table (cache-write / cache-read at their own rates); UNKNOWN model
 *     → costUSD null + costSource 'unpriced', tokens still booked.
 *   - Test 4 (skip taxonomy): non-usage lines skipped silently; malformed JSON → 'corrupt';
 *     an unfamiliar shape that DOES carry token usage → 'unrecognized' (the drift signal);
 *     parseLogLine NEVER throws on any input.
 *   - Test 5 (slug + discovery): the vendor's non-alnum→dash slug (verified against this
 *     machine's real ~/.claude/projects entry); discoverLogsDir precedence.
 *   - Test 6 (native probe): {native:false, probeVersion} today; criteria encoded as data.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ADAPTER_VERSIONS,
  parseLogLine,
  discoverLogsDir,
  slugForRepoRoot,
  PRICING_USD_PER_MTOK,
  pricingVersion,
  probeNativeSpend,
} from '../lib/spend-adapter.mjs'

/** A well-formed v1 Claude Code assistant transcript line. */
function assistantLine(over = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-08T12:00:00.000Z',
    sessionId: 'sess-A',
    requestId: 'req-1',
    isSidechain: false,
    message: {
      id: 'msg-1',
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 4000,
      },
    },
    ...over,
  })
}

describe('spend-adapter — the versioned log-format quarantine (Task 1)', () => {
  it('Test 1: normalizes a v1 assistant line to the canonical ccusage/OTel-shaped event', () => {
    const ev = parseLogLine(assistantLine())
    expect(ev.skip).toBeUndefined()
    // camelCase, field-compatible with ccusage / OTel claude_code.token.usage.
    expect(ev.ts).toBe('2026-07-08T12:00:00.000Z')
    expect(ev.sessionId).toBe('sess-A')
    expect(ev.model).toBe('claude-opus-4-8')
    expect(ev.inputTokens).toBe(1000)
    expect(ev.outputTokens).toBe(500)
    expect(ev.cacheCreationTokens).toBe(200)
    expect(ev.cacheReadTokens).toBe(4000)
    expect(ev.isSidechain).toBe(false)
    expect(ev.adapterVersion).toBe('v1-claude-jsonl-2026-07')
  })

  it('Test 2: two lines sharing (message.id, requestId) yield ONE event (retry dedup)', () => {
    const seen = new Set()
    const first = parseLogLine(assistantLine(), { seen })
    const second = parseLogLine(assistantLine(), { seen })
    expect(first.skip).toBeUndefined()
    expect(second.skip).toBe('duplicate')
  })

  it('Test 3: cost precedence — line costUSD wins; else computed; unknown model → unpriced', () => {
    // (a) a line carrying its own costUSD wins verbatim.
    const carried = parseLogLine(assistantLine({ costUSD: 0.4242 }))
    expect(carried.costUSD).toBe(0.4242)
    expect(carried.costSource).toBe('line')

    // (b) no costUSD → computed from PRICING_USD_PER_MTOK, cache tiers priced distinctly.
    const computed = parseLogLine(assistantLine())
    const r = PRICING_USD_PER_MTOK.opus
    const expected =
      (1000 * r.input + 500 * r.output + 200 * r.cacheWrite + 4000 * r.cacheRead) / 1e6
    expect(computed.costSource).toBe('computed')
    expect(computed.costUSD).toBeCloseTo(expected, 9)

    // (c) unknown model → costUSD null, unpriced, tokens STILL booked (honesty over guessing).
    const unknown = parseLogLine(
      assistantLine({ message: { id: 'msg-x', model: 'gpt-some-thing', usage: { input_tokens: 10, output_tokens: 2 } } }),
    )
    expect(unknown.costUSD).toBeNull()
    expect(unknown.costSource).toBe('unpriced')
    expect(unknown.inputTokens).toBe(10)
    expect(unknown.outputTokens).toBe(2)
  })

  it('Test 4: skip taxonomy — non-usage / corrupt / unrecognized; never throws', () => {
    // non-usage lines (user turns, tool results, summaries) → silent 'non-usage'.
    expect(parseLogLine(JSON.stringify({ type: 'user', message: { content: 'hi' } })).skip).toBe('non-usage')
    expect(parseLogLine(JSON.stringify({ type: 'summary', summary: 'x' })).skip).toBe('non-usage')

    // malformed JSON → 'corrupt', never a throw.
    expect(parseLogLine('{ this is not json').skip).toBe('corrupt')
    expect(parseLogLine('').skip).toBe('corrupt')

    // an unfamiliar shape that DOES carry token usage → 'unrecognized' (the drift counter).
    expect(parseLogLine(JSON.stringify({ type: 'weird-future', usage: { input_tokens: 99 } })).skip).toBe('unrecognized')

    // parseLogLine NEVER throws on ANY input.
    expect(() => parseLogLine(null)).not.toThrow()
    expect(() => parseLogLine(undefined)).not.toThrow()
    expect(() => parseLogLine(12345)).not.toThrow()
  })

  it('Test 5: slugForRepoRoot matches the vendor sanitization; discoverLogsDir precedence', () => {
    // matches the vendor's directory-name derivation for ~/.claude/projects entries.
    expect(slugForRepoRoot('C:\\Users\\Jane_Doe\\projects\\my-app')).toBe(
      'C--Users-Jane-Doe-projects-my-app',
    )

    // discoverLogsDir: SMA_SPEND_LOGS_DIR env wins first.
    const envDir = mkdtempSync(join(tmpdir(), 'spend-env-'))
    writeFileSync(join(envDir, 'a.jsonl'), assistantLine() + '\n')
    const byEnv = discoverLogsDir({ env: { SMA_SPEND_LOGS_DIR: envDir }, logsDir: '/ignored', homedir: '/nope' })
    expect(byEnv.dir).toBe(envDir)
    expect(byEnv.files.length).toBe(1)

    // then DI opts.logsDir.
    const diDir = mkdtempSync(join(tmpdir(), 'spend-di-'))
    const byDi = discoverLogsDir({ env: {}, logsDir: diDir, homedir: '/nope' })
    expect(byDi.dir).toBe(diDir)

    // then the homedir default (<homedir>/.claude/projects/<slug>/). Missing dir → empty, never an error.
    const home = mkdtempSync(join(tmpdir(), 'spend-home-'))
    const byHome = discoverLogsDir({ env: {}, homedir: home, repoRoot: 'C:\\repo\\x' })
    expect(byHome.dir).toBe(join(home, '.claude', 'projects', slugForRepoRoot('C:\\repo\\x')))
    expect(byHome.files).toEqual([])
  })

  it('Test 6: probeNativeSpend is false today; criteria are encoded as data', () => {
    const p = probeNativeSpend({ env: {} })
    expect(p.native).toBe(false)
    expect(typeof p.probeVersion).toBe('number')
    expect(Array.isArray(p.criteria)).toBe(true)
    expect(p.criteria.length).toBeGreaterThan(0)
    // the versioned test seam lets V3.2 re-score by re-running, not rewriting.
    expect(probeNativeSpend({ env: { SMA_NATIVE_SPEND: '1' } }).native).toBe(true)
  })

  it('exports the adapter chain + pricing version as first-class contract', () => {
    expect(Array.isArray(ADAPTER_VERSIONS)).toBe(true)
    expect(ADAPTER_VERSIONS.length).toBeGreaterThanOrEqual(1)
    expect(typeof ADAPTER_VERSIONS[0].detect).toBe('function')
    expect(typeof ADAPTER_VERSIONS[0].normalize).toBe('function')
    expect(typeof pricingVersion).toBe('string')
    expect(pricingVersion.length).toBeGreaterThan(0)
  })
})
