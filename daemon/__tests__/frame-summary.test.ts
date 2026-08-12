/**
 * Tests for the one place a machine frame becomes a sentence a PERSON reads.
 *
 * WHY THIS SUITE EXISTS. The card that shows «Ход попытки» had a human reading and a raw one,
 * and the human one silently fell back to the raw line whenever a frame meant nothing to it.
 * One frame shape made that fallback catastrophic: an assistant frame carrying an EMPTY
 * reasoning block plus its several-kilobyte signature. Summarised to nothing, printed raw, and
 * the answer to «what is my worker doing» became a wall of base64 — the founder's own words
 * were that it could not be read at all.
 *
 * So what is pinned here is not «the summary is pretty». It is:
 *   - NO ENCODED BLOB REACHES A HUMAN LINE, from any direction: a signature, an image result,
 *     a token in a command. Length is the test, and what is dropped announces its own size.
 *   - THE FRAMES A PERSON NEEDS ARE READ, not only the two that were read before: which
 *     connection was touched, which skill was turned on, what the session was armed with,
 *     what was REFUSED, and whether a long tool is still alive.
 *   - AN UNREADABLE FRAME STAYS UNREADABLE. It summarises to nothing so the screen can hide
 *     it, rather than to an invented sentence about what it might have been.
 *   - IT NEVER THROWS. A worker's garbage output must not kill the tick watching it.
 */

import { describe, it, expect } from 'vitest'

import { summarizeFrame } from '../src/runner/frame-summary.mjs'

/** A run of base64 long enough to be the thing that made the log unreadable. */
const BLOB = 'CAIShwMKhwEIEBgCKkAnLeU4skpdpDL' + 'x'.repeat(120)

const assistant = (...content: any[]) => ({ type: 'assistant', message: { role: 'assistant', content } })

describe('summarizeFrame — the tools, the files, the connections', () => {
  it('names the tool and what it was pointed at', () => {
    const parts = summarizeFrame(assistant({ type: 'tool_use', name: 'Read', input: { file_path: '/repo/a.ts' } }))
    expect(parts).toEqual([{ kind: 'tool', tool: 'Read', detail: '/repo/a.ts' }])
  })

  it('A CONNECTION IS NOT AN ORDINARY TOOL: the server is the subject, the operation the detail', () => {
    // «Which of my connections did it reach» must be answerable by reading one column, and
    // `mcp__claude_ai_Gmail__search_messages` read whole answers it only to somebody who
    // already knows the naming convention.
    const parts = summarizeFrame(
      assistant({ type: 'tool_use', name: 'mcp__claude_ai_Gmail__search_messages', input: { q: 'счета' } }),
    )
    expect(parts[0].kind).toBe('mcp')
    expect(parts[0].tool).toBe('claude_ai_Gmail')
    expect(parts[0].detail).toContain('search_messages')
    expect(parts[0].detail).toContain('счета')
  })

  it('a skill is named by the skill, not by the tool that switched it on', () => {
    const parts = summarizeFrame(assistant({ type: 'tool_use', name: 'Skill', input: { skill: 'sma-ui-qa' } }))
    expect(parts).toEqual([{ kind: 'skill', tool: 'sma-ui-qa' }])
  })

  it('a handoff still carries the brief and the subagent — the most asked-for line in the log', () => {
    const parts = summarizeFrame(
      assistant({ type: 'tool_use', name: 'Task', input: { description: 'проверить окно', subagent_type: 'ui-qa' } }),
    )
    expect(parts).toEqual([{ kind: 'handoff', tool: 'Task', detail: 'проверить окно', subagent: 'ui-qa' }])
  })
})

describe('summarizeFrame — nothing encoded ever reaches a human line', () => {
  it('AN EMPTY REASONING BLOCK SUMMARISES TO NOTHING — its signature must never be printed', () => {
    // This exact frame is what filled the card with base64: the reasoning text is empty and
    // the only long string in it is the signature. Nothing to say is the honest answer, and
    // the screen hides such a row instead of falling back to the raw line.
    const parts = summarizeFrame(assistant({ type: 'thinking', thinking: '', signature: BLOB }))
    expect(parts).toEqual([])
    expect(JSON.stringify(parts)).not.toContain(BLOB.slice(0, 40))
  })

  it('a blob inside a command is replaced by its own size, not printed and not silently cut', () => {
    const parts = summarizeFrame(
      assistant({ type: 'tool_use', name: 'Bash', input: { command: `curl -H "auth: ${BLOB}" https://x` } }),
    )
    expect(parts[0].detail).toContain('двоичные данные')
    expect(parts[0].detail).not.toContain(BLOB.slice(0, 40))
    expect(parts[0].detail).toContain('curl') // the readable part survives
  })

  it('AN IMAGE RESULT IS NAMED, NOT ENCODED — a screenshot is sixteen characters, not half a megabyte', () => {
    const frame = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content: [
              { type: 'text', text: 'снимок готов' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BLOB.repeat(20) } },
            ],
          },
        ],
      },
    }
    const parts = summarizeFrame(frame)
    expect(parts[0].kind).toBe('tool_result')
    expect(parts[0].detail).toContain('снимок готов')
    expect(parts[0].detail).toContain('[изображение]')
    expect(parts[0].detail).not.toContain(BLOB.slice(0, 40))
    expect(parts[0].detail!.length).toBeLessThan(200)
  })

  it('a text result is still a text result, and a failure still says so', () => {
    const frame = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'File does not exist.' }] },
    }
    expect(summarizeFrame(frame)).toEqual([{ kind: 'tool_result', ok: false, detail: 'File does not exist.' }])
  })
})

