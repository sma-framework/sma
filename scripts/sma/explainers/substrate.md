# The substrate: files and git, nothing else

Why SMA is only deterministic scripts over your repo, with no daemon or cloud.

## en
Every part of SMA is a plain script reading and writing files in your repository, coordinated through git. There is deliberately no background daemon, no database, no embedding index, no network call, and no LLM in the enforcement path.

Why this matters:
- It travels with `git clone`. The knowledge is yours, not a vendor cache that disappears.
- It is reviewable. Everything the system learns arrives as a diff you can read and revert.
- It is fail-open. If a script breaks, your work continues without the hint; nothing wedges.
- It survives absorption. A model vendor can ship memory, but not a neutral accountability layer over its own agent.

The `pnpm sma upstream-check` command watches the engine SMA is built on for updates without pulling anything automatically.

Example: the calibration ledger, the reflex rules, and the coordination claims are all files under `.sma/` and `.claude/memory/`. Delete the folder and SMA forgets; commit it and the next clone remembers.

## ru
Каждая часть SMA это обычный скрипт, который читает и пишет файлы в Вашем репозитории, а согласуется всё через git. Здесь намеренно нет фонового демона, нет базы данных, нет индекса эмбеддингов, нет сетевых вызовов и нет LLM в пути принуждения.

Почему это важно:
- Оно едет вместе с `git clone`. Знание Ваше, а не кэш поставщика, который исчезает.
- Оно проверяемо. Всё выученное приходит диффом, который можно прочитать и откатить.
- Оно не блокирует. Если скрипт ломается, работа продолжается без подсказки, ничего не вешается.
- Оно переживает поглощение. Поставщик модели может отгрузить память, но не нейтральный слой подотчётности над своим же агентом.

Команда `pnpm sma upstream-check` следит за обновлениями движка, на котором построен SMA, ничего не подтягивая автоматически.

Пример: журнал калибровки, правила рефлексов и заявки координации это всё файлы под `.sma/` и `.claude/memory/`. Удалите папку, и SMA забудет; закоммитьте её, и следующая копия вспомнит.
