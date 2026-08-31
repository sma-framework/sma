import { useState } from 'react'
import { ApiError, isNotReady } from '../../api/client'
import { useBacklogPromote, useBacklogQuery } from '../../api/queries'
import type { BacklogRow } from '../../api/types'
import { openScreen } from '../../shell/navigation'
import { Waiting } from '../../shell/Waiting'

/**
 * «Бэклог» — the project's own list of what is worth doing, read as a board, with a way to put
 * one line into the queue.
 *
 * ═════════════════════ THE FILE IS A HAND. THIS SCREEN NEVER WRITES IT. ═════════════════════
 *
 * `.planning/BACKLOG.md` is written by whoever keeps it — sorted, annotated, argued with in
 * prose. This board READS it, and there is no door behind this screen that could write it back:
 * putting a line into the queue does not strike it out, does not move it and does not touch a
 * byte. So the card STAYS after it is promoted, and the screen says so out loud rather than
 * letting that read as a bug. Deciding a line is done is an edit in the file, by the person
 * whose file it is.
 *
 * ═════════════════════ THE IDENTIFIER IS DATA, AND THIS SCREEN KEEPS NO DICTIONARY ═════════
 *
 * What the letters in front of the number mean is the project's own business. The daemon parses
 * by SHAPE and carries no list of prefixes; this screen carries none either — the identifier is
 * rendered exactly as the file spelled it and is never looked up, grouped by, coloured by or
 * translated. A board that knew one project's prefixes would be a board that silently shows
 * nothing for every other.
 *
 * ═════════════════════ «В РАБОТУ» IS ONE LINE, ONE LANE, ONE PRESS ═════════════════════
 *
 * The lane is asked for before the press, because it is the one thing the queue cannot work out
 * on its own and the one thing the door will not guess twice. «Кузница» is deliberately absent
 * for the same reason it is absent from the new-task form: a forge task needs a draft brief the
 * queue validates separately, and it is asked for on «Агенты», where that brief exists.
 */

/**
 * The lanes a backlog line can be sent to, in the daemon's own words. The queue's vocabulary is
 * frozen; these are the three of it that need nothing but a title.
 */
const LANES: readonly { value: string; label: string }[] = [
  { value: 'prod', label: 'прод-код' },
  { value: 'research', label: 'ресёрч' },
  { value: 'paperwork', label: 'бумага' },
] as const

function promoteWords(err: unknown): string {
  if (isNotReady(err)) return 'Очередь пока не принимает задачи. Строка осталась в файле как была.'
  if (err instanceof ApiError && err.status === 404) {
    return 'Такой строки в файле уже нет — возможно, её только что поправили.'
  }
  if (err instanceof ApiError && (err.status === 409 || err.status === 400) && err.detail) {
    return `Отказано: ${err.detail}`
  }
  return 'Не поставилось. Строка осталась в файле как была.'
}

/** One line of the file, and the one act available over it. */
function BacklogCard({ row }: { row: BacklogRow }) {
  const promote = useBacklogPromote()
  const [picking, setPicking] = useState(false)
  const [lane, setLane] = useState<string>(LANES[0].value)
  const [queued, setQueued] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const send = () => {
    setProblem(null)
    promote.mutate(
      { id: row.id, lane },
      {
        onSuccess: () => {
          setPicking(false)
          setQueued(true)
        },
        onError: (err) => {
          setPicking(false)
          setProblem(promoteWords(err))
        },
      },
    )
  }

  return (
    <article className="flex flex-col gap-2.5 rounded-[12px] border border-bd bg-card p-4 shadow-panel">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="flex-none font-mono text-[11.5px] font-semibold text-blue">{row.id}</span>
        <span className="min-w-0 flex-1 text-[12.5px] leading-[1.5] text-tx">{row.title}</span>
      </div>
      {row.ageLine ? <span className="text-[11px] leading-[1.5] text-tx3">{row.ageLine}</span> : null}

      {queued ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] text-ok-tx">Задача в очереди.</span>
          <button
            type="button"
            onClick={() => openScreen({ screen: 'tasks' })}
            className="rounded-[8px] border border-bd bg-card px-3 py-1 text-[11.5px] text-tx2 hover:text-tx"
          >
            Открыть «Задачи»
          </button>
          <span className="text-[11px] text-tx3">Строка остаётся здесь — файл ведёте Вы.</span>
        </div>
      ) : picking ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {LANES.map((o) => {
              const on = o.value === lane
              return (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setLane(o.value)}
                  className={`rounded-[8px] border px-3 py-1 text-[11.5px] ${
                    on ? 'border-blue bg-blue-s text-tx' : 'border-bd2 text-tx2 hover:text-tx'
                  }`}
                >
                  {o.label}
                </button>
              )
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={send}
              disabled={promote.isPending}
              className="rounded-[8px] bg-blue px-[15px] py-1.5 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
            >
              {promote.isPending ? 'Ставлю…' : 'Поставить в очередь'}
            </button>
            <button
              type="button"
              onClick={() => setPicking(false)}
              className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
            >
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="w-fit rounded-[8px] border border-bd bg-card px-3 py-1 text-[11.5px] font-semibold text-tx"
        >
          В работу
        </button>
      )}

      {problem ? <span className="text-[11.5px] leading-[1.5] text-warn-tx">{problem}</span> : null}
    </article>
  )
}

export function Screen() {
  const backlog = useBacklogQuery()
  const rows = backlog.data?.rows ?? []

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-3 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-tx">Бэклог</h1>
        <span className="flex-1" />
        {rows.length > 0 ? (
          <span className="flex-none rounded-[9px] border border-bd bg-card px-3 py-1.5 text-[11.5px] tabular-nums text-tx2">
            строк: {rows.length}
          </span>
        ) : null}
      </header>

      <div className="flex flex-none items-center border-b border-bd px-7 py-3">
        <span className="text-[12.5px] text-tx2">
          Список проекта: что стоит сделать. Файл ведёте Вы — окно его показывает и не правит.
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
        {backlog.isLoading ? <Waiting what="Читаю список" /> : null}

        {backlog.isError ? (
          <p className="m-0 text-[13px] text-tx2">
            Список сейчас не читается. Сам файл при этом на месте — он лежит в проекте.
          </p>
        ) : null}

        {!backlog.isLoading && !backlog.isError && rows.length === 0 ? (
          <p className="m-0 max-w-[640px] text-[13px] leading-[1.6] text-tx2">
            Список пуст — либо в проекте его ещё нет, либо в нём нет ни одной отмеченной строки.
            Доска показывает то, что помечено в файле как запись списка, а не всё, что там
            написано.
          </p>
        ) : null}

        {rows.length > 0 ? (
          <div className="flex max-w-[860px] flex-col gap-2.5">
            {rows.map((row) => (
              <BacklogCard key={row.id} row={row} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  )
}
