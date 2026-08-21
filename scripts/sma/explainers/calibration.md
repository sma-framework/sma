# Calibration

The ledger of promise-versus-fact, per area, that decides where oversight tightens.

## en
Calibration is the running record of how often SMA's predictions matched fact, broken down by area (domain). A prediction settles as a hit or a miss and lands in the ledger. Over many predictions, each area gets a hit rate.

There is a third outcome, and it is deliberately not a miss: a check that never completed — killed by the runner's time budget, for instance — is recorded as **could not measure**, with the reason attached. A failure to measure you is not a statement that you were wrong, and turning one into the other would poison the ledger with misses nobody made.

Why this matters: an area where the system is often wrong earns stricter oversight; an area with a long clean record earns lighter touch. The number is honest because it is computed from settled predictions, not asserted.

When a prediction misses, a founder can record a disposition in the ledger, so a known and accepted miss does not silently block work forever.

The commands: `node scripts/sma/cli.mjs predict-score` writes verdicts, `node scripts/sma/cli.mjs calibration` reads the per-domain hit rate, `node scripts/sma/cli.mjs disposition` records a founder call, and `node scripts/sma/cli.mjs bench` / `node scripts/sma/cli.mjs arena` benchmark outcomes.

Grade the grader: a separate-context LLM verdict — the blind verifier's, or a vendor grader's if ever consumed — is itself just a claim. When such a judge says «satisfied», that word is recorded as a prediction (`node scripts/sma/cli.mjs calibration --grader-record`) and settled later against deterministic ground truth: a revert, a rework, a red CI run, or a founder rejection within its horizon. A «satisfied» that ground truth contradicts is a class-A ship-blocker that only a founder disposition clears. Every scored verdict carries the judge's model id, so the track record slices by who judged: a grader swap is as visible as a model swap. The vendor can verify; it cannot be audited — this layer is the audit.

Example: after twenty predictions in the domain sma.docs, the ledger shows 18 hits and 2 misses, a 90 percent hit rate, which the calibration passport can publish honestly.

## ru
Калибровка это текущая запись того, как часто предсказания SMA совпадали с фактом, в разбивке по областям (доменам). Предсказание сводится как попадание или промах и попадает в журнал. На многих предсказаниях у каждой области появляется процент попаданий.

Есть и третий исход, и он сознательно не является промахом: проверка, которая не завершилась (например, срезана бюджетом времени раннера), записывается как **не измерено**, с причиной рядом. «Я не смог тебя измерить» не является утверждением «ты был неправ», и превращение одного в другое отравило бы журнал промахами, которых никто не делал.

Почему это важно: область, где система часто ошибается, получает более строгий надзор; область с длинной чистой историей получает более лёгкое касание. Число честное, потому что оно вычислено из сведённых предсказаний, а не заявлено.

Когда предсказание промахивается, основатель может записать в журнал распоряжение, чтобы известный и принятый промах не блокировал работу тихо и навсегда.

Команды: `node scripts/sma/cli.mjs predict-score` пишет вердикты, `node scripts/sma/cli.mjs calibration` читает процент попаданий по доменам, `node scripts/sma/cli.mjs disposition` записывает решение основателя, а `node scripts/sma/cli.mjs bench` и `node scripts/sma/cli.mjs arena` замеряют итоги.

Оценка оценщика. Вердикт языковой модели из отдельного контекста, будь то слепой проверяющий или сторонний оценщик, если он когда-либо используется, сам по себе является лишь заявлением. Когда такой судья говорит «удовлетворено», это слово записывается как прогноз (`node scripts/sma/cli.mjs calibration --grader-record`) и позже сверяется с детерминированной наземной истиной: откат, переделка, красный прогон CI или отказ основателя в пределах горизонта. Вердикт «удовлетворено», которому наземная истина противоречит, становится блокирующим релиз событием класса A, и снять его может только распоряжение основателя. Каждый оценённый вердикт несёт идентификатор модели судьи, поэтому история результатов разбивается по тому, кто судил: смена оценщика видна так же ясно, как смена модели. Поставщик может проверить, но не может быть проверен сам, и этот слой является проверкой.

Пример: после двадцати предсказаний в домене sma.docs журнал показывает 18 попаданий и 2 промаха, то есть 90 процентов, и паспорт калибровки может это честно опубликовать.
