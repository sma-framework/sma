/**
 * Tests for scripts/sma/lib/merge-gate.mjs.
 *
 * The serialized merge gate + the verified-live-only enforcing-scope predicate.
 *
 * Task 1 — merge-claim triplet + the `sma merge` ritual:
 *   - Test 1: the merge-claim triplet mirrors the push-claim (acquire/second-fails/check/release)
 *   - Test 2: runMerge ritual order — acquire -> merge WITHOUT committing -> tests on that tree
 *             -> commit AFTER the run -> receipt -> release
 *   - Test 3: a concurrent merge -> SOFT-deny with an override (never a hard block / throw)
 *   - Test 4: runMerge issues NO push / deploy subcommand (local integration only)
 *   - Test 5: tests-fail -> {merged:false, refused:true} + the merge is ABORTED, never committed
 *   - Test 6: fail-open — an execGit/runTests throw -> {ok:false} + the slot is released (never wedged)
 *
 * THE FOUR LOCKS THIS FILE ADDS, and the defect behind each:
 *   - a runner that answers with a PROMISE still merges green. Without the await in the
 *     ritual, `!!(promise && promise.passed)` is false and EVERY merge would be refused by a
 *     gate that looked like it worked. This case goes red the moment the await is removed.
 *   - a throw ANYWHERE after the merge starts leaves no half-merge behind: the undo
 *     subcommand was issued and the slot is free. Red the moment the undo leaves the catch.
 *   - «no runner wired» and «the runner itself said there was nothing to run» both answer
 *     null, and the receipt must still tell them apart in words. Red the moment null goes
 *     back to being nameless.
 *   - a branch already in the tree is SAID to be already in the tree; no commit is made and
 *     no run is claimed.
 *
 * Task 2 — enforcing scopes (verified-live-only soft-deny + the default-on PRE_CHECKS stream):
 *   - Test 7: enforceScope soft-denies ONLY a verified-LIVE claim; stale -> warn; none -> allow
 *   - Test 8: the stream runs by default — a clean env soft-denies a live overlap and stays
 *     silent without one (nothing to switch on; silence for a single-window user) set
 *   - Test 9: a soft-deny carries an override token; the stream is mayDeny:true (never a hard block)
 *   - Test 10: fail-open — an injected error -> allow; SMA_ENFORCE_SCOPES_DISABLE short-circuits before evidence
 *   - Test 11: founder word wins — a cooling-down / force-cleared scope is NEVER enforced
 *
 * A DI execGit records every args array so tests never touch git and can assert the
 * no-push invariant. Claims + journal go to per-test temp dirs (the real .sma/ is
 * NEVER touched, no real merge is ever run).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acquireMergeClaim,
  releaseMergeClaim,
  checkMergeClaim,
  runMerge,
  enforceScope,
  ENFORCE_OVERRIDE_HINT,
  NO_RUNNER_NOTE,
  RUNNER_SAID_NOTHING_RAN,
} from '../lib/merge-gate.mjs'
import { readJournal } from '../lib/journal.mjs'
import { verifyClaimEvidence } from '../lib/collision.mjs'
import { PRE_CHECKS } from '../lib/pre.mjs'

let claimsDir: string
let journalDir: string

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'sma-merge-gate-'))
  claimsDir = join(base, 'claims')
  journalDir = join(base, 'journal')
})

afterEach(() => {
  try {
    rmSync(join(claimsDir, '..'), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

/**
 * makeExecGit — a DI git runner that READS ITS ARGUMENTS AND ANSWERS BY THEM.
 *
 * It used to answer one fixed string to any question, which is how a fake ends up knowing
 * more than the library it stands in for: this very tree once had a green suite covering a
 * call to a method that did not exist, because the double had it and the live object did not.
 * Here the difference is load-bearing — bringing the branch in, asking whether anything came
 * in, recording it and undoing it are FOUR different questions with four different answers,
 * and a fake that blurs them cannot tell a merge that happened from one that was refused.
 *
 *   opts.throwOn      — 'merge' (the bring-in), 'commit', or 'abort' (`merge --abort`)
 *   opts.noMergeHead  — the MERGE_HEAD check answers empty: the branch was already in the tree
 *   opts.headReadThrows — reading HEAD after the commit fails; the MERGE_HEAD check still works
 */
