/**
 * tool-flags.mjs — HOW THE TWO TOOL LISTS SIT ON A COMMAND LINE, read back in one place.
 *
 * The capability envelope reaches a worker process as two flags: `--allowedTools` carries what
 * the envelope granted, `--disallowedTools` carries what it reserved for a person. Both are
 * written by `buildClaudeArgs` (args.mjs) as a VECTOR — the flag, then ONE ARGUMENT PER NAME.
 *
 * WHY THAT SHAPE, stated here because this is where its reader lives. The names used to be
 * glued into a single value with `join(' ')`, which reads correctly until the first name that
 * contains a space — and every refusal pattern contains one: `Bash(git push:*)`. Glued, that
 * single refusal arrived as two fragments that forbid nothing, and the boundary was quietly
 * wider than the envelope said. Nothing threw and nothing was logged, which is the whole
 * danger of it. An argument value is delimited by the operating system rather than by a
 * character that also occurs inside it, so a vector cannot lose a name that way.
 *
 * WHY THE READER IS ITS OWN MODULE, AND WHY THAT MODULE IMPORTS NOTHING. Two places ask «what
 * did this attempt actually stand under»: the rights receipt and the approval wall. Each used
 * to answer with its own splitting of the glued value — two guesses about one shape, free to
 * drift from the writer and from each other. One reader ends that. It cannot live in args.mjs
 * because the approval wall lives in a module that is pinned FILESYSTEM-FREE by its own suite,
 * and args.mjs touches a disk on purpose. So the rule sits alone, with no imports of its own:
 * anybody may read it, and reading it drags nothing along.
 */

/**
 * toolListInArgs(args, flag) → the values of one tool-list flag, in the order they were
 * pushed, one name per entry.
 *
 *   `null`  — the array does not carry that flag at all.
 *   `[]`    — the flag is there and names nothing: the last argument, or immediately followed
 *             by another flag. That is a broken record, not «nothing was forbidden», and the
 *             two callers each decide what to do about it.
 *
 * The walk stops at the next `--` argument, which is exactly where a vector option ends for
 * the CLI reading the same line. A record written by the OLDER wire (all names in one glued
 * value) reads as a SINGLE entry that matches no name — deliberately, and in the safe
 * direction: it shows up as a divergence to be looked at, never as a boundary that passes.
 *
 * @param {string[]} args
 * @param {string} flag
 * @returns {string[]|null}
 */
export function toolListInArgs(args, flag) {
  const list = Array.isArray(args) ? args.map((a) => String(a)) : []
  const at = list.indexOf(String(flag))
  if (at < 0) return null
  const out = []
  for (let i = at + 1; i < list.length; i += 1) {
    if (list[i].startsWith('--')) break
    out.push(list[i])
  }
  return out
}
