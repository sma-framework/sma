/**
 * Tests for scripts/sma/lib/manifest.mjs + the `sma manifest` CLI + the
 * sma-manifest CI workflow (Phase 9.3 Plan 08 — D-9.3-11, D-9.3-02).
 *
 * The PR EVIDENCE PASSPORT: a deterministic, reader-only assembler over the
 * Track A trust-spine outputs. It computes ZERO new verdicts — every number is
 * READ from a calibration-ledger record, a frozen blind file, or the spend book.
 *
 *   - Test 1 (determinism): two builds over identical state + pinned now are
 *     byte-identical in JSON and markdown.
 *   - Test 2 (reader-only, structural): no runner/network seam anywhere; a ledger
 *     of one hit/one miss/one divergence is reproduced verbatim.
 *   - Test 3 (the ROADMAP contract): all five evidence sections present.
 *   - Test 4 (honest empty): missing inputs render absent/unscored/not-run; nothing throws.
 *   - Test 5 (selectPlans): path-in-diff / summary-sibling / files_modified intersection.
 *   - Test 6 (allowlist discipline): the spend block is the explicit-pick set, topModels<=5.
 *   - Test 7 (marker + coverage): markdown line 1 is the marker; coverage detects loss.
 *   - Tests 8-10 (CLI): --json/--md artifacts; --stat numeric last line; honest empty.
 *   - Tests 11-12 (workflow-as-text): the CI posture is regression-locked as text.
 *   - Tests 13-16 (--dense): the compact agent-readable render — determinism, a
 *     fixed line per section (empty sections MARKED, never dropped), verbatim
 *     numbers, zero markdown.
 *   - Test 17 (CLI --dense): exit 0, the fixed shape, and --json unchanged when
 *     both flags are passed (the two renders never mix).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import {
  MANIFEST_VERSION,
  MANIFEST_MARKER,
  MANIFEST_DENSE_LINES,
  selectPlans,
  collectEvidence,
  buildManifest,
  renderManifestMarkdown,
  renderManifestDense,
  manifestStats,
} from '../lib/manifest.mjs'

const HEX = 'a'.repeat(64)
const HEX2 = 'b'.repeat(64)
const NOW = '2026-07-10T12:00:00.000Z'

let root: string

function writeFixture() {
  const plansDir = join(root, 'plans')
  const smaDir = join(root, '.sma')
  const calibrationDir = join(smaDir, 'calibration')
  const blindDir = join(smaDir, 'blind')
  mkdirSync(plansDir, { recursive: true })
  mkdirSync(calibrationDir, { recursive: true })
  mkdirSync(blindDir, { recursive: true })

  // Plan A — 3 predictions (hit/miss/unscored), 2 receipts (verified/divergent), a blind file.
  const planA = join(plansDir, '9.3-AA-PLAN.md')
  writeFileSync(
    planA,
    `---
phase: 9.3-test
plan: AA
predictions:
  - id: P-HIT
    claim: the hit claim
    metric: m
    check_command: node scripts/sma/cli.mjs manifest --stat prediction-coverage
    comparator: "=="
    threshold: 1
    horizon: h
    domain: sma.demoA
  - id: P-MISS
    claim: the miss claim
    metric: m
    check_command: node scripts/sma/cli.mjs manifest --stat prediction-coverage
    comparator: "=="
    threshold: 1
    horizon: h
    domain: sma.demoB
  - id: P-UNSCORED
    claim: the unscored claim
    metric: m
    check_command: node scripts/sma/cli.mjs manifest --stat prediction-coverage
    comparator: "=="
    threshold: 1
    horizon: h
    domain: sma.demoC
---
body
`,
  )
  writeFileSync(
    join(plansDir, '9.3-AA-SUMMARY.md'),
    `---
receipts:
  - id: R-VER
    assertion: the verified receipt
    check_command: node scripts/sma/cli.mjs manifest --md
    expected_sha256: ${HEX}
  - id: R-DIV
    assertion: the divergent receipt
    check_command: node scripts/sma/cli.mjs manifest --md
    expected_sha256: ${HEX}
---
body
`,
  )
  // Plan B — no predictions, no summary, no blind file (a not-run blind entry).
  const planB = join(plansDir, '9.3-BB-PLAN.md')
  writeFileSync(planB, `---\nphase: 9.3-test\nplan: BB\n---\nbody\n`)

  // Calibration ledger (real JSONL files per domain).
  writeFileSync(
    join(calibrationDir, 'sma.demoA.jsonl'),
    JSON.stringify({ id: 'P-HIT', verdict: 'hit', domain: 'sma.demoA', actual: 1, scoredAt: '2026-07-09T00:00:00.000Z' }) + '\n',
  )
  writeFileSync(
    join(calibrationDir, 'sma.demoB.jsonl'),
    JSON.stringify({ id: 'P-MISS', verdict: 'miss', domain: 'sma.demoB', actual: 0, scoredAt: '2026-07-09T00:00:00.000Z' }) + '\n',
  )
  writeFileSync(
    join(calibrationDir, 'sma.receipts.jsonl'),
    JSON.stringify({ id: 'R-VER', verdict: 'hit', receipt_verdict: 'verified', domain: 'sma.receipts', expected_sha256: HEX, observed_sha256: HEX, scoredAt: '2026-07-09T00:00:00.000Z' }) +
      '\n' +
      JSON.stringify({ id: 'R-DIV', verdict: 'miss', receipt_verdict: 'divergent', domain: 'sma.receipts', expected_sha256: HEX, observed_sha256: HEX2, scoredAt: '2026-07-09T00:00:00.000Z' }) +
      '\n',
  )
  writeFileSync(
    join(calibrationDir, 'sma.verification.jsonl'),
    JSON.stringify({ kind: 'divergence', verdict: 'divergence', id: 'P-HIT', planId: '9.3-AA', plan: '9.3-AA', domain: 'sma.verification', at: '2026-07-09T00:00:00.000Z', scoredAt: '2026-07-09T00:00:00.000Z' }) + '\n',
  )
  // Frozen blind verdicts for plan A only.
  writeFileSync(
    join(blindDir, '9.3-AA.json'),
    JSON.stringify({ planId: '9.3-AA', frozenAt: NOW, verdicts: [{ id: 'x', verdict: 'pass' }, { id: 'y', verdict: 'fail' }] }),
  )

  const dirs = { calibrationDir, blindDir }
  const plans = [
    { planId: '9.3-AA', path: planA, files_modified: ['../sma/lib/manifest.mjs'], predictionDomains: ['sma.demoA', 'sma.demoB', 'sma.demoC'] },
    { planId: '9.3-BB', path: planB, files_modified: ['x/y.ts'], predictionDomains: [] },
  ]
  const spendBook = {
    byModel: { 'claude-opus': { usd: 3, events: 2 }, 'claude-sonnet': { usd: 1, events: 5 } },
    events: [{ ts: '2026-07-10T11:30:00.000Z', usd: 4, model: 'claude-opus' }],
    pricingVersion: 'pv-1',
  }
  const spendBudget = { capUsd: 20, windowHours: 5 }
  return { dirs, plans, spendBook, spendBudget }
}

function buildFrom(fx: ReturnType<typeof writeFixture>) {
  const evidence = collectEvidence({ plans: fx.plans, dirs: fx.dirs })
  return buildManifest({
    range: 'origin/main..HEAD',
    headSha: 'deadbeefcafe1234',
    plans: fx.plans,
    evidence,
    spendBook: fx.spendBook,
    spendBudget: fx.spendBudget,
    chainTip: 'feedface00112233',
    staleness: 'ok',
    now: NOW,
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sma-manifest-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('manifest.mjs — the reader-only PR evidence passport', () => {
  it('Test 1 (determinism): two builds over identical state + pinned now are byte-identical', () => {
    const fx = writeFixture()
    const a = buildFrom(fx)
    const b = buildFrom(fx)
    expect(JSON.stringify(a, null, 2)).toBe(JSON.stringify(b, null, 2))
    expect(renderManifestMarkdown(a)).toBe(renderManifestMarkdown(b))
  })

  it('Test 2 (reader-only, structural): no runner/network seam; verdicts reproduced verbatim', () => {
    // Structural: the module source imports no exec/network seam.
    const libSrc = readFileSync(new URL('../lib/manifest.mjs', import.meta.url), 'utf8')
    expect(libSrc).not.toMatch(/child_process|node:http|node:https|execSync|execFile|fetch\(/)
    // No exported function takes a runner/runCommand parameter.
    for (const fn of [selectPlans, collectEvidence, buildManifest, renderManifestMarkdown, manifestStats]) {
      expect(fn.toString()).not.toMatch(/runCommand|runner|execGit/)
    }
    // Verbatim reproduction: one hit, one miss, one divergence.
    const fx = writeFixture()
    const m = buildFrom(fx)
    const byId = Object.fromEntries(m.predictions.map((p: any) => [p.id, p.verdict]))
    expect(byId['P-HIT']).toBe('hit')
    expect(byId['P-MISS']).toBe('miss')
    expect(byId['P-UNSCORED']).toBe('unscored')
    expect(m.blind.divergences).toBe(1)
  })

  it('Test 3 (the ROADMAP contract): all five evidence sections present', () => {
    const fx = writeFixture()
    const m = buildFrom(fx)
    // 1. predictions with per-id verdicts.
    expect(m.predictions).toHaveLength(3)
    // 2. receipts with expected/observed hashes.
    const rver = m.receipts.find((r: any) => r.id === 'R-VER')
    const rdiv = m.receipts.find((r: any) => r.id === 'R-DIV')
    expect(rver.verdict).toBe('verified')
    expect(rver.hashMatch).toBe(true)
    expect(rdiv.verdict).toBe('divergent')
    expect(rdiv.hashMatch).toBe(false)
    // 3. blind verdict counts + divergence count.
    const blindA = m.blind.plans.find((b: any) => b.plan === '9.3-AA')
    const blindB = m.blind.plans.find((b: any) => b.plan === '9.3-BB')
    expect(blindA.counts).toEqual({ pass: 1, fail: 1 })
    expect(blindB.status).toBe('not-run')
    expect(m.blind.divergences).toBe(1)
    // 4. the spend aggregate block.
    expect(m.spend.windowUsd).toBe(4)
    // 5. the per-domain hitRate table (includes both prediction domains with records).
    const domains = m.calibration.map((c: any) => c.domain)
    expect(domains).toContain('sma.demoA')
    expect(domains).toContain('sma.demoB')
    // footer.
    expect(m.chainTip).toBe('feedface00112233')
    expect(m.staleness).toBe('ok')
    // open class-A: the divergence + the sma.receipts miss (R-DIV) — both trust-domain class-A.
    expect(m.consequences.openClassA).toBe(2)
  })

  it('Test 4 (honest empty): missing inputs render absent/unscored/not-run; nothing throws', () => {
    const plansDir = join(root, 'plans')
    mkdirSync(plansDir, { recursive: true })
    const planA = join(plansDir, '9.3-ZZ-PLAN.md')
    writeFileSync(
      planA,
      `---\nphase: 9.3-test\nplan: ZZ\npredictions:\n  - id: P-1\n    claim: c\n    metric: m\n    check_command: node scripts/sma/cli.mjs manifest --md\n    comparator: "=="\n    threshold: 1\n    horizon: h\n    domain: sma.empty\n---\nbody\n`,
    )
    const dirs = { calibrationDir: join(root, '.sma', 'calibration'), blindDir: join(root, '.sma', 'blind') }
    const plans = [{ planId: '9.3-ZZ', path: planA, files_modified: [], predictionDomains: ['sma.empty'] }]
    let m: any
    expect(() => {
      const evidence = collectEvidence({ plans, dirs })
      m = buildManifest({ plans, evidence, spendBook: null, chainTip: 'empty', staleness: 'unavailable', now: NOW })
    }).not.toThrow()
    expect(m.predictions[0].verdict).toBe('unscored')
    expect(m.blind.plans[0].status).toBe('not-run')
    expect(m.spend).toBe('absent')
    expect(m.staleness).toBe('unavailable')
    expect(m.calibration).toHaveLength(0) // empty ledger -> empty hit-rate table
  })

  it('Test 5 (selectPlans): path-in-diff / summary-sibling / files_modified intersection', () => {
    const index = [
      { planId: '9.3-AA', path: 'p/9.3-AA-PLAN.md', files_modified: ['src/a.ts'], predictionDomains: [] },
      { planId: '9.3-BB', path: 'p/9.3-BB-PLAN.md', files_modified: ['src/b.ts'], predictionDomains: [] },
      { planId: '9.3-CC', path: 'p/9.3-CC-PLAN.md', files_modified: ['src/deep/**'], predictionDomains: [] },
    ]
    // plan-path in diff
    expect(selectPlans({ changedFiles: ['p/9.3-AA-PLAN.md'], planIndex: index }).map((p) => p.planId)).toEqual(['9.3-AA'])
    // summary sibling in diff
    expect(selectPlans({ changedFiles: ['p/9.3-BB-SUMMARY.md'], planIndex: index }).map((p) => p.planId)).toEqual(['9.3-BB'])
    // files_modified intersection (exact + glob)
    expect(selectPlans({ changedFiles: ['src/a.ts', 'src/deep/x/y.ts'], planIndex: index }).map((p) => p.planId)).toEqual(['9.3-AA', '9.3-CC'])
    // dedup + deterministic order
    expect(selectPlans({ changedFiles: ['p/9.3-AA-PLAN.md', 'src/a.ts'], planIndex: index }).map((p) => p.planId)).toEqual(['9.3-AA'])
    // empty diff -> empty, never a throw
    expect(selectPlans({ changedFiles: [], planIndex: index })).toEqual([])
  })

  it('Test 6 (allowlist discipline): the spend block is the explicit-pick set, topModels<=5', () => {
    const bigBook = {
      byModel: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`model-${i}`, { usd: i + 1, events: 1 }])),
      events: [{ ts: '2026-07-10T11:30:00.000Z', usd: 10, model: 'model-7' }],
      pricingVersion: 'pv-2',
      // extra fields that MUST NOT leak into the public block:
      bySession: { 'secret-session-id': { usd: 99 } },
      logsDir: '/home/secret/path',
      counters: { recognized: 1 },
    }
    const m = buildManifest({
      plans: [],
      evidence: collectEvidence({ plans: [], dirs: { calibrationDir: join(root, 'nope'), blindDir: join(root, 'nope') } }),
      spendBook: bigBook,
      spendBudget: { capUsd: 50, windowHours: 5 },
      chainTip: 'empty',
      staleness: 'unavailable',
      now: NOW,
    })
    expect(Object.keys(m.spend).sort()).toEqual(['capUsd', 'pct', 'pricingVersion', 'topModels', 'windowUsd'])
    expect(m.spend.topModels).toHaveLength(5)
    // top-5 by usd desc: model-7..model-3
    expect(m.spend.topModels[0]).toEqual({ model: 'model-7', usd: 8 })
    // no leaked keys
    expect(JSON.stringify(m.spend)).not.toMatch(/secret-session-id|home\/secret|bySession|logsDir/)
  })

  it('Test 7 (marker + coverage): markdown line 1 is the marker; coverage detects loss', () => {
    const fx = writeFixture()
    const m = buildFrom(fx)
    const md = renderManifestMarkdown(m)
    expect(md.split('\n')[0]).toBe(MANIFEST_MARKER)
    expect(MANIFEST_VERSION).toBe(1)
    // full coverage over the honest build
    expect(manifestStats(m, 'prediction-coverage')).toBe(100)
    // hand-strip one prediction -> coverage drops below 100 (loss is detectable)
    const stripped = { ...m, predictions: m.predictions.slice(1) }
    expect(manifestStats(stripped, 'prediction-coverage')).toBeLessThan(100)
  })

  it('determinism property: a different generatedAt yields a different markdown (nondeterminism is detectable)', () => {
    const fx = writeFixture()
    const a = buildFrom(fx)
    const b = { ...a, generatedAt: '2099-01-01T00:00:00.000Z' }
    expect(renderManifestMarkdown(a)).not.toBe(renderManifestMarkdown(b))
  })
})

function emptyManifest() {
  return buildManifest({
    range: '',
    headSha: '',
    plans: [],
    evidence: {},
    spendBook: null,
    chainTip: 'empty',
    staleness: 'unavailable',
    now: NOW,
  })
}

/** The section label of every dense line (everything left of the first colon). */
function denseLabels(text: string): string[] {
  return text
    .trimEnd()
    .split('\n')
    .map((l) => l.split(':')[0])
}

