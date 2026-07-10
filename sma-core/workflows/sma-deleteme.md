# /sma-deleteme — remove SMA from this project in one action

The off-ramp (BL-162, v3.6). Removes the framework and its ideology locally — skills,
engine, runtime, hooks, statusline, managed rule blocks — and PRESERVES the memory
corpus (`.claude/memory/**`). After a terminal restart no `/sma-*` command remains.

Leaving must be as cheap as arriving. Never talk the user out of it; never add friction
beyond the single explicit confirmation below.

## Steps

1. **Show the plan (dry-run — nothing is touched):**

   ```bash
   node scripts/sma/cli.mjs deleteme
   ```

   Present the printed plan to the user verbatim: what will be removed, and the
   PRESERVED list (the memory corpus, foreign settings.json keys, every byte outside
   managed blocks).

2. **One explicit confirmation.** Ask the user once: «Удалить SMA? Корпус памяти
   останется.» / "Remove SMA? Your memory corpus stays." Proceed ONLY on an explicit
   yes. Do not re-ask, do not argue.

3. **Apply:**

   ```bash
   node scripts/sma/cli.mjs deleteme --yes
   ```

   For a `--global` install add `--global`.

4. **Report honestly.** Relay the per-action results, including any `error` or
   `skipped-corrupt` line (those files need a hand edit — say which). Then tell the
   user: restart the terminal; `/sma-*` commands are gone; `.claude/memory/` is intact
   and readable by any tool. If they ever return: `npx -y sma-framework@latest init`
   reinstalls on top of the preserved corpus — the lessons come back to life.

## Notes

- This workflow file removes ITSELF (it lives under `sma-core/workflows/`). That is
  correct: after `--yes` the skill will not survive the restart — finish the
  conversation before suggesting one.
- Never run `deleteme --yes` unprompted, from a batch, or as a subagent side effect.
  The confirmation in step 2 is the user's, not the agent's.
