# Worktree base policy (B15 — the #683 stale-base class, fixed as engine default)

Run this policy for **every wave that dispatches worktree-isolated executors**. It exists
because worktree creation on Windows is observably unreliable: the worktree branch is
sometimes created from a commit OLDER than the orchestrator's HEAD at spawn time (observed
3/4 worktrees in one phase, 3/3 in another run). An executor then writes new code on a
stale base and the merge back produces conflicts on every shared file — which historically
degraded whole phases to sequential execution (a 3-5x wall-clock loss). The fix is a
policy, not a hope: pin the base, verify creation, force-reset on mismatch, and never
reuse a worktree.

## Rule 1 — baseRef pin + verify-then-force-reset (never trust creation)

The orchestrator resolves HEAD **once per wave**, before the first dispatch of that wave:

```bash
PINNED_BASE=$(git rev-parse HEAD)
```

Every worktree in the wave MUST be created at exactly `$PINNED_BASE`. Pass it explicitly
(as `EXPECTED_BASE`) into each executor prompt's worktree-branch-check anchor.

**After each worktree is created — and BEFORE the executor writes a single line — the
orchestrator VERIFIES the actual base and FORCE-RESETS on mismatch:**

```bash
ACTUAL_BASE=$(git -C "$WORKTREE_PATH" rev-parse HEAD)
if [ "$ACTUAL_BASE" != "$PINNED_BASE" ]; then
  echo "worktree-policy: base mismatch for $WORKTREE_PATH — actual $ACTUAL_BASE, pinned $PINNED_BASE. Force-resetting (#683 class)."
  git -C "$WORKTREE_PATH" reset --hard "$PINNED_BASE"
  # Re-verify after the reset — a second mismatch is fatal, not retryable.
  ACTUAL_BASE=$(git -C "$WORKTREE_PATH" rev-parse HEAD)
  [ "$ACTUAL_BASE" = "$PINNED_BASE" ] || { echo "FATAL: worktree $WORKTREE_PATH cannot be pinned to $PINNED_BASE" >&2; exit 1; }
fi
```

Notes:
- `reset --hard` (NOT `--soft`): on Windows the working-tree files do not match the new
  base after a soft reset, so the executor still starts from stale content. Hard reset is
  the only recovery strong enough — proven in live incident recovery.
- The reset is scoped to the worktree via `git -C "$WORKTREE_PATH"` — it never touches
  the orchestrator's own tree or any protected branch.
- The executor side keeps its VERIFY-ONLY branch check (halt with `exit 42`, no
  self-recovery). Recovery is the ORCHESTRATOR's job because it owns the worktree
  lifecycle: on an executor base-mismatch report, run the same
  `git -C <worktree> reset --hard $PINNED_BASE`, verify HEAD + the plan file are present,
  then tell the same agent to re-run its check and proceed — no re-spawn cost.

## Rule 2 — per-wave re-fork (never reuse a worktree)

Worktrees are created **fresh at the start of each wave** and **removed after that
wave's merge** (the standard cleanup step). A worktree is NEVER carried into the next
wave: after wave N merges to the orchestrator branch, any surviving wave-N worktree is
by definition on a stale base relative to the new HEAD — reusing it recreates the exact
#683 failure the pin exists to prevent. Wave N+1 resolves a fresh `PINNED_BASE` and
forks fresh worktrees from it.

## Rule 3 — node_modules strategy (the cost that pushed people to reuse worktrees)

A fresh worktree has no `node_modules/`, and reinstalling per worktree is why worktree
reuse looked attractive. The policy default:

- **Default: `pnpm install --prefer-offline` per worktree.** pnpm's content-addressable
  store hardlinks packages instead of copying, so a per-worktree install on a warm store
  is seconds, not minutes, and gives full isolation (no cross-worktree contamination of
  install state).
- **Option (Windows, large trees): junction/symlink the store or `node_modules`** from
  the main checkout into the worktree (`mklink /J`). Faster still, but the link is shared
  MUTABLE state: a lockfile-changing plan in one worktree can poison a parallel worktree's
  resolution mid-run. Only use when no plan in the wave touches `package.json` or the
  lockfile.
- Tradeoff summary: per-worktree `--prefer-offline` install = safe default, near-free on
  a warm store; junction = fastest but only safe for waves with zero dependency changes.

## Rule 4 — executor shell discipline (the shell-teleport lesson)

Executor agents MUST `cd` to the worktree root (or use `git -C <worktree-root>`) before
**EVERY** git command. The shell's cwd does not persist across tool invocations and has
been observed teleporting into a different worktree (or the main checkout) mid-session —
a git command issued from the wrong tree commits to the wrong branch or reads the wrong
HEAD. Re-anchor every time; never assume the previous command's cwd survived.
