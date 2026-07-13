<!-- sma:loop-host
step: sma-start
points: sma-start:pre, sma-start:post
agent-roles: orchestrator
produces: PROJECT.md, ROADMAP.md, TAGS.md, starter CORE notes, .sma/profile.json, .sma/onboarding-recap.md
consumes:
-->
<purpose>
First-run onboarding for SMA (FI-2 + FI-3), rebuilt for V3.5 as a STAGED, TEACHING
conversation (D-49.3-03/04/05). Not a scaffolding script and not one front-loaded
lecture: the workflow TEACHES how SMA works and WHY the process matters — five
deterministic modules delivered at the moment each becomes relevant — while it learns a
FULL working profile (schema v2) and seeds the starter memory corpus. The founder's ask,
verbatim: «Give people as much intro as possible» (D-49.3-03) — adoption is decided in the
first ten minutes.

The teaching CONTENT is versioned in `references/onboarding-teaching.md` (five modules,
each with one before/after example and a one-line recap); THIS workflow only STAGES it —
a `> TEACH(<module-id>)` marker fires each module immediately before the stage it makes
meaningful, never all at once (D-49.3-05). The end product includes a deterministic recap
artifact (`.sma/onboarding-recap.md`).

Supersedes bare `new-project.md` as the entry point for a fresh install: the file-writing
mechanics are reused from there; the interaction model is this conversation. Every V2
mechanic (PROJECT/ROADMAP seed, TAGS.md grammar, MEM-SCHEMA note frontmatter, the
lint-clean law, the profile write + mirror notes, the close pointer) survives verbatim —
this is an ENRICHMENT of the shipped V2 flow, NOT a from-scratch rewrite (D-49.3-02).
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
Also read:
- `references/onboarding-teaching.md` — the five teaching modules this workflow stages
  (deliver each module's content at its `> TEACH(<module-id>)` marker; the text is
  deterministic, the delivery is conversational).
- `references/infra-profile.md` — the profile schema v2 stages C + D fill.
</required_reading>

<hard_rules>
- Plain language throughout. The audience includes novices — every technical term gets a
  one-line gloss the first time it appears. Never assume the user knows git remotes,
  CI, migrations, or hooks.
- Teaching is STAGED, never front-loaded. Deliver each module at its marker, immediately
  before the stage it makes meaningful — never one lecture blob at the top (D-49.3-05).
- The teaching TEXT is deterministic — it comes from `references/onboarding-teaching.md`.
  Do not improvise new modules or reorder them; deliver the five as written, in order.
- The user's answers are the source of truth. Suggest, never impose: novices get sane
  defaults OFFERED (spoken, never auto-written); an expert's confident answer is respected
  as-is and compresses the novice glosses. «I don't know» / «none» is always valid and
  leaves the field UNSET (the dependent tool asks again when it actually matters).
- One question at a time; follow up on interesting answers (the V2 posture).
- NEVER hardcode any specific host, tag scheme, or company ritual as a default. Every
  project-specific value comes from the user's answers and lands in their profile.
- NEVER write a secret VALUE into the profile. Capture env-var NAMES and tool FACTS only;
  the validator rejects secret-shaped values deterministically (T-49.3-06).
- Everything this workflow writes must pass `pnpm sma lint` immediately — the starter
  notes use the exact frontmatter schema the linter enforces.
</hard_rules>

<process>

## Quick path for existing installs (BL-167)

Before Stage 0, decide whether this is a FRESH install or an EXISTING one — this
routing happens BEFORE any teaching module fires:

```bash
ls .sma/profile.json 2>/dev/null && echo "EXISTING — profile present" || echo "FRESH — full onboarding"
```

- **FRESH install** (no `.sma/profile.json`): run the full staged teaching flow
  below, Stage 0 through Stage 5. This is the default.
- **EXISTING install** (a `.sma/profile.json` is already present): the user already
  knows SMA — do NOT re-run the ~23-question teaching onboarding. Offer the quick
  path instead:

  > You already have a profile. Two options: a full re-onboarding (all stages, with
  > teaching), or the quick path — `pnpm sma profile --quick` prints exactly the
  > fields that are still unset, in order, with zero teaching modules. Answer only
  > those; I write them straight to `.sma/profile.json` through the same validation
  > (secret-shaped values are still rejected, T-49.3-06). Which do you want?

  On the quick path: run `pnpm sma profile --quick`, ask ONLY the fields it lists
  (each carries its one-line description), and write the answers through the Stage D
  profile-write step (`pnpm sma profile --lint` clean, then commit). If it prints
  «nothing to ask», the profile is already complete — say so and stop. NEVER re-ask
  an answered field; NEVER deliver a TEACH module on the quick path. A full
  re-onboarding stays available on request and remains the default for fresh installs.

