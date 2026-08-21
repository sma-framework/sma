# The accountable loop

Predict, act, score, learn: how SMA settles its own claims with a script.

## en
The accountable loop is the heart of SMA. Every plan states up front what its work will measurably change: a metric, a check command, a threshold. This is the prediction. The work is then done (act). At close, a deterministic scorer runs the check command and compares the promise against the fact (score). Scoring is a gate, not a habit: a closed plan that left a checkable, already-due prediction unsettled is a critical lint finding. A miss then drafts a lesson — a **draft**, never a corpus entry behind your back — and promotion to a permanent lesson, and from there to a reflex that warns before the next matching action, is your call against the review gate printed in the draft's own header (learn).

This is what turns "I told the agent" into "the agent could not miss it, and a script checked it".

The commands along the loop:
- `node scripts/sma/cli.mjs state` and `node scripts/sma/cli.mjs exec-journal` track where a plan stands.
- `node scripts/sma/cli.mjs predict-score` settles the predictions.
- `node scripts/sma/cli.mjs metrics` and `node scripts/sma/cli.mjs report` show the whole picture.

Example: a plan predicts "uncovered command count == 0". After the build, `predict-score` runs that check. If a later command shipped without a doc, the count is 1, the prediction misses, and the miss is recorded rather than quietly forgotten.

## ru
Подотчётный цикл это сердце SMA. Каждый план заранее заявляет, что его работа измеримо изменит: метрику, команду проверки, порог. Это предсказание. Затем работа выполняется (действие). На закрытии детерминированный оценщик запускает команду проверки и сравнивает обещание с фактом (оценка). Оценка это гейт, а не привычка: закрытый план, оставивший выполнимое и уже наступившее предсказание несведённым, это критическая находка линта. Промах после этого сочиняет черновик урока, именно **черновик**, а не запись в корпусе за Вашей спиной. Повышение его до постоянного урока, а оттуда до рефлекса, который предупреждает перед следующим похожим действием, это Ваше решение по рубежу допуска, напечатанному в заголовке самого черновика (обучение).

Именно это превращает «я сказал агенту» в «агент не мог промахнуться, и скрипт это проверил».

Команды вдоль цикла:
- `node scripts/sma/cli.mjs state` и `node scripts/sma/cli.mjs exec-journal` показывают, на какой стадии план.
- `node scripts/sma/cli.mjs predict-score` сводит предсказания.
- `node scripts/sma/cli.mjs metrics` и `node scripts/sma/cli.mjs report` показывают всю картину.

Пример: план предсказывает «число непокрытых команд равно 0». После сборки `predict-score` запускает эту проверку. Если более поздняя команда вышла без документации, число равно 1, предсказание промахивается, и промах записывается, а не тихо забывается.
