/**
 * excavate.mjs — the adoption wedge (49.3-03, D-49.3-09).
 *
 * `sma excavate` mines a STRANGER's git history and turns three classes of
 * evidence into CATCHES — «this reflex would have fired before this push, here»:
 *   1. commit ↔ revert pairs   (the git-standard «This reverts commit <sha>»)
 *   2. typo/oops fix chains     (a same-author fix-ish follow-up on a shared file)
 *   3. red-CI fix-forward chains (a fix+ci/build/test follow-up — the RED-CI PROXY)
 *
 * HONEST LIMITATION (module contract): there is NO network anywhere, so real CI
 * state is NEVER observed. The «red CI» class is INFERRED from fix-forward
 * evidence in the history itself — a commit whose subject says it fixes ci/build/
 * test and that follows a related change. It is a proxy, labeled as such.
 *
 * READ-ONLY GIT CONTRACT (T-49.3-03A, D-49.3-09): the ONLY git subcommands this
 * wedge ever runs are `log` (here, in mineRepo), and `rev-parse` + `remote
 * get-url` (in the CLI layer). Every invocation goes through a runner that takes
 * an ARGUMENT ARRAY and runs the git binary with the shell DISABLED — a hostile
 * commit subject/body/path can never reach a shell. Mined content is DATA end to
 * end: it is NEVER executed, eval'd, required, or interpolated into a command
 * string. No http/https/net/dns import exists in this module. No LLM call exists
 * in this module (deterministic history mining only — substrate law).
 *
 * DETERMINISM (D-49.3-07 posture): mineRepo has no Date.now and no randomness in
 * its ranking path — the same repo at the same HEAD yields deep-equal output. The
 * total order is: evidence strength (revert-pair > ci-fix-forward > typo-chain),
 * then author date descending, then sha lexical ascending.
 *
 * CORPUS PATH (T-49.3-03B): an approved catch reaches the memory corpus ONLY as a
 * draft under `.claude/memory/drafts/` through the SAME 3-condition promotion gate
 * predict.mjs's draftLessonFromMiss uses — never auto-promoted, never written to
 * the corpus root. Mined text is confined to a fenced untrusted-evidence block;
 * frontmatter values are sanitized. A promoted excavate lesson carries a
 * `use-when-pattern` precision glob so the shipped V2 reflex consumer fires on the
 * incident class (firingReady replays reflex.mjs's exact compileGlob matcher).
 *
 * Node built-ins only; the git runner is dependency-injectable so tests never
 * touch a real repo. Zero new packages.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { normalizePath, compileGlob } from './collision.mjs'
import { parseNote, serializeNote } from './frontmatter.mjs'

// Control-character git-log framing: record separator (0x1e) between commits,
// unit separator (0x1f) between fields. A trailing unit-sep after %b fences the
// body off from the --name-only file list that git appends.
const RS = '\x1e'
const US = '\x1f'

/** kind → short slug used in a draft filename (fixed internal enum — never mined). */
const KIND_SHORT = { 'revert-pair': 'revert', 'ci-fix-forward': 'cifix', 'typo-chain': 'typo' }

/** Evidence strength for the total-order ranking (higher = stronger). */
const STRENGTH = { 'revert-pair': 3, 'ci-fix-forward': 2, 'typo-chain': 1 }

/** Strict sha shape — 7 to 40 lowercase/upper hex, nothing else (path-traversal guard). */
const SHA_RE = /^[0-9a-f]{7,40}$/i

// ── git runner (default: argv-array, shell OFF) ──────────────────────────────

/**
 * defaultRunGit(repoPath) → (args[]) => stdout. The default read-only runner:
 * execFileSync against the git binary, cwd pinned to the target repo, shell
 * DISABLED (so no argument is ever shell-interpreted), a maxBuffer cap so a huge
 * repo cannot exhaust memory. Tests inject their own runGit and never hit this.
 *
 * @param {string} repoPath
 * @returns {(args:string[]) => string}
 */
export function defaultRunGit(repoPath) {
  return (args) =>
    execFileSync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      shell: false, // hostile strings can never reach a shell
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
}

// ── parser ───────────────────────────────────────────────────────────────────

