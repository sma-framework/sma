---
phase: wires-fixture
plan: not-built
type: fixture
must_haves:
  truths:
    - "следа нет нигде; часть объявленных путей не резолвится ни в одном корне"
  artifacts:
    - path: "tree/code.txt"
      contains: "WIRE_MARKER_NOWHERE"
    - path: "tree/never-written.txt"
      contains: "WIRE_MARKER_NOWHERE"
  key_links:
    - from: "tree/code.txt"
      to: "tree/code.txt"
      via: "связь, объявленная и никогда не построенная"
      pattern: "WIRE_MARKER_NOWHERE"
---

# фикстура описи — РАБОТА ВПЕРЕДИ

Парной сводки НЕТ. Блок `must_haves` совпадает с соседней фикстурой буква в букву, и
следа в дереве точно так же нет — но вердикт обязан быть другим.

Отсутствие сводки означает МОЛЧАНИЕ: план ещё не исполнялся, обвинять его не в чем.
Считать такую дыру в собственных доказательствах за зелень — это занижение строгости,
переодетое в аккуратность.
