import type { ComponentType } from 'react'

import { Screen as Today } from '../screens/today'
import { Screen as Tasks } from '../screens/tasks'
import { Screen as Backlog } from '../screens/backlog'
import { Screen as Coordination } from '../screens/coordination'
import { Screen as Search } from '../screens/search'
import { Screen as Ship } from '../screens/ship'
import { Screen as System } from '../screens/system'
import { Screen as Team } from '../screens/team'
import { Screen as LiveStream } from '../screens/live-stream'
import { Screen as Chat } from '../screens/chat'
import { Screen as Costs } from '../screens/costs'
import { Screen as Rules } from '../screens/rules'
import { Screen as Agents } from '../screens/agents'
import { Screen as Skills } from '../screens/skills'
import { Screen as Memory } from '../screens/memory'
import { Screen as Accounts } from '../screens/accounts'
import { Screen as Connections } from '../screens/connections'
import { Screen as Machines } from '../screens/machines'
import { Screen as TaskCard } from '../screens/task-card'
import { Screen as ImportWizard } from '../screens/import-wizard'
import { Screen as FirstRun } from '../screens/first-run'

/**
 * registry.ts — every screen the window has, and where each one lives.
 *
 * ═════════════════════════ ONE SCREEN, ONE FOLDER, ONE OWNER ══════════════════════
 *
 * A screen is built inside its own folder and NOWHERE else. Work on one screen touches
 * that folder alone: it does not edit the shell, it does not edit this file beyond its
 * own line, and it does not reach into a neighbour. That is what lets several screens be
 * built at the same time without them tripping over each other, and it is why the
 * folders all exist from the first day — empty, but present and claimed.
 *
 * Anything two screens both need is not a screen: it belongs to the shell or to the api
 * layer, and moving it there is a decision made out loud, not a quiet copy.
 *
 * Each import above names its screen's own folder deliberately — the registry is the one
 * place where the map from a name to a folder is written down.
 *
 * ДВА ЭКРАНА СНЯТЫ ВЛАДЕЛЬЦЕМ 28.08.2026, и здесь записано почему — чтобы их не завели заново.
 * «Конвейер фаз» был второй точкой правды рядом с бэклогом: задачи, фазы и батчи вписаны в один
 * бэклог, а фаза видна на «Задачах» и раскрывается там же своей карточкой — карточка и её двери
 * живы, переехала только папка (`screens/tasks/PhaseCardView`). «Мой стиль» был витриной без
 * провода: своих дверей у него не было, а его чтение не читал ни один промпт.
 *
 * The screens of a release are therefore declared HERE IN ONE GO, before any of them is
 * built — exactly as the daemon declares all of its addresses in one revision. This file and
 * the three api files are the only shared ground the screens have; if each screen added its
 * own line when its turn came, every screen built in the same week would collide with its
 * neighbours on these four files and nothing could be built in parallel at all.
 */

export type ScreenId =
  | 'today'
  | 'tasks'
  | 'backlog'
  | 'coordination'
  | 'search'
  | 'ship'
  | 'system'
  | 'team'
  | 'live-stream'
  | 'chat'
  | 'costs'
  | 'rules'
  | 'agents'
  | 'skills'
  | 'memory'
  | 'accounts'
  | 'connections'
  | 'machines'
  | 'task-card'
  | 'import-wizard'
  | 'first-run'

/** Where a screen appears in the sidebar, if it appears there at all. */
export type NavGroup = 'main' | 'settings' | null

export interface ScreenEntry {
  id: ScreenId
  /** The name a person reads — in the sidebar, and at the top of the screen. */
  title: string
  group: NavGroup
  Screen: ComponentType
}

/**
 * The order here IS the order in the sidebar. Three screens carry no sidebar line:
 * a task's card opens from a task, bringing your own helpers in starts from «Агенты»,
 * and the first run is seen once, before the window has a sidebar at all.
 */
export const SCREENS: readonly ScreenEntry[] = [
  { id: 'today', title: 'Сегодня', group: 'main', Screen: Today },
  { id: 'tasks', title: 'Задачи', group: 'main', Screen: Tasks },
  { id: 'team', title: 'Команда', group: 'main', Screen: Team },
  { id: 'live-stream', title: 'Живой поток', group: 'main', Screen: LiveStream },
  { id: 'chat', title: 'Разговор', group: 'main', Screen: Chat },
  { id: 'costs', title: 'Расходы', group: 'main', Screen: Costs },
  { id: 'rules', title: 'Правила', group: 'main', Screen: Rules },
  // The new work of the release, APPENDED rather than woven in among the lines above: the
  // order here is the order on the glass, so interleaving them would silently rearrange a
  // sidebar a person already has habits about. Where they finally belong is a judgment for
  // whoever looks at the finished screens.
  { id: 'backlog', title: 'Бэклог', group: 'main', Screen: Backlog },
  { id: 'coordination', title: 'Координация', group: 'main', Screen: Coordination },
  { id: 'search', title: 'Поиск', group: 'main', Screen: Search },
  { id: 'ship', title: 'Выкат', group: 'main', Screen: Ship },
  { id: 'agents', title: 'Агенты', group: 'settings', Screen: Agents },
  { id: 'skills', title: 'Навыки', group: 'settings', Screen: Skills },
  { id: 'memory', title: 'Память', group: 'settings', Screen: Memory },
  { id: 'accounts', title: 'Аккаунты', group: 'settings', Screen: Accounts },
  { id: 'connections', title: 'Подключения', group: 'settings', Screen: Connections },
  { id: 'machines', title: 'Машины и проекты', group: 'settings', Screen: Machines },
  { id: 'system', title: 'Дом системы', group: 'settings', Screen: System },
  { id: 'task-card', title: 'Карточка задачи', group: null, Screen: TaskCard },
  { id: 'import-wizard', title: 'Привести своих', group: null, Screen: ImportWizard },
  { id: 'first-run', title: 'Первый запуск', group: null, Screen: FirstRun },
] as const

/** The screen the window opens on. */
export const HOME_SCREEN: ScreenId = 'today'

export function screenById(id: ScreenId): ScreenEntry {
  const found = SCREENS.find((s) => s.id === id)
  if (!found) throw new Error(`неизвестный экран «${id}»`)
  return found
}

export function navScreens(group: Exclude<NavGroup, null>): ScreenEntry[] {
  return SCREENS.filter((s) => s.group === group)
}
