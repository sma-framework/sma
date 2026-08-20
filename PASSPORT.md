# SMA Calibration Passport

This is the public trust-telemetry surface of SMA. It is a deterministic function of committed data: a stranger can re-derive it byte-for-byte on a fresh clone with `sma passport --verify`.

**Badge state:** hidden — no Claude model recorded yet

## Prediction calibration (all-time)

| Domain | Hit-rate | n |
| --- | --- | --- |
| sma.adoption | 100% | 1 |
| sma.notify | 100% | 1 |
| sma.perf | 100% | 1 |
| sma.vendor-watch | 100% | 3 |
| tech.daemon | — | 0 |
| **Total** | **100%** | **6** |

_sma.receipts verdicts are excluded from this table and the badge — they have their own section below._

## Per-model breakdown

| Model | Hit-rate | n |
| --- | --- | --- |
| legacy | 100% | 6 |

Current model: `none recorded` (source: —). The badge headlines ONLY the current model's fresh window (n=0); stale priors never headline.

## Structural receipts reproduced

10/10 verified, 0 divergent, 0 skipped-unsafe, 0 errors.

## Chain anchor

Journal chain tip: `ff8c0dc9d6f29db8b1a6b003ac822f3e00a545f8ffd37623ec9a799aa3fb4e6b`.
This tip is pinned into each release tag as `SMA-Journal-Tip`, anchoring this snapshot to the same tamper-evidence line the release pins.

## What `--verify` proves (and what it does not)

`sma passport --verify` proves RENDER DETERMINISM: the rendered passport and badge re-derive byte-identically from the embedded snapshot on a fresh clone. It does NOT prove the underlying ledger is truthful — ledger truthfulness is owned upstream by the canary false-dones and the 5% deep audit. This passport reports the ledger line and corrupt counts (18 lines, 0 corrupt) and says so plainly rather than overclaiming.

## What this passport is able to count

Every number above comes from calibration data committed to THIS repository and from nothing else: the passport counts only what this repository can reproduce. The team that develops SMA runs its own predictions in a separate, private planning workspace, and that ledger is never copied here — each of its records names the internal planning file it was made in, so publishing it would carry private planning material into a public repository. A small sample size on this page therefore means this repository holds few reproducible verdicts of its own. It never means a larger number is being hidden: the badge above is a function of exactly the data you can see.

Captured at: 2026-08-20T16:11:57.914Z

