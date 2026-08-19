import { useMemo } from 'react'

import { usePhaseIndexQuery, useStateQuery } from '../../api/queries'
import { buildUnits, waitWords, STATE_WORD } from '../../screens/tasks/units'
import type { WorkUnit } from '../../screens/tasks/units'
import { clockLabel, plural } from '../format'

/**
 * NarrowTasks — работа на условиях телефона: полоса «ждут вас» и список задач.
 *
 * ═══════════════════ ОДНО ЧТЕНИЕ НА ВСЁ ОКНО, И ЗДЕСЬ ТОЖЕ ═══════════════════
 *
 * Ни одного своего вопроса к дверям: те же два чтения, из которых живёт экран задач стола
 * (картина состояния и указатель фаз), и та же проекция `buildUnits`. Свой запрос сделал бы
 * из телефона вторую версию правды, и первый же день их расхождения был бы днём, когда список
 * перестают читать.
 *
 * ═══════════════════ ЧЕГО ЗДЕСЬ НЕТ — СКАЗАНО СЛОВАМИ ═══════════════════
 *
 * Фазы и сборки строками не показываются: у фазы четыре стадии и вопросы, у сборки — состав
 * из кусков, и то и другое на 375 px превращается в кашу, из которой ничего не решить. Но
 * молча их спрятать нельзя — работа, которую прячет экран, невидима, и человек не узнает даже,
 * что она есть. Поэтому вместо строк — одна приглушённая строка с их числом и честным «это на
 * компьютере».
 *
 * По той же причине вопросы фаз в полосе «ждут вас» НЕ нажимаются: ответ на вопрос стадии —
 * это разговор с текстом и вариантами, и открывать его в 375 px, чтобы человек упёрся в
 * нечитаемое, хуже, чем честно назвать их число.
 *
 * ═══════════════════ ПОКА ЧТЕНИЕ НЕ ОТВЕТИЛО — «ЧИТАЮ», А НЕ «ПУСТО» ═══════════════════
 *
 * То же правило, что на экране стола, и по той же причине: пустой список у окна, которое ещё
 * не спросило, и пустой список у окна, которому ответили «пусто», выглядят одинаково, а
 * говорят противоположное. Приговор «задач нет», вынесенный до первого ответа двери, — это
 * оценка, выданная за факт.
 */

/**
 * «идёт 2 ч 10 м» / «ждёт 41 мин» — возраст строки словами.
 *
 * Три разных вопроса о времени не подменяются один другим: у бегущей строки меряется, сколько
 * ИДЁТ (проекция уже посчитала), у стоящей — сколько ЖДЁТ (очередь кладёт возраст только тому,
 * кто ждёт дольше терпения). Где не измерено ни то, ни другое, строка говорит, ЧТО она такое, —
 * и никогда не показывает ноль: ноль человек читает как «только что», то есть как измерение.
 */
function ageLine(unit: WorkUnit, agedFor: Map<string, number | undefined>): string {
  if (unit.dur !== '—') return `идёт ${unit.dur}`
  const waited = waitWords(agedFor.get(unit.id))
  return waited ? `ждёт ${waited}` : unit.inner
}

