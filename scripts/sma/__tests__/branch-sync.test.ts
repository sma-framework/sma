/**
 * Tests for scripts/sma/lib/branch-sync.mjs — сведение ветки с вершиной и словарь конфликта.
 *
 * ЧТО ЗДЕСЬ ЗАПЕРТО, и какой дефект стоит за каждым замком:
 *   1. конфликт называется ФАЙЛАМИ И ЧИСЛОМ, а не одной строкой «Command failed» — это тот
 *      самый ответ, который приёмщик пять раз подряд выяснял руками (31.08.2026);
 *   2. «git не ответил» отличимо от «конфликтов нет»: пустой список при `answered:false`
 *      читается как неизвестность, иначе неизвестность тихо станет зелёным ответом;
 *   3. механическим считается ТОЛЬКО то, где нет выбора: база пуста → обе стороны остаются;
 *      база непуста → человеку. Развод «на глазок» и есть тихий откат чужой починки;
 *   4. правило без команды пересборки НЕ объявляет файл механическим — это была бы подделка
 *      развода;
 *   5. пересобранный файл, в котором ОСТАЛИСЬ маркеры, не засчитывается разведённым;
 *   6. сводить нечего → слияния не делается вовсе (иначе в ветке заводится пустой коммит
 *      слияния, а по коммитам считают, была ли работа);
 *   7. неразведённое → `merge --abort` и честный отказ; наполовину разведённое слияние хуже
 *      неразведённого, потому что выглядит готовым;
 *   8. НИ ОДНОГО `push` ни на одном пути — тот же закон, что у ритуала слияния;
 *   9. спор ОСТАВЛЯЕТСЯ в дереве только по просьбе (`keepConflict`) и только когда он есть —
 *      и тогда у него есть выход (`abortSync`), потому что дверь, в которую можно только
 *      войти, — это не дверь: `git merge --abort` работнику отказан тем же конвертом, что и
 *      само слияние;
 *  10. код возврата команды пересборки — не всегда итог записи: у правила, объявившего
 *      `exitIsVerdict`, решает доказательство на самом файле, а отказ называется вслух. Без
 *      этого один посторонний упрёк аудитора отправлял человеку уже пересобранную карту;
 *  11. строка ЗАМЕРА (бейдж прогона, квитанция) — единственная непустая база, которая
 *      разводится без человека: числа измерены на двух разных деревьях, слитого не видел ни
 *      один прогон, и своя сторона берётся не как правая, а как одна из двух устаревших. Без
 *      этого одна строка бейджа отказывала склейке НА ВЕСЬ README — а перештамповывает бейдж
 *      КАЖДАЯ работа этого дома. Исключение узкое: бейдж версии и рукописное рядом — человеку.
 *
 * Швы: execGit / io / run — подделки. Ни настоящего git, ни настоящего диска, ни одной
 * настоящей команды пересборки.
 */

import { describe, it, expect } from 'vitest'

import {
  conflictedFiles,
  conflictWords,
  classifyConflicts,
  unionResolve,
  resolveMechanical,
  behindBy,
  syncWithTrunk,
  abortSync,
  unresolvedMergeHint,
  matchesPattern,
  mechanicalPaths,
  isMechanicalPath,
  measuredLinePatterns,
  hasConflictMarkers,
  CONFLICT_FILES_CAP,
  MECHANICAL_DEFAULTS,
  TRUNK_DEFAULT,
} from '../lib/branch-sync.mjs'

const NUL = String.fromCharCode(0)

/** Подделка git: пишет вызовы и отвечает по сценарию (строка или бросок). */
function fakeGit(script: Record<string, any> = {}) {
  const calls: string[][] = []
  const git = (args: string[]) => {
    calls.push([...args])
    for (const [key, value] of Object.entries(script)) {
      if (args.join(' ').includes(key)) {
        if (value instanceof Error) throw value
        if (typeof value === 'function') return value(args)
        return value
      }
    }
    return ''
  }
  return { git, calls }
}

const CONFLICT_ERROR = Object.assign(new Error('Command failed: git merge --no-ff --no-commit main'), { status: 1 })

describe('словарь конфликта — файлы и число, а не «Command failed»', () => {
  it('conflictedFiles спрашивает сам git о неразведённых стадиях и разбирает -z', () => {
    const { git, calls } = fakeGit({ 'diff --name-only': `daemon/src/loop.mjs${NUL}README.md${NUL}` })
    const found = conflictedFiles({ cwd: '/tmp/copy', execGit: git })
    expect(found.answered).toBe(true)
    expect(found.files).toEqual(['daemon/src/loop.mjs', 'README.md'])
    expect(found.count).toBe(2)
    // именно --diff-filter=U: состав конфликта спрашивается у git, а не выводится из прозы ошибки
    expect(calls.some((c) => c.includes('--diff-filter=U'))).toBe(true)
  })

  it('git не ответил → answered:false, и пустой список НЕ означает «конфликтов нет»', () => {
    const { git } = fakeGit({ 'diff --name-only': new Error('fatal: not a git repository') })
    const found = conflictedFiles({ cwd: '/tmp/copy', execGit: git })
    expect(found.answered).toBe(false)
    expect(found.count).toBe(0)
    expect(found.reason).toContain('git не ответил')
  })

  it('conflictWords называет число и имена, а обрезанное — числом, а не молчанием', () => {
    const many = Array.from({ length: CONFLICT_FILES_CAP + 3 }, (_, i) => `src/f${i}.mjs`)
    const words = conflictWords({ files: many, count: many.length })
    expect(words).toContain(`конфликт в ${many.length} файл(ах)`)
    expect(words).toContain('src/f0.mjs')
    expect(words).toContain('… ещё 3')
    expect(conflictWords({ files: [], count: 0 })).toBe('конфликтов не названо')
  })
})

