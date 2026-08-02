"use strict";
/**
 * Model Resolver — Model and effort resolution policy
 *
 * ADR-857 rollout phase 2f: extracted from core.cts (issue #888).
 * Owns model and effort resolution policy: resolves the model, runtime tier,
 * planning granularity, reasoning effort, and fast-mode for a given agent by
 * reading project config and resolving against the model profiles and catalog.
 * Behaviour is preserved byte-for-behaviour from the prior location; only
 * the module boundary moved. The core.cjs re-export spine was retired in
 * epic #1267; callers import resolvers from model-resolver.cjs directly.
 *
 * Dependencies (leaf modules only):
 *   - node:fs / node:path (stdlib, not currently needed — included for future use)
 *   - ./config-loader.cjs    (loadConfig)
 *   - ./configuration.cjs    (CONFIG_DEFAULTS as CANONICAL_CONFIG_DEFAULTS)
 *   - ./model-profiles.cjs   (MODEL_PROFILES, AGENT_TO_PHASE_TYPE, AGENT_DEFAULT_TIERS, VALID_AGENT_TIERS, nextTier)
 *   - ./model-catalog.cjs    (MODEL_ALIAS_MAP, RUNTIME_PROFILE_MAP, PROVIDER_PRESETS)
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const configLoaderModule = require("./config-loader.cjs");
const { loadConfig } = configLoaderModule;
// ─── Configuration Module (for CANONICAL_CONFIG_DEFAULTS used by effort/fast_mode resolvers) ─
const configuration_cjs_1 = require("./configuration.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const modelProfiles = require("./model-profiles.cjs");
const { MODEL_PROFILES, AGENT_TO_PHASE_TYPE, AGENT_DEFAULT_TIERS, VALID_AGENT_TIERS, nextTier } = modelProfiles;
const model_catalog_cjs_1 = require("./model-catalog.cjs");
/**
 * Reserved sub-key of `model_profile_overrides`. Every other sub-key of that
 * object names a RUNTIME and maps tiers to models; `agents` names AGENTS and
 * maps an agent to the model it must run on, whatever the tier profile says.
 * The two namespaces share one config object, so the reserved name is excluded
 * from every runtime-shaped read.
 */
const AGENT_OVERRIDE_KEY = 'agents';
/**
 * The legacy sentinel. Before `config-set <key> null` learned to CLEAR a key it
 * stored the word as a value, so configs written by older versions carry model
 * slots holding the string "null". Nothing is named that: taken literally it
 * dispatches an agent onto a model that cannot exist, and — because the rot sits
 * in the slot that was meant to be empty — it shadows the very default the user
 * was trying to restore.
 */
const CLEARED_SENTINEL = 'null';
/**
 * Normalise one model-valued config slot.
 *
 * Every model read in this file funnels through here, so a slot left rotted by
 * the old clear bug reads as ABSENT and resolution falls through to the next
 * priority — an old config heals itself on the next run instead of failing a
 * dispatch. Accepts the two spellings a model slot may use: a bare string, or an
 * object with a `model` field.
 *
 * Returns the trimmed model, or null when the slot is empty, malformed, or holds
 * the legacy sentinel. Only the exact word is rot — a real model whose name
 * merely begins with those letters is returned untouched.
 */
function modelValueOrNull(raw) {
    const value = typeof raw === 'string'
        ? raw
        : (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw['model'] === 'string'
            ? raw['model']
            : null);
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === CLEARED_SENTINEL)
        return null;
    return trimmed;
}
/**
 * Read `model_profile_overrides.agents.<agent-name>`.
 *
 * The tier profile answers "how heavy is this KIND of work"; this answers "which
 * model must THIS agent run on" — a per-agent choice the per-tier profile cannot
 * express (an agent-level pin used to force the whole profile up or down, moving
 * unrelated agents with it). Returns the model string, or null when there is no
 * entry for this agent — an unknown or misspelled agent name is a no-op, and
 * resolution falls through to the profile exactly as before.
 *
 * The value may be a bare model/alias string or an object with a `model` field
 * (the same two spellings a runtime tier entry accepts).
 */
