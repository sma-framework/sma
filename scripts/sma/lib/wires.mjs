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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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
 * isWithinTree(candidate, treeDir) — THE CONTAINMENT RULE, and the reason it is exported.
 *
 * This instrument used to answer «the path resolves» by asking the filesystem, with no
 * boundary at all. On a machine that keeps sibling working copies next to the one under
 * test, a declaration pointing at a sibling resolved; on a clean clone the very same
 * declaration did not. That makes the verdict a fact about the LAPTOP rather than about
 * the product — which is precisely the class of defect this instrument exists to catch,
 * reappearing inside the judge itself.
 *
 * So: nothing outside the tree under measurement is touched. Not read, not statted, not
 * even asked whether it exists. Containment is decided by path arithmetic ALONE, before
 * any filesystem call, so the answer is identical on every machine — including one where
 * no sibling copy exists at all.
 *
 * A boundary of null means «no tree stated»: the caller gets the old unbounded behaviour
 * and the report says so, because an unbounded run is not a reproducible one.
 */
export function isWithinTree(candidate, treeDir) {
  if (!treeDir) return true
  return isUnder(candidate, treeDir)
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

  // A declared root that escapes the tree under measurement is REFUSED, not walked. An
  // overridden root set is caller input, and caller input that reads `../` walks straight
  // into somebody else's working copy — the one thing this instrument must never do.
  for (const r of list) {
    const p = isAbsolute(String(r)) ? String(r) : join(base, String(r))
    if (!isWithinTree(p, treeDir ?? null)) continue
    walk(p)
  }
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
 * parseRewriteRules(text) -> {rules, errors}. One `prefix=target` per line; blank lines
 * and `#` comments are skipped, order is preserved because the first match wins.
 *
 * WHY A FILE AT ALL. Until this existed the rules were typed by hand into the command
 * line on every run, and that quietly made the headline number a fact about the typing
 * rather than about the product: the same tree scored one way with four rules and quite
 * another with none, and nothing anywhere recorded which set was the intended one. «Zero
 * red» without a written-down set of rules is a number about nothing — so the set gets a
 * file, the file gets a parser, and the parser refuses to guess.
 *
 * MALFORMED INPUT STOPS THE RUN, it is never skipped. A dropped rule does not announce
 * itself: it turns into a pile of paths «outside the tree», which reads exactly like an
 * honest measurement of a tree that has moved. The line number travels with every
 * complaint for the same reason it does in the verdict journal — «your file is malformed»
 * without a line is a dead end.
 *
 * An empty target is LEGAL and means «strip the prefix» (`applyRewrites` implements it):
 * that is how a declaration written against a sibling checkout is read against this one.
 *
 * Parsing only. Reading the file off disk belongs to the caller — this module has no
 * business knowing where a workshop keeps its rules, and by house law that file lives in
 * the workshop and is never shipped with the product.
 */
export function parseRewriteRules(text) {
  const rules = []
  const errors = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1
    const t = lines[i].trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=') // split on the FIRST equals: a target path may contain more
    if (eq < 0) {
      errors.push({ line, error: `the rule names no target: expected «prefix=target», got ${JSON.stringify(t)}` })
      continue
    }
    const prefix = t.slice(0, eq).trim()
    const target = t.slice(eq + 1).trim()
    if (!prefix) {
      errors.push({ line, error: 'the rule names no prefix — a rule that matches everything is not a rule' })
      continue
    }
    rules.push({ prefix, target })
  }
  return { rules, errors }
}

/**
 * resolveDeclaredPath({raw, rewrites, treeDir, plansDir, fsImpl}) -> resolution record.
 *
 * Rewrite first, then try the declared candidate roots in order. A path that resolves
 * nowhere is marked `unresolved` and KEPT — losing it silently is how an instrument
 * reports nothing wrong about the things it failed to look at. Note that `from`/`to`
 * are frequently prose rather than paths; `unresolved` therefore means «not a file in
 * any candidate root», which is a category, not an accusation.
 *
 * THE THIRD STATUS: `outside-tree`. Every candidate is tested for containment in the
 * tree under measurement BEFORE the filesystem is consulted, and a candidate that lands
 * outside is skipped without a single existence check. When no candidate lands inside at
 * all, the declaration is not judged: it is neither green nor red, it is «this run cannot
 * see there». That is an honest third answer, and it is the only one that reads the same
 * on a machine with sibling working copies and on a clean clone.
 *
 * Note the asymmetry, which is deliberate: ONE candidate inside the tree is enough to
 * make the path judgeable, because the outer candidates of a workshop layout are almost
 * always outside by construction. Only a declaration with NOWHERE to look inside the
 * tree becomes `outside-tree`.
 */
export function resolveDeclaredPath({ raw, rewrites, treeDir, plansDir, fsImpl, containWithin } = {}) {
  const fs = makeFs(fsImpl)
  const declared = String(raw ?? '')
  const { value: rewritten, applied } = applyRewrites(declared, rewrites)
  const boundary = containWithin === undefined ? (treeDir ?? null) : containWithin

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
  for (const c of candidates) c.inside = isWithinTree(c.path, boundary)

  let resolved = null
  let resolvedBy = null
  for (const c of candidates) {
    if (!c.inside) continue // never touched: no existsSync, no stat, no read
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

  const anyInside = candidates.some((c) => c.inside)
  return {
    declared,
    rewritten,
    rewriteApplied: applied ? { prefix: applied.prefix, target: applied.target } : null,
    candidates,
    boundary: boundary ? resolve(String(boundary)) : null,
    resolved,
    resolvedBy,
    status: resolved ? 'resolved' : anyInside ? 'unresolved' : 'outside-tree',
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
      artifactsOutsideTree: artifacts.filter((a) => a.resolution.status === 'outside-tree').length,
      prose: prose.length,
      patternless: patternless.length,
      scanFiles: scanFiles.length,
    },
  }
}