describe('summarizeFrame — the frames a person needs that used to be dropped', () => {
  it('the session says what it was armed with, and lists the connections it was given', () => {
    const parts = summarizeFrame({
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5',
      tools: ['Read', 'Bash', 'mcp__Gmail__send', 'mcp__Gmail__search', 'mcp__Higgsfield__render'],
      apiKeySource: 'none',
    })
    expect(parts).toHaveLength(1) // «none» is not a billed credential and mints no claim
    expect(parts[0].kind).toBe('session')
    expect(parts[0].detail).toContain('инструментов: 5')
    expect(parts[0].detail).toContain('Gmail')
    expect(parts[0].detail).toContain('Higgsfield')
    expect(parts[0].detail).toContain('claude-opus-5')
  })

  it('A NAMED API CREDENTIAL IS ITS OWN FACT — «did this cost money» has its own answer', () => {
    const parts = summarizeFrame({ type: 'system', subtype: 'init', tools: [], apiKeySource: 'ANTHROPIC_API_KEY' })
    expect(parts).toContainEqual({ kind: 'apikey', detail: 'ANTHROPIC_API_KEY' })
  })

  it('an explicit list of connections is preferred over guessing them from tool names', () => {
    const parts = summarizeFrame({
      type: 'system',
      subtype: 'init',
      tools: ['mcp__WrongGuess__x'],
      mcp_servers: [{ name: 'Gmail' }, 'Notion'],
    })
    expect(parts[0].detail).toContain('Gmail')
    expect(parts[0].detail).toContain('Notion')
    expect(parts[0].detail).not.toContain('WrongGuess')
  })

  it('A REFUSAL IS THE MOST IMPORTANT LINE IN A TRANSCRIPT THAT HAS ONE', () => {
    const parts = summarizeFrame({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'PowerShell',
      message: 'This command requires approval: mklink /J node_modules',
    })
    expect(parts[0].kind).toBe('denied')
    expect(parts[0].ok).toBe(false)
    expect(parts[0].tool).toBe('PowerShell')
    expect(parts[0].detail).toContain('mklink')
  })

  it('«is it stuck?» is answered by the only frame in the stream that answers it', () => {
    const parts = summarizeFrame({ type: 'tool_progress', tool_name: 'Bash', elapsed_time_seconds: 30 })
    expect(parts).toEqual([{ kind: 'progress', tool: 'Bash', detail: 'идёт 30 с' }])
  })

  it('the machinery stays out of the human feed: counters and the twice-told background frames', () => {
    // Both lifecycle frames name a tool call whose own row is already in this log, so
    // summarising them would print every background command three times.
    expect(summarizeFrame({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 })).toEqual([])
    expect(summarizeFrame({ type: 'system', subtype: 'task_started', tool_use_id: 'toolu_1' })).toEqual([])
    expect(summarizeFrame({ type: 'system', subtype: 'task_notification', tool_use_id: 'toolu_1' })).toEqual([])
  })

  it('the finished session carries its own counter, and the window reading is kept', () => {
    expect(summarizeFrame({ type: 'result', is_error: false, total_cost_usd: 3.171632, num_turns: 52 })).toEqual([
      { kind: 'result', ok: true, detail: '$3.1716 · ходов: 52' },
    ])
    const limit = summarizeFrame({
      type: 'rate_limit_event',
      rate_limit_info: { utilization: 0.4, rateLimitType: 'five_hour' },
    })
    expect(limit[0].kind).toBe('limit')
    expect(limit[0].detail).toContain('5 часов')
    expect(limit[0].detail).toContain('40%')
  })

  it('A WINDOW READING WITHOUT A PERCENTAGE IS STILL A WINDOW READING', () => {
    // The vendor sends this frame only about a SUBSCRIPTION window, and on the transcripts
    // this machine actually produces it carries no `utilization` at all. Dropped, it took
    // with it the one channel fact the stream has — «шло ли это по подписке».
    const parts = summarizeFrame({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', overageStatus: 'rejected' },
    })
    expect(parts[0].kind).toBe('limit')
    expect(parts[0].detail).toBe('окно подписки (5 часов): allowed')
    // …and a frame that says nothing at all is still nothing: no row is invented for it
    expect(summarizeFrame({ type: 'rate_limit_event', rate_limit_info: {} })).toEqual([])
  })
})

describe('summarizeFrame — never throws, on anything', () => {
  it('garbage in, empty list out', () => {
    const junk: any[] = [
      null,
      undefined,
      42,
      'string',
      [],
      {},
      { type: 'assistant' },
      { type: 'assistant', message: { content: 'not a list' } },
      { type: 'assistant', message: { content: [null, 7, { type: 'tool_use' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: { weird: true } }] } },
      { type: 'system', subtype: 'init' },
      { type: 'tool_progress' },
    ]
    for (const frame of junk) {
      expect(() => summarizeFrame(frame)).not.toThrow()
      expect(Array.isArray(summarizeFrame(frame))).toBe(true)
    }
  })

  it('a newline in worker text can never forge a second row of the log it is printed in', () => {
    const parts = summarizeFrame(assistant({ type: 'text', text: 'первая\nвторая\r\nтретья' }))
    expect(parts[0].detail).toBe('первая вторая третья')
  })
})
