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
3. **Immutable after the plan's first commit.** The `PRED-POSTEDIT` lint
   content-hashes the predictions block against the plan file's first commit —
   any post-hoc edit (HARKing) is a critical finding. New claims go in a NEW plan.
4. **Every field is mandatory** (except `confidence`): the `PRED-NOMETRIC` lint
   fails any entry missing `metric` / `check_command` / `comparator` /
   `threshold` — an unscorable prediction is worthless.
5. **Don't duplicate DoD.** The `PRED-DUPDOD` lint warns when a `check_command`
   duplicates an existing DoD dimension check — predict something DoD does NOT
   already verify.
6. **`check_command` must be allowlisted** (`SAFE_COMMAND_PATTERNS` in
   `scripts/sma/lib/predict.mjs`): only `node scripts/sma/...`,
   `pnpm vitest run ...`, or `pnpm sma ...` shapes run; anything else scores
   `skipped-unsafe`. The command's LAST output line must be a number.
7. **`confidence` is optional and NEVER gates a verdict** — it is recorded
   verbatim for calibration only (verbalized-confidence anti-pattern lock).

## Schema

```yaml
predictions:
  - id: P1                     # unique within the plan
    claim: "one falsifiable sentence"
    metric: exit_code          # what the number MEANS
    check_command: "node scripts/sma/cli.mjs lint --json"  # allowlisted; numeric last line
    comparator: "=="           # one of == != >= <= > <
    threshold: 0               # numeric
    horizon: "plan close"      # when it is scored
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
    check_command: "node scripts/sma/cli.mjs lint --json"
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
    check_command: "pnpm sma status --stale-count"
    comparator: "=="
    threshold: 0
    horizon: "next session-start"
    domain: tech.coordination
```
