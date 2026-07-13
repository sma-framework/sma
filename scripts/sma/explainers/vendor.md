# Vendor-update triage ledger

Every Anthropic capability sighting becomes one triaged, append-only ledger row, kept honest by a deterministic linter and gated at release.

## en
The vendor ships faster than any single integration can amortize — tools appear and are deleted within weeks. SMA's answer is a process, not a one-off: `docs/VENDOR-LEDGER.md` is an append-only table where every Anthropic developer update becomes exactly one row.

A sighting is any capability you read about in the docs, changelog, or blog. Each row carries a verdict and a disposition:
- `CORE-threat` — the vendor is entering a lane SMA claims; this creates work.
- `BRIDGE-candidate` — worth a thin adapter behind a seam, with a self-removal tripwire.
- `ABSORB` — good idea, already fits an existing mechanism; fold it in.
- `IRRELEVANT` — does not touch SMA's problem; recorded so it is never re-argued.
- `WATCH` — not actionable yet; carries a tripwire that says when to re-check.

The disposition is a backlog id, a tripwire prediction id, or `none`. The negative verdicts are the point: an `IRRELEVANT` or `WATCH` row is what stops the same vendor feature from being re-litigated every quarter.

`sma vendor` is a reader/linter only — zero network, zero LLM. It fails any row missing a verdict or disposition; `--count untriaged` prints the bare number the `/sma-ship` gate blocks on; `--selftest` proves the linter against a fixture pair. It never writes a verdict — that judgment stays human.

## ru
Вендор выпускает возможности быстрее, чем окупается любая отдельная интеграция: инструменты появляются и удаляются за считанные недели. Ответ SMA это процесс, а не разовая задача. Файл `docs/VENDOR-LEDGER.md` это журнал, куда только добавляют строки: каждое обновление от разработчиков Anthropic превращается ровно в одну строку.

Наблюдение это любая возможность, о которой Вы прочитали в документации, списке изменений или блоге. Каждая строка несёт вердикт и распоряжение:
- `CORE-threat` вендор заходит на территорию, которую SMA считает своей; это порождает работу.
- `BRIDGE-candidate` стоит тонкого адаптера за швом, с предсказанием о собственном удалении.
- `ABSORB` хорошая идея, уже ложится на существующий механизм; включаем её.
- `IRRELEVANT` не касается задачи SMA; записано, чтобы больше не обсуждать заново.
- `WATCH` пока не требует действий; несёт предохранитель, который говорит, когда перепроверить.

Распоряжение это идентификатор из бэклога, идентификатор предсказания или слово `none`. Отрицательные вердикты и есть суть: строка `IRRELEVANT` или `WATCH` не даёт заново спорить об одной и той же возможности вендора каждый квартал.

`sma vendor` это только читатель и линтер: без сети, без модели. Он отбраковывает любую строку без вердикта или распоряжения; `--count untriaged` печатает голое число, на котором блокируется гейт `/sma-ship`; `--selftest` проверяет сам линтер на паре образцов. Он никогда не пишет вердикт сам: это суждение остаётся за человеком.
