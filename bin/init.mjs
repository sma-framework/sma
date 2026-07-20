#!/usr/bin/env node
/**
 * sma-framework installer — `npx sma-framework init [--claude] [--local|--global] [--with-gsd-aliases]`
 *
 * Mirrors the upstream `npx @opengsd/gsd-core --claude --local` installer pattern
 * (D-9.1-06): copy the engine payload, derive the /sma-* command skills from the
 * user-facing workflow set, merge hooks into .claude/settings.json additively and
 * idempotently, scaffold the .sma/ runtime. Node built-ins only — zero dependencies.
 *
 * What it installs:
 *   sma-core/            -> <config>/sma-core/          (engine: workflows, agents, bin, references, templates)
 *   scripts/sma/         -> <project>/scripts/sma/      (V1 runtime: cli.mjs + lib — path parity with hooks)
 *   sma-core/agents      -> <config>/agents/            (subagent definitions, sma-<name>.md)
 *   derived skills       -> <config>/skills/sma-<cmd>/  (thin SKILL.md wrappers over sma-core/workflows)
 *   sma-core/aliases     -> <config>/skills/gsd-<cmd>/  (ONLY with --with-gsd-aliases, D-9.1-02)
 *   hooks                -> <config>/settings.json      (additive merge, existing entries preserved)
 *   .sma/{sessions,claims,journal}                      (runtime scaffold in the project)
 *   rules block          -> <project>/CLAUDE.md         (managed SMA:RULES block via the emit splice
 *                                                        law — BL-165; user bytes never touched)
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
  { name: 'quick',         workflow: 'quick.md',          description: 'Execute a quick task with SMA guarantees (atomic commits, state tracking) but skip optional agents' },
  { name: 'debug',         workflow: 'debug.md',          description: 'Systematic debugging with persistent state across context resets' },
  { name: 'progress',      workflow: 'progress.md',       description: 'Check progress, advance the workflow, or dispatch freeform intent' },
  { name: 'resume-work',   workflow: 'resume-project.md', description: 'Resume work from a previous session with full context restoration' },
  { name: 'pause-work',    workflow: 'pause-work.md',     description: 'Create a context handoff when pausing work mid-phase' },
  { name: 'fast',          workflow: 'fast.md',           description: 'Execute a trivial task inline, no subagents, no planning overhead' },
  { name: 'help',          workflow: 'help.md',           description: 'Show available SMA commands and usage guide' },
  { name: 'deleteme',      workflow: 'sma-deleteme.md',   description: 'Remove SMA from this project in one action — skills, engine, hooks, statusline, managed blocks; your memory corpus stays' },
];

// ── hooks the installer manages (matched by command string for idempotency) ──

const SMA_HOOKS = [
  { event: 'SessionStart', matcher: null, command: 'node scripts/sma/cli.mjs session-start', timeout: 10 },
  { event: 'PreToolUse', matcher: 'Edit|Write', command: 'node scripts/sma/cli.mjs collision-check', timeout: 5 },
  { event: 'PreToolUse', matcher: 'Bash', command: 'node scripts/sma/cli.mjs collision-check', timeout: 5 },
  // 9.1-10 (B2): the reflex consumer is a SIBLING of collision-check, not a
  // replacement — listed AFTER it so mergeHooks appends it behind the collision
  // entry in each matcher group. Every install target fires reflexes from day one.
  { event: 'PreToolUse', matcher: 'Edit|Write', command: 'node scripts/sma/cli.mjs reflex-check', timeout: 5 },
  { event: 'PreToolUse', matcher: 'Bash', command: 'node scripts/sma/cli.mjs reflex-check', timeout: 5 },
  // 9.1-16 (B9/B10, D-9.1-12): the checkable HARD-RULE gates are a SIBLING of
  // reflex-check — listed AFTER it so mergeHooks appends gates-check behind the
  // reflex entry in each matcher group. Advisory WARN only (permissionDecision
  // allow); every install target enforces the inventory in observation mode.
  { event: 'PreToolUse', matcher: 'Edit|Write', command: 'node scripts/sma/cli.mjs gates-check', timeout: 5 },
  { event: 'PreToolUse', matcher: 'Bash', command: 'node scripts/sma/cli.mjs gates-check', timeout: 5 },
  // 9.1-21 (B16): the stall detector feeds on PostToolUse — a NEW hook type
  // for SMA (any pre-existing Stop/SubagentStop entries, e.g. a project's
  // security guard, live under different events and are untouched by the
  // additive merge). Advisory additionalContext nudge only, never a block.
  { event: 'PostToolUse', matcher: 'Edit|Write|Bash', command: 'node scripts/sma/cli.mjs stall-check', timeout: 5 },
];

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
    --with-gsd-aliases   Also install the transitional /gsd-* alias skills (D-9.1-02)
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
 * `.claude/sma-core/...` so a clean machine without a global install works
 * (FI-13 packaging honesty). Global installs keep the $HOME form.
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
 * Merge SMA hook entries into a parsed settings object IN PLACE.
 * - never removes or reorders existing entries (T-9.1-08)
 * - idempotent: an entry whose command string already exists under the same
 *   event (and matcher, for matcher events) is skipped
 * Returns the number of entries added.
 */
export function mergeHooks(settings, hookDefs = SMA_HOOKS) {
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
  return added;
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

  // 5. Transitional /gsd-* aliases — ONLY with --with-gsd-aliases (D-9.1-02)
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
    console.log(`  + aliases       ${aliasCount} transitional /gsd-* skills (remove after phases 51/52 close)`);
  }

  // 6. Hooks merge into <config>/settings.json — additive + idempotent (T-9.1-08)
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
  const added = mergeHooks(settings);
  writeText(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`  + hooks         ${added} added, existing entries preserved (${settingsPath})`);

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

  // 7.5. CLAUDE.md — managed SMA rules block (BL-165, v3.6): most installs have no
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
    - hooks in ${isGlobal ? '~/.claude' : '.claude'}/settings.json (your existing hooks were kept as they were)

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