describe('что считается механическим — и что не считается', () => {
  it('образец с * не переходит через слэш', () => {
    expect(matchesPattern('.claude/memory/INDEX-tech.md', '.claude/memory/INDEX-*.md')).toBe(true)
    expect(matchesPattern('.claude/memory/deep/INDEX-tech.md', '.claude/memory/INDEX-*.md')).toBe(false)
    expect(matchesPattern('README.md', 'README.md')).toBe(true)
  })

  it('пересборка сильнее склейки, а незнакомый файл — человеку', () => {
    const split = classifyConflicts(
      ['README.md', '.claude/memory/MEMORY.md', 'daemon/src/loop.mjs'],
      MECHANICAL_DEFAULTS,
    )
    expect(split.union).toEqual(['README.md'])
    expect(split.regenerate.map((r) => r.file)).toEqual(['.claude/memory/MEMORY.md'])
    expect(split.human).toEqual(['daemon/src/loop.mjs'])
  })

  it('квитанция замера — свой класс, а не «человеку»: склеивать две квитанции нечем', () => {
    const split = classifyConflicts(['test-receipt.json', 'daemon/src/loop.mjs'], MECHANICAL_DEFAULTS)
    expect(split.measured).toEqual(['test-receipt.json'])
    expect(split.human).toEqual(['daemon/src/loop.mjs'])
  })

  // ОДИН СПИСОК НА ДВУХ СПРАШИВАЮЩИХ. О механическом спрашивает не только слияние: очередь
  // задаёт тот же вопрос, решая, стоит ли из-за файла придерживать работу. Второй перечень тех
  // же имён разошёлся бы с первым в первый же день, когда правила пополнят с одной стороны.
  it('весь механический набор называется одним списком — склейка, замер и пересборка вместе', () => {
    const paths = mechanicalPaths(MECHANICAL_DEFAULTS)
    expect(paths).toContain('README.md')
    expect(paths).toContain('README.ru.md')
    expect(paths).toContain('test-receipt.json')
    expect(paths).toContain('docs/master-graph.html')
    expect(paths).toContain('.claude/memory/INDEX-*.md')
    expect(paths).not.toContain('daemon/src/loop.mjs')
  })

  it('вопрос «развожу ли я это сам» отвечается по образцу, а не по точному имени', () => {
    expect(isMechanicalPath('README.ru.md')).toBe(true)
    expect(isMechanicalPath('.claude/memory/INDEX-tech.md')).toBe(true)
    expect(isMechanicalPath('daemon/src/loop.mjs')).toBe(false)
    expect(isMechanicalPath('')).toBe(false)
    // Свои правила звонящего — своё поведение: список остаётся данными.
    expect(isMechanicalPath('README.md', { union: [] })).toBe(false)
  })

  // Строки бейджа — это СТРОКИ внутри рукописного файла, а не файлы: объявить по ним весь файл
  // механическим значило бы соврать о чужих абзацах.
  it('образцы строк замера файлами не притворяются', () => {
    expect(mechanicalPaths({ measured: { lines: ['img\\.shields\\.io/badge/tests-'] } })).toEqual([])
  })

  it('правило БЕЗ команды пересборки не делает файл механическим', () => {
    const split = classifyConflicts(['docs/master-graph.html'], {
      union: [],
      regenerate: [{ files: ['docs/master-graph.html'], command: [] }],
    })
    expect(split.regenerate).toEqual([])
    expect(split.human).toEqual(['docs/master-graph.html'])
  })
})

describe('склейка дописанного — обе стороны остаются, спор уходит человеку', () => {
  it('база пуста → остаются оба абзаца, каждый своей строкой', () => {
    const text = [
      '# README',
      '<<<<<<< HEAD',
      'абзац моей работы',
      '||||||| base',
      '=======',
      'абзац соседней работы',
      '>>>>>>> main',
      'хвост',
    ].join('\n')
    const out = unionResolve(text)
    expect(out.text).toBe(['# README', 'абзац моей работы', 'абзац соседней работы', 'хвост'].join('\n'))
    expect(out.hunks).toBe(1)
    expect(hasConflictMarkers(out.text as string)).toBe(false)
  })

  it('база НЕ пуста → отказ: это спор о содержании, а не дописывание', () => {
    const text = ['<<<<<<< HEAD', 'моя правка', '||||||| base', 'то, что было', '=======', 'чужая правка', '>>>>>>> main'].join('\n')
    const out = unionResolve(text)
    expect(out.text).toBeNull()
    expect(out.reason).toContain('существующие строки')
  })

  it('разметка без базы не разводится вовсе — доказать безопасность нечем', () => {
    const text = ['<<<<<<< HEAD', 'моё', '=======', 'чужое', '>>>>>>> main'].join('\n')
    expect(unionResolve(text).text).toBeNull()
  })

  it('обе стороны дописали одно и то же → строка остаётся одна', () => {
    const text = ['<<<<<<< HEAD', 'один и тот же абзац', '||||||| base', '=======', 'один и тот же абзац', '>>>>>>> main'].join('\n')
    expect(unionResolve(text).text).toBe('один и тот же абзац')
  })
})

