#!/usr/bin/env node
/**
 * verify-rebrand.mjs — integrity gate for the gsd -> sma atomic rebrand.
 *
 * Written for the rebrand, grown since into the leak gate. The checks:
 *   (a) DISPATCH: every subagent_type value in sma-core/workflows/** resolves
 *       to an existing sma-core/agents/<name>.md (broken dispatch is invisible
 *       until a command runs).
 *   (b) ZERO RESIDUE: no old brand token (gsd / GSD / Gsd, case-sensitive
 *       alternation — avoids camelCase false positives like "learningsDelete")
 *       anywhere in sma-core/** contents or filenames, outside the fixed
 *       exclusions (the aliases/ layer intentionally carries the old prefix).
 *   (c) COLORS: every sma-core/agents/sma-*.md frontmatter carries a color field.
 *   (d) INTERNAL IDS: no internal register id (threat `T-<phase>-<n>`, decision
 *       `D-<phase>-<n>`, deferred item `D-<phase>-DEFER-<n>`, private backlog
 *       `SB-<n>`) survives in a PUBLISHED surface. These ids are house
 *       bookkeeping; read by an adopter they are noise that references a
 *       register the adopter cannot open. A STRING LITERAL — the one surface a
 *       user is shown directly — is held to the wider shape set of (f) as well.
 *   (e) INTERNAL PLAN SHAPES: no bare house plan id (a plan/phase word followed
 *       by a compound `9.5-10` id, by a wildcard `49.x` id, or by a zero-padded
 *       slash pair `05/09`) survives in published markdown. Same reason as (d):
 *       it points at a register the adopter cannot read.
 *   (f) SOURCE COMMENTS: no internal register id survives in the COMMENT TEXT of
 *       shipped `.mjs/.cjs/.ts/.tsx`. Armed 2026-08-06 — see the scope block.
 *
 * WHAT "PUBLISHED" MEANS HERE — the git-tracked set, and the reason for it.
 * A push publishes the REPOSITORY, not the npm tarball: `files[]` in package.json
 * is the narrower shop window, and scanning only it left the agent-facing markdown
 * under `sma-core/**` and the root test config unread while both become
 * world-readable the moment `main` is pushed. So checks (d), (e) and (f) enumerate
 * `git ls-files`. If git cannot be run, the tool SAYS SO on stderr and falls back
 * to a filesystem walk — a surface it cannot enumerate is a finding, not a pass.
 *
 * Inside that set, per file class:
 *   - MARKDOWN (`*.md`), wherever it lives: every line. Markdown has no "comment"
 *     class — every line ships as content. This now includes `sma-core/**`, whose
 *     earlier exclusion ("agent-facing instructions, not adopter-facing output")
 *     was the hole: an agent-facing file is still a published file.
 *   - ROOT BUILD/TEST CONFIG (`*.config.{mjs,js,cjs,ts}` at the repo root): the
 *     whole file, comments included. A handful of short hand-written files whose
 *     comments ARE their documentation — there is no archaeology to lose.
 *   - OTHER SHIPPED CODE: string literals AND comment text — the two are read by
 *     different checks ((d) and (f)) with different exclusions, but neither class
 *     is exempt any more. See the next paragraph for the decision behind (f).
 *   - `description` in any package.json (the npm shop window).
 *
 * SOURCE COMMENTS — DECIDED 2026-08-06, and this is the paragraph that used to say
 * the question was open. It is not open. Comment text in shipped source carries no
 * internal filing number; a reason is written out in WORDS instead. The ground: the
 * source IS a published surface — this product ships as readable `.mjs` inside the
 * adopter's own repository, which is a stronger form of publication than a README —
 * and a number that indexes a register only the vendor can open explains nothing to
 * the person reading it. The archaeology objection was real and was paid off by the
 * sweep, not waived: each id was replaced by the reasoning it stood for, so what the
 * comment now says is MORE than the number said. Check (f) is what keeps the answer
 * from decaying: the shapes are banned mechanically, in every shipped source file,
 * tests included. The same law binds this file (see the self-exclusion below).
 *
 * What is deliberately NOT scanned, and why:
 *   - DATA paths — `fixtures/`, `assets/demos/`: synthetic and sample ids are
 *     sanctioned there (a demo of decision-locking must show decision ids). The
 *     exclusion is by PATH, never by shape: a `__tests__` file is data in its
 *     literals and prose in its comments, so it is exempt from (d) and read by (f).
 *   - THIS FILE. Its patterns ARE the shapes, so scanning it would report the
 *     detector as the leak. The prose around them obeys the same rule as any other
 *     comment: the ids that appear below are pattern specimens, nothing else.
 *   - `BL-<n>`: NOT an internal-only shape. It is the PRODUCT's own backlog item
 *     id — minted and parsed by `scripts/sma/lib/batch.mjs`, documented in
 *     `docs/VENDOR-LEDGER.md`. Banning it would fail the product's own vocabulary.
 *   - UNHYPHENATED short codes (`B14`, `P4`, `C9`, `R5`, `S1`, `A4`): a residue of
 *     the same class, left uncovered on purpose and knowingly. Every armed shape
 *     below is anchored on a hyphen followed by a digit; these have neither, so the
 *     pattern that caught them would also catch cell references, sizes, model names
 *     and half the prose in the tree. Removed by hand where found, not by rule.
 *     (The hyphenated short prefixes — `FI-9`, `CR-01`, `WR-02` — ARE armed: the
 *     digit anchor makes them safe to ban, and they were the loudest of the class.)
 *   - an UNPADDED slash pair (`phases 51/52`, `plans 12/13`): the same variant of
 *     (e), left uncovered on purpose. The zero padding is what separates a house
 *     cross-reference from progress notation ("15/15 plans executed", "Phase
 *     63/7"); without it the two shapes are the same three characters and a ban
 *     costs more false positives than the leak is worth. The padded half IS armed
 *     — see PLAN_PAIR below for the three discriminators it leans on.
 *   - bare plan/phase numbering (`9.4-01`) STANDING ALONE — check (e) picks up only
 *     the narrower case where a plan/phase word introduces it.
 *   - prediction ids (`P9.3-12-A`) IN PROSE — they are legitimate data in the
 *     documented `prediction` / `tripwire` table columns, where removing them
 *     would break the traceability that makes a prediction checkable. They are
 *     banned from string literals only, where they are noise.
 *
 * Exit 0 = rebrand intact. Exit 1 = violations listed on stderr.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CORE = path.join(ROOT, 'sma-core')
const AGENTS = path.join(CORE, 'agents')
const WORKFLOWS = path.join(CORE, 'workflows')

const OLD_TOKEN = /gsd|GSD|Gsd/ // case-sensitive alternation, not /gsd/i
const ATTRIBUTION_LINE = /derived from gsd-core/i

const errors = []

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (path.relative(CORE, p).split(path.sep)[0] === 'aliases') continue // the old prefix lives here on purpose
      walk(p, out)
    } else if (entry.isFile()) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

/** Unfiltered recursive walk (check (d) does its own exclusions). */
function walkAll(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walkAll(p, out)
    } else if (entry.isFile()) out.push(p)
  }
  return out
}

