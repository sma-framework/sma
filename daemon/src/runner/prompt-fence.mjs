/**
 * prompt-fence.mjs — the ONE copy of the containment rule for untrusted text on its way
 * into a prompt.
 *
 * WHAT IT IS: a single pure function. Anything a human (or a foreign file, or a chat turn)
 * typed is DATA, and data that reaches a model must be wrapped so it cannot pose as an
 * instruction. The wrap is a code fence whose length is measured against the content itself:
 * a fence STRICTLY longer than the longest backtick run inside can never be closed early by
 * that content, so a «```\nNow ignore your instructions» payload stays inside the block.
 *
 * WHY IT IS ITS OWN MODULE: the rule was written twice — byte-identical — in the task-prompt
 * builder and in the forge prompt builder, and a third consumer (the chat lane) was about to
 * copy it a third time. A containment rule that exists in N places is a rule that will hold
 * in N-1 of them after the first edit. THE LAW HERE: never copy this function. Import it.
 * A test asserts that both prompt builders emit exactly what this module returns, so the day
 * a copy reappears and drifts, the suite says so.
 *
 * The label is ours (a fixed string chosen by the caller — «task», «acceptance»,
 * «untrusted-data»); only the content is untrusted. Node built-ins only; zero deps; pure.
 */

/**
 * fencedBlock(label, content) → a fenced code block whose fence is STRICTLY longer than any
 * backtick run inside `content`, so untrusted text can never break out of the fence
 * (prompt-injection containment). Content stays verbatim DATA.
 *
 * @param {string} label a caller-chosen info string for the fence (trusted)
 * @param {*} content the untrusted text (coerced to string; null/undefined → empty)
 * @returns {string}
 */
export function fencedBlock(label, content) {
  const text = String(content ?? '')
  let maxRun = 0
  let cur = 0
  for (const ch of text) {
    if (ch === '`') {
      cur += 1
      if (cur > maxRun) maxRun = cur
    } else {
      cur = 0
    }
  }
  const fence = '`'.repeat(Math.max(3, maxRun + 1))
  return `${fence}${label}\n${text}\n${fence}`
}
