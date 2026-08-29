import { useEffect, useMemo, useState } from 'react'
import { usePhaseIndexQuery, useStateQuery } from '../../api/queries'
import { TaskPanel } from '../../shell/TaskPanel'
import { useOpenedWith } from '../../shell/navigation'
import { useTellConsoleContext } from '../../shell/console-context'
import { clockLabel, plural } from '../../shell/format'
import { PhaseCardView } from './PhaseCardView'
import { usePhaseBells } from './phase-shared'
import { BatchView } from './BatchView'
import { NewBatchForm } from './NewBatchForm'
import { NewTaskForm } from './NewTaskForm'
import { UnitCard } from './UnitCard'
import { UnitRow } from './UnitRow'
import { WaitCard } from './WaitCard'
import { BOARD_COLUMNS, COLUMN_WORD, buildBoard, buildUnits, countColumns, splitByProject } from './units'
import type { BoardColumn, WorkUnit } from './units'

/**
 * «Задачи» — вся работа в один взгляд: столбики по стадиям, единица работы — карточка.
 *
 * ═════════ ЗАКОН «СПИСОК, А НЕ ДОСКА» — ПРОЖИЛ СВОЁ И СНЯТ ВЛАДЕЛЬЦЕМ 25.08.2026 ═════════
 *
 * ЧТО ЗДЕСЬ СТОЯЛО. «WHY A LIST AND NOT A BOARD»: доска, бывшая на этом месте до списка,
 * раскладывала задачи по пяти столбикам, отвечала на «в какой стадии эта задача» и отказывалась
 * отвечать на два вопроса, с которыми человек сюда приходит, — что стоит на МНЕ и из чего
 * работа СДЕЛАНА. Все единицы у той доски были одинаковыми плитками: столбик не мог сказать,
 * что фаза — это фаза, что у неё четыре стадии и три из них пройдены. Список это исправил —
 * строка несла вид единицы, её слово и точку, состав, ленту шагов, что дальше и сколько идёт, —
 * а всё, что ждало человека, поднималось из списка в полосу наверху.
 *
 * КЕМ И КОГДА СНЯТО. Владельцем, 25.08.2026, словом: он принял клик-макет со столбиками по
 * стадиям и подтвердил решение явно. Не «переспорили доводы» — решение принял тот, чьё это
 * окно и чья это работа.
 *
 * ПОЧЕМУ ЭТО НЕ ВОЗВРАТ К ПРЕЖНЕЙ ДОСКЕ. Столбиков на два больше, чем стадий у фазы, и эти два —
 * не стадии вовсе: «ЖДУТ ВАС» и «Готово». (Числом их здесь не называют: дорога фазы уже
 * выросла один раз, и всякая цифра в этом абзаце разошлась бы с доской молча.) Оба вопроса, которые прежняя доска не брала, теперь у столбиков есть чем
 * ответить: карточка несёт вид единицы, её слово, состав и ленту стадий — то самое, чего плитке
 * старой доски не хватало, — а всё, что стоит на человеке, стоит своим столбиком и своим
 * янтарным цветом. Полосу наверху он и заменил: две янтарные площадки об одном и том же учат
 * человека не читать ни одну.
 *
 * ЧТО ИЗ ПРЕЖНЕГО ЗАКОНА ЖИВО. Форма работы по-прежнему видна (лента стадий, состав, слово
 * состояния); то, что ждёт человека, по-прежнему нельзя искать прокруткой; и раскладка живёт
 * не в вёрстке, а в проекции (`units.ts`), где её проверяет прогон. История не стёрта: здесь
 * записано, что стояло, кто снял и почему, — чтобы следующий, кому покажется, что столбики
 * взялись из моды, прочитал, чем за них заплачено.
 *
 * ═════════════════════ NOTHING HERE IS DRAWN FROM NOTHING ═════════════════════
 *
 * Every figure and every sentence is a projection of a reading the window already holds — see
 * `units.ts`, which is where that translation lives and is the only place it lives. The kind
 * «БАТЧ» of the accepted design is absent for the plainest reason available: the engine has no
 * batches, and a kind painted out of whatever was nearest would read exactly like a measured
 * one.
 *
 * ═════════════════════ ОДНО ОКНО, КРОШКИ ═════════════════════
 *
 * Единица работы РАСКРЫВАЕТСЯ ЗДЕСЬ ЖЕ, а не увозит человека на соседний экран: фаза
 * открывается своей карточкой прямо в этом окне, задача — панелью поверх него. Поэтому путь
 * входа известен, и крошка «Задачи» ведёт назад ровно туда, откуда пришли.
 *
 * Прежде клик по фазе звал отдельный экран со списком всех фаз — и человек оказывался не в той
 * фазе, по которой кликнул, и без дороги назад к задачам. Это и есть «крошки ведут не туда,
 * откуда пришли», только в самой крупной своей форме.
 *
 * ═════════════════ ТОТ ЭКРАН СНЯТ, И КАРТОЧКА ФАЗЫ ЖИВЁТ ЗДЕСЬ ═════════════════
 *
 * Владелец снял его 28.08.2026 словами «у нас есть один бэклог, где вписаны задачи, фазы и
 * батчи; конвейер фаз меня очень путает» — вторая точка правды рядом с бэклогом. Ушёл ЭКРАН и
 * его строка в навигации; сама фаза никуда не делась: она стоит здесь в столбике своей стадии
 * и раскрывается карточкой, которая переехала в эту папку (`PhaseCardView`, `PhaseFolder`,
 * `ArtifactViewer`, `phase-shared`). Двери фаз не тронуты — карточка спрашивает у них ровно то
 * же, что спрашивала.
 */

