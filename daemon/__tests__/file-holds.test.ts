/**
 * Очередь не выдаёт разом две работы про один и тот же файл — и конфликт, если он всё-таки
 * случился, доезжает до человека ИМЕНАМИ ФАЙЛОВ.
 *
 * ЗАМЕР, РАДИ КОТОРОГО ЭТОТ ФАЙЛ СУЩЕСТВУЕТ (31.08.2026): за один вечер пять готовых работ из
 * шести не слились с первого раза. Причина всякий раз одна — очередь выдавала работы веером на
 * четыре места, все четыре отводились от ОДНОЙ вершины, и через двадцать минут той вершины уже
 * не существовало. Система сама создавала себе конфликт и сама же перекладывала его разбор на
 * человека, а приёмщик получал одну строку «слияние не прошло: Command failed» и КАЖДЫЙ РАЗ
 * выяснял состав конфликта руками.
 *
 * ЧТО ЗАПЕРТО ЗДЕСЬ:
 *   1. пути читаются из СОБСТВЕННЫХ СЛОВ задачи (заголовок, описание, признаки успеха), а
 *      объявленные явно — сильнее вычитанных;
 *   2. работа, не назвавшая ни одного файла, никого не придерживает и не придерживается сама:
 *      неизвестность — это «не пересекается», иначе первая же карточка без путей заморозила бы
 *      очередь;
 *   3. придерживает только ЖИВАЯ работа (`claimed`), а не строка, ждущая человека: приёмка
 *      может стоять часами, и остановленный на это время конвейер дороже болезни;
 *   4. справочный бэкенд держит обещание: пересекающаяся работа НЕ выдаётся, пока сосед в
 *      работе, и выдаётся сразу, как он закончил (последовательно, а не никогда);
 *   5. дверь приёмки называет ЧИСЛО и ИМЕНА файлов, а механически разведённое — отдельно.
 */

import { describe, it, expect } from 'vitest'

import { createMemoryQueue, declaredFiles, fileHeldOf } from '../src/queue/adapter.mjs'
import { mergeRefusal } from '../src/front/server.mjs'

/** Готовая к выдаче строка бэклога: без оценки и признаков успеха очередь её не принимает. */
const task = (id: string, extra: Record<string, any> = {}) => ({
  id,
  source: 'backlog' as const,
  title: `работа ${id}`,
  lane: 'prod' as const,
  storyPoints: 1,
  acceptance: 'работа сделана',
  ...extra,
})

describe('declaredFiles — что работа объявила своими словами', () => {
  it('читает пути из заголовка, описания и признаков успеха', () => {
    const files = declaredFiles({
      title: 'починить daemon/src/loop.mjs',
      description: 'конфликты садятся в оба README.md и README.ru.md',
      acceptance: ['числа в `docs/master-graph.html` пересобираются'],
    })
    expect(files).toContain('daemon/src/loop.mjs')
    expect(files).toContain('README.md')
    expect(files).toContain('README.ru.md')
    expect(files).toContain('docs/master-graph.html')
  })

  it('версии и даты путями не считаются', () => {
    expect(declaredFiles({ title: 'версия 5.7.1, замерено 31.08.2026', description: '' })).toEqual([])
  })

  it('объявленное явно сильнее вычитанного из текста', () => {
    const files = declaredFiles({
      title: 'трогает daemon/src/loop.mjs',
      files: ['spa/app.mjs'],
    })
    expect(files).toEqual(['spa/app.mjs'])
  })

  it('обрамление кавычками и обратными кавычками снимается', () => {
    expect(declaredFiles({ title: 'правит `daemon/src/loop.mjs`.' })).toEqual(['daemon/src/loop.mjs'])
  })
})

describe('fileHeldOf — чьи файлы уже заняты идущей работой', () => {
  const busy = { id: 'A', status: 'claimed', title: 'движок daemon/src/loop.mjs' }

  it('ожидающая работа про тот же файл придерживается', () => {
    const held = fileHeldOf([busy, { id: 'B', status: 'queued', title: 'тоже daemon/src/loop.mjs' }])
    expect(held).toEqual(['B'])
  })

  it('работа про другой файл не придерживается', () => {
    expect(fileHeldOf([busy, { id: 'B', status: 'queued', title: 'правит spa/app.mjs' }])).toEqual([])
  })

  it('работа, не назвавшая файлов, свободна — молчание безопасно', () => {
    expect(fileHeldOf([busy, { id: 'B', status: 'queued', title: 'разобраться с очередью' }])).toEqual([])
  })

  it('строка, ждущая ЧЕЛОВЕКА, очередь не останавливает', () => {
    const waiting = { id: 'A', status: 'awaiting_approval', title: 'движок daemon/src/loop.mjs' }
    expect(fileHeldOf([waiting, { id: 'B', status: 'queued', title: 'тоже daemon/src/loop.mjs' }])).toEqual([])
  })
})

