/**
 * Tests for the weekly miss-curriculum.
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
 *   - Test 6/7 (the schedule as a decision): a stale brief calls the builder ONCE, a
 *     fresh one never calls it, and a builder that throws or overruns is reported.
 *   - Test 8/9 (the schedule as a WIRE): the real session-start process rebuilds a
 *     stale brief, leaves a fresh one alone, and both it and the verb name the state
 *     dir the data was read from.
 *   - Test 10 (the word): a brief assembled from misses calls them misses, never the
 *     opposite word.
 *   - Test 11/12 (a usable template): what the brief proposes passes the SAME field
 *     validation every prediction entry passes, and its threshold is the measured base.
 *   - Test 13 (re-verification territory): a structural-receipt cluster is never dressed
 *     up as a prediction template, and is still named in the brief in words.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { clusterMisses, predictionTemplates, weakSpotsBrief, latestBrief, refreshIfStale, isoWeek } from '../lib/curriculum.mjs'
import { validatePrediction } from '../lib/predict.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs')

/** Spawn the REAL cli against a per-test temp state root — the wire, not a stand-in. */
function runCli(args: string[], opts: { root: string; stdin?: string }): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      input: opts.stdin ?? '',
      encoding: 'utf8',
      env: { ...process.env, SMA_ROOT_OVERRIDE: join(opts.root, '.sma') },
    })
    return { stdout, status: 0 }
  } catch (err: any) {
    return { stdout: (err.stdout ?? '').toString(), status: typeof err.status === 'number' ? err.status : 1 }
  }
}

/** The additionalContext the session-start hook printed (empty when it printed nothing). */
function contextOf(stdout: string): string {
  const line = stdout.trim().split('\n').find((l) => l.trim().startsWith('{'))
  if (!line) return ''
  return (JSON.parse(line) as any).hookSpecificOutput.additionalContext as string
}

/** The brief file name of the ISO week that is current right now. */
function briefNameNow(): string {
  const w = isoWeek(Date.now())
  return `brief-${w.year}-W${String(w.week).padStart(2, '0')}.md`
}

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

describe('curriculum — the weekly brief builds itself when it goes stale', () => {
  it('Test 6: a stale brief calls the builder ONCE; a fresh brief never calls it', async () => {
    // stale — an empty dir has no brief at all, which is the staleness of never-built
    const staleDirs = { curriculumDir: join(tmp('curr-refresh-stale-'), 'curriculum') }
    let calls = 0
    const built = await refreshIfStale({
      dirs: staleDirs,
      now: Date.now(),
      build: async () => {
        calls += 1
        return { brief: { path: '/somewhere/brief-2026-W28.md' }, clusters: [{ key: 'a' }, { key: 'b' }] }
      },
    })
    expect(calls).toBe(1)
    expect(built.stale).toBe(true)
    expect(built.built).toBe(true)
    expect(built.clusters).toBe(2)
    expect(built.path).toBe('/somewhere/brief-2026-W28.md')

    // fresh — written just now, so nothing at all must happen
    const freshDirs = { curriculumDir: join(tmp('curr-refresh-fresh-'), 'curriculum') }
    weakSpotsBrief({ clusters: [], proposals: [], templates: [], week: WEEK, dirs: freshDirs })
    const briefPath = join(freshDirs.curriculumDir, 'brief-2026-W28.md')
    const before = statSync(briefPath).mtimeMs
    let freshCalls = 0
    const untouched = await refreshIfStale({
      dirs: freshDirs,
      now: Date.now(),
      build: async () => {
        freshCalls += 1
        return {}
      },
    })
    expect(freshCalls).toBe(0)
    expect(untouched.stale).toBe(false)
    expect(untouched.built).toBe(false)
    expect(statSync(briefPath).mtimeMs).toBe(before)
  })

  it('Test 7: a builder that throws or overruns its budget is reported, never rethrown', async () => {
    const dirs = { curriculumDir: join(tmp('curr-refresh-open-'), 'curriculum') }

    const threw = await refreshIfStale({
      dirs,
      now: Date.now(),
      build: async () => {
        throw new Error('the ledger is unreadable')
      },
    })
    expect(threw.built).toBe(false)
    expect(threw.stale).toBe(true)
    expect(String(threw.error)).toContain('the ledger is unreadable')

    const hung = await refreshIfStale({ dirs, now: Date.now(), timeoutMs: 20, build: () => new Promise(() => {}) })
    expect(hung.built).toBe(false)
    expect(String(hung.error)).toMatch(/budget/i)
  })

  it('Test 8: session-start REBUILDS a stale brief, names the state dir, and leaves a fresh one alone', () => {
    const root = tmp('curr-session-')
    const curriculumDir = join(root, '.sma', 'curriculum')
    mkdirSync(curriculumDir, { recursive: true })
    const briefPath = join(curriculumDir, briefNameNow())
    writeFileSync(briefPath, '# a brief nobody refreshed\n')
    const old = new Date(Date.now() - 30 * DAY)
    utimesSync(briefPath, old, old)
    expect(latestBrief({ dirs: { curriculumDir }, now: Date.now() }).stale).toBe(true)

    const first = runCli(['session-start'], { root, stdin: JSON.stringify({ session_id: 'sess-curriculum', source: 'startup' }) })
    expect(first.status).toBe(0)
    const ctx = contextOf(first.stdout)
    expect(ctx).toContain('собрана') // a fact, not a nudge
    expect(ctx).toContain(`каталог состояния: ${join(root, '.sma')}`) // the tree the data was read from
    const rebuiltAt = statSync(briefPath).mtimeMs
    expect(Date.now() - rebuiltAt).toBeLessThan(5 * 60 * 1000)
    expect(latestBrief({ dirs: { curriculumDir }, now: Date.now() }).stale).toBe(false)

    // the negative half — the next session finds it fresh and does not touch it
    const second = runCli(['session-start'], { root, stdin: JSON.stringify({ session_id: 'sess-curriculum-2', source: 'startup' }) })
    expect(second.status).toBe(0)
    expect(statSync(briefPath).mtimeMs).toBe(rebuiltAt)
  })

  it('Test 9: the curriculum verb names the state dir it read from; --latest stays a bare path', () => {
    const root = tmp('curr-verb-')
    mkdirSync(join(root, '.sma'), { recursive: true })
    const r = runCli(['curriculum'], { root })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`state dir: ${join(root, '.sma')}`)

    // --latest is a machine surface: a receipt pipes it straight into a file test,
    // so the state dir belongs in the human output and in --json, never on this line.
    const latest = runCli(['curriculum', '--latest'], { root })
    expect(latest.status).toBe(0)
    const lastLine = latest.stdout.trim().split('\n').pop() as string
    expect(lastLine).toContain('brief-')
    expect(existsSync(lastLine.replace(' (STALE)', ''))).toBe(true)
  })
})

