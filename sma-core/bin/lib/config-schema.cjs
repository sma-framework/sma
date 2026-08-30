"use strict";
/**
 * Thin adapter — sources schema data from the manifest via the generated
 * Configuration Module. All inline literals have been removed; the manifest
 * at sma-core/bin/shared/config-schema.manifest.json is the single source of truth.
 *
 * Imported by:
 *   - config.cjs (isValidConfigKey validator)
 *   - many tests (config-schema.property.test.cjs, bug-*, feat-*, etc.)
 * (core.cjs re-export spine retired in epic #1267)
 *
 * See Phase 2 Cycle 5 (#3536) — schema manifest migration.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/config-schema.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour from
 * the prior hand-written .cjs; only types are added.
 */
const configuration_cjs_1 = require("./configuration.cjs");
// Frozen first-party capability config-schema — the fallback when no project cwd
// is available (cwd-agnostic call sites).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const capabilityRegistry = require('./capability-registry.cjs');
// Resolve the capability config-schema for a project (ADR-1244 D2). When a cwd is
// supplied, compose installed overlay capabilities for THAT project — LAZILY (never
// at module load: a bare require of this module never scans the filesystem) —
// falling back to the frozen first-party schema. Without a cwd, first-party only.
function _capabilityConfigSchema(cwd) {
    if (typeof cwd === 'string' && cwd) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
            const loaderMod = require('./capability-loader.cjs');
            // #1459 IC-04: thread the consent home explicitly so a consented project cap's config key
            // federates at the SAME user-owned home that gated its activation.
            const schema = loaderMod.loadRegistry({ includeInstalled: true, cwd, smaHome: process.env['SMA_HOME'] }).configSchema;
            if (schema && typeof schema === 'object')
                return schema;
        }
        catch { /* fall back to first-party */ }
    }
    const fp = capabilityRegistry.configSchema;
    return fp && typeof fp === 'object' ? fp : {};
}
function isCapabilityConfigKey(keyPath, cwd) {
    if (typeof keyPath !== 'string')
        return false;
    return Object.prototype.hasOwnProperty.call(_capabilityConfigSchema(cwd), keyPath);
}
/**
 * Returns true for keys owned by the central schema adapter rather than a
 * federated Capability config slice.
 */
function isCentralConfigKey(keyPath) {
    if (typeof keyPath !== 'string')
        return false;
    if (configuration_cjs_1.VALID_CONFIG_KEYS.has(keyPath))
        return true;
    if (configuration_cjs_1.RUNTIME_STATE_KEYS.has(keyPath))
        return true;
    return configuration_cjs_1.DYNAMIC_KEY_PATTERNS.some((p) => p.test(keyPath));
}
/**
 * Returns true if keyPath is a valid central, runtime-state, dynamic, or
 * federated Capability config key.
 */
function isValidConfigKey(keyPath, cwd) {
    if (isCentralConfigKey(keyPath))
        return true;
    return isCapabilityConfigKey(keyPath, cwd);
}
/**
 * configKeyDefault(keyPath) → `{has, value}` — what the SCHEMA says a key is worth when the
 * project never wrote it down, or `{has:false}` when the schema says nothing about it.
 *
 * `{has, value}` rather than a bare value because `false`, `0` and `null` are legitimate
 * defaults: a caller testing the returned value alone could not tell «умолчание — false» from
 * «умолчания нет», which is exactly the confusion that turns a described key into an error.
 * Ownership is asked with hasOwnProperty, so `constructor` and friends never answer with
 * something off the prototype.
 */
function configKeyDefault(keyPath) {
    if (typeof keyPath !== 'string' || !Object.prototype.hasOwnProperty.call(configuration_cjs_1.CONFIG_KEY_DEFAULTS, keyPath)) {
        return { has: false, value: undefined };
    }
    return { has: true, value: configuration_cjs_1.CONFIG_KEY_DEFAULTS[keyPath] };
}
module.exports = {
    VALID_CONFIG_KEYS: configuration_cjs_1.VALID_CONFIG_KEYS,
    RUNTIME_STATE_KEYS: configuration_cjs_1.RUNTIME_STATE_KEYS,
    CONFIG_KEY_DEFAULTS: configuration_cjs_1.CONFIG_KEY_DEFAULTS,
    configKeyDefault,
    DYNAMIC_KEY_PATTERNS: configuration_cjs_1.DYNAMIC_KEY_PATTERNS,
    isCapabilityConfigKey,
    isCentralConfigKey,
    isValidConfigKey,
    getCapabilityConfigSchema: _capabilityConfigSchema,
};
