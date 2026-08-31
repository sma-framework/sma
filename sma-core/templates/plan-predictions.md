# Plan Predictions — Authoring Reference (B18/B19)

Every plan that touches a **risk class** (schema changes, hooks, cross-cutting
concerns) carries 1-3 pre-registered, machine-checkable predictions in its
frontmatter. They are scored DETERMINISTICALLY at plan close
(`node scripts/sma/cli.mjs predict-score <plan>`) — zero LLM involvement — and
every verdict lands in the per-domain calibration ledger. A **miss** auto-drafts
a bug-lesson candidate into `.claude/memory/drafts/` (draft only, never
auto-committed; promotion needs the 3-condition review gate).

## Rules

1. **1-3 predictions per plan, hard cap.** Predictions are calibration signal,
   not ceremony. If you cannot name 1 falsifiable claim, write the escape below.
2. **The escape is itself tracked:** a plan with no predictions MUST carry
   `predictions: none (reason)` in frontmatter — an explicit, greppable record
   of why nothing was pre-registered. Silence is not allowed for risk-class plans.
3. **Immutable from the plan's first execution attempt.** The `PRED-POSTEDIT`
   lint content-hashes the predictions block against the plan as it stood at its
   first execution attempt (the plan's own exec journal, `.sma/exec/<phase>-<plan>.jsonl`,
   dates it) — any edit from that point on (HARKing) is a critical finding, and
   new claims go in a NEW plan. BEFORE the first attempt a plan is a draft and
   the block may be revised freely: the planning loop is «planner writes → checker
   checks → planner revises», and pre-registration guards against fitting the
   predictions TO a result, which only becomes possible once the plan is executed.
   A CLOSED plan whose house kept no exec journal falls back to the first commit —
   a summary proves the plan ran, and «cannot date the attempt» is not «never ran».
4. **Every field is mandatory** (except `confidence`, `measure` and `cwd`):
   the `PRED-NOMETRIC` lint fails any entry missing `metric` /
   `check_command` / `comparator` / `threshold` — an unscorable prediction is
   worthless. Two OPTIONAL fields shape HOW the claim is measured:
   - `measure: last-line | exit-code` — where the fact comes from. `last-line`
     is the default and the historical reading: the numeric last line of the
     output. `exit-code` takes the process exit code as the fact, which is what
     a claim like «the suite is green» has always actually meant. Omit the field
     and nothing changes.
   - `cwd: <path>` — the directory the command runs in. It is handed to the
     runner as a run parameter; it never becomes part of the command string.
5. **Don't duplicate DoD.** The `PRED-DUPDOD` lint warns when a `check_command`
   duplicates an existing DoD dimension check — predict something DoD does NOT
   already verify.
6. **`check_command` must be allowlisted** (`SAFE_COMMAND_PATTERNS` in
   `scripts/sma/lib/predict.mjs`): only `node scripts/sma/...`,
   `pnpm vitest run ...`, `pnpm sma ...`, or the local package manager running
   the project's own manifest (`npm|pnpm|yarn test`, `... pack`,
   `... run <script>`) shapes run; anything else scores `skipped-unsafe`. The
   command's LAST output line must be a number under the default
   `measure: last-line`; under `measure: exit-code` the exit code IS the number
   and the output is not parsed at all. Several steps, or a run in another
   directory, are expressed by FIELDS — `cwd`, and one prediction per claim —
   never by a connector inside the command: `cd X && cmd` and `cmd; echo $?`
   are refused by the charset guard, and that refusal stays exactly as it is.
7. **`confidence` is optional and NEVER gates a verdict** — it is recorded
   verbatim for calibration only (verbalized-confidence anti-pattern lock).
8. **`horizon` is read, not decorative.** A horizon written as a date
   (`2026-11-01`) or a version (`V3.2`) that has not arrived makes the entry
   `not-due`: both `predict-score` and `blind-verify` register it, run nothing,
   and write no verdict — a claim about a future nobody can observe is not
   settled by guessing at it. It becomes scoreable the moment the horizon
   arrives. A prose horizon (`plan close`, `next session-start`) is scored
   immediately, exactly as before.

## Schema

```yaml
predictions:
  - id: P1                     # unique within the plan
    claim: "one falsifiable sentence"
    metric: exit_code          # what the number MEANS
    check_command: "node scripts/sma/cli.mjs lint"  # allowlisted
    measure: exit-code         # OPTIONAL — last-line (default) | exit-code
    cwd: "packages/engine"     # OPTIONAL — where the command runs; a field, not a connector
    comparator: "=="           # one of == != >= <= > <
    threshold: 0               # numeric
    horizon: "plan close"      # when it is scored — see rule 8
    domain: tech.memory        # calibration-ledger domain
    confidence: 0.8            # OPTIONAL — recorded, never gates
```

Escape (tracked, for plans with genuinely nothing to pre-register):

```yaml
predictions: none (pure doc move — no behavior, nothing falsifiable to claim)
```

## Worked examples

**1. Schema/migration plan — "the migration leaves lint green":**

```yaml
predictions:
  - id: P1
    claim: "the corpus migration introduces zero critical lint findings"
    metric: lint_exit_code
    check_command: "node scripts/sma/cli.mjs lint"
    measure: exit-code
    comparator: "=="
    threshold: 0
    horizon: "plan close"
    domain: tech.memory
```

**2. Test-count plan — "the new module lands with its suite green":**

```yaml
predictions:
  - id: P1
    claim: "the reflex suite passes with zero failures on first full run"
    metric: vitest_exit_code
    check_command: "pnpm vitest run scripts/sma/__tests__/reflex.test.ts"
    measure: exit-code
    comparator: "=="
    threshold: 0
    horizon: "plan close"
    domain: tech.hooks
    confidence: 0.7
```

**3. Coordination plan — "no stale sessions survive the reap":**

```yaml
predictions:
  - id: P1
    claim: "after the reap pass, zero stale sessions remain in the registry"
    metric: stale_session_count
    check_command: "node scripts/sma/cli.mjs status --stale-count"
    comparator: "=="
    threshold: 0
    horizon: "next session-start"
    domain: tech.coordination
```
