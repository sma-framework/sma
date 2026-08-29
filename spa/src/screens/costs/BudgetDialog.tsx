import { useState } from 'react'
import { ApiError, isNotReady } from '../../api/client'
import { useBudgetSet } from '../../api/queries'
import { FX_NOTE, formatUsd } from './money'

/**
 * The money stop, and the dialog in front of it.
 *
 * ═════════════════ THERE IS ONE STOP, AND IT IS THE WHOLE MACHINE ═════════════════
 *
 * Not one per lane — this product reads exactly one budget stop, the monthly ceiling on the
 * paid channel, and it is the one the fallback rule consults before spending real money. A
 * per-lane limit written here would be a number a person believes is in force and nothing ever
 * asks about, which is worse than no limit at all.
 *
 * ═════════════════ И ЭТО ДОЛЛАРЫ — ЗДЕСЬ ЭТО ВАЖНЕЕ, ЧЕМ ГДЕ БЫ ТО НИ БЫЛО ═════════════════
 *
 * Это единственная дверь, за которой человек ВВОДИТ сумму сам, и до уборки она спрашивала
 * «сколько евро», а сравнивался потолок с сырыми долларами поставщика. Порог остановки денег
 * стоял не там, где его ставил человек. Пересчёта курса продукт не делает и не заводит —
 * поэтому валюта названа у самого поля ввода, и FX_NOTE стоит рядом.
 *
 * ═════════════════════════ ZERO IS A REAL ANSWER ═════════════════════════
 *
 * Zero does not mean «no limit». It means the paid channel may never be used: with no ceiling
 * there is no money for it, and the rule refuses the fallback outright. That is the shipped
 * default, and the dialog says it in as many words — a person setting a ceiling to zero should
 * know they have switched the paid channel off, not uncapped it.
 */

function budgetWords(err: unknown): string {
  if (isNotReady(err)) return 'Эта дверь пока не отвечает. Потолок остался прежним.'
  if (err instanceof ApiError && err.detail) return `Отказано: ${err.detail}`
  return 'Не применилось. Потолок остался прежним.'
}

export function BudgetDialog({ current, onClose }: { current: number; onClose: () => void }) {
  const set = useBudgetSet()
  const [typed, setTyped] = useState(String(current))
  const [problem, setProblem] = useState<string | null>(null)

  const written = typed.trim().replace(',', '.')
  const limit = Number(written)
  const valid = written !== '' && Number.isFinite(limit) && limit >= 0
  const changed = valid && limit !== current

  const submit = () => {
    if (!changed) return
    setProblem(null)
    set.mutate(
      { limit },
      {
        // The answer is not kept: the whole window re-reads after the write, and the ceiling
        // on the card behind this dialog is drawn from that reading.
        onSuccess: () => onClose(),
        onError: (err) => setProblem(budgetWords(err)),
      },
    )
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-scrim p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Потолок платного канала"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        className="flex w-[440px] flex-col gap-3.5 rounded-[13px] border border-bd2 bg-card p-[18px] shadow-menu"
      >
        <div className="text-[13.5px] font-semibold text-tx">Потолок платного канала</div>

        <p className="m-0 text-[12px] leading-[1.6] text-tx2">
          Бюджет-стоп: пока месячные расходы платного канала не дошли до этой суммы, машина может
          уходить на него, когда все окна подписок закрыты. Как только дошли — перестаёт, и работа
          ждёт открытия окна. Потолок один на всю машину, а не по полосам.
        </p>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="budget-limit" className="text-[11.5px] text-tx2">
            Сколько долларов в месяц — сейчас {formatUsd(current)}
          </label>
          <input
            id="budget-limit"
            value={typed}
            autoFocus
            inputMode="decimal"
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className={`w-full rounded-[9px] border bg-input px-[11px] py-2 font-mono text-[12.5px] text-tx outline-none ${
              valid ? 'border-bd focus:border-blue' : 'border-err-tx'
            }`}
          />
          <span className="text-[11px] leading-[1.5] text-tx3">{FX_NOTE}</span>
          {valid ? null : (
            <span className="text-[11.5px] text-err-tx">
              Нужно число — сколько долларов в месяц, не меньше нуля.
            </span>
          )}
        </div>

        {valid && limit === 0 ? (
          <p className="m-0 rounded-[9px] border border-bd2 bg-warn-s px-3 py-2.5 text-[11.5px] leading-[1.55] text-warn-tx">
            Ноль — это не «без ограничения», а «платным каналом не пользоваться вовсе». Когда окна
            подписок закрыты, работа будет ждать их открытия, а не уходить за деньги.
          </p>
        ) : null}

        {problem ? <p className="m-0 text-[11.5px] leading-[1.5] text-err-tx">{problem}</p> : null}

        <div className="flex items-center justify-between gap-3 border-t border-bd pt-3">
          <span className="text-[11px] text-tx3">
            {changed ? 'Применится сразу' : 'Введите другую сумму'}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!changed || set.isPending}
              className="rounded-[8px] bg-blue px-[15px] py-1.5 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
            >
              {set.isPending ? 'Применяю…' : 'Применить'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
