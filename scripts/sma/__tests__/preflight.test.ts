/**
 * Tests for scripts/sma/lib/preflight.mjs (Phase 49.3 Plan 10).
 *
 * The already-built pre-dispatch comparator (D-49.3-17): a deterministic, zero-LLM,
 * read-only check of a plan's must_haves (artifact paths + `contains` needles) and
 * allowlisted verify commands against the REAL tree → verdict built / partial / absent.
 *
 * Every test injects a fake tree ({existsSync, readFile}) and, for verify commands, a
 * spawn recorder — so no test touches the real tree, shells out, or spends a token. The
 * pure string parsers (bench.mjs) and the safety gate (predict.mjs) are the real modules,
 * lazily imported by preflightPlan; they parse the injected planText only, never the tree.
 *
 * Test 1 — built verdict + determinism
 * Test 2 — absent verdict (nothing exists → execute)
 * Test 3 — partial verdict + reconcile handoff (present file, missing needle)
 * Test 4 — read-only artifact check (no spawn; a command-shaped needle is only searched)
 * Test 5 — verify-command safety gate (--run-verify runs only isSafeCommand-allowlisted)
 * Test 6 — fail-open conservative absent on error (never a false built on doubt)
 * Test 7 — aggregate rule, order-independent
 */

import { describe, it, expect } from 'vitest'

import {
  preflightPlan,
  aggregateVerdict,
  checkArtifact,
  VERDICT_CODES,
} from '../lib/preflight.mjs'

/**
 * makeTree(files) — a DI fake tree. `files` maps a repo-relative suffix -> file text.
 * existsSync/readFile match a resolved absolute path by its (slash-normalized) suffix, so
 * the fake is cross-platform regardless of how path.join renders the root. Records every
 * readFile call so the read-only invariant is assertable.
 */
function makeTree(files: Record<string, string>) {
  const reads: string[] = []
  const norm = (p: string) => String(p).replace(/\\/g, '/')
  const keyFor = (resolved: string) => {
    const r = norm(resolved)
    return Object.keys(files).find((k) => r.endsWith(k)) ?? null
  }
  return {
    reads,
    existsSync: (p: string) => keyFor(p) !== null,
    readFile: (p: string) => {
      reads.push(String(p))
      const k = keyFor(p)
      if (k === null) throw new Error(`ENOENT: ${p}`)
      return files[k]
    },
  }
}

/** Build a minimal plan text with a must_haves.artifacts block + optional verify blocks. */
function makePlan(artifacts: Array<{ path: string; contains?: string }>, verifyCmds: string[] = []) {
  const lines = ['---', 'phase: t', 'plan: t', 'must_haves:', '  artifacts:']
  for (const a of artifacts) {
    lines.push(`    - path: ${a.path}`)
    if (a.contains != null) lines.push(`      contains: "${a.contains}"`)
  }
  lines.push('---', '')
  let body = lines.join('\n')
  for (const c of verifyCmds) body += `\n<verify><automated>${c}</automated></verify>\n`
  return body
}

const ROOT = '/repo'

