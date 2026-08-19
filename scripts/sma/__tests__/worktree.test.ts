/**
 * Tests for scripts/sma/lib/worktree.mjs.
 *
 * Per-terminal worktree isolation: `sma worktree` provisions or
 * reuses a per-session worktree DIRECTORY so parallel human Claude Code sessions
 * physically cannot overwrite each other on this shared, auto-deploy checkout.
 *
 * The two Windows hazards the guards exist for (the reason these tests are the
 * load-bearing safety proofs):
 *   - feedback_worktree_base_windows_bug: a Windows worktree can branch from a
 *     commit OLDER than HEAD → capture EXPECTED_BASE + verify + hard-reset.
 *   - feedback_worktree_shell_teleport: a teleported shell CWD runs git on the
 *     wrong branch → every git call passes an EXPLICIT cwd (no bare `cd &&`).
 *
 * A DI git runner (makeMockGit) records every {args, cwd} it receives so the
 * tests never spawn a real `git worktree`, never touch the network, and can
 * assert the explicit-cwd invariant mechanically. `.sma/` coordination
 * resolution (registry.smaRoot) is ALREADY worktree-transparent and is NOT
 * exercised here — plan 14 provisions working-tree directories only.
 */

import { describe, it, expect } from 'vitest'
import { resolve as resolvePath } from 'node:path'

import {
  provisionWorktree,
  reuseOrProvision,
  listWorktrees,
  removeWorktree,
  resolveSiblingRepo,
  captureExpectedBase,
  verifyWorktreeBase,
  WORKTREE_BRANCH_PREFIX,
  lockPushInCopy,
  PUSH_LOCK_URL,
  PUSH_LOCK_NO_EXTENSION_REASON,
} from '../lib/worktree.mjs'

/**
 * makeMockGit — a recording DI runner. `baseByCwd` maps a cwd -> the sha its
 * `rev-parse HEAD` returns (so a worktree cwd can report a DIFFERENT base than
 * the main checkout — the Windows base bug). `worktrees` is the porcelain text
 * `worktree list --porcelain` returns. `fail:true` makes every call throw (the
 * fail-open probe). Records EVERY {args, cwd} pair.
 */
function makeMockGit(
  opts: { baseByCwd?: Record<string, string>; worktrees?: string; fail?: boolean } = {},
) {
  const calls: { args: string[]; cwd?: string }[] = []
  const run = (args: string[], o: { cwd?: string } = {}) => {
    calls.push({ args, cwd: o.cwd })
    if (opts.fail) throw new Error('git failed (mock)')
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      const map = opts.baseByCwd ?? {}
      return `${map[o.cwd ?? ''] ?? 'DEFAULT_SHA'}\n`
    }
    if (args[0] === 'worktree' && args[1] === 'list') return opts.worktrees ?? ''
    return ''
  }
  return { run, calls }
}