function resolveAgentModelOverride(overrides, agentType) {
    if (!agentType)
        return null;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))
        return null;
    const agentsMap = overrides[AGENT_OVERRIDE_KEY];
    if (!agentsMap || typeof agentsMap !== 'object' || Array.isArray(agentsMap))
        return null;
    if (!Object.hasOwn(agentsMap, agentType))
        return null;
    return modelValueOrNull(agentsMap[agentType]);
}
/**
 * #2517 — Resolve the runtime-aware tier entry for (runtime, tier).
 */
function resolveTierEntry({ runtime, tier, overrides }) {
    if (!runtime || !tier)
        return null;
    // `agents` is the per-agent namespace, never a runtime — a config that pins
    // an agent must not be read as a runtime tier map.
    if (runtime === AGENT_OVERRIDE_KEY)
        return null;
    const runtimeMap = model_catalog_cjs_1.RUNTIME_PROFILE_MAP;
    const builtin = runtimeMap[runtime]?.[tier] || null;
    const overridesMap = overrides;
    const userRaw = overridesMap?.[runtime]?.[tier];
    let userEntry = null;
    if (userRaw) {
        const userModel = modelValueOrNull(userRaw);
        if (typeof userRaw === 'string') {
            // A bare string IS the model, so a rotted one is simply an empty slot.
            userEntry = userModel ? { model: userModel } : null;
        }
        else if (typeof userRaw === 'object' && !Array.isArray(userRaw)) {
            // Object form: drop only a rotted `model` and let the built-in show
            // through it; any sibling fields the user set are still theirs.
            const rest = { ...userRaw };
            delete rest.model;
            userEntry = userModel
                ? { ...rest, model: userModel }
                : (Object.keys(rest).length > 0 ? rest : null);
        }
    }
    if (!builtin && !userEntry)
        return null;
    return { ...(builtin || {}), ...(userEntry || {}) };
}
/**
 * Convenience wrapper used by resolveModelInternal.
 */
function _resolveRuntimeTier(config, tier) {
    return resolveTierEntry({
        runtime: config['runtime'],
        tier,
        overrides: config['model_profile_overrides'],
    });
}
// Reverse of the Claude tier-default IDs, plus the Fable alias which Claude
// Code's Agent tool accepts but which is not a SMA model-profile tier (#1133).
const CLAUDE_POLICY_ID_TO_ALIAS = {
    ...Object.fromEntries(Object.entries(model_catalog_cjs_1.MODEL_ALIAS_MAP)
        .filter((e) => typeof e[1] === 'string')
        .map(([aliasName, id]) => [id, aliasName])),
    'claude-fable-5': 'fable',
};
const CLAUDE_AGENT_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable']);
// Dedupe stderr warnings so repeated agent resolutions don't spam (#1133).
const _modelPolicyUnmappableWarned = new Set();
function warnModelPolicyUnmappable(agentType, policyModel, tier) {
    const key = `${agentType}::${policyModel}::${tier}`;
    if (_modelPolicyUnmappableWarned.has(key))
        return;
    _modelPolicyUnmappableWarned.add(key);
    // MUST go to stderr — resolve-model's JSON result is parsed from stdout.
    process.stderr.write(`sma: warning — model_policy resolved "${policyModel}" for ${agentType}, ` +
        `but it has no Claude agent alias; using "${tier}" instead.\n`);
}
// Test-only: reset the model_policy warn-dedupe cache between cases (#1133).
function _resetModelPolicyWarningCacheForTests() {
    _modelPolicyUnmappableWarned.clear();
}
/**
 * #49 — Provider-neutral model policy preset resolution.
 */
