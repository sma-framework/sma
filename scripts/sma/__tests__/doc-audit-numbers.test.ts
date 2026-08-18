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

function readmeMd(lang: 'en' | 'ru', opts: { version?: string } = {}) {
  const v = opts.version ?? VERSION
  const alt = lang === 'ru' ? `версия ${v}` : `version ${v}`
  return `# SMA\n<img src="https://img.shields.io/badge/version-${v}-3B82F6" alt="${alt}">\n`
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

type FixtureOpts = {
  server?: Parameters<typeof serverMjs>[0]
  cli?: Parameters<typeof cliMjs>[0]
  graph?: Parameters<typeof graphHtml>[0]
  installer?: Parameters<typeof installerMjs>[0]
  version?: string
  capabilityVersion?: string
  markerVersion?: string
  cliReadmeCount?: number
  testScript?: string
  noReceipt?: boolean
  templateWriter?: string
  sourceDefines?: string
}

/** The whole fixture tree, consistent by default: a clean run must score zero. */
function fixtureFiles(o: FixtureOpts = {}): Record<string, string> {
  const version = o.version ?? VERSION
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      version,
      scripts: { test: o.testScript ?? 'vitest run && node scripts/sma/lib/badge.mjs --check' },
    }),
    'daemon/src/front/server.mjs': serverMjs(o.server),
    'scripts/sma/cli.mjs': cliMjs(o.cli),
    'scripts/sma/README.md': `All ${o.cliReadmeCount ?? 3}, grouped by what they are for.`,
    'docs/master-graph.html': graphHtml(o.graph),
    'README.md': readmeMd('en', { version }),
    'README.ru.md': readmeMd('ru', { version }),
    'sma-core/capabilities/sma/capability.json': JSON.stringify({ version: o.capabilityVersion ?? version }),
    'sma-core/VERSION': `${o.markerVersion ?? version}\n`,
    'bin/init.mjs': installerMjs(o.installer),
    'sma-core/templates/state.md': `<!-- placeholder; ${o.templateWriter ?? 'writeStateHeader'} fills it in -->`,
    'scripts/sma/lib/state.mjs': `export function ${o.sourceDefines ?? 'writeStateHeader'}() {}`,
  }
  if (!o.noReceipt) {
    files['test-receipt.json'] = JSON.stringify({ tests: TESTS, files: FILES, dirty: false, commit: 'abc1234' })
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

  it("a stale verb total in the CLI's own README is named", () => {
    const { violations } = runFixture({ cliReadmeCount: 89 })
    expect(hasRule(violations, 'scripts-readme-verb-count')).toBe(true)
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
