# Onboarding teaching modules — the five things a new user must understand (D-49.3-03/05)

The centerpiece of adoption is the first ten minutes. An uninitiated user who does not
understand WHY the process matters abandons the HOW. This file holds the deterministic
teaching content `/sma-start` delivers — the module TEXT lives here, versioned; the
workflow only STAGES it (a `> TEACH(<module-id>)` marker fires each module immediately
before the stage it makes meaningful, never one front-loaded lecture, D-49.3-05).

Every module is written in plain words: each technical term is glossed in one line the
first time it appears (the novice hard rule, carried from V2). Each module carries one
concrete `Without SMA:` / `With SMA:` example pair (a real failure mode next to the
artifact that prevents it) and a one-line `Recap:` sentence. The recap renderer
(`profile.mjs` → `renderRecap`) re-reads the five `Recap:` lines from THIS file, so that
copy lives exactly once.

Order is locked (the workflow's staging map depends on it): `accountable-loop` opens the
conversation (it is the thesis), `receipts-vs-prose` closes it (it frames what
`/sma-plan` asks next).

---

### Module 1 — The accountable loop (id: accountable-loop)

SMA is a PROCESS, not a rules file. A rules file is a long document of "always do X,
never do Y" that an assistant reads once and quietly forgets. SMA instead runs a loop:
**predict → act → score → learn.** Before doing a piece of work, the system writes down
what it EXPECTS to happen — a concrete, checkable claim (a "prediction": a number a
command can later measure). It then does the work. Afterwards it runs that command and
compares the real result to the prediction. Over many cycles this calibrates how much to
trust the system's own estimates — the way a weather forecaster tracks their hit rate
instead of just sounding confident.

The point: confidence is cheap, a scored track record is not. A plan that says "this
will make things 10x faster" is a boast; a plan that says "this will cut the check
command's runtime below 4 seconds, here is the command that proves it" is accountable.

`Without SMA:` a plan claims "done, everything works," ships, and three weeks later
nobody can tell which promises actually held — there was never a number to check, so the
claim was never testable.

`With SMA:` the plan carries a pre-registered prediction (`metric < 4s`, `check_command:
node scripts/bench.mjs`) that a scorer runs after the fact; the claim becomes a hit or a
miss on the record, and a miss auto-drafts a lesson.

Recap: SMA scores what it predicted before acting, so every claim is a checkable number, not a boast.

---

### Module 2 — The three memory layers (id: memory-layers)

The system keeps notes about your project so every session starts already knowing it.
Those notes live in three layers. The **CORE** layer is small and always loaded — the
handful of facts every single session must know (your goal, your stack, your hard
rules). The **periphery** is the large body of topic notes that are pulled in by TAG only
when a task actually needs them (a "tag" is a label like `payments` or `deploy`; a task
about billing pulls the `payments` notes and ignores the rest). The **colder archive**
layers hold older facts that are no longer hot — but tag search still reaches them, so
**nothing is ever deleted**, only demoted to a layer that loads less eagerly.

Why three layers instead of one big file: a single ever-growing document eventually
becomes too big to load every time, so it gets loaded partially or not at all — and then
it is memory in name only. Layering keeps the always-loaded surface tiny while keeping
every fact reachable.

`Without SMA:` a project accumulates a 700-line "rules" file; it grows past what fits in
a session's attention, the assistant reads the top and skips the rest, and the rule that
mattered was on line 480.

`With SMA:` CORE stays a few kilobytes of must-know facts, everything else waits in
tagged periphery notes, and a billing task pulls exactly the billing notes — full recall,
tiny always-on cost.

Recap: memory is three layers — a tiny always-loaded CORE, tag-pulled periphery, and a cold archive; nothing is ever deleted.

---

### Module 3 — The four hook points (id: hook-points)

SMA attaches to a coding session at four moments (a "hook" is a place where a small
script runs automatically at a fixed moment, without anyone invoking it). **At session
start** it loads the project memory and the coordination state, so the session begins
informed. **Before each edit** it runs quick warnings: is another terminal already
touching this file (collision), is there a past lesson about this kind of change
(reflex), does a safety gate apply. **After each tool call** it watches for a stall — the
same action repeating with no progress — and nudges. **Before the context is compressed**
(a long session eventually has to summarize its own history to make room) it writes a
small "flight capsule": the few facts the continuation must not lose.

Why hooks and not discipline: a rule you must remember to follow is a rule you will
eventually forget under load. A hook fires whether or not anyone remembers it.

`Without SMA:` a long session hits its context limit, auto-summarizes, and silently drops
the one constraint that was holding the work together — the next reply confidently
undoes it.

`With SMA:` the pre-compression hook has already written the flight capsule, so the
continuation restores the constraint from a durable file instead of losing it.

Recap: SMA hooks four moments — session start, before each edit, after each tool call, and before context compression — so the right check fires without anyone remembering it.

---

### Module 4 — Coordination without a server (id: coordination)

If you run several AI coding sessions at once (several terminal windows on the same
project), they can collide — two of them editing the same file, or both grabbing the same
numbered resource. SMA coordinates them with **small marker files** left on disk, not a
central server: a "claim" marks who is working on which files, a "shared-counter slot"
reserves the next migration or release number so two sessions do not both take it, a
"push-claim" signals who is about to publish. Because the markers are just local files,
sessions **warn BEFORE a collision** instead of discovering it after a broken merge.

Why files and not a service: a coordination server is one more thing to run, secure, and
keep alive. Marker files need nothing running — they work the moment two terminals share
a folder.

`Without SMA:` two terminals each pick "migration 045" for their own change; both commit;
the second migration silently overwrites the first and the database schema is now wrong on
deploy.

`With SMA:` the first terminal's next-slot claim reserves 045, the second terminal sees
the claim and takes 046 — the collision is a one-line warning, not a production incident.

Recap: parallel terminals leave small marker files — claims, counter slots, push-claims — so sessions warn before a collision instead of merging broken work after.

---

### Module 5 — Receipts, not prose (id: receipts-vs-prose)

"Done" written in prose is a CLAIM — a sentence asking you to trust it. A **receipt** is a
re-runnable command with an expected result: anyone can run it again and get the same
verdict. SMA prefers receipts everywhere it can. Plans carry pre-registered predictions
(a receipt for a promise). Finished work carries structural receipts (a command that
re-verifies the built thing). The calibration ledger is the running receipt of how often
the system's predictions actually held. The rule is simple: a "done" that a machine could
check must ship the command that checks it, not a paragraph asserting it.

Why receipts over prose: prose degrades — it gets copied, softened, and eventually
believed without anyone re-checking. A command does not degrade; it either still passes or
it does not.

`Without SMA:` a summary says "the search returns correct results" — months later the
search is broken and no one notices, because "correct" was never a command anyone could
re-run.

`With SMA:` the summary carries a receipt (`check_command` + expected number); re-running
it today either confirms the claim or exposes the regression on the spot.

Recap: a «done» in prose is a claim; a receipt is a re-runnable command with an expected result — SMA prefers receipts everywhere.

---

## Consumer contract

`renderRecap` (in `scripts/sma/lib/profile.mjs`) parses the five `Recap:` lines from this
file, in document order, and prints them as the "how SMA works" section of the onboarding
recap. The parse is deterministic (a plain line-oriented scan, no LLM) and the copy lives
ONLY here — the recap never hardcodes these sentences. If a module's `Recap:` line is
edited, the recap output changes with it in the same render.