/**
 * parseGitLog(raw) → commits[]. Parse the control-char pretty format produced by
 * mineRepo's log invocation. Tolerant (journal.mjs posture): a record missing
 * field separators, or carrying a non-hex sha, is SKIPPED — never fatal. Every
 * parsed string is inert DATA.
 *
 * @param {string} raw
 * @returns {Array<{sha,parents,date,email,subject,body,files:string[]}>}
 */
export function parseGitLog(raw) {
  const out = []
  const chunks = String(raw ?? '').split(RS)
  for (const chunk of chunks) {
    if (!chunk || !chunk.trim()) continue
    const fields = chunk.split(US)
    if (fields.length < 7) continue // malformed record — skip tolerantly
    const [sha, parents, date, email, subject, body] = fields
    if (!SHA_RE.test(String(sha).trim())) continue // bad sha — skip
    const fileBlock = fields[6]
    const files = fileBlock
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    out.push({
      sha: sha.trim(),
      parents: parents.trim(),
      date: date.trim(),
      email: email.trim(),
      subject, // NOT trimmed of internal content — inert text, preserved verbatim
      body,
      files,
    })
  }
  return out
}

// ── shared helpers ────────────────────────────────────────────────────────────

/** Union of two commits' file lists, insertion-ordered, de-duplicated. */
function unionFiles(a, b) {
  return [...new Set([...(a.files ?? []), ...(b.files ?? [])])]
}

/** Intersection of two commits' file lists (the shared files), insertion-ordered. */
function sharedFiles(a, b) {
  const setB = new Set(b.files ?? [])
  return (a.files ?? []).filter((f) => setB.has(f))
}

/** Whole-day gap between two ISO dates (0 when unparseable). */
function dayGap(d1, d2) {
  const t1 = Date.parse(d1)
  const t2 = Date.parse(d2)
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 0
  return Math.round(Math.abs(t2 - t1) / 86_400_000)
}

/** Whole-hour span between two ISO dates (0 when unparseable). */
function hourSpan(d1, d2) {
  const t1 = Date.parse(d1)
  const t2 = Date.parse(d2)
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 0
  return Math.round(Math.abs(t2 - t1) / 3_600_000)
}

/** ms epoch of an ISO date, or NaN. */
function ms(d) {
  return Date.parse(d)
}

/** The sha the CATCH's reflex would fire BEFORE (the break/original commit). */
function breakShaOf(c) {
  return c.breakSha ?? (Array.isArray(c.shas) ? c.shas[0] : null)
}

/** The paired fix/revert sha — the concrete artifact the catch points at. */
export function evidenceSha(c) {
  return c.fixSha ?? (Array.isArray(c.shas) ? c.shas[c.shas.length - 1] : null)
}

// ── miner 1: revert pairs ─────────────────────────────────────────────────────

/**
 * findRevertPairs(commits) → catches[]. Match the git-standard revert body
 * back-reference «This reverts commit <sha>» to an earlier commit; fallback to a
 * `Revert "<subject>"` subject whose inner subject equals an earlier commit's.
 *
 * @param {Array} commits
 * @returns {Array<{kind,breakSha,fixSha,files,daysBetween,subject,date}>}
 */
