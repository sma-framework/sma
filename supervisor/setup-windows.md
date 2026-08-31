# SMA V5 — running the nightly worker on Windows (Task Scheduler harness)

*Русская версия: [`setup-windows.ru.md`](setup-windows.ru.md).*

This is the Windows twin of [`setup-macos.md`](setup-macos.md): the same thin
supervisor layer, bound to the Windows Task Scheduler instead of launchd. The
daemon core is host-agnostic; only the OS binding lives here.

The procedure below was validated on a reference Windows machine — no
administrator rights, no docker, no `psql` client. The steps you run by hand are
written in plain language; the engineering detail follows in separate blocks.

> **Security matters here.** The Scheduled Task ships DISABLED and this checklist
> does not register it. Registering and enabling it is done by the machine's
> owner, by hand, after the smoke below has passed. The daemon never reaches
> origin: it has no path to the publish verb. Approved work comes back the other
> way — the owner adds this PC as a git remote and pulls the local branch
> themselves.

## 1. Prerequisites

- **Node.js 22.5 or newer** and **git** on PATH. The daemon uses only Node's
  built-in modules plus `pg-boss` — it is plain node, so your project's own
  conflicts over Node or framework versions never reach it.
- **A local Postgres for the queue on :5433.** This is the only hard requirement the
  daemon adds. Nothing in the memory and coordination layer needs it — that layer is
  plain files and git — so a machine that never starts the daemon never needs a
  database at all.

  Either point `queueUrl` at a server you already run, or create the `~/pg-sandbox`
  sandbox (embedded-postgres, PG18) this checklist assumes: a directory holding an
  initialised `pgdata` and the `@embedded-postgres` binaries. It needs no
  administrator rights, no docker, and no installed Postgres server:

  ```powershell
  mkdir ~/pg-sandbox; cd ~/pg-sandbox
  npm init -y; npm install embedded-postgres
  node -e "import('embedded-postgres').then(async ({default:P})=>{ const pg=new P({databaseDir:'./pgdata',user:'postgres',password:'postgres',port:5433,persistent:true}); await pg.initialise() })"
  ```

  Bring it up — and create the daemon's queue database in the same command — with the
  starter that ships beside this file:

  ```powershell
  cd <SMA_HOME>
  node supervisor/pg-sandbox-windows.mjs start          # start | stop | status
  ```

  > **Use the starter rather than the sandbox's own boot script.** On the reference
  > machine `node start.mjs` did not return, was killed on a timeout, and left the
  > cluster in crash recovery — accepting TCP connections and answering no query, which
  > every port probe reports as «up». The starter takes the `pg_ctl` road, and it waits
  > for a **session that answers** rather than for an open socket: a cluster still
  > replaying its log is reported by name (`57P03`) and waited out. It is idempotent —
  > running it against a cluster that is already up prints «already up» and exits 0 —
  > and it creates the queue database (`queueUrl`'s, or `sma_queue`) if it is missing,
  > explicitly in UTF-8, because Windows `initdb` defaults a cluster to the ANSI code
  > page and a WIN1252 queue database cannot hold a task title written in Cyrillic.

  > **A queue database that already exists in another encoding.** A database's encoding
  > is fixed when the database is created; no `ALTER` changes it, so a queue created
  > before the starter learned this is still WIN1252. The daemon now says so at boot,
  > and there is a door out:
  >
  > ```powershell
  > node supervisor/queue-utf8-migrate.mjs             # report only: encoding, what is waiting
  > # stop the daemon, then:
  > node supervisor/queue-utf8-migrate.mjs --apply
  > ```
  >
  > It writes the export to a JSON file before it changes anything, builds a new UTF-8
  > database over `template0`, carries the tasks that are still waiting plus the attempt
  > rows, and swaps the names. The old database is **renamed and kept**, never dropped —
  > delete it yourself once you are satisfied. What it does not carry (the finished job
  > history, the original timestamps, a task a worker was holding at that moment) is
  > printed by the command itself, before and after.
  >
  > Until you run it, nothing is silently swallowed either: a task title such a database
  > cannot store is refused with that same sentence — the database, the consequence and
  > the repair command — instead of an "internal error".
- **Daemon dependencies.** `pgboss-backend.mjs` imports `pg-boss` and `pg`
  lazily. These packages are not declared in the product's root `package.json`;
  install them machine-locally into `node_modules` (they stay out of git). The
  compatible version is `pg-boss@11` — v12 has no default export, which the code
  expects, and v10 has no `getQueueStats`.

  ```powershell
  cd <SMA_HOME>
  pnpm add pg-boss@11 pg    # or: npm install --no-save pg-boss@11 pg
  ```

## 2. Machine-local configuration (never committed)

`~/.sma-daemon/config.json` is written on the daemon's first boot, with a fresh
64-character front token. To create it ahead of time, in one command:

```powershell
cd <SMA_HOME>
node --input-type=module -e "import('./daemon/src/config.mjs').then(m=>m.loadConfig())"
```

Then set in it:

- `queueUrl` = `postgres://postgres:postgres@localhost:5433/sma_queue` — a
  dedicated queue database on :5433. NEVER the `postgres` database and NEVER a
  production database.
- `bind` = `127.0.0.1` (0.0.0.0 only by explicit consent).
- `expireMs` — how long a worker may stay silent before its task is taken back, in
  milliseconds (default `120000`, two minutes). One setting, one clock: the same
  number is the queue's own lease and the sweep that requeues a silent worker's
  task, so raising it moves both. Anything that is not a positive number is
  ignored and the default stands.
- `workers` — for this PC, a single honest local worker:

  ```json
  { "id": "local-1", "lane": "prod", "provider": "claude",
    "account": { "name": "local-1", "configDir": "C:\\Users\\<you>\\.sma-accounts\\local-1",
                 "oauthTokenEnv": "SMA_LOCAL_1_TOKEN", "spendLogsDir": "C:\\Users\\<you>\\.sma-accounts\\local-1\\spend" },
    "enabled": true }
  ```

- `orchestrator` — **do not write it by hand.** The machine's top figure is minted while the
  settings load and written into this file by itself; it is not a worker and never takes a task
  off the queue. A row for it typed into `workers` is lifted out of that list on the next load.

> **About mode 0600.** On win32 `chmod` is a documented no-op; the daemon still
> attempts it and silently ignores the failure. The Windows equivalent of 0600 is
> the user profile ACL: the file sits in `~/.sma-daemon` under your account and is
> readable by its owner only by default. The file is never committed and never
> printed by the wrapper or by the smoke.

> **About a real account.** Binding a headless account (`claude setup-token` → the
> token in the `SMA_LOCAL_1_TOKEN` environment variable) belongs to a REAL nightly
> run, not to the smoke. The smoke proves the loop with a synthetic echo task and
> spends nothing on the model.

## 3. Acceptance run — the loop smoke (this IS the check)

Bring the Postgres sandbox up first (if it is not already running), then run the
smoke:

```powershell
cd <SMA_HOME>
node supervisor/pg-sandbox-windows.mjs start --db sma_queue   # harmless if already up
node supervisor/live-smoke-windows.mjs
```

The smoke proves the chain on REAL durable state: the queue accepts → the worker
picks the task up from pg-boss on :5433 → a receipt appears (`receiptRef`) → the
result is visible in `GET /api/state` with the token. Exit 0 = green. It also
checks negative authentication: `GET /api/state` without a token → 401.

## 4. Registering and enabling the task — OWNER ONLY

These two commands are not part of the setup above. The machine's owner runs them
by hand, when they decide the nightly worker should come on. Before importing,
replace `<SMA_HOME>` in `sma-daemon-windows.task.xml` with the absolute path of
the SMA clone.

```powershell
# the owner only
schtasks /Create /TN SMA-Daemon /XML supervisor\sma-daemon-windows.task.xml
schtasks /Change /TN SMA-Daemon /ENABLE
```

The task ships with `<Enabled>false</Enabled>`, so even an accidental import will
not start a worker. To remove it later: `schtasks /Delete /TN SMA-Daemon /F`.

## 5. What follows (the real run)

- **A real nightly run of a size:S backlog task** is started by the owner AFTER
  the task is enabled. Then the daemon really does pick a ready task off the
  backlog, provision a worktree, spawn a worker and pass the reverify gate — the
  only door into «done».
- **The Telegram report and the spend-ledger economics** ride on that real run,
  not on the synthetic smoke. The smoke is deliberately cheap: it proves the
  loop, it does not fill the nightly statistics.

## 6. The first run from the app

Everything above brings the machine up. This section prepares the machine for the
run where the work itself is started from the app instead of from a command line —
and, more importantly, for **proving that afterwards**. The claim being made is a
plain one: for a stretch of working days the only things left at a terminal were
the four kinds that were agreed to stay there — a measuring run, git history
surgery, removing the framework from a project, and starting or debugging the
daemon itself. Nobody can prove that from memory, so the machine writes it down.

Do these in order. Steps 1 and 5 are the machine owner's own decisions and are
written here as decisions, not as setup.

### 6.1. The terminal journal — a SessionStart hook

One line per terminal session, appended to
`~/.sma-daemon/terminal-sessions.ndjson`. Add this to your **user-level** Claude
Code settings (`~/.claude/settings.json`) so it covers every project on the
machine, not only this checkout — replace `<SMA_HOME>` with the absolute path of
the SMA clone and keep the forward slashes:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node <SMA_HOME>/supervisor/terminal-journal.mjs log", "timeout": 10 }
        ]
      }
    ]
  }
}
```

If the file already has a `hooks` block, add the entry to it — the settings file
is yours; nothing here rewrites it for you.

Two properties worth knowing before you rely on it:

- **It cannot get in your way.** Any failure — an unwritable directory, a full
  disk — is swallowed and the command exits 0. A journal that could stop a session
  from starting would be worse than no journal at all.
- **It does not record the daemon's own sessions.** A worker the daemon spawns
  carries `SMA_HEADLESS` in its environment, and those sessions are skipped. They
  are the work being done from the app — counting them as terminal runs would bury
  the evidence in the very thing it measures.

A session start knows *when* a terminal opened and cannot know *what for*. When you
open a terminal on purpose for one of the four, say so — either set
`SMA_TERMINAL_REASON` in that terminal, or write the reason by hand:

```powershell
$env:SMA_TERMINAL_REASON = "git history surgery: rebasing the release branch"
# or, without touching the environment:
node <SMA_HOME>/supervisor/terminal-journal.mjs log baseline measurement before the release
```

An unlabelled session counts as **outside** the list. That is deliberate: the
burden is on the run that wants to be excused.

### 6.2. The queue's encoding

The run is conducted in the language you actually work in, so a task title has to
survive the round trip. A queue database created before the starter learned to ask
for UTF-8 is still on the machine's ANSI code page and will refuse every non-ASCII
title. Check first, migrate only if the check says so:

```powershell
cd <SMA_HOME>
node supervisor/queue-utf8-migrate.mjs            # report only: the encoding, and what is waiting
# if it is not UTF8 — stop the daemon, then:
node supervisor/queue-utf8-migrate.mjs --apply
```

The old database is renamed and **kept**, never dropped, and the export is written
to a file before anything changes. What a migration does not carry is printed by
the command itself, before and after. Details in §1.

### 6.3. Account tokens in the daemon's environment

Every worker profile names an environment variable (`account.oauthTokenEnv`); the
token itself is never written into the config. The variable has to be set **in the
environment the daemon starts in**, before it spawns anything — a worker that
starts without it spends a session discovering it is not authenticated. If the
daemon runs from the Scheduled Task, the task's environment is the one that has to
carry it, not the shell you happen to be typing in.

### 6.4. Turning the pipeline on

The switch lives on the **«Дом системы»** screen, on the **«Конвейер»** card. Use
it there — do not edit `~/.sma-daemon/config.json` by hand. The switch is the door
that both writes the setting and reports back what the daemon then says about it;
a hand-edited config is a setting nobody confirmed.

A restarted daemon comes up with the pipeline **off** unless it has been turned on
(a config without the key means off), and it says so in its boot line. If the card
reads «Состояние неизвестно», the running daemon predates the switch — restart it
and the line becomes honest.

### 6.5. The Scheduled Task — a decision, with a receipt

Registering and enabling the nightly task is §4, and it stays where it is: the
machine's owner does it by hand, by explicit decision. It is not a step this
section performs for you, and nothing automates it quietly. Whichever way you
decide, write the decision down — «registered on <date>» or «deliberately not
registered» — so the acceptance run reports a fact rather than a shrug.

### 6.6. Before the run, and how it is read afterwards

Two things to note down **before** the first day:

- **The starting spend.** Open the **«Расходы»** screen and record the number. The
  price of moving to the app is then a number, not a feeling.
- **The current bundle.** Anything that changed the app's screens has to have been
  rebuilt (`cd spa && npm run build`) and the daemon restarted, or the run measures
  yesterday's code. The daemon serves the bundle from disk and picks a rebuilt one
  up without a restart — but new **doors** live in its code and do not appear until
  it is restarted.

Afterwards, the journal is read by one command:

```powershell
cd <SMA_HOME>
node supervisor/terminal-journal.mjs report --since 2026-08-10
```

It prints every session it recorded, marks the ones outside the list with `!`,
counts each of the four kinds, and the **last line it prints is the number of runs
outside the list** — the whole claim, in one number a script can read. If there is
no journal at all it says so and exits 3 rather than printing a comfortable zero:
absence of a record is not a record of absence.

### 6.7. Making it come back by itself

Windows does **not** bring the daemon back after a restart: it is not a service, and the
nightly task from §4 does not fire until 23:30. A machine you open during the day — still
more one you reach from somewhere else over a private network — has no window until somebody
starts it by hand.

Two routes; one is enough.

**(a) A Startup-folder shortcut — no administrator rights.** The right choice on a host
without an admin, which is exactly the kind of host this harness is written for:

```powershell
$sma = 'C:\path\to\sma'
$su  = [Environment]::GetFolderPath('Startup')
$w   = New-Object -ComObject WScript.Shell
$s   = $w.CreateShortcut((Join-Path $su 'SMA daemon.lnk'))
$s.TargetPath       = 'powershell.exe'
$s.Arguments        = "-NoProfile -ExecutionPolicy Bypass -File `"$sma\supervisor\start-daemon-windows.ps1`""
$s.WorkingDirectory = $sma
$s.WindowStyle      = 7   # minimised: the process stays visible on the taskbar and closable
$s.Save()
```