// ---- (a) dispatch integrity -------------------------------------------------
const agentFiles = new Set(fs.readdirSync(AGENTS).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')))
const DISPATCH_RE = /subagent_type\s*[=:]\s*"([A-Za-z0-9._-]+)"/g
let dispatchCount = 0
for (const file of walk(WORKFLOWS)) {
  const text = fs.readFileSync(file, 'utf8')
  for (const m of text.matchAll(DISPATCH_RE)) {
    const name = m[1]
    if (name === 'general-purpose') continue // built-in harness agent, not ours
    dispatchCount++
    if (!agentFiles.has(name)) {
      errors.push(`DISPATCH: ${rel(file)} dispatches "${name}" but sma-core/agents/${name}.md does not exist`)
    }
    if (/^gsd-/.test(name)) {
      errors.push(`DISPATCH: ${rel(file)} still dispatches old-brand agent "${name}"`)
    }
  }
}

// ---- (b) zero residue -------------------------------------------------------
let residueHits = 0
for (const file of walk(CORE)) {
  if (OLD_TOKEN.test(path.basename(file))) {
    errors.push(`RESIDUE(filename): ${rel(file)}`)
    residueHits++
  }
  const buf = fs.readFileSync(file)
  if (buf.includes(0)) continue // binary
  const lines = buf.toString('utf8').split('\n')
  lines.forEach((line, i) => {
    if (ATTRIBUTION_LINE.test(line)) return // attribution stays verbatim (fixed exclusion)
    if (OLD_TOKEN.test(line)) {
      errors.push(`RESIDUE: ${rel(file)}:${i + 1}: ${line.trim().slice(0, 120)}`)
      residueHits++
    }
  })
}

// ---- (d) internal register ids in published surfaces ------------------------
/**
 * Internal register id. Three house shapes:
 *   `T-9.1-43` / `D-11-08`  — threat and decision ids;
 *   `D-11-DEFER-05`         — the deferred-item register. The WORD segment is why
 *                             the older pattern walked past it: that pattern wants
 *                             digits straight after the phase number, and this
 *                             shape has a word there;
 *   `SB-031`                — the private product backlog.
 * NOT bare plan numbering (`9.4-01`), which is public, and NOT `BL-<n>`, which is
 * the product's own backlog id format (see the header).
 */
const INTERNAL_ID = /\b(?:[TDQ]-\d+(?:\.\d+)?-(?:[A-Z]{2,}-)?\d+[a-z]?|SB-\d{3})\b/

/**
 * REGISTER_ID — the wider shape set, used where the sweep of 2026-08-06 reached:
 * source COMMENTS (check (f)) and user-facing STRING LITERALS (check (d)). It is a
 * superset of INTERNAL_ID above, which stays as the markdown pattern.
 *
 * EVERY shape is anchored on a hyphen-plus-digit. That anchor is the whole design:
 * it is what keeps a lint rule name (`PRED-POSTEDIT`, `MEM-CONTRADICT`,
 * `PROFILE-SECRET`), an SPDX identifier (`BSD-2-Clause` — the `D` there has a letter
 * in front of it, so no boundary), a step range (`steps 9-12`), a version (`5.2.0`),
 * a date and a receipt id (`id: R1`) out of the net, and it is why a generic
 * placeholder (`D-XX`) reads as prose rather than as a leak.
 *
 * Shape by shape:
 *   decision / question — `D-11-08`, `D-9.2-11`, `D-9.5-04a`, `D-11-DEFER-22`. The
 *     WORD segment is the half an earlier pattern walked past.
 *   threat            — `T-9.1-03`, `T-11-11-01`, `T-02-01`.
 *   private backlog   — `SB-031`. Three digits, so a bare `SB-1` is not assumed.
 *   short registers   — `LP-2`, `FI-9`, `WR-02`, `CR-01`.
 *   grill / consequence — the COMPOUND form only (`CH-9.4-06-1`, `CONS-9.2-07-A`,
 *     `CONS-09-01-A`): a phase segment plus a counter. The BARE form is the
 *     ADOPTER'S vocabulary and stays legal — `CONS-1` is an id in the
 *     `consequences:` block of the adopter's own plan frontmatter (schema
 *     {id, trigger, blocks, until}, enforced by the CONS-SCHEMA lint rule), and
 *     `CH-1` labels a step in the shipped grill demo. Banning either would fail
 *     the product on its own words, which is the same mistake `BL-<n>` avoids.
 *   generation tag    — `SMA-3`, with ONE carve-out: `SMA-2` names the LEGACY
 *     PRODUCT this repo imports from (`sma-core/bin/lib/sma2-import.cjs` exists to
 *     read it), so it is product vocabulary, not a filing number.
 *   house phase       — `49.9-11` and the Russian phrase «фаза 49», the two ways the
 *     vendor's own phase numbering shows up in prose.
 *
 * NOT here, deliberately: `BL-<n>`, which is the PRODUCT's backlog id — minted and
 * parsed by `scripts/sma/lib/batch.mjs`, documented in `docs/VENDOR-LEDGER.md`.
 * Banning it would fail the product on its own vocabulary.
 */
const REGISTER_SHAPES = [
  String.raw`[DQ]-\d+(?:\.\d+)?-(?:\d+[a-z]?|[A-Z][A-Z0-9]*(?:-\d+[a-z]?)?)`,
  String.raw`T-\d+(?:\.\d+)?-\d+(?:-\d+)?[a-z]?`,
  String.raw`SB-\d{3}`,
  String.raw`(?:LP|FI)-\d+`,
  String.raw`(?:CH|CONS)-\d+(?:\.\d+)?-\d+(?:-[A-Za-z0-9]+)?`,
  String.raw`(?:WR|CR)-\d{2}`,
  String.raw`SMA-[013-9](?!\d)`,
  String.raw`49\.\d+-\d+`,
]
const REGISTER_ID = new RegExp(
  String.raw`(?<![\p{L}\p{N}.])(?:${REGISTER_SHAPES.join('|')})(?![\p{L}\p{N}])` +
    String.raw`|(?<![\p{L}])фаз[аыуе]\s+49(?![\p{L}\p{N}])`,
  'u',
)
/**
 * Prediction register id (`P9.3-12-A`). Applied to CODE STRING LITERALS ONLY, not
 * to docs: a prediction id is legitimate DATA in a documented table column (the
 * `prediction` column of the instruments table, the `tripwire` column of
 * docs/VENDOR-LEDGER.md), where deleting it would destroy the traceability that
 * makes the prediction checkable. In printed output it is pure noise, and the
 * count there is currently zero — this rule keeps it zero.
 */
const PREDICTION_ID = /\bP\d+\.\d+-\d+(?:-[A-Za-z0-9]+)?\b/

/** Sanctioned for DATA: synthetic ids belong in a test's literals and a demo's payload. */
const ID_EXCLUDED = /(^|\/)(node_modules|__tests__|fixtures|assets\/demos)(\/|$)/
/**
 * The same list minus `__tests__`, for check (f). A test file's LITERALS are data —
 * a decision-counter test has to name a decision id to test it — but its COMMENTS
 * are ordinary prose written for whoever reads the suite, and the sweep covered them.
 */
const COMMENT_EXCLUDED = /(^|\/)(node_modules|fixtures|assets\/demos)(\/|$)/
/** Shipped source: read for string literals by (d), for comment text by (f). */
const CODE_EXT = /\.(?:mjs|js|cjs|ts|tsx)$/
/** This file's own path, relative to ROOT — the detector is not its own leak. */
const SELF = rel(fileURLToPath(import.meta.url))
/** Root build/test config: short, hand-written, its comments are its documentation. */
const ROOT_CONFIG = /^[^/]+\.config\.(?:mjs|js|cjs|ts)$/

/**
 * The published surface: everything git tracks. A push publishes the repository,
 * so the git index — not `files[]` — is the honest enumeration. Fail LOUD, never
 * quiet: a surface this tool cannot enumerate is a finding.
 */
function publishedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return out.split('\0').filter(Boolean)
  } catch (e) {
    console.error(`WARNING: \`git ls-files\` failed (${String(e.message).split('\n')[0]}) — falling back to a filesystem walk, which may include untracked files`)
    return walkAll(ROOT).map(rel)
  }
}

