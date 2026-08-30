/**
 * Уборка волны сливает ветки исполнителей ЧЕРЕЗ ритуал слияния — эти тесты
 * держат закрытой дыру, через которую она сливала мимо него.
 *
 * Дефект, ради которого файл существует: помощник уборки волны
 * (sma-core/bin/lib/worktree-safety.cjs, глагол `worktree cleanup-wave`) делал
 * голое `git merge --no-ff` — без прогона на сведённом дереве, без квитанции в
 * журнале, и единственным отказом, который он знал, был конфликт самого git.
 * Красный прогон слияние волны не останавливал ВООБЩЕ, тогда как терминальный
 * глагол слияния и дверь одобрения демона ходят через runMerge с его смоком:
 * собственный конвейер обходил ворота, которые сам же построил.
 *
 * Почему настоящий git, а не подделка: «двинулась ли вершина главной ветки»,
 * «остался ли конфликт в общем дереве», «уцелела ли копия исполнителя» —
 * вопросы к дереву на диске, и двойник ответил бы на них из того самого
 * допущения, которое проверяется. Каждый кейс — одноразовый репозиторий,
 * настоящий `git worktree add` и настоящий ритуал (merge-gate.mjs); подменяется
 * только ВЕРДИКТ прогонятеля — ровно тот шов, который ритуал держит для тестов.
 * Претензии и журнал уходят в одноразовые каталоги — настоящий .sma/ не
 * затрагивается никогда.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireMergeClaim, runMerge } from '../lib/merge-gate.mjs'
import { readJournal } from '../lib/journal.mjs'

const require_ = createRequire(import.meta.url)
const wts = require_('../../../sma-core/bin/lib/worktree-safety.cjs')

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

let sandbox: string

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'sma-wave-merge-'))
})

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

/** Одноразовый репозиторий: main с одним базовым коммитом. */
function makeRepo(): { repoRoot: string; baseSha: string } {
  const repoRoot = join(sandbox, 'main')
  mkdirSync(repoRoot, { recursive: true })
  git(['init', '-b', 'main'], repoRoot)
  git(['config', 'user.email', 'suite@example.invalid'], repoRoot)
  git(['config', 'user.name', 'Suite'], repoRoot)
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n')
  git(['add', '.'], repoRoot)
  git(['commit', '-m', 'base'], repoRoot)
  return { repoRoot, baseSha: git(['rev-parse', 'HEAD'], repoRoot).trim() }
}

/**
 * Копия исполнителя: настоящий `git worktree add -b worktree-agent-<имя>` от main
 * плюс один закоммиченный файл работы. `conflict: true` правит ту же строку, что
 * потом правит main, — готовый конфликт для кейса об откате.
 */
function addAgentWorktree(repoRoot: string, name: string, opts: { conflict?: boolean } = {}) {
  const branch = `worktree-agent-${name}`
  const wtPath = join(sandbox, `wt-${name}`)
  git(['worktree', 'add', '-b', branch, wtPath, 'main'], repoRoot)
  writeFileSync(join(wtPath, opts.conflict ? 'base.txt' : `${name}.txt`), `${name}: work\n`)
  git(['add', '.'], wtPath)
  git(['commit', '-m', `work of ${name}`], wtPath)
  return { branch, wtPath }
}

/** План уборки из манифеста той же формы, что пишет запись агентов волны. */
function makePlan(repoRoot: string, baseSha: string, agents: Array<{ branch: string; wtPath: string }>) {
  const manifest = JSON.stringify({
    orchestrator_root: repoRoot,
    worktrees: agents.map((a, i) => ({
      agent_id: `agent-${i + 1}`,
      worktree_path: a.wtPath,
      branch: a.branch,
      expected_base: baseSha,
    })),
  })
  return wts.planWorktreeWaveCleanup(repoRoot, manifest)
}

/**
 * Настоящий ритуал с подменённым ВЕРДИКТОМ прогонятеля — тот же runMerge, те же
 * git-команды, тот же журнал; только смок отвечает то, что велит кейс.
 */
function ritualWith(runTests: () => { passed: boolean | null; ran: boolean }) {
  const claimsDir = join(sandbox, 'claims')
  const journalDir = join(sandbox, 'journal')
  const runWaveMerge = (o: { branch: string; repoRoot: string }) =>
    runMerge({ branch: o.branch, by: 'suite-wave', runTests, claimsDir, journalDir, cwd: o.repoRoot })
  return { runWaveMerge, claimsDir, journalDir }
}

