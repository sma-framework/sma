# supervisor/

Host-supervisor unit templates for the SMA V5 daemon (D-9.5-02a: the runner is
host-agnostic by design; the OS binding is a thin supervisor layer only).

- **Mac mini (first host, D-9.5-02b):** launchd plist template
  (`com.sma.daemon.plist`) — added in a later wave.
- **Windows / Linux (deferred):** NSSM service / systemd unit — the daemon core is
  already host-neutral, so these are add-only.

This directory ships with the product (root `package.json` `files[]` allowlist) so
an adopter installing the daemon also gets the supervisor templates.
