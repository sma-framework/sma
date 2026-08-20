<p align="center">
  <img src="assets/logo-banner.svg" alt="SMA — Shared Memory & Automation" width="830">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-5.6.0-3B82F6" alt="version 5.6.0">
  <img src="https://img.shields.io/badge/tests-3264%2F3264-3CC0A0" alt="tests 3264/3264">
<!-- sma:passport:begin -->
  <a href="PASSPORT.md"><img src="https://img.shields.io/badge/calibration-badge%20hidden%20%C2%B7%20no%20model%20recorded%20yet-E5B567" alt="calibration: badge hidden — no Claude model recorded yet" title="derived from PASSPORT.md, rebuilt each release, reproducible via `sma passport --verify`"></a>
<!-- sma:passport:end -->
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-source--available-3CC0A0" alt="source-available license"></a>
  <img src="https://img.shields.io/badge/runtime-plain%20files%20%2B%20git-2E6FD9" alt="plain files + git">
  <img src="https://img.shields.io/badge/LLM%20in%20the%20hot%20path-zero-1FA0A6" alt="zero LLM in the hot path">
</p>

# SMA — Shared Memory & Automation

**SMA is a local-first memory and accountability control plane for AI coding agents: it delivers the right project knowledge at the exact moment of action — and independently verifies the agent's claims. Layered memory that arrives on time, multi-terminal coordination without a server, and every "done" settled by a script, re-derived by a blind verifier, and blocked from shipping when it is false.**

[Русская версия → README.ru.md](README.ru.md)

> ### 🗺️ [Open the live system map →](https://sma-framework.github.io/sma/master-graph.html)
> Every subsystem of SMA on one interactive page — the fastest way to see how everything connects.

> ### 🆕 [What's new — the taskboard, and numbers that do not lie →](#whats-new--the-taskboard-and-numbers-that-do-not-lie)
> Every unit of work reads as one line and opens into its own view; the conversation about it is one keystroke away — and the gate that lets work out measures the worker's own copy, reddening only on what the worker actually broke.