export function NarrowTasks({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const state = useStateQuery()
  const phaseIndex = usePhaseIndexQuery()

  const data = state.data
  const activeProject = data?.activeProject ?? null

  /**
   * То же правило ответа, что на экране стола: спрошено двое, и ждут обоих. Отказ двери фаз
   * ожиданием не считается — у него свой ответ, и держать из-за него весь список в «читаю»
   * значило бы не показать задачи, которые уже прочитаны.
   */
  const answered = data !== undefined && (phaseIndex.data !== undefined || phaseIndex.isError)

  const units = useMemo(
    () =>
      buildUnits({
        queue: data?.queue ?? [],
        awaiting: data?.awaiting ?? [],
        workers: data?.workers ?? [],
        done: data?.done ?? [],
        batches: data?.batches ?? [],
        phases: phaseIndex.data?.phases ?? [],
        activeProject,
        // Сита по машине на телефоне нет: выбирать машину — работа стола, и выпадающий список
        // на 375 px отнял бы место у того единственного, ради чего сюда пришли.
        machine: '',
        selfMachine: '',
        clock: clockLabel,
        now: Date.now(),
      }),
    [data, phaseIndex.data, activeProject],
  )

  /** Задачи — строками. Фазы и сборки — числом ниже: см. заголовок файла. */
  const taskUnits = units.filter((u) => u.kind === 'inline')
  const asideCount = units.length - taskUnits.length

  /** Возраст ожидания — из того же чтения, тем же полем, которым его читает стол. */
  const agedFor = useMemo(() => {
    const map = new Map<string, number | undefined>()
    for (const row of [...(data?.awaiting ?? []), ...(data?.queue ?? [])]) map.set(row.id, row.agedForHours)
    return map
  }, [data])

  /** Полоса «ждут вас»: те же ждущие строки, что у стола, дольше всех ждущее — первым. */
  const waiting = useMemo(
    () =>
      (data?.awaiting ?? [])
        .filter((r) => !activeProject || r.project === activeProject)
        .slice()
        .sort((a, b) => (b.agedForHours ?? 0) - (a.agedForHours ?? 0)),
    [data, activeProject],
  )

  const oldestWords = useMemo(() => {
    const oldest = waiting.reduce<number | undefined>(
      (max, r) => (r.agedForHours != null && (max == null || r.agedForHours > max) ? r.agedForHours : max),
      undefined,
    )
    return waitWords(oldest)
  }, [waiting])

  /** Вопросы фаз — числом, не строками: отвечать на них с телефона нечем (см. заголовок). */
  const phaseQuestions = (phaseIndex.data?.phases ?? []).reduce((sum, p) => sum + (p.open > 0 ? p.open : 0), 0)

  return (
    <section className="flex flex-col gap-4 px-4 py-4">
      {state.isError ? (
        <p className="m-0 rounded-[10px] border border-warn-s bg-warn-s px-3.5 py-2.5 text-[13px] leading-[1.5] text-tx">
          Связь потеряна. Показано последнее, что было видно, — список не обновляется.
        </p>
      ) : null}

      {!answered ? (
        <p className="m-0 rounded-[10px] border border-bd bg-card px-3.5 py-4 text-[13px] leading-[1.5] text-tx2">
          Читаю список задач… Пусто здесь или нет — пока неизвестно: об этом скажет первый ответ.
        </p>
      ) : null}

      {answered && waiting.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-semibold text-warn-tx">
            Ждут вас: {waiting.length} ·{' '}
            {oldestWords ? `дольше всех — ${oldestWords}` : 'сколько ждут — нет данных'}
          </span>
          <div className="flex flex-col gap-2">
            {waiting.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => onOpenTask(row.id)}
                className="flex min-h-[44px] w-full flex-col gap-1 rounded-[10px] border border-warn/40 bg-warn-s px-3.5 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-blue"
              >
                <span className="text-[14px] leading-[1.35] font-semibold text-tx">
                  {row.title ?? 'Без названия'}
                </span>
                <span className="text-[13px] leading-[1.4] text-warn-tx">
                  {waitWords(row.agedForHours)
                    ? `Ждёт вас ${waitWords(row.agedForHours)} — открыть и принять`
                    : 'Ждёт вас — открыть и принять'}
                </span>
              </button>
            ))}
          </div>
          {phaseQuestions > 0 ? (
            <p className="m-0 text-[13px] leading-[1.5] text-tx3">
              Ещё {phaseQuestions} {plural(phaseQuestions, 'вопрос', 'вопроса', 'вопросов')} ждут ответа на
              стадиях фаз — отвечать на них с компьютера: там виден весь текст вопроса и варианты.
            </p>
          ) : null}
        </div>
      ) : null}

      {answered ? (
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-semibold text-tx">
            Задачи · {taskUnits.length} {plural(taskUnits.length, 'строка', 'строки', 'строк')}
          </span>

          {taskUnits.length === 0 ? (
            <p className="m-0 rounded-[10px] border border-bd bg-card px-3.5 py-4 text-[13px] leading-[1.5] text-tx2">
              Задач нет. Поставить новую можно с компьютера — на телефоне вы принимаете сделанное.
            </p>
          ) : (
            <div className="overflow-hidden rounded-[10px] border border-bd bg-card">
              {/*
                ПОЛ ДОСТУПНОСТИ ПИШЕТСЯ ПРЯМО НА КНОПКЕ, а не прячется в общую строку классов:
                тест проводов читает разметку и требует пол у КАЖДОЙ цели, а класс, уехавший в
                константу, он на кнопке не увидит — и проверка станет зелёной, ничего не
                проверив. Немного повтора здесь дешевле, чем гейт, который не умеет краснеть.
              */}
              {taskUnits.map((unit, i) => (
                <button
                  key={`${unit.kind}:${unit.id}`}
                  type="button"
                  onClick={() => onOpenTask(unit.id)}
                  className={`flex min-h-[44px] w-full flex-col gap-1 px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-blue ${
                    i === 0 ? '' : 'border-t border-bd'
                  } ${unit.state === 'dec' ? 'bg-warn-s' : ''}`}
                >
                  <span className="text-[14px] leading-[1.35] font-semibold text-tx">{unit.title}</span>
                  <span className="text-[13px] leading-[1.4] text-tx2">
                    {STATE_WORD[unit.state]} · {ageLine(unit, agedFor)}
                  </span>
                </button>
              ))}
            </div>
          )}

          {asideCount > 0 ? (
            <p className="m-0 text-[13px] leading-[1.5] text-tx3">
              Ещё {asideCount} {plural(asideCount, 'единица', 'единицы', 'единиц')} работы — фазы и сборки.
              Строками здесь их нет: у фазы стадии и вопросы, у сборки состав из кусков, и это работа
              широкого экрана. Открыть их можно с компьютера.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
