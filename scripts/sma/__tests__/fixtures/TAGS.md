# TAGS — the closed facet vocabulary of the memory corpus

> **This is the authority-control registry (B3).** A tag that is not in this file
> is a LINT ERROR. A new tag appears only by editing this file in the SAME commit
> as its first use — that is how the vocabulary stays closed while several
> terminals work in parallel.
>
> **Parallel additions resolve as a plain git merge** (SPEC edge: concurrency R1):
> two terminals each add a line, the merge keeps both, the linter re-checks the
> registry after the merge. The registry is an ordinary committed file — not a
> database, not a counter.
>
> **Facets (B1, Ranganathan / Z39.19):** a note carries one tag from `area` and
> one from `kind`, plus an optional open `phase:NN`. Retrieval is facet
> intersection (for example «tech + decision»).
>
> **Synonyms (B2, ANSI/NISO Z39.19 USE/UF):** each canonical tag may carry
> `· aliases: a, b` — the UF (Used For) forms. The loader and the linter resolve
> an alias to its canon (USE) before comparing, which removes synonym drift.
>
> **Line grammar (machine-readable, strict):** under a `## <facet>` heading, one
> line per tag:
> `- <tag> — <one-line description> · aliases: <a>, <b>`
> The `· aliases:` part is optional. The ` — ` separator between tag and
> description and the ` · aliases: ` separator are structural — the parser
> (loadTagsRegistry) consumes them.

## area

- crm — internal back-office screens: records, accounts, pipelines, boards.
- content — public content and customer-facing copy.
- tech — infrastructure, builds, types, migrations, general engineering.
- governance — rules, decisions, definition of done, audits, sources of truth.
- os — the operating framework: backlog, tracker, operations map, task rhythm. · aliases: framework, internal-framework
- payload — the CMS data layer: collections, hooks, server API, access, fields. · aliases: cms
- railway — the deploy host: builds, environment variables, limits. · aliases: hosting, deploy
- messaging — outbound and inbound channels: push, SMS, email, the shared inbox. · aliases: sms, push, inbox, channel, comm
- memory — the memory system: notes, index, tags, hygiene, SMA. · aliases: sma, notes
- security — security: access control, webhooks, secrets, regression guards. · aliases: sec, rbac
- phi — regulated personal data: encryption, privacy handling, GDPR. · aliases: privacy, gdpr
- seo — search visibility: schemas, indexing, structured data. · aliases: geo
- design — visual design, brand, UI tokens, the design source of truth. · aliases: ui, brand
- workflow — the working process: planning, execution, verification, phases. · aliases: gsd, process
- release — versions and releases: tags, changelog, the push gate. · aliases: version
- finance — billing, invoices, per-account settlements, reports. · aliases: billing
- agents — AI agents and orchestration: prompts, routing, the command center. · aliases: ai, orchestrator
- testing — tests, fixtures, the test runner, type checks, quality gates. · aliases: tests, ci

## kind

- procedural-rule — a how-to rule: a standing instruction that always applies. · aliases: rule, feedback-rule
- decision — a recorded decision with its rationale and date. · aliases: decision-record
- episodic — an episode: what happened in one session, an incident, an outcome. · aliases: episode, log
- status — current state: what is live, what is done, what is flagged, what blocks. · aliases: state
- reference — a lookup: addresses, versions, key facts, mapping tables. · aliases: ref, lookup
- bug-lesson — a lesson from a bug: a feedback note with the **Why:** + **How to apply:** structure. · aliases: lesson, gotcha

## phase

- Open facet: `phase:NN` — an optional tag binding a note to a phase number
  (for example `phase:12`). Free-form value `phase:<number>`; individual tags are
  not enumerated here.
