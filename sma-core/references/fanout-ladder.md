# Fan-out ladder: swarm or solo (layer 1)

When a task arrives, one decision comes before any work: **one agent, or several in
parallel?** This reference makes that decision deterministic instead of a vibe. It is
layer 1 — terminal discipline you can read and apply by hand. Layer 2 (enforcement in
the orchestration dispatcher) is deliberately deferred; see the last section.

Read this before spawning subagents, and before assuming a single agent is enough.

---

## The four signals

Answer them in order. **The first signal that forces solo wins** — the ladder narrows
fan-out, it never widens it.

| # | Signal | Question | Decision |
|---|---|---|---|
| 1 | **Divisibility** | Can the work be cut into parts whose **file scopes do not overlap**? | No overlap-free cut exists → **solo**. Overlapping edits by parallel agents produce merge damage that costs more than the parallelism saved. |
| 2 | **Risk class** | Does it introduce a new surface, a migration, or a schema change? | Yes → **solo, plus a grill**. New surface and irreversible change need one coherent author and an adversarial review, not throughput. |
| 3 | **Size** | How big is the work? | **S → solo.** **M → a pair** (two scopes at most). **L → waves** (planned, dependency-ordered). |
| 4 | **Budget remaining** | How much of the spend window is left? | Below the lane threshold → **solo**. Fan-out multiplies burn rate by the number of agents; a swarm that runs a budget dry mid-task leaves an unfinished tree. |

Two notes on reading the table:

- Signal 1 is a **gate**, not a preference. "The scopes mostly do not overlap" is an
  overlap. If two agents would both touch one file, the cut is wrong — either re-cut it
  or go solo.
- Signal 2 outranks signal 3. A large task in a risky class is still solo; large means
  it becomes a **sequence** of solo steps, not a swarm.

## What this already means in the shipped commands

The ladder is not new policy invented on paper. It is the rule the commands already
follow, written down so it can be applied outside them.

| Surface | Fan-out | Why |
|---|---|---|
| `/sma-fast` | Solo, by construction | Trivial work: the coordination cost of a second agent exceeds the work itself. |
| `/sma-quick` | Solo, by construction | One scope, one commit, one receipt. Size S on the ladder. |
| `/sma-execute-phase` | Waves, by construction | The plan already declares dependencies and non-overlapping file sets — signal 1 was answered at planning time. |
| Planning a phase | Decides the waves | Wave assignment IS the divisibility answer, recorded in the plans' `files_modified`. |

Reading the same table backwards: if you are about to spawn a swarm for work that has no
plan behind it, you have skipped signal 1. Cut the scopes first, on paper, and check that
no file appears twice.

## Worked examples

| Task | Signals | Decision |
|---|---|---|
| Add a flag to one CLI verb, plus its test and doc line | Divisible? Not usefully. Risk: none. Size: S | Solo |
| Two independent library modules with separate tests | Divisible: yes, disjoint. Risk: none. Size: M | A pair, one scope each |
| A schema migration plus the code that reads it | Divisible: technically. Risk: **migration** | Solo, plus a grill |
| Six plans across a phase, dependencies declared, no shared files | Divisible: yes, by plan. Risk: per plan. Size: L | Waves |
| Any of the above with the spend window nearly exhausted | Budget below threshold | Solo, and consider deferring |

## The honest limits of layer 1

- **It is advisory.** Nothing in the product refuses a swarm today. This document plus
  `sma explain fanout` are the whole mechanism: a terminal that reads it and applies it.
- **It measures nothing.** There is no post-hoc check that a swarm actually beat a solo
  run on wall-clock, cost, or quality. Believing a swarm was faster because it felt busy
  is exactly the failure this ladder exists to replace, and layer 1 cannot detect it.
- **The thresholds are conventions.** S/M/L and "the lane threshold" are the sizes and
  budgets your project already uses; the ladder does not invent new numbers.

## Layer 2 — the dispatcher (deferred to V5.3)

The enforcing half is written down here so it is not re-invented ad hoc:

- **Fan-out becomes a dimension of the routing policy**, decided by the dispatcher rather
  than by whoever is typing.
- **The decision journal records a reason code** per choice: why a swarm, why a solo,
  which signal decided it — appended, never rewritten.
- **Post-hoc scoring closes the loop** from the spend ledger and the prediction ledger: a
  swarm is justified when wall-clock drops while cost and quality stay inside tolerance.
  A miss becomes a lesson draft, like any other scored miss.

It is deferred on purpose. Enforcing a fan-out policy before its outcomes are measured
would freeze thresholds that nobody has scored yet, and a wrong threshold enforced by a
dispatcher is more expensive than the same threshold written in a document a human can
override.

---

## Кратко по-русски

Лестница «рой vs соло», слой 1: детерминированный выбор фан-аута вместо ощущения.
Сигналы читаются по порядку, **первый сигнал, требующий соло, побеждает**.

1. **Делимость.** Есть ли разрез на части с **непересекающимися файловыми скоупами**?
   Нет разреза без пересечений — **соло**. Это гейт, а не предпочтение: «почти не
   пересекаются» означает пересекаются.
2. **Риск-класс.** Новая поверхность, миграция или изменение схемы — **соло плюс
   гриль**. Этот сигнал старше размера: большая рискованная работа это
   последовательность соло-шагов, а не рой.
3. **Размер.** S — **соло**, M — **пара** (максимум два скоупа), L — **волны**.
4. **Остаток бюджета.** Ниже порога полосы — **соло**: рой умножает скорость сжигания
   бюджета на число агентов, а высохший бюджет посреди задачи оставляет недоделанное
   дерево.

В командах продукта эта лестница уже действует по построению: `/sma-fast` и
`/sma-quick` работают соло, `/sma-execute-phase` идёт волнами (делимость доказана
планом: непересекающиеся `files_modified`), а само планирование фазы и есть ответ на
первый сигнал.

Слой 1 честно ограничен: он советует, но не принуждает, и ничего не измеряет.
**Слой 2 — диспетчер оркестрации: fan-out как измерение routing policy, коды причин в
журнале решений, пост-фактум скоринг расходом и временем — приходит с V5.3.**
