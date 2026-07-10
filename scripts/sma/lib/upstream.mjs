/**
 * upstream.mjs — daily upstream-watch mechanic (D-49.1-03, 49.1-07).
 *
 * Compares the fork's anchored upstream version (UPSTREAM.json) against the
 * latest published release, and on a new release produces a THREE-WAY
 * integration report: their-old (vendor snapshot) vs their-new (fresh tarball)
 * vs ours (sma-core), with every upstream path/string mapped through
 * rename-map.json before comparison. Clean changes (upstream-only) are
 * auto-portable; anything we also touched escalates to the manual bucket —
 * nothing is lost, the report shows the honest divergence.
 *
 * DELIBERATELY NARROW: pure comparison + rendering. Zero network calls at
 * import time — the version fetch is dependency-injected (production impl
 * npmFetchVersion shells `npm view <pkg> version` only when CALLED). The only
 * writer is applyCleanSet, and only when apply === true (review-gated on both
 * entry points: the Action's PR branch and the local --apply flag; conflicts
 * NEVER auto-apply — T-49.1-12).
 *
 * Exports: checkVersion, threeWayReport, applyCleanSet, renderReport,
 *          mapPath, mapContent, npmFetchVersion
 *
 * Node built-ins only; zero npm deps. All dirs dependency-injectable.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

// ── version check ────────────────────────────────────────────────────────────

/** Loose semver-ish compare: numeric segment-wise; prerelease suffix stripped. */
function compareVersions(a, b) {
  const norm = (v) => String(v).trim().split('-')[0].split('.').map((s) => parseInt(s, 10) || 0)
  const [as, bs] = [norm(a), norm(b)]
  const len = Math.max(as.length, bs.length)
  for (let i = 0; i < len; i++) {
    const d = (as[i] ?? 0) - (bs[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * checkVersion({ anchorPath, fetchVersion }) — compare UPSTREAM.json's anchored
 * version against the latest upstream release. fetchVersion(pkg) is INJECTED
 * (tests stub it; production uses npmFetchVersion). Fail-open: any error →
 * { status: 'unknown', error } — never throws (the daily Action must not
 * false-alarm on a registry hiccup).
 * @returns {{status:'current'|'new'|'unknown', anchor?:string, latest?:string, package?:string, error?:string}}
 */
export async function checkVersion({ anchorPath, fetchVersion }) {
  try {
    const anchor = JSON.parse(readFileSync(anchorPath, 'utf8'))
    const pkg = anchor.package
    const anchored = anchor.version
    if (!pkg || !anchored) return { status: 'unknown', error: `anchor file ${anchorPath} missing package/version` }
    const latest = String(await fetchVersion(pkg)).trim()
    if (!latest) return { status: 'unknown', error: 'empty version from registry' }
    if (compareVersions(latest, anchored) > 0) {
      return { status: 'new', anchor: anchored, latest, package: pkg }
    }
    return { status: 'current', anchor: anchored, latest, package: pkg }
  } catch (err) {
    return { status: 'unknown', error: String((err && err.message) || err) }
  }
}

/**
 * Production fetchVersion: runs `npm view <pkg> version`. Called lazily —
 * NEVER at import time (importing this module performs no process spawn).
 * pkg is validated to the npm-name charset first (defense in depth), and the
 * invocation is execFileSync with an ARGUMENT ARRAY — no shell string is ever
 * built from the package name. On Windows npm is npm.cmd, which Node refuses
 * to spawn shell-less (CVE-2024-27980 guard), so shell:true is set there; the
 * charset guard means the argument still cannot carry shell metacharacters.
 */
export function npmFetchVersion(pkg) {
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(String(pkg))) {
    throw new Error(`refusing to run npm view for suspicious package name: ${pkg}`)
  }
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return execFileSync(npmCmd, ['view', pkg, 'version'], {
    encoding: 'utf8',
    timeout: 60_000,
    shell: process.platform === 'win32',
  }).trim()
}

// ── rename-map application ───────────────────────────────────────────────────

/** Normalize a path to forward slashes, no leading ./ */
function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Strip the sma-core/ tree prefix the real rename-map carries on files[] entries. */
function stripTreePrefix(p) {
  return norm(p).replace(/^sma-core\//, '')
}

/**
 * mapPath(relPath, renameMap) — map an upstream-package-relative path to our
 * tree-relative path: explicit files[] entry first (tree prefix tolerated on
 * both sides), else the ORDERED string map applied to the path.
 */
export function mapPath(relPath, renameMap) {
  const rel = norm(relPath)
  for (const entry of (renameMap && renameMap.files) || []) {
    if (stripTreePrefix(entry.from) === rel || norm(entry.from) === rel) {
      return stripTreePrefix(entry.to)
    }
  }
  let out = rel
  for (const s of (renameMap && renameMap.strings) || []) {
    out = out.split(s.from).join(s.to)
  }
  return out
}

/**
 * mapContent(text, renameMap) — apply the ORDERED string map to file content.
 * Attribution lines matching /derived from gsd-core/i stay VERBATIM
 * (rename-map.json exclusions).
 */
export function mapContent(text, renameMap) {
  const strings = (renameMap && renameMap.strings) || []
  const attribution = /derived from gsd-core/i
  return String(text)
    .split('\n')
    .map((line) => {
      if (attribution.test(line)) return line
      let out = line
      for (const s of strings) out = out.split(s.from).join(s.to)
      return out
    })
    .join('\n')
}

// ── three-way report ─────────────────────────────────────────────────────────

/** Recursively list files under dir as normalized relative paths. */
function walk(dir, prefix = '') {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), rel))
    else out.push(rel)
  }
  return out
}

