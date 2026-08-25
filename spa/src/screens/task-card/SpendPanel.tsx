import type { SubApiSwitch, TokenSums } from '../../api/types'
import { spendReasons, spendRows } from './spend'

/**
 * Расход задачи на экране. Порядок, слова и то, где стоит прочерк вместо числа, — из
 * `spend.ts`, где это проверяется прогоном; здесь только показ.
 */
export function SpendPanel({
  tokens,
  session,
  spendSwitch,
}: {
  tokens?: TokenSums | null
  session?: string | null
  spendSwitch?: SubApiSwitch | null
}) {
  const rows = spendRows({ tokens, session, spendSwitch })
  const reasons = spendReasons(rows)

  return (
    <section data-testid="task-spend" className="rounded-[12px] border border-bd bg-card px-[15px] py-3.5">
      <div className="text-[12px] font-semibold text-tx">Расход</div>
      <div className="mt-2 flex flex-col gap-1.5">
        {rows.map((r) => (
          <div key={r.key} className="flex justify-between gap-3 text-[11.5px]">
            <span className="min-w-0 text-tx2">{r.label}</span>
            <span className={`flex-none text-right font-mono tabular-nums ${r.known ? 'text-tx' : 'text-tx3'}`}>
              {r.value}
            </span>
          </div>
        ))}
      </div>
      {reasons.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          {reasons.map((why) => (
            <p key={why} className="m-0 text-[10.5px] leading-[1.4] text-tx3">
              {why}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  )
}
