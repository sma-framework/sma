# The statusline segment

The engine's own segment in the terminal status line, plus an attention pulse over an outbound-only webhook.

## en
The statusline segment renders SMA's live state into your Claude Code status line, and the installer puts it there by default — you do not have to wire it up. Six axes, always in this order: the attention pulse of this window (`▸working`, `◆waiting-for-human`, `·idle`), the claim this window is holding, today's collision count, how much of the usage window is used up, the number of open gates, and the number of registered predictions nobody has scored yet. An axis whose value cannot be resolved prints `—`, never a made-up zero: a dash means "no reading", not "none".

Where each axis comes from: the pulse and the claim come from this window's own lease; collisions from the coordination summary; open gates and unscored predictions from the project's own files; and the usage-window percentage from the reading Claude Code pipes to the command on every render, with the percentage of your own spend against a money cap you set as the fallback underneath it.

If you already had a status line command, it is not lost. Yours runs first and its output is printed first, the SMA segment second; uninstall gives your command back byte for byte, or removes the key entirely if the install was the one that added it.

Two costs, named rather than hidden. The entry carries a 60-second refresh, because repaints driven by events only ever reach the window where the conversation is happening — so once a minute each open window spawns this command, and your own wrapped command with it. And the two expensive axes are cached: the window percentage and the open-gate count for 15 seconds, the predictions scan for 2 minutes. A number that lags a few seconds behind is the cache doing its job, not a fault.

Alongside it, the attention pulse marks whether a window is working or waiting for a human, so idle is derived rather than guessed. When a window has been waiting for you, an optional webhook can nudge you.

One thing is deliberate and worth stating plainly: the webhook is outbound only. SMA sends a notification out; there is no inbound path, nothing listens, nothing can be told to act from the outside.

The commands: `node scripts/sma/cli.mjs statusline` renders it, with `install` / `uninstall` / `set-webhook` for the managed settings entry, and `node scripts/sma/cli.mjs pulse` marking working or waiting.

Example: you glance at the status line and see `sma ▸working · claim api-routes · coll 0 · win 23% · gates 2 · preds 5`, so you start work already knowing that this window holds one claim, nobody is colliding with you, and two gates are open.

## ru
Сегмент статусной строки рендерит живое состояние SMA в Вашу статусную строку Claude Code, и установщик ставит его по умолчанию: подключать руками ничего не нужно. Шесть осей, всегда в таком порядке: пульс внимания этого окна (`▸working`, `◆waiting-for-human`, `·idle`), заявка, которую окно держит, число коллизий за сегодня, сколько израсходовано от окна использования, число открытых гейтов и число зарегистрированных предсказаний, которые ещё никто не оценил. Ось, значение которой получить не удалось, печатает прочерк, а не выдуманный ноль: прочерк значит «показания нет», а не «ничего нет».

Откуда берётся каждая ось: пульс и заявка из аренды самого этого окна; коллизии из сводки координации; открытые гейты и неоценённые предсказания из файлов самого проекта; а процент окна использования из показания, которое Claude Code подаёт команде на вход при каждом рендере, и запасным путём под ним идёт процент Вашего собственного расхода против денежного потолка, если Вы его задали.

Если у Вас уже была своя команда статусной строки, она не теряется. Ваша запускается первой, её вывод печатается первым, сегмент SMA вторым; удаление возвращает Вашу команду байт-в-байт или убирает ключ совсем, если это установка его и добавила.

Две цены названы, а не спрятаны. Запись несёт обновление раз в 60 секунд, потому что перерисовка по событию доходит только до того окна, где идёт разговор: значит, раз в минуту каждое открытое окно запускает эту команду, а вместе с ней и Вашу обёрнутую. И две дорогие оси кэшируются: процент окна и счёт открытых гейтов на 15 секунд, обход предсказаний на 2 минуты. Число, отставшее на несколько секунд, это работа кэша, а не поломка.

Рядом с ним пульс внимания отмечает, работает окно или ждёт человека, поэтому простой выводится, а не угадывается. Когда окно ждёт Вас, необязательный вебхук может Вас подтолкнуть.

Одно сделано намеренно и стоит сказать прямо: вебхук работает только на выход. SMA отправляет уведомление наружу; входящего пути нет, ничто не слушает, ничему нельзя велеть действовать снаружи.

Команды: `node scripts/sma/cli.mjs statusline` рисует сегмент, `install` / `uninstall` / `set-webhook` управляют записью в настройках, а `node scripts/sma/cli.mjs pulse` отмечает работу или ожидание.

Пример: Вы бросаете взгляд на статусную строку и видите `sma ▸working · claim api-routes · coll 0 · win 23% · gates 2 · preds 5`, поэтому начинаете работу, уже зная, что это окно держит одну заявку, с Вами никто не сталкивается, а два гейта открыты.
