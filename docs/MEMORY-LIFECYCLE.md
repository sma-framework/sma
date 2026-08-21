# SMA Memory Lifecycle 1.0 — the write pipeline and how a record dies

| | |
|---|---|
| Status | **1.0 — landed.** Every step below is executable code with test coverage; where a behavior is deliberately absent, this document says so and says why. |
| Document version | 1.3 |
| Date | 2026-08-05 |
| Applies to | `schema_version: 2` records; v1 notes are read unchanged and are never written by this path |
| Companion documents | [`MEMORY-MODEL.md`](MEMORY-MODEL.md) — what a record may say and must carry · [`MEMORY-THREAT-MODEL.md`](MEMORY-THREAT-MODEL.md) — what the storage classes defend against |

> **All examples in this document are synthetic.**

> **The document follows the code.** The steps, their order, the refusal reasons
> and the verb syntax below are taken from the shipped modules —
> `scripts/sma/lib/write-pipeline.mjs` (the walk and the transitions),
> `scripts/sma/lib/migrate-v1-v2.mjs` (the migration), `scripts/sma/lib/schema-v2.mjs`
> (the vocabularies and the ladder), `scripts/sma/lib/lint.mjs` (the corpus checks).
> Where this document and those modules disagree, the modules are right.

[`MEMORY-MODEL.md`](MEMORY-MODEL.md) answers *what a record is*. This document
answers *how something becomes one, and how it stops being one*.

---

## 1. The write pipeline: twelve steps in one fixed order

The pipeline is the boundary between "something happened" and "the system now
believes this". It is twelve named steps, walked in exactly this order:

**observe · classify · redact · extract · compare · evidence · risk · persist ·
index · measure · consolidate · lifecycle**

**The order is law, not style.** An event is journalled before it is classified,
classified before it is scrubbed, scrubbed before it is examined, examined before
it is weighed, and weighed before a single byte is written. Re-ordering the list is
not a refactor — it is a change to what the system is allowed to believe.

Three properties hold across the whole walk:

- **Redaction precedes all persistence, including drafts.** Step 3 runs before any
  write path exists in the sequence. "Store it, then redact" would put a secret one
  `git log -p` away.
- **The machine never classifies.** The two fields that decide what a record *means*
  arrive from the caller and are checked, never guessed at or defaulted.
- **Effects live in named places only.** Journal appends (steps 1 and 10), the corpus
  write (8), draft writes (6/7/8 and 11), index artifacts (9), the transition
  pair-write (12), and one corpus read before the walk begins. Every other step is a
  pure function over the state object.

Each step records one entry in a **trace**: `{step, outcome, detail}`. The trace is
append-only — a step never edits history — so the finished walk answers "why does the
system believe this" (or "why did it refuse") without anyone re-running anything.

**Walking the pipeline is now machine-provable, not merely expected.** Steps 1 and 10
append to the write-pipeline journal, so a note that walked this road leaves an event
behind it and a note dropped into the corpus by hand does not — and `MEM-OFFPIPELINE`
in `sma lint` names every note of the second kind. A note filed before the rule existed
is reported as a **warning**, not a critical: an established corpus carries history, and
a rule that turned every inherited note into an error would be read as noise and muted,
which is the one outcome that would make the check worthless.

### 1.1 Step 1 — observe

**Does:** appends the event to the journal. Nothing may run before it: an event the
system refuses must still be a thing the system remembers being asked, or the refusal
is unauditable.

**Boundary:** the journal module (`appendEvent`, `lineHash`).

**What lands there is a pointer, never the payload** — a hash of the claim, its length
and the record id. The content has not been through step 3 yet, so writing it here
would put an unscrubbed secret on disk: the exact failure the pipeline exists to
prevent.

**Stops the walk:** never. An unwritable journal degrades the trace (`degraded`) and
the walk continues — a memory system that cannot write its log must still refuse
secrets.

### 1.2 Step 2 — classify

