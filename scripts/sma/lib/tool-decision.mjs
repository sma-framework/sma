/**
 * tool-decision.mjs — THE FORM OF A DECISION, and the two functions that speak it.
 *
 * ═══════════════ WHY THIS IS ITS OWN FILE ════════════════════════════════════════
 * Two processes have to agree on one string. The BUTTON in the window builds it — in a
 * browser bundle, where `node:fs` does not exist. The HOOK in the worker's child process
 * reads it — in Node, beside a filesystem and a ticket directory. An agreement between two
 * sides that is written down twice is an agreement that will drift, and the drift here has
 * a precise shape: a person presses «Одобрить», nothing happens, and no surface can say why.
 *
 * So the agreement lives HERE, in a file with no imports at all: no Node built-ins, no
 * daemon, no disk, no clock. Both sides import it — the window through its bundle, the gate
 * through the module that parks calls. Neither owns a second idea of what a decision looks
 * like, and the suite proves it by BUILDING with the producer and READING with the consumer.
 *
 * ═══════════════ WHY A LOOK-ALIKE IS NOT A DECISION ══════════════════════════════
 * The channel this string travels on is the same one the founder types ordinary corrections
 * into («нет, не так»). Those corrections are meant for the WORKER. So a line only counts as
 * a decision when it BEGINS with the form and names a ticket in the shape tickets are minted
 * in; a sentence that merely mentions a ticket id releases nothing and goes on to the worker
 * as what it is — a correction.
 */

/**
 * THE FORM. Declared first, because everything else about a decision string — including the
 * prefix that identifies one — is read out of this line rather than spelled a second time.
 */
export const TICKET_DECISION_FORM = 'sma-tool-decision/1 <ticketId> approve|deny [причина]'

/** The prefix that makes a line a decision and not a sentence that mentions one. */
export const TICKET_DECISION_PREFIX = TICKET_DECISION_FORM.split(' ')[0]

/** Идентификатор билета: наша форма, и всё, что на неё не похоже, решением не считается. */
export const TICKET_ID_RE = /^tk-[0-9a-f]{16}$/

/** Два исхода, которые человек может выбрать. Третьего слова нет. */
export const TICKET_DECISIONS = Object.freeze(['approve', 'deny'])

/**
 * formatDecision({ticketId, decision, reason}) → the decision string.
 * THE PRODUCER. The button calls this one; so does the suite, so that «the two sides agree»
 * is never demonstrated against a string a test wrote by hand.
 *
 * An unrecognised word becomes `deny`: a decision nobody can read must not read as consent.
 */
export function formatDecision({ ticketId, decision, reason } = {}) {
  const word = TICKET_DECISIONS.includes(decision) ? decision : 'deny'
  const tail = String(reason ?? '').replace(/[\r\n]+/g, ' ').trim()
  return `${TICKET_DECISION_PREFIX} ${String(ticketId ?? '')} ${word}${tail ? ` ${tail}` : ''}`
}

/**
 * parseDecision(text) → `{ticketId, decision, reason}` or null.
 * THE CONSUMER. The hook calls this one. Partial resemblance is not consent — see the header.
 */
export function parseDecision(text) {
  if (typeof text !== 'string') return null
  const line = text.trim()
  if (!line.startsWith(`${TICKET_DECISION_PREFIX} `)) return null
  const parts = line.slice(TICKET_DECISION_PREFIX.length + 1).trim().split(/\s+/)
  const ticketId = parts.shift() || ''
  const decision = parts.shift() || ''
  if (!TICKET_ID_RE.test(ticketId)) return null
  if (!TICKET_DECISIONS.includes(decision)) return null
  return { ticketId, decision, reason: parts.join(' ') }
}