function resolveModelPolicy(policy, tier) {
    if (!policy || typeof policy !== 'object')
        return null;
    if (!tier)
        return null;
    const runtime = policy['runtime'];
    const rtOverrides = policy['runtime_tiers'];
    if (runtime && typeof runtime === 'string' && rtOverrides && typeof rtOverrides === 'object') {
        const rtOverridesMap = rtOverrides;
        if (Object.hasOwn(rtOverridesMap, runtime)) {
            const runtimeEntry = rtOverridesMap[runtime];
            if (runtimeEntry && typeof runtimeEntry === 'object' && Object.hasOwn(runtimeEntry, tier)) {
                const entryModel = modelValueOrNull(runtimeEntry[tier]);
                if (entryModel)
                    return entryModel;
            }
        }
    }
    const provider = policy['provider'];
    if (!provider || typeof provider !== 'string')
        return null;
    if (provider === 'generic' || provider === 'custom') {
        const TIER_TO_POLICY_KEY = { opus: 'high', sonnet: 'medium', haiku: 'low' };
        const policyKey = TIER_TO_POLICY_KEY[tier];
        if (!policyKey)
            return null;
        return modelValueOrNull(policy[policyKey]);
    }
    const presetsMap = model_catalog_cjs_1.PROVIDER_PRESETS;
    if (!Object.hasOwn(presetsMap, provider))
        return null;
    const presetForProvider = presetsMap[provider];
    if (!presetForProvider || typeof presetForProvider !== 'object')
        return null;
    if (!Object.hasOwn(presetForProvider, tier))
        return null;
    const tierPresets = presetForProvider[tier];
    if (!tierPresets || typeof tierPresets !== 'object')
        return null;
    const budget = (policy['budget'] && typeof policy['budget'] === 'string') ? policy['budget'] : 'medium';
    if (!Object.hasOwn(tierPresets, budget))
        return null;
    const budgetEntry = tierPresets[budget];
    if (!budgetEntry || !budgetEntry.model)
        return null;
    return budgetEntry.model;
}
function resolveModelInternal(cwd, agentType) {
    const config = loadConfig(cwd);
    // 1. Per-agent override
    const modelOverrides = config['model_overrides'];
    const override = modelValueOrNull(modelOverrides?.[agentType]);
    if (override) {
        return override;
    }
    // 1b. Per-agent pin inside model_profile_overrides — wins over the tier
    // profile for THIS agent and leaves every other agent on the profile.
    const agentPin = resolveAgentModelOverride(config['model_profile_overrides'], agentType);
    if (agentPin) {
        return agentPin;
    }
    // 2. Compute the tier
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const profile = String(config['model_profile'] || 'balanced').toLowerCase();
    const agentModels = MODEL_PROFILES[agentType];
    const phaseType = (AGENT_TO_PHASE_TYPE)[agentType];
    const configModels = config['models'];
    const phaseTypeTier = (phaseType && configModels && typeof configModels === 'object')
        ? configModels[phaseType]
        : undefined;
    const VALID_TIERS = new Set(['opus', 'sonnet', 'haiku', 'inherit']);
    const tier = (phaseTypeTier && VALID_TIERS.has(phaseTypeTier))
        ? phaseTypeTier
        : (profile === 'inherit'
            ? 'inherit'
            : (agentModels ? (agentModels[profile] || agentModels['balanced']) : null));
    // 2.5. model_policy preset (#49, #1133)
    const configRuntime = config['runtime'];
    if (tier && tier !== 'inherit') {
        const onClaude = !configRuntime || configRuntime === 'claude';
        const effectiveRuntime = configRuntime || 'claude';
        const mergedPolicy = config['model_policy']
            ? { ...config['model_policy'], runtime: effectiveRuntime }
            : null;
        const policyModel = resolveModelPolicy(mergedPolicy, tier);
        if (policyModel) {
            // Non-Claude runtimes take full model IDs verbatim (unchanged behavior).
            if (!onClaude)
                return policyModel;
            // Claude Code's Agent tool takes tier aliases (opus/sonnet/haiku/fable),
            // not full model IDs — map the policy-resolved ID back to an alias (#1133).
            const aliasForId = CLAUDE_POLICY_ID_TO_ALIAS[policyModel];
            if (aliasForId)
                return aliasForId;
            // The policy value may already be a bare Claude agent alias (e.g. "fable").
            if (CLAUDE_AGENT_ALIASES.has(policyModel))
                return policyModel;
            // No Claude alias for this ID (e.g. a pinned minor version like
            // claude-opus-4-5). Warn once and fall through to the tier alias rather
            // than returning an ID Claude Code cannot spawn.
            warnModelPolicyUnmappable(agentType, policyModel, tier);
        }
    }
    // 3. Runtime-aware resolution (#2517)
    if (configRuntime && configRuntime !== 'claude' && tier && tier !== 'inherit') {
        const entry = _resolveRuntimeTier(config, tier);
        if (entry?.model)
            return entry.model;
    }
    // 4. resolve_model_ids: "omit"
    if (config['resolve_model_ids'] === 'omit') {
        return '';
    }
    // 5. Profile lookup (Claude-native default).
    if (!agentModels) {
        return profile === 'quality' ? 'opus'
            : profile === 'budget' ? 'haiku'
                : profile === 'inherit' ? 'inherit'
                    : 'sonnet';
    }
    if (tier === 'inherit')
        return 'inherit';
    const alias = tier;
    if (config['resolve_model_ids']) {
        return model_catalog_cjs_1.MODEL_ALIAS_MAP[alias] || alias;
    }
    return alias;
}
const VALID_GRANULARITIES = new Set(['coarse', 'standard', 'fine']);
/**
 * Resolve the planning granularity for a phase type (#68).
 */
