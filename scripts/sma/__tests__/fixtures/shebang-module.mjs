#!/usr/bin/env node
/**
 * A FIXTURE, not a tool: an executable-shaped module whose first line is a real
 * shebang. The suite that imports it is the live proof of the strip-shebang rule
 * in vitest.config.mjs — before that rule (and outside the hand-maintained
 * external list it replaced) this import threw `SyntaxError: Invalid or
 * unexpected token`, the importing test file collected ZERO tests, and the
 * failure was charged to the victim instead of the cause.
 *
 * It carries the same direct-run guard the real entry points carry, so importing
 * it stays side-effect free — the point is the interpreter line, nothing else.
 */

export const SHEBANG_FIXTURE = 'loaded'

/** A line whose number must survive the strip (the rule blanks, never deletes). */
export const DECLARED_ON_LINE = 17

if (process.argv[1] && process.argv[1].endsWith('shebang-module.mjs')) {
  process.stdout.write(`${SHEBANG_FIXTURE}\n`)
}
