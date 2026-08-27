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
- **Linux (deferred):** systemd unit — the daemon core is already host-neutral, so
  this is add-only.
- **Host-neutral, both ways:** `daemon-control.mjs` — the STOP and the RESTART that
  belong beside those lifts (`npm run daemon:stop` / `npm run daemon:restart`). It
  identifies the daemon by its own record plus the door address in the config, never
  by a binary name, refuses a stop that would kill a live attempt unless `--force`
  says so, and reports a restart by waiting on the door rather than on the spawn.
  The reasoning lives at the top of `daemon/src/control.mjs`.

This directory ships with the product (root `package.json` `files[]` allowlist) so
an adopter installing the daemon also gets the supervisor templates.