/* ==========================================================================
 * THE SCORING HALF — the verdict engine.
 *
 * Everything above paints nothing. This half does, and it is built against ONE
 * measured danger: on a mature tree «zero failures» is reachable in an evening
 * and worth nothing, because a third of all declared traces occur in more than
 * twenty files — the worst of them is three letters long and occurs in 643. An
 * instrument that only knows how to go green is worse than no instrument at
 * all: it manufactures confidence.
 *
 * FOUR TIERS, in descending strength:
 *   1. THE NAMED FILE. When `from` (or, failing that, `to`) resolves to a real
 *      file, the trace is looked for IN THAT FILE. A trace alive somewhere else
 *      in the tree does NOT save the record — that difference is exactly what
 *      separates a working wire from one that moved out from under its own
 *      declaration.
 *   2. ARTIFACT `path` + `contains` — a needle pinned to a named file, and the
 *      stronger of the two declared forms.
 *   3. WIDTH. A trace occurring in more files than the broad limit is neither
 *      green nor red: it is YELLOW — «too wide to be evidence». The declaration
 *      is unfit, and only a human can say what it should have been.
 *   4. THE TEST TRACE — counted only, never a verdict. Repairing those wires is
 *      its own body of work; the instrument NAMES it instead of doing it.
 *
 * Red is extinguished by exactly one thing: a written verdict carrying an author
 * and a reason. And an inventory from which nothing parsed at all is a BREAKAGE
 * (exit 2) — never a report of «zero failures».
 * ========================================================================== */

/**
 * How many files a trace may occur in and still be evidence of anything.
 *
 * Twenty is a judgement call, so it is a DECLARED one: exported, overridable and
 * printed in every report. An unwritten threshold is how three runs of the same
 * probe produced three different totals.
 */
export const DEFAULT_BROAD_LIMIT = 20

/**
 * The closed vocabulary of human verdicts. Closed on purpose: a free-text verdict
 * field would within a month hold thirty spellings of «fine as is», and «fine as
 * is» is precisely the answer this instrument exists to stop being possible for
 * free. Each entry carries its machine name and the word the report prints.
 */
export const VERDICT_KINDS = Object.freeze({
  renamed: Object.freeze({
    id: 'renamed',
    en: 'renamed — the declaration lagged behind the code',
    ru: 'переименовано',
  }),
  misdeclared: Object.freeze({
    id: 'misdeclared',
    en: 'misdeclared — this record never belonged in the inventory in this shape',
    ru: 'кривое объявление',
  }),
  'regression-filed': Object.freeze({
    id: 'regression-filed',
    en: 'regression — the repair is filed as its own work',
    ru: 'регресс — работа заведена',
  }),
  deferred: Object.freeze({
    id: 'deferred',
    en: 'deferred — decided, with the reason stated in the rationale',
    ru: 'отложено',
  }),
})

/** Why a record is red. Grouping by reason is what lets a human CONFIRM rather than investigate. */
export const RED_REASONS = Object.freeze({
  'trace-missing-everywhere': Object.freeze({
    id: 'trace-missing-everywhere',
    en: 'the trace is nowhere in the search zone',
    ru: 'след не найден нигде',
  }),
  'trace-missing-in-named-file': Object.freeze({
    id: 'trace-missing-in-named-file',
    en: 'the trace is absent from the file the declaration itself names (it is alive elsewhere — a move or a bad declaration)',
    ru: 'следа нет в названном файле',
  }),
  'needle-missing-in-file': Object.freeze({
    id: 'needle-missing-in-file',
    en: 'the artifact file exists with none of the declared work in it',
    ru: 'игла отсутствует в существующем файле',
  }),
  'path-unresolved': Object.freeze({
    id: 'path-unresolved',
    en: 'the declared path resolves in no candidate tree',
    ru: 'путь не резолвится ни в одном дереве',
  }),
})

/** Not proof, and not an accusation either. Visible by count AND by name — never swallowed. */
export const YELLOW_REASONS = Object.freeze({
  broad: Object.freeze({
    id: 'broad',
    en: 'the trace is too wide to be evidence',
    ru: 'след слишком широк — доказательством не является',
  }),
  prose: Object.freeze({
    id: 'prose',
    en: 'the wire is written in words — no machine can check a sentence',
    ru: 'проза — машиной не проверяется',
  }),
  'no-test-trace': Object.freeze({
    id: 'no-test-trace',
    en: 'the trace occurs in no test file anywhere in the tree',
    ru: 'след не встречается ни в одном тестовом файле',
  }),
  'pattern-unparseable': Object.freeze({
    id: 'pattern-unparseable',
    en: 'the declared trace does not compile — there is nothing to check with',
    ru: 'след не компилируется — проверять нечем',
  }),
  patternless: Object.freeze({
    id: 'patternless',
    en: 'the record declares no trace at all — there is nothing to check',
    ru: 'объявление без следа — проверять нечего',
  }),
  'artifact-no-needle': Object.freeze({
    id: 'artifact-no-needle',
    en: 'the artifact record names a path and no needle — only existence was checked',
    ru: 'запись artifacts без иглы — проверено только существование файла',
  }),
})

/**
 * NEITHER GREEN NOR RED — its own named answer, visible as a number in every report.
 *
 * A declaration whose path, after root rewriting, leads outside the tree under
 * measurement cannot be judged by this run. Calling it green would be a verdict about
 * whichever working copies happen to lie beside this one; calling it red would accuse a
 * declaration of being wrong when the run simply was not allowed to look. Both answers
 * would move with the machine. The third answer does not.
 */
export const OUTSIDE_TREE = Object.freeze({
  id: 'outside-measured-tree',
  en: 'the declared path leads outside the tree under measurement — not looked at, and never counted as evidence',
  ru: 'путь вне измеряемого дерева — прибор туда не смотрит и в доказательство не берёт',
})