function makeExecGit(
  opts: { throwOn?: string; resultSha?: string; noMergeHead?: boolean; headReadThrows?: boolean } = {},
) {
  const calls: Array<{ args: string[]; cwd: string | undefined }> = []
  const runner = (args: string[], o: { cwd?: string } = {}) => {
    calls.push({ args, cwd: o.cwd })
    const isAbort = args[0] === 'merge' && args.includes('--abort')
    const isBringIn = args[0] === 'merge' && !isAbort
    const isMergeHeadCheck = args[0] === 'rev-parse' && args.includes('MERGE_HEAD')

    if (opts.throwOn === 'abort' && isAbort) throw new Error('git merge --abort failed')
    if (opts.throwOn === 'merge' && isBringIn) throw new Error('git merge failed')
    if (opts.throwOn === 'commit' && args[0] === 'commit') throw new Error('git commit failed')

    if (isMergeHeadCheck) return opts.noMergeHead ? '' : 'MERGE_HEAD_SHA\n'
    if (args[0] === 'rev-parse') {
      if (opts.headReadThrows) throw new Error('git rev-parse HEAD failed')
      return `${opts.resultSha ?? 'MERGE_RESULT_SHA'}\n`
    }
    return ''
  }
  ;(runner as any).calls = calls
  return runner as ((args: string[], o?: { cwd?: string }) => string) & { calls: typeof calls }
}

/** The subcommand words issued so far, in order — `merge --abort` named apart from a merge. */
function verbsOf(execGit: { calls: Array<{ args: string[] }> }): string[] {
  return execGit.calls.map((c) => (c.args[0] === 'merge' && c.args.includes('--abort') ? 'merge --abort' : c.args[0]))
}