## Stage 0 — OPEN with the thesis

> TEACH(accountable-loop)

Open the conversation by delivering Module 1 (the accountable loop) from
`references/onboarding-teaching.md` — it is the thesis of the whole system: SMA is a
process (predict → act → score → learn), not a rules file. Keep it plain and short, use
its before/after example, and close with one sentence: "Now let's set this up around YOUR
project — I'll explain each part right before we use it, then write everything down."

## Stage A — PROJECT: what you build, seed PROJECT.md + ROADMAP

Ask, conversationally (one question at a time, follow up on interesting answers). This is
Stage A of the profile capture — six questions:

1. **What are you building?** (product, tool, site, service — their words)
2. **For whom?** (users, customers, just themselves)
3. **What does success look like?** (the outcome that would make them say "it works")
4. **What exists already?** (empty folder, a prototype, a live product with users)
5. **What went wrong in your last month of AI-assisted work?** (the burns worth
   remembering — seeds `machineLessons` and the first bug-lesson candidates)
6. **Solo or a team — and how many parallel AI terminals do you run at once today?**
   (seeds `parallelTerminals.typicalCount` + `.splitHabit`)

**Adaptive rule (brownfield):** if a `.planning/` directory already exists, do NOT
re-seed — reconcile instead. Read the existing PROJECT.md/ROADMAP.md, confirm what is
current with the user, and SKIP the seed-writing sub-step below (go straight to Stage B).

From the answers, seed the planning files — reuse the file-writing steps of
`new-project.md` (its "## 4. Write PROJECT.md" section and its roadmap-creation step),
NOT its questioning flow:

- Write `.planning/PROJECT.md` from `templates/project.md`: what this is, core value,
  requirements as hypotheses (greenfield) or inferred from existing code (brownfield),
  key decisions from the conversation, evolution section, last-updated footer.
- Write a first `.planning/ROADMAP.md` skeleton: 2-4 phases maximum, derived from what
  they said success looks like. This is a starting sketch the user will refine with
  `/sma-plan` — say so explicitly.
- Commit both:

```bash
mkdir -p .planning
sma_run query commit "docs: initialize project via /sma-start" --files .planning/PROJECT.md .planning/ROADMAP.md
```

## Stage B — STACK & TESTS

> TEACH(memory-layers)

Deliver Module 2 (the three memory layers) here — it explains WHY the facts you are about
to capture are worth writing down once (they become the always-loaded CORE + tag-pulled
periphery every future session reads).

**Make the split CONCRETE — render the memory-graph preview of THEIR repo (v3.6):**

```bash
node scripts/sma/cli.mjs memory-preview            # this project (--lang ru for Russian)
```

Show the rendered graph to the user verbatim. It draws how THIS project's memory will
split — CORE / periphery areas from their real file tree / reflex candidates mined from
their own git history — read-only, zero network, deterministic at one HEAD. To preview a
DIFFERENT repository first: `node scripts/sma/cli.mjs memory-preview --project <path>`.
A directory with no git history degrades to the fresh-project layout; never let a
preview failure stall the onboarding — skip it and continue.

Then ask five questions (Stage B of the profile):

7. **Languages and frameworks?** → `stack.languages[]`, `stack.frameworks[]`
8. **Package manager?** (npm, pnpm, pip, cargo…) → `stack.packageManager`
9. **Test runner, and the EXACT command to run one targeted test file?** → `testRunner.name`,
   `testRunner.targetedCommand` (novice: "no tests yet" is valid — leave unset)
10. **Type-check / lint commands, if any?** → `testRunner.typeCheckCommand`,
    `testRunner.fullSuiteCommand`
11. **Editor or OS quirks worth knowing?** (Windows path locks, a fussy shell…) →
    `machineLessons[]`

**Seed the memory corpus** (V2 mechanics, unchanged). First show what exists:

```bash
ls .claude/memory/ 2>/dev/null || echo "(no memory yet — this is a fresh install)"
```

**TAGS.md — the tag registry.** Create `.claude/memory/TAGS.md` with three facets:

- `## area` — 4-8 area tags derived from the user's OWN domains (the things they named in
  Stage A: e.g. `payments`, `catalog`, `mobile-app`), plus the two universal areas `tech`
  (infrastructure, build, general engineering) and `workflow` (how work is planned/executed).
- `## kind` — the standard closed set: `procedural-rule`, `decision`, `episodic`,
  `status`, `reference`, `bug-lesson`.
- `## phase` — the open facet: an optional `phase:NN` tag binds a note to a roadmap phase.

Line grammar is strict (the parser consumes it): under each `## <facet>` heading, one line
per tag: `- <tag> — <one-line description>` (optionally ` · aliases: a, b`). The ` — `
separator between tag and description is structural.

**First CORE notes.** Write 2-4 notes into `.claude/memory/`, each built FROM THE USER'S
OWN ANSWERS. Suggested set:

- `project_goal.md` — what they build, for whom, what success looks like (kind: `status`)
- `reference_stack.md` — languages, frameworks, package manager, test command (kind: `reference`)
- `reference_constraints.md` — hard constraints they named (kind: `procedural-rule`/`reference`)
- one `bug-lesson` note per real burn from Stage A Q5, IF the user named a concrete
  mechanism (kind: `bug-lesson`; body carries `**Why:**` + `**How to apply:**`)

Every note MUST carry the exact frontmatter keys the linter (`lint.mjs`, MEM-SCHEMA)
enforces — `description`, `kind`, `tags`, `use-when`, `importance`:

```markdown
---
description: One standalone sentence stating the fact this note holds (at least 5 words).
kind: reference
tags: [tech, reference]
use-when: When picking libraries or writing build or deploy commands for this project.
importance: 8
---

# Project stack

(body: the user's answer, in their words, lightly structured)
```

Rules: `kind` and every `tags` entry must exist in the TAGS.md you just wrote (unknown tag
= lint error); `importance` is an integer 1-10; `use-when` says when a future session
should pull this note. Write memory notes via `bash`/`node fs`, never the editor Write
tool (the auto-memory feature re-nests editor-written notes).

**Build the index and prove it lints clean** — a fresh install must lint clean:

```bash
pnpm sma build-index --write
pnpm sma lint
```

If lint reports anything, fix the notes or TAGS.md NOW — never hand the user a corpus that
starts life broken. Then commit:

```bash
sma_run query commit "memory: seed starter corpus from onboarding answers" --files .claude/memory/
```

## Stage C — INFRA PROFILE (V2 stage 4, kept verbatim)

> TEACH(coordination)

Deliver Module 4 (coordination without a server) here — it explains WHY the shared-counter
answer matters (parallel terminals reserve migration/release numbers via marker files).
Then say in one sentence: "A few questions about your infrastructure, so the release and
coordination tools follow YOUR process instead of guessing."

Elicit each field conversationally. For every question, offer a novice suggestion but
accept whatever the user already uses; «I don't know» / «none» leave the field unset. Six
questions (Stage C of the profile):

12. **Push target** — "Where does your code get pushed?" (a remote = the shared copy of
    your repository). Novice suggestion: GitHub, a free account is enough. → `pushTarget`
13. **Auto-deploy** — "Does pushing to some branch automatically put code live? Which
    branch, on which host?" "No auto-deploy" is a perfectly valid answer. →
    `autoDeployBranch`, `deployHost`
14. **Database** — "Which database, if any?" Novice suggestion: SQLite to start (a
    single-file database, zero setup), Postgres when you need a real server. → `database`
15. **Shared counters** — "Is there anything numbered that two parallel sessions could
    both grab — migration numbers, release numbers?" (a migration = a numbered change to
    the database structure). Values map to the slot names `next-slot` understands
    (`migration`, `release`); empty list until then. → `sharedCounters`
16. **Release ritual** — "When you ship: a tag pattern (a version label like v1.4 on the
    commit)? a command that must be green before pushing (tests, type check)? a command
    that watches CI (the automated check run) after the push?" → `releaseRitual.tagPattern`,
    `releaseRitual.fullGateCommand`, `releaseRitual.ciWatchCommand`
