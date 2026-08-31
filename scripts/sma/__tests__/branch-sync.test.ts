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
 *   8. НИ ОДНОГО `push` ни на одном пути — тот же закон, что у ритуала слияния.
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
  matchesPattern,
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
