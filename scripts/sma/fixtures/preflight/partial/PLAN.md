---
phase: preflight-fixture
plan: partial
type: fixture
must_haves:
  artifacts:
    - path: scripts/sma/fixtures/preflight/partial/content.txt
      contains: "MARKER_ALPHA"
    - path: scripts/sma/fixtures/preflight/partial/content.txt
      contains: "MARKER_NEEDLE_NOT_PRESENT"
---

# preflight fixture — PARTIAL

The first artifact is satisfied (content.txt exists and contains MARKER_ALPHA).
The second names the same existing file but a `contains` needle that is
deliberately NOT present in content.txt, so `sma preflight` must return the
`partial` verdict (code 1 → reconcile-only). A present file whose needle is
absent is partial, never built.
