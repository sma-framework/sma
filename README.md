<p align="center">
  <img src="assets/logo-banner.svg" alt="SMA — Shared Memory & Automation" width="830">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3CC0A0" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/runtime-plain%20files%20%2B%20git-2E6FD9" alt="plain files + git">
  <img src="https://img.shields.io/badge/daemons-none-1FA0A6" alt="no daemons">
  <img src="https://img.shields.io/badge/databases-none-1FA0A6" alt="no databases">
</p>

# SMA — Shared Memory & Automation

**Layered memory + multi-terminal coordination for AI coding agents — with a learning loop that is measured, not hoped for.**

[Русская версия → README.ru.md](README.ru.md)

## Why SMA exists

If you run Claude Code (or any coding agent) on a real project every day, you already know these four failures:

1. **Rules get read, then dropped.** Your carefully written instructions file is acknowledged at session start and violated an hour later — the model's working attention is tiny, and a rule that isn't present *at the moment of the action* might as well not exist.
2. **"Done" that isn't.** The agent reports tests green and files written; the tree says otherwise. Confident prose is not evidence.
3. **Lessons get re-learned, expensively.** The same mistake — the same footgun in your build, the same API quirk — burns you again next month, because nothing turned the first burn into a permanent avoidance.
4. **Parallel sessions collide.** Two terminals on one checkout silently overwrite each other; session B "fixes" what session A finished an hour ago.

SMA is a layer on top of the agent that attacks all four with the same design bet: **small files in your git repo + deterministic scripts + the agent-harness hook system**. No daemon, no database, no embeddings, no cloud. Everything it knows is a markdown file you can read, diff, and revert; everything it enforces is a script you can run yourself.

## What SMA is

Three subsystems on one substrate:

- **Memory that arrives on time.** Project knowledge lives as small, tagged notes. The always-loaded core stays tiny (a few KB); topic notes load only when the task touches that topic; and *reflexes* deliver the exact relevant lesson right before the tool call that needs it — because a rule named at the moment of the act is worth ten rules buried in a big instructions file.
- **Coordination without a server.** Every open terminal registers itself, claims the files it is working on, and draws shared counters (migration numbers, release numbers) from one queue. Parallel sessions warn each other *before* the collision, and the journal records who did what.
- **A learning loop with a score.** Plans state up front what will measurably change and how to check it (`predictions`). A deterministic scorer — a script, not a judge model — settles each prediction against reality. Misses become lessons; repeated lessons become reflexes; the calibration ledger tracks, per area, how often promises match facts. SMA's memory does not claim to work — it has a measured hit rate.

## The story in 10 slides

<p align="center">
  <img src="assets/deck/slide-01.png" alt="SMA — the accountable memory & coordination layer for AI coding agents" width="820">
</p>

<details>
<summary><b>Open the full deck (10 slides)</b> — the problem, the root cause, the mechanism, the proof discipline</summary>

<br>

| | |
|:--:|:--:|
| <img src="assets/deck/slide-02.png" width="410"><br>**The problem** — brilliant, and unaccountable | <img src="assets/deck/slide-03.png" width="410"><br>**Root cause** — a model's working attention is tiny |
| <img src="assets/deck/slide-04.png" width="410"><br>**The bet** — trust you can diff | <img src="assets/deck/slide-05.png" width="410"><br>**The loop** — predict, act, score, learn |
| <img src="assets/deck/slide-06.png" width="410"><br>**Memory that arrives on time** | <img src="assets/deck/slide-07.png" width="410"><br>**Coordination without a server** |
| <img src="assets/deck/slide-08.png" width="410"><br>**Measured, not promised** | <img src="assets/deck/slide-09.png" width="410"><br>**Where this goes (V3)** |
| <img src="assets/deck/slide-10.png" width="410"><br>**Own your agent's memory** | |

</details>

## How the loop runs

