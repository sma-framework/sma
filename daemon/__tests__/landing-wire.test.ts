/**
 * ПОСАДКА СОБРАНА В БОЕВОМ ДЕМОНЕ — ИЛИ КНОПКА ОСТАЁТСЯ ПОЛОВИНОЙ ДЕЛА.
 *
 * ═══════════════ ЗАЧЕМ ЭТОТ ФАЙЛ ═══════════════
 *
 * Штамп чисел и решение «гнать ли полный набор» живут в своей библиотеке, и у неё есть свой
 * прогон над одноразовыми репозиториями. Но дверь приёмки зовёт не библиотеку — она зовёт
 * ЗАМЫКАНИЕ, собранное корнем сборки, и ровно там однажды уже оказалась пустота: ритуал
 * слияния годами получал `undefined` вместо прогонятеля, всё вокруг было зелёным, потому что
 * каждый прогон собирал СВОЙ демон и передавал СВОЙ прогонятель. Тест, собирающий то, что
 * проверяет, доказывает только собственную сборку.
 *
 * Поэтому здесь строится НАСТОЯЩИЙ демон — `createDaemon()` без единого переопределения, тем
 * же вызовом, каким его строит боевая точка входа, — и у собранного объекта спрашивается то,
 * чего он не может ответить случайно: его собственное замыкание приёмки прогоняется над
 * одноразовым репозиторием, и у вершины после этого спрашивают оба сторожа.
 *
 * ЧТО ИМЕННО ДОКАЗЫВАЕТСЯ:
 *   1. Замыкание двери делает ПОСАДКУ, а не одно слияние: в ответе есть штамп, и он встал.
 *   2. После него вершина ЗЕЛЁНАЯ по обоим сторожам — без единой команды человека.
 *   3. Коммит штампа несёт только производные места; маркера версии в нём нет, и дерево
 *      после посадки чистое.
 *   4. Квитанция, снятая на том же коде, не отправляет набор на второй прогон.
 *
 * НИЧЕГО ОБЩЕГО НЕ ТРОГАЕТСЯ: настройка демона указывает во временные каталоги и на закрытый
 * порт, демон только СОБИРАЕТСЯ и никогда не запускается, а слияние идёт в одноразовом
 * репозитории со своими бронью и журналом — общая бронь этой копии не занимается никогда.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { createDaemon } from '../src/main.mjs'
import { STAMP_PATHS } from '../../scripts/sma/lib/landing.mjs'
import { checkBadge, readChangedSince, readHead } from '../../scripts/sma/lib/badge.mjs'
import { audit } from '../../scripts/sma/lib/doc-audit.mjs'

const TOKEN = 'e'.repeat(64)
const GRAPH = 'docs/master-graph.html'

let tmpRoot: string
let park: any
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8' })
  } catch (err) {
    throw new Error(
      `git недоступен на этой машине, поэтому провод посадки НЕ ПРОВЕРЕН: ${String(err)}. ` +
        'Прогон, которого не было, никогда не считается проходом.',
    )
  }

  tmpRoot = mkdtempSync(join(tmpdir(), 'sma-landing-wire-'))
  const repoDir = join(tmpRoot, 'served')
  mkdirSync(repoDir, { recursive: true })
  const configPath = join(tmpRoot, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      queueUrl: 'postgres://127.0.0.1:1/sma_none',
      bind: '127.0.0.1',
      port: 7802,
      token: TOKEN,
      repoDir,
      dataDir: join(tmpRoot, 'data'),
      ledgerDir: join(tmpRoot, 'ledger'),
      projects: [{ id: 'p1', name: 'p1' }],
      activeProject: 'p1',
    }),
    'utf8',
  )
  for (const key of ['SMA_DAEMON_CONFIG', 'SMA_DAEMON_MCP']) savedEnv[key] = process.env[key]
  process.env.SMA_DAEMON_CONFIG = configPath
  process.env.SMA_DAEMON_MCP = join(tmpRoot, 'absent-mcp.json')

  park = createDaemon()
})

afterAll(() => {
  try {
    if (park && park.hub && typeof park.hub.close === 'function') park.hub.close()
    if (park && park.daemon && typeof park.daemon.stop === 'function') park.daemon.stop()
  } catch {
    /* best-effort */
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

