---
phase: wires-fixture
plan: dead
type: fixture
must_haves:
  truths:
    - "след жив в дереве, но НЕ в том файле, который названа сама запись"
  artifacts:
    - path: "tree/code.txt"
      contains: "WIRE_MARKER_MOVED"
  key_links:
    - from: "tree/code.txt"
      to: "tree/elsewhere.txt"
      via: "источник объявлен один, а маркер переехал в соседний файл"
      pattern: "WIRE_MARKER_MOVED"
---

# фикстура описи — СЛЕД ПЕРЕЕХАЛ

У плана ЕСТЬ парная сводка: он закрыт и судим.

`WIRE_MARKER_MOVED` в дереве есть — он лежит в `tree/elsewhere.txt`. Но запись называет
источником `tree/code.txt`, где его нет. Дерево-широкий поиск назовёт такую связь живой;
сужение до названного файла — единственное, что отличает переезд от работы.
