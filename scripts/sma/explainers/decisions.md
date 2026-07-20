# Decision corpus

The owner's real decisions, distilled into the policy the orchestrator answers with — and re-distilled as the corpus grows.

## en
The decision corpus is the collected record of calls the project owner actually made: what was approved, what was rejected, and the reasoning that came with it. Each entry is a small note captured from real work, scrubbed of secrets before it is stored.

The corpus exists so the 24/7 orchestrator can answer routine questions the way the owner would — assign, accept, or bounce work «as the founder», not like a generic agent. The policy prompt the orchestrator runs on is DERIVED from this corpus: every policy claim must cite a corpus note, and the list of decisions reserved for humans only ever grows.

The command: `pnpm sma decisions` works with this corpus — listing, checking, and preparing it for the next re-distillation cycle. Adoption of a new policy version is never automatic: it is gated by the replay exam (see `exam`).

Example: the corpus holds a note «rejected a rush push on a Friday — wait for the owner's explicit order». The distilled policy inherits the rule, and the orchestrator refuses to queue a push without that order.

## ru
Корпус решений это собранная запись реальных решений владельца проекта: что было одобрено, что отклонено и с какой мотивировкой. Каждая запись это небольшая заметка из живой работы, очищенная от секретов перед сохранением.

Корпус нужен, чтобы круглосуточный оркестратор отвечал на рутинные вопросы так, как ответил бы владелец: назначал, принимал и отклонял работу «как основатель», а не как обезличенный агент. Политика, на которой работает оркестратор, ВЫВОДИТСЯ из корпуса: каждое утверждение политики обязано ссылаться на заметку корпуса, а список решений «только человек» может лишь расти.

Команда: `pnpm sma decisions` работает с этим корпусом (просмотр, проверка и подготовка к следующему циклу пере-дистилляции). Принятие новой версии политики никогда не автоматическое: его пропускает только реплей-экзамен (см. `exam`).

Пример: в корпусе есть заметка «отклонён срочный пуш в пятницу, ждать явного распоряжения владельца». Дистиллированная политика наследует правило, и оркестратор отказывается ставить пуш в очередь без такого распоряжения.
