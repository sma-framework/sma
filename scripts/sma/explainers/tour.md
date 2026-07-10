# SMA in 60 seconds

The entry point: what SMA is and which topic to read next.

## en
SMA is a memory and coordination framework for AI coding agents. It solves two chronic problems: the assistant forgets everything between conversations, and parallel terminals overwrite each other's work. SMA adds a third thing on top: an accountable loop that makes the system prove its own claims with a script instead of its own word.

Everything is deterministic scripts over files and git. There is no daemon, no database, no cloud, no LLM in the hot path.

Where to go next:
- `pnpm sma explain substrate` — why it is only files and git.
- `pnpm sma explain loop` — the predict, act, score, learn cycle.
- `pnpm sma explain memory-layers` — how the assistant remembers.
- `pnpm sma explain coordination` — how terminals see each other.
- `pnpm sma explain --list` — every topic at a glance.

Example: type `pnpm sma explain reflexes` and you learn how a past mistake becomes a warning that fires before the next matching edit.

## ru
SMA это фреймворк памяти и координации для ИИ-агентов, которые пишут код. Он решает две хронические проблемы: ассистент забывает всё между разговорами, и параллельные терминалы затирают работу друг друга. Сверху SMA добавляет третье: подотчётный цикл, который заставляет систему доказывать свои же утверждения скриптом, а не своим словом.

Всё это детерминированные скрипты поверх файлов и git. Нет демона, нет базы данных, нет облака, нет LLM в горячем пути.

Куда идти дальше:
- `pnpm sma explain substrate` про то, почему это только файлы и git.
- `pnpm sma explain loop` про цикл: предсказать, сделать, оценить, выучить.
- `pnpm sma explain memory-layers` про то, как ассистент помнит.
- `pnpm sma explain coordination` про то, как терминалы видят друг друга.
- `pnpm sma explain --list` про все темы сразу.

Пример: наберите `pnpm sma explain reflexes`, и Вы узнаете, как прошлая ошибка превращается в предупреждение, которое срабатывает перед следующей похожей правкой.
