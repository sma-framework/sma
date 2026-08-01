import { useState } from 'react'
import { useStateQuery } from '../api/queries'
import { HOME_SCREEN, screenById } from '../screens/registry'
import type { ScreenId } from '../screens/registry'
import { HubBanner } from './HubBanner'
import { Sidebar } from './Sidebar'

/**
 * Shell — the frame every screen lives in: the sidebar on the left, one screen on the
 * right, and the quiet line above it when the household is not all there.
 *
 * The window is made for a working screen — a wide desktop, one thing at a time, no
 * folding and no shrinking. A smaller screen is its own piece of work, taken up on its
 * own terms rather than smuggled in as a breakpoint.
 */
export function Shell() {
  const [active, setActive] = useState<ScreenId>(HOME_SCREEN)
  const state = useStateQuery()
  const { Screen } = screenById(active)

  return (
    <div className="flex min-h-screen">
      <Sidebar active={active} onOpen={setActive} />
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="h-0.5 bg-gradient-to-r from-[#243B66] via-[#1B7E9C] to-[#74DBA0]" />
        <HubBanner federation={state.data?.federation} />
        <Screen />
      </main>
    </div>
  )
}
