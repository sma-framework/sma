import { useEffect, useMemo } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { subscribeHints } from './api/hints'
import { createAppQueryClient, useOnboardingQuery } from './api/queries'
import type { QueryClient } from '@tanstack/react-query'
import { screenById } from './screens/registry'
import { Shell } from './shell/Shell'
import { ThemeProvider } from './shell/ThemeProvider'

/**
 * App — the window itself.
 *
 * Two things happen before anything is drawn: the live channel is opened, so the picture
 * moves as the work moves, and the household is asked whether it has been set up. If it
 * has not, the first run takes the whole window — a person meets the sidebar after the
 * house is theirs, not before.
 */

function Live({ queryClient }: { queryClient: QueryClient }) {
  useEffect(() => {
    const hints = subscribeHints(queryClient)
    return () => hints.close()
  }, [queryClient])
  return null
}

function Window() {
  const onboarding = useOnboardingQuery()

  // The door may not be filled in yet, or may be unreachable for a moment. Either way the
  // honest default is that the house is already set up — the window simply opens.
  const needsFirstRun = onboarding.data?.needed === true
  if (onboarding.isLoading) return null
  if (needsFirstRun) {
    const { Screen } = screenById('first-run')
    return (
      <div className="flex min-h-screen flex-col">
        <Screen />
      </div>
    )
  }
  return <Shell />
}

export function App() {
  const queryClient = useMemo(() => createAppQueryClient(), [])

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <Live queryClient={queryClient} />
        <Window />
      </QueryClientProvider>
    </ThemeProvider>
  )
}