describe('worktree.mjs — per-terminal provisioning + Windows guards', () => {
  it('Test 1 — provision captures EXPECTED_BASE before add, then verifies the base after add', () => {
    const g = makeMockGit({ baseByCwd: { '/main': 'BASE', '/wt': 'BASE' } })
    const res = provisionWorktree({ branch: 'sma-wt/a', path: '/wt', execGit: g.run, cwd: '/main' })

    const idxRev = g.calls.findIndex((c) => c.args[0] === 'rev-parse' && c.args[1] === 'HEAD')
    const idxAdd = g.calls.findIndex((c) => c.args[0] === 'worktree' && c.args[1] === 'add')
    // rev-parse HEAD (capture) precedes worktree add
    expect(idxRev).toBeGreaterThanOrEqual(0)
    expect(idxAdd).toBeGreaterThan(idxRev)
    // base verified AFTER add: a rev-parse HEAD in the new worktree's cwd
    const idxVerify = g.calls.findIndex(
      (c, i) => i > idxAdd && c.args[0] === 'rev-parse' && c.args[1] === 'HEAD' && c.cwd === '/wt',
    )
    expect(idxVerify).toBeGreaterThan(idxAdd)
    expect(res.ok).toBe(true)
    expect(res.expectedBase).toBe('BASE')
  })

  it('Test 2 — base mismatch → hard-reset in the worktree cwd; a matching base does NOT reset', () => {
    // mismatch: the worktree reports an OLDER base than main (the Windows bug)
    const g = makeMockGit({ baseByCwd: { '/main': 'BASE', '/wt': 'OLD' } })
    const res = provisionWorktree({ branch: 'sma-wt/b', path: '/wt', execGit: g.run, cwd: '/main' })
    expect(res.baseFixed).toBe(true)
    const reset = g.calls.find((c) => c.args[0] === 'reset' && c.args[1] === '--hard')
    expect(reset?.args[2]).toBe('BASE') // reset --hard <EXPECTED_BASE>, never --soft
    expect(reset?.cwd).toBe('/wt') // in the worktree, not main

    // match: no reset issued at all
    const g2 = makeMockGit({ baseByCwd: { '/main': 'BASE', '/wt': 'BASE' } })
    const res2 = provisionWorktree({ branch: 'sma-wt/c', path: '/wt', execGit: g2.run, cwd: '/main' })
    expect(res2.baseFixed).toBe(false)
    expect(g2.calls.some((c) => c.args[0] === 'reset')).toBe(false)
  })

  it('Test 3 — every git call carries an explicit cwd and is an args array (no bare `cd &&`)', () => {
    const g = makeMockGit({ baseByCwd: { '/main': 'BASE', '/wt': 'OLD' } })
    provisionWorktree({ branch: 'sma-wt/d', path: '/wt', execGit: g.run, cwd: '/main' })
    expect(g.calls.length).toBeGreaterThan(0)
    for (const c of g.calls) {
      expect(Array.isArray(c.args)).toBe(true) // args array, never a shell string
      expect(typeof c.cwd).toBe('string') // explicit cwd on every call (teleport guard)
      expect(c.cwd).toBeTruthy()
      expect(c.args.join(' ')).not.toMatch(/(^|\s)cd\s/) // no bare cd anywhere
    }
  })

  it('Test 4 — reuse over re-provision; porcelain list parse; remove uses explicit cwd + no --force by default', () => {
    const porcelain =
      'worktree /main\nHEAD abcabc\nbranch refs/heads/main\n\n' +
      'worktree /wt-a\nHEAD defdef\nbranch refs/heads/sma-wt/a\n'
    const g = makeMockGit({ worktrees: porcelain })
    const list = listWorktrees({ execGit: g.run, cwd: '/main' })
    expect(list).toHaveLength(2)
    expect(list[1].path).toBe('/wt-a')
    expect(list[1].branch).toBe('refs/heads/sma-wt/a')

    // reuse returns the existing worktree — no duplicate `worktree add`
    const r = reuseOrProvision({ branch: 'refs/heads/sma-wt/a', path: '/wt-a', execGit: g.run, cwd: '/main' })
    expect(r.reused).toBe(true)
    expect(g.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'add')).toBe(false)

    // remove: explicit cwd, no --force unless asked
    const g2 = makeMockGit()
    removeWorktree({ path: '/wt-a', execGit: g2.run, cwd: '/main' })
    const rm = g2.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')
    expect(rm?.cwd).toBe('/main')
    expect(rm?.args).not.toContain('--force')

    const g3 = makeMockGit()
    removeWorktree({ path: '/wt-a', execGit: g3.run, cwd: '/main', force: true })
    const rm3 = g3.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')
    expect(rm3?.args).toContain('--force')
  })

  it('Test 5 — sibling-repo resolution order: env → config → profile → relative ../sma fallback (tolerant)', () => {
    // env wins over everything
    expect(
      resolveSiblingRepo({
        env: { SMA_PRODUCT_REPO: '/abs/env' },
        readConfig: () => ({ productRepo: '/abs/cfg' }),
        readProfile: () => ({ profile: { productRepo: '/abs/prof' } }),
        cwd: '/main',
      }),
    ).toMatchObject({ path: '/abs/env', source: 'env' })

    // config wins when no env
    expect(
      resolveSiblingRepo({
        env: {},
        readConfig: () => ({ productRepo: '/abs/cfg' }),
        readProfile: () => ({ profile: { productRepo: '/abs/prof' } }),
        cwd: '/main',
      }),
    ).toMatchObject({ path: '/abs/cfg', source: 'config' })

    // profile wins when no env/config
    expect(
      resolveSiblingRepo({
        env: {},
        readConfig: () => ({}),
        readProfile: () => ({ profile: { productRepo: '/abs/prof' } }),
        cwd: '/main',
      }),
    ).toMatchObject({ path: '/abs/prof', source: 'profile' })

    // relative fallback when nothing is recorded
    const fb = resolveSiblingRepo({ env: {}, readConfig: () => ({}), readProfile: () => ({ profile: {} }), cwd: '/main' })
    expect(fb.source).toBe('relative')
    expect(fb.path).toBe(resolvePath('/main', '../sma'))

    // corrupt config/profile (readers throw) still falls through to relative — never throws
    const fb2 = resolveSiblingRepo({
      env: {},
      readConfig: () => {
        throw new Error('corrupt config')
      },
      readProfile: () => {
        throw new Error('corrupt profile')
      },
      cwd: '/main',
    })
    expect(fb2.source).toBe('relative')
  })

  it('Test 6 — fail-open: a git error returns {ok:false, fellBackToPrimary:true} and never throws', () => {
    const g = makeMockGit({ fail: true })
    const res = provisionWorktree({ branch: 'sma-wt/z', path: '/wt', execGit: g.run, cwd: '/main' })
    expect(res.ok).toBe(false)
    expect(res.fellBackToPrimary).toBe(true)
    expect(typeof res.message).toBe('string')
    // listWorktrees is fail-open too — a throwing git yields an empty list, never a throw
    expect(listWorktrees({ execGit: g.run, cwd: '/main' })).toEqual([])
  })

  it('captureExpectedBase + verifyWorktreeBase are the injectable base primitives', () => {
    const g = makeMockGit({ baseByCwd: { '/main': 'BASE', '/wt': 'OLD' } })
    expect(captureExpectedBase({ execGit: g.run, cwd: '/main' })).toBe('BASE')
    const v = verifyWorktreeBase({ execGit: g.run, cwd: '/wt', expectedBase: 'BASE' })
    expect(v.matches).toBe(false)
    expect(v.actual).toBe('OLD')
  })

  it('WORKTREE_BRANCH_PREFIX is a stable non-empty per-terminal branch stem', () => {
    expect(typeof WORKTREE_BRANCH_PREFIX).toBe('string')
    expect(WORKTREE_BRANCH_PREFIX.length).toBeGreaterThan(0)
  })
})