/**
 * Цвет счётчика и заголовка столбика. Стадии движения — синие, потому что там работа идёт;
 * первая — серая, потому что там она ещё не пошла; «ЖДУТ ВАС» — янтарный, «Готово» — зелёный.
 */
const COLUMN_TONE: Record<BoardColumn, string> = {
  discuss: 'text-tx3',
  plan: 'text-blue',
  design: 'text-blue',
  execute: 'text-blue',
  verify: 'text-blue',
  you: 'text-warn-tx',
  done: 'text-ok-tx',
}

/**
 * СКОЛЬКО ЗАКРЫТЫХ КАРТОЧЕК ВИДНО в свёрнутом столбике «Готово».
 *
 * Столбик закрытого растёт без конца и вытолкнул бы работающие столбики вверх экрана, поэтому
 * он свёрнут в счётчик. Но свёрнутый наглухо, он читался бы как «там ничего не происходит»,
 * поэтому последние карточки остаются: видно, ЧЕМ именно закрылось. Порядок единиц ставит
 * «не получилось» впереди «готово» — значит неудача не прячется под счётчиком.
 */
const DONE_SHOWN = 2

function Counter({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={`text-[12px] font-semibold tabular-nums ${tone}`}>{n}</span>
      <span className="text-[11.5px] text-tx2">{label}</span>
    </span>
  )
}

