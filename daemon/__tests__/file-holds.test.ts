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
 *   5. дверь приёмки называет ЧИСЛО и ИМЕНА файлов, а механически разведённое — отдельно;
 *   6. ШТАМПЫ НЕ ДЕРЖАТ: файл, спор о котором развод снимает механически (оба README, карта
 *      графа, квитанция прогона, индекс памяти), объявленным не считается — иначе закон дома
 *      «README×2 в том же изменении» заставляет каждую карточку пересечься с каждой, и очередь
 *      выстраивает весь флот в одну линию (замерено 02.09.2026: одиннадцать строк, свободный
 *      работник, ни одного захвата);
 *   7. само удержание не бывает МОЛЧАЛИВЫМ: придержанная строка называет занятый файл и
 *      работу, которая его держит, — иначе свободные работники и стоящая задача читаются как
 *      поломка, и человек идёт искать её там, где её нет.
 */

import { describe, it, expect } from 'vitest'

import { createMemoryQueue, declaredFiles, fileHeldOf, fileHoldsOf } from '../src/queue/adapter.mjs'
import { MECHANICAL_DEFAULTS, mechanicalPaths } from '../../scripts/sma/lib/branch-sync.mjs'
import { mergeRefusal } from '../src/front/server.mjs'
import { buildUnits } from '../../spa/src/screens/tasks/units'
import type { QueueRow } from '../../spa/src/api/types'

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
      description: 'заодно экран spa/app.mjs',
      acceptance: ['разбор в `scripts/sma/lib/branch-sync.mjs` не меняется'],
    })
    expect(files).toContain('daemon/src/loop.mjs')
    expect(files).toContain('spa/app.mjs')
    expect(files).toContain('scripts/sma/lib/branch-sync.mjs')
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

  // ШТАМПЫ ОБЪЯВЛЕННЫМИ НЕ СЧИТАЮТСЯ. Закон дома велит каждой карточке, меняющей продукт,
  // назвать оба README, — по ним пересекаются ВСЕ работы со всеми, и очередь, честно исполняя
  // правило, выстраивала флот в одну линию. Разводит эти файлы машина, а не человек.
  it('оба README, квитанция прогона и карта графа объявленными не считаются', () => {
    const files = declaredFiles({
      title: 'починить daemon/src/loop.mjs',
      description: 'обновить README.md и README.ru.md',
      acceptance: ['`test-receipt.json` свежий', 'числа в `docs/master-graph.html` пересобраны'],
    })
    expect(files).toEqual(['daemon/src/loop.mjs'])
  })

  it('штамп не спасает и явное объявление: правило одно для обоих путей чтения', () => {
    expect(declaredFiles({ title: 'что угодно', files: ['README.md', 'daemon/src/loop.mjs'] })).toEqual([
      'daemon/src/loop.mjs',
    ])
  })

  // ОДИН ИСТОЧНИК, А НЕ КОПИЯ: очередь спрашивает о механическом ту самую сторону, которая его
  // и разводит на приёмке. Пополнят список правил — очередь узнает об этом тем же днём.
  it('механический набор берётся у развода слияния — весь, каким бы он ни стал', () => {
    for (const pattern of mechanicalPaths(MECHANICAL_DEFAULTS)) {
      const path = pattern.replace(/\*/g, 'x')
      expect(declaredFiles({ title: `работа про ${path} и daemon/src/loop.mjs` })).toEqual(['daemon/src/loop.mjs'])
    }
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

describe('fileHoldsOf — удержание вместе с причиной, а не молча', () => {
  const busy = { id: 'A', status: 'claimed', title: 'движок daemon/src/loop.mjs' }

  it('названы и занятый файл, и работа, которая его держит', () => {
    const holds = fileHoldsOf([busy, { id: 'B', status: 'queued', title: 'тоже daemon/src/loop.mjs' }])
    expect(holds).toEqual([
      { id: 'B', files: ['daemon/src/loop.mjs'], holders: [{ id: 'A', title: 'движок daemon/src/loop.mjs' }] },
    ])
  })

  // Свои файлы, которых никто не занял, к остановке отношения не имеют: лишний путь в причине
  // отправляет человека разбираться не туда.
  it('в причине только ПЕРЕСЁКШИЕСЯ пути, а не все объявленные', () => {
    const holds = fileHoldsOf([busy, { id: 'B', status: 'queued', title: 'daemon/src/loop.mjs и spa/app.mjs' }])
    expect(holds[0].files).toEqual(['daemon/src/loop.mjs'])
  })

  it('держатели не повторяются: одна работа, занявшая два файла, названа один раз', () => {
    const two = { id: 'A', status: 'claimed', title: 'daemon/src/loop.mjs и spa/app.mjs' }
    const holds = fileHoldsOf([two, { id: 'B', status: 'queued', title: 'дописать в daemon/src/loop.mjs и spa/app.mjs' }])
    expect(holds[0].files).toEqual(['daemon/src/loop.mjs', 'spa/app.mjs'])
    expect(holds[0].holders).toEqual([{ id: 'A', title: 'daemon/src/loop.mjs и spa/app.mjs' }])
  })

  // ПРОВОД: штамп, названный обеими работами, никого не держит, а настоящий файл — держит.
  // Обе половины в одном случае намеренно: правило, снявшее удержание вместе с полезным, было
  // бы не починкой, а отключением.
  it('две работы про оба README и квитанцию друг друга не держат — а про движок держат', () => {
    const stamps = 'README.md, README.ru.md и test-receipt.json'
    const rows = [
      { id: 'A', status: 'claimed', title: `первая: ${stamps}, а также daemon/src/loop.mjs` },
      { id: 'B', status: 'queued', title: `вторая: ${stamps}` },
      { id: 'C', status: 'queued', title: `третья: ${stamps} и daemon/src/loop.mjs` },
    ]
    const holds = fileHoldsOf(rows)
    expect(holds.map((h) => h.id)).toEqual(['C'])
    expect(holds[0].files).toEqual(['daemon/src/loop.mjs'])
  })

  // ВОЗВРАЩЁННАЯ РАБОТА ВСТАЁТ В ОЧЕРЕДЬ ПОД СВОИМ ЖЕ НОМЕРОМ, и долговечный бэкенд хранит
  // рядом строку, на которой она остановилась. Придержать её собственной прежней попыткой —
  // значит придержать навсегда: освободить файл могла только она.
  it('сама себя работа не держит, даже когда её прежняя попытка ещё числится идущей', () => {
    const stale = { id: 'B', status: 'claimed', title: 'та же работа: daemon/src/loop.mjs' }
    const again = { id: 'B', status: 'queued', title: 'та же работа: daemon/src/loop.mjs' }
    expect(fileHoldsOf([stale, again])).toEqual([])
  })

  it('…но настоящего держателя своя прежняя попытка не заслоняет', () => {
    const stale = { id: 'B', status: 'claimed', title: 'та же работа: daemon/src/loop.mjs' }
    const other = { id: 'A', status: 'claimed', title: 'движок daemon/src/loop.mjs' }
    const again = { id: 'B', status: 'queued', title: 'та же работа: daemon/src/loop.mjs' }
    const holds = fileHoldsOf([stale, other, again])
    expect(holds).toHaveLength(1)
    expect(holds[0].holders).toEqual([{ id: 'A', title: 'движок daemon/src/loop.mjs' }])
  })

  // Одна функция держит и одна называет причину: два выражения одного правила разошлись бы в
  // первый же день, и человек читал бы объяснение удержания, которого нет.
  it('список придержанных — тот же самый, что читает очередь', () => {
    const rows = [busy, { id: 'B', status: 'queued', title: 'тоже daemon/src/loop.mjs' }, { id: 'C', status: 'queued', title: 'spa/app.mjs' }]
    expect(fileHeldOf(rows)).toEqual(fileHoldsOf(rows).map((h) => h.id))
    expect(fileHeldOf(rows)).toEqual(['B'])
  })
})

describe('экран задач — придержанная строка объясняется предложением, а не молчанием', () => {
  const row = (over: Partial<QueueRow> = {}): QueueRow =>
    ({
      id: 'r-wait',
      title: 'Задача',
      lane: null,
      project: 'sma',
      machine: 'm1',
      priority: 0,
      status: 'queued',
      position: 3,
      ...over,
    }) as QueueRow

  const sentenceOf = (queue: QueueRow[]) => {
    const units = buildUnits({
      queue,
      awaiting: [],
      workers: [],
      done: [],
      batches: [],
      phases: [],
      activeProject: 'sma',
      machine: '',
      selfMachine: 'm1',
      clock: () => '12:00',
      now: 1_000_000,
    })
    expect(units).toHaveLength(1)
    return units[0].next
  }

  it('названы файл и держатель — человек читает, почему стоит и когда пойдёт', () => {
    const said = sentenceOf([
      row({
        idleReason: 'files_busy',
        heldBy: { files: ['daemon/src/loop.mjs'], holders: [{ id: 'r-busy', title: 'движок под замену' }] },
      }),
    ])
    expect(said).toContain('daemon/src/loop.mjs')
    expect(said).toContain('движок под замену')
  })

  it('состав удержания без общей причины не подменяет её: выключенный конвейер говорит за всю очередь', () => {
    const said = sentenceOf([
      row({
        idleReason: 'pipeline_off',
        heldBy: { files: ['daemon/src/loop.mjs'], holders: [{ id: 'r-busy', title: 'движок под замену' }] },
      }),
    ])
    expect(said).toContain('Конвейер выключен')
    expect(said).not.toContain('daemon/src/loop.mjs')
  })

  // Код причины старее поля состава (строка, пришедшая из демона до этой работы) обязан
  // оставаться предложением: пустое место читается как «причины нет».
  it('код причины без состава по-прежнему говорит словами', () => {
    expect(sentenceOf([row({ idleReason: 'files_busy' })])).toContain('файлы заняты')
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
