# SMA Memory Model 1.0 — note schema v2

| | |
|---|---|
| Status | **DRAFT v0.1** — design document under review; nothing in it is a shipped surface yet |
| Document version | 0.1 |
| Date | 2026-07-31 |
| Applies to | proposed `schema_version: 2`; the entire v1 corpus remains readable unchanged |

> **All examples in this document are synthetic.** They describe a fictional
> web-shop project ("the shop") and exist only to illustrate the schema.

---

## 1. What a memory record must answer

Schema v1 answers one question: *what is this note about?* Schema v2 must answer
the full set that makes memory governable:

- **What** is claimed — one durable claim per record.
- **Who** claims it — source and authority.
- **How it is known** — evidence, and for rederivable claims, the check itself.
- **What state of the world it describes** — a code fingerprint.
- **For what scope** it holds — repos, paths, environments.
- **When** it was observed, recorded, and until when it is valid.
- **How sensitive** it is and which storage class may hold it.
- **How it dies** — supersession, revocation, expiry, archival, erasure.

A note that cannot answer these is not wrong — it is a *draft*, and the schema
makes that visible instead of letting it masquerade as established knowledge.

## 2. Memory types

`memory_type` — what kind of knowledge the record carries.

| memory_type | Meaning | Synthetic example (web-shop) |
|---|---|---|
| `working` | State of the current task; short lifecycle. | "Cart-service refactor in flight; flag `new-cart` half rolled out." |
| `semantic` | Relatively stable facts and definitions. | "Product images are served from the `img` CDN subdomain." |
| `episodic` | Concrete events, incidents, outcomes. | "On 2026-03-12 checkout retries double-charged 14 customers; rolled back 23:10." |
| `procedural` | Verified ways of performing actions. | "To add a payment provider: implement `PaymentPort`, register it, add the contract test." |
| `prospective` | An action that must fire on a trigger. | "When the payments API v12 migration lands, delete the v10 shim." |
| `normative` | Permissions, prohibitions, obligations, human-only boundaries. | "No release without a green checkout smoke suite." |
| `preference` | Versioned preferences of a user or organization. | "The team prefers table-driven tests over per-case test functions." |

## 3. Truth modes

`truth_mode` — the epistemic standing of the claim.

| truth_mode | Semantics |
|---|---|
| `observed` | A directly captured event or value. |
| `inferred` | A derivation that may turn out to be wrong. |
| `factual` | A confirmed claim backed by evidence. |
| `hypothesis` | A falsifiable supposition. |
| `decision` | A versioned choice by a human or an authorized process. |
| `normative` | A rule, obligation, or prohibition. |

### 3.1 The two disciplines: FACT vs INTERPRETATION

Every truth mode belongs to one of two verification disciplines, and the
discipline dictates what the record is required to carry:

- **FACT** (`observed`, `factual`) — machine-rederivable. The record **carries
  its check**: a `verification` block (command + expected result) and/or a
  `fingerprint`. Whether the claim still holds is decided by *running the
  check*, never by rereading prose.
- **INTERPRETATION** (`inferred`, `hypothesis`, `decision`, `normative`) —
  authored judgment. The record **carries its provenance**: `source` (whose
  judgment, under what authority) and `evidence` (what supports it).

**The draft rule:** an interpretation without `source` and `evidence` cannot
become `active`. It stays a draft — or is explicitly labeled
`truth_mode: hypothesis`. Provenance is the admission ticket to the reviewed
corpus, not decoration.

A single prose note that mixes an observation, a diagnosis, and a rule is three
records in v2 — one claim each, each with its own truth mode. The distinction
matters because they fail differently:

- *observation:* "checkout retry returned HTTP 200 with an empty body"
- *interpretation:* "probably the payment client swallows the error"
- *fact:* "the fixture reproduces the empty body on retry (test attached)"
- *decision:* "we keep the retry but add an idempotency key"
- *policy:* "no release while the retry regression test is red"

## 4. Provenance: source, evidence, fingerprint

```yaml
source:
  authority: verified-incident      # who/what stands behind the claim
  refs: [incident:2026-03-12-double-charge, receipt:R-118]
evidence:
  - type: test
    ref: test:checkout-retry-idempotency
  - type: incident
    ref: incident:2026-03-12-double-charge
fingerprint:
  paths: [src/checkout/retry.ts, src/payments/client.ts]
  tree_hash: 9f2c41d7
  taken_at: 2026-03-14T09:30:00Z
```

- **source** — where the knowledge came from: an incident, a review, an owner
  instruction, an external document. `authority` is an enum (e.g.
  `verified-incident`, `owner-instruction`, `code-review`, `external-doc`,
  `agent-inference`); `refs` point at the raw material.
- **evidence** — typed references to what would re-verify the claim: tests,
  receipts, benchmark runs, linked episodes. `evidence: none-recorded` is a
  legal, honest value — but it caps the record at draft/hypothesis (§3.1).
