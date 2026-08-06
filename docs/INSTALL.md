# Installing SMA

SMA (sma-framework) is a layered memory + multi-terminal coordination framework
for AI coding agents. This page covers both install paths and what each one
puts on your machine.

## Requirements

**Node 22.5 or newer** (`engines.node: >=22.5`) and `git` on PATH. Nothing else:
the installer and every verb are Node built-ins only.

The floor moved up from 18.17, and it is worth saying why, because a raised
requirement is a cost paid by everyone who installs. Node 18 reached end of life
in April 2025 and Node 20 in April 2026 — the old floor was a promise to keep
working on runtimes that no longer receive security fixes, which made nobody
safer. 22.5 is also the version that first carries `node:sqlite`, used by the
experimental lexical index, but that layer is **not** the reason for the move and
does not depend on the floor being mandatory: it probes for the capability at
runtime and answers the same question with a plain-table BM25 wherever the
official Node build shipped SQLite without the full-text extension.

## Path 1: npx (the front door)

The package is published on the public npm registry as `sma-framework` (v3.6+).
From the root of the project you want SMA installed into:

```bash
npx -y sma-framework@latest init
```

Options:

| Flag | Meaning |
|---|---|
| `--claude` | Install for Claude Code (default and only runtime today) |
| `--local` / `-l` | Install into the current project (default) |
| `--global` / `-g` | Install into `$CLAUDE_CONFIG_DIR` or `~/.claude` instead |
| `--with-gsd-aliases` | Also install the transitional `/gsd-*` alias skills |
| `--help` / `-h` | Show usage |

Examples:

```bash
npx sma-framework init                     # local install, /sma-* commands only
npx sma-framework init --global            # global install (all your projects)
npx sma-framework init --with-gsd-aliases  # local + transitional /gsd-* aliases
```

## Path 2: git clone (the documented fallback)

No registry access needed. Clone anywhere, then run the installer **from the
project you want SMA installed into** (the installer refuses to install into
the clone itself):

```bash
git clone https://github.com/sma-framework/sma.git ../sma-clone
cd <your-project>
node ../sma-clone/bin/init.mjs --local
```

To install into a DIFFERENT project than the clone, run the installer from
that project's root:

```bash
cd /path/to/your-project
node /path/to/sma/bin/init.mjs --local
```

Both paths run the exact same installer (`bin/init.mjs`, Node built-ins only,
zero dependencies).

## What gets installed where

| Payload | Destination (local) | Destination (global) |
|---|---|---|
| Engine (workflows, agents, bin, references, templates) | `<project>/.claude/sma-core/` | `~/.claude/sma-core/` |
| Coordination runtime (cli.mjs + lib) | `<project>/scripts/sma/` | `<project>/scripts/sma/` (always project-level, path parity with hooks) |
| Subagent definitions (`sma-*.md`) | `<project>/.claude/agents/` | `~/.claude/agents/` |
| Command skills (`/sma-*`, 14 commands) | `<project>/.claude/skills/` | `~/.claude/skills/` |
| Transitional `/gsd-*` aliases (flag-gated) | `<project>/.claude/skills/` | `~/.claude/skills/` |
| Hooks (SessionStart + the one-spawn PreToolUse `pre` multiplexer + the PostToolUse stall check) | `<project>/.claude/settings.json` | `~/.claude/settings.json` |
| Runtime scaffold | `<project>/.sma/{sessions,claims,journal,reflex}` | same (project-level) |

If the project already has a `.gitignore`, the installer appends a `.sma/`
line to it (unless one is already there). It does not create the file — if
you have none, add `.sma/` yourself, or the coordination state travels in
your commits.

The fourteen command skills are `/sma-start`, `/sma-discuss-phase`,
`/sma-plan-phase`, `/sma-execute-phase`, `/sma-verify-work`, `/sma-quick`,
`/sma-fast`, `/sma-debug`, `/sma-progress`, `/sma-resume-work`,
`/sma-pause-work`, `/sma-help`, `/sma-deleteme` and `/sma-update`. Anything
else you see written as `/sma-…` in older notes is a CLI verb, not a skill —
run those as `node scripts/sma/cli.mjs <verb>`.

The hooks merge is **additive and idempotent**: your own hook entries are
never removed, reordered, or rewritten, and re-running `init` never duplicates
an SMA entry (entries are matched by their command string). The one exception
is SMA's own legacy wiring: installs that predate the `pre` multiplexer carried
per-stream PreToolUse entries (`collision-check` / `reflex-check` /
`gates-check`), and re-running the installer replaces those with the single
`node scripts/sma/cli.mjs pre` entry so the pre-checks run in one spawn instead
of three. If your `settings.json` is not valid JSON, the installer refuses to
touch it and exits.

## The /gsd-* alias flag

