import { useCallback, useRef, useState } from 'react'

import { useStateQuery } from '../../api/queries'
import { screenById } from '../../screens/registry'
import type { ScreenId } from '../../screens/registry'
import { isNarrowCapable } from './narrow'
import { NarrowMenu } from './NarrowMenu'
import { NarrowTaskCard } from './NarrowTaskCard'
import { NarrowTasks } from './NarrowTasks'
import { WideOnlyNotice } from './WideOnlyNotice'

/**
 * NarrowShell — рама узкой работы: то, что человек с телефоном видит вместо стола.
 *
 * ═══════════════ ЭТО НЕ СЖАТЫЙ СТОЛ, А ОТДЕЛЬНАЯ РАБОТА ═══════════════
 *
 * У широкой рамы своё хозяйство: боковая колонка в 248 px, палитра по клавише, разговор по
 * клавише, полоса федерации. Ни одно из этого не переносится сюда сжатием. Узкая рама держит
 * СВОЙ короткий состав — «ждут вас» → список → карточка → приёмка — и своё хозяйство
 * навигации: что показано сейчас и открыта ли шторка. Решение о том, ЧТО показать, принимается
 * здесь, на раме, а не медиа-запросом внутри каждого экрана: экраны стола этой работой не
 * трогаются вовсе.
 *
 * ═══════════════ ЧЕГО ЗДЕСЬ НЕТ — СКАЗАНО СЛОВАМИ ═══════════════
 *
 * Палитра и разговор на узкую раму не поднимаются: обе живут за сочетанием клавиш, которого на
 * телефоне нет, и обе рассчитаны на ширину, где рядом с ответом помещается то, о чём он. Полоса
 * федерации — сообщение о доме, а не о работе: на 375 px она заняла бы место того единственного,
 * ради чего сюда пришли. Всё три остаются принадлежностью стола, и это решение, а не забывчивость.
 *
 * Выбор проекта тоже остаётся столу: в верхней полосе имя активного проекта стоит СЛОВАМИ, а не
 * переключателем. Сменить проект — значит сменить всё, что человек видит; такое решение принимают
 * там, где видно последствия, а не одним тапом между делом.
 */

/** Что показано прямо сейчас. Своё хозяйство узкой рамы — стол о нём не знает и знать не должен. */
type NarrowView =
  | { kind: 'tasks' }
  | { kind: 'task'; taskId: string }
  | { kind: 'wide-only'; screen: ScreenId }

export function NarrowShell() {
  const state = useStateQuery()
  const [view, setView] = useState<NarrowView>({ kind: 'tasks' })
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  /** Закрытие возвращает фокус кнопке «Меню»: рука с клавиатуры обязана вернуться туда, откуда ушла. */
  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    menuButtonRef.current?.focus()
  }, [])

  const openFromMenu = (id: ScreenId) => {
    setMenuOpen(false)
    menuButtonRef.current?.focus()
    setView(isNarrowCapable(id) ? { kind: 'tasks' } : { kind: 'wide-only', screen: id })
  }

  const project = state.data?.activeProject ?? null
  /** Какая строка меню считается открытой: узкая работа — это экран задач реестра. */
  const activeScreen: ScreenId = view.kind === 'wide-only' ? view.screen : 'tasks'

  return (
    <div className="flex min-h-full flex-col bg-bg">
      <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-bd bg-card px-4 py-2">
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden>
          <defs>
            <linearGradient id="smaMarkNarrow" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#3B82F6" />
              <stop offset=".52" stopColor="#1FA0A6" />
              <stop offset="1" stopColor="#3CC0A0" />
            </linearGradient>
          </defs>
          <rect x="7.6" y="7.2" width="11.4" height="3" rx="1.5" fill="url(#smaMarkNarrow)" />
          <rect x="3" y="11.2" width="18" height="3" rx="1.5" fill="url(#smaMarkNarrow)" />
          <rect x="5.4" y="15.2" width="11.4" height="3" rx="1.5" fill="url(#smaMarkNarrow)" />
        </svg>

        <span className="min-w-0 flex-1 truncate text-[13px] leading-[1.3] text-tx2">
          {project ? `Проект: ${project}` : 'Проект не выбран — выбрать можно с компьютера'}
        </span>

        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-expanded={menuOpen}
          className="flex min-h-[44px] items-center rounded-[10px] border border-bd2 px-3.5 text-[14px] font-semibold text-tx focus-visible:outline-2 focus-visible:outline-blue"
        >
          Меню
        </button>

        {/*
          Шторка стоит В РАЗМЕТКЕ СРАЗУ ЗА СВОЕЙ КНОПКОЙ, а не в конце рамы: слой, открытый
          кнопкой, читается следом за ней и с клавиатуры, и читалкой экрана, — а не после всего
          содержимого, мимо которого пришлось бы пройти.
        */}
        {menuOpen ? <NarrowMenu active={activeScreen} onOpen={openFromMenu} onClose={closeMenu} /> : null}
      </header>

      <main className="flex min-w-0 flex-1 flex-col">
        {view.kind === 'tasks' ? <NarrowTasks onOpenTask={(taskId) => setView({ kind: 'task', taskId })} /> : null}

        {view.kind === 'task' ? (
          <NarrowTaskCard taskId={view.taskId} onBack={() => setView({ kind: 'tasks' })} />
        ) : null}

        {view.kind === 'wide-only' ? (
          <WideOnlyNotice title={screenById(view.screen).title} onBack={() => setView({ kind: 'tasks' })} />
        ) : null}
      </main>
    </div>
  )
}
