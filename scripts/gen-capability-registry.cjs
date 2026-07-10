#!/usr/bin/env node
'use strict';

/**
 * gen-capability-registry.cjs — regenerates sma-core/bin/lib/capability-registry.cjs.
 *
 * The frozen registry file is GENERATED — never edit it by hand. This generator
 * composes two first-party inputs:
 *
 *   1. The current committed registry (the vendored upstream gsd-core 1.6.1
 *      snapshot of 32 built-in capabilities). It is treated as the frozen
 *      source for every capability that has NO fork-authored manifest.
 *   2. Fork-authored first-party manifests under
 *      sma-core/capabilities/<id>/capability.json. A manifest ALWAYS wins over
 *      the snapshot for the same id, so editing a manifest and re-running
 *      `--write` propagates the change.
 *
 * It also exports the runtime seams `capability-loader.cjs` lazily requires at
 * `../../../scripts/gen-capability-registry.cjs` for the overlay compose path
 * (ADR-1244 D2):
 *
 *   - buildRegistry(capMap)      — Map(id -> capability) -> composed registry
 *   - loadCentralConfigKeys()    — Set of central (non-capability) config keys
 *
 * Usage:
 *   node scripts/gen-capability-registry.cjs --write   # regenerate the file
 *   node scripts/gen-capability-registry.cjs --check   # exit 1 if stale
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'sma-core', 'bin', 'lib', 'capability-registry.cjs');
const MANIFEST_DIR = path.join(ROOT, 'sma-core', 'capabilities');
const CENTRAL_SCHEMA_MANIFEST = path.join(
  ROOT, 'sma-core', 'bin', 'shared', 'config-schema.manifest.json',
);

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Load the committed registry module fresh (no require-cache staleness). */
function loadFrozen() {
  const resolved = require.resolve(REGISTRY_PATH);
  delete require.cache[resolved];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(REGISTRY_PATH);
}

/** Read fork-authored first-party manifests: sma-core/capabilities/<id>/capability.json. */
function loadFirstPartyManifests() {
  let entries;
  try {
    entries = fs.readdirSync(MANIFEST_DIR, { withFileTypes: true });
  } catch {
    return []; // no manifest dir — snapshot-only regeneration
  }
  const caps = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const manifestPath = path.join(MANIFEST_DIR, ent.name, 'capability.json');
    let cap;
    try {
      cap = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      throw new Error(`unreadable first-party manifest ${manifestPath}: ${e.message}`);
    }
    if (!cap || typeof cap !== 'object' || cap.id !== ent.name) {
      throw new Error(
        `first-party manifest id mismatch: dir "${ent.name}" vs manifest id "${cap && cap.id}"`,
      );
    }
    caps.push(cap);
  }
  caps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return caps;
}

