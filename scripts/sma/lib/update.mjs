/**
 * update.mjs — the consumer-side updater behind `sma update` (v5).
 *
 * The consumer-update ritual in one command: PULL the available version, COMPARE
 * against the installed one, REPORT honestly, and (only on --yes) re-run the ONE
 * standard installer (bin/init.mjs). The verb itself writes NOTHING — every
 * preservation guarantee (memory corpus, .sma state incl. profile.json, foreign
 * settings.json keys, user CLAUDE.md bytes) is the installer's own, so update
 * cannot invent a second write path that drifts from install.
 *
 * VERSION TRUTH (the version single-source law, reused not re-invented):
 *   - installed  = <configDir>/sma-core/capabilities/sma/capability.json `version`
 *                  (the stamp the installer copies with the engine; package-check
 *                  pins package.json == capability.json at publish time)
 *   - npm        = the registry's `latest` for the package (injected fetcher; an
 *                  unreachable registry is an HONEST state, never a crash)
 *   - local      = a product checkout's package.json `version` (the exact value
 *                  the installer banner prints), clearly labeled as local source
 *
 * HONESTY RULE: installed NEWER than npm (a local-source install) is stated
 * plainly as newer — never presented as a downgrade being "available".
 *
 * DI everywhere (the deleteme.mjs convention): fs ops ride an injected io, the
 * registry ride an injected fetchImpl, the installer ride an injected runner —
 * tests and the selftest never touch the network or a real install.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** The one package name — a constant, never a runtime choice. */
export const PACKAGE_NAME = 'sma-framework'