/**
 * splitSource() — ONE tokenizer, two consumers.
 *
 * Checks (d) and (f) ask opposite questions of the same file ("what is inside a
 * quote" / "what is outside the code"), and answering them with two independent
 * line heuristics is how a scanner ends up disagreeing with itself. So the file is
 * walked once, character by character, and every line is returned twice over: the
 * text of its comments, and the text of its string literals.
 *
 * It is a tokenizer, not a parser, and the trade-offs are chosen so that every
 * failure mode is a MISS, never a false alarm:
 *   - a backslash skips the next character, in code as well as inside a literal, so
 *     an escaped slash in a regex (`/https:\/\//`) cannot open a phantom comment;
 *   - single- and double-quoted state is dropped at the end of every line, because
 *     those literals cannot span one. An apostrophe inside a regex character class
 *     therefore costs at most the rest of ITS line, not the rest of the file;
 *   - backtick state IS carried across lines, because template literals genuinely
 *     span them — which is also how a multi-line help string finally gets read.
 * A regex literal is not tracked as its own state; the two rules above are what keep
 * that cheap approximation from turning into noise.
 */
function splitSource(text) {
  const lines = text.split('\n')
  const comments = []
  const literals = []
  let inBlock = false
  let inTemplate = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let comment = ''
    let literal = ''
    let quote = '' // per-line by construction: a quoted literal does not survive its own line
    let j = 0
    while (j < line.length) {
      const c = line[j]
      const d = line[j + 1]
      if (inBlock) {
        if (c === '*' && d === '/') { inBlock = false; j += 2; continue }
        comment += c
        j++
        continue
      }
      if (inTemplate || quote) {
        if (c === '\\') { literal += line.slice(j, j + 2); j += 2; continue }
        if (inTemplate ? c === '`' : c === quote) { inTemplate = false; quote = ''; j++; continue }
        literal += c
        j++
        continue
      }
      if (c === '\\') { j += 2; continue }
      if (c === '/' && d === '/') { comment += line.slice(j + 2); break }
      if (c === '/' && d === '*') { inBlock = true; j += 2; continue }
      if (c === '`') { inTemplate = true; j++; continue }
      if (c === "'" || c === '"') { quote = c; j++; continue }
      j++
    }
    if (comment.trim()) comments.push({ n: i + 1, text: comment })
    if (literal.trim()) literals.push({ n: i + 1, text: literal })
  }
  return { comments, literals }
}

