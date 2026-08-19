/**
 * Tests for the NUMBERS target of scripts/sma/lib/doc-audit.mjs.
 *
 * The point of a gate is that it can go RED. Every rule below is proved on a FIXTURE
 * tree held in memory — one planted divergence at a time — so the proof does not depend
 * on the state of the real tree on the day the suite runs. Nothing in the fixture group
 * reads a real file.
 *
 * The last three groups are WIRES, and they run against the real tree on purpose: a
 * number that is computed and never delivered to its reader is worth nothing.
 *   - the door count read from the TEXT equals the door count of the LIVE import;
 *   - the audit is reachable through the verb, with the contract the scorer relies on;
 *   - the help door the docs name actually opens, and prints the verbs it claims.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  audit,
  auditNumbers,
  receiptDriftFiles,
  wordToNumber,
  writeNumbers,
  parseRouteCount,
  parseHandlerKeys,
  NUMBER_REGIONS,
} from '../lib/doc-audit.mjs'

const REAL_CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url))
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const FAKE_ROOT = '/fake-root'

const VERSION = '9.9.9'
const TESTS = 12
const FILES = 3
/** The commit the fixture tree stands on, and the one its receipt was measured at. */
const FIXTURE_HEAD = 'abc1234'
/**
 * The default injected git: the receipt was measured on the very tip, so the freshness rule
 * has nothing to say. Every drift case below hands its OWN answers in — a fixture that
 * quietly asked the real repository would prove nothing about the rule and everything about
 * the day it ran.
 */
const gitAtTip = (argv: string[]) => (argv[0] === 'rev-parse' ? `${FIXTURE_HEAD}\n` : '')
/** The verb total of the fixture CLI: its dispatch table declares exactly these three. */
const VERBS = 3

// ── fixture builders ──────────────────────────────────────────────────────────

/** A front whose header, assertion and table all agree on three doors. */
function serverMjs(
  opts: { assertN?: number; proseWord?: string; liveWord?: string; doors?: number; noTable?: boolean } = {},
) {
  const doors = opts.doors ?? 3
  const names = ['handleIndex', 'handleState', 'handleDone', 'handleTask', 'handleDiff']
  const rows = Array.from({ length: doors }, (_, i) => `  'GET /api/${i}': '${names[i % names.length]}',`).join('\n')
  const header = [
    '/**',
    ` * ROUTES is a frozen object of EXACTLY ${opts.proseWord ?? 'THREE'} routes.`,
    ` * Object.keys(ROUTES).length === ${opts.assertN ?? doors} is a test.`,
    ` * ALL ${opts.liveWord ?? 'THREE'} ARE LIVE.`,
    ' */',
  ].join('\n')
  if (opts.noTable) return `${header}\nconst somethingElse = 1\n`
  return `${header}\nexport const ROUTES = Object.freeze({\n${rows}\n})\n`
}

/** A CLI whose dispatch table, printed list and allow-list comment all agree. */
function cliMjs(opts: { dropFromList?: string; extraInList?: string; otherVerbs?: number } = {}) {
  const verbs = ['status', 'doc-audit', 'batch']
  const printed = verbs.filter((v) => v !== opts.dropFromList).concat(opts.extraInList ? [opts.extraInList] : [])
  const other = opts.otherVerbs ?? verbs.length - 1
  return [
    'const HANDLERS = {',
    '  status: cmdStatus,',
    "  'doc-audit': cmdDocAudit, // a trailing comment with a colon: still one key",
    '  batch: cmdBatch,',
    '}',
    '',
    '/**',
    ` * Deliberately an opt-in allow-list: ${other} other verbs keep the existing behaviour.`,
    ' */',
    "const OWN_HELP = new Set(['memory'])",
    '',
    'async function main() {',
    `  process.stdout.write('node scripts/sma/cli.mjs <${printed.join('|')}>\\n')`,
    '}',
  ].join('\n')
}

