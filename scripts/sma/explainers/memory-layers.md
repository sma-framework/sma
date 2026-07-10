# Memory in three layers

Core, topic notes, and reflexes: how the assistant remembers your project.

## en
Your project's knowledge lives as small notes, one fact per note, each carrying tags from a strict vocabulary. There are three layers:
- The core is always loaded. The most important rules and current blockers reach every conversation from the first second.
- Topic notes load on demand. Working on payments? The assistant pulls only notes tagged finance, not the whole corpus.
- Reflexes are lessons from misses that fire as warnings at the moment of a matching action.

The index is machine-built by a script from the notes, so a manual edit is caught by the checker immediately.

The commands:
- `pnpm sma load --tags <area>` pulls the relevant notes for a task.
- `pnpm sma lint` finds untagged, mistyped, broken-link or stale notes.
- `pnpm sma build-index` regenerates the table of contents.
- `pnpm sma consolidate` and `pnpm sma trim` keep the corpus sharp at scale.

Example: `pnpm sma load --tags security` returns only the security notes, so the assistant is briefed without loading hundreds of unrelated facts.

## ru
Знание Вашего проекта живёт как маленькие заметки, один факт на заметку, каждая с ярлыками из строгого словаря. Слоёв три:
- Ядро загружается всегда. Самые важные правила и текущие блокеры попадают в каждый разговор с первой секунды.
- Тематические заметки грузятся по требованию. Работаете над платежами? Ассистент подтянет только заметки с ярлыком finance, а не весь корпус.
- Рефлексы это уроки из промахов, которые срабатывают предупреждением в момент похожего действия.

Индекс строит скрипт из заметок, поэтому ручную правку проверяющий ловит сразу.

Команды:
- `pnpm sma load --tags <область>` тянет нужные заметки под задачу.
- `pnpm sma lint` находит заметки без ярлыков, с опечатками, с битыми ссылками или устаревшие.
- `pnpm sma build-index` пересобирает оглавление.
- `pnpm sma consolidate` и `pnpm sma trim` держат корпус острым на масштабе.

Пример: `pnpm sma load --tags security` вернёт только заметки по безопасности, поэтому ассистент введён в курс, не загружая сотни несвязанных фактов.
