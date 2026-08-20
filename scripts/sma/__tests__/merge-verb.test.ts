/**
 * Tests for the `merge` verb of the command line — the ritual's OTHER caller.
 *
 * WHY THIS FILE EXISTS AT ALL. Until it was written, nothing in either suite directory ran
 * the merge verb or its self-test: the library underneath was covered, the verb on top was
 * not. That gap is not academic. The ritual is asynchronous, and a forgotten await at any of
 * its call sites reads back as a promise — a value that is neither an error nor a merge. At
 * the verb's own call site that mistake is the worst kind: the verb would print «влит в main
 * ЛОКАЛЬНО» and return ZERO, a silent lie about a merge it never read the answer to. A whole
 * green suite would have said nothing about it.
 *
 * The file closes that gap from two directions:
 *
 *   1. BY RUNNING IT. The verb's self-test is executed as a real child process, and the verb
 *      itself is driven end to end over a throwaway repository. A promise where an answer
 *      belongs turns both of those red.
 *   2. BY READING IT. The live call sites of the ritual are asserted one by one — and the
 *      claim made about each is its OWN, because the property differs between them. Writing
 *      «all of them are awaited» would be a lie about the first one, and a reader who
 *      believed it would either quietly drop it from the lock or add an await to a closure
 *      that must not have one. The NUMBER of sites is asserted too, so a fifth one appearing
 *      without an answer turns this file red rather than passing unnoticed.
 */

import { describe, it, expect } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'cli.mjs')
const CLI_SRC = readFileSync(CLI, 'utf8')
const DAEMON_MAIN = readFileSync(join(HERE, '..', '..', '..', 'daemon', 'src', 'main.mjs'), 'utf8')
const FRONT_SERVER = readFileSync(join(HERE, '..', '..', '..', 'daemon', 'src', 'front', 'server.mjs'), 'utf8')
const PRODUCT_ROOT = join(HERE, '..', '..', '..')

/** Windows and git disagree about slashes; comparisons here are about the PLACE, not the spelling. */
function norm(p: string): string {
  return String(p).replace(/[\\/]+/g, '/').toLowerCase()
}

/** The lines of a source that call the ritual with an options object. */
function ritualCallLines(src: string): string[] {
  return src.split('\n').filter((l) => /\brunMerge\(\{/.test(l))
}

describe('the merge verb proves itself, and its self-test is actually run', () => {
  it('the self-test prints a bare 1 and exits 0', () => {
    const r = spawnSync(process.execPath, [CLI, 'merge', '--selftest'], { encoding: 'utf8' })
    expect(r.error, String(r.error)).toBeUndefined()
    expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0)
    const lines = String(r.stdout).trim().split('\n')
    expect(lines[lines.length - 1].trim(), 'the numeric-last-line contract the scorer reads').toBe('1')
  })

  it('the enforce self-test still prints a bare 1 and exits 0', () => {
    const r = spawnSync(process.execPath, [CLI, 'merge', '--selftest-enforce'], { encoding: 'utf8' })
    expect(r.error, String(r.error)).toBeUndefined()
    expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0)
    const lines = String(r.stdout).trim().split('\n')
    expect(lines[lines.length - 1].trim()).toBe('1')
  })
})

