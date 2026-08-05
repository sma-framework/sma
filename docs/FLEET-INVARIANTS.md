# SMA Fleet Invariants 1.0 — the seven, the states, and the promise the fleet does not make

| | |
|---|---|
| Status | **1.0 — landed.** Every invariant below names the module function that enforces it and the test case that proves it. An invariant with no named test is not in §3 — it is in §5, as an intention. |
| Document version | 1.0 |
| Date | 2026-08-04 |
| Applies to | the durable task queue of one installation: the fleet state machine, the capability envelope, the attempt ledger and the queue backend beneath them |
| Companion documents | [`MEMORY-THREAT-MODEL.md`](MEMORY-THREAT-MODEL.md) — the same treatment for the memory corpus · [`SPEC.md`](SPEC.md) — what the product is |

> **The document follows the code.** Every state name, contract field, function
> name and test case below is taken from the shipped modules:
> `daemon/src/queue/state-machine.mjs` (the states, the transition contracts, the
> idempotency key, the transition applier), `daemon/src/queue/capability-envelope.mjs`
> (the eight capability dimensions and the human-only boundary),
> `daemon/src/queue/attempt-ledger.mjs` (the append-only per-attempt record and the
> attempt stamp), `daemon/src/queue/pgboss-backend.mjs` and
> `daemon/src/queue/adapter.mjs` (the queue itself), `daemon/src/queue/liveness.mjs`
> (the sweep). Where this document and those modules disagree, the modules are
> right and this document is a bug.

---

## 1. What this document is for

A fleet of headless workers is a system in which the interesting failures are not
crashes. A crash is loud. The failures that matter are quiet: a task that is
recovered twice and runs its side effect twice; a task that disappears between a
worker's death and the next sweep; work marked accepted by the process that did
it; a dead-lettered task that quietly walks back into the queue because some code
path had no reason not to let it.

Seven sentences say what must never happen. They were written down before the
fleet was built, and until now they lived only as prose — the code implemented
them in four different modules, and nothing anywhere stated them together or
checked them as a set. This document states them, points each one at the code
that enforces it and the test that attacks it, and then — in §5 — says plainly
which of them are *checked* rather than *enforced*, and what the tests simulate
rather than exercise for real.

The document also states the one promise the fleet deliberately does **not**
make (§4). That omission is a design decision, not an oversight, and a reader who
does not know about it will build something on top of the fleet that cannot work.

## 2. The states, and the shape of a transition

**Eleven states.** `READY` · `CLAIMED` · `RUNNING` · `PRODUCED` · `VERIFYING` ·
`WAITING_HUMAN` · `ACCEPTED` · `REJECTED` · `RETRYABLE` · `DEAD_LETTER` ·
`CANCELLED`. They are frozen in `FLEET_STATES` (`state-machine.mjs`); four of
them — `ACCEPTED`, `REJECTED`, `DEAD_LETTER`, `CANCELLED` — are terminal, and
terminality is expressed by the *absence* of any outgoing contract rather than by
a flag, so a state cannot be terminal in one place and leaky in another.

**Twenty-two legal transitions, each with a contract.** The table lives in
`TRANSITIONS` (`state-machine.mjs`) and is deliberately **not** reproduced here: a
table copied into a document drifts from the code the first time somebody edits
one of them alone. Read it there. What belongs here is the contract's *shape*,
because that is the thing a reader has to understand before the table means
anything:

| Field | What it says |
|---|---|
| `actor` | who may perform it — dispatcher, worker, verifier, supervisor or human. Exactly one. |
| `preconditions` | what must be true first. `applyTransition` decides the two it can see from one call and returns the rest as `deferredPreconditions` rather than treating silence as a pass. |
| idempotency key | `idempotencyKey(taskId, attemptId, transition)` — deterministic, restart-stable, no clock and no counter. |
| `writes` | the durable records the transition produces. |
| `externalEffects` | what happens **outside** the queue. Always declared, never omitted — an effect nobody declared is the case invariant 4 exists to survive. |
| `timeout` | how long the destination state may last. Written down for `RUNNING -> PRODUCED`: 45 minutes. |
| `retryPolicy` | `create_new_attempt` or `none`. |
| `nextStates` | where the task may go after landing. Written out per contract, and the suite compares every one against the destination's own outgoing set, so the duplication cannot drift. |