**(b) A logon Scheduled Task** — `supervisor/sma-daemon-logon-windows.task.xml`, shipped
disabled like its nightly sibling. Registering it **requires an elevated console** (measured:
without one `Register-ScheduledTask` answers «Access is denied»), so on a host without an
admin use route (a).

```powershell
$sma = 'C:\path\to\sma'
$xml = (Get-Content "$sma\supervisor\sma-daemon-logon-windows.task.xml" -Raw -Encoding UTF8).Replace('<SMA_HOME>', $sma)
Register-ScheduledTask -TaskName 'SMA-Daemon-Logon' -Xml $xml -Force
Enable-ScheduledTask   -TaskName 'SMA-Daemon-Logon'
```

**The two triggers do not fight.** `start-daemon-windows.ps1` looks at the window's port
first and exits without doing anything when a daemon is already answering, so the nightly
task and the at-logon start cannot end up with two daemons on one queue.

**The honest limit: it is logon, not boot.** The daemon has to stand in the interactive
user's environment — their PATH, their home, their account's credentials — so the trigger
fires after a sign-in. On a box you reach from far away with nobody sitting at it that means
either automatic sign-in, or one manual login after a restart.

Verified from a cold start: with both Postgres and the daemon stopped, the shortcut brings
back **both** — the database sandbox first, then the daemon, and the window answers on 7777.

