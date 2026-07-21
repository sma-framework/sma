'use strict';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkCliSkew = checkCliSkew;
/**
 * cli-skew-check.cts — CLI version-skew detection (#1754).
 *
 * Pure function: compares the resolved sma-tools.cjs path to the project root.
 * If the resolved CLI is OUTSIDE the project root while a project-local install
 * EXISTS, returns a warning string (the caller writes it to stderr). Non-blocking.
 *
 * Catches the shadowing scenario from #1748: a stale global canary CLI (e.g.
 * from the retired @sma-build/sdk) shadowing the project-local SMA install.
 *
 * The function is PURE (no I/O) — the caller provides the resolved path, the
 * project root, and whether a project-local install exists. This makes it
 * trivially testable without filesystem setup.
 */
const node_path_1 = __importDefault(require("node:path"));
/**
 * Check for CLI version skew.
 *
 * @param opts.resolvedPath - The absolute path of the running sma-tools.cjs (__filename).
 * @param opts.projectRoot - The project root (from findProjectRoot), or null if no project.
 * @param opts.projectLocalExists - Whether a project-local sma-tools.cjs exists.
 * @returns A warning string if skew is detected, or null if no skew.
 */
function checkCliSkew(opts) {
    const { resolvedPath, projectRoot, projectLocalExists } = opts;
    // No project context or no project-local install → no skew possible.
    if (!projectRoot || !projectLocalExists)
        return null;
    // If the resolved CLI is under the project root, it IS a project-local install.
    const rel = node_path_1.default.relative(projectRoot, resolvedPath);
    if (!rel.startsWith('..'))
        return null;
    // Resolved CLI is outside project root while a project-local install exists → SKEW.
    const hint = resolvedPath.includes('@sma-build')
        ? ' If @sma-build/sdk: npm uninstall -g @sma-build/sdk'
        : '';
    return `⚠ SMA: ${resolvedPath} may shadow project-local SMA.${hint}`;
}