/**
 * СТРОКА ЗАМЕРА — ЕДИНСТВЕННАЯ НЕПУСТАЯ БАЗА, КОТОРАЯ РАЗВОДИТСЯ БЕЗ ЧЕЛОВЕКА.
 *
 * Дефект за этими замками измерен на живом дереве 01.09.2026: всякая работа перед сдачей
 * перештамповывает бейдж прогона, это правка существующей строки, и склейка отказывала НА ВЕСЬ
 * README — вместе с абзацами, ради которых класс `union` и писался. Исключение обязано остаться
 * узким: числа замера — да; всё, что рядом с ними, — по-прежнему человеку.
 */
describe('секция чистого замера — устарела у обеих сторон, и это не спор о содержании', () => {
  const lines = measuredLinePatterns(MECHANICAL_DEFAULTS)
  const badge = (n: number) => `  <img src="https://img.shields.io/badge/tests-${n}%2F${n}-3CC0A0" alt="tests ${n}/${n}">`
  const section = (ours: string, base: string, theirs: string) =>
    ['<<<<<<< HEAD', ours, '||||||| base', base, '=======', theirs, '>>>>>>> main'].join('\n')

  it('бейдж прогона с обеих сторон → берётся своя, секция засчитана как замер', () => {
    const out = unionResolve(section(badge(6156), badge(6054), badge(6100)), { measuredLines: lines })
    expect(out.text).toBe(badge(6156))
    expect(out.measured).toBe(1)
    expect(hasConflictMarkers(out.text as string)).toBe(false)
  })

  it('в одном файле и абзац, и бейдж → развелось ВСЁ, а раньше отказывало всё', () => {
    const text = [
      section(badge(6156), badge(6054), badge(6100)),
      '## Что нового',
      '<<<<<<< HEAD',
      'абзац моей работы',
      '||||||| base',
      '=======',
      'абзац соседней работы',
      '>>>>>>> main',
    ].join('\n')
    const out = unionResolve(text, { measuredLines: lines })
    expect(out.text).toBe([badge(6156), '## Что нового', 'абзац моей работы', 'абзац соседней работы'].join('\n'))
    expect(out.hunks).toBe(2)
    expect(out.measured).toBe(1)
    // Тот же текст БЕЗ объявленных образцов ведёт себя ровно как до появления класса.
    expect(unionResolve(text).text).toBeNull()
  })

  it('бейдж ВЕРСИИ замером не является — выпуск объявляют, а не измеряют', () => {
    const ver = (v: string) => `  <img src="https://img.shields.io/badge/version-${v}-3B82F6">`
    const out = unionResolve(section(ver('5.7.2'), ver('5.7.0'), ver('5.7.1')), { measuredLines: lines })
    expect(out.text).toBeNull()
    expect(out.reason).toContain('существующие строки')
  })

  it('рукописная строка, заехавшая в секцию с бейджем, возвращает её человеку целиком', () => {
    const out = unionResolve(
      section(`${badge(6156)}\nи моя правка рядом`, badge(6054), badge(6100)),
      { measuredLines: lines },
    )
    expect(out.text).toBeNull()
  })
})

