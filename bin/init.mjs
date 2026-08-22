#!/usr/bin/env node
/**
 * sma-framework installer — `npx sma-framework init [--claude] [--local|--global] [--with-gsd-aliases]`
 *
 * Mirrors the upstream `npx @opengsd/gsd-core --claude --local` installer pattern:
 * copy the engine payload, derive the /sma-* command skills from the
 * user-facing workflow set, merge hooks into .claude/settings.json additively and
 * idempotently, scaffold the .sma/ runtime. Node built-ins only — zero dependencies.
 *
 * What it installs:
 *   sma-core/            -> <config>/sma-core/          (engine: workflows, agents, bin, references, templates)
 *   scripts/sma/         -> <project>/scripts/sma/      (V1 runtime: cli.mjs + lib — path parity with hooks)
 *   sma-core/agents      -> <config>/agents/            (subagent definitions, sma-<name>.md)
 *   derived skills       -> <config>/skills/sma-<cmd>/  (thin SKILL.md wrappers over sma-core/workflows)
 *   sma-core/aliases     -> <config>/skills/gsd-<cmd>/  (ONLY with --with-gsd-aliases)
 *   hooks                -> <config>/settings.json      (additive merge, foreign entries preserved;
 *                                                        SMA's own legacy per-stream PreToolUse
 *                                                        entries migrate to the `pre` multiplexer)
 *   .sma/{sessions,claims,journal}                      (runtime scaffold in the project)
 *   memory skeleton      -> <project>/.claude/memory/   (TAGS.md + an empty generated
 *                                                        MEMORY.md — the memory SYSTEM,
 *                                                        ZERO notes; write-if-absent only)
 *   rules block          -> <project>/CLAUDE.md         (managed SMA:RULES block via the emit splice
 *                                                        law: user bytes never touched)
 *
 * <config> = <project>/.claude (--local, default) or $CLAUDE_CONFIG_DIR|~/.claude (--global).
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The package version (single source: package.json) for the installer banner; '' on any failure. */
function pkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

// ── user-facing command set (source of truth: sma-core/aliases/README.md table) ──

const COMMANDS = [
  { name: 'start',         workflow: 'sma-start.md',      description: 'First-run onboarding conversation: explains the system, seeds PROJECT/ROADMAP, the starter memory corpus, and the infra profile' },
  { name: 'plan-phase',    workflow: 'plan-phase.md',     description: 'Create detailed phase plan (PLAN.md) with verification loop' },
  { name: 'execute-phase', workflow: 'execute-phase.md',  description: 'Execute all plans in a phase with wave-based parallelization' },
  { name: 'discuss-phase', workflow: 'discuss-phase.md',  description: 'Gather phase context through adaptive questioning before planning' },
  { name: 'verify-work',   workflow: 'verify-work.md',    description: 'Validate built features through conversational UAT' },
  { name: 'qa',            workflow: 'qa.md',             description: 'Live QA: run the app, check every success criterion by using it, press the surface, file defects with repro steps' },
  { name: 'quick',         workflow: 'quick.md',          description: 'Execute a quick task with SMA guarantees (atomic commits, state tracking) but skip optional agents' },
  { name: 'debug',         workflow: 'debug.md',          description: 'Systematic debugging with persistent state across context resets' },
  { name: 'progress',      workflow: 'progress.md',       description: 'Check progress, advance the workflow, or dispatch freeform intent' },
  { name: 'resume-work',   workflow: 'resume-project.md', description: 'Resume work from a previous session with full context restoration' },
  { name: 'pause-work',    workflow: 'pause-work.md',     description: 'Create a context handoff when pausing work mid-phase' },
  { name: 'fast',          workflow: 'fast.md',           description: 'Execute a trivial task inline, no subagents, no planning overhead' },
  { name: 'help',          workflow: 'help.md',           description: 'Show available SMA commands and usage guide' },
  { name: 'deleteme',      workflow: 'sma-deleteme.md',   description: 'Remove SMA from this project in one action — skills, engine, hooks, statusline, managed blocks; your memory corpus stays' },
  { name: 'update',        workflow: 'sma-update.md',     description: 'Check installed vs available SMA versions and update via the standard installer — memory corpus, profile, and .sma state preserved' },
];

