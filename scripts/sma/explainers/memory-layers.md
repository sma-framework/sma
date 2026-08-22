# Memory in three layers

Core, topic notes, and reflexes: how the assistant remembers your project.

## en
Your project's knowledge lives as small notes, one fact per note, each carrying tags from a strict vocabulary. There are three layers:
- The core is always loaded. The most important rules and current blockers reach every conversation from the first second.
- Topic notes load on demand. Working on payments? The assistant pulls only notes tagged finance, not the whole corpus.
- Reflexes are lessons from misses that fire as warnings at the moment of a matching action.

The index is machine-built by a script from the notes, so a manual edit is caught by the checker immediately.

The always-loaded layer has a byte budget, and how full it is no longer needs looking up: the session start prints the fill, `build-index --write` prints it again the moment the index is rewritten, and the statusline carries it once it approaches the limit. Over budget, the message is not a scolding but a ready offer — consolidate now, with the command beside it. Nothing is rewritten for you.

Forgetting is one command. `memory forget <id>` makes the assistant stop treating a note as true: the file stays on disk, but the note never reaches a conversation again, and the command tells you which state it applied. Name a replacement and the old note is linked to the new one instead. Erasing is a separate and irreversible act: `--erase` on its own only shows what would go and deletes nothing, and it happens only when you repeat it with `--yes`. Even then, a note that once reached a commit is still in that commit and in every copy of the repository, which the command says out loud rather than hides.

The commands:
- `node scripts/sma/cli.mjs load --tags <area>` pulls the relevant notes for a task.
- `node scripts/sma/cli.mjs lint` finds untagged, mistyped, broken-link or stale notes.
- `node scripts/sma/cli.mjs build-index` regenerates the table of contents.
- `node scripts/sma/cli.mjs memory forget <id> --reason "<why>"` makes one note stop counting as true; `--erase --yes` deletes it for good.
- `node scripts/sma/cli.mjs consolidate` and `node scripts/sma/cli.mjs trim` keep the corpus sharp at scale.

Example: `node scripts/sma/cli.mjs load --tags security` returns only the security notes, so the assistant is briefed without loading hundreds of unrelated facts.

## ru
Знание Вашего проекта живёт как маленькие заметки, один факт на заметку, каждая с ярлыками из строгого словаря. Слоёв три:
- Ядро загружается всегда. Самые важные правила и текущие блокеры попадают в каждый разговор с первой секунды.
- Тематические заметки грузятся по требованию. Работаете над платежами? Ассистент подтянет только заметки с ярлыком finance, а не весь корпус.
- Рефлексы это уроки из промахов, которые срабатывают предупреждением в момент похожего действия.

Индекс строит скрипт из заметок, поэтому ручную правку проверяющий ловит сразу.

У всегда загружаемого слоя есть байтовый бюджет, и за его заполненностью больше не надо ходить: старт сессии печатает её сам, `build-index --write` печатает её ещё раз в момент перезаписи индекса, а строка состояния несёт её, когда бюджет близок к пределу. При переполнении сообщение это не выговор, а готовое предложение: консолидируй сейчас, и рядом стоит команда. Ничего за Вас не переписывается.

Забыть можно одной командой. `memory forget <id>` заставляет ассистента перестать считать заметку верной: файл на диске остаётся, но в разговор заметка больше не попадает, и команда сама печатает, что именно она применила. Если назвать замену, старая заметка просто свяжется с новой. Стереть совсем это отдельное и необратимое действие: один флаг `--erase` ничего не удаляет, он только показывает, что уйдёт, а само удаление происходит, лишь если повторить то же самое с `--yes`. И даже тогда заметка, которая когда-то попала в коммит, остаётся в этом коммите и во всех копиях репозитория; команда говорит это вслух, а не умалчивает.

Команды:
- `node scripts/sma/cli.mjs load --tags <область>` тянет нужные заметки под задачу.
- `node scripts/sma/cli.mjs lint` находит заметки без ярлыков, с опечатками, с битыми ссылками или устаревшие.
- `node scripts/sma/cli.mjs build-index` пересобирает оглавление.
- `node scripts/sma/cli.mjs memory forget <id> --reason "<почему>"` перестаёт считать одну заметку верной; `--erase --yes` удаляет её насовсем.
- `node scripts/sma/cli.mjs consolidate` и `node scripts/sma/cli.mjs trim` держат корпус острым на масштабе.

Пример: `node scripts/sma/cli.mjs load --tags security` вернёт только заметки по безопасности, поэтому ассистент введён в курс, не загружая сотни несвязанных фактов.
