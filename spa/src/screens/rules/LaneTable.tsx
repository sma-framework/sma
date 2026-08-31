import type { RulesLane, RulesWorker } from '../../api/types'

/**
 * LaneTable — who works on what, and with which engine, in one dense block.
 *
 * A lane is not a category invented by this screen: it is the word the configuration uses to
 * decide where a task goes, and the rows are printed in the order that configuration names
 * them. Reordering them by name here would quietly hide the fact that order is itself part of
 * the policy — the first lane a task matches is the lane it gets.
 *
 * ═══════════════════ THE PROFILE IS PRINTED, NEVER COMPLETED ═══════════════════
 *
 * A profile field the configuration does not carry arrives ABSENT, and an absent field is
 * shown as a dash. It is NOT filled in with the provider's default, however well known that
 * default is: a person reading this table is asking «what did I write down», and a screen
 * that answers with what it guessed teaches them to distrust the whole table.
 *
 * The account appears by NAME only. That is not a display choice made here — the reading
 * carries nothing else, by construction, so neither a token nor a local path can reach the
 * glass through this component.
 */

const LANE_UNNAMED = 'без полосы'

/** Columns, once: the header and every row use this one grid so the numbers line up. */
const COLS =
  'grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_92px_minmax(0,120px)_78px_minmax(0,1fr)_86px] items-center gap-3'

function Cell({ text, dim = false }: { text: string | undefined; dim?: boolean }) {
  const empty = text === undefined || text === ''
  return (
    <span className={`min-w-0 truncate text-[12px] ${empty || dim ? 'text-tx3' : 'text-tx2'}`}>
      {empty ? '—' : text}
    </span>
  )
}

/**
 * Три состояния строки, и разница между двумя первыми — та самая, ради которой эта таблица и
 * читается: кто возьмёт задачу сам, а кого надо позвать.
 */
function State({ worker }: { worker: RulesWorker | undefined }) {
  const enabled = worker?.enabled === true
  const inQueue = worker?.inQueue === true
  const dot = inQueue ? 'bg-green' : enabled ? 'bg-teal' : 'bg-tx3'
  const text = inQueue ? 'в очереди' : enabled ? 'по вызову' : 'выключен'
  const hint = inQueue
    ? 'Разбирает очередь: инлайн-задачи и куски сборок'
    : enabled
      ? `Включён, но из очереди сам не берёт: роль «${worker?.role ?? '—'}» зовут поимённо при постановке или поднимает фаза`
      : 'Выключен: не берёт ничего и по имени тоже'

  return (
    <span className="flex items-center gap-[7px]" title={hint}>
      <span aria-hidden className={`h-1.5 w-1.5 flex-none rounded-full ${dot}`} />
      <span className={`text-[11.5px] ${inQueue ? 'text-tx2' : 'text-tx3'}`}>{text}</span>
    </span>
  )
}

export function LaneTable({ lanes, workers }: { lanes: RulesLane[]; workers: RulesWorker[] }) {
  if (workers.length === 0) {
    return (
      <p className="m-0 px-5 py-4 text-[12.5px] text-tx2">
        Ни одного работника не заведено. Работники и их полосы описываются в конфигурации демона — окно
        показывает то, что там написано.
      </p>
    )
  }

  const byId = new Map(workers.map((w) => [w.id, w]))
  /** A worker whose lane never made it into a lane bucket is still a worker — it gets its own row. */
  const placed = new Set(lanes.flatMap((l) => l.workers))
  const loose = workers.filter((w) => !placed.has(w.id))
  const groups: RulesLane[] = loose.length > 0 ? [...lanes, { lane: null, workers: loose.map((w) => w.id) }] : lanes

  return (
    <div className="flex flex-col">
      <div className={`${COLS} border-b border-bd px-5 pb-2`}>
        <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Полоса</span>
        <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Работник</span>
        <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Провайдер</span>
        <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Модель</span>
        <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Усилие</span>
        <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Аккаунт</span>
        <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Состояние</span>
      </div>

      {groups.map((lane, gi) =>
        lane.workers.map((id, wi) => {
          const w = byId.get(id)
          const first = wi === 0
          return (
            <div
              key={`${lane.lane ?? LANE_UNNAMED}-${id}`}
              className={`${COLS} px-5 py-2.5 hover:bg-row-hover ${
                first && !(gi === 0 && wi === 0) ? 'border-t border-bd' : ''
              }`}
            >
              <span className="min-w-0 truncate text-[12.5px] font-medium text-tx">
                {first ? (lane.lane ?? LANE_UNNAMED) : ''}
              </span>
              <span className="min-w-0 truncate text-[12.5px] text-tx">{id}</span>
              <Cell text={w?.provider} />
              <Cell text={w?.model} />
              <Cell text={w?.effort} />
              <Cell text={w?.account} />
              {/*
                СОСТОЯНИЙ ТРИ, А НЕ ДВА. «Включён» отвечало на вопрос «стоит ли галочка», а
                человек читает эту колонку как ответ на другой — «возьмёт ли он мою задачу».
                Для включённого специалиста эти два ответа расходятся: галочка стоит, а из
                очереди он не берёт ничего, его зовут поимённо или поднимает фаза.
              */}
              <State worker={w} />
            </div>
          )
        }),
      )}
    </div>
  )
}
