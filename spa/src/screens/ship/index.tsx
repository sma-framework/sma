import { Placeholder } from '../../shell/Placeholder'

/**
 * «Выкат» — the release gate, step by step, and the publication that is only reachable
 * behind a green run of it.
 *
 * The folder is claimed and empty on purpose: the work that fills it touches nothing outside
 * these files. Nothing here asks the daemon anything yet — the addresses it will read are
 * declared but not yet answering, and the most dangerous act in the product is not one to
 * wire up ahead of the door that guards it.
 */
export function Screen() {
  return <Placeholder title="Выкат" />
}
