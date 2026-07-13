/**
 * Tests for scripts/sma/lib/vendor-ledger.mjs (49.4-01 — the standing
 * Anthropic-update triage ledger linter).
 *
 * The load-bearing behaviors (plan 49.4-01 Task 1):
 *   Test 1 — parseLedger (tolerant reader): a missing file returns
 *            { rows: [], errors: [] } + a warning, never throws; a corrupt
 *            table line lands in errors while valid rows still parse.
 *   Test 2 — row shape: a valid row parses into
 *            { date, source, capability, runtime, verdict, disposition, triagedBy };
 *            runtime is api|claude-code; verdict is one of LEDGER_VERDICTS.
 *   Test 3 — lintLedger: an empty verdict OR empty disposition is VENDOR-UNTRIAGED
 *            (naming the row); an unknown verdict token is VENDOR-SCHEMA.
 *   Test 4 — countUntriaged: 2 untriaged rows -> 2; a fully-triaged ledger -> 0.
 *   Test 5 — selftest: the inline fixture pair (untriaged MUST fail lint,
 *            triaged MUST pass) returns 1; sabotaging either half returns 0.
 *
 * Zero fs writes — every fixture is an inline string injected via readFile.
 */

import { describe, it, expect } from 'vitest'
import {
  LEDGER_VERDICTS,
  parseLedger,
  lintLedger,
  countUntriaged,
  selftest,
} from '../lib/vendor-ledger.mjs'

/** Build a `## Ledger` markdown fixture from an array of 7-cell row arrays. */
function ledgerFixture(rows) {
  const header = '| date | source | capability | runtime | verdict | disposition | triaged-by |'
  const sep = '|---|---|---|---|---|---|---|'
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n')
  return ['# Vendor ledger', '', '## Ledger', '', header, sep, body, ''].join('\n')
}

/** parseLedger over an inline string (no fs). */
function parseText(text) {
  return parseLedger({ ledgerPath: 'FIXTURE', readFile: () => text })
}

const OK_ROW = ['2026-07-10', 'S1 multi-agent', 'hub-and-spoke, 20 agents', 'api', 'IRRELEVANT', 'none', '49.4 research']

describe('vendor-ledger — LEDGER_VERDICTS', () => {
  it('is the frozen §3.4 vocabulary, byte-exact', () => {
    expect(LEDGER_VERDICTS).toEqual([
      'CORE-threat',
      'BRIDGE-candidate',
      'ABSORB',
      'IRRELEVANT',
      'WATCH',
    ])
    expect(Object.isFrozen(LEDGER_VERDICTS)).toBe(true)
  })
})

describe('vendor-ledger — Test 1: tolerant parse', () => {
  it('a missing file returns empty rows + a warning, never throws', () => {
    const res = parseLedger({
      ledgerPath: 'DOES-NOT-EXIST',
      readFile: () => {
        throw new Error('ENOENT')
      },
    })
    expect(res.rows).toEqual([])
    expect(res.errors).toEqual([])
    expect(res.warnings.length).toBeGreaterThan(0)
  })

  it('a corrupt table line lands in errors while valid rows still parse', () => {
    const text = [
      '## Ledger',
      '',
      '| date | source | capability | runtime | verdict | disposition | triaged-by |',
      '|---|---|---|---|---|---|---|',
      `| ${OK_ROW.join(' | ')} |`,
      '| 2026-07-10 | too | few | cells |', // 4 cells — corrupt
      `| 2026-07-11 | S2 cookbook | plan-big | api | ABSORB | none | 49.4 research |`,
      '',
    ].join('\n')
    const res = parseText(text)
    expect(res.rows.length).toBe(2)
    expect(res.errors.length).toBe(1)
  })

  it('a ledger with no ## Ledger section is a warning, not a throw', () => {
    const res = parseText('# Just a header\n\nsome prose, no table\n')
    expect(res.rows).toEqual([])
    expect(res.warnings.length).toBeGreaterThan(0)
  })
})

