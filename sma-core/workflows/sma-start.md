<!-- sma:loop-host
step: sma-start
points: sma-start:pre, sma-start:post
agent-roles: orchestrator
produces: PROJECT.md, ROADMAP.md, TAGS.md, starter CORE notes, .sma/profile.json
consumes:
-->
<purpose>
First-run onboarding for SMA (FI-2 + FI-3). Not a scaffolding script — a real conversation:
explain what the user just installed in plain words, learn what they build and what they
want to achieve, seed PROJECT.md and a first ROADMAP skeleton from their answers, create
the starter memory corpus (TAGS.md + the first CORE notes written from their own words),
and capture the infra profile (where code is pushed, what auto-deploys, which database,
which counters are shared, what the release ritual is) so every SMA side-process reads
THEIR setup instead of assuming anyone else's.

Supersedes bare `new-project.md` as the entry point for a fresh install: the file-writing
mechanics are reused from there; the interaction model is replaced by this conversation.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
Also read `references/infra-profile.md` (the profile schema stage 4 fills).
</required_reading>

<hard_rules>
- Plain language throughout. The audience includes novices — every technical term gets a
  one-line gloss the first time it appears. Never assume the user knows git remotes,
  CI, or migrations.
- The user's answers are the source of truth. Suggest, never impose: novices get sane
  defaults offered; an expert's existing stack is respected as-is.
- NEVER hardcode any specific host, tag scheme, or company ritual as a default. Every
  project-specific value comes from the user's answers and lands in their profile.
- Everything this workflow writes must pass `pnpm sma lint` immediately — the starter
  notes use the exact frontmatter schema the linter enforces.
</hard_rules>

<process>

## Stage 1 — ICEBREAKERS: what you now have

Open the conversation by explaining the system in plain words. Keep it to at most
~15 sentences total, zero jargon without a one-line gloss. Cover the four capabilities:

1. **Layered memory.** The system keeps notes about your project in two layers: a small
   CORE that is always loaded (the facts every session must know), and a periphery of
   topic notes pulled in by tags only when a task needs them. Nothing is ever deleted —
   old facts move to colder layers where tag search still finds them.
2. **Terminals that see each other.** If you run several AI coding sessions at once
   (several terminal windows on the same project), they leave small marker files for
   each other: who is working on what, who holds a shared counter, who is about to push.
   You get a warning before two sessions collide instead of a broken merge after.
3. **Predictions that score plans.** Before executing a plan, the system records what it
   expects to happen; afterwards it compares. Over time this calibrates how much to
   trust its own estimates — like a weather forecaster tracking their hit rate.
4. **Reflexes that warn before repeat mistakes.** Every confirmed bug becomes a short
   lesson note. Next time you touch the same kind of code, the lesson surfaces BEFORE
   the edit, not after the incident repeats.

Close the icebreaker with one sentence: "Now let's set this up around YOUR project —
a few questions, then I write everything down."

## Stage 2 — ELICIT: what you build, seed PROJECT.md + ROADMAP

Ask, conversationally (one question at a time, follow up on interesting answers):

1. **What are you building?** (product, tool, site, service — their words)
2. **For whom?** (users, customers, just themselves)
3. **What does success look like?** (the outcome that would make them say "it works")
4. **What exists already?** (empty folder, a prototype, a live product with users)

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

## Stage 3 — MEMORY SEED: the starter corpus from their own answers

First show what memory exists right now:

```bash
ls .claude/memory/ 2>/dev/null || echo "(no memory yet — this is a fresh install)"
```

On a first run there is none. Explain in one sentence: "I'll now create your project's
memory from what you just told me — so every future session starts already knowing it."

**3a. TAGS.md — the tag registry.** Create `.claude/memory/TAGS.md` with two facets:

- `## area` — 4-8 area tags derived from the user's OWN domains (the things they named
  in stage 2: e.g. `payments`, `catalog`, `mobile-app` — whatever their project splits
  into), plus the two universal areas `tech` (infrastructure, build, general engineering)
  and `workflow` (how work is planned and executed).
- `## kind` — the standard closed set: `procedural-rule`, `decision`, `episodic`,
  `status`, `reference`, `bug-lesson`.
- `## phase` — the open facet: an optional `phase:NN` tag binds a note to a roadmap phase.

Line grammar is strict (the parser consumes it): under each `## <facet>` heading, one
line per tag: `- <tag> — <one-line description>` (optionally ` · aliases: a, b`). The
` — ` separator between tag and description is structural.

**3b. First CORE notes.** Write 2-4 notes into `.claude/memory/`, each built FROM THE
USER'S OWN ANSWERS — their goal, their stack, their constraints. Suggested set:

- `project_goal.md` — what they build, for whom, what success looks like (kind: `status`)
- `reference_stack.md` — languages, frameworks, services they use (kind: `reference`)
- `reference_constraints.md` — hard constraints they named (kind: `procedural-rule` or
  `reference`)

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

Rules: `kind` and every `tags` entry must exist in the TAGS.md you just wrote (unknown
tag = lint error); `importance` is an integer 1-10; `use-when` says when a future
session should pull this note.

**3c. Build the index and prove it lints clean.** A fresh install must lint clean:

```bash
pnpm sma build-index --write
pnpm sma lint
```

If lint reports anything, fix the notes or TAGS.md NOW — never hand the user a corpus
that starts life broken. Then commit:

```bash
sma_run query commit "memory: seed starter corpus from onboarding answers" --files .claude/memory/
```

## Stage 4 — INFRA PROFILE: where your code lives and ships

Explain in one sentence: "Last part — a few questions about your infrastructure, so the
release and coordination tools follow YOUR process instead of guessing."

Elicit each field of the infra profile conversationally (schema and storage contract:
`references/infra-profile.md`). For every question, offer a novice suggestion but accept
whatever the user already uses — "I don't know" or "none" are valid answers and simply
leave the field unset (the dependent tool will ask again when it actually matters):

1. **Push target** — "Where does your code get pushed?" (a remote = the shared copy of
   your repository). Novice suggestion: GitHub, a free account is enough. → `pushTarget`
2. **Auto-deploy** — "Does pushing to some branch automatically put code live? Which
   branch, on which host?" Novice suggestion: none at first, or a free host with a
   deploy-on-push setup when they want a live site. "No auto-deploy" is a perfectly
   valid answer. → `autoDeployBranch`, `deployHost`
3. **Database** — "Which database, if any?" Novice suggestion: SQLite to start (a
   single-file database, zero setup), Postgres when you need a real server.
   → `database`
4. **Shared counters** — "Is there anything numbered that two parallel sessions could
   both grab — migration numbers, release numbers?" (a migration = a numbered change to
   the database structure). Novice suggestion: `["migration", "release"]` once a
   database and versioned releases exist; empty list until then. Values must map to the
   slot names `next-slot` understands (`migration`, `release`). → `sharedCounters`
5. **Release ritual** — "When you ship: is there a tag pattern (a version label like
   v1.4 on the commit), a command that must be green before pushing (tests, type
   check), a command that watches CI (the automated check run) after the push?" Novice
   suggestion: tag pattern `v0.N`, gate = the project's test command, CI watch = none
   until CI exists. → `releaseRitual.tagPattern`, `releaseRitual.fullGateCommand`,
   `releaseRitual.ciWatchCommand`
6. **Anything else** a release helper should know, free text. → `notes`

**Write the profile:**

- `.sma/profile.json` — the machine-readable copy (create `.sma/` if absent). Only the
  fields the user actually answered; never write placeholder defaults.
- Mirror the same facts as reference-kind memory notes (e.g. `reference_infra.md`,
  kind: `reference`, tags include `tech`) so sessions that load memory know the
  infrastructure without opening the JSON.

```bash
mkdir -p .sma
# write .sma/profile.json with the answered fields (see references/infra-profile.md)
pnpm sma build-index --write && pnpm sma lint
sma_run query commit "onboarding: infra profile + mirror notes" --files .sma/profile.json .claude/memory/
```

Consumers: `ship.md`, `next-slot`, and the push-safety gates READ this profile. A
missing profile or field means they ask the user at that moment — they never fall back
to some other project's ritual.

## Stage 5 — CLOSE: what to do next

End with a short, concrete pointer:

```
Setup complete. You now have:
- .planning/PROJECT.md + ROADMAP.md (your goal, on paper)
- .claude/memory/ (TAGS.md + your first CORE notes — lint-clean)
- .sma/profile.json (your infrastructure, so tools follow YOUR process)

Next step:
- /sma-discuss 1 — talk through the first phase before planning it
- /sma-plan 1 — plan the first phase directly if it is already clear
```

</process>

<success_criteria>
- [ ] User heard the four icebreakers (memory layers, terminals, predictions, reflexes) in plain words
- [ ] PROJECT.md + ROADMAP skeleton written from the user's answers and committed
- [ ] Starter corpus created: TAGS.md + 2-4 CORE notes with the exact lint-enforced frontmatter (description, kind, tags, use-when, importance)
- [ ] `pnpm sma lint` passes clean on the fresh corpus
- [ ] Infra profile captured: .sma/profile.json + mirror reference notes, only user-answered fields
- [ ] User knows the next command to run
</success_criteria>
