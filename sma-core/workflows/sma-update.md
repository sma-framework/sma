# /sma-update — check versions and update SMA through the standard installer

The consumer-side updater. It pulls the available versions, compares them against
the installed one, shows what the situation is, and — only after the user says yes —
re-runs the ONE standard installer. Everything local is preserved by the installer
itself: the memory corpus (`.claude/memory/**`), the `.sma/` state including
`profile.json`, every foreign `settings.json` key, every user byte of CLAUDE.md.

## Steps

1. **Show the version report (dry-run — nothing is touched):**

   ```bash
   node scripts/sma/cli.mjs update
   ```

   Present the printed report to the user verbatim: the installed version (read from
   the install's own stamp), the npm `latest`, and — when a local product checkout was
   detected next to the project — its version, clearly labeled as the local source.

   Relay the honest edge cases exactly as printed:
   - an unreachable npm registry is a report line, not an error to apologize for;
   - an installed version NEWER than a source means a local-source install — say
     "newer", never "a downgrade is available".

2. **Decide whether an update applies.** If every reachable source says `up-to-date`
   (актуально) or `installed-newer`, tell the user they are current (or ahead) and
   stop — do not push an unnecessary reinstall.

3. **One explicit confirmation.** When an update IS available, ask once:
   «Обновить SMA до <version>? Корпус памяти, профиль и состояние .sma останутся.» /
   "Update SMA to <version>? Your memory corpus, profile, and .sma state stay."
   Proceed ONLY on an explicit yes.

4. **Apply:**

   ```bash
   node scripts/sma/cli.mjs update --yes
   ```

   To update from the detected local checkout instead of npm add `--source local`;
   for a `--global` install add `--global`. This re-runs the standard installer —
   the update command itself writes nothing.

5. **Report honestly.** Relay the installer's own output and exit code. On success:
   restart the terminal to pick up the refreshed `/sma-*` commands; the memory
   corpus, profile, and `.sma/` state are untouched. On failure: show the error
   verbatim — do not claim the update happened.

## Notes

- Never run `update --yes` unprompted or as a subagent side effect. The
  confirmation in step 3 is the user's, not the agent's.
- The `--yes` path refuses to install a version OLDER than the installed one; a
  deliberate rollback is a manual installer run, outside this workflow.
