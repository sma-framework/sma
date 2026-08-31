/**
 * Tests for scripts/sma/lib/merge-smoke.mjs — the runner the merge gate is handed.
 *
 * WHAT THIS FILE IS REALLY ABOUT. The runner's job is not «run the tests»; it is to tell the
 * ritual WHICH OF THREE WORLDS it is in — the tests ran and were green, the tests ran and were
 * red, or there was no run at all. The middle and the last used to arrive wearing the same
 * face, and the cost of that confusion is not theoretical: launched by command name and
 * without a shell, the package manager could not be found on this platform at all, the spawn
 * died with a system error, the catch read it as a failing run, and the runner reported RED
 * having executed NOTHING. A gate like that refuses every merge forever and calls it working.
 *
 * So the failure branches here are driven by the SHAPE of a real failure — a spawn that never
 * started carries a system error code and no exit status; a child killed on its deadline
 * carries a signal and no exit status; a child that ran and failed carries a status — and
 * never by a flag that says «pretend this went wrong». A fake that answers from the very
 * distinction under test proves only that the fake works.
 *
 * And because a runner that cannot really launch anything is exactly the defect this module
 * exists to close, two cases here launch REAL child processes over throwaway trees: one where
 * the target passes and one where it fails. Reading the code cannot tell those apart.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import {
  runMergeSmoke,
  runMergeSmokeAsync,
  resolveSuiteEntry,
  summarizeRedRun,
  MERGE_SMOKE_TARGET,
  MERGE_SMOKE_TIMEOUT_MS,
  NO_TARGET_NOTE,
  NO_SUITE_RUNNER_NOTE,
  TIMED_OUT_NOTE,
} from '../lib/merge-smoke.mjs'

/** A child process that never started: the shape execFileSync throws on a missing binary. */
function spawnFailure(code: string) {
  const err: any = new Error(`spawnSync ${code}`)
  err.code = code
  err.errno = -4058
  err.status = null
  err.signal = null
  return err
}

/** A child that RAN and left with a non-zero code — the only shape that means «red». */
function exitedWith(status: number, said = '') {
  const err: any = new Error(`Command failed with exit code ${status}`)
  err.status = status
  err.signal = null
  err.stdout = said
  err.stderr = ''
  return err
}

/**
 * Вывод настоящего красного прогона, урезанный до формы: сводка по файлу, строка `×` с
 * первой причиной и блок `Failed Tests` с полным именем и утверждением. Разбирается
 * ИМЕННО такой текст, потому что именно его печатает сьютер, которого зовёт этот модуль.
 */
const RED_OUTPUT = [
  ' RUN  v3.2.4 C:/tmp/tree',
  '',
  ' ❯ scripts/sma/__tests__/merge-gate.test.ts (2 tests | 1 failed) 41ms',
  '   ✓ merge-claim triplet + the sma merge ritual > Test 1 3ms',
  '   × гейт слияния: непригодная среда называется средой > отказ несёт имя 12ms',
  '     → expected false to be true // Object.is equality',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  scripts/sma/__tests__/merge-gate.test.ts > гейт слияния: непригодная среда называется средой > отказ несёт имя',
  'AssertionError: expected false to be true // Object.is equality',
  '',
  '- Expected',
  '+ Received',
  '',
  ' ❯ scripts/sma/__tests__/merge-gate.test.ts:651:24',
  '',
].join('\n')

/** A child killed on its deadline: a signal, no status, and the killed flag execFileSync sets. */
function killedOnDeadline() {
  const err: any = new Error('spawnSync ETIMEDOUT')
  err.killed = true
  err.signal = 'SIGTERM'
  err.status = null
  return err
}

/** A tree where the target exists, so the launch branch is reached. */
const treeWithTarget = { exists: () => true, resolveEntry: () => 'C:/anywhere/suite-runner.mjs' }