describe('уборка волны сливает через ритуал слияния, а не голым git merge', () => {
  it('красный прогон на сведённом дереве останавливает слияние волны: вершина не двигается, копия цела, хвост волны — в pending, отказ — квитанцией', async () => {
    const { repoRoot, baseSha } = makeRepo()
    const one = addAgentWorktree(repoRoot, 'one')
    const two = addAgentWorktree(repoRoot, 'two')
    const plan = makePlan(repoRoot, baseSha, [one, two])
    const { runWaveMerge, journalDir } = ritualWith(() => ({ passed: false, ran: true }))

    const res = await wts.executeWorktreeWaveCleanupPlan(plan, { runWaveMerge })

    expect(res.ok).toBe(false)
    expect(res.entries[0].status).toBe('blocked')
    expect(res.entries[0].reason).toBe('merge_refused_tests_red')
    // отказ назван словами, а не кодом git
    expect(String(res.entries[0].stderr)).toContain('красн')
    // вершина главной ветки не двинулась — красный прогон НЕ вошёл в историю
    expect(git(['rev-parse', 'HEAD'], repoRoot).trim()).toBe(baseSha)
    // копия и ветка исполнителя целы: непринятая работа не съедена уборкой
    expect(existsSync(one.wtPath)).toBe(true)
    expect(git(['rev-parse', '--verify', `refs/heads/${one.branch}`], repoRoot).trim()).toBeTruthy()
    // хвост волны не тронут и ждёт решения
    expect(res.pending.map((e: { branch: string }) => e.branch)).toContain(two.branch)
    // отказ записан квитанцией в журнал — молча волна не останавливается
    const j = readJournal({ journalDir })
    const refusal = j.events.find((e: any) => e.type === 'merge' && e.detail && e.detail.refused === true)
    expect(refusal).toBeTruthy()
    expect((refusal as any).detail.branch).toBe(one.branch)
  })

  it('зелёный прогон: слияние фиксируется коммитом с двумя родителями, копия и ветка убраны, квитанция в журнале', async () => {
    const { repoRoot, baseSha } = makeRepo()
    const one = addAgentWorktree(repoRoot, 'one')
    const plan = makePlan(repoRoot, baseSha, [one])
    const { runWaveMerge, journalDir } = ritualWith(() => ({ passed: true, ran: true }))

    const res = await wts.executeWorktreeWaveCleanupPlan(plan, { runWaveMerge })

    expect(res.ok).toBe(true)
    expect(res.entries[0].status).toBe('merged_removed')
    const head = git(['rev-parse', 'HEAD'], repoRoot).trim()
    expect(head).not.toBe(baseSha)
    // no-ff: у результата два родителя — принятие волны откатывается одной командой
    expect(git(['rev-parse', 'HEAD^2'], repoRoot).trim()).toBeTruthy()
    // вердикт ритуала едет на записи манифеста: чем кончился прогон и какой sha родился
    expect(res.entries[0].merge.testsPassed).toBe(true)
    expect(res.entries[0].merge.resultSha).toBe(head)
    expect(existsSync(one.wtPath)).toBe(false)
    expect(() => git(['rev-parse', '--verify', `refs/heads/${one.branch}`], repoRoot)).toThrow()
    const j = readJournal({ journalDir })
    const receipt = j.events.find((e: any) => e.type === 'merge' && e.detail && e.detail.testsPassed === true)
    expect(receipt).toBeTruthy()
  })

  it('конфликт: запись волны отклонена, а ОБЩЕЕ дерево остаётся чистым — ритуал откатывает недоведённое слияние вместо того, чтобы бросить его посреди чужой работы', async () => {
    const { repoRoot, baseSha } = makeRepo()
    const one = addAgentWorktree(repoRoot, 'one', { conflict: true })
    // main правит ту же строку — готовый конфликт при сведении
    writeFileSync(join(repoRoot, 'base.txt'), 'main side\n')
    git(['add', '.'], repoRoot)
    git(['commit', '-m', 'main moves the same line'], repoRoot)
    const mainTip = git(['rev-parse', 'HEAD'], repoRoot).trim()
    const plan = makePlan(repoRoot, baseSha, [one])
    const { runWaveMerge } = ritualWith(() => ({ passed: true, ran: true }))

    const res = await wts.executeWorktreeWaveCleanupPlan(plan, { runWaveMerge })

    expect(res.ok).toBe(false)
    expect(res.entries[0].status).toBe('blocked')
    expect(res.entries[0].reason).toBe('merge_failed')
    expect(git(['rev-parse', 'HEAD'], repoRoot).trim()).toBe(mainTip)
    // дерево ЧИСТОЕ: до починки голое git merge оставляло здесь конфликтные маркеры
    expect(git(['status', '--porcelain'], repoRoot).trim()).toBe('')
  })

  it('занятый слот слияния останавливает уборку волны словами держателя — волна ждёт в той же очереди, что и все', async () => {
    const { repoRoot, baseSha } = makeRepo()
    const one = addAgentWorktree(repoRoot, 'one')
    const plan = makePlan(repoRoot, baseSha, [one])
    const { runWaveMerge, claimsDir, journalDir } = ritualWith(() => ({ passed: true, ran: true }))
    acquireMergeClaim({ by: 'other-terminal', branch: 'somebody-elses-branch', claimsDir, journalDir })

    const res = await wts.executeWorktreeWaveCleanupPlan(plan, { runWaveMerge })

    expect(res.ok).toBe(false)
    expect(res.entries[0].status).toBe('blocked')
    expect(res.entries[0].reason).toBe('merge_slot_held')
    expect(String(res.entries[0].stderr)).toContain('слияние уже идёт')
    expect(git(['rev-parse', 'HEAD'], repoRoot).trim()).toBe(baseSha)
  })

  it('штатная сборка без инъекций доходит до настоящего ритуала: в дереве без цели смок честно отвечает «прогона не было», слияние фиксируется, квитанция — в .sma/journal целевого репозитория', async () => {
    const { repoRoot, baseSha } = makeRepo()
    const one = addAgentWorktree(repoRoot, 'one')
    const plan = makePlan(repoRoot, baseSha, [one])

    const res = await wts.executeWorktreeWaveCleanupPlan(plan, {})

    expect(res.ok).toBe(true)
    expect(res.entries[0].status).toBe('merged_removed')
    // в одноразовом дереве нет цели смока — три ответа, а не два: это «прогона не было», не зелёный
    expect(res.entries[0].merge.testsPassed).toBe(null)
    expect(String(res.entries[0].merge.testsNote || '')).not.toBe('')
    const j = readJournal({ journalDir: join(repoRoot, '.sma', 'journal') })
    const receipt = j.events.find((e: any) => e.type === 'merge')
    expect(receipt).toBeTruthy()
    expect((receipt as any).detail.testsPassed).toBe(null)
  })
})
