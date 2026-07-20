/**
 * deleteme.mjs — the one-click OFF-RAMP (BL-162, v3.6). Reverses every artifact the
 * installer (bin/init.mjs) writes and PRESERVES the memory corpus: leaving must be
 * as cheap as arriving, or the install was a trap. The trust argument: an adopter
 * who can see the exit will walk through the entrance.
 *
 * What it removes (the 8 installer write targets, mirrored from bin/init.mjs):
 *   1. <config>/sma-core/                      (engine)
 *   2. <project>/scripts/sma/                  (runtime)
 *   3. <config>/agents/sma-*.md                (subagent definitions, sma- prefix ONLY)
 *   4. <config>/skills/sma-<cmd>/              (derived command skills)
 *   5. <config>/skills/gsd-<cmd>/              (ONLY dirs whose SKILL.md references sma-core —
 *                                               the transitional aliases; a user's own gsd dir survives)
 *   6. <config>/settings.json                  (SMA hook entries removed; statusLine restored
 *                                               from .sma/statusline/wrapped-command.json; every
 *                                               OTHER key byte-preserved — never-clobber)
 *   7. managed blocks in CLAUDE.md / AGENTS.md / .cursorrules / GEMINI.md
 *                                              (SMA:EXPORT + SMA:RULES spans cut; a corrupt
 *                                               anchor pair is REFUSED, file untouched)
 *   8. <project>/.sma/                         (runtime state) + the `.sma/` .gitignore line
 *
 * What it NEVER touches: `.claude/memory/**` (the corpus is the user's asset, not the
 * framework's), any settings.json key other than hooks/statusLine, any byte outside a
 * managed block, any file it did not recognize as installer-written.
 *
 * DI everywhere (the batch.mjs convention): every fs op rides an injected io so tests
 * never touch a real install. The CLI injects the real io.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ── managed-block anchor families ────────────────────────────────────────────
// SMA:EXPORT — the emit corpus block (emit.mjs). SMA:RULES — the installer rules
// block (claude-embed.mjs, BL-165). Tokens are a cross-module CONTRACT: deleteme
// strips both families without importing either producer.

/** The md-style (HTML comment) and txt-style (# >>>) anchor pairs per token. */
export const BLOCK_ANCHORS = [
  { token: 'SMA:EXPORT', style: 'md', beginPrefix: '<!-- SMA:EXPORT:BEGIN', end: '<!-- SMA:EXPORT:END -->' },
  { token: 'SMA:EXPORT', style: 'txt', beginPrefix: '# >>> SMA:EXPORT:BEGIN', end: '# <<< SMA:EXPORT:END' },
  { token: 'SMA:RULES', style: 'md', beginPrefix: '<!-- SMA:RULES:BEGIN', end: '<!-- SMA:RULES:END -->' },
  { token: 'SMA:RULES', style: 'txt', beginPrefix: '# >>> SMA:RULES:BEGIN', end: '# <<< SMA:RULES:END' },
]

/** The four instruction files that can carry managed blocks (mirror of EMIT_FORMATS). */
export const BLOCK_FILES = ['CLAUDE.md', 'AGENTS.md', '.cursorrules', 'GEMINI.md']

/**
 * cutBlock(text, {beginPrefix, end}) — remove ONE whole-line-anchored BEGIN..END span.
 * The splice law, inverted: exactly one BEGIN and one END with END after BEGIN cuts the
 * span (plus one adjacent blank line so no double gap is left); zero anchors is a no-op;
 * anything else (torn pair, duplicates) is CORRUPT and the text is returned untouched —
 * user content is never destroyed to make removal succeed.
 *
 * @returns {{text:string, action:'removed'|'none'|'corrupt'}}
 */
export function cutBlock(text, { beginPrefix, end }) {
  const lines = String(text ?? '').split('\n')
  const begins = []
  const ends = []
  lines.forEach((l, i) => {
    if (l.startsWith(beginPrefix)) begins.push(i)
    if (l === end) ends.push(i)
  })
  if (begins.length === 0 && ends.length === 0) return { text: String(text ?? ''), action: 'none' }
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) return { text: String(text ?? ''), action: 'corrupt' }
  const head = lines.slice(0, begins[0])
  const tail = lines.slice(ends[0] + 1)
  // collapse the seam: one blank line max between head and tail
  while (head.length && head[head.length - 1] === '' && tail.length && tail[0] === '') tail.shift()
  return { text: [...head, ...tail].join('\n'), action: 'removed' }
}

/**
 * stripManagedBlocks(text) — cut every known anchor family from one file's text.
 * @returns {{text:string, removed:string[], corrupt:string[]}} tokens removed / refused
 */
