# Reflexes

A scored miss becomes a rule that warns before the next matching action.

## en
A reflex is what a miss turns into. When a prediction misses or a bug is confirmed, the lesson is written as a rule with a firing condition. Before each subsequent assistant action, a check asks whether the action matches a condition, and if it does, it injects a warning straight into the conversation, before the edit.

It is like a child who touches boiling water once and never again. Noise controls are built in: a repeat warning is muted, and every rule has a kill switch.

The rules do not only accumulate. A self-tuning ladder promotes rules that keep proving useful and demotes noisy ones, always on journal evidence and always as a reviewable diff.

The commands: `pnpm sma reflex-check` fires the check (usually via the hook), and `pnpm sma ladder`, `pnpm sma tune` and `pnpm sma curriculum` manage how rules mature.

Example: after a migration was once forgotten, a reflex fires "did you add the migration?" the next time a collection schema is edited.

## ru
Рефлекс это то, во что превращается промах. Когда предсказание промахивается или подтверждается баг, урок записывается как правило с условием срабатывания. Перед каждым следующим действием ассистента проверка спрашивает, подходит ли действие под условие, и если да, вставляет предупреждение прямо в разговор, до правки.

Это как ребёнок, который однажды тронул кипяток и больше никогда. Контроль шума встроен: повторное предупреждение приглушается, и у каждого правила есть выключатель.

Правила не просто накапливаются. Самонастраивающаяся лестница повышает правила, которые продолжают приносить пользу, и понижает шумные, всегда по свидетельству журнала и всегда обозримым диффом.

Команды: `pnpm sma reflex-check` запускает проверку (обычно через хук), а `pnpm sma ladder`, `pnpm sma tune` и `pnpm sma curriculum` управляют тем, как правила взрослеют.

Пример: после того как миграцию однажды забыли, рефлекс срабатывает «Вы добавили миграцию?» в следующий раз при правке схемы коллекции.