describe('preflight — the already-built pre-dispatch comparator', () => {
  it('Test 1: built verdict when every artifact exists and every needle is present — deterministic', async () => {
    const tree = makeTree({ 'a.txt': 'MARKER_ALPHA here', 'b.txt': 'MARKER_BETA here' })
    const planText = makePlan([
      { path: 'a.txt', contains: 'MARKER_ALPHA' },
      { path: 'b.txt', contains: 'MARKER_BETA' },
    ])
    const args = { planText, rootDir: ROOT, existsSync: tree.existsSync, readFile: tree.readFile }

    const r1 = await preflightPlan(args)
    const r2 = await preflightPlan(args)

    expect(r1.verdict).toBe('built')
    expect(r1.code).toBe(0)
    expect(r1.missing).toEqual([])
    expect(r1.artifacts.every((a: any) => a.satisfied)).toBe(true)
    // same injected tree data → deep-equal result (determinism)
    expect(r2).toEqual(r1)
  })

  it('Test 2: absent verdict when no artifact path exists (the execute case)', async () => {
    const tree = makeTree({}) // nothing on disk
    const planText = makePlan([
      { path: 'x.ts', contains: 'foo' },
      { path: 'y.ts', contains: 'bar' },
    ])
    const r = await preflightPlan({ planText, rootDir: ROOT, existsSync: tree.existsSync, readFile: tree.readFile })

    expect(r.verdict).toBe('absent')
    expect(r.code).toBe(2)
    expect(r.missing.length).toBe(2)
  })

  it('Test 3: partial verdict + reconcile handoff when a present file is missing its needle', async () => {
    const tree = makeTree({ 'a.txt': 'MARKER_ALPHA here', 'b.txt': 'unrelated content only' })
    const planText = makePlan([
      { path: 'a.txt', contains: 'MARKER_ALPHA' }, // satisfied
      { path: 'b.txt', contains: 'MARKER_MISSING' }, // exists, needle absent → divergent
    ])
    const r = await preflightPlan({ planText, rootDir: ROOT, existsSync: tree.existsSync, readFile: tree.readFile })

    expect(r.verdict).toBe('partial')
    expect(r.code).toBe(1)
    // the reconcile payload names the present-but-divergent artifact (blind-verify's input)
    expect(r.reconcile).toBeDefined()
    expect(r.reconcile.map((x: any) => x.path)).toContain('b.txt')
  })

  it('Test 4: the artifact check is read-only — no spawn, and a command-shaped needle is only searched', async () => {
    const spawn = { calls: [] as any[] }
    const runVerify = (...a: any[]) => {
      spawn.calls.push(a)
      return { stdout: '', exitCode: 0 }
    }
    // the needle itself resembles a shell command — it must be searched, never executed
    const tree = makeTree({ 'a.txt': 'contains the string rm -rf /tmp/thing literally' })
    const planText = makePlan([{ path: 'a.txt', contains: 'rm -rf /tmp/thing' }])

    const r = await preflightPlan({
      planText,
      rootDir: ROOT,
      existsSync: tree.existsSync,
      readFile: tree.readFile,
      runVerify, // supplied but NOT opted-in
    })

    expect(r.verdict).toBe('built') // the string was found by a read-only includes
    expect(spawn.calls.length).toBe(0) // nothing was ever spawned during the artifact check
  })

  it('Test 5: --run-verify runs only isSafeCommand-allowlisted commands; a non-allowlisted one is skipped-unsafe', async () => {
    const spawn = { calls: [] as any[] }
    const runVerify = (inner: string, opts: any) => {
      spawn.calls.push({ inner, opts })
      return { stdout: '1', exitCode: 0 }
    }
    const tree = makeTree({ 'a.txt': 'MARKER_ALPHA' })
    const planText = makePlan(
      [{ path: 'a.txt', contains: 'MARKER_ALPHA' }],
      ['node scripts/sma/cli.mjs preflight --selftest', 'rm -rf /'],
    )

    const r = await preflightPlan({
      planText,
      rootDir: ROOT,
      existsSync: tree.existsSync,
      readFile: tree.readFile,
      optVerify: true,
      runVerify,
    })

    const safe = r.verify.find((v: any) => v.inner.startsWith('node scripts/sma/'))
    const unsafe = r.verify.find((v: any) => v.inner.startsWith('rm '))
    expect(safe.status).toBe('ran')
    expect(unsafe.status).toBe('skipped-unsafe')
    // the runner was invoked EXACTLY once — only for the allowlisted command
    expect(spawn.calls.length).toBe(1)
    expect(spawn.calls[0].inner).toBe('node scripts/sma/cli.mjs preflight --selftest')
  })

  it('Test 6: fail-open — a readFile that throws yields conservative absent with confidence low, never throws', async () => {
    const throwingRead = () => {
      throw new Error('boom: unreadable plan')
    }
    const r = await preflightPlan({ planPath: '/does/not/exist/PLAN.md', readFile: throwingRead, rootDir: ROOT })

    expect(r.verdict).toBe('absent')
    expect(r.code).toBe(2)
    expect(r.confidence).toBe('low')
    expect(r.error).toMatch(/boom/)
  })

  it('Test 7: aggregateVerdict applies the fixed rule and is order-independent', () => {
    const sat = (id: string) => ({ path: id, exists: true, needleFound: true, satisfied: true })
    const div = (id: string) => ({ path: id, exists: true, needleFound: false, satisfied: false })
    const gone = (id: string) => ({ path: id, exists: false, needleFound: false, satisfied: false })

    expect(aggregateVerdict([sat('a'), sat('b')]).verdict).toBe('built')
    expect(aggregateVerdict([gone('a'), gone('b')]).verdict).toBe('absent')
    expect(aggregateVerdict([div('a'), div('b')]).verdict).toBe('absent') // none satisfied → absent
    expect(aggregateVerdict([]).verdict).toBe('absent') // empty → unprovable → absent

    const mix = [sat('a'), div('b'), gone('c')]
    const forward = aggregateVerdict(mix).verdict
    const reversed = aggregateVerdict([...mix].reverse()).verdict
    expect(forward).toBe('partial')
    expect(reversed).toBe('partial') // sorting the input never changes the verdict

    expect(VERDICT_CODES).toEqual({ built: 0, partial: 1, absent: 2 })
  })

  it('checkArtifact resolves relative paths against rootDir and is a pure existence+includes check', () => {
    const tree = makeTree({ 'lib/x.mjs': 'export const FOO = 1' })
    const hit = checkArtifact({
      path: 'lib/x.mjs',
      contains: 'FOO',
      rootDir: ROOT,
      existsSync: tree.existsSync,
      readFile: tree.readFile,
    })
    expect(hit.satisfied).toBe(true)
    expect(hit.exists).toBe(true)

    const miss = checkArtifact({
      path: 'lib/x.mjs',
      contains: 'NOPE',
      rootDir: ROOT,
      existsSync: tree.existsSync,
      readFile: tree.readFile,
    })
    expect(miss.exists).toBe(true)
    expect(miss.satisfied).toBe(false)
  })
})