### 6.8. The watchdog — installed from an ordinary session, by one command

The section above brings the daemon back after a restart. A daemon that dies in the middle of
the day is brought back by the watchdog (`supervisor/daemon-watch.mjs`), and it had the same
problem, only sharper: its own unit — the Scheduled Task
`sma-daemon-watch-windows.task.xml` — **cannot be registered at all** on a host without an
administrator. Measured: both `schtasks /Create` and `Register-ScheduledTask` answer «Access is
denied» from an ordinary session.

The no-admin route is now installed by a script that ships with the product, not by hand:

```powershell
cd <SMA_HOME>
node supervisor/install-watch-windows.mjs           # install and start it now
node supervisor/install-watch-windows.mjs status    # what is installed, what is running
node supervisor/install-watch-windows.mjs remove    # take it out and stop it
```

What it does, in order, and what it says out loud:

- **It tries the Scheduled Task first** — that unit is better than a shortcut: it survives a
  logoff and it can restart. The refusal is **named in words** («schtasks отказал по правам:
  «Access is denied» — задача планировщика ставится только из окна с правами администратора»)
  and only then is the fallback taken. An install that quietly slips into the fallback leaves
  the owner believing a task is registered that is not there. `--no-task` skips the attempt
  when you already know the answer.
- **It writes the Startup shortcut** — `%APPDATA%\…\Startup\SMA daemon watch.lnk`, pointing at
  the absolute path of `node.exe` and at `supervisor/watch-loop.mjs`. The real Startup folder
  is asked of Windows itself: on a roaming profile it is not where a computed path would put
  it, and a shortcut written to the wrong folder is silence instead of a watchdog.
