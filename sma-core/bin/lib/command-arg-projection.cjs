"use strict";
/**
 * Command Argument Projection Module (ADR-457 build-at-publish: the
 * hand-written bin/lib/command-arg-projection.cjs collapsed to a TypeScript
 * source of truth). Behaviour is preserved byte-for-behaviour from the prior
 * hand-written .cjs; only types are added.
 *
 * Shared helpers for command-family adapters to project argv tokens into
 * typed named values and multi-word segments.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseNamedArgs = parseNamedArgs;
exports.parseMultiwordArg = parseMultiwordArg;
exports.collectPositionals = collectPositionals;
exports.parseNamedArgsWithPositionals = parseNamedArgsWithPositionals;
/**
 * Extract named --flag <value> pairs from an args array.
 * Returns an object mapping flag names to their values (null if absent).
 * Flags listed in `booleanFlags` are treated as booleans.
 */
function parseNamedArgs(args, valueFlags = [], booleanFlags = []) {
    // Index each token's first position once (firstIndex.get(t) ?? -1 === args.indexOf(t),
    // firstIndex.has(t) === args.includes(t)) so the flag loops below don't each re-scan
    // argv — O(argv + flags) instead of O(flags * argv). Semantics are unchanged. (#312)
    const firstIndex = new Map();
    for (let i = 0; i < args.length; i++) {
        if (!firstIndex.has(args[i]))
            firstIndex.set(args[i], i);
    }
    const result = {};
    for (const flag of valueFlags) {
        const idx = firstIndex.has(`--${flag}`) ? firstIndex.get(`--${flag}`) : -1;
        result[flag] =
            idx !== -1 && args[idx + 1] !== undefined && !args[idx + 1].startsWith('--')
                ? args[idx + 1]
                : null;
    }
    for (const flag of booleanFlags) {
        result[flag] = firstIndex.has(`--${flag}`);
    }
    return result;
}
/**
 * The bare tokens of a family argv `[family, subcommand, ...rest]` — everything
 * after the subcommand that is neither a `--flag` nor the value one consumed.
 *
 * `valueFlags` is what makes the second half possible: without it,
 * `add-decision --phase 11 "text"` would offer `11` as a positional.
 */
function collectPositionals(args, valueFlags = []) {
    const valueFlagTokens = new Set(valueFlags.map(flag => `--${flag}`));
    const positionals = [];
    for (let i = 2; i < args.length; i++) {
        const token = args[i];
        if (typeof token !== 'string')
            continue;
        if (token.startsWith('--')) {
            // A value flag eats the next token (matching parseNamedArgs' own rule);
            // a boolean or unknown flag eats nothing.
            const next = args[i + 1];
            if (valueFlagTokens.has(token) && next !== undefined && !next.startsWith('--'))
                i += 1;
            continue;
        }
        positionals.push(token);
    }
    return positionals;
}
/**
 * parseNamedArgs, plus the POSITIONAL spelling of the same command.
 *
 * Several state verbs accepted only `--flag value` while the
 * shipped executor documentation and workflows call them positionally
 * (`state.record-metric "$PHASE" "$PLAN" "$DURATION" …`). The mismatch failed
 * SILENTLY — `record-session "" "Completed 11-02" "None"` reported
 * `{"recorded": true}` and dropped the text. Accepting both spellings is the
 * non-breaking direction: every existing flag caller is untouched, and the
 * documented positional form starts doing what it says.
 *
 * A FLAG ALWAYS WINS: positionals only fill slots that no flag filled, so the two
 * spellings can be mixed (`add-decision --phase 11 "the text"`) without the parser
 * ever having to guess which bare token belongs to which flag.
 *
 * `positionalOrder` names the flag each slot fills; a `null`/empty entry means "this
 * slot exists in the documented form but is ignored", and it still consumes a token.
 */
function parseNamedArgsWithPositionals(args, valueFlags = [], positionalOrder = [], booleanFlags = []) {
    const named = parseNamedArgs(args, valueFlags, booleanFlags);
    const positionals = collectPositionals(args, valueFlags);
    let next = 0;
    for (const name of positionalOrder) {
        if (next >= positionals.length)
            break;
        if (!name) {
            next += 1; // reserved slot — consumed, discarded
            continue;
        }
        if (named[name] !== null && named[name] !== undefined)
            continue; // the flag spelling wins; no positional is consumed for it
        named[name] = positionals[next];
        next += 1;
    }
    return named;
}
/**
 * Collect all tokens after --flag until the next --flag or end of args.
 */
function parseMultiwordArg(args, flag) {
    const idx = args.indexOf(`--${flag}`);
    if (idx === -1)
        return null;
    const tokens = [];
    for (let i = idx + 1; i < args.length; i++) {
        if (args[i].startsWith('--'))
            break;
        tokens.push(args[i]);
    }
    return tokens.length > 0 ? tokens.join(' ') : null;
}
