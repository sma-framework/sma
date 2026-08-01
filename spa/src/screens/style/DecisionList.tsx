import { useState } from 'react'

import type { StyleDecision } from '../../api/types'
import { plural } from '../../shell/format'

/**
 * DecisionList — the decisions the distillation has already taken apart, opened on demand.
 *
 * ═════════════════════ EVERY LINE HERE WENT THROUGH THE SCRUBBER ═════════════════════
 *
 * The three parts of a row — the situation, what was decided, and the rule behind it — are
 * the contents of fenced blocks the miner wrote AFTER redaction. Text a person typed around
 * those fences never reaches the payload at all, so there is nothing on this screen for a
 * filter here to have missed. The rows are rendered as text nodes: no markup a note carried
 * is interpreted, because a note is material, not a template.
 *
 * ═════════════════════════ CLOSED BY DEFAULT, SEARCHED IN PLACE ═════════════════════════
 *
 * The list is the deepest thing on the screen and the least often needed, so it stays folded
 * under its own count and opens with one click. Three rows are visible; the rest arrives by
 * scrolling, which keeps the block from pushing the history off the screen. The search
 * filters the rows that are already here — it asks the daemon nothing.
 */
export function DecisionList({ decisions }: { decisions: StyleDecision[] }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const q = search.trim().toLowerCase()
  const found = q
    ? decisions.filter((d) => `${d.situation} ${d.decision} ${d.why}`.toLowerCase().includes(q))
    : decisions

  return (
    <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-[18px] py-[13px] text-left hover:bg-row-hover"
      >
        <span aria-hidden className="flex-none text-[11px] text-tx3">
          {open ? '▾' : '▸'}
        </span>
        <span className="text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">
          Разобранные решения
        </span>
        <span className="text-[11px] text-tx3 tabular-nums">({decisions.length})</span>
        <div className="flex-1" />
        {open ? null : <span className="flex-none text-[11.5px] text-blue">посмотреть</span>}
      </button>

      {open ? (
        <>
          {decisions.length === 0 ? (
            <p className="m-0 border-t border-bd px-[18px] py-4 text-[12.5px] text-tx2">
              Ни одного решения ещё не разобрано. Разбор идёт в терминале — сюда попадает то,
              что он записал.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2.5 border-t border-bd px-[18px] py-2.5">
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Поиск по решениям"
                  aria-label="Поиск по разобранным решениям"
                  className="min-w-0 flex-1 rounded-[9px] border border-bd bg-input px-[11px] py-2 text-[12.5px] text-tx outline-none focus:border-blue"
                />
                <span className="flex-none text-[11px] whitespace-nowrap text-tx3 tabular-nums">
                  {q
                    ? `найдено ${found.length}`
                    : `показано ${decisions.length} ${plural(decisions.length, 'решение', 'решения', 'решений')}`}
                </span>
              </div>

              <div className="max-h-[260px] overflow-y-auto">
                {found.length === 0 ? (
                  <p className="m-0 border-t border-bd px-[18px] py-4 text-[12.5px] text-tx2">
                    Ничего не нашлось по этому запросу
                  </p>
                ) : (
                  found.map((d) => (
                    <div key={d.id} className="flex flex-col gap-1.5 border-t border-bd px-[18px] py-3">
                      <div className="flex min-w-0 items-baseline gap-3">
                        <span className="min-w-0 flex-1 text-[12.5px] leading-[1.5] text-tx">
                          {d.situation || '—'}
                        </span>
                        {d.decision ? (
                          <span className="flex-none rounded-full border border-bd2 px-2.5 py-[3px] text-[11px] whitespace-nowrap text-tx2">
                            {d.decision}
                          </span>
                        ) : null}
                      </div>
                      {d.why ? (
                        <span className="text-[11.5px] leading-[1.5] text-tx3">{d.why}</span>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </>
      ) : null}
    </div>
  )
}
