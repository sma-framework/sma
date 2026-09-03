# Lane parity: what a worker can do on each provider

> An inventory, not a promise. Every cell answers YES or NO and names the command that
> re-checks that answer against this tree. A cell without a command is a word, and a word
> goes stale in silence.

The daemon starts workers on different command lines. A lane is a provider plus its CLI: today
there are two (`claude`, `codex`), tomorrow a third. The question this inventory exists to
answer: **a worker on any model must live on the same foundation as a worker on the first one**
— the same path from hand-out to acceptance, the same gates, the same ledger, the same memory.

A lane is declared as one row of the table in `daemon/src/runner/provider-adapter.mjs`.
Everything marked «asked of the table» below is read from there, and therefore cannot drift
between two places in the tree.

## How to read a cell

| Mark | Meaning |
| --- | --- |
| **YES** | It can, and the command in the right column proves it. |
| **YES, OTHERWISE** | It can, by a different road than the first lane — the road is named. |
| **NO** | It cannot. «Every NO» below says whether that is ours to fix or is a wall in somebody else's CLI. |

Every command runs from the root of the tree.

## The inventory

| # | On the task's path | Claude | codex | How to check |
| --- | --- | --- | --- | --- |
| 1 | **Spawn: the envelope's grant reaches the process** | YES — tool flags | YES, OTHERWISE — the grant collapses into a SANDBOX (`read-only` / `workspace-write`) | `node -e "import('./daemon/src/runner/provider-adapter.mjs').then(m=>console.log(m.providerAdapter('claude').argsOf({allowedTools:['Edit']}).join(' '),'||',m.providerAdapter('codex').sandboxOf(['Read','Edit','Bash'])))"` |
| 2 | **Spawn: the envelope's refusal list («this stays with the person»)** | YES — `--disallowedTools` | **NO** — `codex exec` has no flag; the lane's row does not carry the decision at all | `node -e "import('./daemon/src/runner/provider-adapter.mjs').then(m=>console.log(m.providerAdapter('codex').argsOf({disallowedTools:['WebFetch'],allowedTools:['Edit'],sandbox:'read-only'}).join(' ')))"` |
| 3 | **Refused BEFORE the spawn when the machine will not enforce the boundary** | not applicable (the boundary is flags) | YES | `npx vitest run daemon/__tests__/codex-sandbox-wire.test.ts` |
| 4 | **A copy of the project + its own branch** | YES | YES — the same verb; the lane is never asked | `grep -n "provision" daemon/src/loop.mjs \| head -3` |
| 5 | **Role and skills seeded into the session's prompt** | YES | YES — the preamble travels on both lanes | `grep -n "resolveWorkerContext" daemon/src/loop.mjs` |
| 6 | **Skills as FILES in the copy (`.claude/skills`)** | YES | **NO** — that CLI does not read such a directory; only the preamble reaches it | `grep -n "'.claude', 'skills'" daemon/src/loop.mjs` |
| 7 | **The personal layer in the account home (settings, hooks, rules)** | YES | **NO** — the mirror lands in a directory that CLI does not read, and the parking hook does not exist in its session | `grep -n "mirrorPersonalLayer(" daemon/src/loop.mjs` |
| 8 | **MCP servers** | YES — `--mcp-config` | **NO** — no flag on that CLI; the lane's row states it | `grep -n "mcpConfigPath" daemon/src/runner/provider-adapter.mjs` |
| 9 | **The handoff note (`APPROACH_NOTE`) read off the stream** | YES | YES — the frame unwrapper knows this lane's shape too | `npx vitest run daemon/__tests__/codex-sandbox-wire.test.ts -t "записка"` |
| 10 | **A lesson into memory (`LESSON_WRITTEN` / `LESSON_NONE`)** | YES | YES — same marker, same gate | `grep -n "lessonCheck" daemon/src/loop.mjs \| head -3` |
| 11 | **Attempt ledger: the whole command line and the boundary read back off it** | YES | YES — plus the sandbox and the writable roots | `npx vitest run daemon/__tests__/codex-sandbox-wire.test.ts -t "строка НА ДИСКЕ"` |
| 12 | **A correction to the LIVE turn (back into the same session)** | YES | **NO** — we have no road back into its running session | `node -e "import('./daemon/src/runner/provider-adapter.mjs').then(m=>console.log('resume:',m.providerAdapter('claude').resumesSession,m.providerAdapter('codex').resumesSession))"` |
| 13 | **The correction arrives at all** | YES — by resuming the session | YES, OTHERWISE — in the text of the next run, and it is journalled | `npx vitest run daemon/__tests__/provider-adapter-wire.test.ts -t "поправка"` |
| 14 | **The attempt's spend in the book (four numbers off the final frame)** | YES — `stream-result` | YES — `codex-final`, its own frame reader | `npx vitest run daemon/__tests__/provider-adapter-wire.test.ts -t "книг"` |
| 15 | **Subscription windows (how much is spent, when it resets)** | YES — the stream states them | **NO** — this lane's stream is silent about windows; the blindness is declared, not forgotten | `node -e "import('./daemon/src/runner/provider-adapter.mjs').then(m=>console.log('windows:',m.providerAdapter('claude').statesWindows,m.providerAdapter('codex').statesWindows))"` |
| 16 | **A filled CONTEXT window is recognised** | YES | **NO** — the compaction frame exists only on the first lane | `grep -n "compact_boundary" daemon/src/loop.mjs` |
| 17 | **The turn ceiling is computed for this work** | YES | YES — computed before the command is assembled, on both lanes | `grep -n "taskTurnCap" daemon/src/runner/build-args.mjs` |
| 18 | **The turn ceiling REACHES the process** | YES — `--max-turns` | **NO** — `codex exec` has no flag; computed and not delivered | `node -e "import('./daemon/src/runner/provider-adapter.mjs').then(m=>console.log(m.providerAdapter('codex').argsOf({maxTurns:40,sandbox:'read-only'}).join(' ')))"` |
| 19 | **«Hit the ceiling» stays different from «the worker crashed»** | YES | **NO** — a consequence of 18: no ceiling on the line and no frame about one | `grep -n "turnCapHitOf" daemon/src/loop.mjs \| head -2` |
| 20 | **The merge gate: re-verify, work shape, receipt, note** | YES | YES — the gate judges the branch and the tree, never the vendor | `grep -n "invokeVerb(.*reverify" daemon/src/loop.mjs \| head -2` |
| 21 | **Committing out of its own copy** | YES — the session commits itself | YES, OTHERWISE — on Windows the sandbox denies git's own directory, so the daemon commits from outside, by what the worker left | `node -e "import('./daemon/src/runner/provider-adapter.mjs').then(m=>console.log('deniesGitDir win32:',m.providerAdapter('claude').deniesGitDir({platform:'win32'}),m.providerAdapter('codex').deniesGitDir({platform:'win32'})))"` |
| 22 | **A task may name its lane, and the spawn knows it** | YES | YES — one list for the door and for the launch table | `npx vitest run daemon/__tests__/provider-adapter-wire.test.ts -t "таблиц"` |

