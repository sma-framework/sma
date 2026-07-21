# Import Workflow

External plan ingestion with conflict detection and agent delegation.

- **--from**: Import external plan → conflict detection → write PLAN.md → validate via sma-plan-checker

Future: `--prd` mode (PRD extraction into PROJECT.md + REQUIREMENTS.md + ROADMAP.md) is planned for a follow-up PR.

---

<step name="banner">

Display the stage banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SMA ► IMPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

</step>

<step name="parse_arguments">

Parse `$ARGUMENTS` to determine the execution mode:

- If `--from` is present: extract FILEPATH (the next token after `--from`), set MODE=plan
- If `--prd` is present: display message that `--prd` is not yet implemented and exit:
  ```
  SMA > --prd mode is planned for a future release. Use --from to import plan files.
  ```
- If neither flag is found: display usage and exit:

```
Usage: /sma:import --from <path>

  --from <path>   Import an external plan file into SMA format
```

**Validate the file path:**

Verify the path does not contain traversal sequences and the file exists:

```bash
case "{FILEPATH}" in
  *..* ) echo "SECURITY_ERROR: path contains traversal sequence"; exit 1 ;;
esac
test -f "{FILEPATH}" || echo "FILE_NOT_FOUND"
```

If FILE_NOT_FOUND: display error and exit:

```
╔══════════════════════════════════════════════════════════════╗
║  ERROR                                                       ║
╚══════════════════════════════════════════════════════════════╝

File not found: {FILEPATH}

**To fix:** Verify the file path and try again.
```

</step>

---

## Path A: MODE=plan (--from)

<step name="plan_load_context">

Load project context for conflict detection:

1. Read `.planning/ROADMAP.md` — extract phase structure, phase numbers, dependencies
2. Read `.planning/PROJECT.md` — extract project constraints, tech stack, scope boundaries.
   **If PROJECT.md does not exist:** skip constraint checks that rely on it and display:
   ```
   SMA > Note: No PROJECT.md found. Conflict checks against project constraints will be skipped.
   ```
3. Read `.planning/REQUIREMENTS.md` — extract existing requirements for overlap and contradiction checks.
   **If REQUIREMENTS.md does not exist:** skip requirement conflict checks and continue.
4. Glob for all CONTEXT.md files across phase directories:
   ```bash
   find .planning/phases/ -name "*-CONTEXT.md" -o -name "CONTEXT.md" 2>/dev/null
   ```
   Read each CONTEXT.md found — extract locked decisions (any decision in a `<decisions>` block)

Store loaded context for conflict detection in the next step.

</step>

<step name="plan_read_input">

Read the imported file at FILEPATH.

Determine the format:
- **SMA PLAN.md format**: Has YAML frontmatter with `phase:`, `plan:`, `type:` fields
- **Freeform document**: Any other format (markdown spec, design doc, task list, etc.)

Extract from the imported content:
- **Phase target**: Which phase this plan belongs to (from frontmatter or inferred from content)
- **Plan objectives**: What the plan aims to accomplish
- **Tasks listed**: Individual work items described in the plan
- **Files modified**: Any files mentioned as targets
- **Dependencies**: Any referenced prerequisites

</step>

<step name="plan_conflict_detection">

Run conflict checks against the loaded project context. The report format, severity semantics, and safety-gate behavior are defined by `references/doc-conflict-engine.md` — read it and apply it here. Operation noun: `import`.

### BLOCKER checks (any one prevents import):

- Plan targets a phase number that does not exist in ROADMAP.md → [BLOCKER]
- Plan specifies a tech stack that contradicts PROJECT.md constraints → [BLOCKER]
- Plan contradicts a locked decision in any CONTEXT.md `<decisions>` block → [BLOCKER]
- Plan contradicts an existing requirement in REQUIREMENTS.md → [BLOCKER]

### WARNING checks (user confirmation required):

- Plan partially overlaps existing requirement coverage in REQUIREMENTS.md → [WARNING]
- Plan has `depends_on` referencing plans that are not yet complete → [WARNING]
- Plan modifies files that overlap with existing incomplete plans → [WARNING]
- Plan phase number conflicts with existing phase numbering in ROADMAP.md → [WARNING]

### INFO checks (informational, no action needed):

- Plan uses a library not currently in the project tech stack → [INFO]
- Plan adds a new phase to the ROADMAP.md structure → [INFO]

Render the full Conflict Detection Report using the format in `references/doc-conflict-engine.md`.

**If any [BLOCKER] exists:** apply the safety gate from the reference — exit WITHOUT writing any files. No PLAN.md is written when blockers exist.

**If only WARNINGS and/or INFO (no blockers):**

