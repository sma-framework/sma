# The statusline segment

A native status segment plus an attention pulse, over an outbound-only webhook.

## en
The statusline segment renders SMA's live state into your Claude Code status line: active sessions, collisions today, the next free slot, whether a push is in progress. It is the report at a glance, without typing a command.

Alongside it, an attention pulse marks whether a window is working or waiting for a human, so idle is derived rather than guessed. When a window has been waiting for you, an optional webhook can nudge you.

One thing is deliberate and worth stating plainly: the webhook is outbound only. SMA sends a notification out; there is no inbound path, nothing listens, nothing can be told to act from the outside.

The commands: `pnpm sma statusline render` and `install` / `uninstall` / `set-webhook`, with `pnpm sma pulse` marking working or waiting.

Example: you glance at the status line and see "2 windows, 0 collisions, next migration 072", so you start work already knowing the shared state.

## ru
Сегмент статусной строки рендерит живое состояние SMA в Вашу статусную строку Claude Code: активные сессии, коллизии за сегодня, следующий свободный слот, идёт ли пуш. Это отчёт с одного взгляда, без набора команды.

Рядом с ним пульс внимания отмечает, работает окно или ждёт человека, поэтому простой выводится, а не угадывается. Когда окно ждёт Вас, необязательный вебхук может Вас подтолкнуть.

Одно сделано намеренно и стоит сказать прямо: вебхук работает только на выход. SMA отправляет уведомление наружу; входящего пути нет, ничто не слушает, ничему нельзя велеть действовать снаружи.

Команды: `pnpm sma statusline render`, `install`, `uninstall`, `set-webhook`, а `pnpm sma pulse` отмечает работу или ожидание.

Пример: Вы бросаете взгляд на статусную строку и видите «2 окна, 0 коллизий, следующая миграция 072», поэтому начинаете работу, уже зная общее состояние.
