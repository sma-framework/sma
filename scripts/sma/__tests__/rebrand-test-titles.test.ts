/**
 * Tests for check (g) of tools/verify-rebrand.mjs — a test TITLE is prose, and the
 * house law that bans internal register ids from product files binds it too.
 *
 * The hole this covers: checks (d) and (f) exempt `__tests__` BY PATH, because a
 * test's literals are data — a suite that proves the scanner catches a forbidden
 * shape has to spell one. The exemption was reading the whole file, so an id that
 * landed in `it('…')` rode through a red gate untouched, even though a title is
 * printed to whoever reads the report and explains nothing to an adopter. Check (g)
 * reads the first string argument of `describe/it/test` under a test directory and
 * nothing else.
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
 *   Test 2 — the same shape in ordinary test DATA stays green: the narrow half of the
 *            path exemption is what makes the wide half safe to drop.
 *   Test 3 — a `describe(` written inside a STRING is text, not a call. This is the
 *            self-reference trap: the fixtures below are exactly that shape, and a
 *            scanner that read the raw line instead of the tokenizer's code positions
 *            would report this very file as the leak.
 *   Test 4 — the awkward-but-real forms are read too: a chained modifier and a title
 *            on its own line.
 *   Test 5 — the scanner is still green on THIS repository, including on this file.
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

// The suites below are written as source text on purpose: they are the INPUT to the
// scanner, never run by this runner. A quoted call is data — see Test 3.
const BAD_TITLE = `import { describe, it, expect } from 'vitest'

describe('the collision ledger', () => {
  it('D-11-08 survives a restart', () => {
    expect(true).toBe(true)
  })
})
`

const TITLES_ARE_PROSE_DATA_IS_DATA = `import { describe, it, expect } from 'vitest'

const ROW = { decision: 'D-11-08', threat: 'T-9.1-43', backlog: 'SB-031' }

describe('the collision ledger', () => {
  it('keeps the register id it was handed', () => {
    expect(ROW.decision).toBe('D-11-08')
    expect(ROW.threat).toBe('T-9.1-43')
    expect(ROW.backlog).toBe('SB-031')
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

  it('stays green on the same shape used as test DATA (Test 2)', () => {
    const r = scan(TITLES_ARE_PROSE_DATA_IS_DATA)
    expect(r.status, r.out).toBe(0)
    expect(r.out).not.toContain('TEST-TITLE')
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