export function Screen() {
  const state = useStateQuery()
  const phaseIndex = usePhaseIndexQuery()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  /** Открыта ли форма батча. Две формы одновременно — это два ответа на один вопрос. */
  const [batchOpen, setBatchOpen] = useState(false)
  const [machine, setMachine] = useState<string>('')
  /** Какая фаза раскрыта в этом же окне. `null` — на глазу список. */
  const [openPhase, setOpenPhase] = useState<string | null>(null)
  /** Какая сборка раскрыта в этом же окне — тем же способом и по той же причине. */
  const [openBatch, setOpenBatch] = useState<string | null>(null)
  /** Раскрыта ли группа строк с неизвестным проектом. Свёрнута — но её заголовок виден всегда. */
  const [unknownOpen, setUnknownOpen] = useState(false)

  /*
   * ЭКРАН, ОТКРЫТЫЙ СРАЗУ НА ФОРМЕ.
   *
   * Из палитры сюда приходят две просьбы: «новая задача» и «новый батч». Это просьба РАЗВЕРНУТЬ
   * форму — ту же, что за кнопкой в шапке, — а не поставить работу: форма спрашивает всё, что
   * спрашивала, и не отправляет ничего до своей кнопки. Открыт остаётся ровно один вид формы:
   * две сразу — это два ответа на один вопрос (то же правило, что у кнопок в шапке).
   *
   * Просьба живёт в объекте открытия, и каждое открытие — новый объект, поэтому вторая просьба
   * подряд разворачивает форму снова, даже если человек успел закрыть первую.
   */
  const openedWith = useOpenedWith()
  useEffect(() => {
    if (openedWith?.opens === 'new-task') {
      setNewOpen(true)
      setBatchOpen(false)
    }
    if (openedWith?.opens === 'new-batch') {
      setBatchOpen(true)
      setNewOpen(false)
    }
  }, [openedWith])

  // Карточка фазы живёт теперь и здесь, значит и два звонка фазового цикла нужны здесь: без
  // них раскрытая фаза осталась бы такой, какой её открыли, пока человек не ушёл и не вернулся.
  usePhaseBells()

  const data = state.data
  const activeProject = data?.activeProject ?? null
  const machines = data?.machines ?? []
  const showMachine = machines.length > 1
  const selfMachine = machines.find((m) => m.role === 'self')?.id ?? ''

  const units = useMemo(
    () =>
      buildUnits({
        queue: data?.queue ?? [],
        awaiting: data?.awaiting ?? [],
        workers: data?.workers ?? [],
        done: data?.done ?? [],
        // Сборки приезжают тем же одним чтением состояния, что и всё остальное: третий вид
        // списка — проекция ряда движка, а не второй вопрос к нему.
        batches: data?.batches ?? [],
        phases: phaseIndex.data?.phases ?? [],
        activeProject,
        machine,
        selfMachine,
        clock: clockLabel,
        // Часы читаются ЗДЕСЬ, на каждом пересчёте проекции, а не внутри неё: опрос состояния
        // приносит новый признак жизни у каждой бегущей строки, поэтому пересчёт случается
        // ровно тогда, когда есть что пересчитывать. Проекция при этом остаётся сравнимой.
        now: Date.now(),
      }),
    [data, phaseIndex.data, activeProject, machine, selfMachine],
  )

  // Шесть столбиков и шесть чисел над ними — из ОДНОЙ раскладки: счётчик, посчитанный
  // отдельно от того, что лежит в столбике, однажды разойдётся с ним, и человек прочитает
  // расхождение как ошибку экрана.
  const board = useMemo(() => buildBoard(units), [units])
  const counts = useMemo(() => countColumns(units), [units])

  /**
   * РАБОТА, ЧЕЙ ПРОЕКТ НЕИЗВЕСТЕН — та же проекция, отдельной группой.
   *
   * Эти строки поставлены раньше, чем задача научилась знать свой проект. Доска выше их не
   * показывает — она о выбранном проекте, — а выбросить их совсем нельзя: работа, которую прячет
   * каждый фильтр, невидима, и человек не может ни решить её, ни даже узнать, что она есть.
   *
   * Строится тем же `buildUnits` и рисуется теми же строками — чтобы группа не стала вторым
   * способом показать задачу, который однажды разойдётся с первым. Сужение по проекту внутри
   * выключено (`activeProject: null`): строки уже отобраны, а сито отбросило бы их снова.
   * Фазы сюда не идут: фаза свой проект называет всегда.
   */
  const unknownUnits = useMemo(() => {
    if (!activeProject) return []
    const unknownOf = <T extends { project?: string | null }>(rows: T[]): T[] =>
      splitByProject(rows, activeProject).unknown
    return buildUnits({
      queue: unknownOf(data?.queue ?? []),
      awaiting: unknownOf(data?.awaiting ?? []),
      workers: unknownOf(data?.workers ?? []),
      done: unknownOf(data?.done ?? []),
      batches: unknownOf(data?.batches ?? []),
      phases: [],
      activeProject: null,
      machine,
      selfMachine,
      clock: clockLabel,
      now: Date.now(),
    })
  }, [data, activeProject, machine, selfMachine])

  /**
   * ОТВЕТИЛО ЛИ ЧТЕНИЕ СОСТОЯНИЯ ХОТЬ РАЗ — и до этого мгновения экран не утверждает о работе
   * НИЧЕГО.
   *
   * Пустой список у окна, которое ещё не спросило, и пустой список у окна, которому ответили
   * «пусто», выглядели одинаково: «Задач нет. Поставьте задачу.» — приговор, вынесенный до
   * первого ответа двери. Живая очередь при этом стояла рядом, и человек читал про свою работу
   * заявление, которого никто не измерял. Это тот же класс, что «нарисованное число», только в
   * словах: оценка выдана за факт.
   *
   * `data === undefined` — это ровно «ответа ещё не было» у этого чтения (первый ответ данные
   * уже не отпускает, поэтому мигания между опросами здесь быть не может). Пока его нет, экран
   * говорит, что он читает; счётчики тоже молчат — ноль в них был бы измерением, которого не
   * делали.
   *
   * СПРОШЕНО ДВОЕ, И ЖДУТ ОБОИХ: список — проекция ДВУХ чтений, состояния и указателя фаз, и
   * «задач нет», сказанное до ответа второго, — та же преждевременная оценка. Отказ двери фаз
   * ожиданием не считается: у него свой ответ внизу экрана, и держать из-за него весь список в
   * «читаю» значило бы не показать задачи, которые уже прочитаны.
   */
  const answered = data !== undefined && (phaseIndex.data !== undefined || phaseIndex.isError)

  /** The roster in one sentence — who is on the work right now. */
  const workerLine = useMemo(() => {
    const rows = data?.workers ?? []
    if (rows.length === 0) return 'Работников нет'
    if (rows.length === 1) return `Работник: ${rows[0].id} · ${rows[0].presence}`
    const busy = rows.filter((w) => !!w.taskId).length
    return `Работников: ${rows.length} · занято ${busy}`
  }, [data])

  // ЧТО ОТКРЫТО — рассказано оболочке. Список и раскрытая фаза — это ОДИН экран, и снаружи
  // их не различить: без этого рассказа окно разговора говорило бы «Задачи», пока человек
  // читает стадию фазы, и отвечало бы не про то, на что он смотрит.
  useTellConsoleContext(
    openPhase !== null
      ? {
          kind: 'phase',
          line: `фаза ${(phaseIndex.data?.phases ?? []).find((p) => p.id === openPhase)?.name ?? openPhase}`,
          phase: openPhase,
        }
      : openBatch !== null
        ? {
            kind: 'screen',
            line: `батч «${(data?.batches ?? []).find((b) => b.id === openBatch)?.title ?? openBatch}»`,
          }
        : {
            kind: 'list',
            line: `Задачи · ${units.length} ${plural(units.length, 'единица', 'единицы', 'единиц')} работы`,
          },
  )

  const openUnit = (unit: WorkUnit) => {
    if (unit.target.screen === 'phase') setOpenPhase(unit.target.id)
    else if (unit.target.screen === 'batch') setOpenBatch(unit.target.id)
    else setSelectedId(unit.target.id)
  }

  // Фаза раскрыта — это тот же экран, просто вглубь. Крошка «Задачи» и кнопка возврата ведут
  // сюда же, в список: человек пришёл отсюда, и другой дороги к фазе в окне больше нет.
  if (openPhase !== null) {
    return (
      <PhaseCardView
        id={openPhase}
        onBack={() => setOpenPhase(null)}
        backLabel="← К задачам"
        trail={[{ label: 'Задачи', onClick: () => setOpenPhase(null) }]}
      />
    )
  }

  // Сборка раскрывается здесь же и той же дорогой, что фаза: вход в элемент запомнится, потому
  // что элемент открывается ПОВЕРХ развилки, а не вместо неё.
  if (openBatch !== null) {
    return (
      <BatchView
        id={openBatch}
        onBack={() => setOpenBatch(null)}
        backLabel="← К задачам"
        trail={[{ label: 'Задачи', onClick: () => setOpenBatch(null) }]}
      />
    )
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-3 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">Задачи</h1>
        <span className="flex-1" />
        <span className="flex-none text-[11.5px] text-tx2">{workerLine}</span>

        {showMachine ? (
          <select
            value={machine}
            onChange={(e) => setMachine(e.target.value)}
            aria-label="Машина"
            className="flex-none rounded-[9px] border border-bd bg-card px-2.5 py-1.5 text-[12px] text-tx2 outline-none"
          >
            <option value="">Все машины</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
        ) : null}

        {/*
          Второе действие рядом с первым, а не вместо него: инлайн и батч — РАЗНЫЕ виды работы
          с разными правилами (одна задача против фразы, разложенной на элементы), и общая
          форма с переключателем спрашивала бы половину полей впустую в каждом из двух случаев.
        */}
        <div className="relative flex-none">
          <button
            type="button"
            onClick={() => {
              setBatchOpen((v) => !v)
              setNewOpen(false)
            }}
            aria-expanded={batchOpen}
            className="rounded-[9px] border border-bd2 px-[13px] py-2 text-[12px] font-semibold text-tx2 hover:text-tx"
          >
            + Батч
          </button>
          {batchOpen ? (
            <NewBatchForm
              onClose={() => setBatchOpen(false)}
              onCreated={(id) => {
                // Сразу в развилку заведённой сборки: человек только что описал работу, и
                // список верхнего уровня ответил бы ему одной строкой о ней вместо состава.
                setBatchOpen(false)
                setOpenBatch(id)
              }}
            />
          ) : null}
        </div>

        <div className="relative flex-none">
          <button
            type="button"
            onClick={() => {
              setNewOpen((v) => !v)
              setBatchOpen(false)
            }}
            aria-expanded={newOpen}
            className="rounded-[9px] bg-blue px-[15px] py-2 text-[12px] font-semibold text-white hover:bg-blue-d"
          >
            + Новая задача
          </button>
          {newOpen ? <NewTaskForm onClose={() => setNewOpen(false)} /> : null}
        </div>
      </header>

      {state.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">
            Связь потеряна. Список не обновляется, показано последнее, что было видно.
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-7 py-5">
        <div className="mb-2.5 flex items-baseline gap-3">
          <span className="text-[13px] font-semibold text-tx">Задачи · верхний уровень · по стадиям</span>
          {/* Счётчики — ПО СТОЛБИКАМ, и все шесть стоят всегда, включая нулевые: число здесь
              измерено (столбик пуст), а не выдумано, и исчезающий счётчик двигал бы соседей. */}
          {answered ? (
            <div className="flex gap-3">
              {BOARD_COLUMNS.map((key) => (
                <Counter key={key} n={counts[key]} label={COLUMN_WORD[key].toLowerCase()} tone={COLUMN_TONE[key]} />
              ))}
            </div>
          ) : (
            <span className="text-[11.5px] text-tx3">считаю…</span>
          )}
        </div>

        {units.length === 0 && !answered ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-[10px] border border-bd bg-card py-16">
            <p className="m-0 text-[13px] text-tx2">
              {state.isError ? 'Список не прочитан — дверь состояния не ответила.' : 'Читаю список задач…'}
            </p>
            <p className="m-0 text-[11.5px] text-tx3">
              Пусто здесь или нет — пока неизвестно: об этом скажет первый ответ.
            </p>
          </div>
        ) : units.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 rounded-[10px] border border-bd bg-card py-16">
            {/* «Задач нет» говорится, только когда их и правда нет НИГДЕ. Строки с неизвестным
                проектом стоят ниже своей группой, и приговор «пусто» над ними был бы неправдой. */}
            <p className="m-0 text-[13px] text-tx2">
              {unknownUnits.length > 0
                ? 'В этом проекте задач нет. Ниже — работа, чей проект неизвестен.'
                : 'Задач нет. Поставьте задачу.'}
            </p>
            <button
              type="button"
              onClick={() => setNewOpen(true)}
              className="rounded-[9px] bg-blue px-[15px] py-2 text-[12px] font-semibold text-white hover:bg-blue-d"
            >
              + Новая задача
            </button>
          </div>
        ) : (
          /*
            ШЕСТЬ СТОЛБИКОВ — И НИ ОДНОГО РЕШЕНИЯ, ПРИНЯТОГО ЗДЕСЬ.
            Что в каком столбике лежит, решает проекция (`buildBoard`), и её проверяет прогон;
            разметка эти столбики только рисует. Раскладка, живущая в вёрстке, проверяется
            глазом — и ровно поэтому расходится с правдой молча.
          */
          <div className="flex items-start gap-3">
            {board.map((col) => (
              <div key={col.key} className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex items-baseline gap-1.5 px-0.5">
                  <span className="text-[10px] font-semibold tracking-[0.05em] text-tx2 uppercase">{col.title}</span>
                  <span className={`text-[11px] font-semibold tabular-nums ${COLUMN_TONE[col.key]}`}>
                    {col.units.length}
                  </span>
                </div>

                {col.key === 'you'
                  ? col.units.map((unit) => (
                      <WaitCard key={`${unit.kind}:${unit.id}`} unit={unit} onOpen={openUnit} />
                    ))
                  : (col.key === 'done' ? col.units.slice(0, DONE_SHOWN) : col.units).map((unit) => (
                      <UnitCard key={`${unit.kind}:${unit.id}`} unit={unit} onOpen={openUnit} />
                    ))}

                {col.key === 'done' && col.units.length > DONE_SHOWN ? (
                  <span className="px-0.5 text-[10.5px] text-tx3">
                    ещё {col.units.length - DONE_SHOWN} — свёрнуты
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {/*
          ГРУППА «ПРОЕКТ НЕИЗВЕСТЕН» — словами, не подстановкой.
          Заголовок с числом виден всегда, когда такие строки есть; сами строки свёрнуты, потому
          что это работа не того проекта, на который человек смотрит, — но и не чужая.
        */}
        {unknownUnits.length > 0 ? (
          <div className="mt-4 overflow-hidden rounded-[10px] border border-bd bg-card">
            <button
              type="button"
              onClick={() => setUnknownOpen((v) => !v)}
              aria-expanded={unknownOpen}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-row-hover"
            >
              <span aria-hidden className="flex-none text-[11px] text-tx3">
                {unknownOpen ? '▾' : '▸'}
              </span>
              <span className="text-[13px] font-semibold text-tx">
                Проект неизвестен — {unknownUnits.length}
              </span>
              <span className="flex-1" />
              <span className="text-[11.5px] text-tx3">
                {unknownOpen ? 'свернуть' : 'показать'}
              </span>
            </button>
            {unknownOpen ? (
              <>
                <p className="m-0 border-t border-bd px-4 py-2.5 text-[11.5px] leading-[1.5] text-tx3">
                  Эти строки поставлены раньше, чем задача стала знать свой проект. Приписать их
                  тому, что открыт сейчас, значило бы выдумать принадлежность; спрятать — сделать
                  работу невидимой. Поэтому они здесь, со своей правдой: проект неизвестен.
                </p>
                {unknownUnits.map((unit, i) => (
                  <UnitRow key={`unknown:${unit.kind}:${unit.id}`} unit={unit} first={i === 0} onOpen={openUnit} />
                ))}
              </>
            ) : null}
          </div>
        ) : null}

        {phaseIndex.isError ? (
          <p className="mt-3 text-[11.5px] text-tx3">
            Фазы не прочитались — в списке только задачи. Дверь, которая их приносит, ответила
            ошибкой.
          </p>
        ) : null}
      </div>

      {selectedId ? <TaskPanel taskId={selectedId} onClose={() => setSelectedId(null)} /> : null}
    </section>
  )
}