```mermaid
flowchart LR
    A["Plan writes<br>predictions"] --> B["Agent acts"]
    R["Reflexes fire<br>BEFORE the act"] --> B
    B --> C["Deterministic scorer<br>settles each prediction"]
    C --> D["Calibration ledger<br>per-area hit rates"]
    C -->|miss| E["Lesson drafted"]
    E -->|promoted on evidence| R
    D --> F["Report: sessions ·<br>predictions · collisions"]
```

One burn, permanent avoidance — the model is a child who touches boiling water once. The miss is written down, the written lesson gets a trigger, and the trigger fires as a warning in front of the *next* matching action, in every terminal, forever. And because the scorer is a script, the loop cannot flatter itself.

## The lifecycle: discuss → plan → build → verify → ship

SMA is not only memory — it is a full working rhythm for shipping real changes with an agent. Each stage is a `/sma-*` command, and every stage reads from and writes back to the same file-based memory, so nothing is re-explained twice.

```mermaid
flowchart LR
    D["1 · Discuss<br>/sma-discuss-phase"] --> P["2 · Plan<br>/sma-plan-phase"]
    P --> B["3 · Build<br>/sma-execute-phase"]
    B --> V["4 · Verify<br>/sma-verify-work"]
    V --> S["5 · Ship<br>push ritual"]
    M(["Memory corpus<br>+ predictions + reflexes"]) -.->|reads| D
    M -.->|reads| P
    M -.->|reads| B
    B -.->|writes lessons| M
    V -.->|writes lessons| M
    S -.->|calibration scored| M
```

- **1 · Discuss** — lock the gray-area decisions with a human *before* any code, through adaptive questioning. The context is captured as files, so the plan that follows is grounded, not guessed.
- **2 · Plan** — turn the decisions into an executable plan whose steps each carry a machine-checkable **prediction** (what will change, and the command that proves it). The plan is the contract.
- **3 · Build** — execute the plan in dependency-aware waves. Reflexes fire before risky actions; progress is journaled so an interrupted run resumes in minutes, not from scratch.
- **4 · Verify** — validate the built feature against its acceptance criteria in a conversational pass. Human sign-off gates stay human; the agent never self-certifies them.
- **5 · Ship** — the release ritual runs the full gate, and the predictions written back in step 2 are **scored** against what actually happened. Misses become the next lessons. The loop closes.

## Memory, in three layers

Not one big instruction file — three tiers that keep the always-loaded budget tiny while nothing is ever forgotten.

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