function readOrNull(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/**
 * threeWayReport({ vendorBaseDir, newUpstreamDir, oursDir, renameMap }) —
 * PURE READ. Walks their delta (newUpstream vs vendorBase); for each changed
 * path, maps it through the rename map to our path and buckets:
 *   - ours byte-equal to the string-mapped vendorBase content → 'clean'
 *     (we never diverged there; the upstream change is auto-portable)
 *   - anything else → 'conflict' (manual bucket; nothing is lost)
 * Clean entries carry `content` (the mapped new-upstream content applyCleanSet
 * would write; null for upstream deletions).
 * @returns {{clean:Array, conflict:Array, summary:{clean:number, conflict:number, total:number, divergencePct:number}}}
 */
export function threeWayReport({ vendorBaseDir, newUpstreamDir, oursDir, renameMap }) {
  const baseFiles = new Set(walk(vendorBaseDir))
  const newFiles = new Set(walk(newUpstreamDir))
  const clean = []
  const conflict = []

  const push = (bucket, entry) => (bucket === 'clean' ? clean : conflict).push(entry)

  const allPaths = new Set([...baseFiles, ...newFiles])
  for (const rel of [...allPaths].sort()) {
    const baseContent = baseFiles.has(rel) ? readOrNull(join(vendorBaseDir, rel)) : null
    const newContent = newFiles.has(rel) ? readOrNull(join(newUpstreamDir, rel)) : null

    // Not part of their delta → skip.
    if (baseContent !== null && newContent !== null && baseContent === newContent) continue

    const change = baseContent === null ? 'added' : newContent === null ? 'deleted' : 'modified'
    const ourPath = mapPath(rel, renameMap)
    const oursContent = readOrNull(join(oursDir, ourPath))
    const mappedBase = baseContent === null ? null : mapContent(baseContent, renameMap)
    const mappedNew = newContent === null ? null : mapContent(newContent, renameMap)

    const entry = { upstreamPath: rel, ourPath, change, content: mappedNew }

    if (change === 'added') {
      // New upstream file: clean if we don't already have a diverging file there.
      if (oursContent === null || oursContent === mappedNew) push('clean', entry)
      else push('conflict', { ...entry, reason: 'file exists locally with different content' })
    } else if (change === 'deleted') {
      // Upstream deletion: portable only if we never diverged from their old.
      if (oursContent !== null && oursContent === mappedBase) push('clean', entry)
      else push('conflict', { ...entry, reason: oursContent === null ? 'already absent locally' : 'locally modified — upstream deleted' })
    } else {
      // Modified upstream: clean iff ours is byte-equal to the mapped vendor base.
      if (oursContent !== null && oursContent === mappedBase) push('clean', entry)
      else if (oursContent === mappedNew) continue // already ported — not a delta for us
      else push('conflict', { ...entry, reason: oursContent === null ? 'missing locally' : 'changed in both trees' })
    }
  }

  const total = clean.length + conflict.length
  const divergencePct = total === 0 ? 0 : Math.round((conflict.length / total) * 100)
  return { clean, conflict, summary: { clean: clean.length, conflict: conflict.length, total, divergencePct } }
}

// ── clean-set apply (the ONLY writer — review-gated, T-49.1-12) ──────────────

/**
 * applyCleanSet({ report, oursDir, apply }) — write the mapped new-upstream
 * content for CLEAN entries only, and ONLY when apply === true (default is a
 * dry run that writes NOTHING). Conflict entries are never touched — they
 * escalate to the manual bucket. Serves BOTH review-gated entry points: the
 * Action's PR branch and the local operator's explicit --apply.
 * @returns {{dryRun:boolean, applied:string[], wouldApply:string[]}}
 */
export function applyCleanSet({ report, oursDir, apply = false }) {
  const wouldApply = report.clean.map((e) => e.ourPath)
  if (apply !== true) {
    return { dryRun: true, applied: [], wouldApply }
  }
  const applied = []
  for (const entry of report.clean) {
    const target = join(oursDir, entry.ourPath)
    if (entry.change === 'deleted') {
      rmSync(target, { force: true })
    } else {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, entry.content)
    }
    applied.push(entry.ourPath)
  }
  return { dryRun: false, applied, wouldApply }
}

