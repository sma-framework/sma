# sma update

Check installed vs available SMA versions and update through the standard installer; everything local stays yours.

## en
`sma update` is the consumer-side updater. It reads the INSTALLED version from the stamp the installer itself copied (`.claude/sma-core/capabilities/sma/capability.json` — the same single source `package.json` is pinned to at publish time), pulls the AVAILABLE versions — the npm registry's `sma-framework@latest` plus, when a product checkout sits next to your project, that local source (clearly labeled) — and prints an honest comparison.

Honesty over cheer:
- An unreachable registry is a report line ("source unreachable"), never a crash.
- An installed version NEWER than a source (a local-source install) is stated plainly as newer — it is never phrased as a downgrade being available, and `--yes` refuses to roll back.

Dry-run by default. `node scripts/sma/cli.mjs update` only prints the report; `--yes` re-runs the ONE standard installer from the chosen source (`--source local` for the sibling checkout, default is npm). The verb writes nothing itself, so the preservation guarantees are the installer's own: `.claude/memory/**`, `.sma/` state including `profile.json`, every foreign `settings.json` key, and every user byte of CLAUDE.md survive the update.

Example: `node scripts/sma/cli.mjs update --yes`, then restart the terminal to pick up the refreshed `/sma-*` commands.

## ru
`sma update` это обновление на стороне потребителя. Команда читает УСТАНОВЛЕННУЮ версию из штампа, который скопировал сам установщик (`.claude/sma-core/capabilities/sma/capability.json`, тот же единый источник, к которому привязан `package.json` при публикации), запрашивает ДОСТУПНЫЕ версии: `sma-framework@latest` в реестре npm и, если рядом с проектом лежит checkout продукта, этот локальный источник (он помечается явно), и печатает честное сравнение.

Честность важнее бодрого тона:
- Недоступный реестр это строка отчёта («источник недоступен»), а не сбой.
- Установленная версия НОВЕЕ источника (установка из локального источника) так и называется: новее. Это никогда не подаётся как «доступен откат», и `--yes` откат не выполняет.

По умолчанию сухой прогон. `node scripts/sma/cli.mjs update` только печатает отчёт; `--yes` заново запускает ЕДИНСТВЕННЫЙ штатный установщик из выбранного источника (`--source local` для соседнего checkout, по умолчанию npm). Сама команда ничего не пишет, поэтому гарантии сохранности принадлежат установщику: `.claude/memory/**`, состояние `.sma/` вместе с `profile.json`, все чужие ключи `settings.json` и каждый Ваш байт CLAUDE.md переживают обновление.

Пример: `node scripts/sma/cli.mjs update --yes`, затем перезапустите терминал, чтобы подхватить обновлённые команды `/sma-*`.