/** Misses recorded against the structural-receipt domain — re-verification territory. */
function fixtureReceiptLedgers() {
  return [
    { domain: 'sma.receipts', verdict: 'miss', scoredAt: iso(NOW - 1 * DAY), check_command: 'node scripts/sma/cli.mjs airbag list --schema-check' },
    { domain: 'sma.receipts', verdict: 'miss', scoredAt: iso(NOW - 2 * DAY), check_command: 'node scripts/sma/cli.mjs airbag list --schema-check' },
    { domain: 'sma.receipts', verdict: 'miss', scoredAt: iso(NOW - 3 * DAY), check_command: 'node scripts/sma/cli.mjs airbag list --schema-check' },
  ]
}

describe('curriculum — the brief tells the truth about misses and proposes a usable template', () => {
  it('Test 10: a brief assembled from misses calls them misses, never the opposite word', () => {
    const dirs = { curriculumDir: join(tmp('curr-word-'), 'curriculum') }
    const clusters = clusterMisses({ ledgers: fixtureLedgers(), events: fixtureEvents(), classified: fixtureClassified(), windowMs: 30 * DAY, now: NOW })
    const templates = predictionTemplates({ clusters, week: WEEK, dirs })
    const r = weakSpotsBrief({ clusters, proposals: [], templates, week: WEEK, dirs })

    expect(r.text).toContain('misses')
    // the whole document is about being honest about misses; it cannot call them hits
    expect(r.text).not.toContain('hits')
    expect(r.text).not.toContain(' hit')
  })

  it('Test 11: what the brief proposes passes the same field validation a prediction passes', () => {
    const dirs = { curriculumDir: join(tmp('curr-valid-'), 'curriculum') }
    const clusters = clusterMisses({ ledgers: fixtureLedgers(), events: [], classified: [], windowMs: 30 * DAY, now: NOW })
    const templates = predictionTemplates({ clusters, week: WEEK, dirs })
    expect(templates.length).toBeGreaterThan(0)
    for (const t of templates) {
      const v = validatePrediction(t)
      expect({ id: t.id, missing: v.missing, errors: v.errors }).toEqual({ id: t.id, missing: [], errors: [] })
      expect(v.valid).toBe(true)
    }
  })

  it('Test 12: the threshold is the measured base of the cluster, not an invented number', () => {
    const dirs = { curriculumDir: join(tmp('curr-threshold-'), 'curriculum') }
    const clusters = clusterMisses({ ledgers: fixtureLedgers(), events: [], classified: [], windowMs: 30 * DAY, now: NOW })
    const templates = predictionTemplates({ clusters, week: WEEK, dirs })
    for (const t of templates) {
      const cluster = clusters.find((c) => c.key === t.domain)
      expect(t.threshold).toBe(cluster.count)
      expect(t.comparator).toBe('>=')
    }
  })

  it('Test 13: a structural-receipt cluster is named in words and never dressed up as a template', () => {
    const dirs = { curriculumDir: join(tmp('curr-reverify-'), 'curriculum') }
    const clusters = clusterMisses({ ledgers: fixtureReceiptLedgers(), events: fixtureEvents(), classified: [], windowMs: 30 * DAY, now: NOW })
    const receipts = clusters.find((c) => c.key === 'sma.receipts')
    expect(receipts.count).toBe(3)

    const templates = predictionTemplates({ clusters, week: WEEK, dirs })
    // the scorer never scores a receipt claim, so proposing one to the planner would be
    // proposing something that cannot receive a verdict
    expect(templates.find((t) => t.domain === 'sma.receipts')).toBeUndefined()
    // and the incident cluster has no allowlisted command, so it cannot be run unedited
    expect(templates.find((t) => t.domain === 'src/crm')).toBeUndefined()

    const r = weakSpotsBrief({ clusters, proposals: [], templates, week: WEEK, dirs })
    // the knowledge is kept — in words, with the instrument that closes it
    expect(r.text).toContain('sma.receipts')
    expect(r.text).toContain('reverify')
    expect(r.text).not.toContain('TPL-sma.receipts')
    expect(r.text).toContain('src/crm')
  })
})
