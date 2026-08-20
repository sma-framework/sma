/**
 * rules-parity.mjs — what «the worker plays by the same rules as your own terminal» is
 * allowed to mean, as a function instead of a sentence.
 *
 * WHY THE LITERAL READING IS BOTH UNREACHABLE AND WRONG. Read word for word, «the same list
 * of rules» asks for one list copied onto two sessions. But a permission file has two halves
 * that do opposite things. `deny` and `ask` can only ever NARROW what a session may do:
 * copying them onto a worker takes rights away and can never add one. `allow` and
 * `defaultMode` only ever WIDEN: an allow list is what a person grants himself while sitting
 * at the keyboard, one convenience at a time, and `defaultMode: "auto"` in a user-scope file
 * switches a headless session into the automatic regime wholesale. The two halves have
 * different GROUNDS, not different styles: a person at a keyboard sees every call before it
 * runs and can stop it; an unattended session has nobody watching, which is the whole reason
 * it is given a smaller envelope in the first place.
 *
 * And this is measured, not reasoned. With the author's own settings in place a worker's
 * `git push` GOES THROUGH; with the same settings absent, the same call is refused. So
 * mirroring the widening half is not untidiness — it is the act of handing an unattended
 * session the rights of the person.
 *
 * THEREFORE THE RULE READS: the narrowing half must match rule for rule, and the widening
 * half must be DECLARED not-mirrored and be absent from the worker. A difference nobody
 * declared is a failure here, not a pass — «we never carried it» and «we forgot it» look
 * identical from the outside, and only one of them is a decision.
 *
 * WHAT THIS MODULE IS NOT. It is not the mirror and it is not a report: it takes two parsed
 * settings objects and a declaration, and returns a verdict. It never opens a file, so it
 * cannot ever be the thing that edited the personal settings of a human being while checking
 * them — the one failure a checking tool must be structurally incapable of.
 */

/** The words the mirror says instead of carrying a widening rule across. */
export const NOT_MIRRORED = 'not mirrored'

/** The half that can only take rights away. It must match rule for rule. */
export const NARROWING_KEYS = Object.freeze(['deny', 'ask'])

/** The half that can only add rights. It is declared, never carried. */
export const WIDENING_KEYS = Object.freeze(['allow', 'defaultMode'])

/**
 * notMirroredDeclaration() → the declaration itself: every widening key mapped to the words
 * of refusal. Spelled once, so the mirror that makes the declaration and the check that
 * demands it cannot drift into disagreeing about which keys the widening ones are.
 *
 * @returns {Record<string, string>}
 */
export function notMirroredDeclaration() {
  const out = {}
  for (const key of WIDENING_KEYS) out[key] = NOT_MIRRORED
  return out
}

/** The permissions block of a settings object, or `null` when there is no object at all. */
function permissionsOf(settings) {
  if (!settings || typeof settings !== 'object') return null
  const perms = settings.permissions
  return perms && typeof perms === 'object' ? perms : {}
}

/** A rule list as strings; anything that is not a list is an empty one. */
function asList(value) {
  return Array.isArray(value) ? value.map(String) : []
}

/**
 * surplus(a, b) → what `a` holds beyond what `b` holds, as `{rule, count}` pairs.
 *
 * A MULTISET, not a set: a rule written twice and a rule written once are different files,
 * and folding them together would let a list quietly lose a duplicate without the check
 * noticing. Order is deliberately NOT part of the comparison — two files that hold the same
 * rules in a different order are the same rules.
 */
function surplus(a, b) {
  const rest = [...b]
  const extra = []
  for (const rule of a) {
    const at = rest.indexOf(rule)
    if (at >= 0) rest.splice(at, 1)
    else extra.push(rule)
  }
  const out = []
  for (const rule of extra) {
    const seen = out.find((e) => e.rule === rule)
    if (seen) seen.count += 1
    else out.push({ rule, count: 1 })
  }
  return out
}

/** The numbers a report prints for one side, with `null` for «this side has no such key». */
function countsOf(perms) {
  return {
    allow: Array.isArray(perms.allow) ? perms.allow.length : null,
    deny: asList(perms.deny).length,
    ask: asList(perms.ask).length,
    defaultMode: typeof perms.defaultMode === 'string' ? perms.defaultMode : null,
  }
}

