/**
 * Tests for checks (g) and (h) of tools/verify-rebrand.mjs — the two halves of a test
 * file, read by the house law that bans internal register ids from product files.
 *
 * The hole check (g) covers: checks (d) and (f) exempt `__tests__` BY PATH, because a
 * test's literals are data — a suite that proves the scanner catches a forbidden
 * shape has to spell one. The exemption was reading the whole file, so an id that
 * landed in `it('…')` rode through a red gate untouched, even though a title is
 * printed to whoever reads the report and explains nothing to an adopter. Check (g)
 * reads the first string argument of `describe/it/test` under a test directory and
 * nothing else.
 *
 * The hole check (h) covers, found the same way and one delivery later: the DATA half
 * of that exemption was hiding forty-odd house backlog ids used as the identifiers of
 * MADE-UP tasks in `daemon/__tests__`. A fixture id is invented, so it has no reason to
 * wear the register's shape — unlike a decision counter, which a test can genuinely be
 * ABOUT. So check (h) is narrow where (g) is wide: three shapes a test never needs
 * (`SB-<n>`, `D-<n>.<n>`, `49.<n>`), and the register ids under test stay legal.
 *
 * WHY A CHILD PROCESS AND A THROWAWAY REPOSITORY. The scanner resolves its own root
 * from its own path and enumerates `git ls-files`, so "does the gate go red" is a
 * question about a process over a tracked tree — an in-process double would answer it
 * from the very assumption under test, and there is no way to plant a tracked fixture
 * in THIS repository without touching the index the human is working in. So each case
 * gets the real scanner, copied into a throwaway repository with the minimum tree its
 * other checks need, and is judged on exit code and stderr.
 *
 * The load-bearing behaviors:
 *   Test 1 — a forbidden shape in a title turns the gate RED, and the message names
 *            the file and the line.
 *   Test 2 — a register id a test is ABOUT stays green in ordinary test DATA: the
 *            narrow half of the path exemption is what makes the wide half safe to drop.
 *   Test 3 — a `describe(` written inside a STRING is text, not a call. This is the
 *            self-reference trap: the fixtures below are exactly that shape, and a
 *            scanner that read the raw line instead of the tokenizer's code positions
 *            would report this very file as the leak.
 *   Test 4 — the awkward-but-real forms are read too: a chained modifier and a title
 *            on its own line.
 *   Test 5 — the scanner is still green on THIS repository, including on this file.
 *   Test 6 — a house BACKLOG id planted as a fixture task id turns the gate RED, and the
 *            message names the file and the line. This is the decoy the delivery review
 *            asked for: the leak that got through was exactly this shape in exactly this
 *            position, so the gate is proved against a planted copy of it.
 *   Test 7 — the vendor's own phase number planted in fixture data is red too.
 *
 * THE SPECIMENS ARE ASSEMBLED, NEVER SPELLED. Check (h) reads the ordinary literals of a
 * test file, and this suite's inputs ARE the forbidden shapes — a file that spelled one
 * would report itself. The alternative, exempting this path, would put a permanent hole
 * in the gate this file exists to defend. So the shapes are built at run time and
 * interpolated into the sample sources: the child scanner is handed the real string, and
 * no literal in THIS file carries one.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const SCANNER = join('tools', 'verify-rebrand.mjs')
const SAMPLE = join('daemon', '__tests__', 'sample.test.ts')

let tmp: string

/** Run a command in the throwaway tree and fail LOUD — status, signal and stderr. */
function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false })
  return {
    status: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    why: `status=${r.status} signal=${r.signal} err=${r.error?.message ?? ''}\n${r.stderr ?? ''}`,
  }
}

/** Write the sample suite, track it, and run the real scanner over the tree. */
function scan(sample: string) {
  writeFileSync(join(tmp, SAMPLE), sample)
  const added = run('git', ['add', '-A'], tmp)
  expect(added.status, added.why).toBe(0)
  return run(process.execPath, [SCANNER], tmp)
}

// The two forbidden shapes this suite plants, assembled rather than written — see the
// header. `BACKLOG_ID` is a private-backlog id, `HOUSE_PHASE` the vendor's phase number.
const BACKLOG_ID = ['SB', '031'].join('-')
const HOUSE_PHASE = ['49', '2'].join('.')

// The suites below are written as source text on purpose: they are the INPUT to the
// scanner, never run by this runner. A quoted call is data — see Test 3.
const BAD_TITLE = `import { describe, it, expect } from 'vitest'

describe('the collision ledger', () => {
  it('D-11-08 survives a restart', () => {
    expect(true).toBe(true)
  })
})
`

// The register ids a test can genuinely be ABOUT: a decision counter and a threat id are
// the SUBJECT of the assertions below, so check (h) leaves them alone.
const TITLES_ARE_PROSE_DATA_IS_DATA = `import { describe, it, expect } from 'vitest'

const ROW = { decision: 'D-11-08', threat: 'T-9.1-43' }

describe('the collision ledger', () => {
  it('keeps the register id it was handed', () => {
    expect(ROW.decision).toBe('D-11-08')
    expect(ROW.threat).toBe('T-9.1-43')
  })
})
`

const QUOTED_CALL = `import { describe, it, expect } from 'vitest'

describe('the scanner reading itself', () => {
  it('treats a quoted call as text', () => {
    const source = "describe('D-11-08 — a title inside a string')"
    expect(source).toContain('describe')
  })
})
`

