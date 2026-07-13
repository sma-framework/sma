/**
 * profile.mjs — the ONE deterministic reader/validator/consumer-registry/recap for
 * the SMA infra + working-style profile (49.3-01, D-49.3-04 / T-49.3-06).
 *
 * Every later Track B command reads the profile through THIS module — never by
 * re-parsing .sma/profile.json itself. Schema v2 (this plan) keeps every v1 field
 * and v1 law intact (every field optional; absent = ask-at-the-moment, never a
 * hardcoded default) and adds the fuller working profile. The reference doc
 * (sma-core/references/infra-profile.md) documents the same schema + consumer
 * table for humans; this file is the machine encoding of it.
 *
 * DESIGN LAWS:
 *   - PURE + DETERMINISTIC: normalizeProfile / validateProfile / deadFields /
 *     answeredFields / renderRecap are pure functions of their inputs — no
 *     Date.now(), no random, no network, no LLM (substrate law). renderRecap's
 *     reproducibility is a shipped feature (P49.3-01-B).
 *   - TOLERANT READER (journal.mjs posture): a missing/corrupt profile never
 *     throws — readProfile returns {} plus a warnings entry.
 *   - DI EVERYWHERE: readProfile takes {profilePath, readFile}; deadFields takes
 *     {schema, consumers}; renderRecap takes {profile, teachingSource, seededFiles}
 *     — tests never touch the real .sma/ and never shell out.
 *   - PRIVACY (T-49.3-06): the profile stores env-var NAMES and tool FACTS only.
 *     validateProfile REJECTS a secret-shaped VALUE anywhere (PROFILE-SECRET)
 *     before anything is written — a rejection, not a warning.
 *   - CONSUMER REGISTRY IS A CONTRACT: PROFILE_CONSUMERS covers EVERY schema
 *     field; a field with zero consumers is a dead field (PROFILE-DEADFIELD) — the
 *     "700-line rules file" failure in miniature (adoption scorecard metric 5).
 *
 * Node built-ins only; zero npm deps. No child_process import anywhere.
 */

import { readFileSync as fsReadFileSync } from 'node:fs'

// ─────────────────────────── schema (v1 + v2) ────────────────────────────────
//
// One entry per top-level profile field. `type` drives validateProfile; `askStage`
// is the /sma-start stage that captures it ('meta' = auto-set, not user-answered,
// excluded from coverage). `values` lists the allowed set for an enum field.

/** @typedef {{field:string, type:string, askStage:string, description:string, values?:string[]}} SchemaEntry */

/** @type {SchemaEntry[]} */
export const PROFILE_SCHEMA = [
  { field: 'profileVersion', type: 'number', askStage: 'meta', description: 'Schema version (2 = v3.5 shape); absent = a v1 profile upgraded in memory.' },
  { field: 'pushTarget', type: 'string', askStage: 'C', description: 'Where code is pushed — the shared copy of the repository.' },
  { field: 'autoDeployBranch', type: 'string', askStage: 'C', description: 'Branch whose push automatically goes live.' },
  { field: 'deployHost', type: 'string', askStage: 'C', description: 'The service that serves the deployed code, if any.' },
  { field: 'database', type: 'string', askStage: 'C', description: 'The database the project uses.' },
  { field: 'sharedCounters', type: 'string[]', askStage: 'C', description: 'Numbered resources parallel sessions coordinate on (migration, release).' },
  { field: 'releaseRitual', type: 'object', askStage: 'C', description: 'tagPattern / fullGateCommand / ciWatchCommand.' },
  { field: 'stack', type: 'object', askStage: 'B', description: 'languages[] / frameworks[] / packageManager.' },
  { field: 'testRunner', type: 'object', askStage: 'B', description: 'name / targetedCommand / fullSuiteCommand? / typeCheckCommand?.' },
  { field: 'parallelTerminals', type: 'object', askStage: 'A', description: 'typicalCount / splitHabit.' },
  { field: 'riskTolerance', type: 'enum', askStage: 'D', values: ['conservative', 'balanced', 'fast'], description: 'How loud the gates/reflexes are.' },
  { field: 'dangerCommands', type: 'string[]', askStage: 'D', description: 'Match patterns for commands to warn on — NEVER executed.' },
  { field: 'workingStyle', type: 'object', askStage: 'D', description: 'sessionRhythm / tddPreference / reviewHabit.' },
  { field: 'machineLessons', type: 'string[]', askStage: 'B', description: 'Gotchas of THIS machine, seeded as memory notes.' },
  { field: 'envVarNames', type: 'string[]', askStage: 'C', description: 'Env-var NAMES only (never values) the ship preflight checks.' },
  { field: 'notes', type: 'string', askStage: 'C', description: 'Free text for anything the fields above do not capture.' },
]

