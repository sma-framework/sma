import { useEffect, useState } from 'react'
import { useStateQuery } from '../api/queries'
import { HOME_SCREEN, screenById } from '../screens/registry'
import type { ScreenId } from '../screens/registry'
import { HubBanner } from './HubBanner'
import { OPEN_SCREEN_EVENT, OpenedWithProvider, readOpenScreen } from './navigation'
import type { OpenScreenDetail } from './navigation'
import { Palette } from './Palette'
import { Sidebar } from './Sidebar'

/**
 * Shell — the frame every screen lives in: the sidebar on the left, one screen on the
 * right, and the quiet line above it when the household is not all there.
 *
 * It is also the ONE thing that moves the window. A screen that wants another screen says
 * so (see navigation) and the shell hears it here: it switches, and it hands the target
 * screen what it was opened with — the task behind «Открыть карточку», for instance. A
 * screen opened from the sidebar is opened with nothing, which is how a screen tells the
 * difference between «show me this task» and «show me this screen».
 *
 * The window is made for a working screen — a wide desktop, one thing at a time, no
 * folding and no shrinking. A smaller screen is its own piece of work, taken up on its
 * own terms rather than smuggled in as a breakpoint.
 */
export function Shell() {
  const [active, setActive] = useState<ScreenId>(HOME_SCREEN)
  const [openedWith, setOpenedWith] = useState<OpenScreenDetail | null>(null)
  const state = useStateQuery()
  const { Screen } = screenById(active)

  useEffect(() => {
    const onAsked = (e: Event) => {
      const asked = readOpenScreen(e)
      if (!asked) return
      setActive(asked.screen)
      setOpenedWith(asked)
    }
    window.addEventListener(OPEN_SCREEN_EVENT, onAsked)
    return () => window.removeEventListener(OPEN_SCREEN_EVENT, onAsked)
  }, [])

  const openFromSidebar = (id: ScreenId) => {
    setActive(id)
    setOpenedWith(null)
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar active={active} onOpen={openFromSidebar} />
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="h-0.5 bg-gradient-to-r from-[#243B66] via-[#1B7E9C] to-[#74DBA0]" />
        <HubBanner federation={state.data?.federation} />
        <OpenedWithProvider value={openedWith}>
          <Screen />
        </OpenedWithProvider>
      </main>
      {/*
        The palette lives HERE and not inside a screen, for the same reason the shell owns the
        move between screens: it is a way to every screen at once, and it listens for its key
        whichever screen is on the glass. It is drawn last so it covers what it is over, and it
        draws nothing at all until it is asked for.
      */}
      <Palette />
    </div>
  )
}
