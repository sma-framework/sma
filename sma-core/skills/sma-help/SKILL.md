---
name: sma-help
description: "Show available SMA commands and usage guide"
argument-hint: "[--brief | --full | <topic> | --brief <topic>]"
allowed-tools:
  - Read
---

<objective>
Display SMA help at the tier the user asked for: brief (one-line refresher), default (one-page tour), full (complete reference), a single topic section, or a compact scoped lookup of one topic (`--brief <topic>`: signature + one-line summary).

Output ONLY the reference content of the chosen tier. Do NOT add:
- Project-specific analysis
- Git status or file context
- Next-step suggestions
- Any commentary beyond the reference
</objective>

<execution_context>
@~/.claude/sma-core/workflows/help.md
</execution_context>

<context>
Arguments: $ARGUMENTS
</context>

<process>
Follow ~/.claude/sma-core/workflows/help.md with $ARGUMENTS.
</process>