- **fingerprint** — the state of the code the note *describes*, captured at
  recording time: the paths involved and a content hash over them.

**Deterministic staleness.** A note stamped with a fingerprint makes staleness a
comparison, not a judgment call: recompute the hash over `fingerprint.paths`
and compare. A mismatch does not prove the note wrong — it proves the world
moved since the note was written, and flags the record for re-verification. No
model, no heuristics, no "this looks old".

## 5. Temporal model

| Field | Meaning |
|---|---|
| `observed_at` | When the underlying event happened or the value was seen. |
| `recorded_at` | When the record entered the corpus (transaction time). |
| `valid_from` | Start of the claim's validity window. |
| `valid_until` | End of validity; empty = open-ended. |
| `supersedes` | The record this one replaces. |
| `superseded_by` | Back-link, maintained by tooling; a superseded record never appears in active retrieval. |

`observed_at` and `recorded_at` are deliberately separate: a lesson written up
two days after the incident has two different timestamps, and temporal queries
("what did we know when we shipped?") need both. Supersession is a typed,
machine-readable link — replacing prose conventions like "see the newer note"
that no retrieval layer can act on.

## 6. Lifecycle status

`status: draft | active | superseded | revoked | expired | archived`

| Action | Semantics |
|---|---|
| supersede | A new version replaces the old; history stays linked. |
| revoke | The record must not be used; audit history may remain. |
| expire | Retention or validity window ran out. |
| archive | Removed from active retrieval, kept for history. |
| erase | Physically removed from every permitted store; copies and indexes verified. Not a status — after erasure there is no record, at most a tombstone where policy requires one. |

The write pipeline (observe → classify → redact → extract claim → compare →
attach evidence → approve → persist → index → measure) is specified in
`MEMORY-LIFECYCLE.md` (planned); this document only fixes the states a record
can be in.

## 7. Sensitivity and storage classes

`sensitivity` decides which storage class may hold the record — and each class
forbids things:

| sensitivity | Storage class | Forbids |
|---|---|---|
| `public` | Public git repo | Secrets, personal data, internal identifiers, unreviewed claims. |
| `internal` | Private git repo | Secrets; anything that may require guaranteed physical erasure (git history cannot promise it); regulated personal data. |
| `sensitive` | Encrypted local store | Leaving the machine; syncing into any git remote; entering compiled context without an explicit gate. |
| `ephemeral` | Runtime store with TTL | Outliving its TTL; promotion to a durable class without reclassification through the write pipeline. |
| `regulated` | Governed external system | Living in the shared substrate at all. Out of scope for this model by design. |

**Fail semantics.** Advisory features (style hints, optional telemetry,
optional semantic indexes) fail *open* — degraded, never blocking. Sensitivity
boundaries fail *closed*: a record whose class cannot be determined is treated
as the most restrictive plausible class, and a retrieval pass that cannot
evaluate a sensitivity filter returns nothing rather than everything.

## 8. Splitting `importance`

The v1 single `importance` number conflates at least six questions. v2 asks
them separately:

| Field | Question it answers | Values |
|---|---|---|
| `criticality` | What does *missing* this memory cost? | `low` / `medium` / `high` / `critical` |
| `frequency` | How often is it expected to apply? | `low` / `medium` / `high` |
| `confidence` | How well is the claim supported? | `0.0`–`1.0` |
| `freshness` | When was it last re-verified? | date |
| `context_priority` | Load always, or on demand? | `core` / `on-demand` |
| `risk` | What approval does *acting on it* require? | `none` / `review-required` / `human-only` |

Two v1 notes can both carry `importance: 9` for entirely different reasons —
one because skipping it breaks releases (criticality), one because it must load
in every session (context priority). The split makes ranking, loading, and
approval three independent decisions instead of one overloaded digit.

## 9. Retrieval block

```yaml
retrieval:
  areas: [checkout, payments]          # closed vocabulary, linted
  entities: [payment-gateway, idempotency-key]
  task_types: [bugfix, refactor, release]
  paths: [src/checkout/**, src/payments/**]
  semantic_index: false                # opt-in to optional derived indexes
```

Deterministic facets stay the first and always-available retrieval layer. Hard
filters run before any ranking: permission, sensitivity, `status`, valid time,
repo/environment scope. Optional lexical or dense indexes are derived layers on
top — rebuildable, removable, never a source of truth.

Two structural fields accompany every record:

- `schema_version: 2` — mandatory; the parser accepts v1 and v2 side by side.
- `status` — the lifecycle state (§6); hard-filtered at retrieval time.

## 10. Typed links

Wikilinks stay for humans; the machine layer uses typed edges:

`derived_from` · `supports` · `contradicts` · `supersedes` · `caused_by` ·
`applies_to` · `exception_to` · `requires` · `verified_by` · `owned_by` ·
`part_of`

The graph is built for questions, not beauty: an edge earns its place only if
it improves a concrete retrieval, temporal-resolution, or verification query.

