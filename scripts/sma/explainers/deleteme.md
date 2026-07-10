# sma deleteme

Remove SMA from a project in one action; the memory corpus stays yours.

## en
`sma deleteme` is the off-ramp. One command reverses everything the installer wrote: the engine under `.claude/sma-core`, the runtime at `scripts/sma`, the `/sma-*` command skills, the sma agents, the hooks in `.claude/settings.json`, the statusline segment (your original statusline is restored verbatim), the managed blocks in CLAUDE.md / AGENTS.md / .cursorrules / GEMINI.md, and the `.sma/` state directory.

What it never touches: `.claude/memory/**`. The lessons your project learned are your asset, not the framework's — they survive removal and keep working as plain markdown any tool can read.

It is safe by construction:
- Dry-run by default. `node scripts/sma/cli.mjs deleteme` only PRINTS the removal plan; nothing changes until you add `--yes`.
- Never-clobber. Only SMA hook entries and the statusLine key are edited in settings.json; every other key survives. Only managed-block spans are cut from instruction files; a torn anchor pair is refused, not repaired.
- Honest per action. A locked file reports an error for that one action; the rest proceed.

Example: `node scripts/sma/cli.mjs deleteme --yes`, restart the terminal — no `/sma-*` commands remain, and `.claude/memory/` is exactly where you left it.

## ru
`sma deleteme` это выход. Одна команда отменяет всё, что записал инсталлер: движок в `.claude/sma-core`, рантайм в `scripts/sma`, команды `/sma-*`, агентов sma, хуки в `.claude/settings.json`, сегмент statusline (Ваша исходная строка восстанавливается дословно), managed-блоки в CLAUDE.md / AGENTS.md / .cursorrules / GEMINI.md и каталог состояния `.sma/`.

Что не трогается никогда: `.claude/memory/**`. Уроки, которые выучил Ваш проект, это Ваш актив, а не актив фреймворка. Они переживают удаление и продолжают работать как обычный markdown, который читает любой инструмент.

Это безопасно по построению:
- По умолчанию сухой прогон. `node scripts/sma/cli.mjs deleteme` только ПЕЧАТАЕТ план удаления; ничего не меняется, пока Вы не добавите `--yes`.
- Никогда не задевает чужое. В settings.json правятся только записи хуков SMA и ключ statusLine; все остальные ключи сохраняются. Из файлов инструкций вырезаются только managed-блоки; разорванная пара маркеров отклоняется, а не чинится.
- Честность по каждому действию. Заблокированный файл даёт ошибку только по этому действию; остальные выполняются.

Пример: `node scripts/sma/cli.mjs deleteme --yes`, перезапуск терминала. Команд `/sma-*` больше нет, а `.claude/memory/` ровно там, где Вы его оставили.