function resolveGranularityInternal(cwd, phaseType, override) {
    if (override !== undefined && override !== null && override !== '') {
        if (VALID_GRANULARITIES.has(override)) {
            return override;
        }
    }
    const config = loadConfig(cwd);
    const configGranularities = config['granularities'];
    const perPhase = (phaseType && configGranularities && typeof configGranularities === 'object')
        ? configGranularities[phaseType]
        : undefined;
    if (perPhase && VALID_GRANULARITIES.has(perPhase)) {
        return perPhase;
    }
    if (config['granularity'] !== undefined && config['granularity'] !== null && config['granularity'] !== '') {
        return config['granularity'];
    }
    const planning = config['planning'];
    const planningGran = planning && planning['granularity'];
    if (planningGran !== undefined && planningGran !== null && planningGran !== '') {
        return planningGran;
    }
    return 'standard';
}
/**
 * Validate a CLI granularity override at the command boundary. Empty/null/undefined
 * are treated as "no override" (no-op). An invalid non-empty value calls `fail`.
 */
function assertValidGranularityOverride(override, fail) {
    if (override !== undefined && override !== null && override !== '' && !VALID_GRANULARITIES.has(override)) {
        fail(`invalid granularity '${override}' (valid: ${[...VALID_GRANULARITIES].join(', ')})`);
    }
}
/**
 * #3024 — Resolve a model for a specific dynamic-routing attempt.
 */
