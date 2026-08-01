import { openScreen } from '../../shell/navigation'

/**
 * StopParkZone — the red zone, moved here from «Дом системы» exactly as it was.
 *
 * ══════════════════ IT SAYS WHAT IS TRUE, NOT WHAT WOULD LOOK GOOD ══════════════════
 *
 * The design puts a big red «Остановить парк» here, and it belongs here. The daemon's list
 * of addresses is closed and frozen, and it contains NO such switch — so this window has no
 * honest way to press one. A red button wired to nothing would be the worst object in the
 * whole product: the one a person reaches for when something is going wrong, that does
 * nothing and says it succeeded.
 *
 * So the zone shows the two ways the park can actually be stopped today, both of them real:
 * switch the workers off one at a time on «Агенты» (a door that exists and answers), or
 * stop the daemon itself where it runs. When the park switch does open as a door, this
 * component is where it lands — the zone is already in the right place, with the right
 * words around it.
 */
export function StopParkZone() {
  return (
    <section className="mt-1">
      <div className="mb-2 text-[10.5px] font-semibold tracking-[0.09em] text-err-tx uppercase">Красная зона</div>
      <div className="flex items-center gap-5 rounded-[12px] border border-err-bd bg-err-s px-[18px] py-[15px]">
        <div className="flex-1">
          <div className="text-[13.5px] font-semibold text-err-tx">Остановить парк</div>
          <div className="mt-1 max-w-[640px] text-[12.5px] leading-[1.6] text-tx2">
            Одного выключателя на весь парк в окне пока нет — демон не открывает такой двери, и рисовать
            кнопку, которая ничего не делает, здесь нельзя. Работу останавливают так: выключить работников по
            одному на «Агентах» — новых задач они больше не возьмут; либо остановить самого демона на машине,
            где он запущен.
          </div>
        </div>
        <button
          type="button"
          onClick={() => openScreen({ screen: 'agents' })}
          className="h-[31px] flex-none rounded-[8px] border border-err-bd px-3.5 text-[12.5px] font-semibold text-err-tx hover:bg-err-s"
        >
          Открыть «Агенты»
        </button>
      </div>
    </section>
  )
}
