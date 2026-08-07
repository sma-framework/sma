import { useState } from 'react'
import { useMemoryIndex, useMemoryLintQuery } from '../../api/queries'
import type { MemoryLintFinding, MemoryLintReport } from '../../api/types'
import { CardHead, corpusWords } from './shared'

/**
 * «Линт» и «Оглавление» — what the corpus's own checker says about it, and the one button that
 * rewrites the generated part of it.
 *
 * ═════════════════ THE COUNTS ARE THE TRUTH; THE LIST IS AS MUCH AS FITS ═════════════════
 *
 * The report carries two numbers and a BOUNDED list of findings, and it says out loud when the
 * list was cut. So the table below counts the findings it was given, and when the report is
 * truncated the panel says which number is which — a bounded list beside an unbounded total,
 * shown without a word about it, reads as an arithmetic bug in a screen that is otherwise
 * telling the truth.
 *
 * A finding names a NOTE, never a path. That is the door's law, not this panel's — the daemon
 * takes the last segment on the way out — and this side simply never asks for more.
 *
 * ══════════════════ THE INDEX IS GENERATED, AND THIS BUTTON IS THAT SENTENCE ══════════════
 *
 * The corpus index is written by a generator and never by hand; the linter has a check that
 * says so. The button is the other half of that rule — it runs the project's own regeneration,
 * in the project, and shows the receipt of what was written.
 *
 * It ASKS FIRST, and the question names the cost rather than hiding it: regeneration overwrites
 * the generated index. If somebody has edited that file by hand — which is exactly what the
 * check above complains about — those edits are what the rebuild replaces. That is very likely
 * the wanted behaviour, and it is still not a thing to discover after pressing.
 */

/** One rule, and how many notes it fired on. */
interface RuleRow {
  rule: string
  severity: 'critical' | 'warning'
  count: number
  /**
   * The checker's own sentence, taken from the first finding of this rule. It rides the payload
   * as `note` and the note's NAME rides as `file` — the door's own spelling, transcribed rather
   * than argued with.
   */
  message: string
  /** The notes it named, as names. */
  notes: string[]
}

/** How many note names one rule shows before it starts counting the rest. */
const NOTES_SHOWN = 4

/**
 * The findings in hand, grouped by the rule that raised them. Insertion order is kept, so the
 * table reads in the order the checker reported — this panel introduces no ranking of its own.
 */
export function groupByRule(findings: MemoryLintFinding[]): RuleRow[] {
  const byRule = new Map<string, RuleRow>()
  for (const f of findings) {
    const found = byRule.get(f.rule)
    if (found) {
      found.count += 1
      if (f.file) found.notes.push(f.file)
      continue
    }
    byRule.set(f.rule, {
      rule: f.rule,
      severity: f.severity,
      count: 1,
      message: f.note ?? '',
      notes: f.file ? [f.file] : [],
    })
  }
  return [...byRule.values()]
}

function RuleLine({ row, first }: { row: RuleRow; first: boolean }) {
  const shown = row.notes.slice(0, NOTES_SHOWN)
  const rest = row.notes.length - shown.length
  return (
    <div className={`flex flex-col gap-1 px-[18px] py-[11px] ${first ? '' : 'border-t border-bd'}`}>
      <div className="flex min-w-0 items-baseline gap-3">
        <span
          className={`flex-none rounded-full px-2 py-[2px] text-[10px] whitespace-nowrap ${
            row.severity === 'critical' ? 'bg-err-s text-err-tx' : 'bg-warn-s text-warn-tx'
          }`}
        >
          {row.severity === 'critical' ? 'критично' : 'предупреждение'}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-tx" title={row.rule}>
          {row.rule}
        </span>
        <span className="flex-none text-[12.5px] font-semibold text-tx tabular-nums">{row.count}</span>
      </div>
      {row.message ? <span className="text-[11.5px] leading-[1.5] text-tx2">{row.message}</span> : null}
      {shown.length > 0 ? (
        <span className="text-[11px] leading-[1.5] text-tx3">
          {shown.join(' · ')}
          {rest > 0 ? ` · и ещё ${rest}` : ''}
        </span>
      ) : null}
    </div>
  )
}

