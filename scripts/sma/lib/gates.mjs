/**
 * gates.mjs — the P4 propose/enforce split (49.1-16, B9/B10, D-49.1-12).
 *
 * Promotes the deterministically-checkable HARD RULEs from prompt-convention to
 * PreToolUse gates. The full paper contract (matchers, WARN texts, kill envs,
 * not-checkable rationale) lives in sma-core/references/gates-inventory.md.
 *
 * POSTURE (D-49.1-12, non-negotiable in THIS wave): every gate is ADVISORY WARN.
 * checkEvent never denies — the CLI handler (`gates-check`) emits
 * permissionDecision 'allow' ALWAYS. The soft-deny tier is 49.1-17's separately
 * gated mechanism; NO permissionDecision 'deny' is ever emitted from this module.
 *
 * FAIL-OPEN (C9, scorecard metric 7): the whole evaluation is wrapped, and EACH
 * gate's matcher runs in its own try/catch, so a bug in one gate can neither wedge
 * a session nor stop the other gates. Node built-ins only; zero npm deps.
 *
 * SMA-3 escaped-verb isolation: every sensitive command literal is assembled via
 * `['verb'].join('')` so this source tree never carries the adjacent dangerous
 * literal (e.g. the two-word deploy invocation), matching the push-claim channel
 * in cli.mjs.
 *
 * CR-01 discipline (RESEARCH Pitfall 1): Edit/Write hooks deliver ABSOLUTE Windows
 * paths; buildCtx relativizes against the repo root BEFORE any path matching,
 * reusing collision.mjs's normalizePath/relativizePath so there is ONE path truth.
 *
 * FATIGUE: per-session dedup reuses the reflex seen-store shape under a 'gate:'
 * key prefix — a gate fires once per session per (gateId, target).
 */

import { statSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { normalizePath, relativizePath } from './collision.mjs'
import { appendEvent } from './journal.mjs'

// ── soft-deny tier (49.1-17, D-49.1-13) ─────────────────────────────────────────
// Full-gate evidence marker TTL: a fullgate-<sha>.json older than this no longer
// satisfies GATE-PUSH (the tree moved on since the heavy gate ran). 6 hours.
const FULLGATE_TTL_MS = 6 * 60 * 60 * 1000

// ── SMA-3 escaped sensitive verbs (assembled, never adjacent to their context) ──
const PUSH_VERB = ['push'].join('') //         the deploy verb
const STASH_VERB = ['stash'].join('') //       the shared-stack verb
const ADD_VERB = ['add'].join('') //           the stage verb
const CHECKOUT_VERB = ['checkout'].join('') //  the destructive-restore verb
const RESTORE_VERB = ['restore'].join('') //    the destructive-restore verb (v2)
const BUILD_VERB = ['build'].join('') //        the local-build verb

// ── matcher helpers ───────────────────────────────────────────────────────────

const reGitPush = new RegExp('\\bgit\\s+' + PUSH_VERB + '\\b')
const reGitStash = new RegExp('\\bgit\\s+' + STASH_VERB + '\\b')
// bulk stage: -A / --all / a bare "." target (never an explicit path)
const reGitAddAll = new RegExp('\\bgit\\s+' + ADD_VERB + '\\s+(-A\\b|--all\\b|\\.(\\s|$))')
// blanket checkout-of-paths (`git checkout -- ...`) or any `git restore`
const reGitCheckout = new RegExp('\\bgit\\s+' + CHECKOUT_VERB + '\\s+--\\s')
const reGitRestore = new RegExp('\\bgit\\s+' + RESTORE_VERB + '\\b')
// local build: `next build` or `(pnpm|npm|yarn) [run] build` (NOT `pnpm sma build-index`)
const reNextBuild = new RegExp(
  '(\\bnext\\s+' + BUILD_VERB + '\\b)|(\\b(pnpm|npm|yarn)\\s+(run\\s+)?' + BUILD_VERB + '\\b)',
)

// NOTE: collision.normalizePath lowercases the relativized target, so these
// path matchers carry the `i` flag (the literals stay readable in canonical case).
const reMemGenerated = /(^|\/)\.claude\/memory\/(MEMORY\.md|INDEX-[^/]*\.md)$/i
const reDodPath = /-DOD\.json$/i
const reMigIndex = /(^|\/)src\/migrations\/index\.ts$/i
// GATE-STATEEDIT (D-49.1-14): the machine-managed STATE.md fenced region. The target
// must be `.planning/STATE.md` AND the written content must INTERSECT the fence — i.e.
// carry a fence marker or one of the three managed section headings (Current Position /
// Open Blockers / Active Sessions). A free-form STATE.md edit outside those zones stays
// silent, so the WARN fires only when a hand-edit would fight the sma state verbs.
const reStatePath = /(^|\/)\.planning\/STATE\.md$/i
const reStateManaged = /SMA-MANAGED:(START|END)|^##\s+Current Position\b|^##\s+Open Blockers\b|^##\s+Active Sessions\b/m

/**
 * dodHumanPass(content) — true when the new *-DOD.json content pairs a human-kind
 * dimension with status pass IN THE SAME dimension object. Brace-group scan first
 * (per-dimension objects) so an agent-kind pass alongside a human-kind pending
 * never false-fires; falls back to whole-string co-occurrence only for a fragment
 * with no object braces (a single-dimension Edit new_string).
 * @param {string} content
 * @returns {boolean}
 */
function dodHumanPass(content) {
  if (!content || typeof content !== 'string') return false
  const kindHuman = /"kind"\s*:\s*"human"/
  const statusPass = /"status"\s*:\s*"pass"/
  const groups = content.match(/\{[^{}]*\}/g)
  if (groups && groups.length) {
    return groups.some((g) => kindHuman.test(g) && statusPass.test(g))
  }
  return kindHuman.test(content) && statusPass.test(content)
}

// ── the registry ──────────────────────────────────────────────────────────────

/**
 * GATES — the checkable HARD-RULE inventory (D-49.1-12). Each entry:
 *   id      — GATE-<NAME>
 *   tools   — which PreToolUse tools it matches (Bash | Edit | Write)
 *   match   — (ctx) => boolean over the relativized tool input (CR-01)
 *   warn    — self-sufficient advisory text: rule + the correct alternative
 *   killEnv — per-gate kill switch (SMA_GATE_<NAME>_OFF)
 *
 * ctx = { toolName, target (relativized path), command (bash), content }.
 */
export const GATES = [
  {
    id: 'GATE-PUSH',
    tools: ['Bash'],
    killEnv: 'SMA_GATE_PUSH_OFF',
    match: (ctx) => reGitPush.test(ctx.command),
    warn:
      'SMA-гейт [GATE-PUSH]: обнаружен push. Перед push прогоните полный гейт ' +
      '(pnpm test + pnpm tsc --noEmit), просмотрите git log origin/main..main и присвойте ' +
      'следующий тег V1.N. Пушить только по явной команде основателя.',
    // Soft-deny tier (D-49.1-13): DORMANT unless SMA_GATE_PUSH_DENY is set. When armed,
    // a push is denied unless a fresh full-gate evidence marker exists for HEAD (written
    // by /sma-ship via `pnpm sma gates mark-fullgate`) or a one-shot override token is
    // present. Promotion (arming) is a founder action justified by gates-report
    // --promotion-readiness — NEVER armed by default.
    softDeny: {
      armEnv: 'SMA_GATE_PUSH_DENY',
      // evidence: a fullgate-<HEAD>.json younger than the TTL satisfies the gate.
      evidence: ({ gatesDir, headSha, now }) => {
        try {
          if (!gatesDir || !headSha) return false
          const st = statSync(join(gatesDir, `fullgate-${headSha}.json`))
          return (now ?? Date.now()) - st.mtimeMs <= FULLGATE_TTL_MS
        } catch {
          return false // no marker / unreadable → no evidence (never throws)
        }
      },
      denyText:
        'SMA-гейт [GATE-PUSH] DENY: push заблокирован — нет доказательства полного гейта ' +
        'для текущего HEAD. Прогоните ритуал /sma-ship (он запишет маркер fullgate через ' +
        'pnpm sma gates mark-fullgate) или получите разовый override с провенансом: ' +
        'pnpm sma gates override GATE-PUSH --yes --reason "почему". Kill-switch: SMA_GATE_PUSH_DENY=0.',
    },
  },
  {
    id: 'GATE-ADDALL',
    tools: ['Bash'],
    killEnv: 'SMA_GATE_ADDALL_OFF',
    match: (ctx) => reGitAddAll.test(ctx.command),
    warn:
      'SMA-гейт [GATE-ADDALL]: массовый git add (-A / --all / .) запрещён на общем дереве — ' +
      'можно захватить незакоммиченные файлы другого терминала. Добавляйте файлы явно: ' +
      'git add path/to/file.',
  },
  {
    id: 'GATE-STASH',
    tools: ['Bash'],
    killEnv: 'SMA_GATE_STASH_OFF',
    match: (ctx) => reGitStash.test(ctx.command),
    warn:
      'SMA-гейт [GATE-STASH]: git stash запрещён — стек stash общий для всех worktree, вы ' +
      'примените чужой WIP. Вместо этого закоммитьте во временную ветку ' +
      '(git checkout -b scratch-<task>-wip + явные git add) или читайте файл через ' +
      'git show <ref>:<path>.',
  },
  {
    id: 'GATE-MEMEDIT',
    tools: ['Edit', 'Write'],
    killEnv: 'SMA_GATE_MEMEDIT_OFF',
    match: (ctx) => reMemGenerated.test(ctx.target),
    warn:
      'SMA-гейт [GATE-MEMEDIT]: MEMORY.md / INDEX-*.md — СГЕНЕРИРОВАННЫЕ файлы, ручная правка ' +
      'потеряется при пересборке. Меняйте исходные заметки в .claude/memory/ и пересоберите ' +
      'индекс: pnpm sma build-index.',
    // Soft-deny tier (D-49.1-13): DORMANT unless SMA_GATE_MEMEDIT_DENY is set. A hand-edit
    // of a generated file has no positive "evidence" escape (nothing legitimizes it) — the
    // only sanctioned bypass is a one-shot override token with provenance.
    softDeny: {
      armEnv: 'SMA_GATE_MEMEDIT_DENY',
      // no evidence marker for a hand-edit — override is the only escape.
      denyText:
        'SMA-гейт [GATE-MEMEDIT] DENY: ручная правка сгенерированного MEMORY.md / INDEX-*.md ' +
        'заблокирована — изменение потеряется при пересборке. Меняйте исходные заметки в ' +
        '.claude/memory/ и пересоберите индекс: pnpm sma build-index. Разовый override с ' +
        'провенансом: pnpm sma gates override GATE-MEMEDIT --yes --reason "почему". ' +
        'Kill-switch: SMA_GATE_MEMEDIT_DENY=0.',
    },
  },
  {
    id: 'GATE-DODHONESTY',
    tools: ['Edit', 'Write'],
    killEnv: 'SMA_GATE_DODHONESTY_OFF',
    match: (ctx) => reDodPath.test(ctx.target) && dodHumanPass(ctx.content),
    warn:
      'SMA-гейт [GATE-DODHONESTY]: человеческий DoD-гейт помечается pass ТОЛЬКО основателем ' +
      'в /crm/projects, никогда записью в файл. Оставьте human-измерения в status pending.',
  },
  {
    id: 'GATE-NEXTBUILD',
    tools: ['Bash'],
    killEnv: 'SMA_GATE_NEXTBUILD_OFF',
    match: (ctx) => reNextBuild.test(ctx.command),
    warn:
      'SMA-гейт [GATE-NEXTBUILD]: локальный next build / pnpm build запрещён (медленно, держит ' +
      '.next lock). Запушьте и дайте собрать Railway; правьте по факту сборки в CI.',
  },
  {
    id: 'GATE-CHECKOUT',
    tools: ['Bash'],
    killEnv: 'SMA_GATE_CHECKOUT_OFF',
    match: (ctx) => reGitCheckout.test(ctx.command) || reGitRestore.test(ctx.command),
    warn:
      'SMA-гейт [GATE-CHECKOUT]: git checkout -- / git restore на общем дереве может уничтожить ' +
      'незакоммиченную работу другого терминала. Сначала сохраните git diff, откатывайте только ' +
      'ваш конкретный файл.',
  },
  {
    id: 'GATE-MIGNUM',
    tools: ['Edit', 'Write'],
    killEnv: 'SMA_GATE_MIGNUM_OFF',
    match: (ctx) => reMigIndex.test(ctx.target),
    warn:
      'SMA-гейт [GATE-MIGNUM]: номер миграции в src/migrations/index.ts ОБЯЗАН приходить из ' +
      'pnpm sma next-slot migration — не выбирайте номер вручную (коллизия на общем дереве).',
  },
  {
    id: 'GATE-STATEEDIT',
    tools: ['Edit', 'Write'],
    killEnv: 'SMA_GATE_STATEEDIT_OFF',
    // Advisory WARN only (D-49.1-14 says WARN, never deny — no softDeny here). Fires on a
    // hand-edit of the machine-managed STATE.md zones; a free-form STATE.md edit is silent.
    match: (ctx) => reStatePath.test(ctx.target) && reStateManaged.test(ctx.content),
    warn:
      'SMA-гейт [GATE-STATEEDIT]: машинно-управляемая секция STATE.md (Current Position / Open ' +
      'Blockers / Active Sessions) внутри ограждения SMA-MANAGED правится ТОЛЬКО через state-глаголы, ' +
      'иначе правка потеряется при следующей записи. Используйте: pnpm sma state set-position | ' +
      'add-blocker | resolve-blocker | set-session.',
  },
]

/** truthy env flag: set and not "0"/"false"/"". */
function truthy(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return !!s && s !== '0' && s !== 'false'
}

/**
 * evaluateSoftDeny(gate, opts) → { deny:boolean } — the D-49.1-13 soft-deny decision
 * for a gate that carries `softDeny`. DORMANT by default: returns {deny:false} unless
 * the gate's arm env is set. When armed, the operation is allowed if EITHER a fresh
 * evidence marker satisfies the gate OR a one-shot override token is present (consumed
 * + journaled with provenance). Otherwise it denies.
 *
 * FAIL-OPEN (scorecard metric 7): the whole body is wrapped so ANY exception in the
 * deny path degrades to allow — a coordination bug can never wedge or falsely-deny a
 * session. The evidence matcher guards its own file I/O so a missing marker is a clean
 * "no evidence" (deny), NOT an exception (allow).
 *
 * @param {object} gate — a GATES entry carrying `softDeny`
 * @param {{env?:object, gatesDir?:string, headSha?:string, now?:number, journalDir?:string, terminalId?:string}} opts
 * @returns {{deny:boolean}}
 */
function evaluateSoftDeny(gate, opts = {}) {
  const sd = gate && gate.softDeny
  if (!sd) return { deny: false }
  const env = opts.env ?? {}
  if (!truthy(env[sd.armEnv])) return { deny: false } // dormant unless explicitly armed

  try {
    // 1) evidence escape (e.g. GATE-PUSH's fullgate marker). Absent for GATE-MEMEDIT.
    if (typeof sd.evidence === 'function') {
      if (sd.evidence({ gatesDir: opts.gatesDir, headSha: opts.headSha, now: opts.now }) === true) {
        return { deny: false }
      }
    }
    // 2) one-shot override token escape (force-clear-style provenance, consumed once).
    if (opts.gatesDir) {
      const tokenPath = join(opts.gatesDir, `override-${gate.id}.json`)
      if (existsSync(tokenPath)) {
        let reason = ''
        let tokTerminal = ''
        try {
          const t = JSON.parse(readFileSync(tokenPath, 'utf8'))
          reason = typeof t.reason === 'string' ? t.reason : ''
          tokTerminal = typeof t.terminal === 'string' ? t.terminal : ''
        } catch {
          /* an unreadable token is still a present escape — consume it */
        }
        try {
          unlinkSync(tokenPath) // one-shot: consume so it cannot be replayed
        } catch {
          /* consumption failure is non-fatal — still allow this one */
        }
        // journal the override use with who/why (repudiation mitigation, T-49.1-35).
        if (opts.journalDir && opts.terminalId) {
          try {
            appendEvent(
              {
                type: 'gate-override',
                actors: [opts.terminalId],
                scope: gate.id,
                detail: { gateId: gate.id, terminal: tokTerminal || opts.terminalId, reason },
              },
              { terminalId: opts.terminalId, journalDir: opts.journalDir },
            )
          } catch {
            /* a journal failure never blocks the override */
          }
        }
        return { deny: false }
      }
    }
    // 3) armed, no evidence, no override → deny.
    return { deny: true }
  } catch {
    return { deny: false } // fail-open — an exception in the deny path degrades to allow
  }
}

/**
 * buildCtx(toolName, input, root) — the relativized evaluation context (CR-01).
 * Edit/Write: relativize the ABSOLUTE hook path; content = new content or the
 * Edit new_string (what the tool is about to WRITE). Bash: the raw command.
 * @returns {{toolName:string, target:string, command:string, content:string}}
 */
function buildCtx(toolName, input, root) {
  const ctx = { toolName, target: '', command: '', content: '' }
  try {
    if (toolName === 'Bash' && typeof input.command === 'string') {
      ctx.command = input.command
    }
    if ((toolName === 'Edit' || toolName === 'Write') && typeof input.file_path === 'string' && input.file_path.trim()) {
      const rootNorm = root ? normalizePath(root).replace(/\/+$/, '') + '/' : ''
      ctx.target = relativizePath(normalizePath(input.file_path), rootNorm)
      ctx.content =
        typeof input.content === 'string'
          ? input.content
          : typeof input.new_string === 'string'
            ? input.new_string
            : ''
    }
  } catch {
    /* fail-open — an unparseable input yields an empty ctx, matching nothing */
  }
  return ctx
}

/**
 * checkEvent({ evt, root, env, seen, journalDir, terminalId, gates }) →
 *   { warns:[{gateId, target, text}], fires:[{gateId, target}], seen }.
 *
 * Evaluates every applicable gate over the relativized tool input. ALL WARN — the
 * caller ALWAYS emits permissionDecision 'allow'. Per-session dedup mutates+returns
 * the seen-store (persistence is the caller's job, mirroring reflex.applyFatigue).
 * Every surviving fire is journaled (type 'gate') when journalDir+terminalId given.
 *
 * FAIL-OPEN: the whole body is wrapped; each gate's match is independently guarded
 * so one throwing gate never stops the others (behavior test 5, scorecard 7).
 *
 * SOFT-DENY (D-49.1-13): a gate carrying `softDeny` may set `out.deny = {gateId, text}`
 * when its arm env is set AND neither evidence nor a one-shot override allows it. The
 * deny is evaluated BEFORE per-session dedup so a repeated push keeps being denied. The
 * caller (cmdGatesCheck) consumes `out.deny` to emit permissionDecision 'deny'. Dormant
 * gates (arm env unset) never set it — the module stays WARN-only by default.
 *
 * @param {{evt?:object, root?:string, env?:object, seen?:object, journalDir?:string, terminalId?:string, gates?:Array, gatesDir?:string, headSha?:string, now?:number}} opts
 */
export function checkEvent(opts = {}) {
  const env = opts.env ?? {}
  const gates = Array.isArray(opts.gates) ? opts.gates : GATES
  const out = { warns: [], fires: [], seen: opts.seen && typeof opts.seen === 'object' ? opts.seen : {} }
  if (!out.seen.keys || typeof out.seen.keys !== 'object') out.seen.keys = {}

  try {
    // global kill-switch.
    if (truthy(env.SMA_GATES_DISABLE)) return out

    const evt = opts.evt || {}
    const toolName = typeof evt.tool_name === 'string' ? evt.tool_name : ''
    const input = evt.tool_input && typeof evt.tool_input === 'object' ? evt.tool_input : {}
    if (!toolName) return out

    const ctx = buildCtx(toolName, input, opts.root)

    for (const gate of gates) {
      try {
        if (!gate || !gate.id || !Array.isArray(gate.tools)) continue
        if (!gate.tools.includes(toolName)) continue
        if (gate.killEnv && truthy(env[gate.killEnv])) continue

        let hit = false
        try {
          hit = gate.match(ctx) === true
        } catch {
          hit = false // per-gate containment — a matcher throw is swallowed
        }
        if (!hit) continue

        // Soft-deny tier (D-49.1-13): evaluated BEFORE dedup so a repeated push keeps
        // being denied. Dormant unless the gate's arm env is set; fail-open inside.
        if (gate.softDeny && !out.deny) {
          const sd = evaluateSoftDeny(gate, {
            env,
            gatesDir: opts.gatesDir,
            headSha: opts.headSha,
            now: opts.now,
            journalDir: opts.journalDir,
            terminalId: opts.terminalId,
          })
          if (sd.deny) {
            out.deny = { gateId: gate.id, text: gate.softDeny.denyText || gate.warn }
          }
        }

        const target = ctx.target || (ctx.command ? ctx.command.slice(0, 200) : '')
        // per-session dedup: one fire per (gate, target).
        const key = `gate:${gate.id}::${target}`
        if (out.seen.keys[key]) {
          out.seen.keys[key] += 1
          continue
        }
        out.seen.keys[key] = 1

        out.warns.push({ gateId: gate.id, target, text: gate.warn })
        out.fires.push({ gateId: gate.id, target })

        // journal the fire (promotion evidence, D-49.1-13). Fail-open.
        if (opts.journalDir && opts.terminalId) {
          try {
            appendEvent(
              { type: 'gate', actors: [opts.terminalId], scope: target, detail: { gateId: gate.id, target } },
              { terminalId: opts.terminalId, journalDir: opts.journalDir },
            )
          } catch {
            /* a journal failure never blocks the gate */
          }
        }
      } catch {
        /* per-gate containment — never let one gate stop the loop */
      }
    }
  } catch {
    /* fail-open (C9) — a gate failure can NEVER wedge a session */
  }
  return out
}
