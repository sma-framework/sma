/**
 * Tests for scripts/sma/lib/update.mjs (v5 — the consumer-side updater).
 *
 * The load-bearing behaviors:
 *   Test 1 — semver: compare matrix (older/equal/newer), prerelease precedence,
 *            unparseable degrades below parseable (never a throw)
 *   Test 2 — version sources (fake io): installed stamp from capability.json,
 *            local source from a checkout's package.json; missing/unparseable/
 *            wrong-name are honest nulls with a detail
 *   Test 3 — detectLocalSource (fake io): sibling checkout found deterministically,
 *            the project itself excluded, a readdir failure degrades to null
 *   Test 4 — fetchNpmVersion (injected fetch): ok / non-200 / bad JSON / offline
 *            throw / non-semver — every failure an honest {ok:false}, never a throw
 *   Test 5 — verdict + report matrix: update-available / up-to-date /
 *            installed-newer (NEVER a downgrade offer) / unreachable / unknown-installed
 *   Test 6 — plan + apply: exact installer invocations; the injected runner fires
 *            EXACTLY once on apply and never on a broken plan
 *   Test 7 — updateSelftest: the full fixture round-trip on a real temp dir prints 1
 *   Test 8 — CLI round-trip: `cli.mjs update --selftest` exits 0 with last line 1
 *            (proves the verb-table registration)
 *
 * DI everywhere — only Tests 7/8 touch a real (temp) fs; nothing ever fetches.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, it, expect, afterAll } from 'vitest'
import {
  PACKAGE_NAME,
  parseSemver,
  compareSemver,
  readInstalledVersion,
  readSourceVersion,
  isProductCheckout,
  detectLocalSource,
  fetchNpmVersion,
  verdictFor,
  buildReport,
  planUpdate,
  applyUpdate,
  updateSelftest,
} from '../lib/update.mjs'

/** A fake io over a {path: content} map plus an explicit dir list. */
function io(files: Record<string, string>, dirs: string[] = []) {
  const map: Record<string, string> = {}
  for (const [k, v] of Object.entries(files)) map[resolve(k)] = v
  const dirSet = new Set(dirs.map((d) => resolve(d)))
  return {
    exists: (p: string) => resolve(p) in map || dirSet.has(resolve(p)),
    isDir: (p: string) => dirSet.has(resolve(p)),
    readFile: (p: string) => {
      const key = resolve(p)
      if (!(key in map)) throw new Error(`ENOENT: ${p}`)
      return map[key]
    },
    readdir: (p: string) => {
      const key = resolve(p)
      const kids = new Set<string>()
      for (const d of dirSet) if (dirname(d) === key) kids.add(d.slice(key.length + 1))
      for (const f of Object.keys(map)) if (dirname(f) === key) kids.add(f.slice(key.length + 1))
      return [...kids]
    },
  }
}

describe('update — semver compare (Test 1)', () => {
  it('orders the plain triple', () => {
    expect(compareSemver('5.0.0', '5.0.1')).toBe(-1)
    expect(compareSemver('5.0.1', '5.0.1')).toBe(0)
    expect(compareSemver('5.0.2', '5.0.1')).toBe(1)
    expect(compareSemver('5.10.0', '5.9.9')).toBe(1) // numeric, not lexicographic
  })

  it('applies semver prerelease precedence', () => {
    expect(compareSemver('5.1.0-rc.1', '5.1.0')).toBe(-1) // a release outranks its rc
    expect(compareSemver('5.1.0-rc.2', '5.1.0-rc.1')).toBe(1)
    expect(compareSemver('5.1.0-rc.1', '5.0.9')).toBe(1) // rc of a newer core is newer
    expect(compareSemver('5.1.0-alpha', '5.1.0-alpha.1')).toBe(-1) // shorter prefix sorts lower
  })

  it('degrades an unparseable side below a parseable one, never throws', () => {
    expect(parseSemver('not-a-version')).toBeNull()
    expect(compareSemver('garbage', '5.0.1')).toBe(-1)
    expect(compareSemver('5.0.1', 'garbage')).toBe(1)
    expect(compareSemver('garbage', 'garbage')).toBe(0)
  })
})

