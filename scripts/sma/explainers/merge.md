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

Push is explicitly out of scope: shipping stays founder-ordered through the release ritual; `sma merge` does not push and does not deploy.

The posture is fail-open: any error degrades to an honest failure that releases the held slot, so a gate bug can never wedge a session or leave a slot stuck. The soft-deny is the mayDeny tier only; hard deny remains the security guard's alone, and a force-cleared scope is never enforced against the founder's word.

Example: `node scripts/sma/cli.mjs merge worktree-agent-7` reports "merged into main LOCALLY (a1b2c3d); tests on the merge result: green" and reminds you that push happens through the release ritual.

The OTHER direction is `sma sync-branch`, and it belongs to whoever hands work in, not to whoever accepts it. Work is cut from a tip that stops existing about twenty minutes later, so before a branch is handed over the trunk is brought INTO it, in that worker's own copy: `node scripts/sma/cli.mjs sync-branch`. A mechanical conflict is settled with nobody — a generated artifact is rebuilt by its own command, and a paragraph both sides appended stays as BOTH paragraphs. Anything left is named by FILE and by COUNT rather than announced as "it did not go through", and `--keep` leaves that remainder marked in the tree so the author of one side can settle it with `git add` + `git commit`; `--abort` backs out of that state again. `--check` only says how far behind the branch is and changes nothing. The verb never pushes and never touches the shared tree — and it exists because the bare merge verb is refused to a worker on purpose: a duty with nothing to perform it with is a paragraph, not a duty.

## ru
`sma merge <ветка>` это ЕДИНСТВЕННЫЙ путь, которым ветка воркдерева (смотрите `sma worktree`) попадает в main. Он убивает классический сбой нескольких терминалов: «Ваш пуш увёз мою недостроенную работу».

Ритуал идёт в строгом порядке:
1. Занять слот «идёт слияние». Это тот же триплет заявки (занять, отпустить, проверить), что и у заявки на пуш, поэтому параллельное слияние получает мягкий запрет с переопределением, а не гонку.
2. Влить ветку в main ЛОКАЛЬНО. Никакого пуша, никакого деплоя.
3. Прогнать целевые тесты на РЕЗУЛЬТАТЕ слияния, а не на какой-то из веток по отдельности, потому что две зелёные по отдельности ветки могут быть красными вместе.
4. Записать квитанцию в журнал: ветка, sha результата и вердикт тестов, прошли или нет, честно.
5. Отпустить слот.

Пуш намеренно вне охвата: отгрузка остаётся по команде основателя, через релизный ритуал; `sma merge` не пушит и не деплоит.

Осанка с открытым отказом: любая ошибка вырождается в честный отказ с освобождением занятого слота, поэтому баг ворот не может повесить сессию или оставить слот застрявшим. Мягкий запрет это только уровень mayDeny; жёсткий запрет остаётся за стражем безопасности, а принудительно очищенный охват никогда не принуждается против слова основателя.

Пример: `node scripts/sma/cli.mjs merge worktree-agent-7` сообщает «влит в main ЛОКАЛЬНО (a1b2c3d); тесты на результате слияния: зелёные» и напоминает, что пуш происходит через релизный ритуал.

ОБРАТНОЕ направление это `sma sync-branch`, и это работа сдающего, а не приёмщика. Работы отводятся от вершины, которой через двадцать минут не существует, поэтому перед сдачей вершина вносится В ветку, в собственной копии работника: `node scripts/sma/cli.mjs sync-branch`. Механический конфликт разводится без человека: сгенерированное пересобирается своей же командой, а абзац, дописанный обеими сторонами, остаётся ОБОИМИ абзацами. Всё, что осталось, называется ИМЕНАМИ ФАЙЛОВ и их ЧИСЛОМ, а не объявляется строкой «слияние не прошло». Флаг `--keep` оставляет этот остаток размеченным в дереве, чтобы автор одной из сторон развёл его сам через `git add` и `git commit`, а `--abort` выводит обратно из этого состояния. Флаг `--check` только говорит, на сколько ветка отстала, и ничего не меняет. Верб не пушит и общего дерева не касается, а существует он потому, что голый глагол слияния работнику отказан нарочно: обязанность, которую нечем исполнить, это не обязанность, а текст.