export function findRevertPairs(commits) {
  const out = []
  for (const c of commits) {
    let target = null

    const m = /This reverts commit ([0-9a-f]{7,40})/i.exec(c.body || '')
    if (m) {
      const prefix = m[1].toLowerCase()
      target =
        commits.find((o) => o !== c && String(o.sha).toLowerCase().startsWith(prefix)) || null
    }

    if (!target) {
      const sm = /^Revert[:\s]+["']?(.+?)["']?\s*$/i.exec(c.subject || '')
      if (sm) {
        const inner = sm[1].trim()
        target = commits.find((o) => o !== c && String(o.subject || '').trim() === inner) || null
      }
    }

    if (target && target.sha !== c.sha) {
      out.push({
        kind: 'revert-pair',
        breakSha: target.sha,
        fixSha: c.sha,
        files: unionFiles(target, c),
        daysBetween: dayGap(target.date, c.date),
        subject: target.subject ?? '',
        date: c.date,
      })
    }
  }
  return out
}

// ── miner 2: typo/oops chains ─────────────────────────────────────────────────

const FIX_ISH_RE = /(typo|oops|fixup|forgot|missed)/i

/**
 * findTypoChains(commits, {windowHours=48}) → catches[]. A same-author, fix-ish
 * follow-up touching a file shared with a recent earlier commit inside the
 * window. Disjoint file sets NEVER chain.
 *
 * @param {Array} commits
 * @param {{windowHours?:number}} [opts]
 * @returns {Array<{kind,shas,files,spanHours,subject,date}>}
 */
export function findTypoChains(commits, opts = {}) {
  const windowHours = opts.windowHours ?? 48
  const out = []
  for (const later of commits) {
    if (!FIX_ISH_RE.test(later.subject || '')) continue
    const tLater = ms(later.date)
    if (!Number.isFinite(tLater)) continue

    // the most recent earlier same-author commit sharing a file, inside the window
    let best = null
    for (const earlier of commits) {
      if (earlier === later) continue
      if ((earlier.email || '') !== (later.email || '')) continue
      const tEarlier = ms(earlier.date)
      if (!Number.isFinite(tEarlier) || tEarlier >= tLater) continue
      if (tLater - tEarlier > windowHours * 3_600_000) continue
      if (sharedFiles(earlier, later).length === 0) continue
      if (!best || ms(earlier.date) > ms(best.date)) best = earlier
    }
    if (!best) continue
    out.push({
      kind: 'typo-chain',
      shas: [best.sha, later.sha],
      files: sharedFiles(best, later),
      spanHours: hourSpan(best.date, later.date),
      subject: best.subject ?? '',
      date: later.date,
    })
  }
  return out
}

// ── miner 3: red-CI fix-forward chains (the inferred proxy) ───────────────────

const FIX_VERB_RE = /\b(fix|repair|correct|patch)\b/i
const CI_RE = /\b(ci|build|tests?|lint|type|typecheck|typescript|compile|pipeline)\b/i

/**
 * findFixForwardChains(commits, {windowHours=24}) → catches[]. A fix + ci/build/
 * test follow-up that either shares a file with a recent earlier commit inside
 * the window, OR names an earlier commit's sha (an explicit reference bypasses
 * the window). A standalone ci-fix with no antecedent yields nothing.
 *
 * @param {Array} commits
 * @param {{windowHours?:number}} [opts]
 * @returns {Array<{kind,breakSha,fixSha,files,signal,subject,date}>}
 */
export function findFixForwardChains(commits, opts = {}) {
  const windowHours = opts.windowHours ?? 24
  const out = []
  for (const later of commits) {
    const subj = later.subject || ''
    if (!FIX_VERB_RE.test(subj) || !CI_RE.test(subj)) continue
    const tLater = ms(later.date)

    // (a) explicit sha reference in subject+body (window-independent)
    let antecedent = null
    const refText = `${subj}\n${later.body || ''}`
    const shaRefs = refText.match(/\b[0-9a-f]{7,40}\b/gi) || []
    for (const ref of shaRefs) {
      const prefix = ref.toLowerCase()
      const hit = commits.find(
        (o) => o !== later && String(o.sha).toLowerCase().startsWith(prefix),
      )
      if (hit) {
        antecedent = hit
        break
      }
    }

    // (b) shared file within the window (most recent)
    if (!antecedent && Number.isFinite(tLater)) {
      for (const earlier of commits) {
        if (earlier === later) continue
        const tEarlier = ms(earlier.date)
        if (!Number.isFinite(tEarlier) || tEarlier >= tLater) continue
        if (tLater - tEarlier > windowHours * 3_600_000) continue
        if (sharedFiles(earlier, later).length === 0) continue
        if (!antecedent || ms(earlier.date) > ms(antecedent.date)) antecedent = earlier
      }
    }

    if (!antecedent) continue
    const signalMatch = CI_RE.exec(subj)
    out.push({
      kind: 'ci-fix-forward',
      breakSha: antecedent.sha,
      fixSha: later.sha,
      files: unionFiles(antecedent, later),
      signal: signalMatch ? signalMatch[0].toLowerCase() : 'ci',
      subject: antecedent.subject ?? '',
      date: later.date,
    })
  }
  return out
}

// ── orchestration ─────────────────────────────────────────────────────────────

/** Total-order comparator: strength desc, author date desc, sha lexical asc. */
function rankCatches(a, b) {
  const sa = STRENGTH[a.kind] ?? 0
  const sb = STRENGTH[b.kind] ?? 0
  if (sb !== sa) return sb - sa
  const da = ms(a.date)
  const db = ms(b.date)
  const na = Number.isFinite(da) ? da : 0
  const nb = Number.isFinite(db) ? db : 0
  if (nb !== na) return nb - na
  return String(evidenceSha(a) ?? '').localeCompare(String(evidenceSha(b) ?? ''))
}

/**
 * mineRepo({repoPath, runGit, limit=2000, since}) → {catches, stats}. ONE git log
 * invocation, parse, run the three miners, dedupe (a revert-pair absorbs a
 * fix-forward that overlaps its shas), total-order rank. Deterministic by
 * construction (no Date.now, no randomness).
 *
 * @param {{repoPath?:string, runGit?:Function, limit?:number, since?:string}} args
 * @returns {{catches:Array, stats:{commitsScanned:number, byKind:object}}}
 */
export function mineRepo(args = {}) {
  const { repoPath, since } = args
  const limit = Number.isFinite(args.limit) ? args.limit : 2000
  const runGit = args.runGit ?? defaultRunGit(repoPath)

  const logArgs = ['log', '--no-color', '--name-only', `--max-count=${limit}`]
  if (since) logArgs.push(`--since=${since}`)
  logArgs.push(`--pretty=format:${RS}%H${US}%P${US}%aI${US}%ae${US}%s${US}%b${US}`)

  const raw = runGit(logArgs)
  const commits = parseGitLog(raw)

  const revert = findRevertPairs(commits)
  const fixfwd = findFixForwardChains(commits)
  const typo = findTypoChains(commits)

  // dedupe: a revert-pair absorbs any fix-forward overlapping its shas.
  const revertShas = new Set()
  for (const r of revert) {
    if (r.breakSha) revertShas.add(r.breakSha)
    if (r.fixSha) revertShas.add(r.fixSha)
  }
  const fixKept = fixfwd.filter((f) => !revertShas.has(f.breakSha) && !revertShas.has(f.fixSha))

  const catches = [...revert, ...fixKept, ...typo].sort(rankCatches)

  const byKind = {}
  for (const c of catches) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1

  return { catches, stats: { commitsScanned: commits.length, byKind } }
}

// ── CATCH formatting + git links ──────────────────────────────────────────────

/**
 * commitUrl(remoteUrl, sha) → a provider commit URL, or null. Recognizes
 * github.com / gitlab.com / bitbucket.org in ssh and https remote forms and
 * strips a trailing `.git`. HONESTY RULE (must_haves): an unrecognized remote
 * returns null — a fabricated link is never produced (the formatter prints
 * sha-only instead).
 *
 * @param {string} remoteUrl
 * @param {string} sha
 * @returns {string|null}
 */
export function commitUrl(remoteUrl, sha) {
  if (!remoteUrl || !sha || !SHA_RE.test(String(sha))) return null
  const raw = String(remoteUrl).trim()

  // Normalize ssh (git@host:owner/repo(.git)) and https/ssh-url forms to host + path.
  let host = null
  let path = null
  const sshShort = /^[\w.-]+@([\w.-]+):(.+)$/.exec(raw)
  if (sshShort) {
    host = sshShort[1].toLowerCase()
    path = sshShort[2]
  } else {
    const url = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(raw)
    if (url) {
      host = url[1].toLowerCase()
      path = url[2]
    }
  }
  if (!host || !path) return null

  const repoPath = path.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  if (!repoPath) return null

  if (host === 'github.com') return `https://github.com/${repoPath}/commit/${sha}`
  if (host === 'gitlab.com') return `https://gitlab.com/${repoPath}/-/commit/${sha}`
  if (host === 'bitbucket.org') return `https://bitbucket.org/${repoPath}/commits/${sha}`
  return null
}

/** Short 7-char sha (or '?'). */
function short(sha) {
  return sha ? String(sha).slice(0, 7) : '?'
}

/** The human evidence label per catch kind. */
function evidenceLabel(c) {
  if (c.kind === 'revert-pair') return 'reverted-by'
  if (c.kind === 'ci-fix-forward') return 'fixed-forward-by'
  return 'fixed-by'
}

/**
 * formatCatches(catches, {remoteUrl}) → human numbered output. Per catch: the
 * counterfactual sentence naming the push the reflex would have fired before, the
 * evidence line with the paired sha and a git link (or sha-only for an unknown
 * remote), and the involved files. Ends with a one-line summary + next-step
 * pointer to the write-drafts flow and the promotion gate.
 *
 * @param {Array} catches
 * @param {{remoteUrl?:string}} [opts]
 * @returns {string}
 */
export function formatCatches(catches, opts = {}) {
  const remoteUrl = opts.remoteUrl ?? null
  const lines = []
  const list = Array.isArray(catches) ? catches : []
  list.forEach((c, i) => {
    const bSha = short(breakShaOf(c))
    const eSha = evidenceSha(c)
    const url = commitUrl(remoteUrl, eSha)
    const files = (c.files ?? []).map((f) => normalizePath(f)).join(', ')
    lines.push(
      `${i + 1}. [${c.kind}] this reflex would have fired before this push — before ${bSha} ${c.subject ?? ''}`.trimEnd(),
    )
    lines.push(`   ${evidenceLabel(c)}: ${short(eSha)}${url ? ' — ' + url : ''}`)
    if (files) lines.push(`   files: ${files}`)
  })
  lines.push('')
  lines.push(
    list.length
      ? `${list.length} catch(es) mined. Write reviewable drafts with --write-drafts, then promote through .claude/memory/drafts/ (the 3-condition gate).`
      : 'No catches mined from this history — nothing to draft.',
  )
  return lines.join('\n') + '\n'
}

// ── draft writer (through the promotion gate) ─────────────────────────────────

/** Collapse to one sanitized line: strip control chars + backticks, cap length. */
function sanitizeOneLine(s, cap = 180) {
  return String(s ?? '')
    .split('')
    .map((ch) => { const cc = ch.charCodeAt(0); return cc < 32 || cc === 127 ? ' ' : ch })
    .join('')
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap)
}