describe('update — version sources (Test 2)', () => {
  const configDir = resolve('/proj/.claude')
  const cap = join(configDir, 'sma-core', 'capabilities', 'sma', 'capability.json')

  it('reads the installed stamp from capability.json', () => {
    const res = readInstalledVersion({ configDir, io: io({ [cap]: JSON.stringify({ id: 'sma', version: '5.0.1' }) }) })
    expect(res.version).toBe('5.0.1')
    expect(res.source).toBe(cap)
  })

  it('a missing / unparseable / non-semver stamp is an honest null with a detail', () => {
    expect(readInstalledVersion({ configDir, io: io({}) })).toMatchObject({ version: null, detail: expect.stringContaining('not installed') })
    expect(readInstalledVersion({ configDir, io: io({ [cap]: '{broken' }) }).version).toBeNull()
    expect(readInstalledVersion({ configDir, io: io({ [cap]: JSON.stringify({ version: 'vNext' }) }) })).toMatchObject({
      version: null,
      detail: expect.stringContaining('not semver'),
    })
  })

  it('reads a local source version ONLY from a sma-framework package.json', () => {
    const src = resolve('/repo/sma')
    const ok = readSourceVersion({ sourceDir: src, io: io({ [join(src, 'package.json')]: JSON.stringify({ name: PACKAGE_NAME, version: '5.1.0' }) }) })
    expect(ok.version).toBe('5.1.0')
    const wrongName = readSourceVersion({ sourceDir: src, io: io({ [join(src, 'package.json')]: JSON.stringify({ name: 'other', version: '5.1.0' }) }) })
    expect(wrongName.version).toBeNull()
    expect(wrongName.detail).toContain('other')
    expect(readSourceVersion({ sourceDir: src, io: io({}) }).version).toBeNull()
  })
})

describe('update — detectLocalSource (Test 3)', () => {
  const parent = resolve('/repos')
  const proj = join(parent, 'my-app')
  const smaDir = join(parent, 'sma')

  const checkoutFiles = {
    [join(smaDir, 'package.json')]: JSON.stringify({ name: PACKAGE_NAME, version: '5.1.0' }),
    [join(smaDir, 'bin', 'init.mjs')]: '// installer',
  }

  it('finds the sibling product checkout and excludes the project itself', () => {
    const fio = io(checkoutFiles, [proj, smaDir, join(parent, 'aaa-not-sma')])
    expect(isProductCheckout(smaDir, fio)).toBe(true)
    expect(detectLocalSource({ projectDir: proj, io: fio })).toBe(smaDir)
  })

  it('returns null when no sibling qualifies, and on a readdir failure', () => {
    const fio = io({}, [proj, join(parent, 'other')])
    expect(detectLocalSource({ projectDir: proj, io: fio })).toBeNull()
    const broken = { ...io({}, []), readdir: () => { throw new Error('EACCES') } }
    expect(detectLocalSource({ projectDir: proj, io: broken })).toBeNull()
  })
})

describe('update — fetchNpmVersion via injected fetch (Test 4)', () => {
  it('a healthy registry answer yields {ok, version}', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ version: '5.0.2' }) })
    expect(await fetchNpmVersion({ fetchImpl })).toEqual({ ok: true, version: '5.0.2' })
  })

  it('non-200, bad JSON, non-semver, and an offline throw are honest {ok:false}', async () => {
    expect((await fetchNpmVersion({ fetchImpl: async () => ({ ok: false, status: 404 }) })).ok).toBe(false)
    expect((await fetchNpmVersion({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } }) })).ok).toBe(false)
    expect((await fetchNpmVersion({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: 'latest' }) }) })).ok).toBe(false)
    const offline = await fetchNpmVersion({ fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org') } })
    expect(offline.ok).toBe(false)
    expect(offline.detail).toContain('ENOTFOUND')
    expect((await fetchNpmVersion({ fetchImpl: null as never })).ok).toBe(false) // no fetch in the runtime
  })
})

