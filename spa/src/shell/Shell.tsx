import { useEffect, useState } from 'react'
import { useStateQuery } from '../api/queries'
import { HOME_SCREEN, screenById } from '../screens/registry'
import type { ScreenId } from '../screens/registry'
import { HubBanner } from './HubBanner'
import { OPEN_SCREEN_EVENT, OpenedWithProvider, readOpenScreen } from './navigation'
import type { OpenScreenDetail } from './navigation'
import { useIsNarrow } from './narrow/narrow'
import { NarrowShell } from './narrow/NarrowShell'
import { Palette } from './Palette'
import { Sidebar } from './Sidebar'
import { SystemConsole } from './SystemConsole'

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
 *
 * И ЭТА ОТДЕЛЬНАЯ РАБОТА ТЕПЕРЬ СУЩЕСТВУЕТ: она живёт в `shell/narrow` и взята ровно на её
 * условиях, как здесь и было заявлено, — со своим коротким составом (увидеть, что от тебя
 * ждут, открыть задачу, принять её), своей верхней полосой и шторкой вместо боковой колонки.
 * Ни один экран стола ради неё не сжимался и не получал точки перелома: узкая работа не
 * пересобирает стол, она показывает вместо него СВОЁ. Порог, на котором рама выбирает между
 * ними, — то же самое число, что стоит минимумом ниже, и живёт оно в одном месте (narrow.ts).
 *
 * И ЭТА ШИРИНА ОБЪЯВЛЕНА ЗДЕСЬ, НА РАМЕ, а не на странице. Минимум в 1360px стоял на `body`,
 * и на узком экране вбок уезжала вся страница целиком; теперь его несёт рама, а возит её
 * `#root` (см. tokens.css). Заявление то же самое — «окну нужно 1360», — но сказано про то,
 * что действительно столько занимает: `min-h-full` вместо `min-h-screen` по той же причине,
 * полоса прокрутки контейнера съедает часть высоты, и рама в целый экран высотой вылезала бы
 * из него ровно на её толщину.
 */
export function Shell() {
  const [active, setActive] = useState<ScreenId>(HOME_SCREEN)
  const [openedWith, setOpenedWith] = useState<OpenScreenDetail | null>(null)
  const state = useStateQuery()
  const narrow = useIsNarrow()
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

  /*
    Развилка стоит ПОСЛЕ всех хуков и до всякой разметки: узкая работа — не вариант этой
    рамы, а другая рама. Минимум ширины остаётся там, где он и был, — у стола, которому он
    нужен; узкая работа живёт без него, и потому здесь не появилось ни второго числа, ни
    условного класса. Решение принимается на уровне того, ЧТО показано.
  */
  if (narrow) return <NarrowShell />

  return (
    <div className="flex min-h-full min-w-[1360px]">
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
      {/*
        Разговор живёт ЗДЕСЬ по той же причине, что и палитра: он нужен над любым экраном и
        слушает свою клавишу, что бы ни было на стекле. Имя открытого экрана передаётся ему
        пропсом — это единственное, что оболочка знает наверняка; всё, что глубже (какая
        фаза раскрыта, какая задача открыта), рассказывает сам экран.
      */}
      <SystemConsole screen={active} />
    </div>
  )
}
