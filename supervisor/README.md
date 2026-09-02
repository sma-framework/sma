# supervisor/

Host-supervisor unit templates for the SMA V5 daemon (the runner is
host-agnostic by design; the OS binding is a thin supervisor layer only).

- **macOS:** launchd LaunchAgent template (`com.sma.daemon.plist`), the
  first-boot checklist (`setup-macos.md`, Russian twin `setup-macos.ru.md`), and
  the cross-platform verb + host portability smoke (`smoke-macos.mjs`) — the
  FIRST post-clone setup step.
- **Windows:** Task Scheduler harness (`sma-daemon-windows.task.xml`,
  `start-daemon-windows.ps1`), setup checklist (`setup-windows.md`, Russian twin
  `setup-windows.ru.md`), and the live contour smoke (`live-smoke-windows.mjs`).
- **The daily log, and the proof that it rotates:** the wrapper lives as long as the
  daemon does, so which day a line belongs to is decided PER LINE, in one place —
  `daemon-log-day.ps1`. `log-rotation-drill.ps1` drives that same writer across a
  midnight in a second (it moves the clock the writer reads instead of waiting for one)
  and prints a JSON verdict naming both day files, so the rotation is confirmed by a run
  rather than by reading the source:
  `powershell -NoProfile -ExecutionPolicy Bypass -File supervisor/log-rotation-drill.ps1`.
  **That midnight is the LOCAL one, and all three day logs turn on it.** `daemon-lift-<day>.log`
  and `daemon-watch-<day>.log` are named by `dayLogPath()` in `lift-log.mjs`, which stamped the
  day in UTC and so rotated at 02:00 local east of Greenwich: the lift of the night of 30→31.08
  was filed under the 30th while the wrapper it started wrote into the 31st — one event, two
  days, and the operator opening the night's files found the lift in none of them. The day is
  now read off the same wall clock the wrapper's `Get-Date` reads, and a case in
  `scripts/sma/__tests__/daemon-log-rotation.test.ts` asks both implementations about the same
  instant and requires the same answer. Timestamps INSIDE a line stay UTC, as everywhere else.
- **Linux (deferred):** systemd unit — the daemon core is already host-neutral, so
  this is add-only.
- **Host-neutral, both ways:** `daemon-control.mjs` — the STOP and the RESTART that
  belong beside those lifts (`npm run daemon:stop` / `npm run daemon:restart`). It
  identifies the daemon by its own record plus the door address in the config, never
  by a binary name, refuses a stop that would kill a live attempt unless `--force`
  says so, and reports a restart by waiting on the door rather than on the spawn.
  The reasoning lives at the top of `daemon/src/control.mjs`.

- **The half that watches while nobody is looking:** `daemon-watch.mjs` (`npm run daemon:watch`).
  The two lifts above bring the daemon up and `daemon-control.mjs` takes it down again — both by
  hand. Nothing noticed a daemon that DIED, and nothing could: the window is the daemon's own web
  face and the Telegram polling is the same process, so one death takes both channels at once and
  reads as silence. The watchdog knocks on the door, declares a fall only after several silences in
  a row (the hour it records is the FIRST one), tells the owner in Telegram — there is nobody else
  left to say it — and runs the same lift the supervisor uses. It will not resurrect a daemon that
  was stopped on purpose: an orderly stop removes the process record and a crash leaves it behind,
  and that difference is what it reads. It never says «it is back up»: that word belongs to the
  risen daemon, which says it after knocking on its OWN door (`daemon/src/outage.mjs`) and closes
  the outage with a receipt carrying every time. The decision table lives in `daemon/src/watch.mjs`
  and is proved with no process, no socket and no Telegram.
- **But a started lift has no outcome yet, and the watchdog now waits for one.** «The spawn call did
  not throw» is not «the daemon is coming back»: the lift is detached, so a launch that never
  happened is invisible unless someone goes and looks at the door. A started lift is recorded as
  `pending`; the outcome is named by the door (`up` inside the allowed window, `no-door` past it), a
  failure is a SECOND message to the owner carrying the reason, and retries are spaced with a
  doubling wait and capped — after the last one the watchdog stops and calls the owner instead of
  looping. The output of every lift lands in `daemon-lift-<day>.log` beside the daemon's log, on
  every platform: `lift-log.mjs` owns that one spawn for both the watchdog and `daemon-control.mjs`,
  because where the output goes is a property of the lift and not of each caller.