## 11. Corpus integrity lint

`verify-corpus` is a deterministic lint over the whole corpus — exit-code
contract, runnable in CI and pre-ship:

- schema validation and closed vocabularies (types, modes, areas, authorities);
- provenance presence — an `active` interpretation without `source`/`evidence`
  is a violation, per the draft rule (§3.1);
- temporal sanity — `observed_at ≤ recorded_at`, `valid_from ≤ valid_until`;
- supersession symmetry — `supersedes`/`superseded_by` agree; no superseded
  record is `active`;
- fingerprint drift — recomputed hashes flag stale records deterministically;
- storage-class agreement — no `sensitive` record inside a git-backed class.

## 12. Backward compatibility: v1 → v2

A v1 note carries `description`, `kind`, `tags`, `use-when`, `importance`.
Every v1 field has a defined destination:

| v1 field | v2 destination | Notes |
|---|---|---|
| `description` | `claim` | One durable claim per record; surrounding narrative becomes a linked episode (`derived_from`). |
| `kind` | `memory_type` + `truth_mode` | Seeded from the table below; human confirms. |
| `tags` | `retrieval.areas` (+ `entities`) | Closed vocabulary carries over. |
| `use-when` | `retrieval.task_types` + `retrieval.paths` | Parsed into facets where possible; the remainder stays a free-text hint. |
| `importance` | six fields (§8) | Seeds `criticality` and `context_priority`; `confidence`, `freshness`, `frequency`, `risk` start unset and are proposed. |
| *(absent in v1)* | `source`, `evidence`, `fingerprint`, temporal fields, `sensitivity`, `status` | Proposed by the agent from context; `none-recorded` is a legal honest value for evidence. |

Suggested `kind` seed mapping (confirmed per note, never assumed):

| v1 kind | memory_type | truth_mode |
|---|---|---|
| `bug-lesson` | `procedural` | `factual` |
| `procedural-rule` | `procedural` | `normative` |
| `decision` | `semantic` | `decision` |
| `feedback` | `preference` or `normative` | `decision` |
| `reference` | `semantic` | `factual` |
| `status`, `handoff` | `working` or `episodic` | `observed` |
| `episodic` | `episodic` | `observed` |

### 12.1 The migration law

**Migration is preview-only.** The migration tool never rewrites a v1 note in
place. It *proposes* a v2 rendering as a diff; a human accepts or rejects each
one. Until accepted, the v1 note remains canonical, and the v2 parser keeps
reading it as-is. One hundred percent of the v1 corpus stays readable with zero
edits — forever if the owner never accepts a single proposal.

### 12.2 Worked example

A v1 note from the fictional web-shop:

```yaml
---
description: "Checkout retry double-charged customers (2026-03-12) — every
  payment retry must reuse the idempotency key of the original attempt; fixed
  in retry.ts, regression test added"
kind: bug-lesson
tags: [checkout, payments]
use-when: touching checkout retry or the payment client
importance: 8
---
```

The proposed v2 record (shown to the human as a diff, never auto-applied):

```yaml
---
id: mem-checkout-retry-001
schema_version: 2
status: active
memory_type: procedural
truth_mode: normative
claim: Every payment retry must send the idempotency key of the original attempt.
scope:
  repos: [web-shop]
  paths: [src/checkout/**, src/payments/**]
  environments: [production, staging]
source:
  authority: verified-incident
  refs: [incident:2026-03-12-double-charge]
evidence:
  - type: test
    ref: test:checkout-retry-idempotency
fingerprint:
  paths: [src/checkout/retry.ts, src/payments/client.ts]
  tree_hash: 9f2c41d7
  taken_at: 2026-03-14T09:30:00Z
observed_at: 2026-03-12T22:41:00Z
recorded_at: 2026-03-14T09:30:00Z
valid_from: 2026-03-14
valid_until:
criticality: high
frequency: medium
confidence: 0.97
freshness: 2026-03-14
context_priority: on-demand
risk: review-required
sensitivity: internal
retention: until-revoked
retrieval:
  areas: [checkout, payments]
  entities: [payment-gateway, idempotency-key]
  task_types: [bugfix, refactor, release]
  paths: [src/checkout/**, src/payments/**]
  semantic_index: false
verification:
  command: npm test -- checkout-retry-idempotency
  expected: exit-code-0
links:
  - type: derived_from
    ref: episode:2026-03-12-checkout-outage
  - type: verified_by
    ref: test:checkout-retry-idempotency
---
The 2026-03-12 incident narrative lives in the linked episode record.
This claim carries only the durable rule and its check.
```

## 13. Change log

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-07-31 | Initial draft: types, truth modes + FACT/INTERPRETATION disciplines, provenance incl. fingerprint, temporal model, lifecycle, sensitivity/storage classes, importance split, retrieval block, typed links, integrity lint, v1→v2 mapping + migration law. |