17. **Anything else** a release helper should know, plus any env-var NAMES the ship
    preflight should check are set (NAMES only, never values). → `notes`, `envVarNames[]`

## Stage D — WORKING STYLE & RISK

> TEACH(hook-points)

Deliver Module 3 (the four hook points) here — it explains WHERE these answers fire: the
danger commands become before-each-edit warnings, the risk tolerance tunes how loud the
gates and reflexes are. Then ask six questions (Stage D of the profile):

18. **Session rhythm** — long focused sessions, or many short ones? → `workingStyle.sessionRhythm`
19. **TDD preference** — write tests first, after, or not usually? → `workingStyle.tddPreference`
20. **Review habit** — read every diff, or trust green tests? → `workingStyle.reviewHabit`
21. **Risk tolerance** — conservative, balanced, or fast? → `riskTolerance`
22. **Danger commands** — "commands you never want run without being asked first"
    (force-push, `rm -rf`, database resets). Stored as MATCH PATTERNS for before-edit
    warnings — NEVER executed. → `dangerCommands[]`
23. **Personal machine lessons** — gotchas specific to THIS machine worth remembering. →
    `machineLessons[]`

**Write the profile:**

- `.sma/profile.json` — the machine-readable copy (create `.sma/` if absent). Only the
  fields the user actually answered; never write placeholder defaults. Add
  `"profileVersion": 2`. Capture env-var NAMES and tool FACTS only — NEVER a secret value.
- Mirror the same facts as reference-kind memory notes (e.g. `reference_infra.md`,
  kind: `reference`, tags include `tech`) so sessions that load memory know the
  infrastructure without opening the JSON.

Before committing, prove the profile is clean (schema + no secret-shaped value + no dead
schema field):

```bash
mkdir -p .sma
# write .sma/profile.json with the answered fields (see references/infra-profile.md)
pnpm sma profile --lint
pnpm sma build-index --write && pnpm sma lint
sma_run query commit "onboarding: infra profile v2 + mirror notes" --files .sma/profile.json .claude/memory/
```

Consumers: `ship.md`, `next-slot`, the push-safety gates, the context compiler, the
statusline, and gates-check all READ this profile. A missing profile or field means they
ask the user at that moment — they never fall back to some other project's ritual.

## Stage 5 — CLOSE: the recap + what to do next

> TEACH(receipts-vs-prose)

Deliver Module 5 (receipts, not prose) here — it frames what `/sma-plan` will ask of the
user next (pre-registered predictions on every plan). Then render the durable onboarding
recap and commit it:

```bash
pnpm sma profile --recap
sma_run query commit "onboarding: deterministic recap artifact" --files .sma/onboarding-recap.md
```

`.sma/onboarding-recap.md` is the onboarding's durable artifact (deterministic: same
inputs → byte-identical output) and the design surface registered as «New» in the design
SoT. End with a short, concrete pointer:

```
Setup complete. You now have:
- .planning/PROJECT.md + ROADMAP.md (your goal, on paper)
- .claude/memory/ (TAGS.md + your first CORE notes — lint-clean)
- .sma/profile.json (your full working profile, so tools follow YOUR process)
- .sma/onboarding-recap.md (a recap of everything captured — re-render anytime)

Next step:
- /sma-discuss 1 — talk through the first phase before planning it
- /sma-plan 1 — plan the first phase directly if it is already clear
```

</process>

<success_criteria>
- [ ] The five modules were delivered STAGED (accountable-loop first, receipts-vs-prose
      last), each at its marker before the stage it makes meaningful — never one lecture
- [ ] PROJECT.md + ROADMAP skeleton written from the user's answers and committed
      (brownfield: reconciled, not re-seeded)
- [ ] Starter corpus created: TAGS.md + 2-4 CORE notes with the exact lint-enforced
      frontmatter (description, kind, tags, use-when, importance); bug-lesson notes carry
      **Why:** + **How to apply:**
- [ ] `pnpm sma lint` passes clean on the fresh corpus
- [ ] Infra + working-style profile captured: `.sma/profile.json` (profileVersion 2, only
      user-answered fields, NO secret values) + mirror reference notes
- [ ] `pnpm sma profile --lint` clean (no schema / secret / dead-field violation)
- [ ] `.sma/onboarding-recap.md` rendered and committed
- [ ] User knows the next command to run
</success_criteria>