describe('the three worlds are told apart — red is never «there was no run»', () => {
  it('a tree without the target gives NO RUN, and nothing is launched at all', () => {
    let launched = 0
    const res: any = runMergeSmoke({
      cwd: '/nowhere',
      exists: () => false,
      resolveEntry: () => 'C:/anywhere/suite-runner.mjs',
      exec: () => {
        launched += 1
      },
    })
    expect(res.passed, 'an empty tree must never read as a red run').toBe(null)
    expect(res.ran).toBe(false)
    expect(res.note).toBe(NO_TARGET_NOTE)
    expect(res.note).toContain(MERGE_SMOKE_TARGET)
    expect(launched, 'the runner launched a suite it already knows is absent').toBe(0)
  })

  it('a suite runner that will not resolve gives NO RUN, not a red verdict', () => {
    let launched = 0
    const res: any = runMergeSmoke({
      cwd: '/repo',
      exists: () => true,
      resolveEntry: () => {
        const err: any = new Error('Cannot find module')
        err.code = 'MODULE_NOT_FOUND'
        throw err
      },
      exec: () => {
        launched += 1
      },
    })
    expect(res.passed).toBe(null)
    expect(res.ran).toBe(false)
    expect(res.note).toBe(NO_SUITE_RUNNER_NOTE)
    expect(launched).toBe(0)
  })

  it('THE MEASURED DEFECT: a spawn that never started is NO RUN, not «tests are red»', () => {
    // This is the exact shape the old body turned into a refusal: on this platform the package
    // manager is a script wrapper, a plain file launch cannot see it, and the error carries a
    // system code with NO exit status. Reading it as red refused every merge on the machine.
    const res: any = runMergeSmoke({
      cwd: '/repo',
      ...treeWithTarget,
      exec: () => {
        throw spawnFailure('ENOENT')
      },
    })
    expect(res.passed, 'a launch that never happened is not a verdict about the tests').toBe(null)
    expect(res.ran).toBe(false)
    expect(res.note).toBe(NO_SUITE_RUNNER_NOTE)
  })

  it('a child killed on its deadline is NO RUN — the machine is not the tests', () => {
    const res: any = runMergeSmoke({
      cwd: '/repo',
      ...treeWithTarget,
      exec: () => {
        throw killedOnDeadline()
      },
    })
    expect(res.passed).toBe(null)
    expect(res.ran).toBe(false)
    expect(res.note).toBe(TIMED_OUT_NOTE)
    expect(res.note).toContain(String(Math.round(MERGE_SMOKE_TIMEOUT_MS / 1000)))
  })

  it('a child that RAN and exited non-zero is red — and carries the code it left with', () => {
    const res: any = runMergeSmoke({
      cwd: '/repo',
      ...treeWithTarget,
      exec: () => {
        throw exitedWith(1)
      },
    })
    expect(res.passed).toBe(false)
    expect(res.ran).toBe(true)
    expect(res.exitCode).toBe(1)
    expect(res.note, 'a verdict has no «why there was no run» to give').toBeUndefined()
  })

  /**
   * ═══ КРАСНЫЙ ОТВЕТ БЕЗ ИМЕНИ ТЕСТА — ЭТО ПОЛОВИНА ОТВЕТА ═══════════════════════════
   *
   * Замерено 31.08.2026: приёмка вернула «тесты на сведённом дереве красные» и ни одного
   * слова о том, какой тест и почему, — приёмщик искал это руками, а нашёл вовсе не тесты.
   * Код выхода говорит ЧТО случилось и молчит ГДЕ. Поэтому красный ответ несёт имя первого
   * упавшего теста и первые строки причины, взятые из вывода того же прогона.
   */
  it('красный ответ несёт ИМЯ упавшего теста и первые строки причины', () => {
    const res: any = runMergeSmoke({
      cwd: '/repo',
      ...treeWithTarget,
      exec: () => {
        throw exitedWith(1, RED_OUTPUT)
      },
    })
    expect(res.passed).toBe(false)
    expect(res.failedTest, 'красный отказ без имени теста отправляет человека искать вручную').toContain(
      'отказ несёт имя',
    )
    expect(res.failedTest).toContain('merge-gate.test.ts')
    expect(res.failureDetail).toContain('AssertionError')
    expect(res.failureDetail).toContain('expected false to be true')
  })

  it('зелёный ответ не несёт ни имени, ни причины — успех себя не объясняет', () => {
    const res: any = runMergeSmoke({ cwd: '/repo', ...treeWithTarget, exec: () => '' })
    expect(res.passed).toBe(true)
    expect(res.failedTest).toBeUndefined()
    expect(res.failureDetail).toBeUndefined()
  })

  it('a child that RAN and exited zero is green', () => {
    const res: any = runMergeSmoke({ cwd: '/repo', ...treeWithTarget, exec: () => '' })
    expect(res.passed).toBe(true)
    expect(res.ran).toBe(true)
  })
})