// ─────────────────────────── consumer registry ───────────────────────────────
//
// The CONTRACT with the rest of Track B: every schema field maps to >=1 named
// downstream consumer. Renaming a field breaks its named consumers; the registry
// is where that breakage becomes a lint failure (PROFILE-DEADFIELD) instead of
// silent rot. Must stay in agreement with the reference doc's consumer table.

/** @type {Record<string, string[]>} */
export const PROFILE_CONSUMERS = {
  profileVersion: ['profile.mjs readProfile/normalizeProfile'],
  pushTarget: ['ship.md'],
  autoDeployBranch: ['ship.md', 'push-safety gates'],
  deployHost: ['ship.md'],
  database: ['sma emit headers', 'planner context'],
  sharedCounters: ['next-slot'],
  releaseRitual: ['ship.md', 'push-safety gates'],
  stack: ['sma emit headers', 'planner context'],
  testRunner: ['executor targeted-test rule', 'ship full gate'],
  parallelTerminals: ['statusline segment', 'collision messaging'],
  riskTolerance: ['gates/reflex verbosity', 'self-tuning ladder'],
  dangerCommands: ['gates-check PreToolUse warnings'],
  workingStyle: ['context-compiler pack header'],
  machineLessons: ['reflex surface (seeded notes)'],
  envVarNames: ['ship preflight'],
  notes: ['ship.md'],
}

const SCHEMA_FIELD_SET = new Set(PROFILE_SCHEMA.map((s) => s.field))

// ─────────────────────────── tolerant reader ─────────────────────────────────

/**
 * readProfile({profilePath, readFile}) -> {profile, warnings}. Fail-open: a
 * missing file yields {profile:{}, warnings:[]}; a corrupt JSON file yields
 * {profile:{}, warnings:['…']}. NEVER writes, NEVER throws.
 *
 * @param {{profilePath:string, readFile?:Function}} opts
 * @returns {{profile:object, warnings:string[]}}
 */
export function readProfile(opts = {}) {
  const readFile = opts.readFile ?? fsReadFileSync
  let text
  try {
    text = readFile(opts.profilePath, 'utf8')
  } catch {
    return { profile: {}, warnings: [] } // missing file — honest empty state
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { profile: {}, warnings: [`profile at ${opts.profilePath} is not a JSON object — ignored`] }
    }
    return { profile: parsed, warnings: [] }
  } catch (err) {
    return { profile: {}, warnings: [`profile at ${opts.profilePath} is not valid JSON (${err && err.message}) — ignored`] }
  }
}

/**
 * normalizeProfile(raw) -> a v2-shaped COPY. Pure: never mutates the input, never
 * writes to disk. A v1 profile (no profileVersion) is upgraded in memory by
 * stamping profileVersion:2; every v1 field is preserved verbatim.
 *
 * @param {object} raw
 * @returns {object}
 */
export function normalizeProfile(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const copy = { ...src }
  if (copy.profileVersion == null) copy.profileVersion = 2
  return copy
}

// ─────────────────────────── secret screening (T-49.3-06) ────────────────────

