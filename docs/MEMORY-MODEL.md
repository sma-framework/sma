# SMA Memory Model 1.0 — note schema v2

| | |
|---|---|
| Status | **1.0 — landed.** Every rule below is enforced by shipped code and covered by the test suite. |
| Document version | 1.0 |
| Date | 2026-08-02 |
| Applies to | `schema_version: 2`; the entire v1 corpus stays readable with zero edits |
| Companion documents | [`MEMORY-LIFECYCLE.md`](MEMORY-LIFECYCLE.md) — how a record is written, reviewed and retired · [`MEMORY-THREAT-MODEL.md`](MEMORY-THREAT-MODEL.md) — what the storage classes defend against |

> **All examples in this document are synthetic.** They describe a fictional
> web-shop project ("the shop") and exist only to illustrate the schema.

> **The document follows the code, never the other way round.** Every enum value,
> field name, field order and check id below is taken from the shipped modules:
> `scripts/sma/lib/schema-v2.mjs` (legality), `scripts/sma/lib/frontmatter.mjs`
> (grammar and emit order), `scripts/sma/lib/lint.mjs` (the corpus checks),
> `scripts/sma/lib/write-pipeline.mjs` (the write path). Where this document and
> those modules disagree, the modules are right and this document is a bug.

---

## 1. What a memory record must answer

Schema v1 answers one question: *what is this note about?* Schema v2 answers the
full set that makes memory governable:

- **What** is claimed — one durable claim per record.
- **Who** claims it — source and authority.
- **How it is known** — evidence, and for rederivable claims, the check itself.
- **What state of the world it describes** — a fingerprint.
- **For what scope** it holds — repos, paths, environments.
- **When** it was observed, recorded, and until when it is valid.
- **How sensitive** it is and which storage class may hold it.
- **How it dies** — supersession, revocation, expiry, archival, erasure.

A note that cannot answer these is not wrong — it is a *draft*, and the schema
makes that visible instead of letting it masquerade as established knowledge.

### 1.1 The required field set

Eight fields are mandatory on every schema-v2 record, whatever else it says:

`id` · `schema_version` · `status` · `memory_type` · `truth_mode` · `claim` ·
`language` · `sensitivity`

**The id law:** `id` MUST equal the file's name without its extension. A record's
identity then survives a move, a copy and a grep, and the retrieval layer never
has to reconcile two spellings of the same thing. The law holds for episode files
too — only the filename stem counts, never the directory.

**`language`** is a per-record code (`en`, `ru`, …). It is required because recall
across languages is a thing the corpus is measured on: a query in one language
that must find a note written in another is a measurable case only if every record
says which language it is in.

## 2. Memory types