function put(root: string, rel: string, text: string) {
  const path = join(root, ...rel.split('/'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

function readIn(root: string, rel: string) {
  return readFileSync(join(root, ...rel.split('/')), 'utf8')
}

function graphHtml({ tests, files, date, commit }: { tests: number; files: number; date: string; commit: string }) {
  return [
    '<!doctype html><html><body>',
    `<!-- sma:num-meta:start -->v1.0.0 · ${tests} tests · ${files} files<!-- sma:num-meta:end -->`,
    `<!-- sma:num-hero:start -->v1.0.0 · ${tests} tests · ${files} files<!-- sma:num-hero:end -->`,
    `<!-- sma:num-footer:start -->v1.0.0 · ${tests} tests · ${files} files<!-- sma:num-footer:end -->`,
    `<svg role="img" aria-label="Growth, and ${tests} tests across ${files} files on the working tree, ${date}.">`,
    '<line class="tip" x1="342" y1="148.53" x2="410" y2="160.00"/>',
    `<circle class="tip" cx="410" cy="160.00" r="5"><title>main — ${tests} tests, ${files} files. A working-tree measurement — the run receipt of ${date} at commit ${commit}.</title></circle>`,
    `<text class="val tip" x="410" y="150.00">${tests}</text>`,
    `<text class="ax tip" x="410" y="176.00">${files} files</text>`,
    '</svg>',
    `<figcaption>It is the run receipt of the suite on main, ${date} (${tests} tests / ${files} files).</figcaption>`,
    '</body></html>',
  ].join('\n')
}

function readmeText(tests: number, alt: string) {
  return `# fixture\n<img src="https://img.shields.io/badge/tests-${tests}%2F${tests}-brightgreen" alt="${alt} ${tests}/${tests}">\n`
}

describe('дверь приёмки боевого демона делает ПОСАДКУ, а не одно слияние', () => {
  it('замыкание двери сводит ветку, штампует числа и оставляет вершину зелёной', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sma-landing-wire-repo-'))
    const repo = join(home, 'repo')
    mkdirSync(repo, { recursive: true })
    const claimsDir = join(home, 'claims')
    const journalDir = join(home, 'journal')
    mkdirSync(claimsDir, { recursive: true })
    mkdirSync(journalDir, { recursive: true })
    const git = (args: string[]) => String(execFileSync('git', args, { cwd: repo, encoding: 'utf8' }))
    try {
      git(['init', '-q'])
      git(['config', 'user.email', 'suite@example.invalid'])
      git(['config', 'user.name', 'suite'])
      git(['config', 'commit.gpgsign', 'false'])
      git(['config', 'core.autocrlf', 'false'])
      put(repo, 'package.json', `${JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2)}\n`)
      put(repo, 'src/first.mjs', 'export const first = 1\n')
      put(repo, 'sma-core/VERSION', '1.0.0\r\n')
      put(repo, 'README.md', readmeText(21, 'tests'))
      put(repo, 'README.ru.md', readmeText(21, 'тесты'))
      // Карта отстала: числа в ней — от позавчерашнего замера. Ровно это и краснеет у
      // человека сразу после кнопки, и ровно это дверь обязана починить сама.
      put(repo, GRAPH, graphHtml({ tests: 7, files: 2, date: '30.08.2026', commit: '0000000' }))
      git(['add', '-A'])
      git(['commit', '-q', '--no-verify', '-m', 'fixture'])
      const measured = git(['rev-parse', 'HEAD']).trim()
      put(
        repo,
        'test-receipt.json',
        `${JSON.stringify(
          { tests: 21, files: 6, measuredAt: '2026-09-01T10:00:00.000Z', source: 'vitest', commit: measured, dirty: false },
          null,
          2,
        )}\n`,
      )
      git(['add', '--', 'test-receipt.json'])
      git(['commit', '-q', '--no-verify', '-m', 'worker stamp'])
      const trunk = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()

      // Ветка работника: правка прозы. Кода она не двигает, значит квитанция, снятая до неё,
      // описывает и сведённое дерево — второй прогон здесь был бы прогоном ни за чем.
      git(['checkout', '-q', '-b', 'wt/prose'])
      put(repo, 'NOTES.md', 'a paragraph a worker added\n')
      git(['add', '--', 'NOTES.md'])
      git(['commit', '-q', '--no-verify', '-m', 'prose'])
      git(['checkout', '-q', trunk])

      // ── БОЕВОЕ ЗАМЫКАНИЕ, вызванное ровно так, как его вызывает дверь приёмки.
      const res: any = await park.front.deps.verbRunner({
        branch: 'wt/prose',
        by: 'landing-wire-case',
        cwd: repo,
        claimsDir,
        journalDir,
      })

      expect(res.softDenied, 'случай занял чужую бронь слияния вместо своей').toBeFalsy()
      expect(res.merged, `слияние не прошло: ${JSON.stringify(res)}`).toBe(true)

      // (1) ЭТО ПОСАДКА. Корень сборки, отдавший двери одно слияние, оставил бы это поле пустым.
      expect(res.landing, 'дверь боевого демона сделала слияние без штампа — посадка не собрана').toBeTruthy()
      expect(res.landing.stamped, JSON.stringify(res.landing)).toBe(true)
      expect(res.landing.reusedReceipt, 'квитанция снята на том же коде — набор гнать было незачем').toBe(true)
      expect(res.landing.ran).toBe(false)
      expect(res.landing.tests).toBe(21)

      // (2) ВЕРШИНА ЗЕЛЁНАЯ ПО ОБОИМ СТОРОЖАМ — теми же вопросами, которые человек задавал руками.
      const head = readHead({ cwd: repo })
      const receiptCommit = JSON.parse(readIn(repo, 'test-receipt.json')).commit
      const badge = checkBadge({ pkgRoot: repo, head, changedSince: readChangedSince({ cwd: repo, commit: receiptCommit }) })
      expect(badge.violations, JSON.stringify(badge.violations)).toEqual([])
      const numbers = audit({ target: 'numbers', rootDir: repo })
      expect(
        (numbers.violations as any[]).filter((v) => v.file === GRAPH),
        JSON.stringify(numbers.violations),
      ).toEqual([])
      expect(readIn(repo, GRAPH)).toContain('21 tests · 6 files')

      // (3) КОММИТ ШТАМПА НЕСЁТ ТОЛЬКО ПРОИЗВОДНОЕ, и маркера версии в нём нет.
      const stampFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD'])
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      expect(stampFiles).not.toContain('sma-core/VERSION')
      for (const f of stampFiles) expect(STAMP_PATHS as readonly string[]).toContain(f)
      expect(git(['status', '--porcelain']).trim(), 'посадка оставила дерево грязным').toBe('')
      expect(readIn(repo, 'sma-core/VERSION')).toBe('1.0.0\r\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 180000)
})
