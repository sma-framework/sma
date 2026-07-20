# Third-Party Licenses

> **Scope note (license change):** SMA itself is licensed under **FSL-1.1-MIT**
> (see [LICENSE](LICENSE)). The third-party components listed in this file keep
> their own original licenses (MIT), and their copyright and permission notices
> are preserved as required. The FSL terms apply to the SMA work as a whole and
> to SMA's own code; they do not re-license the upstream MIT material.

The SMA engine is derived from gsd-core (MIT), github.com/open-gsd/gsd-core.

The pristine upstream snapshot lives under `vendor/gsd-core-1.6.1/` and
`vendor/agents-1.6.1/` (source: `@opengsd/gsd-core@1.6.1`, see `UPSTREAM.json`).
The working engine under `sma-core/` is a derivative of that snapshot.

## Ideology absorbed, no code vendored (9.4-07)

The decision-ladder wording in the installer's managed CLAUDE.md rules block
(`renderRulesBlock`, "Economy ladder") is adapted from the IDEOLOGY of
DietrichGebert/ponytail (MIT) — its "does this need to exist? … only then the
minimum that works" posture. The token-economy honesty posture (measure your own
cost before you enforce a budget) is informed by juliusbrussee/caveman (MIT). No
source code from either project is vendored or copied into this repository; only
the ideas were absorbed, in our own wording, and both upstreams are MIT-licensed.
Ponytail's LLM-based `/review` delete-list mechanism is explicitly NOT adopted —
SMA's footprint receipt is deterministic `git diff --numstat` arithmetic against a
written claim, with zero LLM in the path.

## Paperclip — code pattern + spec absorbed (9.5-03, D-9.5-07)

The compare-and-set (CAS-UPDATE) checkout pattern in `daemon/src/queue/cas.mjs` is
absorbed **as a code pattern** from **Paperclip**
(github.com/paperclipai/paperclip, HEAD `3a727bf7`) — **Copyright (c) 2025
Paperclip AI, MIT License**. Two things were absorbed:

1. The **CAS-UPDATE checkout pattern** — «`UPDATE … SET status='x' WHERE id=? AND
   status='expected' RETURNING`; zero rows = lost the race, no locks» — re-expressed
   in our own code at `daemon/src/queue/cas.mjs`.
2. The **liveness contract** (their spec §8: «every non-terminal task must have a
   durable live path — a queued job, an active job with a fresh touch, or a scheduled
   retry; a background PID is NOT a live path») — used **as a specification / ТЗ
   only**, with our own implementation at `daemon/src/queue/liveness.mjs`.

No Paperclip source code is vendored: the CAS pattern is rewritten in our own
expression, and the liveness contract is implemented from its specification.

The **claim-generation hardening** (also requiring `dispatched_at` in the CAS WHERE
so a stale handler cannot roll back a newer reclaim) and the **retry-as-child-row
attempt ledger** (`daemon/src/queue/attempt-ledger.mjs`) are **Multica ideas only —
zero code copied** (Multica is mod-Apache licensed; only the ideas were absorbed, in
our own wording and implementation).

Paperclip is MIT-licensed; its copyright and permission notice are preserved:

MIT License

Copyright (c) 2025 Paperclip AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## gsd-core — MIT License (verbatim)

MIT License

Copyright (c) 2026 Open GSD

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
