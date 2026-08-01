import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

/**
 * ThemeProvider — light or dark, decided once, remembered.
 *
 * Light is what opens by default: this is a working instrument for daytime work. The
 * choice is written as one attribute on the page; every colour in the window follows
 * from it, because every colour is a token and every token has both values.
 */

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'sma.theme'

interface ThemeContextValue {
  theme: Theme
  setTheme: (next: Theme) => void
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function readStored(): Theme {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored)

  useEffect(() => {
    document.documentElement.setAttribute('data-sma-theme', theme)
    try {
      window.localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      /* a browser that refuses to remember is not a reason to stop working */
    }
  }, [theme])

  const setTheme = useCallback((next: Theme) => setThemeState(next), [])
  const toggle = useCallback(() => setThemeState((cur) => (cur === 'dark' ? 'light' : 'dark')), [])

  const value = useMemo<ThemeContextValue>(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme is used outside ThemeProvider')
  return ctx
}
