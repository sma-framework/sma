# Declared wires — is the plumbing your plans promised still there?

`sma wires` reads the wiring your plans declared, checks each declaration against a real tree, and says plainly what it does NOT prove.

## en
Plans declare their own plumbing: which file feeds which, through what, and by what trace in the code. Nobody ever reads those declarations back — so a wire can be cut, renamed or never built, and the declaration goes on stating it. `sma wires` reads the whole inventory and renders a deterministic verdict.

Three forms are read at once, and they are NOT of equal strength. A structured `key_links` entry (from / to / via / pattern) is weak: the pattern proves a string exists somewhere. An `artifacts` entry (path + contains) is stronger: the trace is pinned to a named file. A line written in prose has strength zero — it is counted and named, never scored, because no machine checks a sentence.

Evidence has tiers. When a declaration names a file, the trace is looked for IN that file, and being alive somewhere else does not save the record: the declaration named a place, and the work is not in it. A trace found in more files than the width limit is not evidence either, no matter where else it turned up — the limit is a declared constant, overridable with `--broad-limit`, and printed in every report.

Only closed work is judged. A plan with no summary beside it is silence, not green: reading a hole in your own evidence as a pass is leniency in tidy clothing.

The run looks ONLY inside the tree you gave it. A declared path that leads outside is neither green nor red: it gets its own named answer, counted and listed, because an existence check against whatever directories happen to sit beside your checkout would make the verdict a fact about your machine. Use `--rewrite <prefix>=<target>` to bring foreign roots home; the flag repeats, and every rule is printed in the header. The same rules can live in a file (`--rewrite-file <file>`, one `prefix=target` per line, `#` comments) so the set is written down instead of retyped — the header names which source it read, `--rewrite` on the line overrides the file, an absent file is stated rather than treated as a fault, and a malformed one stops the run at the offending line.

Red goes out one way only: a written verdict in a journal you pass with `--verdicts`, carrying an author and a reason. A verdict without them stops the run rather than quietly excusing anything.

Exit code is the verdict: 0 nothing red, 1 red without a verdict, 2 the inventory does not read at all. `--count` prints the red count as the last line, `--json` prints every category, `--selftest` runs the bundled synthetic fixtures twice and prints 1 if all of them are both correct and identical.

WHAT THIS DOES NOT PROVE, and please do not let anyone read it otherwise: a trace found in a file proves a STRING is there. It does not prove a call, it does not prove a delivery, and it does not prove that the receiver ever reads what was delivered. Only a test that watches the RECEIVER proves a wire. This command is the bookkeeping that forces such a test to exist. Historic declarations, written years ago in shapes nobody agreed on, are for a human to sort out; the command names them and never repairs them.

## ru
Планы объявляют собственную проводку: какой файл кого питает, через что и по какому следу в коде. Эти объявления никто никогда не перечитывает, поэтому провод можно перерезать, переименовать или вовсе не построить, а объявление будет продолжать его утверждать. Команда `sma wires` читает всю опись и выносит воспроизводимый вердикт.

Читаются три формы сразу, и они НЕ равны по силе. Структурная запись `key_links` (from / to / via / pattern) слабая: след доказывает лишь то, что где то в дереве есть такая строка. Запись `artifacts` (path + contains) сильнее: след привязан к названному файлу. Строка, написанная прозой, силы не имеет вовсе: её считают и называют, но не судят, потому что предложение машиной не проверяется.

У доказательства есть ярусы. Если объявление называет файл, след ищут ИМЕННО в нём, и то, что он жив где то ещё, запись не спасает: место названо, а работы в нём нет. След, встречающийся в большем числе файлов, чем порог широты, доказательством тоже не является, где бы он ещё ни нашёлся. Порог это объявленная константа, он переопределяется флагом `--broad-limit` и печатается в каждом отчёте.

Судится только закрытая работа. План, рядом с которым нет сводки, это молчание, а не зелень: считать дыру в собственных свидетельствах успехом значит проявлять мягкость под видом аккуратности.

Прогон смотрит ТОЛЬКО внутрь того дерева, которое Вы ему дали. Объявленный путь, уводящий наружу, не зелёный и не красный: у него отдельный названный ответ, он посчитан и перечислен. Иначе проверка существования попадала бы в те каталоги, которые случайно лежат рядом с Вашей рабочей копией, и вердикт стал бы фактом про Вашу машину, а не про продукт. Флаг `--rewrite <префикс>=<цель>` возвращает чужие корни домой; флаг повторяемый, и все правила печатаются в шапке отчёта.

Красное гаснет ровно одним способом: записанным вердиктом в журнале, который Вы передаёте флагом `--verdicts`, и у вердикта обязаны быть автор и обоснование. Вердикт без них останавливает прогон, а не тихо оправдывает находку.

Код выхода и есть вердикт: 0 красного нет, 1 есть красное без вердикта, 2 опись не читается вовсе. Флаг `--count` печатает число красных последней строкой, `--json` отдаёт все категории, `--selftest` прогоняет синтетические образцы дважды и печатает 1, если все они и верны, и совпали между прогонами.

ЧЕГО ЭТА КОМАНДА НЕ ДОКАЗЫВАЕТ, и пусть никто не прочитает её иначе: след, найденный в файле, доказывает наличие СТРОКИ. Он не доказывает вызова, не доказывает доставки и не доказывает, что получатель хоть раз прочитал доставленное. Провод доказывает только тест, который смотрит на ПОЛУЧАТЕЛЯ. Эта команда есть бухгалтерия, которая заставляет такой тест появиться. Исторические объявления, написанные годы назад в формах, о которых никто не договаривался, разбирает человек: команда их называет и никогда не чинит сама.
