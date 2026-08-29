<!-- sma:loop-host
step: design
agent-roles: orchestrator
produces: DESIGN.md
consumes: PLAN.md, CONTEXT.md, RESEARCH.md
-->
<purpose>
The design stage: between the plan and the code. It draws the thing — a wireframe, or the
shape of the machinery when there are no screens — writes a short contract of checkable
points beside the drawing, has the contract checked, and hands it to a person.

Nothing is built until that contract is confirmed. This stage does not confirm anything
itself and cannot pass its own gate; it produces the artefacts the gate reads and stops.

The artefacts stay in the phase folder for good. Six months later the question "why does it
look like this" has a file to answer it, not a memory.
</purpose>

<progressive_disclosure>
Read only what the current invocation needs:

| When | Read |
|---|---|
| `mode` resolved to `wireframe` or `mixed` | `references/ui-brand.md` — the house rules a drawing must not break |
| drafting the contract | `templates/DESIGN.md` |
| checking the contract on the headless path | `agents/sma-ui-checker.md` — the measurements, applied inline |

Do not read a file until its row applies.
</progressive_disclosure>

<process>

## Shared steps (both paths)

### 1. Initialize

```bash
_SMA_SHIM_NAME="sma-tools.cjs"; _SMA_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; SMA_TOOLS="${_SMA_RUNTIME_ROOT}/sma-core/bin/${_SMA_SHIM_NAME}"; if [ -f "$SMA_TOOLS" ]; then sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${_SMA_RUNTIME_ROOT}/.claude/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${_SMA_RUNTIME_ROOT}/.claude/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${_SMA_RUNTIME_ROOT}/.codex/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${_SMA_RUNTIME_ROOT}/.codex/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif command -v sma-tools >/dev/null 2>&1; then SMA_TOOLS="$(command -v sma-tools)"; sma_run() { "$SMA_TOOLS" "$@"; }; elif [ -f "$HOME/.claude/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="$HOME/.claude/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${HERMES_HOME:-$HOME/.hermes}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CODEX_HOME:-$HOME/.codex}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; else echo "ERROR: sma-tools.cjs not found at $SMA_TOOLS and sma-tools is not on PATH. Run: npx -y sma-framework@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${SMA_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${SMA_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
INIT=$(sma_run query init.phase-op "${PHASE}"); [[ "$INIT" == @file:* ]] && INIT=$(cat "${INIT#@file:}")
```

Phase number from `$ARGUMENTS` (required). Parse the JSON for: `phase_found`, `phase_dir`,
`expected_phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `padded_phase`,
`has_context`, `has_research`, `has_plans`, `plan_count`, `commit_docs`, `response_language`.

**If `response_language` is set:** everything shown to the person is written in that
language. File paths, code, and the contract's field names stay as they are.

**If `phase_found` is false:**
```
Phase {N} not found in the roadmap.
Run /sma-progress to see the phases that exist.
```
Exit.

**If `has_plans` is false:**
```
Phase {N} has no plans yet. The design stage draws what the plans say will be built —
without them it would be drawing something else.