export function stripManagedBlocks(text) {
  let cur = String(text ?? '')
  const removed = []
  const corrupt = []
  for (const a of BLOCK_ANCHORS) {
    const res = cutBlock(cur, a)
    if (res.action === 'removed') {
      cur = res.text
      removed.push(`${a.token}(${a.style})`)
    } else if (res.action === 'corrupt') {
      corrupt.push(`${a.token}(${a.style})`)
    }
  }
  return { text: cur, removed, corrupt }
}

// ── settings.json surgery (never-clobber) ────────────────────────────────────

/** True when a hook command string is SMA's (path-separator tolerant). */
export function isSmaHookCommand(cmd) {
  return typeof cmd === 'string' && /scripts[\\/]+sma[\\/]+cli\.mjs/.test(cmd)
}

/**
 * removeSmaHooks(settings) — strip every SMA hook entry from settings.hooks IN PLACE:
 * the exact inverse of the installer's additive mergeHooks. A group that becomes empty
 * is dropped; an event whose group list becomes empty is dropped; a FOREIGN entry
 * sharing a group with an SMA entry survives byte-identical. Returns entries removed.
 */
export function removeSmaHooks(settings) {
  if (!settings || typeof settings.hooks !== 'object' || settings.hooks === null) return 0
  let removed = 0
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event]
    if (!Array.isArray(groups)) continue
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) continue
      const kept = g.hooks.filter((h) => !(h && isSmaHookCommand(h.command)))
      removed += g.hooks.length - kept.length
      g.hooks = kept
    }
    settings.hooks[event] = groups.filter((g) => g && Array.isArray(g.hooks) && g.hooks.length > 0)
    if (settings.hooks[event].length === 0) delete settings.hooks[event]
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks
  return removed
}

/** True when a statusLine command string is SMA's segment (mirror of cli.mjs). */
export function isSmaStatuslineCmd(cmd) {
  return typeof cmd === 'string' && /scripts[\\/]+sma[\\/]+cli\.mjs\s+statusline/.test(cmd)
}

/**
 * restoreStatusline(settings, wrapped) — the uninstall arm of the statusline contract
 * (wrapped-command.json, 9.3-07): hadNone -> delete the key; a stored original ->
 * verbatim restore; no record but OUR command present -> delete; anything else -> noop.
 * @returns {'restored'|'removed'|'noop'}
 */
export function restoreStatusline(settings, wrapped) {
  const w = wrapped && typeof wrapped === 'object' ? wrapped : null
  const existing = settings ? settings.statusLine : undefined
  const existingCmd = existing && typeof existing === 'object' ? existing.command : typeof existing === 'string' ? existing : null
  if (w && w.hadNone) {
    if (existing !== undefined && isSmaStatuslineCmd(existingCmd)) {
      delete settings.statusLine
      return 'removed'
    }
    return 'noop'
  }
  if (w && w.original !== undefined) {
    settings.statusLine = w.original
    return 'restored'
  }
  if (existing !== undefined && isSmaStatuslineCmd(existingCmd)) {
    delete settings.statusLine
    return 'removed'
  }
  return 'noop'
}

// ── the real io (CLI injects this; tests inject fakes) ──────────────────────

export const REAL_IO = {
  exists: (p) => existsSync(p),
  isDir: (p) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  },
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, text) => writeFileSync(p, text, 'utf8'),
  readdir: (p) => readdirSync(p),
  rm: (p) => rmSync(p, { recursive: true, force: true, maxRetries: 3 }),
}

// ── plan + apply ─────────────────────────────────────────────────────────────

/**
 * applyDeleteme({project, configDir, io, dryRun}) — plan and (unless dryRun) reverse
 * the install. Every action is independent and fail-soft: one locked file never
 * aborts the rest; the outcome is reported per action, honestly.
 *
 * @returns {{actions: Array<{kind:string, target:string, status:string, detail?:string}>,
 *            preserved: string[]}}
 */
