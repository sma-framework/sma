import type { Federation } from '../api/types'

/**
 * HubBanner — the quiet line that appears when the main machine cannot be reached.
 *
 * The window runs on every machine, so a person may be looking at one of them directly
 * while the main machine is down. Nothing breaks: this machine still shows its own work
 * in full. The line only says what is NOT on screen, so a smaller list is never mistaken
 * for a quiet night.
 *
 * It appears only once something has actually failed to reach the main machine. An
 * unproven suspicion is not worth alarming anyone with.
 */
export function HubBanner({ federation }: { federation: Federation | undefined }) {
  if (!federation) return null
  if (federation.role !== 'peer' || federation.hubReachable) return null

  return (
    <div className="flex items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
      <span aria-hidden className="text-warn-tx">
        ●
      </span>
      <span className="text-[12.5px] text-tx">
        Главная машина недоступна. Пока видна только эта машина.
      </span>
    </div>
  )
}