**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.

Ask via AskUserQuestion using the approve-revise-abort pattern (see `references/gate-prompts.md`):
- question: "Review the warnings above. Proceed with import?"
- header: "Approve?"
- options: Approve | Abort

If user selects "Abort": exit cleanly with message "Import cancelled."

</step>

<step name="plan_convert">

Convert the imported content to SMA PLAN.md format.

Ensure the PLAN.md has all required frontmatter fields:
```yaml
---
phase: "{NN}-{slug}"
plan: "{NN}-{MM}"
type: "feature|refactor|config|test|docs"
wave: 1
depends_on: []
files_modified: []
autonomous: true
must_haves:
  truths: []
  artifacts: []
---
```

**Reject PBR naming conventions in source content:**
If the imported plan references PBR plan naming (e.g., `PLAN-01.md`, `plan-01.md`), rename all references to SMA `{NN}-{MM}-PLAN.md` convention during conversion.

Apply SMA naming convention for the output filename:
- Format: `{NN}-{MM}-PLAN.md` (e.g., `04-01-PLAN.md`)
- NEVER use `PLAN-01.md`, `plan-01.md`, or any other format
- NN = phase number (zero-padded), MM = plan number within the phase (zero-padded)

Determine the target directory by querying `init.phase-op` for the phase number extracted in `plan_read_input`. This ensures the `project_code` prefix from `.planning/config.json` is applied:

```bash
_SMA_SHIM_NAME="sma-tools.cjs"; _SMA_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; SMA_TOOLS="${_SMA_RUNTIME_ROOT}/sma-core/bin/${_SMA_SHIM_NAME}"; if [ -f "$SMA_TOOLS" ]; then sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${_SMA_RUNTIME_ROOT}/.claude/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${_SMA_RUNTIME_ROOT}/.claude/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${_SMA_RUNTIME_ROOT}/.codex/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${_SMA_RUNTIME_ROOT}/.codex/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif command -v sma-tools >/dev/null 2>&1; then SMA_TOOLS="$(command -v sma-tools)"; sma_run() { "$SMA_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${HERMES_HOME:-$HOME/.hermes}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CODEX_HOME:-$HOME/.codex}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; else echo "ERROR: sma-tools.cjs not found at $SMA_TOOLS and sma-tools is not on PATH. Run: npx -y sma-framework@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${SMA_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${SMA_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
INIT=$(sma_run query init.phase-op "{NN}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
expected_phase_dir=$(echo "$INIT" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).expected_phase_dir)")
```

If the directory does not exist, create it:
```bash
mkdir -p "${expected_phase_dir}"
```

Set `phase_dir="${expected_phase_dir}"` for use in subsequent steps.

Write the PLAN.md file to the target directory.

</step>

<step name="plan_validate">

Delegate validation to sma-plan-checker:

Print: "Delegating to sma-plan-checker (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)"

```
Agent({
  subagent_type: "sma-plan-checker",
  prompt: "Validate: .planning/phases/{phase}/{plan}-PLAN.md — check frontmatter completeness, task structure, and SMA conventions. Report any issues."
})
```

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

If the checker returns errors:
- Display the errors to the user
- Ask the user to resolve issues before the plan is considered imported
- Do not delete the written file — the user can fix and re-validate manually

If the checker returns clean:
- Display: "Plan validation passed"

</step>

<step name="plan_finalize">

Update `.planning/ROADMAP.md` to reflect the new plan:
- Add the plan to the Plans list under the correct phase section
- Include the plan name and description

Update `.planning/STATE.md` if appropriate (e.g., increment total plan count).

Commit the imported plan and updated files:
```bash
sma_run query commit "docs({phase}): import plan from {basename FILEPATH}" --files .planning/phases/{phase}/{plan}-PLAN.md .planning/ROADMAP.md
```

Display completion:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SMA ► IMPORT COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Show: plan filename written, phase directory, validation result, next steps.

</step>

---

## Anti-Patterns

Do NOT:
- Violate the shared conflict-engine contract in `references/doc-conflict-engine.md` (no markdown tables, no new severity labels, no bypass of the BLOCKER gate)
- Write PLAN.md files as `PLAN-01.md` or `plan-01.md` — always use `{NN}-{MM}-PLAN.md`
- Use `pbr:plan-checker` or `pbr:planner` — use `sma-plan-checker` and `sma-planner`
- Write `.planning/.active-skill` — this is a PBR pattern with no SMA equivalent
- Reference `pbr-tools`, `pbr:`, or `PLAN-BUILD-RUN` anywhere
- Write any PLAN.md file when blockers exist — the safety gate must hold
- Skip path validation on the --from file argument
