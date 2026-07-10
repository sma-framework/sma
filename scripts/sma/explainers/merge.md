# sma merge

The serialized merge ritual: a worktree branch enters main locally, tested, receipted, never pushed.

## en
`sma merge <branch>` is the ONLY way a worktree branch (see `sma worktree`) enters main. It kills the classic multi-terminal failure: "your push carried my half-built work".

The ritual runs in strict order:
1. Acquire the merge-in-progress slot. It is the same claim triplet (acquire, release, check) the push-claim uses, so a concurrent merge gets a soft-deny with an override, never a race.
2. Merge the branch into main LOCALLY. Never a push, never a deploy.
3. Run targeted tests on the MERGE RESULT, not on either branch alone, because two individually green branches can be red together.
4. Journal a receipt: the branch, the result sha, and the test verdict, pass or fail, honestly.
5. Release the slot.

Push is explicitly out of scope: shipping stays founder-ordered via `/sma-ship`; `sma merge` does not push and does not deploy.

The posture is fail-open: any error degrades to an honest failure that releases the held slot, so a gate bug can never wedge a session or leave a slot stuck. The soft-deny is the mayDeny tier only; hard deny remains the security guard's alone, and a force-cleared scope is never enforced against the founder's word.

Example: `pnpm sma merge worktree-agent-7` reports "merged into main LOCALLY (a1b2c3d); tests on the merge result: green" and reminds you that push happens via `/sma-ship`.

## ru
`sma merge <ветка>` это ЕДИНСТВЕННЫЙ путь, которым ветка воркдерева (смотрите `sma worktree`) попадает в main. Он убивает классический сбой нескольких терминалов: «Ваш пуш увёз мою недостроенную работу».

Ритуал идёт в строгом порядке:
1. Занять слот «идёт слияние». Это тот же триплет заявки (занять, отпустить, проверить), что и у заявки на пуш, поэтому параллельное слияние получает мягкий запрет с переопределением, а не гонку.
2. Влить ветку в main ЛОКАЛЬНО. Никакого пуша, никакого деплоя.
3. Прогнать целевые тесты на РЕЗУЛЬТАТЕ слияния, а не на какой-то из веток по отдельности, потому что две зелёные по отдельности ветки могут быть красными вместе.
4. Записать квитанцию в журнал: ветка, sha результата и вердикт тестов, прошли или нет, честно.
5. Отпустить слот.

Пуш намеренно вне охвата: отгрузка остаётся по команде основателя через `/sma-ship`; `sma merge` не пушит и не деплоит.

Осанка с открытым отказом: любая ошибка вырождается в честный отказ с освобождением занятого слота, поэтому баг ворот не может повесить сессию или оставить слот застрявшим. Мягкий запрет это только уровень mayDeny; жёсткий запрет остаётся за стражем безопасности, а принудительно очищенный охват никогда не принуждается против слова основателя.

Пример: `pnpm sma merge worktree-agent-7` сообщает «влит в main ЛОКАЛЬНО (a1b2c3d); тесты на результате слияния: зелёные» и напоминает, что пуш происходит через `/sma-ship`.