describe('resolveMechanical — разводит без выбора и не трогает ничего больше', () => {
  const unionFile = ['<<<<<<< HEAD', 'моё', '||||||| base', '=======', 'чужое', '>>>>>>> main'].join('\n')

  it('склеенный файл переписан и добавлен в индекс; чужое осталось человеку', () => {
    const { git, calls } = fakeGit()
    const written: Record<string, string> = {}
    const io = {
      readFileSync: () => unionFile,
      writeFileSync: (p: string, t: string) => {
        written[String(p).replace(/\\/g, '/')] = t
      },
    }
    const out = resolveMechanical({
      cwd: '/copy',
      execGit: git,
      files: ['README.md', 'daemon/src/loop.mjs'],
      io,
      run: () => '',
    })
    expect(out.resolved).toEqual([{ file: 'README.md', how: 'union' }])
    expect(out.remaining).toEqual(['daemon/src/loop.mjs'])
    expect(Object.values(written)[0]).toBe('моё\nчужое')
    expect(calls.some((c) => c[0] === 'add' && c.includes('README.md'))).toBe(true)
    expect(calls.some((c) => c.join(' ').includes('--conflict=diff3'))).toBe(true)
  })

  it('квитанция замера разводится ПЕРВОЙ — до пересборки карты, которая её читает', () => {
    const trace: string[] = []
    const out = resolveMechanical({
      cwd: '/copy',
      execGit: (args: string[]) => {
        trace.push(`git ${args.join(' ')}`)
        return ''
      },
      files: ['docs/master-graph.html', 'test-receipt.json'],
      io: { readFileSync: () => 'пересобрано, маркеров нет', writeFileSync: () => {} },
      run: (cmd: string[]) => {
        trace.push(`run ${cmd.join(' ')}`)
        return ''
      },
    })
    const ours = trace.findIndex((t) => t === 'git checkout --ours -- test-receipt.json')
    const firstRun = trace.findIndex((t) => t.startsWith('run '))
    expect(ours).toBeGreaterThanOrEqual(0)
    // Пересборка карты читает квитанцию: запущенная поверх маркеров, она вернула бы обе стороны
    // неизменными, и механический по природе файл уехал бы человеку следом за источником.
    expect(firstRun).toBeGreaterThan(ours)
    expect(out.resolved).toContainEqual({ file: 'test-receipt.json', how: 'measured' })
    expect(out.notes.join(' ')).toContain('устарели у ОБЕИХ сторон')
    expect(out.notes.join(' ')).toContain('npm run badge')
    expect(out.remaining).toEqual([])
  })

  it('README с бейджем и абзацем: развод назван составом, а устаревшее число — вслух', () => {
    const { git } = fakeGit()
    const readme = [
      '<<<<<<< HEAD',
      '  <img src="https://img.shields.io/badge/tests-6156%2F6156-3CC0A0" alt="tests 6156/6156">',
      '||||||| base',
      '  <img src="https://img.shields.io/badge/tests-6054%2F6054-3CC0A0" alt="tests 6054/6054">',
      '=======',
      '  <img src="https://img.shields.io/badge/tests-6100%2F6100-3CC0A0" alt="tests 6100/6100">',
      '>>>>>>> main',
      '<<<<<<< HEAD',
      'мой абзац',
      '||||||| base',
      '=======',
      'соседний абзац',
      '>>>>>>> main',
    ].join('\n')
    let saved = ''
    const out = resolveMechanical({
      cwd: '/copy',
      execGit: git,
      files: ['README.md'],
      io: { readFileSync: () => readme, writeFileSync: (_p: string, t: string) => { saved = t } },
      run: () => '',
    })
    expect(out.resolved).toEqual([{ file: 'README.md', how: 'union+measured' }])
    expect(saved).toContain('tests-6156')
    expect(saved).toContain('мой абзац')
    expect(saved).toContain('соседний абзац')
    expect(out.notes.join(' ')).toContain('npm run badge')
  })

  it('одна команда пересборки запускается ОДИН раз на весь свой набор файлов', () => {
    const { git } = fakeGit()
    const runs: string[][] = []
    const out = resolveMechanical({
      cwd: '/copy',
      execGit: git,
      files: ['.claude/memory/MEMORY.md', '.claude/memory/INDEX-tech.md'],
      io: { readFileSync: () => 'пересобранный индекс без маркеров', writeFileSync: () => {} },
      run: (cmd: string[]) => {
        runs.push(cmd)
        return ''
      },
    })
    expect(runs.length).toBe(1)
    expect(out.resolved.map((r) => r.how)).toEqual(['regenerate', 'regenerate'])
    expect(out.remaining).toEqual([])
  })

  it('пересборка прошла, а маркеры остались → файл НЕ засчитывается разведённым', () => {
    const { git } = fakeGit()
    const out = resolveMechanical({
      cwd: '/copy',
      execGit: git,
      files: ['.claude/memory/MEMORY.md'],
      io: { readFileSync: () => unionFile, writeFileSync: () => {} },
      run: () => '',
    })
    expect(out.resolved).toEqual([])
    expect(out.remaining).toEqual(['.claude/memory/MEMORY.md'])
    expect(out.notes.join(' ')).toContain('маркеры конфликта остались')
  })

  it('отказ команды пересборки уводит её файлы человеку, а не роняет развод', () => {
    const { git } = fakeGit()
    const out = resolveMechanical({
      cwd: '/copy',
      execGit: git,
      files: ['.claude/memory/MEMORY.md'],
      io: { readFileSync: () => '', writeFileSync: () => {} },
      run: () => {
        throw new Error('build-index refused')
      },
    })
    expect(out.remaining).toEqual(['.claude/memory/MEMORY.md'])
    expect(out.notes.join(' ')).toContain('пересборка отказала')
  })

  // ── ПОХОДКА `rederive` — КАРТА ЗАМЕРА ─────────────────────────────────────────────────
  //
  // Числа графика названы в задаче механическим местом, но команда, которая их пишет, правит
  // в файле ТОЛЬКО свои размеченные спаны: запусти её поверх конфликта — маркеры останутся,
  // потому что она их не трогает. Поэтому решает сравнение двух пересборок, и заперто здесь
  // именно оно: совпали — разница была производной и выбирать было не из чего; разошлись —
  // спорили о рукописном (пять исторических точек, подпись под рисунком), и это человеку.
  describe('rederive — две пересборки решают, был ли выбор', () => {
    const GRAPH = 'docs/master-graph.html'

    /** io, отвечающий тем, что «пересборка» положила на диск для текущей стороны. */
    const sideIo = (bySide: Record<string, string>, state: { side: string }) => ({
      readFileSync: () => bySide[state.side],
      writeFileSync: () => {},
    })

    it('обе стороны пересобираются в ОДНО → файл разведён без человека', () => {
      const state = { side: '' }
      const { git, calls } = fakeGit({
        checkout: (args: string[]) => {
          state.side = args.includes('--ours') ? 'ours' : 'theirs'
          return ''
        },
      })
      const out = resolveMechanical({
        cwd: '/copy',
        execGit: git,
        files: [GRAPH],
        io: sideIo({ ours: '<p>2984 tests</p>', theirs: '<p>2984 tests</p>' }, state),
        run: () => '',
      })
      expect(out.resolved).toEqual([{ file: GRAPH, how: 'rederive' }])
      expect(out.remaining).toEqual([])
      // ОБЕ стороны материализованы — ни одна не объявлена правой без второй.
      expect(calls.some((c) => c.includes('--ours'))).toBe(true)
      expect(calls.some((c) => c.includes('--theirs'))).toBe(true)
      expect(calls.some((c) => c[0] === 'add' && c.includes(GRAPH))).toBe(true)
    })

    it('стороны пересобираются в РАЗНОЕ → человеку, и ни одна не выбрана', () => {
      const state = { side: '' }
      const { git, calls } = fakeGit({
        checkout: (args: string[]) => {
          state.side = args.includes('--ours') ? 'ours' : 'theirs'
          return ''
        },
      })
      const out = resolveMechanical({
        cwd: '/copy',
        execGit: git,
        files: [GRAPH],
        io: sideIo({ ours: '<p>наша подпись</p>', theirs: '<p>чужая подпись</p>' }, state),
        run: () => '',
      })
      expect(out.resolved).toEqual([])
      expect(out.remaining).toEqual([GRAPH])
      expect(out.notes.join(' ')).toContain('пересобираются в РАЗНОЕ')
      expect(calls.some((c) => c[0] === 'add' && c.includes(GRAPH))).toBe(false)
    })

    it('совпали, но маркеры уцелели → разведённым НЕ считается', () => {
      const state = { side: '' }
      const { git } = fakeGit({ checkout: () => '' })
      const out = resolveMechanical({
        cwd: '/copy',
        execGit: git,
        files: [GRAPH],
        io: sideIo({ '': unionFile }, state),
        run: () => '',
      })
      expect(out.resolved).toEqual([])
      expect(out.remaining).toEqual([GRAPH])
      expect(out.notes.join(' ')).toContain('маркеры конфликта остались')
    })

    it('отказ команды не решает за файл: стороны разошлись → человеку, сосед разведён', () => {
      const state = { side: '' }
      const { git } = fakeGit({
        checkout: (args: string[]) => {
          if (args.includes('--ours')) state.side = 'ours'
          else if (args.includes('--theirs')) state.side = 'theirs'
          return ''
        },
      })
      const sides: Record<string, string> = { ours: '<p>наша подпись</p>', theirs: '<p>чужая подпись</p>' }
      const out = resolveMechanical({
        cwd: '/copy',
        execGit: git,
        files: [GRAPH, 'README.md'],
        io: {
          readFileSync: (p: string) => (String(p).includes('master-graph') ? sides[state.side] : unionFile),
          writeFileSync: () => {},
        },
        run: () => {
          throw new Error('doc-audit: 1 violation(s).')
        },
      })
      expect(out.remaining).toEqual([GRAPH])
      expect(out.notes.join(' ')).toContain('пересобираются в РАЗНОЕ')
      // Соседний union-файл разведён как ни в чём не бывало — отказ одного не топит другого.
      expect(out.resolved).toEqual([{ file: 'README.md', how: 'union' }])
    })

    // ── КОД ВОЗВРАТА КОМАНДЫ — НЕ ВСЕГДА ИТОГ ЗАПИСИ ──────────────────────────────────
    //
    // Замерено 31.08.2026 живым прогоном верба: карта уехала человеку со словами «пересобрать
    // обе стороны не удалось», хотя пересобрана была дважды и успешно. Команда здесь аудитор:
    // пишет выведенные числа и ТУТ ЖЕ возвращает вердикт обо всём документе, и одно постороннее
    // замечание (о другом файле) делало код возврата ненулевым. Заперто ровно это: у правила,
    // объявившего `exitIsVerdict`, решает доказательство на файле, а отказ НАЗЫВАЕТСЯ.
    it('exitIsVerdict: команда отказала, а обе пересборки сошлись → развод по результату', () => {
      const state = { side: '' }
      const { git, calls } = fakeGit({
        checkout: (args: string[]) => {
          state.side = args.includes('--ours') ? 'ours' : 'theirs'
          return ''
        },
      })
      const out = resolveMechanical({
        cwd: '/copy',
        execGit: git,
        files: [GRAPH],
        io: sideIo({ ours: '<p>5913 tests</p>', theirs: '<p>5913 tests</p>' }, state),
        run: () => {
          throw new Error('doc-audit: 1 violation(s).')
        },
      })
      expect(out.resolved).toEqual([{ file: GRAPH, how: 'rederive' }])
      expect(out.remaining).toEqual([])
      // Отказ не проглочен: человек читает и его, и то, почему он ничего не решил.
      expect(out.notes.join(' ')).toContain('по результату, а не по коду возврата')
      expect(out.notes.join(' ')).toContain('1 violation')
      expect(calls.some((c) => c[0] === 'add' && c.includes(GRAPH))).toBe(true)
    })

    it('без флага код возврата судит, как судил: отказ уводит файл человеку', () => {
      const { git } = fakeGit({ checkout: () => '' })
      const out = resolveMechanical({
        cwd: '/copy',
        execGit: git,
        files: [GRAPH],
        rules: { union: [], regenerate: [{ files: [GRAPH], command: ['node', 'rebuild.mjs'], strategy: 'rederive' }] },
        io: { readFileSync: () => '<p>всё равно что</p>', writeFileSync: () => {} },
        run: () => {
          throw new Error('rebuild refused')
        },
      })
      expect(out.resolved).toEqual([])
      expect(out.remaining).toEqual([GRAPH])
      expect(out.notes.join(' ')).toContain('пересобрать обе стороны не удалось')
    })

    it('походка rebuild с флагом: отказ пережит РОВНО тогда, когда маркеры ушли из файла', () => {
      const { git } = fakeGit()
      const rules = {
        union: [],
        regenerate: [{ files: ['docs/gen.md'], command: ['node', 'gen.mjs'], exitIsVerdict: true }],
      }
      const refused = () => {
        throw new Error('gen: 2 warning(s)')
      }
      const ok = resolveMechanical({
        cwd: '/copy',
        execGit: git,
        files: ['docs/gen.md'],
        rules,
        io: { readFileSync: () => 'пересобранное без маркеров', writeFileSync: () => {} },
        run: refused,
      })
      expect(ok.resolved).toEqual([{ file: 'docs/gen.md', how: 'regenerate' }])
      expect(ok.notes.join(' ')).toContain('по результату, а не по коду возврата')

      const kept = resolveMechanical({
        cwd: '/copy',
        execGit: git,
        files: ['docs/gen.md'],
        rules,
        io: { readFileSync: () => unionFile, writeFileSync: () => {} },
        run: refused,
      })
      expect(kept.resolved).toEqual([])
      expect(kept.remaining).toEqual(['docs/gen.md'])
      expect(kept.notes.join(' ')).toContain('маркеры конфликта остались')
    })

    it('флаг объявлен ровно у карты замера — индекс памяти судится кодом возврата', () => {
      const split = classifyConflicts([GRAPH, '.claude/memory/MEMORY.md'], MECHANICAL_DEFAULTS)
      expect(split.regenerate.find((r) => r.file === GRAPH)?.exitIsVerdict).toBe(true)
      expect(split.regenerate.find((r) => r.file === '.claude/memory/MEMORY.md')?.exitIsVerdict).toBe(false)
    })
  })
})