describe('vendor-ledger — Test 2: row shape', () => {
  it('a valid row parses into the seven named fields', () => {
    const res = parseText(ledgerFixture([OK_ROW]))
    expect(res.rows.length).toBe(1)
    const row = res.rows[0]
    expect(row.date).toBe('2026-07-10')
    expect(row.source).toBe('S1 multi-agent')
    expect(row.capability).toBe('hub-and-spoke, 20 agents')
    expect(row.runtime).toBe('api')
    expect(row.verdict).toBe('IRRELEVANT')
    expect(row.disposition).toBe('none')
    expect(row.triagedBy).toBe('49.4 research')
  })

  it('the header + separator rows are not parsed as data', () => {
    const res = parseText(ledgerFixture([OK_ROW, OK_ROW]))
    expect(res.rows.length).toBe(2)
  })
})

describe('vendor-ledger — Test 3: lint', () => {
  it('an empty verdict is VENDOR-UNTRIAGED naming the row', () => {
    const row = ['2026-07-10', 'S9 sighting', 'a new thing', 'api', '', 'none', 'me']
    const { rows } = parseText(ledgerFixture([row]))
    const { ok, violations } = lintLedger(rows)
    expect(ok).toBe(false)
    const v = violations.find((x) => x.rule === 'VENDOR-UNTRIAGED' && x.field === 'verdict')
    expect(v).toBeTruthy()
    expect(v.message).toContain('S9 sighting')
  })

  it('an empty disposition is VENDOR-UNTRIAGED', () => {
    const row = ['2026-07-10', 'S9 sighting', 'a new thing', 'api', 'WATCH', '', 'me']
    const { rows } = parseText(ledgerFixture([row]))
    const { ok, violations } = lintLedger(rows)
    expect(ok).toBe(false)
    expect(violations.some((x) => x.rule === 'VENDOR-UNTRIAGED' && x.field === 'disposition')).toBe(true)
  })

  it('an unknown verdict token is VENDOR-SCHEMA', () => {
    const row = ['2026-07-10', 'S9 sighting', 'a new thing', 'api', 'MAYBE', 'none', 'me']
    const { rows } = parseText(ledgerFixture([row]))
    const { ok, violations } = lintLedger(rows)
    expect(ok).toBe(false)
    expect(violations.some((x) => x.rule === 'VENDOR-SCHEMA' && x.field === 'verdict')).toBe(true)
  })

  it('a bad runtime is VENDOR-SCHEMA', () => {
    const row = ['2026-07-10', 'S9 sighting', 'a new thing', 'browser', 'WATCH', 'none', 'me']
    const { rows } = parseText(ledgerFixture([row]))
    const { violations } = lintLedger(rows)
    expect(violations.some((x) => x.rule === 'VENDOR-SCHEMA' && x.field === 'runtime')).toBe(true)
  })

  it('a fully-triaged ledger lints clean', () => {
    const { rows } = parseText(ledgerFixture([OK_ROW]))
    expect(lintLedger(rows).ok).toBe(true)
  })
})

describe('vendor-ledger — Test 4: count', () => {
  it('counts 2 untriaged rows', () => {
    const rows = [
      ['2026-07-10', 'S1', 'x', 'api', '', 'none', 'me'], // missing verdict
      ['2026-07-10', 'S2', 'y', 'api', 'WATCH', '', 'me'], // missing disposition
      OK_ROW, // triaged
    ]
    const { rows: parsed } = parseText(ledgerFixture(rows))
    expect(countUntriaged(parsed)).toBe(2)
  })

  it('a fully-triaged ledger counts 0', () => {
    const { rows } = parseText(ledgerFixture([OK_ROW, OK_ROW]))
    expect(countUntriaged(rows)).toBe(0)
  })
})

describe('vendor-ledger — Test 5: selftest', () => {
  it('the honest inline fixture pair returns 1', () => {
    expect(selftest()).toBe(1)
  })

  it('sabotaging the untriaged half (make it fully triaged) returns 0', () => {
    const triaged = ledgerFixture([OK_ROW])
    expect(selftest({ untriagedText: triaged, triagedText: triaged })).toBe(0)
  })

  it('sabotaging the triaged half (inject an untriaged row) returns 0', () => {
    const untriaged = ledgerFixture([['2026-07-10', 'S1', 'x', 'api', '', 'none', 'me']])
    expect(selftest({ untriagedText: untriaged, triagedText: untriaged })).toBe(0)
  })
})
