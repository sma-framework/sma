/**
 * badge.mjs — the README test badge, written from a MEASURED receipt.
 *
 * THE LAW: the number on the badge is never typed by hand. It is derived from a
 * suite run, stamped into `test-receipt.json`, and written into BOTH READMEs by
 * this module. `package-check --strict` (the prepublishOnly gate) then refuses a
 * release whose badge and receipt disagree, so a stale badge cannot ship — the
 * failure mode that let `tests-876/876` sit in the shop window while the real
 * suite had grown past it.
 *
 * ONE door in, measured by construction:
 *   --from-vitest <file>   parse a runner's final JSON report (`vitest run
 *                          --reporter=json --outputFile=<file>`; jest's reporter
 *                          has the same shape) and take the counts from it.
 *                          Refuses anything but a finished, fully green run, and
 *                          refuses a report that predates HEAD — a leftover report
 *                          measured older code. There is no argv path for a number:
 *                          a provisional total written into the receipt makes the
 *                          badge and the receipt agree with each other and with
 *                          nothing that was ever run.
 *   --check [--strict]     compare both READMEs against the receipt; exit 1 on a
 *                          mismatch. This is what `npm test` calls. Because both sides
 *                          can be wrong TOGETHER, --check also judges the receipt
 *                          ITSELF: a receipt measured on a DIRTY worktree, or at a
 *                          commit that code and tests have moved on from, fails the
 *                          check outright — not a warning, and not only under --strict.
 *                          A number measured over files nobody can name is not a number
 *                          about this tree. Only the two UNVERIFIABLE cases (no git to
 *                          ask, no provenance in the receipt) stay warnings until
 *                          --strict: «cannot be checked» and «wrong» are different
 *                          words. A commit that moved only the DERIVED places (the
 *                          receipt, the two READMEs, the map) is the measurement
 *                          landing, not code moving underneath it, and is passed over —
 *                          recording a measurement always makes one more commit, so
 *                          without that exemption the rule could never be satisfied.
 *   --verify-live [<file>] the conclusive one: re-measure and compare the receipt AND
 *                          the READMEs against a THIRD number from a fresh run.
 *                          Given a report file it uses that; given none it runs the
 *                          suite itself.
 *
 * The receipt is the single source; the two READMEs are projections of it.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// One definition of "what counts as drift", shared with the docs audit: the same
// question asked twice must not be answered by two lists.
import { receiptDriftFiles } from './doc-audit.mjs'

/** Where the measured numbers live. Relative to the package root. */
export const RECEIPT_FILE = 'test-receipt.json'
/** The READMEs that carry a badge. Both are rewritten together — the README law. */
export const BADGE_READMES = ['README.md', 'README.ru.md']

/** Matches the shields.io test badge and its alt text, in either README. */
const BADGE_URL_RE = /(badge\/tests-)(\d+)(%2F)(\d+)(-)/g
const BADGE_ALT_RE = /(alt="(?:tests|тесты) )(\d+)(\/)(\d+)(")/g

/**
 * parseVitestJson(text) -> {tests, files, startedAt} | throws.
 * Reads vitest's JSON reporter shape. A run that is not finished and fully green is
 * refused: a badge that says "1512/1512" on a red suite is exactly the lie this
 * module exists to prevent.
 */
export function parseVitestJson(text) {
  const r = JSON.parse(text)
  const tests = Number(r.numTotalTests)
  // NOT numTotalTestSuites — that counts `describe` blocks (740 here), not files.
  // The file count is the length of the per-file results array.
  const files = Array.isArray(r.testResults) ? r.testResults.length : Number(r.numTotalTestSuites)
  if (!Number.isFinite(tests) || !Number.isFinite(files)) {
    throw new Error('vitest json carries no numTotalTests / test file results')
  }
  if (tests <= 0 || files <= 0) {
    throw new Error(`refusing to stamp a badge from a run that collected no tests: ${tests} tests across ${files} files`)
  }
  const failed = Number(r.numFailedTests ?? 0)
  const passed = Number(r.numPassedTests ?? tests)
  if (failed > 0 || passed !== tests) {
    throw new Error(`refusing to stamp a badge from a non-green run: ${passed}/${tests} passed, ${failed} failed`)
  }
  // A file that fails to LOAD (syntax error, bad import) reports status "failed" with
  // zero assertions, so its tests never enter numTotalTests at all: the counters above
  // read green while the badge SHRINKS by however many tests that file held. The
  // per-file status and the runner's own success flag are the honest signals.
  const broken = (Array.isArray(r.testResults) ? r.testResults : []).filter((t) => t && t.status !== 'passed')
  if (broken.length > 0) {
    const first = broken[0]
    throw new Error(`refusing to stamp a badge: ${broken.length} test file(s) did not pass — ${first.name ?? 'unknown file'}: ${String(first.message ?? first.status).split('\n')[0]}`)
  }
  if (r.success === false) {
    throw new Error('refusing to stamp a badge from a run the runner itself marked failed (success: false)')
  }
  const startedAt = Number(r.startTime)
  return { tests, files, startedAt: Number.isFinite(startedAt) ? startedAt : null }
}

