# Compaction survival exam (S3) — 10 locked questions

The deterministic post-compact exam (D-49.2-09 measurement, scorecard S3). After a
real auto-compact the operator answers these in a plain file; `sma bench exam --grade`
scores the answers against the pre-written answer key with NORMALIZED KEYWORD MATCHING
(casefold + trim) — never LLM judgment. The base is measured BEFORE the capsule exists
(plan 06); the protocol needs >=3 graded exams by the 2026-07-21 freeze.

Each question carries its DETERMINISTIC extraction rule: the same repo state always
yields the same answer key (`buildAnswerKey` in bench.mjs). Zero LLM anywhere.

- **Q1** — active plan id. Extraction rule: the plan id of the most recent
  `.sma/exec/<phase>-<plan>.jsonl` with an open (not `plan_complete`) journal.
- **Q2** — next undone task. Extraction rule: `exec-journal nextUndone` over the active
  plan's journal (lowest task number with no `task_complete` event).
- **Q3** — current plan `files_modified`. Extraction rule: the `files_modified:` list in
  the active plan's PLAN.md frontmatter.
- **Q4** — active claims + holders. Extraction rule: each `.sma/claims/*.json` scope +
  its holder identity.
- **Q5** — last 3 journal events. Extraction rule: the tail of the merged coordination
  journal (`readJournal`), most recent 3 events (type + scope).
- **Q6** — open gates / soft-denies. Extraction rule: `.sma/gates/` evidence markers and
  any armed soft-deny gate ids.
- **Q7** — next free migration slot. Extraction rule: `sma next-slot migration` (the
  sorted-insert next number; read-only probe).
- **Q8** — current phase + wave. Extraction rule: STATE.md `## Current Position`
  (`Phase: N`) plus the active plan's `wave:` frontmatter.
- **Q9** — locked D-XX ids constraining the active task. Extraction rule: the `D-<phase>-*`
  decision ids referenced by the active plan (from the phase CONTEXT decisions block).
- **Q10** — the active plan's prediction ids + thresholds. Extraction rule: the
  `predictions:` frontmatter block of the active plan (each `id` + `threshold`).
