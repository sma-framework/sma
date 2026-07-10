# sma excavate

Day-one value: mine a stranger's git history read-only for reflexes that would have fired.

## en
`sma excavate` is the five-minute demo on a repo SMA has never seen. It reads the git history only, touching nothing, and looks for patterns that a reflex would have caught: commit then revert pairs, chains of typo-fix commits, red CI runs followed by a fix.

For each pattern it prints a CATCHES line: what happened, and which reflex would have warned before which push. It is the fastest way to show that "our process matters" is not a slogan, because it points at real past mistakes in your own history that the loop would have flagged.

Because it is read-only over git, it is safe to run on any repository, including one you do not own.

The command: `pnpm sma excavate` with `--stats` as its instrument.

Example: run it on a project and it reports "3 commit-revert pairs, 5 typo-fix chains; a reflex on migration edits would have fired before 2 of them" — concrete evidence in the first five minutes.

## ru
`sma excavate` это пятиминутная демонстрация на репозитории, который SMA никогда не видел. Он читает только git-историю, ничего не трогая, и ищет закономерности, которые поймал бы рефлекс: пары коммит и откат, цепочки правок-опечаток, красные прогоны CI, за которыми следует исправление.

Для каждой закономерности он печатает строку CATCHES: что произошло и какой рефлекс предупредил бы перед каким пушем. Это самый быстрый способ показать, что «наш процесс важен» это не лозунг, потому что он указывает на реальные прошлые ошибки в Вашей же истории, которые цикл пометил бы.

Поскольку это только чтение поверх git, его безопасно запускать на любом репозитории, включая тот, которым Вы не владеете.

Команда: `pnpm sma excavate` со спутником `--stats` как измерителем.

Пример: запустите его на проекте, и он сообщит «3 пары коммит-откат, 5 цепочек правок-опечаток; рефлекс на правки миграций сработал бы перед 2 из них», то есть конкретное свидетельство в первые пять минут.