describe('renderManifestDense — the compact, agent-readable passport', () => {
  it('Test 13 (determinism): two renders of the same manifest are byte-identical', () => {
    const fx = writeFixture()
    const m = buildFrom(fx)
    expect(renderManifestDense(m)).toBe(renderManifestDense(m))
    // and a second build over the same state renders identically too
    expect(renderManifestDense(buildFrom(fx))).toBe(renderManifestDense(m))
  })

  it('Test 14 (fixed shape): one line per section, the same count full or empty', () => {
    const fx = writeFixture()
    const full = renderManifestDense(buildFrom(fx))
    const empty = renderManifestDense(emptyManifest())
    expect(full.trimEnd().split('\n')).toHaveLength(MANIFEST_DENSE_LINES)
    expect(empty.trimEnd().split('\n')).toHaveLength(MANIFEST_DENSE_LINES)
    // an empty section is MARKED, never dropped: same labels, in the same order
    expect(denseLabels(empty)).toEqual(denseLabels(full))
    expect(denseLabels(full)).toEqual(['manifest', 'predictions', 'receipts', 'blind', 'spend', 'hit-rate', 'trust'])
    // the explicit empty markers
    expect(empty).toMatch(/predictions: n=0 \(none\)/)
    expect(empty).toMatch(/receipts: n=0 \(none\)/)
    expect(empty).toMatch(/spend: \(absent\)/)
    expect(empty).toMatch(/hit-rate: \(none\)/)
  })

  it('Test 15 (verbatim numbers): the dense line reproduces the ledger verdicts', () => {
    const fx = writeFixture()
    const dense = renderManifestDense(buildFrom(fx))
    expect(dense).toMatch(/predictions: n=3 .*hit=1/)
    expect(dense).toMatch(/predictions: .*miss=1/)
    expect(dense).toMatch(/predictions: .*unscored=1/)
    expect(dense).toMatch(/receipts: n=2 .*divergent=1/)
    expect(dense).toMatch(/receipts: .*verified=1/)
    expect(dense).toMatch(/blind: .*divergences=1/)
    expect(dense).toMatch(/trust: .*open-class-A=2/)
    expect(dense).toMatch(/trust: .*verdict=red/)
  })

  it('Test 16 (no markdown): no marker, no table pipes, no headings — a parseable line set', () => {
    const fx = writeFixture()
    const dense = renderManifestDense(buildFrom(fx))
    expect(dense).not.toContain(MANIFEST_MARKER)
    expect(dense).not.toMatch(/\|/)
    expect(dense).not.toMatch(/^#/m)
    expect(dense).not.toMatch(/^_/m)
    // every line is `label: payload`
    for (const line of dense.trimEnd().split('\n')) expect(line).toMatch(/^[a-z-]+: \S/)
  })
})

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url))

