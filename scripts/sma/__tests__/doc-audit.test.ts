/**
 * Tests for scripts/sma/lib/doc-audit.mjs (Phase 49.3 Plan 09, Task 2 — D-49.3-01/15).
 *
 *  - Test 1: extractRegion returns the content between paired markers; missing/unpaired
 *    markers return {found:false}.
 *  - Test 2: auditManual flags a SURFACE_MANIFEST entry absent from its language region
 *    (rule:'surface-missing'); all tokens present yields zero surface violations.
 *  - Test 3: a footer stamp >= 2026-07-07 passes; an older/absent stamp is stale-stamp.
 *  - Test 4: auditReadme requires all five ANALOGS + the per-language WEDGE in the region.
 *  - Test 5 (both directions): a multiplier INSIDE the positioning region is a violation;
 *    the SAME string OUTSIDE the region is not.
 *  - Test 6: an em-dash in a RU region is ru-em-dash; an em-dash in an EN region is allowed.
 *  - Test 7 (CLI contract): `doc-audit --count` exits 0 with a bare integer last line;
 *    `doc-audit --json` prints the violation records + count.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SURFACE_MANIFEST,
  ANALOGS,
  WEDGE,
  MULTIPLIER_RE,
  extractRegion,
  auditManual,
  auditReadme,
  audit,
} from '../lib/doc-audit.mjs'

const REAL_CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url))
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

// ── fixture builders ──────────────────────────────────────────────────────────

function goodFooter() {
  return '<footer>SMA manual<br>Last updated: 08.07.2026, 09:00 CEST</footer>'
}

function manualHtml(lang: 'en' | 'ru', opts: { dropId?: string; emDash?: boolean; footer?: string } = {}) {
  const tokens = SURFACE_MANIFEST.filter((e) => e.id !== opts.dropId)
    .map((e) => `<p>${e[lang]} explained here.</p>`)
    .join('\n')
  const dash = opts.emDash ? '<p>a token — with an em-dash</p>' : ''
  const footer = opts.footer ?? goodFooter()
  return `<html><body>\n<!-- sma:v35:start -->\n${tokens}\n${dash}\n<!-- sma:v35:end -->\n${footer}\n</body></html>`
}

function readmeMd(lang: 'en' | 'ru', opts: { dropAnalog?: string; noWedge?: boolean; multiplier?: string; emDash?: boolean } = {}) {
  const analogs = ANALOGS.filter((a) => a !== opts.dropAnalog).join(', ')
  const wedge = opts.noWedge ? '' : WEDGE[lang]
  const mult = opts.multiplier ? ` ${opts.multiplier}` : ''
  const dash = opts.emDash ? ' text — dash' : ''
  return `# README\n\n<!-- sma:positioning:start -->\n## How SMA compares\nAnalogs: ${analogs}. ${wedge}.${mult}${dash}\n<!-- sma:positioning:end -->\n\n10x is fine out here.\n`
}

/** Build an injected readFile over an in-memory {relPath: content} map rooted at ROOT-fake. */
function fakeReader(files: Record<string, string>) {
  const rootDir = '/fake-root'
  const map = new Map<string, string>()
  for (const [rel, content] of Object.entries(files)) map.set(join(rootDir, ...rel.split('/')), content)
  const readFile = (p: string) => {
    if (map.has(p)) return map.get(p) as string
    throw new Error(`ENOENT ${p}`)
  }
  return { rootDir, readFile }
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('doc-audit.mjs — region extraction', () => {
  it('Test 1: extractRegion returns paired content and flags missing markers', () => {
    const html = 'a<!-- sma:v35:start -->INNER<!-- sma:v35:end -->b'
    const ok = extractRegion(html, 'sma:v35')
    expect(ok.found).toBe(true)
    expect(ok.content).toBe('INNER')
    expect(extractRegion('no markers here', 'sma:v35').found).toBe(false)
    expect(extractRegion('<!-- sma:v35:start --> unpaired', 'sma:v35').found).toBe(false)
  })
})

describe('doc-audit.mjs — manual audit', () => {
  it('Test 2: a dropped SURFACE_MANIFEST token is surface-missing; a full region is clean', () => {
    const clean = fakeReader({
      'docs/manual.en.html': manualHtml('en'),
      'docs/manual.ru.html': manualHtml('ru'),
    })
    expect(auditManual(clean).length).toBe(0)

    const dropped = fakeReader({
      'docs/manual.en.html': manualHtml('en', { dropId: 'excavate' }),
      'docs/manual.ru.html': manualHtml('ru'),
    })
    const v = auditManual(dropped)
    expect(v.some((x) => x.rule === 'surface-missing' && x.detail === 'excavate')).toBe(true)
  })

  it('Test 3: a stale or missing footer stamp is a stale-stamp violation', () => {
    const stale = fakeReader({
      'docs/manual.en.html': manualHtml('en', { footer: '<footer>Last updated: 01.01.2026, 09:00 CEST</footer>' }),
      'docs/manual.ru.html': manualHtml('ru', { footer: '<footer>no date here</footer>' }),
    })
    const v = auditManual(stale)
    expect(v.filter((x) => x.rule === 'stale-stamp').length).toBe(2)
  })

  it('Test 6a: an em-dash inside the RU manual region is a violation; EN is allowed', () => {
    const v = auditManual(
      fakeReader({
        'docs/manual.en.html': manualHtml('en', { emDash: true }), // EN em-dash allowed
        'docs/manual.ru.html': manualHtml('ru', { emDash: true }),
      }),
    )
    expect(v.some((x) => x.rule === 'ru-em-dash' && x.file === 'docs/manual.ru.html')).toBe(true)
    expect(v.some((x) => x.rule === 'ru-em-dash' && x.file === 'docs/manual.en.html')).toBe(false)
  })
})

describe('doc-audit.mjs — readme positioning audit', () => {
  it('Test 4: every analog + the per-language WEDGE must appear in the region', () => {
    const clean = fakeReader({
      'README.md': readmeMd('en'),
      'README.ru.md': readmeMd('ru'),
    })
    expect(auditReadme(clean).length).toBe(0)

    const bad = fakeReader({
      'README.md': readmeMd('en', { dropAnalog: 'ccusage' }),
      'README.ru.md': readmeMd('ru', { noWedge: true }),
    })
    const v = auditReadme(bad)
    expect(v.some((x) => x.rule === 'analog-missing' && x.detail === 'ccusage')).toBe(true)
    expect(v.some((x) => x.rule === 'wedge-missing' && x.file === 'README.ru.md')).toBe(true)
  })

  it('Test 5: a multiplier is a violation INSIDE the region, allowed OUTSIDE it', () => {
    // "10x" lives outside the region in the base fixture -> clean
    expect(auditReadme(fakeReader({ 'README.md': readmeMd('en'), 'README.ru.md': readmeMd('ru') })).length).toBe(0)
    // the SAME "10x" placed inside the region -> a multiplier-claim violation
    const v = auditReadme(
      fakeReader({ 'README.md': readmeMd('en', { multiplier: '10x' }), 'README.ru.md': readmeMd('ru') }),
    )
    expect(v.some((x) => x.rule === 'multiplier-claim' && x.file === 'README.md')).toBe(true)
    // the regex itself matches Latin and Cyrillic suffixes, not hex
    expect(MULTIPLIER_RE.test('10x')).toBe(true)
    expect(MULTIPLIER_RE.test('2.5х')).toBe(true)
    expect(MULTIPLIER_RE.test('0x1A')).toBe(false)
  })

  it('Test 6b: an em-dash inside the RU positioning region is ru-em-dash; EN allowed', () => {
    const v = auditReadme(
      fakeReader({ 'README.md': readmeMd('en', { emDash: true }), 'README.ru.md': readmeMd('ru', { emDash: true }) }),
    )
    expect(v.some((x) => x.rule === 'ru-em-dash' && x.file === 'README.ru.md')).toBe(true)
    expect(v.some((x) => x.rule === 'ru-em-dash' && x.file === 'README.md')).toBe(false)
  })
})

describe('doc-audit.mjs — CLI contract', () => {
  it('Test 7: --count exits 0 with a bare integer last line; --json prints records + count', () => {
    // --count: always exit 0, bare number as the last line (scorer contract)
    const countOut = execFileSync('node', [REAL_CLI, 'doc-audit', '--count'], { cwd: ROOT, encoding: 'utf8' })
    const lastLine = countOut.trim().split('\n').pop() as string
    expect(lastLine).toMatch(/^\d+$/)

    // --json: parseable object with a violations array and a numeric count
    const jsonOut = execFileSync('node', [REAL_CLI, 'doc-audit', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim()
    const parsed = JSON.parse(jsonOut.split('\n').pop() as string)
    expect(Array.isArray(parsed.violations)).toBe(true)
    expect(typeof parsed.count).toBe('number')
  })
})
