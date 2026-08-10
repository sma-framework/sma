import { useState } from 'react'
import { usePipelineToggle, useStateQuery } from '../../api/queries'
import { openScreen } from '../../shell/navigation'

/**
 * StopParkZone — the red zone, moved here from «Дом системы» exactly as it was.
 *
 * ══════════════════ IT SAYS WHAT IS TRUE, NOT WHAT WOULD LOOK GOOD ══════════════════
 *
 * The design puts a big red «Остановить парк» here, and it belongs here. For a long time
 * this zone drew no button at all and said so out loud: the daemon opened no such door, and
 * a red button wired to nothing is the worst object in the product — the one a person
 * reaches for when something is going wrong, that does nothing and reports success.
 *
 * SINCE 10.08.2026 THE DOOR EXISTS AND THIS ZONE USES IT. The conveyor's own switch
 * (`POST /api/pipeline/toggle`) is what a person means by «стоп»: with it off the daemon
 * claims no new task on any machine. That is a real, immediate, reversible stop.
 *
 * WHAT IT DOES NOT DO IS SAID IN THE SAME BREATH. Sessions already running are not killed —
 * a worker mid-attempt finishes or is switched off on «Агенты», and the machine itself is
 * stopped where it runs. The old zone was right that honesty matters more than a big button;
 * the fix is not to remove the honesty, it is to add the button the honesty was missing.
 */
export function StopParkZone() {
  const state = useStateQuery()
  const toggle = usePipelineToggle()
  const [problem, setProblem] = useState<string | null>(null)

  // Absent (an older daemon) is not «off»: without an answer the zone keeps its old shape and
  // offers no switch, rather than drawing one whose state it cannot read.
  const pipeline = state.data?.rules?.pipeline
  const running = pipeline?.enabled

  const flip = (enabled: boolean) => {
    setProblem(null)
    toggle.mutate({ enabled }, { onError: () => setProblem('Не переключилось. Состояние парка осталось прежним.') })
  }

  return (
    <section className="mt-1">
      <div className="mb-2 text-[10.5px] font-semibold tracking-[0.09em] text-err-tx uppercase">Красная зона</div>
      <div className="flex items-center gap-5 rounded-[12px] border border-err-bd bg-err-s px-[18px] py-[15px]">
        <div className="flex-1">
          <div className="text-[13.5px] font-semibold text-err-tx">
            {running === false ? 'Парк остановлен' : 'Остановить парк'}
          </div>
          <div className="mt-1 max-w-[640px] text-[12.5px] leading-[1.6] text-tx2">
            {pipeline === undefined ? (
              <>
                Состояние конвейера сейчас не читается. Работу останавливают так: выключить работников по
                одному на «Агентах» — новых задач они больше не возьмут; либо остановить самого демона на
                машине, где он запущен.
              </>
            ) : running === false ? (
              <>
                Новые задачи не берутся ни на одной машине. Уже запущенные сессии этим не убиваются — их
                выключают на «Агентах» или остановкой демона.
              </>
            ) : (
              <>
                Остановка выключает конвейер: новых задач парк больше не берёт, и это сразу и обратимо. Уже
                запущенные сессии продолжат — их выключают по одной на «Агентах» либо остановкой самого демона.
              </>
            )}
            {problem ? <span className="mt-1 block text-err-tx">{problem}</span> : null}
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          {pipeline === undefined ? null : running === false ? (
            <button
              type="button"
              disabled={toggle.isPending}
              onClick={() => flip(true)}
              className="h-[31px] rounded-[8px] border border-bd px-3.5 text-[12.5px] font-semibold text-tx2 disabled:opacity-60"
            >
              Возобновить
            </button>
          ) : (
            <button
              type="button"
              disabled={toggle.isPending}
              onClick={() => flip(false)}
              className="h-[31px] rounded-[8px] border border-err-bd bg-err px-3.5 text-[12.5px] font-semibold text-white disabled:opacity-60"
            >
              Остановить парк
            </button>
          )}
          <button
            type="button"
            onClick={() => openScreen({ screen: 'agents' })}
            className="h-[31px] flex-none rounded-[8px] border border-err-bd px-3.5 text-[12.5px] font-semibold text-err-tx hover:bg-err-s"
          >
            Открыть «Агенты»
          </button>
        </div>
      </div>
    </section>
  )
}