**The eleven states sit on top of four, they do not replace them.**
`toQueueStatus` maps every fleet state down onto the queue's own
`queued / claimed / completed / failed` vocabulary, so the fine layer adds
resolution and can never contradict the queue about whether a job is checked out.
`PRODUCED`, `VERIFYING` and `WAITING_HUMAN` all map to `claimed` — those are the
three genuinely different situations the four-value vocabulary collapses, and
telling them apart is the whole reason the fine layer exists.

## 3. The seven invariants

Each subsection is the invariant in one sentence, the mechanism that enforces it
named by module and function, and the test that attacks it named by file and
case. The property suite (`daemon/__tests__/invariants.test.ts`) checks **all
seven after every step of every generated sequence**, so each one below is
checked far more often than its own dedicated case suggests.

### 3.1 Invariant one — acceptance is never self-certified

> A task does not reach `ACCEPTED` without a valid verification receipt and a
> human or otherwise authorized disposition.

**Enforced by** `applyTransition` (`state-machine.mjs`), which refuses any
transition into `ACCEPTED` that lacks a receipt reference or names a disposition
outside the closed set, and by `complete()` in `adapter.mjs` and
`pgboss-backend.mjs`, which throw `NoReceiptError` before any mutation when a
result carries no `receiptRef`. **Read §5.8:** the live queue path now calls
`applyTransition`, but it never names `ACCEPTED` — `complete()` hands the task to
a human rather than accepting it — so on that path this invariant is still held by
the `complete()` receipt guard alone. The `ACCEPTED` refusal remains a tested
formal reference with no production caller.

**Proven by** `invariants.test.ts` → `invariantOneAcceptedIsNeverSelfCertified`,
whose generator deliberately withholds the receipt or the disposition on roughly
a third of the acceptance attempts; the mutation case *"1 — an ACCEPTED task with
no receipt is reported"*; and `state-machine.test.ts` plus the queue contract
suite case *"complete refuses without a receiptRef"*.

### 3.2 Invariant two — a worker holds no push or merge capability

> No sequence of inputs — no prompt, no task text, no grant list, no envelope
> field — produces a worker capability that permits pushing or merging.

**Enforced by** `HUMAN_ONLY_ACTIONS`, `validateEnvelope` and `envelopeAllows`
(`capability-envelope.mjs`), which refuse an envelope naming a forbidden token in
any granting dimension, refuse an envelope that dropped a member from its own
denial list, and answer `false` to a human-only action whatever the dimensions
say; by the forbidden-token scan that runs **first** inside `applyTransition`,
before any other check can matter; and by `scripts/sma/lib/ship-lane.mjs`, which
is a read-only checker that never pushes, tags or deploys.

**Proven by** `invariants.test.ts` → `invariantTwoNoEnvelopeGrantsPushOrMerge`,
checked after every step including the steps that inject hostile grants such as
`git push` and `auto-merge`; the mutation case *"2 — an envelope widened with a
push tool is reported"*; and `capability-envelope.test.ts`.

**Read §5.1 before relying on this.** The envelope is a declaration, not an
enforcement point.

### 3.3 Invariant three — one active lease, many immutable attempts

> A task holds at most one active lease at a time, while any number of immutable
> attempts may exist for it.

**Enforced by** the queue itself: a `fetch` **is** the claim in
`pgboss-backend.mjs`, so a second worker cannot check out a job a first one
holds, and `claimNext` walks the lane queues in a documented stable order; and by
`attempt-ledger.mjs`, which appends and never rewrites — the module contains no
function that edits or removes a row, by construction.

**Proven by** `invariants.test.ts` → `invariantThreeAtMostOneActiveLease`, which
also asserts that the attempt list is append-only and that no attempt id is ever
reused; the mutation case *"3 — a task holding two active leases is reported"*;
and `fleet-drill.test.ts` → the restart drill, where a task claimed at the moment
of a restart is still claimed by exactly one worker afterwards.

### 3.4 Invariant four — a lease expiry unsays nothing

> The expiry of a lease does not mean the external side effect did not happen.