// ---- plan-shape patterns (shared by (d) string literals and (e) markdown) --
/**
 * A house plan id in PUBLISHED markdown. The leak shape is a plan/phase word
 * introducing a compound id (`plan 9.5-10`, `плана 9.1-04`, `phase 9.1-26`), a
 * wildcard one (`plan 49.x`), or a zero-padded slash pair (`plans 05/09`). The
 * number names a register no adopter can read.
 *
 * The match is CONTEXTUAL — the word has to introduce the number — which is what
 * keeps the false-positive floor honest. Deliberately NOT flagged:
 *   - semver (`5.1.0`), dates (`20.07.2026`), ports (`:5433`): none of them carry
 *     the `N.N-NN` / `N.x` shape, and none is introduced by a plan word;
 *   - bare `Phase 2.1`, `/sma-plan-phase 5.1`: the ADOPTER'S OWN numbering, which
 *     is documented product vocabulary in the templates, workflows and help;
 *   - a bare id nobody introduces (`- [ ] 02.1-01: [Description]`, the documented
 *     plan-file naming convention) — same reason.
 */
const PLAN_WORD = String.raw`(?:plans?|phases?|план\p{L}*|фаз\p{L}*)`
/**
 * Words that turn a number pair into PROGRESS. Used as a negative lookahead on the
 * slash-pair branch only — a cross-reference is followed by punctuation or prose,
 * a count is followed by what is being counted.
 */
