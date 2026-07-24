<purpose>
Execute discovery at the appropriate depth level.
Produces DISCOVERY.md (for Level 2-3) that informs PLAN.md creation.

Called from plan-phase.md's mandatory_discovery step with a depth parameter.

NOTE: For comprehensive ecosystem research ("how do experts build this"), use /sma:plan-phase --research-phase instead, which produces RESEARCH.md.
</purpose>
```bash
_SMA_SHIM_NAME="sma-tools.cjs"; _SMA_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; SMA_TOOLS="${_SMA_RUNTIME_ROOT}/sma-core/bin/${_SMA_SHIM_NAME}"; if [ -f "$SMA_TOOLS" ]; then sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${_SMA_RUNTIME_ROOT}/.claude/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${_SMA_RUNTIME_ROOT}/.claude/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${_SMA_RUNTIME_ROOT}/.codex/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${_SMA_RUNTIME_ROOT}/.codex/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif command -v sma-tools >/dev/null 2>&1; then SMA_TOOLS="$(command -v sma-tools)"; sma_run() { "$SMA_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${HERMES_HOME:-$HOME/.hermes}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CODEX_HOME:-$HOME/.codex}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/sma-core/bin/${_SMA_SHIM_NAME}" ]; then SMA_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/sma-core/bin/${_SMA_SHIM_NAME}"; sma_run() { node "$SMA_TOOLS" "$@"; }; else echo "ERROR: sma-tools.cjs not found at $SMA_TOOLS and sma-tools is not on PATH. Run: npx -y sma-framework@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${SMA_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${SMA_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(sma_run query config-get response_language --default "" 2>/dev/null || echo "")
```

**If `response_language` is set:** All user-facing questions, prompts, and explanations in this workflow MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.


<depth_levels>
**This workflow supports three depth levels:**

| Level | Name         | Time      | Output                                       | When                                      |
| ----- | ------------ | --------- | -------------------------------------------- | ----------------------------------------- |
| 1     | Quick Verify | 2-5 min   | No file, proceed with verified knowledge     | Single library, confirming current syntax |
| 2     | Standard     | 15-30 min | DISCOVERY.md                                 | Choosing between options, new integration |
| 3     | Deep Dive    | 1+ hour   | Detailed DISCOVERY.md with validation gates  | Architectural decisions, novel problems   |

**Depth is determined by plan-phase.md before routing here.**
</depth_levels>

<source_hierarchy>
**MANDATORY: Context7 BEFORE WebSearch**

Claude's training data is 6-18 months stale. Always verify.

1. **Context7 MCP FIRST** - Current docs, no hallucination
2. **Official docs** - When Context7 lacks coverage
3. **WebSearch LAST** - For comparisons and trends only

See ~/.claude/sma-core/templates/discovery.md `<discovery_protocol>` for full protocol.
</source_hierarchy>

<process>

<step name="determine_depth">
Check the depth parameter passed from plan-phase.md:
- `depth=verify` → Level 1 (Quick Verification)
- `depth=standard` → Level 2 (Standard Discovery)
- `depth=deep` → Level 3 (Deep Dive)

Route to appropriate level workflow below.
</step>

<step name="level_1_quick_verify">
**Level 1: Quick Verification (2-5 minutes)**

For: Single known library, confirming syntax/version still correct.

**Process:**

1. Resolve library in Context7:

   ```
   mcp__context7__resolve-library-id with libraryName: "[library]"
   ```

2. Fetch relevant docs:

   ```
   mcp__context7__get-library-docs with:
   - context7CompatibleLibraryID: [from step 1]
   - topic: [specific concern]
   ```

3. Verify:

   - Current version matches expectations
   - API syntax unchanged
   - No breaking changes in recent versions

4. **If verified:** Return to plan-phase.md with confirmation. No DISCOVERY.md needed.

5. **If concerns found:** Escalate to Level 2.

**Output:** Verbal confirmation to proceed, or escalation to Level 2.
</step>

<step name="level_2_standard">
**Level 2: Standard Discovery (15-30 minutes)**

For: Choosing between options, new external integration.

**Process:**

1. **Identify what to discover:**

   - What options exist?
   - What are the key comparison criteria?
   - What's our specific use case?

2. **Context7 for each option:**

   ```
   For each library/framework:
   - mcp__context7__resolve-library-id
   - mcp__context7__get-library-docs (mode: "code" for API, "info" for concepts)
   ```

3. **Official docs** for anything Context7 lacks.

4. **WebSearch** for comparisons:

   - "[option A] vs [option B] {current_year}"
   - "[option] known issues"
   - "[option] with [our stack]"

5. **Cross-verify:** Any WebSearch finding → confirm with Context7/official docs.

