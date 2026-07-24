<purpose>
Analyze freeform text from the user and route to the most appropriate SMA command. This is a dispatcher — it never does the work itself. Match user intent to the best command, confirm the routing, and hand off.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

```bash
_SMA_SHIM_NAME="sma-tools.cjs"; _SMA_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; SMA_TOOLS="${_SMA_RUNTIME_ROOT}/sma-core/bin/${_SMA_SHIM_NAME}"; if [ -f "$SMA_TOOLS" ]; then sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${_SMA_RUNTIME_ROOT}/.claude/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${_SMA_RUNTIME_ROOT}/.claude/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${_SMA_RUNTIME_ROOT}/.codex/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${_SMA_RUNTIME_ROOT}/.codex/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif command -v sma-tools >/dev/null 2>&1; then SMA_TOOLS="$(command -v sma-tools)"; sma_run() { "$SMA_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${HERMES_HOME:-$HOME/.hermes}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CODEX_HOME:-$HOME/.codex}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; else echo "ERROR: sma-tools.cjs not found at $SMA_TOOLS and sma-tools is not on PATH. Run: npx -y sma-framework@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${SMA_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${SMA_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(sma_run query config-get response_language --default "" 2>/dev/null || echo "")
```

**If `response_language` is set:** All user-facing questions, prompts, and explanations in this workflow MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

<step name="validate">
**Check for input.**


**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
If `$ARGUMENTS` is empty, ask via AskUserQuestion:

```
What would you like to do? Describe the task, bug, or idea and I'll route it to the right SMA command.
```

Wait for response before continuing.
</step>

<step name="check_project">
**Check if project exists.**

```bash
INIT=$(sma_run query state.load 2>/dev/null)
```

Track whether `.planning/` exists — some routes require it, others don't.
</step>

<step name="route">
**Match intent to command.**

Evaluate `$ARGUMENTS` against these routing rules. Apply the **first matching** rule:

| If the text describes... | Route to | Why |
|--------------------------|----------|-----|
| Starting a new greenfield project, "set up", "initialize" | `/sma:new-project` | Needs full project initialization |
| First-time setup for an existing codebase, brownfield onboarding | `/sma:onboard` | Safe map → docs ingest → project setup sequence |
| Mapping or analyzing an existing codebase map | `/sma:map-codebase` | Codebase discovery or refresh |
| A bug, error, crash, failure, or something broken | `/sma:debug` | Needs systematic investigation |
| Spiking, "test if", "will this work", "experiment", "prove this out", validate feasibility | `/sma:spike` | Throwaway experiment to validate feasibility |
| Sketching, "mockup", "what would this look like", "prototype the UI", "design this", explore visual direction | `/sma:sketch` | Throwaway HTML mockups to explore design |
| Wrapping up spikes, "package the spikes", "consolidate spike findings" | `/sma:spike --wrap-up` | Package spike findings into reusable skill |
| Wrapping up sketches, "package the designs", "consolidate sketch findings" | `/sma:sketch --wrap-up` | Package sketch findings into reusable skill |
| Exploring, researching, comparing, or "how does X work" | `/sma:explore` | Socratic ideation and idea routing |
| Discussing vision, "how should X look", brainstorming | `/sma:discuss-phase` | Needs context gathering |
| A complex task: refactoring, migration, multi-file architecture, system redesign | `/sma:phase` | Needs a full phase with plan/build cycle |
| Planning a specific phase or "plan phase N" | `/sma:plan-phase` | Direct planning request |
| Executing a phase or "build phase N", "run phase N" | `/sma:execute-phase` | Direct execution request |
| Running all remaining phases automatically | `/sma:autonomous` | Full autonomous execution |
| A review or quality concern about existing work | `/sma:verify-work` | Needs verification |
| Checking progress, status, "where am I" | `/sma:progress` | Status check |
| Resuming work, "pick up where I left off" | `/sma:resume-work` | Session restoration |
| A note, idea, or "remember to..." | `/sma:capture` | Capture for later |
| Adding tests, "write tests", "test coverage" | `/sma:add-tests` | Test generation |
| Completing a milestone, shipping, releasing | `/sma:complete-milestone` | Milestone lifecycle |
| A specific, actionable, small task (add feature, fix typo, update config) | `/sma:quick` | Self-contained, single executor |

**Requires `.planning/` directory:** All routes except `/sma:new-project`, `/sma:onboard`, `/sma:map-codebase`, `/sma:spike`, `/sma:sketch`, and `/sma:help`. If the project doesn't exist and the route requires it, suggest `/sma:onboard` for existing codebases or `/sma:new-project` for greenfield projects.

**Ambiguity handling:** If the text could reasonably match multiple routes, ask the user via AskUserQuestion with the top 2-3 options. For example:

```
"Refactor the authentication system" could be:
1. /sma:phase — Full planning cycle (recommended for multi-file refactors)
2. /sma:quick — Quick execution (if scope is small and clear)

Which approach fits better?
```
</step>

<step name="display">
**Show the routing decision.**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SMA ► ROUTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Input:** {first 80 chars of $ARGUMENTS}
**Routing to:** {chosen command}
**Reason:** {one-line explanation}
```
</step>

<step name="dispatch">
**Invoke the chosen command.**

Run the selected `/sma-*` command, passing `$ARGUMENTS` as args.

If the chosen command expects a phase number and one wasn't provided in the text, extract it from context or ask via AskUserQuestion.

After invoking the command, stop. The dispatched command handles everything from here.
</step>

</process>

<success_criteria>
- [ ] Input validated (not empty)
- [ ] Intent matched to exactly one SMA command
- [ ] Ambiguity resolved via user question (if needed)
- [ ] Project existence checked for routes that require it
- [ ] Routing decision displayed before dispatch
- [ ] Command invoked with appropriate arguments
- [ ] No work done directly — dispatcher only
</success_criteria>
