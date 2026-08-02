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

This directory ships with the product (root `package.json` `files[]` allowlist) so
an adopter installing the daemon also gets the supervisor templates.