describe('merge-claim triplet + the sma merge ritual', () => {
  it('Test 1: the merge-claim triplet mirrors the push-claim (acquire/second-fails/check/release)', () => {
    const a = acquireMergeClaim({ by: 'T-a', branch: 'sma-wt/x', claimsDir, journalDir })
    expect(a.acquired).toBe(true)

    // a SECOND concurrent acquire returns {acquired:false, holder} — NOT a throw.
    const b = acquireMergeClaim({ by: 'T-b', branch: 'sma-wt/y', claimsDir, journalDir })
    expect(b.acquired).toBe(false)
    expect(b.holder && (b.holder as any).by).toBe('T-a')

    // checkMergeClaim reports the current holder WITHOUT mutating.
    const chk = checkMergeClaim({ claimsDir })
    expect(chk.live).toBe(true)
    expect(chk.who).toBe('T-a')
    expect(chk.branch).toBe('sma-wt/x')
    // still held after a read — no mutation.
    expect(acquireMergeClaim({ by: 'T-c', claimsDir, journalDir }).acquired).toBe(false)

    const rel = releaseMergeClaim({ by: 'T-a', claimsDir, journalDir })
    expect(rel.released).toBe(true)
    // after release, a fresh acquire wins.
    expect(acquireMergeClaim({ by: 'T-d', claimsDir, journalDir }).acquired).toBe(true)
  })

  it('Test 2: runMerge order — merge WITHOUT committing -> tests on that tree -> commit AFTER the run', async () => {
    const execGit = makeExecGit()
    let handed: any = null
    let issuedWhenTheRunnerWasCalled: string[] = []
    const runTests = (arg: any) => {
      handed = arg
      issuedWhenTheRunnerWasCalled = verbsOf(execGit)
      return { passed: true }
    }
    const res = (await runMerge({ branch: 'sma-wt/x', by: 'T-a', execGit, runTests, claimsDir, journalDir, cwd: '/repo' })) as any
    expect(res.merged).toBe(true)
    expect(res.testsPassed).toBe(true)

    // the branch was brought in WITHOUT being committed…
    const bringInIdx = execGit.calls.findIndex((c) => c.args[0] === 'merge' && c.args.includes('--no-commit'))
    const commitIdx = execGit.calls.findIndex((c) => c.args[0] === 'commit')
    expect(bringInIdx).toBeGreaterThanOrEqual(0)
    // …and the commit came AFTER the run, not before it. This is the whole reorder: at the
    // moment the runner was asked, no commit had been made, so a red answer still had
    // something to refuse.
    expect(issuedWhenTheRunnerWasCalled).not.toContain('commit')
    expect(commitIdx).toBeGreaterThan(bringInIdx)

    // the runner was handed the TREE and an explicit null sha — the merge commit did not
    // exist yet, and handing it the PREVIOUS head would name the tree before the branch came.
    expect(handed.cwd).toBe('/repo')
    expect(handed.resultSha).toBe(null)
    // the sha appears only after the commit, and that is what the receipt carries.
    expect(res.resultSha).toBe('MERGE_RESULT_SHA')
    // every git call carried an explicit cwd (no CWD teleport).
    for (const c of execGit.calls) expect(c.cwd).toBe('/repo')

    // a receipt was journaled.
    const j = readJournal({ journalDir })
    const receipt = j.events.find((e: any) => e.type === 'merge')
    expect(receipt).toBeTruthy()
    expect((receipt as any).detail.branch).toBe('sma-wt/x')
    expect((receipt as any).detail.testsPassed).toBe(true)

    // slot released — a subsequent acquire wins.
    expect(acquireMergeClaim({ by: 'T-b', claimsDir, journalDir }).acquired).toBe(true)
  })

  /**
   * ═══ ОТПЕЧАТОК КОММИТА СЛИЯНИЯ ПЕРЕСТАЁТ ОБРЕЗАТЬСЯ ПРИ ЗАПИСИ ══════════════════
   *
   * Из квитанции слияния собирается ОДНА команда, которую человек копирует и выполняет,
   * чтобы отменить приёмку: `git -C <репозиторий> revert -m 1 <отпечаток>`. Отпечаток
   * записывался обрезанным до семи знаков. Семи обычно хватает, но git требует ОДНОЗНАЧНОГО
   * префикса, и в достаточно большом дереве однажды перестанет хватать — а полный отпечаток
   * есть прямо в момент вычисления, и обрезать его там незачем. Короткая форма, если она
   * нужна глазам, получается при ОТОБРАЖЕНИИ.
   *
   * Рядом — путь репозитория, в котором слияние произошло: без него команда неполна, потому
   * что человек читает карточку не обязательно из того каталога, где лежит проект.
   */
  it('квитанция слияния несёт ПОЛНЫЙ отпечаток и путь репозитория — из них собирается команда отката', async () => {
    const full = '0123456789abcdef0123456789abcdef01234567'
    const execGit = makeExecGit({ resultSha: full })
    const res = (await runMerge({ branch: 'sma-wt/x', by: 'T-a', execGit, runTests: () => ({ passed: true }), claimsDir, journalDir, cwd: '/repo' })) as any
    expect(res.merged).toBe(true)
    expect(res.resultSha).toBe(full)

    const j = readJournal({ journalDir })
    const receipt = j.events.find((e: any) => e.type === 'merge') as any
    expect(receipt.detail.resultSha, 'отпечаток обрезан при ЗАПИСИ — команда отката собирается из огрызка').toBe(full)
    expect(receipt.detail.resultSha).toHaveLength(40)
    expect(receipt.detail.repo, 'без пути репозитория команда отката неполна').toBe('/repo')
  })

  it('нечего записывать — квитанция молчит, а не выдумывает: отпечаток null, путь назван', async () => {
    const execGit = makeExecGit({ headReadThrows: true })
    await runMerge({ branch: 'sma-wt/x', by: 'T-a', execGit, runTests: () => ({ passed: true }), claimsDir, journalDir, cwd: '/repo' })
    const j = readJournal({ journalDir })
    const receipt = j.events.find((e: any) => e.type === 'merge') as any
    expect(receipt.detail.resultSha).toBe(null)
    expect(receipt.detail.repo).toBe('/repo')
  })

  it('Test 3: a concurrent merge -> SOFT-deny with an override (never a hard block / throw)', async () => {
    // another terminal holds the merge slot.
    acquireMergeClaim({ by: 'T-other', branch: 'sma-wt/held', claimsDir, journalDir })
    const execGit = makeExecGit()
    const res = (await runMerge({ branch: 'sma-wt/x', by: 'T-a', execGit, runTests: () => ({ passed: true }), claimsDir, journalDir })) as any
    expect(res.merged).toBe(false)
    expect(res.softDenied).toBe(true)
    expect(typeof res.override).toBe('string')
    expect(res.override.length).toBeGreaterThan(0)
    // it never merged — no git call happened at all.
    expect(execGit.calls.length).toBe(0)
  })

  it('Test 4: runMerge issues NO push / deploy subcommand (local integration only)', async () => {
    const execGit = makeExecGit()
    const res = (await runMerge({ branch: 'sma-wt/x', by: 'T-a', execGit, runTests: () => ({ passed: true }), claimsDir, journalDir, cwd: '/repo' })) as any
    expect(res.merged).toBe(true)
    const verbs = execGit.calls.map((c) => c.args[0])
    expect(verbs).not.toContain('push')
    expect(execGit.calls.every((c) => !c.args.includes('push'))).toBe(true)
    // only local read/merge/record subcommands.
    for (const v of verbs) expect(['merge', 'rev-parse', 'commit']).toContain(v)
  })

  /**
   * ═══ КРАСНЫЙ ПРОГОН ОЗНАЧАЕТ, ЧТО СЛИЯНИЯ НЕ БЫЛО ══════════════════════════════
   *
   * Раньше здесь утверждалось `{merged:true, testsPassed:false}` — то есть ветка ВЛИТА, тесты
   * красные, и работа «вернулась ждать» поверх уже сдвинутой вершины. Гейт, который сначала
   * сливает, а потом смотрит, — не гейт, а отчёт задним числом. Теперь красный прогон
   * означает отказ: подкоманда отмены прозвучала, подкоманда фиксации — нет, вершина не
   * двинулась, и откатывать нечего, потому что ничего не произошло.
   */
  it('Test 5: красный прогон -> {merged:false, refused:true}: отмена прозвучала, фиксация — нет', async () => {
    const execGit = makeExecGit()
    const res = (await runMerge({ branch: 'sma-wt/x', by: 'T-a', execGit, runTests: () => ({ passed: false }), claimsDir, journalDir, cwd: '/repo' })) as any
    expect(res.merged).toBe(false)
    expect(res.testsPassed).toBe(false)
    expect(res.refused).toBe(true)

    const verbs = verbsOf(execGit)
    expect(verbs, 'красный прогон обязан ОТМЕНИТЬ незафиксированное слияние').toContain('merge --abort')
    expect(verbs, 'коммита слияния на красном прогоне быть не может').not.toContain('commit')

    // the journal carries a REFUSAL, not a merge that went badly.
    const j = readJournal({ journalDir })
    const receipt = j.events.find((e: any) => e.type === 'merge') as any
    expect(receipt.detail.testsPassed).toBe(false)
    expect(receipt.detail.refused).toBe(true)
    expect(String(receipt.detail.reason)).toMatch(/тест/i)
    expect(receipt.detail.resultSha, 'отпечатка нет — коммита слияния не было').toBe(null)
    // slot released even on a refusal.
    expect(acquireMergeClaim({ by: 'T-b', claimsDir, journalDir }).acquired).toBe(true)
  })

  /**
   * ═══ ОБЕЩАНИЕ ВМЕСТО ОТВЕТА НЕ КРАСИТ СЛИЯНИЕ ══════════════════════════════════
   *
   * Прогонятель звался БЕЗ ожидания. Асинхронная реализация вернула бы обещание, а
   * `!!(обещание && обещание.passed)` — это `false`: КАЖДОЕ слияние стало бы отказом, а гейт
   * при этом выглядел бы работающим. Мина срабатывает молча, поэтому замок стоит здесь: убери
   * ожидание из ритуала — и этот случай краснеет первым.
   */
  it('прогонятель, отвечающий обещанием, даёт ЗЕЛЁНОЕ слияние, а не отказ', async () => {
    const execGit = makeExecGit()
    const res = (await runMerge({
      branch: 'sma-wt/x',
      by: 'T-a',
      execGit,
      runTests: async () => ({ passed: true }),
      claimsDir,
      journalDir,
      cwd: '/repo',
    })) as any
    expect(res.merged, 'обещание вместо ответа прочитано как красный прогон — ожидание потеряно').toBe(true)
    expect(res.testsPassed).toBe(true)
    expect(verbsOf(execGit)).not.toContain('merge --abort')
  })

  it('обещание, которое отвечает КРАСНЫМ, тоже дочитывается — отказ, а не ложный зелёный', async () => {
    const execGit = makeExecGit()
    const res = (await runMerge({
      branch: 'sma-wt/x',
      by: 'T-a',
      execGit,
      runTests: async () => ({ passed: false }),
      claimsDir,
      journalDir,
      cwd: '/repo',
    })) as any
    expect(res.merged).toBe(false)
    expect(res.refused).toBe(true)
    expect(verbsOf(execGit)).toContain('merge --abort')
  })

  /**
   * ═══ ПОСЛЕ СБОЯ ДЕРЕВО НЕ ОСТАЁТСЯ В НЕЗАВЕРШЁННОМ СЛИЯНИИ ═════════════════════
   *
   * Закон об откатываемости требует не только возможности отката, но и видимости точки:
   * дерево, брошенное на полпути слияния, нельзя вернуть одной командой из записи. Поэтому
   * ЛЮБОЙ сбой после начала сведения — упавший прогонятель, конфликт, отказ журнала — сперва
   * отменяет незафиксированное слияние и только потом отпускает слот.
   */
  it('прогонятель бросил исключение -> {ok:false}, отмена прозвучала, слот отпущен', async () => {
    const execGit = makeExecGit()
    const res = (await runMerge({
      branch: 'sma-wt/x',
      by: 'T-a',
      execGit,
      runTests: () => {
        throw new Error('runner boom')
      },
      claimsDir,
      journalDir,
      cwd: '/repo',
    })) as any
    expect(res.ok).toBe(false)
    expect(verbsOf(execGit), 'упавший прогонятель оставил дерево в незавершённом слиянии').toContain('merge --abort')
    expect(verbsOf(execGit)).not.toContain('commit')
    expect(acquireMergeClaim({ by: 'T-b', claimsDir, journalDir }).acquired).toBe(true)
  })

  it('отмена, которая сама не удалась, НАЗЫВАЕТСЯ и несёт команду выхода', async () => {
    const execGit = makeExecGit({ throwOn: 'abort' })
    const res = (await runMerge({ branch: 'sma-wt/x', by: 'T-a', execGit, runTests: () => ({ passed: false }), claimsDir, journalDir, cwd: '/repo' })) as any
    expect(res.merged).toBe(false)
    expect(res.unfinishedMerge, 'молчание здесь — это «откатить можно, но не видно, к чему»').toBe(true)
    expect(String(res.howToClear)).toContain('merge --abort')
    expect(String(res.howToClear)).toContain('/repo')
    // and the same words are in the journal, not only in the return value.
    const j = readJournal({ journalDir })
    const receipt = j.events.find((e: any) => e.type === 'merge') as any
    expect(receipt.detail.unfinishedMerge).toBe(true)
    // the slot is free regardless — a gate bug never wedges a session.
    expect(acquireMergeClaim({ by: 'T-b', claimsDir, journalDir }).acquired).toBe(true)
  })

  /**
   * ═══ СОВПАДЕНИЕ ВЕТОК НАЗВАНО, А НЕ ВЫДАНО ЗА ПРОГОН ═══════════════════════════
   *
   * Когда ветка уже в дереве, сводить нечего и фиксировать нечего. Это не прогон и не отказ —
   * и ритуал говорит это словами вместо того, чтобы изобразить состоявшееся слияние.
   */
  it('ветка уже в дереве — сказано словами, фиксация не звучала, прогон не заявлен', async () => {
    const execGit = makeExecGit({ noMergeHead: true })
    let ranTests = false
    const res = (await runMerge({
      branch: 'sma-wt/x',
      by: 'T-a',
      execGit,
      runTests: () => {
        ranTests = true
        return { passed: true }
      },
      claimsDir,
      journalDir,
      cwd: '/repo',
    })) as any
    expect(res.alreadyUpToDate).toBe(true)
    expect(res.testsPassed).toBe(null)
    expect(String(res.testsNote)).toMatch(/сводить было нечего/i)
    expect(ranTests, 'сводить было нечего — прогонять тем более').toBe(false)
    expect(verbsOf(execGit)).not.toContain('commit')
    expect(res.resultSha).toBe(null)
    expect(acquireMergeClaim({ by: 'T-b', claimsDir, journalDir }).acquired).toBe(true)
  })

  /**
   * A RECEIPT STATES WHAT HAPPENED, AND NOTHING ELSE.
   *
   * With no test runner injected the ritual reported `testsPassed: true` — a claim that a run
   * nobody made had passed. It was measured on a live door: an approval with zero commits came
   * back saying the tests were green. There are three answers here, not two — passed, failed,
   * and «не запускались» — and only the third is honest when nothing ran.
   */
  it('no test runner -> testsPassed is NULL, in the return and in the receipt — never a green', async () => {
    const execGit = makeExecGit()
    const res = (await runMerge({ branch: 'sma-wt/x', by: 'T-a', execGit, claimsDir, journalDir, cwd: '/repo' })) as any
    expect(res.merged).toBe(true)
    expect(res.testsPassed).toBe(null)
    const j = readJournal({ journalDir })
    const receipt = j.events.find((e: any) => e.type === 'merge')
    expect((receipt as any).detail.testsPassed).toBe(null)
  })

  /**
   * ═══ «ПРОГОНА НЕ БЫЛО» ПЕРЕСТАЛО БЫТЬ БЕЗЫМЯННЫМ ══════════════════════════════
   *
   * Два разных мира приезжали к читателю с одним лицом: сборка, где прогонятель вообще не
   * подключён, и сборка, где он подключён, ответил, и его ответ — «запускать было нечего».
   * Первое — дыра в проводке, второе — факт о дереве. Различать их и есть смысл этого поля,
   * и оно обязано ехать И в возврат, И в квитанцию: различие, живущее только в памяти
   * исполнителя, — не различие.
   */
  it('«прогонятель не подключён» и «запускать было нечего» — оба null, но РАЗНЫМИ словами', async () => {
    const noRunner = (await runMerge({ branch: 'sma-wt/x', by: 'T-a', execGit: makeExecGit(), claimsDir, journalDir, cwd: '/repo' })) as any
    expect(noRunner.testsPassed).toBe(null)
    expect(noRunner.testsNote).toBe(NO_RUNNER_NOTE)
    expect(noRunner.receipt.testsNote).toBe(NO_RUNNER_NOTE)

    const nothingToRun = (await runMerge({
      branch: 'sma-wt/y',
      by: 'T-a',
      execGit: makeExecGit(),
      runTests: () => ({ passed: null }),
      claimsDir,
      journalDir,
      cwd: '/repo',
    })) as any
    expect(nothingToRun.merged).toBe(true)
    expect(nothingToRun.testsPassed).toBe(null)
    expect(nothingToRun.testsNote).toBe(RUNNER_SAID_NOTHING_RAN)
    expect(nothingToRun.receipt.testsNote).toBe(RUNNER_SAID_NOTHING_RAN)

    expect(noRunner.testsNote, 'два разных отсутствия обязаны звучать по-разному').not.toBe(nothingToRun.testsNote)

    // a runner with its OWN word keeps it — the receipt quotes the runner, not a paraphrase.
    const ownWord = (await runMerge({
      branch: 'sma-wt/z',
      by: 'T-a',
      execGit: makeExecGit(),
      runTests: () => ({ passed: null, note: 'в дереве нет ни одного рецепта' }),
      claimsDir,
      journalDir,
      cwd: '/repo',
    })) as any
    expect(ownWord.testsNote).toBe('в дереве нет ни одного рецепта')
    expect(ownWord.receipt.testsNote).toBe('в дереве нет ни одного рецепта')
  })

  it('a run that DID happen is reported as it went — true stays true, false stays false', async () => {
    const green = (await runMerge({
      branch: 'sma-wt/x',
      by: 'T-a',
      execGit: makeExecGit(),
      runTests: () => ({ passed: true }),
      claimsDir,
      journalDir,
    })) as any
    expect(green.testsPassed).toBe(true)
    expect(green.merged).toBe(true)
    const red = (await runMerge({
      branch: 'sma-wt/y',
      by: 'T-a',
      execGit: makeExecGit(),
      runTests: () => ({ passed: false }),
      claimsDir,
      journalDir,
    })) as any
    expect(red.testsPassed).toBe(false)
    expect(red.merged).toBe(false)
  })

  it('Test 6: fail-open — an execGit throw -> {ok:false} + the slot is released (never wedged)', async () => {
    const throwGit = makeExecGit({ throwOn: 'merge' })
    const res = (await runMerge({ branch: 'sma-wt/x', by: 'T-a', execGit: throwGit, runTests: () => ({ passed: true }), claimsDir, journalDir })) as any
    expect(res.ok).toBe(false)
    expect(typeof res.message).toBe('string')
    // a merge that exits non-zero STILL leaves the tree half-merged, so the undo is issued
    // even though the bring-in itself is what failed.
    expect(verbsOf(throwGit)).toContain('merge --abort')
    // the held slot was released by the fail-open wrapper — a subsequent acquire wins.
    const again = acquireMergeClaim({ by: 'T-b', claimsDir, journalDir })
    expect(again.acquired).toBe(true)
  })
})