> ### 🧭 [Roadmap →](ROADMAP.md) · [по-русски](ROADMAP.ru.md)
> Where SMA is and what comes next: **V5 orchestration (a 24/7 worker fleet) — shipped → V5.1 works-with-what-you-have + the working front — shipped (v5.1.0) → V5.2 measured memory — shipped (v5.2.0) → V5.3 governance + hardened fleet — shipped (v5.3.0) → V5.4 the whole working day without the terminal — shipped (v5.4.0) → V5.5 the engine: steering a live session — shipped (v5.5.0) → V5.6 the taskboard and honest numbers — in the repository, current.** The whole release history, note by note, is in [docs/DETAILS.md](docs/DETAILS.md#the-v5-series-release-by-release).

> **This is not a memory plugin.** It is a working discipline for shipping real code with an AI agent: memory that arrives at the exact moment it is needed, coordination that stops two terminals from overwriting each other, and a **trust spine** in which every "done" is settled by a script, re-derived by a blind verifier, and blocks the next release if it is false. It writes only to a few folders next to your code — **your source tree is never touched** — and everything it knows or enforces is a plain file you can read, diff, and revert.

---

## Install

### 1 · What you need first

| | |
|---|---|
| **Node 22.5 or newer** | Node is the program that runs SMA's scripts. Check what you have with `node -v`. If the number is lower, or the command is not found, install the current version from [nodejs.org](https://nodejs.org). |
| **git** | SMA keeps everything as ordinary text files in your repository, so your project should be a git repository (run `git init` in it if it is not one yet). |
| **Claude Code** | The AI coding agent SMA plugs into today. The `/sma-…` commands below are typed into a Claude Code session, the same way you talk to it normally. |

Nothing else. The core of SMA adds no packages to your project and needs no database, no server and no account. (An optional extra — the worker fleet described further down — does ask for more; you can ignore it entirely.)

### 2 · One command

Open a terminal, go to the top folder of **your own project**, and run:

```bash
npx -y sma-framework@latest init
```

That is the whole install. It takes a few seconds and prints every file it wrote. (`npx` is Node's built-in "fetch and run this once" tool; it leaves nothing behind afterwards.)

### 3 · What you have afterwards

New folders appear **next to** your code. Not one line of your own source is edited.

```text
your-project/
├─ src/, package.json…   ← YOUR CODE — untouched
│
├─ .claude/
│  ├─ skills/            ← the 14 /sma-… commands you can now type
│  ├─ agents/            ← the helpers those commands call on
│  ├─ sma-core/          ← the engine: the instructions behind each command
│  ├─ memory/            ← your project's notes — installed EMPTY, the notes stay yours
│  └─ settings.json      ← 7 hooks + the engine's statusline segment (your own entries are kept)
├─ scripts/sma/          ← the command-line tool the commands use underneath
├─ .sma/                 ← working state: who is editing what, and the log of checks
└─ CLAUDE.md             ← one short marked block is added; your own text is untouched
```

Those hooks are **seven entries across six agent events**, and together they are the
whole of SMA's grip on a session. `SessionStart` — pick up what this window was doing.
`PreToolUse` twice: once on the editing tools `Edit`/`Write`/`Bash`, where the collision,
reflex and gate checks run as one process, and once on the tool that spawns a subagent
(matched under both names that tool has carried across agent versions, so an upgrade
cannot quietly unhook it), so the subagent starts already holding the project's claims
and open questions. `PostToolUse` on the same editing tools — the stall check.
`SessionEnd` — hand back the claims this window is holding. `PreCompact` — write a flight
capsule before the context is trimmed. `SubagentStop` — check what a finishing subagent
said it wrote against what is actually in the tree.

Two things stated honestly, because a promise is worth less than a limit named out loud.
`SessionEnd` fires whenever the session ends — you close the window, you type `/clear`,
you log out — not only on a closed window. And the `PreCompact` capsule is written **when
your version of the agent announces that event**; on a version that does not, the command
simply exits without an error and nothing else changes. Your own entries in any of these
events are kept exactly as they are. What each hook does and the time budget it runs
under: [docs/DETAILS.md](docs/DETAILS.md).

The statusline gets one entry too, and it is installed **by default**: the engine's own
segment, a compact readout of what this window and the neighbouring ones are doing — the
attention pulse, the claim this window holds, today's collisions, how much of the
subscription window is used up, open gates, unscored predictions. If you already had a
statusline command of your own, it is kept verbatim and printed **first**; the segment
goes after it, and `/sma-deleteme` hands your line back byte-for-byte — or removes the
key entirely, if we were the ones who added it. The entry asks the agent to re-run it
once a minute, because repaints driven by events only ever reach the window where you
are typing; nothing would otherwise ask a quiet window to look again. The price of that
timer is named rather than hidden: once a minute, each open window spawns one short
process, and your own wrapped command with it.

A `.planning/` folder appears later, the first time you plan a piece of work.

Changed your mind? `/sma-update` re-runs this same installer to move to a newer version, and `/sma-deleteme` removes everything in one step — both keep your notes in `.claude/memory/` and everything else local. Install flags, the install-from-a-git-clone route, and the complete list of files: [docs/INSTALL.md](docs/INSTALL.md).

## First steps

### Start here

Open a Claude Code session in your project and type:

| Type this | What happens |
|---|---|
| `/sma-start` | A guided conversation, run once. It asks what your project is and how you ship it, writes the answers down, and starts your notes file. Everything you run later speaks in those terms. |
| `/sma-help` | The list of commands, one line each — your map when you forget a name. |
| `/sma-progress` | "Where are we?" — what is done, what comes next, and an offer to run it. |

### A normal working cycle

You work in **phases**: one chunk of work at a time — a feature, a fix, a rewrite. Four commands, always in this order:

1. `/sma-discuss-phase 1` — it asks you questions until the goal is unambiguous.
2. `/sma-plan-phase 1` — it writes the plan, including how the result will be checked.
3. `/sma-execute-phase 1` — it does the work and commits it, step by step.
4. `/sma-verify-work 1` — it walks the result through with you and re-runs the checks the plan promised.

Then repeat with `2`, `3`, and so on. For something small, skip all four: `/sma-quick` for a small task, `/sma-fast` for a one-liner.

### Where to look next

- [docs/INSTALL.md](docs/INSTALL.md) — install options, what lands where, updating and removing.
- [docs/DETAILS.md](docs/DETAILS.md) — the engineering deep dive, once you want to know how it works inside.
- `node scripts/sma/cli.mjs explain <name>` — run from your project root: a plain-language explanation of any SMA command.

## What's new — the taskboard, and numbers that do not lie

The window had a board of cards. This work turns it into the place the owner actually works from: **every unit of work reads as one line, opens into its own view, and the conversation about it happens without leaving the screen** — and every figure beside it is either measured or admitted to be missing.

**Three real kinds of work, not one thing wearing three labels.**

| | One line says |
|---|---|
| **A task** | the smallest unit — one order, one worker, one session. It closes when the session closes; nothing else has to be signed. |
| **A pack of tasks** | one sentence of yours spread over several items, worked one at a time by the same worker, and closed by a single assembly at the end. The line names which item is holding the assembly up. |
| **A phase** | the full cycle — discuss, plan, execute, verify — with gates between the stages. It does not call itself finished until verification and your acceptance are both behind it. |

A task is the bottom of the hierarchy and the way in is the same from everywhere: from inside a phase you reach it through a plan, from inside a pack through an item, and on its own it is simply a task with no parent. The trail at the top leads back exactly where you came from.

**A unit of work answers three questions, and the card is those three columns.** *What was promised* — the words of the order and the marks of success. *What was done* — what the attempt actually produced. *What proves it* — the receipt, not an adjective. Each column carries ✓ / ? / × only where the state is genuinely known; where the engine cannot answer, the cell says so in words. Under the columns: who was in the session — the worker first, its subagents beneath it, each with its model and how long it ran — the last event, what the attempt spent, and an explicit block for outside connections that is empty when there are none rather than absent.

**The words of a task are derived by the system, not typed by you.** You write the formulation. Press once and SMA proposes the description and the marks of success the way a planner derives criteria from a goal — visible on the card, and yours to correct. Nothing is queued by the proposal itself; a draft is a draft until you confirm it. Setting up a pack works the same way: write the sentence, and the system proposes what it could be made of — matching entries from your backlog and new sub-tasks split out of the sentence — every candidate confirmable, removable, and never queued without your word.

**A worker that stops with a question is impossible to miss.** The stop shows up in three places at once — the band at the top of the list, the row itself, and the card — each carrying how long it has been waiting. You answer from the conversation window, and the worker **continues the same session**: the return does not start over, and the context you already paid for stays in its head.

**Talk to the system without leaving the screen — `Ctrl K`.** The conversation opens over whatever you are looking at and takes its context from it, so «what is the state of this?» means *this*. Three things can come out of it: a decision on a waiting question, which travels to the worker; an order, which becomes a task and appears in the list; or an answer about the current state. Search and actions moved to `Ctrl P`.

**A whole echelon can be told to stand.** «Stop wave 2» — confirmed, then the tasks of that wave finish the move they are in and stop; nothing is torn mid-step. Unfinished steps stay in their sessions, and when you lift the hold they continue from exactly where they stood. The hold is written to disk, so it survives a restart of the daemon.

**Work that is already built is not built again.** Before the daemon starts a worker it asks the already-built preflight — a millisecond, zero-token check — whether the thing has already been done: it reads **every plan of the task's phase** and compares each plan's own claims against the real tree. If every one of them answers built, the task closes on that check's receipt and no session is ever started; nothing is rebuilt for pay. One plan short and the door stays shut, deliberately: a false «not built» costs one extra run, while a false «already built» would close the task with the work never done, quietly, with «completed» standing in the ledger — so a door that exists to save work errs towards doing it. **The verdict is written to the daemon's log every time** — built, partially built, absent, and the verb's own failure alike. And the door is only asked where there is something deterministic to ask about: an ordinary order carries no phase and no plan behind it, its marks of success are prose, and a verdict may never be made to judge prose — so it is not asked at all, and *that* reason is on the record too. A door that is quietly never opened looks exactly like a door that is broken; one line naming the plan and the verdict turns a year of silence into a minute of reading.

**The gate that lets work out is differential, and it measures the worker's own copy.** A worker's changes used to be judged against a whole-repository run, so anything already red before the task started came back as the worker's fault — and the same run measured the tree the *daemon* stood in rather than the tree the work actually happened in. Both are fixed. The gate takes its two snapshots — before and after — **naming the worker's working copy in each**, and `reverify --tree` runs the checks against the tree it was told to measure while the accounting stays in one shared ledger. Only a divergence that is **new** is red. A pre-existing failure is reported as pre-existing, by name, so it can be dealt with as its own piece of work rather than blocking someone who did not cause it.

**Numbers that are measured, or absent — never invented.**

| | What it says now |
|---|---|
| **How long it has been waiting** | counted from the moment the work actually stopped, not from when the row was created — and a decision that has been waiting a minute is not called «stuck» |
| **How many attempts** | attempts, counted as attempts: three approaches written down as six journal lines are three, not six |
| **One task, one line** | every section of the list stands for the **last word** about a task, so a returned task appears once — under its own name, never as an identifier |
| **A merge receipt** | answers «not run» when the tests were never wired to it, instead of reporting a green it did not observe |
| **Anything the engine cannot answer** | says «no data» in words. A zero that is wrong is worse than a blank, because it reads as an answer |

**Accepting the work happens in the right tree, and a refusal says why.** The approve door merges in the tree that actually holds the branch — the connected project's, not the daemon's — and when it refuses, it names the reason in words and the card shows that reason instead of a dead button. Every attempt's journal now carries the **list of files it changed** beside the commit it started from, so «what would I be rolling back?» is answered by the record rather than by reconstruction.

### Everything before it

The V5 line shipped as a release every few days. In one breath: V5 built the fleet and its engine; V5.1 put the window in front of it; V5.2 made the memory layer measurable; V5.3 made it governable and gave the fleet a state machine its running code consults; V5.4 turned the window into a place you can work from all day, and taught the system that **an answer is also work**; V5.5 built the wheel — steering a live session, with a correction written to disk before anything is killed. Each of those releases, with its fix list and what it deliberately did not claim, is in [docs/DETAILS.md](docs/DETAILS.md#the-v5-series-release-by-release).

**What this does not claim.** This release lives in the repository (tag v5.6.0); the npm listing is deliberately behind while the engine settles — installing from npm today gives you the last published version, not this page.

## The window — the app the daemon serves

V5 shipped the engine and a deliberately thin operations panel. The releases after it built the app on top: **two dozen screens**, compiled once and served by the daemon itself, behind the same token and the same frozen route table. No second web server appears, no extra port is opened, nothing new listens.

The app arrives already compiled: the npm package carries the built front in `daemon/static/app`, so there is nothing to build before you can open it. The daemon's own dependencies ride inside the package the same way — nineteen packages, about 6 MB, vendored in `daemon/node_modules` — so there is no second `npm install` for it either; the full list, with the licence each one carries, is in [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md). From a git clone, `cd spa && npm run build` rebuilds it into that same folder. The daemon needs no further wiring, and the panel it already served stays exactly where it was, as the emergency view. A clean boot says so out loud — one line, *«Buckle up, soldier — the park is live»*, naming the exact address to open; failure was always loud, and success no longer whispers.

### The whole working day, without the terminal

The screens behind the daemon became a place you can actually work from. The route table that
carries them is **declared once and frozen** — its size is a test, and it grows only by an
explicit, recorded revision, so the surface cannot quietly turn into remote command execution.
Every door in it is live: there is no «coming soon» handler left in the table.

- **The phase cycle, run from the app.** An index of every phase with «N open / M answered», a
  card per phase with its four stages and a button on each, plans and summaries opened in place
  as plain text, and the acceptance list answered line by line. A phase is named the way *you*
  named it in the roadmap, not by its directory.
- **A parked question is answered on a card.** When a stage stops to ask, the question arrives in
  the window in exactly the shape the engine parked it — a variant or your own words, one of the
  two, and the form says which to remove rather than silently dropping one.
- **The live attempt log.** A worker's output streams into the screen *while it is still talking*,
  including the text of its subagents — so a session that delegates does not go silent behind a
  spinner for minutes.
- **The memory workbench.** Drafts are reviewed and applied one at a time, each with its own
  preview and its own yes; the lint report, the index rebuild and the corpus doors are all in the
  window. Nothing is written to your corpus without a per-file confirmation.
- **Coordination and backlog.** Who is holding what, which claims collide, and the backlog with a
  «promote to a task» door — the same state the terminal reads, in one place.
- **The ship card — and it never pushes.** It runs the gate, records the run, and marks the
  result. **The publish itself stays a human action**, by construction: there is no path from the
  daemon to `origin`, and this card does not invent one.
- **Search across everything, and Ctrl+K.** One search over tasks, phases, memory and backlog with
  a visibility filter, and a command palette. The palette **opens the thing that acts** rather than
  acting itself — a keystroke is not consent.
- **Several accounts, secrets staying local.** Accounts are added from the window; the value of a
  token never travels through it, only the NAME of the variable it lives in. Each worker session
  is assembled with one account's credentials and no other's.

### Opening the window — what a first run actually needs

The app belongs to the **optional** V5 layer, and that layer asks for two things the memory and coordination core never does: a process that stays up, and somewhere durable to keep the work. Nothing below is needed to use SMA's memory, coordination or accountability — skip the whole section and everything else still works.

**1 · A local PostgreSQL for the queue.** The daemon keeps its task queue in Postgres (pg-boss), in a database of its own — never your application's production database, and never exposed to the internet. There are two honest roads and the product does not pretend there is a third: point `queueUrl` at **a server you already run** (SMA neither installs PostgreSQL nor manages yours), or start **the bundled sandbox**, for a machine with no PostgreSQL, no docker and no administrator rights:

```bash
node supervisor/pg-sandbox-windows.mjs start
```

It waits until a real session answers instead of trusting an open socket, creates the queue's database if it is missing, and says so and exits 0 when everything is already up. The whole road — including the one-time step that creates the sandbox directory — is in [docs/INSTALL.md](docs/INSTALL.md).

**A task can be named in any language.** If the queue database was created in a non-UTF-8 encoding (the Windows `initdb` default), SMA says so at boot — naming the database, what will happen to a non-ASCII title, and the command that repairs it — and refuses such a title with that same sentence instead of an "internal error". `node supervisor/queue-utf8-migrate.mjs` reports; `--apply` builds a UTF-8 database, carries the waiting tasks and the attempt rows over, and keeps the old database under a new name. The whole procedure, and what deliberately does not travel, is in [supervisor/setup-windows.md](supervisor/setup-windows.md).

**2 · Start the daemon**, from the SMA checkout or the installed package directory:

```bash
node daemon/src/main.mjs
```

The first boot writes `~/.sma-daemon/config.json` — machine-local settings, never committed, carrying a freshly generated front token — and then prints the address it listens on (`127.0.0.1:7777` by default). If the queue is unreachable the boot fails loudly and the process exits: set `queueUrl` in that file to your own server (`postgres://localhost:5432/sma_daemon` is the default) and start it again.

**3 · Open the app once with the token:**

```
http://127.0.0.1:7777/?token=<the token in ~/.sma-daemon/config.json>
```

That single visit exchanges the token for an HttpOnly session cookie and every later visit is a plain address. Until it happens the daemon answers `unauthorized` and nothing else — there is no login page to guess at, deliberately. Read the token out of the config file; it is never printed to the log.

**Always-on wiring** — a launchd job on macOS, a Scheduled Task on Windows — is written up in the [supervisor/](supervisor/) checklists, together with the smoke run that proves the loop end to end before you leave it running overnight.

**Your day, not a dashboard.** *Today* opens on what the fleet did overnight and what is waiting on you; the board holds every task; the team screen shows each worker with its lane and its window; the live stream is the work as it happens; costs read straight from the spend book, per day, per lane and per account. The app is built for a desktop screen (1440 px and up) — the phone still waits for its own design pass, and every release so far has shipped without it rather than pretending otherwise.

**Every task card answers WHY.** The decision journal rides the same attempt ledger the receipts do, in three layers: the dispatcher's own reasons (why this lane, this worker, this window — structured codes from a closed vocabulary, never free text), the worker's mandatory approach note (what it chose, what it rejected, which rules and memories shaped it), and the memory trace — what the session actually did, not what its role file claimed: whether it opened the memory index, which notes it read, how many times it called the loader, which reflexes fired and from which source that is known, what it read out of the account's own notebook (counted apart from the project's corpus, because the two are not the same memory), what lesson it left behind and whether it left an approach note. That layer is written for **every** attempt, a failed one included. An attempt without its note is as incomplete as one without its receipt — and so is an attempt without a lesson.

**A conversation with tied hands.** The chat screen carries one caption and it is literal: *«Reads and suggests. Runs nothing itself.»* Factual questions — why a run failed, what is eating the window, where a task stands — are answered by deterministic read models with no model call at all: instant and free. Only open questions and task drafts reach a model, on a short lane outside the task queue, and a draft still passes the same readiness gate and the same approval door as any other task. The route table gains no execution surface for it.

**Bring the agents you already have.** The import door reads the estate already sitting in your repository — `.claude/agents`, `.claude/skills`, your rules file — and enrolls it through the same door the Creator uses: a draft, a lint receipt, an approval queue. The wizard shows what it found, what collides with a name already taken, and exactly what will be written. Imported definitions are third-party text, so nothing is ever enabled by the import itself; activation stays two explicit human steps.

**A first run without the terminal.** Once the daemon is up (see above) the app opens on a four-step interview — your project, your infrastructure, the estate it can see, and your first lessons. It writes exactly the artifacts `/sma-start` writes, through the same writer, so the two doors are provably one door. The terminal path stays for whoever prefers it, and it needs no daemon at all. **And it can wait.** «Позже» closes the interview having written nothing into your project; the answer is kept on the daemon's side, so the window stops asking and the door stays open for whenever you want it.

**Terminal parity, proven rather than asserted.** A worker session has to be able to do what your own terminal session does — and that claim is worth nothing while it is merely asserted, so parity here is a property of the ground the worker stands on and it is proven by artifacts. Every attempt leaves a small run directory in the connected project, `.sma/runs/<attemptId>/`, and one command reads it: `node tools/terminal-parity-check.mjs [--attempt <id>] [--project <dir>]` — with no identifier at all it takes the latest attempt. It prints five receipts, and each of them is written to say what it proves *and what it does not*. **Hooks** — a guard answered inside that run's own time window; that something was watching, not that it refused the right thing, and a hook that started and never replied is written down as a failure rather than rounded up. **Memory** — the corpus was actually read: the index came back or the loader was called; that the notes reached the session, not that the session used them. **Rules** — your project's instruction file reached the working copy; that the copy has it, not that anyone opened it. **Skills** — the copy carries your skills and agents, or an honest `n/a` naming the reason on a project that has neither, because «not applicable» and «passed» are different words on purpose. **Rights** — the tool list the spawn was actually given equals the list the capability envelope demanded; its best status is `warn` and never `ok`, because only `allowedTools` rides the command line to the process while the actions reserved for a human are enforced after the fact rather than before it, and a green light there would certify a guarantee this product does not yet give. Missing data is a failure that names the missing file — never a default pass, because the cheapest route to five out of five is to check nothing. The command exits 0 only at five out of five, and the last line of its output is the bare count, so it is scorable; `--json` prints the same verdict as an object. The daemon computes the same five with the same module and writes them onto the attempt, so the task card shows the score and the path without anybody running a command first. The directory is local evidence and **not for git**; the project keeps the newest 200 attempts and names in the log every one it sweeps. Receipt by receipt, with the boundary of each: [docs/DETAILS.md](docs/DETAILS.md#terminal-parity-receipt-by-receipt).

**The worker's copy carries your project's whole layer.** A worker never edits the tree you are working in: it gets its own copy on its own branch, cut from a known commit. That copy is not a bare checkout — it brings the layer your project deliberately keeps outside git (`.claude/`, `CLAUDE.md`, `.claude/settings.local.json` by default), so the rules, hooks and lessons the worker was taught are in the room with it. Name your own list in `.sma/worktree-include` — a small JSON `{"copy": […], "link": […]}` at the root of your main tree. Dependencies are **linked, not installed**: a junction on Windows, a directory symlink elsewhere, pointing at the `node_modules` you already have — no package manager runs in the copy, so a run starts in seconds rather than minutes. Secrets never travel: `.env*`, `*.pem`, `*.key` and `.secrets*` are refused even when the manifest names them, and every refusal is reported rather than silent. When you approve the work, the copy and its branch are removed for you. What was copied, what was linked, what was skipped, when the copy was removed and by whom is written onto the attempt and shown on the task card — so «this can be rolled back» is a record you can read, not a promise.

**The worker leaves a lesson with every task — or says why not.** The copy carries your lessons in; the flywheel only turns if something comes back out. So the last step of a run is a lesson: the worker writes one note into the memory corpus of its own copy through `sma memory write` — the same twelve-step pipeline your own terminal uses, never a file dropped past it — and closes with `LESSON_WRITTEN: <path>`. If there is genuinely nothing to teach it says `LESSON_NONE: <reason>` instead, in its own words; «no» without a reason is not an answer and is refused. Neither of the two, and the attempt is not complete: it fails as `no_lesson`, exactly the way an attempt without a receipt fails, and the card says so in words rather than in a code. The note is a **draft** until you accept it — the pipeline stages it, nothing enters the corpus behind your back — and it passes your approval together with the code. On «Одобрить» the drafts are applied into the project's corpus and the index is rebuilt. On a project that keeps `.claude/` under git the merge brings the note itself; on a project that keeps it outside git — this product's own corpus is one — the daemon carries the drafts out of the copy before the copy is removed, and if it cannot, the copy is not removed at all: a lesson that exists in one place only is not something to sweep. The approach note travels the same road: it becomes a draft of the project's memory instead of a line that dies in the journal. Parked work owes no lesson — a round cut short by a question to you never reached the step — and neither does the Creator's own lane, which drafts definitions rather than doing the work. What the pipeline refused is named with its reason on the card, because the fate of a lesson is something you read, not something you infer from a missing file.

**The worker's account mirrors your personal layer — with named limits.** A copy of your project is not the same thing as your own working profile, and until the account carries that too, «the same session you get» is a claim nobody can check. Before **every** spawn — not once at setup — the daemon writes your personal layer into the worker's own config directory: your global `CLAUDE.md`, your `hooks`, and the two permission lists that can only ever narrow what a session may do, `permissions.deny` and `permissions.ask`. What does **not** travel is named just as plainly. `allow` and `defaultMode` stay behind: `defaultMode: "auto"` in a user-scope settings file would put a headless worker session into auto mode and widen its rights past the envelope this product hands it, and an `allow` list would do the same one rule at a time — widening a worker's rights is a decision somebody makes on purpose, never a side effect of mirroring. Your own plugins stay behind too, because a plugin is installed into an account and the worker's account is not yours: name the ones it should carry in `workers[].plugins` in `config.json` and install them into that account yourself — the product never runs an install on your behalf. `model`, `env` and `statusLine` are left alone as well: the model and the environment of a run come from the worker profile the daemon already owns. Hosted claude.ai connectors are switched **off** for the worker by `disableClaudeAiConnectors: true` (Claude Code 2.1.182 or later), so no MCP server you never chose is attached to a session you are paying for; the tools a worker may reach are the ones from your own registry, handed over explicitly on `--mcp-config` and switched on by you on «Подключения». Auto-memory is kept per repository rather than per copy — every copy of one project shares one auto-memory directory, so a lesson written down in one attempt is there in the next. The account's previous settings file is backed up before it is overwritten. And all of it — the fingerprint of the instructions file that travelled, how many hooks, how many narrowing rules, which plugins, the connectors switch, the auto-memory path, and what the session actually loaded when it started — is written onto the attempt and shown on the task card, because a layer nobody can see is a layer nobody can notice is wrong.

### Several machines, several projects — one window

A project is a first-class dimension now, not a separate install: one daemon runs the tasks of all your repositories, each task carries its project, and the app filters by it. Existing tasks are adopted into a project on first start — nothing to migrate by hand. Connecting one is a form rather than a hand-made HTTP request: on «Машины и проекты» you name the project's folder, press «Подключить», and the daemon reads it from there. An entry with no folder behind it is labelled «не подключён» instead of being shown as though it were live.

Across machines, daemons federate. You nominate one daemon as the **hub** and introduce its peers from the app: the hub mints a single-use invitation, you carry it to the second machine, and from then on the hub aggregates state — presence per machine, costs and windows per machine, every project in one window. Actions are not re-played by the hub: an approval or a new task issued from the hub travels to the owning machine as the same already-authorised call, through every door it would have passed locally. A peer opened directly still shows its own machine, with a quiet banner when the hub is unreachable — there is no single point of failure.

The network between your machines is **yours, not ours**: a private mesh (WireGuard, Tailscale, or a self-hosted coordinator). **The daemon never asks to be exposed to the public internet**, and no vendor cloud appears anywhere in this design.

### What the machine needs — measured, not guessed

The core of SMA needs nothing: it is plain files next to your code. The **fleet** is what asks for a
machine, so here is what each part of it actually costs, measured on a reference Windows host
(12 logical processors, 13 GB) running this repository's own suite and real worker sessions:

| | Measured |
|---|---|
| The daemon itself | **22 MB** |
| PostgreSQL (the queue) | **~30 MB** idle |
| One worker session | **~310 MB** average, ~380 MB at its peak |
| One full parallel test run | **~1 GB** peak, and it takes *cores − 1* workers |

Those four numbers are the whole model. A machine running **W** windows at once, with **T** test
runs happening at the same time, wants roughly `W × 0.4 GB + T × 1 GB` of working set, plus your
operating system, plus as much again for the file cache — and the cache is not optional comfort: it
is what keeps `git` fast when every worker has its own worktree of a thousand-file checkout.

**Worked example — three projects, three windows each (nine sessions):** about 3.6 GB of sessions,
two suites running at once ≈ 2 GB, daemon and queue ≈ 0.5 GB. Call it **6 GB of working set**, and
then leave room for the OS and the cache:

- **RAM — 16 GB is the floor, 32 GB is where it stops being tight.** Prefer a machine whose memory
  you can add to later over one where it is soldered.
- **CPU — 8 cores / 16 threads minimum.** The heaviest thing this fleet ever does is your own test
  suite, run in parallel, several times a day; two suites at once will use every thread you have.
- **Disk — an NVMe SSD, 1 TB works and 2 TB is comfortable.** Size is not the interesting number:
  **write endurance is**. Provisioning and removing worktrees is a constant stream of small-file
  writes, so prefer a drive with DRAM cache and a TBW rating you can look up.
- **No GPU.** The model runs on the provider's side; nothing here is local inference. A machine sold
  on its graphics is money spent on a capability this fleet never uses.

Two honest caveats. These are measurements from **one** machine and **one** codebase — the variable
that moves them most is your own test suite, so measure yours before buying for it. And a session
that mostly waits on the network costs far less than one that is running your build; the 310 MB
average above is real work, not idling.

## Before SMA → After SMA

The whole point of SMA is the second column. Same agent, same model — a different discipline around it.

| | **Without SMA** | **With SMA** |
|---|---|---|
| **1 · A rule is dropped** | Your instructions say "every schema change needs a migration." Twenty edits later the agent adds a column and forgets. It ships; queries break on deploy. | The moment the agent touches the schema file, a reflex fires **into that tool call**: *"schema change → migration required (last time this broke prod)."* It cannot be skimmed past. |
| **2 · "Done" that isn't** | *"All tests pass, feature complete."* You pull, run them, three are red. The confident summary was the only evidence, and it was wrong. | The plan pre-registered a check. At close, a **script** re-runs it on a fresh clone and writes `hit` or `miss` to the ledger. "Done" is a re-runnable command, not a sentence — and a blind verifier re-derives it without ever reading the agent's report. |
| **3 · A lesson re-learned** | The same build flag bites you a third month running. Each fix lived only in one closed chat; nothing carried it forward. | The first burn was written as a note with a trigger. Every later session — and every teammate's clone — gets the warning **before** repeating it. One burn, permanent avoidance. |
| **4 · Two terminals collide** | Terminal B edits `src/api` while Terminal A is mid-refactor there. B's push silently reverts an hour of A's work; nobody notices until CI. | B registered a session and A had **claimed** `src/api`. When B goes to edit, it is warned *before* the keystroke — and both drew their migration numbers from one queue, so they never clash. |
| **5 · A false "done" ships** | The report said the feature works. It didn't; the regression reaches `main` and the next release carries it. | A class-A divergence — the heaviest signal in the system: a claimed pass that the blind verifier reproduced as a failure — **auto-blocks the release gate (`sma preship`)** until a human records an explicit disposition. The ledger is append-only; the agent cannot forgive itself. |

> **Honest caveat.** On a single task, SMA costs more — the checks and the memory are not free. Its bet is **cost per correct result across many tasks**, not the cheapest single run.

<!-- sma:positioning:start -->

## How SMA compares

A model vendor cannot neutrally grade its own agent's homework. With Claude Outcomes that sentence needs sharpening, not retiring: the vendor now *can* verify, because separate-context grading shipped as a platform feature. What it cannot do is be **audited**. An outcomes grade is an opaque rubric verdict: no re-runnable receipt, no published track record, no consequence when it is wrong. SMA's lane is the audit layer any grader — theirs or ours — has to survive, and that lane is exactly why SMA outlives platform absorption.

So the comparison is deliberately honest, including where each analog is better than SMA. Reach figures are GitHub stars as of July 2026 — check them before quoting:

| Tool | Reach | What it does better than SMA | What only SMA does |
|------|-------|------------------------------|--------------------|
| **Claude Outcomes** | platform | Managed sessions, a built-in outcome grader, zero setup | Deterministic re-runnable receipts, a judge-attributed calibrated hit rate, and a contradicted "satisfied" that blocks the release until a human rules |
| **claude-mem** | 86k★ | Category-leading memory mechanics, polished SQLite runtime | Scores whether the memory actually helped, and publishes the hit rate |
| **Aider** repo-map | 47k★ | Deterministic context graph with years of production proof | Carries a memory corpus and a learning loop on top of the graph |
| **Letta** / MemGPT | 24k★ | Rich memory-block architecture | No DB, no server, and the agent does not grade itself |
| **ccusage** | 16.5k★ | Excellent local spend observability | The spend signal drives enforcement, not just observation |
| **BMAD** | 50k★ | Rich orchestration templates | A verification layer, so a claim has to survive a script |

**What SMA deliberately does not do in the layer that matters:** the memory, coordination and accountability core runs with no daemon, no database, no embeddings, no cloud and no LLM in the hot path — everything is files and git (see `node scripts/sma/cli.mjs explain substrate`). Correctness never depends on a model call, or on anything staying up. The V5 worker fleet and its app are a **separate, optional layer** on top: that one does run a local daemon and keep its queue in a local PostgreSQL, both on your own machines, and switching it off leaves everything above untouched.

**The grader itself is graded.** Every separate-context verdict — the blind verifier's, or an outcomes grader's if ever consumed — is recorded, scored against ground truth (a revert, a rework, red CI, a founder rejection), and a wrong "satisfied" cannot be audited away: it blocks the release until a human dispositions it. That is the audit an opaque grade cannot offer.

**The evidence passport reads two ways.** `sma manifest` assembles one deterministic passport per pull request — the predictions and their verdicts, the receipts and their hashes, the blind-verify counts, the spend window, the per-area hit rate — and renders it for whoever is reading: `--md` for the reviewer's PR comment, `--json` for a tool, and `--dense` for an agent, which prints the whole passport as one fixed line per section. Nothing is recomputed for any of them: all three renders read the same built object, so the compact view can never disagree with the one a human signed off, and an empty section is marked rather than dropped.

Economy is held to the same evidence bar. Lane budgets are derived from the project's *own* spend percentiles, never a vendor benchmark; any plan can publish a **footprint receipt** — git-diff arithmetic against a written claim, an overrun scored as a calibration miss; and the ship lanes gate a push on a full test-and-security run a quick lane can never weaken. Every saving is paired with a quality guard, and a number is published only once it has been scored (see `node scripts/sma/cli.mjs explain economy`). The spend book prices tokens from a versioned, local pricing table — never fetched over the network — updated 2026-07-21 to the current Claude rates: the newest model family added, and a stale Opus rate corrected after it had overstated the real price roughly threefold.

Adoption is reported honestly, not asserted: the real hit rate and sample size live in the calibration badge and `PASSPORT.md`, rebuilt from the ledger with `sma passport --build` and reproducible on a fresh clone. The badge hides itself after a model change until enough new data exists, so it never quietly overstates. One rebuild reaches **every** README this repository carries — the English one and the Russian one are written by the same operation from the same snapshot, so the two locales cannot drift apart because somebody edited one by hand; a README that is absent is named in the output rather than created. It also says out loud what it is able to count: only what this repository can reproduce. Predictions made in a private planning workspace are never copied in — each such record names the internal planning file it was written in — so a small sample size on this page means few reproducible verdicts of our own, never a larger number kept out of sight.

Three trust-spine features (the git airbag, the spend ledger, and the pre-compaction capsule) are bridges the wider ecosystem may well absorb, and that is fine; they are not the headline, the accountability layer is. Two vendor-absorbable candidates stay explicit WATCH tripwires rather than headlines — a cross-session, on-by-default agent-teams primitive, and the advisor tool exposed inside sessions — each carrying a self-removal condition that retires our bridge the day the platform ships it.

<!-- sma:positioning:end -->

## What makes it different

- **Accountable, not just helpful.** Every claim SMA makes about itself is a pre-registered prediction settled by a script and re-derived by a blind verifier — and only once its stated horizon has actually arrived: a claim due at a later version or a future date stays registered and unscored rather than collecting a verdict about a future nobody can observe. A receipt's digest is derived from the exact check command, its exit code and its normalized output, so two different checks can never share a hash. What may be a check command is one anchored allowlist — SMA's own verbs, a test run, and your project's `test`, `pack` and `run <script>`, so a release gate hashes the build and the suite instead of recording bare exit codes — and never anything that fetches code from a registry. A command that cannot be expressed there is admitted only with `--unsafe-ack`, which stamps the waiver onto the receipt where it stays readable, and does not make it re-verifiable. What the check *measures* is a field of the record rather than a suffix on the command: a prediction may declare that the fact is the command's **exit code** instead of the numeric last line of its output, and it may declare the **working directory** the command runs in. Both are handed to the runner as parameters, so the allowlist did not widen by a single character — `cd X && cmd` and `cmd; echo $?` are refused exactly as before; what widened is the vocabulary a claim can be measured in, which is why «the suite is green» is finally a claim that can turn out to be wrong. Memory frameworks promise recall; SMA publishes its hit rate and lets a false "done" block its own release.
- **The layer a vendor cannot ship.** A model vendor cannot impartially grade its own agent's homework. SMA grades it from outside — deterministically, with no LLM in the hot path — which is exactly why it survives platform absorption.
- **Deterministic first.** Retrieval is tag- and trigger-driven, enforcement is plain scripts, and the whole learning-and-verification loop runs without a single LLM call in the hot path. Optional intelligence can sit on top; correctness never depends on it.
- **Git-native and reversible.** Notes, ledgers, journals, receipts — all files in your repo. Self-improvement arrives as diffs you review; anything the system learns can be reverted with `git revert`.
- **Fail-open by design.** A warning never blocks your work; a dead hook never wedges a session; every stream has a kill-switch. Hard blocking is reserved for security gates you configure yourself and for the consequences law you opt into.
- **Yours.** The corpus lives in your repository, travels with `git clone`, and is portable to other agents — it is knowledge you own, not a vendor cache.

## Memory, in three layers

Not one big instruction file — three tiers that keep the always-loaded budget tiny while nothing is lost by accident. (Losing something *on purpose* is a command of its own — see below.)

```mermaid
flowchart TD
    subgraph Always["Loaded every session"]
        C["CORE — a few KB<br>the rules that always apply"]
    end
    subgraph OnDemand["Loaded when the task touches it"]
        I["AREA INDEXES<br>topic notes, pulled by tag"]
    end
    subgraph AtTheAct["Delivered at the tool call"]
        X["REFLEXES<br>one lesson, right before the matching action"]
    end
    C --> I --> X
```

Each note carries a `use-when` trigger — that single line is what lets SMA deliver it at exactly the right tool call instead of dumping the whole corpus into every prompt. Auto-trim never deletes — it *demotes* down the layers (in this repo's own dogfood, the always-loaded index went from 46 KB to 5 KB with full recall preserved). *Auto-trim only changes how loudly the system remembers; real forgetting is a separate deliberate command, never a side effect.*

Delivery is filtered before anything is ranked: a note that was retired, has passed its own valid-until date, or sits above the class the asking consumer may see is left out of the pack — and stays in its area index, marked, so it is still findable. Nothing is rewritten to make that happen.

**Then it is ranked by three layers at once, not one.** `sma load` and `sma context` fuse the tag order with an exact path/symbol match and a lexical one, so a note reaches you on a **word it never carried as a tag** — which is the whole reason to hold a lexical index. The layer got there by measurement, not by preference: scored against the tag-only path on this project's own gold cases (2026-08-19), recall@3 rose 34 points and MRR 26, at 8 % more tokens in the pack. The same record carries the cost honestly — on one case the layer answers where the tag-only path was right to stay silent, and that regression is written down rather than tuned away on the very set that measures it. The index behind the layer keeps itself: the corpus rebuild refreshes it, and delivery repairs a stale one in place. Where the layer cannot run — an older Node, or a build without full text — the periphery is the tag one and the reason is printed, never silently.

**Three paths deliberately do not get it:** the reflex fired mid-edit, the pre-act injection and the pack handed to a subagent. Each is budgeted or interrupts somebody at work, and widening them is a decision of its own rather than a consequence of this one.

**You can make it forget.** `node scripts/sma/cli.mjs memory forget <id>` retires one note: it stops being delivered, stays in its area index marked as retired, and remains readable as history. Add `--erase` and the record is physically removed instead — from the corpus, from the drafts area, from the this-machine-only store, and from every index derived from it, each surface named in the report and then read back to confirm it is actually gone. It asks once, and it does not ask twice. **It can also decline.** If an episode in the archive happens to share the record's id, the erase stops before touching a single surface, names that file, removes nothing — and hands the decision back to you: history is a different asset class from truth, and a delete command does not get to rule on it on your behalf.

**The honest limit, stated in the same breath: git already has it.** If the note was ever committed, erasing the file today does not remove it from your repository's history — an old commit still carries the text. Erase tells you so, and what to do about it (rewriting history, or rotating whatever leaked) is a decision for you, not something a memory command should do behind your back. [docs/MEMORY-LIFECYCLE.md](docs/MEMORY-LIFECYCLE.md) walks through both.

**Material that must not leave this machine has its own class.** A note marked as restricted is refused entry to any git-backed path before a single byte is written — in both write doors, failing closed — and is filed instead under `.sma/local-memory`, which keeps itself out of git by its own ignore marker. To be exact about what that does and does not buy you: this is enforced **placement**, not encryption. The bytes on disk are plain text, deliberately and on the record — see [docs/MEMORY-THREAT-MODEL.md](docs/MEMORY-THREAT-MODEL.md).

**A note that talks to the assistant is not delivered at all.** Retrieved text is data, never an instruction: a note whose body carries something aimed at the agent — "ignore your previous instructions", and the same trick in Russian — is refused at read time, and so is a note that plainly belongs to a different repository than the one being asked about. Neither is quietly down-ranked; each is withheld with the reason named, and `sma memory explain --task "…"` prints that reason.

How loudly a note speaks is what it says about itself: a note states what *missing* it would cost, and that grade — not a guess — decides whether it interrupts you with a full warning, a single line, or nothing at all.

## The pillars

- **Predictions** — every plan states, up front, what will measurably change and how to check it; a deterministic scorer compares promise to fact at plan close. Scoring at close stopped being a wish: a closed plan that leaves a checkable, already-due prediction without a verdict is a critical lint finding, so a promise cannot quietly outlive the plan that made it. A prediction whose check the command boundary refuses is a defect of the prediction, not a debt — it is named in words at close and blocks nothing, because a gate that jams on one badly written sentence is a gate somebody removes.
- **Receipts + blind verification** — every "done" carries a re-runnable check; a blind verifier re-derives it from the tree alone, refusing the agent's self-report as input. The re-run measures the tree it was pointed at, and only a divergence that is **new** is red — a failure that was already there is named as pre-existing rather than charged to whoever ran last.
- **QA that uses the product instead of reading it** — `sma-ui-qa` runs after the verifier and before a phase reaches you. The verifier asks whether the *repository* shows the goal was met; this asks whether the *product does it when someone uses it*. It turns the phase's own success criteria into cases it runs in a real browser, sweeps the surface pressing every visible control once, and leaves the data-destroying ones for a human, named in the receipt. A criterion it could not test is BLOCKED, never passed — and **a run that did not happen is never a pass**: with no browser driver it exits 3 and says `NOT RUN`, instead of an empty finding list that reads as clean. The driver is resolved at run time and never installed on your behalf: SMA's own runtime dependency count stays zero. Only measured defects send work back to a builder; whether a screen *reads* well is advice for a person, because a beauty score with a decimal point is a random number.
- **Consequences** — a class-A miss does not just get logged, it *acts*: it blocks the next ship until a human dispositions it, from an append-only ledger the agent cannot edit.
- **Reflexes** — a scored miss becomes a permanent rule that fires *before* the next matching tool call. Touch boiling water once, never again. The chain now has a second source of fuel besides a settled prediction: when a receipt is re-run and the tree disagrees with what was recorded, that divergence drafts a lesson by itself. It stays a **draft** — nothing enters the corpus without you, and the draft carries its own three-condition review gate in its header, the first condition being «make sure the miss is not an artefact of a broken check». Only a **new** divergence drafts: a pair that already has its draft is counted, not filed again, or the first sweep of a long ledger would bury the drafts folder instead of teaching anything.
- **A weekly reading of the misses** — the miss-curriculum clusters settled misses into prediction templates and a weak-spots brief, and it now **builds itself** at session start the moment the standing brief is over a week old, instead of nagging you to run it. It names the state directory it read from, because the same verb run from a working copy used to resolve a different checkout's journal and report an empty week that was not empty.
- **Corpus health** — lint, contradiction detection, and consolidation keep the memory sharp at hundreds of notes instead of decaying into noise. The contradiction detector reads every kind of note that *states a rule* — a decision, a status, a norm, a procedure — and reads a Russian corpus as well as an English one, so a clean result means «nothing was found» rather than «nothing was examined». It calls two notes contradictory only where one denies the other *about the same subject, in the same clause* — a marker sitting in some unrelated aside of a long rule is not a disagreement — so a red result is worth acting on. Diagnostics are loud: a failing memory command prints what broke and why, and a corpus without its tag registry still builds a usable index instead of erroring.
- **Coordination** — session registry, file claims with pre-edit warnings, and shared counters for anything two terminals could race on. The session count is honest: a lease whose terminal is gone is reported as stale, never as a working window.
- **Scaffolding** — a per-plan progress journal turns a dead executor into a five-minute resumption; a stall detector, dependency-aware waves and the one-spawn `pre` multiplexer keep long runs honest, parallel and cheap.
- **A fleet with its rules written down — and now consulted** — the optional worker fleet has a formal layer: a named state machine that says which task state may follow which and on whose authority, an envelope that declares up front what one worker may touch, and a stamp on every attempt recording the world it ran in. Seeded property tests attack all of it, and crash, restart, dead-letter and redelivery drills try to lose a task and cannot. Since 2026-08-05 the layer no longer stands beside the code as a declaration: the live queue path routes its status changes through the state machine, a spawn is refused when the lane's envelope grants it no execution surface, production attempt rows carry the idempotency key, the state-machine version, the envelope digest and the digest of the memory corpus the worker stood in — and a per-tick reconciliation closes the crash hole, so an attempt that ended while the daemon was down gets its ledger row, flagged as reconstructed rather than observed. One drill has now been run against a real PostgreSQL: the daemon hard-killed with a task in flight, the census taken from the database afterwards, no task lost. **Stated plainly so nobody reads more into it than shipped:** three of the seven stamp fields — the policy version, the harness version and a plan hash — stay *absent*, because nothing in the product can compute them and an invented value is worse than an admitted gap; and the envelope bounds what the *daemon* does on a worker's behalf, not what that worker may reach once its session is running, which is still the checkout's own settings. The seven invariants, and what is deliberately not a goal, are in [docs/FLEET-INVARIANTS.md](docs/FLEET-INVARIANTS.md).
- **Economy** — lane budgets derived from your own spend history, a self-cost meter, and quality guards on every savings number.

## It lives beside your code, never inside it

SMA never edits, moves, or reformats a single line of your application. It writes only to a handful of sibling folders — all plain text, all under version control, all yours.

```text
your-project/
├─ src/            ← YOUR CODE — SMA never writes here
├─ package.json    ← untouched
│
├─ .claude/
│  ├─ memory/      ← the memory corpus (markdown notes you can read & diff);
│  │                 installed EMPTY — you get the system, the notes stay yours
│  ├─ agents/      ← the /sma-* workflow agents
│  └─ settings.json← the hooks that wire SMA into your agent
├─ .sma/           ← coordination + accountability state
└─ .planning/      ← phase plans, predictions, receipts, calibration
```

Delete the folders and your project is exactly as it was.

## Which model runs which agent

By default a model *profile* answers one question — how heavy is this kind of work — and every agent follows it. When you need a single agent on a specific model, pin that agent instead of switching the whole profile:

```bash
node .claude/sma-core/bin/sma-tools.cjs query config-set model_profile_overrides.agents.sma-executor opus
```

The pin wins over the profile for that agent only; every other agent stays where it was, and it holds against automatic tier escalation. A name SMA does not recognise is ignored — a typo changes nothing rather than failing a run. To lift a pin, set it to `null`: the key is removed and the agent goes back to the profile.

```bash
node .claude/sma-core/bin/sma-tools.cjs query config-set model_profile_overrides.agents.sma-executor null
```

`null` is how you clear *any* setting — the key is deleted rather than set to the word "null". Full resolution order and the per-runtime tier map: [scripts/sma/README.md](scripts/sma/README.md).

**The whole team ships, and the window shows it.** Every SMA agent that comes with the product is visible on the app's team screen alongside any you wrote yourself — each one marked as stock, yours, or a stock definition you have edited — and one control switches the pipeline on for all of them at once. The control says which of the three states it is in — the team is on, on but not for everyone, or off — states what pressing it will do, and reports back whether the switch actually took, instead of flipping and leaving you to guess. Nothing is enabled by installing; turning the team on is a deliberate act, and turning it off again is the same control.

**A connected project is watched live.** Point the window at one of your repositories and its files are followed as they change: edit a note and the screen updates within a second, without a reload. If the watcher cannot run, the screen says so — «live connection unavailable, updating on a schedule» — instead of showing stale data as if it were fresh. Switch to another project and the watcher follows it, with no daemon restart. What the window shows of that project's memory is **read-only**: it reads your corpus, it never writes into it — and it reads it in the format the corpus is actually written in, so a note's claim is its title and what it applies to becomes its tags. The migration preview is bounded rather than open-ended: a corpus over 200 notes reports its size instead of building a preview of that scale, and a staged preview nobody accepted is pruned after fourteen days.

## Commands

The `/sma-*` workflow family (run inside a Claude Code session):

| Command | What it does |
|---|---|
| `/sma-start` | First-run onboarding: explains the system, seeds the memory corpus and the infra profile |
| `/sma-discuss-phase` | Gather phase context through adaptive questioning before planning |
| `/sma-plan-phase` | Create a detailed phase plan with a verification loop |
| `/sma-execute-phase` | Execute all plans in a phase with wave-based parallelization |
| `/sma-verify-work` | Validate built features through conversational UAT |
| `/sma-quick` | A quick task with SMA guarantees (atomic commits, state tracking), skipping optional agents |
| `/sma-fast` | A trivial task inline — no subagents, no planning overhead |
| `/sma-debug` | Systematic debugging with persistent state across context resets |
| `/sma-progress` | Where things stand: progress, next step, freeform intent dispatch |
| `/sma-resume-work` | Resume from a previous session with full context restoration |
| `/sma-pause-work` | Create a context handoff when pausing mid-phase |
| `/sma-help` | Show available commands and the usage guide |
| `/sma-deleteme` | Remove SMA in one action; your memory corpus stays |
| `/sma-update` | Check installed vs available versions and update via the standard installer; everything local stays |

Underneath runs the coordination + accountability CLI — 91 verbs, each with an in-product explainer. Call it from your project root, the way the hooks do:

```bash
node scripts/sma/cli.mjs status            # who is working on what, right now
node scripts/sma/cli.mjs explain <verb>    # what any verb is for, in plain language
node scripts/sma/cli.mjs grill --gate      # cross-examine every plan promise before the build
```

The full reference lives in [scripts/sma/README.md](scripts/sma/README.md). A few are worth naming here:

| Command | What it does |
|---|---|
| `sma baseline capture` | Measure what the layer costs you today — retrieval recall, context cost, hook latency, worker recovery, a clean install — and with `--record`, store each number as a re-runnable receipt |
| `sma baseline replay` | Re-run those recorded receipts later, so «it got better» is a diff and not a memory |
| `sma eval memory` | Score the memory layer against your gold cases — recall@k, precision@k, MRR, nDCG, critical-memory misses, retired records delivered anyway, contradictions handed over in one pack. Deterministic floors turn it into a verdict: a violated floor exits non-zero, and no model is asked its opinion. A gold set with **no cases** renders no verdict at all — it prints «no data», exits non-zero and reports `floor_verdict: "no-data"`, because a gate that goes green on an absence of data is decoration, not a gate |
| `sma eval memory --experiment <name>` | The A/B a retrieval layer has to face before anybody gets it by default: your gold set scored TWICE — once by the **facet path, named explicitly**, once by the named arm — differing by one option and nothing else, so the difference belongs to the layer. The control is that path by name and not «whatever ships today», and the reason is on the record: the day the shipped path became hybrid, a control that inherited it would have been comparing the layer with itself. Both arms are printed beside the deltas, in percentage points, with the token cost next to the score, because a retrieval number improves trivially by delivering more. It names **no** winner: the rule that decides whether a layer enters the default path is applied by a person and written down — which is exactly how the lexical layer entered it |
| `sma eval north-star` | Price one VERIFIED CORRECT result — tokens, compute, wall-clock and the minutes a human spent — divided by the results the benchmark judged correct, with every recorded receipt beside it in one guardrail panel. The term nothing measures yet (human minutes) reports `null` and names where its future measurement will come from; a flattering 0 is never substituted, because a 0 there would read as «humans spend no time on this» |
| `sma eval gate --file <decl.json>` | Check a new feature's admission declaration before the work starts: failure class, recorded baseline, falsifiable prediction, acceptance, rollback. A prediction whose threshold is not a number is refused by name — «it will be noticeably better» is a wish, and a wish cannot turn out to be wrong. The five elements and the format: [docs/FEATURE-GATE.md](docs/FEATURE-GATE.md) |
| `sma memory explain --task "…"` | Ask why the pack looks like this. Every note in the corpus gets exactly one verdict: delivered — on what grounds (the always-load rule it states about itself, its weight, which tag met your task) — or withheld, naming the filter and the field that decided, the missing tag overlap, or the budget cut and its position. It reports the real selection, instrumented, so a retrieval change can be argued about decision by decision |
| `sma memory migrate` | Propose a richer schema for every note as a reviewable draft — preview-only: it never rewrites a note, and each proposal is applied by hand with `--apply <draft> --confirm <note> --yes` |
| `sma memory write` | Put one candidate memory through the twelve-step write pipeline and read every verdict: what was scrubbed before anything could be stored, what it contradicts, whether it may be believed at all — and where it landed: the corpus, a draft for review, or nowhere. There is one door, and the product now points at it: the managed rules block SMA writes into your `CLAUDE.md` sends the agent **through** this pipeline instead of teaching it to drop a flat file into the corpus by hand, which is what it used to say. Walking the pipeline leaves a journal event, so a lint (`MEM-OFFPIPELINE`) can name every note that is in the corpus with no such event behind it. Notes older than the rule are flagged as a warning rather than an error and stay visible instead of being swept: an existing corpus is expected to carry history, and a run with zero findings is not what you should expect on day one |
| `sma memory index rebuild\|status` | **Measured, and in.** Build the derived lexical index — an exact path/symbol match plus SQLite BM25 — under `.sma/`, and ask whether it still describes the corpus. The layer takes part in the delivery of `load` and `context` by default, and what put it there is a comparison recorded on your kind of evidence rather than an opinion: on this project's own gold set, 2026-08-19, recall@3 rose 34 points and MRR 26, at 8 % more tokens in the pack. The same record names the cost in the other direction — on one case the layer speaks where the facet path was right to stay silent — because a layer admitted on numbers is admitted with its numbers, all of them. You rarely type these two commands: `sma build-index --write` rebuilds this index together with the corpus, and delivery repairs a stale one in place. It needs Node ≥ 22.5 for the `node:sqlite` module: below that the layer is honestly `unavailable` and exits 0, and delivery stays on the deterministic facet and exact layers and says so. The official Node build compiles SQLite **without** full text, so the engine is chosen by a probe and not by a version number — where the extension is missing, a plain-table BM25 answers the same question. The index is derived: delete the file and a single rebuild restores it whole, which is the only way an index stays an index instead of quietly becoming a second source of truth |
| `sma history search <word…>` | Ask whether you have been here before — in one run over the four books this project already keeps: the coordination journal, the plan execution records, the bodies of your lessons, and your session transcripts. Every hit names its source, its file and its moment. It matches on **words, not substrings**, and Cyrillic reads on equal terms with Latin. `--limit` caps each book separately, because one shared ceiling would go to the transcripts — they are three orders of magnitude larger than the rest — and the answer would be transcripts only; they are read as a stream and stop being opened as soon as the limit is met, so there is no second index to keep fresh. Every fragment passes the same key-shaped and high-entropy check the product runs over a profile, and a match is replaced whole — with the limit stated in the same breath: short secrets and word-passwords have no shape to recognise, so the output is still something you read before you paste it. Where the line with retrieval runs: delivery ranks a lesson by its **axis** — its claim, its triggers, its tags — so a word living only in the prose of a note is invisible there and findable here, deliberately. A missing transcript directory is an empty book, not an error |

---

## Going deeper

Everything above is the core. The detail lives one link away:

- **[docs/DETAILS.md](docs/DETAILS.md)** — the full engineering deep-dive: the four-setup side-by-side, the accountable loop diagrams, the complete CLI reference by version layer, the animated demo gallery, how the hooks integrate, and the whole version history — V1 through [the V5 series, release by release](docs/DETAILS.md#the-v5-series-release-by-release) — with the trust spine process by process.
- **[ROADMAP.md](ROADMAP.md)** — where SMA goes next, and what each version of the V5 line actually shipped, with its honest carries named. Русская копия: [ROADMAP.ru.md](ROADMAP.ru.md).
- **[docs/MEMORY-MODEL.md](docs/MEMORY-MODEL.md)** — the schema law of the memory layer: what one record may claim and must carry, the closed vocabularies, provenance and its fingerprint, the temporal model, the storage classes, the one-claim law, and the corpus checks that hold all of it up.
- **[docs/MEMORY-LIFECYCLE.md](docs/MEMORY-LIFECYCLE.md)** — how a memory is written, approved and retired: the twelve-step write pipeline with every refusal it can make, the risk-approval ladder, drafts, the four lifecycle transitions, and the preview-only migration ritual.
- **[docs/MEMORY-THREAT-MODEL.md](docs/MEMORY-THREAT-MODEL.md)** — the security posture: which storage class may hold what, what fails open and what fails closed, how retrieved text stays data instead of becoming an instruction, and the encryption policy — decided on 2026-08-04: no cipher in this version, the restricted class is enforced as placement and its bytes are plain text on disk.
- **[docs/FLEET-INVARIANTS.md](docs/FLEET-INVARIANTS.md)** — the fleet's seven invariants written as law: the named state machine and its transition contracts, the capability envelope, the attempt stamp, how the property tests and the drills attack each one — and §5, which says plainly what is *not* a goal, and where every remaining edge sits now that the daemon does route through the layer: the three stamp fields nothing in the product can compute, the transitions exempt by name, and the reach the envelope does not bound.
- **[docs/FEATURE-GATE.md](docs/FEATURE-GATE.md)** — the five elements a new feature must declare before it reaches the default path: the failure class it addresses, the recorded baseline it will be compared against, a falsifiable prediction with a numeric threshold and the command that produces the number, what acceptance means, and how it rolls back. Checked by `sma eval gate`.
- **[docs/INSTALL.md](docs/INSTALL.md)** — install flags, payload manifest, uninstall.
- **[docs/recipes/browser-check-command.md](docs/recipes/browser-check-command.md)** — how a user-interface check becomes a re-runnable receipt: a headless "command + exit code" script, the browser library in *your* devDependencies (SMA's core stays browser-free), and why pixel diffs are banned as evidence.
- **[sma-core/references/fanout-ladder.md](sma-core/references/fanout-ladder.md)** — swarm or solo: the four deterministic signals (divisibility into non-overlapping file scopes, risk class, size, budget remaining) that decide fan-out, plus what the shipped commands already do.
- **[scripts/sma/README.md](scripts/sma/README.md)** — every CLI subcommand, flag, hook event, and kill-switch.
- **[PASSPORT.md](PASSPORT.md)** — the calibration passport: the real hit rate and sample size, reproducible on a fresh clone.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=sma-framework/sma&type=Date)](https://star-history.com/#sma-framework/sma&Date)

## License and attribution

**SMA Source-Available License v1.0** — see [LICENSE](LICENSE). In plain words: the source is open to read, install locally, modify, and use for yourself, inside your own team, and in noncommercial education and research — free of charge. Any monetization of SMA — selling it, offering it (or a product built on it) for a fee or as a hosted service, or charging for services where SMA is part of what the customer pays for — requires a written commercial agreement with the author: **matvey.maslov99@gmail.com**. The default commercial terms are 30% of the gross revenue of the offering that uses SMA; write first, always. Commercial use without an agreement does not escape these terms: by that use alone you accept the license automatically — no notice in either direction is required — and the author may sue at any time, without prior warning or an offer to cure, for no less than 30% of the gross revenue involved, plus interest and enforcement costs (LICENSE §4; German law, venue at the author's seat). Earlier versions keep the licenses they shipped with: v4.0.2 and earlier (including those npm releases) remain MIT, and v5.0.0–v5.0.4 remain FSL-1.1-MIT with that license's scheduled conversion of each version to MIT two years after its release.

**Author: Matvey Maslov.** Questions, feedback, adoption stories: [matvey.maslov99@gmail.com](mailto:matvey.maslov99@gmail.com) — or open an [issue](https://github.com/sma-framework/sma/issues).

The workflow engine inside SMA is derived from [gsd-core](https://github.com/open-gsd/gsd-core) (MIT). Third-party notices and the engine's provenance are tracked in [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).