describe('update — verdicts + report (Test 5)', () => {
  it('lands the full verdict matrix', () => {
    expect(verdictFor('5.0.0', { ok: true, version: '5.0.1' })).toBe('update-available')
    expect(verdictFor('5.0.1', { ok: true, version: '5.0.1' })).toBe('up-to-date')
    expect(verdictFor('5.0.2', { ok: true, version: '5.0.1' })).toBe('installed-newer')
    expect(verdictFor('5.0.1', { ok: false })).toBe('unreachable')
    expect(verdictFor(null, { ok: true, version: '5.0.1' })).toBe('unknown-installed')
  })

  it('the installed-newer case is NEVER labeled as an available update (the honesty rule)', () => {
    const report = buildReport({
      installed: '5.0.1',
      npm: { ok: true, version: '5.0.0' },
      local: { ok: true, version: '5.0.1', dir: '/repo/sma' },
    })
    const npmRow = report.sources.find((s: { id: string }) => s.id === 'npm')
    expect(npmRow.verdict).toBe('installed-newer')
    expect(npmRow.verdict).not.toBe('update-available')
    expect(report.sources.find((s: { id: string }) => s.id === 'local').verdict).toBe('up-to-date')
  })

  it('an unreachable npm plus no local checkout is still a complete honest report', () => {
    const report = buildReport({ installed: '5.0.1', npm: { ok: false, detail: 'offline' }, local: null })
    expect(report.sources).toHaveLength(1)
    expect(report.sources[0]).toMatchObject({ id: 'npm', ok: false, version: null, verdict: 'unreachable', detail: 'offline' })
  })
})

describe('update — plan + apply (Test 6)', () => {
  it('plans the exact standard-installer invocations', () => {
    expect(planUpdate({ source: 'npm' })).toMatchObject({ command: 'npx', args: ['-y', `${PACKAGE_NAME}@latest`, 'init', '--local'] })
    expect(planUpdate({ source: 'npm', isGlobal: true }).args).toContain('--global')
    const local = planUpdate({ source: 'local', localDir: resolve('/repo/sma') })
    expect(local.command).toBe('node')
    expect(local.args).toEqual([join(resolve('/repo/sma'), 'bin', 'init.mjs'), '--local'])
    expect(planUpdate({ source: 'local', localDir: null }).error).toBeTruthy()
  })

  it('the injected runner fires EXACTLY once on apply, and never on a broken plan', () => {
    let calls = 0
    const runner = () => {
      calls += 1
      return { exitCode: 0 }
    }
    const applied = applyUpdate({ plan: planUpdate({ source: 'npm' }), runner })
    expect(applied).toMatchObject({ ran: true, exitCode: 0 })
    expect(calls).toBe(1)
    const refused = applyUpdate({ plan: planUpdate({ source: 'local', localDir: null }), runner })
    expect(refused.ran).toBe(false)
    expect(calls).toBe(1)
    expect(applyUpdate({ plan: planUpdate({ source: 'npm' }) }).error).toContain('runner')
    expect(calls).toBe(1)
  })
})

describe('update — selftest + CLI registration (Tests 7/8)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sma-update-test-'))
  afterAll(() => {
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* best-effort */
    }
  })

  it('Test 7: updateSelftest on a real temp dir returns 1', () => {
    expect(updateSelftest({ tmpRoot: tmp })).toBe(1)
  })

  it('Test 8: `cli.mjs update --selftest` exits 0 with 1 as the last line', () => {
    const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs')
    const res = spawnSync(process.execPath, [cli, 'update', '--selftest'], {
      encoding: 'utf8',
      timeout: 25_000,
      env: { ...process.env, SMA_ROOT_OVERRIDE: join(tmp, '.sma') },
    })
    expect(res.status).toBe(0)
    expect(res.stdout.trim().split('\n').pop()).toBe('1')
  })
})