/** The map page: three marked spans carrying today's numbers, plus untouched history. */
function graphHtml(opts: { version?: string; tests?: number; files?: number; dropRegion?: string } = {}) {
  const v = opts.version ?? VERSION
  const t = opts.tests ?? TESTS
  const f = opts.files ?? FILES
  const span = (name: string, inner: string) =>
    name === opts.dropRegion ? '' : `<!-- ${name}:start -->${inner}<!-- ${name}:end -->`
  return [
    '<html><head>',
    span('sma:num-meta', `<meta name="description" content="the map, v${v}">`),
    '</head><body>',
    span('sma:num-hero', `<span class="pill">v${v}</span><span class="stat">${t} tests · ${f} files</span>`),
    // history lives OUTSIDE every marked span and is never policed or rewritten
    '<svg><text>v3.0.0 · 532 tests</text><text>v5.0.1 · 1145 tests</text></svg>',
    span('sma:num-footer', `<p><strong>SMA v${v}</strong></p>`),
    '</body></html>',
  ].join('\n')
}

function readmeMd(lang: 'en' | 'ru', opts: { version?: string; verbs?: number | null } = {}) {
  const v = opts.version ?? VERSION
  const alt = lang === 'ru' ? `версия ${v}` : `version ${v}`
  const n = opts.verbs === undefined ? VERBS : opts.verbs
  const sentence =
    n === null
      ? lang === 'ru'
        ? 'Под капотом работает подотчётный CLI.\n'
        : 'Underneath runs the accountability CLI.\n'
      : lang === 'ru'
        ? `Под капотом работает координационно-подотчётный CLI — ${n} команд.\n`
        : `Underneath runs the coordination + accountability CLI — ${n} verbs.\n`
  return `# SMA\n<img src="https://img.shields.io/badge/version-${v}-3B82F6" alt="${alt}">\n${sentence}`
}

/**
 * The three documents outside the READMEs that also name the verb total. They are here
 * because of what the gate missed once: it watched a single file, the rest of the places
 * were «correct today», and three shipped documents drifted while the audit printed zero.
 * Each place therefore gets its own fixture and its own red test below — one test standing
 * in for all of them would rebuild exactly the blind spot this list exists to remove.
 */
function detailsMd(lang: 'en' | 'ru', n: number | null) {
  if (n === null) {
    return lang === 'ru' ? '## Справочник CLI\n\nПод капотом работает CLI.\n' : '## The CLI reference\n\nThe CLI runs underneath.\n'
  }
  return lang === 'ru'
    ? `## Справочник CLI\n\nПод капотом работает координационно-подотчётный CLI: ${n} команд.\n`
    : `## The CLI reference\n\nThe coordination + accountability CLI runs underneath — ${n} verbs.\n`
}

function installMd(n: number | null) {
  return n === null
    ? 'node scripts/sma/cli.mjs explain <verb>  # what a verb is for\n'
    : `node scripts/sma/cli.mjs explain <verb>  # what any of the ${n} verbs is for\n`
}

/** The installer: one read of the package version, handed to the block writer, no copy. */
function installerMjs(opts: { literal?: string; unwired?: boolean } = {}) {
  return [
    'function pkgVersion() {',
    "  const pkg = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));",
    "  return typeof pkg.version === 'string' ? pkg.version : '';",
    '}',
    'const version = pkgVersion();',
    opts.unwired
      ? '  const res = embed.embedRules({ projectDir: project });'
      : '  const res = embed.embedRules({ projectDir: project, version });',
    opts.literal ? `// shipped in ${opts.literal}` : '',
  ].join('\n')
}

/** Every file that names the verb total. The list mirrors VERB_COUNT_PLACES of the audit. */
const VERB_COUNT_FILES = [
  'scripts/sma/README.md',
  'README.md',
  'README.ru.md',
  'docs/DETAILS.md',
  'docs/DETAILS.ru.md',
  'docs/INSTALL.md',
] as const
type VerbCountFile = (typeof VERB_COUNT_FILES)[number]

type FixtureOpts = {
  server?: Parameters<typeof serverMjs>[0]
  cli?: Parameters<typeof cliMjs>[0]
  graph?: Parameters<typeof graphHtml>[0]
  installer?: Parameters<typeof installerMjs>[0]
  version?: string
  capabilityVersion?: string
  markerVersion?: string
  /**
   * One planted verb total per file. `null` means the place stops naming the number at
   * all — a different violation from naming a wrong one, and it has to stay different:
   * a rule left with nothing to match is an empty rule that passes forever.
   */
  verbCounts?: Partial<Record<VerbCountFile, number | null>>
  testScript?: string
  noReceipt?: boolean
  /** What the receipt says it was measured on. `null` means it names no commit at all. */
  receiptCommit?: string | null
  /**
   * The injected git. Fixtures answer it themselves so no test in this group ever asks the
   * real repository anything — the whole point of the fixture group is that its proof does
   * not depend on the state of the tree on the day the suite runs.
   */
  git?: (argv: string[]) => string
  templateWriter?: string
  sourceDefines?: string
}

