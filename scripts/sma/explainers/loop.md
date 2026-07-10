# The accountable loop

Predict, act, score, learn: how SMA settles its own claims with a script.

## en
The accountable loop is the heart of SMA. Every plan states up front what its work will measurably change: a metric, a check command, a threshold. This is the prediction. The work is then done (act). At close, a deterministic scorer runs the check command and compares the promise against the fact (score). A miss becomes a permanent lesson, and often a reflex that warns before the next matching action (learn).

This is what turns "I told the agent" into "the agent could not miss it, and a script checked it".

The commands along the loop:
- `pnpm sma state` and `pnpm sma exec-journal` track where a plan stands.
- `pnpm sma predict-score` settles the predictions.
- `pnpm sma metrics` and `pnpm sma report` show the whole picture.

Example: a plan predicts "uncovered command count == 0". After the build, `predict-score` runs that check. If a later command shipped without a doc, the count is 1, the prediction misses, and the miss is recorded rather than quietly forgotten.

## ru
Подотчётный цикл это сердце SMA. Каждый план заранее заявляет, что его работа измеримо изменит: метрику, команду проверки, порог. Это предсказание. Затем работа выполняется (действие). На закрытии детерминированный оценщик запускает команду проверки и сравнивает обещание с фактом (оценка). Промах становится постоянным уроком, а часто и рефлексом, который предупреждает перед следующим похожим действием (обучение).

Именно это превращает «я сказал агенту» в «агент не мог промахнуться, и скрипт это проверил».

Команды вдоль цикла:
- `pnpm sma state` и `pnpm sma exec-journal` показывают, на какой стадии план.
- `pnpm sma predict-score` сводит предсказания.
- `pnpm sma metrics` и `pnpm sma report` показывают всю картину.

Пример: план предсказывает «число непокрытых команд равно 0». После сборки `predict-score` запускает эту проверку. Если более поздняя команда вышла без документации, число равно 1, предсказание промахивается, и промах записывается, а не тихо забывается.
