import { useEffect, useRef, useState } from 'react'
import { useStateQuery } from '../api/queries'

/**
 * NotifyToggle — «скажите мне, когда что-то ждёт решения», and nothing beyond that.
 *
 * ═══════════════════ NOTHING TURNS ITSELF ON ═══════════════════════════════════════
 *
 * It is OFF until a person presses it, and pressing it is the only thing in this window that
 * asks the browser for a permission. The browser's own rule — a permission may be asked for
 * only out of a gesture — is not a limitation being worked around here; it is the same rule
 * this product keeps everywhere, and it lands in one place: the click handler below is the
 * only caller of `requestPermission` in the whole window.
 *
 * ═══════════════════ A NOTIFICATION CARRIES A NUMBER, AND NEVER A TITLE ════════════
 *
 * A system notification is drawn by the operating system, over whatever is on the screen, and
 * is often kept in a tray afterwards. Anything put in it has left this window for good. So it
 * carries HOW MANY things wait for a decision and not one word about what they are: a
 * person's own screen tells them the rest, at the moment they choose to look.
 *
 * ═══════════════════ IT WATCHES THE ONE READING, NOT A SECOND ONE ══════════════════
 *
 * The number is the same one every screen shows, off the one poll. A GROWTH in it is news; a
 * fall is somebody having dealt with something and is not worth interrupting anybody over. The
 * first reading of a session is never news either — a window opening is not an event.
 */

const STORAGE_KEY = 'sma.notify.decisions'

function supported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'on'
  } catch {
    return false
  }
}

function store(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    /* a browser that refuses to remember is not a reason to stop working */
  }
}

function BellIcon({ off }: { off: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M4.2 6.6a3.8 3.8 0 0 1 7.6 0v2.6l1 2H3.2l1-2Z" strokeLinejoin="round" />
      <path d="M6.6 12.6a1.5 1.5 0 0 0 2.8 0" strokeLinecap="round" />
      {off ? <path d="M2.6 2.6 13.4 13.4" strokeLinecap="round" /> : null}
    </svg>
  )
}

export function NotifyToggle() {
  const state = useStateQuery()
  const waiting = state.data?.kpis.awaitingApproval ?? null

  const [on, setOn] = useState(readStored)
  const [permission, setPermission] = useState<NotificationPermission | null>(
    supported() ? Notification.permission : null,
  )
  /** The number as of the previous reading. Null until there has been one. */
  const seen = useRef<number | null>(null)

  useEffect(() => {
    if (waiting === null) return
    const before = seen.current
    // Remembered whether or not anything is announced: switching this on must not fire for a
    // growth that happened while it was off.
    seen.current = waiting
    if (before === null || waiting <= before) return
    if (!on || permission !== 'granted') return
    try {
      // The body is the count. Nothing else about the work travels here — see the header.
      new Notification('SMA', {
        body: `Ждут решения: ${waiting}`,
        tag: 'sma-awaiting-decision',
      })
    } catch {
      /* a browser that refuses to draw it is not a reason to lose the picture */
    }
  }, [waiting, on, permission])

  if (!supported()) return null

  const press = () => {
    if (on) {
      setOn(false)
      store(false)
      return
    }
    const current = Notification.permission
    if (current === 'granted') {
      setPermission('granted')
      setOn(true)
      store(true)
      return
    }
    if (current === 'denied') {
      // The browser will not ask again; saying so is the whole of what is left to do.
      setPermission('denied')
      return
    }
    void Notification.requestPermission().then((answer) => {
      setPermission(answer)
      if (answer !== 'granted') return
      setOn(true)
      store(true)
    })
  }

  const denied = permission === 'denied'
  const label = denied ? 'Уведомления запрещены браузером' : on ? 'Уведомляю о решениях' : 'Уведомлять о решениях'

  return (
    <button
      type="button"
      onClick={press}
      aria-pressed={on}
      title={
        denied
          ? 'Разрешение выдаётся в настройках сайта в браузере'
          : 'Локальное уведомление, когда число ждущих решения выросло. В нём только число.'
      }
      className="flex h-[31px] w-full items-center gap-[11px] rounded-lg px-2.5 text-left text-[12.5px] font-medium text-side-tx2 hover:bg-side-hover hover:text-side-tx"
    >
      <BellIcon off={!on} />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}
