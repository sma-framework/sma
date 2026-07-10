# Infra profile — the portable record of a project's infrastructure (FI-3)

Every project has "side processes": where code is pushed, what auto-deploys, which
database sits under it, which numbers two parallel sessions could both grab, what the
release ritual looks like. These are project-specific INSTANCES of general concepts.
SMA captures them once, at onboarding (`/sma-start` stage 4), as an **infra profile** —
and every SMA tool that touches infrastructure READS the profile instead of hardcoding
any one project's process.

## Storage contract

The profile lives in TWO synchronized forms:

1. **`.sma/profile.json`** — the machine-readable copy, committed to the repo. This is
   what workflows and scripts read.
2. **Mirror memory notes** — the same facts as `kind: reference` notes in the memory
   corpus (e.g. `reference_infra.md`), so any session that loads memory knows the
   infrastructure without opening the JSON. When the profile changes, both are updated
   in the same commit.

## Schema v2 (`.sma/profile.json`)

Schema v2 (D-49.3-04) keeps EVERY v1 field and v1 law intact and ADDS a fuller working
profile — stack, test commands, parallel-terminal habits, risk posture, danger-command
patterns, working style, machine lessons, and env-var NAMES. A v1 profile (no
`profileVersion`) is upgraded to the v2 shape IN MEMORY by the reader (`normalizeProfile`)
without rewriting the file. Every field is still optional; absent still means
"ask-at-the-moment", never a hardcoded default.

```json
{
  "profileVersion": 2,
  "pushTarget": "github.com/acme/shop",
  "autoDeployBranch": "main",
  "deployHost": "the hosting service that redeploys on push, if any",
  "database": "postgres",
  "sharedCounters": ["migration", "release"],
  "releaseRitual": {
    "tagPattern": "v0.N",
    "fullGateCommand": "npm test && npx tsc --noEmit",
    "ciWatchCommand": "gh run watch --exit-status"
  },
  "stack": {
    "languages": ["typescript"],
    "frameworks": ["next.js", "payload"],
    "packageManager": "pnpm"
  },
  "testRunner": {
    "name": "vitest",
    "targetedCommand": "pnpm vitest run path/to/file.test.ts",
    "fullSuiteCommand": "pnpm test",
    "typeCheckCommand": "pnpm tsc --noEmit"
  },
  "parallelTerminals": {
    "typicalCount": 3,
    "splitHabit": "one terminal per phase"
  },
  "riskTolerance": "balanced",
  "dangerCommands": ["git push --force", "rm -rf", "drop table"],
  "workingStyle": {
    "sessionRhythm": "many short sessions",
    "tddPreference": "after",
    "reviewHabit": "read every diff"
  },
  "machineLessons": ["Windows Defender holds a just-written file for a few ms"],
  "envVarNames": ["STRIPE_SECRET_KEY", "DATABASE_URL"],
  "notes": "free text — anything else a release helper should know"
}
```

| Field | Meaning |
|---|---|
| `profileVersion` | Schema version. `2` for the v3.5 shape; absent = a v1 profile, upgraded in memory by the reader. |
| `pushTarget` | Where code is pushed — the shared copy of the repository (host + repo path). |
| `autoDeployBranch` | Branch whose push automatically goes live. Omit when nothing auto-deploys. |
| `deployHost` | The service that serves the deployed code, if any. |
| `database` | The database the project uses (`sqlite`, `postgres`, `mysql`, a managed service name, or absent for none). |
| `sharedCounters` | Which numbered resources parallel sessions must coordinate on. Values map to the slot names `next-slot` understands: `"migration"`, `"release"`. Empty or absent = no shared counters yet. |
| `releaseRitual.tagPattern` | The version-label pattern stamped on each release commit (e.g. `v0.N` — N increments by one per release). |
| `releaseRitual.fullGateCommand` | The command that must exit green BEFORE any push that ships (tests, type check — whatever "safe to ship" means in this project). |
| `releaseRitual.ciWatchCommand` | The command that watches the automated post-push check run to completion, if CI exists. |
| `stack` | `{languages[], frameworks[], packageManager}` — the technology the project is built on. Drives `sma emit` headers and planner context. |
| `testRunner` | `{name, targetedCommand, fullSuiteCommand?, typeCheckCommand?}` — how tests run. The executor's targeted-test rule reads `targetedCommand`; the ship full gate reads `fullSuiteCommand`/`typeCheckCommand`. |
| `parallelTerminals` | `{typicalCount, splitHabit}` — how many AI sessions run at once and how the user splits them. Drives the statusline segment and collision messaging. |
| `riskTolerance` | `conservative` \| `balanced` \| `fast` — how loud the gates/reflexes are and how the self-tuning ladder is presented. |
| `dangerCommands` | Match PATTERNS (strings) for commands the user never wants run without being asked first. Feed gates-check PreToolUse warnings. NEVER executed — patterns only. |
| `workingStyle` | `{sessionRhythm, tddPreference, reviewHabit}` — the user's rhythm. Drives the context-compiler pack header. |
| `machineLessons` | Short strings — gotchas of THIS machine. Seeded as memory notes so the reflex surface can raise them. |
| `envVarNames` | Env-var NAMES only (never values) the ship preflight should check are set. |
| `notes` | Free text for anything the fields above do not capture. |