/** Sanitize a provenance token (repoLabel) — keep path-ish chars only. */
function sanitizeToken(s) {
  return String(s ?? '')
    .replace(/[^\w./@-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown'
}

/** Top-level path segments of the involved files → placeholder facet tags. */
function tagsFromFiles(files) {
  const segs = new Set()
  for (const f of files ?? []) {
    const norm = normalizePath(f)
    const top = norm.split('/').filter(Boolean)[0]
    if (top) segs.add(top.replace(/[^a-z0-9-]/g, ''))
  }
  return [...segs].filter(Boolean).slice(0, 4)
}

/** Longest common directory of two normalized dir paths. */
function commonDir(a, b) {
  const pa = a.split('/')
  const pb = b.split('/')
  const out = []
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) out.push(pa[i])
    else break
  }
  return out.join('/')
}

/**
 * globFromFiles(files) → a `use-when-pattern` precision glob over the incident's
 * file paths. The common directory (if any) becomes `<dir>/**`; a single
 * root-level file matches itself; otherwise `**`.
 */
function globFromFiles(files) {
  const norm = (files ?? []).map(normalizePath).filter(Boolean)
  if (!norm.length) return '**'
  const dirs = norm.map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''))
  let common = dirs[0]
  for (const d of dirs.slice(1)) common = commonDir(common, d)
  if (common) return `${common}/**`
  return norm.length === 1 ? norm[0] : '**'
}