/** The whole fixture tree, consistent by default: a clean run must score zero. */
function fixtureFiles(o: FixtureOpts = {}): Record<string, string> {
  const version = o.version ?? VERSION
  const vc = (f: VerbCountFile) => (o.verbCounts && f in o.verbCounts ? (o.verbCounts[f] as number | null) : VERBS)
  const cliReadme = vc('scripts/sma/README.md')
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      version,
      scripts: { test: o.testScript ?? 'vitest run && node scripts/sma/lib/badge.mjs --check' },
    }),
    'daemon/src/front/server.mjs': serverMjs(o.server),
    'scripts/sma/cli.mjs': cliMjs(o.cli),
    'scripts/sma/README.md':
      cliReadme === null ? 'The verbs, grouped by what they are for.' : `All ${cliReadme}, grouped by what they are for.`,
    'docs/master-graph.html': graphHtml(o.graph),
    'README.md': readmeMd('en', { version, verbs: vc('README.md') }),
    'README.ru.md': readmeMd('ru', { version, verbs: vc('README.ru.md') }),
    'docs/DETAILS.md': detailsMd('en', vc('docs/DETAILS.md')),
    'docs/DETAILS.ru.md': detailsMd('ru', vc('docs/DETAILS.ru.md')),
    'docs/INSTALL.md': installMd(vc('docs/INSTALL.md')),
    'sma-core/capabilities/sma/capability.json': JSON.stringify({ version: o.capabilityVersion ?? version }),
    'sma-core/VERSION': `${o.markerVersion ?? version}\n`,
    'bin/init.mjs': installerMjs(o.installer),
    'sma-core/templates/state.md': `<!-- placeholder; ${o.templateWriter ?? 'writeStateHeader'} fills it in -->`,
    'scripts/sma/lib/state.mjs': `export function ${o.sourceDefines ?? 'writeStateHeader'}() {}`,
  }
  if (!o.noReceipt) {
    const receipt: Record<string, unknown> = { tests: TESTS, files: FILES, dirty: false }
    const commit = o.receiptCommit === undefined ? FIXTURE_HEAD : o.receiptCommit
    if (commit !== null) receipt.commit = commit
    files['test-receipt.json'] = JSON.stringify(receipt)
  }
  return files
}

/** An injected reader over an in-memory {relPath: content} map rooted at FAKE_ROOT. */
function fakeTree(files: Record<string, string>) {
  const map = new Map<string, string>()
  for (const [rel, content] of Object.entries(files)) map.set(join(FAKE_ROOT, ...rel.split('/')), content)
  const readFile = (p: string) => {
    if (map.has(p)) return map.get(p) as string
    throw new Error(`ENOENT ${p}`)
  }
  const writeFile = (p: string, data: string) => {
    map.set(p, data)
  }
  const listTemplates = () => [...map.keys()].filter((k) => k.replace(/\\/g, '/').includes('sma-core/templates/'))
  const listSourceFiles = () => [...map.keys()].filter((k) => k.replace(/\\/g, '/').includes('scripts/sma/lib/'))
  return { rootDir: FAKE_ROOT, readFile, writeFile, listTemplates, listSourceFiles, map }
}

/** Run the numbers audit over a fixture tree described by its divergences. */
function runFixture(o: FixtureOpts = {}) {
  const t = fakeTree(fixtureFiles(o))
  const notes: string[] = []
  const violations = auditNumbers({
    readFile: t.readFile,
    listTemplates: t.listTemplates,
    listSourceFiles: t.listSourceFiles,
    rootDir: t.rootDir,
    runGit: o.git ?? gitAtTip,
    notes,
  })
  return { violations, notes, tree: t }
}

