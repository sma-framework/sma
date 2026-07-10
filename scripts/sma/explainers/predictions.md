# Predictions

The frontmatter block that makes a plan's promises falsifiable and immutable.

## en
A prediction is a promise a plan makes before the work starts, written as a structured block in the plan's frontmatter: an id, a claim in plain words, a metric, a check command, a comparator and a threshold, and a horizon at which it is settled.

Two properties give predictions their teeth:
- They are falsifiable. Each names an exact command whose output a script compares against the threshold, so "done" is a number, not an opinion.
- They are immutable after planning. A lint refuses edits to a registered prediction, so you cannot move the goalposts after seeing the result.

A challenged claim that survives the grill either becomes a registered prediction or is withdrawn; it cannot stay a vague promise.

The commands: `pnpm sma grill` cross-examines a plan's claims before the build; `pnpm sma predict-score` settles them after.

Example: a plan writes `metric: uncovered_handlers_count, check_command: sma explain --coverage --count, comparator: ==, threshold: 0`. At verify, the script runs the command and the plan passes only if the real output is 0.

## ru
Предсказание это обещание, которое план даёт до начала работы, записанное структурным блоком во фронтматтере плана: идентификатор, утверждение простыми словами, метрика, команда проверки, оператор сравнения и порог, и горизонт, на котором оно сводится.

Два свойства дают предсказаниям зубы:
- Они фальсифицируемы. Каждое называет точную команду, чей вывод скрипт сравнивает с порогом, поэтому «готово» это число, а не мнение.
- Они неизменны после планирования. Линт отказывает в правке зарегистрированного предсказания, поэтому нельзя сдвинуть цель, увидев результат.

Оспоренное утверждение, пережившее грилл, либо становится зарегистрированным предсказанием, либо отзывается; оно не может остаться расплывчатым обещанием.

Команды: `pnpm sma grill` перекрёстно допрашивает утверждения плана до сборки; `pnpm sma predict-score` сводит их после.

Пример: план пишет `metric: uncovered_handlers_count, check_command: sma explain --coverage --count, comparator: ==, threshold: 0`. На проверке скрипт запускает команду, и план проходит, только если реальный вывод равен 0.