function resolveModelForTier(cwd, agentType, attempt) {
    const config = loadConfig(cwd);
    const attemptN = Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
    const modelOverrides = config['model_overrides'];
    const override = modelValueOrNull(modelOverrides?.[agentType]);
    if (override)
        return override;
    // A per-agent pin outranks the escalation ladder too — the point of the pin
    // is that this agent's model does not move with the tier.
    const agentPin = resolveAgentModelOverride(config['model_profile_overrides'], agentType);
    if (agentPin)
        return agentPin;
    if (config['model_policy'] && config['runtime'] && config['runtime'] !== 'claude') {
        return resolveModelInternal(cwd, agentType);
    }
    const dr = config['dynamic_routing'];
    if (!dr || typeof dr !== 'object' || dr['enabled'] !== true) {
        return resolveModelInternal(cwd, agentType);
    }
    const tierModels = dr['tier_models'];
    if (!tierModels || typeof tierModels !== 'object') {
        return resolveModelInternal(cwd, agentType);
    }
    const defaultTier = (AGENT_DEFAULT_TIERS)[agentType];
    if (!defaultTier || !(VALID_AGENT_TIERS).has(defaultTier)) {
        return resolveModelInternal(cwd, agentType);
    }
    const maxEscalations = Number.isInteger(dr['max_escalations']) && dr['max_escalations'] >= 0
        ? dr['max_escalations']
        : 1;
    const escalationEnabled = dr['escalate_on_failure'] !== false;
    const effectiveAttempt = escalationEnabled
        ? Math.min(attemptN, maxEscalations)
        : 0;
    let tier = defaultTier;
    for (let i = 0; i < effectiveAttempt; i += 1) {
        const next = (nextTier)(tier);
        if (!next || next === tier)
            break;
        tier = next;
    }
    const alias = modelValueOrNull(tierModels[tier]);
    if (!alias) {
        return resolveModelInternal(cwd, agentType);
    }
    return alias;
}
// ─── #443 — Unified effort + fast_mode resolvers ─────────────────────────────
const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_SET = new Set(VALID_EFFORTS);
/**
 * Walk one step up the effort ladder from `e`.
 */
function nextEffort(e) {
    const i = VALID_EFFORTS.indexOf(e);
    if (i < 0)
        return null;
    return VALID_EFFORTS[Math.min(i + 1, VALID_EFFORTS.length - 1)];
}
/**
 * #443 — Resolve a universal effort string for (cwd, agentType).
 */
function resolveEffortInternal(cwd, agentType, opts) {
    // Step 1: invocation override
    if (opts && typeof opts.override === 'string' && EFFORT_SET.has(opts.override)) {
        return opts.override;
    }
    const config = loadConfig(cwd);
    const effortCfg = (config['effort'] && typeof config['effort'] === 'object' && !Array.isArray(config['effort']))
        ? config['effort']
        : null;
    // Step 2: agent_overrides
    if (effortCfg) {
        const ao = effortCfg['agent_overrides'];
        if (ao && typeof ao === 'object' && !Array.isArray(ao)) {
            const v = ao[agentType];
            if (typeof v === 'string' && EFFORT_SET.has(v))
                return v;
        }
    }
    else {
        const canonicalEffort = (configuration_cjs_1.CONFIG_DEFAULTS)['effort'];
        const mao = canonicalEffort && typeof canonicalEffort === 'object'
            ? canonicalEffort['agent_overrides']
            : undefined;
        if (mao && typeof mao === 'object' && !Array.isArray(mao)) {
            const v = mao[agentType];
            if (typeof v === 'string' && EFFORT_SET.has(v))
                return v;
        }
    }
    // Step 3: routing_tier_defaults by agent's default tier.
    const agentTier = (AGENT_DEFAULT_TIERS)[agentType];
    if (agentTier) {
        if (effortCfg && effortCfg['routing_tier_defaults'] &&
            typeof effortCfg['routing_tier_defaults'] === 'object' &&
            !Array.isArray(effortCfg['routing_tier_defaults'])) {
            const v = effortCfg['routing_tier_defaults'][agentTier];
            if (typeof v === 'string' && EFFORT_SET.has(v))
                return v;
        }
        else if (!effortCfg) {
            const canonicalEffort = (configuration_cjs_1.CONFIG_DEFAULTS)['effort'];
            const manifestDefaults = canonicalEffort && typeof canonicalEffort === 'object'
                ? canonicalEffort['routing_tier_defaults']
                : undefined;
            if (manifestDefaults && typeof manifestDefaults === 'object') {
                const v = manifestDefaults[agentTier];
                if (typeof v === 'string' && EFFORT_SET.has(v))
                    return v;
            }
        }
    }
    // Step 4: effort.default
    if (effortCfg) {
        const d = effortCfg['default'];
        if (typeof d === 'string' && EFFORT_SET.has(d))
            return d;
    }
    else {
        const canonicalEffort = (configuration_cjs_1.CONFIG_DEFAULTS)['effort'];
        const d = canonicalEffort && typeof canonicalEffort === 'object'
            ? canonicalEffort['default']
            : undefined;
        if (typeof d === 'string' && EFFORT_SET.has(d))
            return d;
    }
    // Step 5: hardcoded default
    return 'high';
}
/**
 * #443 — Resolve fast_mode boolean for (cwd, agentType).
 */