const PROGRESS_WORD = String.raw`(?:complete|completed|done|executed|passed|verified|green|remaining|left|answered|tasks?|steps?|plans?|phases?|выполн\p{L}*|заверш\p{L}*|готов\p{L}*|осталось|шаг\p{L}*|задач\p{L}*)`
/**
 * ARMED 2026-08-05 — the slash-pair cross-reference (`plans 05/09`, «планы 05/09»).
 * It was deliberately unarmed until now because the naive two-number pair collides
 * with progress notation, which this repository's own markdown is full of ("3/3
 * plans executed", "Phase 63/7", "Plans: 3/5 complete", "2/2 plans complete").
 * Three discriminators, read off that real corpus, keep the two apart:
 *
 *   1. ZERO PADDING. A house plan number is padded to two digits (`05`, `09`); a
 *      count never is. Across every git-tracked markdown file exactly two padded
 *      pairs exist, and one of them was the offender this rule was armed for.
 *   2. WORD ORDER. The plan word has to INTRODUCE the pair, which is inherited
 *      from check (e)'s contextual shape. Progress puts the word after the count
 *      ("15/15 plans executed") or behind a colon ("Plans: 3/5"), and neither
 *      reaches this pattern.
 *   3. WHAT FOLLOWS. A pair trailed by a counting word is progress even when it is
 *      padded, and an identical pair (`05/05`) is a count of itself, never a
 *      cross-reference between two plans. Both are excluded by name.
 *
 * A pair followed by another `/` is a date or a longer id, not this shape.
 */