describe('syncWithTrunk — свести ветку с вершиной ДО сдачи', () => {
  it('сводить нечего → слияние не начинается вовсе (пустой коммит слияния не заводится)', async () => {
    const { git, calls } = fakeGit({ 'rev-list --count': '0\n' })
    const res = await syncWithTrunk({ cwd: '/copy', execGit: git })
    expect(res).toMatchObject({ ok: true, synced: false, alreadyCurrent: true, behind: 0 })
    expect(calls.some((c) => c[0] === 'merge')).toBe(false)
  })

  it('вершины в копии нет → честная причина, а не отказ работы', async () => {
    const { git } = fakeGit({ 'rev-parse -q --verify main': new Error('fatal: needed a single revision') })
    const res = await syncWithTrunk({ cwd: '/copy', execGit: git })
    expect(res).toMatchObject({ ok: true, synced: false, reason: 'no-trunk' })
  })

  it('чисто → слияние фиксируется коммитом, и вершина оказывается в родителях', async () => {
    const { git, calls } = fakeGit({
      'rev-list --count': '3\n',
      'rev-parse -q --verify MERGE_HEAD': 'abc123\n',
      'rev-parse HEAD': 'deadbeefdeadbeef\n',
    })
    const res = await syncWithTrunk({ cwd: '/copy', execGit: git })
    expect(res).toMatchObject({ ok: true, synced: true, behind: 3, mergeSha: 'deadbeefdeadbeef' })
    expect(calls.some((c) => c[0] === 'merge' && c.includes('--no-ff') && c.includes('--no-commit'))).toBe(true)
    expect(calls.some((c) => c[0] === 'commit')).toBe(true)
  })

  it('конфликт целиком механический → слияние доводится до конца без человека', async () => {
    const { git, calls } = fakeGit({
      'rev-list --count': '2\n',
      'merge --no-ff --no-commit': CONFLICT_ERROR,
      'diff --name-only': `README.md${NUL}`,
      'rev-parse -q --verify MERGE_HEAD': 'abc\n',
      'rev-parse HEAD': 'feed\n',
    })
    const res = await syncWithTrunk({
      cwd: '/copy',
      execGit: git,
      io: {
        readFileSync: () => ['<<<<<<< HEAD', 'моё', '||||||| base', '=======', 'чужое', '>>>>>>> main'].join('\n'),
        writeFileSync: () => {},
      },
    })
    expect(res.ok).toBe(true)
    expect(res.synced).toBe(true)
    expect(res.resolved).toEqual([{ file: 'README.md', how: 'union' }])
    expect(calls.some((c) => c[0] === 'merge' && c.includes('--abort'))).toBe(false)
  })

  // Развод с оговоркой и развод гладкий — РАЗНЫЕ события, и различие обязано пережить успех.
  // Раньше примечания жили только на пути отказа: сведение, прошедшее вопреки отказу команды
  // пересборки, выглядело точно так же, как прошедшее без единой заминки.
  it('оговорка механического развода доезжает и на УСПЕХЕ, а не только на отказе', async () => {
    const { git } = fakeGit({
      'rev-list --count': '2\n',
      'merge --no-ff --no-commit': CONFLICT_ERROR,
      'diff --name-only': `docs/master-graph.html${NUL}`,
      'rev-parse -q --verify MERGE_HEAD': 'abc\n',
      'rev-parse HEAD': 'feed\n',
    })
    const res = await syncWithTrunk({
      cwd: '/copy',
      execGit: git,
      io: { readFileSync: () => '<p>5913 tests</p>', writeFileSync: () => {} },
      run: () => {
        throw new Error('doc-audit: 1 violation(s).')
      },
    })
    expect(res.ok).toBe(true)
    expect(res.synced).toBe(true)
    expect(res.resolved).toEqual([{ file: 'docs/master-graph.html', how: 'rederive' }])
    expect((res.notes || []).join(' ')).toContain('по результату, а не по коду возврата')
  })

  it('осталось неразведённое → merge --abort и отказ С ИМЕНАМИ ФАЙЛОВ', async () => {
    const { git, calls } = fakeGit({
      'rev-list --count': '2\n',
      'merge --no-ff --no-commit': CONFLICT_ERROR,
      'diff --name-only': `daemon/src/loop.mjs${NUL}README.md${NUL}`,
    })
    const res = await syncWithTrunk({
      cwd: '/copy',
      execGit: git,
      io: {
        readFileSync: () => ['<<<<<<< HEAD', 'моё', '||||||| base', '=======', 'чужое', '>>>>>>> main'].join('\n'),
        writeFileSync: () => {},
      },
    })
    expect(res.ok).toBe(false)
    expect(res.conflict).toBe(true)
    expect(res.remaining).toEqual(['daemon/src/loop.mjs'])
    expect(res.detail).toContain('daemon/src/loop.mjs')
    expect(res.detail).toContain('конфликт в 1 файл(ах)')
    // README развёлся сам и в остатке его нет — но развод НАЗВАН, а не молчалив
    expect(res.resolved).toEqual([{ file: 'README.md', how: 'union' }])
    expect(calls.some((c) => c[0] === 'merge' && c.includes('--abort'))).toBe(true)
    expect(calls.some((c) => c[0] === 'commit')).toBe(false)
  })

  it('слияние сорвалось НЕ по конфликту → сказана первая строка от самого git', async () => {
    const { git } = fakeGit({
      'rev-list --count': '1\n',
      'merge --no-ff --no-commit': new Error('error: Your local changes would be overwritten\nвторая строка'),
      'diff --name-only': '',
    })
    const res = await syncWithTrunk({ cwd: '/copy', execGit: git })
    expect(res.ok).toBe(false)
    expect(res.conflict).toBe(false)
    expect(res.detail).toContain('local changes would be overwritten')
    expect(res.detail).not.toContain('вторая строка')
  })

  it('НИ ОДНОГО push ни на одном пути — вершина местная, как и весь ритуал', async () => {
    const { git, calls } = fakeGit({
      'rev-list --count': '2\n',
      'rev-parse -q --verify MERGE_HEAD': 'abc\n',
      'rev-parse HEAD': 'beef\n',
    })
    await syncWithTrunk({ cwd: '/copy', execGit: git })
    expect(calls.some((c) => c.join(' ').includes('push'))).toBe(false)
    expect(TRUNK_DEFAULT).toBe('main')
  })

  it('копии нет → честный отказ, а не бросок', async () => {
    const res = await syncWithTrunk({ cwd: '', execGit: () => '' })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('рабочей копии нет')
  })

  it('behindBy отвечает null, когда git не ответил — неизвестность не выдаётся за ноль', () => {
    const { git } = fakeGit({
      'rev-list --count': new Error('нет такой ветки'),
    })
    expect(behindBy({ cwd: '/copy', execGit: git })).toBeNull()
  })
})

