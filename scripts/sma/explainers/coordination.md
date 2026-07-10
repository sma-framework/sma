# Coordination without a server

Sessions, claims, slots and the journal: how parallel terminals see each other.

## en
When you run several assistant windows against one checkout, SMA keeps them from colliding, all through files and git, with no server.
- Sessions. Each window leaves a pulse saying who it is and what it works on. `pnpm sma status` shows all active windows.
- Claims. A terminal declares "I am taking these files" (`pnpm sma claim`). Another terminal reaching for them gets a warning before the edit, naming the holder. Work is never blocked.
- Slots. A migration or release number comes from `pnpm sma next-slot`: the first terminal gets 067, the second gets 068, no race.
- The journal. Every collision is recorded so the real collision rate can be measured.

The commands: `status`, `heartbeat`, `claim`, `release`, `force-clear`, `next-slot`, `consume`, `tia`, and `worktree` for full physical isolation.

Example: two terminals both run `pnpm sma next-slot migration` at the same second and receive different numbers, so two migrations never claim the same slot.

## ru
Когда Вы запускаете несколько окон ассистента на одном рабочем дереве, SMA не даёт им столкнуться, и всё это через файлы и git, без сервера.
- Сессии. Каждое окно оставляет пульс с тем, кто оно и над чем работает. `pnpm sma status` показывает все активные окна.
- Заявки. Терминал объявляет «я беру эти файлы» (`pnpm sma claim`). Другой терминал, потянувшийся к ним, получает предупреждение перед правкой с именем держателя. Работа не блокируется.
- Слоты. Номер миграции или релиза берётся из `pnpm sma next-slot`: первый терминал получает 067, второй получает 068, без гонки.
- Журнал. Каждая коллизия записывается, чтобы можно было измерить реальную частоту коллизий.

Команды: `status`, `heartbeat`, `claim`, `release`, `force-clear`, `next-slot`, `consume`, `tia` и `worktree` для полной физической изоляции.

Пример: два терминала запускают `pnpm sma next-slot migration` в одну и ту же секунду и получают разные номера, поэтому две миграции никогда не займут один слот.
