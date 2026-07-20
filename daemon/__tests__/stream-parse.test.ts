/**
 * Tests for daemon/src/runner/spawn.mjs + stream.mjs + usage.mjs
 * (Phase 9.5 Plan 04, Tasks 2 & 3).
 *
 * The child mechanics + NDJSON stream extraction + usage booking, proven entirely
 * over FIXTURE streams and a RECORDING fake spawnImpl — no test ever spawns a real
 * CLI or spends a token.
 *
 *   spawn.mjs (shell-disabled DI child):
 *   - Test 1: spawnWorker spawns with { shell: false }, writes the prompt to stdin and
 *             ends it, and never places task content in the arg array.
 *   - Test 2: stdout is line-buffered — each complete line hits onLine; a trailing
 *             partial line is flushed on exit; onExit fires with the code.
 *   - Test 3: the returned handle carries pid + a working kill().
 *
 *   stream.mjs (pure NDJSON parsers, never throw):
 *   - Test 4: parseClaudeEvent over the whole claude fixture — system carries sessionId,
 *             assistant events parse, result extracts { totalCostUsd, modelUsage, sessionId }.
 *   - Test 5: parseCodexEvent over the whole codex fixture — thread.started yields threadId,
 *             turn.completed yields the usage token counts.
 *   - Test 6: a garbage line returns { type: 'unparsed' } from BOTH parsers and never throws.
 *
 *   usage.mjs (honest per-account booking — Pitfall 5):
 *   - Test 7: claudeUsageFromResult maps the fixture result → a stream-result row w/ cost.
 *   - Test 8: codexUsageFromFinal with token fields → a codex-final row.
 *   - Test 9: codexUsageFromFinal WITHOUT token fields → a source:'estimate' row (never $0-blind).
 *   - Test 10: bookUsage + readUsage round-trip sums per account within the rolling window.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { spawnWorker } from '../src/runner/spawn.mjs'
import { parseClaudeEvent, parseCodexEvent } from '../src/runner/stream.mjs'
import {
  bookUsage,
  readUsage,
  claudeUsageFromResult,
  codexUsageFromFinal,
  estimateUsage,
} from '../src/runner/usage.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const claudeFixture = readFileSync(join(HERE, 'fixtures', 'claude-stream.ndjson'), 'utf8')
const codexFixture = readFileSync(join(HERE, 'fixtures', 'codex-stream.ndjson'), 'utf8')

/** A recording fake child: captures spawn opts + stdin, lets the test push stdout. */
function makeFakeChild() {
  const child: any = new EventEmitter()
  child.pid = 4242
  child.killed = false
  child.stdin = { chunks: [] as string[], ended: false, write(c: string) { this.chunks.push(String(c)) }, end(c?: string) { if (c) this.chunks.push(String(c)); this.ended = true } }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = function () { this.killed = true; return true }
  return child
}

describe('spawnWorker (excavate safe-child contract — shell disabled, DI)', () => {
  it('spawns with shell:false, writes the prompt to stdin, keeps task content out of args', () => {
    let seen: any = null
    const child = makeFakeChild()
    const spawnImpl = (bin: string, args: string[], opts: any) => {
      seen = { bin, args, opts }
      return child
    }
    const prompt = '# Задача BL-1\n```task\ntitle: hostile `rm -rf`\n```'
    spawnWorker({ bin: 'claude', args: ['--print', '-'], cwd: '/wt/x', env: { A: '1' }, prompt, spawnImpl })
    expect(seen.opts.shell).toBe(false)
    expect(seen.opts.cwd).toBe('/wt/x')
    expect(seen.args).toEqual(['--print', '-']) // task content NOT smuggled into args
    expect(child.stdin.ended).toBe(true)
    expect(child.stdin.chunks.join('')).toContain('title: hostile')
  })

  it('line-buffers stdout, flushes a trailing partial on exit, fires onExit', () => {
    const child = makeFakeChild()
    const lines: string[] = []
    let exit: any = null
    spawnWorker({
      bin: 'claude', args: [], cwd: '/wt', env: {}, prompt: 'p',
      spawnImpl: () => child,
      onLine: (l: string) => lines.push(l),
      onExit: (e: any) => { exit = e },
    })
    child.stdout.emit('data', '{"a":1}\n{"b":')
    child.stdout.emit('data', '2}\ntrailing-no-newline')
    child.emit('exit', 0, null)
    expect(lines).toEqual(['{"a":1}', '{"b":2}', 'trailing-no-newline'])
    expect(exit).toEqual({ code: 0, signal: null })
  })

  it('returns a handle with pid + a working kill()', () => {
    const child = makeFakeChild()
    const handle = spawnWorker({ bin: 'x', args: [], cwd: '/', env: {}, prompt: '', spawnImpl: () => child })
    expect(handle.pid).toBe(4242)
    handle.kill()
    expect(child.killed).toBe(true)
  })
})

