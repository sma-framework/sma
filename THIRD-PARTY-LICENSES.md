# Third-Party Licenses

> **Scope note (license change):** SMA itself is licensed under the **SMA Source-Available License v1.0**
> (see [LICENSE](LICENSE)). The third-party components listed in this file keep
> their own original licenses (MIT), and their copyright and permission notices
> are preserved as required. These terms apply to the SMA work as a whole and
> to SMA's own code; they do not re-license the upstream MIT material.

The SMA engine is derived from gsd-core (MIT), github.com/open-gsd/gsd-core.

The pristine upstream source is `@opengsd/gsd-core@1.6.1`, available at
github.com/open-gsd/gsd-core and on the npm registry.
The working engine under `sma-core/` is a derivative of that upstream.

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

## Paperclip — code pattern + spec absorbed (9.5-03)

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

## Window bundle — MIT notices (verbatim)

The operator's window ships already built, and the build does not carry these
notices inside it (the generated window section below records exactly what it does
and does not keep). They are therefore preserved here, in the file that travels in
the same package as the bundle. Every package listed in that section is MIT, and
every one of them carries the identical MIT permission and warranty text
reproduced below; only the copyright lines differ:

    Copyright (c) Meta Platforms, Inc. and affiliates.
        — react, react-dom, scheduler

    Copyright (c) 2021-present Tanner Linsley
        — @tanstack/react-query, @tanstack/query-core

    Copyright (c) Tailwind Labs, Inc.
        — tailwindcss

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

<!-- daemon-vendored:begin -->
## Daemon vendored dependencies (generated)

These packages are vendored (shipped inside the package) so the optional daemon needs no second install; each one keeps its own LICENSE file inside `daemon/node_modules`.

| Package | Version | License |
|---|---|---|
| cron-parser | 5.6.2 | MIT |
| luxon | 3.7.2 | MIT |
| pg | 8.22.0 | MIT |
| pg-boss | 11.1.2 | MIT |
| pg-cloudflare | 1.4.0 | MIT |
| pg-connection-string | 2.14.0 | MIT |
| pg-int8 | 1.0.1 | ISC |
| pg-pool | 3.14.0 | MIT |
| pg-protocol | 1.15.0 | MIT |
| pg-types | 2.2.0 | MIT |
| pgpass | 1.0.5 | MIT |
| postgres-array | 2.0.0 | MIT |
| postgres-bytea | 1.0.1 | MIT |
| postgres-date | 1.0.7 | MIT |
| postgres-interval | 1.2.0 | MIT |
| serialize-error | 8.1.0 | MIT |
| split2 | 4.2.0 | ISC |
| type-fest | 0.20.2 | (MIT OR CC0-1.0) |
| xtend | 4.0.2 | MIT |
<!-- daemon-vendored:end -->

<!-- spa-bundle:begin -->
## Window bundle dependencies (generated)

The operator's window is built from `spa/` into `daemon/static/app` and ships inside the package already compiled, so these packages reach the adopter as bundle bytes rather than as files of their own. The list is the runtime closure of `spa/package.json`'s `dependencies` — every package whose code the bundler can reach — plus the build-time packages whose own authored output lands in the bundle. Versions and licences are read from the committed `spa/package-lock.json`, which is present in every clone; build-only tooling that leaves nothing of itself behind (vite, typescript, the `@types/*` packages) is deliberately absent.

| Package | Version | License | Ships as |
|---|---|---|---|
| @tanstack/query-core | 5.101.4 | MIT | bundled code |
| @tanstack/react-query | 5.101.4 | MIT | bundled code |
| react | 19.2.8 | MIT | bundled code |
| react-dom | 19.2.8 | MIT | bundled code |
| scheduler | 0.27.0 | MIT | bundled code |
| tailwindcss | 4.3.3 | MIT | emitted CSS |

**Copyright notices in the built bundle — measured, not assumed.** The CSS keeps its notice: `/*!`-style legal comments survive minification, so `assets/index-*.css` still carries `/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */`. The JavaScript does **not**: minification strips every `@license` banner, and `assets/index-*.js` ends up with no copyright line in it at all — React's `/** @license React */` headers included.

MIT asks for the copyright and permission notice in every copy or substantial portion, so the notices travel WITH the bundle in this file instead of inside it — see «Window bundle — MIT notices (verbatim)» above. This file is packed by `files[]`, so it reaches the adopter in the same tarball as the bundle it describes. That is a statement about a real build, not a belief about the toolchain: the test suite re-measures both halves of it against `daemon/static/app` whenever a build is on disk.
<!-- spa-bundle:end -->
