import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useSearchQuery } from '../api/queries'
import { SCREENS } from '../screens/registry'
import type { SearchHit } from '../api/types'
import { openScreen } from './navigation'
import { PALETTE_ACTIONS } from './palette-actions'
import { KindBadge, SEARCH_DEBOUNCE_MS, SEARCH_Q_CAP, openHit } from './search-hits'

/**
 * Palette — everything in this window, from the keyboard. Ctrl+P, or ⌘P.
 *
 * ═══════════════════════ WHAT IT IS ALLOWED TO BE ═══════════════════════════════
 *
 * A place to FIND and a place to GO, and — deliberately — not a place to act behind the
 * screens' backs. Every entry of its list of acts opens the button that performs the act;
 * the reasoning is written out in palette-actions.ts, which is also the only place the list
 * can grow. Nothing here reaches the api layer except through the one search hook the screen
 * «Поиск» uses; there is no client function in this file.
 *
 * ═══════════════════════ THREE LISTS, IN THE ORDER THEY PAY OFF ═════════════════
 *
 *   Экраны — matched against the window's OWN registry. That is not a second copy of the
 *     daemon's list of screens: it is the list this window is built from, it is instant, and
 *     it keeps the fastest thing a palette does working when the search door is unreachable.
 *     Because of it, hits of kind «экран» from the daemon are left out below — the same
 *     screen twice in one list is a list a person stops trusting.
 *   Действия — the static list, filtered by what was typed.
 *   Найдено — the daemon's answer, in the order the daemon gave it. A palette is one column a
 *     hand walks down with an arrow key, so the hits stay flat here; the screen «Поиск», where
 *     they are read rather than jumped from, groups them.
 *
 * ═══════════════════════ THE KEY, AND WHOSE KEY IT IS ═══════════════════════════
 *
 * The shortcut is read off the physical key (`code`), not off the letter the layout produces,
 * so it works on a Cyrillic layout — where Ctrl+P types «з» — without a second rule. It does
 * NOT fire while a person is typing into a field: a text box's own Ctrl+P belongs to the text
 * box. The one exception is the palette's own field, where the shortcut closes what it opened.
 *
 * WHY NOT Ctrl+K, WHICH THIS WAS. The floating conversation window owns Ctrl+K now: the
 * founder's design draws that key on the conversation, and a key cannot belong to two things
 * — whichever mounted second would silently win, and which one that is depends on the order
 * React happened to mount them in. So there is exactly ONE owner per combination, written
 * down in both files: the palette matches KeyP and nothing else, the conversation matches
 * KeyK and nothing else. Ctrl+P is the browser's print key on this page; taking it is
 * deliberate — a window that is not a document has nothing to print, and the founder chose
 * the pair.
 */

/** What was typed, once the typing has stopped. */
function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** Is the person typing into something right now? */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

interface Row {
  key: string
  title: string
  hint: string
  badge: ReactNode
  /** Move the window. Answers false when the hit points at nothing this window can open. */
  go: () => boolean
}

/** The screens a person may be sent to from here: the ones with a line in the sidebar. */
const NAVIGABLE = SCREENS.filter((s) => s.group !== null)

function matches(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle)
}