const hasRule = (violations: Array<{ rule: string }>, rule: string) => violations.some((v) => v.rule === rule)

// ── the fixtures ──────────────────────────────────────────────────────────────

describe('the numbers audit — a consistent tree scores nothing', () => {
  it('a fixture whose every number agrees with the code yields zero violations', () => {
    const { violations, notes } = runFixture()
    expect(violations.map((v) => `${v.rule}: ${v.detail}`)).toEqual([])
    expect(notes).toEqual([])
  })

  it('the parsers read the fixture tables the way the audit assumes', () => {
    expect(parseRouteCount(serverMjs({ doors: 5 }))).toBe(5)
    expect(parseHandlerKeys(cliMjs())).toEqual(['status', 'doc-audit', 'batch'])
    expect(NUMBER_REGIONS).toHaveLength(3)
  })
})

describe('the numbers audit — every rule can go red', () => {
  it('a spelled-out door count that disagrees with the table is named', () => {
    const { violations } = runFixture({ server: { proseWord: 'FIFTY-SIX' } })
    expect(hasRule(violations, 'route-count-prose')).toBe(true)
    expect(violations.find((v) => v.rule === 'route-count-prose')?.detail).toContain('56')
  })

  it('a digit in the size assertion that disagrees with the table is named', () => {
    const { violations } = runFixture({ server: { assertN: 56 } })
    expect(hasRule(violations, 'route-count-assertion')).toBe(true)
  })

  it('a spelled-out word the audit does not know is refused, never guessed', () => {
    const { violations } = runFixture({ server: { proseWord: 'UMPTEEN' } })
    expect(hasRule(violations, 'unknown-number-word')).toBe(true)
    expect(hasRule(violations, 'route-count-prose')).toBe(false)
  })

  it('a verb that is dispatched but missing from the printed list is named', () => {
    const { violations } = runFixture({ cli: { dropFromList: 'batch' } })
    const v = violations.filter((x) => x.rule === 'verb-list-parity')
    expect(v).toHaveLength(1)
    expect(v[0].detail).toContain('batch')
  })

  it('a verb that is printed but answered by no handler is named too', () => {
    const { violations } = runFixture({ cli: { extraInList: 'ghost' } })
    const v = violations.filter((x) => x.rule === 'verb-list-parity')
    expect(v).toHaveLength(1)
    expect(v[0].detail).toContain('ghost')
  })

  it('a stale count in the own-help comment is named', () => {
    const { violations } = runFixture({ cli: { otherVerbs: 88 } })
    expect(hasRule(violations, 'own-help-count')).toBe(true)
  })

  /**
   * The verb total, place by place. Deliberately NOT one test with a loop over the list
   * and NOT one test standing in for all six: the failure this group exists to prevent
   * was precisely a place nobody was watching, so each place has to be able to fail on
   * its own name, and a place deleted from the audit's list has to take a named test
   * with it rather than quietly shrink a loop.
   */
  it("a stale verb total in the CLI's own README is named, with its file", () => {
    const { violations } = runFixture({ verbCounts: { 'scripts/sma/README.md': 89 } })
    const v = violations.find((x) => x.rule === 'verb-count')
    expect(v?.file).toBe('scripts/sma/README.md')
    expect(v?.detail).toContain('scripts/sma/README.md')
    expect(v?.detail).toContain('89')
  })

  it('a stale verb total in the English README is named, with its file', () => {
    const { violations } = runFixture({ verbCounts: { 'README.md': 89 } })
    const v = violations.find((x) => x.rule === 'verb-count')
    expect(v?.file).toBe('README.md')
    expect(v?.detail).toContain('README.md')
  })

  it('a stale verb total in the Russian README is named, with its file', () => {
    const { violations } = runFixture({ verbCounts: { 'README.ru.md': 89 } })
    const v = violations.find((x) => x.rule === 'verb-count')
    expect(v?.file).toBe('README.ru.md')
    expect(v?.detail).toContain('README.ru.md')
  })

  it('a stale verb total in the English details is named, with its file', () => {
    const { violations } = runFixture({ verbCounts: { 'docs/DETAILS.md': 89 } })
    const v = violations.find((x) => x.rule === 'verb-count')
    expect(v?.file).toBe('docs/DETAILS.md')
    expect(v?.detail).toContain('docs/DETAILS.md')
  })

  it('a stale verb total in the Russian details is named, with its file', () => {
    const { violations } = runFixture({ verbCounts: { 'docs/DETAILS.ru.md': 89 } })
    const v = violations.find((x) => x.rule === 'verb-count')
    expect(v?.file).toBe('docs/DETAILS.ru.md')
    expect(v?.detail).toContain('docs/DETAILS.ru.md')
  })

  it('a stale verb total in the install guide is named, with its file', () => {
    const { violations } = runFixture({ verbCounts: { 'docs/INSTALL.md': 89 } })
    const v = violations.find((x) => x.rule === 'verb-count')
    expect(v?.file).toBe('docs/INSTALL.md')
    expect(v?.detail).toContain('docs/INSTALL.md')
  })

  it('two places drifting at once are two violations, one per file, not one summary', () => {
    const { violations } = runFixture({ verbCounts: { 'docs/INSTALL.md': 89, 'docs/DETAILS.ru.md': 44 } })
    const files = violations.filter((v) => v.rule === 'verb-count').map((v) => v.file).sort()
    expect(files).toEqual(['docs/DETAILS.ru.md', 'docs/INSTALL.md'])
  })

  it('a place that stops naming the number at all is its own violation, never a quiet pass', () => {
    for (const file of VERB_COUNT_FILES) {
      const { violations } = runFixture({ verbCounts: { [file]: null } })
      const v = violations.find((x) => x.rule === 'verb-count-missing')
      expect(v?.file, `${file} went silent unnoticed`).toBe(file)
      expect(v?.detail).toContain(file)
      // and it is NOT reported as a wrong number: «gone» and «wrong» are different words
      expect(hasRule(violations, 'verb-count')).toBe(false)
    }
  })

  it('a version inside a marked span of the map that is not the package version is named', () => {
    const { violations } = runFixture({ graph: { version: '5.1.0' } })
    expect(hasRule(violations, 'graph-region-version')).toBe(true)
  })

  it('statistics inside a marked span that are not the measured ones are named', () => {
    const { violations } = runFixture({ graph: { tests: 1145 } })
    expect(hasRule(violations, 'graph-region-stats')).toBe(true)
  })

  it('the growth history outside the marked spans is never policed', () => {
    // the fixture carries v3.0.0 / 1145 tests outside every span, and scores nothing
    const { violations } = runFixture()
    expect(violations).toHaveLength(0)
  })

  it('a version badge that disagrees with the package is named, in either README', () => {
    const t = fakeTree({ ...fixtureFiles(), 'README.ru.md': readmeMd('ru', { version: '5.1.0' }) })
    const violations = auditNumbers({
      readFile: t.readFile,
      listTemplates: t.listTemplates,
      listSourceFiles: t.listSourceFiles,
      rootDir: t.rootDir,
    })
    expect(violations.some((v) => v.rule === 'readme-version-badge' && v.file === 'README.ru.md')).toBe(true)
  })

  it('a capability record that disagrees with the package is named', () => {
    const { violations } = runFixture({ capabilityVersion: '1.6.1' })
    expect(hasRule(violations, 'capability-version')).toBe(true)
  })

  it('an install marker that disagrees with the package is named', () => {
    const { violations } = runFixture({ markerVersion: '1.6.1' })
    expect(hasRule(violations, 'version-marker')).toBe(true)
  })

  it('a template that promises a writer no shipped source defines is named', () => {
    const { violations } = runFixture({ templateWriter: 'syncNothingAtAll' })
    const v = violations.find((x) => x.rule === 'phantom-writer')
    expect(v?.detail).toContain('syncNothingAtAll')
    expect(v?.file).toBe('sma-core/templates/state.md')
  })

  it('a writer the sources DO define is not a phantom', () => {
    const { violations } = runFixture({ templateWriter: 'updateThing', sourceDefines: 'updateThing' })
    expect(hasRule(violations, 'phantom-writer')).toBe(false)
  })

  it('the badge check falling out of the ordinary test run is named', () => {
    const { violations } = runFixture({ testScript: 'vitest run' })
    expect(hasRule(violations, 'badge-gate-wired')).toBe(true)
  })

  it('a version literal in the installer is named as the second source it is', () => {
    const { violations } = runFixture({ installer: { literal: 'v5.5.2' } })
    const v = violations.find((x) => x.rule === 'version-literal-in-installer')
    expect(v?.detail).toContain('5.5.2')
  })

  it('an installer that does not hand the read version to the block writer is named', () => {
    const { violations } = runFixture({ installer: { unwired: true } })
    expect(hasRule(violations, 'version-source-unwired')).toBe(true)
  })

  it('an unknown target is a violation, not a quiet zero', () => {
    const r = audit({
      target: 'bogus',
      readFile: () => {
        throw new Error('the audit must not read anything for an unknown target')
      },
      rootDir: FAKE_ROOT,
    })
    expect(r.count).toBe(1)
    expect(r.violations[0].rule).toBe('unknown-target')
  })
})

