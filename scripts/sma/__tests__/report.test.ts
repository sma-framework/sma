/**
 * Tests for scripts/sma/lib/report.mjs (Phase 49.1 Plan 24, Task 2 — D-49.1-07, B23).
 *
 * The LOCAL static-HTML report: zero server, zero daemon, zero DB. renderReport is
 * a pure transform (fixtures in, one self-contained HTML string out). The four
 * pinned behaviours + the XSS escape pin (T-49.1-51):
 *   - Test 1: renderReport over full fixture -> one self-contained HTML string
 *     (no external script/css URLs) containing the six sections + metrics.
 *   - Test 2: every empty data source renders its honest empty-state text.
 *   - Test 3: the footer carries the generated-at timestamp line.
 *   - Test 4: writeReport writes the file; defaultReportPath is .sma/report/index.html.
 *   - Test 5 (T-49.1-51): journal strings are HTML-escaped (a <script> fixture entry
 *     never lands as live markup).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderReport, writeReport, defaultReportPath } from '../lib/report.mjs'

const FULL = {
  generatedAt: '2026-07-06T12:00:00Z',
  sessions: [{ id: 't-abc', status: 'working', description: 'metrics + report', blockers: [] }],
  predictions: [{ domain: 'payload', verdict: 'hit', ts: '2026-07-05T10:00:00Z' }],
  calibration: [{ domain: 'payload', rate: 0.8, n: 5, hits: 4, misses: 1 }],
  reflex: [{ noteId: 'feedback_x.md', target: 'src/x.ts', ts: '2026-07-05T11:00:00Z', actor: 'Tom' }],
  collisions: [{ type: 'collision', actors: ['Tom', 'Sam'], scope: 'src/x.ts', ts: '2026-07-05T11:30:00Z' }],
  corpus: { lintCritical: 0, lintWarn: 2, corpusFiles: 206, indexCommit: 'abc1234' },
  metrics: {
    leadTime: { available: true, plans: [{ id: '49.1-01', ms: 3600000, incomplete: false }] },
    reworkRate: { available: true, rate: 0.2, rework: 2, total: 10 },
    deviations: { available: true, byKind: { gate: 2, collision: 1 }, total: 3 },
  },
}

const SECTION_IDS = ['sessions', 'predictions', 'calibration', 'reflex', 'collisions', 'corpus', 'metrics']

describe('renderReport — self-contained static HTML', () => {
  it('returns one self-contained HTML doc with all six sections + metrics', () => {
    const html = renderReport(FULL)
    expect(html).toContain('<!DOCTYPE html>')
    // No external assets — must open file:// offline (no http(s) src/href).
    expect(/(?:src|href)=["']https?:/i.test(html)).toBe(false)
    // No protocol-relative asset URLs either.
    expect(/(?:src|href)=["']\/\//i.test(html)).toBe(false)
    for (const id of SECTION_IDS) {
      expect(html).toContain(`id="${id}"`)
    }
    // Real values render.
    expect(html).toContain('206') // corpus files
    expect(html).toContain('payload') // domain
  })
})

describe('honest empty states (no-fake-dashboard-data)', () => {
  it('renders an empty-state marker for every absent source, no fabricated numbers', () => {
    const empty = {
      generatedAt: '2026-07-06T12:00:00Z',
      sessions: [],
      predictions: [],
      calibration: [],
      reflex: [],
      collisions: [],
      corpus: null,
      metrics: {
        leadTime: { available: false, plans: [] },
        reworkRate: { available: false, rate: null },
        deviations: { available: false, byKind: {}, total: 0 },
      },
    }
    const html = renderReport(empty)
    // Every section is present…
    for (const id of SECTION_IDS) {
      expect(html).toContain(`id="${id}"`)
    }
    // …and each renders the honest empty marker (>= one per section).
    const emptyCount = (html.match(/Нет данных/g) || []).length
    expect(emptyCount).toBeGreaterThanOrEqual(SECTION_IDS.length)
  })
})

describe('footer timestamp (house HTML rule)', () => {
  it('carries the generated-at line', () => {
    const html = renderReport(FULL)
    expect(html).toContain('Generated:')
    expect(html).toContain('2026-07-06T12:00:00Z')
  })
})

describe('writeReport + defaultReportPath', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sma-report-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writeReport writes the HTML to the given out path', () => {
    const out = join(dir, 'nested', 'index.html')
    const res = writeReport({ out, html: renderReport(FULL) })
    expect(res.written).toBe(out)
    const onDisk = readFileSync(out, 'utf8')
    expect(onDisk).toContain('<!DOCTYPE html>')
  })

  it('defaultReportPath resolves to <smaRoot>/report/index.html', () => {
    const p = defaultReportPath({ smaRoot: join('X', '.sma') })
    expect(p).toBe(join('X', '.sma', 'report', 'index.html'))
  })
})

describe('XSS escape (T-49.1-51)', () => {
  it('escapes journal strings so a <script> entry never lands as live markup', () => {
    const evil = {
      ...FULL,
      sessions: [{ id: 't-x', status: 'working', description: '<script>alert(1)</script>', blockers: [] }],
      collisions: [{ type: 'collision', actors: ['<img src=x onerror=alert(1)>'], scope: 'a', ts: '2026-07-05T11:30:00Z' }],
    }
    const html = renderReport(evil)
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<img src=x onerror=')
  })
})