`memory_type` — what kind of knowledge the record carries. A closed vocabulary;
the machine never picks it (see [`MEMORY-LIFECYCLE.md` §1.2](MEMORY-LIFECYCLE.md#12-step-2--classify)).

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

`truth_mode` — the epistemic standing of the claim. Also a closed vocabulary.

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
  `fingerprint` (§4). Whether the claim still holds is decided by *running the
  check*, never by rereading prose.
- **INTERPRETATION** (`inferred`, `hypothesis`, `decision`, `normative`) —
  authored judgment. The record **carries its provenance**: `source.authority`
  (whose judgment, under what standing) and, once it is `active`, `evidence`.

**The draft rule:** an interpretation without authority and evidence cannot become
`active`. It stays a draft — or is explicitly labeled `truth_mode: hypothesis`.
Provenance is the admission ticket to the reviewed corpus, not decoration. The
write path enforces this by *downgrading* rather than discarding: the record is
restamped `status: draft`, `truth_mode: hypothesis` and staged for review
([`MEMORY-LIFECYCLE.md` §1.6](MEMORY-LIFECYCLE.md#16-step-6--evidence)).

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
  authority: self-observed
  refs: [incident:2026-03-12-double-charge, receipt:R-118]
evidence:
  - type: test
    ref: test:checkout-retry-idempotency
  - type: incident
    ref: incident:2026-03-12-double-charge
fingerprint:
  product_version: 5.1.0
  tree_paths: [src/checkout/retry.ts, src/payments/client.ts]
  tree_hash: 9f2c41d7a1b3…
```

### 4.1 source

Where the knowledge came from. `authority` is a **closed vocabulary**, ordered
from the strongest standing to the weakest:

| authority | Meaning |
|---|---|
| `owner-instruction` | The owner of the installation said so, directly. |
| `external-review` | A review, audit or outside party stands behind it. |
| `self-observed` | The installation observed it itself (an incident, a run, a measurement). |
| `inferred` | A machine or a human derived it; nobody vouched for it. |

`owner-instruction` exists so that a verbatim quote in prose stops being the only
way to express authority. Provenance smuggled into narrative text is exactly what
this enum retires. `refs` point at the raw material.

### 4.2 evidence

Typed references to what would re-verify the claim: tests, receipts, benchmark
runs, linked episodes. Each entry is a `{type, ref}` pair.

`none-recorded` is a legal, honest ref value — and it counts as **no** evidence,
so it caps the record at draft/hypothesis (§3.1). Write it as an array entry, not
as a bare scalar: `evidence: none-recorded` parses on the way in but the shared
serializer refuses to write it back, and the corpus lint reports such a record as
a critical finding rather than blessing something the next tool will reject.

### 4.3 fingerprint — the composite stamp

The state of the world the note *describes*, captured at recording time. Two
halves, one required:

| Sub-key | Required | Meaning |
|---|---|---|
| `product_version` | yes, whenever a fingerprint is present | The human-readable **epoch** the claim describes — which version of the product it was true of. |
| `tree_paths` | optional | The files the claim is bound to, when it is bound to files at all. |
| `tree_hash` | optional, **requires `tree_paths`** | A content hash over exactly those paths. |

A hash with no paths can never be recomputed, so it can never prove drift. That
combination is rejected rather than trusted.

**`tree_hash` has exactly one definition** (exported as `computeTreeHash`): sha256
over `<path>:<git blob hash>` lines, paths sorted, one trailing newline, hashed
from the **working tree**. Working tree, not the index: a claim about a file should
go stale the moment that file changes, not the moment someone commits it. Anything
that computes this value differently is a second definition, and a second
definition makes every fingerprint read as drifted forever.

**Deterministic staleness.** A stamped note makes staleness a comparison, not a
judgment call: compare the epoch against the product's current version, recompute
the hash over `tree_paths`. A mismatch does not prove the note wrong — it proves
the world moved since the note was written, and flags the record for
re-verification. No model, no heuristics, no "this looks old". When the comparison
cannot be made at all (no git runner, an unreadable path, no readable product
version), the result is an explicit **unverified** finding: unverifiable is never
reported as verified.

### 4.4 Claims about external artifacts

If any `source.refs[]` entry or `evidence[].ref` is URL-shaped (`http://`,
`https://`), `valid_until` is **required**. An artifact outside this installation
moves without telling us, so a claim about it must carry the date at which it stops
being assumed true.

## 5. Temporal model

| Field | Meaning |
|---|---|
| `observed_at` | When the underlying event happened or the value was seen. |
| `recorded_at` | When the record entered the corpus (transaction time). |
| `valid_from` | Start of the claim's validity window. |
| `valid_until` | End of validity; absent = open-ended. |
| `supersedes` | The record this one replaces. |
| `superseded_by` | Back-link to the replacement. |
| `superseded_at` | When the replacement happened. |

`observed_at` and `recorded_at` are deliberately separate: a lesson written up two
days after the incident has two different timestamps, and temporal queries ("what
did we know when we shipped?") need both.

Supersession is a typed, machine-readable link — it replaces prose conventions like
"see the newer note" that no retrieval layer can act on. The pointers are written
in pairs and never one-sidedly; see §6 and
[`MEMORY-LIFECYCLE.md` §5](MEMORY-LIFECYCLE.md#5-lifecycle-actions).

## 6. Lifecycle status

`status: active | superseded | revoked | expired | archived | draft`

| Action | Semantics |
|---|---|
| supersede | A new version replaces the old; history stays linked, both ends of the pointer are written. |
| revoke | The record must not be used; audit history may remain. A revocation requires a stated reason. |
| expire | The validity window ran out. Never applied before `valid_until` has actually passed. |
| archive | Removed from active retrieval, kept for history. |
| erase | Physically removed from every permitted store; copies and indexes verified. **Not a status** — after erasure there is no record, at most a tombstone where policy requires one. |

`draft` is where a record waits when it is not yet entitled to be believed: a
judgment with no provenance, a candidate lesson, anything the approval ladder does
not let through automatically.

**Erasure is deferred by policy, and the deferral is honest.** No code path in the
write pipeline removes a record: `erase` is outside the set of transitions the
module performs, and asking for it returns a refusal that names the reason.
Erasure means physical removal from *every* permitted store with copies and indexes
verified — and a module that writes markdown into a git working tree cannot promise
any part of that sentence, because deleting the file would leave the history intact
and the promise false. What each storage class can and cannot promise is §7; the
full refusal and the policy behind it are in
[`MEMORY-LIFECYCLE.md` §5.5](MEMORY-LIFECYCLE.md#55-erase-deferred-by-policy).

The twelve-step write pipeline that produces these states — observe · classify ·
redact · extract · compare · evidence · risk · persist · index · measure ·
consolidate · lifecycle — is specified in
[`MEMORY-LIFECYCLE.md` §1](MEMORY-LIFECYCLE.md#1-the-write-pipeline-twelve-steps-in-one-fixed-order).
This document only fixes the states a record can be in.

## 7. Sensitivity and storage classes

`sensitivity` decides which storage class may hold the record — and each class
forbids things:

| sensitivity | Storage class | Forbids |
|---|---|---|
| `public` | Publishable: a public repo, a shipped preset | Secrets, personal data, installation-private facets (§9.3), unreviewed claims. |
| `internal` | Private repo of the installation | Secrets; regulated personal data; anything that may require guaranteed physical erasure (git history cannot promise it). |
| `sensitive` | Restricted store, never a public export | Sitting anywhere a public or preset export can read it; entering compiled context without an explicit gate. |
| `encrypted-required` | Restricted store, encryption required by policy | Everything `sensitive` forbids, plus living in a git-backed class at all. |

**`encrypted-required` states a REQUIREMENT, not an implemented cipher.** The
schema and the lint can refuse to let such a record sit where it must not sit;
they do not encrypt anything. Which cipher, which key custody, which
recovery story — that is policy, and it lives in the companion
[`MEMORY-THREAT-MODEL.md` §6](MEMORY-THREAT-MODEL.md#6-encryption-the-policy-and-the-deferral).
Implementing storage encryption is a separate decision;
nothing in this model pretends it has already been made.

**Placement is checked, not assumed.** A record that declares a restricted class
while also declaring a public or preset audience is wrong on its own terms and is a
critical finding. A record that declares `public` — or declares no class at all,
which is every pre-schema note — is additionally scanned for content shapes that
read as sensitive; those are warnings, because a pattern match must never hard-block
a commit (§11).

**Fail semantics.** Advisory features (style hints, optional telemetry, optional
derived indexes) fail *open* — degraded, never blocking. Sensitivity boundaries fail
*closed*: a record whose class cannot be determined is treated as the most
restrictive plausible class, and the approval ladder routes it to the strictest path
([`MEMORY-LIFECYCLE.md` §3](MEMORY-LIFECYCLE.md#3-the-risk-approval-ladder)).

## 8. Splitting `importance`

The v1 single `importance` number conflates at least six questions. v2 asks them
separately:

| Field | Question it answers | Values |
|---|---|---|
| `criticality` | What does *missing* this memory cost? | `low` / `medium` / `high` / `critical` |
| `frequency` | How often is it expected to apply? | `low` / `medium` / `high` — **benchmark-pending** |
| `confidence` | How well is the claim supported? | `0.0`–`1.0` |
| `freshness` | When was it last re-verified? | date |
| `context_priority` | Load always, or only when asked for? | `always` / `on-demand` |
| `risk` | What approval does *acting on it* require? | `low` / `medium` / `high` / `critical` |

Two v1 notes can both carry `importance: 9` for entirely different reasons — one
because skipping it breaks releases (criticality), one because it must load in
every session (context priority). The split makes ranking, loading and approval
three independent decisions instead of one overloaded digit.

**Which of these are closed vocabularies.** `context_priority` and `risk` are
enum-checked by the validator; `criticality` and `frequency` use the grades above by
convention and are not yet enum-checked, and `confidence`/`freshness` are values, not
vocabularies. `risk` is load-bearing beyond ranking: together with `memory_type`,
`truth_mode` and `sensitivity` it decides which approval path a record takes
([`MEMORY-LIFECYCLE.md` §3](MEMORY-LIFECYCLE.md#3-the-risk-approval-ladder)).

**What `criticality` is worth when something has to rank or tier.** A v2 record
states no `importance` number at all, so both halves of the split are read back onto
the one shared weight axis every consumer already sorts and tiers by:
`context_priority: always` keeps the always-load floor, and underneath it the grade
supplies the number — `low` 2, `medium` 5, `high` 8, `critical` 8. A grade outside
the four never mints a weight. The numbers are a deliberate semantic, not a formula:
`high` is loud enough for a full pre-act warning, `medium` speaks in one line, and
`low` sits *below* the reflex silence threshold on purpose — a record that says
missing it costs little has not earned an interruption. A v1 note that states its own
`importance` is unaffected: a stated number always wins, including a stated zero.

**`frequency` is carried but unproven.** It is in the schema for completeness and is
explicitly a candidate for the measurement work: no sample so far has demonstrated
that it earns its place. It may be narrowed or dropped in a later minor version, and
saying so here is cheaper than pretending it was validated.

## 9. Retrieval, scope and the one-claim law

### 9.1 The retrieval block

```yaml
retrieval:
  areas: [checkout, payments]          # closed vocabulary, shared with v1 tags
  paths: [src/checkout/**]             # where the claim applies in the tree
  hint: touching checkout retry or the payment client
```

`areas` is the membership axis the index and the loader read, and it is the **same
closed vocabulary as v1 `tags`** — registered in the corpus's `TAGS.md`, checked by
the lint, aliases resolved to canonical values. A migrated note carries its tags over
one-for-one. `paths` and `hint` are the narrowing facets a v1 `use-when` /
`use-when-pattern` becomes.

The block's grammar is checked (one level of nesting, scalars and inline arrays);
its sub-key *names* are not a closed vocabulary. Additional facets are legal and
survive round-trips, but nothing validates or reads them until some tool does.

Deterministic facets are the first and always-available retrieval layer. The
**contract** for retrieval is that hard filters run before any ranking:
permission, sensitivity, `status`, valid time, repo/environment scope. Optional
lexical or dense indexes are derived layers on top — rebuildable, removable,
never a source of truth.

**What of that is implemented today.** The structural filters run, in code, as one
predicate: `isVisibleNow(record, {now, audience, scope})`, exported from the
generator beside the CORE-membership rule and applied by the read engine as a
filter chain **before** CORE membership, facet matching and ordering are asked —
so a record that may not be shown never enters a comparison it should not have
been in. The chain covers both output points of a delivered pack, CORE and
periphery. What it decides:

- **`status`** — a `superseded` or `revoked` record is out of the delivery
  entirely. (It used to be excluded from CORE only and still rode into the matched
  periphery; that is the shape the retrieval measurement caught as a forbidden
  hit — a rule known to be wrong, quoted back at the task.)
- **Valid time** — a record outside its own `valid_from` … `valid_until` window is
  not delivered. A date-only stamp is read as the whole day, so a claim valid
  *until* the 18th is still valid **on** the 18th. Nothing is mutated: the record
  keeps its `status`, and `MEM-EXPIRE` stays the advisory, human-facing reader of
  the same field (§11).
- **`sensitivity`** — by **audience**, and only by audience. The default consumer
  is the local owner reading their own corpus, and nothing is withheld from them;
  filtering there would cost recall while protecting nobody. A delegated agent
  sees public and internal; anything leaving the machine sees public only. An
  audience nobody registered is fail-closed to the narrowest ceiling, and a record
  that declares no class is treated as internal — absence is never `public`.
- **`scope`** — a record that names the repos or environments it holds in is out
  of delivery in every other one; a record that names none constrains nothing, and
  a caller that states no world asks no question (§9.2).

Three things this deliberately is **not**. It is not the write-time approval
ladder: that answers «may this record exist», this answers «may it be shown», and
the two read some of the same fields without being the same question. It is not a
content filter — it reads typed fields only, never the note's body, so nothing a
record says in prose can argue its way into a payload. And it does not touch the
index: a hidden record is out of the **delivery**, not out of the corpus, and its
area index still catalogues it with the state named — an index is a map, not a
payload.

What remains unenforced is **permission** in the harness sense: this layer knows
nothing about who is running the agent, so `audience` is a parameter its caller
states, not an identity it verifies. For that half — and for anything a caller
mis-declares — the defense is still placement: material that must not be seen at
all must not be in the corpus. That is the same reading as
[`MEMORY-THREAT-MODEL.md` §2.4](MEMORY-THREAT-MODEL.md#24-what-is-enforced-where--an-honest-map)
and non-goal 5 in [§7](MEMORY-THREAT-MODEL.md#7-non-goals).

### 9.2 scope and applies_to

`scope` is a block (`repos`, `paths`, `environments`): the world in which the claim
is meant to hold. `applies_to` is a top-level list: what the claim is *about*.

### 9.3 The private-facet ban

A facet value that is meaningless outside the installation that minted it —
a work-cycle number such as `phase:12.3` — is **forbidden in a `public`-class
record**, in either `applies_to` or `retrieval.areas`. An `internal` record may
carry as many of them as it likes; that is what internal means. The rule exists
because such a value tells an outside reader nothing and tells them something about
the inside: exactly the leak the release scan exists to catch. The lint enforces it
as a critical finding.

### 9.4 One claim per record

**A reviewed record carries exactly one durable claim.** A record with two
assertions cannot be superseded, contradicted or expired as a unit: half of it may
go stale while the other half stays true, and there is no way to say so. The law is
enforced in three places — the validator (a `claim` must be a single string), the
write path (a list, an empty claim or a bullet list inside one string is refused with
the instruction to split), and the corpus lint.

### 9.5 Episodes — the other half of the representation

Narrative belongs somewhere, and that somewhere is not a reviewed record. Episodes
are the dual representation:

- they live in `episodes/` inside the corpus — same git-diffable world, separate
  class;
- they are **multi-claim legal**: an episode may carry a dozen assertions in its
  body, and is never held to the record disciplines of §3.1;
- they carry a **minimal archive field set** — identity, lifecycle state, storage
  class, language, the recording date, plus the supersession pointers and dates that
  apply — because inventing evidence or a fingerprint during an archival pass would
  fabricate provenance;
- they are **excluded from default retrieval**: the corpus walk is flat and does not
  descend into `episodes/`, so history is available by explicit reference and never
  loaded by accident;
- a claim extracted from an episode carries `derived_from: <episode id>` — the
  back-link that makes the history reachable from the doctrine.

A reviewed record whose body has grown into a running log (three or more line-start
dated update markers) is an episode wearing a record's clothes, and the lint says so.

### 9.6 Two structural fields

- `schema_version: 2` — mandatory; the parser accepts v1 and v2 side by side, and a
  note with no `schema_version` key is a v1 note, unconditionally.
- `status` — the lifecycle state (§6); hard-filtered at retrieval time.

## 10. Typed links

Wikilinks stay for humans; the machine layer uses typed edges. A `links` entry is a
`{type, ref}` pair:

`derived_from` · `supports` · `contradicts` · `supersedes` · `caused_by` ·
`applies_to` · `exception_to` · `requires` · `verified_by` · `owned_by` · `part_of`

The graph is built for questions, not beauty: an edge earns its place only if it
improves a concrete retrieval, temporal-resolution or verification query.

**Enforced, not conventional:** the *shape* of `links` is enforced by the grammar and
the vocabulary above **is a closed enum** — `LINK_TYPES` in `schema-v2.mjs`, checked by
`checkLinks`, which the record validator runs in its structure tier. A type outside the
eleven is refused with a `links[i].type: "…" is outside the closed vocabulary (…)`
finding, and an entry with no `ref`, or a `ref` that is not a string, is refused the
same way; the corpus lint surfaces both as `MEM-V2SCHEMA` criticals. Absence stays
legal — a record that claims no edges claims nothing false. The two edges the tooling
itself writes are the supersession pair (§5, top-level fields) and `derived_from`
(§9.5); the back-pointer `superseded_by` is a top-level field, not a member of this
vocabulary.

### 10.1 The graph is a projection, not an artifact

The graph is **computed from the records' own `links` fields on demand and thrown
away**: `projectLinks` (pure, over already-parsed notes) and `linkGraphFromCorpus` (the
one function that reads the disk) in `scripts/sma/lib/links.mjs`.
The projection is **never persisted** — no graph file, no graph database, no
per-note graph artifact. Nothing
derived from it can become a second source of truth about the corpus, and deleting
anything it ever returned destroys no knowledge, because the edges live in the records.

Two limits, stated rather than implied:

- **Direction and symmetry are not enforced.** An edge points from the record that
  declares it to the record it names, and no inverse edge is required at the other end.
  The one pair that is symmetric — `supersedes`/`superseded_by` — gets that symmetry
  from `applyLifecycle`, which writes both ends atomically, not from this vocabulary.
- **A dangling reference is reported, not repaired.** An edge whose `ref` names no
  record in the corpus is listed in the projection's `dangling` set and left out of the
  traversable graph; an edge the validator refuses is listed in `refused`. Neither is
  rewritten: this codebase does not edit records it did not author.

## 11. Corpus integrity lint

Integrity is one deterministic pass over the whole corpus — exit-code contract,
runnable in CI and pre-ship. It is **read-only by law**: nothing in it fixes, stamps,
deletes or expires anything. A stale fingerprint and an expired claim are *review
triggers*; a checker that silently rewrote the corpus it judges could never be
trusted to judge it.

Two laws bound the record checks: a note with no `schema_version` is invisible to
them (a corpus that has not migrated lints today exactly as it linted yesterday),
and a schema-v2 record is invisible to the v1 completeness check (migration must not
turn a corpus permanently red).

### 11.1 The record checks

| Check id | Tier | Fires on |
|---|---|---|
| `MEM-V2SCHEMA` | critical (+ warn) | Every structure finding from the record validator, plus the id law, plus a record the shared grammar cannot write back. Discipline findings arrive as **warn** while a record is inside the migration grace (§11.2). |
| `MEM-ONECLAIM` | critical (+ warn) | A reviewed record with a missing or list-valued `claim`. **Warn** when the body carries three or more line-start dated update markers — an episode wearing a record's clothes (§9.5). |
| `MEM-FPDRIFT` | warn | `fingerprint.product_version` differs from the product's current version, or a `tree_hash` that no longer matches the files it names. An unavailable git runner or unreadable path produces an explicit **unverified** warning. |
| `MEM-EXPIRE` | warn | `status: active` with `valid_until` strictly in the past (UTC, date-only), or a `valid_until` nobody can parse. Never mutates anything. |
| `MEM-SENSPLACE` | critical + warn | **critical:** a `sensitive`/`encrypted-required` record carrying a public or preset audience marker. **warn:** sensitive-shaped content in a record that declares `sensitivity: public` or declares no class at all. |
| `MEM-PRIVFACET` | critical | An installation-private facet inside `applies_to` or `retrieval.areas` of a **public-class** record (§9.3). |
| `MEM-EPISODE` | warn | An episode missing a minimal archive field, breaking the id law, or declaring the wrong schema version, memory type or status. The one check that descends into `episodes/`. |

The corpus-wide checks that predate the schema still apply to both grammars — among
them `MEM-VOCAB` and `MEM-ALIAS` (the closed tag/area vocabulary), `MEM-SUPERSEDE`
(pointer integrity), `MEM-SECRET` (credential shapes at the corpus door),
`MEM-ORPHAN` and `MEM-REGEN` (the generated index), and the size budgets. `MEM-SCHEMA`
is the v1 completeness check and skips v2 records by design.

### 11.2 The migration grace

A record that declares `migrated_from: v1` gets the two disciplines of §3.1 as
**warnings** instead of errors: a claim migrated out of a v1 note genuinely does not
know who stood behind it, and locking it out of the corpus it already lives in would
make migration impossible. Structure findings — required fields, closed vocabularies,
the one-claim law, the fingerprint shape, the external-artifact horizon — are
**always errors**, migrated or not.

The grace is not an exemption, because it has a stated horizon: **the close of the
current measurement cycle**. After that, the graced findings become errors. The
horizon is a named milestone rather than a date on purpose — the calendar meaning
belongs to whoever runs the installation, not to the schema. Every graced warning
names the horizon in its own message.

Which findings the grace covers is *discovered*, not declared: the checker asks the
validator the same question twice — once as the record is, once as if it had been
authored natively — and treats the difference as the graced set. A new discipline
rule is therefore graced correctly without anyone remembering to update the lint.

## 12. Backward compatibility: v1 → v2

A v1 note carries `description`, `kind`, `tags`, `use-when`, `importance`. Every v1
field has a defined destination:

| v1 field | v2 destination | Notes |
|---|---|---|
| `description` | `claim` | One durable claim per record; surrounding narrative becomes a linked episode (`derived_from`). |
| `kind` | `memory_type` + `truth_mode` | Seeded from the table below; the human confirms. |
| `tags` | `retrieval.areas` | 1:1, verbatim — the same closed vocabulary. |
| `use-when` | `retrieval.hint` | Carried whole. |
| `use-when-pattern` | `retrieval.paths` | |
| `reflex` | `retrieval.reflex` | |
| `importance` | `criticality` + `context_priority` | `criticality: high` at 8 or above, else `medium`; `context_priority: always` at 9 or above, else `on-demand`. The other four fields of §8 start unset. |
| `valid_from` · `valid_until` · `supersedes` · `superseded_by` · `superseded_at` | same names | Verbatim. |
| *(absent in v1)* | `source`, `evidence`, `fingerprint`, `verification` | **Not invented.** A migration that fabricated provenance would be worse than one that admits it has none. |

Every migrated record is stamped `migrated_from: v1`, `status: active`,
`recorded_at: <today>`, `language: <detected>` and a `sensitivity` class. A v1 field
with no destination is **reported**, never carried blind — carrying an unknown nested
block into a v2 leaf would emit corruption wearing a transform's clothes.

Seed mapping for `kind` (confirmed per note, never assumed):

| v1 kind | memory_type | truth_mode | disposition |
|---|---|---|---|
| `bug-lesson` | `procedural` | `factual` | record |
| `procedural-rule` | `procedural` | `normative` | record |
| `decision` | `semantic` | `decision` | record |
| `reference` | `semantic` | `factual` | record |
| `feedback` (legacy kind) | `normative` when the text speaks in standing-rule language, else `preference` | `normative` / `decision` | record |
| `status` · `handoff` · `episodic` | `episodic` | `observed` | **episode archive** |
| *(unmapped)* | `semantic` | `inferred` | record |

Overriding all of it: a note that **declares its own retirement** — a
`superseded_by`, a retired `status`, or a `valid_until` that has passed — is archived
whatever its kind says.

### 12.1 The migration law

**Migration is preview-only.** The tool never rewrites a v1 note in place. It
*proposes* a v2 rendering as a staged draft plus a diff; a human accepts or rejects
each one, **one file at a time, naming the file**:

```bash
# PREVIEW (the default) — stage proposals, print the report, write nothing else
sma memory migrate [--preview] [--corpus <dir>] [--json]

# APPLY — exactly ONE proposal, naming its own source, with an explicit yes
sma memory migrate --apply <draft> --confirm <source-file> --yes [--corpus <dir>]
```

There is no bulk-apply path — not as a flag, not as a function. Consent that can be
given in bulk is not consent to anything in particular. Until a proposal is accepted
the v1 note remains canonical and the parser keeps reading it as-is: one hundred
percent of the v1 corpus stays readable with zero edits, forever if the owner never
accepts a single proposal. The ritual in full is
[`MEMORY-LIFECYCLE.md` §6](MEMORY-LIFECYCLE.md#6-the-migration-ritual).

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

The proposed v2 record — shown to the human as a diff, never auto-applied. **The
field order below is the schema's fixed emit order**: a record written in this order
re-serializes to the exact same bytes, which is what makes a round-trip diff mean
something. Absent optional keys are omitted rather than left empty.

```yaml
---
id: mem-checkout-retry-001
schema_version: 2
status: active
migrated_from: v1
memory_type: procedural
truth_mode: normative
claim: Every payment retry must send the idempotency key of the original attempt.
language: en
scope:
  repos: [web-shop]
  paths: [src/checkout/**, src/payments/**]
  environments: [production, staging]
applies_to: [checkout, payments]
source:
  authority: self-observed
  refs: [incident:2026-03-12-double-charge]
evidence:
  - type: test
    ref: test:checkout-retry-idempotency
fingerprint:
  product_version: 5.1.0
  tree_paths: [src/checkout/retry.ts, src/payments/client.ts]
  tree_hash: 9f2c41d7a1b3
observed_at: 2026-03-12T22:41:00Z
recorded_at: 2026-03-14T09:30:00Z
valid_from: 2026-03-14
criticality: high
frequency: medium
confidence: 0.97
freshness: 2026-03-14
context_priority: on-demand
risk: medium
sensitivity: internal
retention: until-revoked
retrieval:
  areas: [checkout, payments]
  paths: [src/checkout/**, src/payments/**]
  hint: touching checkout retry or the payment client
verification:
  command: npm test -- checkout-retry-idempotency
  expected: exit-code-0
links:
  - type: verified_by
    ref: test:checkout-retry-idempotency
derived_from: episode-2026-03-12-checkout-outage
---
The 2026-03-12 incident narrative lives in the linked episode record.
This claim carries only the durable rule and its check.
```

The full emit order, for reference:

`id` · `schema_version` · `status` · `migrated_from` · `memory_type` · `truth_mode` ·
`claim` · `language` · `scope` · `applies_to` · `source` · `evidence` ·
`fingerprint` · `observed_at` · `recorded_at` · `valid_from` · `valid_until` ·
`criticality` · `frequency` · `confidence` · `freshness` · `context_priority` ·
`risk` · `sensitivity` · `retention` · `retrieval` · `verification` · `links` ·
`derived_from` · `supersedes` · `superseded_by` · `superseded_at`

A key outside this list is not dropped — silent data loss is the failure the shared
read/write path exists to prevent — but it is emitted after the known keys and the
validator reports it: kept as-is, with nothing validating it.

## 13. Change log

| Version | Date | Change |
|---|---|---|
| 1.2 | 2026-08-03 | §8 states what `criticality` is worth on the shared weight axis: a record with no `importance` number of its own now weighs its grade (`low` 2 · `medium` 5 · `high` 8 · `critical` 8), with `context_priority: always` keeping the always-load floor above it. Behavior changed with it: migrated records stop weighing zero, so a knowledge item whose grade clears the reflex silence threshold fires pre-act where it used to stay quiet, and a graded record sorts ahead of an ungraded one inside its area index. A stated `importance` still wins, and no grade moves a record into or out of always-load membership. No schema change. |
| 1.1 | 2026-08-03 | §9.1 now describes an implementation instead of a target: the read-time hard filters are code (`isVisibleNow` — status, valid time, sensitivity by audience, repo/environment scope), executed as a filter chain before ranking on both output points of a pack. One behavior changed with it: a `superseded`/`revoked` record no longer reaches the delivered periphery, only its area index. Still unenforced and named as such: permission — `audience` is a parameter the caller states, not an identity this layer verifies. No schema change. |
| 1.0 (correction) | 2026-08-02 | §9.1 corrected, not extended: the hard retrieval filters were written as if they ran, and only the `status` filter on CORE membership does. The paragraph now separates the contract from the implementation and names placement as the defense until read-time class filtering lands, which is what `MEMORY-THREAT-MODEL.md` §2.4 and non-goal 5 have said all along. No schema or behavior changed. |
| 1.0 | 2026-08-02 | First landed version. Reconciled with the shipped code throughout: the authority scale (`owner-instruction` · `external-review` · `self-observed` · `inferred`), the composite fingerprint (`product_version` + optional `tree_paths`/`tree_hash`) and its single hash definition, the external-artifact horizon, six lifecycle statuses including `draft`, four sensitivity classes ending in `encrypted-required`, `context_priority: always/on-demand` and `risk: low…critical`, the required field set including `language`, `applies_to` and the private-facet ban, the one-claim law, the episodes dual representation, the real lint check ids and tiers with the migration grace and its horizon, the landed v1→v2 transform table, the migration verb syntax with per-file acceptance, and a worked example in the schema's fixed emit order. |
| 0.1 | 2026-07-31 | Initial draft: types, truth modes + FACT/INTERPRETATION disciplines, provenance incl. fingerprint, temporal model, lifecycle, sensitivity/storage classes, importance split, retrieval block, typed links, integrity lint, v1→v2 mapping + migration law. |