## Every NO — what happens to it

**Fixed by this same work.**

- **The road a correction took was chosen by the name of the binary, not by the lane.** The
  branch compared `spec.bin` to the word `claude`. On a machine where the CLI is installed
  through npm the launch goes through the interpreter (`node <script>`) — and our own lane
  stopped recognising itself: the person's word took the third-party road (glued to the next
  run's text) and the paid live session never resumed. The lane's own property
  (`resumesSession`) is asked now. Check:
  `npx vitest run daemon/__tests__/provider-adapter-wire.test.ts -t "npm"`.

**A wall in somebody else's CLI — not ours to fix (cells 2, 8, 18, 19).** `codex exec` has no
flag for a tool list, for a refusal list, for an MCP config or for a turn ceiling. Until it
does, the honest boundary runs like this: the grant becomes a sandbox (cell 1) and everything
else is declared in the lane's row as *uncarried* — visible at a glance rather than inferred
from silence. One consequence of cell 2 deserves naming on its own: the approval wall reads the
refusal list **off the spawn's command line**, and on this lane it is empty — «nothing was
forbidden» and «there was nothing to forbid it with» look identical.

**A wall in the provider's stream (cells 15, 16).** That CLI states neither the subscription
windows nor a context overflow. The blindness is declared as `statesWindows` so it cannot be
mistaken for a forgotten place; while it stands, this lane's spend is visible in the spend book
rather than in a window.

**Ours, but not small (cells 6, 7).** Skills as files and the personal layer are written where
the first lane looks. The second needs a seeding of its own — that is a piece of work, not a line.

## The foundation for a third provider

**Branchings by lane name: 12 before, 2 now.** Counted as comparisons of the provider's name
(or of its binary's name) along the task path:

```
PAT="provider[^=]*(===|!==) 'codex'|prov (===|!==) 'codex'|isCodex|(===|!==) CLAUDE_BIN"
for f in daemon/src/loop.mjs daemon/src/runner/build-args.mjs daemon/src/runner/args.mjs; do
  printf "%-32s %s\n" "$f" "$(grep -cE "$PAT" $f)"
done
```

Before: `loop.mjs` 6, `build-args.mjs` 4, `args.mjs` 2. Now: `loop.mjs` 0, `build-args.mjs` 0,
`args.mjs` 2 — and both survivors live inside the file that owns those lane expressions (the
«the sandbox will not let it into git's own directory» predicate, and the account env assembly).

**Where the adapter's boundary runs.** The table holds the four things the order named — spawn,
stream, usage, windows — and two more without which a lane cannot be described honestly:

| Property | The question it answers |
| --- | --- |
| `bin`, `argsOf(opts)` | what starts it, and WHICH launch decisions this command line will really carry |
| `sandboxOf(allowedTools)`, `needsProvisionedSandbox` | what the envelope's grant becomes, and whether the machine must be prepared in advance |
| `finalEventOf`, `usageFromFinal`, `tokensFromFinal` | how the stream ends and how the numbers are read off it |
| `statesWindows` | whether the stream states the subscription windows |
| `resumesSession` | whether there is a road back into a running session |
| `seedsTaskHome`, `deniesGitDir` | whether the lane is minted a per-task home, and whether its session can commit for itself |

**What stayed a plan rather than a change.** Seeding the per-task home (the login, the sandbox
trace, its own temp directory) and assembling the account environment remain in
`runner/args.mjs` and `runner/build-args.mjs`: they touch the disk and throw named refusals, and
moving them together with the lane declaration would be changing two things in one motion. The
table already says WHO needs a home (`seedsTaskHome`); moving the seeding itself is the next step.

**How a third provider is added.** One row in `PROVIDER_ADAPTERS`, one entry in the queue's
`TASK_PROVIDERS` list — and cell 22 of this inventory goes red if only the second is done.
