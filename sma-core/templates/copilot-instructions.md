# Instructions for SMA

- Use the sma-core skill when the user asks for SMA or uses a `sma-*` command.
- Treat `/sma-...` or `sma-...` as command invocations and load the matching file from `.github/skills/sma-*`.
- When a command says to spawn a subagent, prefer a matching custom agent from `.github/agents`.
- Do not apply SMA workflows unless the user explicitly asks for them.
- After completing any `sma-*` command (or any deliverable it triggers: feature, bug fix, tests, docs, etc.), ALWAYS: (1) offer the user the next step by prompting via `ask_user`; repeat this feedback loop until the user explicitly indicates they are done.