describe('справочная очередь — пересекающиеся работы выдаются ПОСЛЕДОВАТЕЛЬНО', () => {
  it('вторая работа про тот же файл не выдаётся, пока первая идёт, и выдаётся после неё', async () => {
    const q = createMemoryQueue({})
    await q.enqueue(task('T-1', { title: 'движок: daemon/src/loop.mjs', priority: 2 }))
    await q.enqueue(task('T-2', { title: 'тоже движок: daemon/src/loop.mjs', priority: 1 }))

    const first = await q.claimNext('daemon', {})
    expect(first?.id).toBe('T-1')

    // Пока первая в работе, второй работы для неё нет — это НЕ «никогда», это «не сейчас».
    expect(await q.claimNext('daemon', {})).toBeNull()

    await q.complete('T-1', { receiptRef: 'r1', attemptToken: first?.attemptToken })
    const second = await q.claimNext('daemon', {})
    expect(second?.id).toBe('T-2')
  })

  it('непересекающаяся работа едет рядом, а не ждёт очереди', async () => {
    const q = createMemoryQueue({})
    await q.enqueue(task('T-1', { title: 'движок: daemon/src/loop.mjs', priority: 2 }))
    await q.enqueue(task('T-2', { title: 'экран: spa/app.mjs', priority: 1 }))

    expect((await q.claimNext('daemon', {}))?.id).toBe('T-1')
    expect((await q.claimNext('daemon', {}))?.id).toBe('T-2')
  })
})

describe('дверь приёмки — конфликт называется файлами и числом', () => {
  it('ритуал назвал файлы → человек читает их, а не «Command failed»', () => {
    const refusal = mergeRefusal({
      ok: false,
      conflict: true,
      conflictFiles: ['daemon/src/loop.mjs', 'docs/master-graph.html'],
      conflictCount: 2,
      message: 'конфликт в 2 файл(ах): … — Command failed: git merge',
    })
    expect(refusal.reasonCode).toBe('conflict')
    expect(refusal.reason).toContain('2 файл(ах)')
    expect(refusal.reason).toContain('daemon/src/loop.mjs')
    expect(refusal.reason).toContain('docs/master-graph.html')
  })

  it('механически разведённое названо отдельно — автоматический развод не бывает молчаливым', () => {
    const refusal = mergeRefusal({
      ok: false,
      conflict: true,
      conflictFiles: ['daemon/src/loop.mjs'],
      conflictCount: 1,
      conflictResolved: [{ file: 'README.md', how: 'union' }],
      message: 'что-то от git',
    })
    expect(refusal.reason).toContain('README.md')
    // …И НАЗВАНО ТЕМ, ЧТО ОНО ЕСТЬ. Отказавший ритуал откатывает слияние ЦЕЛИКОМ, вместе с уже
    // сделанным механическим разводом: «уже разведено» обещало человеку работу, которой в дереве
    // нет, и звало разводить руками файл, который разводится сам.
    expect(refusal.reason).toContain('разводится САМО')
    expect(refusal.reason).not.toContain('уже разведено')
  })

  it('почему механическое НЕ развелось — оговорки ритуала доезжают до нажимающего кнопку', () => {
    const refusal = mergeRefusal({
      ok: false,
      conflict: true,
      conflictFiles: ['docs/master-graph.html'],
      conflictCount: 1,
      conflictNotes: ['docs/master-graph.html: стороны пересобираются в РАЗНОЕ — спор не только в числах'],
      message: 'что-то от git',
    })
    expect(refusal.reason).toContain('почему не развелось')
    expect(refusal.reason).toContain('пересобираются в РАЗНОЕ')
  })

  it('общее дерево осталось в незавершённом слиянии → сказано на ЛЮБОМ классе отказа', () => {
    const conflict = mergeRefusal({
      ok: false,
      conflict: true,
      conflictFiles: ['daemon/src/loop.mjs'],
      conflictCount: 1,
      message: 'что-то от git',
      unfinishedMerge: true,
      howToClear: 'git -C /repo merge --abort',
    })
    expect(conflict.reasonCode).toBe('conflict')
    expect(conflict.reason).toContain('НЕЗАВЕРШЁННОМ СЛИЯНИИ')
    expect(conflict.reason).toContain('git -C /repo merge --abort')

    // Красный прогон и непригодная среда откатывают слияние ТЕМ ЖЕ вызовом — значит и провалиться
    // он может там же, и дерево там остаётся ровно таким же полусведённым.
    const red = mergeRefusal({
      merged: false,
      testsPassed: false,
      refused: true,
      unfinishedMerge: true,
      howToClear: 'git -C /repo merge --abort',
    })
    expect(red.reasonCode).toBe('tests_red')
    expect(red.reason).toContain('НЕЗАВЕРШЁННОМ СЛИЯНИИ')
  })

  it('дерево целое → о слиянии в нём ни слова: пугать нечем', () => {
    const refusal = mergeRefusal({ merged: false, testsPassed: false, refused: true })
    expect(refusal.reason).not.toContain('НЕЗАВЕРШЁННОМ')
  })

  it('старый ответ без списка по-прежнему узнаётся по прозе git', () => {
    const refusal = mergeRefusal({ ok: false, message: 'CONFLICT (content): Merge conflict in README.md' })
    expect(refusal.reasonCode).toBe('conflict')
  })
})
