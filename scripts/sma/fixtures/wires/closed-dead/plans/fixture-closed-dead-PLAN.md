---
phase: wires-fixture
plan: closed-dead
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

# фикстура описи — ЗАКРЫТО, А КОДА НЕТ

У плана ЕСТЬ парная сводка. План закрыт — значит объявленной работы больше ждать неоткуда,
и отсутствие следа это находка.

Пара к соседней фикстуре без сводки: блок `must_haves` у них совпадает буква в букву, и
единственное, что разводит вердикты, — наличие файла сводки рядом.