// ── report renderer ──────────────────────────────────────────────────────────

/**
 * renderReport({ report, version, anchor, generatedAt }) — markdown integration
 * report for docs/upstream-reports/<version>.md: clean list, conflict list with
 * three-way hunk pointers, and the honest divergence note (the further we
 * diverge, the bigger the manual bucket — the report SHOWS it).
 */
export function renderReport({ report, version, anchor, generatedAt } = {}) {
  const ts = generatedAt || new Date().toISOString()
  const { clean, conflict, summary } = report
  const lines = []
  lines.push(`# Upstream integration report — gsd-core ${anchor} → ${version}`)
  lines.push('')
  lines.push(`Generated: ${ts}`)
  lines.push('')
  lines.push(`| Bucket | Files |`)
  lines.push(`| --- | --- |`)
  lines.push(`| Auto-portable (clean) | ${summary.clean} |`)
  lines.push(`| Manual (conflict) | ${summary.conflict} |`)
  lines.push('')
  lines.push(`**Divergence:** ${summary.divergencePct}% of their delta lands in the manual bucket.`)
  lines.push('The further the fork diverges from upstream, the bigger this bucket gets — that is expected and honest, nothing is lost.')
  lines.push('')
  lines.push('## Auto-portable (clean) — upstream-only changes')
  lines.push('')
  if (clean.length === 0) lines.push('(none)')
  for (const e of clean) {
    lines.push(`- \`${e.ourPath}\` (${e.change}; upstream \`${e.upstreamPath}\`)`)
  }
  lines.push('')
  lines.push('## Manual bucket (conflict) — changed on both sides, human/agent integration pass required')
  lines.push('')
  if (conflict.length === 0) lines.push('(none)')
  for (const e of conflict) {
    lines.push(`- [ ] \`${e.ourPath}\` (${e.change}; ${e.reason || 'diverged'})`)
    lines.push(`      three-way: vendor-base \`${e.upstreamPath}\` · new-upstream \`${e.upstreamPath}\` · ours \`${e.ourPath}\``)
  }
  lines.push('')
  lines.push('---')
  lines.push('Merge of any auto-port PR is a HUMAN action (T-49.1-12 review gate). Conflicts never auto-apply.')
  lines.push('')
  return lines.join('\n')
}
