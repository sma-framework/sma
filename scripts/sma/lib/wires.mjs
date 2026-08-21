/**
 * wires.mjs — the COLLECTING half of the declared-wire inventory.
 *
 * Plans have been declaring their own wiring for as long as the tree has existed:
 * which file feeds which, through what, and by what trace in the code. Nobody ever
 * read those declarations back. This module reads them — and nothing else. It hands
 * out counts, statuses and resolved paths; it renders no verdict and paints nothing
 * red. The scoring half is a separate step on purpose: the measurement mistakes that
 * produced this module were mistakes of COLLECTION, not of judgement, and a collector
 * that also judges hides its own bias inside its own number.
 *
 * THE HONEST BOUNDARY, stated here so it also travels into the report:
 * a declaration is not proof that a wire works. A trace found in a file proves that a
 * STRING exists — not that anything is called, not that a value is delivered, not that
 * the receiver ever reads it. The only thing that proves a wire is a test that watches
 * the RECEIVER. This inventory is bookkeeping that forces such a test to exist; calling
 * it proof would repeat, on the instrument itself, exactly the failure it was built to
 * catch.
 *
 * THREE FORMS, of unequal strength — all three are read in one pass:
 *   1. structured `must_haves.key_links` entries (from / to / via / pattern) — weak:
 *      the pattern only proves a string is somewhere in the tree;
 *   2. `must_haves.artifacts` entries (path + contains) — stronger: the trace is
 *      pinned to a NAMED file, so a missing file is distinguishable from a file that
 *      is present with none of the work in it;
 *   3. prose lines written under the same `key_links` key — strength zero: not
 *      machine-checkable at all, so they are COUNTED and named, never scored.
 *
 * ONE STATUS DISCRIMINATOR, and it is already law in this tree: a plan is closed when
 * the paired SUMMARY file sits next to it, because a summary is written at close and
 * never before. No other source of status is consulted — not the roadmap, not an
 * acceptance predicate, not a verification file, not a state document. A plan WITHOUT
 * a summary is SILENCE (the work is still ahead), never green: reading a hole in
 * one's own evidence as a pass is leniency wearing the costume of tidiness.
 *
 * House posture: read-only (no write path exists here), every directory INJECTED by
 * the caller — a lib never goes looking for a planning tree on its own — and the whole
 * filesystem surface is swappable so tests never touch a real tree.
 */

import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  readdirSync as fsReaddirSync,
  statSync as fsStatSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { parseFrontmatterEntries } from './predict.mjs'

/** Plan / summary filename suffixes — the pair the discriminator is built on. */
export const PLAN_SUFFIX = '-PLAN.md'
export const SUMMARY_SUFFIX = '-SUMMARY.md'

/** The two frontmatter blocks the inventory lives in, plus the neighbour it only counts. */
export const KEY_LINKS_KEY = 'must_haves.key_links'
export const ARTIFACTS_KEY = 'must_haves.artifacts'
export const PROHIBITIONS_KEY = 'must_haves.prohibitions'

/**
 * The walk roots, DECLARED rather than discovered — and this is the whole point of the
 * constant. The same probe run three times over an unwritten root set produced three
 * different totals, which makes a claim of zero failures a number about nothing. A
 * caller may override the set, but then the set it passed is what the receipt must
 * print. Entries may name a directory or a single file; both are walked.
 */
export const DEFAULT_SCAN_ROOTS = Object.freeze([
  'scripts',
  'daemon',
  'supervisor',
  'spa/src',
  'sma-core',
  'tools',
  'bin',
  'docs',
  'README.md',
  'README.ru.md',
  'ROADMAP.md',
])

/**
 * Directory names the walk NEVER enters, declared in exactly one place.
 * A dependency directory at any depth is a junction point in a working copy —
 * following it walks straight out into a tree this run was never asked about.
 */
export const WALK_EXCLUDED_DIRS = Object.freeze(['node_modules', '.git'])

/**
 * Whole path fragments excluded outright, resolved against the tree under test.
 * The built front directory is the other junction point.
 */
export const WALK_EXCLUDED_PATHS = Object.freeze([join('daemon', 'static', 'app')])

/**
 * PLANS_ARE_NOT_CODE. The plans directory is never part of the search zone. A trace
 * found inside the very declaration that asked for it is the inventory congratulating
 * itself: the marker is present because somebody typed it into the plan, not because
 * any code carries it. Excluding the plans tree is the difference between a measurement
 * and a mirror.
 */
export const PLANS_ARE_NOT_CODE = true