describe('the numbers audit — a missing anchor is loud, never a silent pass', () => {
  it('a front without a readable route table is parse-failed', () => {
    const { violations } = runFixture({ server: { noTable: true } })
    expect(hasRule(violations, 'parse-failed')).toBe(true)
  })

  it('a marked span missing from the map is region-missing', () => {
    const { violations } = runFixture({ graph: { dropRegion: 'sma:num-hero' } })
    const v = violations.filter((x) => x.rule === 'region-missing')
    expect(v).toHaveLength(1)
    expect(v[0].detail).toBe('sma:num-hero')
  })

  it('an absent receipt is NOT MEASURED — no violation, and notes say so in words', () => {
    const { violations, notes } = runFixture({ noReceipt: true, graph: { tests: 1145 } })
    expect(hasRule(violations, 'graph-region-stats')).toBe(false)
    expect(notes.join(' ')).toContain('not measured')
  })

  it('a receipt measured on a dirty tree is a note, not a violation', () => {
    const t = fakeTree({
      ...fixtureFiles(),
      'test-receipt.json': JSON.stringify({ tests: TESTS, files: FILES, dirty: true, commit: 'abc1234def' }),
    })
    const notes: string[] = []
    const violations = auditNumbers({
      readFile: t.readFile,
      listTemplates: t.listTemplates,
      listSourceFiles: t.listSourceFiles,
      rootDir: t.rootDir,
      notes,
    })
    expect(violations).toHaveLength(0)
    expect(notes.join(' ')).toContain('dirty')
  })
})