export function Palette() {
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [cursor, setCursor] = useState(0)

  const asked = useDebounced(question, SEARCH_DEBOUNCE_MS)
  // Closed, the palette asks nothing at all: the hook makes no request for an empty question.
  const found = useSearchQuery(open ? asked : '')

  const panelRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const activeRef = useRef<HTMLButtonElement | null>(null)
  /** Whatever had the focus before the palette took it, so it can be given back. */
  const cameFrom = useRef<HTMLElement | null>(null)

  const close = () => setOpen(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isP = e.code === 'KeyP' || e.key === 'p' || e.key === 'P'
      if ((e.ctrlKey || e.metaKey) && isP) {
        const insidePalette = panelRef.current?.contains(e.target as Node) ?? false
        if (isTypingTarget(e.target) && !insidePalette) return
        e.preventDefault()
        setOpen((was) => !was)
        return
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault()
        close()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // A palette opens on a blank question: it is asked something new every time, and the answer
  // to the last thing somebody looked for is not what the next person means to see.
  useEffect(() => {
    if (open) {
      cameFrom.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setQuestion('')
      setCursor(0)
      inputRef.current?.focus()
      return
    }
    cameFrom.current?.focus()
    cameFrom.current = null
  }, [open])

  const needle = question.trim().toLowerCase()

  const screenRows: Row[] = useMemo(() => {
    if (needle === '') return []
    return NAVIGABLE.filter((s) => matches(s.title, needle)).map((s) => ({
      key: `screen:${s.id}`,
      title: s.title,
      hint: 'открыть экран',
      badge: <span className="flex-none rounded-full bg-blue-s px-2 py-[2px] text-[10.5px] text-blue">экран</span>,
      go: () => {
        openScreen({ screen: s.id })
        return true
      },
    }))
  }, [needle])

  const actionRows: Row[] = useMemo(
    () =>
      PALETTE_ACTIONS.filter((a) => needle === '' || matches(a.title, needle) || matches(a.hint, needle)).map((a) => ({
        key: `action:${a.id}`,
        title: a.title,
        hint: a.hint,
        badge: (
          <span className="flex-none rounded-full bg-ok-s px-2 py-[2px] text-[10.5px] text-ok-tx">действие</span>
        ),
        go: () => {
          // Every door of the static list is a screen today; the hook door is declared for the
          // day an act qualifies for it, and its reasoning lives beside the list.
          if (a.door.via === 'screen') {
            openScreen({ screen: a.door.screen, opens: a.door.opens })
            return true
          }
          return false
        },
      })),
    [needle],
  )

  const hitRows: Row[] = useMemo(() => {
    const hits: SearchHit[] = found.data?.hits ?? []
    // Screens are answered above out of this window's own registry — see the header.
    return hits
      .filter((h) => h.kind !== 'screen')
      .map((h, i) => ({
        key: `hit:${i}:${h.kind}:${h.title}`,
        title: h.title,
        hint: h.hint,
        badge: <KindBadge kind={h.kind} />,
        go: () => openHit(h),
      }))
  }, [found.data])

  const rows = useMemo(() => [...screenRows, ...actionRows, ...hitRows], [screenRows, actionRows, hitRows])

  // A new question is a new list, and the hand starts at the top of it.
  useEffect(() => setCursor(0), [needle, found.data])

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [cursor, rows.length])

  const run = (row: Row | undefined) => {
    if (!row) return
    if (row.go()) close()
  }

  const onPanelKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (rows.length === 0 ? 0 : (c + 1) % rows.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (rows.length === 0 ? 0 : (c - 1 + rows.length) % rows.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      run(rows[cursor])
      return
    }
    if (e.key === 'Tab') {
      // The focus stays inside: a palette a person can tab out of while it covers the window
      // is a palette that leaves them typing into something they cannot see.
      const panel = panelRef.current
      if (!panel) return
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>('input, button, [href], textarea, select, [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => !el.hasAttribute('disabled'))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  if (!open) return null

  const askedSomething = needle !== ''
  const nothing = askedSomething && rows.length === 0 && !found.isFetching

  /**
   * The three lists are drawn in the order they are concatenated in `rows`, so a section knows
   * where its own rows sit in the one list the arrow keys walk: the length of everything above
   * it. The offset is passed in rather than counted during the render — a counter mutated while
   * drawing is a number nobody can check by reading one line.
   */
  const section = (label: string, list: Row[], offset: number) =>
    list.length === 0 ? null : (
      <div key={label} className="border-t border-bd first:border-t-0">
        <div className="px-[18px] pt-3 pb-1.5 text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">
          {label}
        </div>
        {list.map((row, i) => {
          const index = offset + i
          const active = index === cursor
          return (
            <button
              key={row.key}
              type="button"
              ref={active ? activeRef : undefined}
              onMouseEnter={() => setCursor(index)}
              onClick={() => run(row)}
              className={`flex w-full items-baseline gap-2.5 px-[18px] py-2 text-left ${active ? 'bg-surf' : ''}`}
            >
              {row.badge}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-tx">{row.title}</span>
                <span className="block truncate text-[11px] text-tx3">{row.hint}</span>
              </span>
            </button>
          )
        })}
      </div>
    )

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-scrim p-6 pt-[12vh]"
      onClick={close}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Поиск и действия"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onPanelKey}
        className="flex max-h-[70vh] w-[620px] flex-col overflow-hidden rounded-[14px] border border-bd2 bg-card shadow-menu"
      >
        <div className="flex-none border-b border-bd px-[18px] py-3">
          <input
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={SEARCH_Q_CAP}
            placeholder="Что найти или что сделать"
            aria-label="Что найти или что сделать"
            className="w-full bg-transparent text-[14px] text-tx outline-none placeholder:text-tx3"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {section('Экраны', screenRows, 0)}
          {section('Действия', actionRows, screenRows.length)}
          {section('Найдено', hitRows, screenRows.length + actionRows.length)}

          {found.isFetching && askedSomething ? (
            <p className="m-0 border-t border-bd px-[18px] py-2.5 text-[11.5px] text-tx3">Ищу…</p>
          ) : null}

          {found.isError && askedSomething ? (
            <p className="m-0 border-t border-bd px-[18px] py-2.5 text-[11.5px] leading-[1.5] text-tx2">
              Поиск по проекту сейчас не отвечает. Экраны и действия выше — свои, они работают.
            </p>
          ) : null}

          {nothing ? (
            <p className="m-0 border-t border-bd px-[18px] py-2.5 text-[11.5px] text-tx2">Ничего не нашлось.</p>
          ) : null}
        </div>

        <div className="flex flex-none items-center justify-between gap-3 border-t border-bd px-[18px] py-2 text-[11px] text-tx3">
          <span>Ctrl P — поиск и действия · ↑ ↓ — выбрать · Enter — открыть · Esc — закрыть</span>
          <span>Действия открывают ту же кнопку на экране</span>
        </div>
      </div>
    </div>
  )
}
