---
name: sma-ideate
description: "exploration capture | explore sketch spike spec capture"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [capture, explore, sketch, spike, spec-phase]
---

Route to the appropriate exploration / capture skill based on the user's intent.
`sma-note`, `sma-add-todo`, `sma-add-backlog`, and `sma-plant-seed` were folded
into `sma-capture` (with `--note`, default, `--backlog`, `--seed` modes) by
#2790. The capture target lists pending todos via `--list`.

| User wants | Invoke |
|---|---|
| Explore an idea or opportunity | sma-explore |
| Sketch out a rough design or plan | sma-sketch |
| Time-boxed technical spike | sma-spike |
| Write a spec for a phase | sma-spec-phase |
| Capture a thought (todo / note / backlog / seed) | sma-capture |

Invoke the matched skill directly using the Skill tool.