export function applyDeleteme({ project, configDir, io = REAL_IO, dryRun = true } = {}) {
  const actions = []
  const act = (kind, target, fn, detail) => {
    if (dryRun) {
      actions.push({ kind, target, status: 'would-remove', ...(detail ? { detail } : {}) })
      return
    }
    try {
      const status = fn()
      actions.push({ kind, target, status: status ?? 'removed', ...(detail ? { detail } : {}) })
    } catch (err) {
      actions.push({ kind, target, status: 'error', detail: String(err && err.message ? err.message : err) })
    }
  }

  // 1. engine
  const core = join(configDir, 'sma-core')
  if (io.exists(core)) act('engine', core, () => void io.rm(core))

  // 2. runtime
  const runtime = join(project, 'scripts', 'sma')
  if (io.exists(runtime)) act('runtime', runtime, () => void io.rm(runtime))

  // 3. agents (sma- prefix only — a user's own agent files survive)
  const agentsDir = join(configDir, 'agents')
  if (io.isDir(agentsDir)) {
    for (const f of io.readdir(agentsDir)) {
      if (f.startsWith('sma-') && f.endsWith('.md')) act('agent', join(agentsDir, f), () => void io.rm(join(agentsDir, f)))
    }
  }

  // 4 + 5. skills: every sma-* dir; a gsd-* dir ONLY when its SKILL.md references sma-core
  const skillsDir = join(configDir, 'skills')
  if (io.isDir(skillsDir)) {
    for (const d of io.readdir(skillsDir)) {
      const p = join(skillsDir, d)
      if (!io.isDir(p)) continue
      if (d.startsWith('sma-')) {
        act('skill', p, () => void io.rm(p))
      } else if (d.startsWith('gsd-')) {
        let body = ''
        try {
          body = io.readFile(join(p, 'SKILL.md'))
        } catch {
          body = ''
        }
        if (body.includes('sma-core')) act('alias-skill', p, () => void io.rm(p))
      }
    }
  }

  // 6. settings.json — hooks out, statusLine restored, EVERY other key preserved.
  const settingsPath = join(configDir, 'settings.json')
  if (io.exists(settingsPath)) {
    let settings = null
    try {
      settings = JSON.parse(String(io.readFile(settingsPath)).replace(/^﻿/, ''))
    } catch {
      settings = null
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      actions.push({ kind: 'settings', target: settingsPath, status: 'skipped-unparseable', detail: 'not valid JSON — remove the SMA hooks and statusLine key by hand' })
    } else {
      let wrapped = null
      try {
        wrapped = JSON.parse(io.readFile(join(project, '.sma', 'statusline', 'wrapped-command.json')))
      } catch {
        wrapped = null
      }
      const hooksRemoved = removeSmaHooks(settings)
      const slStatus = restoreStatusline(settings, wrapped)
      if (hooksRemoved > 0 || slStatus !== 'noop') {
        act('settings', settingsPath, () => {
          io.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n')
          return `hooks-removed:${hooksRemoved} statusline:${slStatus}`
        }, `hooks-removed:${hooksRemoved} statusline:${slStatus}`)
      }
    }
  }

  // 7. managed blocks — cut SMA:EXPORT + SMA:RULES spans; corrupt pair -> refuse that file.
  for (const f of BLOCK_FILES) {
    const p = join(project, f)
    if (!io.exists(p)) continue
    let text = ''
    try {
      text = io.readFile(p)
    } catch {
      continue
    }
    const { text: next, removed, corrupt } = stripManagedBlocks(text)
    if (corrupt.length) {
      actions.push({ kind: 'managed-block', target: p, status: 'skipped-corrupt', detail: `torn anchor pair: ${corrupt.join(', ')} — file untouched` })
      continue
    }
    if (removed.length && next !== text) {
      act('managed-block', p, () => {
        io.writeFile(p, next)
        return `removed:${removed.join(',')}`
      }, `removed:${removed.join(',')}`)
    }
  }

  // 8. .sma/ state (AFTER the statusline restore read above) + the .gitignore line.
  const smaDir = join(project, '.sma')
  if (io.exists(smaDir)) act('state', smaDir, () => void io.rm(smaDir))
  const gitignore = join(project, '.gitignore')
  if (io.exists(gitignore)) {
    try {
      const gi = io.readFile(gitignore)
      const lines = gi.split('\n')
      const kept = lines.filter((l) => l.trim() !== '.sma/')
      if (kept.length !== lines.length) {
        act('gitignore', gitignore, () => {
          io.writeFile(gitignore, kept.join('\n'))
          return 'line-removed'
        }, '.sma/ line')
      }
    } catch {
      /* fail-soft — a .gitignore read error never blocks the off-ramp */
    }
  }

  return { actions, preserved: [join(configDir, 'memory'), 'every settings.json key except hooks/statusLine', 'every byte outside managed blocks'] }
}

// ── selftest (the P-BL-162 falsifiable check) ────────────────────────────────

/**
 * deletemeSelftest({tmpRoot}) — build a full fake install in a temp dir (foreign hook
 * sharing a group with SMA's, a wrapped foreign statusline, a CLAUDE.md carrying user
 * prose + BOTH managed blocks, a memory note, a foreign skill), apply deleteme for
 * real, and assert: every installer artifact is gone, every user asset survives, and
 * a second apply is a clean no-op. Returns 1 on full pass, else 0. Never throws.
 */
