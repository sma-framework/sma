/**
 * digest.mjs — the session-start cross-terminal digest (B12). Turns multi-terminal
 * awareness from archaeology (manual `git log` + reading .sma/ by hand) into a briefing:
 * «Что изменилось с вашего последнего heartbeat» — commits since MY last beat, who claims
 * what now (named identities), the live push signal, and low-calibration escalations.
 *
 * Design invariants:
 *   - PURE assembly over INJECTED sources (a git-log runner, registry sessions, the push
 *     claim, calibration escalations) — zero I/O of its own beyond the injected runner, so
 *     tests never touch the network. The CLI wires the real sources.
 *   - Per-source try/catch: ONE failing source degrades to a PARTIAL digest, never a throw
 *     (T-49.1-37 — session-start is HOOK_FACING and must never wedge a window).
 *   - Read-only git ONLY (the injected runner issues `git log`, a read subcommand; the
 *     founder-reserved deploy op is never invoked here — V1 posture).
 *   - Budgeted: the assembled block is clamped to DIGEST_BUDGET_BYTES (UTF-8 bytes) so the
 *     injected SessionStart context stays small; an empty ledger omits its section (honest
 *     empty state, never a fake zero line).
 *
 * Node built-ins only; zero npm deps.
 */

import { execFileSync } from 'node:child_process'

import { displayIdentity } from './registry.mjs'

/** Hard byte budget of the whole assembled digest block (B12; acceptance-checked). */
export const DIGEST_BUDGET_BYTES = 1536

/**
 * defaultGitLogRunner(sinceIso, o) -> raw `git log` output (author-tab-subject lines)
 * for commits since an ISO timestamp. Read-only subcommand only (V1 posture). Injectable
 * execGit for tests; a git error propagates to the caller's try/catch (partial digest).
 */
export function defaultGitLogRunner(sinceIso, o = {}) {
  const execGit = o.execGit ?? ((args) => execFileSync('git', args, { encoding: 'utf8' }))
  const args = ['log', '--pretty=format:%an\t%s']
  if (sinceIso) args.splice(1, 0, `--since=${sinceIso}`)
  return execGit(args)
}

/**
 * sinceLastHeartbeat({self, gitLog}) -> [{author, subject}] for commits authored after
 * self.lastHeartbeat. `gitLog` is INJECTED — either the raw string output or a runner
 * fn(sinceIso)->string. Any error (git failure, no runner) yields [] (partial
 * degradation, never a throw).
 *
 * @param {{self?:{lastHeartbeat?:string}, gitLog?:string|Function}} o
 * @returns {Array<{author:string, subject:string}>}
 */
export function sinceLastHeartbeat(o = {}) {
  try {
    const since = o.self && o.self.lastHeartbeat ? o.self.lastHeartbeat : null
    let raw = ''
    if (typeof o.gitLog === 'function') raw = o.gitLog(since) ?? ''
    else if (typeof o.gitLog === 'string') raw = o.gitLog
    else return []

    const commits = []
    for (const line of String(raw).split('\n')) {
      if (!line.trim()) continue
      const tab = line.indexOf('\t')
      const author = tab >= 0 ? line.slice(0, tab).trim() : 'unknown'
      const subject = (tab >= 0 ? line.slice(tab + 1) : line).trim()
      commits.push({ author: author || 'unknown', subject })
    }
    return commits
  } catch {
    return [] // partial degradation — a commits failure never breaks the digest
  }
}

/** Group commits by author name (the resolvable «terminal-name» key) -> Map<name, count>. */
function groupByAuthor(commits) {
  const map = new Map()
  for (const c of commits) map.set(c.author, (map.get(c.author) ?? 0) + 1)
  return map
}

/** Byte length under UTF-8 (budget is measured in bytes, not chars). */
function bytes(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * buildDigest(o) -> a budgeted RU text block «Что изменилось с вашего последнего
 * heartbeat», or '' when there is nothing worth surfacing. Assembles four sections, each
 * behind its own try/catch (T-49.1-37 partial degradation):
 *   1. commits since my last heartbeat, grouped by author;
 *   2. other live sessions' claims with their NAMED identity («P52 Anna: <scope>»);
 *   3. the live push signal («Отправка в origin: <who> готовит <version>»);
 *   4. low-calibration escalations («истории ошибок в области <domain>») — omitted when
 *      the ledger is empty (honest empty state).
 *
 * @param {object} o
 * @param {{lastHeartbeat?:string, terminalId?:string}} [o.self]
 * @param {string|Function} [o.gitLog]         injected git-log output/runner
 * @param {Array} [o.sessions]                 OTHER sessions [{holderIdentity,label,phase,scope}]
 * @param {{live?:boolean, who?:string, plannedVersion?:string}} [o.pushClaim]
 * @param {Array<{domain:string,n:number,misses:number}>} [o.escalations]
 * @param {number} [o.maxBytes]                budget override (default DIGEST_BUDGET_BYTES)
 * @returns {string}
 */
export function buildDigest(o = {}) {
  const maxBytes = Number.isFinite(o.maxBytes) ? o.maxBytes : DIGEST_BUDGET_BYTES
  const sections = []

  // (1) commits since last heartbeat, grouped by author.
  try {
    const commits = sinceLastHeartbeat({ self: o.self, gitLog: o.gitLog })
    if (commits.length) {
      const parts = [...groupByAuthor(commits).entries()].map(([a, n]) => `${a}: ${n}`)
      sections.push(`Коммиты с прошлого heartbeat: ${commits.length} (${parts.join(', ')})`)
    }
  } catch {
    /* partial */
  }

  // (2) other live sessions' claims with their named identity.
  try {
    const others = Array.isArray(o.sessions) ? o.sessions : []
    const lines = []
    for (const s of others) {
      if (!s) continue
      const id = displayIdentity({ holderIdentity: s.holderIdentity, label: s.label, phase: s.phase })
      const scopeDesc =
        (s.scope && typeof s.scope.description === 'string' && s.scope.description.trim()) ||
        (s.scope && Array.isArray(s.scope.globs) && s.scope.globs.join(', ')) ||
        ''
      lines.push(scopeDesc ? `${id}: ${scopeDesc}` : id)
    }
    if (lines.length) sections.push(`Терминалы: ${lines.join('; ')}`)
  } catch {
    /* partial */
  }

  // (3) live push signal.
  try {
    const pc = o.pushClaim
    if (pc && pc.live) {
      const who = pc.who ? pc.who : 'терминал'
      const ver = pc.plannedVersion ? ` ${pc.plannedVersion}` : ''
      sections.push(`Отправка в origin: ${who} готовит${ver}`)
    }
  } catch {
    /* partial */
  }

  // (4) calibration escalations — omitted entirely when the ledger is empty.
  try {
    const esc = Array.isArray(o.escalations) ? o.escalations : []
    for (const e of esc) {
      if (!e || !e.domain) continue
      const detail = Number.isFinite(e.misses) && Number.isFinite(e.n) ? ` (${e.misses} из ${e.n})` : ''
      sections.push(`истории ошибок в области ${e.domain}${detail}`)
    }
  } catch {
    /* partial */
  }

  if (!sections.length) return ''

  const lines = ['Что изменилось с вашего последнего heartbeat:', ...sections]
  // Budget: drop trailing sections until under the byte budget (header always survives).
  while (lines.length > 1 && bytes(lines.join('\n')) > maxBytes) lines.pop()
  let text = lines.join('\n')
  // Final hard clamp for a single oversized line (never emit past the budget).
  if (bytes(text) > maxBytes) text = Buffer.from(text, 'utf8').slice(0, maxBytes).toString('utf8')
  return text
}