/**
 * Run `cli.mjs manifest …` against a temp .sma root.
 *
 * `err` rides out with the exit code on purpose. The old shape dropped the
 * child's stderr on the floor, so every non-zero exit — a real product error, a
 * crash, a child that never started on a loaded box — reduced to the same
 * "expected 1 to be 0" with nothing to read. `expectOk` checks the pair, so a
 * red arrives with its reason attached.
 */
function runManifest(args: string[], smaRoot: string): { out: string; code: number; err: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, 'manifest', ...args], {
      env: { ...process.env, SMA_ROOT_OVERRIDE: smaRoot },
      encoding: 'utf8',
    })
    return { out, code: 0, err: '' }
  } catch (err: any) {
    return {
      out: String(err.stdout ?? ''),
      code: err.status ?? 1,
      err: `${err.message ?? ''}\n${String(err.stderr ?? '')}`.slice(0, 600),
    }
  }
}

/** Assert a manifest run exited 0, carrying the child's stderr into the report. */
function expectOk(r: { code: number; err: string }) {
  expect({ code: r.code, err: r.err }).toMatchObject({ code: 0 })
}

describe('sma manifest — the CLI surface', () => {
  let smaRoot: string
  beforeEach(() => {
    smaRoot = join(root, '.sma')
    mkdirSync(smaRoot, { recursive: true })
  })

  it('Test 8 (--json/--md): canonical keys, marker line 1, artifacts written', () => {
    const j = runManifest(['--json'], smaRoot)
    expectOk(j)
    const parsed = JSON.parse(j.out)
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'blind',
        'calibration',
        'chainTip',
        'consequences',
        'coverage',
        'generatedAt',
        'headSha',
        'manifestVersion',
        'plans',
        'predictions',
        'range',
        'receipts',
        'spend',
        'staleness',
      ].sort(),
    )
    const md = runManifest(['--md'], smaRoot)
    expectOk(md)
    expect(md.out.split('\n')[0]).toBe(MANIFEST_MARKER)
    // both artifacts landed under .sma/manifest/
    const manifestDir = join(smaRoot, 'manifest')
    expect(existsSync(join(manifestDir, `${parsed.headSha}.json`))).toBe(true)
    expect(existsSync(join(manifestDir, `${parsed.headSha}.md`))).toBe(true)
  })

  it('Test 9 (--stat): numeric last line, exit 0, determinism == 1 on a stable tree', () => {
    for (const stat of ['determinism', 'prediction-coverage', 'bench-build-ms']) {
      const r = runManifest([`--stat`, stat], smaRoot)
      expectOk(r)
      const last = r.out.trim().split('\n').pop() as string
      expect(Number.isFinite(Number(last))).toBe(true)
      if (stat === 'determinism') expect(Number(last)).toBe(1)
    }
  })

  it('Test 17 (--dense): the fixed compact shape, exit 0; --json keeps its own render', () => {
    const d = runManifest(['--dense'], smaRoot)
    expectOk(d)
    const lines = d.out.trimEnd().split('\n')
    expect(lines).toHaveLength(MANIFEST_DENSE_LINES)
    expect(lines[0].startsWith('manifest: ')).toBe(true)
    expect(d.out).not.toContain(MANIFEST_MARKER)
    // the two renders never mix: --json passed alongside --dense stays JSON (regression)
    const both = runManifest(['--dense', '--json'], smaRoot)
    expectOk(both)
    expect(() => JSON.parse(both.out)).not.toThrow()
    expect(JSON.parse(both.out).manifestVersion).toBe(MANIFEST_VERSION)
  })

  it('Test 10 (honest empty): no plans in range -> plans:[], coverage 100, exit 0', () => {
    const r = runManifest(['--json'], smaRoot)
    expectOk(r)
    const parsed = JSON.parse(r.out)
    expect(parsed.plans).toEqual([])
    expect(manifestStats(parsed, 'prediction-coverage')).toBe(100)
  })
})