// ── hooks the installer manages (matched by command string for idempotency) ──
// Exported so the installer's own suite asserts the shipped set from THIS list
// instead of keeping a second copy of it, which would quietly drift apart.
//
// EVERY COMMAND IS ANCHORED TO THE PROJECT ROOT — `${CLAUDE_PROJECT_DIR:-.}` — and that
// is the whole point of this table's spelling. A hook is a one-shot process whose working
// directory is INHERITED from the session, not fixed at the project root: the moment a
// session stands somewhere else, a command written relative to the project makes node fail
// to resolve the module BEFORE a single line of engine code runs. Which means none of the
// fail-open wrapping inside the CLI can catch it, and it is not one entry that breaks —
// the entire table goes down at once, plus the status line, because they all share the one
// spelling. The agent harness sets the project-root variable when it runs hooks; where it
// is not set the fallback `.` resolves to exactly what this table said before the anchor
// existed, so the command is never WORSE than the relative form, anywhere.
//
// The path is quoted so a project directory containing spaces stays one argument.
//
// CHANGING ANY COMMAND STRING HERE IS A TWO-PART EDIT: the merge below recognises OUR
// entries by their exact command string, so the string it replaces has to be listed in
// STALE_SMA_HOOK_COMMANDS at the same time — otherwise every existing install gets the new
// entry ADDED BESIDE the old one on its next update, and both keep firing forever.

export const SMA_HOOKS = [
  { event: 'SessionStart', matcher: null, command: 'node "${CLAUDE_PROJECT_DIR:-.}/scripts/sma/cli.mjs" session-start', timeout: 10 },
  // the whole PreToolUse pipeline is ONE `pre` multiplexer
  // spawn — collision → reflex → gates run as ordered streams inside a single
  // node process, so sibling ordering is internal to the CLI, not a property
  // of hook wiring anymore. The old per-stream entries (collision-check /
  // reflex-check / gates-check × 'Edit|Write' and 'Bash') are listed in
  // STALE_SMA_HOOK_COMMANDS below and removed by mergeHooks, so an existing
  // install heals to the single spawn on update.
  { event: 'PreToolUse', matcher: 'Edit|Write|Bash', command: 'node "${CLAUDE_PROJECT_DIR:-.}/scripts/sma/cli.mjs" pre', timeout: 5 },
  // the context pack rides PreToolUse on the Task tool, so every subagent is
  // spawned already carrying the project's claims, gates and open questions
  // instead of rediscovering them. It is its OWN matcher group rather than a
  // wider matcher on the multiplexer above, because `pre` is wired for the
  // editing tools and knows nothing about Task; the consumer invariant is
  // "exactly one SMA chain PER MATCHER", which a second group keeps.
  { event: 'PreToolUse', matcher: 'Task|Agent', command: 'node "${CLAUDE_PROJECT_DIR:-.}/scripts/sma/cli.mjs" pretask-pack', timeout: 10 },
  // the stall detector feeds on PostToolUse. Advisory additionalContext nudge
  // only, never a block. NOT absorbed by `pre` (that multiplexer is
  // PreToolUse-only), so it stays its own entry. The merge below is additive in
  // EVERY event: foreign entries — a project's own security guard, say — are
  // never dropped or reordered, including in the events this template now
  // writes to as well.
  { event: 'PostToolUse', matcher: 'Edit|Write|Bash', command: 'node "${CLAUDE_PROJECT_DIR:-.}/scripts/sma/cli.mjs" stall-check', timeout: 5 },
  // The three entries below carry NO matcher on purpose. These events do accept
  // matchers (end reason, compaction trigger, subagent type); leaving the field
  // out is how one entry covers every value of them, which is what all three
  // want.
  //   session-end releases the claims this window is holding, so a terminal
  //   that was simply closed never leaves a teammate blocked on a scope nobody
  //   is editing any more.
  { event: 'SessionEnd', matcher: null, command: 'node "${CLAUDE_PROJECT_DIR:-.}/scripts/sma/cli.mjs" session-end', timeout: 10 },
  //   precompact-capsule writes the flight capsule BEFORE the context is
  //   trimmed. It walks git and the working tree to build one, and a capsule
  //   cut short by the hook budget is state lost for good — so these two get a
  //   longer budget than the editing-path hooks, still short enough that a
  //   person does not feel it.
  { event: 'PreCompact', matcher: null, command: 'node "${CLAUDE_PROJECT_DIR:-.}/scripts/sma/cli.mjs" precompact-capsule', timeout: 15 },
  //   subagent-verify matches what a finishing subagent claimed to have written
  //   against the tree — the same git-and-disk walk, the same reasoning.
  { event: 'SubagentStop', matcher: null, command: 'node "${CLAUDE_PROJECT_DIR:-.}/scripts/sma/cli.mjs" subagent-verify', timeout: 15 },
  //   turn-diff brings the diff verdict back into the window at the boundary of
  //   every turn: which files moved since the claim was taken, and whether any of
  //   them fell outside the area that claim declared. It gets the EDITING-PATH
  //   budget, not the fifteen seconds the two entries above have, and the reason
  //   is the event itself — Stop fires every turn, so its price is paid every turn.
  //
  //   NOTHING HEAVY IS EVER HUNG HERE. Re-running the check commands recorded in
  //   summary files would mean executing strings that arrived as data on a
  //   schedule instead of by a person's decision, and paying a test suite's price
  //   to do it; that re-check belongs to the verb a person types and to the
  //   acceptance ritual. This table already refused to hang even the CHEAP release
  //   of claims on this event, for the same reason — a turn is not an ending.
  { event: 'Stop', matcher: null, command: 'node "${CLAUDE_PROJECT_DIR:-.}/scripts/sma/cli.mjs" turn-diff', timeout: 5 },
];

