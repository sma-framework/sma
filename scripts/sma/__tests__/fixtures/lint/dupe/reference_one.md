---
description: A reference note whose body is near-identical to a sibling note in the same corpus.
kind: reference
tags: [tech, reference]
use-when: proving the content-hash duplicate check pairs near-identical bodies
importance: 3
---

# The build heap must be raised in the build script

The Railway build runs out of memory unless the heap size is raised in the build
script itself, not only in the runtime environment.