function LintBody({ report }: { report: MemoryLintReport }) {
  const rows = groupByRule(report.findings ?? [])
  if (rows.length === 0) {
    return (
      <p className="m-0 border-t border-bd px-[18px] py-4 text-[12.5px] text-tx2">
        Проверка ничего не нашла — корпус в порядке.
      </p>
    )
  }
  return (
    <>
      {rows.map((row, i) => (
        <RuleLine key={row.rule} row={row} first={i === 0} />
      ))}
      {report.truncated ? (
        <div className="border-t border-bd bg-surf px-[18px] py-2.5 text-[11.5px] leading-[1.5] text-tx3">
          Список показан не целиком. Числа наверху — по всему корпусу; в таблице сосчитано
          столько, сколько поместилось.
        </div>
      ) : null}
    </>
  )
}

/**
 * What the corpus's own checker says, and a way to ask it again.
 *
 * Mounted only while a project is connected, so it takes no «enabled» of its own — the read
 * starts when the panel appears and stops when it goes.
 */
export function LintPanel() {
  const lint = useMemoryLintQuery()
  const report = lint.data

  return (
    <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
      <CardHead
        title="Проверка корпуса"
        note={
          report
            ? `критично ${report.critical} · предупреждений ${report.warnings}`
            : undefined
        }
      />
      <div className="flex flex-wrap items-center gap-3 px-[18px] py-[13px]">
        <span className="min-w-0 flex-1 text-[12.5px] leading-[1.5] text-tx">
          Что о корпусе говорит его собственная проверка: какие правила нарушены и в скольких
          записях.
        </span>
        <button
          type="button"
          onClick={() => void lint.refetch()}
          disabled={lint.isFetching}
          className="flex-none rounded-[8px] border border-bd bg-card px-3 py-1 text-[11.5px] font-semibold text-tx disabled:opacity-60"
        >
          {lint.isFetching ? 'Проверяю…' : 'Обновить'}
        </button>
      </div>

      {lint.isLoading ? (
        <p className="m-0 border-t border-bd px-[18px] py-4 text-[12.5px] text-tx2">Проверяю корпус…</p>
      ) : lint.isError ? (
        <p className="m-0 border-t border-bd px-[18px] py-4 text-[12.5px] text-tx2">
          Проверка сейчас не отвечает. На сам корпус это не влияет — он лежит файлами в проекте.
        </p>
      ) : report ? (
        <LintBody report={report} />
      ) : null}
    </div>
  )
}

/** The generated index, and the one button that rewrites it. */
export function IndexPanel() {
  const rebuild = useMemoryIndex()
  const [asking, setAsking] = useState(false)
  const [receipt, setReceipt] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const run = () => {
    setProblem(null)
    rebuild.mutate(undefined, {
      onSuccess: (result) => {
        setAsking(false)
        setReceipt(result?.receipt ?? null)
      },
      onError: (err) => {
        setAsking(false)
        setProblem(corpusWords(err, 'Пересобрать не удалось. Оглавление осталось прежним.'))
      },
    })
  }

  return (
    <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
      <CardHead title="Оглавление" />
      <div className="flex flex-col gap-2 px-[18px] py-[13px]">
        <span className="text-[12.5px] leading-[1.5] text-tx">
          Короткая выжимка, которую команда читает перед каждой работой. Её собирает машина — не
          рука.
        </span>
        <button
          type="button"
          onClick={() => setAsking(true)}
          className="w-fit rounded-[8px] border border-bd bg-card px-3 py-1 text-[11.5px] font-semibold text-tx disabled:opacity-60"
        >
          Пересобрать оглавление
        </button>
        {receipt ? (
          <span className="font-mono text-[11px] break-all text-ok-tx">Готово · {receipt}</span>
        ) : null}
        {problem ? <span className="text-[11.5px] leading-[1.5] text-warn-tx">{problem}</span> : null}
      </div>

      {asking ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-scrim p-6"
          onClick={() => setAsking(false)}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Пересобрать оглавление"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setAsking(false)
            }}
            className="flex w-[420px] flex-col gap-3.5 rounded-[13px] border border-bd2 bg-card p-[18px] shadow-menu"
          >
            <div className="text-[13.5px] font-semibold text-tx">Пересобрать оглавление?</div>
            <p className="m-0 text-[12px] leading-[1.6] text-tx2">
              Оглавление будет собрано заново по записям проекта. Если этот файл кто-то правил
              руками, правки заменятся собранным заново — сами записи при этом не меняются.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAsking(false)}
                className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
              >
                Нет
              </button>
              <button
                type="button"
                onClick={run}
                disabled={rebuild.isPending}
                className="rounded-[8px] bg-blue px-[15px] py-1.5 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
              >
                {rebuild.isPending ? 'Собираю…' : 'Да, пересобрать'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