6. **Create DISCOVERY.md** using ~/.claude/sma-core/templates/discovery.md structure:

   - Summary with recommendation
   - Key findings per option
   - Code examples from Context7
   - Confidence level (should be MEDIUM-HIGH for Level 2)

7. Return to plan-phase.md.

**Output:** `.planning/phases/XX-name/DISCOVERY.md`
</step>

<step name="level_3_deep_dive">
**Level 3: Deep Dive (1+ hour)**

For: Architectural decisions, novel problems, high-risk choices.

**Process:**

1. **Scope the discovery** using ~/.claude/sma-core/templates/discovery.md:

   - Define clear scope
   - Define include/exclude boundaries
   - List specific questions to answer

2. **Exhaustive Context7 research:**

   - All relevant libraries
   - Related patterns and concepts
   - Multiple topics per library if needed

3. **Official documentation deep read:**

   - Architecture guides
   - Best practices sections
   - Migration/upgrade guides
   - Known limitations

4. **WebSearch for ecosystem context:**

   - How others solved similar problems
   - Production experiences
   - Gotchas and anti-patterns
   - Recent changes/announcements

5. **Cross-verify ALL findings:**

   - Every WebSearch claim → verify with authoritative source
   - Mark what's verified vs assumed
   - Flag contradictions

6. **Create comprehensive DISCOVERY.md:**

   - Full structure from ~/.claude/sma-core/templates/discovery.md
   - Quality report with source attribution
   - Confidence by finding
   - If LOW confidence on any critical finding → add validation checkpoints

7. **Confidence gate:** If overall confidence is LOW, present options before proceeding.

8. Return to plan-phase.md.

**Output:** `.planning/phases/XX-name/DISCOVERY.md` (comprehensive)
</step>

<step name="identify_unknowns">
**For Level 2-3:** Define what we need to learn.

Ask: What do we need to learn before we can plan this phase?

- Technology choices?
- Best practices?
- API patterns?
- Architecture approach?
  </step>

<step name="create_discovery_scope">
Use ~/.claude/sma-core/templates/discovery.md.

Include:

- Clear discovery objective
- Scoped include/exclude lists
- Source preferences (official docs, Context7, current year)
- Output structure for DISCOVERY.md
  </step>

<step name="execute_discovery">
Run the discovery:
- Use web search for current info
- Use Context7 MCP for library docs
- Prefer current year sources
- Structure findings per template
</step>

<step name="create_discovery_output">
Write `.planning/phases/XX-name/DISCOVERY.md`:
- Summary with recommendation
- Key findings with sources
- Code examples if applicable
- Metadata (confidence, dependencies, open questions, assumptions)
</step>

<step name="confidence_gate">
After creating DISCOVERY.md, check confidence level.

If confidence is LOW:

**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
Use AskUserQuestion:

- header: "Low Conf."
- question: "Discovery confidence is LOW: [reason]. How would you like to proceed?"
- options:
  - "Dig deeper" - Do more research before planning
  - "Proceed anyway" - Accept uncertainty, plan with caveats
  - "Pause" - I need to think about this

If confidence is MEDIUM:
Inline: "Discovery complete (medium confidence). [brief reason]. Proceed to planning?"

If confidence is HIGH:
Proceed directly, just note: "Discovery complete (high confidence)."
</step>

<step name="open_questions_gate">
If DISCOVERY.md has open_questions:

Present them inline:
"Open questions from discovery:

- [Question 1]
- [Question 2]

These may affect implementation. Acknowledge and proceed? (yes / address first)"

If "address first": Gather user input on questions, update discovery.
</step>

<step name="offer_next">
```
Discovery complete: .planning/phases/XX-name/DISCOVERY.md
Recommendation: [one-liner]
Confidence: [level]

What's next?

1. Discuss phase context (/sma:discuss-phase [current-phase])
2. Create phase plan (/sma:plan-phase [current-phase])
3. Refine discovery (dig deeper)
4. Review discovery

```

NOTE: DISCOVERY.md is NOT committed separately. It will be committed with phase completion.
</step>

</process>

<success_criteria>
**Level 1 (Quick Verify):**
- Context7 consulted for library/topic
- Current state verified or concerns escalated
- Verbal confirmation to proceed (no files)

**Level 2 (Standard):**
- Context7 consulted for all options
- WebSearch findings cross-verified
- DISCOVERY.md created with recommendation
- Confidence level MEDIUM or higher
- Ready to inform PLAN.md creation

**Level 3 (Deep Dive):**
- Discovery scope defined
- Context7 exhaustively consulted
- All WebSearch findings verified against authoritative sources
- DISCOVERY.md created with comprehensive analysis
- Quality report with source attribution
- If LOW confidence findings → validation checkpoints defined
- Confidence gate passed
- Ready to inform PLAN.md creation
</success_criteria>