/** The incident class phrase per catch kind (for the use-when sentence). */
function incidentClass(kind) {
  if (kind === 'revert-pair') return 'a change that later had to be reverted'
  if (kind === 'ci-fix-forward') return 'a change that broke CI and needed a fix-forward'
  return 'a change that needed an immediate typo/oops follow-up'
}

/**
 * draftLessonFromCatch({catch, repoLabel, dirs}) → {drafted, path, error?}.
 *
 * Mirrors predict.mjs draftLessonFromMiss EXACTLY in posture: drafts land under
 * `.claude/memory/drafts/`, are idempotent (an existing draft is never
 * overwritten), are NEVER auto-committed, and carry the 3-condition promotion-gate
 * header — the ONLY path into the corpus. The paired sha is validated against a
 * strict 7-40-hex regex BEFORE any filename construction (path-traversal guard).
 * Frontmatter is sanitized; mined text lives ONLY in a fenced untrusted block.
 *
 * @param {{catch:object, repoLabel:string, dirs?:{draftsDir?:string}}} args
 * @returns {{drafted:boolean, path:string|null, error?:string}}
 */
export function draftLessonFromCatch({ catch: c, repoLabel, dirs = {} }) {
  if (!c || typeof c !== 'object') return { drafted: false, path: null, error: 'no catch' }

  const sha = evidenceSha(c)
  // path-traversal guard: reject a sha with separators / non-hex BEFORE filename use.
  if (!SHA_RE.test(String(sha ?? ''))) {
    return { drafted: false, path: null, error: `invalid sha "${sha}" — refusing to build a filename` }
  }
  const sha7 = String(sha).slice(0, 7)
  const kindShort = KIND_SHORT[c.kind] ?? 'catch'
  const draftsDir = dirs.draftsDir ?? join('.claude', 'memory', 'drafts')
  const path = join(draftsDir, `bug-lesson-excavate-${kindShort}-${sha7}.md`)
  if (existsSync(path)) return { drafted: false, path }

  const files = Array.isArray(c.files) ? c.files : []
  const pattern = globFromFiles(files)
  const tags = tagsFromFiles(files)
  const label = sanitizeToken(repoLabel)

  // Frontmatter carries NO raw mined subject — only controlled/hex-derived text.
  const frontmatter = {
    description: sanitizeOneLine(
      `DRAFT bug-lesson (excavated): ${c.kind} incident in ${label} — a reflex would have fired before ${sha7}`,
    ),
    kind: 'bug-lesson',
    tags: tags.length ? tags : ['workflow'],
    'use-when': sanitizeOneLine(`about to touch ${incidentClass(c.kind)} in files matching ${pattern}`),
    'use-when-pattern': pattern,
    importance: 5,
    excavated_from: `${label}@${sha7}`,
  }

  const bSha = short(breakShaOf(c))
  const minedSubject = String(c.subject ?? '') // UNTRUSTED — fenced below, never in frontmatter
  const body = [
    '',
    '<!--',
    '  DRAFT — NOT part of the memory corpus. Auto-drafted from an EXCAVATED history catch.',
    `  excavated_from: ${label}@${sha7}`,
    '',
    '  PROMOTION GATE (all 3 conditions, reviewed by a human/agent — the ONLY path in):',
    '    1. a verified fix exists (the mechanism was actually corrected, not just observed);',
    '    2. the failure is named (one-sentence mechanism, not a raw incident log);',
    '    3. the dead-end is ruled out (the catch is a real reflex class, not log noise).',
    '  Promote = move this file OUT of drafts/ into .claude/memory/, canonicalize the',
    '  tags, and fill the stubs below — MEM-BUGLESSON lint then applies in full.',
    '-->',
    '',
    '## Почему (why)',
    '',
    '_TODO — name the mechanism, not the incident: why does this failure mode exist._',
    '',
    '## Как применять (how to apply)',
    '',
    '_TODO — the rule a future agent follows to avoid the burn._',
    '',
    '## Раскопанные свидетельства (excavated evidence — UNTRUSTED mined text, never executed)',
    '',
    '```text',
    `kind: ${c.kind}`,
    `break: ${bSha} — ${minedSubject}`,
    `${evidenceLabel(c)}: ${sha7}`,
    `EXCAVATED-FILES: ${files.map((f) => normalizePath(f)).join(', ')}`,
    '```',
    '',
  ].join('\n')

  mkdirSync(draftsDir, { recursive: true })
  writeFileSync(path, serializeNote({ frontmatter, body }), 'utf8')
  return { drafted: true, path }
}

