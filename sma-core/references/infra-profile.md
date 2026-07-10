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

## Schema (`.sma/profile.json`)

```json
{
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
  "notes": "free text — anything else a release helper should know"
}
```

| Field | Meaning |
|---|---|
| `pushTarget` | Where code is pushed — the shared copy of the repository (host + repo path). |
| `autoDeployBranch` | Branch whose push automatically goes live. Omit when nothing auto-deploys. |
| `deployHost` | The service that serves the deployed code, if any. |
| `database` | The database the project uses (`sqlite`, `postgres`, `mysql`, a managed service name, or absent for none). |
| `sharedCounters` | Which numbered resources parallel sessions must coordinate on. Values map to the slot names `next-slot` understands: `"migration"`, `"release"`. Empty or absent = no shared counters yet. |
| `releaseRitual.tagPattern` | The version-label pattern stamped on each release commit (e.g. `v0.N` — N increments by one per release). |
| `releaseRitual.fullGateCommand` | The command that must exit green BEFORE any push that ships (tests, type check — whatever "safe to ship" means in this project). |
| `releaseRitual.ciWatchCommand` | The command that watches the automated post-push check run to completion, if CI exists. |
| `notes` | Free text for anything the fields above do not capture. |

**Every field is optional.** An absent field is NOT an error and is NOT substituted with
a default — it means "not decided yet". The consumer that needs the missing field asks
the user AT THAT MOMENT and offers to save the answer back into the profile.

## Consumer contract

| Consumer | What it reads | On a missing profile/field |
|---|---|---|
| `workflows/ship.md` | `releaseRitual` (tagPattern, fullGateCommand, ciWatchCommand), `autoDeployBranch`, `pushTarget` | Ask the user for the missing piece, offer to save it into `.sma/profile.json`. Never substitute another project's ritual. |
| `next-slot` (`scripts/sma/lib/slots.mjs` via `pnpm sma next-slot`) | `sharedCounters` — which counters are coordination-worthy in this project | Counter not listed = no slot coordination claimed for it; ask before assuming a counter is shared. |
| Push-safety gates (pre-push hooks, push-claim checks) | `autoDeployBranch` (a push to it is a deploy), `releaseRitual.fullGateCommand` | Ask; a gate never invents a command to run. |

The one non-negotiable rule for all consumers: **fallback is ask-the-user, never a
hardcoded default.** No consumer may assume a particular host, tag scheme, or gate
command when the profile is silent.

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
