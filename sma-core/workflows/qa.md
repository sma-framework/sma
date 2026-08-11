<purpose>
Live QA of a running app against the phase's own success criteria. Turns each criterion into a test case, runs it, presses the phase's interactive surface, and files defects with repro steps a builder can follow. Standalone command — works whether or not the phase went through the full cycle.
</purpose>

<core_principle>
**Present in the repository ≠ works for the user**

The verifier answers "does the codebase deliver what the phase promised?" by reading. This command answers the twin question by USING the product. A file can exist, be imported, be covered by a test, and the feature still not work — that is the class that reaches a person as «search returns the wrong rows» and «the feature does not do X».

Two independent roads to one question. Neither replaces the other, and a code-only pass is never reported as a live one.
</core_principle>

<available_agent_types>
Valid SMA subagent types (use exact names — do not fall back to 'general-purpose'):
- sma-ui-qa — Runs the app, checks each success criterion, presses the surface, files defects
</available_agent_types>

<process>

## 0. Initialize

```bash
_SMA_SHIM_NAME="sma-tools.cjs"; _SMA_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; SMA_TOOLS="${_SMA_RUNTIME_ROOT}/sma-core/bin/${_SMA_SHIM_NAME}"; if [ -f "$SMA_TOOLS" ]; then sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${_SMA_RUNTIME_ROOT}/.claude/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${_SMA_RUNTIME_ROOT}/.claude/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${_SMA_RUNTIME_ROOT}/.codex/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${_SMA_RUNTIME_ROOT}/.codex/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif command -v sma-tools >/dev/null 2>&1; then SMA_TOOLS="$(command -v sma-tools)"; sma_run() { "$SMA_TOOLS" "$@"; }; elif [ -f "$HOME/.claude/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="$HOME/.claude/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; else echo "ERROR: sma-tools.cjs not found at $SMA_TOOLS and sma-tools is not on PATH. Run: npx -y sma-framework@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${SMA_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${SMA_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
INIT=$(sma_run query init.phase-op "${PHASE_ARG}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_UI_QA=$(sma_run query agent-skills sma-ui-qa)
UI_QA_MODEL=$(sma_run query resolve-model sma-ui-qa --raw)
```

Parse: `phase_dir`, `phase_number`, `phase_name`, `padded_phase`.

If no phase argument is given, QA the phase the project is currently on. If the project has no phases at all, QA still runs — the contract is then whatever the user named in `$ARGUMENTS`, and the report says so.

## 1. The plaque

Display before anything else, so a terminal session shows which reviewer holds the floor:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SMA ► QA — PHASE {N}: {name}
 the product gets used, not read
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## 2. Find the app

```bash
APP_URL=""
for p in 3000 5173 8080 4200 8000; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$p" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then APP_URL="http://localhost:$p"; break; fi
done
[ -n "$APP_URL" ] && echo "app at $APP_URL" || echo "no app is serving"
```

A URL in `$ARGUMENTS` wins over discovery.

**Existing report.** If `{phase_dir}/{padded_phase}-UI-QA.md` already exists, say so and
ask: re-run QA, or view the existing report and exit. A re-run overwrites the file — the
receipts it references stay where they are.

**If nothing answers:** print the plaque's verdict as `NOT RUN — no app is serving`, name the ports tried, and ask for the start command. Do **not** substitute a code review and present it as QA. That substitution is the exact defect this command exists to remove.

## 3. Spawn sma-ui-qa

```
◆ QA is using the app... (runs in a subagent — no output until it returns, ~2–8 min; expected, not a freeze)
```

```
Agent(
  prompt="Read $HOME/.claude/agents/sma-ui-qa.md for instructions.

<objective>
Live QA of Phase {phase_number}: {phase_name}.
Load this phase's success criteria and must-haves, turn EACH into a test case, and run
it against the app at {APP_URL}. Then press the phase's interactive surface. Report
defects with repro steps a builder can follow without asking a question.
</objective>

<files_to_read>
- {phase_dir}/*-PLAN.md (must_haves and requirement ids)
- {phase_dir}/*-SUMMARY.md (what is claimed)
- {phase_dir}/*-VERIFICATION.md (what the verifier already settled — do not repeat it)
- {phase_dir}/*-UI-SPEC.md (design contract, if it exists)
</files_to_read>

${AGENT_SKILLS_UI_QA}

<config>
phase_dir: {phase_dir}
app_url: {APP_URL}
</config>",
  subagent_type="sma-ui-qa",
  model="{UI_QA_MODEL}",
  description="QA Phase {N}"
)
```

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests while the subagent is active. Wait for it to return.

## 4. The result plaque

The agent has written `{phase_dir}/{padded_phase}-UI-QA.md` — QA's feedback lives in the
phase folder beside the planner's PLAN, the executor's SUMMARY and the verifier's
VERIFICATION, and its frontmatter (`verdict`, `criteria`, `surface`,
`returnable_defects`, `receipts`) is what an orchestrator routes on. If the file is
missing after a completed return, that is a defect in the run — say so, do not
reconstruct it from the agent's message.

On `## UI QA COMPLETE`, print:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SMA ► QA — PHASE {N}: {verdict}
 criteria   {passed} passed · {failed} failed · {blocked} blocked  (of {total})
 surface    {touched} of {total} controls pressed · {refused} refused
 receipt    {path}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then list the defects, most severe first, each with its `Returnable:` mark.

`NOT RUN` prints in the same plaque, in those words, with an empty criteria line — never a zero that reads as "nothing wrong".

## 5. Route the outcome

- **Returnable defects present** → offer to send the work back to the builder, with the defect list as the note. In a daemon-driven project that is the return door with a comment; in a terminal session it is the next `/sma-execute-phase` scoped to the failing criteria. Ask before dispatching — the machine may find the defect, but starting work is the user's call.
- **A defect already returned once** → do not offer a third attempt. Present both attempts and let the user decide; a loop that cannot end is worse than a defect that is reported.
- **Only judgment, no returnable defects** → report and stop. Judgment is advice, never a reason to dispatch rework.
- **`NOT RUN`** → the phase's status is unchanged and unclaimed. Say what is missing.

</process>

<success_criteria>
- [ ] Plaque printed before any work
- [ ] App discovered, or `NOT RUN` reported with the ports tried
- [ ] Every success criterion became a case that was RUN, or is marked BLOCKED with a reason
- [ ] Defects carry repro steps and a `Returnable:` mark
- [ ] Coverage states its denominator — controls pressed of controls present
- [ ] No code-only finding presented as a live result
</success_criteria>
