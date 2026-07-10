# sma memory-preview

An ASCII graph of how SMA will lay out YOUR repository's memory, in the terminal.

## en
`sma memory-preview` turns the layered-memory theory into a picture of your own project. It reads the repository (and nothing else) and draws, right in the terminal, how the memory will split: the CORE that loads every session, the periphery areas derived from your real file tree, and the reflex candidates mined from your real git history by `excavate` — the reverts, the fix-forward chains, the typo chains your team already paid for.

Three properties:
- Read-only, zero network. The only inputs are `git ls-files`, the git log, and the `.claude/memory/` directory if one exists.
- Deterministic. The same repository at the same commit renders byte-identically — no clock, no randomness in the output.
- Graceful. A directory with no git history shows the fresh-project layout instead of crashing your onboarding.

Commands: `node scripts/sma/cli.mjs memory-preview` for the current project, `--project <path>` to preview another repository, `--lang ru` for Russian, `--json` for the raw analysis.

Example: during `/sma-start` the preview shows your `src/` split into five areas and 7 catches in the history — you see, before adopting anything, exactly what the framework would remember for you.

## ru
`sma memory-preview` превращает теорию слоёной памяти в картину Вашего собственного проекта. Он читает репозиторий (и ничего больше) и рисует прямо в терминале, как разложится память: ЯДРО, которое грузится каждую сессию, области периферии из Вашего реального дерева файлов и кандидаты в рефлексы, добытые `excavate` из Вашей реальной истории git: реверты, цепочки чинки красного CI, цепочки опечаток, за которые Ваша команда уже заплатила.

Три свойства:
- Только чтение, ноль сети. Входы: `git ls-files`, журнал git и каталог `.claude/memory/`, если он есть.
- Детерминизм. Один и тот же репозиторий на одном коммите рисуется байт-в-байт одинаково: ни часов, ни случайности в выводе.
- Мягкая деградация. Каталог без истории git показывает раскладку свежего проекта, а не роняет онбординг.

Команды: `node scripts/sma/cli.mjs memory-preview` для текущего проекта, `--project <путь>` для другого репозитория, `--lang ru` для русского вывода, `--json` для сырого анализа.

Пример: во время `/sma-start` превью показывает Ваш `src/`, разбитый на пять областей, и 7 находок в истории. Вы видите, ещё ничего не приняв, что именно фреймворк будет помнить за Вас.
