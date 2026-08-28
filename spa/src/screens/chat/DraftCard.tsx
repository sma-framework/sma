import type { ChatDraft } from '../../api/types'
import { acceptanceList, STAGE_LABEL } from '../../shell/format'

/** What a lane is called on the glass. An unknown lane is shown as the daemon spelled it. */
const LANE_WORD: Record<string, string> = {
  prod: 'основная',
  research: 'исследование',
  paperwork: 'документы',
  forge: 'кузница',
}

/**
 * DraftCard — a task the conversation OFFERS, and the two things a person can do with it.
 *
 * ═════════════════ КНОПКА — КОРОТКИЙ ПУТЬ, А НЕ ЕДИНСТВЕННЫЙ ═════════════════
 *
 * Черновик становится задачей ровно в один момент — когда человек СОГЛАСИЛСЯ. Согласиться
 * можно двумя способами, и они равны по силе: нажать «Создать» здесь или ответить в разговоре
 * «да». Второй способ есть потому, что на телефоне кнопок нет вовсе, а двери обязаны быть
 * одинаковыми; первый — потому что рукой быстрее, когда карточка перед глазами.
 *
 * Кнопка при этом остаётся тем, чем была: обычным POST /api/enqueue из обработчика нажатия и
 * ниоткуда больше. Эффекта, который ставит задачу сам по себе, в этой папке нет — ни ответ, ни
 * тот, кто его надиктовал, работу отсюда не начнут. Слово «да» тоже не начинает её здесь: оно
 * уходит обычным ходом разговора, и ставит задачу ДЕМОН, своей же дверью постановки.
 *
 * Приёмка ни одним из двух путей не делается: «Одобрить» — отдельная рука на отдельной
 * кнопке. Строка под кнопками говорит это вслух.
 *
 * ═══════════════ A DRAFT ARRIVES ONE OF THREE WAYS, AND SAYS WHICH ═══════════════
 *
 * A session proposes a WORKER, checked against the roster before it left the daemon. A
 * sentence that already named its own lane proposes the LANE directly — the thing a roster
 * pick could never express. And a stage of a phase proposes neither: it carries a goal, and
 * the button behind it presses the phase cycle's own door, exactly as the phase card does.
 * All three are the same mechanic — a card, a click, a door — and the card names which one it
 * is rather than showing a blank where a worker used to be.
 */
export function DraftCard({
  draft,
  createdTaskId,
  creating,
  onCreate,
  onAmend,
  onOpenTask,
}: {
  draft: ChatDraft
  /** Set once the draft has become a real task — the card then points at it. */
  createdTaskId?: string
  creating: boolean
  onCreate: () => void
  onAmend: () => void
  onOpenTask: (taskId: string) => void
}) {
  const done = !!createdTaskId
  const stage = draft.data && draft.data.kind === 'stage' ? draft.data : null
  const debug = !!(draft.data && draft.data.kind === 'debug')

  return (
    <div className="max-w-[480px] overflow-hidden rounded-[11px] border border-bd2 bg-card shadow-panel">
      <div className="flex items-center gap-2 border-b border-bd bg-surf px-3 py-2">
        <span className="text-[10.5px] tracking-[0.1em] text-tx3 uppercase">
          {stage ? 'Черновик стадии' : 'Черновик задачи'}
        </span>
      </div>

      <div className="p-3">
        <div className="mb-2.5 text-[13.5px] font-semibold text-tx">{draft.title}</div>

        <div className="mb-3 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5">
          {stage ? (
            <>
              <span className="text-[11.5px] text-tx3">Стадия</span>
              <span className="text-[11.5px] font-semibold text-tx">
                {STAGE_LABEL[stage.stage] ?? stage.stage}
              </span>
              <span className="text-[11.5px] text-tx3">Фаза</span>
              <span className="text-[11.5px] font-semibold text-tx">{stage.phase}</span>
            </>
          ) : null}
          {draft.worker ? (
            <>
              <span className="text-[11.5px] text-tx3">Предлагаемый исполнитель</span>
              <span className="text-[11.5px] font-semibold text-tx">{draft.worker}</span>
            </>
          ) : null}
          {draft.lane ? (
            <>
              <span className="text-[11.5px] text-tx3">Линия работы</span>
              <span className="text-[11.5px] font-semibold text-tx">
                {LANE_WORD[draft.lane] ?? draft.lane}
              </span>
            </>
          ) : null}
          {stage ? null : (
            <>
              <span className="text-[11.5px] text-tx3">Режим</span>
              <span className="text-[11.5px] font-semibold text-tx">{draft.mode}</span>
            </>
          )}
          {/*
            Признаков может быть несколько, и приезжают они списком. Список, подставленный в
            текст, склеивается вплотную — «…файл существуетВ нём названа дата…», — поэтому
            каждый признак стоит своей строкой. И слово над ними согласовано с их числом:
            «Признак готовности» над тремя строками обещает один и обманывает счётом.
          */}
          {acceptanceList(draft.acceptance).length > 0 ? (
            <>
              <span className="text-[11.5px] text-tx3">
                {acceptanceList(draft.acceptance).length === 1 ? 'Признак готовности' : 'Признаки готовности'}
              </span>
              <span className="flex flex-col gap-1 text-[11.5px] leading-[1.5] text-tx">
                {acceptanceList(draft.acceptance).map((text, i) => (
                  <span key={`${i}-${text.slice(0, 16)}`}>{text}</span>
                ))}
              </span>
            </>
          ) : null}
        </div>

        {debug ? (
          <div className="mb-3 text-[11.5px] leading-[1.5] text-tx2">
            Разбор поломки идёт обычной задачей — ход будет виден в журнале попыток на её карточке.
          </div>
        ) : null}

        {done ? (
          <div className="flex items-center gap-2.5">
            <span className="text-[12.5px] font-semibold text-ok-tx">
              {stage ? 'Стадия в очереди.' : 'Задача поставлена.'}
            </span>
            <button
              type="button"
              onClick={() => onOpenTask(createdTaskId)}
              className="text-[12.5px] font-medium text-blue hover:text-teal"
            >
              Открыть
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={creating}
              onClick={onCreate}
              className="rounded-[8px] bg-blue-d px-3.5 py-[7px] text-[12.5px] font-semibold text-white disabled:opacity-60"
            >
              {creating ? 'Ставлю…' : stage ? 'Запустить стадию' : 'Создать'}
            </button>
            <button
              type="button"
              onClick={onAmend}
              className="rounded-[8px] border border-bd2 px-3 py-[7px] text-[12.5px] text-tx2 hover:bg-row-hover hover:text-tx"
            >
              Поправить
            </button>
          </div>
        )}

        <div className="mt-2.5 text-[11px] text-tx3">
          Черновик. Уйдёт в работу по кнопке — или когда Вы ответите «да» в разговоре.
        </div>
      </div>
    </div>
  )
}