/**
 * The whole exclusion set in ONE place, so a receipt can print what the walk refused to
 * look at. An instrument that reports no failures without saying where it declined to
 * look is reporting about nothing.
 */
export const WALK_EXCLUSIONS = Object.freeze({
  dirNames: WALK_EXCLUDED_DIRS,
  paths: WALK_EXCLUDED_PATHS,
  plansTree: PLANS_ARE_NOT_CODE,
})

/** The two outcomes this collecting step emits. */
export const PLAN_STATUS = Object.freeze({
  /** paired summary present -> the plan is closed, and therefore judgeable */
  closed: 'closed',
  /** no paired summary -> the work is still ahead; silence, NOT green */
  ahead: 'ahead',
})

/**
 * Where a declared path is looked for, in this fixed order. Declaring the candidates
 * (rather than resolving ad hoc) is what makes an unresolved path a REPORTABLE category
 * instead of a silent skip.
 */
export const CANDIDATE_ROOTS = Object.freeze([
  { name: 'tree', of: ({ treeDir }) => treeDir },
  { name: 'plans-parent', of: ({ plansDir }) => (plansDir ? dirname(plansDir) : null) },
  { name: 'workshop', of: ({ plansDir }) => (plansDir ? dirname(dirname(plansDir)) : null) },
])

/** Swappable filesystem surface — tests never touch a real tree. */
function makeFs(fsImpl = {}) {
  return {
    existsSync: fsImpl.existsSync ?? fsExistsSync,
    readFileSync: fsImpl.readFileSync ?? fsReadFileSync,
    readdirSync: fsImpl.readdirSync ?? fsReaddirSync,
    statSync: fsImpl.statSync ?? fsStatSync,
  }
}

/** planId from a plan path: basename minus the PLAN / SUMMARY suffix. */
export function planIdFromPath(p) {
  return basename(String(p ?? '')).replace(/-(PLAN|SUMMARY)\.md$/i, '')
}

/** The summary path paired to a plan path — same directory, same id, other suffix. */
export function summaryPathFor(planPath) {
  const s = String(planPath ?? '')
  return s.endsWith(PLAN_SUFFIX) ? s.slice(0, -PLAN_SUFFIX.length) + SUMMARY_SUFFIX : null
}

/** True when `child` is `parent` itself or sits under it (boundary-safe, not a prefix glob). */
function isUnder(child, parent) {
  if (!parent) return false
  const c = resolve(String(child))
  const p = resolve(String(parent))
  return c === p || c.startsWith(p + sep)
}

/**
 * listPlanFiles(dir, suffix, fs) -> sorted paths. One parameterized walk, fail-soft per
 * directory — an unreadable directory yields nothing rather than an exception.
 */
export function listPlanFiles(dir, suffix = PLAN_SUFFIX, fs = makeFs()) {
  const out = []
  const walk = (d) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name.endsWith(suffix)) out.push(p)
    }
  }
  if (dir) walk(dir)
  return out.sort()
}

/**
 * collectScanFiles({roots, treeDir, plansDir, fsImpl}) -> sorted file paths.
 *
 * The search zone. A root naming a single FILE is read as that file rather than skipped
 * — the class of bug that had an earlier probe quietly omit every top-level document it
 * was pointed at. Excluded: the plans tree (PLANS_ARE_NOT_CODE), dependency directories
 * at any depth, the version-control directory, and the built front directory.
 */
export function collectScanFiles({ roots, treeDir, plansDir, fsImpl } = {}) {
  const fs = makeFs(fsImpl)
  const base = treeDir ?? '.'
  const list = Array.isArray(roots) && roots.length ? roots : DEFAULT_SCAN_ROOTS
  const excludedPaths = WALK_EXCLUDED_PATHS.map((p) => join(base, p))
  const out = []
  const seen = new Set()

  const skip = (p) => isUnder(p, plansDir) || excludedPaths.some((x) => isUnder(p, x))

  const walk = (p) => {
    if (skip(p)) return
    let st
    try {
      st = fs.statSync(p)
    } catch {
      return // a declared root that is not there is an absence, not an exception
    }
    if (st.isFile()) {
      const key = resolve(p)
      if (!seen.has(key)) {
        seen.add(key)
        out.push(p)
      }
      return
    }
    if (!st.isDirectory()) return
    let entries
    try {
      entries = fs.readdirSync(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory() && WALK_EXCLUDED_DIRS.includes(e.name)) continue
      walk(join(p, e.name))
    }
  }

  for (const r of list) walk(isAbsolute(String(r)) ? String(r) : join(base, String(r)))
  return out.sort()
}