**Every field is optional.** An absent field is NOT an error and is NOT substituted with
a default — it means "not decided yet". The consumer that needs the missing field asks
the user AT THAT MOMENT and offers to save the answer back into the profile.

## Consumer contract

| Consumer | What it reads | On a missing profile/field |
|---|---|---|
| `workflows/ship.md` | `releaseRitual` (tagPattern, fullGateCommand, ciWatchCommand), `autoDeployBranch`, `pushTarget`, `envVarNames` (ship preflight) | Ask the user for the missing piece, offer to save it into `.sma/profile.json`. Never substitute another project's ritual. |
| `next-slot` (`scripts/sma/lib/slots.mjs` via `pnpm sma next-slot`) | `sharedCounters` — which counters are coordination-worthy in this project | Counter not listed = no slot coordination claimed for it; ask before assuming a counter is shared. |
| Push-safety gates (pre-push hooks, push-claim checks) | `autoDeployBranch` (a push to it is a deploy), `releaseRitual.fullGateCommand` | Ask; a gate never invents a command to run. |
| `sma emit` headers + planner context (49.3-04/05) | `stack` (languages, frameworks, packageManager) | Omit the stack header; the planner asks when it matters. |
| Executor targeted-test rule + ship full gate | `testRunner.targetedCommand` (per-edit), `testRunner.fullSuiteCommand` / `typeCheckCommand` (push gate) | Ask for the command; never invent a test invocation. |
| Statusline segment + collision messaging (49.3-07) | `parallelTerminals` (typicalCount, splitHabit) | Segment renders a neutral count; no assumption about split habit. |
| gates/reflex verbosity + self-tuning ladder | `riskTolerance` | Default to the balanced presentation; ask before assuming a posture. |
| gates-check PreToolUse warn patterns | `dangerCommands` — match patterns only, NEVER executed | No extra warn patterns; the built-in safety invariants still fire. |
| Context-compiler pack header (49.3-05) | `workingStyle` (sessionRhythm, tddPreference, reviewHabit) | Omit the working-style header. |
| Reflex surface (seeded notes) | `machineLessons` — seeded as memory notes at onboarding | No machine-specific reflex; nothing assumed. |

The one non-negotiable rule for all consumers: **fallback is ask-the-user, never a
hardcoded default.** No consumer may assume a particular host, tag scheme, or gate
command when the profile is silent.

Every schema-v2 field above has at least one registered consumer in
`PROFILE_CONSUMERS` (`scripts/sma/lib/profile.mjs`). A schema field with ZERO consumers is
a lint failure (PROFILE-DEADFIELD) — a field nobody reads is the "700-line rules file"
failure in miniature (adoption scorecard metric 5). This table and `PROFILE_CONSUMERS`
must stay in agreement: adding a field here without a consumer entry there fails lint.

## Privacy boundary (T-49.3-06)

The profile stores **env-var NAMES and tool FACTS only — never a secret VALUE.** A name
(`STRIPE_SECRET_KEY`, `DATABASE_URL`) is a fact about which variables the project uses; a
value (`sk-live-…`) is a secret that must never enter a committed repo artifact other
tools read. `validateProfile` (`scripts/sma/lib/profile.mjs`) deterministically REJECTS
any secret-shaped value ANYWHERE in the profile BEFORE it is written — the check
(`secretShaped`) flags `sk-`/`ghp_`/`gho_`/`AKIA`/`xox`-prefixed tokens, `-----BEGIN`
key blocks, and long high-entropy opaque runs. `envVarNames` entries are validated as
NAMES (uppercase-with-underscores allowed), so the literal name `STRIPE_SECRET_KEY`
passes while a value never would. A secret-shaped value is a rejection (PROFILE-SECRET),
not a warning; the onboarding workflow never echoes a value into the profile.

## Safety boundary (T-49.1-09)

The profile supplies COMMAND STRINGS (`fullGateCommand`, `ciWatchCommand`) that the
user themselves configured for their own repository. Consumers must:

- **Echo the command** verbatim before running it, so the user always sees what is
  about to execute.
- Keep the safety invariants **non-configurable**: "never push when the gate is red"
  and "review the origin diff before pushing" are hard rules of `ship.md` itself — the
  profile decides WHICH commands implement them, never WHETHER they run.

## Novice defaults (suggestions, never auto-written)

`/sma-start` offers these to users who do not have an answer yet — they are suggestions
spoken in the conversation, never silently written into the profile:

- Push target: GitHub (a free account is enough).
- Deploy: none at first; a free host with deploy-on-push when a live site is wanted.
  "No auto-deploy" is a valid, complete answer.
- Database: SQLite to start (single file, zero setup); Postgres when a real server is
  needed.
- Shared counters: empty until a database or versioned releases exist; then
  `["migration", "release"]`.
- Release ritual: tag pattern `v0.N`; gate = the project's own test command; CI watch =
  none until CI exists.

## House rituals are instances, not defaults

Any specific team's process — a particular deploy host, a particular tag series, a
particular full-gate sequence — is exactly ONE possible profile. At dogfood time a team
writes ITS values into ITS `.sma/profile.json` (for this framework's home platform that
happens in phase 49.1-26). Nothing in sma-core may treat any team's values as the
built-in behavior.