/**
 * ═══ РАЗБОР ВЫВОДА: ЧТО ИМЕННО ЕДЕТ В ОТКАЗ ══════════════════════════════════════════
 *
 * Разбор отделён от запуска, потому что это две разные ошибки: «не поймали вывод» и «поймали,
 * но прочли не то». Правило одно и жёсткое — НИЧЕГО НЕ ВЫДУМЫВАТЬ: вывод, в котором имени
 * теста нет (сьютер упал на сборке файла, а не на утверждении), отдаёт имя `null`, а не
 * правдоподобную строку. Ложное имя хуже отсутствующего: по нему пойдут чинить чужой тест.
 */
describe('разбор красного вывода — имя теста и первые строки причины', () => {
  it('берёт полное имя из блока Failed Tests и утверждение под ним', () => {
    const sum: any = summarizeRedRun(RED_OUTPUT)
    expect(sum.failedTest).toContain('merge-gate.test.ts')
    expect(sum.failedTest).toContain('отказ несёт имя')
    expect(sum.failedTest, 'хвост со временем прогона — не часть имени').not.toMatch(/\d+ms$/)
    expect(sum.failureDetail).toContain('AssertionError')
    expect(sum.failureDetail, 'рамка отчёта — не причина').not.toMatch(/⎯{3,}/)
  })

  it('строка «×» тоже даёт имя, когда блока Failed Tests в выводе нет', () => {
    const sum: any = summarizeRedRun(
      [' ❯ a.test.ts (1 test | 1 failed) 4ms', '   × набор > падает 2ms', '     → expected 1 to be 2'].join('\n'),
    )
    expect(sum.failedTest).toContain('набор > падает')
    expect(sum.failureDetail).toContain('expected 1 to be 2')
  })

  it('цвет терминала снимается — имя теста не носит на себе управляющих последовательностей', () => {
    const ESC = String.fromCharCode(27) // краска терминала приезжает управляющей последовательностью
    const sum: any = summarizeRedRun(`${ESC}[31m FAIL ${ESC}[39m a.test.ts > набор > падает\nAssertionError: нет\n`)
    expect(sum.failedTest).toBe('a.test.ts > набор > падает')
    expect(sum.failedTest).not.toContain(ESC)
  })

  it('вывод без единого упавшего теста НЕ выдумывает имени — оно null, а причина всё равно едет', () => {
    const sum: any = summarizeRedRun(
      ['⎯⎯⎯ Unhandled Errors ⎯⎯⎯', 'Error: Failed to load url ./missing.mjs', '  at loadModule'].join('\n'),
    )
    expect(sum.failedTest, 'придуманное имя отправит человека чинить не тот тест').toBe(null)
    expect(sum.failureDetail).toContain('Failed to load url')
  })

  it('пустой вывод — ни имени, ни причины, и ни одного придуманного слова', () => {
    expect(summarizeRedRun('')).toMatchObject({ failedTest: null, failureDetail: null })
    expect(summarizeRedRun(undefined as any)).toMatchObject({ failedTest: null, failureDetail: null })
  })

  it('причина обрезана: отказ — это первые строки, а не весь протокол прогона', () => {
    const long = [' FAIL  a.test.ts > набор > падает', ...Array.from({ length: 40 }, (_, i) => `строка причины ${i} ${'я'.repeat(400)}`)].join('\n')
    const sum: any = summarizeRedRun(long)
    expect(sum.failureDetail.split('\n').length).toBeLessThanOrEqual(3)
    for (const line of sum.failureDetail.split('\n')) expect(line.length).toBeLessThanOrEqual(200)
  })
})

