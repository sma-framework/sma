# SMA Calibration Passport

This is the public trust-telemetry surface of SMA. It is a deterministic function of committed data: a stranger can re-derive it byte-for-byte on a fresh clone with `sma passport --verify`.

**Badge state:** hidden — no Claude model recorded yet

## Prediction calibration (all-time)

| Domain | Hit-rate | n |
| --- | --- | --- |
| **Total** | **—** | **0** |

_sma.receipts verdicts are excluded from this table and the badge — they have their own section below._

## Per-model breakdown

| Model | Hit-rate | n |
| --- | --- | --- |

Current model: `none recorded` (source: —). The badge headlines ONLY the current model's fresh window (n=0); stale priors never headline.

## Structural receipts reproduced

0/0 verified, 0 divergent, 0 skipped-unsafe, 0 errors.

## Chain anchor

Journal chain tip: `d3f16009cdde037e59c7e4a54fb23b7645c92a1b49b3f4ef77f2affe8d814125`.
This tip is pinned into each release tag as `SMA-Journal-Tip`, anchoring this snapshot to the same tamper-evidence line the release pins.

## What `--verify` proves (and what it does not)

`sma passport --verify` proves RENDER DETERMINISM: the rendered passport and badge re-derive byte-identically from the embedded snapshot on a fresh clone. It does NOT prove the underlying ledger is truthful — ledger truthfulness is owned upstream by the canary false-dones and the 5% deep audit (49.2-10). This passport reports the ledger line and corrupt counts (0 lines, 0 corrupt) and says so plainly rather than overclaiming.

Captured at: 2026-07-09T17:57:17.707Z

```sma-passport-snapshot
{
  "calibration": {
    "domains": [],
    "perModel": [],
    "totals": {
      "hits": 0,
      "misses": 0,
      "n": 0,
      "rate": null
    }
  },
  "capturedAt": "2026-07-09T17:57:17.707Z",
  "chainTip": {
    "files": [
      {
        "file": "stpa-guard.jsonl",
        "lines": 12,
        "tip": "f376ac5f265d3e5219f60dea2f90171595b34212cf6cdd7b5421e4c3b5ecec9a"
      },
      {
        "file": "t-5bffafac.jsonl",
        "lines": 1,
        "tip": "9f0474a3accf49bf463d11dd5332bfbf5f79a079ff38a43e2d3abb853c5961d8"
      }
    ],
    "tip": "d3f16009cdde037e59c7e4a54fb23b7645c92a1b49b3f4ef77f2affe8d814125"
  },
  "guard": {
    "freshN": 0,
    "lastChangeAt": null,
    "requiredN": 20,
    "status": "no-model-data"
  },
  "ledger": {
    "corrupt": 0,
    "lines": 0
  },
  "model": {
    "id": null,
    "since": null,
    "source": null
  },
  "receipts": {
    "divergent": 0,
    "errors": 0,
    "n": 0,
    "skippedUnsafe": 0,
    "verified": 0
  },
  "schema": 1
}
```
