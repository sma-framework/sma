# sma emit

Compile the corpus into CLAUDE.md, AGENTS.md, .cursorrules and GEMINI.md via managed blocks.

## en
`sma emit` compiles your learned corpus into the instruction files other agents read: CLAUDE.md, AGENTS.md, .cursorrules, GEMINI.md. It writes only inside a managed block delimited by markers; everything you wrote outside that block is never touched.

Three properties make it safe:
- It is anti-lock-in. Your knowledge is portable to any agent, not trapped in SMA.
- It is idempotent. Re-emitting the same corpus produces a byte-identical block, so a re-run is a no-op in git.
- It is bounded. Only the managed region changes, so your hand-authored guidance is preserved exactly.

The command: `pnpm sma emit` produces all four formats from one source.

Example: you add a security lesson to the corpus and run `pnpm sma emit`. The managed block in CLAUDE.md updates; your project-specific prose above and below it stays exactly as you left it.

## ru
`sma emit` собирает Ваш выученный корпус в файлы инструкций, которые читают другие агенты: CLAUDE.md, AGENTS.md, .cursorrules, GEMINI.md. Он пишет только внутри управляемого блока, ограниченного маркерами; всё, что Вы написали вне блока, не трогается никогда.

Три свойства делают это безопасным:
- Это против вендор-лока. Ваше знание переносимо на любого агента, а не заперто в SMA.
- Это идемпотентно. Повторный выпуск того же корпуса даёт байт-идентичный блок, поэтому повторный запуск это пустая операция в git.
- Это ограничено. Меняется только управляемая область, поэтому Ваши написанные вручную указания сохраняются в точности.

Команда: `pnpm sma emit` производит все четыре формата из одного источника.

Пример: Вы добавляете урок по безопасности в корпус и запускаете `pnpm sma emit`. Управляемый блок в CLAUDE.md обновляется; Ваша проза выше и ниже него остаётся ровно такой, какой Вы её оставили.