const PLAN_PAIR = String.raw`(?!(?<pp>\d{2})/\k<pp>)(?:0\d/\d{2}|\d{2}/0\d)(?!/)(?!\s+${PROGRESS_WORD})`
const PLAN_SHAPE = String.raw`(?:\d{1,2}\.\d{1,2}-\d{1,3}|\d{1,2}\.x|${PLAN_PAIR})`
const INTERNAL_PLAN = new RegExp(
  // trailing guard: not a longer number, and not the `02.1-01-PLAN.md` file name
  String.raw`(?<![\p{L}\p{N}])${PLAN_WORD}\s*[№#]?\s*${PLAN_SHAPE}(?![\p{L}\p{N}]|-[A-Za-z])`,
  'iu',
)

/**
 * The same rule, one notch wider, for STRING LITERALS — a line the adopter can
 * actually be shown. The extra shape is the BARE pair (`plan 11-14`), and it is
 * armed here and NOWHERE else for one reason: `Phase 2-01` is the adopter's OWN
 * documented heading format, so in markdown and in comments (which explain that
 * format) the shape is product vocabulary and banning it would be a lie. A printed
 * line is different — nothing the product says to a user needs a plan number in it.
 *
 * Two discriminators keep even that narrow arming honest:
 *   1. the plan word must be SINGULAR (`plan 11-14`, not `plans 11-14`) — a plural
 *      introduces a RANGE ("plans 11-14", "steps 9-12"), which is ordinary English;
 *   2. the second number is two digits, which is how the register writes them.
 */
const PLAN_WORD_SINGULAR = String.raw`(?:plan|phase|план\p{L}*|фаз\p{L}*)`
const INTERNAL_PLAN_STRING = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:${PLAN_WORD}\s*[№#]?\s*${PLAN_SHAPE}` +
    String.raw`|${PLAN_WORD_SINGULAR}\s*[№#]?\s*\d{1,2}-\d{2})(?![\p{L}\p{N}]|-[A-Za-z])`,
  'iu',
)

const PUBLISHED = publishedFiles()
let idScanned = 0
let mdScanned = 0
{
  for (const r of PUBLISHED) {
    if (ID_EXCLUDED.test(r)) continue
    const abs = path.join(ROOT, r)
    if (!fs.existsSync(abs)) continue // tracked, but deleted in the worktree
    const isDoc = r.endsWith('.md')
    const isCode = CODE_EXT.test(r)
    const isPkg = path.basename(r) === 'package.json'
    if (!isDoc && !isCode && !isPkg) continue
    const buf = fs.readFileSync(abs)
    if (buf.includes(0)) {
      // A NUL byte makes a text scan meaningless — and skipping SILENTLY once hid
      // five runtime files from this check. A file the scan cannot read is a
      // finding, not an exemption: put the byte in a \u0000 escape and it scans.
      errors.push(`INTERNAL-ID: ${r}: carries raw NUL bytes, so check (d) cannot read it — replace them with \\u0000 escapes`)
      continue
    }
    const text = buf.toString('utf8')
    idScanned++
    if (isDoc) mdScanned++
    // Markdown and root config are read WHOLE, comments included; other shipped
    // code is read through its string literals only — header's scope block says why.
    if (isDoc || (isCode && ROOT_CONFIG.test(r))) {
      if (!INTERNAL_ID.test(text)) continue
      text.split('\n').forEach((line, i) => {
        if (INTERNAL_ID.test(line)) errors.push(`INTERNAL-ID: ${r}:${i + 1}: ${line.trim().slice(0, 120)}`)
      })
    } else if (isPkg) {
      if (!INTERNAL_ID.test(text)) continue
      let pkg
      try { pkg = JSON.parse(text) } catch { continue }
      if (typeof pkg.description === 'string' && INTERNAL_ID.test(pkg.description)) {
        errors.push(`INTERNAL-ID: ${r}: package description carries an internal register id`)
      }
    } else {
      // A user-facing string is the loudest surface there is — it gets the WIDE
      // shape set, the prediction ids, and the contextual plan id. No cheap
      // pre-filter here: the tokenizer reads the file once either way, and the
      // pre-filter is exactly what silently skipped a shape the last time it was
      // asked about one pattern out of two.
      for (const h of splitSource(text).literals) {
        if (!REGISTER_ID.test(h.text) && !PREDICTION_ID.test(h.text) && !INTERNAL_PLAN_STRING.test(h.text)) continue
        errors.push(`INTERNAL-ID(string): ${r}:${h.n}: ${h.text.trim().slice(0, 120)}`)
      }
    }
  }
}

