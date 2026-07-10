---
phase: preflight-fixture
plan: absent
type: fixture
must_haves:
  artifacts:
    - path: scripts/sma/fixtures/preflight/absent/__never_built_alpha__.txt
      contains: "x"
    - path: scripts/sma/fixtures/preflight/absent/__never_built_beta__.txt
      contains: "y"
---

# preflight fixture — ABSENT

No declared artifact path exists in the tree, so `sma preflight` must return the
`absent` verdict (code 2 → execute). This is the ordinary execute case: a
well-formed must_haves block whose artifacts the tree does not yet carry. The
paths are named so they never exist anywhere, keeping the verdict stable from any
working directory.
