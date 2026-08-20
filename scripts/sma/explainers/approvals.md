# Acceptance rules from your own history

The standing rules you already live by, read off the record of what you accepted and what you sent back — proposed, never switched on.

## en
A system that only ever asks makes you answer the same question the twentieth time exactly as you answered it the first nineteen. The answers are already on disk: the attempt ledger records every approach a worker made, and the queue records what happened to it afterwards. `node scripts/sma/cli.mjs approvals suggest` reads a standing acceptance rule out of that history instead of asking you for it again.

The reading is arithmetic, not opinion. The ledger is folded into the decisions a PERSON made, told apart by the queue's own rules: the queue repeats a failed approach by itself, and only a human sends finished work back. So a finished approach with another approach after it is a return, the last finished approach is an acceptance, and a repeat after a failure is nobody's decision at all. No model is asked anything, which is why the same history always yields the same proposal, on a machine with no network and no key.

Every number arrives with its denominator. «Approved 9 times» is unfalsifiable; «approved without a single return, 9 of 9» can be checked, and can turn out to be wrong. Below the threshold (`--min`, five decisions by default) the command refuses to propose anything at all and says how little it has, because a rule inferred from three cases is an invented number in a different outfit.

It proposes, and that is the whole of it. Switching a standing rule on stays a separate, explicit step of yours, exactly as importing somebody else's agents does. The verb writes no file, changes no config and opens no door: it prints, and says so on its last line.

Flags: `--ledger <dir>` to read a history other than the daemon's own, `--min <n>` to move the honesty threshold, `--json` for the same truth machine-readable. An empty or missing history says «no data» and exits 0.

## ru
Система, которая только спрашивает, заставляет Вас отвечать на один и тот же вопрос в двадцатый раз ровно так же, как Вы ответили в первый. Ответы уже лежат на диске: журнал попыток пишет каждый подход работника, а очередь пишет, что с ним стало дальше. Команда `node scripts/sma/cli.mjs approvals suggest` вычитывает стоячее правило приёмки из этой истории вместо того, чтобы спрашивать Вас снова.

Чтение это арифметика, а не мнение. Журнал складывается в решения, которые принял ЧЕЛОВЕК, и отличаются они по правилам самой очереди: провалившийся подход очередь повторяет сама, а вернуть завершённую работу может только человек. Значит завершённый подход, после которого пошёл ещё один, это возврат; последний завершённый подход это принятие; а повтор после провала не решение вовсе. Ни одну модель ни о чём не спрашивают, поэтому одна и та же история всегда даёт один и тот же ответ, на машине без сети и без ключа.

Каждое число приходит со своим знаменателем. «Одобрено 9 раз» опровергнуть нечем; «одобрено без возврата 9 из 9» можно проверить, и оно может оказаться неверным. Ниже порога (`--min`, по умолчанию пять решений) команда не предлагает ничего вовсе и говорит, как мало у неё данных: правило, выведенное из трёх случаев, это выдуманное число в другой одежде.

Она предлагает, и этим всё исчерпывается. Включение стоячего правила остаётся отдельным явным Вашим шагом, ровно как импорт чужих агентов. Глагол не пишет ни одного файла, не меняет настройки и не открывает дверей: он печатает, и говорит об этом последней строкой.

Флаги: `--ledger <каталог>` читать историю, отличную от собственной истории демона, `--min <n>` подвинуть порог честности, `--json` та же правда машиночитаемо. Пустая или отсутствующая история отвечает «данных нет» и кодом выхода 0.