- **It starts the loop right now**, as a detached process: a watchdog that dies with the window
  that installed it watches nothing. What makes it alive is not the spawn call but the **lock**
  it took; a lock not taken within 15 seconds is a failure with the log named, not a «started».

`watch-loop.mjs` is that eternal circle, and it carries the three properties of the Scheduled
Task without which the shortcut would be a silent downgrade: the delay before the first look
(`--delay`, 120 seconds by default — a watchdog that looks at a machine which is merely slow
declares a fall that never happened), the restart of a fallen watchdog with a ceiling (five
fast failures in a row are a cause the sixth start will not change: the circle stops and leaves
it in the log), and **one watchdog per machine** (the lock at
`~/.sma-daemon/daemon-watch.lock.json`; two would declare one fall twice and lift twice). The
circle's own lines and the watchdog's output go to
`~/.sma-daemon/logs/daemon-watch-<day>.log`, and which day a line belongs to is decided per line —
by the LOCAL clock, the same one the daemon's own log turns on, so a line written after midnight
does not land in yesterday's file.

**If you had already started a watchdog by hand** — an old shortcut with the loop written
inside its argument string — the install rewrites that shortcut, but the ALREADY RUNNING old
process survives it: it never took the lock and knows nothing about it. Close its window (or
sign out and back in), or the machine carries two watchdogs until the next logon.