/**
 * THE ORDER OF THE MEASUREMENT. Twice in two phases a summary announced a green suite while
 * the tip actually handed over was red: the suite had been measured before the last commit,
 * and that last commit was the one that broke it. The rule «measure after the last commit»
 * was written in the plans and in every brief, and it held zero times out of two. So it
 * stopped being a matter of attentiveness and became this gate. Each case below plants one
 * answer from git — the real repository is never asked.
 */
describe('the numbers audit — the measurement must describe the tip it is handed over on', () => {
  /** git says HEAD moved past the receipt, and these files moved with it. */
  const gitMoved = (changed: string[]) => (argv: string[]) =>
    argv[0] === 'rev-parse' ? 'f00dfeed9999999999999999999999999999999\n' : `${changed.join('\n')}\n`

  it('a receipt measured before code landed is named, with the count and a file to look at', () => {
    const { violations } = runFixture({ git: gitMoved(['scripts/sma/lib/state.mjs', 'daemon/src/front/server.mjs']) })
    const v = violations.find((x) => x.rule === 'receipt-measured-before-head')
    expect(v?.file).toBe('test-receipt.json')
    expect(v?.detail).toContain('2 code/test change(s)')
    expect(v?.detail).toContain('scripts/sma/lib/state.mjs')
    expect(v?.detail).toContain(FIXTURE_HEAD)
  })

  it('a receipt measured before TESTS landed is drift too — a suite total is what they move', () => {
    const { violations } = runFixture({ git: gitMoved(['scripts/sma/__tests__/doc-audit-numbers.test.ts']) })
    expect(hasRule(violations, 'receipt-measured-before-head')).toBe(true)
  })

  it('a receipt that only the derived places moved past is NOT drift — writing it down makes a commit', () => {
    const { violations, notes } = runFixture({
      git: gitMoved(['test-receipt.json', 'README.md', 'README.ru.md', 'docs/master-graph.html', 'sma-core/VERSION']),
    })
    expect(hasRule(violations, 'receipt-measured-before-head')).toBe(false)
    expect(notes).toEqual([])
  })

  it('prose changed after the measurement is not drift — a rewritten paragraph moves no test', () => {
    const { violations } = runFixture({ git: gitMoved(['docs/DETAILS.md', 'docs/INSTALL.md']) })
    expect(hasRule(violations, 'receipt-measured-before-head')).toBe(false)
  })

  it('no git at all is a note and never a violation — the audit must work in an unpacked package', () => {
    const { violations, notes } = runFixture({
      git: () => {
        throw new Error('git: command not found')
      },
    })
    expect(hasRule(violations, 'receipt-measured-before-head')).toBe(false)
    expect(notes.join(' ')).toContain('no readable git history')
  })

  it('a commit git does not know is a note too, and says which commit it could not place', () => {
    const { violations, notes } = runFixture({
      git: (argv: string[]) => {
        if (argv[0] === 'rev-parse') return 'f00dfeed9999999999999999999999999999999\n'
        throw new Error("fatal: bad object abc1234")
      },
    })
    expect(hasRule(violations, 'receipt-measured-before-head')).toBe(false)
    expect(notes.join(' ')).toContain(FIXTURE_HEAD)
  })

  it('a receipt naming no commit says so in words instead of passing quietly', () => {
    const { violations, notes } = runFixture({ receiptCommit: null })
    expect(hasRule(violations, 'receipt-measured-before-head')).toBe(false)
    expect(notes.join(' ')).toContain('names no commit')
  })

  it('receiptDriftFiles keeps code and tests, drops prose and the places the remint writes', () => {
    expect(
      receiptDriftFiles([
        'test-receipt.json',
        'README.md',
        'README.ru.md',
        'docs/master-graph.html',
        'sma-core/VERSION',
        'docs/DETAILS.ru.md',
        '',
        'scripts/sma/cli.mjs',
        'spa/src/shell/Shell.tsx',
        'package.json',
      ]),
    ).toEqual(['scripts/sma/cli.mjs', 'spa/src/shell/Shell.tsx', 'package.json'])
  })

  it('reads the separator git prints on Windows the same as anywhere else', () => {
    expect(receiptDriftFiles(['scripts\\sma\\cli.mjs'])).toEqual(['scripts/sma/cli.mjs'])
  })
})

