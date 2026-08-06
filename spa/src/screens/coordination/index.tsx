import { Placeholder } from '../../shell/Placeholder'

/**
 * «Координация» — who else has this checkout open, what each of them reserved before
 * changing it, and where two reservations cover the same ground.
 *
 * The folder is claimed and empty on purpose: the work that fills it touches nothing outside
 * these files. Nothing here asks the daemon anything yet — the address it will read is
 * declared but not yet answering.
 */
export function Screen() {
  return <Placeholder title="Координация" />
}