// ---- (f) internal register ids in shipped source comments -------------------
// DECIDED 2026-08-06 (see the header): a comment in shipped source explains itself
// in words, never by a filing number. Comment text only — the literals on the same
// line belong to check (d), and a test's literals are data that stays.
let commentFilesScanned = 0
for (const r of PUBLISHED) {
  if (!CODE_EXT.test(r)) continue
  if (COMMENT_EXCLUDED.test(r)) continue
  if (r === SELF) continue // the detector is not its own leak
  const abs = path.join(ROOT, r)
  if (!fs.existsSync(abs)) continue
  const buf = fs.readFileSync(abs)
  if (buf.includes(0)) continue // already reported as unreadable by check (d)
  commentFilesScanned++
  for (const h of splitSource(buf.toString('utf8')).comments) {
    if (!REGISTER_ID.test(h.text)) continue
    errors.push(`COMMENT-ID: ${r}:${h.n}: ${h.text.trim().slice(0, 120)}`)
  }
}

// ---- (e) internal plan shapes in published markdown -------------------------
// Same surface as check (d): the git-tracked set, not `files[]`. The npm allowlist
// was the narrower of the two and left published markdown unread.
let shippedDocsScanned = 0
for (const r of PUBLISHED) {
  if (!r.endsWith('.md')) continue
  if (ID_EXCLUDED.test(r)) continue
  const abs = path.join(ROOT, r)
  if (!fs.existsSync(abs)) continue
  shippedDocsScanned++
  const text = fs.readFileSync(abs, 'utf8')
  if (!INTERNAL_PLAN.test(text)) continue
  text.split('\n').forEach((line, i) => {
    if (INTERNAL_PLAN.test(line)) errors.push(`PLAN-ID: ${r}:${i + 1}: ${line.trim().slice(0, 120)}`)
  })
}


// ---- (c) colors -------------------------------------------------------------
let colorCount = 0
for (const name of fs.readdirSync(AGENTS).sort()) {
  if (!name.endsWith('.md')) continue
  const text = fs.readFileSync(path.join(AGENTS, name), 'utf8')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m || !/^color:\s*\S+/m.test(m[1])) {
    errors.push(`COLOR: sma-core/agents/${name} has no color field in frontmatter`)
  } else colorCount++
}

// ---- report -----------------------------------------------------------------
console.log(`dispatch sites checked: ${dispatchCount}`)
console.log(`agents with color: ${colorCount}/${[...fs.readdirSync(AGENTS)].filter((f) => f.endsWith('.md')).length}`)
console.log(`residue hits: ${residueHits}`)
console.log(`published files scanned for internal ids: ${idScanned} (of which markdown: ${mdScanned})`)
console.log(`published markdown scanned for internal plan shapes: ${shippedDocsScanned}`)
console.log(`shipped source files scanned for comment-text ids: ${commentFilesScanned}`)
if (errors.length) {
  console.error(`\nFAIL — ${errors.length} violation(s):`)
  for (const e of errors) console.error('  ' + e)
  process.exit(1)
}
console.log('OK — rebrand intact (dispatch resolves, zero residue, colors applied, no internal ids in published markdown / root config / user-facing strings / source comments, no internal plan shapes in published markdown)')
