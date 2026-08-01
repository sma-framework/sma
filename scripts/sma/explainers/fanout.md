# Fan-out: swarm or solo

Four deterministic signals decide whether work goes to several agents in parallel or to one.

## en
Before any work starts there is a decision most tools leave to a feeling: one agent, or a swarm of them? SMA answers it with four signals, read in order, where **the first signal that forces solo wins** — the ladder narrows fan-out, never widens it.

1. **Divisibility.** Can the work be cut into parts whose file scopes do not overlap? If no overlap-free cut exists, it is solo. This is a gate, not a preference: "the scopes mostly do not overlap" is an overlap, and two agents editing one file produce merge damage worth more than the parallelism saved.
2. **Risk class.** A new surface, a migration, or a schema change means solo plus a grill. This outranks size: large risky work becomes a sequence of solo steps, not a swarm.
3. **Size.** S goes solo, M goes to a pair (two scopes at most), L goes to planned dependency-ordered waves.
4. **Budget remaining.** Below the lane threshold, solo. Fan-out multiplies the burn rate by the number of agents, and a swarm that drains the window mid-task leaves an unfinished tree.

The shipped commands already obey this: `/sma-fast` and `/sma-quick` are solo by construction, `/sma-execute-phase` runs waves because the plans declare non-overlapping `files_modified` — planning a phase IS the answer to signal 1.

Layer 1 is honest about its limits: it advises, it does not enforce, and it measures nothing. The enforcing half (fan-out as a routing-policy dimension, a reason code per choice in the decision journal, post-hoc scoring from the spend and prediction ledgers) is deferred to V5.3, so that thresholds are enforced only after they have been scored. The full ladder, with worked examples, lives in `sma-core/references/fanout-ladder.md`.

## ru
Перед началом работы стоит решение, которое большинство инструментов оставляет на ощущение: один агент или рой? SMA отвечает четырьмя сигналами, читаемыми по порядку, причём **первый сигнал, требующий соло, побеждает**: лестница только сужает фан-аут и никогда его не расширяет.

1. **Делимость.** Есть ли разрез задачи на части с непересекающимися файловыми скоупами? Если разреза без пересечений нет, работа идёт соло. Это гейт, а не предпочтение: «почти не пересекаются» означает пересекаются, а два агента, правящих один файл, наносят ущерб слияния дороже сэкономленной параллельности.
2. **Риск-класс.** Новая поверхность, миграция или изменение схемы означают соло плюс гриль. Этот сигнал старше размера: большая рискованная работа превращается в последовательность соло-шагов, а не в рой.
3. **Размер.** S идёт соло, M идёт в пару (максимум два скоупа), L идёт волнами по объявленным зависимостям.
4. **Остаток бюджета.** Ниже порога полосы, соло. Рой умножает скорость сжигания бюджета на число агентов, а высохшее окно посреди задачи оставляет недоделанное дерево.

Команды продукта подчиняются этому по построению: `/sma-fast` и `/sma-quick` работают соло, `/sma-execute-phase` идёт волнами, потому что планы объявили непересекающиеся `files_modified`. Планирование фазы и есть ответ на первый сигнал.

Слой 1 честен насчёт своих границ: он советует, но не принуждает, и ничего не измеряет. Принуждающая половина (fan-out как измерение routing policy, код причины на каждый выбор в журнале решений, пост-фактум скоринг по книге трат и журналу предсказаний) отложена до V5.3, чтобы пороги принуждались только после того, как их оценили. Полная лестница с разобранными примерами живёт в `sma-core/references/fanout-ladder.md`.
