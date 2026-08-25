import { useState } from 'react'
import { useBatchDecide, useStateQuery } from '../../api/queries'
import type { BatchItem, BatchItemState } from '../../api/types'
import { EntitySummary } from '../../shell/EntitySummary'
import { LiveTimer } from '../../shell/LiveTimer'
import { TaskPanel } from '../../shell/TaskPanel'
import { batchStats, clockOfMs } from '../../shell/stats'
import { plural } from '../../shell/format'
import { doorWords } from '../pipeline/shared'
import { BATCH_ITEM_TONE, STATE_WORD } from './units'
import type { UnitState } from './units'

/**
 * BatchView — одна сборка как развилка: запрос владельца слева, куски столбцом, сборка справа.
 *
 * ═══════════════════ ПОЧЕМУ РАЗВИЛКА, А НЕ ЕЩЁ ОДИН СПИСОК ═══════════════════════════
 *
 * Батч отвечает на вопрос, которого нет ни у инлайна, ни у фазы: «одна моя фраза — во что она
 * превратилась и когда сойдётся обратно». Список кусков этого не говорит: он показывает четыре
 * строки и молчит о том, что они одно целое и что целое закроется только вместе. Развилка
 * говорит это формой — один вход, куски, один выход, — и потому она и нарисована, а не таблица.
 *
 * ═══════════════════ СВЯЗЬ — ФУНКЦИЯ СОСТОЯНИЯ, А НЕ КРАСОТЫ ════════════════════════
 *
 * Каждая линия читается: слева — «этот кусок уже отделился от запроса» (пунктир, пока кусок не
 * начинали), справа — «этот кусок уже В сборке» (сплошная зелёная только у произведённого,
 * пунктир у всего остального). Толщина и цвет — то же состояние, что и в слове рядом с куском.
 * Линия, нарисованная одинаково для всех, врала бы ровно про то единственное, ради чего человек
 * сюда пришёл: где именно стоит его работа.
 *
 * ═══════════════════ ЭЛЕМЕНТ — ЭТО ЗАДАЧА, И КАРТОЧКА У НЕЁ ОДНА ═════════════════════
 *
 * Клик по куску открывает ТУ ЖЕ панель задачи, которую открывает клик по строке списка: задача —
 * самый нижний уровень, и вход в неё есть отовсюду. Своего «вида элемента» здесь нет и быть не
 * может — второй вид одной и той же задачи однажды разошёлся бы с первым, и никто бы не заметил.
 *
 * ═══════════════════ ВСТАВШАЯ СБОРКА ГОВОРИТ, ЧТО ОНА ВСТАЛА ═════════════════════════
 *
 * Сломавшийся кусок останавливает батч и задаёт владельцу вопрос с тремя названными вариантами.
 * Экран обязан этот вопрос показать: иначе сборка выглядит зависшей, а она ждёт человека. Слова
 * вариантов приезжают ОТ ДВИЖКА и той же тройкой уходят в дверь ответа.
 */

/** Одна крошка пути: как называется и куда возвращает. Без обработчика — это «вы здесь». */
export interface BatchCrumb {
  label: string
  onClick?: () => void
}

/** Тон куска: цвет линии и подложка. Цвет никогда не единственный носитель — слово рядом. */
const NODE_TONE: Record<UnitState, { box: string; word: string; dot: string; stroke: string }> = {
  run: { box: 'border-blue/30 bg-blue-s', word: 'text-blue', dot: 'bg-blue', stroke: 'var(--color-blue)' },
  dec: { box: 'border-warn/50 bg-warn-s', word: 'text-warn-tx', dot: 'bg-warn', stroke: 'var(--color-warn)' },
  ok: { box: 'border-green/40 bg-ok-s', word: 'text-ok-tx', dot: 'bg-green', stroke: 'var(--color-green)' },
  wait: { box: 'border-bd bg-card', word: 'text-tx3', dot: 'bg-tx3', stroke: 'var(--color-tx3)' },
  fail: { box: 'border-err-bd bg-err-s', word: 'text-err-tx', dot: 'bg-err', stroke: 'var(--color-err)' },
  skip: { box: 'border-bd bg-surf', word: 'text-tx3', dot: 'bg-tx3', stroke: 'var(--color-bd2)' },
  off: { box: 'border-bd bg-surf', word: 'text-tx3', dot: 'bg-tx3', stroke: 'var(--color-bd2)' },
}

