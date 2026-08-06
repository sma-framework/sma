import { Placeholder } from '../../shell/Placeholder'

/**
 * «Конвейер фаз» — where a phase stands, what it is about to be asked, and the buttons that
 * move it from one stage to the next.
 *
 * The folder exists before the screen does, and that is deliberate: it is claimed, it has its
 * line in the registry, and the work that fills it touches nothing outside these files. Until
 * then it says so plainly and asks the daemon nothing — the addresses it will read are
 * declared but not yet answering, and a screen that knocks on them would only be knocking.
 */
export function Screen() {
  return <Placeholder title="Конвейер фаз" />
}
