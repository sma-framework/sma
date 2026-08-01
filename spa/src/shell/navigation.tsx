import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { SCREENS } from '../screens/registry'
import type { ScreenId } from '../screens/registry'

/**
 * navigation — how one screen asks the window to open another, and how the screen that
 * opens learns what it was opened WITH.
 *
 * ═══════════════════════ A SCREEN ASKS, THE SHELL MOVES ═══════════════════════
 *
 * A screen never moves the window itself: it says out loud «open this one, with this task»
 * and the shell — the only thing that knows which screen is on the glass — hears it and
 * moves. That is what keeps a screen from reaching into the shell's state or into a
 * neighbour's, and it is why this small mechanism lives here rather than inside whichever
 * screen happened to need it first.
 *
 * The name of the screen is taken from the registry's own type, so a screen that does not
 * exist cannot be asked for. The event is checked again when it arrives: it travels through
 * the window object, which anything on the page can shout into, so the shell trusts the
 * registry rather than the sender.
 */

export const OPEN_SCREEN_EVENT = 'sma:open-screen'

export interface OpenScreenDetail {
  screen: ScreenId
  /** The task the target screen is to open on, when the target screen is about one task. */
  taskId?: string
}

/** Ask the window for another screen. The shell is what hears this. */
export function openScreen(detail: OpenScreenDetail): void {
  window.dispatchEvent(new CustomEvent<OpenScreenDetail>(OPEN_SCREEN_EVENT, { detail }))
}

/**
 * The request as the shell is willing to read it: an unknown screen name is not a screen,
 * and anything that is not a string is not a task id. A malformed request is simply
 * ignored — the window stays where it is.
 */
export function readOpenScreen(e: Event): OpenScreenDetail | null {
  const detail = (e as CustomEvent<OpenScreenDetail>).detail
  if (!detail || typeof detail !== 'object') return null
  if (!SCREENS.some((s) => s.id === detail.screen)) return null
  return { screen: detail.screen, taskId: typeof detail.taskId === 'string' ? detail.taskId : undefined }
}

const OpenedWith = createContext<OpenScreenDetail | null>(null)

/**
 * The shell puts the request that brought the current screen up in here, so the screen can
 * read it without the registry having to grow a prop for every screen that wants one.
 */
export function OpenedWithProvider({ value, children }: { value: OpenScreenDetail | null; children: ReactNode }) {
  return <OpenedWith.Provider value={value}>{children}</OpenedWith.Provider>
}

/** What the screen on the glass was opened with — nothing, when it was opened from the sidebar. */
export function useOpenedWith(): OpenScreenDetail | null {
  return useContext(OpenedWith)
}