/**
 * lockPushInCopy — КОПИЯ ВЫДАЁТСЯ БЕЗ АДРЕСА ДЛЯ PUSH, А ДЕРЕВО ЧЕЛОВЕКА НЕ ТРОГАЮТ.
 *
 * Прогон на временном репозитории (git 2.53) показал ровно то, ради чего написан
 * весь этот блок: `git config remote.origin.pushurl no_push`, выполненный ВНУТРИ
 * связанной копии, пишется в ОБЩИЙ конфиг и отнимает push у главного дерева —
 * то есть защита от работника обезоруживает человека. Изолирует только пара
 * «расширение per-worktree включено в главном дереве» + `git config --worktree`.
 *
 * И вторая половина, которая здесь и есть предмет: расширение мы НЕ включаем сами
 * НИКОГДА. Оно меняет смысл уже существующих настроек чужого репозитория
 * (`core.bare`, `core.worktree` начинают читаться по-копийно), и делать это молча,
 * ради ВТОРОГО рубежа, недопустимо. Поэтому есть случай, который утверждает
 * ОТСУТСТВИЕ такой команды в записи подделки git, — а не только результат.
 */
function makeConfigGit(
  opts: {
    ext?: string
    sharedPush?: string
    copyPush?: string
    /** имитирует утечку: запись `--worktree` всё равно видна в общем конфиге */
    leakOnWrite?: boolean
  } = {},
) {
  const calls: { args: string[]; cwd?: string }[] = []
  let shared = opts.sharedPush ?? ''
  let copy = opts.copyPush ?? ''
  const run = (args: string[], o: { cwd?: string } = {}) => {
    calls.push({ args, cwd: o.cwd })
    if (args[0] !== 'config') return ''
    const worktreeScoped = args.includes('--worktree')
    const rest = args.filter((a) => a !== 'config' && a !== '--worktree')
    if (rest[0] === '--get') {
      const key = rest[1]
      let value = ''
      if (key === 'extensions.worktreeConfig') value = opts.ext ?? ''
      else if (key === 'remote.origin.pushurl') value = worktreeScoped ? copy : shared
      // git отвечает кодом 1 на отсутствующий ключ — подделка обязана уметь то же
      if (value === '') throw Object.assign(new Error('exit 1'), { status: 1 })
      return value + '\n'
    }
    if (rest[0] === '--unset') {
      if (worktreeScoped) copy = ''
      else shared = ''
      return ''
    }
    // запись
    if (rest[0] === 'remote.origin.pushurl') {
      if (worktreeScoped) {
        copy = rest[1]
        if (opts.leakOnWrite) shared = rest[1]
      } else {
        shared = rest[1]
      }
      return ''
    }
    return ''
  }
  return {
    run,
    calls,
    seen: () => ({ shared, copy }),
  }
}

