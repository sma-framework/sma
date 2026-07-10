# sma-framework — Living SPEC (delta-spec)

> **Rule (load-bearing):** every future behavior change to sma-framework lands with a
> **delta entry in this file, in the same commit** as the code. The baseline is frozen;
> the deltas are the changelog of requirements. A change without a delta entry is a spec
> regression — the SPEC is the anchor V2+ work is measured against, not the git log.
>
> Shape (OpenSpec fold-back): `## Baseline` is the generalized V1 requirement set;
> `## Delta VN.M` sections append one entry per shipped mechanism, each with its
> requirement sentence and the verifying test file. When a delta matures it is folded
> back into the baseline at the next major line.

sma-framework is a deterministic, in-repo memory + multi-terminal-coordination layer that
installs alongside a GSD-style engine. Design constants (never re-litigated): no daemons ·
no databases as coordination truth · no embeddings in the hot path · fail-open coordination
(a failure NEVER wedges a session) · deterministic Node scripts as the enforcement
substrate · hard `deny` reserved for the security guard. All I/O is dependency-injectable;
Node built-ins only; zero npm runtime deps.

---

## Baseline (V1)

The 14 requirements the V1 foundation locked, generalized (host-platform specifics
stripped — any repo, any planning tree). Verified by the V1 suite under
`scripts/sma/__tests__/`.

- **R1 · TAGS registry.** A committed faceted closed tag vocabulary (`area: × kind: [+ phase:]`,
  aliases) at a canonical path; an unregistered tag is a lint failure; new tags enter only via
  a registry edit in the same commit as first use.
- **R2 · Corpus schema + migration.** Every memory note carries normalized frontmatter
  (`description, kind, tags[], use-when, importance`, optional supersession fields); unparseable
  notes are skipped-and-listed, never guessed.
- **R3 · Generated CORE + index.** `MEMORY.md` is a build artifact: always-load CORE + a
  one-line-per-fact index, stamped with the commit it was built at and a "do not hand-edit"
  header; lint fails when the committed artifact ≠ regeneration output (deterministic, byte-stable).
- **R4 · Deterministic loader.** CORE always + tag-matched periphery by facet intersection with
  alias resolution; zero matches → CORE only, exit 0; equal-rank order is stable
  (importance desc → recency desc → name asc); recency is never the primary filter.
- **R5 · memory-lint.** One read-only, idempotent checker: orphans (both directions), schema
  completeness, closed-vocab membership, tag-chaos, content-hash duplicates, supersession
  integrity, artifact-matches-regeneration; criticals block at commit, warnings report.
- **R6 · MemPalace обкатка (timeboxed).** Evidence-gathering run for the extend-vs-replace
  decision; the corpus never leaves the machine; a blocked run records "blocked" and the prior
  augment-only verdict stands. (Framework-optional.)
- **R7 · Session registry.** Gitignored per-terminal lease `sessions/<terminal-id>.json`
  (identity, pid, scope, status, blockers, timestamps); presence auto-registered/renewed by
  fail-open hooks (always exit 0); liveness = renewTime, status = self-reported (two axes);
  worktree sessions redirect registry writes to the main root.
- **R8 · Collision detect + WARN.** Scope-glob intersection (case-fold + forward-slash
  normalized) + graduated staleness (fresh → attention → reap-eligible, auto-reap only when
  clean); WARN carries `{who, operation, scope, since, how-to-clear}`; advisory, never blocking;
  an aged-out DIRTY entry is flagged for a human, never silently deleted.
- **R9 · External-state slots.** Deterministic-named atomic-`mkdir` claims for shared counters
  (migration numbers, release-version counter, deploy-signal advisory); numeric (never
  lexicographic) comparison; loser-gets-N+1; abandoned slots cool down before reuse; the
  deploy signal is queue-not-cancel and founder-reserved.
- **R10 · Collision-event journal.** Append-only per-terminal JSONL `journal/<terminal-id>.jsonl`
  (per-terminal files — shared-file appends are not atomic on Windows); reader merge-sorts by
  (ts, terminal, seq); every warn/collision/claim/steal event recorded; empty → zero-event report.
- **R11 · Provenance-lite.** Every claim/slot/registry mutation stamps `{by, session, at}` +
  `expectedPrev` (fencing-as-provenance); first write allows `expectedPrev:null` reason "initial";
  a scanner WARNs on mismatch.
