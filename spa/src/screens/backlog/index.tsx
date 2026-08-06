import { Placeholder } from '../../shell/Placeholder'

/**
 * «Бэклог» — the project's own list of what is worth doing, read as rows, with a way to put
 * one of them into the queue.
 *
 * The folder is claimed and empty on purpose: the work that fills it touches nothing outside
 * these files. Nothing here asks the daemon anything yet — the address it will read is
 * declared but not yet answering.
 */
export function Screen() {
  return <Placeholder title="Бэклог" />
}