/**
 * compareRules({terminal, worker, declaration, labels}) → the verdict.
 *
 * @param {object} [args]
 * @param {object|null} [args.terminal] the person's parsed settings, `null` when absent
 * @param {object|null} [args.worker] the worker account's parsed settings, `null` when absent
 * @param {object|null} [args.declaration] what the mirror says it refuses to carry
 * @param {{terminal?:string, worker?:string}} [args.labels] how each side is named in a reason
 * @returns {{denyEqual:boolean, askEqual:boolean, allowDeclared:boolean,
 *            defaultModeDeclared:boolean, present:{terminal:boolean, worker:boolean},
 *            counts:{terminal:object|null, worker:object|null}, widened:string[],
 *            diffs:Array<{list:string, side:string, rule:string, count:number, says:string}>,
 *            reasons:string[], verdict:'ok'|'fail'}}
 */
export function compareRules({ terminal, worker, declaration, labels } = {}) {
  const named = {
    terminal: (labels && labels.terminal) || 'настройки терминала',
    worker: (labels && labels.worker) || 'настройки работника',
  }
  const tp = permissionsOf(terminal)
  const wp = permissionsOf(worker)

  const reasons = []
  const diffs = []
  const widened = []

  // ── (1) НЕТ ФАЙЛА — НЕТ ОТВЕТА. «Данных нет» never rounds up to «совпало»: the whole
  // point of the check is that a person can tell a proven match from an unopened file.
  if (!tp) reasons.push(`данных нет: ${named.terminal}`)
  if (!wp) reasons.push(`данных нет: ${named.worker}`)

  // ── (2) СУЖАЮЩЕЕ — БУКВА В БУКВУ, поимённо в обе стороны.
  let denyEqual = false
  let askEqual = false
  if (tp && wp) {
    for (const list of NARROWING_KEYS) {
      const mine = asList(tp[list])
      const theirs = asList(wp[list])
      const onlyTerminal = surplus(mine, theirs).map((e) => ({
        list,
        side: 'terminal',
        rule: e.rule,
        count: e.count,
        says: `есть у человека, нет у работника: ${e.rule}${e.count > 1 ? ` ×${e.count}` : ''}`,
      }))
      const onlyWorker = surplus(theirs, mine).map((e) => ({
        list,
        side: 'worker',
        rule: e.rule,
        count: e.count,
        says: `есть у работника, нет у человека: ${e.rule}${e.count > 1 ? ` ×${e.count}` : ''}`,
      }))
      const equal = onlyTerminal.length === 0 && onlyWorker.length === 0
      if (list === 'deny') denyEqual = equal
      else askEqual = equal
      if (!equal) {
        diffs.push(...onlyTerminal, ...onlyWorker)
        reasons.push(`сужающий список ${list} расходится: ${onlyTerminal.length + onlyWorker.length} правил`)
      }
    }
  }

  // ── (3) РАСШИРЯЮЩЕЕ — ЕГО У РАБОТНИКА БЫТЬ НЕ ДОЛЖНО. The key is named, because
  // «permissions diverge» is a sentence nobody can act on and «allow was mirrored» is.
  if (wp) {
    for (const key of WIDENING_KEYS) {
      if (Object.prototype.hasOwnProperty.call(wp, key)) {
        widened.push(key)
        reasons.push(
          `расширяющее правило зеркалировано работнику: ${key} — это отдаёт безлюдной сессии права человека`,
        )
      }
    }
  }

  // ── (4) ОБЪЯВЛЕНИЕ ОБЯЗАТЕЛЬНО. Silence is the failure mode this half exists to catch:
  // a mirror that stopped declaring is a mirror nobody would notice had started carrying.
  const declared = {}
  for (const key of WIDENING_KEYS) {
    const ok = Boolean(declaration && typeof declaration === 'object' && declaration[key] === NOT_MIRRORED)
    declared[key] = ok
    if (!ok) {
      reasons.push(`разница не объявлена: ${key} — отказ зеркалировать обязан быть записан словами «${NOT_MIRRORED}»`)
    }
  }

  return {
    denyEqual,
    askEqual,
    allowDeclared: declared.allow === true,
    defaultModeDeclared: declared.defaultMode === true,
    present: { terminal: Boolean(tp), worker: Boolean(wp) },
    counts: { terminal: tp ? countsOf(tp) : null, worker: wp ? countsOf(wp) : null },
    widened,
    diffs,
    reasons,
    verdict: reasons.length === 0 && denyEqual && askEqual ? 'ok' : 'fail',
  }
}
