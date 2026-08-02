# SMA in 60 seconds

The entry point: what SMA is and which topic to read next.

## en
SMA is a memory and coordination framework for AI coding agents. It solves two chronic problems: the assistant forgets everything between conversations, and parallel terminals overwrite each other's work. SMA adds a third thing on top: an accountable loop that makes the system prove its own claims with a script instead of its own word.

The core is deterministic scripts over files and git: no daemon, no database, no cloud, no LLM in the hot path. The V5 worker fleet and its app are an optional layer on top, with a local daemon and a local PostgreSQL queue on your own machines.

Where to go next:
- `node scripts/sma/cli.mjs explain substrate` — why it is only files and git.
- `node scripts/sma/cli.mjs explain loop` — the predict, act, score, learn cycle.
- `node scripts/sma/cli.mjs explain memory-layers` — how the assistant remembers.
- `node scripts/sma/cli.mjs explain coordination` — how terminals see each other.
- `node scripts/sma/cli.mjs explain --list` — every topic at a glance.

Example: type `node scripts/sma/cli.mjs explain reflexes` and you learn how a past mistake becomes a warning that fires before the next matching edit.

## ru
SMA это фреймворк памяти и координации для ИИ-агентов, которые пишут код. Он решает две хронические проблемы: ассистент забывает всё между разговорами, и параллельные терминалы затирают работу друг друга. Сверху SMA добавляет третье: подотчётный цикл, который заставляет систему доказывать свои же утверждения скриптом, а не своим словом.

Ядро это детерминированные скрипты поверх файлов и git: нет демона, нет базы данных, нет облака, нет LLM в горячем пути. Парк работников V5 и его приложение это необязательный слой сверху, с локальным демоном и локальной очередью в PostgreSQL на Ваших машинах.

Куда идти дальше:
- `node scripts/sma/cli.mjs explain substrate` про то, почему это только файлы и git.
- `node scripts/sma/cli.mjs explain loop` про цикл: предсказать, сделать, оценить, выучить.
- `node scripts/sma/cli.mjs explain memory-layers` про то, как ассистент помнит.
- `node scripts/sma/cli.mjs explain coordination` про то, как терминалы видят друг друга.
- `node scripts/sma/cli.mjs explain --list` про все темы сразу.

Пример: наберите `node scripts/sma/cli.mjs explain reflexes`, и Вы узнаете, как прошлая ошибка превращается в предупреждение, которое срабатывает перед следующей похожей правкой.