**Enforced by** every contract in `TRANSITIONS` declaring its `externalEffects`
explicitly rather than by omission, so a redelivered transition whose effect was
already performed is recognisable as such; and by the append-only ledger, in
which the record of an attempt survives the worker that wrote it.

**Proven by** `invariants.test.ts` → `invariantFourLeaseExpiryDoesNotUnsayAnEffect`,
which asserts that no effect key ever recorded is missing after any number of
lease expiries and worker deaths; the mutation case *"4 — an effect that was
recorded and then retracted is reported"*; and `fleet-drill.test.ts` → the kill
drill, whose two cases now assert a row on **both** recovery paths, plus the
reconciliation drill.

**Read §5.4.** The second recovery path's row is reconstructed after the fact, and
says less than a live one.

### 3.5 Invariant five — a retry reuses the key, or opens a new attempt

> A retried effect either runs under the same idempotency key it already had, or
> belongs to a new attempt.

**Enforced by** `idempotencyKey(taskId, attemptId, transition)`
(`state-machine.mjs`), a hash of exactly those three inputs with no clock, no
counter and no randomness — so the same effect retried under the same attempt
composes the same key across process restarts; by `applyTransition`, which
answers a key it has already seen with `alreadyApplied: true` rather than running
the effect again **and rather than refusing**, because the effect did happen; and
by the queue's `singletonKey`, which coalesces a repeated enqueue of a pending
item onto the one entry that already exists.

**Proven by** `invariants.test.ts` → `invariantFiveOneEffectIsAppliedOnce`, which
asserts both that one effect is applied at most once per task, attempt and
transition, and that every recorded key **is** the deterministic key of its own
triple — so a redelivery cannot mint itself a fresh one; the mutation cases *"5 —
one effect applied twice under one attempt and one transition is reported"* and
*"5b — an effect key that is not the deterministic key of its own triple is
reported"*; and `fleet-drill.test.ts` → the redelivery drill.

**Read §5.5** for the half of this sentence that is not enforced.

### 3.6 Invariant six — the attempt stamp is fixed at creation

> The policy version, memory snapshot, model and harness version an attempt ran
> under are fixed when the attempt is created and never change afterwards.

**Enforced by** `ALLOWED_ATTEMPT_KEYS` and `recordAttempt`'s explicit-pick loop
(`attempt-ledger.mjs`), which writes only named fields and can never pass a stray
key through; by `memorySnapshotHash`, which digests the corpus's canonical
records — asking `listNoteFiles` what counts as one, so a rebuilt index provably
does not move the digest; by `envelopeHash`, so the capability envelope reaches
the durable row as a digest and never as paths; and by `STATE_MACHINE_VERSION`,
which rides in on `applyTransition`'s result rather than being defaulted by the
ledger, because stamping a version onto an attempt that never went through the
state machine would fabricate the exact provenance the stamp exists to establish.

**Proven by** `invariants.test.ts` → `invariantSixTheAttemptStampNeverMoves`,
which reads the **durable ledger back from disk** after every step and compares
every row against the value the attempt was created with; the mutation case *"6 —
a ledger whose stamp changed between two rows of one attempt is reported"*; and
`journal.test.ts`.

**Read §5.6.** This one is checked, not structurally prevented.

### 3.7 Invariant seven — a dead-letter task waits for a decision

> A dead-lettered task does not return to `READY` without an explicit
> disposition.

**Enforced by** `DEAD_LETTER` being terminal in `TRANSITIONS` — it carries no
outgoing contract at all — and by `applyTransition` refusing the pair *by name*
so a caller gets the reason rather than a generic illegal-pair answer; with a
disposition supplied it is still refused, now returning `requiresNewAttempt`,
because an authorized disposition opens a **new** attempt through the enqueue
path and does not move this immutable one. At the queue layer the dead-letter
queue is a separate queue that `claimNext` never fetches from. **Read §5.8:**
the queue-layer half is what runs in production; the `applyTransition` half is
still a tested formal reference on this edge specifically — nothing in production
asks the machine about `DEAD_LETTER -> READY`, because nothing in production
attempts it.