describe('the launch itself — the form that was measured to work on this platform', () => {
  it('launches the running interpreter with an ABSOLUTE entry, an args array and no shell', () => {
    const seen: any[] = []
    runMergeSmoke({
      cwd: '/repo',
      exists: () => true,
      resolveEntry: () => 'C:/anywhere/suite-runner.mjs',
      exec: (file: string, args: string[], opts: any) => {
        seen.push({ file, args, opts })
        return ''
      },
    })
    expect(seen.length).toBe(1)
    const [call] = seen
    // the interpreter this process is already running under — never a command name that the
    // platform resolves through a wrapper script.
    expect(call.file).toBe(process.execPath)
    expect(call.file).not.toMatch(/^(npm|pnpm|yarn|npx)(\.|$)/)
    expect(call.args[0]).toBe('C:/anywhere/suite-runner.mjs')
    expect(call.args).toContain(MERGE_SMOKE_TARGET)
    expect(Array.isArray(call.args), 'an args array, never a command string').toBe(true)
    // a shell would make the arguments a sentence the platform re-parses; the cure for the
    // wrapper problem here is the interpreter, not a shell.
    expect(call.opts.shell, 'no shell — the entry is absolute, so none is needed').toBeUndefined()
    expect(call.opts.cwd, 'the run happens in the tree being merged, not in ours').toBe('/repo')
    expect(call.opts.timeout, 'a run without a ceiling can hold the approval door open').toBe(MERGE_SMOKE_TIMEOUT_MS)
    // ВЫВОД ЛОВИТСЯ, А НЕ ВЫБРАСЫВАЕТСЯ. Раньше здесь стояло `stdio:'ignore'` под словами
    // «сьют говорит кодом выхода» — и код выхода действительно говорит ЧТО, но молчит ГДЕ.
    // Имя упавшего теста живёт только в выводе; выброшенный вывод — это отказ, который
    // приёмщик обязан расследовать руками.
    expect(call.opts.stdio, 'выброшенный вывод — это отказ без имени упавшего теста').toEqual(['ignore', 'pipe', 'pipe'])
    expect(call.opts.encoding, 'вывод читается текстом, а не байтами').toBe('utf8')
  })

  it('the suite runner really resolves from this installation, to a file that exists', () => {
    const entry = resolveSuiteEntry()
    expect(isAbsolute(entry), `the entry must be absolute, got: ${entry}`).toBe(true)
    expect(existsSync(entry), `the resolved suite runner is not on disk: ${entry}`).toBe(true)
  })
})

/**
 * ═══ REAL CHILD PROCESSES ═══════════════════════════════════════════════════════════════
 *
 * Both trees are throwaway and neither is a repository: the runner is handed a directory and
 * a relative target, which is all it ever gets from the ritual. Nothing shared is touched.
 */