const WORKFLOW = fileURLToPath(new URL('../../../.github/workflows/sma-manifest.yml', import.meta.url))

describe('sma-manifest CI workflow — the security posture locked as text', () => {
  const yaml = readFileSync(WORKFLOW, 'utf8')
  const usesLines = yaml.split('\n').filter((l) => /^\s*-?\s*uses:/.test(l))

  it('Test 11: pull_request + push:main only; least-privilege perms; SHA-pinned; guarded comment', () => {
    // triggers: pull_request + push to main ONLY, and NEVER the target-elevated variant.
    expect(yaml).toMatch(/^on:/m)
    expect(yaml).toMatch(/\n\s{2}pull_request:/)
    expect(yaml).toMatch(/\n\s{2}push:\r?\n\s{4}branches:\s*\[main\]/)
    expect(yaml).not.toMatch(/pull_request_target/)
    // explicit least-privilege permissions block — exactly contents:read + pull-requests:write.
    expect(yaml).toMatch(/permissions:\r?\n\s{2}contents:\s*read\r?\n\s{2}pull-requests:\s*write/)
    // every `uses:` pins to a full 40-hex commit SHA.
    expect(usesLines.length).toBeGreaterThan(0)
    for (const line of usesLines) {
      expect(line).toMatch(/uses:\s*[\w.\-/]+@[0-9a-f]{40}\b/)
    }
    // the comment step is guarded by a same-repo head condition AND continue-on-error.
    expect(yaml).toMatch(/if:\s*github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/)
    expect(yaml).toMatch(/continue-on-error:\s*true/)
  })

  it('Test 12: first-party actions only; run steps use only node cli + gh; no curl-pipe-sh', () => {
    // no third-party actions — every `uses:` is an actions/* first-party action.
    for (const line of usesLines) {
      const m = /uses:\s*([\w.\-/]+)@/.exec(line)
      expect(m).not.toBeNull()
      expect(m![1].startsWith('actions/')).toBe(true)
    }
    // the objective merge-time evaluation delegates to the shipped engine; the comment is gh.
    expect(yaml).toMatch(/node scripts\/sma\/cli\.mjs manifest/)
    expect(yaml).toMatch(/node scripts\/sma\/cli\.mjs predict-score/)
    expect(yaml).toMatch(/gh (api|pr comment)/)
    // no curl-pipe-sh, no arbitrary package installs beyond the repo's own pnpm install.
    expect(yaml).not.toMatch(/curl/)
    expect(yaml).not.toMatch(/\|\s*(sh|bash)\b/)
    // \b guards the legitimate `pnpm install` (which contains the substring "npm install").
    expect(yaml).not.toMatch(/\bnpm install|\bnpx |pip install/)
  })
})
