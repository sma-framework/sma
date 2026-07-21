'use strict';
/**
 * One-shot script + library: bidirectional SMA slash-command namespace normalizer.
 *
 * - Default direction (transformContent): retired /sma-<cmd> → /sma:<cmd>
 *   (keeps monorepo sources, docs, and workflows in the active colon form).
 * - Reverse direction (transformContentToHyphen): /sma:<cmd> / sma:<cmd> → sma-<cmd>
 *   (used during skill installation for runtimes that register skills under the
 *   canonical hyphen form established in #2808).
 *
 * Both directions only rewrite known commands from `commands/sma/*.md` (longest-first
 * matching + word-boundary safety). Non-commands (sma-sdk, sma-tools, etc.) are
 * intentionally left untouched.
 *
 * The pure transforms live in sma-core/bin/lib/command-roster.cjs — the runtime
 * module shipped inside every install — and this dev-time one-shot requires them
 * from there. The dependency used to point the other way (command-roster required
 * this file at `../../../scripts/`), which resolved in the source tree but not in
 * installs, where scripts/ is never delivered next to sma-core/. Reversing it
 * keeps installs self-contained while this walker stays dev-only.
 *
 * Derived from the upstream `scripts/fix-slash-commands.cjs` pattern
 * (@opengsd/gsd-core 1.6.1), renamed for SMA.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  readSmaCommandNames,
  transformContent,
  transformContentToHyphen,
  buildPattern,
  buildColonPattern,
} = require('../sma-core/bin/lib/command-roster.cjs');

// Kept as a named export for API compatibility: the roster resolves the same
// <repo>/commands/sma directory this file historically read (scripts/.. and
// sma-core/bin/lib/../../.. are both the repo root in the source tree).
const readCmdNames = readSmaCommandNames;

const SEARCH_DIRS = [
  path.join(__dirname, '..', 'sma-core', 'bin', 'lib'),
  path.join(__dirname, '..', 'sma-core', 'workflows'),
  path.join(__dirname, '..', 'sma-core', 'references'),
  path.join(__dirname, '..', 'sma-core', 'templates'),
  path.join(__dirname, '..', 'sma-core', 'contexts'),
  path.join(__dirname, '..', 'commands', 'sma'),
  path.join(__dirname, '..', 'agents'),
  path.join(__dirname, '..', 'hooks'),
];

const TOP_LEVEL_FILES = [
  path.join(__dirname, '..', '.clinerules'),
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo']);
const EXTENSIONS = new Set(['.md', '.cjs', '.js', '.ts', '.tsx']);

// Test files contain intentional fixture strings (e.g. inputs the sanitizer
// is expected to strip). Rewriting them changes test semantics.
function isTestFile(name) {
  return /\.test\.(c?js|tsx?)$/.test(name);
}

function processFile(file, cmdNames) {
  const pattern = buildPattern(cmdNames);
  if (!pattern) return;
  let src;
  try { src = fs.readFileSync(file, 'utf-8'); } catch { return; }
  const replaced = transformContent(src, cmdNames);
  if (replaced !== src) {
    fs.writeFileSync(file, replaced, 'utf-8');
    const count = (src.match(pattern) || []).length;
    console.log(`  ${count} replacements: ${path.relative(path.join(__dirname, '..'), file)}`);
  }
}

function processDir(dir, cmdNames) {
  const pattern = buildPattern(cmdNames);
  if (!pattern) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      processDir(full, cmdNames);
    } else if (EXTENSIONS.has(path.extname(e.name)) && !isTestFile(e.name)) {
      processFile(full, cmdNames);
    }
  }
}

if (require.main === module) {
  const cmdNames = readCmdNames();
  for (const dir of SEARCH_DIRS) {
    processDir(dir, cmdNames);
  }
  for (const file of TOP_LEVEL_FILES) {
    processFile(file, cmdNames);
  }
  console.log('Done.');
}

module.exports = {
  transformContent,
  transformContentToHyphen,
  buildPattern,
  buildColonPattern,
  readCmdNames,
  SKIP_DIRS
};