/**
 * makeCtx — a minimal hand-built pre-stream ctx for the enforce stream. deps.mergeGate is
 * the real module; deps.collision.verifyClaimEvidence is the real predicate; deps.fingerprint
 * is a stub whose overlapInjection returns the injected overlaps (or throws when asked).
 */
function makeCtx(opts: { env?: Record<string, string>; overlaps?: any[]; overlapThrows?: boolean } = {}) {
  const overlaps = opts.overlaps ?? []
  return {
    env: opts.env ?? {},
    toolName: 'Edit',
    toolInput: { file_path: 'src/x.ts' },
    sessions: [],
    identity: { terminalId: 'self' },
    repoRoot: '/repo',
    now: () => Date.now(),
    deps: {
      mergeGate: { enforceScope },
      collision: { verifyClaimEvidence },
      fingerprint: {
        overlapInjection: () => {
          if (opts.overlapThrows) throw new Error('overlap boom')
          return overlaps
        },
      },
    },
  } as any
}

describe('enforcing scopes (verified-live-only soft-deny + default-on stream)', () => {
  it('Test 7: enforceScope soft-denies ONLY a verified-LIVE claim; stale -> warn; none -> allow', () => {
    // dirty scope (no post-renew commit) -> verifyClaimEvidence LIVE -> soft-deny + override.
    const live = enforceScope({ foreignClaim: { by: 'T-x' }, evidence: { scopeDirtyVsHead: true }, env: {}, verifyClaimEvidence })
    expect(live.action).toBe('soft-deny')
    expect(typeof live.override).toBe('string')
    expect((live.override as string).length).toBeGreaterThan(0)

    // clean scope + a post-renew in-scope commit -> STALE -> WARN-only (never soft-deny).
    const stale = enforceScope({
      foreignClaim: { by: 'T-x' },
      evidence: { scopeDirtyVsHead: false, commitInScopeAfterRenew: 'abcdef1' },
      env: {},
      verifyClaimEvidence,
    })
    expect(stale.action).toBe('warn')

    // no foreign claim -> allow.
    const none = enforceScope({ foreignClaim: null, env: {}, verifyClaimEvidence })
    expect(none.action).toBe('allow')
  })

  it('Test 8: the enforce stream runs by default — a clean env soft-denies a verified-live overlap', async () => {
    const stream = PRE_CHECKS.find((s: any) => s.id === 'enforce') as any
    expect(stream).toBeTruthy()
    expect(stream.mayDeny).toBe(true)
    expect(stream.killSwitchEnv).toBe('SMA_ENFORCE_SCOPES_DISABLE')

    // Nothing set in the environment — a person's shell the day after he installed —
    // plus a verified-live foreign overlap: the stream answers. No door to open first.
    const clean = await stream.run(makeCtx({ env: {}, overlaps: [{ terminalId: 'T-x' }] }))
    expect(clean.deny).toBeTruthy()

    // The other half of the promise, and the one a single-window user lives in: the same
    // clean environment with NO foreign overlap produces not one line — silence, not noise.
    const alone = await stream.run(makeCtx({ env: {}, overlaps: [] }))
    expect(alone.deny).toBeFalsy()
    expect(alone.warns).toEqual([])
  })

  it('Test 9: a soft-deny carries an override token; the stream is mayDeny:true (never a hard block)', async () => {
    const stream = PRE_CHECKS.find((s: any) => s.id === 'enforce') as any
    const on = await stream.run(makeCtx({ env: { SMA_ENFORCE_SCOPES: '1' }, overlaps: [{ terminalId: 'T-x' }] }))
    expect(on.deny).toBeTruthy()
    // the deny text carries the override token — so it can never block real work.
    expect(String(on.deny.text)).toContain(ENFORCE_OVERRIDE_HINT.slice(0, 20))
    // the enforce stream is a SOFT-deny tier (mayDeny:true); gates (the security guard tier) is separate.
    expect(stream.mayDeny).toBe(true)
    const gates = PRE_CHECKS.find((s: any) => s.id === 'gates')
    expect(gates).toBeTruthy()
    expect((gates as any).id).not.toBe(stream.id)
  })

  it('Test 10: fail-open — an injected error -> allow; SMA_ENFORCE_SCOPES_DISABLE short-circuits before evidence', async () => {
    // verifyClaimEvidence throws -> enforceScope returns allow (never a deny on error).
    const errored = enforceScope({
      foreignClaim: { by: 'T-x' },
      evidence: {},
      env: {},
      verifyClaimEvidence: () => {
        throw new Error('evidence boom')
      },
    })
    expect(errored.action).toBe('allow')

    // DISABLE short-circuits BEFORE any evidence read.
    let read = false
    const disabled = enforceScope({
      foreignClaim: { by: 'T-x' },
      evidence: {},
      env: { SMA_ENFORCE_SCOPES_DISABLE: '1' },
      verifyClaimEvidence: () => {
        read = true
        return { live: true }
      },
    })
    expect(disabled.action).toBe('allow')
    expect(read).toBe(false)

    // stream fail-open: an overlapInjection that throws -> {warns:[]}, no deny.
    const stream = PRE_CHECKS.find((s: any) => s.id === 'enforce') as any
    const r = await stream.run(makeCtx({ env: { SMA_ENFORCE_SCOPES: '1' }, overlapThrows: true }))
    expect(r.deny).toBeFalsy()
    expect(r.warns).toEqual([])
  })

  it('Test 11: founder word wins — a cooling-down / force-cleared scope is NEVER enforced', () => {
    const cooling = enforceScope({
      foreignClaim: { by: 'T-x' },
      evidence: { scopeDirtyVsHead: true }, // would be LIVE...
      env: {},
      verifyClaimEvidence,
      coolingDown: true, // ...but a cooling-down scope is never enforced.
    })
    expect(cooling.action).toBe('warn')
    expect(cooling.action).not.toBe('soft-deny')
  })
})
