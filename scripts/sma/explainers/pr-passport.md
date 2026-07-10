# The PR evidence passport

The reviewer starts from evidence, not from diff archaeology.

## en
The PR evidence passport turns a range of commits into a single evidence pack for a reviewer. Instead of reconstructing what happened by reading every diff, the reviewer opens the passport and sees the claims, the predictions and their settled outcomes, the receipts, and the blind-verify verdicts for the change set.

Why this matters: review time is usually spent re-deriving intent from code. When the evidence is assembled up front, the reviewer starts from "here is what was promised and here is the script that says it held", and spends attention on judgment instead of archaeology.

It reads git and the existing ledgers only; it invents nothing and asserts nothing the loop did not already settle.

The command: `pnpm sma manifest --range <a>..<b>` with `--json`, `--md` and `--stat`.

Example: `pnpm sma manifest --range main..HEAD --md` emits a Markdown passport listing each plan's predictions, whether they hit, and the receipts, ready to paste into the PR.

## ru
Паспорт доказательств PR превращает диапазон коммитов в единый пакет доказательств для проверяющего. Вместо восстановления происходившего чтением каждого диффа проверяющий открывает паспорт и видит утверждения, предсказания и их сведённые итоги, квитанции и вердикты слепой переповерки для набора изменений.

Почему это важно: время проверки обычно уходит на повторное выведение замысла из кода. Когда доказательства собраны заранее, проверяющий начинает с «вот что обещали, и вот скрипт, который говорит, что это удержалось», и тратит внимание на суждение, а не на археологию.

Он читает только git и уже существующие журналы; он ничего не выдумывает и не заявляет ничего, чего цикл ещё не свёл.

Команда: `pnpm sma manifest --range <a>..<b>` с `--json`, `--md` и `--stat`.

Пример: `pnpm sma manifest --range main..HEAD --md` выпускает паспорт в Markdown со списком предсказаний каждого плана, попали ли они, и квитанциями, готовый вставить в PR.
