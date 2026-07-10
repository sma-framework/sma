/**
 * Tests for the weekly miss-curriculum — Phase 49.3 Plan 06, Task 2 (D-49.3-16).
 *
 *   - Test 1 (deterministic clustering): clusterMisses groups calibration misses by
 *     domain + journal incidents / ignored-broke fires by targetClass prefix, ranks
 *     count desc with alphabetical tie-break, caps at 7; deep-equal on re-run.
 *   - Test 2 (templates): predictionTemplates yields one template per >=2-member
 *     cluster with an allowlist-shaped-or-empty check_command; a same-week re-run
 *     appends ZERO duplicate ids.
 *   - Test 3 (brief): weakSpotsBrief writes exactly the five sections, <= 4096 bytes,
 *     byte-identical on re-render (zero LLM, zero hidden clock).
 *   - Test 4 (staleness): latestBrief flags stale when the newest brief is > 7 days
 *     old or none exists.
 *   - Test 5 (tolerance): corrupt JSONL lines are skipped; an empty dir is honest-empty.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clusterMisses, predictionTemplates, weakSpotsBrief, latestBrief } from '../lib/curriculum.mjs'

function tmp(p) {
  return mkdtempSync(join(tmpdir(), p))
}

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-07-08T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const WEEK = { year: 2026, week: 28 }

function incident({ scope, at, seq = 1, terminal = 't1', type = 'incident' }) {
  return { ts: iso(at), terminal, seq, type, actors: [terminal], scope, detail: {} }
}

function fixtureLedgers() {
  return [
    { domain: 'sma.enforcement', verdict: 'miss', scoredAt: iso(NOW - 2 * DAY), check_command: 'node scripts/sma/cli.mjs ladder --count-autofix' },
    { domain: 'sma.enforcement', verdict: 'miss', scoredAt: iso(NOW - 3 * DAY), check_command: 'node scripts/sma/cli.mjs ladder --count-autofix' },
    { domain: 'sma.memory', verdict: 'miss', scoredAt: iso(NOW - 1 * DAY) },
    { domain: 'sma.enforcement', verdict: 'hit', scoredAt: iso(NOW - 1 * DAY) },
  ]
}
function fixtureEvents() {
  return [
    incident({ scope: 'src/crm/foo.ts', at: NOW - 2 * DAY, seq: 1 }),
    incident({ scope: 'src/crm/bar.ts', at: NOW - 3 * DAY, seq: 2 }),
  ]
}
function fixtureClassified() {
  return [
    { ruleId: 'R-A', kind: 'reflex', targetClass: 'src/crm', scope: 'src/crm/baz.ts', ref: 't1#9', ts: iso(NOW - 4 * DAY), classification: 'ignored-broke' },
  ]
}

describe('curriculum — deterministic clustering + prediction templates + weak-spots brief', () => {
  it('Test 1: clusterMisses is deterministic and ranks by count', () => {
    const args = { ledgers: fixtureLedgers(), events: fixtureEvents(), classified: fixtureClassified(), windowMs: 30 * DAY, now: NOW }
    const c1 = clusterMisses(args)
    const c2 = clusterMisses(args)
    expect(c1).toEqual(c2)
    expect(c1.length).toBeLessThanOrEqual(7)
    // src/crm has 3 (2 incidents + 1 ignored-broke fire), sma.enforcement has 2 misses.
    expect(c1[0].key).toBe('src/crm')
    expect(c1[0].count).toBe(3)
    const enf = c1.find((c) => c.key === 'sma.enforcement')
    expect(enf.count).toBe(2)
    expect(enf.checkCommand).toBe('node scripts/sma/cli.mjs ladder --count-autofix')
  })

  it('Test 2: predictionTemplates — one per >=2 cluster, idempotent per ISO week', () => {
    const dir = tmp('curr-tpl-')
    const dirs = { curriculumDir: join(dir, 'curriculum') }
    const clusters = clusterMisses({ ledgers: fixtureLedgers(), events: fixtureEvents(), classified: fixtureClassified(), windowMs: 30 * DAY, now: NOW })

    const t1 = predictionTemplates({ clusters, week: WEEK, dirs })
    expect(t1.find((t) => t.id === 'TPL-sma.enforcement-2026W28')).toBeTruthy()
    // the sma.memory cluster has only 1 member -> no template
    expect(t1.find((t) => t.domain === 'sma.memory')).toBeUndefined()
    // check_command copied when allowlist-shaped
    const enfTpl = t1.find((t) => t.domain === 'sma.enforcement')
    expect(enfTpl.check_command).toBe('node scripts/sma/cli.mjs ladder --count-autofix')
    expect(enfTpl.threshold).toBeNull()

    predictionTemplates({ clusters, week: WEEK, dirs }) // same ISO week — must add no dup ids
    const lines = readFileSync(join(dirs.curriculumDir, 'templates.jsonl'), 'utf8').split('\n').filter((l) => l.trim())
    const ids = lines.map((l) => JSON.parse(l).id)
    expect(ids.length).toBe(new Set(ids).size)
  })

  it('Test 3: weakSpotsBrief — exactly five sections, <= 4096 bytes, byte-identical on re-render', () => {
    const dir = tmp('curr-brief-')
    const dirs = { curriculumDir: join(dir, 'curriculum') }
    const clusters = clusterMisses({ ledgers: fixtureLedgers(), events: fixtureEvents(), classified: fixtureClassified(), windowMs: 30 * DAY, now: NOW })
    const templates = predictionTemplates({ clusters, week: WEEK, dirs })
    const proposals = [
      { ruleId: 'R-NOISE', kind: 'reflex', from: 'warn', to: 'note', refused: false, reason: 'measured zero benefit' },
      { ruleId: 'GATE-PUSH', kind: 'gate', from: 'warn', to: 'soft-deny', refused: false, reason: 'measured ignored-broke' },
    ]
    const r1 = weakSpotsBrief({ clusters, proposals, templates, week: WEEK, dirs })
    expect(existsSync(r1.path)).toBe(true)
    expect(r1.bytes).toBeLessThanOrEqual(4096)
    const disk = readFileSync(r1.path, 'utf8')
    for (const h of ['## Top miss clusters', '## Noise demoted', '## Rules rising', '## New prediction templates', '## Ask at the next discuss']) {
      expect(disk).toContain(h)
    }
    const r2 = weakSpotsBrief({ clusters, proposals, templates, week: WEEK, dirs })
    expect(Buffer.from(r1.text, 'utf8').equals(Buffer.from(r2.text, 'utf8'))).toBe(true)
  })

  it('Test 4: latestBrief flags staleness', () => {
    const emptyDirs = { curriculumDir: join(tmp('curr-stale-'), 'curriculum') }
    expect(latestBrief({ dirs: emptyDirs, now: NOW }).stale).toBe(true)

    const dir = tmp('curr-fresh-')
    const dirs = { curriculumDir: join(dir, 'curriculum') }
    const clusters = clusterMisses({ ledgers: fixtureLedgers(), events: [], classified: [], windowMs: 30 * DAY, now: NOW })
    weakSpotsBrief({ clusters, proposals: [], templates: [], week: WEEK, dirs })
    const fresh = latestBrief({ dirs, now: Date.now() })
    expect(fresh.stale).toBe(false)
    expect(fresh.path).toBeTruthy()
  })

  it('Test 5: tolerant of corrupt JSONL and honest-empty on empty inputs', () => {
    const dir = tmp('curr-tol-')
    const dirs = { curriculumDir: join(dir, 'curriculum') }
    mkdirSync(dirs.curriculumDir, { recursive: true })
    writeFileSync(join(dirs.curriculumDir, 'templates.jsonl'), 'not json\n{"id":"TPL-x-2026W28"}\n')
    const t = predictionTemplates({ clusters: [], week: WEEK, dirs })
    expect(Array.isArray(t)).toBe(true)

    expect(clusterMisses({ ledgers: [], events: [], classified: [], now: NOW })).toEqual([])
  })
})
