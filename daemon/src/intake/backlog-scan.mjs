/**
 * backlog-scan.mjs — the BACKLOG.md intake edge (Phase 9.5 Plan 07, Task 1;
 * D-9.5-06, D-9.5-10, D-9.5-11, Pitfall 13).
 *
 * WHAT IT IS: the SECONDARY intake path. `parseBacklogContent` is a faithful JS port
 * of the platform parser (src/crm/project-tracker/parse-backlog.ts) — SAME line
 * format, SAME structural ` — ` delimiter, SAME CRLF split, SAME «only under ##
 * Backlog» rule, and it NEVER throws. `scanBacklog` wraps it with a `git fetch` (so the
 * mini reads the founder's latest pushed BACKLOG, not a stale clone) + the DoR split +
 * a data-age label; `toTask` maps a ready line to the canonical task shape.
 *
 * INTAKE PRECEDENCE (Q2 default, pending grill): the roster button is the PRIMARY
 * intake (expedite, founder-explicit); the BACKLOG scan is SECONDARY, run per cadence
 * (config.backlogScanMinutes, default 60) after a `git fetch`. Pitfall 13 (BACKLOG.md
 * on the mini is stale — unpushed founder edits): the scan is age-labeled (dataAgeMs
 * from the last commit that touched BACKLOG.md) so the roster can show its freshness
 * rather than trusting a stale clone silently.
 *
 * THE DoR GATE (D-9.5-10 / D-9.5-11 item 5): «без оценки задачу нельзя выдавать в
 * работу». An open, non-promoted line is only enqueued when it carries a valid `sp:N`
 * estimate ≤ 13. Two notReady classes are SURFACED (never silently dropped, never
 * enqueued):
 *   - no `sp:N` tag           → reason «нет оценки»
 *   - `sp:N` > 13             → reason «>13 SP, нужна декомпозиция» (the E-lite gate;
 *                               full decomposition via «Создатель» forge kind
 *                               'decompose' is deferred to BL-105)
 *
 * REMI INTAKE (D-9.5-06): the Remi bridge is DEFERRED post-pilot. Wave-1 intake is the
 * BACKLOG scan + the roster button only.
 *
 * Node built-ins only where used at all; execGit / clock / fsImpl are dependency-
 * injected so the whole suite runs against fakes and never shells out or touches a repo.
 */

/** `- [ ] **BL-007** · Title — desc …` (open) / `- [x] …` (closed). Ported verbatim. */
const ITEM_RE = /^-\s+\[([ xX])\]\s+\*\*(BL-\d+)\*\*\s*(.*)$/

/** A `key:value` tag in backticks, e.g. `size:M` / `sp:3`. Ported verbatim. */
const TAG_RE = /`([a-z]+):([^`]+)`/gi

/** Size → priority (D-9.5-10 intake): S is smallest+fastest, fetch it first. */
const SIZE_PRIORITY = Object.freeze({ S: 2, M: 1, L: 0 })

/** The Fibonacci decomposition ceiling (D-9.5-10 запрет п.4): anything above waits. */
const SP_CEILING = 13

/**
 * parseBacklogContent(raw) → BacklogItem[]. A faithful port of the platform parser:
 * only lines under `## Backlog` are read; the trailing backtick tags are pulled out
 * first; title/description split on the first space-delimited dash. Adds `open`
 * (checkbox) and `storyPoints` (the `sp:N` tag as a number, else null). Never throws.
 *
 * @param {string} raw
 * @returns {Array<{id:string,title:string,description:string,open:boolean,size:(string|null),area:(string|null),added:(string|null),phase:(string|null),storyPoints:(number|null)}>}
 */
export function parseBacklogContent(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return []
  const lines = raw.split(/\r?\n/).map((l) => l.replace(/\r$/, ''))
  const items = []
  let inBacklog = false

  for (const line of lines) {
    if (/^##\s+Backlog\b/i.test(line)) {
      inBacklog = true
      continue
    }
    if (/^##\s+/.test(line) && !/^##\s+Backlog\b/i.test(line)) {
      inBacklog = false
      continue
    }
    if (!inBacklog) continue

    const m = line.match(ITEM_RE)
    if (!m) continue

    const open = m[1].toLowerCase() !== 'x'
    const id = m[2]
    let rest = m[3].trim()

    // Pull the trailing backtick tags out first so they don't pollute title/desc.
    const tags = {}
    rest = rest
      .replace(TAG_RE, (_full, key, value) => {
        tags[String(key).toLowerCase()] = String(value).trim()
        return ''
      })
      .trim()

    // Drop a leading "· " / "• " decoration.
    rest = rest.replace(/^[·•]\s*/, '').trim()

    // Split title — description on the first dash surrounded by spaces (structural ` — `).
    let title = rest
    let description = ''
    const dash = rest.match(/\s[—–-]\s/)
    if (dash && dash.index !== undefined) {
      title = rest.slice(0, dash.index).trim()
      description = rest.slice(dash.index + dash[0].length).trim()
    }

    const spNum = tags.sp !== undefined ? Number.parseInt(tags.sp, 10) : NaN

    items.push({
      id,
      title,
      description,
      open,
      size: tags.size ?? null,
      area: tags.area ?? null,
      added: tags.added ?? null,
      phase: tags.phase ?? null,
      storyPoints: Number.isFinite(spNum) ? spNum : null,
    })
  }

  return items
}

