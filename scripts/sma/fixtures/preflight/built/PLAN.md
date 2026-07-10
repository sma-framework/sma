---
phase: preflight-fixture
plan: built
type: fixture
must_haves:
  artifacts:
    - path: scripts/sma/fixtures/preflight/built/content.txt
      contains: "MARKER_ALPHA"
    - path: scripts/sma/fixtures/preflight/built/content.txt
      contains: "MARKER_BETA"
---

# preflight fixture — BUILT

Every declared artifact path (content.txt) EXISTS and every `contains` needle is
present in it, so `sma preflight` must return the `built` verdict (code 0 → skip).
