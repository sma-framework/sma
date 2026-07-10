<purpose>
One-page newcomer-oriented tour of SMA Core. Output ONLY the `<reference>` content below. No additions.
</purpose>

<reference>
# SMA Core — Git. Ship. Done.

Plan-driven development for solo agentic work with Claude Code. SMA Core turns a vague idea into a hierarchical plan, then executes it phase by phase with state tracking and atomic commits.

## Start here (3 commands)

```text
/sma-new-project        # Greenfield: questioning → research → requirements → roadmap
/sma-plan-phase 1       # Create a detailed plan for phase 1
/sma-execute-phase 1    # Execute all plans in the phase
```

Existing codebase? Run `/sma-map-codebase` first to ground SMA in your code.

## Common commands

| Command | Purpose |
|---|---|
| `/sma-progress` | Where am I, what's next — also routes freeform intent with `--do "..."` |
| `/sma-quick` | Small ad-hoc task with SMA guarantees (planning dir + atomic commit) |
| `/sma-fast "<task>"` | Trivial inline change — no subagents, ≤3 file edits |
| `/sma-discuss-phase <N>` | Capture vision and decisions before planning |
| `/sma-debug "<symptom>"` | Persistent debug session, survives `/clear` |
| `/sma-capture` | Save an idea, todo, note, seed, or backlog item |
| `/sma-verify-work <N>` | Conversational UAT for a completed phase |
| `/sma-ship <N>` | Open a PR from a completed phase |
| `/sma-help --full` | Complete reference (every command, every flag) |

## Want more?

```text
/sma-help --brief         # 10-line refresher of top commands
/sma-help --full          # complete reference
/sma-help <topic>         # one section only — see topics below
/sma-help --brief <topic> # compact scoped lookup — signature + one-line summary
```

Topics: `workflow` · `planning` · `execute` · `quick` · `debug` · `capture` · `ship` · `config` · `milestones` · `spike` · `sketch` · `review` · `audit` · `progress`

## Update SMA

```bash
npx sma-framework@latest
```
</reference>