describe('wordToNumber — spelled-out numbers, or an honest refusal', () => {
  it('reads units, teens, tens and hyphenated compounds, case-insensitively', () => {
    expect(wordToNumber('FOURTEEN')).toBe(14)
    expect(wordToNumber('SIXTY-ONE')).toBe(61)
    expect(wordToNumber('FIFTY-SIX')).toBe(56)
    expect(wordToNumber('THIRTY')).toBe(30)
    expect(wordToNumber('ninety-nine')).toBe(99)
    expect(wordToNumber('ZERO')).toBe(0)
  })

  it('refuses what it does not know instead of guessing', () => {
    expect(wordToNumber('UMPTEEN')).toBe(null)
    expect(wordToNumber('SIXTY-TEN')).toBe(null)
    expect(wordToNumber('')).toBe(null)
    expect(wordToNumber(undefined as unknown as string)).toBe(null)
  })
})

describe('writeNumbers — the derived numbers, written and only there', () => {
  it('rewrites the marked spans and the install marker, and is idempotent', () => {
    const t = fakeTree(fixtureFiles({ graph: { version: '5.1.0', tests: 1145, files: 96 }, markerVersion: '1.6.1' }))
    const first = writeNumbers({ readFile: t.readFile, writeFile: t.writeFile, rootDir: t.rootDir })
    expect(first.written).toContain('docs/master-graph.html')
    expect(first.written).toContain('sma-core/VERSION')

    const graph = t.map.get(join(FAKE_ROOT, 'docs', 'master-graph.html')) as string
    expect(graph).toContain(`v${VERSION}`)
    expect(graph).toContain(`${TESTS} tests · ${FILES} files`)
    expect(t.map.get(join(FAKE_ROOT, 'sma-core', 'VERSION'))).toBe(`${VERSION}\n`)
    // history outside the spans is untouched
    expect(graph).toContain('v3.0.0 · 532 tests')
    expect(graph).toContain('v5.0.1 · 1145 tests')

    // and the tree it just wrote now audits clean
    const violations = auditNumbers({
      readFile: t.readFile,
      listTemplates: t.listTemplates,
      listSourceFiles: t.listSourceFiles,
      rootDir: t.rootDir,
    })
    expect(violations).toHaveLength(0)

    // second run: the same bytes, so nothing is written at all
    const second = writeNumbers({ readFile: t.readFile, writeFile: t.writeFile, rootDir: t.rootDir })
    expect(second.written).toEqual([])
  })

  it('without a measured receipt the statistics span is left alone, and said so', () => {
    const t = fakeTree(fixtureFiles({ noReceipt: true, graph: { version: '5.1.0', tests: 1145, files: 96 } }))
    const res = writeNumbers({ readFile: t.readFile, writeFile: t.writeFile, rootDir: t.rootDir })
    const graph = t.map.get(join(FAKE_ROOT, 'docs', 'master-graph.html')) as string
    expect(graph).toContain('1145 tests · 96 files') // untouched: a hand-typed count is the lie
    expect(graph).toContain(`v${VERSION}`) // the version is derivable, so it IS written
    expect(res.notes.join(' ')).toContain('no measured receipt')
  })
})

