/**
 * pricing.mjs — THE ONE PRICE LIST of the whole tree.
 *
 * ═══════════════════════ WHY IT IS ITS OWN FILE ═══════════════════════════════
 *
 * The table used to live inside spend-adapter.mjs, where only the `sma spend` ledger could
 * reach it. The daemon books its own usage rows and asks the same question of them — «what
 * would this attempt have cost on the API» — and the cheapest way to answer it over there is
 * a second table. A second table is how one household ends up with two different answers to
 * one question: on the day one copy is corrected, the other keeps quoting last year's rate
 * and nothing anywhere says so. So the list moved ABOVE both readers, and both import it.
 * The CLI substrate keeps its zero-dependency law (this module is Node built-ins and
 * arithmetic); the daemon depends on the substrate, never the other way round.
 *
 * ═══════════════════════ NEVER FETCHED, ALWAYS STAMPED ════════════════════════
 *
 * No network, ever (substrate law): the table is versioned DATA, and `pricingVersion` rides
 * into every report so a rate change can never be a silent table swap.
 *
 * ═══════════════════════ THE PRICE IS NOT AN INVOICE ══════════════════════════
 *
 * Nothing here bills anybody. The work runs on subscription plans that are already paid for;
 * a figure computed from this table answers «as if it had gone through the API», and every
 * reader that shows it is obliged to say so, in words, next to the number.
 *
 * Node built-ins only; zero deps, zero network, zero LLM.
 */

/** Finite non-negative token count (else 0) — the same coercion both readers used. */
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** The pricing-table version, stamped into every report (no silent table swaps). */
export const pricingVersion = 'claude-pricing-2026-08-28'

/**
 * PRICING_USD_PER_MTOK — USD per MILLION tokens for the known model families. Input, output,
 * cache-write (cache_creation) and cache-read (cache_read) each have their own rate. An
 * unknown model → null (booked token-only, cost null, `unpriced`) — honesty over guessing.
 * Family match is a substring test on a lowercased model string, so a versioned id
 * ('claude-opus-5') maps to its tier.
 *
 * Source: the official Anthropic pricing page, re-verified 2026-08-28.
 *
 * `cacheWrite` is the 5-minute-TTL write rate (the table's single-rate convention). A
 * 1-hour-TTL write bills higher — fable $20, opus $10, sonnet $4, haiku $2 per MTok — and a
 * booked row does not record WHICH TTL it used, so the shorter rate is applied and the
 * approximation is stated here rather than hidden.
 *
 * WHAT THE 2026-08-28 REVISION CORRECTED, and why each was worth correcting:
 *
 *  - THE HAIKU ROW CARRIED $0.8/$4 — the rates of the PREVIOUS Haiku generation. The current
 *    one is $1/$5 (write $1.25, read $0.10). A stale row does not announce itself: it prices
 *    every haiku token 20 % low forever, and the report looks exactly as trustworthy as a
 *    correct one.
 *  - THE SONNET ROW CARRIED A NOTE ordering a future raise to $3/$15 on 1 September. That
 *    increase was cancelled and $2/$10 is the standing price — so the note was a scheduled
 *    defect: whoever obeyed it on the appointed day would have overcharged every sonnet row
 *    by half, with a comment as their authority. A comment that instructs a future rate
 *    change is not documentation; it is an unattended edit.
 */
export const PRICING_USD_PER_MTOK = Object.freeze({
  fable: Object.freeze({ input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 }),
  opus: Object.freeze({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }),
  sonnet: Object.freeze({ input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }),
  haiku: Object.freeze({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }),
})

/**
 * pricingFor(model) → the tier rates, or null for an unknown model family.
 * @param {string|null|undefined} model
 * @returns {{input:number, output:number, cacheWrite:number, cacheRead:number}|null}
 */
export function pricingFor(model) {
  const m = String(model || '').toLowerCase()
  if (m.includes('fable') || m.includes('mythos')) return PRICING_USD_PER_MTOK.fable
  if (m.includes('opus')) return PRICING_USD_PER_MTOK.opus
  if (m.includes('sonnet')) return PRICING_USD_PER_MTOK.sonnet
  if (m.includes('haiku')) return PRICING_USD_PER_MTOK.haiku
  return null
}

/**
 * priceUsd({model, input, output, cacheRead, cacheWrite}) → USD for those four counts at
 * that model's rates, rounded to 1e-6 — or NULL when the family is unknown.
 *
 * Null rather than 0: a zero would say «this work was free», and an unpriced model means
 * «nobody here knows what it costs». The callers keep the tokens either way and report the
 * unpriced share; that is the whole difference between an estimate and a fib.
 *
 * @param {{model?:string|null, input?:number, output?:number, cacheRead?:number, cacheWrite?:number}} [counts]
 * @returns {number|null}
 */
export function priceUsd({ model, input, output, cacheRead, cacheWrite } = {}) {
  const rates = pricingFor(model)
  if (!rates) return null
  const usd =
    (num(input) * rates.input +
      num(output) * rates.output +
      num(cacheRead) * rates.cacheRead +
      num(cacheWrite) * rates.cacheWrite) /
    1e6
  return Math.round(usd * 1e6) / 1e6
}