/** Unambiguous credential token shapes — a VALUE carrying one is a secret. */
const SECRET_TOKEN_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/,
  /ghp_[A-Za-z0-9]{16,}/,
  /gho_[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{12,}/,
  /xox[baprs]-[A-Za-z0-9-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

/** A contiguous opaque run (no spaces) worth entropy-screening. */
const OPAQUE_RUN_RE = /[A-Za-z0-9+/_=-]{40,}/g

/**
 * secretShaped(value) -> boolean. Deterministic: true when the string carries a
 * known credential token OR a 40+ char mixed-class opaque run (has lower AND
 * upper AND digit — a random base64-ish secret). A pure-hex run (git sha / hash)
 * and an ALL-CAPS env-var NAME never qualify (allowlisted by shape). No
 * randomness anywhere.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function secretShaped(value) {
  if (typeof value !== 'string') return false
  for (const re of SECRET_TOKEN_PATTERNS) {
    if (re.test(value)) return true
  }
  const runs = value.match(OPAQUE_RUN_RE) || []
  for (const run of runs) {
    const hasLower = /[a-z]/.test(run)
    const hasUpper = /[A-Z]/.test(run)
    const hasDigit = /[0-9]/.test(run)
    // Mixed-class (all three) 40+ char run = secret-shaped. Pure hex (no upper)
    // and ALL-CAPS names (no lower) are allowlisted by construction.
    if (hasLower && hasUpper && hasDigit) return true
  }
  return false
}

/** A well-formed env-var NAME (uppercase-with-underscores) — a fact, not a secret. */
function isEnvVarName(s) {
  return typeof s === 'string' && /^[A-Z][A-Z0-9_]*$/.test(s)
}

// ─────────────────────────── validation ──────────────────────────────────────

/** True when a value matches its schema-declared type. */
function typeMatches(entry, value) {
  switch (entry.type) {
    case 'number':
      return Number.isFinite(value)
    case 'string':
      return typeof value === 'string'
    case 'enum':
      return typeof value === 'string' && Array.isArray(entry.values) && entry.values.includes(value)
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
    case 'object':
      return value != null && typeof value === 'object' && !Array.isArray(value)
    default:
      return true
  }
}

/** Recursively collect every string leaf of a value (for the secret scan). */
function collectStrings(value, out) {
  if (typeof value === 'string') {
    out.push(value)
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out)
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) collectStrings(value[k], out)
  }
}

/**
 * validateProfile(profile) -> {ok, violations:[{rule, field, message}]}.
 * Rules:
 *   - PROFILE-SCHEMA: an unknown top-level field, or a present field whose value
 *     does not match its schema type.
 *   - PROFILE-SECRET: a secret-shaped VALUE anywhere. envVarNames entries that are
 *     well-formed NAMES are exempt (names are facts, values are secrets).
 * A pure function — never reads disk, never writes.
 *
 * @param {object} profile
 * @returns {{ok:boolean, violations:{rule:string, field:string, message:string}[]}}
 */
export function validateProfile(profile) {
  const violations = []
  const p = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {}

  // PROFILE-SCHEMA — unknown fields + type mismatches.
  for (const key of Object.keys(p)) {
    if (!SCHEMA_FIELD_SET.has(key)) {
      violations.push({ rule: 'PROFILE-SCHEMA', field: key, message: `unknown top-level field "${key}" — not in PROFILE_SCHEMA; remove it or add it to the schema` })
      continue
    }
    const entry = PROFILE_SCHEMA.find((s) => s.field === key)
    const value = p[key]
    if (value == null) continue // absent/optional — never a type error
    if (!typeMatches(entry, value)) {
      const expected = entry.type === 'enum' ? `one of [${entry.values.join(', ')}]` : entry.type
      violations.push({ rule: 'PROFILE-SCHEMA', field: key, message: `field "${key}" must be ${expected} (got ${JSON.stringify(value)})` })
    }
  }

  // PROFILE-SECRET — secret-shaped values anywhere, with envVarNames exempt as names.
  for (const key of Object.keys(p)) {
    if (!SCHEMA_FIELD_SET.has(key)) continue
    if (key === 'envVarNames' && Array.isArray(p[key])) {
      for (const name of p[key]) {
        if (isEnvVarName(name)) continue // a NAME is a fact — allowed
        if (secretShaped(name)) {
          violations.push({ rule: 'PROFILE-SECRET', field: key, message: `envVarNames entry is secret-shaped — store NAMES only, never a value (T-49.3-06)` })
        }
      }
      continue
    }
    const strings = []
    collectStrings(p[key], strings)
    for (const s of strings) {
      if (secretShaped(s)) {
        violations.push({ rule: 'PROFILE-SECRET', field: key, message: `field "${key}" carries a secret-shaped value — the profile stores env-var NAMES and tool facts only, never a secret value (T-49.3-06)` })
        break // one violation per field is enough
      }
    }
  }

  return { ok: violations.length === 0, violations }
}

// ─────────────────────────── dead-field + coverage ───────────────────────────