// Command strings this installer USED to ship and no longer does. They are SMA-managed BY
// CONSTRUCTION — these exact strings only ever came from this template — so mergeHooks may
// drop them without touching foreign hooks. Kept so an existing install is healed (not
// doubled) on update.
//
// This list is not documentation, it is the ONLY thing standing between a changed command
// string and a doubled hook on every machine that ever ran this installer: the merge below
// recognises our entries by their exact string, so an entry it no longer recognises is left
// where it is AND the new spelling is added beside it. Two live processes per event, one of
// them a command we deliberately stopped shipping.
//
// Two generations are listed:
//   1. the per-stream PreToolUse chain that the `pre` multiplexer replaced;
//   2. the PROJECT-RELATIVE spelling of the whole table, replaced by the anchored form
//      above after it turned out to bring the entire table down whenever a session was
//      standing in some other directory.
//
// AN ENTRY BORN ANCHORED NEVER BELONGS HERE. A string this installer never wrote cannot be
// left behind by it, and listing one would hand the sweep permission to delete a command
// that, for all it knows, somebody else put there on purpose. The list is a record of what
// WAS shipped, not a wish about what should disappear.
//
// EXPORTED so the suite builds its «install made before the anchor» fixture from this list
// instead of manufacturing a legacy spelling for every shipped row — a fixture that invents
// history proves the sweep removes strings that never existed.
export const STALE_SMA_HOOK_COMMANDS = new Set([
  'node scripts/sma/cli.mjs collision-check',
  'node scripts/sma/cli.mjs reflex-check',
  'node scripts/sma/cli.mjs gates-check',
  'node scripts/sma/cli.mjs session-start',
  'node scripts/sma/cli.mjs pre',
  'node scripts/sma/cli.mjs pretask-pack',
  'node scripts/sma/cli.mjs stall-check',
  'node scripts/sma/cli.mjs session-end',
  'node scripts/sma/cli.mjs precompact-capsule',
  'node scripts/sma/cli.mjs subagent-verify',
]);

