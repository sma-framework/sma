'use strict';
/**
 * Command Roster Module
 *
 * Read-only helper for discovering canonical commands/sma command stems and
 * applying the shared SMA slash-command namespace transform.
 *
 * SELF-CONTAINED ON PURPOSE. This module sits on the sma-tools eager require
 * chain (sma-tools → loop-resolver → capability-state → surface →
 * runtime-artifact-layout → runtime-artifact-conversion → here), and installed
 * runtimes ship ONLY the sma-core/ payload. A former top-level
 * `require('../../../scripts/fix-slash-commands.cjs')` resolved fine in the
 * source tree (scripts/ is a sibling of sma-core/) but pointed at
 * `<configDir>/scripts/` in an install — a path the installer never delivers —
 * so EVERY sma-tools invocation died with MODULE_NOT_FOUND before dispatching
 * anything. The pure transforms live here now; the dev one-shot
 * `scripts/fix-slash-commands.cjs` requires them FROM this module (dependency
 * reversed) so the two implementations cannot drift. Do not add requires that
 * reach outside sma-core/ at module load — see install-layout.test.ts.
 */
const fs = require('node:fs');
const path = require('node:path');

// commands/sma sits three levels up from this file in BOTH layouts
// (mirrors capability-state.cjs _resolveCommandsSmaDir):
//   source tree: <repo>/sma-core/bin/lib      → <repo>/commands/sma
//   installed:   <configDir>/sma-core/bin/lib → <configDir>/commands/sma
// Either directory may be absent (skill-based runtimes install no commands
// tree; this repo derives skills from sma-core/workflows) — readCmdNames
// degrades to [] on ENOENT and the transforms below no-op on an empty list.
const COMMANDS_DIR = path.resolve(__dirname, '..', '..', '..', 'commands', 'sma');

function buildPattern(cmdNames) {
    // Empty input would compile `/sma-()(?=[^a-zA-Z0-9_-]|$)/g`, which the regex
    // engine still matches at any `/sma-` token followed by a non-word boundary
    // (e.g. EOL, whitespace, punctuation) — rewriting it to a stray `/sma:`.
    // Short-circuit so the caller can no-op on a missing/empty registry rather
    // than perform an unintended broad rewrite.
    if (!Array.isArray(cmdNames) || cmdNames.length === 0)
        return null;
    const sorted = [...cmdNames].sort((a, b) => b.length - a.length); // longest first to avoid partial matches
    return new RegExp(`/sma-(${sorted.join('|')})(?=[^a-zA-Z0-9_-]|$)`, 'g');
}

/**
 * Pure transform: rewrite retired `/sma-<cmd>` to `/sma:<cmd>` for the given command names.
 * Returns the rewritten string. Identifiers not in `cmdNames` (e.g. `/sma-sdk`,
 * `/sma-tools`) are left untouched.
 */
function transformContent(src, cmdNames) {
    const pattern = buildPattern(cmdNames);
    if (!pattern)
        return src;
    return src.replace(pattern, (_, cmd) => `/sma:${cmd}`);
}

/**
 * Build regex for the reverse direction (colon form → hyphen form).
 * Matches both "sma:cmd" and "/sma:cmd" (the leading / is preserved automatically
 * because it is not part of the match). Uses longest-first ordering plus
 * bidirectional word-boundary safety (negative lookbehind on the left, lookahead
 * on the right) so matches only occur at token boundaries.
 */
function buildColonPattern(cmdNames) {
    if (!Array.isArray(cmdNames) || cmdNames.length === 0)
        return null;
    const sorted = [...cmdNames].sort((a, b) => b.length - a.length);
    return new RegExp(`(?<![a-zA-Z0-9_-])sma:(${sorted.join('|')})(?=[^a-zA-Z0-9_-]|$)`, 'g');
}

/**
 * Pure transform (reverse): rewrite `/sma:<cmd>` / `sma:<cmd>` to hyphen form
 * for known SMA commands.
 *
 * Non-command identifiers (e.g. sma-sdk, sma-tools) are left untouched, matching
 * the safety contract of the forward transform.
 */
function transformContentToHyphen(src, cmdNames) {
    const pattern = buildColonPattern(cmdNames);
    if (!pattern)
        return src;
    return src.replace(pattern, (_, cmd) => `sma-${cmd}`);
}

function readSmaCommandNames() {
    try {
        return fs.readdirSync(COMMANDS_DIR)
            .filter(f => f.endsWith('.md'))
            .map(f => f.replace(/\.md$/, ''));
    }
    catch (err) {
        // Only swallow the missing-directory case. Any other error (EACCES, ENOTDIR,
        // etc.) indicates a real misconfiguration and must propagate so callers are
        // not silently handed an empty registry while the real problem goes undetected.
        if (err.code !== 'ENOENT')
            throw err;
        // COMMANDS_DIR may not exist on installs that use skill-based runtimes or
        // global Claude installs (no local commands/sma/ directory). Return [] so
        // callers that handle an empty array gracefully (buildPattern returns null,
        // transformContent is a no-op) are not broken by a missing directory.
        return [];
    }
}

module.exports = {
    readSmaCommandNames,
    transformContentToHyphen,
    transformContent,
    buildPattern,
    buildColonPattern,
};