/** Central (non-capability) config keys — the single CJS schema manifest. */
function loadCentralConfigKeys() {
  try {
    const raw = JSON.parse(fs.readFileSync(CENTRAL_SCHEMA_MANIFEST, 'utf8'));
    return new Set(Array.isArray(raw.validKeys) ? raw.validKeys : []);
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// View composition (additive over the frozen snapshot)
// ---------------------------------------------------------------------------

function sortedObject(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

/** Remove every trace of capability `id` from the (cloned) derived views. */
function stripCapFromViews(v, id) {
  delete v.capabilities[id];
  for (const k of Object.keys(v.bySkill)) if (v.bySkill[k] === id) delete v.bySkill[k];
  for (const k of Object.keys(v.byAgent)) if (v.byAgent[k] === id) delete v.byAgent[k];
  for (const point of Object.keys(v.byLoopPoint)) {
    const slot = v.byLoopPoint[point];
    // NOTE: the upstream snapshot legitimately carries intentionally-EMPTY loop
    // points (e.g. execute:pre) — never delete a point, only filter this id out.
    slot.steps = (slot.steps || []).filter((s) => s.capId !== id);
    slot.contributions = (slot.contributions || []).filter((c) => c.capId !== id);
    slot.gates = (slot.gates || []).filter((g) => g.capId !== id);
  }
  for (const k of Object.keys(v.configKeys)) if (v.configKeys[k] === id) delete v.configKeys[k];
  for (const k of Object.keys(v.configSchema)) {
    if (v.configSchema[k] && v.configSchema[k].owner === id) delete v.configSchema[k];
  }
  delete v.runtimes[id];
  for (const fam of Object.keys(v.commandFamilies)) {
    if (v.commandFamilies[fam].capId === id) delete v.commandFamilies[fam];
  }
  delete v.capabilityClusters[id];
  delete v.profileMembership[id];
  delete v.requiresGraph[id];
}

/** Merge one capability object into the (cloned) derived views. */
function addCapToViews(v, cap) {
  const id = cap.id;
  v.capabilities[id] = cap;
  for (const s of cap.skills || []) v.bySkill[s] = id;
  for (const a of cap.agents || []) v.byAgent[a] = id;
  const slotOf = (point) => {
    if (!v.byLoopPoint[point]) v.byLoopPoint[point] = { steps: [], contributions: [], gates: [] };
    return v.byLoopPoint[point];
  };
  for (const step of cap.steps || []) slotOf(step.point).steps.push({ capId: id, ...step });
  for (const c of cap.contributions || []) slotOf(c.point).contributions.push({ capId: id, ...c });
  for (const g of cap.gates || []) slotOf(g.point).gates.push({ capId: id, ...g });
  for (const [key, schema] of Object.entries(cap.config || {})) {
    v.configKeys[key] = id;
    v.configSchema[key] = { owner: id, ...schema };
  }
  if (cap.role === 'runtime') v.runtimes[id] = cap;
  for (const cmd of cap.commands || []) {
    v.commandFamilies[cmd.family] = { capId: id, module: cmd.module, router: cmd.router };
  }
  if ((cap.skills || []).length > 0) {
    v.capabilityClusters[id] = [...cap.skills].sort();
    v.profileMembership[id] = { tier: cap.tier, profiles: [cap.tier] };
  }
  v.requiresGraph[id] = [...(cap.requires || [])];
}

/**
 * Compose the full set of derived views from the frozen base registry plus
 * `extraCaps` (fork manifests or accepted overlay capabilities). An extra whose
 * id already exists in the base REPLACES the base entry (manifest wins).
 */
function composeViews(base, extraCaps) {
  const v = {
    capabilities: structuredClone(base.capabilities || {}),
    bySkill: structuredClone(base.bySkill || {}),
    byAgent: structuredClone(base.byAgent || {}),
    byLoopPoint: structuredClone(base.byLoopPoint || {}),
    configKeys: structuredClone(base.configKeys || {}),
    configSchema: structuredClone(base.configSchema || {}),
    runtimes: structuredClone(base.runtimes || {}),
    commandFamilies: structuredClone(base.commandFamilies || {}),
    capabilityClusters: structuredClone(base.capabilityClusters || {}),
    profileMembership: structuredClone(base.profileMembership || {}),
    requiresGraph: reconstructRequiresGraph(base),
  };
  for (const cap of extraCaps) stripCapFromViews(v, cap.id);
  for (const cap of extraCaps) addCapToViews(v, cap);
  v.capabilities = sortedObject(v.capabilities);
  v.requiresGraph = sortedObject(v.requiresGraph);
  return v;
}

/**
 * The frozen module does not export `_requiresGraph`; rebuild it from the cap
 * objects (requires lists are plain id arrays — see the `pattern-mapper` entry).
 */
function reconstructRequiresGraph(base) {
  const graph = {};
  for (const [id, cap] of Object.entries(base.capabilities || {})) {
    graph[id] = [...(cap.requires || [])];
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Runtime seam for capability-loader.cjs (ADR-1244 D2 overlay compose)
// ---------------------------------------------------------------------------

/**
 * Compose a full registry object from a Map(id -> capability) holding
 * first-party ∪ accepted-overlay capabilities. First-party entries pass through
 * untouched; entries whose id is NOT in the frozen registry are merged
 * additively via the same rules `--write` uses, so derived views cannot drift
 * between the build-time and runtime paths.
 */
function buildRegistry(capMap) {
  const base = loadFrozen();
  const extras = [];
  for (const [id, cap] of capMap.entries()) {
    if (!(id in (base.capabilities || {}))) extras.push(cap);
  }
  const v = composeViews(base, extras);
  return materialize(v);
}

function materialize(v) {
  const graph = v.requiresGraph;
  function requiresClosure(id) {
    const visited = new Set();
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift();
      const reqs = graph[current] || [];
      for (const req of reqs) {
        if (!visited.has(req)) {
          visited.add(req);
          queue.push(req);
        }
      }
    }
    return visited;
  }
  return {
    version: '1',
    capabilities: v.capabilities,
    bySkill: v.bySkill,
    byAgent: v.byAgent,
    byLoopPoint: v.byLoopPoint,
    configKeys: v.configKeys,
    configSchema: v.configSchema,
    runtimes: v.runtimes,
    commandFamilies: v.commandFamilies,
    capabilityClusters: v.capabilityClusters,
    profileMembership: v.profileMembership,
    requiresClosure,
  };
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function j(obj) {
  return JSON.stringify(obj, null, 2);
}

function render(v) {
  return `'use strict';

/**
 * capability-registry.cjs — generated by scripts/gen-capability-registry.cjs
 * DO NOT EDIT BY HAND. Run: node scripts/gen-capability-registry.cjs --write
 * ADR-894 §5 — role-partitioned Capability Registry.
 */

const capabilities = ${j(v.capabilities)};

const bySkill = ${j(v.bySkill)};

const byAgent = ${j(v.byAgent)};

const byLoopPoint = ${j(v.byLoopPoint)};

const configKeys = ${j(v.configKeys)};

const configSchema = ${j(v.configSchema)};

const runtimes = ${j(v.runtimes)};

const commandFamilies = ${j(v.commandFamilies)};

const capabilityClusters = ${j(v.capabilityClusters)};

const profileMembership = ${j(v.profileMembership)};

const _requiresGraph = ${j(v.requiresGraph)};

function requiresClosure(id) {
  const visited = new Set();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift();
    const reqs = _requiresGraph[current] || [];
    for (const req of reqs) {
      if (!visited.has(req)) {
        visited.add(req);
        queue.push(req);
      }
    }
  }
  return visited;
}

module.exports = {
  version: '1',
  capabilities,
  bySkill,
  byAgent,
  byLoopPoint,
  configKeys,
  configSchema,
  runtimes,
  commandFamilies,
  capabilityClusters,
  profileMembership,
  requiresClosure,
};
`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function generate() {
  const base = loadFrozen();
  const manifests = loadFirstPartyManifests();
  return render(composeViews(base, manifests));
}

function main(argv) {
  const args = new Set(argv.slice(2));
  const next = generate();
  if (args.has('--check')) {
    const current = fs.readFileSync(REGISTRY_PATH, 'utf8');
    if (current === next) {
      console.log('capability-registry.cjs is current.');
      return 0;
    }
    console.error('capability-registry.cjs is STALE — run: node scripts/gen-capability-registry.cjs --write');
    return 1;
  }
  if (args.has('--write')) {
    fs.writeFileSync(REGISTRY_PATH, next, 'utf8');
    console.log(`wrote ${path.relative(ROOT, REGISTRY_PATH)}`);
    return 0;
  }
  process.stdout.write(next);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { buildRegistry, loadCentralConfigKeys, generate };
