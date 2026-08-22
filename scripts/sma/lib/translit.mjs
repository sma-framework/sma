/**
 * translit.mjs — ONE spelling, for the whole tree, of «a human description becomes a
 * machine name».
 *
 * Directory and file names in this system are BORN from descriptions a person typed.
 * A description written in a script the name cannot carry, cleaned character by
 * character, does not merely come out ugly — it collapses DIFFERENT pieces of work into
 * ONE name, and every command that takes a name then lands on the wrong thing: clearing
 * your own reservation removes somebody else's guard while they are still editing, and
 * nothing anywhere says so. Transliterating first keeps the name readable AND keeps two
 * different descriptions apart.
 *
 * It lives in one module instead of being re-typed by each consumer because a naming
 * convention written down twice drifts, and on the day the two spellings disagree one
 * half of the system stops finding what the other half created.
 *
 * LEAF BY CONSTRUCTION: the only import here is a node built-in. The collision detector
 * and the session registry already import each other; a shared helper that reached back
 * into either of them would tighten that knot. Everything points INTO this module and
 * nothing points out of it.
 *
 * Node built-ins only.
 */

import { createHash } from 'node:crypto'

/**
 * Lowercase Cyrillic → latin, by the table people actually read (ж→zh, щ→sch, ю→yu).
 * Multi-letter results are deliberate: a name its author can read back is worth more
 * than a name of minimal length. The two signs that spell no sound of their own (ъ, ь)
 * map to nothing. Anything absent from this table — latin, digits, punctuation, any
 * other script — is not this table's business and passes through untouched.
 */
const CYRILLIC_TO_LATIN = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
}

/**
 * translitToLatin(s) — replace Cyrillic letters with their latin reading; leave every
 * other character exactly as it was.
 * @param {string} s
 * @returns {string}
 */
export function translitToLatin(s) {
  if (s == null) return ''
  // Callers normally lowercase before calling; doing it again costs nothing and makes
  // this function correct on its own — which is what a shared leaf has to be.
  const src = String(s).toLowerCase()
  let out = ''
  for (const ch of src) {
    const mapped = CYRILLIC_TO_LATIN[ch]
    out += mapped === undefined ? ch : mapped
  }
  return out
}

/**
 * slugHash(s) — the first 8 hex of sha1 over the string: a short, stable digest used as
 * the last-resort disambiguator, for when the words themselves leave nothing behind.
 *
 * The session registry spells the same formula for its window-token suffix, and this is
 * a deliberate second writing of it rather than an import. The registry is NOT a leaf —
 * it imports from the shared layer and the collision detector imports it back — so
 * translit → registry would close a cycle, while registry → translit is the direction
 * that stays legal on the day the registry starts naming things through this module. A
 * digest is also the one piece of arithmetic that cannot drift: sha1 over the same bytes
 * is the same eight characters in every copy of it.
 * @param {string} s
 * @returns {string}
 */
export function slugHash(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 8)
}
