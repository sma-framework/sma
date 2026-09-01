import type { ReactNode } from 'react'
import { navScreens } from '../screens/registry'
import type { ScreenId } from '../screens/registry'
import { NotifyToggle } from './NotifyToggle'
import { ProjectSelector } from './ProjectSelector'
import { useTheme } from './ThemeProvider'

/**
 * Sidebar — the one place a person moves around from.
 *
 * The order of the lines is the order of a working day: what is happening now, then the
 * work itself, then the people, then the flow, then the conversation, then the money and
 * the rules. Everything that is set up once and rarely touched sits below, under its own
 * heading.
 *
 * The lines that came with the conveyor of phases sit at the end of the upper group rather
 * than among the older ones: adding a screen must not quietly move the line a person's hand
 * already knows the position of.
 *
 * The project switcher sits at the very top, under the mark, because it governs
 * everything below it. The settings group ends with «Машины и проекты»: the same line
 * that used to be about this computer alone now covers every machine in the household
 * and every project on them, which is what a person actually goes there to look at.
 *
 * The sidebar is dark in both themes: it is the frame around the work, not part of it.
 */

const ICONS: Record<ScreenId, ReactNode> = {
  today: (
    <>
      <rect x="2.5" y="3" width="11" height="10.5" rx="2" />
      <path d="M2.5 6.2h11M5.6 2v2.2M10.4 2v2.2" />
    </>
  ),
  tasks: <path d="M6.4 4.2h7.1M6.4 8h7.1M6.4 11.8h7.1M2.6 4.2h.01M2.6 8h.01M2.6 11.8h.01" strokeLinecap="round" />,
  team: (
    <>
      <circle cx="6" cy="6.4" r="2.6" />
      <circle cx="11.4" cy="7" r="2" />
      <path d="M1.9 13.4c.5-2.2 2.2-3.4 4.1-3.4s3.6 1.2 4.1 3.4M11.6 10.4c1.4.2 2.4 1.3 2.7 3" />
    </>
  ),
  'live-stream': <path d="M1.8 8h2.4l1.6-4 2.4 8 1.7-4h4.3" strokeLinecap="round" />,
  chat: (
    <>
      <path d="M13.4 9.6c0 .9-.7 1.6-1.6 1.6H6.2L3 13.6V4.4c0-.9.7-1.6 1.6-1.6h7.2c.9 0 1.6.7 1.6 1.6Z" />
      <path d="M6 6.6h4.4M6 8.9h2.8" strokeLinecap="round" />
    </>
  ),
  costs: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 5v6M6.3 6.6h3.4M6.3 9.4h3.4" strokeLinecap="round" />
    </>
  ),
  rules: (
    <>
      <rect x="3" y="2.4" width="10" height="11.2" rx="2" />
      <path d="M5.6 5.8h4.8M5.6 8.4h4.8M5.6 11h2.6" strokeLinecap="round" />
    </>
  ),
  // The lines the release added, in the registry's own order. Each glyph says what the screen
  // IS rather than what it does: a tray of things not started, two claims over the same
  // ground, a lens, a way out, and the machine itself.
  backlog: (
    <>
      <path d="M2.4 9.2 4.3 3.6h7.4l1.9 5.6v2.8a1.6 1.6 0 0 1-1.6 1.6H4a1.6 1.6 0 0 1-1.6-1.6Z" />
      <path d="M2.4 9.2h3l1 1.8h3.2l1-1.8h3" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  coordination: (
    <>
      <circle cx="6.2" cy="8" r="4" />
      <circle cx="9.8" cy="8" r="4" />
    </>
  ),
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="4.4" />
      <path d="M10.5 10.5 13.8 13.8" strokeLinecap="round" />
    </>
  ),
  ship: (
    <>
      <path d="M8 2.6v7.4M5.2 5.4 8 2.6l2.8 2.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.8 10.6v1.4a1.6 1.6 0 0 0 1.6 1.6h7.2a1.6 1.6 0 0 0 1.6-1.6v-1.4" />
    </>
  ),
  agents: (
    <>
      <rect x="2.6" y="2.8" width="10.8" height="4.4" rx="1.8" />
      <rect x="2.6" y="8.8" width="10.8" height="4.4" rx="1.8" />
    </>
  ),
  skills: <rect x="4.3" y="4.3" width="7.4" height="7.4" rx="1.6" transform="rotate(45 8 8)" />,
  memory: (
    <>
      <ellipse cx="8" cy="4.2" rx="4.9" ry="2" />
      <path d="M3.1 4.2v7.6c0 1.1 2.2 2 4.9 2s4.9-.9 4.9-2V4.2M3.1 8c0 1.1 2.2 2 4.9 2s4.9-.9 4.9-2" />
    </>
  ),
  accounts: (
    <>
      <circle cx="8" cy="5.6" r="2.8" />
      <path d="M2.8 13.6c.6-2.6 2.6-4 5.2-4s4.6 1.4 5.2 4" />
    </>
  ),
  connections: (
    <>
      <circle cx="4.2" cy="11.6" r="2.2" />
      <circle cx="11.8" cy="4.4" r="2.2" />
      <path d="M5.9 10 10.1 6" />
    </>
  ),
  machines: (
    <>
      <rect x="2" y="3" width="12" height="8" rx="1.8" />
      <path d="M6 13.4h4" strokeLinecap="round" />
    </>
  ),
  // Две машины и пунктир между ними: связь, которой ещё нет, пока её не поднял человек.
  'remote-access': (
    <>
      <rect x="1.6" y="4.6" width="4.6" height="6.8" rx="1.4" />
      <rect x="9.8" y="4.6" width="4.6" height="6.8" rx="1.4" />
      <path d="M6.9 8h.001M8.1 8h.001M9.3 8h.001" strokeLinecap="round" />
    </>
  ),
  system: (
    <>
      <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.4" />
      <path
        d="M6.6 2v2.4M9.4 2v2.4M6.6 11.6V14M9.4 11.6V14M2 6.6h2.4M2 9.4h2.4M11.6 6.6H14M11.6 9.4H14"
        strokeLinecap="round"
      />
    </>
  ),
  'task-card': null,
  'import-wizard': null,
  'first-run': null,
}