// ── tiny arg parser ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { local: false, global: false, claude: false, withGsdAliases: false, help: false };
  const unknown = [];
  for (const a of argv) {
    if (a === 'init') continue; // `npx sma-framework init` — the default action
    else if (a === '--local' || a === '-l') flags.local = true;
    else if (a === '--global' || a === '-g') flags.global = true;
    else if (a === '--claude') flags.claude = true;
    else if (a === '--with-gsd-aliases') flags.withGsdAliases = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else unknown.push(a);
  }
  return { flags, unknown };
}

function printHelp() {
  console.log(`
  Usage: npx sma-framework init [options]

  Installs the SMA framework (engine + runtime + command skills) into a project
  or into your global Claude Code config.

  Options:
    --claude             Install for Claude Code (default and only runtime today)
    -l, --local          Install into the current project (default)
    -g, --global         Install into $CLAUDE_CONFIG_DIR or ~/.claude
    --with-gsd-aliases   Also install the transitional /gsd-* alias skills
    -h, --help           Show this help

  Examples:
    npx sma-framework init                     # local install, /sma-* commands only
    npx sma-framework init --global            # global install
    npx sma-framework init --with-gsd-aliases  # local + transitional /gsd-* aliases

  Fallback without npm registry access (run FROM YOUR PROJECT directory):
    git clone <repo> ../sma-clone
    node ../sma-clone/bin/init.mjs --local
  (running the installer from inside the clone itself is refused — the clone is
   the package source, not an install target)
`);
}

// ── fs helpers ───────────────────────────────────────────────────────────────

/** Recursive copy with per-entry exclude filter. Node built-ins only. */
function copyDir(src, dest, { exclude = [] } = {}) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (exclude.includes(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d, {}); // excludes apply at top level only
    else cpSync(s, d);
  }
}

/** UTF-8 no BOM, LF-preserving write. */
function writeText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, { encoding: 'utf8' });
}

/**
 * For --local installs, installed markdown references global paths like
 * `$HOME/.claude/sma-core/...` — rewrite them to the project-relative
 * `.claude/sma-core/...` so a clean machine without a global install works:
 * an installed tree may only point at paths that its own install mode creates.
 * Global installs keep the $HOME form.
 */
function rewriteMarkdownPaths(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) rewriteMarkdownPaths(p);
    else if (entry.name.endsWith('.md')) {
      const text = readFileSync(p, 'utf8');
      const next = text
        .replace(/\$HOME\/\.claude\//g, '.claude/')
        .replace(/~\/\.claude\//g, '.claude/');
      if (next !== text) writeText(p, next);
    }
  }
}

// ── hooks merge (additive, idempotent, order-preserving) ─────────────────────

/**
 * Drop the command strings this installer itself used to ship (STALE_SMA_HOOK_COMMANDS)
 * from a parsed settings object IN PLACE. Exact command-string match only — foreign hooks
 * are never touched. A matcher group left empty is removed; an event left empty is removed.
 * Returns the number of entries dropped.
 *
 * EVERY EVENT, not just PreToolUse. It was PreToolUse-only while the only superseded
 * strings were the per-stream chain, which lived nowhere else — and that narrowness is
 * precisely what would have doubled the other six entries the moment the whole table was
 * respelled: a stale SessionStart entry the scan never looked at is a stale entry that
 * survives and then gets a second, live sibling added next to it.
 */
export function removeStaleSmaHooks(settings) {
  if (!settings || typeof settings.hooks !== 'object' || settings.hooks === null) return 0;
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) continue;
      const kept = g.hooks.filter((h) => !(h && STALE_SMA_HOOK_COMMANDS.has(h.command)));
      removed += g.hooks.length - kept.length;
      g.hooks = kept;
    }
    settings.hooks[event] = groups.filter((g) => g && Array.isArray(g.hooks) && g.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  return removed;
}

/**
 * Merge SMA hook entries into a parsed settings object IN PLACE.
 * - first drops SMA's OWN known-stale entries (removeStaleSmaHooks) so an install
 *   carrying a superseded spelling — the legacy 3-spawn PreToolUse chains, or the
 *   project-relative commands of any event — heals on update instead of doubling
 * - never removes or reorders FOREIGN entries
 * - idempotent: an entry whose command string already exists under the same
 *   event (and matcher, for matcher events) is skipped
 * Returns { added, removedStale }.
 */
