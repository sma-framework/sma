# The calibration passport

A public, reproducible badge of SMA's real hit rate, with a model-version guard.

## en
The passport is how SMA publishes its own honesty. It builds a PASSPORT.md and a README badge from the calibration ledger: the real hit rate and the sample size, for example "SMA-calibrated: 90% hits, n=42". Anyone can rebuild it on a fresh clone and get the same number, because it is computed from settled predictions, not asserted.

The subtle part is the model-version guard. When the underlying model changes, the old hit rate no longer describes the new model, so the badge hides itself until enough new data exists (n at or above 20). That is honesty about statistics, not modesty: a badge that kept showing pre-change numbers would be quietly lying.

The commands: `pnpm sma passport --build` and `--verify` and `--check-badge`, with `pnpm sma model` tracking model-version sightings.

Example: you switch models on Tuesday. The badge disappears from the README until twenty fresh predictions accumulate, then returns with a number that actually describes the new model.

## ru
Паспорт это то, как SMA публикует собственную честность. Он строит PASSPORT.md и значок README из журнала калибровки: реальный процент попаданий и размер выборки, например «SMA-calibrated: 90% попаданий, n=42». Любой может пересобрать его на свежей копии и получить то же число, потому что оно вычислено из сведённых предсказаний, а не заявлено.

Тонкость это страж версии модели. Когда нижележащая модель меняется, старый процент попаданий больше не описывает новую модель, поэтому значок прячется, пока не накопится достаточно новых данных (n не меньше 20). Это честность в статистике, а не скромность: значок, продолжающий показывать числа до смены, тихо лгал бы.

Команды: `pnpm sma passport --build`, `--verify` и `--check-badge`, а `pnpm sma model` отслеживает замеченные версии модели.

Пример: Вы меняете модель во вторник. Значок исчезает из README, пока не наберётся двадцать свежих предсказаний, затем возвращается с числом, которое действительно описывает новую модель.