- **On Windows the lift is one hop longer, because «detached» there means «no console»:**
  `lift-daemon-windows.ps1`. Detachment is what lets the caller report and exit while the daemon
  lives on, and for a node composition root the flag does exactly that; on Windows libuv turns it
  into DETACHED_PROCESS, the kernel is told the child must have NO console, and Windows PowerShell
  5.1 cannot start without one. Measured 02.09.2026, three lifts in a row: the process was created,
  exited 0 in milliseconds, ran not one line of `start-daemon-windows.ps1` and wrote nothing to
  stdout, stderr or any log — `daemon-lift-<day>.log` held the «lifting» line and silence. So the
  Windows lift is NOT detached: a short-lived launcher starts the real wrapper hidden, with its two
  streams redirected to `daemon-lift-<stamp>.out.log` / `.err.log`, prints the pid and echoes the
  first lines of the boot back into the daily lift log. The daemon's independence comes from that
  hidden start — Windows does not kill a child when its parent exits. Which platform detaches is
  carried by the lift command itself (`liftCommand`), so the choice cannot drift apart from the
  spawn that acts on it. And the exit of a lift is now logged ALWAYS, code 0 included, with how
  long it lived: a start that «succeeded» in twenty milliseconds is the evidence, and the old
  «success is silent» condition swallowed exactly it.
- **`lift-drill.mjs` proves that path on a real machine without stopping anything**
  (`node supervisor/lift-drill.mjs`). The failure above is invisible to unit tests by nature — it
  is not in the decision to lift, it is in how the operating system creates the process — so the
  drill calls the very same `liftCommand` + `spawnLiftLogged` a restart calls, and fails unless the
  lift log ends up holding a pid and lines from the wrapper itself. It leaves a live daemon alone:
  the wrapper's first act is to look at the door and stand down when somebody is already serving.
  What it therefore does NOT cover is the cold start, which needs a closed door.
- **And a daemon that is ALIVE can still be dead to everyone outside it.** Measured: the process
  was up (56 MB, CPU running) while `GET /` hung to the timeout three probes in a row, and the jam
  held for ten minutes with the watchdog running. The watchdog was not broken — it declared the
  fall and started three lifts. There was simply nowhere to lift *to*: the port was held by the very
  process that had stopped answering, so every lift lost the race for one address. So «alive, and the
  door has been silent for a series of knocks» is now called a death and treated as one: **stop
  first, lift second**, and never by hunting the process table — the process is named by its own
  record, exactly as `daemon-control.mjs` names it. Two measurements bound the patience. The door's
  own latency under load is recorded in the code (`MEASURED_DOOR_LATENCY_MS`) and one knock waits a
  multiple of it, because a watchdog that kills healthy daemons is worse than no watchdog; and the
  first minutes after a lift are the daemon's start-up sweep of old working copies (~45 s measured,
  up to ~2 minutes observed), which is «loading», not «jammed» — the difference is read from the
  recorded start time of the process, not guessed. The boot now opens the door BEFORE that sweep
  rather than after it, so the silence the watchdog had to forgive is largely gone at the source.
- **And the watchdog gets a unit of its own,** because a watchdog started from a terminal lives
  exactly as long as that terminal: `sma-daemon-watch-windows.task.xml` (at logon, two minutes
  after the daemon's own task, with `RestartOnFailure` under it) and its macOS twin
  `com.sma.daemon-watch.plist` (`KeepAlive`). Both are **shipped disabled**, like every unit in
  this folder. On the Mac the daemon's own plist already relifts it, so what the watchdog adds
  there is the TELLING — between the death and launchd's relift both channels are silent, and
  that silence is indistinguishable from a quiet afternoon.
- **And that unit is installable without an administrator** — `install-watch-windows.mjs`
  (`node supervisor/install-watch-windows.mjs`, plus `status` and `remove`). On the reference
  Windows host the Scheduled Task above cannot be registered at all: `schtasks /Create` and
  `Register-ScheduledTask` both answer «Access is denied» from an ordinary session, and the
  watchdog was living in a hand-made Startup shortcut with its loop typed inside an argument
  string. The command tries the task FIRST (it is the better unit), **names the refusal in
  words** instead of swallowing it, and only then writes the shortcut — asking Windows itself
  where the Startup folder really is, because a shortcut written to a computed path on a
  roaming profile is silence rather than a watchdog. It then starts the circle as a detached
  process that outlives the window it was installed from, and calls it running only once the
  circle has taken its lock. The circle itself is `watch-loop.mjs`: the delay before the first
  look, the restart of a fallen watchdog with a ceiling, and one watchdog per machine — the
  three properties of the Scheduled Task, so the no-admin route is a route and not a downgrade.
  The decision table lives in `daemon/src/watch-install.mjs` and is proved with no process, no
  scheduler and no shortcut.
- **And the proof that the whole chain happens:** `live-outage-drill.mjs` boots a real daemon on a
  scratch queue of its own, kills the process outright, and watches the fall, the lift, the return
  and both messages on real sockets — the send is the real client pointed at a stand-in Bot API, so
  nothing lands in the owner's chat. `--window` drives the built window against a deliberately dead
  door through `ui-drive` and reads the words off the screen; `--all` runs both acts:
  `node supervisor/live-outage-drill.mjs --all`.

This directory ships with the product (root `package.json` `files[]` allowlist) so
an adopter installing the daemon also gets the supervisor templates.
