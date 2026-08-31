# sma start-map

The map of what SMA will do in YOUR project, printed before onboarding asks anything.

## en
`sma start-map` is the first screen of `/sma-start`. Before a single question, it prints five things this system will do in the repository it is standing in, and every count in it is read from that repository: how many tracked files fold into how many memory areas, how many catches (`revert` pairs, red-CI fix-forward chains, typo chains) already sit in your git history, whether a memory corpus is already here.

Why the order matters: onboarding used to open with a lecture and then roughly twenty-three questions, so a person answered «what must never break in this project» for a system they had not yet seen do anything. The map moves the first useful moment ahead of the first question — nothing is written, nothing is asked, and reading it costs one command.

Three properties, the same ones the memory preview holds:
- Read-only, zero network. The inputs are `git ls-files`, the git log, and `.claude/memory/` if it exists.
- Deterministic. The same repository at the same commit renders byte-identically: no clock, no randomness.
- Graceful. A directory with no git history shows the fresh-project map instead of crashing the onboarding.

Commands: `node scripts/sma/cli.mjs start-map` for this project, `--project <path>` for another repository, `--lang ru` for Russian, `--json` for the raw analysis, `--selftest` for the falsifiable check.

The analysis is shared with `sma memory-preview` (one `analyzeRepo`, consumed twice), so the two onboarding pictures can never disagree about the same repository.

## ru
`sma start-map` это первый экран `/sma-start`. До первого вопроса он печатает пять вещей, которые система сделает в том репозитории, где она стоит, и каждое число в этой карте прочитано из самого репозитория: сколько файлов под git сворачиваются в сколько областей памяти, сколько находок (пары с `revert`, цепочки чинки красного CI, цепочки опечаток) уже лежит в Вашей истории git, есть ли здесь корпус памяти.

Почему важен порядок: раньше онбординг открывался лекцией и примерно двадцатью тремя вопросами, и человек отвечал «что нельзя ломать в этом проекте» системе, которую ещё не видел в деле. Карта переносит первую пользу вперёд первого вопроса: ничего не записывается, ничего не спрашивается, чтение стоит одной команды.

Три свойства, те же, что у превью памяти:
- Только чтение, ноль сети. Входы: `git ls-files`, журнал git и каталог `.claude/memory/`, если он есть.
- Детерминизм. Один и тот же репозиторий на одном коммите рисуется байт-в-байт одинаково: ни часов, ни случайности.
- Мягкая деградация. Каталог без истории git показывает карту свежего проекта, а не роняет онбординг.

Команды: `node scripts/sma/cli.mjs start-map` для текущего проекта, `--project <путь>` для другого репозитория, `--lang ru` для русского вывода, `--json` для сырого разбора, `--selftest` для проверки.

Разбор общий с `sma memory-preview` (один `analyzeRepo`, использованный дважды), поэтому две картины онбординга не могут разойтись в описании одного репозитория.