Auto-trim never deletes — it *demotes* down the layers, so the system gets lighter without ever losing a fact (in this repo's own dogfood, the always-loaded index went from 46 KB to 5 KB with full recall preserved, gated by a standing benchmark).

## Coordination without a server

```mermaid
sequenceDiagram
    participant A as Terminal A
    participant FS as .sma/ (files + git)
    participant B as Terminal B
    A->>FS: register session · claim src/api
    B->>FS: register session · claim src/api
    FS-->>B: ⚠ scope held by A — warned BEFORE the edit
    A->>FS: next-slot migration → 0007
    B->>FS: next-slot migration → 0008
    Note over FS: shared counters never collide<br>the journal records who did what
```

## Install

The front door:

```bash
npx sma-framework init
```

The git-clone fallback (no registry access needed) — clone anywhere, then run
the installer **from your own project directory**:

```bash
git clone https://github.com/sma-framework/sma.git ../sma-clone
cd <your-project>
node ../sma-clone/bin/init.mjs --local
```

Both paths run the same zero-dependency installer. Flags (`--global`, `--with-gsd-aliases`, ...), the full payload manifest, and uninstall steps are in [docs/INSTALL.md](docs/INSTALL.md).

## Quickstart

Open a Claude Code session in your project and run:

```
/sma-start
```

The onboarding conversation explains the system, seeds your starter memory corpus and project scaffolding, and records your infrastructure profile (your deploy host, your release ritual) so every later command speaks your stack. From that point on, each new session registers itself automatically and loads the memory core before doing anything else.

## Commands

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

The coordination CLI runs underneath (`node scripts/sma/cli.mjs` or `pnpm sma`): `status`, `claim`, `next-slot`, `load`, `lint`, and friends. Sessions and hooks call it for you; you can also call it directly.

## The six pillars

- **Predictions** — every plan states, up front, what will measurably change and how to check it; a deterministic scorer compares promise to fact at plan close, and a calibration ledger tracks which areas keep being wrong.
- **Reflexes** — a scored miss becomes a permanent rule that fires *before* the next matching tool call, as a warning injected into the session. Touch boiling water once, never again.
- **Corpus health** — lint, contradiction detection, scheduled consolidation, and promotion counters keep the memory sharp at hundreds of notes instead of decaying into noise.
- **Coordination** — session registry, file claims with pre-edit warnings, shared counters for anything two terminals could race on, and a live "someone is pushing" signal.
- **Harness** — per-plan progress journals make an executor death a five-minute resume; stall detection and dependency-aware waves keep long runs honest and parallel.
- **Report** — a cockpit view of sessions, predictions, reflex firings, collisions, and corpus health, so the state of the system is visible, not assumed.

## What makes it different

- **Accountable, not just helpful.** Every claim SMA makes about itself is a pre-registered prediction settled by a script. Memory frameworks usually promise recall; SMA publishes its hit rate.
- **Deterministic first.** Retrieval is tag- and trigger-driven, enforcement is plain scripts, and the whole learning loop runs without a single LLM call in the hot path. Optional intelligence can sit on top; correctness never depends on it.
- **Git-native and reversible.** Notes, ledgers, journals — all files in your repo. Self-improvement arrives as diffs you review; anything the system learns can be reverted with `git revert`.
- **Fail-open by design.** A warning never blocks your work; a dead hook never wedges a session. Hard blocking is reserved for security gates you configure yourself.
- **Yours.** The corpus lives in your repository, travels with `git clone`, and is portable to other agents — it is knowledge you own, not a vendor cache.

## Roadmap — what's next (V3)

V1 gave agents memory. V2 gave them predictions, reflexes, and coordination. **V3 makes the agent stop trusting its own word** — the one thing a model vendor structurally cannot ship neutrally, because it cannot grade its own homework. Four load-bearing pieces, each a deterministic script on the substrate already here:

```mermaid
flowchart LR
    subgraph V3["V3 · the accountability layer"]
        R["Replayable receipts<br>every «done» carries a<br>re-runnable command, not prose"]
        B["Blind re-verification<br>a second agent re-derives «done»<br>from the tree alone"]
        G["Git airbag<br>a recovery snapshot before<br>any destructive command"]
        P["Calibration passport<br>a public badge with the<br>measured hit rate"]
    end
```

- **Replayable receipts** — every accomplishment claim carries a command and an expected result hash, re-runnable by anyone. Prose-only claims fail a lint. "Done" becomes evidence, not assertion.
- **Blind re-verification** — a separate agent re-derives each "done" purely from the code tree, without seeing the executor's report. Claimed-pass / reproduced-fail is the heaviest signal in the ledger.
- **Git airbag** — a deterministic recovery point written *before* any destructive command runs, so a bad `git reset --hard` or force-push becomes a one-command undo instead of lost work.
- **Calibration passport** — the per-area hit rate and recall score compile into a public README badge. The first honest trust metric for agentic work: memory that publishes its own accuracy.

Full design, scored and adversarially reviewed, lives with the project. This is the direction, not a promise of dates — it ships evidence-first, one falsifiable metric at a time.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=sma-framework/sma&type=Date)](https://star-history.com/#sma-framework/sma&Date)

## License and attribution

MIT — see [LICENSE](LICENSE).

**Creator: Matvey Maslov.**

The workflow engine inside SMA is derived from [gsd-core](https://github.com/open-gsd/gsd-core) (MIT). The pristine upstream snapshot, the rename map, and third-party notices are tracked in [UPSTREAM.json](UPSTREAM.json), [rename-map.json](rename-map.json), and [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).