/** Любая команда, которая ВКЛЮЧАЕТ расширение per-worktree, — запрещённая. */
function enablingCalls(calls: { args: string[] }[]) {
  return calls.filter(
    (c) =>
      c.args[0] === 'config' &&
      c.args.some((a) => a === 'extensions.worktreeConfig') &&
      !c.args.includes('--get'),
  )
}

describe('worktree.mjs — копия без адреса для push, дерево человека нетронуто', () => {
  it('расширение включено ЧЕЛОВЕКОМ → замок стоит в копии, в общем конфиге пусто', () => {
    const g = makeConfigGit({ ext: 'true' })
    const res = lockPushInCopy({ execGit: g.run, mainRoot: '/main', copyPath: '/wt' })
    expect(res.applied).toBe(true)
    expect(res.isolated).toBe(true)
    expect(res.worktreeConfigPreset).toBe(true)
    expect(g.seen().copy).toBe(PUSH_LOCK_URL)
    expect(g.seen().shared, 'адрес протёк в главное дерево — у человека отняли push').toBe('')
    // запись сделана ИМЕННО флагом --worktree, иначе она общая по определению
    const write = g.calls.find((c) => c.args.includes('remote.origin.pushurl') && !c.args.includes('--get'))
    expect(write?.args).toContain('--worktree')
    expect(write?.cwd, 'запись адреса ушла не в копию').toBe('/wt')
  })

  it('расширение не включено человеком → applied:false, причина словами и НИ ОДНОЙ команды включения', () => {
    const g = makeConfigGit({ ext: '' })
    const res = lockPushInCopy({ execGit: g.run, mainRoot: '/main', copyPath: '/wt' })
    expect(res.applied).toBe(false)
    expect(res.worktreeConfigPreset).toBe(false)
    expect(res.reason).toBe(PUSH_LOCK_NO_EXTENSION_REASON)
    expect(res.reason.length, 'причина обязана быть словами, а не кодом').toBeGreaterThan(20)
    // ГЛАВНОЕ: мы не переконфигурировали чужой репозиторий ради своей защиты
    expect(enablingCalls(g.calls), 'продукт включил расширение сам — это запрещено').toEqual([])
    // и ни один адрес не записан ни там, ни там
    expect(g.seen().shared).toBe('')
    expect(g.seen().copy).toBe('')
  })

  it('утечка в общий конфиг → откат с обеих сторон и честное applied:false', () => {
    const g = makeConfigGit({ ext: 'true', leakOnWrite: true })
    const res = lockPushInCopy({ execGit: g.run, mainRoot: '/main', copyPath: '/wt' })
    expect(res.applied).toBe(false)
    expect(res.isolated).toBe(false)
    expect(res.reason).toContain('isolation')
    expect(g.seen().shared, 'у человека остался чужой адрес push').toBe('')
    expect(g.seen().copy).toBe('')
  })

  it('адрес push уже настроен человеком → не трогаем вовсе', () => {
    const g = makeConfigGit({ ext: 'true', sharedPush: 'git@example.com:me/mine.git' })
    const res = lockPushInCopy({ execGit: g.run, mainRoot: '/main', copyPath: '/wt' })
    expect(res.applied).toBe(false)
    expect(res.mainPushUrl).toBe('git@example.com:me/mine.git')
    expect(g.seen().shared).toBe('git@example.com:me/mine.git')
    expect(g.calls.filter((c) => c.args.includes('--unset'))).toEqual([])
  })

  it('повторный вызов на уже запертой копии идемпотентен: applied:true и ни одной записи', () => {
    const g = makeConfigGit({ ext: 'true', copyPush: PUSH_LOCK_URL })
    const res = lockPushInCopy({ execGit: g.run, mainRoot: '/main', copyPath: '/wt' })
    expect(res.applied).toBe(true)
    expect(res.alreadyLocked).toBe(true)
    const writes = g.calls.filter((c) => c.args[0] === 'config' && !c.args.includes('--get'))
    expect(writes, 'второй вызов что-то записал').toEqual([])
  })

  it('fail-open: git падает — копия выдаётся без замка, с названной причиной, без броска', () => {
    const g = makeMockGit({ fail: true })
    const res = lockPushInCopy({ execGit: g.run, mainRoot: '/main', copyPath: '/wt' })
    expect(res.applied).toBe(false)
    expect(typeof res.reason).toBe('string')
    expect(res.reason.length).toBeGreaterThan(0)
  })

  it('у каждого вызова git явный cwd — телепорта оболочки быть не может', () => {
    const g = makeConfigGit({ ext: 'true' })
    lockPushInCopy({ execGit: g.run, mainRoot: '/main', copyPath: '/wt' })
    expect(g.calls.length).toBeGreaterThan(0)
    for (const c of g.calls) {
      expect(typeof c.cwd, 'вызов без cwd: ' + c.args.join(' ')).toBe('string')
      expect(Array.isArray(c.args)).toBe(true)
      expect(c.args.join(' ')).not.toContain('cd ')
    }
  })

  it('обе точки выдачи копии кладут результат замка полем pushLock', () => {
    const g = makeConfigGit({ ext: 'true' })
    const fresh: any = provisionWorktree({ branch: 'sma-wt/p', path: '/wt', execGit: g.run, cwd: '/main' })
    expect(fresh.ok).toBe(true)
    expect(fresh.pushLock?.applied).toBe(true)

    const g2 = makeConfigGit({ ext: 'true' })
    const reused: any = reuseOrProvision({
      branch: 'sma-wt/p',
      path: '/wt',
      execGit: (args: string[], o: any = {}) => {
        if (args[0] === 'worktree' && args[1] === 'list') {
          return 'worktree /wt\nHEAD abc\nbranch refs/heads/sma-wt/p\n\n'
        }
        return g2.run(args, o)
      },
      cwd: '/main',
    })
    expect(reused.reused).toBe(true)
    expect(reused.pushLock?.applied, 'переиспользованная копия осталась с правом push').toBe(true)
  })
})
