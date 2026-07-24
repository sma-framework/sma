<purpose>
List captured seeds for browsing and audit, with an optional status filter. Read-only — never mutates seeds.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="load_seeds">
Load seed context. An optional status filter (e.g. `dormant`, `active`, `triggered`) may follow `--list-seeds`.

```bash
_SMA_SHIM_NAME="sma-tools.cjs"; _SMA_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; SMA_TOOLS="${_SMA_RUNTIME_ROOT}/sma-core/bin/${_SMA_SHIM_NAME}"; if [ -f "$SMA_TOOLS" ]; then sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${_SMA_RUNTIME_ROOT}/.claude/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${_SMA_RUNTIME_ROOT}/.claude/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${_SMA_RUNTIME_ROOT}/.codex/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${_SMA_RUNTIME_ROOT}/.codex/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif command -v sma-tools >/dev/null 2>&1; then SMA_TOOLS="$(command -v sma-tools)"; sma_run() { "$SMA_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${HERMES_HOME:-$HOME/.hermes}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CODEX_HOME:-$HOME/.codex}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; else echo "ERROR: sma-tools.cjs not found at $SMA_TOOLS and sma-tools is not on PATH. Run: npx -y sma-framework@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${SMA_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${SMA_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
SEEDS=$(sma_run list-seeds "$STATUS_FILTER")
if [[ "$SEEDS" == @file:* ]]; then SEEDS=$(cat "${SEEDS#@file:}"); fi
```

Replace `$STATUS_FILTER` with the filter token from `$ARGUMENTS` if one was given, otherwise omit it.

Extract from the JSON: `count`, `seeds[]` (each has `seed_id`, `status`, `scope`, `trigger_when`, `planted`, `title`), and `summary` (a `{ status: count }` map).
</step>

<step name="empty_case">
If `count` is 0:
```
No seeds found.

Plant one with /sma:capture --seed "<forward-looking idea>".
```
(If a status filter was given and nothing matched, say so: `No seeds with status "<filter>".`) Exit.
</step>

<step name="render_table">
Render the seeds as a table, sorted by `seed_id` (already sorted by the tool). Truncate `trigger_when` and `title` to keep the table readable.

```
Seeds
─────────────────────────────────────────────────────────────────────
ID        Status     Scope    Trigger                  Title
SEED-001  dormant    large    when websockets land     Real-time collaboration
SEED-006  triggered  medium   MILE-04 planning         Remove legacy auth crates
─────────────────────────────────────────────────────────────────────
<count> seeds  (<summary rendered as "N status" pairs, e.g. "1 dormant, 1 triggered">)
```

Then offer next actions as plain text (no mutation here):
```
- /sma:capture --seed --enrich <ID>   enrich a seed with trigger, why, and scope
- /sma:capture --list-seeds <status>  filter by status
```
</step>

</process>

<success_criteria>
- [ ] Seeds listed with ID, status, scope, trigger, and title
- [ ] Status filter applied when provided
- [ ] Empty / no-match case handled with guidance
- [ ] Summary line shows total and per-status counts
- [ ] No seed files were modified (read-only)
</success_criteria>