/**
 * СПОР, ОСТАВЛЕННЫЙ В ДЕРЕВЕ, — и почему без него отказ был обязанностью без двери.
 *
 * «Разведите спор САМИ — вы знаете, что писали» верно по существу и невыполнимо на деле, если
 * разметку конфликта унёс откат, а `git merge` работнику отказан конвертом возможностей. Здесь
 * заперты обе половины лечения: спор остаётся размеченным ТОЛЬКО когда об этом попросили и
 * только когда он есть, и из оставленного состояния есть выход своим глаголом.
 */
describe('keepConflict — спор остаётся в дереве, и из него есть выход', () => {
  it('попросили оставить → НИ ОДНОГО merge --abort, и сказано, чем доводить', async () => {
    const { git, calls } = fakeGit({
      'rev-list --count': '2\n',
      'merge --no-ff --no-commit': CONFLICT_ERROR,
      'diff --name-only': `daemon/src/loop.mjs${NUL}README.md${NUL}`,
    })
    const res = await syncWithTrunk({
      cwd: '/copy',
      execGit: git,
      keepConflict: true,
      io: {
        readFileSync: () => ['<<<<<<< HEAD', 'моё', '||||||| base', '=======', 'чужое', '>>>>>>> main'].join('\n'),
        writeFileSync: () => {},
      },
    })
    expect(res.ok).toBe(false)
    expect(res.kept).toBe(true)
    expect(res.remaining).toEqual(['daemon/src/loop.mjs'])
    expect(res.detail).toContain('daemon/src/loop.mjs')
    // Механическая половина уже разведена и лежит в индексе — доводить остаётся только спорное.
    expect(res.resolved).toEqual([{ file: 'README.md', how: 'union' }])
    expect(calls.some((c) => c[0] === 'add' && c.includes('README.md'))).toBe(true)
    expect(calls.some((c) => c[0] === 'merge' && c.includes('--abort'))).toBe(false)
    // Коммит слияния НЕ ставится за сдающего: разведённое наполовину выглядело бы сведённым.
    expect(calls.some((c) => c[0] === 'commit')).toBe(false)
    expect(res.howToFinish).toContain('add')
    expect(res.howToFinish).toContain('commit')
    expect(res.howToFinish).toContain('sync-branch --abort')
  })

  it('сорвалось НЕ по конфликту → оставлять нечего, и откат делается даже с keepConflict', async () => {
    const { git, calls } = fakeGit({
      'rev-list --count': '1\n',
      'merge --no-ff --no-commit': new Error('error: Your local changes would be overwritten'),
      'diff --name-only': '',
    })
    const res = await syncWithTrunk({ cwd: '/copy', execGit: git, keepConflict: true })
    expect(res.ok).toBe(false)
    expect(res.kept).toBeUndefined()
    expect(calls.some((c) => c[0] === 'merge' && c.includes('--abort'))).toBe(true)
  })

  it('всё развелось механически → keepConflict ничего не меняет: слияние доводится до конца', async () => {
    const { git, calls } = fakeGit({
      'rev-list --count': '2\n',
      'merge --no-ff --no-commit': CONFLICT_ERROR,
      'diff --name-only': `README.md${NUL}`,
      'rev-parse -q --verify MERGE_HEAD': 'abc\n',
      'rev-parse HEAD': 'beef\n',
    })
    const res = await syncWithTrunk({
      cwd: '/copy',
      execGit: git,
      keepConflict: true,
      io: {
        readFileSync: () => ['<<<<<<< HEAD', 'моё', '||||||| base', '=======', 'чужое', '>>>>>>> main'].join('\n'),
        writeFileSync: () => {},
      },
    })
    expect(res.ok).toBe(true)
    expect(res.synced).toBe(true)
    expect(res.kept).toBeUndefined()
    expect(calls.some((c) => c[0] === 'commit')).toBe(true)
  })

  it('abortSync выходит из оставленного слияния', () => {
    const { git, calls } = fakeGit({ 'rev-parse -q --verify MERGE_HEAD': 'abc\n' })
    const res = abortSync({ cwd: '/copy', execGit: git })
    expect(res).toMatchObject({ ok: true, aborted: true })
    expect(calls.some((c) => c[0] === 'merge' && c.includes('--abort'))).toBe(true)
  })

  it('слияния в дереве нет → это ФАКТ о дереве, а не отказ, и merge не зовётся вовсе', () => {
    const { git, calls } = fakeGit({ 'rev-parse -q --verify MERGE_HEAD': new Error('нет такой ссылки') })
    const res = abortSync({ cwd: '/copy', execGit: git })
    expect(res).toMatchObject({ ok: true, aborted: false, reason: 'no-merge' })
    expect(calls.some((c) => c[0] === 'merge')).toBe(false)
  })

  it('сам откат отказал → названо вместе с командой выхода, а не проглочено', () => {
    const { git } = fakeGit({
      'rev-parse -q --verify MERGE_HEAD': 'abc\n',
      'merge --abort': new Error('fatal: There is no merge to abort\nвторая строка'),
    })
    const res = abortSync({ cwd: '/copy', execGit: git })
    expect(res.ok).toBe(false)
    expect(res.unfinishedMerge).toBe(true)
    expect(res.howToClear).toContain('merge --abort')
    expect(res.detail).not.toContain('вторая строка')
  })

  it('копии нет → честный отказ, а не бросок', () => {
    expect(abortSync({ cwd: '', execGit: () => '' })).toMatchObject({ ok: false, aborted: false })
    expect(unresolvedMergeHint('/copy')).toContain('/copy')
  })
})
