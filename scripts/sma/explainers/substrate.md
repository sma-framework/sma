# The substrate: files and git, nothing else

Why the core of SMA is only deterministic scripts over your repo, with no daemon or cloud.

## en
The core of SMA — memory, coordination, accountability — is plain scripts reading and writing files in your repository, coordinated through git. There is deliberately no background daemon, no database, no embedding index, no network call, and no LLM in the enforcement path.

The V5 worker fleet and its app are a separate, optional layer on top: that one does run a local daemon and keeps its queue in a local PostgreSQL, both on your own machines. Switch it off and everything described here is untouched.

Why this matters:
- It travels with `git clone`. The knowledge is yours, not a vendor cache that disappears.
- It is reviewable. Everything the system learns arrives as a diff you can read and revert.
- It is fail-open. If a script breaks, your work continues without the hint; nothing wedges.
- It survives absorption. A model vendor can ship memory, but not a neutral accountability layer over its own agent.

Example: the calibration ledger, the reflex rules, and the coordination claims are all files under `.sma/` and `.claude/memory/`. Delete the folder and SMA forgets; commit it and the next clone remembers.

## ru
Ядро SMA (память, координация, подотчётность) это обычные скрипты, которые читают и пишут файлы в Вашем репозитории, а согласуется всё через git. Здесь намеренно нет фонового демона, нет базы данных, нет индекса эмбеддингов, нет сетевых вызовов и нет LLM в пути принуждения.

Парк работников V5 и его приложение это отдельный необязательный слой сверху: он действительно поднимает локальный демон и держит очередь в локальном PostgreSQL, и то и другое на Ваших машинах. Выключите его, и всё описанное здесь не изменится.

Почему это важно:
- Оно едет вместе с `git clone`. Знание Ваше, а не кэш поставщика, который исчезает.
- Оно проверяемо. Всё выученное приходит диффом, который можно прочитать и откатить.
- Оно не блокирует. Если скрипт ломается, работа продолжается без подсказки, ничего не вешается.
- Оно переживает поглощение. Поставщик модели может отгрузить память, но не нейтральный слой подотчётности над своим же агентом.

Пример: журнал калибровки, правила рефлексов и заявки координации это всё файлы под `.sma/` и `.claude/memory/`. Удалите папку, и SMA забудет; закоммитьте её, и следующая копия вспомнит.