/**
 * Drop OUR OWN entries that carry a command we still ship but sit under a matcher we no
 * longer use, so a matcher that moves cannot leave a second live copy behind. The stale-
 * command list above cannot cover this case: there the command changed and the matcher
 * stayed, here it is the other way round, and the entry left over is byte-identical to a
 * legitimate one — it just fires from the wrong door. Left alone it means two processes on
 * one event, forever, on every machine that installed the earlier spelling.
 *
 * Strictly OURS: an entry is only dropped when its command is one this installer ships AND
 * that command has a home under this event in the current list. A foreign hook that happens
 * to sit in the same group is never read, let alone removed.
 */
function removeMovedMatcherEntries(settings, hookDefs) {
  if (!settings || typeof settings.hooks !== 'object' || settings.hooks === null) return 0;
  let removed = 0;
  for (const def of hookDefs) {
    const groups = settings.hooks[def.event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) continue;
      const sameMatcher = def.matcher === null ? !g.matcher : g.matcher === def.matcher;
      if (sameMatcher) continue;
      const kept = g.hooks.filter((h) => !(h && h.command === def.command));
      removed += g.hooks.length - kept.length;
      g.hooks = kept;
    }
    settings.hooks[def.event] = groups.filter((g) => g && Array.isArray(g.hooks) && g.hooks.length > 0);
    if (settings.hooks[def.event].length === 0) delete settings.hooks[def.event];
  }
  return removed;
}

export function mergeHooks(settings, hookDefs = SMA_HOOKS) {
  const removedStale = removeStaleSmaHooks(settings);
  const removedMoved = removeMovedMatcherEntries(settings, hookDefs);
  if (typeof settings.hooks !== 'object' || settings.hooks === null) settings.hooks = {};
  let added = 0;
  for (const def of hookDefs) {
    const groups = Array.isArray(settings.hooks[def.event]) ? settings.hooks[def.event] : (settings.hooks[def.event] = []);
    // already present anywhere under this event+matcher? -> skip
    const present = groups.some(
      (g) =>
        (def.matcher === null ? !g.matcher : g.matcher === def.matcher) &&
        Array.isArray(g.hooks) &&
        g.hooks.some((h) => h && h.command === def.command),
    );
    if (present) continue;
    const hookEntry = { type: 'command', command: def.command, timeout: def.timeout };
    // reuse an existing group with the same matcher when there is one
    const group = groups.find((g) => (def.matcher === null ? !g.matcher : g.matcher === def.matcher));
    if (group && Array.isArray(group.hooks)) group.hooks.push(hookEntry);
    else groups.push(def.matcher === null ? { hooks: [hookEntry] } : { matcher: def.matcher, hooks: [hookEntry] });
    added += 1;
  }
  return { added, removedStale, removedMoved };
}

// ── skill derivation ─────────────────────────────────────────────────────────