function NavIcon({ id }: { id: ScreenId }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      {ICONS[id]}
    </svg>
  )
}

function NavItem({
  id,
  title,
  active,
  onOpen,
}: {
  id: ScreenId
  title: string
  active: boolean
  onOpen: (id: ScreenId) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      aria-current={active ? 'page' : undefined}
      className={
        active
          ? 'flex h-[33px] w-full items-center gap-[11px] rounded-lg bg-side-act px-2.5 text-left text-[13px] font-semibold text-white shadow-[inset_2px_0_0_var(--color-green)]'
          : 'flex h-[33px] w-full items-center gap-[11px] rounded-lg px-2.5 text-left text-[13px] font-medium text-side-tx2 hover:bg-side-hover hover:text-side-tx'
      }
    >
      <NavIcon id={id} />
      <span>{title}</span>
    </button>
  )
}

export function Sidebar({ active, onOpen }: { active: ScreenId; onOpen: (id: ScreenId) => void }) {
  const { theme, toggle } = useTheme()

  return (
    <aside className="sticky top-0 flex h-screen w-[248px] flex-none flex-col border-r border-side-bd bg-side">
      <div className="flex items-center gap-2.5 px-4 pt-[18px] pb-3.5">
        <svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden>
          <defs>
            <linearGradient id="smaMark" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#3B82F6" />
              <stop offset=".52" stopColor="#1FA0A6" />
              <stop offset="1" stopColor="#3CC0A0" />
            </linearGradient>
          </defs>
          <rect x="7.6" y="7.2" width="11.4" height="3" rx="1.5" fill="url(#smaMark)" />
          <rect x="3" y="11.2" width="18" height="3" rx="1.5" fill="url(#smaMark)" />
          <rect x="5.4" y="15.2" width="11.4" height="3" rx="1.5" fill="url(#smaMark)" />
          <path d="M20.4 1.6 21.1 3.4 22.9 4.1 21.1 4.8 20.4 6.6 19.7 4.8 17.9 4.1 19.7 3.4Z" fill="#74DBA0" />
        </svg>
        <span className="bg-gradient-to-r from-[#5B9BE8] via-[#1FA0A6] to-[#74DBA0] bg-clip-text text-[17px] font-extrabold tracking-[0.16em] text-transparent">
          SMA
        </span>
      </div>

      <ProjectSelector />

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-[18px]">
        {navScreens('main').map((s) => (
          <NavItem key={s.id} id={s.id} title={s.title} active={s.id === active} onOpen={onOpen} />
        ))}

        <div className="mt-[18px] mb-[7px] px-2.5 text-[10px] font-semibold tracking-[0.10em] text-side-tx3 uppercase">
          Настройки
        </div>

        {navScreens('settings').map((s) => (
          <NavItem key={s.id} id={s.id} title={s.title} active={s.id === active} onOpen={onOpen} />
        ))}
      </nav>

      <div className="flex flex-col gap-1.5 border-t border-side-bd px-3 py-3">
        {/*
          A shortcut nobody is told about is a shortcut nobody has. Two lines, under everything,
          where the eye lands after it has run out of lines to click.

          TWO KEYS, TWO OWNERS, SAID TOGETHER. The conversation window took Ctrl+K (the
          founder's design draws it there) and the palette moved to Ctrl+P. Written one under
          the other on purpose: the hand that learned the old key finds the new one in the same
          glance, instead of pressing Ctrl+K and deciding the palette broke.
        */}
        <div className="flex items-center gap-[9px] px-2.5 text-[11.5px] text-side-tx3">
          <kbd className="rounded border border-side-bd px-1.5 py-[1px] font-sans text-[10.5px]">Ctrl</kbd>
          <kbd className="rounded border border-side-bd px-1.5 py-[1px] font-sans text-[10.5px]">P</kbd>
          <span>поиск и действия</span>
        </div>

        <div className="flex items-center gap-[9px] px-2.5 text-[11.5px] text-side-tx3">
          <kbd className="rounded border border-side-bd px-1.5 py-[1px] font-sans text-[10.5px]">Ctrl</kbd>
          <kbd className="rounded border border-side-bd px-1.5 py-[1px] font-sans text-[10.5px]">K</kbd>
          <span>разговор с системой</span>
        </div>

        <NotifyToggle />

        <button
          type="button"
          onClick={toggle}
          className="flex h-[31px] w-full items-center gap-[11px] rounded-lg px-2.5 text-left text-[12.5px] font-medium text-side-tx2 hover:bg-side-hover hover:text-side-tx"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
            <circle cx="8" cy="8" r="3.4" />
            <path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" strokeLinecap="round" />
          </svg>
          <span>{theme === 'dark' ? 'Светлое оформление' : 'Тёмное оформление'}</span>
        </button>
      </div>
    </aside>
  )
}