/**
 * readHead({cwd, exec}) -> {sha, dirty, committedAt} | null.
 * The tree the numbers belong to. `null` when git cannot answer (no repo, no git) —
 * an unverifiable provenance is reported as unverifiable, never faked.
 */
export function readHead({ cwd, exec } = {}) {
  const run = exec ?? ((args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  try {
    const sha = String(run(['rev-parse', 'HEAD'])).trim()
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return null
    const seconds = Number(String(run(['log', '-1', '--format=%ct'])).trim())
    const dirty = String(run(['status', '--porcelain'])).trim().length > 0
    return { sha, dirty, committedAt: Number.isFinite(seconds) ? seconds * 1000 : null }
  } catch {
    return null
  }
}

/**
 * readChangedSince({cwd, exec, commit}) -> string[] | null.
 * The paths git says moved between the commit the receipt NAMES and the live HEAD.
 * `null` when git cannot answer — no repository, no git, or a commit this clone does
 * not know — and an unanswerable question is never read as "nothing changed": the
 * caller fails closed on `null`.
 */
export function readChangedSince({ cwd, exec, commit } = {}) {
  if (!commit) return null
  const run = exec ?? ((args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  try {
    return String(run(['diff', '--name-only', commit, 'HEAD']))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return null
  }
}

/**
 * assertReportIsLive({startedAt, head}) -> void | throws.
 * A report only measures the code it ran over. A JSON file left over from an earlier
 * tree is how a provisional number reaches the receipt: a report started at 02:08
 * stamped at 10:41, by which time the suite had moved. If the run started BEFORE the
 * current HEAD commit was made, it measured older code. Unknown times -> no verdict.
 */
export function assertReportIsLive({ startedAt, head } = {}) {
  if (!head || !head.committedAt || !startedAt) return
  if (startedAt < head.committedAt) {
    throw new Error(
      `refusing to stamp from a report that predates HEAD: the run started ${new Date(startedAt).toISOString()} but HEAD (${head.sha.slice(0, 8)}) was committed ${new Date(head.committedAt).toISOString()} — re-run the suite and stamp from THAT report`,
    )
  }
}

/**
 * resolveMeasurement({argv, readFile, head}) -> {tests, files, startedAt} | throws.
 * The ONLY way a number reaches the receipt, and the whole bootstrap is this: a
 * runner's final JSON, from a run no older than HEAD. `--from-suite <tests>/<files>`
 * used to take totals straight off the command line; it is refused by name so the
 * old habit gets an explanation instead of a usage line.
 */
export function resolveMeasurement({ argv = [], readFile, head } = {}) {
  if (argv.includes('--from-suite')) {
    throw new Error('--from-suite is gone: the receipt is written only from a runner\'s final JSON (--from-vitest <file>), never from a number typed on the command line')
  }
  const i = argv.indexOf('--from-vitest')
  const file = i > -1 ? argv[i + 1] : undefined
  if (!file) throw new Error('usage: badge.mjs --from-vitest <json> | --check [--strict] | --verify-live [<json>]')
  const read = readFile ?? ((p) => readFileSync(p, 'utf8'))
  const measured = parseVitestJson(read(resolve(file)))
  assertReportIsLive({ startedAt: measured.startedAt, head })
  return measured
}

/**
 * applyBadge(readmeText, tests) -> {text, replaced}. Rewrites both the shields
 * URL and the alt text to `tests/tests` (a green suite is all of it).
 */
export function applyBadge(readmeText, tests) {
  let replaced = 0
  let text = readmeText.replace(BADGE_URL_RE, (_m, a, _o, sep, _o2, tail) => {
    replaced++
    return `${a}${tests}${sep}${tests}${tail}`
  })
  text = text.replace(BADGE_ALT_RE, (_m, a, _o, sep, _o2, tail) => {
    replaced++
    return `${a}${tests}${sep}${tests}${tail}`
  })
  return { text, replaced }
}

/** readBadge(readmeText) -> the number on the badge, or null if there is none. */
export function readBadge(readmeText) {
  const m = /badge\/tests-(\d+)%2F(\d+)-/.exec(readmeText)
  return m ? { shown: Number(m[1]), total: Number(m[2]) } : null
}

/**
 * The receipt shape written to disk. `commit`/`dirty` are the provenance: WHICH tree
 * the number was measured on. Without them a stale receipt and a stale badge agree
 * with each other forever and nothing can tell.
 */
export function buildReceipt({ tests, files, startedAt, head } = {}) {
  return {
    tests,
    files,
    measuredAt: new Date().toISOString(),
    source: 'vitest',
    commit: head?.sha ?? null,
    dirty: head?.dirty ?? null,
    runStartedAt: startedAt ? new Date(startedAt).toISOString() : null,
  }
}

/**
 * checkReceiptCleanliness({receipt}) -> [{code, detail, hard}].
 * The verdict that needs no git at all, because it is written in the receipt: a run
 * measured over a DIRTY worktree ran over files that are in no commit, so nothing —
 * not this check, not a reviewer, not the person who stamped it — can name what was
 * measured. Such a number may not be published: it is unfalsifiable by construction.
 * Measure a committed tree, then stamp.
 */
export function checkReceiptCleanliness({ receipt } = {}) {
  if (!receipt || !receipt.dirty) return []
  const where = receipt.commit ? ` at ${String(receipt.commit).slice(0, 8)}` : ''
  return [{
    code: 'badge-receipt-dirty',
    hard: true,
    detail: `${RECEIPT_FILE} was measured on a dirty worktree${where} — the run covered uncommitted files, so nothing can say WHAT was measured; commit first, then re-stamp (badge.mjs --from-vitest <report>)`,
  }]
}

/**
 * checkReceiptFreshness({receipt, head, changedSince}) -> [{code, detail, hard}].
 * The cheap guard. Comparing README to receipt only proves they were written by the
 * same command; comparing the receipt's commit to the live HEAD asks whether the
 * number still describes THIS tree.
 *
 * `hard` separates the two kinds of answer. A receipt measured somewhere else is WRONG
 * about this tip and fails the check on its own; a receipt that cannot be judged (no git,
 * no provenance) is UNVERIFIED, which is a warning until --strict asks for certainty.
 *
 * `changedSince` is the file list from readChangedSince, and it decides what a differing
 * commit means: code or tests moved (wrong), or only the derived places did — the
 * measurement landing in its own commit, which every stamp makes and which must not be
 * read as staleness. Absent or `null`, the difference alone is the verdict: an
 * unanswerable question fails closed.
 */
export function checkReceiptFreshness({ receipt, head, changedSince } = {}) {
  if (!head) {
    return [{ code: 'badge-head-unknown', detail: 'cannot read git HEAD — the receipt\'s freshness is unverified (run --verify-live to re-measure)' }]
  }
  if (!receipt || !receipt.commit) {
    return [{ code: 'badge-receipt-no-provenance', detail: `${RECEIPT_FILE} records no commit, so nothing can say whether its number still fits this tree — re-stamp it (badge.mjs --from-vitest <report>)` }]
  }
  if (receipt.commit === head.sha) return []
  const at = `${RECEIPT_FILE} was measured at ${receipt.commit.slice(0, 8)} but HEAD is ${head.sha.slice(0, 8)}`
  const drifted = (detail) => [{ code: 'badge-receipt-drifted', hard: true, detail }]
  if (changedSince === undefined || changedSince === null) {
    return drifted(`${at} — and nothing here can say what moved in between; re-stamp on the tip, or confirm with --verify-live`)
  }
  const moved = receiptDriftFiles(changedSince)
  if (moved.length === 0) return [] // only derived places moved: the measurement landing
  const rest = moved.length > 1 ? ` and ${moved.length - 1} more` : ''
  return drifted(`${at}, with ${moved.length} code/test change(s) in between (${moved[0]}${rest}) — the number describes a tree that is not this one; re-stamp on the tip, or confirm with --verify-live`)
}

/**
 * checkBadge({pkgRoot, io, head, changedSince, strict}) -> {ok, violations, warnings}.
 * Pure given an io. The receipt is authoritative for the READMEs; a README that
 * disagrees with it is stale. Pass `head` (from readHead) to also judge the receipt
 * itself: without it no FRESHNESS verdict is produced at all, which is what
 * package-check wants — its violation count is a publishability contract and must not
 * depend on git.
 *
 * The dirty verdict is the exception, and deliberately: it is read off the receipt, not
 * off git, so the release gate can refuse an unfalsifiable measurement in a tree with no
 * history. It is a violation wherever a verdict was asked for — `--check` (which passes a
 * head) and `--strict` (the prepublishOnly gate) — and a warning in the bare
 * publishability count, whose total must not grow behind the scorer's back.
 */
export function checkBadge({ pkgRoot, io, head, changedSince, strict } = {}) {
  const read = io ?? { exists: existsSync, readFile: (p) => readFileSync(p, 'utf8') }
  const violations = []
  const warnings = []
  const judgeReceipt = (receipt) => {
    const asked = head !== undefined || strict === true
    for (const f of checkReceiptCleanliness({ receipt })) (asked ? violations : warnings).push(f)
    if (head === undefined) return // freshness not requested
    for (const f of checkReceiptFreshness({ receipt, head, changedSince })) (f.hard || strict ? violations : warnings).push(f)
  }

  // The law binds only a project that MAKES the claim. No badge anywhere -> there
  // is no public number to keep honest, and demanding a receipt would be noise.
  const badged = []
  for (const name of BADGE_READMES) {
    const p = join(pkgRoot, name)
    if (!read.exists(p)) continue
    const badge = readBadge(read.readFile(p))
    if (badge) badged.push({ name, badge })
  }
  if (badged.length === 0) return { ok: true, violations: [], warnings: [] }

  const receiptPath = join(pkgRoot, RECEIPT_FILE)
  if (!read.exists(receiptPath)) {
    return { ok: false, warnings, violations: [{ code: 'badge-no-receipt', detail: `README carries a test badge but ${RECEIPT_FILE} is missing — the number must come from a measured run (badge.mjs --from-vitest)` }] }
  }
  let receipt
  try {
    receipt = JSON.parse(read.readFile(receiptPath))
  } catch (err) {
    return { ok: false, warnings, violations: [{ code: 'badge-bad-receipt', detail: `${RECEIPT_FILE} unparseable: ${err && err.message}` }] }
  }
  judgeReceipt(receipt)
  for (const { name, badge } of badged) {
    if (badge.total !== receipt.tests || badge.shown !== receipt.tests) {
      violations.push({ code: 'badge-stale', detail: `${name} badge says ${badge.shown}/${badge.total} but the measured receipt says ${receipt.tests} — rewrite it from the receipt, never by hand` })
    }
  }
  return { ok: violations.length === 0, violations, warnings }
}

/**
 * defaultRunSuite({pkgRoot, exec, io}) -> the runner's JSON text.
 * The live seam for --verify-live: ask the project's own vitest for a JSON report.
 * A red suite exits non-zero and the report still tells the truth — parseVitestJson
 * refuses it downstream, which is the point.
 */
export function defaultRunSuite({ pkgRoot, exec, io } = {}) {
  const outFile = join(tmpdir(), `sma-badge-verify-${process.pid}-${Date.now()}.json`)
  const run = exec ?? ((cmd, args, opts) => execFileSync(cmd, args, opts))
  const files = io ?? { readFile: (p) => readFileSync(p, 'utf8'), remove: (p) => rmSync(p, { force: true }) }
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  try {
    run(npx, ['vitest', 'run', '--reporter=json', `--outputFile=${outFile}`], { cwd: pkgRoot, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' })
  } catch {
    /* non-zero exit = a red suite; the report is what we judge, not the exit code */
  }
  try {
    return files.readFile(outFile)
  } finally {
    try {
      files.remove(outFile)
    } catch {
      /* a leftover temp report is not a failure */
    }
  }
}

/**
 * verifyLive({pkgRoot, io, reportText, runSuite}) -> {ok, violations, measured}.
 * The conclusive check. `checkBadge` compares two copies of one number, so it is
 * silent when both are wrong together; this brings a THIRD number from a fresh run
 * and lets it break the tie.
 */
export function verifyLive({ pkgRoot, io, reportText, runSuite } = {}) {
  const read = io ?? { exists: existsSync, readFile: (p) => readFileSync(p, 'utf8') }
  const text = reportText ?? (typeof runSuite === 'function' ? runSuite() : undefined)
  if (text === undefined) throw new Error('verify-live needs a fresh runner report: pass one (--verify-live <json>) or let it run the suite')
  const measured = parseVitestJson(text) // same green law: a red run proves nothing
  const violations = []

  const receiptPath = join(pkgRoot, RECEIPT_FILE)
  if (!read.exists(receiptPath)) {
    violations.push({ code: 'badge-no-receipt', detail: `a fresh run measured ${measured.tests} tests but ${RECEIPT_FILE} is missing — stamp it (badge.mjs --from-vitest)` })
  } else {
    let receipt
    try {
      receipt = JSON.parse(read.readFile(receiptPath))
    } catch (err) {
      receipt = null
      violations.push({ code: 'badge-bad-receipt', detail: `${RECEIPT_FILE} unparseable: ${err && err.message}` })
    }
    if (receipt && (receipt.tests !== measured.tests || receipt.files !== measured.files)) {
      violations.push({ code: 'badge-live-mismatch', detail: `${RECEIPT_FILE} says ${receipt.tests} tests / ${receipt.files} files but a fresh run measured ${measured.tests}/${measured.files} — the receipt is stale, re-stamp it from this run` })
    }
  }

  for (const name of BADGE_READMES) {
    const p = join(pkgRoot, name)
    if (!read.exists(p)) continue
    const badge = readBadge(read.readFile(p))
    if (!badge) continue
    if (badge.shown !== measured.tests || badge.total !== measured.tests) {
      violations.push({ code: 'badge-live-mismatch', detail: `${name} badge says ${badge.shown}/${badge.total} but a fresh run measured ${measured.tests} — re-stamp the badge from this run` })
    }
  }

  return { ok: violations.length === 0, violations, measured }
}

// ── direct run ───────────────────────────────────────────────────────────────
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const argv = process.argv.slice(2)
  const strict = argv.includes('--strict')

  if (argv.includes('--check')) {
    const head = readHead({ cwd: pkgRoot })
    // What moved since the receipt was measured is a git question, asked once here so
    // checkBadge stays pure: a commit that carried only the measurement is not drift.
    const receiptCommit = (() => {
      try {
        return JSON.parse(readFileSync(join(pkgRoot, RECEIPT_FILE), 'utf8')).commit
      } catch {
        return null
      }
    })()
    const changedSince = readChangedSince({ cwd: pkgRoot, commit: receiptCommit })
    const { ok, violations, warnings } = checkBadge({ pkgRoot, head, changedSince, strict })
    for (const w of warnings) process.stderr.write(`  [warn ${w.code}] ${w.detail}\n`)
    for (const v of violations) process.stderr.write(`  [${v.code}] ${v.detail}\n`)
    process.stdout.write(`${violations.length}\n`)
    process.exit(ok ? 0 : 1)
  }

  if (argv.includes('--verify-live')) {
    const at = argv.indexOf('--verify-live') + 1
    const file = argv[at] && !argv[at].startsWith('--') ? argv[at] : undefined
    try {
      const { ok, violations, measured } = verifyLive({
        pkgRoot,
        reportText: file ? readFileSync(resolve(file), 'utf8') : undefined,
        runSuite: file ? undefined : () => defaultRunSuite({ pkgRoot }),
      })
      for (const v of violations) process.stderr.write(`  [${v.code}] ${v.detail}\n`)
      process.stdout.write(`live: ${measured.tests} tests / ${measured.files} files\n`)
      process.stdout.write(`${violations.length}\n`)
      process.exit(ok ? 0 : 1)
    } catch (err) {
      process.stderr.write(`badge: ${err && err.message}\n`)
      process.exit(1)
    }
  }

  const head = readHead({ cwd: pkgRoot })
  let measured
  try {
    measured = resolveMeasurement({ argv, head })
  } catch (err) {
    process.stderr.write(`badge: ${err && err.message}\n`)
    process.exit(1)
  }

  writeFileSync(join(pkgRoot, RECEIPT_FILE), JSON.stringify(buildReceipt({ ...measured, head }), null, 2) + '\n')
  for (const name of BADGE_READMES) {
    const p = join(pkgRoot, name)
    if (!existsSync(p)) continue
    const { text, replaced } = applyBadge(readFileSync(p, 'utf8'), measured.tests)
    writeFileSync(p, text)
    process.stdout.write(`${name}: ${replaced} badge site(s) -> ${measured.tests}\n`)
  }
  process.stdout.write(`receipt: ${measured.tests} tests / ${measured.files} files${head ? ` @ ${head.sha.slice(0, 8)}${head.dirty ? ' (dirty)' : ''}` : ' (no git provenance)'}\n`)
  if (head && head.dirty) {
    // Said at the door rather than only at the gate: this receipt is already refused.
    process.stderr.write(
      '  [warn badge-receipt-dirty] measured on a dirty worktree, so nothing can name what was measured — ' +
        `--check and the release gate both refuse this receipt. Commit the tree, re-run the suite, and stamp again.\n`,
    )
  }
}