/**
 * applyRewrites(raw, rewrites) -> {value, applied}. Root rewriting, first match wins.
 *
 * Most declared paths in a mature inventory point at the tree the PLANNER had open, not
 * at the working copy under test. Without rewriting, the instrument renders a verdict
 * about a tree nobody asked about while the worker edits their own — a wrong answer that
 * looks entirely convincing. `rewrites` is a list of {prefix, target} pairs supplied by
 * the caller and printed in the receipt.
 */
export function applyRewrites(raw, rewrites) {
  const s = String(raw ?? '')
  const list = Array.isArray(rewrites) ? rewrites : []
  for (const r of list) {
    if (!r || !r.prefix) continue
    const prefix = String(r.prefix)
    if (s.startsWith(prefix)) {
      const target = String(r.target ?? '')
      const rest = s.slice(prefix.length).replace(/^[/\\]+/, '')
      return { value: target ? join(target, rest) : rest, applied: r }
    }
  }
  return { value: s, applied: null }
}

/**
 * resolveDeclaredPath({raw, rewrites, treeDir, plansDir, fsImpl}) -> resolution record.
 *
 * Rewrite first, then try the declared candidate roots in order. A path that resolves
 * nowhere is marked `unresolved` and KEPT — losing it silently is how an instrument
 * reports nothing wrong about the things it failed to look at. Note that `from`/`to`
 * are frequently prose rather than paths; `unresolved` therefore means «not a file in
 * any candidate root», which is a category, not an accusation.
 */
export function resolveDeclaredPath({ raw, rewrites, treeDir, plansDir, fsImpl } = {}) {
  const fs = makeFs(fsImpl)
  const declared = String(raw ?? '')
  const { value: rewritten, applied } = applyRewrites(declared, rewrites)

  const candidates = []
  if (isAbsolute(rewritten)) {
    candidates.push({ root: 'absolute', path: rewritten })
  } else {
    for (const c of CANDIDATE_ROOTS) {
      const root = c.of({ treeDir, plansDir })
      if (!root) continue
      candidates.push({ root: c.name, path: join(root, rewritten) })
    }
  }

  let resolved = null
  let resolvedBy = null
  for (const c of candidates) {
    let ok = false
    try {
      ok = !!fs.existsSync(c.path)
    } catch {
      ok = false
    }
    if (ok) {
      resolved = c.path
      resolvedBy = c.root
      break
    }
  }

  return {
    declared,
    rewritten,
    rewriteApplied: applied ? { prefix: applied.prefix, target: applied.target } : null,
    candidates,
    resolved,
    resolvedBy,
    status: resolved ? 'resolved' : 'unresolved',
  }
}

/**
 * compilePattern(pattern) -> {source, regex|null, error|null}. A trace is external data
 * written by a human years ago; an unparseable one is MARKED, never thrown and never
 * dropped. Compiling is not running: bounding the cost of a hostile pattern belongs to
 * whoever executes it, not to the step that only reads the declaration.
 */
export function compilePattern(pattern) {
  const source = String(pattern ?? '')
  if (!source) return { source, regex: null, error: 'empty pattern' }
  try {
    return { source, regex: new RegExp(source), error: null }
  } catch (err) {
    return { source, regex: null, error: `unparseable pattern: ${err && err.message}` }
  }
}

/**
 * planStatus({planPath, fsImpl}) -> {status, summaryPath}. THE discriminator, and the
 * only one: paired summary present -> closed; absent -> the work is ahead. Deliberately
 * consults nothing else.
 */
export function planStatus({ planPath, fsImpl } = {}) {
  const fs = makeFs(fsImpl)
  const summaryPath = summaryPathFor(planPath)
  let exists = false
  try {
    exists = !!summaryPath && !!fs.existsSync(summaryPath)
  } catch {
    exists = false
  }
  return {
    status: exists ? PLAN_STATUS.closed : PLAN_STATUS.ahead,
    summaryPath: exists ? summaryPath : null,
  }
}

/**
 * collectInventory({plansDir, treeDir, roots, rewrites, fsImpl}) -> the inventory.
 *
 * One pass over a plans tree producing, per plan: its status by the paired-summary
 * discriminator, its structured links, its artifact records, its prose lines (counted,
 * never scored), and the resolution of every path it names. Plus two honesty side
 * numbers: how many plans carry a prohibitions block (NOT checked here — naming a second
 * unverified corpus without pretending to have verified it) and how many summaries stand
 * with no plan beside them.
 *
 * Renders NO verdict. Nothing here decides whether a wire is alive.
 */