function skillBody(cmd, workflowRef) {
  return `---
name: sma-${cmd.name}
description: "${cmd.description}"
---

# /sma-${cmd.name}

Read and follow \`${workflowRef}\` end to end, treating the user's arguments as \`$ARGUMENTS\`. That workflow file is the single source of truth for this command; this skill adds nothing and removes nothing.
`;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { flags, unknown } = parseArgs(process.argv.slice(2));
  if (flags.help) return printHelp();
  if (unknown.length) {
    console.error(`Unknown option(s): ${unknown.join(' ')}\nRun with --help for usage.`);
    process.exit(1);
  }
  if (flags.local && flags.global) {
    console.error('Pick ONE of --local or --global.');
    process.exit(1);
  }

  const isGlobal = flags.global;
  const project = process.cwd();
  if (path.resolve(project) === path.resolve(pkgRoot)) {
    console.error(
      'Refusing to install into the package clone itself.\n' +
      'Run the installer FROM the project you want SMA installed into:\n' +
      `  cd <your-project> && node ${path.relative(project, path.join(pkgRoot, 'bin', 'init.mjs')) || 'bin/init.mjs'} --local`
    );
    process.exit(1);
  }
  const configDir = isGlobal
    ? (process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim()) || path.join(homedir(), '.claude')
    : path.join(project, '.claude');
  // The @-reference prefix inside installed markdown for this install shape.
  const workflowPrefix = isGlobal ? '$HOME/.claude' : '.claude';

  const srcCore = path.join(pkgRoot, 'sma-core');
  const srcRuntime = path.join(pkgRoot, 'scripts', 'sma');
  if (!existsSync(srcCore) || !existsSync(srcRuntime)) {
    console.error('Package payload missing (sma-core/ or scripts/sma/). Corrupt install?');
    process.exit(1);
  }

  const version = pkgVersion();
  console.log(`\nInstalling SMA${version ? ` v${version}` : ''} (${isGlobal ? 'global' : 'local'}) ...\n`);

  // 1. Engine: sma-core -> <config>/sma-core (aliases ship separately, flag-gated)
  const destCore = path.join(configDir, 'sma-core');
  copyDir(srcCore, destCore, { exclude: ['aliases'] });
  if (!isGlobal) rewriteMarkdownPaths(destCore);
  console.log(`  + engine        ${destCore}`);

  // 2. Runtime: scripts/sma -> <project>/scripts/sma (path parity with the hooks below)
  const destRuntime = path.join(project, 'scripts', 'sma');
  copyDir(srcRuntime, destRuntime, { exclude: ['__tests__'] });
  console.log(`  + runtime       ${destRuntime}`);

  // 3. Agents: sma-core/agents/sma-*.md -> <config>/agents
  const destAgents = path.join(configDir, 'agents');
  mkdirSync(destAgents, { recursive: true });
  let agentCount = 0;
  for (const f of readdirSync(path.join(srcCore, 'agents'))) {
    if (!f.startsWith('sma-') || !f.endsWith('.md')) continue;
    cpSync(path.join(srcCore, 'agents', f), path.join(destAgents, f));
    agentCount += 1;
  }
  if (!isGlobal) rewriteMarkdownPaths(destAgents);
  console.log(`  + agents        ${agentCount} -> ${destAgents}`);

  // 4. Command skills derived from the user-facing workflow set
  const destSkills = path.join(configDir, 'skills');
  let skillCount = 0;
  for (const cmd of COMMANDS) {
    if (!existsSync(path.join(srcCore, 'workflows', cmd.workflow))) {
      console.warn(`  ! skipping /sma-${cmd.name}: workflow ${cmd.workflow} not found in payload`);
      continue;
    }
    const ref = `${workflowPrefix}/sma-core/workflows/${cmd.workflow}`;
    writeText(path.join(destSkills, `sma-${cmd.name}`, 'SKILL.md'), skillBody(cmd, ref));
    skillCount += 1;
  }
  console.log(`  + skills        ${skillCount} /sma-* commands -> ${destSkills}`);

  // 5. Transitional /gsd-* aliases — ONLY with --with-gsd-aliases
  if (flags.withGsdAliases) {
    const srcAliases = path.join(srcCore, 'aliases');
    let aliasCount = 0;
    if (existsSync(srcAliases)) {
      for (const entry of readdirSync(srcAliases, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('gsd-')) continue;
        copyDir(path.join(srcAliases, entry.name), path.join(destSkills, entry.name));
        aliasCount += 1;
      }
    }
    console.log(`  + aliases       ${aliasCount} transitional /gsd-* skills (remove once the transition window closes)`);
  }

  // 6. Hooks merge into <config>/settings.json — additive + idempotent for
  // foreign entries; SMA's own legacy per-stream PreToolUse chains
  // are migrated to the single `pre` multiplexer entry.
  const settingsPath = path.join(configDir, 'settings.json');
  let settings = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf8').replace(/^﻿/, ''); // strip BOM if present
    try {
      settings = JSON.parse(raw);
    } catch (e) {
      console.error(`\nERROR: ${settingsPath} is not valid JSON (${e.message}).`);
      console.error('Refusing to touch it — fix the file and re-run init.');
      process.exit(1);
    }
  }
  const { added, removedStale, removedMoved } = mergeHooks(settings);
  writeText(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  // Two different repairs, named apart: one replaced a command we stopped shipping, the
  // other removed a copy of a command we still ship that sat under a matcher we moved.
  // One sentence for both would tell the operator the wrong story about their own file.
  const staleNote = removedStale ? `, ${removedStale} superseded entries replaced (legacy per-stream entries, project-relative commands)` : '';
  const movedNote = removedMoved ? `, ${removedMoved} entries dropped from a matcher this installer no longer uses` : '';
  console.log(`  + hooks         ${added} added${staleNote}${movedNote}, foreign entries preserved (${settingsPath})`);

  // 6.5. Statusline segment — the engine's own line in the terminal status bar.
  //
  // The managed edit is IMPORTED from lib, never spawned as the `statusline install`
  // verb and never re-implemented here. Spawning it would be worse than a copy: the
  // verb resolves the state root through the SHARED git directory, so a spawn from a
  // linked working copy writes the settings of a DIFFERENT checkout. And a second
  // implementation of the same write is the defect class this installer has already
  // paid for once — two lists of one thing drift apart, and the drift only surfaces
  // when a user is standing on it. One implementation, every caller imports it.
  //
  // ALWAYS the PROJECT settings file, even for a global install, and that refusal is
  // deliberate rather than an oversight: the command is project-relative
  // (`node scripts/sma/cli.mjs statusline`), so a user-scope entry would run in EVERY
  // project the adopter opens, including all the ones without this runtime — where it
  // fails, prints nothing, and shadows the adopter's own status line with emptiness
  // everywhere at once (a project-level statusLine takes precedence over the user one).
  // Same rule the runtime at scripts/sma already follows: always project-level.
  const statuslineSettingsPath = path.join(project, '.claude', 'settings.json');
  try {
    const { pathToFileURL } = await import('node:url');
    const statusline = await import(pathToFileURL(path.join(pkgRoot, 'scripts', 'sma', 'lib', 'statusline-install.mjs')).href);
    const res = await statusline.applyStatuslineInstall('install', {
      settingsPath: statuslineSettingsPath,
      dirs: { statuslineDir: path.join(project, '.sma', 'statusline') },
      by: 'sma init',
      now: Date.now(),
    });
    // Reported BY STATUS, not by one sentence for every outcome. Someone who installed
    // the segment by hand in an earlier release must be told "unchanged", not
    // "installed" — a report that calls a no-op an install teaches the operator the
    // wrong thing about their own file.
    if (res.status === 'installed') {
      console.log(`  + statusline    engine segment (${statuslineSettingsPath})`);
    } else if (res.status === 'installed-wrap') {
      console.log(`  + statusline    engine segment; your own status line was kept and prints first`);
    } else if (res.status === 'noop-already') {
      console.log(`  + statusline    engine segment already installed — unchanged`);
    } else {
      // parse-failed: the hooks step above exits on an unparseable file, so this is
      // nearly unreachable locally — the file would have to change between the two
      // steps. Kept anyway, and it WARNS rather than failing the install: nothing was
      // written, so there is nothing to roll back.
      const snippet = JSON.stringify(statusline.canonicalStatuslineEntry(statusline.SMA_STATUSLINE_CMD));
      console.warn(`  ! statusline    ${statuslineSettingsPath} is not valid JSON — nothing written; add "statusLine": ${snippet} by hand`);
    }
  } catch (e) {
    console.warn(`  ! statusline    segment skipped (${e && e.message ? e.message : e})`);
  }

  // 7. .sma/ runtime scaffold + .gitignore line
  for (const d of ['sessions', 'claims', 'journal', 'reflex']) mkdirSync(path.join(project, '.sma', d), { recursive: true });
  const gitignorePath = path.join(project, '.gitignore');
  if (existsSync(gitignorePath)) {
    const gi = readFileSync(gitignorePath, 'utf8');
    // Recognize any existing rule that already ignores the .sma directory —
    // `.sma`, `.sma/`, or the `.sma/*` idiom (often paired with `!.sma/README.md`
    // to keep the README tracked). Appending a blunt `.sma/` when `.sma/*` is
    // already present would shadow that re-include (git cannot re-include a file
    // whose parent dir is excluded), so the check must treat `.sma/*` as covered.
    if (!/^\.sma\/?\*?\s*$/m.test(gi)) {
      writeText(gitignorePath, gi + (gi.endsWith('\n') || gi === '' ? '' : '\n') + '.sma/\n');
      console.log('  + .gitignore    added .sma/ line');
    }
  }
  console.log(`  + runtime dirs  .sma/{sessions,claims,journal,reflex}`);

  // 7.4. Memory SYSTEM scaffold — the structure ships, the content never does.
  // The rules block written just below points every agent at
  // `.claude/memory/MEMORY.md`; without this step that pointer named a file no
  // install ever created, and `build-index --write` died with ENOENT because the
  // corpus dir only appeared if the user finished /sma-start. Writes TAGS.md +
  // an empty generated MEMORY.md, and ONLY where absent — an existing corpus is
  // the user's asset and is never touched (same law as `sma deleteme`).
  try {
    const { pathToFileURL } = await import('node:url');
    const scaffold = await import(pathToFileURL(path.join(pkgRoot, 'scripts', 'sma', 'lib', 'memory-scaffold.mjs')).href);
    const res = await scaffold.scaffoldMemory({ projectDir: project });
    const what = res.created.length ? `${res.created.join(' + ')} (0 notes)` : 'existing corpus kept as it was';
    console.log(`  + memory        ${what} -> ${res.dir}`);
  } catch (e) {
    console.warn(`  ! memory        corpus skeleton skipped (${e && e.message ? e.message : e})`);
  }

  // 7.5. CLAUDE.md — managed SMA rules block (v3.6): most installs have no
  // autoMemoryDirectory wiring, so without this pointer the memory corpus is
  // invisible to the very agent it exists for. Same splice law as `sma emit`,
  // its own SMA:RULES anchor family; an embed failure warns, NEVER fails the install.
  try {
    const { pathToFileURL } = await import('node:url');
    const embed = await import(pathToFileURL(path.join(pkgRoot, 'scripts', 'sma', 'lib', 'claude-embed.mjs')).href);
    const res = embed.embedRules({ projectDir: project, version });
    if (res.action === 'skipped-corrupt') {
      console.warn('  ! CLAUDE.md     SMA:RULES anchors are torn — block NOT written; fix the markers and re-run init');
    } else if (res.action === 'error') {
      console.warn(`  ! CLAUDE.md     rules block not written (${res.detail})`);
    } else {
      console.log(`  + CLAUDE.md     SMA rules block (${res.action})`);
    }
  } catch (e) {
    console.warn(`  ! CLAUDE.md     rules block skipped (${e && e.message ? e.message : e})`);
  }

  // 8. Plain-language completion summary
  console.log(`
Done. SMA${version ? ` v${version}` : ''} is installed${isGlobal ? ' globally' : ' in this project'}.

  What you got:
    - the SMA engine (workflows, agents, templates) under ${isGlobal ? '~/.claude' : '.claude'}/sma-core
    - the coordination runtime at scripts/sma (multi-terminal sessions, claims, journal)
    - the /sma-* command skills (${skillCount} commands)${flags.withGsdAliases ? '\n    - the transitional /gsd-* aliases' : ''}
    - the memory system at .claude/memory (tag registry + index, EMPTY — the notes will be yours)
    - hooks in ${isGlobal ? '~/.claude' : '.claude'}/settings.json (your own hooks were kept as they were)
    - the engine segment in your terminal status line (.claude/settings.json — your own line, if you had one, still prints first)

  Next step: open a Claude Code session in this project and run \`/sma-start\`.
`);
}

// Only run when executed directly (mergeHooks stays importable for tests).
// realpathSync derefs the node_modules/.bin symlink npx uses on unix.
let invokedDirectly = false;
if (process.argv[1]) {
  try {
    const { realpathSync } = await import('node:fs');
    invokedDirectly = realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    invokedDirectly = path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}
if (invokedDirectly) await main();