`--with-gsd-aliases` installs 11 thin alias skills (`/gsd-plan-phase`,
`/gsd-execute-phase`, ...) that delegate 1:1 to their `/sma-*` counterparts.
They exist only for the transition period on checkouts with old muscle memory
and are removed once that transition window closes (see
`sma-core/aliases/README.md`). Default installs get the `/sma-*` surface only.

## After installing

Open a Claude Code session in the project and run `/sma-start` — a one-time
guided conversation that records what the project is and how you ship it. After
that, `/sma-help` lists every command and `/sma-progress` answers "where are we".

Day to day you work one phase at a time, in this order:
`/sma-discuss-phase N` (agree the goal) → `/sma-plan-phase N` (write the plan and
the checks) → `/sma-execute-phase N` (do it, committing step by step) →
`/sma-verify-work N` (walk it through and re-run the checks). Small jobs skip all
four: `/sma-quick` for a small task, `/sma-fast` for a one-liner.

Outside a session, the CLI is called the same way the installed hooks call it —
from your project root, with no package script and nothing on your `PATH`:

```bash
node scripts/sma/cli.mjs status          # who is working on what, right now
node scripts/sma/cli.mjs explain <verb>  # what any of the 90 verbs is for
```

## The daemon and the app (the optional V5 layer)

The package also carries the V5 worker fleet: the `daemon/` runner with the
compiled app it serves (`daemon/static/app`, already built — there is nothing
to compile), and the `supervisor/` checklists that wire it to launchd or the
Windows Task Scheduler. **None of it is installed into your project and none
of it starts by itself** — `bin/init.mjs` only lays down the memory and
coordination layer described above, and that layer never needs a running
process.

The daemon also brings its own dependencies with it: nineteen packages, about
6 MB, vendored under `daemon/node_modules`, so there is no second
`npm install` to run for it — the list, with the licence each one carries, is
generated into `THIRD-PARTY-LICENSES.md`.

**Nothing above this section needs a database.** The memory and coordination
layer — the corpus, the ninety verbs, claims, receipts, the `/sma-*` commands —
is plain files and git, with no server and no PostgreSQL anywhere in it. The
database below is a requirement of the optional V5 daemon and the app it serves,
and of nothing else. If you never start the daemon, you never need one.

To bring the app up, from the SMA package or checkout directory:

1. **Give the queue a PostgreSQL.** The daemon keeps its task queue there
   (pg-boss), in a database of its own — never your application's production
   database, and never exposed to the internet. There are two honest roads and
   the product does not pretend there is a third:

   - **A server you already run.** Create an empty database for the queue and
     point `queueUrl` in `~/.sma-daemon/config.json` at it. SMA does not install
     PostgreSQL and does not manage yours.
   - **The sandbox**, for a machine with no PostgreSQL, no docker and no
     administrator rights — which is the case this product was actually
     developed on. It is an `embedded-postgres` cluster in `~/pg-sandbox`,
     started by:

     ```bash
     node supervisor/pg-sandbox-windows.mjs start
     ```

     That command starts the cluster through `pg_ctl`, then **waits until a real
     session answers** — an open socket is not readiness, because a cluster still
     replaying its write-ahead log accepts the connection and refuses every query
     with `57P03`, which is exactly how a half-started sandbox looks like a
     working one. It also creates the daemon's queue database if it is missing,
     and it is safe to run when everything is already up: it says so and exits 0.
     `stop` and `status` are the other two verbs. Creating the sandbox directory
     itself is a one-time step written out in
     [`supervisor/setup-windows.md`](../supervisor/setup-windows.md); if it is
     not there, the starter names what is missing and how to make it rather than
     failing with a stack trace.

   Either road, the queue database has to be **UTF-8** for a task to be named in
   anything but plain ASCII. PostgreSQL fixes a database's encoding when the
   database is created — no `ALTER` changes it later — and the Windows `initdb`
   default is the ANSI code page. The daemon reports a queue database in another
   encoding at boot, names what will happen to a non-ASCII title, and names the
   command that repairs it: `node supervisor/queue-utf8-migrate.mjs` reports,
   `--apply` builds a UTF-8 database, carries the waiting tasks and the attempt
   rows over, and keeps the old database under a new name. The full procedure,
   and what deliberately does not travel, is in
   [`supervisor/setup-windows.md`](../supervisor/setup-windows.md).

2. **Start it:** `node daemon/src/main.mjs`. The first boot writes
   `~/.sma-daemon/config.json` (machine-local, never committed) with a fresh
   front token, then prints the address it listens on — `127.0.0.1:7777` by
   default. An unreachable queue is a loud boot failure, not a silent one:
   point `queueUrl` in that file at your server and start it again.
3. **Open it once with the token:**
   `http://127.0.0.1:7777/?token=<the token in ~/.sma-daemon/config.json>`.
   That visit exchanges the token for an HttpOnly session cookie; until then
   every route answers `unauthorized`, deliberately.

