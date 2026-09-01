/**
 * branch-sync-strays.test.ts — УБОРКА ЗА КОМАНДОЙ ПЕРЕСБОРКИ.
 *
 * ЧТО ЗДЕСЬ ЗАПЕРТО. Механический развод обещает не трогать в дереве ничего, кроме файлов
 * спора. Команда пересборки такого обещания не давала: это чужая программа со своим мнением о
 * том, что ей ещё поправить по дороге. Замерено 01.09.2026 живым прогоном на двух ветках,
 * отведённых от одной вершины: аудитор чисел, позванный ради карты замера, переписал заодно
 * маркер версии (`sma-core/VERSION`) — файл, которого в споре не было. Слияние потом откатилось
 * ЦЕЛИКОМ, отказ сказал «рабочее дерево вернулось в прежнее состояние», а `git status`
 * показывал изменённый файл. Ровно то враньё о состоянии дерева, от которого дом уже лечился:
 * дальше оно расходится веером — в список «что тронула эта попытка» въезжает файл, которого
 * работник не касался, а следующая дверь читает копию как грязную.
 *
 * ЧЕТЫРЕ ЗАМКА, И ВСЕ ЧЕТЫРЕ — ПРО ГРАНИЦУ: убрать своё, назвать неубранное, не тронуть чужое,
 * не спрашивать git там, где команд не было.
 *
 * Отдельным файлом, а не строкой в общем сьюте модуля: общий сьют в этот час держал другой
 * терминал (claim на `branch-sync.test.ts`), а перебивать чужой claim ради своего замка — это
 * ровно тот способ тихо потерять чужую работу, от которого весь этот модуль и написан.
 *
 * Швы те же, что и у всего слоя: git — подделка, диск — подделка, настоящего репозитория здесь
 * нет ни одного.
 */

import { describe, it, expect } from 'vitest'

import { resolveMechanical, parseStatusZ, straysBetween } from '../lib/branch-sync.mjs'

const NUL = String.fromCharCode(0)

const GRAPH = 'docs/master-graph.html'
const STRAY = 'sma-core/VERSION'

/** Снимок `git status --porcelain -z` из строк «XY путь». */
const snap = (rows: string[]) => (rows.length ? rows.join(NUL) + NUL : '')

/**
 * git, отвечающий на `status --porcelain` ПО ОЧЕРЕДИ заготовленными снимками.
 *
 * Возврат — это `checkout -- <путь>`; материализация стороны идёт тем же глаголом
 * (`checkout --ours -- <путь>`), и путать их нельзя: падать по заказу должен только возврат.
 */
function gitSnapshots(snapshots: string[][], failRestoreOf: string[] = []) {
  const calls: string[][] = []
  let asked = 0
  const git = (args: string[]) => {
    calls.push([...args])
    if (args.join(' ').includes('status --porcelain')) {
      const rows = snapshots[Math.min(asked, snapshots.length - 1)]
      asked += 1
      return snap(rows)
    }
    if (args[0] === 'checkout' && args[1] === '--' && failRestoreOf.some((f) => args.includes(f))) {
      throw new Error(`error: pathspec '${args[args.length - 1]}' did not match any file(s) known to git`)
    }
    return ''
  }
  return { git, calls, asked: () => asked }
}

/** Обе стороны карты пересобираются в ОДНО — значит выбирать было не из чего. */
const sameBothSides = { readFileSync: () => '<p>2984 tests</p>', writeFileSync: () => {} }

describe('снимок грязи — разбор ответа git и разница двух снимков', () => {
  it('parseStatusZ читает коды и пути, а прежнее имя переименования отдельным файлом не считает', () => {
    const map = parseStatusZ(snap(['M  README.md', ' M sma-core/VERSION', 'R  spa/new.ts', 'spa/old.ts']))
    expect(map.get('README.md')).toBe('M ')
    expect(map.get('sma-core/VERSION')).toBe(' M')
    expect(map.get('spa/new.ts')).toBe('R ')
    expect(map.has('spa/old.ts')).toBe(false)
  })

  it('straysBetween называет появившееся и изменившееся, но не файлы спора и не ушедшую грязь', () => {
    const before = parseStatusZ(snap(['M  docs/master-graph.html', ' M spa/src/App.tsx', ' M docs/gone.md']))
    const after = parseStatusZ(snap(['MM docs/master-graph.html', ' M spa/src/App.tsx', ' M sma-core/VERSION']))
    expect(straysBetween(before, after, [GRAPH])).toEqual([STRAY])
  })

  it('снимка нет (git не ответил) → сторон нет: неизвестность не выдаётся за чистоту', () => {
    expect(straysBetween(null, parseStatusZ(snap([' M sma-core/VERSION'])), [])).toEqual([])
    expect(straysBetween(parseStatusZ(''), null, [])).toEqual([])
  })
})

