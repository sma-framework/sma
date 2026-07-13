# Receipts and blind re-verification

Structural proof that a claim is true, re-derived by a verifier that never saw the claim.

## en
A receipt is a structural record that a piece of work actually did what it said: files touched, tests run, hashes of the result. Receipts are not the agent's narration, they are facts derived from the tree and git.

The stronger move is blind re-verification: a separate verifier re-derives the outcome from the tree alone, without reading the original claim, so it cannot be talked into agreeing. If the two diverge, that divergence is the signal.

The commands:
- `pnpm sma reverify` re-checks structural receipts.
- `pnpm sma receipt-hash` emits the receipt.
- `pnpm sma chain-tip` and `pnpm sma chain-verify` pin and tamper-check the journal chain.
- `pnpm sma blind-verify` re-derives an outcome behind an information barrier.
- `pnpm sma evidence` records burden-of-proof for a risky op, and subagent work carries `pretask-pack`, `subagent-verify` and `subagent-receipts`.

Example: an executor claims "migration applied". `reverify` checks the migration file and schema state directly, so a false "done" cannot pass on the agent's word alone.

Why a receipt beats a grade: a platform outcomes grader tells you "satisfied" once, inside the vendor's walls, and you take its word. A receipt is a command anyone can re-run tomorrow. And in SMA the grader itself is graded — its verdicts are recorded, scored against ground truth (a revert, a rework, red CI, a founder rejection), and a wrong "satisfied" cannot be audited away: it blocks the release until a human dispositions it. The vendor can verify; it cannot be audited.

## ru
Квитанция это структурная запись о том, что работа действительно сделала заявленное: какие файлы затронуты, какие тесты прошли, какие хэши у результата. Квитанции это не рассказ агента, а факты, выведенные из дерева и git.

Более сильный ход это слепая переповерка: отдельный проверяющий заново выводит итог только из дерева, не читая исходное заявление, поэтому его нельзя уговорить согласиться. Если эти двое расходятся, само расхождение и есть сигнал.

Команды:
- `pnpm sma reverify` перепроверяет структурные квитанции.
- `pnpm sma receipt-hash` выпускает квитанцию.
- `pnpm sma chain-tip` и `pnpm sma chain-verify` закрепляют и проверяют на подмену цепочку журнала.
- `pnpm sma blind-verify` заново выводит итог за информационным барьером.
- `pnpm sma evidence` записывает бремя доказательства для рискованной операции, а работа субагента несёт `pretask-pack`, `subagent-verify` и `subagent-receipts`.

Пример: исполнитель заявляет «миграция применена». `reverify` проверяет файл миграции и состояние схемы напрямую, поэтому ложное «готово» не пройдёт на одном слове агента.

Почему квитанция лучше оценки: платформенный оценщик результата говорит «satisfied» один раз, внутри стен поставщика, и Вы верите ему на слово. Квитанция это команда, которую любой может перезапустить завтра. А в SMA сам оценщик тоже оценивается: его вердикты записываются, сверяются с фактом (откат, переделка, красный CI, отказ основателя), и ошибочное «satisfied» нельзя замять аудитом, оно блокирует релиз, пока решение не вынесет человек. Поставщик может проверить, но пройти аудит не может.
