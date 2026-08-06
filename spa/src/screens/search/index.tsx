import { Placeholder } from '../../shell/Placeholder'

/**
 * «Поиск» — one question, and an answer out of every corpus at once: the screens, the work,
 * the lessons, the rules and the attempts.
 *
 * The folder is claimed and empty on purpose: the work that fills it touches nothing outside
 * these files. Nothing here asks the daemon anything yet — the address it will read is
 * declared but not yet answering.
 */
export function Screen() {
  return <Placeholder title="Поиск" />
}