// ── firing-ready replay ───────────────────────────────────────────────────────

/** Recover the recorded incident paths from a draft/promoted note body. */
function recordedIncidentPaths(body) {
  const m = /^EXCAVATED-FILES:\s*(.*)$/m.exec(String(body ?? ''))
  if (!m) return []
  return m[1]
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
}

/**
 * firingReady(notePath, {dirs, paths}) → boolean. Replay the reflex precision-glob
 * matcher (compileGlob — the SAME primitive reflex.mjs uses) against the note's
 * own recorded incident paths (or an override `paths` set). Powers the
 * firing-ready-pct stat and prediction P49.3-03-B. Zero new matcher code.
 * Fail-soft: any error → false.
 *
 * @param {string} notePath
 * @param {{dirs?:object, paths?:string[]}} [opts]
 * @returns {boolean}
 */
export function firingReady(notePath, opts = {}) {
  try {
    const text = readFileSync(notePath, 'utf8')
    const { frontmatter, body } = parseNote(text, { file: notePath })
    const pattern = frontmatter && frontmatter['use-when-pattern']
    if (!pattern) return false
    let re
    try {
      re = compileGlob(pattern)
    } catch {
      return false
    }
    const candidates =
      Array.isArray(opts.paths) && opts.paths.length ? opts.paths : recordedIncidentPaths(body)
    return candidates.map(normalizePath).some((p) => re.test(p))
  } catch {
    return false
  }
}

