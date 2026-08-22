# The eight hook entries

Where SMA fires automatically inside a Claude Code session.

## en
SMA wires itself into seven moments of a session, eight entries in all, so most of the value happens without you typing anything:
- Session start. The window registers itself and loads the memory core.
- Before a tool call. One multiplexer (`node scripts/sma/cli.mjs pre`) runs before every Edit, Write or Bash and dispatches the collision, reflex, gates and airbag checks in a single spawn.
- Before a subagent is spawned. `pretask-pack` injects the assembled context pack, so the subagent starts already holding the project's claims, gates and open questions. It is a second entry on the same event with its own matcher, and it matches the spawn tool under both names it has carried across agent versions: a matcher that knows only one name still installs and still fires, and does nothing at all.
- After a tool call. A stall detector notices when the assistant is going in circles.
- Session end. The window releases its own claims so a stale lease never blocks a teammate. It fires on every way a session can end: the window closed, `/clear`, a logout. Not only on a closed window.
- Before the context is compacted. `precompact-capsule` writes the flight capsule while the working state still exists, and only where your version of the agent announces that event; where it does not, the command exits without an error and without a capsule, and the entry waits installed until an upgrade makes it live.
- When a subagent stops. `subagent-verify` checks every write the subagent claimed against the real tree, and a phantom write is flagged in the journal.
- At the boundary of every turn. `turn-diff` names the files that have moved since you claimed the scope you are working in, and says whether any of them fell outside the area that claim declared. It compares two git trees and does nothing else: the check commands recorded in your summary files are never re-run here, because those arrive as data and running them on a schedule instead of on your decision is not a thing a per-turn hook may do. It releases no claim either — a turn is not an ending.

The core principle is fail-open: a hook that breaks never wedges the session, it just drops the hint. The four entries that carry no matcher carry none on purpose: those events do accept matchers (end reason, compaction trigger, subagent type), and leaving the field out is how a single entry covers every value of them.

The commands behind the hooks: `session-start`, `pre` (with `pre-bench` as its speed instrument), `collision-check`, `reflex-check`, `stall-check`, `pretask-pack`, `session-end`, `precompact-capsule`, `subagent-verify`, `turn-diff`.

Example: before an edit to a claimed file, the `pre` multiplexer surfaces a warning naming the terminal that holds it, then lets the edit proceed anyway.

## ru
SMA встраивается в семь моментов сессии, всего восемью записями, чтобы большая часть пользы происходила без единого Вашего слова:
- Старт сессии. Окно регистрирует себя и загружает ядро памяти.
- Перед вызовом инструмента. Один мультиплексор (`node scripts/sma/cli.mjs pre`) запускается перед каждым Edit, Write или Bash и разводит проверки коллизий, рефлексов, ворот и подушки безопасности за один запуск.
- Перед запуском субагента. `pretask-pack` вставляет собранный пакет контекста, чтобы субагент стартовал, уже держа в руках заявки проекта, его ворота и открытые вопросы. Это вторая запись на том же событии со своим матчером, и она ловит инструмент запуска под обоими именами, которые он носил в разных версиях агента: матчер, знающий одно имя, всё равно ставится и всё равно срабатывает, не делая при этом ровно ничего.
- После вызова инструмента. Детектор застревания замечает, когда ассистент ходит по кругу.
- Конец сессии. Окно снимает свои заявки, чтобы устаревшая аренда не блокировала коллегу. Срабатывает на любом способе завершить сессию: окно закрыли, набрали `/clear`, вышли из учётной записи. Не только на закрытии окна.
- Перед сжатием контекста. `precompact-capsule` записывает полётную капсулу, пока рабочее состояние ещё существует, и только там, где Ваша версия агента подаёт это событие; где не подаёт, команда завершается без ошибки и без капсулы, а запись ждёт установленной до обновления, которое её оживит.
- Когда субагент останавливается. `subagent-verify` сверяет каждую запись, которую субагент назвал сделанной, с реальным деревом, и фантомная запись помечается в журнале.
- На границе каждого хода. `turn-diff` называет файлы, сдвинувшиеся с момента, когда Вы взяли область работы, и говорит, не вышел ли какой-нибудь из них за пределы заявленного. Он сравнивает два дерева git и больше не делает ничего: записанные в Ваших сводках команды проверки здесь не перезапускаются никогда, потому что они приезжают как данные, а гонять их по расписанию вместо Вашего решения похуковая работа не вправе. Заявок он тоже не снимает: ход это не завершение.

Ключевой принцип это работа с открытым отказом: сломанный хук никогда не вешает сессию, он просто теряет подсказку. Четыре записи без матчера идут без него намеренно: эти события матчеры принимают (причина завершения, триггер сжатия, тип субагента), и отсутствие поля это ровно тот способ, которым одна запись покрывает все их значения.

Команды за хуками: `session-start`, `pre` (со спутником `pre-bench` как измерителем скорости), `collision-check`, `reflex-check`, `stall-check`, `pretask-pack`, `session-end`, `precompact-capsule`, `subagent-verify`, `turn-diff`.

Пример: перед правкой заявленного файла мультиплексор `pre` показывает предупреждение с именем терминала, который его держит, и всё равно пропускает правку.