/** 0 — clean; 1 — red without a verdict; 2 — the inventory does not read at all. */
export const EXIT_CODES = Object.freeze({ clean: 0, red: 1, unreadable: 2 })

/**
 * The ceiling, printed in EVERY report rather than buried in a research note. An
 * instrument that lets its own output be read as proof of a working wire repeats,
 * on itself, the failure it was built to catch.
 */
export const HONEST_BOUNDARY =
  'What this proves: the declared trace is where the declaration says it is. What it does NOT prove: that the wire works. A string is not a call, a call is not a delivery, and a delivery is not the receiver reading it. Only a test that watches the RECEIVER proves a wire.'

/** A test file: a `__tests__` path segment, or `.test.` in the filename. */
export function isTestFile(p) {
  const s = String(p ?? '')
  if (/(^|[\\/])__tests__[\\/]/.test(s)) return true
  return /\.test\.[^\\/]+$/.test(basename(s))
}

/** Read a file as text, or null. A file that cannot be read is an absence, not an exception. */
function readText(fs, p) {
  try {
    return String(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** Plain string comparison — never localeCompare, whose order depends on the machine's locale. */
function cmp(a, b) {
  const x = String(a ?? '')
  const y = String(b ?? '')
  return x < y ? -1 : x > y ? 1 : 0
}

function byKey(keyOf) {
  return (a, b) => cmp(keyOf(a), keyOf(b))
}

/** A path shown relative to the tree under test, so the report does not move with the checkout. */
function display(treeDir, p) {
  if (!p) return null
  if (!treeDir) return String(p)
  const rel = relative(treeDir, String(p))
  return !rel || rel.startsWith('..') ? String(p) : rel.split(sep).join('/')
}

/**
 * validateVerdictRecord(rec, line) -> {record|null, errors}
 *
 * THE most dangerous surface of the whole instrument: a verdict is what turns red
 * into silence. So a verdict without an AUTHOR or without a REASON is not a lenient
 * verdict — it is malformed input, and the instrument STOPS rather than quietly
 * extinguishing a finding on nobody's authority.
 */
export function validateVerdictRecord(rec, line = null) {
  const errors = []
  const at = (msg) => errors.push({ line, error: msg })

  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    at('the verdict is not an object')
    return { record: null, errors }
  }

  const kind = rec.kind === 'link' || rec.kind === 'artifact' ? rec.kind : null
  if (!kind) at(`the record kind is not named: expected "link" or "artifact", got ${JSON.stringify(rec.kind ?? null)}`)

  const plan = rec.plan == null ? '' : String(rec.plan).trim()
  if (!plan) at('the verdict names no plan')

  const pattern = rec.pattern == null ? '' : String(rec.pattern)
  const path = rec.path == null ? '' : String(rec.path)
  if (kind === 'link' && !pattern) at('a link verdict carries no trace (pattern)')
  if (kind === 'artifact' && !path) at('an artifact verdict carries no path')

  const verdictId = rec.verdict == null ? '' : String(rec.verdict).trim()
  if (!VERDICT_KINDS[verdictId]) {
    at(
      `the verdict is outside the closed vocabulary (${Object.keys(VERDICT_KINDS).join(', ')}), got ${JSON.stringify(
        rec.verdict ?? null,
      )}`,
    )
  }

  const author = rec.author == null ? '' : String(rec.author).trim()
  if (!author) at('a verdict with no author is malformed — red is never extinguished on nobody’s authority')

  const rationale = rec.rationale == null ? '' : String(rec.rationale).trim()
  if (!rationale) at('a verdict with no rationale is malformed — «fine as is» is not a reason')

  if (errors.length) return { record: null, errors }

  return {
    record: {
      line,
      kind,
      plan,
      pattern: pattern || null,
      path: path || null,
      contains: rec.contains == null || rec.contains === '' ? null : String(rec.contains),
      verdict: verdictId,
      author,
      date: rec.date == null ? null : String(rec.date),
      rationale,
    },
    errors: [],
  }
}

/**
 * parseVerdicts(text) -> {records, errors}. One JSON object per line; blank lines and
 * `#` comments are skipped. The line number travels with every complaint, because
 * «your verdicts file is malformed» without a line number is a dead end.
 *
 * Parsing only. Reading the file off disk belongs to the caller — this module has no
 * business knowing where a workshop keeps its journal.
 */
export function parseVerdicts(text) {
  const records = []
  const errors = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1
    const t = lines[i].trim()
    if (!t || t.startsWith('#')) continue
    let raw
    try {
      raw = JSON.parse(t)
    } catch (err) {
      errors.push({ line, error: `the line does not parse as JSON: ${err && err.message}` })
      continue
    }
    const { record, errors: bad } = validateVerdictRecord(raw, line)
    if (bad.length) errors.push(...bad)
    else records.push(record)
  }
  return { records, errors }
}

/** Verdicts may arrive as raw JSONL text, as an array of records, or already parsed. */
function normalizeVerdicts(verdicts) {
  if (verdicts == null) return { records: [], errors: [] }
  if (typeof verdicts === 'string') return parseVerdicts(verdicts)
  if (Array.isArray(verdicts)) {
    const records = []
    const errors = []
    verdicts.forEach((rec, i) => {
      const { record, errors: bad } = validateVerdictRecord(rec, rec && rec.line != null ? rec.line : i + 1)
      if (bad.length) errors.push(...bad)
      else records.push(record)
    })
    return { records, errors }
  }
  if (Array.isArray(verdicts.records)) {
    return { records: [...verdicts.records], errors: [...(verdicts.errors ?? [])] }
  }
  return { records: [], errors: [{ line: null, error: 'the verdicts argument is of no recognised shape' }] }
}

/**
 * The files a declaration NAMES. A named file is searched directly; a named directory
 * is narrowed to the files of the search zone underneath it — still narrowing, just
 * coarser. Neither resolving means there is no named place and the tree-wide tier
 * applies.
 */
function namedTargets(resolution, scanFiles, fs) {
  if (!resolution || resolution.status !== 'resolved' || !resolution.resolved) return null
  let st
  try {
    st = fs.statSync(resolution.resolved)
  } catch {
    return null
  }
  if (st.isFile()) return [resolution.resolved]
  if (st.isDirectory()) {
    const under = scanFiles.filter((f) => isUnder(f, resolution.resolved))
    return under.length ? under : null
  }
  return null
}

/**
 * evaluateInventory({inventory, treeDir, roots, broadLimit, verdicts, fsImpl}) -> evaluation.
 *
 * The verdict engine. Reads the search zone once, scores every structural link and every
 * artifact record, applies the human verdicts, and returns categories, counts and an exit
 * code. Writes nothing, prints nothing, shells nothing.
 *
 * Green is deliberately EXPENSIVE and costs two things at once: the trace must be in the
 * named place (when the declaration names one), AND the trace must be specific enough to
 * mean anything (tree width at or under the limit). Miss either and the record is not
 * green — it is red where the evidence is absent, yellow where the evidence is worthless.
 */
export function evaluateInventory({ inventory, treeDir, roots, broadLimit, verdicts, fsImpl } = {}) {
  const fs = makeFs(fsImpl)
  const inv = inventory ?? {}
  const tree = treeDir ?? inv.treeDir ?? null
  const plansDir = inv.plansDir ?? null
  const declaredRoots =
    Array.isArray(roots) && roots.length ? [...roots] : [...(inv.roots ?? DEFAULT_SCAN_ROOTS)]
  const parsedLimit = Number(broadLimit)
  const limit = Number.isFinite(parsedLimit) && parsedLimit >= 0 ? parsedLimit : DEFAULT_BROAD_LIMIT

  // Which declared roots are actually there. A root that silently was not walked is how
  // a report about nothing looks exactly like a report about everything.
  const rootsPresent = []
  const rootsMissing = []
  const rootsRefused = []
  for (const r of declaredRoots) {
    const p = isAbsolute(String(r)) ? String(r) : join(tree ?? '.', String(r))
    // A root that escapes the tree is refused by arithmetic, before any existence check:
    // the walk already declines it, and the header must say so rather than call it absent.
    if (!isWithinTree(p, tree)) {
      rootsRefused.push(String(r))
      continue
    }
    let ok = false
    try {
      ok = !!fs.existsSync(p)
    } catch {
      ok = false
    }
    ;(ok ? rootsPresent : rootsMissing).push(String(r))
  }

  const { records: verdictRecords, errors: verdictErrors } = normalizeVerdicts(verdicts)

  const links = Array.isArray(inv.links) ? inv.links : []
  const artifactRecords = Array.isArray(inv.artifacts) ? inv.artifacts : []
  const scanFiles = Array.isArray(inv.scanFiles) ? inv.scanFiles : []

  // ---- one pass over the search zone, counting every distinct trace -------------
  const index = new Map()
  for (const l of links) {
    if (l.patternError) continue
    if (index.has(l.pattern)) continue
    const compiled = compilePattern(l.pattern)
    if (!compiled.regex) continue
    index.set(l.pattern, { regex: compiled.regex, count: 0, capped: false, files: [], testHit: false })
  }
  for (const f of scanFiles) {
    if (!index.size) break
    const inTest = isTestFile(f)
    let text
    let read = false
    for (const rec of index.values()) {
      const needWidth = rec.count <= limit // once past the limit the exact number stops mattering
      const needTest = inTest && !rec.testHit
      if (!needWidth && !needTest) continue
      if (!read) {
        text = readText(fs, f)
        read = true
      }
      if (text == null) break
      if (rec.regex.test(text)) {
        rec.count += 1
        if (rec.files.length <= limit) rec.files.push(f)
        if (inTest) rec.testHit = true
      }
    }
  }
  for (const rec of index.values()) rec.capped = rec.count > limit

  const green = []
  const red = []
  const ahead = []
  // Declared paths this run is not allowed to look at. Its own list, counted separately,
  // because folding it into either colour would put the machine's directory layout into
  // the verdict.
  const outside = []
  const yellow = {
    broad: [],
    prose: [],
    noTestTrace: [],
    patternUnparseable: [],
    patternless: [],
    artifactNoNeedle: [],
  }

  // ---- structural links ---------------------------------------------------------
  for (const link of links) {
    const base = {
      kind: 'link',
      plan: link.plan,
      planId: link.planId,
      pattern: link.pattern,
      from: link.from,
      to: link.to,
      via: link.via,
    }

    if (link.planStatus !== PLAN_STATUS.closed) {
      // No summary beside the plan: the work is still ahead. SILENCE — not green, and
      // certainly not red. Judging unfinished work is how an instrument earns a
      // reputation for crying wolf; calling it green is how it earns a worse one.
      ahead.push({ ...base, category: 'ahead' })
      continue
    }

    if (link.patternError) {
      yellow.patternUnparseable.push({ ...base, category: 'yellow', reason: 'pattern-unparseable', detail: link.patternError })
      continue
    }

    const idx = index.get(link.pattern)
    const treeCount = idx ? idx.count : 0
    const tooWide = treeCount > limit

    // BOTH named ends, not the first one that happens to resolve. A wire's trace is the
    // marker of a JOINT: it is what the caller writes and what the receiver answers to,
    // so a trace present at one end and absent at the other is a half-connected wire and
    // is reported as such. Taking the first resolving end instead was measured against
    // this tree and let eighteen records through — which is exactly how strictness gets
    // lowered by accident and «zero failures» gets cheap.
    // Ends that point out of the tree are NAMED before scoring. The link itself is still
    // judged — by the tree-wide tier, which searches only inside the tree — but the report
    // must be able to say how much of the inventory declared a place this run cannot see.
    for (const [role, res] of [['from', link.fromPath], ['to', link.toPath]]) {
      if (res && res.status === 'outside-tree') {
        outside.push({
          kind: 'link',
          plan: link.plan,
          planId: link.planId,
          role,
          declared: res.declared,
          rewritten: res.rewritten,
          rewriteApplied: res.rewriteApplied,
          // The record is not dropped: the tree-wide tier still scores it, with no help
          // from any neighbouring copy.
          stillScored: true,
        })
      }
    }

    const fromTargets = namedTargets(link.fromPath, scanFiles, fs)
    const toTargets = namedTargets(link.toPath, scanFiles, fs)
    const namedSides = []
    if (fromTargets) namedSides.push('from')
    if (toTargets) namedSides.push('to')
    const targets = namedSides.length ? [...new Set([...(fromTargets ?? []), ...(toTargets ?? [])])].sort(cmp) : null

    const record = {
      ...base,
      namedSides,
      namedFiles: targets ?? [],
      missingIn: [],
      treeFiles: treeCount,
      treeFilesCapped: !!(idx && idx.capped),
      sampleFiles: idx ? [...idx.files].sort(cmp).slice(0, 5) : [],
      testTrace: !!(idx && idx.testHit),
    }

    if (targets) {
      // Named by the human, missing the trace — listed by name, because «somewhere among
      // the files you named» is a research assignment, not a finding.
      record.missingIn = targets.filter((t) => {
        const text = readText(fs, t)
        return !(text != null && idx.regex.test(text))
      })
      if (!record.missingIn.length) {
        // Present at every end it was promised at — but a trace occurring all over the
        // tree proves nothing about anything, no matter which file it was found in.
        if (tooWide) yellow.broad.push({ ...record, category: 'yellow', reason: 'broad' })
        else green.push({ ...record, category: 'green', evidence: 'named-file' })
      } else if (treeCount === 0) {
        red.push({ ...record, category: 'red', reason: 'trace-missing-everywhere' })
      } else {
        // THE NARROWING. Alive elsewhere does not save the record: the declaration
        // named a file, and that file does not carry the work.
        red.push({ ...record, category: 'red', reason: 'trace-missing-in-named-file' })
      }
    } else if (treeCount === 0) {
      red.push({ ...record, category: 'red', reason: 'trace-missing-everywhere' })
    } else if (tooWide) {
      yellow.broad.push({ ...record, category: 'yellow', reason: 'broad' })
    } else {
      green.push({ ...record, category: 'green', evidence: 'tree-narrow' })
    }

    // The fourth tier. Counted and named — never a verdict, because repairing these
    // wires is a body of work of its own and the instrument is not doing it here.
    if (!record.testTrace) yellow.noTestTrace.push({ ...record, category: 'yellow', reason: 'no-test-trace' })
  }

  // ---- artifact records (path + contains) ---------------------------------------
  for (const art of artifactRecords) {
    const base = {
      kind: 'artifact',
      plan: art.plan,
      planId: art.planId,
      declaredPath: art.declaredPath,
      contains: art.contains,
      resolved: art.resolution ? art.resolution.resolved : null,
    }

    if (art.planStatus !== PLAN_STATUS.closed) {
      ahead.push({ ...base, category: 'ahead' })
      continue
    }
    if (art.resolution && art.resolution.status === 'outside-tree') {
      // Not red. The declaration names a place this run refuses to look at, and an
      // accusation built on a directory that may or may not exist beside this checkout
      // is not a finding — it is the machine talking.
      outside.push({
        kind: 'artifact',
        plan: art.plan,
        planId: art.planId,
        role: 'path',
        declared: art.resolution.declared,
        rewritten: art.resolution.rewritten,
        rewriteApplied: art.resolution.rewriteApplied,
        contains: art.contains,
        stillScored: false,
      })
      continue
    }
    if (!art.resolution || art.resolution.status !== 'resolved') {
      red.push({ ...base, category: 'red', reason: 'path-unresolved' })
      continue
    }
    if (!art.contains) {
      yellow.artifactNoNeedle.push({ ...base, category: 'yellow', reason: 'artifact-no-needle' })
      continue
    }

    let st
    try {
      st = fs.statSync(art.resolution.resolved)
    } catch {
      st = null
    }
    const needle = String(art.contains)
    let found = false
    if (st && st.isDirectory()) {
      found = scanFiles
        .filter((f) => isUnder(f, art.resolution.resolved))
        .some((f) => {
          const text = readText(fs, f)
          return text != null && text.includes(needle)
        })
    } else {
      const text = readText(fs, art.resolution.resolved)
      found = text != null && text.includes(needle)
    }

    if (found) green.push({ ...base, category: 'green', evidence: 'artifact-needle' })
    else red.push({ ...base, category: 'red', reason: 'needle-missing-in-file' })
  }

  // ---- prose and traceless records: counted, named, never scored ------------------
  for (const p of Array.isArray(inv.prose) ? inv.prose : []) {
    if (p.planStatus !== PLAN_STATUS.closed) {
      ahead.push({ kind: 'prose', plan: p.plan, planId: p.planId, text: p.text, category: 'ahead' })
      continue
    }
    yellow.prose.push({ kind: 'prose', plan: p.plan, planId: p.planId, text: p.text, category: 'yellow', reason: 'prose' })
  }
  for (const p of Array.isArray(inv.patternless) ? inv.patternless : []) {
    yellow.patternless.push({
      kind: 'patternless',
      plan: p.plan,
      planId: p.planId,
      entry: p.entry,
      category: 'yellow',
      reason: 'patternless',
    })
  }

  // ---- human verdicts: the only thing that puts a red out -------------------------
  const keyOfRed = (r) =>
    r.kind === 'link'
      ? `link|${r.planId}|${r.pattern}`
      : `artifact|${r.planId}|${r.declaredPath}|${r.contains ?? ''}`
  const keyOfVerdict = (v) =>
    v.kind === 'link' ? `link|${v.plan}|${v.pattern}` : `artifact|${v.plan}|${v.path}|${v.contains ?? ''}`
  const loose = (v) => `artifact|${v.plan}|${v.path}`
  const looseRed = (r) => `artifact|${r.planId}|${r.declaredPath}`

  const byExact = new Map()
  const byLoose = new Map()
  for (const r of red) {
    const k = keyOfRed(r)
    if (!byExact.has(k)) byExact.set(k, [])
    byExact.get(k).push(r)
    if (r.kind === 'artifact') {
      const lk = looseRed(r)
      if (!byLoose.has(lk)) byLoose.set(lk, [])
      byLoose.get(lk).push(r)
    }
  }

  const reviewed = []
  const stale = []
  const claimed = new Set()
  for (const v of verdictRecords) {
    let matches = byExact.get(keyOfVerdict(v))
    if ((!matches || !matches.length) && v.kind === 'artifact' && !v.contains) matches = byLoose.get(loose(v))
    const fresh = (matches ?? []).filter((m) => !claimed.has(m))
    if (!fresh.length) {
      // A verdict matching no current red. It is NOT silently dropped: either the red it
      // spoke about is genuinely gone (good news, and the journal should be pruned) or the
      // verdict names something that never existed (bad news, and it is hiding nothing).
      stale.push({ ...v, category: 'stale' })
      continue
    }
    for (const m of fresh) {
      claimed.add(m)
      reviewed.push({
        ...m,
        category: 'reviewed',
        verdict: v.verdict,
        verdictLabel: VERDICT_KINDS[v.verdict] ? VERDICT_KINDS[v.verdict].ru : v.verdict,
        author: v.author,
        date: v.date,
        rationale: v.rationale,
        verdictLine: v.line,
      })
    }
  }
  const redRemaining = red.filter((r) => !claimed.has(r))

  // ---- determinism: every list ordered by plan, then by trace ---------------------
  const linkKey = (r) => `${r.planId ?? ''}|${r.pattern ?? r.declaredPath ?? r.text ?? ''}|${r.contains ?? ''}`
  green.sort(byKey(linkKey))
  redRemaining.sort(byKey((r) => `${r.reason}|${linkKey(r)}`))
  reviewed.sort(byKey(linkKey))
  ahead.sort(byKey(linkKey))
  stale.sort(byKey((v) => `${v.plan}|${v.pattern ?? v.path ?? ''}`))
  outside.sort(byKey((r) => `${r.planId ?? ''}|${r.role}|${r.declared ?? ''}`))
  for (const k of Object.keys(yellow)) yellow[k].sort(byKey(linkKey))

  const redByReason = {}
  for (const id of Object.keys(RED_REASONS)) {
    const bucket = redRemaining.filter((r) => r.reason === id)
    if (bucket.length) redByReason[id] = bucket.length
  }

  // ---- THE LOCK AGAINST EMPTINESS -------------------------------------------------
  // An inventory that parsed nothing is a BREAKAGE, not a clean bill of health. This is
  // the single line standing between this instrument and the failure it was built to
  // catch: a guard whose pattern stopped matching goes green in perfect silence.
  const parsedNothing = links.length + artifactRecords.length === 0
  const exitCode = parsedNothing || verdictErrors.length
    ? EXIT_CODES.unreadable
    : redRemaining.length
      ? EXIT_CODES.red
      : EXIT_CODES.clean

  return {
    treeDir: tree,
    plansDir,
    roots: { declared: declaredRoots, present: rootsPresent, missing: rootsMissing, refused: rootsRefused },
    rewrites: Array.isArray(inv.rewrites) ? [...inv.rewrites] : [],
    broadLimit: limit,
    green,
    red: redRemaining,
    reviewed,
    ahead,
    outside,
    yellow,
    staleVerdicts: stale,
    verdictErrors,
    parsedNothing,
    exitCode,
    counts: {
      green: green.length,
      red: redRemaining.length,
      redByReason,
      reviewed: reviewed.length,
      ahead: ahead.length,
      outsideTree: outside.length,
      outsideTreeUnjudged: outside.filter((o) => !o.stillScored).length,
      broad: yellow.broad.length,
      prose: yellow.prose.length,
      noTestTrace: yellow.noTestTrace.length,
      patternUnparseable: yellow.patternUnparseable.length,
      patternless: yellow.patternless.length,
      artifactNoNeedle: yellow.artifactNoNeedle.length,
      verdicts: verdictRecords.length,
      staleVerdicts: stale.length,
      verdictErrors: verdictErrors.length,
      links: links.length,
      artifacts: artifactRecords.length,
      scanFiles: scanFiles.length,
    },
  }
}

/**
 * countRedWithoutVerdict(evaluation) -> number. The scoring contract of the neighbouring
 * verbs: ONE number, printed by the caller as the last line, so a script can read the
 * state of the tree without parsing prose.
 */
export function countRedWithoutVerdict(evaluation) {
  return evaluation && Array.isArray(evaluation.red) ? evaluation.red.length : 0
}

/** The machine view: every category in full, including the yellow ones the text only counts. */
export function toJson(evaluation) {
  if (!evaluation) return null
  return {
    treeDir: evaluation.treeDir,
    plansDir: evaluation.plansDir,
    roots: evaluation.roots,
    rewrites: evaluation.rewrites ?? [],
    broadLimit: evaluation.broadLimit,
    exitCode: evaluation.exitCode,
    counts: evaluation.counts,
    red: evaluation.red,
    reviewed: evaluation.reviewed,
    staleVerdicts: evaluation.staleVerdicts,
    verdictErrors: evaluation.verdictErrors,
    outsideTree: evaluation.outside ?? [],
    yellow: evaluation.yellow,
    ahead: evaluation.ahead,
    green: evaluation.green,
    honestBoundary: HONEST_BOUNDARY,
  }
}

/**
 * renderReport({treeDir, commit, plansDir, evaluation, inventory, roots, broadLimit}) -> string.
 *
 * Reproducible by construction: no clock, no unordered walk, no ambient state. Two calls
 * on the same data return the same bytes — which is the whole reason the header carries
 * the tree, its commit, the walk roots, the width threshold and the parse counts. «Zero
 * failures» without those five numbers is a number about nothing; this session watched a
 * base move by fifty commits inside twenty minutes.
 *
 * The commit is passed IN. This module does not shell out to a version-control tool, and
 * an unstated commit is printed as unstated rather than skipped.
 */
export function renderReport({
  treeDir,
  commit,
  plansDir,
  evaluation,
  inventory,
  roots,
  broadLimit,
  rewrites,
  rewriteSource,
} = {}) {
  const ev = evaluation ?? {}
  const inv = inventory ?? {}
  const tree = treeDir ?? ev.treeDir ?? inv.treeDir ?? null
  const plans = plansDir ?? ev.plansDir ?? inv.plansDir ?? null
  const limit = broadLimit ?? ev.broadLimit ?? DEFAULT_BROAD_LIMIT
  const declared = Array.isArray(roots) && roots.length ? roots : (ev.roots && ev.roots.declared) || inv.roots || []
  const missing = new Set((ev.roots && ev.roots.missing) || [])
  const refused = new Set((ev.roots && ev.roots.refused) || [])
  const rewriteRules = Array.isArray(rewrites) && rewrites.length ? rewrites : ev.rewrites || inv.rewrites || []
  const counts = ev.counts ?? {}
  const invCounts = inv.counts ?? {}
  const out = []
  const show = (p) => display(tree, p)

  // ---- header: the five numbers without which the body is unreproducible ----------
  out.push(`wires — tree ${tree ? resolve(tree) : '(tree not stated)'} @ ${commit ? String(commit) : 'commit not established'}`)
  out.push(`plans: ${plans ? resolve(plans) : '(plans directory not stated)'}`)
  out.push(
    `walk roots (${declared.length} declared, ${declared.length - missing.size - refused.size} present): ` +
      declared
        .map((r) =>
          refused.has(r)
            ? `${r} [outside the tree — REFUSED, not walked]`
            : missing.has(r)
              ? `${r} [absent — not walked]`
              : String(r),
        )
        .join(', '),
  )
  // The rewriting rules belong in the header for the same reason the roots do: they
  // decide which declarations are inside the tree at all, so «zero failures» read without
  // them is a number about an unknown mapping.
  //
  // AND SO DOES THEIR SOURCE. A rule set typed into the command line and a rule set read
  // from a file are two different claims about reproducibility: the first is a fact about
  // one person's shell history, the second is a fact anybody can re-run. Printing the
  // count without saying WHERE it came from leaves the reader unable to tell them apart,
  // which is the same failure as printing a verdict without its author.
  const srcSuffix = rewriteSource ? ` — source: ${rewriteSource}` : ''
  out.push(
    rewriteRules.length
      ? `root rewrites applied (${rewriteRules.length})${srcSuffix}: ` +
        rewriteRules.map((r) => `${r.prefix} → ${r.target || '(stripped)'}`).join(', ')
      : // No rules is a legitimate configuration, not a fault — but it is never silent: the
        // price of having none is stated in the same breath, as the number of declarations
        // this run is therefore not allowed to look at.
        `root rewrites applied: none${srcSuffix} — every declared path is read exactly as written; ` +
        `${counts.outsideTree ?? 0} declared paths lead outside the tree and are NOT looked at`,
  )
  out.push(
    `containment: only paths inside the tree above are examined; anything outside is NOT looked at${
      tree ? '' : ' — NO TREE STATED, so containment is off and this run is not reproducible'
    }`,
  )
  out.push(`broad-trace limit: ${limit} files — a trace found in more files is NOT evidence`)
  out.push(
    `parsed: ${invCounts.links ?? counts.links ?? 0} structural links, ` +
      `${invCounts.artifacts ?? counts.artifacts ?? 0} artifact records, ` +
      `${invCounts.prose ?? 0} prose lines, ${invCounts.patternless ?? 0} records without a trace`,
  )
  out.push(
    `plans: ${invCounts.plans ?? 0} total, ${invCounts.plansClosed ?? 0} with a summary (judged), ` +
      `${invCounts.plansAhead ?? 0} without one (not judged)`,
  )
  out.push(`plans carrying a prohibitions block: ${invCounts.prohibitionsPlans ?? 0} — NOT checked by this command`)
  out.push(`summaries with no plan beside them: ${invCounts.orphanSummaries ?? 0}`)
  out.push(`files in the search zone: ${counts.scanFiles ?? invCounts.scanFiles ?? 0}`)
  out.push('')

  // ---- body, in order of seriousness ---------------------------------------------
  if (ev.parsedNothing) {
    out.push('THE INVENTORY DOES NOT READ: not one structural link and not one artifact record parsed.')
    out.push('This is a breakage of the instrument or of the arguments it was given — never a clean tree.')
    out.push('')
  }
  if (Array.isArray(ev.verdictErrors) && ev.verdictErrors.length) {
    out.push(`MALFORMED VERDICTS (${ev.verdictErrors.length}) — the run stops; red is never put out on nobody's authority:`)
    for (const e of ev.verdictErrors) out.push(`  line ${e.line ?? '?'}: ${e.error}`)
    out.push('')
  }

  const redList = Array.isArray(ev.red) ? ev.red : []
  out.push(`RED — declared, closed, and not there (${redList.length}):`)
  if (!redList.length) out.push('  none')
  for (const id of Object.keys(RED_REASONS)) {
    const bucket = redList.filter((r) => r.reason === id)
    if (!bucket.length) continue
    const reason = RED_REASONS[id]
    out.push(`  ${reason.en} — ${reason.ru} (${bucket.length}):`)
    for (const r of bucket) {
      if (r.kind === 'link') {
        const missing = Array.isArray(r.missingIn) ? r.missingIn : []
        const named = missing.length
          ? missing.slice(0, 3).map((f) => show(f)).join(', ') + (missing.length > 3 ? ` (+${missing.length - 3} more)` : '')
          : 'no file named — the declaration names neither end as a path'
        const suggestion =
          id === 'trace-missing-in-named-file'
            ? `alive in ${r.treeFiles}${r.treeFilesCapped ? '+' : ''} file(s) elsewhere — suggested: renamed / misdeclared`
            : 'suggested: regression, or a declaration that was never true'
        out.push(
          `    ${r.planId} | trace ${JSON.stringify(r.pattern)} | absent from (${
            (r.namedSides ?? []).join('+') || '—'
          }): ${named} | ${suggestion}`,
        )
      } else {
        out.push(
          `    ${r.planId} | path ${show(r.declaredPath) ?? r.declaredPath} | needle ${JSON.stringify(r.contains)} | suggested: ${
            id === 'path-unresolved' ? 'renamed or written against another tree' : 'regression, or the work never landed'
          }`,
        )
      }
    }
  }
  out.push('')

  const reviewed = Array.isArray(ev.reviewed) ? ev.reviewed : []
  out.push(`REVIEWED BY A HUMAN — red put out by a written verdict (${reviewed.length}):`)
  if (!reviewed.length) out.push('  none')
  for (const r of reviewed) {
    const kind = VERDICT_KINDS[r.verdict]
    out.push(
      `  ${r.planId} | ${r.kind === 'link' ? `trace ${JSON.stringify(r.pattern)}` : `path ${show(r.declaredPath) ?? r.declaredPath}`} | ` +
        `${kind ? `${kind.en} — ${kind.ru}` : r.verdict} | ${r.author}${r.date ? `, ${r.date}` : ''}: ${r.rationale}`,
    )
  }
  out.push('')

  const staleList = Array.isArray(ev.staleVerdicts) ? ev.staleVerdicts : []
  out.push(`STALE VERDICTS — written about a finding this run does not have (${staleList.length}):`)
  if (!staleList.length) out.push('  none')
  for (const v of staleList) {
    out.push(`  line ${v.line ?? '?'} | ${v.plan} | ${v.kind === 'link' ? JSON.stringify(v.pattern) : v.path} | ${v.author}`)
  }
  out.push('')

  const aheadList = Array.isArray(ev.ahead) ? ev.ahead : []
  const aheadPlans = [...new Set(aheadList.map((a) => a.planId))].sort(cmp)
  out.push(`WORK STILL AHEAD — no summary beside the plan, so NOT judged (${aheadList.length} records in ${aheadPlans.length} plans):`)
  if (!aheadPlans.length) out.push('  none')
  else for (const p of aheadPlans) out.push(`  ${p}`)
  out.push('')

  // Its own section, between «still ahead» and «yellow»: not a colour of the verdict, a
  // statement about the REACH of this run.
  const outsideList = Array.isArray(ev.outside) ? ev.outside : []
  const outsidePlans = [...new Set(outsideList.map((o) => o.planId))].sort(cmp)
  out.push(
    `${OUTSIDE_TREE.en} — ${OUTSIDE_TREE.ru} (${outsideList.length} declared paths in ${outsidePlans.length} plans):`,
  )
  if (!outsideList.length) out.push('  none')
  else {
    const unjudged = outsideList.filter((o) => !o.stillScored).length
    out.push(
      `  of these, ${unjudged} record(s) are left UNJUDGED entirely; the rest are still scored by the tree-wide tier, which searches inside this tree only`,
    )
    for (const o of outsideList) {
      const via = o.rewriteApplied ? ` (after rewrite ${o.rewriteApplied.prefix} → ${o.rewriteApplied.target || '(stripped)'})` : ''
      out.push(`    ${o.planId} | ${o.kind} ${o.role} | ${o.declared}${via}`)
    }
  }
  out.push('')

  const y = ev.yellow ?? {}
  const broadList = Array.isArray(y.broad) ? y.broad : []
  out.push(`YELLOW — visible, and NOT counted as evidence:`)
  out.push(`  ${YELLOW_REASONS.broad.en} — ${YELLOW_REASONS.broad.ru} (${broadList.length}):`)
  if (!broadList.length) out.push('    none')
  for (const r of broadList) {
    out.push(`    ${r.planId} | trace ${JSON.stringify(r.pattern)} | found in ${r.treeFiles}${r.treeFilesCapped ? '+' : ''} files (limit ${limit})`)
  }
  const prose = Array.isArray(y.prose) ? y.prose : []
  const prosePlans = [...new Set(prose.map((p) => p.planId))].sort(cmp)
  out.push(`  ${YELLOW_REASONS.prose.en} — ${YELLOW_REASONS.prose.ru}: ${prose.length} lines in ${prosePlans.length} plans`)
  out.push(
    `  ${YELLOW_REASONS['no-test-trace'].en} — ${YELLOW_REASONS['no-test-trace'].ru}: ${
      (y.noTestTrace ?? []).length
    } (counted only — this tier never changes a verdict)`,
  )
  out.push(`  ${YELLOW_REASONS['pattern-unparseable'].en} — ${YELLOW_REASONS['pattern-unparseable'].ru}: ${(y.patternUnparseable ?? []).length}`)
  out.push(`  ${YELLOW_REASONS.patternless.en} — ${YELLOW_REASONS.patternless.ru}: ${(y.patternless ?? []).length}`)
  out.push(`  ${YELLOW_REASONS['artifact-no-needle'].en} — ${YELLOW_REASONS['artifact-no-needle'].ru}: ${(y.artifactNoNeedle ?? []).length}`)
  out.push('')

  out.push(`GREEN — the trace is where the declaration says it is: ${(ev.green ?? []).length}`)
  out.push('')
  out.push(HONEST_BOUNDARY)

  return out.join('\n') + '\n'
}
