/**
 * Tests for daemon/src/runner/spawn.mjs + stream.mjs + usage.mjs
 *.
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
 *   - Test 6b: SUBAGENT PROVENANCE — a frame carrying parent_tool_use_id parses as
 *             {subagent:true, parentId}, a frame without it as {subagent:false} and NO id,
 *             and the result frame keeps handing out its sessionId either way (regression).
 *
 *   usage.mjs (honest per-account booking):
 *   - Test 7: claudeUsageFromResult maps the fixture result → a stream-result row w/ cost.
 *   - Test 8: codexUsageFromFinal with token fields → a codex-final row.
 *   - Test 8b: the CACHE WRITE is read off the frame rather than hard-zeroed — this provider
 *             does report it (`cache_write_input_tokens`), and a zero written over a number the
 *             frame carried is a lost measurement, not caution.
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
  codexTokensFromFinal,
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

  /**
   * КАК ЗАКОНЧИЛСЯ ПРОГОН — по слову самого CLI. Завершающий кадр несёт эти два поля, когда
   * прогон закончил не работник, а провайдер (перегрузка, серверная ошибка), и до сих пор они
   * пролетали мимо: читателю оставалось `is_error`, одинаковое и для отказа провайдера, и для
   * работы, закончившейся ошибкой по существу. Обычный кадр не говорит о них НИЧЕГО — ключей
   * нет вовсе, а не null, придуманный за библиотеку.
   */
  it('завершающий кадр отдаёт слово CLI о конце прогона: причина и код провайдера', () => {
    const cut = parseClaudeEvent(
      JSON.stringify({
        type: 'result',
        is_error: true,
        terminal_reason: 'api_error',
        api_error_status: 529,
        result: 'API Error: 529 Overloaded',
        session_id: 's-529',
      }),
    )
    expect(cut.isError).toBe(true)
    expect(cut.terminalReason).toBe('api_error')
    expect(cut.apiErrorStatus).toBe(529)

    const ordinary = parseClaudeEvent(JSON.stringify({ type: 'result', is_error: false, session_id: 's-ok' }))
    expect(ordinary.terminalReason).toBe(null)
    expect(ordinary.apiErrorStatus).toBe(null)
  })

  /**
   * КАК CLI НАЗВАЛ ИСХОД СВОИМ СЛОВОМ — и почему это читается именно с ЗАВЕРШАЮЩЕГО кадра.
   *
   * Схема завершающего кадра у CLI закрытая: успех либо одно из четырёх слов неуспеха, и одно
   * из них называет упор в потолок ходов. У кадра системного типа это слово читалось всегда, у
   * завершающего — не читалось вовсе, и попытка, срезанная потолком, приходила на экран
   * неотличимой от любого другого провала работника: та же «нет квитанции», та же «ошибка
   * работника». Поле новое, и до этой правки читателей у него не было.
   *
   * Слово читается и у успеха тоже: это НЕ поле «только для ошибок», а имя исхода. Обычный
   * кадр, который своего слова не сказал, отдаёт null — придумывать за библиотеку нечего.
   */
  it('завершающий кадр отдаёт слово исхода: упор в потолок ходов, успех и молчание', () => {
    const capped: any = parseClaudeEvent(
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 80, session_id: 's-cap' }),
    )
    expect(capped.subtype).toBe('error_max_turns')
    expect(capped.numTurns).toBe(80)
    expect(capped.isError).toBe(true)

    const ok: any = parseClaudeEvent(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 4 }))
    expect(ok.subtype).toBe('success')
    expect(ok.numTurns).toBe(4)

    const silent: any = parseClaudeEvent(JSON.stringify({ type: 'result', is_error: false }))
    expect(silent.subtype).toBe(null)
    expect(silent.numTurns).toBe(null)
  })
})

/**
 * THE FRAME THAT WAS FLOWING PAST UNREAD.
 *
 * `rate_limit_event` carries the vendor's own view of the subscription window and arrives on
 * ordinary spawns, not only on failures. It went unparsed for as long as the window model
 * assumed no such reading existed — which is why the roster's bars sat near zero on an account
 * that was three quarters spent. The seconds/milliseconds case is the one that would fail
 * SILENTLY: read as milliseconds, a reset three days out lands in 1970 and every freshness
 * check throws the measurement away without an error anywhere.
 */
