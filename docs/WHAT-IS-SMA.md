# What SMA is — the deep description

*This is the long answer. The short one is the [README](../README.md). Русская версия: [WHAT-IS-SMA.ru.md](WHAT-IS-SMA.ru.md).*

---

## The problem, stated without marketing

An AI coding agent is a brilliant colleague with three chronic conditions.

**It forgets.** Every session starts from zero. The build flag that burned you in March burns you again in April, because the fix lived in a closed chat. Instructions files help until they grow into a wall of text the model skims — and the one rule that mattered is the one it skimmed past.

**It overstates.** "All tests pass, feature complete" is a sentence a model can generate whether or not the tests pass. The confident summary is often the *only* evidence — and when it is wrong, nobody finds out until deploy. This is not malice; it is what happens when the author of the claim is also its only judge.

**It does not scale into a team.** Open two terminals on one repository and they overwrite each other. Put an agent fleet to work overnight and you inherit a harder question: who checked the work, in what environment did it run, what exactly did it change, and how do you roll it back when the answer was wrong?

Every tool in this space attacks one of the three. SMA's position is that they are one problem: **an agent you cannot hold accountable is an agent whose memory and whose fleet you cannot trust either.** So SMA builds all three layers on one spine — and makes the spine verifiable by you, not by the agent's own word.

## The answer, in one architecture

SMA is a local-first control plane that lives **beside** your code — plain files and git, no server, no database, no cloud, no LLM call in any hot path. It has three load-bearing layers and one optional one:

1. **Memory that arrives on time.** Not one big file the model skims — three tiers. A few kilobytes of always-true rules load every session; topic notes load when the task touches their tags; and single-lesson *reflexes* fire into the exact tool call they protect. A note about schema migrations does not sit in the prompt all day — it interrupts the agent at the moment it touches the schema file.

2. **Coordination without a server.** Sessions register, scopes are claimed, collisions warn *before* the keystroke, and anything two terminals could race on — a migration number, a release version — comes from one shared counter. All of it is files in `.sma/`, readable and diffable.

3. **The trust spine.** Every plan pre-registers what will measurably change and how to check it. Every "done" carries a re-runnable check whose exit code — not whose prose — settles it. A *blind* verifier re-derives the verdict from the tree alone, refusing the agent's self-report as input. A false "done" is not a log line: it blocks the next release until a human rules on it, from an append-only ledger the agent cannot edit.

4. **The fleet (optional).** A daemon on your machine runs worker sessions around the clock: durable queue, one attempt ledger, budget stops, and a window — served by the daemon itself — where you put work in, watch it live, steer it mid-run, and accept or return the result. Switch it off and layers 1–3 lose nothing.

The phase cycle ties the layers into a working discipline: **discuss → plan → design → execute → verify.** Discussion pins the goal. The plan pre-registers its checks. The design stage — new in v5.7.0 — draws the thing and writes a short contract beside the drawing, and **execution physically does not start until a person confirms that contract**. Execution commits atomically with receipts. Verification re-runs what the plan promised, and a live-QA pass presses the actual buttons.

## The design stage, properly

Between "the plan is written" and "the code is being written" there was a gap every team knows: the agent builds the wrong shape of the right thing, and you find out after paying for the build. The design stage closes that gap with four properties, each of them a mechanism rather than a convention:

- **An artifact, not a vibe.** The stage produces a design contract in the phase folder — what stands where, what the person does, what must not be there — plus a self-contained HTML sketch when the work has screens. Both stay in the folder for good, versioned like everything else.
- **A gate with no key under the mat.** The dispatcher refuses to start execution of a phase whose design is not confirmed. There is no flag and no configuration entry that disables the gate; a new version of the contract closes execution again until a fresh confirmation. Fail-closed, tested from the refusal side.
- **Grandfathering by evidence, not by date.** A phase that predates the stage shows «skipped» — decided by a checkable trace of prior execution, never by a timestamp. Old projects do not suddenly acquire a gate they never agreed to.
- **A road back.** If drawing the thing exposes a hole in the plan, the phase returns to planning with the reason carried as data — not a comment somebody may read — and the plan is corrected in its own stage.

Two roles come with the stage. A **designer** persona distilled from real design resources — rules, palettes, reference judgments — that drafts the contract. An **animator** persona that owns motion, under a stated law (nothing over 300 ms, nothing frequent animated at all). Both are drafts-and-gates citizens like every other agent here: they propose, a person confirms, and the confirmation is what opens the build.