describe('уборка за командой — испачканное ВНЕ спора возвращается или называется', () => {
  it('файл вне спора возвращается из индекса и в оговорки не едет', () => {
    const { git, calls } = gitSnapshots([[`M  ${GRAPH}`], [`M  ${GRAPH}`, ` M ${STRAY}`], [`M  ${GRAPH}`]])
    const out = resolveMechanical({ cwd: '/copy', execGit: git, files: [GRAPH], io: sameBothSides, run: () => '' })
    expect(out.resolved).toEqual([{ file: GRAPH, how: 'rederive' }])
    expect(calls.some((c) => c[0] === 'checkout' && c[1] === '--' && c.includes(STRAY))).toBe(true)
    // Убранное МОЛЧИТ: оговорка о нём означала бы для человека работу, которой в дереве нет.
    expect(out.notes.join(' ')).not.toContain(STRAY)
  })

  it('вернуть не удалось → файл НАЗВАН вместе с состоянием дерева, а не проглочен', () => {
    const { git } = gitSnapshots(
      [[`M  ${GRAPH}`], [`M  ${GRAPH}`, `?? ${STRAY}`], [`M  ${GRAPH}`, `?? ${STRAY}`]],
      [STRAY],
    )
    const out = resolveMechanical({ cwd: '/copy', execGit: git, files: [GRAPH], io: sameBothSides, run: () => '' })
    expect(out.resolved).toEqual([{ file: GRAPH, how: 'rederive' }])
    expect(out.notes.join(' ')).toContain(STRAY)
    expect(out.notes.join(' ')).toContain('вернуть не удалось')
  })

  it('checkout прошёл, а файл остался грязным → это тоже названо: судим по снимку, а не по коду', () => {
    const { git } = gitSnapshots([[`M  ${GRAPH}`], [`M  ${GRAPH}`, ` M ${STRAY}`], [`M  ${GRAPH}`, ` M ${STRAY}`]])
    const out = resolveMechanical({ cwd: '/copy', execGit: git, files: [GRAPH], io: sameBothSides, run: () => '' })
    expect(out.notes.join(' ')).toContain(STRAY)
    expect(out.notes.join(' ')).toContain('дерево осталось грязным')
  })

  it('чужая незакоммиченная правка не трогается — она грязна в ОБОИХ снимках', () => {
    const FOREIGN = 'spa/src/App.tsx'
    const { git, calls } = gitSnapshots([
      [`M  ${GRAPH}`, ` M ${FOREIGN}`],
      [`M  ${GRAPH}`, ` M ${FOREIGN}`],
    ])
    const out = resolveMechanical({ cwd: '/copy', execGit: git, files: [GRAPH], io: sameBothSides, run: () => '' })
    expect(calls.some((c) => c[0] === 'checkout' && c[1] === '--' && c.includes(FOREIGN))).toBe(false)
    expect(out.notes.join(' ')).not.toContain(FOREIGN)
  })

  it('правил пересборки нет → про грязь git не спрашивают вовсе', () => {
    // Маркеры собираются из повторов, а не пишутся литералом: файл со спором в исходнике —
    // это тот самый спор, который потом ищут в чужом дереве.
    const M = { ours: '<'.repeat(7), base: '|'.repeat(7), mid: '='.repeat(7), theirs: '>'.repeat(7) }
    const disputed = [`${M.ours} ours`, 'наш абзац', `${M.base} base`, M.mid, 'их абзац', `${M.theirs} theirs`, ''].join('\n')
    const { git, asked } = gitSnapshots([[]])
    const out = resolveMechanical({
      cwd: '/copy',
      execGit: git,
      files: ['README.md'],
      rules: { union: ['README.md'], regenerate: [] },
      io: { readFileSync: () => disputed, writeFileSync: () => {} },
      run: () => '',
    })
    expect(out.resolved).toEqual([{ file: 'README.md', how: 'union' }])
    expect(asked()).toBe(0)
  })
})