/**
 * deadFields({schema, consumers}) -> string[]. Every schema field must have >=1
 * registered consumer; a field with none is dead (PROFILE-DEADFIELD). Pure;
 * DI-able so a test copy can drop a consumer entry. Sorted for determinism.
 *
 * @param {{schema?:SchemaEntry[], consumers?:Record<string,string[]>}} [opts]
 * @returns {string[]}
 */
export function deadFields(opts = {}) {
  const schema = opts.schema ?? PROFILE_SCHEMA
  const consumers = opts.consumers ?? PROFILE_CONSUMERS
  const dead = []
  for (const entry of schema) {
    const list = consumers[entry.field]
    if (!Array.isArray(list) || list.length === 0) dead.push(entry.field)
  }
  return dead.sort()
}

/** True when a value counts as an answer (present + non-empty at some leaf). */
function isAnswered(value) {
  if (value == null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.some(isAnswered)
  if (typeof value === 'object') return Object.keys(value).some((k) => isAnswered(value[k]))
  return false
}

/**
 * answeredFields(profile) -> string[]. The user-answered schema fields (askStage
 * A-D); 'meta' fields (profileVersion) never count. Its length is the coverage
 * number behind `sma profile --coverage` (P49.3-01-C). Pure; sorted.
 *
 * @param {object} profile
 * @returns {string[]}
 */
export function answeredFields(profile) {
  const p = profile && typeof profile === 'object' ? profile : {}
  const out = []
  for (const entry of PROFILE_SCHEMA) {
    if (entry.askStage === 'meta') continue
    if (isAnswered(p[entry.field])) out.push(entry.field)
  }
  return out.sort()
}

// ─────────────────────────── quick-path interview planner (BL-167) ───────────

/** askStage rank for the quick-path ordering (A→D); 'meta' is never asked. */
const ASK_STAGE_ORDER = { A: 0, B: 1, C: 2, D: 3 }

/**
 * interviewPlan(profile) -> { entries:[{field, askStage, description}], nothingToAsk }.
 *
 * The BL-167 quick-update planner: the deterministic complement of answeredFields.
 * It returns every NON-meta schema field the user has NOT answered, ordered by
 * askStage A→D then PROFILE_SCHEMA declaration order within a stage. PURE:
 * normalizeProfile FIRST (so a v1 profile's already-answered fields never
 * re-surface — the v1 user is asked only the genuinely new v2 fields), then
 * schema-minus-answered via the SAME per-field `isAnswered` predicate
 * answeredFields uses (no duplication). No Date.now, no random — identical inputs
 * yield deeply-equal plans. It PLANS ONLY; it never writes and never re-asks an
 * answered field. An empty profile degrades honestly to the full non-meta schema
 * (a full interview, still zero TEACH).
 *
 * @param {object} profile
 * @returns {{entries:{field:string, askStage:string, description:string}[], nothingToAsk:boolean}}
 */
export function interviewPlan(profile) {
  const p = normalizeProfile(profile)
  const entries = []
  for (const entry of PROFILE_SCHEMA) {
    if (entry.askStage === 'meta') continue // auto-set — never asked
    if (isAnswered(p[entry.field])) continue // already answered — never re-asked
    entries.push({ field: entry.field, askStage: entry.askStage, description: entry.description })
  }
  // Stable sort by askStage A→D; PROFILE_SCHEMA declaration order survives within a stage.
  entries.sort((a, b) => (ASK_STAGE_ORDER[a.askStage] ?? 99) - (ASK_STAGE_ORDER[b.askStage] ?? 99))
  return { entries, nothingToAsk: entries.length === 0 }
}

/** A minimal schema-type-valid non-empty sample value (selftest fixtures only). */
function sampleAnswer(entry) {
  switch (entry.type) {
    case 'number':
      return 2
    case 'enum':
      return Array.isArray(entry.values) && entry.values.length ? entry.values[0] : 'x'
    case 'string[]':
      return ['x']
    case 'object':
      return { k: 'v' }
    default:
      return 'x'
  }
}

/**
 * profileSelftest(planner = interviewPlan) -> 1 | 0. Runs the fixture pair in
 * memory: (a) a v2 profile with exactly 2 unset fields must plan exactly those 2;
 * (b) a fully-answered profile must yield the nothing-to-ask fast exit. Returns 1
 * when both hold, else 0. The planner is INJECTED so a sabotaged copy (one that
 * re-asks an answered field) provably scores 0 — the self-proving contract. Pure,
 * numeric: the predict.mjs scorer reads the bare 1/0 (P49.4-04-A).
 *
 * @param {(profile:object)=>{entries:{field:string}[], nothingToAsk:boolean}} [planner]
 * @returns {number}
 */
export function profileSelftest(planner = interviewPlan) {
  const full = {}
  for (const entry of PROFILE_SCHEMA) {
    full[entry.field] = entry.askStage === 'meta' ? 2 : sampleAnswer(entry)
  }
  const twoUnset = { ...full }
  delete twoUnset.pushTarget
  delete twoUnset.database

  const planA = planner(twoUnset)
  const fieldsA = Array.isArray(planA && planA.entries) ? planA.entries.map((e) => e.field) : []
  const okA =
    fieldsA.length === 2 &&
    fieldsA.includes('pushTarget') &&
    fieldsA.includes('database') &&
    planA.nothingToAsk === false

  const planB = planner(full)
  const okB = Array.isArray(planB && planB.entries) && planB.entries.length === 0 && planB.nothingToAsk === true

  return okA && okB ? 1 : 0
}

// ─────────────────────────── recap render ────────────────────────────────────

/** The five Recap: one-liners from onboarding-teaching.md, in document order. */
function parseRecapLines(teachingSource) {
  const out = []
  for (const line of String(teachingSource ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const m = /^Recap:\s*(.+)$/.exec(line.trim())
    if (m) out.push(m[1].trim())
  }
  return out
}

/** Deterministic one-line rendering of a field value (stable key order). */
function renderValue(v) {
  if (Array.isArray(v)) return v.map(renderValue).join(', ')
  if (v && typeof v === 'object') {
    return Object.keys(v)
      .sort()
      .filter((k) => isAnswered(v[k]))
      .map((k) => `${k}: ${renderValue(v[k])}`)
      .join('; ')
  }
  return String(v)
}

const NOT_SET = 'not set — will ask when needed'

/**
 * renderRecap({profile, teachingSource, seededFiles}) -> markdown string. PURE +
 * DETERMINISTIC: no Date.now(), no random — same inputs yield byte-identical
 * output (P49.3-01-B). Sections: (a) seeded files; (b) the profile table (answered
 * vs «not set»); (c) the five module recap one-liners read from teachingSource;
 * (d) next commands. Unset fields render the honest NOT_SET copy.
 *
 * @param {{profile:object, teachingSource:string, seededFiles:string[]}} args
 * @returns {string}
 */
export function renderRecap({ profile, teachingSource, seededFiles } = {}) {
  const p = normalizeProfile(profile)
  const files = Array.isArray(seededFiles) ? seededFiles : []
  const recaps = parseRecapLines(teachingSource)

  const lines = []
  lines.push('# Onboarding recap')
  lines.push('')
  lines.push('A deterministic record of everything /sma-start captured. Re-render anytime with `sma profile --recap`.')
  lines.push('')

  lines.push('## What was seeded')
  lines.push('')
  if (files.length === 0) {
    lines.push('- (nothing seeded)')
  } else {
    for (const f of files) lines.push(`- ${f}`)
  }
  lines.push('')

  lines.push('## Your profile')
  lines.push('')
  lines.push('| Field | Value |')
  lines.push('| --- | --- |')
  for (const entry of PROFILE_SCHEMA) {
    if (entry.askStage === 'meta') continue
    const value = p[entry.field]
    const cell = isAnswered(value) ? renderValue(value) : NOT_SET
    lines.push(`| ${entry.field} | ${cell} |`)
  }
  lines.push('')

  lines.push('## How SMA works (five things)')
  lines.push('')
  if (recaps.length === 0) {
    lines.push('- (teaching source unavailable)')
  } else {
    recaps.forEach((r, i) => lines.push(`${i + 1}. ${r}`))
  }
  lines.push('')

  lines.push('## Next')
  lines.push('')
  lines.push('- /sma-discuss 1 — talk through the first phase before planning it')
  lines.push('- /sma-plan 1 — plan the first phase directly if it is already clear')
  lines.push('')

  return lines.join('\n')
}