Always-on wiring, plus a smoke run that proves the queue → worker → receipt
loop before you leave it running, is in [`supervisor/setup-macos.md`](../supervisor/setup-macos.md)
and [`supervisor/setup-windows.md`](../supervisor/setup-windows.md).

## Updating

Updates flow through the SAME standard installer — never through hand-editing
installed files. From the project root:

```bash
node scripts/sma/cli.mjs update        # report only: installed vs npm latest (and a detected local checkout)
node scripts/sma/cli.mjs update --yes  # apply: re-runs the installer from the chosen source
```

Or conversationally, inside a Claude Code session: `/sma-update`.

- The installed version is read from the install's own stamp
  (`.claude/sma-core/capabilities/sma/capability.json`); the available versions
  come from the npm registry and, when a product checkout sits next to your
  project (the git-clone fallback shape above), from that local source — clearly
  labeled as such. `--source local` applies from the checkout; `--global`
  targets a global install.
- The report is honest at the edges: an unreachable registry is a report line,
  not a crash, and an installed version NEWER than npm (a local-source install)
  is stated plainly as newer — `--yes` refuses to roll back.
- Because the update just re-runs `bin/init.mjs`, everything local is preserved
  by the installer's own guarantees: `.claude/memory/**`, the `.sma/` state
  including `profile.json`, every foreign `settings.json` key, and every user
  byte of CLAUDE.md.

## Uninstalling

The off-ramp is one action, and it is the supported path:

```
/sma-deleteme
```

Or, outside a session, the same verb directly (dry-run by default):

```bash
node scripts/sma/cli.mjs deleteme          # show exactly what would be removed
node scripts/sma/cli.mjs deleteme --yes    # do it
node scripts/sma/cli.mjs deleteme --yes --global   # for a global install
```

It reverses every installer artifact — engine, runtime, agents, skills, the
hook entries, the statusline insert, the managed CLAUDE.md block, `.sma/` —
and **preserves `.claude/memory/**`**: the corpus is yours, not the tool's.
Foreign `settings.json` keys and every user byte of CLAUDE.md survive; a
managed block whose anchor pair has been damaged is refused rather than
guessed at.

<details>
<summary>Manual removal (fallback, if the verb is unavailable)</summary>

```bash
rm -rf .claude/sma-core .sma scripts/sma
rm -rf .claude/skills/sma-* .claude/skills/gsd-*
rm -f  .claude/agents/sma-*.md
```

(For a global install: the same paths under `~/.claude` instead of
`.claude/`, plus the project-level `scripts/sma` and `.sma/`.) Then open
`.claude/settings.json` and delete the hook entries whose command starts with
`node scripts/sma/cli.mjs`, and the statusline entry if you enabled one.
Everything else in `settings.json` is yours and untouched. Finally, remove
the `<!-- SMA:RULES:BEGIN … -->` / `<!-- SMA:RULES:END -->` block from
CLAUDE.md and, optionally, the `.sma/` line from `.gitignore` — the manual
path does not do those for you, which is the main reason `/sma-deleteme`
exists.

</details>

## Audited payload manifest

The package uses a **files allowlist** (never a denylist) in `package.json`, so
nothing ships by accident. The composition below is `npm pack --dry-run` for
`sma-framework@5.3.0` (audited 2026-08-06) — **1152 files, 5.1 MB packed /
18.9 MB unpacked**. Reproduce it yourself in a clone with:

```bash
npm pack --dry-run
```

| Path | Files | What it is |
|---|---|---|
| `sma-core/` | 459 | the engine: workflows, agents, references, templates, bin shim, transitional aliases |
| `scripts/sma/` | 289 | the coordination + accountability runtime (`cli.mjs` + lib), its explainers, and its test fixtures |
| `daemon/` | 70 | the optional V5 runner, its front server, and the compiled app it serves (`daemon/static/app`) |
| `daemon/node_modules/` | 278 | the daemon's two runtime dependencies (`pg`, `pg-boss`) and their transitive tree |
| `docs/` | 14 | this page, both deep dives, the three memory documents, the recipes, the system map |
| `supervisor/` | 10 | the always-on checklists (English + Russian) and smoke runners for macOS and Windows |
| `bin/init.mjs` | 1 | the installer |
| root | 5 | `package.json`, `LICENSE`, `THIRD-PARTY-LICENSES.md`, `README.md`, `README.ru.md` |

**Explicitly absent:** `.sma/` runtime state, `tools/` (repo-only maintenance
scripts — anything documented as `node tools/…` runs from a git clone, not
from the package), `spa/` (the app source; only its build output ships),
`assets/`, `.planning/`, `.env*`, and all dotfiles.

Two honest notes about what *is* in there. The daemon's dependency tree is
vendored rather than resolved at install time, which is why the package is
larger than a pure-Node payload would be; its licences are tracked in
`THIRD-PARTY-LICENSES.md`. And the test fixtures under `scripts/sma/__tests__`
ship deliberately, so the receipts a release claims can be re-run from the
published package rather than taken on trust.
