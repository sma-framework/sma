/**
 * THE LOCK ON THE DISPATCHER'S VOCABULARY.
 *
 * The router explains every decision by appending a CODE to the task's decision journal, and
 * the sink only accepts codes the closed vocabulary knows. That guard is correct and it is
 * also perfectly silent: a code that is not in the vocabulary is dropped, the routing answer
 * is unchanged, nothing throws, nothing is logged. The decision is simply never explained —
 * and the card that renders it says «решение о маршруте не записано» about a decision that
 * was in fact made.
 *
 * Silence is the right behaviour at RUNTIME (a dispatcher that dies of a typo is worse than
 * one that cannot explain itself), so the mistake has to be caught somewhere else: at the
 * moment the literal is written. That is what this file is. It reads the router's source as
 * TEXT, pulls out every string literal handed to the journal sink, and requires each one to
 * be a key of the closed vocabulary.
 *
 * READING SOURCE AS TEXT IS A HOUSE MOVE, NOT AN INVENTION: the explainer coverage check and
 * the documentation audit both do exactly this — parse the shipped file, compare it against
 * the table that is supposed to describe it. The alternative (running the router and watching
 * the sink) can only cover the branches a test happens to drive, and the orphan is always in
 * the branch nobody drove.
 *
 * WHAT IT CANNOT SEE, said out loud: two call sites pass a VARIABLE, not a literal (the money
 * rule's verdict, and the wait code chosen a line earlier). A text scan has nothing to check
 * there. Those two are covered by the wire test beside this file, which drives the router and
 * looks at what actually reached the sink.
 *
 * THIS FILE IS RED ON ARRIVAL, AND THAT IS ITS FIRST JOB. The literal for the handover to the
 * paid channel when the pool is empty is not in the vocabulary today, so the decision that
 * spends real money is the one decision the journal never records. The lock is committed red,
 * with the failing run kept as a receipt; the work that adds the word turns it green.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

import { DISPATCH_REASONS } from '../src/front/journal.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUTER_PATH = join(HERE, '..', 'src', 'policy', 'routing.mjs')

/**
 * Every string literal passed as the CODE argument of a journal-sink call.
 *
 * The shape matched is the call as it is written in the source: the sink, the task, then the
 * code. Only the single-quoted third argument is taken — a variable in that position is
 * invisible to a text scan and is honestly left to the wire test.
 */
function journalledCodeLiterals(source: string): string[] {
  const call = /journalDecision\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*,\s*'([^']+)'/g
  const out: string[] = []
  for (let m = call.exec(source); m; m = call.exec(source)) out.push(m[1])
  return out
}

describe('every reason the router writes down is a word the vocabulary knows', () => {
  const source = readFileSync(ROUTER_PATH, 'utf8')
  const literals = journalledCodeLiterals(source)

  it('finds the literals at all — a lock that reads nothing would pass forever', () => {
    // Without this the file above could be renamed, the call could be reshaped, and the
    // assertion below would go on reporting success over an empty list.
    expect(literals.length).toBeGreaterThan(0)
  })

  it('names any reason the router writes but the vocabulary does not carry', () => {
    const known = Object.keys(DISPATCH_REASONS)
    const orphans = literals.filter((code) => !known.includes(code))
    // The message has to carry the WORD: an orphan reported as a count sends the reader back
    // into the source to find out which one, and that is the minute the report was for.
    expect(orphans, `the router journals ${JSON.stringify(orphans)}, absent from the closed vocabulary ${JSON.stringify(known)}`).toEqual([])
  })
})
