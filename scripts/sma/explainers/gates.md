# Gates

Advisory warnings, a dormant soft-deny, and kill switches: enforcement with teeth but no lock-in.

## en
Gates are checkable project rules that graduate from a request in prose to an automatic check. By default a gate is advisory: it warns and records, but does not block. For a hot file or a truly dangerous action, a soft-deny can be enabled while a fresh claim is held, and every gate carries a kill switch so you can always turn it off.

The same posture covers the trust-spine guards: budget and loop-breaking (`spend`, `spend-check`, `breaker`), the git airbag (`airbag`, `airbag-check`, `undo`) that snapshots before a risky op and restores in one action, the pre-push gate (`preship`), and the integrity guards (`integrity`, `skeptic`, `canary`, `nearmiss`) that keep the scoring honest against gaming.

An already-built preflight (`preflight`) checks a plan's claims against the real tree before an executor spawns, so nothing is rebuilt for pay.

The core principle stays fail-open: hard blocking is reserved for security and for a consequences law you opt into.

Example: `pnpm sma undo` restores the last airbag snapshot, HEAD plus dirty and untracked files, in a single reversible step.

## ru
Ворота это проверяемые правила проекта, которые вырастают из просьбы в прозе до автоматической проверки. По умолчанию ворота совещательны: они предупреждают и записывают, но не блокируют. Для горячего файла или по-настоящему опасного действия можно включить мягкий запрет, пока держится свежая заявка, и у каждых ворот есть выключатель, чтобы их всегда можно было отключить.

Та же осанка покрывает стражей хребта доверия: бюджет и разрыв циклов (`spend`, `spend-check`, `breaker`), git-подушку (`airbag`, `airbag-check`, `undo`), которая делает снимок перед рискованной операцией и восстанавливает одним действием, ворота перед пушем (`preship`) и стражей целостности (`integrity`, `skeptic`, `canary`, `nearmiss`), которые держат оценку честной против игры с метрикой.

Предпроверка «уже построено» (`preflight`) сверяет утверждения плана с реальным деревом до запуска исполнителя, поэтому ничего не строится за плату повторно.

Ключевой принцип остаётся с открытым отказом: жёсткая блокировка остаётся за безопасностью и за законом последствий, который Вы включаете сами.

Пример: `pnpm sma undo` восстанавливает последний снимок подушки, HEAD плюс изменённые и неотслеживаемые файлы, одним обратимым шагом.