function resolveFastModeInternal(cwd, agentType, opts) {
    // Step 1: invocation override
    if (opts && typeof opts.override === 'boolean') {
        return opts.override;
    }
    const config = loadConfig(cwd);
    const fmCfg = (config['fast_mode'] && typeof config['fast_mode'] === 'object' && !Array.isArray(config['fast_mode']))
        ? config['fast_mode']
        : null;
    // Step 2: agent_overrides
    if (fmCfg) {
        const ao = fmCfg['agent_overrides'];
        if (ao && typeof ao === 'object' && !Array.isArray(ao)) {
            const v = ao[agentType];
            if (typeof v === 'boolean')
                return v;
        }
    }
    // Step 3: routing_tier_defaults by agent's default tier.
    const agentTier = (AGENT_DEFAULT_TIERS)[agentType];
    if (agentTier) {
        if (fmCfg && fmCfg['routing_tier_defaults'] &&
            typeof fmCfg['routing_tier_defaults'] === 'object' &&
            !Array.isArray(fmCfg['routing_tier_defaults'])) {
            const v = fmCfg['routing_tier_defaults'][agentTier];
            if (typeof v === 'boolean')
                return v;
        }
        else if (!fmCfg) {
            const canonicalFm = (configuration_cjs_1.CONFIG_DEFAULTS)['fast_mode'];
            const manifestDefaults = canonicalFm && typeof canonicalFm === 'object'
                ? canonicalFm['routing_tier_defaults']
                : undefined;
            if (manifestDefaults && typeof manifestDefaults === 'object') {
                const v = manifestDefaults[agentTier];
                if (typeof v === 'boolean')
                    return v;
            }
        }
    }
    // Step 4: fast_mode.enabled
    if (fmCfg && typeof fmCfg['enabled'] === 'boolean') {
        return fmCfg['enabled'];
    }
    // Step 5: hardcoded default
    return false;
}
/**
 * #443 — Resolve effort for a dynamic-routing attempt (with escalation).
 */
function resolveEffortForTier(cwd, agentType, attempt) {
    const base = resolveEffortInternal(cwd, agentType);
    const config = loadConfig(cwd);
    const dr = config['dynamic_routing'];
    if (!dr || typeof dr !== 'object' || dr['enabled'] !== true) {
        return base;
    }
    if (dr['escalate_on_failure'] === false) {
        return base;
    }
    const maxEscalations = Number.isInteger(dr['max_escalations']) && dr['max_escalations'] >= 0
        ? dr['max_escalations']
        : 1;
    const attemptN = Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
    const effectiveAttempt = Math.min(attemptN, maxEscalations);
    let current = base;
    for (let i = 0; i < effectiveAttempt; i++) {
        const next = nextEffort(current);
        if (!next || next === current)
            break;
        current = next;
    }
    return current;
}
module.exports = {
    AGENT_OVERRIDE_KEY,
    CLEARED_SENTINEL,
    modelValueOrNull,
    resolveAgentModelOverride,
    resolveTierEntry,
    resolveModelPolicy,
    resolveModelInternal,
    _resetModelPolicyWarningCacheForTests,
    VALID_GRANULARITIES,
    resolveGranularityInternal,
    assertValidGranularityOverride,
    resolveModelForTier,
    VALID_EFFORTS,
    EFFORT_SET,
    nextEffort,
    resolveEffortInternal,
    resolveFastModeInternal,
    resolveEffortForTier,
};
