# Gates

Advisory warnings, a dormant soft-deny, and kill switches: enforcement with teeth but no lock-in.

## en
Gates are checkable project rules that graduate from a request in prose to an automatic check. By default a gate is advisory: it warns and records, but does not block. For a hot file or a truly dangerous action, a soft-deny can be enabled while a fresh claim is held, and every gate carries a kill switch so you can always turn it off.

The same posture covers the trust-spine guards: budget and loop-breaking (`spend`, `spend-check`, `breaker`), the git airbag (`airbag`, `airbag-check`, `undo`) that snapshots before a risky op and restores in one action, the pre-push gate (`preship`), and the integrity guards (`integrity`, `skeptic`, `canary`, `nearmiss`) that keep the scoring honest against gaming.

An already-built preflight (`preflight`) checks a plan's claims against the real tree before an executor spawns, so nothing is rebuilt for pay.

The core principle stays fail-open: hard blocking is reserved for security and for a consequences law you opt into.

Example: `node scripts/sma/cli.mjs undo` restores the last airbag snapshot, HEAD plus dirty and untracked files, in a single reversible step.

`sma tool-gate` is the one gate that belongs to a WORKER rather than to you. It runs before a worker's tool call, classifies it against a threshold written for unattended sessions, and when the call is dangerous it does not refuse: it writes a ticket into that attempt's directory and HOLDS the call while a person looks at it. Approving continues the same session on the same call. The wait is bounded, and when the bound passes the hook itself answers a refusal, because a hook that outlives its declared timeout is cancelled by the harness and the call would otherwise run. Outside one of our attempts, with no attempt directory in its environment, it answers allow and says the gate is not configured: it lives in an account settings file shared by the whole machine and must never refuse work it was not asked about.

## ru
Ворота это проверяемые правила проекта, которые вырастают из просьбы в прозе до автоматической проверки. По умолчанию ворота совещательны: они предупреждают и записывают, но не блокируют. Для горячего файла или по-настоящему опасного действия можно включить мягкий запрет, пока держится свежая заявка, и у каждых ворот есть выключатель, чтобы их всегда можно было отключить.

Та же осанка покрывает стражей хребта доверия: бюджет и разрыв циклов (`spend`, `spend-check`, `breaker`), git-подушку (`airbag`, `airbag-check`, `undo`), которая делает снимок перед рискованной операцией и восстанавливает одним действием, ворота перед пушем (`preship`) и стражей целостности (`integrity`, `skeptic`, `canary`, `nearmiss`), которые держат оценку честной против игры с метрикой.

Предпроверка «уже построено» (`preflight`) сверяет утверждения плана с реальным деревом до запуска исполнителя, поэтому ничего не строится за плату повторно.

Ключевой принцип остаётся с открытым отказом: жёсткая блокировка остаётся за безопасностью и за законом последствий, который Вы включаете сами.

Пример: `node scripts/sma/cli.mjs undo` восстанавливает последний снимок подушки, HEAD плюс изменённые и неотслеживаемые файлы, одним обратимым шагом.

`sma tool-gate` это единственные ворота, которые принадлежат РАБОТНИКУ, а не Вам. Они срабатывают перед вызовом инструмента работником, называют его по порогу, написанному для сессий без человека за клавиатурой, и на опасном вызове не отказывают: кладут билет в каталог этой попытки и УДЕРЖИВАЮТ вызов, пока человек смотрит. Одобрение продолжает ту же сессию тем же вызовом. Ожидание ограничено, и по истечении срока хук отвечает отказом сам, потому что хук, переживший объявленный им таймаут, отменяется харнессом, и вызов иначе выполнится. Вне нашей попытки, когда каталога попытки нет в окружении, ворота отвечают «разрешено» и говорят, что не сконфигурированы: они живут в файле настроек аккаунта, общем для всей машины, и не имеют права отказывать работе, о которой их не спрашивали.
