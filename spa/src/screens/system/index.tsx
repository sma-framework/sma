import { Placeholder } from '../../shell/Placeholder'

/**
 * «Дом системы» — what this install is, whether there is a newer one, the conveyor's own
 * switch, and the window through which a person reports that something is wrong.
 *
 * The folder is claimed and empty on purpose: the work that fills it touches nothing outside
 * these files. Three of the four addresses it will read answer already; they are deliberately
 * not wired here, because a screen wired ahead of the shape it is meant to show is a screen
 * built twice.
 */
export function Screen() {
  return <Placeholder title="Дом системы" />
}