Verified by a live run on 2026-08-29 on the reference machine with no administrator rights:
`schtasks` answered «Access is denied» and that was printed in words; the shortcut landed in
the Startup folder; the circle started and **survived the window that installed it** (the
process was still alive from the next shell session); and launching that same shortcut the way
a logon launches it brought the circle up again.

---

## First run

**Date:** 2026-07-20 (reference Windows machine, no administrator rights).
**Result:** GREEN — the `supervisor/live-smoke-windows.mjs` smoke exited 0.

**The loop was proven on real pg-boss at :5433/sma_queue** (not `postgres`, not a
production database):

| Step | Check | Result |
|-----|----------|------|
| 1 | PG :5433 up + database `sma_queue` created (42P04 tolerated) | PASS |
| 2 | Daemon booted (front listening on 127.0.0.1:7788 + a stateless tick running) | PASS |
| 3 | GET /api/state without a token → 401 (the authentication gate holds) | PASS |
| 4 | Task enqueued through the front's POST /api/enqueue (source 'roster', DoR-exempt) | PASS |
| 5 | Task left the queue → status 'completed' (picked up + finished inside the poll window) | PASS |
| 6a | Durable pg-boss row on :5433/sma_queue: state='completed', receiptRef in output | PASS |
| 6b | GET /api/state with the token shows the task in done[] (workerId=local-1, attempts=1) | PASS |
| 6c | Attempt-ledger row: outcome='completed', receiptRef, workerId=local-1, provider=claude | PASS |

