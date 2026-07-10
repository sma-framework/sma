#!/usr/bin/env node
/**
 * gen.mjs — generate on-brand, looping "terminal cast" SVGs, one per SMA command,
 * for embedding under each command in the README. Pure Node, no deps.
 *
 * Each SVG is a self-contained animated document: staged line reveals via SMIL
 * (opacity keyframes with per-line begin offsets), a blinking gradient caret, and
 * the house gradient (blue -> teal -> green). Renders on GitHub via <img>/![]().
 *
 *   node assets/demos/gen.mjs        # writes assets/demos/sma-<cmd>.svg
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))

// ── house palette ────────────────────────────────────────────────────────────
const C = {
  ground: '#0B0F17', surface: '#0F131C', border: '#232c3b', bar: '#141a25',
  ink: '#E6EDF5', dim: '#8b98a9', mut: '#c3cede',
  green: '#74DBA0', greenSoft: '#a9e0c4', teal: '#1FA0A6', blue: '#3B82F6',
  amber: '#E7C07A', okInk: '#bfe6cf',
}

// leading-glyph -> accent colour for that glyph
const LEAD = { '$': C.green, '◇': C.teal, '◆': C.teal, '✓': C.green,
  '⚠': C.amber, '?': C.blue, '→': C.green }
// per line-class -> body colour
const BODY = { cmd: C.ink, accent: C.mut, dim: C.dim, ok: C.okInk, hi: C.mut }

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// glyphs we want as numeric entities for portability
const ent = (s) => s
  .replace(/✓/g, '&#10003;').replace(/◇/g, '&#9671;').replace(/◆/g, '&#9670;')
  .replace(/⚠/g, '&#9888;').replace(/→/g, '&#8594;').replace(/‘|’/g, "'")
  .replace(/“/g, '&#8220;').replace(/”/g, '&#8221;').replace(/·/g, '&#183;')

const CH = 8.5           // monospace char advance at 15px
const LH = 27            // line height
const PADX = 22
const Y0 = 60            // first line baseline offset from top of body region

function svg(demo) {
  const lines = demo.lines
  const N = lines.length
  const cadence = 0.52
  const T = +(N * cadence + 3.0).toFixed(2)   // full loop period (s)
  const barH = 42
  const H = barH + Y0 - 18 + N * LH + 20
  const W = 760

  const body = lines.map((ln, i) => {
    const [text, cls] = ln
    const y = barH + Y0 - 34 + i * LH
    const lead = text[0]
    const leadColor = LEAD[lead]
    const bodyColor = BODY[cls] || C.mut
    let inner
    if (leadColor && (lead === '$' ? true : text[1] === ' ' || text.length === 1)) {
      const rest = text.slice(1)
      inner = `<tspan fill="${leadColor}" font-weight="700">${ent(esc(lead))}</tspan>`
        + `<tspan fill="${bodyColor}">${ent(esc(rest))}</tspan>`
    } else {
      inner = `<tspan fill="${bodyColor}">${ent(esc(text))}</tspan>`
    }
    // loop-safe staged reveal: 0 -> hold -> 1 -> hold -> 0 (all clear together, then repeat)
    const f = +((i * cadence) / T).toFixed(4)          // reveal start fraction
    const g = +Math.min(f + 0.035, 0.9).toFixed(4)     // reveal end fraction
    const anim = `<animate attributeName="opacity" dur="${T}s" repeatCount="indefinite" `
      + `values="0;0;1;1;0" keyTimes="0;${f};${g};0.955;1" calcMode="spline" `
      + `keySplines="0 0 1 1;.2 .8 .2 1;0 0 1 1;.4 0 1 1"/>`
    return `<g opacity="0"><text x="${PADX}" y="${y}" class="ln">${inner}</text>${anim}</g>`
  }).join('\n  ')

  // blinking caret parked at the end of the command line (line 0)
  const cmdLen = lines[0][0].length
  const caretX = PADX + cmdLen * CH + 3
  const caretY = barH + Y0 - 34 + 0 * LH - 12
  const caret = `<rect x="${caretX}" y="${caretY}" width="9" height="16" rx="1.5" fill="url(#g)">`
    + `<animate attributeName="opacity" dur="1.05s" repeatCount="indefinite" values="1;1;0;0" keyTimes="0;.5;.5;1"/></rect>`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" role="img" aria-label="Terminal demo of the ${demo.cmd} command">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#2E6FD9"/><stop offset=".35" stop-color="#1B7E9C"/>
      <stop offset=".7" stop-color="#1FA0A6"/><stop offset="1" stop-color="#74DBA0"/>
    </linearGradient>
    <style>.ln{font-size:15px}.tt{font-size:12.5px;fill:#8b98a9;font-family:ui-sans-serif,-apple-system,'Segoe UI',Roboto,sans-serif}</style>
  </defs>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="13" fill="${C.surface}" stroke="${C.border}"/>
  <rect x="1" y="1" width="${W - 2}" height="${barH}" rx="13" fill="${C.bar}"/>
  <rect x="1" y="${barH - 12}" width="${W - 2}" height="12" fill="${C.bar}"/>
  <circle cx="24" cy="21" r="6" fill="#ff5f57"/><circle cx="46" cy="21" r="6" fill="#febc2e"/><circle cx="68" cy="21" r="6" fill="#28c840"/>
  <text x="${W / 2}" y="26" text-anchor="middle" class="tt">your-project &#8212; ${ent(esc(demo.cmd))}</text>
  <rect x="1" y="${barH}" width="${W - 2}" height="2" fill="url(#g)" opacity=".55"/>
  ${body}
  ${caret}
  <rect x="${PADX}" y="${H - 16}" width="${W - PADX * 2}" height="2.5" rx="1.25" fill="url(#g)" opacity=".22"/>
</svg>
`
}

// ── the 12 command scripts (authentic, concise) ───────────────────────────────
const DEMOS = [
  { cmd: '/sma-start', file: 'sma-start', lines: [
    ['$ /sma-start', 'cmd'],
    ['◇ SMA onboarding — first I explain, then I configure', 'accent'],
    ['  not a 700-line rules file — a process you can diff', 'dim'],
    ['  loop:  predict → act → score → learn   (reflex fires first)', 'dim'],
    ['? your stack / deploy host / release ritual …', 'hi'],
    ['✓ seeded  .claude/memory · .sma · infra profile', 'ok'],
    ['✓ 5 hooks wired — your source code is untouched', 'ok'],
    ['◆ ready — every session now loads the core first', 'accent'],
  ] },
  { cmd: '/sma-discuss-phase', file: 'sma-discuss-phase', lines: [
    ['$ /sma-discuss-phase 12', 'cmd'],
    ['◇ locking the gray-area decisions before any code', 'accent'],
    ['  adaptive questions — only what is still unresolved', 'dim'],
    ['? two responsibles, or a second field?   › …', 'hi'],
    ['✓ D-12-01 … D-12-07 locked → 12-CONTEXT.md', 'ok'],
    ['◆ grounded — the plan builds on facts, not guesses', 'accent'],
  ] },
  { cmd: '/sma-plan-phase', file: 'sma-plan-phase', lines: [
    ['$ /sma-plan-phase 12', 'cmd'],
    ['◇ research → plans → plan-check', 'accent'],
    ['  every step carries a machine-checkable prediction', 'dim'],
    ['✓ 6 plans / 3 waves written', 'ok'],
    ['✓ plan-check: PASS — goal covered, no orphan', 'ok'],
    ['◆ ready for  /sma-execute-phase 12', 'accent'],
  ] },
  { cmd: '/sma-execute-phase', file: 'sma-execute-phase', lines: [
    ['$ /sma-execute-phase 12', 'cmd'],
    ['◇ building in dependency-aware waves', 'accent'],
    ['⚠ reflex: schema change → migration required (fired first)', 'hi'],
    ['  wave 1 ✓   wave 2 ✓   progress journaled', 'dim'],
    ['✓ vitest 142/142 · atomic commits', 'ok'],
    ['◆ executor died? resume in minutes, not from scratch', 'accent'],
  ] },
  { cmd: '/sma-verify-work', file: 'sma-verify-work', lines: [
    ['$ /sma-verify-work 12', 'cmd'],
    ['◇ walking the built feature with you', 'accent'],
    ['  a script re-runs each "done" — not my word', 'dim'],
    ['✓ 8/9 acceptance checks reproduced on a fresh clone', 'ok'],
    ['◆ human sign-off stays human — I never self-certify', 'accent'],
  ] },
  { cmd: '/sma-quick', file: 'sma-quick', lines: [
    ['$ /sma-quick "add a rate-limit header"', 'cmd'],
    ['◇ small task, full guarantees', 'accent'],
    ['✓ change + its targeted test green', 'ok'],
    ['✓ atomic commit · state tracked', 'ok'],
    ['◆ done — no planning ceremony', 'accent'],
  ] },
  { cmd: '/sma-fast', file: 'sma-fast', lines: [
    ['$ /sma-fast "fix the footer typo"', 'cmd'],
    ['◇ trivial — inline, no subagents', 'accent'],
    ['✓ edited + committed', 'ok'],
    ['◆ done in one pass', 'accent'],
  ] },
  { cmd: '/sma-debug', file: 'sma-debug', lines: [
    ['$ /sma-debug "inbox returns 500 on send"', 'cmd'],
    ['◇ scientific method — state survives a context reset', 'accent'],
    ['  hypothesis → probe → observe → narrow', 'dim'],
    ['✓ root cause: outbound SMTP port blocked on host', 'ok'],
    ['◆ lesson written — this burn never repeats', 'accent'],
  ] },
  { cmd: '/sma-progress', file: 'sma-progress', lines: [
    ['$ /sma-progress', 'cmd'],
    ['◇ where things stand', 'accent'],
    ['  phase 12 · wave 2 of 3 · 1 open blocker', 'dim'],
    ['→ next: /sma-execute-phase continues wave 3', 'hi'],
    ['◆ or just tell me what you want next', 'accent'],
  ] },
  { cmd: '/sma-resume-work', file: 'sma-resume-work', lines: [
    ['$ /sma-resume-work', 'cmd'],
    ['◇ restoring context from the flight recorder', 'accent'],
    ['  reads intent, touched files, open questions', 'dim'],
    ['✓ back exactly where we paused — minutes, not scratch', 'ok'],
    ['◆ continuing wave 3', 'accent'],
  ] },
  { cmd: '/sma-pause-work', file: 'sma-pause-work', lines: [
    ['$ /sma-pause-work', 'cmd'],
    ['◇ writing a handoff before you step away', 'accent'],
    ['✓ stopped-at · blockers · next step → STATE.md', 'ok'],
    ['◆ the next session (or a teammate) resumes cold', 'accent'],
  ] },
  { cmd: '/sma-help', file: 'sma-help', lines: [
    ['$ /sma-help', 'cmd'],
    ['◇ the /sma-* family', 'accent'],
    ['  start · discuss · plan · execute · verify', 'dim'],
    ['  quick · fast · debug · progress · resume · pause', 'dim'],
    ['◆ files + git underneath — everything you can diff', 'accent'],
  ] },

  // ── V3 · the trust spine (authentic behavior, house style) ───────────────────
  { cmd: 'sma reverify', file: 'sma-reverify', lines: [
    ['$ sma reverify --all --fresh-clone', 'cmd'],
    ['◇ re-running every "done" on a throwaway git clone', 'accent'],
    ['  only committed evidence counts — no live mutable state', 'dim'],
    ['✓ 24/24 structural receipts reproduced (observed = expected)', 'ok'],
    ['✓ RECEIPT-PROSE lint clean — no naked prose "done"', 'ok'],
    ['◆ "done" is a command that re-runs, not a sentence', 'accent'],
  ] },
  { cmd: 'sma blind-verify', file: 'sma-blind-verify', lines: [
    ['$ sma blind-verify 9.2-07-PLAN.md', 'cmd'],
    ['◇ re-deriving every "done" from the code tree alone', 'accent'],
    ['⚠ BLIND_FORBIDDEN: a SUMMARY as input is structurally refused', 'hi'],
    ['  the verifier never sees the executor’s own report', 'dim'],
    ['✓ 9 checks derived from -PLAN.md + tree · no divergence', 'ok'],
    ['◆ claimed-pass / reproduced-fail is the heaviest ledger event', 'accent'],
  ] },
  { cmd: 'sma preship', file: 'sma-preship', lines: [
    ['$ sma preship', 'cmd'],
    ['⚠ SHIP BLOCKED — 1 open class-A event', 'hi'],
    ['  blind-divergence in sma.receipts — a false "done" reproduced', 'dim'],
    ['$ sma disposition <event> --verdict fix-forward --reason "…" --yes', 'cmd'],
    ['✓ disposition recorded in the append-only ledger', 'ok'],
    ['✓ sma preship: clean — ship may proceed', 'ok'],
    ['◆ the agent cannot forgive itself — only the founder unblocks', 'accent'],
  ] },
  { cmd: 'sma grill', file: 'sma-grill', lines: [
    ['$ sma grill 12-01-PLAN.md --gate', 'cmd'],
    ['◇ cross-examining every promise before the build', 'accent'],
    ['⚠ BLOCKED — 1 unresolved challenge', 'hi'],
    ['  CH-1: «rejects the 101st req» ⟵ what about a burst at t=0?', 'dim'],
    ['✓ CH-1 → converted to a registered prediction (PRED-03)', 'ok'],
    ['◆ allowed — no challenge left standing, the build may start', 'accent'],
  ] },
  { cmd: 'sma pre-bench', file: 'sma-pre-bench', lines: [
    ['$ sma pre-bench', 'cmd'],
    ['◇ the PreToolUse multiplexer — ONE spawn per tool call', 'accent'],
    ['  V2 base: 1268.6 ms/call (3–4 spawns) · SLO p95 ≤ 300 ms', 'dim'],
    ['✓ p95 152–157 ms · spawn-count 1 · parity 0 mismatches', 'ok'],
    ['◆ every check now rides one node run, not four', 'accent'],
  ] },
  { cmd: 'sma undo', file: 'sma-undo', lines: [
    ['$ sma undo --dry-run', 'cmd'],
    ['◇ the git airbag — a ms-level snapshot before destructive git', 'accent'],
    ['  update-ref refs/sma/airbag + stash create (never a slow bundle)', 'dim'],
    ['✓ newest snapshot restorable: HEAD + dirty + untracked', 'ok'],
    ['◆ one action back to safety —  sma undo --yes', 'accent'],
  ] },
  { cmd: 'sma resume', file: 'sma-resume', lines: [
    ['$ sma resume', 'cmd'],
    ['◇ rebuilding the brief from the flight recorder (zero LLM)', 'accent'],
    ['  intent · touched files · recent decisions · open questions', 'dim'],
    ['✓ back exactly where compaction cut you off — minutes, not scratch', 'ok'],
    ['◆ the capsule was written BEFORE the context was cut', 'accent'],
  ] },
  { cmd: 'sma spend', file: 'sma-spend', lines: [
    ['$ sma spend', 'cmd'],
    ['◇ deterministic spend ledger — parsed from local session logs', 'accent'],
    ['  per session · subagent · model   (no daemon, no cloud)', 'dim'],
    ['⚠ budget reflex warns at 70/90%; a loop-breaker disarms a runaway rule', 'hi'],
    ['◆ spend blindness is the proven enterprise veto — this closes it', 'accent'],
  ] },
]

mkdirSync(OUT, { recursive: true })
let n = 0
for (const d of DEMOS) {
  writeFileSync(join(OUT, `${d.file}.svg`), svg(d))
  n++
}
console.log(`wrote ${n} command demo SVGs to ${OUT}`)