describe('parseClaudeEvent (pure, never throws)', () => {
  it('extracts sessionId / assistant / result fields over the whole fixture', () => {
    const events = claudeFixture.split('\n').filter((l) => l.trim()).map(parseClaudeEvent)
    const system = events.find((e) => e.type === 'system')
    const assistants = events.filter((e) => e.type === 'assistant')
    const result = events.find((e) => e.type === 'result')
    expect(system?.sessionId).toBe('9f8e7d6c-1234-4abc-8def-0123456789ab')
    expect(assistants.length).toBe(2)
    expect(result?.totalCostUsd).toBeCloseTo(0.0342, 6)
    expect(result?.sessionId).toBe('9f8e7d6c-1234-4abc-8def-0123456789ab')
    expect(result?.modelUsage).toBeTruthy()
    expect(result?.modelUsage['claude-opus-4-8'].inputTokens).toBe(2200)
  })
})

describe('parseCodexEvent (pure, never throws)', () => {
  it('extracts threadId + the final usage token counts over the whole fixture', () => {
    const events = codexFixture.split('\n').filter((l) => l.trim()).map(parseCodexEvent)
    const started = events.find((e) => e.threadId)
    const final = events.find((e) => e.usage)
    expect(started?.threadId).toBe('th_01H8XABCDEFG')
    expect(final?.usage.input_tokens).toBe(3400)
    expect(final?.usage.output_tokens).toBe(1200)
  })
})

describe('parsers never throw on hostile output (T-9.5-13)', () => {
  it('a garbage line → {type:unparsed} from both parsers, no throw', () => {
    const garbage = 'not json at all }{'
    expect(() => parseClaudeEvent(garbage)).not.toThrow()
    expect(() => parseCodexEvent(garbage)).not.toThrow()
    expect(parseClaudeEvent(garbage).type).toBe('unparsed')
    expect(parseCodexEvent(garbage).type).toBe('unparsed')
    expect(parseClaudeEvent('').type).toBe('unparsed')
  })
})

describe('usage.mjs — honest per-account booking (Pitfall 5)', () => {
  let dataDir: string
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'sma-usage-')) })
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }) })

  it('claudeUsageFromResult maps the fixture result → a stream-result row with cost', () => {
    const result = claudeFixture.split('\n').filter((l) => l.trim()).map(parseClaudeEvent).find((e) => e.type === 'result')
    const row = claudeUsageFromResult(result, { accountName: 'max-1', taskId: 'BL-1' })
    expect(row.source).toBe('stream-result')
    expect(row.provider).toBe('claude')
    expect(row.costUsd).toBeCloseTo(0.0342, 6)
    expect(row.inputTokens).toBe(2200)
    expect(row.outputTokens).toBe(120)
  })

  it('codexUsageFromFinal with token fields → a codex-final row', () => {
    const final = codexFixture.split('\n').filter((l) => l.trim()).map(parseCodexEvent).find((e) => e.usage)
    const row = codexUsageFromFinal(final, { accountName: 'pro-1', taskId: 'R-2', model: 'gpt-5-codex' })
    expect(row.source).toBe('codex-final')
    expect(row.inputTokens).toBe(3400)
    expect(row.outputTokens).toBe(1200)
  })

  it('codexUsageFromFinal WITHOUT token fields → a source:estimate row (never $0-blind)', () => {
    const noTokens = { type: 'turn.completed' } // GAP: no usage
    const row = codexUsageFromFinal(noTokens, {
      accountName: 'pro-1', taskId: 'R-3', model: 'gpt-5-codex',
      startedAt: 1_000, endedAt: 61_000, // 60s
    })
    expect(row.source).toBe('estimate')
    expect(row.outputTokens).toBeGreaterThan(0) // booked SOMETHING, never blind $0
  })

  it('bookUsage + readUsage round-trip sums per account within the rolling window', () => {
    const now = 100_000
    bookUsage({ dataDir, event: { ts: new Date(now - 1000).toISOString(), accountName: 'max-1', provider: 'claude', taskId: 't1', inputTokens: 100, outputTokens: 10, costUsd: 0.01, source: 'stream-result' } })
    bookUsage({ dataDir, event: { ts: new Date(now - 2000).toISOString(), accountName: 'max-1', provider: 'claude', taskId: 't2', inputTokens: 200, outputTokens: 20, costUsd: 0.02, source: 'stream-result' } })
    // an old row outside the window
    bookUsage({ dataDir, event: { ts: new Date(now - 999_999).toISOString(), accountName: 'max-1', provider: 'claude', taskId: 't0', inputTokens: 999, outputTokens: 99, source: 'stream-result' } })
    // a different account
    bookUsage({ dataDir, event: { ts: new Date(now - 500).toISOString(), accountName: 'pro-1', provider: 'codex', taskId: 'x', inputTokens: 5, outputTokens: 5, source: 'codex-final' } })

    const summed = readUsage({ dataDir, accountName: 'max-1', windowMs: 60_000, clock: () => now })
    expect(summed.inputTokens).toBe(300)
    expect(summed.outputTokens).toBe(30)
    expect(summed.costUsd).toBeCloseTo(0.03, 6)
    expect(summed.rows).toBe(2)
  })

  it('estimateUsage never books a zero-token row', () => {
    const row = estimateUsage({ accountName: 'pro-1', taskId: 'z', model: 'gpt-5-codex', startedAt: 0, endedAt: 0 })
    expect(row.source).toBe('estimate')
    expect(row.outputTokens).toBeGreaterThanOrEqual(1)
  })
})
