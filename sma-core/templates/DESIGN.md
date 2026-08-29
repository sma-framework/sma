---
phase: {N}
slug: {phase-slug}
version: 1
date: {date}
mode: wireframe
checker_verdict: PASS
verdict_reasons: none
---

# Phase {N} — Design Contract

> What this unit of work will look like and how it will behave, agreed BEFORE code.
> Drafted in the design stage, checked by `sma-ui-checker` before the gate, confirmed by a
> person at the gate. Execution does not start until this file is confirmed.

**Front matter fields:**

| Field | Values | Meaning |
|-------|--------|---------|
| `version` | integer, starts at `1` | Bumped by one every time this contract is redrafted. Never reused. |
| `mode` | `wireframe` \| `system` \| `mixed` | `wireframe` — the work changes screens. `system` — the work has no screens and the design is the shape of the machinery. `mixed` — both. |
| `checker_verdict` | `PASS` \| `FLAG` \| `BLOCK` | The checker's verdict, written here BEFORE a person is asked to confirm. |
| `verdict_reasons` | one line per finding, `none` on PASS | Kept verbatim on `FLAG` and on `BLOCK`. A verdict is never quietly upgraded — the person reads what the checker actually said. |

---

## Sketch files

The sketch files live in this phase folder **forever**. They are the record of what was
agreed: any person or agent can open them later and see the thing itself, not a description
of it. Paths below are relative to this file.

| File | Kind | What it shows |
|------|------|---------------|
| `{padded_phase}-design-{name}.html` | self-contained HTML — inline CSS, no external assets, no network | {screen or state} |
| `{padded_phase}-design-{name}.png` | snapshot of the HTML beside it | {screen or state} |
| `{padded_phase}-design-{name}.dc.html` | canvas sketch, editable by eye in the design tool | {screen or state} |

Rules:

- **Self-contained.** The HTML opens from disk with no build step, no CDN, no font fetch.
  A sketch that needs a server is not a sketch a reviewer can open.
- **A snapshot for every HTML sketch.** When no browser driver is available in the session,
  write `snapshot: not taken (no driver)` in the row. Never name a file that does not exist.
- **`system` mode has no sketch files.** Write `none — system mode` and fill the section below.

---

## System design

Required in `system` mode, optional in `mixed`, omitted in `wireframe`.

A diagram — mermaid or ASCII — that answers three questions: **who talks to whom**, **where
the truth lives**, and **which states exist**.

```
{diagram}
```

Then the explanation, **half a page at most**. Longer than that means the design is not
settled yet — settle it, do not describe it at greater length.

{explanation}

---

## Contract points

Each row is one checkable statement for the executor and for QA — an assertion someone can
be right or wrong about, never a wish. The three columns are the three classes every design
point falls into; a row may leave a cell empty when that class does not apply to it.

**Points are derived FROM the confirmed sketch, not the other way round.** The sketch is the
source; this table reads it back in words so a machine-checkable claim exists for each part
of it.

| # | What stands where | What the person does | What must not be there |
|---|-------------------|----------------------|------------------------|
| 1 | {element, its place, its state} | {the action, and what answers it} | {the thing whose presence fails this contract} |

---

## Motion

| Transition | Duration | Trigger |
|------------|----------|---------|

Empty by default, and an empty table is a complete answer. **Motion is described only where
motion exists** — the animator joins the work on a non-empty table and stays out otherwise.

---

## Versioning

- The current contract always lives at **`{padded_phase}-DESIGN.md`**. That is the name the
  gate looks for, and it is the only name the gate can see.
- Before drafting a new version, the current file is archived to
  **`{padded_phase}-DESIGN.v{K}.md`** — `K` = the next free integer. The archived name
  contains a dot, so the gate does not see it; it stays in the folder as the trail of what
  was agreed before.
- Then the new contract is written at the plain name with `version` bumped by one.
- **A new version goes through the same gate.** Execution waits for a fresh confirmation —
  a contract that was confirmed at version 1 confirms nothing about version 2.

---

## Confirmation

| Field | Value |
|-------|-------|
| Checker verdict | {PASS / FLAG / BLOCK — same value as the front matter} |
| Confirmed by | {person, or "pending"} |
| Confirmed on | {YYYY-MM-DD, or "pending"} |

A `BLOCK` that survived the revision rounds stays written here as `BLOCK`. The person decides
what to do about it; the record does not decide for them.
