# SMA deck — paste-ready Claude Design prompt

The founder pastes the prompt below into claude.ai/design to generate the product
deck. Exported slide images land in `assets/deck/` and get embedded in README.md.
Keep this file in sync with the README's actual claims — the deck must never
promise features the repo does not ship.

---

Design a 10-slide product deck (16:9, 1280×720 per slide) for **SMA — Shared
Memory & Automation**, an open-source memory + coordination layer for AI coding
agents. Output ONE self-contained HTML file: each slide a full-viewport section,
arrow-key + click navigation, no external assets, all CSS/JS inline. Every slide
must also look correct as a standalone screenshot (they will be exported as PNGs
for the GitHub README).

## Brand system (follow exactly)

- Ground: near-black `#0A0D14`. Surfaces/cards: `#11151F` and `#161B28`,
  border `rgba(255,255,255,.08)`, radius 14px. Dark theme ONLY.
- Primary blue `#3B82F6` (deep `#2E6FD9`) · teal `#1FA0A6` (deep `#1B7E9C`) ·
  green `#3CC0A0` · light green `#74DBA0`. Muted text `#8CA3B8`, dim `#5A7186`,
  main text `#E6ECF4`.
- Signature gradient (left→right): `#243B66 → #1F5A86 → #1B7E9C → #1FA0A6 → #3CC0A0 → #74DBA0`.
- Logo mark (reproduce as inline SVG): three horizontal rounded bars, staggered
  (top bar shifted right, middle widest, bottom shifted left), colored along the
  gradient top-to-bottom (blue→teal→green), plus a small 4-point green spark
  floating at the top-right. On slide backgrounds the bars may appear as a huge,
  very-low-opacity background motif.
- Wordmark: "SMA" set in a bold geometric sans (Inter/Segoe UI, weight 800),
  wide letter-spacing, filled with the gradient. Subline "Shared Memory &
  Automation" in muted slate.
- Visual language: rounded cards, pill badges, thin borders, soft teal radial
  glows, generous whitespace. Stat callouts as "data chips" (big number + small
  caption). NO stock imagery, NO emoji, NO clip art, NO hype gradients beyond
  the brand gradient.
- Tone of copy: calm, precise, engineering-grade confidence. Short sentences.
  No exclamation marks, no "revolutionary/game-changing".
- Footer on every slide except the title: `github.com/sma-framework/sma` (left)
  and slide number (right), in dim color.

## The deck's job

Make a developer who runs AI coding agents daily feel, within 10 slides, that
working WITHOUT this layer is negligent — then show them the fix is one command.
The argument is evidence-first: real, cited pain → structural cause → the SMA
mechanism → proof discipline. Design ONLY what is described below; do not invent
features, numbers, or screens.

## Slides

**Slide 1 — Title.** Logo mark large, wordmark "SMA", subline "Shared Memory &
Automation". Tagline below: "The accountable memory & coordination layer for AI
coding agents." Small pill row: `plain files + git` · `no daemons` · `no
databases` · `MIT`. Background: faint giant bar motif.

**Slide 2 — Your agent is brilliant. And unaccountable.** Four pain cards in a
2×2 grid, each with a stat chip and one line:
- "Rules read, then dropped" — chip: `1,375 reactions` — the single
  most-upvoted Claude Code issue: explicit instructions acknowledged, then
  violated in the same session.
- "«Done» that isn't" — chip: `35%` — of engineering leaders won't ship
  AI-written code; agents report green tests the tree never saw.
- "Destroyed work" — chip: `60 hours` — lost to one agent-initiated
  `git reset --hard`; the pain that makes people quit forever.
- "Amnesia between sessions" — chip: `86K ★` — an entire cottage industry of
  memory bolt-ons exists only because agents forget everything.

**Slide 3 — Why this keeps happening.** One centered statement with a small
diagram: a model's working attention holds only ~a couple dozen active concepts
at once (cite: Anthropic interpretability research, 2026). Three consequences as
short lines: a rule not present AT THE MOMENT of the action does not exist ·
self-reports structurally under-describe internal state · big instruction files
lose to tiny timely ones. Visual: one bright bar (the workspace) vs a long faded
stack of rules that don't fit.

**Slide 4 — The bet.** Large statement: "Trust you can diff." Explanation in
three short cards: everything SMA knows is a markdown file in YOUR git repo ·
everything it enforces is a deterministic script you can run yourself · no
daemon, no database, no embeddings, no cloud. Small line: adopted in one
command, removed in one revert — a standard costs nothing to leave.

**Slide 5 — The loop.** Clean node-diagram (branded, not mermaid-default):
`Plan writes predictions` → `Agent acts` (with `Reflexes fire BEFORE the act`
feeding in) → `Deterministic scorer settles each prediction` → `Calibration
ledger (per-area hit rates)` → misses become `Lessons` → promoted lessons become
`Reflexes` (arrow looping back to the act). Caption: "One burn, permanent
avoidance — and the scorer is a script, so the loop cannot flatter itself."

**Slide 6 — Memory that arrives on time.** Three-layer visual using the bar
motif: `CORE — a few KB, every session` / `AREA INDEXES — loaded on topic` /
`REFLEXES — one lesson, delivered at the exact tool call`. Stat chip: `46KB →
5KB` always-loaded index after restructuring, with full recall preserved (a
standing benchmark gates it).

**Slide 7 — Coordination without a server.** Simple two-terminal illustration:
both register sessions, claim file scopes, draw shared counters (migration N,
release N) from one queue; a warning fires BEFORE the overlapping edit. Line:
"Parallel sessions stop surprising each other. The journal remembers who did
what."

**Slide 8 — Measured, not promised.** Show a mock (clearly labeled as
illustrative) calibration readout: per-area hit-rate bars and a recall-benchmark
score. Copy: "Every claim SMA makes about itself is a pre-registered prediction
settled by a script. Memory frameworks promise recall. SMA publishes its hit
rate."

**Slide 9 — Where this goes (V3).** Four roadmap pills, one line each, marked
"next": Receipts — every «done» carries a re-runnable command, not prose ·
Blind re-verification — a second agent re-derives «done» from the tree alone ·
Git airbag — a recovery snapshot before any destructive command · Calibration
passport — a public badge with the measured hit rate.

**Slide 10 — Close.** Logo mark. One command, huge, centered:
`npx sma-framework init`. Below: "Own your agent's memory." and the repo URL.
Pill row repeats: `plain files + git` · `no daemons` · `MIT`. Small dim credit
line at the bottom: "Created by Matvey Maslov".

## Quality bar

Consistent margins and type scale across slides; every stat chip visually
identical in construction; the gradient used sparingly (wordmark, one accent per
slide, diagram arrows); contrast AA on all text; slides must read at thumbnail
size (README embed). No content beyond what is specified.
