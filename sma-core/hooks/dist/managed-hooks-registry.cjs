'use strict';

/**
 * Authoritative list of SMA-managed hook files.
 *
 * Extracted from the worker script into a shared CJS module so that:
 *  1. sma-check-update-worker.js can require() it directly (no source-level
 *     duplication).
 *  2. Tests can assert against the exported array instead of regex-parsing
 *     the worker source (retiring the pending-migration-to-typed-ir token
 *     on managed-hooks.test.cjs and orphaned-hooks.test.cjs, per #455).
 *
 * These are the files SMA ships into ~/.claude/hooks/ (or equivalent) and
 * checks for staleness after an update. Orphaned files from removed features
 * (e.g., sma-intel-*.js) must NOT be listed here — that would cause permanent
 * stale warnings for users who haven't cleaned up manually (#1750).
 */
const MANAGED_HOOKS = [
  'sma-check-update-worker.js',
  'sma-check-update.js',
  'sma-config-reload.js',
  'sma-context-monitor.js',
  'sma-cursor-post-tool.js',
  'sma-cursor-pre-tool.js',
  'sma-cursor-session-start.js',
  'sma-cursor-stop.js',
  'sma-cursor-subagent-start.js',
  'sma-cursor-subagent-stop.js',
  'sma-ensure-canonical-path.js',
  'sma-graphify-update.sh',
  'sma-phase-boundary.sh',
  'sma-prompt-guard.js',
  'sma-read-guard.js',
  'sma-read-injection-scanner.js',
  'sma-session-state.sh',
  'sma-statusline.js',
  'sma-update-banner.js',
  'sma-validate-commit.sh',
  'sma-windsurf-pre-command.js',
  'sma-windsurf-pre-write.js',
  'sma-workflow-guard.js',
  'sma-worktree-path-guard.js',
];

module.exports = { MANAGED_HOOKS };