/** npm registry endpoint for the latest dist-tag (the injected default target). */
export const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`

/** Strict semver shape (optional prerelease/build), mirrors the house SEMVER_RE. */
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

// ── the real io (CLI injects this; tests inject fakes) ──────────────────────

export const REAL_IO = {
  exists: (p) => existsSync(p),
  isDir: (p) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  },
  readFile: (p) => readFileSync(p, 'utf8'),
  readdir: (p) => readdirSync(p),
}

// ── semver ───────────────────────────────────────────────────────────────────

/** parseSemver('1.2.3-rc.1') -> {major,minor,patch,pre:['rc','1']} | null. */
export function parseSemver(v) {
  const s = String(v ?? '').trim()
  if (!SEMVER_RE.test(s)) return null
  const noBuild = s.split('+')[0]
  const dash = noBuild.indexOf('-')
  const core = dash === -1 ? noBuild : noBuild.slice(0, dash)
  const pre = dash === -1 ? [] : noBuild.slice(dash + 1).split('.')
  const [major, minor, patch] = core.split('.').map(Number)
  return { major, minor, patch, pre }
}

/**
 * compareSemver(a, b) -> -1 | 0 | 1 (semver precedence, prerelease-aware:
 * 1.4.0-rc.1 < 1.4.0; rc.2 > rc.1). An unparseable side sorts LOWER than a
 * parseable one (honest degrade, never a throw); two unparseable are equal.
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1
  }
  // core equal — a release outranks any prerelease
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1
  const n = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1 // shorter prerelease sorts lower
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (xn !== yn) {
      return xn ? -1 : 1 // numeric identifiers sort below alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

// ── version sources ──────────────────────────────────────────────────────────

/**
 * readInstalledVersion({configDir, io}) — the installed stamp: the engine's own
 * capability.json, copied by the installer. {version|null, source, detail?} —
 * a missing or unparseable file yields version null with an honest detail.
 */
export function readInstalledVersion({ configDir, io = REAL_IO } = {}) {
  const source = join(configDir, 'sma-core', 'capabilities', 'sma', 'capability.json')
  if (!io.exists(source)) return { version: null, source, detail: 'not installed here (no capability.json)' }
  try {
    const cap = JSON.parse(io.readFile(source))
    const v = String(cap.version ?? '')
    if (!SEMVER_RE.test(v)) return { version: null, source, detail: `capability.json version «${v}» is not semver` }
    return { version: v, source }
  } catch (err) {
    return { version: null, source, detail: String(err && err.message ? err.message : err) }
  }
}

/**
 * readSourceVersion({sourceDir, io}) — a product checkout's package.json version
 * (the exact value the installer banner prints). {version|null, detail?}.
 */
export function readSourceVersion({ sourceDir, io = REAL_IO } = {}) {
  const pkgPath = join(sourceDir, 'package.json')
  if (!io.exists(pkgPath)) return { version: null, detail: 'no package.json in the source dir' }
  try {
    const pkg = JSON.parse(io.readFile(pkgPath))
    if (pkg.name !== PACKAGE_NAME) return { version: null, detail: `package.json name «${pkg.name}» is not ${PACKAGE_NAME}` }
    const v = String(pkg.version ?? '')
    if (!SEMVER_RE.test(v)) return { version: null, detail: `package.json version «${v}» is not semver` }
    return { version: v }
  } catch (err) {
    return { version: null, detail: String(err && err.message ? err.message : err) }
  }
}

/** True when a directory looks like a product checkout (installer + right package name). */
export function isProductCheckout(dir, io = REAL_IO) {
  if (!io.exists(join(dir, 'bin', 'init.mjs'))) return false
  return readSourceVersion({ sourceDir: dir, io }).version !== null
}

/**
 * detectLocalSource({projectDir, io}) — find a product checkout next to the
 * project (the git-clone fallback shape from docs/INSTALL.md: a sibling dir
 * holding bin/init.mjs + a sma-framework package.json). Deterministic: siblings
 * scanned in sorted order, the project itself excluded, first hit wins.
 * Returns the absolute dir or null. Never throws.
 */
export function detectLocalSource({ projectDir, io = REAL_IO } = {}) {
  try {
    const parent = dirname(resolve(projectDir))
    const self = basename(resolve(projectDir))
    const entries = io.readdir(parent).filter((e) => e !== self).sort()
    for (const e of entries) {
      const dir = join(parent, e)
      if (!io.isDir(dir)) continue
      if (isProductCheckout(dir, io)) return dir
    }
    return null
  } catch {
    return null
  }
}

/**
 * The default real fetcher: node:https with `agent:false` so the socket closes
 * with the response and process.exit() finds no live libuv handle (global fetch's
 * pooled undici socket trips the win32 async.c teardown assertion). Fetch-shaped
 * ({ok, status, json()}) so injected test fakes and the default are interchangeable.
 */
export function httpsFetch(url, { signal } = {}) {
  return new Promise((promiseResolve, promiseReject) => {
    import('node:https').then(({ get }) => {
      const req = get(url, { agent: false, headers: { accept: 'application/json' } }, (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          data += c
        })
        res.on('end', () => {
          const status = res.statusCode ?? 0
          promiseResolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(data) })
        })
      })
      req.on('error', promiseReject)
      if (signal) signal.addEventListener('abort', () => req.destroy(new Error(`registry timed out`)), { once: true })
    }, promiseReject)
  })
}

/**
 * fetchNpmVersion({fetchImpl, url, timeoutMs}) — the registry's latest version
 * via an INJECTED fetch. {ok, version?, detail?}; any failure (offline, non-200,
 * bad JSON, non-semver) is an honest {ok:false, detail} — never a throw.
 */
export async function fetchNpmVersion({ fetchImpl = httpsFetch, url = REGISTRY_URL, timeoutMs = 10_000 } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, detail: 'no fetch available in this runtime' }
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null
  try {
    const res = await fetchImpl(url, ctl ? { signal: ctl.signal } : {})
    if (!res || !res.ok) return { ok: false, detail: `registry answered ${res ? res.status : 'nothing'}` }
    const body = await res.json()
    const v = String(body && body.version ? body.version : '')
    if (!SEMVER_RE.test(v)) return { ok: false, detail: `registry version «${v || '(empty)'}» is not semver` }
    return { ok: true, version: v }
  } catch (err) {
    return { ok: false, detail: String(err && err.message ? err.message : err) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── compare + report ─────────────────────────────────────────────────────────

/** The per-source verdict vocabulary (fixed strings — the test/scorer contract). */
export const VERDICTS = ['update-available', 'up-to-date', 'installed-newer', 'unreachable', 'unknown-installed']

/** verdictFor(installed, source:{ok,version}) — one honest verdict per source. */
export function verdictFor(installed, source) {
  if (!source || source.ok !== true || !source.version) return 'unreachable'
  if (!installed) return 'unknown-installed'
  const cmp = compareSemver(installed, source.version)
  if (cmp < 0) return 'update-available'
  if (cmp > 0) return 'installed-newer' // NEVER phrased as a downgrade offer
  return 'up-to-date'
}

/**
 * buildReport({installed, npm, local}) — the pure comparison object the CLI
 * renders. `npm` is a fetchNpmVersion result; `local` is
 * {ok, version|null, dir, detail?} or null when no checkout was found.
 */
export function buildReport({ installed, npm, local } = {}) {
  const sources = []
  sources.push({
    id: 'npm',
    label: `npm (${PACKAGE_NAME}@latest)`,
    ok: Boolean(npm && npm.ok),
    version: npm && npm.ok ? npm.version : null,
    verdict: verdictFor(installed, npm),
    ...(npm && npm.detail ? { detail: npm.detail } : {}),
  })
  if (local) {
    sources.push({
      id: 'local',
      label: `local source (${local.dir})`,
      ok: Boolean(local.ok),
      version: local.ok ? local.version : null,
      verdict: verdictFor(installed, local),
      ...(local.detail ? { detail: local.detail } : {}),
    })
  }
  return { installed: installed ?? null, sources }
}

// ── apply (the ONE write path: the standard installer) ───────────────────────

/** What the installer PRESERVES — stated with every apply/dry-run (its guarantees, not new ones). */
export const PRESERVED = [
  '.claude/memory/** (the memory corpus — the installer never touches it)',
  '.sma/** state incl. profile.json (scaffold dirs are only created, never wiped)',
  'every foreign key in .claude/settings.json (hooks merge is additive + idempotent)',
  'every user byte in CLAUDE.md (only the managed SMA:RULES block is spliced)',
]

/**
 * planUpdate({source:'npm'|'local', localDir, isGlobal}) — the PURE description
 * of the one installer invocation; nothing is executed here. {command, args, note}.
 */
export function planUpdate({ source, localDir, isGlobal = false } = {}) {
  const scopeFlag = isGlobal ? '--global' : '--local'
  if (source === 'local') {
    if (!localDir) return { error: 'no local product checkout to install from' }
    return { command: 'node', args: [join(localDir, 'bin', 'init.mjs'), scopeFlag], note: `installer from the local checkout ${localDir}` }
  }
  return { command: 'npx', args: ['-y', `${PACKAGE_NAME}@latest`, 'init', scopeFlag], note: `installer from the npm registry (${PACKAGE_NAME}@latest)` }
}

/**
 * applyUpdate({plan, runner}) — run the planned installer EXACTLY once through
 * the injected runner ({command,args}) -> {exitCode}. {ran, exitCode|null, error?}.
 */
export function applyUpdate({ plan, runner } = {}) {
  if (!plan || plan.error) return { ran: false, exitCode: null, error: plan ? plan.error : 'no plan' }
  if (typeof runner !== 'function') return { ran: false, exitCode: null, error: 'no runner injected' }
  try {
    const res = runner({ command: plan.command, args: plan.args })
    return { ran: true, exitCode: res && typeof res.exitCode === 'number' ? res.exitCode : 0 }
  } catch (err) {
    return { ran: true, exitCode: 1, error: String(err && err.message ? err.message : err) }
  }
}

// ── selftest (deterministic, zero network — the receipt surface) ─────────────

/**
 * updateSelftest({tmpRoot}) — build a fake install + a fake sibling checkout in
 * a temp dir, then prove: the installed stamp reads from capability.json, the
 * sibling is detected and its package.json version read, the compare matrix
 * (older / equal / newer / prerelease / unreachable / unknown) lands the right
 * verdicts, plans are exact, and --yes semantics invoke the runner EXACTLY once
 * while the dry path invokes it zero times. Returns 1 on full pass, else 0.
 * Never throws, never fetches.
 */
export function updateSelftest({ tmpRoot }) {
  try {
    const project = join(tmpRoot, 'proj')
    const configDir = join(project, '.claude')
    const w = (p, text) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, text, 'utf8')
    }
    // fake install stamped 5.0.0 + a sibling product checkout at 5.1.0
    w(join(configDir, 'sma-core', 'capabilities', 'sma', 'capability.json'), JSON.stringify({ id: 'sma', version: '5.0.0' }))
    w(join(tmpRoot, 'src-sma', 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '5.1.0' }))
    w(join(tmpRoot, 'src-sma', 'bin', 'init.mjs'), '// installer stub')
    w(join(tmpRoot, 'not-a-source', 'package.json'), JSON.stringify({ name: 'unrelated', version: '9.9.9' }))

    const installed = readInstalledVersion({ configDir })
    if (installed.version !== '5.0.0') return 0
    const localDir = detectLocalSource({ projectDir: project })
    if (!localDir || basename(localDir) !== 'src-sma') return 0
    if (readSourceVersion({ sourceDir: localDir }).version !== '5.1.0') return 0

    // compare matrix
    if (compareSemver('5.0.0', '5.0.1') !== -1) return 0
    if (compareSemver('5.0.1', '5.0.1') !== 0) return 0
    if (compareSemver('5.0.2', '5.0.1') !== 1) return 0
    if (compareSemver('5.1.0-rc.1', '5.1.0') !== -1) return 0
    if (compareSemver('5.1.0-rc.2', '5.1.0-rc.1') !== 1) return 0

    // verdicts, incl. the honesty rule (newer != downgrade offer)
    if (verdictFor('5.0.0', { ok: true, version: '5.1.0' }) !== 'update-available') return 0
    if (verdictFor('5.1.0', { ok: true, version: '5.1.0' }) !== 'up-to-date') return 0
    if (verdictFor('5.2.0', { ok: true, version: '5.1.0' }) !== 'installed-newer') return 0
    if (verdictFor('5.0.0', { ok: false, detail: 'offline' }) !== 'unreachable') return 0
    if (verdictFor(null, { ok: true, version: '5.1.0' }) !== 'unknown-installed') return 0

    const report = buildReport({
      installed: installed.version,
      npm: { ok: false, detail: 'selftest is offline by design' },
      local: { ok: true, version: '5.1.0', dir: localDir },
    })
    if (report.sources.length !== 2) return 0
    if (report.sources[0].verdict !== 'unreachable') return 0
    if (report.sources[1].verdict !== 'update-available') return 0

    // plans are exact; the runner fires exactly once on apply, zero on dry
    const planNpm = planUpdate({ source: 'npm', isGlobal: false })
    if (planNpm.command !== 'npx' || planNpm.args.join(' ') !== `-y ${PACKAGE_NAME}@latest init --local`) return 0
    const planLocal = planUpdate({ source: 'local', localDir, isGlobal: false })
    if (planLocal.command !== 'node' || planLocal.args[0] !== join(localDir, 'bin', 'init.mjs') || planLocal.args[1] !== '--local') return 0
    if (!planUpdate({ source: 'local', localDir: null }).error) return 0

    let calls = 0
    const runner = () => {
      calls += 1
      return { exitCode: 0 }
    }
    const applied = applyUpdate({ plan: planLocal, runner })
    if (!applied.ran || applied.exitCode !== 0 || calls !== 1) return 0
    const refused = applyUpdate({ plan: planUpdate({ source: 'local', localDir: null }), runner })
    if (refused.ran || calls !== 1) return 0

    return 1
  } catch {
    return 0
  }
}