Run /sma-plan-phase {N} first.
```
Exit. This is the stage's own precondition, not a way around it: there is no flag and no
config key that starts the design stage without plans, and none is to be added.

### 2. Read the phase before drawing anything

Mandatory, in this order:

```bash
ls "${phase_dir}"/*-PLAN.md 2>/dev/null || true
ls "${phase_dir}"/*-CONTEXT.md "${phase_dir}"/*-RESEARCH.md 2>/dev/null || true
```

Read **every** `*-PLAN.md` in the phase folder — they say what will actually be built.
Read CONTEXT.md when it exists (the decisions already made — do not reopen them) and
RESEARCH.md when it exists (the stack the drawing has to be drawable in).

### 3. Choose the mode

Look at what the plans touch — their `files_modified` lists and the `<files>` of their tasks:

- any file a person looks at — screens, views, pages, components, styles, rendered
  templates → **`wireframe`**
- nothing a person looks at — engine, storage, queue, protocol, tooling → **`system`**
- some plans do and some do not → **`mixed`**

A phase with no screens still gets a design: the design of the machinery. It is looked at by
eye and confirmed before code exactly like a wireframe is.

Write the chosen mode into the contract's front matter.

### 4. If a contract already exists, version it before drafting

```bash
ls "${phase_dir}/${padded_phase}-DESIGN.md" 2>/dev/null || true
ls "${phase_dir}/${padded_phase}-DESIGN.v"*.md 2>/dev/null || true
```

**If the plain name exists:** archive it before writing anything new. `K` = the next free
integer after the archives already present.

```bash
git mv "${phase_dir}/${padded_phase}-DESIGN.md" "${phase_dir}/${padded_phase}-DESIGN.v${K}.md"
```

The archived name carries a dot, which is exactly why the gate cannot see it: the gate
matches the file name's ending, and `.v${K}.md` does not end in `-DESIGN.md`. The archive
stays in the folder as the trail. Then draft the new contract at the plain name with
`version` bumped by one, and say so to the person:

```
Phase {N} already had a confirmed design (version {K}).
Archived: {padded_phase}-DESIGN.v{K}.md
The new version goes through the same gate — execution waits for a fresh confirmation.
```

### 5. Choose the path

- The session has a subagent tool, and `--text` is not in `$ARGUMENTS` → **the interactive
  path** below.
- Otherwise → **the headless path** below. Fleet sessions have no subagent tool at all; a
  step that calls for one there does not fail, it hangs until somebody kills it.

Both paths produce the same artefacts and both end at the same gate. **Neither can skip the
gate**, and there is no configuration key that turns this stage or its gate off.

## Headless path (--text)

Everything happens inline, in this session. **Zero subagents are spawned here.** Where the
interactive path delegates, this path reads the same instructions and applies them itself.

### H1. Draft the sketch

**`wireframe` / `mixed`** — for each screen or state the plans introduce, write a
self-contained HTML file into the phase folder:

```
${phase_dir}/${padded_phase}-design-{name}.html
```

Inline CSS, no external stylesheet, no font fetch, no CDN, no build step. It must open from
disk. Read `references/ui-brand.md` first and stay inside it.

Then a snapshot beside it, taken with the browser driver if the machine has one:

```bash
node scripts/sma/ui-drive.mjs "file://${phase_dir}/${padded_phase}-design-{name}.html" \
  "shot:${padded_phase}-design-{name}" --no-sweep
```

Exit code 3 means NOT RUN — no driver was found and nothing was looked at. Then the HTML is
delivered without a snapshot and the contract row says, in those words,
`snapshot: not taken (no driver)`. A snapshot that was not taken is never described as if it
had been. On a clean run, copy the produced image next to its HTML as
`${padded_phase}-design-{name}.png`.

**`system`** — no sketch files. The diagram (who talks to whom, where the truth lives, which
states exist) and its half-page explanation go straight into the contract's System design
section.

### H2. Write the contract

Read `templates/DESIGN.md` and write:

```
${phase_dir}/${padded_phase}-DESIGN.md
```

The contract points are derived **from** the sketch you just drew — read it back and turn
each part of it into a statement someone can be right or wrong about. A point that the
sketch does not show is not a contract point; it is a wish, and it does not go in.

### H3. Check before the gate — inline

Read `agents/sma-ui-checker.md` and apply its measurements to the contract yourself, in this
session. Write the verdict into the front matter — `checker_verdict` plus `verdict_reasons`
verbatim.

**On `BLOCK`:** fix the sketch and the contract, then measure again. **At most two rounds.**
If it is still `BLOCK` after the second, `BLOCK` stays in the front matter with its reasons
and the contract goes to the person as it is. A person shown a laundered verdict is a person
who cannot judge; the round limit exists so the machine stops, not so the record improves.

Continue to the closing steps.

## Interactive path

The session has subagents, so the specialists do their own work.

### I1. Material for the drawing

```bash
UI_RESEARCHER_MODEL=$(sma_run query resolve-model sma-ui-researcher --raw)
AGENT_SKILLS_UI=$(sma_run query agent-skills sma-ui-researcher)
```

Spawn `sma-ui-researcher` with the phase plans, CONTEXT.md and RESEARCH.md as its reading,
asking for the material the drawing needs — patterns, references, constraints — not for the
drawing itself.

```
Agent(prompt=research_prompt, subagent_type="sma-ui-researcher", model="{UI_RESEARCHER_MODEL}",
      description="Design material Phase {N}")
```

> After calling Agent(), stop working on this task until the subagent returns.

### I2. Draw it

A canvas design tool, when the session has one, is the better hand here: the drawing is
edited by eye and the file (`${padded_phase}-design-{name}.dc.html`) lands in the phase
folder like any other sketch. Without one, the sketch is the self-contained HTML of step H1,
snapshot included.

The drawing is the designer's own job, so spawn the designer:

```bash
DESIGNER_MODEL=$(sma_run query resolve-model sma-designer --raw)
AGENT_SKILLS_DESIGNER=$(sma_run query agent-skills sma-designer)
```

Spawn `sma-designer` with the phase plans, CONTEXT.md and RESEARCH.md, the material the
researcher returned, and `references/ui-brand.md` as its reading. It draws the sketches and
derives the contract from them; it does not write `checker_verdict` — that field belongs to
the checker in the next step.

```
Agent(prompt=design_prompt, subagent_type="sma-designer", model="{DESIGNER_MODEL}",
      description="Draw Phase {N}")
```

> After calling Agent(), stop working on this task until the subagent returns.

If `sma-designer` is genuinely not installed in this session, say so plainly and draft inline
from `agents/sma-designer.md` instead — never silently substitute a different agent for it.

The contract comes back written from `templates/DESIGN.md`, its points derived from the
drawing. Movement is marked, not specified, at this stage: the `Motion` table names where
movement exists and stays empty otherwise. **An empty table is a complete answer** — the
partner for movement, `sma-animator`, joins after the contract is confirmed, not here.

### I3. Check before the gate — delegated

```bash
UI_CHECKER_MODEL=$(sma_run query resolve-model sma-ui-checker --raw)
AGENT_SKILLS_UI_CHECKER=$(sma_run query agent-skills sma-ui-checker)
```

Spawn `sma-ui-checker` with the contract and the sketch files. Write its verdict and reasons
into the contract's front matter.

```
Agent(prompt=checker_prompt, subagent_type="sma-ui-checker", model="{UI_CHECKER_MODEL}",
      description="Check design contract Phase {N}")
```

> After calling Agent(), stop working on this task until the subagent returns.

**On `BLOCK`:** fix and re-check, at most two rounds, then the honest `BLOCK` stands in the
front matter — same rule as the headless path, for the same reason.

Continue to the closing steps.

## Closing steps (both paths)

### C1. Commit the drawing and the contract

Explicit paths only — never a blanket add.

```bash
sma_run query commit "docs(${padded_phase}): design contract" --files \
  "${phase_dir}/${padded_phase}-DESIGN.md" \
  "${phase_dir}/${padded_phase}-design-"*.html "${phase_dir}/${padded_phase}-design-"*.png
```

Include the archived `${padded_phase}-DESIGN.v{K}.md` in the same commit when step 4
produced one.

**An uncommitted contract is refused by the gate, and that refusal is correct**: the gate
records what it approved by its commit, and it cannot record a file that has no commit. If
the commit is skipped for any reason, say so to the person — the stage did not finish.

### C2. Record the session

```bash
sma_run query state.record-session \
  --stopped-at "Phase ${PHASE} design contract awaiting confirmation" \
  --resume-file "${phase_dir}/${padded_phase}-DESIGN.md"
```

### C3. Hand it to the person

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SMA ► DESIGN CONTRACT READY — PHASE {N}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Mode: {wireframe / system / mixed}    Version: {K}    Checker: {PASS / FLAG / BLOCK}

Sketch:   {each file, one per line — or "none — system mode"}
Contract: {phase_dir}/{padded_phase}-DESIGN.md

Waiting for a person: confirm the design, or send it back with a comment.
Until it is confirmed, execution of phase {N} does not start.
```

The stage ends here. This workflow does not call the gate, does not confirm on anyone's
behalf, and has no way to proceed past this point. Confirmation is a separate action by a
person — on the phase card in the window, or the same action from the terminal.

If the drawing exposed a hole in the plan, that is not fixed here either: the phase goes back
to planning with the reason in words, and the plan is corrected in its own stage.

</process>

<success_criteria>
- Phase validated; the phase plans, and the context and research when they exist, were read
  before anything was drawn
- Mode chosen by what the plans touch, and written into the contract's front matter
- An existing contract was archived under a name the gate cannot see before a new version was
  drafted, and the archive stayed in the folder
- Sketch files are self-contained and live in the phase folder; a snapshot that could not be
  taken is written down as not taken
- The contract's points are derived from the sketch and are checkable statements
- The checker's verdict is in the front matter BEFORE a person is asked — a surviving BLOCK
  stays there with its reasons
- The contract and its sketch files are committed with explicit paths
- The headless path spawned no subagents
- The stage stopped at the gate: nothing was confirmed by this workflow
</success_criteria>