describe('every live call site of the ritual is answered — each by its OWN claim', () => {
  /**
   * SITE 1 — the daemon's door closure. There is NO await here, and there must not be: the
   * line RETURNS the ritual's call, and the awaiting belongs to whoever called the closure.
   * The claim is therefore a PAIR — the closure hands the result back rather than swallowing
   * it, AND the door that invokes the closure awaits it.
   */
  it('site 1 — the door closure RETURNS the ritual, and the door that calls it awaits', () => {
    // FOUR different collaborators in that file are called `verbRunner`, and only ONE of them
    // is the merge ritual — matching on the name alone lands on a runner of command-line verbs
    // belonging to another door entirely. The line is identified by what it CALLS.
    const line = DAEMON_MAIN.split('\n').find((l) => l.includes('verbRunner:') && l.includes('runMerge')) ?? ''
    expect(line, 'the door closure that calls the merge ritual was not found at all').toContain('runMerge')
    // it RETURNS the call — an arrow with a body that hands the value back, not a statement
    // that starts it and drops the answer on the floor.
    expect(line).toMatch(/=>\s*runMerge\(/)
    // …and the caller in the approval door awaits the closure. This is where the answer is
    // read; adding an await to the closure above would be editing the wrong line entirely.
    const callerLine = FRONT_SERVER.split('\n').find((l) => l.includes('deps.verbRunner(')) ?? ''
    expect(callerLine, 'the door that invokes the closure was not found').not.toBe('')
    expect(callerLine, 'the closure is invoked without waiting for its answer').toContain('await')
  })

  /**
   * SITES 2, 3 AND 4 — the three calls inside the verb's self-test: the green ritual, the
   * refused red run, and the concurrent soft-deny. Here the await belongs on the call ITSELF.
   * A miss is also caught behaviourally: the merge flag would be a promise, the self-test
   * would print 0 and exit 1, and the cases at the top of this file go red.
   *
   * SITE 5 — the body of the verb. The await belongs on the call itself, and this is the
   * costliest site to miss: with a promise in hand neither the failure flag nor the merge flag
   * can be read, so the verb prints «влит в main ЛОКАЛЬНО» and returns ZERO. A lie about a
   * merge, told with a success code. It is closed behaviourally further down as well.
   */
  it('sites 2 to 5 — every call in the command line waits for its answer', () => {
    const lines = ritualCallLines(CLI_SRC)
    expect(lines.length, 'the command line no longer holds the four call sites this lock knows').toBe(4)
    for (const l of lines) {
      expect(l, `a call to the ritual with no await: ${l.trim()}`).toMatch(/await\s+\w+\.runMerge\(\{/)
    }
  })

  /**
   * THE COUNT IS PART OF THE LOCK. A new call site appearing without a claim of its own is the
   * exact way this coverage would rot, so the number is asserted rather than implied — and it
   * is asserted per FILE, because the two files hold sites with different properties and a
   * single total would let one grow while the other shrank.
   */
  it('the ritual has FIVE live call sites — a sixth must come here for its own claim', () => {
    const daemonCalls = ritualCallLines(DAEMON_MAIN)
    const cliCalls = ritualCallLines(CLI_SRC)
    expect(daemonCalls.length, 'the daemon holds exactly one — the door closure').toBe(1)
    expect(cliCalls.length, 'the command line holds three self-test calls and the verb body').toBe(4)
    expect(daemonCalls.length + cliCalls.length).toBe(5)
  })
})

/**
 * ═══ ТЕЛО ВЕРБА ЗАКРЫТО ПРОГОНОМ, А НЕ ЧТЕНИЕМ ═══════════════════════════════════
 *
 * Одноразовый репозиторий, своя ветка, свой каталог координации — общий чекаут и общий слот
 * слияния не задеты ни разу. Герметичность здесь не предполагается, а УТВЕРЖДАЕТСЯ: верб сам
 * называет дерево, в котором действовал, и квитанция обязана указывать на временный
 * репозиторий. Прогонятель верба в этом дереве отвечает красным (запускать нечем), и это
 * ровно тот случай, который проверяется: красный прогон означает, что слияния НЕ БЫЛО.
 */
describe('the verb refuses a red run in a throwaway repository, and says so', () => {
  it('a red run leaves the tip where it was, prints a refusal and exits non-zero', () => {
    const repo = mkdtempSync(join(tmpdir(), 'sma-merge-verb-'))
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
    try {
      git(['init', '-q'])
      git(['config', 'user.email', 'suite@example.invalid'])
      git(['config', 'user.name', 'suite'])
      git(['config', 'commit.gpgsign', 'false'])
      writeFileSync(join(repo, 'a.txt'), 'a\n', 'utf8')
      git(['add', 'a.txt'])
      git(['commit', '-q', '--no-verify', '-m', 'init'])
      const trunk = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
      const tipBefore = git(['rev-parse', 'HEAD']).trim()

      git(['checkout', '-q', '-b', 'feature-x'])
      writeFileSync(join(repo, 'b.txt'), 'b\n', 'utf8')
      git(['add', 'b.txt'])
      git(['commit', '-q', '--no-verify', '-m', 'feat'])
      git(['checkout', '-q', trunk])

      const r = spawnSync(process.execPath, [CLI, 'merge', 'feature-x'], { cwd: repo, encoding: 'utf8' })
      expect(r.error, String(r.error)).toBeUndefined()

      // ── hermeticity is ASSERTED, not assumed: the verb names the tree it acted in.
      const journalDir = join(repo, '.sma', 'journal')
      const files = readdirSync(journalDir).filter((f) => f.endsWith('.jsonl'))
      expect(files.length, 'the ritual journalled nothing — there is no receipt to read').toBeGreaterThan(0)
      const events = files
        .flatMap((f) => readFileSync(join(journalDir, f), 'utf8').split('\n'))
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
      const receipt = events.filter((e: any) => e.type === 'merge').pop()
      expect(receipt, 'no merge receipt in the throwaway journal').toBeTruthy()
      expect(norm((receipt as any).detail.repo), 'the verb acted somewhere else than the throwaway repository').toContain(
        norm(basename(repo)),
      )
      expect(norm((receipt as any).detail.repo)).not.toBe(norm(PRODUCT_ROOT))

      // ── the refusal itself.
      expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).not.toBe(0)
      expect(r.stderr).toMatch(/ОТКАЗАНО/)
      expect(r.stdout, 'a refusal must never print the sentence that claims a merge').not.toMatch(/влит в main/)
      expect((receipt as any).detail.refused).toBe(true)
      expect((receipt as any).detail.testsPassed).toBe(false)

      // ── and the tree is where it was: no merge commit, nothing half-merged.
      expect(git(['rev-parse', 'HEAD']).trim(), 'the tip moved on a refused merge').toBe(tipBefore)
      const status = git(['status', '--porcelain'])
      expect(status, 'the tree was left in an unfinished merge').not.toMatch(/^(UU|AA|DU|UD|AU|UA|DD)\s/m)
    } finally {
      try {
        rmSync(repo, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  }, 120000)
})
