# Predictions

The frontmatter block that makes a plan's promises falsifiable and immutable.

## en
A prediction is a promise a plan makes before the work starts, written as a structured block in the plan's frontmatter: an id, a claim in plain words, a metric, a check command, a comparator and a threshold, and a horizon at which it is settled.

Three properties give predictions their teeth:
- They are falsifiable. Each names an exact command whose output a script compares against the threshold, so "done" is a number, not an opinion.
- They are immutable after planning. A lint refuses edits to a registered prediction, so you cannot move the goalposts after seeing the result.
- They must be settled. A closed plan that left a checkable, already-due prediction without a verdict is a critical lint finding (`PRED-UNSCORED`), so a promise cannot quietly outlive its plan. A prediction whose check the allowlist refuses is a defect of the prediction, named in words at close, and blocks nothing.

The check command must match the allowlist — SMA's own verbs run as `node scripts/sma/cli.mjs …`, `pnpm vitest run …`, or your project's own `test` / `pack` / `run <script>`. A bare `sma …` is NOT one of them: what is on your PATH is not what the ledger can vouch for. Two optional fields say how the claim is measured: `measure: exit-code` takes the process exit code as the fact instead of the numeric last line of the output, and `cwd` names the directory the command runs in. Both are fields handed to the runner, never text glued into the command — `cd X && cmd` and `cmd; echo $?` stay refused.

A challenged claim that survives the grill either becomes a registered prediction or is withdrawn; it cannot stay a vague promise.

The commands: `node scripts/sma/cli.mjs grill` cross-examines a plan's claims before the build; `node scripts/sma/cli.mjs predict-score` settles them after.

Example: a plan writes `metric: uncovered_command_count`, `check_command: node scripts/sma/cli.mjs explain --coverage --count`, `comparator: ==`, `threshold: 0`. At verify, the script runs the command and the plan passes only if the real output is 0.

## ru
Предсказание это обещание, которое план даёт до начала работы, записанное структурным блоком во фронтматтере плана: идентификатор, утверждение простыми словами, метрика, команда проверки, оператор сравнения и порог, и горизонт, на котором оно сводится.

Три свойства дают предсказаниям зубы:
- Они фальсифицируемы. Каждое называет точную команду, чей вывод скрипт сравнивает с порогом, поэтому «готово» это число, а не мнение.
- Они неизменны после планирования. Линт отказывает в правке зарегистрированного предсказания, поэтому нельзя сдвинуть цель, увидев результат.
- Их обязаны свести. Закрытый план, оставивший выполнимое и уже наступившее предсказание без вердикта, — критическая находка линта (`PRED-UNSCORED`), поэтому обещание не может тихо пережить свой план. Предсказание, чью проверку список разрешённых форм отвергает, — дефект самого предсказания: он называется при закрытии словами и не блокирует ничего.

Команда проверки обязана попасть в список разрешённых форм: собственные вербы SMA в виде `node scripts/sma/cli.mjs …`, `pnpm vitest run …` или собственные `test` / `pack` / `run <скрипт>` Вашего проекта. Голое `sma …` в этот список НЕ входит: то, что лежит у Вас в PATH, — не то, за что может поручиться журнал. Два необязательных поля говорят, КАК измеряется утверждение: `measure: exit-code` берёт фактом код выхода процесса вместо числовой последней строки вывода, а `cwd` называет каталог, в котором команда запускается. Оба — поля, которые едут раннеру, а не текст, вклеенный в команду: `cd X && cmd` и `cmd; echo $?` остаются отвергнутыми.

Оспоренное утверждение, пережившее грилл, либо становится зарегистрированным предсказанием, либо отзывается; оно не может остаться расплывчатым обещанием.

Команды: `node scripts/sma/cli.mjs grill` перекрёстно допрашивает утверждения плана до сборки; `node scripts/sma/cli.mjs predict-score` сводит их после.

Пример: план пишет `metric: uncovered_command_count`, `check_command: node scripts/sma/cli.mjs explain --coverage --count`, `comparator: ==`, `threshold: 0`. На проверке скрипт запускает команду, и план проходит, только если реальный вывод равен 0.