## The philosophy that everything obeys

These are not values on a poster; each one names a mechanism you can trigger.

**Receipts over prose.** A claim of "done" carries the command that proves it, and the command is re-runnable by you. The receipt's digest is derived from the exact check command, its exit code and its normalized output — two different checks cannot share a hash.

**Numbers are measured or absent — never invented.** Where the engine cannot answer, the screen says «no data» in words. A zero that is wrong is worse than a blank, because it reads as an answer. This rule is enforced right down to this documentation: the counts of commands, CLI verbs, daemon routes and tests quoted in these pages are checked against the code by `npm test`, and a document that disagrees turns the suite red. Run `node scripts/sma/cli.mjs doc-audit --target numbers` yourself.

**Computed is not connected.** The costliest failure class this project ever paid for: nine subsystems, each written, tested, green — and attached to nothing. The permission envelope was computed, hashed, journaled, and never handed to the spawned process. The law that came out of it governs all planning now: every computed artifact must be proven to *reach* its consumer by a test that asserts the wire, and an end-to-end run covers the route, not the pieces.

**Fail-open where it advises, fail-closed where it protects.** A warning never blocks your work; a dead hook never wedges a session; every advisory stream has a named kill-switch. Hard blocking is reserved for the boundaries you would want hard: push rights, secrets, budget stops, the design gate, the release gate.

**Human-only is human-only.** Push, merge, tag, deploy, release, the design confirmation, the disposition of a contradicted "done" — no score, no automation level, no orchestrator ever takes these. The refusal travels in the launch arguments of the worker's own process, where a prompt cannot argue with it.

**Honest limits, said in the same breath.** Where a lock has a boundary, the boundary is printed beside the lock. The parity check says what each receipt proves *and what it does not*. The memory eraser tells you git history still holds what you committed. A run that did not happen is reported as «NOT RUN» — never as an empty list of findings that reads as clean.

## Memory, deeper than the diagram

A note in SMA is not a paragraph — it is a **claim** with a schema: memory type (working / semantic / episodic / procedural / prospective / normative / preference), truth mode (observed / inferred / decision / hypothesis / normative), source authority, scope, temporal validity, sensitivity, retention, and a `use-when` trigger that makes just-in-time delivery possible at all.

Writing goes through **one twelve-step pipeline** — secret scrub first, contradiction check, trust classification — and lands as a draft until a person accepts it. Reading is filtered before it is ranked (retired, expired and above-clearance notes stay out of the pack, marked, findable), then ranked by three layers at once: deterministic facets, exact path/symbol match, and lexical BM25 — a layer admitted to the default path only after a measured lift on this project's own gold set (recall@3 +34 points, MRR +26, at 8 % more tokens — the regression it also caused is on the same record). Retrieved text is **data, never instruction**: a note that talks to the assistant is refused at read time, with the reason named.

The corpus is governed like code: lint, contradiction detection, consolidation, an explain command that names why every note was delivered or withheld, a benchmark reproducible on a fresh clone, and a deliberate lifecycle — supersede, revoke, expire, archive, and physical erase that names every surface it cleaned and declines when history shares the id.

And the flywheel turns both ways: a worker session ends by writing a lesson through the same pipeline — or stating, in words, why there is none. An attempt without its lesson fails exactly the way an attempt without its receipt fails.

## The fleet, deeper than the feature list

The daemon is the optional layer, and it is built like infrastructure, not like a demo:

- **A durable queue** (Postgres, local, yours) with atomic claims, single-active-lease semantics, idempotency keys, a dead-letter lane, and a state machine the live code actually consults — attack-tested by property tests and crash/restart/redelivery drills that try to lose a task and cannot.
- **Terminal parity, proven per attempt.** A worker runs in its own copy of your project, carrying the layer git does not: your rules file, your hooks, your memory, your skills, your permission lists — and *not* your widening rights, plugins or claude.ai connectors, each named. Six receipts per attempt (hooks, memory, rules, skills, rights, profile) are computed by the daemon and printed by one command; missing data is a failure, never a default pass.
- **Rollback as a record, not a promise.** Every attempt journals its base commit, its branch, the files it changed (from git, so shell edits count), deletions as their own line — and one whole copy-paste command that undoes it.
- **Money that cannot go quiet.** Every worker attempt leaves a line in the spend book — including the killed ones, as labelled estimates. The budget stop and the costs screen read one number through one seam, so they cannot disagree.
- **Steering, not just watching.** Text typed at a running task has three declared fates: reach the turn mid-run at the next tool-call boundary, wait for the turn's end, or interrupt now — with the correction written to disk *before* anything is killed. A returned task resumes the session you already paid for.
- **A failure that explains itself, in one journal.** Three stores know something about a task that broke: the queue row (whose word the card shows), the attempt ledger (the machine's own word about each try) and the decision journal (the worker's note) — and not one of them answers «why does work break here». Where the first two disagree, a person reads the wrong cause: the attempt walked into its turn ceiling, the task was stopped by hand afterwards, and the card says «stopped by hand». One cause is written by no door at all — «the attempts ran out» is derived while a job row is read — so a journal assembled from the closing doors would be silent about exactly the ending most often examined. The daemon sweeps for it instead, once per tick: one append-only line per failure, one file for every project (the ledger is one and the projects are many, and «why does work break» is a question about the machine rather than about a repository), the queue's word and the ledger's word side by side, and absence recorded as absence — a task nobody ever attempted says so, rather than reporting «attempt zero». The pass that appends every new failure is the same one that gathers the history behind you, so the two can never drift apart; its first run on the machine SMA is built on named 42 broken tasks, six where the screen's cause differs from the ledger's, and seven whose only record is a job row the queue archives on a schedule of its own.
- **A window that tells the truth.** Twenty-plus screens served by the daemon itself behind one token and a frozen route table. Numbers on it are measured or say «no data». A field that reaches the window's contract is either drawn on some screen or stands in an explicit not-drawn list with a reason — enforced by the suite.

## Why nobody else has this

The comparison table with per-tool reach and what each does *better* than SMA is in the [README](../README.md#how-sma-compares) — it is deliberately honest, and it stays there. This is the structural argument behind it.

**Memory tools remember; none of them answer for the result.** The best of them have excellent mechanics — persistence, search, session continuity. SMA's memory publishes its *hit rate*, scores whether a delivered note actually helped, and lets a false "done" block its own release. Recall is a means; the product is accountability.

**Orchestration tools coordinate; none of them verify.** Templates, roles, pipelines — and every claim of completion is still the agent grading its own homework. SMA is the only tool in this table where a claimed pass that a blind verifier reproduces as a failure has an automatic *consequence*.

**The vendor can verify — and cannot be audited.** A model vendor grading its own agent is a conflicted judge even when the grading is honest: the verdict is an opaque rubric with no re-runnable receipt, no published track record, no consequence when wrong. SMA is the audit layer any grader has to survive — deterministic, local, reproducible on a fresh clone. That is also why platform absorption does not kill it: absorb the memory, absorb the sessions — the audit seat stays outside by definition.

**And the discipline is the moat.** Any one mechanism here can be copied. What compounds is the system of them: pre-registered predictions + blind verification + consequences + reflexes + a memory that learns from every scored miss — running for months over a real codebase, leaving a corpus and a calibration record that are *yours*. The switching cost of honesty accrues to you, not to us: the whole estate travels with `git clone`.

## What we do not claim

The single-task cost is *higher* with SMA — checks and memory are not free; the bet is cost per **correct** result across many tasks. The fleet's five-day acceptance run under the owner's daily use, and federation proven across two physical machines, are live-operation milestones still ahead — stated on the [roadmap](../ROADMAP.md), not smuggled into a changelog. The runtime's surfaces speak Russian and English unevenly today; full bilingual parity is planned, on the record. A subscription window has no honest price in money, so per-attempt costs are counted in tokens and marked estimated where the stream died. And none of the three worker locks is sold as a proof of impossibility — a worker holding a shell can unset a push address; the locks are layered precisely because each one alone is a fence, not a wall.

## Where it came from

SMA grew in public, version by version, each release naming what it deliberately did not claim: V1 laid memory + coordination on plain files; V2 added predictions, reflexes and corpus health; V3 built the trust spine; V4 graded the grader; V5 shipped the fleet; V5.1–V5.6 gave it the window, measured memory, governance, the full working day, live-session steering, and a taskboard whose numbers do not lie. v5.7.0 adds the design stage — the last gate between a plan and a build that nobody had. The full history, honest carries included, is in [DETAILS.md](DETAILS.md#the-v5-series-release-by-release).

---

*Every number in this document is held by the same gate as the rest of the documentation: `npm test` fails when a count here disagrees with the code. If you find a sentence that cannot be checked by a command, file an issue — that sentence is the bug.*