- **taskId:** `R-1784552633866`
- **receiptRef:** `preflight:R-1784552633866`
- **Enqueue path:** the front's `POST /api/enqueue` (token in the
  `Authorization: Bearer` header) — NOT the fallback `adapter.enqueue`.
- **verbRunner:** a recording echo runner answered the `preflight` verb with the
  verdict 'built' → the preflight door (`loop.mjs` step 4) carried the task to
  completed without spawning a worker and without model spend. The reverify gate
  remains the door for real work — this is a proof of the loop, not a bypass of
  the gate.

### Observations recorded during that run (READ-ONLY — not patched at the time)

1. **tickDeps without `buildArgs`** (anticipated). `main.mjs` does not pass
   `buildArgs` into the tick, so a real non-'built' task cannot reach a spawn from
   the production composition root. It does not affect this smoke (the preflight
   door skips the spawn).
2. **`ledger` passed into the tick as the STRING `ledgerDir`** (anticipated). That
   makes `ledger.recordAttempt` inside `loop.mjs` (completeTask/failTask) a silent
   no-op — the `typeof === 'function'` guard skips it. BUT the attempt-ledger row
   is written by the pg-boss adapter ITSELF in its `complete()` (`ledgerDir` is
   passed into `createPgBossQueue`), so the ledger fills up anyway — through the
   adapter path, not the tick. Consequence for a deployment: the ledger branch in
   the tick is dead as laid; the single write comes from the adapter (which is
   correct for one write).
3. **`createDaemon().start()` does not call `adapter.start()`.** The returned
   `start()` brings up only the front and the tick; the pg-boss connection is not
   opened. The smoke (and a real deployment) has to start the adapter itself.
4. **`pgboss-backend.mjs start()` references a dead-letter queue `sma.task.dead`
   but does not create it.** Under pg-boss v11, `createQueue(lane, {deadLetter})`
   validates the target and fails with «Queue sma.task.dead does not exist» → a
   fresh boot crashes. A deployment (or the backend itself) has to create the
   dead-letter queue before the lane queues. On this run the harness provisioned it.
5. **`pg-boss` and `pg` are not declared in the product's root `package.json`**,
   although `pgboss-backend.mjs` imports them lazily. They are installed
   machine-locally (and stay out of git). The compatible version is `pg-boss@11`:
   v12 has no default export, which `const { default: PgBoss } = await import('pg-boss')`
   expects; v10 has no `getQueueStats`; v11 has no `touch` (but `touch` is not part
   of this loop — the preflight door neither spawns nor streams). A deployment
   should declare the runtime dependencies and pin a compatible pg-boss major.