/** Что кусок говорит о себе второй строкой — его состояние, сказанное человеку. */
const NOTE: Record<BatchItemState, string> = {
  done: 'закрыт — работа произведена',
  running: 'идёт прямо сейчас',
  waiting: 'не начат — ждёт своей очереди в сборке',
  awaiting_decision: 'ждёт вашего решения',
  failed: 'не получилось — сборка стоит на нём',
  skipped: 'пропущен вашим решением — сборку он больше не держит',
}

/** Геометрия развилки — та же, что в принятом макете: вход, столбец кусков, выход. */
const STEP = 58
const NODE_H = 50
const CANVAS_W = 1060
const ORIGIN_W = 180
const NODE_X = 256
const NODE_W = 496
const TAIL_X = 832

export function BatchView({
  id,
  onBack,
  backLabel = '← К задачам',
  trail = [],
}: {
  id: string
  onBack: () => void
  /** Слово на кнопке возврата — оно называет место, откуда пришли, а не «назад вообще». */
  backLabel?: string
  /** Крошки предков: их даёт тот, кто открыл вид, потому что только он знает путь. */
  trail?: BatchCrumb[]
}) {
  const state = useStateQuery()
  const decide = useBatchDecide()

  /** Какой кусок открыт панелью задачи. `null` — на глазу сама развилка. */
  const [openItem, setOpenItem] = useState<string | null>(null)
  const [problem, setProblem] = useState('')
  /** Отмена — действие разрушительное, поэтому она спрашивает второй раз, а не «сразу». */
  const [armed, setArmed] = useState(false)

  const batch = (state.data?.batches ?? []).find((b) => b.id === id) ?? null
  const items = batch?.items ?? []
  const n = items.length
  // Закрытые куски считает окошко показателей (`batchStats`) — второй счёт здесь назвал бы ту
  // же сборку двумя разными числами. Пропущенные считаются тут: это не показатель, а слово
  // владельца о куске, и сказать его нужно в описании, а не цифрой.
  const skipped = items.filter((i) => i.state === 'skipped').length
  const started = items.some((i) => i.state !== 'waiting')
  const opened = items.find((i) => i.id === openItem) ?? null

  /**
   * ПОКА ОТКРЫТА ПАНЕЛЬ ЗАДАЧИ, КРОШКИ — АДРЕС, А НЕ РУЛЬ. Панель читается поверх развилки, за
   * затемнением, которое ловит клики: кликабельная крошка под ним обещает дорогу, которой нет
   * (это уже находили живой проверкой на карточке фазы). Панель закрывается своими способами —
   * крестиком, Esc и кликом по затемнению, — и крошки снова становятся рулём.
   */
  const crumbs: BatchCrumb[] = [
    ...trail.map((c) => (openItem ? { label: c.label } : c)),
    { label: batch?.title ?? 'Открываю…' },
    ...(opened ? [{ label: opened.title ?? opened.id }] : []),
  ]

  const answer = (option: 'skip' | 'retry' | 'cancel') => {
    if (!batch || !batch.question) return
    setProblem('')
    decide.mutate(
      option === 'cancel'
        ? { batchId: batch.id, decision: option }
        : { batchId: batch.id, decision: option, itemId: batch.question.itemId },
      {
        onSuccess: () => setArmed(false),
        onError: (err) => setProblem(doorWords(err)),
      },
    )
  }

  // Заголовок развилки: он говорит, что именно человек видит, и не выдаёт неначатую сборку за
  // разошедшуюся работу.
  const forkTitle = !started
    ? 'Развилка готова, работник до неё ещё не дошёл'
    : `Один запрос разошёлся на ${n} ${plural(n, 'элемент', 'элемента', 'элементов')} и снова сойдётся в одну сборку`

  const tailWords =
    batch?.state === 'cancelled'
      ? 'Сборка отменена вами. Незапущенные элементы вынуты из очереди; то, что уже произвело, не тронуто.'
      : n === 0
        ? 'Элементов у постановки нет — держать сборку нечему.'
        : batch?.holding
          ? `Закроется, когда закрыты все ${n}. Держит «${batch.holding.title ?? batch.holding.id}» — ${
              NOTE[batch.holding.state]
            }.`
          : 'Сборка закрыта: каждый элемент произвёл или отпущен вами.'

  /**
   * ОПИСАНИЕ СБОРКИ — ЭТО СЛОВА ВЛАДЕЛЬЦА И МОМЕНТ, КОГДА ОН ИХ СКАЗАЛ.
   *
   * Название сборки и есть его фраза: дверь батча записывает её как заголовок запроса, ничего
   * не сочиняя. Момент приезжает отдельным полем той же строки — и `null` у него значит ровно
   * «сборка старше этой отметки», а не «только что»: отметка постановки в очередь выглядела бы
   * здесь так же и врала бы на величину, которую никто не заметит.
   *
   * Числа сюда НЕ ПИШУТСЯ. Прежде под заголовком стояла строка «батч · 3 элемента · закрыто 1
   * из 3 …» — те же самые числа, что теперь стоят в окошке показателей. Владелец вычеркнул её
   * (25.08): два места для одного числа — это одно место, где оно однажды разойдётся.
   */
  const requestedClock = clockOfMs(batch?.requestedAt ?? null)
  const describe =
    n === 0
      ? 'Элементов у этой постановки нет — держать сборку нечему.'
      : `Один работник ведёт сборку, по одному элементу за раз: ${n} ${plural(
          n,
          'элемент',
          'элемента',
          'элементов',
        )}, и закроется она только вместе.${
          skipped > 0 ? ` Пропущено вашим решением: ${skipped}.` : ''
        }`

  const h = Math.max(n, 1) * STEP + 10
  const mid = h / 2

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-3 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <nav aria-label="Путь" className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px]">
          {crumbs.map((crumb, i) => (
            <span key={`${crumb.label}:${i}`} className="flex min-w-0 items-center gap-1.5">
              {crumb.onClick ? (
                <button
                  type="button"
                  onClick={crumb.onClick}
                  className="max-w-[220px] truncate text-blue-d hover:underline"
                >
                  {crumb.label}
                </button>
              ) : (
                <span className="max-w-[360px] truncate font-semibold text-tx">{crumb.label}</span>
              )}
              {i < crumbs.length - 1 ? (
                <span aria-hidden className="text-tx3">
                  /
                </span>
              ) : null}
            </span>
          ))}
        </nav>
        {/* Живое время сборки — от момента, когда её попросил владелец. Сломавшийся кусок
            останавливает сборку и спрашивает человека: колечко встаёт, цвет меняется, время
            ожидания продолжает расти — именно оно и есть цена простоя. */}
        {batch ? (
          <LiveTimer
            state={
              batch.state === 'failed'
                ? 'failed'
                : batch.question || batch.state === 'awaiting_decision'
                  ? 'waiting'
                  : batch.state === 'running'
                    ? 'running'
                    : 'idle'
            }
            since={batch.requestedAt ?? null}
          />
        ) : null}
        {batch ? (
          <span
            className={`flex-none rounded-[8px] px-2.5 py-1 text-[11.5px] font-semibold ${
              batch.state === 'done'
                ? 'bg-ok-s text-ok-tx'
                : batch.question || batch.state === 'awaiting_decision'
                  ? 'bg-warn-s text-warn-tx'
                  : batch.state === 'running'
                    ? 'bg-blue-s text-blue-d'
                    : 'bg-surf text-tx2'
            }`}
          >
            {STATE_WORD[batch.state === 'cancelled' ? 'off' : BATCH_ITEM_TONE[batch.state]]}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onBack}
          className="flex-none rounded-[8px] border border-bd2 px-3 py-1.5 text-[12px] text-tx2 hover:text-tx"
        >
          {backLabel}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-7 py-5">
        {!batch && state.isLoading ? <p className="m-0 text-[13px] text-tx2">Открываю сборку…</p> : null}
        {!batch && !state.isLoading ? (
          <p className="m-0 text-[13px] text-tx2">
            Такой сборки в этом чтении состояния нет. Ничего с ней не случилось — вернитесь к задачам и
            откройте её снова.
          </p>
        ) : null}

        {batch ? (
          <div className="flex flex-col gap-4">
            {/* Заголовок миниатюрный: имя сборки человек уже прочитал в пути наверху, а место
                под ним принадлежит описанию и показателям, а не второму написанию имени. */}
            <h2 className="m-0 truncate text-[13px] font-semibold leading-tight text-tx">
              {batch.title ?? 'Без названия'}
            </h2>

            <EntitySummary
              describeTitle="Описание батча"
              text={`«${batch.title ?? 'Без названия'}» — этими словами сборку и заказали. ${describe}`}
              source={
                requestedClock
                  ? `запрос владельца, ${requestedClock}`
                  : 'момент просьбы не записан — сборка старше этой отметки'
              }
              stats={batchStats(batch, Date.now())}
            />

            {/* ВСТАВШАЯ СБОРКА СПРАШИВАЕТ. Слова вариантов — движковые, не наши. */}
            {batch.question ? (
              <div className="rounded-[10px] border border-warn-s bg-warn-s px-4 py-3.5">
                <p className="m-0 text-[13px] font-semibold text-tx">{batch.question.text}</p>
                <p className="m-0 mt-1 text-[11.5px] leading-[1.5] text-tx2">
                  Сборка стоит и ничего не повторяет сама: пока вы не ответите, ни один её элемент
                  работнику не выдаётся.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {batch.question.options.map((o) =>
                    o.id === 'cancel' ? (
                      <button
                        key={o.id}
                        type="button"
                        disabled={decide.isPending}
                        onClick={() => (armed ? answer('cancel') : setArmed(true))}
                        className="rounded-[8px] border border-err-bd bg-card px-3 py-1.5 text-[12px] font-semibold text-err-tx hover:bg-err-s disabled:opacity-60"
                      >
                        {armed ? 'Точно отменить сборку' : o.label}
                      </button>
                    ) : (
                      <button
                        key={o.id}
                        type="button"
                        disabled={decide.isPending}
                        onClick={() => answer(o.id)}
                        className="rounded-[8px] border border-bd2 bg-card px-3 py-1.5 text-[12px] font-semibold text-tx hover:bg-card-hov disabled:opacity-60"
                      >
                        {o.label}
                      </button>
                    ),
                  )}
                  {armed ? (
                    <button
                      type="button"
                      onClick={() => setArmed(false)}
                      className="text-[11.5px] text-tx2 underline hover:text-tx"
                    >
                      не отменять
                    </button>
                  ) : null}
                </div>
                {problem ? <p className="m-0 mt-2 text-[11.5px] text-err-tx">{problem}</p> : null}
              </div>
            ) : null}

            {/* Развилка: запрос владельца → элементы → сборка. */}
            <div className="rounded-[10px] border border-bd bg-card px-[18px] py-4 shadow-panel">
              <p className="m-0 text-[12px] font-semibold text-tx">{forkTitle}</p>

              <div className="mt-3.5 overflow-x-auto">
                <div className="relative" style={{ width: CANVAS_W, height: h }}>
                  <svg width={CANVAS_W} height={h} className="absolute inset-0" aria-hidden="true">
                    {items.map((item, k) => {
                      const tone = NODE_TONE[BATCH_ITEM_TONE[item.state]]
                      const y = 33 + k * STEP
                      const dim = item.state === 'waiting' || item.state === 'skipped'
                      return (
                        <path
                          key={`in:${item.id}`}
                          d={`M${ORIGIN_W} ${mid} C 222 ${mid} 214 ${y} ${NODE_X} ${y}`}
                          fill="none"
                          stroke={tone.stroke}
                          strokeWidth={item.state === 'failed' || item.state === 'awaiting_decision' ? 2.2 : 1.4}
                          strokeDasharray={dim ? '4 4' : '0'}
                          opacity={dim ? 0.45 : 0.8}
                        />
                      )
                    })}
                    {items.map((item, k) => {
                      // ВПРАВО ЛИНИЯ СПЛОШНАЯ ТОЛЬКО У ПРОИЗВЕДЁННОГО: сборка состоит из того, что
                      // уже сделано, всё остальное — обещание, и пунктир говорит именно это.
                      const done = item.state === 'done'
                      const y = 33 + k * STEP
                      return (
                        <path
                          key={`out:${item.id}`}
                          d={`M${NODE_X + NODE_W} ${y} C 796 ${y} 792 ${mid} ${TAIL_X} ${mid}`}
                          fill="none"
                          stroke={done ? 'var(--color-green)' : 'var(--color-bd2)'}
                          strokeWidth={1.2}
                          strokeDasharray={done ? '0' : '4 4'}
                          opacity={done ? 0.7 : 0.4}
                        />
                      )
                    })}
                  </svg>

                  <div
                    className="absolute left-0 rounded-[7px] border border-bd bg-surf px-3 py-2.5"
                    style={{ top: mid - 24, width: ORIGIN_W }}
                  >
                    <p className="m-0 text-[12px] font-semibold text-tx">Запрос владельца</p>
                    <p className="m-0 mt-0.5 text-[10.5px] leading-[1.4] text-tx2">
                      «{batch.title ?? 'Без названия'}»
                    </p>
                  </div>

                  {items.map((item, k) => (
                    <ItemNode
                      key={item.id}
                      item={item}
                      top={8 + k * STEP}
                      holding={batch.holding?.id === item.id}
                      onOpen={() => setOpenItem(item.id)}
                    />
                  ))}

                  <div
                    className="absolute rounded-[7px] border border-dashed border-bd2 bg-surf px-3.5 py-2.5"
                    style={{ left: TAIL_X, top: mid - 34, width: 226 }}
                  >
                    <p className="m-0 text-[12px] font-semibold text-tx">Сборка батча</p>
                    <p className="m-0 mt-1 text-[10.5px] leading-[1.45] text-tx2">{tailWords}</p>
                  </div>
                </div>
              </div>

              {n === 0 ? (
                <p className="m-0 mt-3 text-[11.5px] text-tx3">
                  Элементов у этой постановки нет. Постановка записывается последней, поэтому такое
                  бывает только после обрыва — работа при этом остаётся в очереди сама по себе.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {openItem ? <TaskPanel taskId={openItem} onClose={() => setOpenItem(null)} /> : null}
    </div>
  )
}

/** Один кусок сборки — и он же задача: клик открывает ту же панель, что и строка списка. */
function ItemNode({
  item,
  top,
  holding,
  onOpen,
}: {
  item: BatchItem
  top: number
  holding: boolean
  onOpen: () => void
}) {
  const tone = NODE_TONE[BATCH_ITEM_TONE[item.state]]
  const word = STATE_WORD[BATCH_ITEM_TONE[item.state]]
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Элемент сборки · ${item.title ?? item.id} · ${word}`}
      className={`absolute box-border rounded-[7px] border px-3 py-2 text-left hover:border-blue ${tone.box}`}
      style={{ left: NODE_X, top, width: NODE_W, height: NODE_H }}
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 flex-none rounded-full ${tone.dot} ${
            item.state === 'running' ? 'animate-pulse' : ''
          }`}
        />
        <span className="truncate text-[12.5px] font-semibold text-tx">{item.title ?? item.id}</span>
        <span className={`ml-auto flex-none text-[10.5px] font-semibold ${tone.word}`}>{word}</span>
      </span>
      <span className="mt-0.5 block truncate text-[10.5px] text-tx2">
        {NOTE[item.state]}
        {holding ? ' · держит сборку' : ''}
      </span>
    </button>
  )
}