describe('parseClaudeEvent — the subscription window reading', () => {
  const frame = (info: object) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'u', session_id: 's' })

  it('reads the window, the fraction spent and the reset — the shape the CLI actually sends', () => {
    const e: any = parseClaudeEvent(
      frame({ status: 'allowed_warning', resetsAt: 1786788000, rateLimitType: 'seven_day', utilization: 0.73, isUsingOverage: false }),
    )
    expect(e.type).toBe('rate_limit')
    expect(e.limitType).toBe('seven_day')
    expect(e.utilization).toBe(0.73) // a FRACTION on the wire, kept as one
    expect(e.status).toBe('allowed_warning')
    expect(e.usingOverage).toBe(false)
  })

  it('normalises the reset to milliseconds — seconds on the wire would silently date to 1970', () => {
    const seconds: any = parseClaudeEvent(frame({ rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 1786788000 }))
    expect(seconds.resetsAt).toBe(1786788000000)
    expect(seconds.resetsAt).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'))
    // …and a stamp already in milliseconds is left alone
    expect((parseClaudeEvent(frame({ rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 1786788000000 })) as any).resetsAt).toBe(1786788000000)
  })

  it('a frame with nothing usable in it is still an event, with nulls — never a throw', () => {
    const e: any = parseClaudeEvent(JSON.stringify({ type: 'rate_limit_event' }))
    expect(e.type).toBe('rate_limit')
    expect(e.limitType).toBeNull()
    expect(e.utilization).toBeNull()
    expect(e.resetsAt).toBeNull()
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

describe('parsers never throw on hostile output', () => {
  it('a garbage line → {type:unparsed} from both parsers, no throw', () => {
    const garbage = 'not json at all }{'
    expect(() => parseClaudeEvent(garbage)).not.toThrow()
    expect(() => parseCodexEvent(garbage)).not.toThrow()
    expect(parseClaudeEvent(garbage).type).toBe('unparsed')
    expect(parseCodexEvent(garbage).type).toBe('unparsed')
    expect(parseClaudeEvent('').type).toBe('unparsed')
  })
})

describe('subagent provenance — the live log can tell a delegated line from the session’s own', () => {
  it('a frame with parent_tool_use_id → {subagent:true} + the opaque parent id', () => {
    const frame = JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'toolu_01ABCdefGHIjkl',
      message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 2 } },
    })
    const e = parseClaudeEvent(frame)
    expect(e.subagent).toBe(true)
    expect(e.parentId).toBe('toolu_01ABCdefGHIjkl')
    expect(e.model).toBe('claude-opus-4-8') // the existing extraction is untouched
  })

  it('a frame WITHOUT it → {subagent:false} and no parentId key at all', () => {
    const events = claudeFixture.split('\n').filter((l) => l.trim()).map(parseClaudeEvent)
    for (const e of events) {
      expect(e.subagent).toBe(false)
      expect('parentId' in e).toBe(false) // an absent id is absent, never the empty string
    }
  })

  it('the result frame still yields its sessionId — with a parent id and without one', () => {
    const plain = parseClaudeEvent(JSON.stringify({ type: 'result', session_id: 'sess-plain', total_cost_usd: 1 }))
    const nested = parseClaudeEvent(
      JSON.stringify({ type: 'result', session_id: 'sess-nested', parent_tool_use_id: 'toolu_XYZ' }),
    )
    expect(plain.sessionId).toBe('sess-plain')
    expect(plain.subagent).toBe(false)
    expect(nested.sessionId).toBe('sess-nested')
    expect(nested.subagent).toBe(true)
    expect(nested.parentId).toBe('toolu_XYZ')
  })

  it('a hostile parent id does not change the never-throw contract, and is passed through opaque', () => {
    const hostile = JSON.stringify({ type: 'assistant', parent_tool_use_id: '../../etc/passwd ' })
    expect(() => parseClaudeEvent(hostile)).not.toThrow()
    const e = parseClaudeEvent(hostile)
    expect(e.subagent).toBe(true)
    expect(e.parentId).toBe('../../etc/passwd ') // NOT interpreted here — capped/sanitized at storage
    // and a broken line is still shapeless: no invented provenance
    expect(parseClaudeEvent('}{ not json').type).toBe('unparsed')
    expect('subagent' in parseClaudeEvent('}{ not json')).toBe(false)
  })
})