**Proven by** `invariants.test.ts` → `invariantSevenDeadLetterNeedsADisposition`,
which checks two halves — that the transition **table** declares no way out of
any terminal state, and that no generated **history** contains one; the mutation
cases *"7 — a transition table loosened to declare DEAD_LETTER -> READY is
reported"* and *"7b — a history containing a DEAD_LETTER exit is reported"*; and
`fleet-drill.test.ts` → the dead-letter drill, which exhausts a task's retry
budget and then asserts both halves of the gate: no ordinary path returns it, and
an explicit disposition does.

## 4. At-least-once, and why exactly-once is not promised

**The fleet promises at-least-once delivery. It does not promise exactly-once,
and no part of it should ever be read as providing it.**

The reason is not modesty. A durable queue on top of a database cannot keep an
exactly-once promise across a worker that dies between performing an external
effect and recording that it did — the effect is in the world, and the record is
not. Any layer above that claims exactly-once is claiming something the layer
below cannot deliver, and a promise the layer below cannot keep is worse than no
promise, because callers build on it.

What makes at-least-once survivable is four things, and they are the reason the
modules are shaped the way they are:

1. **Immutable attempts.** Every attempt appends its own row; nothing is
   rewritten, so the history of a task is the sum of what happened rather than
   the last thing that happened.
2. **Idempotent effects.** An effect is keyed by task, attempt and transition, so
   a redelivery is recognisable and answers *already applied* instead of running
   again.
3. **Transactional state transitions.** A transition either lands with its
   contract satisfied or is refused; there is no half-transition.
4. **Explicitly declared external effects.** Every contract says what it does to
   the world, so a reader never has to infer it from silence.

Exactly-once is permissible only for a narrow local transition — one that touches
nothing outside the process and can therefore be made atomic — and never as a
fleet-wide guarantee. If you are designing something that needs exactly-once
across the fleet, the fleet is not what you need; make the effect idempotent
instead.

## 5. Non-goals — what the fleet does not guarantee

Written in the manner of the memory threat model's own non-goals section: these
are limits that are known, not limits that were missed. Each one names what would
close it.

### 5.1 The capability envelope bounds the daemon's own acts, not the worker's session

**Updated 2026-08-05.** The daemon now constructs, validates and consults an
envelope: `loop.mjs` resolves the lane's envelope at the claim and asks
`envelopeAllows` two questions — may this lane start a worker process at all
(`allowedTools` must grant the shell), and does the forge lane's committed draft
path lie inside the lane's declared write scope. Both refusals are fail-closed and
land on the record: a named reason from the failure taxonomy, the detail in the
daemon's log, and the digest of the refusing envelope on the attempt row.

**What that is worth, and what it is not.** For all four shipped lanes
`LANE_TOOLS` grants the shell, so the spawn gate refuses only a lane the queue
should never have produced — `validateTask` rejects an unknown lane at enqueue
already. Its value is that the checkpoint now exists at the place a process is
started, so a narrowed tool list or a forgotten new lane takes effect in
production rather than only in the declaration. The draft-path check is a second
independent leg beside `lintDraft`'s own path contract; what it changes is that
`writePaths` — the one dimension the four lanes actually differ on — is now a
consulted declaration instead of a decoration.

**What is still open, and it is the larger half.** Nothing bounds the worker's
reach INSIDE its session. Once the process starts, its real permission surface is
the checkout's `.claude/settings.json` in the worktree it was given, exactly as
before. The envelope gates the daemon's own two acts; it does not follow the
worker in. Three consequences follow and all three are stated in the module header
as well:

- The `prod` lane's declared write scope is the whole worktree. That is the
  envelope being **accurate** about a lane that edits any source file in the
  repository it was handed, not the envelope being generous. Narrowing it would
  make it a lie rather than a boundary.
- `allowedTools` includes a shell, which structurally permits a push at the
  operating-system level. What actually holds invariant two today is the
  composition of five things — the ship lane never pushes, the loop's only git
  surface is worktree and merge, the runner's argument guard refuses any flag
  that would swap out the checkout's settings, the transition applier refuses any
  grant naming push or merge, and the envelope refuses to declare one. The
  envelope is the fifth leg, not the whole chair.
- `networkDestinations` and `secretScopes` are empty for every lane. That is a
  statement, not an omission: a worker's provider traffic and credentials belong
  to the account the harness spawns it under, not to the task.

