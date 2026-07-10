# sma context and the fragment catalog

Catalog-before-grep: a deterministic one-line card per file, and a budgeted context pack.

## en
Before an agent greps blindly, `sma context` gives it a map. The fragment catalog builds a deterministic one-line card per repo file: its symbols, its imports, its git stats. The context compiler then assembles a task-scoped pack from those cards within a token budget, and the same input always produces the same pack.

Why this matters: blind grep is slow, noisy and non-reproducible. A catalog-first pack is fast, focused and byte-deterministic, so two runs of the same task see the same context and the loop stays honest.

The commands: `pnpm sma catalog refresh` and `catalog find` build and query the cards; `pnpm sma context compile` builds a pack, with `score`, `miss` and `exam` measuring how good the pack was.

Example: `pnpm sma context compile` for a ticket about auth returns a pack of exactly the auth-relevant files and symbols, the same set every time, instead of a fresh unpredictable grep.

## ru
Прежде чем агент грепает вслепую, `sma context` даёт ему карту. Каталог фрагментов строит детерминированную карточку в одну строку на файл репозитория: её символы, её импорты, её git-статистику. Затем компилятор контекста собирает из этих карточек пакет под задачу в пределах бюджета токенов, и один и тот же вход всегда даёт один и тот же пакет.

Почему это важно: слепой греп медленный, шумный и невоспроизводимый. Пакет, собранный сначала из каталога, быстрый, сфокусированный и байт-детерминированный, поэтому два запуска одной задачи видят один контекст, и цикл остаётся честным.

Команды: `pnpm sma catalog refresh` и `catalog find` строят и опрашивают карточки; `pnpm sma context compile` собирает пакет, а `score`, `miss` и `exam` измеряют, насколько пакет был хорош.

Пример: `pnpm sma context compile` для тикета про авторизацию вернёт пакет ровно из относящихся к авторизации файлов и символов, тот же набор каждый раз, вместо свежего непредсказуемого грепа.
