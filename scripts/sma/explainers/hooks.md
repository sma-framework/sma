# The four hook points

Where SMA fires automatically inside a Claude Code session.

## en
SMA wires itself into four moments of a session so most of the value happens without you typing anything:
- Session start. The window registers itself and loads the memory core.
- Before a tool call. One multiplexer (`pnpm sma pre`) runs before every Edit, Write or Bash and dispatches the collision, reflex, gates and airbag checks in a single spawn.
- After a tool call. A stall detector notices when the assistant is going in circles.
- Session end. The window releases its own claims so a stale lease never blocks a teammate.

The core principle is fail-open: a hook that breaks never wedges the session, it just drops the hint.

The commands behind the hooks: `session-start`, `pre` (with `pre-bench` as its speed instrument), `collision-check`, `reflex-check`, `stall-check`, `session-end`.

Example: before an edit to a claimed file, the `pre` multiplexer surfaces a warning naming the terminal that holds it, then lets the edit proceed anyway.

## ru
SMA встраивается в четыре момента сессии, чтобы большая часть пользы происходила без единого Вашего слова:
- Старт сессии. Окно регистрирует себя и загружает ядро памяти.
- Перед вызовом инструмента. Один мультиплексор (`pnpm sma pre`) запускается перед каждым Edit, Write или Bash и разводит проверки коллизий, рефлексов, ворот и подушки безопасности за один запуск.
- После вызова инструмента. Детектор застревания замечает, когда ассистент ходит по кругу.
- Конец сессии. Окно снимает свои заявки, чтобы устаревшая аренда не блокировала коллегу.

Ключевой принцип это работа с открытым отказом: сломанный хук никогда не вешает сессию, он просто теряет подсказку.

Команды за хуками: `session-start`, `pre` (со спутником `pre-bench` как измерителем скорости), `collision-check`, `reflex-check`, `stall-check`, `session-end`.

Пример: перед правкой заявленного файла мультиплексор `pre` показывает предупреждение с именем терминала, который его держит, и всё равно пропускает правку.