// ── the wires (real tree, read-only) ──────────────────────────────────────────

describe('wire: the door count read from the text is the door count of the live table', () => {
  it('parsing the front matches importing it', async () => {
    const { readFileSync } = await import('node:fs')
    const path = join(ROOT, 'daemon', 'src', 'front', 'server.mjs')
    const parsed = parseRouteCount(readFileSync(path, 'utf8'))
    const live = await import('../../../daemon/src/front/server.mjs')
    expect(parsed).toBe(Object.keys(live.ROUTES).length)
  })
})

describe('wire: the audit is reachable through the verb', () => {
  it('doc-audit --target numbers --count exits 0 with a bare integer last line', () => {
    const out = execFileSync('node', [REAL_CLI, 'doc-audit', '--target', 'numbers', '--count'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect((out.trim().split('\n').pop() as string).trim()).toMatch(/^\d+$/)
  })

  it('an unknown target reaches the caller as a named violation, not as silence', () => {
    const out = execFileSync('node', [REAL_CLI, 'doc-audit', '--target', 'bogus', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    const parsed = JSON.parse(out.trim().split('\n').pop() as string)
    expect(parsed.violations.some((v: { rule: string }) => v.rule === 'unknown-target')).toBe(true)
  })

  it('--write is refused without the numbers target, in words', () => {
    let code = 0
    let stderr = ''
    try {
      execFileSync('node', [REAL_CLI, 'doc-audit', '--write'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
    } catch (err) {
      const e = err as { status: number; stderr: string }
      code = e.status
      stderr = e.stderr
    }
    expect(code).toBe(1)
    expect(stderr).toContain('--target numbers')
  })
})

describe('wire: the help door the docs name actually opens', () => {
  it('--help and -h both print the verb list and exit 0', () => {
    for (const flag of ['--help', '-h']) {
      const out = execFileSync('node', [REAL_CLI, flag], { cwd: ROOT, encoding: 'utf8' })
      expect(out).toContain('doc-audit')
      // the two verbs the printed list used to omit
      expect(out).toContain('|deleteme|')
      expect(out).toContain('|memory-preview|')
    }
  })
})

describe('guard: the numbers target is at zero on the REAL tree', () => {
  /**
   * This is the test that turns `npm test` red the day any number in the docs stops
   * matching the code that owns it. Everything above proves the gate CAN go red on a
   * planted fixture; this one asserts the tree we actually ship is clean right now, with
   * the same default readers the verb uses, so a drift cannot hide behind an injected
   * reader. It reads and never writes.
   *
   * The assertion is on the whole list rather than on its length: when it fails, the
   * report has to name the divergences themselves, not just how many there were.
   */
  it('audit({target: numbers}) over the real tree reports no violations', () => {
    const { violations } = audit({ target: 'numbers', rootDir: ROOT })
    expect(violations).toEqual([])
  })
})
