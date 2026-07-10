# SMA statusline segment (D-49-03)

A persistent «SMA: N сессий · M коллизий» indicator for the Claude Code statusline.
It reads the local `.sma/` files **directly** (`fs.readFileSync` only — no network, no
child process, no CRM round-trip), so it adds zero latency and works offline. The whole
segment is wrapped in `try/catch` and returns an **empty string** on ANY error — a
statusline must never crash the prompt.

## Where it goes (machine-local, NOT committed)

The live statusline script is the machine-local `~/.claude/statusline.js`
(`C:/Users/<you>/.claude/statusline.js` on Windows). That file is **not** committed to
this repo and must **never** live in `~/.claude/local` (the Claude Code updater wipes
that directory — see the `reference_custom_statusline` memory). This document is the
committed source of truth; each machine applies the snippet below to its own
`~/.claude/statusline.js`.

`N` = fresh sessions (a `.sma/sessions/*.json` whose `renewTime` is within its
`leaseDurationSeconds` TTL). `M` = collision events in **today's** journal tails (a
`.sma/journal/*.jsonl` line whose `type` is `collision` or `warn`). Both default to `0`
when `.sma/` is absent (a repo without SMA active shows nothing).

## The snippet

Add this helper and call it where the statusline assembles its `parts` array. It takes
the repo root (derive it from the session `cwd` the statusline already receives on stdin,
or hard-code the checkout path on a single-project machine).

```javascript
// ── SMA segment (D-49-03): direct .sma/ read, no network, empty string on ANY error ──
const fs = require("node:fs");
const path = require("node:path");

function smaSegment(repoRoot) {
  try {
    const smaDir = path.join(repoRoot, ".sma");
    // (1) N — fresh sessions: renewTime within leaseDurationSeconds TTL.
    let sessions = 0;
    try {
      const sdir = path.join(smaDir, "sessions");
      for (const f of fs.readdirSync(sdir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const s = JSON.parse(fs.readFileSync(path.join(sdir, f), "utf8"));
          const renew = Date.parse(s.renewTime);
          const ttlMs = (Number(s.leaseDurationSeconds) || 1800) * 1000;
          if (Number.isFinite(renew) && Date.now() - renew < ttlMs) sessions++;
        } catch {} // one bad session file never breaks the count
      }
    } catch {} // no sessions/ dir → 0

    // (2) M — collisions in TODAY's journal tails (type 'collision' or 'warn').
    let collisions = 0;
    try {
      const jdir = path.join(smaDir, "journal");
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      for (const f of fs.readdirSync(jdir)) {
        if (!f.endsWith(".jsonl")) continue;
        try {
          const lines = fs.readFileSync(path.join(jdir, f), "utf8").split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const e = JSON.parse(line);
              if (
                typeof e.ts === "string" &&
                e.ts.slice(0, 10) === today &&
                (e.type === "collision" || e.type === "warn")
              ) {
                collisions++;
              }
            } catch {} // a torn append line never breaks the count
          }
        } catch {}
      }
    } catch {} // no journal/ dir → 0

    if (sessions === 0 && collisions === 0) return ""; // nothing to show
    return `SMA: ${sessions} сессий · ${collisions} коллизий`;
  } catch {
    return ""; // a statusline must NEVER crash the prompt (D-49-03)
  }
}
```

Then, in the stdin `"end"` handler where the existing `parts` are pushed, add (colored to
match the house palette — a dim/cyan segment fits the existing `ctx | 5h | 7d` line):

```javascript
  // repoRoot: derive from the session cwd Claude Code sends on stdin, falling back
  // to the statusline process cwd (single-project checkouts may hard-code theirs).
  const CYAN = "\x1b[38;5;80m";
  const repoRoot =
    (data.workspace && data.workspace.current_dir) ||
    (data.cwd) ||
    process.cwd();
  const sma = smaSegment(repoRoot);
  if (sma) parts.push(`${CYAN}${sma}${RESET}`);
```

## Verify after applying

```bash
# feed the same stdin shape Claude Code sends; the script must print without throwing.
echo '{"context_window":{"used_percentage":10}}' | node ~/.claude/statusline.js
```

The SMA segment appears only when there is at least one fresh session or a collision
today; otherwise it is silently omitted (empty string), leaving the base line unchanged.