/**
 * laneForItem(item) → the execution lane heuristic (documented, deterministic —
 * D-9.5-10 план 07). The `— why` sentence + area drive it:
 *   - research  — a research-flavoured line (title/desc signals исследование/research)
 *   - paperwork — governance/os area or a .planning/docs-only line (no prod code)
 *   - prod      — everything else (the default; incl. size:S + area:tech)
 * Roster/return tasks bypass this — they carry their own lane.
 */
function laneForItem(item) {
  const text = `${item.title} ${item.description}`.toLowerCase()
  if (/ресёрч|ресерч|research|исслед|изуч/.test(text)) return 'research'
  const area = (item.area ?? '').toLowerCase()
  if (area === 'governance' || area === 'os' || /\.planning|документ|docs-only/.test(text)) return 'paperwork'
  return 'prod'
}

/**
 * toTask(item) → the canonical task shape (adapter.mjs TASK SHAPE) for a READY backlog
 * line. lane from the size/area heuristic; source 'backlog'; priority from size
 * (S=2/M=1/L=0, missing→0); storyPoints from the `sp:N` tag; acceptance from the
 * post-delimiter detail sentence (the ` — what & why` part) — the D-9.5-10 DoD contract
 * the worker reads. Falls back to the title when a line carries no detail so acceptance
 * is never empty (validateTask requires it for backlog).
 *
 * @param {object} item  a parseBacklogContent item
 * @returns {object} a canonical task
 */
export function toTask(item) {
  if (!item || typeof item !== 'object') throw new Error('toTask: item is required')
  const detail = item.description && String(item.description).trim() ? String(item.description).trim() : String(item.title ?? '')
  return {
    id: item.id,
    source: 'backlog',
    title: item.title,
    lane: laneForItem(item),
    priority: SIZE_PRIORITY[item.size] ?? 0,
    storyPoints: item.storyPoints ?? undefined,
    acceptance: detail,
  }
}

/**
 * scanBacklog({repoDir, execGit, clock, fsImpl}) → {items, notReady, dataAgeMs}.
 *
 * (1) `git fetch` via the injected execGit (freshness on the mini — Pitfall 13); a fetch
 *     failure (offline) is swallowed, the LOCAL BACKLOG is still read.
 * (2) read `<repoDir>/.planning/BACKLOG.md` via the injected fsImpl.
 * (3) parse; keep open, non-phase-promoted lines as intake candidates.
 * (4) DoR split: a valid `sp:N` ≤ 13 → a ready task (toTask); no tag → notReady
 *     «нет оценки»; `sp:N` > 13 → notReady «>13 SP, нужна декомпозиция». Neither notReady
 *     class is EVER placed in `items`.
 * (5) dataAgeMs from the last commit that touched BACKLOG.md (the roster's age label).
 *
 * @param {{repoDir:string, execGit:(args:string[])=>string, clock?:()=>number, fsImpl?:{readFileSync:Function}}} deps
 * @returns {Promise<{items:object[], notReady:Array<{id:string,title:string,reason:string}>, dataAgeMs:(number|null)}>}
 */
export async function scanBacklog({ repoDir, execGit, clock = Date.now, fsImpl } = {}) {
  if (typeof execGit !== 'function') throw new Error('scanBacklog requires an execGit function')
  const read = fsImpl && typeof fsImpl.readFileSync === 'function' ? fsImpl.readFileSync : null
  if (!read) throw new Error('scanBacklog requires fsImpl.readFileSync')

  // (1) freshness — best-effort fetch; never fatal (offline mini still scans local).
  try {
    execGit(['fetch', '--quiet'])
  } catch {
    /* offline — fall through to the local BACKLOG (labeled with its age) */
  }

  // (2) read the local BACKLOG.md (fail-open to an empty scan).
  const backlogPath = `${repoDir}/.planning/BACKLOG.md`
  let raw = ''
  try {
    raw = read(backlogPath, 'utf8')
  } catch {
    return { items: [], notReady: [], dataAgeMs: null }
  }

  // (3)+(4) parse + DoR split.
  const parsed = parseBacklogContent(raw)
  const items = []
  const notReady = []
  for (const item of parsed) {
    if (!item.open) continue // closed → out of intake
    if (item.phase) continue // promoted to a real phase → a phase card, not a queue task
    if (item.storyPoints == null) {
      notReady.push({ id: item.id, title: item.title, reason: 'не готово к выдаче: нет оценки' })
      continue
    }
    if (item.storyPoints > SP_CEILING) {
      notReady.push({ id: item.id, title: item.title, reason: '>13 SP, нужна декомпозиция' })
      continue
    }
    items.push(toTask(item))
  }

  // (5) data-age label from the last commit touching BACKLOG.md (Pitfall 13).
  let dataAgeMs = null
  try {
    const out = String(execGit(['log', '-1', '--format=%ct', '--', '.planning/BACKLOG.md'])).trim()
    const ts = Number.parseInt(out, 10)
    if (Number.isFinite(ts)) dataAgeMs = clock() - ts * 1000
  } catch {
    /* no git history for the file — leave the age unknown (null) */
  }

  return { items, notReady, dataAgeMs }
}