const AWKWARD_FORMS = `import { describe, it, expect } from 'vitest'

describe.skip(
  'D-11-08 named through a chained modifier and a line break',
  () => {
    it('ordinary', () => {
      expect(true).toBe(true)
    })
  },
)
`

const CLEAN = `import { describe, it, expect } from 'vitest'

describe('the collision ledger', () => {
  it('survives a restart', () => {
    expect(true).toBe(true)
  })
})
`

// THE DECOY (Test 6). A house backlog id standing in for the id of a MADE-UP task — the
// exact position the real leak was found in, planted here so the gate is proved against it
// rather than trusted. The id sits on line 3 and line 7 of the sample.
const HOUSE_ID_AS_FIXTURE = `import { describe, it, expect } from 'vitest'

const TASK = { id: '${BACKLOG_ID}', title: 'починить дверь приёмки' }

describe('the queue', () => {
  it('keeps the task it was handed', () => {
    expect(TASK.id).toBe('${BACKLOG_ID}')
  })
})
`

// The same decoy for the second armed shape: the vendor's phase number, which a fixture
// picks up by copying a real phase directory name. Line 3 of the sample.
const HOUSE_PHASE_AS_FIXTURE = `import { describe, it, expect } from 'vitest'

const DIR = '${HOUSE_PHASE}-sma-v3-trust-spine'

describe('the phase index', () => {
  it('reads the directory name', () => {
    expect(DIR).toContain('trust-spine')
  })
})
`

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sma-rebrand-titles-'))
  // The minimum tree the scanner's other checks need: an agent with a color, a
  // workflow directory to walk, and a test directory to plant the sample in.
  mkdirSync(join(tmp, 'tools'), { recursive: true })
  mkdirSync(join(tmp, 'sma-core', 'agents'), { recursive: true })
  mkdirSync(join(tmp, 'sma-core', 'workflows'), { recursive: true })
  mkdirSync(join(tmp, 'daemon', '__tests__'), { recursive: true })
  copyFileSync(join(REPO_ROOT, SCANNER), join(tmp, SCANNER))
  writeFileSync(join(tmp, 'sma-core', 'agents', 'sma-scout.md'), '---\nname: sma-scout\ncolor: blue\n---\n\nAn agent.\n')
  writeFileSync(join(tmp, 'sma-core', 'workflows', 'run.md'), 'A workflow that dispatches nobody.\n')
  const init = run('git', ['init', '-q'], tmp)
  expect(init.status, init.why).toBe(0)
})

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('verify-rebrand (g) — a test title is prose', () => {
  it('goes red on a register id in a title, and names the file and the line (Test 1)', () => {
    const r = scan(BAD_TITLE)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('TEST-TITLE: daemon/__tests__/sample.test.ts:4')
    expect(r.out).toContain('survives a restart')
  })

  it('stays green on a register id the test is ABOUT, used as DATA (Test 2)', () => {
    const r = scan(TITLES_ARE_PROSE_DATA_IS_DATA)
    expect(r.status, r.out).toBe(0)
    expect(r.out).not.toContain('TEST-TITLE')
    expect(r.out).not.toContain('TEST-FIXTURE-ID')
  })

  it('stays green on a call written inside a string literal (Test 3)', () => {
    const r = scan(QUOTED_CALL)
    expect(r.status, r.out).toBe(0)
    expect(r.out).not.toContain('TEST-TITLE')
  })

  it('reads a chained modifier and a title on its own line (Test 4)', () => {
    const r = scan(AWKWARD_FORMS)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('TEST-TITLE: daemon/__tests__/sample.test.ts:4')
  })

  it('leaves an ordinary title alone, and reports how many it read', () => {
    const r = scan(CLEAN)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/test titles scanned: [1-9]\d*/)
    expect(r.out).toMatch(/test fixture literals scanned: [1-9]\d*/)
  })
})

describe('verify-rebrand (h) — a fixture id is invented, so it does not wear the house shape', () => {
  it('goes red on a house backlog id used as a fixture task id (Test 6)', () => {
    const r = scan(HOUSE_ID_AS_FIXTURE)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('TEST-FIXTURE-ID: daemon/__tests__/sample.test.ts:3')
    expect(r.out).toContain('TEST-FIXTURE-ID: daemon/__tests__/sample.test.ts:7')
    // the report shows the offending shape, not just the coordinates
    expect(r.out).toContain(BACKLOG_ID)
  })

  it("goes red on the vendor's phase number used as fixture data (Test 7)", () => {
    const r = scan(HOUSE_PHASE_AS_FIXTURE)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('TEST-FIXTURE-ID: daemon/__tests__/sample.test.ts:3')
    expect(r.out).toContain(HOUSE_PHASE)
  })

  it('leaves the SAME sample alone once the id is a neutral product one', () => {
    const r = scan(HOUSE_ID_AS_FIXTURE.split(BACKLOG_ID).join('R-031'))
    expect(r.status, r.out).toBe(0)
    expect(r.out).not.toContain('TEST-FIXTURE-ID')
  })
})

describe('verify-rebrand — the scanner does not go red on this repository', () => {
  // The scanner walks the WHOLE tree (7k+ test titles) as a child process; under a full
  // parallel suite run that walk shares the machine with every other worker and the default
  // 30s budget times out on a tree the scanner clears in seconds when idle. The budget is
  // about the machine's load, not the scanner's health — so it is set where a loaded run
  // still finishes, and a hang still fails.
  it('is green on the real tree, this suite and its specimens included (Test 5)', () => {
    const r = run(process.execPath, [SCANNER], REPO_ROOT)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/test titles scanned: \d+/)
  }, 180_000)
})