**What would close the remaining half:** a bound the worker cannot step outside
once it is running — the envelope projected onto the session's own permission
surface at spawn time, rather than checked once at the door. That is a change to
how a worker is launched, not to this module.

### 5.2 The drills prove logic, not durability

Every drill in `fleet-drill.test.ts` runs against a stateful fake queue over
plain maps, with an injected clock. That is a deliberate choice — the drills must
pass on a machine with no database, because a gate that only runs on one machine
is not a gate — and it buys determinism at a real cost: **a drill against a fake
proves the recovery logic, and proves nothing whatsoever about the durability of
the database underneath it.** Nothing here demonstrates that a row survives a
power cut, that a transaction is isolated correctly under concurrency, or that
the real queue behaves as the fake models it.

**What would close it:** a drill against a live local Postgres in which the
daemon process is actually killed with a signal and restarted, with the task
census taken from the database rather than from a map. That is an operational
test, not a unit test, and it needs a machine with the queue configured.

### 5.3 The property suite drives a simulated fleet, not the runner

The generated sequences drive the real state machine, the real envelope validator
and the real ledger, and they write to a real ledger directory on disk. They do
not spawn a worker, do not run the tick, and do not touch the queue backend. An
invariant that is broken by the *runner* rather than by these modules would not
be caught here.

**What would close it:** extending the generator to drive `tick` against the
in-memory reference queue, which would make the sequences much slower and is a
larger piece of work than this document's subject.

### 5.4 On one recovery path the row is reconstructed, and says less

**Updated 2026-08-05 — the gap is closed, and what replaced it is weaker than a
live row, deliberately.** A task recovered by the queue's **own** lease expiry —
the daemon down while a worker dies — used to leave no row at all, because only
`complete()` and `fail()` reach the ledger and neither of them ran. `reconcile.mjs`
now runs once a tick from `loop.mjs`, compares what the queue says has concluded
against the attempt **numbers** the ledger holds, and appends the ones nobody
wrote.

**A reconstructed row is evidence that an attempt existed, and nothing more.** It
carries `reconstructed: true`, and it carries no `workerId`, no `provider` and no
`receiptRef`, because nobody observed those. Its `recordedAt` is the moment of
reconciliation, not the moment of the attempt — a retry counter cannot say when
the attempt was, and a plausible timestamp would be a fabricated one. Its
`outcome: 'failed'` / `failureReason: 'runtime_offline'` are the two facts the
counter really does carry.

**It under-reports by construction.** Only tasks the queue reports with
`attempt > 1` are examined, and a ledger holding any row the pass cannot place —
a row with no attempt number — silences that whole task rather than guessing
beside it. So the answer to «is every attempt in the ledger» is *more often yes
than it was*, not *always yes*.

**What is still open:** the pass holds no state between calls, so it re-reads the
ledger file of every retried task on every tick. On a queue with thousands of
retried tasks that is the cost to watch, and a time bound on how far back it looks
is the narrowing that would pay for itself first.

### 5.5 Half of invariant five is not machine-decidable

The invariant's second branch says a retry may open a new attempt *without
repeating the effect*. The enforceable part — one effect applied at most once per
task, attempt and transition, and a deterministic key that a redelivery cannot
change — is checked after every step. The other part is not: a new attempt of a
task legitimately starts a worker process again, which is by any reading a repeat
of that effect, and treating it as a violation would make the invariant unusable.
So the suite checks the first branch strictly and does not attempt the second.

**What would close it:** a per-effect classification saying which effects are
safe to repeat across attempts and which are not. No such classification exists
today, and inventing one without knowing the real effects would be decoration.

### 5.6 Invariant six is checked, not structurally prevented

The ledger is append-only, and no function in the module edits or removes a row —
but nothing stops a caller from *appending a second row for the same attempt with
a different stamp*. The property suite reads the ledger back and reports it when
it happens; the storage does not refuse it. Related: an attempt row is keyed by
the attempt **number**, not by an attempt id — `attemptId` is a field of the
decision journal, not of the attempt ledger — so rows are grouped by number when
the stamp is compared.

