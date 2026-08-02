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

- **Node.js 18.17 or newer** and **git** on PATH. The daemon uses only Node's
  built-in modules plus `pg-boss` — it is plain node, so your project's own
  conflicts over Node or framework versions never reach it.
- **A local Postgres for the queue on :5433.** Create a `~/pg-sandbox` sandbox
  (embedded-postgres, PG18): a directory with a `start.mjs` boot script that
  brings an embedded Postgres up on :5433. Run it with
  `cd ~/pg-sandbox && node start.mjs` (the server backgrounds itself; running it
  again is harmless). This needs no administrator rights, no docker, and no
  installed Postgres server.
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
- `workers` — for this PC, a single honest local worker:

  ```json
  { "id": "local-1", "lane": "prod", "provider": "claude",
    "account": { "name": "local-1", "configDir": "C:\\Users\\<you>\\.sma-accounts\\local-1",
                 "oauthTokenEnv": "SMA_LOCAL_1_TOKEN", "spendLogsDir": "C:\\Users\\<you>\\.sma-accounts\\local-1\\spend" },
    "enabled": true }
  ```

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
cd ~/pg-sandbox; node start.mjs      # bring :5433 up (harmless if already running)
cd <SMA_HOME>
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
