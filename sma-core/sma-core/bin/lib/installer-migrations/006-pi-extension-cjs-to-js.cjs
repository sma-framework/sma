"use strict";
/**
 * Installer migration: retire pi's stale `extensions/sma.cjs` after #2470
 * renamed the installed native extension to `extensions/sma.js`.
 *
 * What old artifact is being retired?
 *   `extensions/sma.cjs` — the pre-#2470 dest filename for pi's native
 *   extension. pi auto-discovers extensions by scanning `<agentDir>/extensions/`
 *   and keeping only names accepted by its own predicate
 *   (`isExtensionFile()` in @earendil-works/pi-coding-agent:
 *   `name.endsWith(".ts") || name.endsWith(".js")`). A `.cjs` file is skipped
 *   SILENTLY — no `/sma` command, no error, no log line. The file is therefore
 *   permanently inert, not merely redundant.
 *
 * How do we prove it is SMA-owned?
 *   The installer records the native plugin in the install manifest as
 *   `<nativePlugin.dir>/<nativePlugin.file>` (bin/install.js, the
 *   `_hostBehaviors(runtime).nativePlugin` manifest block), so a pre-#2470 pi
 *   install carries `extensions/sma.cjs` as a manifest-managed entry. Only a
 *   manifest-managed classification produces an action here; an unmanifested
 *   `sma.cjs` is treated as a user's own file and preserved.
 *
 * What happens if the user modified it?
 *   `backup-and-remove` instead of `remove-managed`, so a patched extension is
 *   recoverable from the backup rather than silently destroyed.
 *
 * What happens if it is missing?
 *   No actions — fresh (post-#2470) installs and already-migrated installs both
 *   plan empty, so the migration is idempotent.
 *
 * What runtime and scope does it affect?
 *   pi only, global and local. No other runtime ever installed this path:
 *   OpenCode and Kilo — the only other runtimes declaring
 *   `hostBehaviors.nativePlugin` — both ship `plugins/sma-core.js`.
 *
 * Is the action safe in non-interactive install?
 *   Yes. Both emitted action types are non-interactive and journaled; neither
 *   requires a user choice, and unknown files never produce an action.
 *
 * Why not `move-managed`? The installer materializes the new `extensions/sma.js`
 * from the package payload in the same run, so moving the stale file onto that
 * path would just be overwritten. Retiring the old path is the accurate
 * description of the change.
 *
 * See docs/installer-migrations.md#shipped-migrations and the pi row of
 * docs/installer-migrations.md#runtime-configuration-contract-registry.
 */
/** Pre-#2470 dest filename for pi's native extension. */
const STALE_PI_EXTENSION = 'extensions/sma.cjs';
const OWNERSHIP_EVIDENCE = 'pre-#2470 pi installs record the native extension at extensions/sma.cjs in ' +
    'sma-file-manifest.json (installer nativePlugin manifest entry)';
const REASON = 'pi cannot auto-discover a .cjs extension (isExtensionFile accepts only .ts/.js), ' +
    'so this file is inert; superseded by extensions/sma.js (#2470)';
const migration = {
    id: '2026-07-20-pi-extension-cjs-to-js',
    title: 'Retire pi\'s undiscoverable extensions/sma.cjs',
    description: 'Remove the stale extensions/sma.cjs left by pre-#2470 pi installs, superseded by ' +
        'extensions/sma.js — the suffix pi\'s extension auto-discovery actually accepts.',
    introducedIn: '1.7.1',
    runtimes: ['pi'],
    scopes: ['global', 'local'],
    destructive: true,
    plan: (ctx) => {
        const artifact = ctx.classifyArtifact(STALE_PI_EXTENSION);
        if (artifact.classification === 'managed-pristine') {
            return [
                {
                    type: 'remove-managed',
                    relPath: STALE_PI_EXTENSION,
                    reason: REASON,
                    ownershipEvidence: OWNERSHIP_EVIDENCE,
                },
            ];
        }
        if (artifact.classification === 'managed-modified') {
            return [
                {
                    type: 'backup-and-remove',
                    relPath: STALE_PI_EXTENSION,
                    reason: REASON,
                    ownershipEvidence: OWNERSHIP_EVIDENCE,
                },
            ];
        }
        // 'unknown' (never SMA-managed), 'missing', and 'managed-missing' all plan
        // nothing: unknown files are preserved by policy, and an absent file needs
        // no retirement.
        return [];
    },
};
module.exports = migration;
