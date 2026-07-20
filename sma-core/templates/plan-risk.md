# Plan-risk rubric (B17 — verification effort follows blast radius)

A uniform gate wastes verifier effort on trivial plans and under-verifies risky ones.
This rubric scores each plan's blast radius **deterministically** — every input is
computable from the plan's frontmatter (`files_modified`) plus diff stats; no judgment
calls, no adjectives. The verify step computes the score, maps it to a tier, and writes
both into the phase DoD JSON.

## Scoring (additive, deterministic)

| Input | Points | How to compute |
|-------|--------|----------------|
| Hot-file touch | +2 per hot file | Intersect `files_modified` with the HOT_FILES list (`scripts/sma/lib/collision.mjs` — currently `.planning/STATE.md`, `.planning/ROADMAP.md`, `.claude/memory/MEMORY.md`). Count matches, x2. |
| Migration present | +3 | Any `files_modified` entry under a migrations path (e.g. `src/migrations/`), OR the plan/diff adds a migration registration. Present = +3, absent = 0. |
| File count | +1 per 5 files | `floor(len(files_modified) / 5)`. A 12-file plan scores +2. |
| Shared-surface edit | +2 | Any `files_modified` entry matching a shared surface: `.claude/settings.json` / `settings.local.json`, hook files (`.claude/hooks/**` or hook entries in settings), or engine workflows (`sma-core/workflows/**`, `sma-core/agents/**`). Flat +2 if one or more match. |

Score = sum of the four rows. Ties and edge cases resolve by the arithmetic — there is
no discretionary adjustment.

## Tiers

| Score | Tier |
|-------|------|
| 0-2 | `low` |
| 3-5 | `medium` |
| >=6 | `high` |

## Consequences (what each tier buys)

| Tier | Verification effort |
|------|---------------------|
| `low` | Targeted tests only — the tests for the files the plan touched. No deep pass. |
| `medium` | Targeted tests + the verifier's standard pass (must_haves against the codebase). |
| `high` | Verifier deep pass (must_haves + cross-plan integration + regression surface) AND a human-visible note in the DoD: the `risk` field's tier itself flags the phase card so a human sees it before sign-off. |

## DoD JSON `risk` field

The verify step writes the result into the phase DoD JSON as a top-level field beside
`dimensions`:

```json
{
  "schemaVersion": 1,
  "phaseId": "9.1",
  "emittedAt": "...",
  "risk": { "score": 7, "tier": "high" },
  "dimensions": [ ... ]
}
```

- `score`: the integer sum from the rubric above.
- `tier`: `"low" | "medium" | "high"` per the tier table.
- For a multi-plan phase, the phase-level `risk` is the **maximum** plan score in the
  phase (the riskiest plan sets the verification bar).
- Both the tracker (kanban card rendering) and the verifier (effort sizing) read this
  field. Human gates in `dimensions` stay `pending` regardless of tier — risk sizes the
  automated effort; it never self-certifies a human gate.
