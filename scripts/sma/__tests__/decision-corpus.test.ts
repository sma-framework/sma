/**
 * Tests for scripts/sma/lib/decision-corpus.mjs (Phase 9.5 Plan 02, Task 1).
 *
 * D-9.5-08 lane 1 — the decision-corpus miner. It retrospectively mines the
 * founder's real decisions (orders, corrections, refusals, приёмка) from local
 * session transcripts into DRAFT corpus notes «ситуация → решение + почему»,
 * copying the excavate.mjs containment posture verbatim.
 *
 *   - Test 1  (export contract): mineDecisions/redactSecrets are functions,
 *     DECISION_SIGNALS is a frozen array of signal descriptors.
 *   - Test 2  (mining + schema): a fixture transcript with a founder order lands
 *     one draft under <memoryDir>/drafts/ with the founder-decision frontmatter
 *     contract (kind/tags/use-when/importance/metadata) + the three body sections.
 *   - Test 3  (determinism): two runs over the same fixtures produce byte-identical
 *     draft content AND identical filenames (no Date.now in the ranking path).
 *   - Test 4  (containment): every fs write goes ONLY under <memoryDir>/drafts/ —
 *     nothing is ever written outside the memory tree (fsImpl recorder).
 *   - Test 5  (redaction): a fixture fake token does not survive into the draft.
 *   - Test 6  (tolerance): a non-JSON transcript line is skipped + counted, never
 *     thrown on.
 *   - Test 7  (why-required): the «Почему» section is present even when no
 *     reasoning was mined (the review-stub marker).
 *   - Test 8  (corpusStats): counts drafted founder-decision notes by kind.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mineDecisions, corpusStats, redactSecrets, DECISION_SIGNALS } from '../lib/decision-corpus.mjs'

const FIXED_CLOCK = () => '2026-07-14T00:00:00.000Z'

/** One transcript record line (Claude Code JSONL user/assistant shape). */
function userLine(content: string, over: Record<string, any> = {}) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    timestamp: over.timestamp ?? '2026-07-14T10:00:00.000Z',
    sessionId: over.sessionId ?? 'sess-a',
    ...over,
  })
}
function assistantLine(text: string, over: Record<string, any> = {}) {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    timestamp: over.timestamp ?? '2026-07-14T09:59:00.000Z',
    sessionId: over.sessionId ?? 'sess-a',
    ...over,
  })
}

/** Write a transcripts dir with the given {file: lines[]} map; return its path. */
function mkTranscripts(files: Record<string, string[]>) {
  const dir = mkdtempSync(join(tmpdir(), 'sma-dc-tx-'))
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(dir, name), lines.join('\n'), 'utf8')
  }
  return dir
}

function mkMemoryDir() {
  return mkdtempSync(join(tmpdir(), 'sma-dc-mem-'))
}