describe('the runner actually runs tests — proved by launching them', () => {
  function treeWhoseTargetSays(body: string): string {
    const tree = mkdtempSync(join(tmpdir(), 'sma-smoke-'))
    const target = join(tree, MERGE_SMOKE_TARGET)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `import { describe, it, expect } from 'vitest'\n${body}\n`, 'utf8')
    return tree
  }

  it('a foreign tree whose target PASSES answers green', () => {
    const tree = treeWhoseTargetSays(`describe('smoke', () => { it('passes', () => { expect(1).toBe(1) }) })`)
    try {
      const res: any = runMergeSmoke({ cwd: tree })
      expect(res, `the real runner did not answer green: ${JSON.stringify(res)}`).toMatchObject({
        passed: true,
        ran: true,
      })
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  }, 180000)

  it('a foreign tree whose target FAILS answers red, with the code the child left with', () => {
    const tree = treeWhoseTargetSays(`describe('smoke', () => { it('fails', () => { expect(1).toBe(2) }) })`)
    try {
      const res: any = runMergeSmoke({ cwd: tree })
      expect(res.passed, `the real runner did not answer red: ${JSON.stringify(res)}`).toBe(false)
      expect(res.ran, 'a red verdict must come from a run that HAPPENED').toBe(true)
      expect(typeof res.exitCode, 'a red verdict carries the exit code, not a signal').toBe('number')
      expect(res.exitCode).not.toBe(0)
      // И ИМЯ — ИЗ НАСТОЯЩЕГО ВЫВОДА НАСТОЯЩЕГО СЬЮТЕРА. Разбор подделанного текста
      // доказывает разбор; только этот случай доказывает, что сьютер печатает именно то,
      // что разбирают, и что вывод действительно доехал до нас.
      expect(res.failedTest, `настоящий красный прогон не назвал теста: ${JSON.stringify(res)}`).toContain('fails')
      expect(String(res.failureDetail)).toMatch(/expected 1 to be 2/)
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  }, 180000)

  it('a foreign tree with NO target answers «there was no run» without launching anything', () => {
    const tree = mkdtempSync(join(tmpdir(), 'sma-smoke-bare-'))
    try {
      const started = Date.now()
      const res: any = runMergeSmoke({ cwd: tree })
      expect(res).toMatchObject({ passed: null, ran: false, note: NO_TARGET_NOTE })
      // no child was started: the answer is immediate, while any real launch on this machine
      // is close to a second even when it finds nothing.
      expect(Date.now() - started).toBeLessThan(500)
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  })
})

/**
 * ═══ THE ASYNCHRONOUS RUNNER — the one the DAEMON's approval door is handed ═══════════════
 *
 * Same three worlds, spoken through a spawned child's two events instead of one thrown error:
 * 'error' is a launch that never happened, 'exit' carries a code (a verdict) or a signal with
 * no code (a deadline — the machine, not the tests). The branch tests below drive those exact
 * shapes through a stub child, for the same reason the synchronous tests above drive error
 * shapes: a fake that answers from the distinction under test proves only that the fake works.
 */
function stubChild() {
  const child: any = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  // Настоящий ребёнок с перехваченным выводом отдаёт два потока — на них и подписывается
  // модуль. Заглушка без них молча роняла бы подписку в исключение.
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

describe('the asynchronous runner tells the same three worlds apart', () => {
  it('does NOT hold the loop: the call returns a pending promise before the child says a word', async () => {
    const child = stubChild()
    const verdicts: any[] = []
    const p = runMergeSmokeAsync({ cwd: '/repo', ...treeWithTarget, spawn: () => child }).then((v: any) => {
      verdicts.push(v)
      return v
    })
    // the call is back in our hands while the child is still running — with the synchronous
    // body this line was unreachable until the whole smoke had finished.
    await new Promise((r) => setImmediate(r))
    expect(verdicts, 'the verdict arrived before the child exited — who was asked?').toHaveLength(0)
    child.emit('exit', 0, null)
    expect(await p).toMatchObject({ passed: true, ran: true })
  })

  it('a spawn that never started is NO RUN, not «tests are red» — as an event this time', async () => {
    const child = stubChild()
    const p = runMergeSmokeAsync({ cwd: '/repo', ...treeWithTarget, spawn: () => child })
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    expect(await p).toMatchObject({ passed: null, ran: false, note: NO_SUITE_RUNNER_NOTE })
  })

  it('a child that died by signal with no code is NO RUN — the machine is not the tests', async () => {
    const child = stubChild()
    const p = runMergeSmokeAsync({ cwd: '/repo', ...treeWithTarget, spawn: () => child })
    child.emit('exit', null, 'SIGTERM')
    expect(await p).toMatchObject({ passed: null, ran: false, note: TIMED_OUT_NOTE })
  })

  it('a child that RAN and exited non-zero is red — and carries the code it left with', async () => {
    const child = stubChild()
    const p = runMergeSmokeAsync({ cwd: '/repo', ...treeWithTarget, spawn: () => child })
    child.emit('exit', 1, null)
    const res: any = await p
    expect(res).toMatchObject({ passed: false, ran: true, exitCode: 1 })
    expect(res.note, 'a verdict has no «why there was no run» to give').toBeUndefined()
  })

  it('keeps the measured launch form: the interpreter, an absolute entry, no shell, output ignored', async () => {
    const seen: any[] = []
    const child = stubChild()
    const p = runMergeSmokeAsync({
      cwd: '/repo',
      exists: () => true,
      resolveEntry: () => 'C:/anywhere/suite-runner.mjs',
      spawn: (file: string, args: string[], opts: any) => {
        seen.push({ file, args, opts })
        return child
      },
    })
    child.emit('exit', 0, null)
    await p
    expect(seen).toHaveLength(1)
    const [call] = seen
    expect(call.file).toBe(process.execPath)
    expect(call.args[0]).toBe('C:/anywhere/suite-runner.mjs')
    expect(call.args).toContain(MERGE_SMOKE_TARGET)
    expect(call.opts.shell, 'no shell — the entry is absolute, so none is needed').toBeUndefined()
    expect(call.opts.cwd).toBe('/repo')
    // Та же поправка, что и у синхронного близнеца: вывод ловится, потому что имя упавшего
    // теста живёт только в нём, а код выхода называет лишь факт красноты.
    expect(call.opts.stdio, 'выброшенный вывод — это отказ без имени упавшего теста').toEqual(['ignore', 'pipe', 'pipe'])
  })

  /**
   * ГРАНИЦА КУСКА ПРОХОДИТ ПОСРЕДИ БУКВЫ, И ЭТО НЕ РЕДКОСТЬ, А УСТРОЙСТВО ТРУБЫ. Имена тестов
   * в этом дереве написаны по-русски: буква занимает два байта, и кусок, оборванный между
   * ними, при склейке байтами даёт мусор — отказ назвал бы тест, которого нет. Поэтому здесь
   * настоящий поток (не заглушка-эмиттер): только он умеет декодировать через границу, и
   * только на нём эта разница видна.
   */
  it('русское имя не рвётся на границе куска — поток декодируется, а не склеивается по байтам', async () => {
    const child = stubChild()
    child.stdout = new PassThrough()
    const p = runMergeSmokeAsync({ cwd: '/repo', ...treeWithTarget, spawn: () => child })
    const out = Buffer.from(' FAIL  a.test.ts > набор > падает\nAssertionError: нет\n', 'utf8')
    const cut = 20 // ровно посередине первой русской буквы
    child.stdout.write(out.subarray(0, cut))
    child.stdout.write(out.subarray(cut))
    await new Promise((r) => setImmediate(r))
    child.emit('exit', 1, null)
    const res: any = await p
    expect(res.failedTest, 'имя приехало склеенным из байтов').toBe('a.test.ts > набор > падает')
    expect(res.failedTest).not.toContain('�')
  })

  it('красный ребёнок называет упавший тест — вывод прочитан, а не выброшен', async () => {
    const child = stubChild()
    const p = runMergeSmokeAsync({ cwd: '/repo', ...treeWithTarget, spawn: () => child })
    child.stdout.emit('data', RED_OUTPUT)
    child.emit('exit', 1, null)
    const res: any = await p
    expect(res).toMatchObject({ passed: false, ran: true, exitCode: 1 })
    expect(res.failedTest).toContain('отказ несёт имя')
    expect(res.failureDetail).toContain('AssertionError')
  })

  it('a tree without the target resolves immediately, and nothing is launched at all', async () => {
    let launched = 0
    const res: any = await runMergeSmokeAsync({
      cwd: '/nowhere',
      exists: () => false,
      resolveEntry: () => 'C:/anywhere/suite-runner.mjs',
      spawn: () => {
        launched += 1
        return stubChild()
      },
    })
    expect(res).toMatchObject({ passed: null, ran: false, note: NO_TARGET_NOTE })
    expect(launched).toBe(0)
  })

  it('a REAL foreign tree whose target PASSES answers green — through the spawned child', async () => {
    const tree = mkdtempSync(join(tmpdir(), 'sma-smoke-async-'))
    const target = join(tree, MERGE_SMOKE_TARGET)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `import { describe, it, expect } from 'vitest'\ndescribe('smoke', () => { it('passes', () => { expect(1).toBe(1) }) })\n`, 'utf8')
    try {
      const res: any = await runMergeSmokeAsync({ cwd: tree })
      expect(res, `the real async runner did not answer green: ${JSON.stringify(res)}`).toMatchObject({
        passed: true,
        ran: true,
      })
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  }, 180000)
})
