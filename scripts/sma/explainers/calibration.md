# Calibration

The ledger of promise-versus-fact, per area, that decides where oversight tightens.

## en
Calibration is the running record of how often SMA's predictions matched fact, broken down by area (domain). A prediction settles as a hit or a miss and lands in the ledger. Over many predictions, each area gets a hit rate.

Why this matters: an area where the system is often wrong earns stricter oversight; an area with a long clean record earns lighter touch. The number is honest because it is computed from settled predictions, not asserted.

When a prediction misses, a founder can record a disposition in the ledger, so a known and accepted miss does not silently block work forever.

The commands: `pnpm sma predict-score` writes verdicts, `pnpm sma calibration` reads the per-domain hit rate, `pnpm sma disposition` records a founder call, and `pnpm sma bench` / `pnpm sma arena` benchmark outcomes.

Grade the grader: a separate-context LLM verdict — the blind verifier's, or a vendor grader's if ever consumed — is itself just a claim. When such a judge says «satisfied», that word is recorded as a prediction (`pnpm sma calibration --grader-record`) and settled later against deterministic ground truth: a revert, a rework, a red CI run, or a founder rejection within its horizon. A «satisfied» that ground truth contradicts is a class-A ship-blocker that only a founder disposition clears. Every scored verdict carries the judge's model id, so the track record slices by who judged: a grader swap is as visible as a model swap. The vendor can verify; it cannot be audited — this layer is the audit.

Example: after twenty predictions in the domain sma.docs, the ledger shows 18 hits and 2 misses, a 90 percent hit rate, which the calibration passport can publish honestly.

## ru
Калибровка это текущая запись того, как часто предсказания SMA совпадали с фактом, в разбивке по областям (доменам). Предсказание сводится как попадание или промах и попадает в журнал. На многих предсказаниях у каждой области появляется процент попаданий.

Почему это важно: область, где система часто ошибается, получает более строгий надзор; область с длинной чистой историей получает более лёгкое касание. Число честное, потому что оно вычислено из сведённых предсказаний, а не заявлено.

Когда предсказание промахивается, основатель может записать в журнал распоряжение, чтобы известный и принятый промах не блокировал работу тихо и навсегда.

Команды: `pnpm sma predict-score` пишет вердикты, `pnpm sma calibration` читает процент попаданий по доменам, `pnpm sma disposition` записывает решение основателя, а `pnpm sma bench` и `pnpm sma arena` замеряют итоги.

Оценка оценщика. Вердикт языковой модели из отдельного контекста, будь то слепой проверяющий или сторонний оценщик, если он когда-либо используется, сам по себе является лишь заявлением. Когда такой судья говорит «удовлетворено», это слово записывается как прогноз (`pnpm sma calibration --grader-record`) и позже сверяется с детерминированной наземной истиной: откат, переделка, красный прогон CI или отказ основателя в пределах горизонта. Вердикт «удовлетворено», которому наземная истина противоречит, становится блокирующим релиз событием класса A, и снять его может только распоряжение основателя. Каждый оценённый вердикт несёт идентификатор модели судьи, поэтому история результатов разбивается по тому, кто судил: смена оценщика видна так же ясно, как смена модели. Поставщик может проверить, но не может быть проверен сам, и этот слой является проверкой.

Пример: после двадцати предсказаний в домене sma.docs журнал показывает 18 попаданий и 2 промаха, то есть 90 процентов, и паспорт калибровки может это честно опубликовать.