export function collectInventory({ plansDir, treeDir, roots, rewrites, fsImpl } = {}) {
  const fs = makeFs(fsImpl)
  const errors = []

  const planPaths = listPlanFiles(plansDir, PLAN_SUFFIX, fs)
  const summaryPaths = listPlanFiles(plansDir, SUMMARY_SUFFIX, fs)

  const scanFiles = collectScanFiles({ roots, treeDir, plansDir, fsImpl })

  const plans = []
  const links = []
  const artifacts = []
  const prose = []
  const patternless = []
  const prohibitionsPlans = []

  const resolvePath = (raw) => resolveDeclaredPath({ raw, rewrites, treeDir, plansDir, fsImpl })

  for (const planPath of planPaths) {
    const { status, summaryPath } = planStatus({ planPath, fsImpl })
    const id = planIdFromPath(planPath)
    plans.push({ path: planPath, id, status, summaryPath })

    // ONE reader for the whole inventory. A second hand-rolled scan would become a
    // second source of truth and drift from the plans by the next morning.
    const linkRead = parseFrontmatterEntries(planPath, KEY_LINKS_KEY, {
      readFn: fs.readFileSync,
      scalars: true,
    })
    if (linkRead.error) errors.push({ plan: planPath, key: KEY_LINKS_KEY, error: linkRead.error })

    for (const entry of linkRead.entries) {
      if (typeof entry === 'string') {
        // Form 3: a wire written in words. Named in the data, a number in the report,
        // never a pass and never a failure — a machine cannot check a sentence.
        prose.push({ plan: planPath, planId: id, planStatus: status, text: entry })
        continue
      }
      if (!entry || entry.pattern == null || entry.pattern === '') {
        // A record without a trace: neither structured enough to check nor prose.
        // Kept as its own category so it is never counted as either.
        patternless.push({ plan: planPath, planId: id, planStatus: status, entry })
        continue
      }
      const compiled = compilePattern(entry.pattern)
      links.push({
        plan: planPath,
        planId: id,
        planStatus: status,
        from: entry.from ?? null,
        to: entry.to ?? null,
        via: entry.via ?? null,
        pattern: compiled.source,
        patternError: compiled.error,
        fromPath: entry.from == null ? null : resolvePath(entry.from),
        toPath: entry.to == null ? null : resolvePath(entry.to),
      })
    }

    const artRead = parseFrontmatterEntries(planPath, ARTIFACTS_KEY, { readFn: fs.readFileSync })
    if (artRead.error) errors.push({ plan: planPath, key: ARTIFACTS_KEY, error: artRead.error })
    for (const entry of artRead.entries) {
      if (!entry || typeof entry !== 'object' || entry.path == null) continue
      artifacts.push({
        plan: planPath,
        planId: id,
        planStatus: status,
        declaredPath: String(entry.path),
        contains: entry.contains == null || entry.contains === '' ? null : String(entry.contains),
        resolution: resolvePath(entry.path),
      })
    }

    const prohRead = parseFrontmatterEntries(planPath, PROHIBITIONS_KEY, {
      readFn: fs.readFileSync,
      scalars: true,
    })
    if (prohRead.entries.length) prohibitionsPlans.push(planPath)
  }

  const planIds = new Set(plans.map((p) => p.id))
  const orphanSummaries = summaryPaths.filter((s) => !planIds.has(planIdFromPath(s)))

  return {
    plansDir: plansDir ?? null,
    treeDir: treeDir ?? null,
    roots: Array.isArray(roots) && roots.length ? [...roots] : [...DEFAULT_SCAN_ROOTS],
    rewrites: Array.isArray(rewrites) ? [...rewrites] : [],
    plans,
    summaries: summaryPaths,
    orphanSummaries,
    prohibitionsPlans,
    links,
    artifacts,
    prose,
    patternless,
    scanFiles,
    errors,
    counts: {
      plans: plans.length,
      plansClosed: plans.filter((p) => p.status === PLAN_STATUS.closed).length,
      plansAhead: plans.filter((p) => p.status === PLAN_STATUS.ahead).length,
      summaries: summaryPaths.length,
      orphanSummaries: orphanSummaries.length,
      prohibitionsPlans: prohibitionsPlans.length,
      links: links.length,
      linksWithBadPattern: links.filter((l) => l.patternError).length,
      artifacts: artifacts.length,
      artifactsUnresolved: artifacts.filter((a) => a.resolution.status === 'unresolved').length,
      prose: prose.length,
      patternless: patternless.length,
      scanFiles: scanFiles.length,
    },
  }
}
