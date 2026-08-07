import { SCREENS } from '../screens/registry'
import type { ScreenId } from '../screens/registry'
import type { SearchHit, SearchKind } from '../api/types'
import { openScreen } from './navigation'

/**
 * search-hits — what an answer from the search door is CALLED, and where it opens.
 *
 * ═══════════════════════ TWO SURFACES, ONE READING OF A HIT ═══════════════════════
 *
 * Two things in this window show hits: the screen «Поиск», where a person reads them, and
 * the palette, where a person jumps from them. What a hit is called and where clicking it
 * leads must not differ between the two — a person who learns that «правило» opens «Правила»
 * on one surface and somewhere else on the other has learned that the window is not one
 * thing. So the naming and the opening live here, in the shell, exactly as the registry says
 * anything two surfaces both need must.
 *
 * ═══════════════════════ A REF IS A PLACE IN THE WINDOW ═══════════════════════════
 *
 * The daemon promises that a `ref` carries a place in the WINDOW and never a place on disk,
 * and that exactly one of its fields is filled. This module trusts neither promise blindly:
 * a screen name is checked against the registry before the window is moved, because an
 * unknown name is not a screen, and a hit whose ref opens nothing is reported as such rather
 * than swallowed — a row that looks clickable and does nothing is worse than a row that says
 * it leads nowhere.
 *
 * Two kinds carry no identifier at all, and that is the design rather than an omission: a
 * rule and a helper are read on their own screen, which shows all of them. They are opened by
 * their KIND. A lesson has an identifier the corpus knows, but this window has no address for
 * one note — «Память» shows the corpus, and the hit's own title is what the eye then looks
 * for. When the window grows a per-note address, this is the one place that learns it.
 */

/** The door's own ceiling on a question, named here so nobody is refused after typing. */
export const SEARCH_Q_CAP = 256

/** How long the window waits after the last keystroke before asking. */
export const SEARCH_DEBOUNCE_MS = 300

/** What a corpus is called in a heading. */
export const KIND_LABEL: Record<SearchKind, string> = {
  screen: 'Экраны',
  task: 'Задачи',
  note: 'Память',
  rule: 'Правила',
  agent: 'Агенты',
  attempt: 'Попытки',
}

/** What one hit is called in a badge beside it. */
export const KIND_WORD: Record<SearchKind, string> = {
  screen: 'экран',
  task: 'задача',
  note: 'заметка',
  rule: 'правило',
  agent: 'агент',
  attempt: 'попытка',
}

/**
 * The screen a kind belongs to when the hit carries no identifier of its own. `rule` and
 * `agent` are the declared pair; `note` is here because the corpus screen is the whole of
 * what this window can open a lesson on today.
 */
const KIND_HOME: Partial<Record<SearchKind, ScreenId>> = {
  rule: 'rules',
  agent: 'agents',
  note: 'memory',
}

/** Is this a screen this window actually has? An unknown name is not a screen. */
export function isKnownScreen(name: string): name is ScreenId {
  return SCREENS.some((s) => s.id === name)
}

/**
 * The task an attempt belongs to. The ledger mints an attempt's identity as the task's id, a
 * `#`, and the number of the run — so the task is the part in front of the `#`. This window
 * has no screen for one attempt; the card of its task is where its log is read, which is the
 * true destination rather than an approximation of one.
 */
export function taskOfAttempt(attemptId: string): string {
  const cut = attemptId.indexOf('#')
  return cut > 0 ? attemptId.slice(0, cut) : attemptId
}

/**
 * Open what a hit points at. Answers whether it led anywhere — a caller renders a row that
 * leads nowhere as text rather than as a button.
 */
export function openHit(hit: SearchHit): boolean {
  const ref = hit.ref ?? {}

  if (typeof ref.screen === 'string' && isKnownScreen(ref.screen)) {
    openScreen({ screen: ref.screen })
    return true
  }
  if (typeof ref.taskId === 'string' && ref.taskId !== '') {
    openScreen({ screen: 'task-card', taskId: ref.taskId })
    return true
  }
  if (typeof ref.attemptId === 'string' && ref.attemptId !== '') {
    const taskId = taskOfAttempt(ref.attemptId)
    if (taskId !== '') {
      openScreen({ screen: 'task-card', taskId })
      return true
    }
  }
  const home = KIND_HOME[hit.kind]
  if (home) {
    openScreen({ screen: home })
    return true
  }
  return false
}

export interface HitGroup {
  kind: SearchKind
  label: string
  hits: SearchHit[]
}

/**
 * The hits in groups — WITHOUT overruling the order they arrived in.
 *
 * The daemon ranks every corpus into one list and says plainly that the order is already
 * right. Grouping is therefore done the only way that keeps both truths: the groups appear in
 * the order their BEST hit appeared, and inside a group the daemon's order is untouched. A
 * person reads five short lists instead of one long one, and the thing the daemon thought was
 * the best answer is still the first thing on the screen.
 */
export function groupHits(hits: readonly SearchHit[]): HitGroup[] {
  const groups: HitGroup[] = []
  const byKind = new Map<SearchKind, HitGroup>()
  for (const hit of hits) {
    let group = byKind.get(hit.kind)
    if (!group) {
      group = { kind: hit.kind, label: KIND_LABEL[hit.kind] ?? hit.kind, hits: [] }
      byKind.set(hit.kind, group)
      groups.push(group)
    }
    group.hits.push(hit)
  }
  return groups
}

/** The small word beside a hit that says which corpus it came out of. */
export function KindBadge({ kind }: { kind: SearchKind }) {
  return (
    <span className="flex-none rounded-full bg-idle-s px-2 py-[2px] text-[10.5px] text-idle-tx">
      {KIND_WORD[kind] ?? kind}
    </span>
  )
}