**Does:** checks `memory_type` and `truth_mode`, supplied by the caller, against the
closed vocabularies of [`MEMORY-MODEL.md` §2](MEMORY-MODEL.md#2-memory-types) and
[§3](MEMORY-MODEL.md#3-truth-modes).

**Boundary:** the schema vocabulary module.

**Stops the walk: yes — hard rejection** when either value is missing or outside its
vocabulary. The refusal names the field, the offending value and the allowed list.
There is no default and no inference: a machine that may pick its own truth mode can
promote a guess to a fact, which is the anti-pattern the memory model forbids outright.

### 1.3 Step 3 — redact

**Does:** scans every string leaf of the record plus the body for two classes of
material. Credential shapes come from the codebase's single redaction vocabulary;
personal shapes (an email address, an absolute home-directory path) are a separate,
lighter class.

**Boundary:** the flight-check secret scanner, plus the personal-shape vocabulary this
module owns and exports (so the corpus lint can ask the same question about material
already on disk, instead of keeping a second copy that would drift).

**Stops the walk:**

| Finding | Outcome |
|---|---|
| Credential shape | **HARD STOP.** The record is refused, the refusal is journalled with **rule names only, never the content**, and nothing is written anywhere — not the corpus, not drafts. A secret that reached a git-diffable store is not recoverable by deleting the file. |
| Personal shape | Scrubbed in place to `[redacted:<rule>]`; the walk continues and the trace names the rules that fired. |

### 1.4 Step 4 — extract

**Does:** enforces the one-claim law
([`MEMORY-MODEL.md` §9.4](MEMORY-MODEL.md#94-one-claim-per-record)).

**Stops the walk: yes — rejection** when `claim` is a list, is missing or empty, or is
a single string carrying a bullet list. Every refusal carries the same guidance: split
it into separate records, one claim each, and run each through the pipeline. Narrative
that genuinely holds many claims belongs in an episode
([`MEMORY-MODEL.md` §9.5](MEMORY-MODEL.md#95-episodes--the-other-half-of-the-representation)).

### 1.5 Step 5 — compare

**Does:** holds the candidate up against what the corpus already says — contradictions,
duplicate claims, supersession candidates, `supersedes` pointers that resolve to
nothing, and overlapping validity windows on a shared area.

**Boundary:** the consolidation module's contradiction detector — the **one** detector
in this codebase. It reads the v1 note vocabulary, so a v2 record is projected onto it
(claim as description, retrieval areas as tags, truth mode as kind); a v1 note in the
corpus is already in that shape. The corpus itself was read **once**, before the walk,
so this step is a pure function over data and never touches the disk. The same function
is what the `MEM-CONTRADICT` lint rule renders, so the two can never disagree.

**What it looks at, and what it cannot see.** The detector considers the kinds that
**state a rule** — `decision`, `status`, `normative`, `procedural-rule`. Kinds that state
a *fact* stay out on purpose: two facts phrased differently are a **merge** question, and
the merge proposal already owns subject overlap. A pair must share subject matter *and*
then either oppose in polarity or disagree on a number. Three limits are worth knowing
before trusting a clean result:

- **Polarity is read from marker words**, in English and Russian both, and only in their
  base forms. An opposition carried by **verb antonymy** — "the snapshot stays" against
  "delete the snapshot" — is invisible to it, because no list of marker words reaches
  that.
- **A date is not a quantity, and a bare numeral is not a subject.** Two rules given on
  different days are sequential, not contradictory; *when* a claim was made is what
  `valid_from` / `valid_until` are for.
- **A clean result is weaker than it looks.** This is a lexical heuristic, not a reasoner:
  it finds the contradictions that are visible in the words. It is worth what it catches,
  not as proof that the corpus agrees with itself.

**Stops the walk:** **one** thing blocks — an exact id collision, because two records
cannot share an identity and the id law makes the id the filename. Everything else is a
**flag**, carried forward in the trace. A contradiction is not an error; it is the most
valuable thing this step can find, and refusing the record would leave the corpus
holding the older belief with nothing recorded against it. The flags are what step 11
acts on.

### 1.6 Step 6 — evidence

**Does:** the provenance gate for authored judgment
([`MEMORY-MODEL.md` §3.1](MEMORY-MODEL.md#31-the-two-disciplines-fact-vs-interpretation)).
An interpretation must name the authority behind it, and an *active* one must carry
evidence.

A re-derivable mode (`observed`, `factual`) passes through untouched: its discipline is
a check it can re-run, not a person who vouches for it, and that discipline is enforced
at the corpus door in step 8.

**Stops the walk: yes — by staging, not by discarding.** A judgment that cannot say who
stands behind it is **downgraded**: `status: draft`, `truth_mode: hypothesis`, written
to `drafts/` for review. Discarding it would lose the observation; promoting it would
let a guess wear a fact's clothes. The trace keeps the mode it was declared in, so
nothing about the caller's intent is silently rewritten.

### 1.7 Step 7 — risk

**Does:** asks the approval ladder (§3) which door this record is entitled to, and takes
the answer literally.

**Stops the walk: yes — by staging** for every path except one. Exactly one answer opens
the automatic door: a low-risk working observation. On top of the ladder's verdict, that
door checks the two facts it depends on directly *and* requires a retention window or an
end date — a memory written with no human in the loop must be able to fall out of the
corpus on its own, or an unreviewed belief becomes permanent by default.

### 1.8 Step 8 — persist

**Does:** the only door into the corpus, and it is a gate, not a pipe. Validation runs
**before** the write: the id law plus every structure rule of the record validator. The
write itself goes through the atomic primitive, so a reader sees the previous state or
the new one and never a torn file.

**Stops the walk:**

| Condition | Outcome |
|---|---|
| Validation errors | **Staged**, never half-written. There is no path here that produces a partly valid corpus file. |
| A file already occupies the id | **Staged.** Step 5 normally catches this; the door does not rely on a single lock, and the pipeline never clobbers a record it did not write. |
| The record is legal but the shared grammar refuses to emit it | **Rejected**, with the serializer's own message. A record nothing can re-emit is a record the next tool that touches it will reject. |
| Written | The walk **continues**. |

A successful write sets a `persisted` flag and deliberately does **not** declare the
outcome: the corpus door is not the end of the sequence. Steps 9–12 run on exactly one
path — the one where something was actually written — and step 12 declares the terminal
outcome.

### 1.9 Step 9 — index

**Does:** a record nobody can find is not memory. The always-load index and the per-area
catalogs are regenerated through the **same** generator functions the index-build verb
uses; re-rendering them here would create a second index grammar, and the first
divergence between the two would be invisible because both files would look plausible.

The build anchor (a commit hash and per-file dates) is **injected**. With no runner the
index is stamped with a deterministic epoch anchor rather than a hash nobody computed —
so a memory write never becomes a surprise process spawn.

**Stops the walk:** never. **Fail-open by design:** the record is already on disk, so an
index that cannot be rebuilt is a stale index, not a failed write. The step degrades with
the reason in the trace rather than unwinding a write that already succeeded.

### 1.10 Step 10 — measure

**Does:** leaves exactly one `retrieval-trace` record in the journal per persisted write:
the record id, the timestamp, the path, and the shape of the walk as `step:outcome`
strings.

**No metric is computed here, deliberately.** Measuring retrieval is the measurement
track's work, and a pipeline that scored itself would be marking its own homework. What
this step guarantees is that the data to measure *later* exists at all: a write with no
trace is a repudiable write. The record carries a **shape, never content** — the claim
stays where it belongs, in the record.

**Stops the walk:** never (fail-open, like step 1).

### 1.11 Step 11 — consolidate

**Does:** when step 5 found a contradiction or a near-duplicate, this step writes a
**proposal**: a draft naming both records and the action a human might take
(`supersede-or-revoke-one-side`, `merge-into-one-record`). When step 5 found nothing, it
does nothing.

**It never merges, never promotes, never edits either record — the step has no corpus
write path at all**, and that is the point. Auto-merge is the canon anti-pattern: two
beliefs quietly rewritten into one is a decision nobody reviewed, made by the component
least able to judge which one was right. A proposal already on disk is never clobbered;
it may carry a human's edit.

**Stops the walk:** never.

### 1.12 Step 12 — lifecycle

**Does:** resolves the record's own lifecycle position and completes any supersession the
**caller declared**. Completing a declared pointer is not inference and not a merge: the
record says `supersedes: X`, and leaving X without the matching `superseded_by` would
produce the one failure the corpus cannot survive — a belief known to be replaced that
keeps loading as current.

Nothing is inferred here. A near-duplicate that step 5 merely *suspects* produces a
proposal (step 11), never a transition.

A transition invalidates the index step 9 just built, so the rebuild is repeated after
it. That is the honest ordering: the canon sequence is fixed, and a step that changes the
corpus must leave the index describing the corpus as it now is.

**Stops the walk:** it *is* the end. This step declares the terminal outcome
`persisted-active`.

## 2. Outcomes, the trace, and the verb

A walk ends in exactly one of three outcomes:

| Outcome | Meaning | Where it is decided |
|---|---|---|
| `persisted-active` | The record is in the corpus, indexed, traced, and its declared supersessions are complete. | Step 12 |
| `staged-draft` | The record is in `drafts/` awaiting review. **A correct outcome, not a failure** — it is the normal one for anything but a low-risk working observation. | Steps 6, 7, 8 |
| `rejected` | Nothing was written anywhere. | Steps 2, 3, 4, 5, 8 |

The surface:

```bash
sma memory write --type <memory_type> --truth <truth_mode> --claim <text> [options]

  --id <id>              record id; default: derived from --type and --claim
  --body <text>          the note body
  --areas <a,b>          retrieval areas
  --evidence <t>:<ref>   evidence entries, comma-separated
  --authority <v>        owner-instruction | external-review | self-observed | inferred
  --sensitivity <v>      public | internal | sensitive | encrypted-required (default: internal)
  --risk <v>             low | medium | high | critical (default: low)
  --retention <window>   e.g. P30D — REQUIRED for the one automatic path
  --valid-until <date>   end of the claim's validity window
  --supersedes <id,..>   records this one replaces (the pointer is completed on both ends)
  --product-version <v>  the fingerprint a re-derivable claim is checked against
  --language <code>      default: en
  --corpus <dir>         default: .claude/memory
```

Exit codes: `persisted-active` → 0 · `staged-draft` → 0 · `rejected` → 1. A value outside
a closed vocabulary is refused **with the allowed list**, printed from the schema module's
own exports. The verb prints the trace table: one row per executed step, so the decision
is legible without reading code.

**Classification is the caller's**, at the CLI exactly as in the module: `--type` and
`--truth` are never guessed.

## 3. The risk-approval ladder

Which door a record is entitled to is a **pure, deterministic function** of four fields:
`memory_type`, `truth_mode`, `sensitivity`, `risk`. Seven paths, from the lightest to the
strictest:

| Approval path | What routes to it |
|---|---|
| `auto-ttl` | A low-risk **working** observation. The **only** path that writes without a human — and the pipeline additionally requires a retention window or an end date. |
| `auto-draft` | A candidate lesson: an **episodic** or **procedural** claim in `hypothesis`/`inferred` mode. Automatic about *drafting*, never about believing. |
| `evidence-review` | A **procedural** claim in a settled mode — and every well-formed combination the table does not map. |
| `human-approval` | A standing rule: `memory_type: normative` or `truth_mode: normative`. |
| `owner-versioned` | `memory_type: preference` — the owner's own preference, versioned. |
| `versioned-replay` | `truth_mode: decision`. |
| `governed-human-only` | The strictest path — reached by escalation or by falling closed (below). |

**Precedence, in order:**

1. **Escalation, before anything else.** A `sensitive` or `encrypted-required` class, or a
   `critical` risk, goes to `governed-human-only` whatever else the record says. This is
   checked *before* the vocabulary gate, so a known-dangerous class still escalates even
   when another field is malformed.
2. **Fail closed.** If any of the four inputs is missing or outside its closed vocabulary,
   the answer is `governed-human-only`. A record whose class cannot be determined is
   treated as the most restrictive plausible class
   ([`MEMORY-MODEL.md` §7](MEMORY-MODEL.md#7-sensitivity-and-storage-classes)).
3. **The mapped classes**, strictest first: owner preference, decision policy,
   reflex-grade rule, candidate lesson, procedural recommendation, low-risk observation.
4. **Anything well-formed but unmapped gets `evidence-review`** — never one of the
   automatic paths. A gap in the table must not become a permission.

## 4. Drafts

**One directory.** Everything staged for review lives in `drafts/` inside the corpus.
No corpus reader, no index build and no record check descends into it: a draft is
explicitly *not* memory.

**Three markers.** Every draft says where it came from, in a `draft_kind` field, so its
origin is greppable:

| `draft_kind` | Written by | What it is |
|---|---|---|
| `v2-migration` | The migration preview (§6) | A proposed v2 rendering of an existing v1 note. |
| `pipeline-write` | The write pipeline, steps 6–8 | A candidate belief that did not earn the automatic door. |
| `consolidation-proposal` | The write pipeline, step 11 | Not a belief at all — a **question** about two beliefs that already exist. |

A migration draft additionally carries `draft_source` and `draft_disposition`. These
three draft-only keys are **stripped at apply time**: they describe the proposal, not the
record, and carrying them into the corpus would put unvalidated fields on every migrated
note forever.

**Nothing overwrites a draft.** A draft a human may already have edited is worth more than
the one a re-run would write; a re-run reports that it kept the existing file instead of
silently replacing it. That is also why a stale draft must be recognised as stale rather
than assumed fresh: read the reported status, or clear the directory before a batch.

**Promotion is a human act, and there is no bulk one.**

- A **migration draft** is applied one file at a time, naming its own source (§6).
- A **pipeline draft** has no promotion verb by design. It is reviewed, the missing field
  is supplied — the authority nobody named, the evidence nobody attached — and the record
  goes through the write path again. There is no shortcut that turns a draft into a belief
  without passing the gates that put it there.
- A **consolidation proposal** has no applier at all, deliberately. Deciding which of two
  beliefs survives is a human act; no verb in this codebase applies such a proposal on its
  own.

## 5. Lifecycle actions

Five actions are performed, and they are callable outside the walk as well as from
step 12: **supersede · revoke · expire · archive · erase**. The first four are
*transitions* — the bytes stay on disk and each writes the status of
[`MEMORY-MODEL.md` §6](MEMORY-MODEL.md#6-lifecycle-status). The fifth *destroys*; it has
rules of its own and they are in [§5.5](#55-erase-physical-removal-verified) below.

Rules that hold for all four transitions:

- **The grammar gets the last word.** A record the shared serializer cannot re-emit is
  **refused**, not rewritten into something the emitter invented. A refusal changes
  nothing on disk.
- **v1 notes are refused.** The v1 grammar has no `status` field, so a transition written
  onto a v1 note would be dropped silently on the way out. Migrate it first — a stated
  refusal beats a silent no-op.
- **A transition that says nothing touches nothing.** When the rendered text equals what is
  already on disk, no write happens.
- **Every transition is journalled** — action, id, resulting status, and what changed. The
  journal is fail-open: an unwritable log degrades the audit trail, it does not un-write
  the corpus.
- **Unknown actions are refused by name**, listing the five that exist.
- **All four retirements are honoured by the read path.** A record in any of the four
  states is withheld from the pack, with the state named in the trace so the absence can
  be argued with. This was true of `superseded` and `revoked` from the start and became
  true of `expired` and `archived` on **2026-08-04**: until then the read filter acted on
  two of the four, so §5.4's promise below was made by this document and kept by no code.
  It is one set now (`CORE_EXCLUDED_STATUSES`, `generator.mjs`), read by the always-load
  index, by read-time visibility and by the evaluator's definition of «retired».

What a person types to reach any of this is in [§5.6](#56-what-a-person-actually-types) —
one command and at most one flag.

### 5.1 supersede

A new version replaces an old one. **Symmetry or nothing:** the retired record gains
`status: superseded`, `superseded_by` and `superseded_at`, and the replacement gains
`supersedes`. Both files are rendered and checked **before either is written**, so a
failure on the second cannot leave the first rewritten — the pair is prepared atomically
even though two files can never be renamed as one.

Refused when: no successor is named; a record would supersede itself; the target is
already superseded by a *different* record (completing that pointer would break an
existing chain); or either file cannot be loaded or re-emitted.

A superseded record drops out of the always-load index on the next build.

### 5.2 revoke

The record must not be used; audit history may remain.

**A revocation requires a stated reason**, and the reason is **journalled, not written into
the record**: the schema has no free-text field for it, and inventing one would put an
unvalidated key on every revoked record forever. A revocation nobody explained is
indistinguishable from an accident.

### 5.3 expire

The validity window ran out. Refused when the record carries no `valid_until` — a claim
with no end date has not run out of anything — and refused while that date has **not yet
passed**: a claim is never expired early. The refusal names the date, so the report stays
diffable across days.

Note the division of labour: the corpus lint *reports* an active record whose `valid_until`
has passed, as a review trigger. It never applies this transition itself.

### 5.4 archive

Removed from active retrieval, kept for history. This is also the disposition a migration
gives to a note that is narrative rather than doctrine
([`MEMORY-MODEL.md` §9.5](MEMORY-MODEL.md#95-episodes--the-other-half-of-the-representation)).

### 5.5 Erase: physical removal, verified

**Erase removes the record.** It is the only action here that destroys rather than
transitions, and it lives in a module of its own — `scripts/sma/lib/erase.mjs` — so the
write pipeline still contains no deletion code path. Until 2026-08-04 this section recorded
erase as *deferred by policy*; the policy has since been decided, and this is what was
decided.

**What it does.** It clears every surface a copy of a record can survive on, and then
verifies each one by **reading it back from disk**. The surfaces are a single frozen list,
`ERASE_SURFACES`, and the same list is walked twice — once to clear, once to verify — so
the two cannot drift apart. Adding a derived index later is one entry in that list, not
two functions somebody has to remember:

| Surface | What it is | How it is cleared |
|---|---|---|
| the active corpus | the reviewed record itself, in the git working tree | the file is removed |
| the drafts area | a staged copy awaiting review, in the same tree | the file is removed |
| the this-machine-only store | material that never entered git | the file is removed |
| the generated index | `MEMORY.md`, which carries claim text on every CORE line | rebuilt from the corpus |
| the per-area catalogs | `INDEX-<area>.md`, one line of claim text per note | rebuilt; an area index the rebuild no longer produces is **deleted** |
| the derived lexical index | the `.sma/` index that answers queries from axis text | rebuilt from the corpus |

**Derived indexes are rebuilt, never edited.** That is the law that makes a derived index
safe to delete in the first place; hand-editing an index line would turn the index into a
second source of truth. The rebuild is done by the same builders the index verb uses.

**A partial erasure is a failure.** If any surface still holds a copy after the clearing,
the result is `applied: false` and names that surface — never a success with a warning
attached. The surfaces that *did* succeed stay enumerated, because an operator told only
"it failed" cannot know what state the corpus is now in.

**A store nobody named is not guessed at.** The `.sma/` stores are opt-in: without a
`repoRoot`, `localDir`, `indexDir` or `dbPath`, those surfaces are reported
`not-configured` and are neither cleared nor claimed clean. A destructive operation does
not invent the path of a store it would delete from.

**The episode archive is not a surface, and an episode sharing the id stops the erase.**
`episodes/` is deliberately outside the list above: an episode records **what happened**,
not what is true, and destroying history is a larger promise than the one that was
decided. Normally the distinction costs nothing, because the claim extracted from an
episode is written as `<stem>-claim` while the episode keeps `<stem>` — the two never
collide. Nothing in the id law *forbids* the collision, though, and on one the erase would
leave `episodes/<id>.md` holding a copy of the same content that no surface reports. So
this operation **refuses**: it names the colliding file, removes nothing, rebuilds nothing,
and stops before the first surface is touched. The operator decides what happens to the
history — keep it and erase under a different id, or remove the episode themselves — and
runs the command again. It is a gate, not a wall: once the collision is gone the same
command completes normally. Erasing the episode automatically was considered and **not**
chosen; a delete that can reach into the history archive is a promise this product does not
make on the operator's behalf.

**Links are reported, never rewritten.** A record still pointing at the erased one — an
episode, or a claim carrying `derived_from` — is reported as **dangling**. It is not
repointed and not deleted:
[`MEMORY-MODEL.md`](MEMORY-MODEL.md) §13 forbids rewriting records this
operation did not author, and a pointer silently re-aimed is worse than one openly broken.

**The journal keeps the evidence.** The erasure appends one event to the append-only
journal and no prior entry is touched. The journal holds a pointer and an event, never the
content, so keeping it does not defeat the deletion — and a deletion that erased the record
of itself could not be audited at all.

**Git history is NOT touched, and the result says so.** This is the honest limit, stated
rather than promised away: a record that reached a commit is still in that commit and in
every clone made since. Automatic history rewriting was **rejected by decision** — it is
irreversible and it breaks every clone that already exists — so no code path in the module
executes a git command, and every result carries the exception in words. The way to never
need it is prevention: material that cannot be allowed to persist belongs in the
this-machine-only class, which keeps it out of git in the first place. The steps a person
would take by hand, and the reason the tool will not take them, are in
[§5.7](#57-if-it-already-reached-a-commit-the-manual-route).

### 5.6 What a person actually types

Everything above is the machinery. **A person types one command and, at most, one flag.**
Nobody is obliged to learn the difference between superseding, revoking, expiring and
archiving in order to make the system stop believing something, and that is
the whole reason this section exists.

```bash
sma memory forget <id> --reason "<why>"        # revoke    — the default
sma memory forget <id> --replaced-by <new-id>  # supersede
sma memory forget <id> --expire                # expire
sma memory forget <id> --archive               # archive
sma memory forget <id> --erase --yes           # erase     — irreversible
```

`forget` is a **subcommand of the `memory` namespace**, not a verb of its own: the
top-level handler table gains no key and the documented verb count is unchanged.

**The default-state rule**, stated so a reader can predict what a bare forget will do:

| What was typed | What is applied | Why that one |
|---|---|---|
| a replacement is named | **supersede** | the replacement exists, so the chain is the true statement — and both ends are written together or neither is |
| no replacement is named | **revoke** | the strongest non-destructive state, and the safe default in the only direction that matters: revoking something merely stale costs a little findability, while archiving something that was actually *wrong* leaves a wrong record quotable |
| `--expire` | **expire** | reachable for a caller that knows it wants it; still refused unless the record's own `valid_until` has passed |
| `--archive` | **archive** | reachable for a caller that knows it wants it |
| `--erase --yes` | **erase** | never implied, never a default, and not reachable without both flags |

A revocation needs a stated reason (§5.2), and the command asks for it in those words
rather than failing quietly.

**Underneath is not the same as hidden.** The command prints which state it applied — in
plain words *and* as the `status` value — and the record carries that status in its own
frontmatter afterwards, where anyone can read it later. The reason goes to the journal.
Someone who never opens this document still learns which of the five ran, from the command
that ran it.

**A record is forgotten where it lives.** A this-machine-only record is not in the corpus
at all; the verb resolves the storage class and acts on the store that actually holds it,
rather than refusing to forget precisely the class of record a person most wants forgotten.

**The destructive flag is not a stronger version of the other four.** `--erase` on its own
destroys nothing: it lists the copies it found, names every surface it would walk, states
the history exception and stops. The consent is the explicit `--yes` flag — the posture
every other irreversible operation in this product already uses. **A missing terminal is
never consent:** nothing in this path reads a terminal, so there is no prompt for a
non-interactive caller to be assumed past.

**An erase can also decline.** If an episode in the archive happens to share the record's
id, the command stops and says so instead of completing a removal it could not honestly
call complete ([§5.5](#55-erase-physical-removal-verified)). Nothing is removed; the
operator resolves the episode and runs the same command again.

### 5.7 If it already reached a commit: the manual route

Erase clears the corpus, the working tree and every derived index. **It does not touch git
history, and this document will not pretend otherwise.** If the record was ever committed,
it is in that commit, and in every clone anyone has made since.

Removing it from history is a manual operation, and these are the steps:

1. **Decide whether it is worth it.** Everything below breaks every existing clone of the
   repository. If the material was a credential, read step 5 first — you may find that it
   is the only step that helps.
2. **Rewrite the history**, in a fresh clone, over the paths that held the record. The
   tooling and the exact invocation are named in
   [`MEMORY-THREAT-MODEL.md` §6.4](MEMORY-THREAT-MODEL.md#64-the-honest-line-about-deletion),
   deliberately in **one** place: a recipe this dangerous should have one home rather than
   two that drift apart.
3. **Force-push the rewritten history**, and expect every branch protection you have to
   object. That objection is correct.
4. **Tell everyone holding a copy to re-clone.** Not pull, not rebase — re-clone. A
   colleague who pulls reintroduces the old objects, and forks, mirrors, backups and a
   hosting provider's own caches may keep them regardless of what your branch now says.
5. **Rotate anything that was secret.** This is the step people skip, and once the material
   has been readable by others it is the only one that actually helps: assume a copy exists
   somewhere, and make it worthless.

**Why the product does not do this for you.** It is irreversible, it breaks work other
people are in the middle of, and it cannot be verified from inside a single clone — while
the one thing this operation refuses to do is report a success it could not check. Putting
a friendly verb over that would be a promise the product cannot keep, and it was rejected by
name rather than left undone by accident.

**The prevention is one decision made once.** Material that must not persist belongs in the
**this-machine-only** storage class, which never enters a git-backed path at all. The
argument and the enforcement are in
[`MEMORY-THREAT-MODEL.md` §2](MEMORY-THREAT-MODEL.md#2-storage-classes); this document does
not repeat them.

## 6. The migration ritual

**Preview-only.** The migration reads every v1 note, stages a complete schema-v2 rendering
in `drafts/`, and prints the report with a diff. **Not one byte of the corpus is written by
a preview** — an invariant proved by hashing the whole corpus tree before and after a full
run, not by promising it.

```bash
# PREVIEW (the default)
sma memory migrate [--preview] [--corpus <dir>] [--json]

# APPLY — exactly ONE proposal, naming its own source, with an explicit yes
sma memory migrate --apply <draft> --confirm <source-file> --yes [--corpus <dir>]
```

`--json` prints the whole `{proposals, summary}` object — the machine surface for a review
loop. Exit codes: preview 0; apply 0 on success, 1 on any refusal, with the reason on
stdout.

**Consent that cannot be given in bulk.** `--confirm` must name the proposal's own declared
source file, and `--yes` must be present. There is **no bulk-apply function to call** — not
a flag, not an export. A loop over proposals is possible only by passing, for each one, a
confirmation a human supplied.

**A draft is untrusted input.** It may have been hand-edited before acceptance — that is the
entire point of a preview. Every value that reaches a filesystem path is therefore
charset-gated before any write, so a proposal can only ever resolve *inside* the corpus, and
the id law is re-checked against the file the proposal is about to write.

**What applying does.** A record disposition writes the v2 note. An **archive** disposition
produces *two* drafts and *two* independent decisions: the episode archive (applying it
moves the note into `episodes/`) and a **claim stub** for the durable rule the narrative
contained. The stub ships with an empty claim and therefore **fails validation on purpose**:
apply refuses anything with validation errors, so knowledge nobody has written down yet
physically cannot become memory. Writing that one sentence is the only judgment in the whole
migration.

**Errors block, warnings do not.** A migrated record carries `migrated_from: v1`, so the
discipline findings arrive as warnings under the grace (§7) and do not stand in the way.
The typical proposal applies with exactly one warning — a missing `source.authority` — which
is honest: the migration genuinely does not know who stood behind a v1 note.

**Nothing is invented and nothing is carried blind.** No authority, no evidence, no
fingerprint are fabricated; a v1 field with no destination is *reported* rather than copied
onto the record, because copying an unknown nested block into a v2 leaf would produce
corruption wearing a transform's clothes. A personal-shape hit **escalates** the proposal's
sensitivity class rather than defaulting it, so migrating can never quietly launder a leak
past the placement checks.

## 7. The migrated-record grace

A record that declares `migrated_from: v1` is held to the same **structure** as any other —
required fields, closed vocabularies, the one-claim law, the fingerprint shape, the
external-artifact horizon are **always errors** — but its **disciplines** arrive as
warnings:

| Finding under grace | Why it is a warning |
|---|---|
| A re-derivable claim (`observed`, `factual`) carrying neither verification nor fingerprint | A v1 note never had a place to put a check. |
| An interpretation with no `source.authority` | A v1 note never recorded who stood behind it. |
| An **active** interpretation with no evidence | Same reason; the alternative is locking a corpus out of itself. |

Everything else about such a record is judged normally, including the placement and secret
checks — a migration is not an amnesty.

**The grace has a stated horizon: the close of the current measurement cycle.** After it,
these findings become errors. A grace with no horizon is an exemption, and the horizon is a
*named milestone* rather than a date because the calendar meaning belongs to whoever runs the
installation, not to the schema. Every graced warning names the horizon in its own message,
so nobody has to read this document to learn that a deadline exists.

**The graced set is discovered, not declared.** The checker asks the validator the same
question twice — once as the record is, once as if it had been authored natively — and treats
the difference as the graced set. There is no second list of "which rules are discipline" to
fall out of sync. See
[`MEMORY-MODEL.md` §11.2](MEMORY-MODEL.md#112-the-migration-grace).

## 8. Change log

| Version | Date | Change |
|---|---|---|
| 1.3 | 2026-08-05 | Two promises this document was making without code behind them got their code, and both are now stated as what they actually are. §1.5 says what the contradiction detector **looks at** — the rule-stating kinds, not every kind — and, more usefully, what it **cannot see**: verb antonymy, and a clean result that is weaker than it looks. Until this date the detector's kind gate admitted only `decision` and `status`, and a corpus holding neither got an empty result that read as «no contradictions» and meant «nothing was examined»; the polarity vocabulary was likewise English-only on a Russian corpus. §5.5 and §5.6 record that an erase **can decline**: the episode archive is not one of the six surfaces, so an episode sharing the record's id stops the operation before anything is removed, names the file, and leaves the decision about history with the operator. Erasing the episode along with the record was considered and rejected — it is a strictly larger promise than the one that was approved. |
| 1.2 | 2026-08-04 | The lifecycle got a user-facing surface, and this document got the two sections that describe it. §5.6 (**what a person actually types**) states the one-command view and the default-state rule — a forget naming a replacement supersedes, a forget naming none revokes, expiry and archiving stay reachable by flag, and erase is reachable only behind two of them — plus the rule that the applied state is always shown and always written into the record. §5.7 (**the manual route**) carries the git-history limit in full: five numbered steps a person would take by hand, including the rotate-the-secret step everyone skips, the warning that each of them breaks every existing clone, and the reason the product refuses to do it behind a friendly verb; the tooling itself stays named in exactly one place, `MEMORY-THREAT-MODEL.md` §6.4. §5's shared rules now record that **all four** retirements are honoured by the read path as of this date — `expired` and `archived` were retired by the write path and delivered by the read path until then, so §5.4's promise was made here and kept by no code — a gap this document had recorded against itself. §5.5 names `ERASE_SURFACES` as the one list walked twice. |
| 1.1 | 2026-08-04 | Erase shipped (§5.5 rewritten from «deferred by policy» to the six surfaces it clears and verifies, the partial-erasure failure rule, the opt-in stores, the dangling-link report, the journal evidence and the git-history exception); §5 now describes five actions rather than four. |
| 1.0 | 2026-08-02 | First version. The twelve landed pipeline steps with their module boundaries and stop conditions, the three outcomes and the write verb, the seven-path risk-approval ladder with its precedence, the draft conventions and their three markers, the four lifecycle transitions with the symmetric-pointer law and the deliberate erase deferral, the preview-only migration ritual with per-file acceptance, and the migrated-record grace with its horizon. |
