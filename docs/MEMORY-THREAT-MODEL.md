# SMA Memory Threat Model 1.0 — storage classes, failure semantics and untrusted retrieval

| | |
|---|---|
| Status | **1.0 — landed.** Every rule marked *enforced* below is shipped code with test coverage; every rule marked *policy* is a written decision with no code behind it yet, and says so in place. |
| Document version | 1.2 |
| Date | 2026-08-02 |
| Applies to | the memory corpus of one installation: `schema_version: 2` records, the v1 notes beside them, and the episode archive |
| Companion documents | [`MEMORY-MODEL.md`](MEMORY-MODEL.md) — what a record may say and must carry · [`MEMORY-LIFECYCLE.md`](MEMORY-LIFECYCLE.md) — how a record is written, approved and retired |

> **All examples in this document are synthetic archetypes.** They describe shapes
> of material — an admission about how something is defended, a waiver whose end
> date has passed, a version claim that no longer matches the product — never the
> contents of any real corpus.

> **The document follows the code.** Every check id, enum value, pattern and
> refusal below is taken from the shipped modules: `scripts/sma/lib/schema-v2.mjs`
> (classes, the storage-class resolver, the placement refusal, the approval
> ladder, the private-facet shape), `scripts/sma/lib/local-store.mjs` (the
> this-machine-only store), `scripts/sma/lib/lint.mjs` (the placement and
> integrity checks), `scripts/sma/lib/write-pipeline.mjs` (the redaction gate and
> the write path). Where this document and those modules disagree, the modules are
> right and this document is a bug.

[`MEMORY-MODEL.md`](MEMORY-MODEL.md) answers *what a record is*.
[`MEMORY-LIFECYCLE.md`](MEMORY-LIFECYCLE.md) answers *how it becomes one*. This
document answers *what could go wrong with it, and which of those things the
system actually stops*.

---

## 1. What this document defends

Memory is the one part of an agent system that outlives the session that made it.
That is its value and its whole risk surface: a claim written once is read back
for months, by tools and by people who never saw it being written. Four failure
families follow from that:

1. **Material sits where it must not sit** — something confidential ends up in a
   store that gets published, exported or shipped as a preset (§2).
2. **A guard fails and nobody notices** — a subsystem breaks and the system keeps
   going as if it had passed (§3).
3. **Retrieved text is obeyed instead of read** — a stored note behaves as an
   instruction to whoever loads it (§4).
4. **A claim borrows authority it does not have, or keeps authority it has lost**
   — provenance is spoofed, or it silently goes stale (§5).

The defenses are deliberately unglamorous: a small set of typed fields, a
deterministic pass over the corpus, and a write path that refuses more often than
it writes. None of them depends on a model call.

## 2. Storage classes

### 2.1 The class map

**Three storage classes, on one axis: who will see this record.** The names are
the whole design — a person can answer "who sees it" without reading a manual,
and there is nothing else to learn. The vocabulary is frozen in code as
`STORAGE_CLASSES` (`scripts/sma/lib/schema-v2.mjs`), ordered from the lightest to
the strictest.

| Storage class | Who sees it | Where its records physically live | `sensitivity` values that resolve to it |
|---|---|---|---|
| **Shared** | the project's people — it travels with the team and with the repository | the corpus directory, inside the project's git | none declared · `public` · `internal` |
| **Ephemeral** | the same people, and nobody after the date | the corpus directory, carrying the lifetime window that retires it | any non-restricted value **plus** a `retention` window or a `valid_until` horizon |
| **This-machine-only** | only this machine; the material never enters git at all | the local store, outside the corpus directory, which keeps itself out of git (`scripts/sma/lib/local-store.mjs`) | `sensitive` · `encrypted-required` |

The schema's `sensitivity` field remains a **four-value closed vocabulary**. The
three classes are DERIVED from it and from the record's lifetime fields; no new
frontmatter field was introduced, because a boundary a person has to learn a new
field to use is a boundary most records will miss.

**How a record gets its class.** `resolveStorageClass(record, {now})` is pure and
fail-closed, and applies its rules strictest first:

1. a `sensitivity` outside the closed four is **refused**, not defaulted — an
   unreadable label is not a permit, and quietly calling it shared would turn a
   typo into a publication;
2. `sensitive` and `encrypted-required` resolve to **this-machine-only**, whatever
   else the record says, including a lifetime window: the strictest rule wins;
3. a `retention` window or a `valid_until` horizon resolves to **ephemeral**;
4. everything else is **shared**.

The verdict names the field and the rule that decided, so it can be argued with.
The optional `now` is used only to report whether a horizon has already passed; it
never changes a class.

**What happens when a record is aimed at the wrong place.**
`storagePlacementDenial(record, {targetDir, localDir})` answers the placement
question in the same module, because legality has one authority. The write path
consults it **before any byte is written**, and a denial is terminal — nothing is
written, not even partially. Both of the write path's doors are gated: the corpus
door (`persist`) and the drafts door (`stage`). Gating only the corpus door would
leave the boundary open in practice, because a restricted record never reaches
that door — the approval ladder escalates it and routes it to drafts, and the
drafts directory sits inside the same git working tree. The gate also refuses when
the class could not be read at all, and when no local store directory was named
for the write: a destination nobody named is not a permission.

**Why ephemeral is not a `sensitivity` value.** "How long may this live?" and "who
may see this?" are independent questions, and folding them into one field would
make both unanswerable. A short-lived record is expressed by its lifetime fields —
`retention` (a window or `{ttl, until}`) and `valid_until` — at any
confidentiality class. The write path treats this as load-bearing rather than
decorative: **the one automatic write path refuses a record with no lifetime
window at all**, on the grounds that an unreviewed memory must be able to expire
by itself ([`MEMORY-LIFECYCLE.md` §1.7](MEMORY-LIFECYCLE.md#17-step-7--risk)). The
same predicate (`hasLifetimeWindow`) answers that question and derives the
ephemeral class, so the two cannot drift apart.

**Two classes this product deliberately does not have.** Both are removed by a
product decision, not missing by oversight, and neither is coming back through a
side door.

- **Regulated memory is removed from the product entirely**, together with any
  separate breakdown of medical versus personal data. There is one axis here, who
  sees it, and adding a class for material this substrate cannot actually govern
  would advertise a capability it does not have. §7 states the same thing as a
  non-goal.
- **A separate "private git" class is removed** because for a user that is not a
  distinct mechanism — it is a private repository, which the shared class already
  describes. A new entity there adds a word to learn and changes nothing about
  where a record sits.

Neither removal touches the credential scan at the write gate, and it stays. That
scan is about a password never reaching the text in the first place, not about
categories of data — there is no class that may hold a live credential (§3).

### 2.2 What each class forbids

| `sensitivity` | Forbids |
|---|---|
| `public` | Secrets; personal data; installation-private facets; unreviewed claims. |
| `internal` | Secrets; regulated personal data; anything that may later require guaranteed physical erasure — a git history cannot promise it. |
| `sensitive` | Sitting anywhere a public or preset export can read it. |
| `encrypted-required` | Everything `sensitive` forbids, **plus living in a git-backed class at all** — which today means it must not enter the corpus (§6). |

The class also decides the approval path: `sensitive` and `encrypted-required`
escalate to the strictest path before any other consideration
([`MEMORY-MODEL.md` §7](MEMORY-MODEL.md#7-sensitivity-and-storage-classes),
[`MEMORY-LIFECYCLE.md` §3](MEMORY-LIFECYCLE.md#3-the-risk-approval-ladder)).

### 2.3 Placement rules, exactly as enforced

Placement is checked by two corpus checks. Both are described here as they behave,
not as they ideally would.

**`MEM-SENSPLACE` — sensitive material never sits where a public or preset export
can see it.** It has two halves with different tiers:

- **Declared contradiction → critical.** A schema-v2 record whose class is
  `sensitive` or `encrypted-required` *and* which also declares a public-facing
  audience is wrong on its own terms. The audience sweep is deliberately broad: it
  reads every sub-key of `scope` and `retrieval`, plus `applies_to`, and treats
  the values `public`, `preset`, `published`, `release` and `open`
  (case-insensitive) as audience markers. One finding is raised per marker, and
  the message says plainly that guessing which of the two — the class or the
  audience — is the mistake is not the checker's job.
- **Undeclared content → warn.** Records that declare `sensitivity: public`, and
  every record that declares **no class at all** (which is every pre-schema note),
  are additionally scanned for content shapes that read as sensitive regardless of
  what the record says about itself. The scan covers `description`, `claim` and
  the body. Two shape families are screened: a **security-posture admission** (the
  archetype: a note recording that some account or system has no second factor)
  and a **personal identifier** — a personal email address, or a home-directory
  path — using the same two patterns the write path scrubs with, so the two sides
  cannot drift apart. Internal and restricted classes are **out of scope** for
  this half: material already stored where it belongs is not a finding.

  This tier is a deliberate choice, not caution. A pattern match is a guess, and a
  guess must never hard-block a commit; the finding says *classify it or remove
  the material*, and a human decides which.

**`MEM-PRIVFACET` — installation-private facets stay out of public-class
records → critical.** A facet value meaningless outside the installation that
minted it — a work-cycle number shaped `phase:<number>` — is forbidden inside
`applies_to` or `retrieval.areas` of a **`public`-class** record. An `internal`
record may carry as many as it likes; that is what internal means. The rule exists
because such a value tells an outside reader nothing while telling them something
about the inside: exactly the leak a release scan exists to catch
([`MEMORY-MODEL.md` §9.3](MEMORY-MODEL.md#93-the-private-facet-ban)).

**The credential door is separate and stricter.** Credential-shaped material is
refused at the write path before anything is stored anywhere (§3), and screened on
disk by `MEM-SECRET` as a critical finding. Redaction is not a placement question:
there is no class that may hold a live credential.

### 2.4 What is enforced where — an honest map

| Boundary | Enforced by | State |
|---|---|---|
| A credential never reaches a durable store | write path, step 3 | **enforced** — hard refusal, nothing written |
| A personal identifier is scrubbed on the way in | write path, step 3 | **enforced** — scrubbed in place, walk continues |
| A restricted class never declares a public audience | `MEM-SENSPLACE` (critical) | **enforced** |
| An unclassified note holding sensitive-shaped content is surfaced | `MEM-SENSPLACE` (warn) | **enforced**, advisory by design |
| An installation-private facet never ships in a public-class record | `MEM-PRIVFACET` (critical) | **enforced** |
| A restricted class routes to the strictest approval path | the approval ladder | **enforced** |
| This-machine-only material never reaches a git-backed path | `storagePlacementDenial`, consulted by the write path at both doors (`persist`, `stage`) | **enforced** — refusal before any byte; nothing is written, not even partially |
| A record whose class cannot be read is treated as the most restrictive plausible class | `resolveStorageClass` | **enforced** — refused, never defaulted to shared |
| The local store stays out of git without anyone editing a repository-level ignore file | `ensureLocalStore` (`local-store.mjs`) | **enforced** — the store writes its own ignore marker inside itself; a deleted marker is restored, a changed one is left alone and reported |
| `encrypted-required` content is encrypted at rest | — | **policy only** (§6): placement is enforced in code, the cipher decision is open |
| Retrieval filters by `status` and valid time at load time | the read engine (`isVisibleNow`, before ranking) | **enforced** — a retired or out-of-window record is out of the delivery, on both output points of a pack; it stays catalogued in its area index with the state named |
| Retrieval filters by class at load time | the read engine (`isVisibleNow`, before ranking) | **enforced for a declared audience**: the caller states the consumer class and a record above its ceiling is not delivered (unregistered audience → narrowest ceiling; undeclared class → treated as internal). The default consumer is the local owner, who is withheld nothing |
| The consumer's audience is *verified* rather than declared | — | **not yet**: this layer knows nothing about who runs the agent. `audience` is an argument, not an identity — a caller that mis-declares it is not caught here |

The last two rows are the ones worth reading twice. Read-time filtering is now
real, and it is **structural**: it reads typed fields — never a note's body — so
it removes what is retired, out of its window or above the stated audience's
ceiling. It cannot remove what should never have been stored, and it cannot
detect a caller that names the wrong audience. For that half **the defense is
still placement, not redaction at read time**: material that must not be seen must
not be in the corpus; nothing downstream will catch it later.

## 3. Failure semantics

A guard that fails silently is worse than no guard: it converts an outage into a
false assurance. Every part of the memory layer therefore has a declared failure
direction.

| Category | On failure |
|---|---|
| Style hints, citation logging, optional telemetry | **fail-open** |
| Optional derived index | **fail-open** to deterministic retrieval |
| Journalling of an event | **fail-open**, recorded as degraded |
| Measurement hook | **fail-open** |
| Credential (secret-class) screening | **fail-closed** |
| Class determination for the approval ladder | **fail-closed** |
| Corpus-door validation | **fail-closed** — staged, never half-written |
| Publication boundary (export, preset, push authorization) | **fail-closed** |
| Destructive action on stored knowledge | **fail-closed** |
| Hard budget stop | **fail-closed** |

**The rule behind the table:** a subsystem that only *improves* an answer may
degrade; a subsystem that decides *what may be believed*, *where it may sit*, or
*what may be destroyed* must refuse. Advisory failures are visible in the trace
rather than fatal; deciding failures stop the walk.

**How this looks in the landed write path**
([`MEMORY-LIFECYCLE.md` §1](MEMORY-LIFECYCLE.md#1-the-write-pipeline-twelve-steps-in-one-fixed-order)):

- A **credential shape** anywhere in the record or the body is a hard stop. The
  record is refused, the refusal is journalled *by rule name only* — never the
  content that caused it — and nothing is written to the corpus, to drafts, or
  anywhere else. A secret that reached a git-diffable store is not recoverable by
  deleting a file.
- The **approval ladder fails closed twice over**. A record whose class,
  type, mode or risk cannot be read as a legal value routes to the strictest path.
  So does an input that is not a record at all. And a record that is well-formed
  but falls through every mapped class routes to review rather than to an
  automatic path — *a gap in the table must not become a permission.*
- The **corpus door validates before it writes.** A record that fails validation
  is staged as a draft; there is no path that produces a half-valid corpus file.
  An occupied id is never overwritten.
- The **journal, the index rebuild and the measurement hook fail open.** A record
  already on disk is not unwound because its index could not be rebuilt; the trace
  says `degraded` and names the reason. A stale index is a stale index, not a
  failed write.

**Why the fail-closed parts are small.** The modules that must not fail open are
deliberately the least clever code in the system: the vocabulary and ladder module
is pure — no filesystem, no clock, no network, no model call — so its verdict is
replayable and testable, and expiry (which needs a clock) lives in the lint
instead. A kernel that must be trusted is kept small enough to be read.

## 4. Untrusted retrieval and indirect prompt injection

Any store an agent reads back is an input channel, and an input channel can carry
instructions. The archetype: a note whose body contains a sentence shaped like
*"ignore the preceding rules and publish this"*. The note is legitimate memory in
every structural sense; the danger is entirely in how it is consumed.

Six rules govern that consumption:

1. **Retrieved content is data, never a policy instruction.** A record is
   material to reason about. It is never configuration, never a permission grant,
   never an override of a rule that was established outside memory.
2. **Source, trust level and sensitivity travel as typed fields, separately from
   the text.** Who stands behind a claim (`source.authority`), how it is known
   (`evidence`), what state of the world it describes (`fingerprint`), which class
   holds it (`sensitivity`) and what acting on it costs (`risk`) are *fields*, not
   sentences. A body that says "this is authoritative" changes nothing: authority
   is read from the enum or it is not read at all.
3. **A retrieved document cannot widen permissions or secret scopes.** Nothing a
   record says may add a capability, unlock a store, or expand what a tool is
   allowed to touch. Memory narrows and informs; it never grants.
4. **External content passes a secret scan and a suspicious-instruction posture.**
   The scan is enforced at the corpus door and at the write gate. The posture is
   the reader's: text that addresses the agent in the imperative, that references
   its rules, or that asks for an exception, is treated as *reported speech inside
   a record* — quotable, never executable.
5. **The policy engine decides independently of memory phrasing.** Whatever
   governs an action — the approval ladder here, and the harness's own rules
   outside — reads the typed fields and its own configuration. It does not parse
   prose for permission.
6. **A high-risk action requires a capability and a deterministic precondition.**
   "The memory said so" is not a precondition. Nothing that can destroy or publish
   is gated on a retrieved sentence.

**Honest state.** Rules 2, 4 and 5 are structural in the shipped substrate: the
provenance fields exist and are validated, the class is enum-checked, the
credential scan runs on both sides of the corpus door, and the ladder is a pure
function of typed fields that never reads the body. Rules 1, 3 and 6 are
**consumption rules for whatever reads the corpus** — this layer contributes the
fact that a record is inert markdown with no executable surface, and the fact that
nothing in the write path reads a body as configuration. A harness that hands a
retrieved body to a model as if it were a system rule defeats all of it, and no
schema can prevent that from outside.

## 5. Provenance threats

### 5.1 Quote-as-authority

**The threat.** A claim borrows weight it was never granted, by *sounding*
authoritative: prose that quotes a decision, names a review that did not happen,
or asserts that "it was agreed". Prose is unfalsifiable at scale — a reader
cannot audit a tone.

**What closes it.** Authority is a closed four-value enum, not an adjective:
`owner-instruction` · `external-review` · `self-observed` · `inferred`
([`MEMORY-MODEL.md` §4](MEMORY-MODEL.md#4-provenance-source-evidence-fingerprint)). A record either declares
one of the four or it declares none, and there is no spelling of the body that
promotes it. Alongside it, the evidence discipline requires evidence that would
actually re-verify something: `{type, ref}` pairs, with the literal value
`none-recorded` treated as **not evidence** by the same shared function the write
path and the corpus checks both call. An interpretation-class record with neither
a declared authority nor real evidence does not pass the discipline checks — as an
error for a natively authored record, and as a warning while a migrated record is
inside its grace ([`MEMORY-MODEL.md` §11.2](MEMORY-MODEL.md#112-the-migration-grace)).

The point is not that a human cannot lie in a typed field. It is that a lie in a
typed field is a *specific, auditable, greppable* lie, while a lie in prose is a
matter of interpretation.

### 5.2 Stale facts

**The threat.** A claim was true about a state of the world that no longer exists.
The archetype: a note stating that the current release is one epoch, while the
shipped product is several epochs further on. Nothing about the note looks wrong —
it simply describes a world that has moved.

**What closes it.** Code-dependent claims carry a composite fingerprint: the
product version, plus an optional hash of the specific paths the claim depends on.
`MEM-FPDRIFT` (**warn**) fires when the recorded version differs from the
product's current one, or when a path hash no longer matches the files it names.
When the check cannot verify — no git runner, an unreadable path — it says
**unverified** explicitly rather than passing quietly.

### 5.3 Expired claims that still read as current

**The threat.** A time-boxed permission or exception outlives its window. The
archetype: a waiver granted until a date that has passed, whose note still says
`status: active` and still loads as doctrine.

**What closes it.** `MEM-EXPIRE` (**warn**) fires on any record with
`status: active` whose `valid_until` lies strictly in the past, and on any
`valid_until` no one can parse — a horizon nobody can compare against is the same
as no horizon. Claims about external artifacts (a URL, someone else's service) are
required to carry a horizon at all, precisely because they go stale without anyone
touching them ([`MEMORY-MODEL.md` §4.4](MEMORY-MODEL.md#44-claims-about-external-artifacts)).

### 5.4 Why none of these counters delete anything

**The corpus checks are read-only by law.** Nothing in the integrity pass fixes,
stamps, deletes or expires a record. A drifted fingerprint and a passed horizon
are *review triggers*, surfaced to a human who decides between re-verifying,
superseding and retiring. A checker that silently rewrote the corpus it judges
could never be trusted to judge it — and a corpus that edits itself has no
provenance left to audit.

## 6. Encryption: the policy, and the deferral

`encrypted-required` states a **requirement, not an implemented cipher**. Nothing
in this product encrypts anything. What the product does have is the other half,
and it is the half that cannot be added afterwards: **placement and prevention are
enforced in code** — the three classes, the local store, and a write path that
refuses to put this-machine-only material into a git-backed path (§2.1). **The
cipher decision is still open, and it is carried by a decision of its own with the
product owner's answer at its head.** This section is the written comparison that
decision starts from; it does not pre-empt it.

### 6.1 The two candidate families

| | **git-crypt** (GPG-based) | **age-based tooling** (e.g. SOPS with age recipients) |
|---|---|---|
| Granularity | Whole file, transparently, via repository filters | Selected values inside a structured file; keys and structure stay readable |
| Diff and review | An encrypted file is opaque in review | Structure and field names stay diffable; only values are opaque |
| Key custody | GPG keyring per collaborator, or a shared symmetric key file | Recipient keys; a file can be encrypted to several recipients at once |
| Rotation | Re-encrypt the affected files; old commits keep the old key's ciphertext | Re-encrypt affected values; recipients can be added or removed per file |
| Best fit | A mostly-public repository with a small, stable set of wholly secret files | A corpus whose metadata must stay machine-readable while some content must not be |
| Cost | Simple mental model; opaque history; unattended (no-terminal) use needs care | Richer model; one more tool and one more config file to keep correct |

### 6.2 Selection criteria, when the decision is taken

1. **Granularity.** A memory record is a markdown file whose frontmatter is
   machine-read. Whole-file encryption hides the frontmatter from the index, the
   lint and the loader; field-level encryption keeps them working but leaves the
   file shape visible. Which of those is acceptable is the first question, and it
   is not obvious — which is precisely why this is deferred rather than guessed.
2. **Recovery.** What happens when the key is lost? An encrypted corpus with no
   recovery story is a data-loss mechanism wearing a security feature's clothes.
3. **Custody and rotation.** Who holds keys, how a collaborator is added, how a
   departure is handled, and what "rotate" means for material already in history.
4. **Unattended use.** Any check that runs without a human present must either
   work without a passphrase or be explicitly out of scope for encrypted content.
5. **Dependency footprint.** The substrate law is files and git, no daemon, no
   database, no service. Any candidate that requires a running service loses on
   that ground alone.
6. **Cross-platform reality.** Whatever is chosen has to work identically on every
   platform the product supports, or it becomes a per-platform correctness
   difference.

### 6.3 Where this actually stands, stated plainly

**The cipher is not chosen, and no dependency has been added for it.** Neither
family above is chosen, prepared for, or partially wired in. This document
describes the candidates so that the decision, when it is taken, starts from a
written comparison instead of a preference. Do not read anything here as a claim
that encryption exists; do not read it as a claim that it never will.

**What did land is prevention, and it is code, not policy.**
`encrypted-required` and `sensitive` material does not enter a git-backed path at
all: the class resolves to this-machine-only, the write path refuses at both of
its doors before writing anything, the material's home is a store outside the
corpus, and that store keeps itself out of git by carrying its own ignore marker
rather than by trusting a repository-level file somebody has to remember to edit
(§2.1, §2.4). The class also may never carry a public-facing audience marker, and
it escalates to the strictest approval path.

**Why prevention rather than "encrypt it later".** Encryption added after the fact
does not retroactively protect anything: the plaintext stays in the history, and a
`git log -p` still returns it. There is no version of this that is fixed later.
That is exactly why this half shipped first and did not wait for the cipher
question to be settled.

### 6.4 The honest line about deletion

**If a record reached a commit, it is in the history — and in every clone of that
repository.** Deleting the file removes it from the working tree and from every
derived index; it does not remove it from the history, and nothing in this product
promises otherwise. Rewriting history to erase it is possible with repository-level
tooling (`git filter-repo`, or `git filter-branch` on older installations, followed
by a force-push and a re-clone by everyone who has a copy), but that is a manual,
irreversible operation that breaks every existing clone, and this product will not
do it on your behalf behind a friendly verb.

**The way to never need that is placement, and it is one decision made once:** put
material that must not be shown in the this-machine-only class, where it never
enters history at all. That is the whole argument for §2.1's third class, and it is
the same honest admission that produces the erase deferral
([`MEMORY-LIFECYCLE.md` §5.5](MEMORY-LIFECYCLE.md#55-erase-deferred-by-policy)):
prevention is the only thing a git-backed store can actually promise.

## 7. Non-goals

Stated explicitly, because an unstated non-goal reads as an oversight.

1. **Regulated memory is not in scope.** Data carrying retention obligations,
   jurisdictional constraints or a right to erasure needs a separately governed
   system with audited access, enforced retention and verified deletion. This
   substrate is markdown in a git working tree; it can promise none of those. The
   `sensitivity` vocabulary deliberately has **no** value for it, so that no
   record can claim a protection that does not exist.
2. **Physical erasure is not implemented.** It is refused by policy rather than
   missing by accident, with the refusal naming the reason, and it arrives — if it
   arrives — with lifecycle governance capable of verifying removal across every
   permitted store. What to do instead (prevent at the write gate and the classes;
   retire with `revoke` or `archive`; use repository-level tooling for history) is
   in [`MEMORY-LIFECYCLE.md` §5.5](MEMORY-LIFECYCLE.md#55-erase-deferred-by-policy).
3. **This is not a runtime policy engine or a capability broker.** The memory layer
   supplies typed provenance, a deterministic approval path and a set of refusals.
   Deciding what a tool may touch belongs to the harness that runs the agent.
4. **This is not a secret manager.** The only thing this layer does with a
   credential is refuse it, at both doors.
5. **Retrieval-time filtering is not access control** (§2.4). The class-based hard
   filters described in the model document now run before ranking, but they act on
   what the *caller declares* it is: this layer has no way to verify an audience,
   authenticate a consumer or revoke one. It narrows a delivery; it does not
   control access. Placement remains the defense against material that must not be
   seen at all.
6. **No threat here is defended by a model call.** Every guard named in this
   document is a deterministic check. That is a constraint on what can be
   defended, and it is chosen deliberately: a defense that depends on a model
   is a defense that a model can be talked out of.

## 8. Change log

| Version | Date | Change |
|---|---|---|
| 1.2 | 2026-08-04 | §2.1 rewritten to the **three** storage classes that shipped, on the single who-sees-it axis, with the mapping table and the two removals stated as product decisions: regulated memory (with any medical-versus-personal breakdown) and a separate private-git class are gone from the product; the credential scan is untouched by either. The classes stopped being a label and became a placement: `STORAGE_CLASSES` and `resolveStorageClass` derive the class fail-closed from fields the schema already had, `storagePlacementDenial` decides legality of a destination, and the write path consults it at BOTH doors — `persist` and `stage` — before any byte, because the drafts directory is a git-backed path too and is where the approval ladder actually routes a restricted record. `local-store.mjs` gives the this-machine-only class a home outside the corpus that keeps itself out of git by carrying its own ignore marker. §2.4 gained four enforced rows; §6 now says exactly where encryption stands — placement enforced in code, cipher decision open — and §6.4 carries the honest line about git history and clones. No new dependency, no cipher, no new frontmatter field. |
| 1.1 | 2026-08-03 | §2.4 and non-goal 5 updated to the landed read-time filters: `status`, valid time and `sensitivity`-by-audience are now enforced by the read engine before ranking (`MEMORY-MODEL.md` §9.1), so the «not yet» row became two enforced rows — and one new honest «not yet»: an audience is *declared* by the caller, never verified here. Filtering narrows a delivery; it is not access control, and placement stays the defense against material that must not be stored at all. No new guard is defended by a model call. |
| 1.0 | 2026-08-02 | First version. The five storage classes mapped onto the four-value `sensitivity` vocabulary with the two deliberate omissions and their reasons; what each class forbids; the placement rules exactly as the corpus checks enforce them, with tiers; an honest enforced/policy/not-yet map; the fail-open / fail-closed table with the landed write-path behavior behind it; the six untrusted-retrieval rules with their honest state; three provenance threats (quote-as-authority, stale facts, expired claims) with the typed fields and checks that counter them and the read-only law that keeps the counters advisory; the encryption policy — two candidate families, six selection criteria, and an explicit deferral with zero dependencies added; and six stated non-goals. |