// ── stats instrument (numeric-last-line contract) ─────────────────────────────

/** True for a corpus note file (top-level *.md, excluding structural files). */
function isCorpusNote(file) {
  if (!file.endsWith('.md')) return false
  if (file === 'MEMORY.md' || file === 'ARCHIVE.md' || file === 'TAGS.md') return false
  if (/^INDEX-[^/\\]+\.md$/.test(file)) return false
  return true
}

/**
 * excavateStats({metric, corpusDir, repoPath, runGit, readdir, readFile}) → number.
 *
 * The instrument behind the --stats numeric-last-line contract (predict.mjs scorer
 * input shape, D-49.3-16). Metrics:
 *   - approved-lessons: count of top-level corpus notes carrying `excavated_from`.
 *   - firing-ready-pct: integer % of those notes where firingReady is true (0 when none).
 *   - determinism: mineRepo twice on the repo; 1 on serialized-equal output, else 0.
 *
 * All discovery is injectable so tests never touch a real corpus/repo.
 *
 * @param {object} args
 * @returns {number}
 */
export function excavateStats(args = {}) {
  const metric = args.metric
  const corpusDir = args.corpusDir ?? join('.claude', 'memory')
  const readdir = args.readdir ?? ((d) => safeReaddir(d))
  const readFile = args.readFile ?? ((p) => readFileSync(p, 'utf8'))

  if (metric === 'determinism') {
    try {
      const a = mineRepo({ repoPath: args.repoPath, runGit: args.runGit })
      const b = mineRepo({ repoPath: args.repoPath, runGit: args.runGit })
      return JSON.stringify(a) === JSON.stringify(b) ? 1 : 0
    } catch {
      return 0
    }
  }

  // Both remaining metrics enumerate promoted excavate notes (excavated_from present).
  let notes = []
  try {
    notes = readdir(corpusDir).filter(isCorpusNote)
  } catch {
    notes = []
  }
  const promoted = []
  for (const file of notes) {
    try {
      const { frontmatter } = parseNote(readFile(join(corpusDir, file)), { file })
      if (frontmatter && frontmatter.excavated_from) promoted.push(file)
    } catch {
      /* fail-soft per note */
    }
  }

  if (metric === 'approved-lessons') return promoted.length

  if (metric === 'firing-ready-pct') {
    if (!promoted.length) return 0 // honest empty state — never a vacuous 100
    let ready = 0
    for (const file of promoted) {
      if (firingReady(join(corpusDir, file), {})) ready += 1
    }
    return Math.round((ready / promoted.length) * 100)
  }

  return 0
}

/** readdirSync that yields [] on a missing dir (fail-soft). */
function safeReaddir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