```sma-passport-snapshot
{
  "calibration": {
    "domains": [
      {
        "domain": "sma.adoption",
        "hits": 1,
        "misses": 0,
        "n": 1,
        "rate": 1
      },
      {
        "domain": "sma.notify",
        "hits": 1,
        "misses": 0,
        "n": 1,
        "rate": 1
      },
      {
        "domain": "sma.perf",
        "hits": 1,
        "misses": 0,
        "n": 1,
        "rate": 1
      },
      {
        "domain": "sma.vendor-watch",
        "hits": 3,
        "misses": 0,
        "n": 3,
        "rate": 1
      },
      {
        "domain": "tech.daemon",
        "hits": 0,
        "misses": 0,
        "n": 0,
        "rate": null
      }
    ],
    "perModel": [
      {
        "hits": 6,
        "misses": 0,
        "model": "legacy",
        "n": 6,
        "rate": 1
      }
    ],
    "totals": {
      "hits": 6,
      "misses": 0,
      "n": 6,
      "rate": 1
    }
  },
  "capturedAt": "2026-08-20T16:11:57.914Z",
  "chainTip": {
    "files": [
      {
        "file": "b-a949c530.jsonl",
        "lines": 2,
        "tip": "be613213c63b1b9470796dcfc9ae6ac3863c8cc28c777ffb9d6a6a47592ddcb7"
      },
      {
        "file": "reaper.jsonl",
        "lines": 10,
        "tip": "9dd67a40bc9eba5ba02ab3692abc88c1459b7412a4996502c64f497bd17b3ea4"
      },
      {
        "file": "roster.jsonl",
        "lines": 11,
        "tip": "2bc3b609358eb7c0287dd094291fce4d60d8ecd728324b197a8974e6c5441430"
      },
      {
        "file": "stpa-guard.jsonl",
        "lines": 341,
        "tip": "d84d2884ce775fbaaa2503e1ed42d565eac15a3d3ba42e86d81cae3beed8b5dd"
      },
      {
        "file": "t-10568.jsonl",
        "lines": 2,
        "tip": "7262fb243eb6b035436d58a2147de0d917b996b342cca53b722f446d82fecb9e"
      },
      {
        "file": "t-12092.jsonl",
        "lines": 2,
        "tip": "e99223eb434c6a103aaeabc73991646f998f4f8b3c945f6ac3eea77bfff83758"
      },
      {
        "file": "t-12548.jsonl",
        "lines": 2,
        "tip": "66b3454176bf2f19597301a30212c2fcbb5c7eda2405e869e7f9c57d676cb5ca"
      },
      {
        "file": "t-14596.jsonl",
        "lines": 2,
        "tip": "f75e08eb7cbbe929436381e0f7b8303616dbf41de209fafcd7bfcc7c1877f26a"
      },
      {
        "file": "t-15092.jsonl",
        "lines": 2,
        "tip": "ab3bc7724a0cfc9d3c6203f99cc613ffa4f1fa356851d48778d3df48709cda30"
      },
      {
        "file": "t-1768.jsonl",
        "lines": 4,
        "tip": "52212813fdc5bb5d9ef8b4d6c8a8c6eefd1d944dd461a8897e4e7d8ed98cae84"
      },
      {
        "file": "t-18672.jsonl",
        "lines": 4,
        "tip": "44fc3527712efcd4c1f70d14368ccc91d7f8c76a723155f3f0ef666434cc508c"
      },
      {
        "file": "t-19544.jsonl",
        "lines": 2,
        "tip": "e2ee78b8674d4a8df60e177d122b732040e71fcf134cbfdb58c5475a80b63e6c"
      },
      {
        "file": "t-21616.jsonl",
        "lines": 4,
        "tip": "6e749058e374ffe910d40b48e948353f3031d5793cc169a76efe58bcbee58d8d"
      },
      {
        "file": "t-23640.jsonl",
        "lines": 4,
        "tip": "f721fdd5a613e16867df2d21e388e9d88ab3a38195a770c0883356fc6cb8bdc0"
      },
      {
        "file": "t-2376.jsonl",
        "lines": 2,
        "tip": "991f3e30a174dc392c19032fe34634f270d5c75cd61594826d774f2f6b52d770"
      },
      {
        "file": "t-23932.jsonl",
        "lines": 2,
        "tip": "952a1d236080eb86939918c28884188b2b4ce821716f3c7a14a3797566e4acdb"
      },
      {
        "file": "t-24772.jsonl",
        "lines": 2,
        "tip": "d8a6dd18552292e4e18d6337e066148d595a4f6639b67a54b25cd7fbc65cfc56"
      },
      {
        "file": "t-24976.jsonl",
        "lines": 2,
        "tip": "156ea98b2fdba1a8db373943e2f10a9977df09fdd12094e3927c7a32efda9ad3"
      },
      {
        "file": "t-25528.jsonl",
        "lines": 2,
        "tip": "2cb6f29d8298cc2e827d4a82f6619a89a59d44b8ae22d800ce6b377a18997106"
      },
      {
        "file": "t-28184.jsonl",
        "lines": 2,
        "tip": "ec73549ad5012adfaca368505f411169d8e1c5fc9daf7af4780100a5cf8d5c4b"
      },
      {
        "file": "t-29180.jsonl",
        "lines": 2,
        "tip": "63f9ce06f18af5c99800893197e219a41f491441be3011db7645ee6c70d026fa"
      },
      {
        "file": "t-29616.jsonl",
        "lines": 1,
        "tip": "d507abb0c9948fc2b7a7786ad7fa7c6bbaa00d8c1c0f7cb2e65411a827d2341e"
      },
      {
        "file": "t-29732.jsonl",
        "lines": 2,
        "tip": "6299e3a01fc91d6893b282d4f99d407f930605a28bb6f5a8344311d1500f32c3"
      },
      {
        "file": "t-30752.jsonl",
        "lines": 2,
        "tip": "8fa515a78bb3fa853a1452f03009e0fc185e173d3cf45523d0762c5830a8129e"
      },
      {
        "file": "t-31456.jsonl",
        "lines": 2,
        "tip": "3abe03237c3eb7c96931d8368a76237a04446a780e9ccd042662304a7c99bd43"
      },
      {
        "file": "t-36692.jsonl",
        "lines": 2,
        "tip": "2d78915803cf657466bcc9b723e2d16c0c70bbc956d5a703a093decca629840b"
      },
      {
        "file": "t-3844.jsonl",
        "lines": 4,
        "tip": "ce3a87b369a678ba0e91a3a24f5661faf790f64660bf4beaa7f0f8777897da66"
      },
      {
        "file": "t-4224.jsonl",
        "lines": 2,
        "tip": "43f1158827a51c6e0c26249e5fb3a50d3c0aefab92ae016171d3eeacaa751abe"
      },
      {
        "file": "t-5bffafac.jsonl",
        "lines": 1,
        "tip": "9f0474a3accf49bf463d11dd5332bfbf5f79a079ff38a43e2d3abb853c5961d8"
      },
      {
        "file": "t-7296.jsonl",
        "lines": 3,
        "tip": "3744663cee887b2c276822437ac8a813fbe9bdc22518bdff2ecd62fae000dffd"
      },
      {
        "file": "t-9120.jsonl",
        "lines": 1,
        "tip": "d58d25ff123a1d1ee37d361a075e5924a82eb65e0fcf1bec968d17810d4ff5f0"
      },
      {
        "file": "write-pipeline.jsonl",
        "lines": 395,
        "tip": "089b91f90ccc006e7f34a224ff4427f330a4f6d27cc57da97565b854166fb27a"
      }
    ],
    "tip": "ff8c0dc9d6f29db8b1a6b003ac822f3e00a545f8ffd37623ec9a799aa3fb4e6b"
  },
  "guard": {
    "freshN": 0,
    "lastChangeAt": null,
    "requiredN": 20,
    "status": "no-model-data"
  },
  "ledger": {
    "corrupt": 0,
    "lines": 18
  },
  "model": {
    "id": null,
    "since": null,
    "source": null
  },
  "receipts": {
    "divergent": 0,
    "errors": 0,
    "n": 10,
    "skippedUnsafe": 0,
    "verified": 10
  },
  "schema": 1
}
```