describe('usage.mjs — honest per-account booking', () => {
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

  /**
   * ═══════ ЧЕТВЁРТОЕ ЧИСЛО ЧИТАЕТСЯ ИЗ КАДРА, А НЕ СТАВИТСЯ НУЛЁМ ═══════
   *
   * Здесь стоял жёсткий `cacheWrite: 0` с объяснением, что этот поставщик про запись кэша не
   * говорит. Кадр `turn.completed` у codex-cli 0.150.1 её сообщает — `cache_write_input_tokens`
   * рядом с `cached_input_tokens`. Ноль вместо присланного поля — не осторожность, а
   * потерянное измерение: попытка, залившая в кэш миллион, и попытка, не залившая ничего,
   * выглядели в квитанции одинаково.
   */
  it('codexTokensFromFinal reads the cache WRITE the frame actually carries', () => {
    const frame = parseCodexEvent(JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 13_070,
        cached_input_tokens: 11_008,
        cache_write_input_tokens: 1_920,
        output_tokens: 5,
      },
    }))
    expect(codexTokensFromFinal(frame)).toEqual({ input: 13_070, output: 5, cacheRead: 11_008, cacheWrite: 1_920 })
  })

  it('a frame that carries no cache write is still an honest zero, and camelCase reads too', () => {
    expect(codexTokensFromFinal({ usage: { input_tokens: 10, output_tokens: 2 } }).cacheWrite).toBe(0)
    expect(codexTokensFromFinal({ usage: { cacheWriteInputTokens: 7 } }).cacheWrite).toBe(7)
    expect(codexTokensFromFinal({}).cacheWrite).toBe(0)
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
    // channel-less rows are subscription work by construction → none of it is paid money
    expect(summed.apiCostUsd).toBe(0)
  })

  it('splits the paid-channel share from the plan-absorbed cost (QA D4)', () => {
    const now = 100_000
    bookUsage({ dataDir, event: { ts: new Date(now - 1000).toISOString(), accountName: 'api', provider: 'claude', taskId: 'p1', inputTokens: 10, outputTokens: 1, costUsd: 0.05, channel: 'api', source: 'stream-result' } })
    bookUsage({ dataDir, event: { ts: new Date(now - 2000).toISOString(), accountName: 'api', provider: 'claude', taskId: 'p2', inputTokens: 10, outputTokens: 1, costUsd: 0.12, channel: 'subscription', source: 'stream-result' } })
    const summed = readUsage({ dataDir, accountName: 'api', windowMs: 60_000, clock: () => now })
    expect(summed.costUsd).toBeCloseTo(0.17, 6) // the window bars still see all of it
    expect(summed.apiCostUsd).toBeCloseTo(0.05, 6) // «платный канал» sees ONLY the invoice
  })

  it('estimateUsage never books a zero-token row', () => {
    const row = estimateUsage({ accountName: 'pro-1', taskId: 'z', model: 'gpt-5-codex', startedAt: 0, endedAt: 0 })
    expect(row.source).toBe('estimate')
    expect(row.outputTokens).toBeGreaterThanOrEqual(1)
  })

  it('a MISSING start is not a session since 1970 — the estimate refuses to invent a duration', () => {
    // What production really did: no startedAt, endedAt = an epoch timestamp. The old formula
    // read that as fifty-six years and booked ~35 billion tokens into the book the spending
    // cap reads from.
    const row = estimateUsage({ accountName: 'pro-1', taskId: 'z', endedAt: 1786377106855 })
    expect(row.outputTokens).toBe(1) // the floor: «unknown, and not free»
    expect(row.outputTokens).toBeLessThan(1000)
  })

  it('a real pair is still estimated from its real duration', () => {
    const start = 1786377106855
    const row = estimateUsage({ accountName: 'pro-1', taskId: 'z', startedAt: start, endedAt: start + 120000 })
    expect(row.outputTokens).toBe(2400) // two minutes at the documented rate
  })

  it('an impossible span is a broken pair, not a long attempt', () => {
    const start = 1786377106855
    const row = estimateUsage({ accountName: 'pro-1', taskId: 'z', startedAt: start, endedAt: start + 40 * 60 * 60 * 1000 })
    expect(row.outputTokens).toBe(1)
    // and a reversed pair likewise
    expect(estimateUsage({ startedAt: start + 1000, endedAt: start }).outputTokens).toBe(1)
  })
})
