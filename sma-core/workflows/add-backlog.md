# Add Backlog Item Workflow

Invoked by `/sma-capture --backlog` (`commands/sma/capture.md`).

Adds an idea to the ROADMAP.md backlog parking lot using 999.x numbering. Backlog items
are unsequenced ideas that aren't ready for active planning — they live outside the normal
phase sequence and accumulate context over time.

<process>

## Step 1: Read ROADMAP.md

Check for existing backlog entries:

```bash
cat .planning/ROADMAP.md
```

## Step 2: Find next backlog number

```bash
_SMA_SHIM_NAME="sma-tools.cjs"; _SMA_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; SMA_TOOLS="${_SMA_RUNTIME_ROOT}/sma-core/bin/${_SMA_SHIM_NAME}"; if [ -f "$SMA_TOOLS" ]; then sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${_SMA_RUNTIME_ROOT}/.claude/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${_SMA_RUNTIME_ROOT}/.claude/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${_SMA_RUNTIME_ROOT}/.codex/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${_SMA_RUNTIME_ROOT}/.codex/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif command -v sma-tools >/dev/null 2>&1; then SMA_TOOLS="$(command -v sma-tools)"; sma_run() { "$SMA_TOOLS" "$@"; }; elif [ -f "$HOME/.claude/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="$HOME/.claude/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${HERMES_HOME:-$HOME/.hermes}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CODEX_HOME:-$HOME/.codex}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; else echo "ERROR: sma-tools.cjs not found at $SMA_TOOLS and sma-tools is not on PATH. Run: npx -y sma-framework@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${SMA_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${SMA_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
NEXT=$(sma_run query phase.next-decimal 999 --raw)
```

If no 999.x phases exist yet, `phase.next-decimal` returns `999.1`. Sparse numbering
is fine (e.g. 999.1, 999.3) — always use `phase.next-decimal`, never guess.

## Step 3: Write ROADMAP entry

**Write the ROADMAP entry BEFORE creating the directory.** Directory existence is a
reliable indicator that the phase is already registered, which prevents false duplicate
detection in any hook that checks for existing 999.x directories (#2280).

Add under a `## Backlog` section. If the section doesn't exist, create it at the end
of ROADMAP.md:

```markdown
## Backlog

### Phase {NEXT}: {description} (BACKLOG)

**Goal:** [Captured for future planning]
**Requirements:** TBD
**Plans:** 0 plans

Plans:
- [ ] TBD (promote with /sma-review-backlog when ready)
```

## Step 4: Create the phase directory

Apply the `project_code` prefix (if set in `.planning/config.json`) so the backlog directory name is consistent with all other phase-creation paths:

```bash
SLUG=$(sma_run query generate-slug "$ARGUMENTS" --raw)
PROJECT_CODE=$(sma_run query config-get project_code --raw 2>/dev/null || echo "")
PREFIX=$([ -n "$PROJECT_CODE" ] && echo "${PROJECT_CODE}-" || echo "")
PHASE_DIR=".planning/phases/${PREFIX}${NEXT}-${SLUG}"
mkdir -p "${PHASE_DIR}"
touch "${PHASE_DIR}/.gitkeep"
```

## Step 5: Commit

```bash
sma_run query commit "docs: add backlog item ${NEXT} — ${ARGUMENTS}" --files .planning/ROADMAP.md "${PHASE_DIR}/.gitkeep"
```

## Step 6: Report

```
## 📋 Backlog Item Added

Phase {NEXT}: {description}
Directory: {PHASE_DIR}/

This item lives in the backlog parking lot.
Use /sma-discuss-phase {NEXT} to explore it further.
Use /sma-review-backlog to promote items to active milestone.
```

</process>

<notes>
- 999.x numbering keeps backlog items out of the active phase sequence
- Phase directories are created immediately so /sma-discuss-phase and /sma-plan-phase work on them
- No `Depends on:` field — backlog items are unsequenced by definition
- Sparse numbering is fine (999.1, 999.3) — always uses next-decimal
- Promote backlog items to the active milestone with /sma-review-backlog
</notes>