const cleanup: string[] = []
afterEach(() => {
  while (cleanup.length) {
    try {
      rmSync(cleanup.pop() as string, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

describe('export contract (Test 1)', () => {
  it('exposes the miner + redactor functions and a frozen DECISION_SIGNALS array', () => {
    expect(typeof mineDecisions).toBe('function')
    expect(typeof redactSecrets).toBe('function')
    expect(typeof corpusStats).toBe('function')
    expect(Array.isArray(DECISION_SIGNALS)).toBe(true)
    expect(DECISION_SIGNALS.length).toBeGreaterThan(0)
    expect(Object.isFrozen(DECISION_SIGNALS)).toBe(true)
  })
})

describe('mineDecisions — schema + drafts-only (Test 2)', () => {
  it('lands one founder-decision draft with the full frontmatter + body contract', () => {
    const tx = mkTranscripts({
      'a.jsonl': [
        assistantLine('Я предлагаю закоммитить ключ прямо в репозиторий.'),
        userLine('никогда так не делай, это HARD RULE — секреты в репозиторий не коммитим'),
      ],
    })
    const mem = mkMemoryDir()
    cleanup.push(tx, mem)

    const res = mineDecisions({ transcriptsDir: tx, memoryDir: mem, clock: FIXED_CLOCK })
    expect(res.drafted).toBe(1)
    expect(res.scanned).toBeGreaterThanOrEqual(2)

    const draftsDir = join(mem, 'drafts')
    const files = readdirSync(draftsDir).filter((f) => f.startsWith('decision-') && f.endsWith('.md'))
    expect(files.length).toBe(1)

    const text = readFileSync(join(draftsDir, files[0]), 'utf8')
    expect(text).toMatch(/^---\n/)
    expect(text).toContain('kind: founder-decision')
    expect(text).toMatch(/tags: \[/)
    expect(text).toMatch(/use-when:/)
    expect(text).toMatch(/importance: \d/)
    expect(text).toContain('metadata:')
    expect(text).toContain('source: transcripts')
    // three required body sections
    expect(text).toContain('## Ситуация')
    expect(text).toContain('## Решение основателя')
    expect(text).toContain('## Почему')
    // mined decision text is confined to a fenced untrusted-evidence block
    expect(text).toContain('```untrusted-evidence')
    expect(text).toContain('HARD RULE')
  })
})

describe('mineDecisions — determinism (Test 3)', () => {
  it('two runs over the same fixtures produce byte-identical drafts + filenames', () => {
    const files = {
      'a.jsonl': [
        assistantLine('Предлагаю вариант с новой таблицей.', { sessionId: 's1' }),
        userLine('нет, переделай — не так, сделай колонкой', { sessionId: 's1', timestamp: '2026-07-13T08:00:00.000Z' }),
      ],
      'b.jsonl': [userLine('ок, принято, одобряю', { sessionId: 's2', timestamp: '2026-07-12T08:00:00.000Z' })],
    }
    const tx1 = mkTranscripts(files)
    const tx2 = mkTranscripts(files)
    const mem1 = mkMemoryDir()
    const mem2 = mkMemoryDir()
    cleanup.push(tx1, tx2, mem1, mem2)

    mineDecisions({ transcriptsDir: tx1, memoryDir: mem1, clock: FIXED_CLOCK })
    mineDecisions({ transcriptsDir: tx2, memoryDir: mem2, clock: FIXED_CLOCK })

    const d1 = readdirSync(join(mem1, 'drafts')).sort()
    const d2 = readdirSync(join(mem2, 'drafts')).sort()
    expect(d1).toEqual(d2)
    for (const f of d1) {
      expect(readFileSync(join(mem1, 'drafts', f), 'utf8')).toBe(readFileSync(join(mem2, 'drafts', f), 'utf8'))
    }
  })
})

describe('mineDecisions — containment (Test 4)', () => {
  it('writes ONLY under <memoryDir>/drafts/ (fsImpl recorder)', () => {
    const tx = mkTranscripts({
      'a.jsonl': [userLine('сделай это обязательно, всегда так делай')],
    })
    const mem = mkMemoryDir()
    cleanup.push(tx, mem)

    const writes: string[] = []
    const fsImpl = {
      readdirSync,
      readFileSync,
      existsSync: () => false,
      mkdirSync: (p: string, o?: any) => {
        writes.push(String(p))
        return mkdirSync(p, o)
      },
      writeFileSync: (p: string, data: string) => {
        writes.push(String(p))
        return writeFileSync(p, data)
      },
    }

    mineDecisions({ transcriptsDir: tx, memoryDir: mem, clock: FIXED_CLOCK, fsImpl })
    expect(writes.length).toBeGreaterThan(0)
    const draftsDir = join(mem, 'drafts')
    for (const p of writes) {
      expect(p.startsWith(draftsDir)).toBe(true)
    }
  })
})

describe('redactSecrets + mining (Test 5)', () => {
  it('a fake token does not survive into the draft', () => {
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    expect(redactSecrets(`token=${secret}`)).not.toContain(secret)
    expect(redactSecrets(`Bearer ${secret}`)).toContain('[redacted]')

    const tx = mkTranscripts({
      'a.jsonl': [userLine(`сделай так: положи ключ token=${secret} в конфиг, это нужно`)],
    })
    const mem = mkMemoryDir()
    cleanup.push(tx, mem)

    mineDecisions({ transcriptsDir: tx, memoryDir: mem, clock: FIXED_CLOCK })
    const draftsDir = join(mem, 'drafts')
    const f = readdirSync(draftsDir)[0]
    const text = readFileSync(join(draftsDir, f), 'utf8')
    expect(text).not.toContain(secret)
    expect(text).toContain('[redacted]')
  })
})

describe('mineDecisions — malformed-line tolerance (Test 6)', () => {
  it('skips a non-JSON line, counts it, and still drafts', () => {
    const tx = mkTranscripts({
      'a.jsonl': [
        '{ this is not valid json',
        userLine('переделай это, не так'),
        'also-garbage',
      ],
    })
    const mem = mkMemoryDir()
    cleanup.push(tx, mem)

    const res = mineDecisions({ transcriptsDir: tx, memoryDir: mem, clock: FIXED_CLOCK })
    expect(res.skipped).toBeGreaterThanOrEqual(2)
    expect(res.drafted).toBe(1)
  })
})

describe('mineDecisions — «Почему» always present (Test 7)', () => {
  it('emits the review-stub «Почему» marker when no reasoning was mined', () => {
    const tx = mkTranscripts({
      'a.jsonl': [userLine('сделай быстрый пуш')],
    })
    const mem = mkMemoryDir()
    cleanup.push(tx, mem)

    mineDecisions({ transcriptsDir: tx, memoryDir: mem, clock: FIXED_CLOCK })
    const draftsDir = join(mem, 'drafts')
    const text = readFileSync(join(draftsDir, readdirSync(draftsDir)[0]), 'utf8')
    expect(text).toContain('## Почему')
    expect(text).toMatch(/дополнить при ревью/i)
  })
})

describe('corpusStats (Test 8)', () => {
  it('counts drafted founder-decision notes by kind', () => {
    const tx = mkTranscripts({
      'a.jsonl': [
        userLine('никогда не коммить секреты, это HARD RULE', { sessionId: 's1', timestamp: '2026-07-14T10:00:00.000Z' }),
        userLine('переделай форму, потому что кнопка не видна', { sessionId: 's2', timestamp: '2026-07-13T10:00:00.000Z' }),
      ],
    })
    const mem = mkMemoryDir()
    cleanup.push(tx, mem)

    mineDecisions({ transcriptsDir: tx, memoryDir: mem, clock: FIXED_CLOCK })
    const stats = corpusStats({ memoryDir: mem })
    expect(stats.total).toBeGreaterThanOrEqual(1)
    expect(stats.byKind['founder-decision']).toBeGreaterThanOrEqual(1)
  })
})
