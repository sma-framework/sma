import type { WorkerHistoryRow, WorkerRow } from '../../api/types'
import { clockOfMs } from '../../shell/stats'
import { OUTCOME_TONE, OUTCOME_WORDS, STATS_PERIOD, historyTitle, splitHistory, statsWords } from './history'

/**
 * WorkerHistory — «что делал этот работник», и это ЕДИНСТВЕННЫЙ экран, отвечающий на вопрос
 * о ПРОШЛОМ одного работника.
 *
 * ═══════════════ ЗАЧЕМ ОНО ПОЯВИЛОСЬ ═══════════════
 *
 * Ростер отвечал ровно на «кто чем занят сейчас»: имя, окно, задача в руках. Владелец,
 * заходя в «Команду», спрашивал другое — «прокликать агентов и увидеть, что они делали», — и
 * получить этого не мог ниоткуда: приходилось идти в общий список работ и глазами искать те,
 * что вёл этот работник, чего в списке уже и не написано (очередь стирает работника со строки,
 * когда работу переставляют в очередь заново).
 *
 * ═══════════════ ОКНО НЕ СЧИТАЕТ. НИ ОДНОГО ЧИСЛА ═══════════════
 *
 * Две цифры вверху — те же самые, что на карточке: один объект, пришедший в состоянии,
 * показанный через одну функцию (`statsWords`). Здесь нет ни своей арифметики, ни «а заодно
 * посчитаем по списку» — второе мнение о числе однажды разойдётся с первым, и человек
 * перестанет верить обоим. Ровно тот же закон уже записан над самой карточкой.
 *
 * И ИМЕННО ПОЭТОМУ ДЛИНА СПИСКА НАЗВАНА СЛОВАМИ. Числа считают ПОДХОДЫ, список — РАБОТЫ:
 * задача, доведённая с третьего раза, стоит в списке одной строкой и в числах — тремя. Если
 * этого не сказать, человек прочитает расхождение как ошибку экрана.
 *
 * ═══════════════ РОД РАБОТЫ РАЗДЕЛЁН, А НЕ ПОМЕЧЕН ═══════════════
 *
 * Фазы и инлайн-задачи стоят разными списками (просьба владельца — «не смешивать»). Значком
 * внутри одного списка это не решается: значок читается как свойство строки, а не как граница
 * между двумя родами работы, и «шесть работ» продолжает отвечать не на тот вопрос.
 */

/** Один день, как его читают глазами: «28.08, 14:20». Момента нет — прочерк. */
function whenWords(ms: number): string {
  const at = new Date(ms)
  if (Number.isNaN(at.getTime())) return '—'
  const day = `${String(at.getDate()).padStart(2, '0')}.${String(at.getMonth() + 1).padStart(2, '0')}`
  return `${day}, ${clockOfMs(ms) ?? '—'}`
}

function HistoryLine({ row, onOpenTask }: { row: WorkerHistoryRow; onOpenTask: (taskId: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpenTask(row.taskId)}
      className="flex w-full items-baseline justify-between gap-3 rounded-[8px] px-2 py-1.5 text-left hover:bg-row-hover"
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-tx hover:text-blue">
        {row.phase ? <span className="text-tx3">Фаза {row.phase} · </span> : null}
        {historyTitle(row)}
      </span>
      <span className={`flex-none text-[11.5px] ${OUTCOME_TONE[row.outcome]}`}>{OUTCOME_WORDS[row.outcome]}</span>
      <span className="flex-none text-[10.5px] whitespace-nowrap text-tx3 tabular-nums">{whenWords(row.endedAt)}</span>
    </button>
  )
}

export function WorkerHistory({
  worker,
  stats,
  onOpenTask,
  onClose,
}: {
  worker: WorkerRow
  /** Ровно та пара, что напечатана на карточке. Пересчёта здесь нет по построению. */
  stats: { done: number; failed: number } | null
  onOpenTask: (taskId: string) => void
  onClose: () => void
}) {
  const said = statsWords(stats)
  const groups = splitHistory(worker.history)
  const total = (worker.history ?? []).length

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-scrim p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Что делал ${worker.id}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        className="flex max-h-[80vh] w-[620px] flex-col gap-3.5 rounded-[13px] border border-bd2 bg-card p-[18px] shadow-menu"
      >
        <div className="flex flex-none items-baseline justify-between gap-3">
          <div className="text-[13.5px] font-semibold text-tx">Что делал «{worker.id}»</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[8px] border border-bd2 px-[13px] py-1 text-[11.5px] text-tx2 hover:text-tx"
          >
            Закрыть
          </button>
        </div>

        <div className="flex flex-none items-baseline gap-2 border-b border-bd pb-3">
          <span className="text-[10.5px] text-tx3">{STATS_PERIOD}</span>
          {said.kind === 'measured' ? (
            <span className="text-[12.5px] tabular-nums text-tx2">
              сделано: <span className="font-semibold text-ok-tx">{said.done}</span> · не получилось:{' '}
              <span className={(said.failed ?? 0) > 0 ? 'font-semibold text-err-tx' : 'font-semibold text-tx2'}>
                {said.failed}
              </span>
            </span>
          ) : (
            <span className="text-[12.5px] text-tx3">{said.text}</span>
          )}
        </div>

        {worker.history === undefined ? (
          <p className="m-0 text-[12px] leading-[1.6] text-tx2">
            Журнал попыток прочитать не удалось — списка работ у окна нет. Пустой список здесь
            означал бы «он ничего не вёл», а это утверждение, которого никто не измерял.
          </p>
        ) : total === 0 ? (
          <p className="m-0 text-[12px] leading-[1.6] text-tx2">
            За период ни одна работа этого работника не завершилась. Журнал открыт, считать было
            нечего — это измерение, а не пробел.
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
            {groups.map((group) => (
              <section key={group.key} className="flex flex-col gap-1">
                <div className="text-[10.5px] text-tx3">
                  {group.label} · {group.rows.length}
                </div>
                {group.rows.map((row) => (
                  <HistoryLine key={`${group.key}:${row.taskId}`} row={row} onOpenTask={onOpenTask} />
                ))}
              </section>
            ))}
          </div>
        )}

        <p className="m-0 flex-none border-t border-bd pt-3 text-[11px] leading-[1.5] text-tx3">
          Список считает РАБОТЫ, числа выше — ПОДХОДЫ: задача, доведённая со второго раза, стоит
          здесь одной строкой и в числах — двумя. Слово при работе — чем она кончилась в
          последний раз.
        </p>
      </div>
    </div>
  )
}
