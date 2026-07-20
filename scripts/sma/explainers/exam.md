# Replay exam

Held-out real situations replayed against the current policy — the match rate against the owner's actual decisions gates every policy adoption.

## en
The replay exam measures how well the orchestrator's policy imitates the project owner. It takes HELD-OUT historical situations — real cases whose true outcome the policy has never seen — and asks the policy to decide each one: approve, reject, escalate. The exam then compares those verdicts with what the owner really decided.

The result is a match rate. A candidate policy version is adopted only when its exam score clears the bar; a policy that would have contradicted the owner on known history never goes live. This keeps «answers like the founder» an earned, measured property instead of a marketing claim.

The command: `pnpm sma exam` builds the exam deterministically from the decision corpus (see `decisions`) and scores a policy against it. The build is reproducible — the same corpus yields the same exam — so two runs argue about facts, not sampling luck.

Example: a re-distilled policy v7 scores 14 of 16 on the exam while v6 scored 11 of 16 — v7 is adopted, and the two misses become new corpus notes for the next cycle.

## ru
Реплей-экзамен измеряет, насколько политика оркестратора имитирует владельца проекта. Он берёт ОТЛОЖЕННЫЕ исторические ситуации (реальные случаи, чей настоящий исход политика не видела) и просит политику решить каждый: одобрить, отклонить, эскалировать. Затем экзамен сравнивает эти вердикты с тем, что владелец решил на самом деле.

Результат: процент совпадений. Версия-кандидат политики принимается только когда её балл проходит планку; политика, которая противоречила бы владельцу на известной истории, никогда не выходит в работу. Так «отвечает как основатель» остаётся заработанным, измеренным свойством, а не рекламным словом.

Команда: `pnpm sma exam` детерминированно строит экзамен из корпуса решений (см. `decisions`) и оценивает политику по нему. Сборка воспроизводима: один корпус даёт один и тот же экзамен, поэтому два прогона спорят о фактах, а не о везении выборки.

Пример: пере-дистиллированная политика v7 набирает 14 из 16 против 11 из 16 у v6, поэтому принимается v7, а два промаха становятся новыми заметками корпуса на следующий цикл.
