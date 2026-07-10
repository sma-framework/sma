# HARD-RULE checkability inventory (D-49.1-12)

This is the planner-resolved "точная инвентаризация" the D-49.1-12 decision defers to
planning: a structured pass over this checkout's `CLAUDE.md` HARD-RULE list, splitting
each rule into **deterministically checkable** (ships now as a PreToolUse gate) vs
**needs human judgment** (stays prose / skill-level). It is the paper contract that
`scripts/sma/lib/gates.mjs` implements.

**Posture (D-49.1-12, non-negotiable in this wave):** every gate below is **advisory
WARN only** — `permissionDecision` is ALWAYS `allow`. The soft-deny tier is 49.1-17's
separately-gated mechanism, never introduced here. `gates-check` is HOOK_FACING and
fail-open: a gate bug can never wedge a session (scorecard metric 7).

Every sensitive command literal in `gates.mjs` is assembled via the SMA-3 escaped-verb
isolation (`['verb'].join('')`), exactly as the push-claim channel in `cli.mjs` does, so
this source tree never carries the adjacent dangerous literal.

## CHECKABLE — ship as gates now (all WARN)

| Gate id | Tool match | Trigger matcher | WARN text (rule + correct alternative) | Kill env | Journal fields |
|---------|-----------|-----------------|----------------------------------------|----------|----------------|
| `GATE-PUSH` | Bash | `git` + the deploy verb (escaped regex) | push detected -> run the full gate (`pnpm test` + `pnpm tsc --noEmit`), review `git log origin/main..main`, assign the next `V1.N` tag; push only on the founder's explicit word | `SMA_GATE_PUSH_OFF` | `{type:'gate', gateId, target, terminal}` |
| `GATE-ADDALL` | Bash | `git add` + `-A` / `--all` / bare `.` | bulk stage banned on the shared tree (can capture a parallel terminal's files) -> stage explicitly: `git add path/to/file` | `SMA_GATE_ADDALL_OFF` | same |
| `GATE-STASH` | Bash | `git` + the stash verb (escaped) | stash banned — the stash stack is shared across every worktree, you will apply another window's WIP -> commit to a throwaway branch (`git checkout -b scratch-<task>-wip` + explicit adds) or read via `git show <ref>:<path>` | `SMA_GATE_STASH_OFF` | same |
| `GATE-MEMEDIT` | Edit/Write | path is `.claude/memory/MEMORY.md` or `.claude/memory/INDEX-*.md` | those files are GENERATED — a hand edit is lost on rebuild -> edit the source notes in `.claude/memory/` and rerun `pnpm sma build-index` | `SMA_GATE_MEMEDIT_OFF` | same |
| `GATE-DODHONESTY` | Edit/Write | path ends `-DOD.json` AND the new content pairs `"kind":"human"` with `"status":"pass"` in one dimension object | a human DoD gate is flipped to `pass` only by the founder in `/crm/projects`, never a file write -> leave human dimensions at `status: pending` | `SMA_GATE_DODHONESTY_OFF` | same |
| `GATE-NEXTBUILD` | Bash | `next` + the build verb (escaped), or `(pnpm\|npm\|yarn) [run] build` | local `next build` / `pnpm build` banned (slow, holds the `.next` lock) -> push and let Railway build; fix forward on the CI build | `SMA_GATE_NEXTBUILD_OFF` | same |
| `GATE-CHECKOUT` | Bash | `git checkout --` (escaped) or `git restore` (escaped) | a blanket `git checkout --` / `git restore` on the shared tree can destroy a parallel terminal's uncommitted work -> capture `git diff` first, revert only your specific file | `SMA_GATE_CHECKOUT_OFF` | same |
| `GATE-MIGNUM` | Edit/Write | path is `src/migrations/index.ts` | the migration NUMBER must come from `pnpm sma next-slot migration`, never chosen by hand (collision on the shared tree) | `SMA_GATE_MIGNUM_OFF` | same |

Global kill switch: `SMA_GATES_DISABLE=1` silences every gate. Per-session dedup reuses
the reflex fatigue store under a `gate:` key prefix (a gate fires once per session per
`gate:<id>::<target>`), so a repeated edit to the same file does not re-nag.

## NOT deterministically checkable — stays prose / skill-level

| Rule | Why it needs a human (one line) | Where it lives |
|------|---------------------------------|----------------|
| Design-prompt-first for front-facing work | "Is this surface front-facing?" is a judgment about the change's intent, not a matchable path/command | prose HARD RULE + the design-SoT lockstep |
| Plain-language for non-tech audience | Whether prose reads clearly to a non-engineer is a semantic quality call, not a regex | prose HARD RULE (rewrite-on-review) |
| Compliance-defer / regulated-data handling | "Is this field/route regulated data?" is semantic; the security-regression-guard owns its concrete sub-checks (never-log, encryption-at-rest, fail-closed routing) | security-regression-guard skill |
| Versioned-release changelog quality | Whether a changelog is "plain enough for the founder" is a judgment; the mechanical `V1.N` tag steps live in the ship ritual | `/sma-ship` workflow |

## Evidence loop (D-49.1-13 promotion)

Every gate fire is journaled (`type:'gate'`), so `gates-report` can surface per-gate fire
counts and false-positive acks. That fire+ack ledger is the promotion evidence D-49.1-13
needs before any gate graduates from WARN to the soft-deny tier in 49.1-17. A gate with
persistent false positives is fixed or kept WARN; it is never promoted on volume alone.