- **R12 · Read-only projection.** A token-authenticated one-way mirror of the local registry +
  journal tail + memory-health numbers to an external cockpit; allowlisted metadata only (never
  file/note bodies, never secrets); last-writer-wins per terminal; reporter is fail-open.
- **R13 · Packaging as an engine capability.** Registered capability (id, tier, skills/hooks),
  implemented as in-repo deterministic scripts; declares the engine version it was built against
  and WARNs on mismatch instead of breaking; no daemons, no coordination DB, no embeddings.
- **R14 · Benchmark + backup discipline.** Baseline measured BEFORE the first corpus-mutating
  commit (pinned query/task sample) + full backup (tag + out-of-repo archive) + same-protocol
  re-measure AFTER the switch, appended to one report.

---

## Delta V2.0 — Predictions · Reflexes · Enforcement (Phase 49.1)

Six pillars extend the V1 primitives in-place (never a rewrite). Each entry: the
requirement it adds + its verifying test file under `scripts/sma/__tests__/`.

- **D2.0-P1 · Prediction engine — "predict → act → measure".** A PLAN carries an immutable
  `predictions:` block (`{metric, check_command, comparator, threshold, horizon}`, HARKing-guarded
  by PRED lints); a deterministic zero-LLM scorer runs the check and writes a verdict to the
  journal; a per-area calibration ledger auto-escalates historically-wrong areas; an optional
  `confidence` is recorded for Brier tracking but NEVER gates.
  *Verified by:* `predict.test.ts`, `calibration.test.ts`.
- **D2.0-P2 · Reflex firing + enforced memory — "the rule fires BEFORE the act".** A PreToolUse
  reflex consumer matches impending tool calls (paths/commands) against `use-when` triggers of
  promoted lessons and injects them as `additionalContext` WARN; advisory only, never `deny`;
  launch-blocking fatigue controls + kill-switch prevent alert fatigue; each surviving fire is
  journaled and citation-tracked.
  *Verified by:* `reflex.test.ts`.
- **D2.0-P3 · Corpus health at scale — "sharp at 500+ notes".** A scheduled (non-daemon)
  `consolidate` pass produces a reflection digest; overflow of a hot-surface byte budget DEMOTES
  a note down a layer (never deletes); optional bi-temporal (`valid_from`/`valid_until`) fields
  and a contradiction check keep the corpus honest as it grows.
  *Verified by:* `consolidate.test.ts`, `trim.test.ts`, `recall.test.ts`.
- **D2.0-P4 · Coordination with teeth — "races become hard, not just warned".** Checkable
  HARD-RULEs promote from prose to deterministic PreToolUse gates (advisory-first, soft-deny only
  with journal evidence of low false-positive rate); the slot allocator generalizes to ALL shared
  planning counters (bl/action/decision/phase); a fenced machine-readable STATE section carries the
  cross-terminal digest.
  *Verified by:* `gates.test.ts`, `next-slot.test.ts`, `state-section.test.ts`.
- **D2.0-P5 · Resilient + parallel harness — "death is a resume; waves run parallel".** A per-plan
  progress journal + fixed resume ritual make an interrupted execution recoverable; deterministic
  stall detection flags a stuck session; **test-impact analysis (`tia`)** is the regex-based
  ADVISORY middle tier between targeted-only and full-suite — it greps changed files' exported
  symbols across test files and ALWAYS carries the disclaimer that the full `pnpm test` suite
  remains the push gate (it NEVER substitutes for it); idempotent **slot reconciliation**
  re-issues an expired-unconsumed number so the claimed-number-lost class ends; verifier/checker
  agents run least-privilege (config-enforced read-only tool scope).
  *Verified by:* `tia.test.ts`, `next-slot.test.ts` (reconcile cases), `exec-journal.test.ts`,
  `stall.test.ts`.
- **D2.0-P6 · Live cockpit + telemetry — "the founder SEES it".** The read-only projection (R12)
  grows an event vocabulary + snapshot payload feeding cockpit panels (predictions + per-area
  calibration, reflex firings, collision feed, corpus health); a cross-terminal digest briefs each
  session on what changed since its last heartbeat.
  *Verified by:* `snapshot.test.ts`, `digest.test.ts`.

### Delta note — 49.1-23 (B17) residuals

This plan shipped the P5 residuals of the delta above: `tia` (regex test-impact analysis,
advisory tier), config-enforced read-only tool scope on `sma-verifier` + `sma-plan-checker`,
idempotent slot reconciliation (`reconcileExpiredClaim` + `consume`/`markConsumed`), and this
delta-spec itself. No new external surface, no packages installed.