export function deletemeSelftest({ tmpRoot }) {
  try {
    const project = tmpRoot
    const configDir = join(project, '.claude')
    const w = (p, text) => {
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, text, 'utf8')
    }
    // fake install
    w(join(configDir, 'sma-core', 'workflows', 'sma-start.md'), 'engine')
    w(join(project, 'scripts', 'sma', 'cli.mjs'), '// runtime')
    w(join(configDir, 'agents', 'sma-executor.md'), 'agent')
    w(join(configDir, 'agents', 'keep-me.md'), 'user agent')
    w(join(configDir, 'skills', 'sma-start', 'SKILL.md'), 'skill')
    w(join(configDir, 'skills', 'gsd-quick', 'SKILL.md'), 'alias over sma-core/workflows/quick.md')
    w(join(configDir, 'skills', 'my-own', 'SKILL.md'), 'user skill')
    w(join(configDir, 'memory', 'feedback_lesson.md'), 'the corpus survives')
    const settings = {
      model: 'opus',
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node scripts/sma/cli.mjs session-start', timeout: 10 }] }],
        PreToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [
              { type: 'command', command: 'node scripts/sma/cli.mjs pre', timeout: 5 },
              { type: 'command', command: 'node my-own-guard.mjs', timeout: 5 },
            ],
          },
        ],
      },
      statusLine: { type: 'command', command: 'node scripts/sma/cli.mjs statusline', padding: 0 },
    }
    w(join(configDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n')
    w(join(project, '.sma', 'statusline', 'wrapped-command.json'), JSON.stringify({ command: 'node user-line.mjs', original: { type: 'command', command: 'node user-line.mjs' }, hadNone: false }))
    w(
      join(project, 'CLAUDE.md'),
      [
        '# My project',
        '',
        'User prose that must survive byte-identical.',
        '',
        '<!-- SMA:RULES:BEGIN v1 installed by sma-framework -->',
        'rules body',
        '<!-- SMA:RULES:END -->',
        '',
        '<!-- SMA:EXPORT:BEGIN v1 fmt=CLAUDE.md commit=' + '0'.repeat(40) + ' -->',
        'corpus body',
        '<!-- SMA:EXPORT:END -->',
        '',
        'Trailing user prose.',
        '',
      ].join('\n'),
    )
    w(join(project, '.gitignore'), 'node_modules/\n.sma/\ndist/\n')

    const run = () => applyDeleteme({ project, configDir, io: REAL_IO, dryRun: false })
    const first = run()
    if (first.actions.some((a) => a.status === 'error')) return 0

    // installer artifacts gone
    if (existsSync(join(configDir, 'sma-core'))) return 0
    if (existsSync(join(project, 'scripts', 'sma'))) return 0
    if (existsSync(join(configDir, 'agents', 'sma-executor.md'))) return 0
    if (existsSync(join(configDir, 'skills', 'sma-start'))) return 0
    if (existsSync(join(configDir, 'skills', 'gsd-quick'))) return 0
    if (existsSync(join(project, '.sma'))) return 0
    // user assets survive
    if (!existsSync(join(configDir, 'memory', 'feedback_lesson.md'))) return 0
    if (!existsSync(join(configDir, 'agents', 'keep-me.md'))) return 0
    if (!existsSync(join(configDir, 'skills', 'my-own', 'SKILL.md'))) return 0
    const after = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
    if (after.model !== 'opus') return 0
    if (JSON.stringify(after).includes('scripts/sma/cli.mjs')) return 0
    const pre = after.hooks && after.hooks.PreToolUse
    if (!pre || pre[0].hooks.length !== 1 || pre[0].hooks[0].command !== 'node my-own-guard.mjs') return 0
    if (!after.statusLine || after.statusLine.command !== 'node user-line.mjs') return 0
    const claude = readFileSync(join(project, 'CLAUDE.md'), 'utf8')
    if (claude.includes('SMA:EXPORT') || claude.includes('SMA:RULES')) return 0
    if (!claude.includes('User prose that must survive byte-identical.') || !claude.includes('Trailing user prose.')) return 0
    const gi = readFileSync(join(project, '.gitignore'), 'utf8')
    if (gi.includes('.sma/') || !gi.includes('node_modules/') || !gi.includes('dist/')) return 0

    // idempotence: a second run plans nothing destructive and errors nothing
    const second = run()
    if (second.actions.some((a) => a.status === 'error')) return 0
    if (second.actions.some((a) => a.kind === 'engine' || a.kind === 'runtime' || a.kind === 'state')) return 0
    return 1
  } catch {
    return 0
  }
}