**What would close it:** a read-before-append check in `recordAttempt` that
refuses a stamp conflicting with the first row of the same attempt. It would cost
the ledger its current property of never reading before it writes.

### 5.7 A property failure arrives without minimisation

The property harness is thirty lines of deterministic generator rather than a
property-testing library, because the product declares no runtime dependency it
does not need and adding one is a decision above a single change. The cost is
real and is stated here rather than discovered: a library would shrink a
forty-step counterexample to the three steps that matter, and this harness does
not. A failure arrives as a seed, a sequence number and a step index, and a
person shrinks it by re-running with fewer steps.

**What would close it:** adopting a property-testing library, which is a decision
about dependencies rather than about tests.

### 5.8 The machine is wired, and three of the seven stamp fields have no value to carry

**Rewritten 2026-08-05 — the wiring landed; what remains is narrower and is stated
here rather than implied.**

**What now runs in production.** `pgboss-backend.mjs` routes each of its three
status changes through `applyTransition` — `claimNext` names `READY -> CLAIMED`,
`complete` names `RUNNING -> PRODUCED`, `fail` names `RUNNING -> RETRYABLE` — and
`loop.mjs` mints the transition its own attempt row stands for, naming `CLAIMED`
or `RUNNING` according to whether a worker process had actually started. Live
attempt rows now carry `idempotencyKey`, `stateMachineVersion`,
`capabilityEnvelopeHash`, and — on the tick's rows — `memorySnapshotHash`.

**The machine is consulted; the queue is not gated on it.** A refused transition
is logged by name and leaves the stamp absent, and the durable mutation still
happens. That is deliberate: the queue is the coarse truth, and an audit layer
that could strand a finished task by refusing to record it would be a worse fault
than the one it detects.

**Three transitions are exempt, by name.** `RETRYABLE -> READY` and
`RETRYABLE -> DEAD_LETTER` — which of the two a failure takes is decided inside
pg-boss by `retryLimit` during the very `fail` call, and this backend never
observes the branch; naming one would be a claim about something it did not see.
`PRODUCED -> VERIFYING -> ACCEPTED` — `complete()` is not acceptance, it hands the
task to a human, and manufacturing a disposition there is exactly the
self-certification invariant one exists to forbid. This is why §3.1 and §3.7 still
point here: the machine is called, but not on the edges those two invariants live
on.

**Three of the seven stamp fields are still absent, and that is the honest answer,
not a gap.** `policyVersion` — the daemon's routing policy carries no version at
all. `harnessVersion` — nothing in this process asks the agent CLI what version it
is. `planHash` — a task carries a title, an acceptance sentence and a lane; there
is no plan document to hash. Each absence is recorded at the call site. A fourth,
`memorySnapshotHash`, is absent on the **adapter's** rows specifically, because
that layer does not know which corpus the worker read; the tick does, and stamps
it there.

**What would close the rest:** a versioned routing policy and an observed harness
version would give two of the three fields something true to carry. The exempt
transitions close only when the layer that decides them reports the branch it
took — for the retry/dead-letter split that means reading the outcome back from
pg-boss, and for acceptance it means the front's approve path minting the
transition it already performs.

## 6. Change log

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-08-04 | First edition. The seven invariants, the eleven states and the transition contract shape, the at-least-once promise, and seven non-goals — written when the property suite and the drills that prove them landed. |
| 1.1 | 2026-08-05 | §5.8 added after review: the state machine and the attempt stamp are tested formal references with no production consumer yet — §3.1/§3.7's «Enforced by `applyTransition`» now reads through that lens, stated instead of implied. |
| 1.2 | 2026-08-05 | The wiring landed and three non-goals shrank to their true size. §5.8 rewritten: the queue adapter and the tick now route status changes through `applyTransition` and live rows carry the key, the machine version and the envelope digest — with three transitions exempt by name and three stamp fields absent because nothing in the product can compute them. §5.1: the envelope is consulted before a spawn and before a forge draft is accepted, fail-closed; the worker's own session surface remains unbounded and that is now the whole of the non-goal. §5.4: the reconciliation pass closed the missing-row gap, and a reconstructed row is documented as weaker than a live one. §3.1/§3.4/§3.7 re-pointed accordingly. |
