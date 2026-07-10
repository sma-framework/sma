/**
 * memory-preview.mjs — the onboarding memory-graph preview (BL-174, v3.6).
 *
 * During /sma-start TEACH the user hears "layered memory: CORE + periphery +
 * reflexes" as THEORY. This module makes it CONCRETE: an ASCII graph, rendered
 * in the terminal, of how SMA will lay out the memory of THEIR OWN repository —
 * areas derived from the real file tree (`git ls-files`), reflex candidates
 * mined from the real git history (excavate's mineRepo), the existing corpus
 * counted if one is already there.
 *
 * The substrate law applies end to end: read-only git via an argv-array runner
 * (shell OFF), no network, no LLM, no clock in the rendered bytes — same repo at
 * the same HEAD renders byte-identically (that determinism is the P-BL-174
 * falsifiable check). An empty/непроинициализированный repo degrades to the
 * fresh-project preview, never a crash: the preview runs during onboarding,
 * where a crash costs the adopter.
 *
 * Consume-never-reimplement (D-49.3-02): history mining IS excavate.mineRepo;
 * this module adds only the ls-files area fold and the renderer.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultRunGit, mineRepo } from './excavate.mjs'

// ── analysis ─────────────────────────────────────────────────────────────────

/** Fold a file list into top-level areas; descend ONE level into a dominant dir. */
export function foldAreas(files) {
  const top = new Map()
  for (const f of files) {
    const seg = f.includes('/') ? f.slice(0, f.indexOf('/')) : '(root)'
    top.set(seg, (top.get(seg) ?? 0) + 1)
  }
  // a single dir holding >50% of files hides the real structure — split it one level
  const total = files.length
  const dominant = [...top.entries()].find(([seg, n]) => seg !== '(root)' && n / Math.max(1, total) > 0.5)
  if (dominant) {
    const [dom] = dominant
    top.delete(dom)
    for (const f of files) {
      if (!f.startsWith(dom + '/')) continue
      const rest = f.slice(dom.length + 1)
      const seg = rest.includes('/') ? `${dom}/${rest.slice(0, rest.indexOf('/'))}` : dom
      top.set(seg, (top.get(seg) ?? 0) + 1)
    }
  }
  return [...top.entries()]
    .filter(([seg]) => seg !== '(root)')
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 6)
    .map(([dir, count]) => ({ dir, count, tag: dir.replace(/[^A-Za-z0-9а-яА-Я_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root' }))
}

/**
 * analyzeRepo({repoDir, runGit, io}) — the deterministic input fold. Every failure
 * degrades (empty file list, zero catches, no corpus) — never throws.
 *
 * @returns {{repoDir, empty:boolean, fileCount:number, areas:Array, byKind:object,
 *            catchTotal:number, corpus:{notes:number, present:boolean}}}
 */
export function analyzeRepo({ repoDir, runGit, io } = {}) {
  const run = runGit ?? defaultRunGit(repoDir)
  const read = io ?? { exists: existsSync, readdir: readdirSync, readFile: (p) => readFileSync(p, 'utf8') }

  let files = []
  try {
    files = String(run(['ls-files']))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    files = []
  }

  let byKind = {}
  let catchTotal = 0
  try {
    const mined = mineRepo({ repoPath: repoDir, runGit: run })
    byKind = mined.stats.byKind ?? {}
    catchTotal = mined.catches.length
  } catch {
    byKind = {}
    catchTotal = 0
  }

  let notes = 0
  let present = false
  try {
    const memDir = join(repoDir ?? '.', '.claude', 'memory')
    if (read.exists(memDir)) {
      present = true
      notes = read.readdir(memDir).filter((f) => f.endsWith('.md') && !/^(MEMORY|ARCHIVE|TAGS)\.md$/.test(f) && !/^INDEX-/.test(f)).length
    }
  } catch {
    present = false
    notes = 0
  }

  return {
    repoDir: repoDir ?? '.',
    empty: files.length === 0,
    fileCount: files.length,
    areas: foldAreas(files),
    byKind,
    catchTotal,
    corpus: { notes, present },
  }
}

// ── renderer ─────────────────────────────────────────────────────────────────

const W = 64 // inner width of every box line

function boxTop(title) {
  const total = W + 4 // every box row renders exactly W+4 chars wide
  let t = ` ${title} `
  if (t.length > total - 3) t = `${t.slice(0, total - 5)}… `
  return `┌─${t}${'─'.repeat(Math.max(0, total - 3 - t.length))}┐`
}
function boxLine(text) {
  const t = String(text ?? '')
  const clipped = t.length > W ? `${t.slice(0, W - 1)}…` : t
  return `│ ${clipped}${' '.repeat(Math.max(0, W - clipped.length))} │`
}
function boxBottom() {
  return `└${'─'.repeat(W + 2)}┘`
}
function connector() {
  return `${' '.repeat(Math.floor((W + 4) / 2))}│`
}

const L = {
  en: {
    title: (d) => `SMA memory preview — ${d}`,
    subtitle: 'how this repository\'s memory will split (read-only, zero network)',
    core: 'CORE — always loaded, every session',
    coreBody: ['project thesis · stack · the hard rules', 'starts at ~5-8 notes, seeded by /sma-start'],
    index: 'MEMORY.md — the generated index',
    periphery: 'PERIPHERY — pulled by tag, only when the task needs it',
    peripheryEmpty: 'areas appear as your file tree grows',
    areaLine: (a) => `area:${a.tag.padEnd(22)} ${String(a.count).padStart(5)} files → notes on demand`,
    load: 'load:  node scripts/sma/cli.mjs load --tags <area>',
    reflexes: 'REFLEXES — lessons that fire AT the act (WARN before a repeat)',
    mined: (n) => `mined from YOUR git history by excavate: ${n} catch(es)`,
    minedZero: 'no catches in this history yet — reflexes accrue from real misses',
    kind: { 'revert-pair': 'commit ↔ revert pairs', 'fix-forward': 'red-CI fix-forward chains', 'typo-chain': 'typo/oops fix chains' },
    kindLine: (label, n) => ` · ${label}: ${n}`,
    drafts: (n) => `→ ${n} bug-lesson draft(s) via: node scripts/sma/cli.mjs excavate --write-drafts`,
    corpus: (n) => `existing corpus detected: ${n} note(s) — the preview ADDS to it, nothing is replaced`,
    emptyRepo: 'this directory has no git-tracked files yet — the fresh-project layout is shown',
  },
  ru: {
    title: (d) => `Превью памяти SMA — ${d}`,
    subtitle: 'как разложится память этого репозитория (только чтение, ноль сети)',
    core: 'ЯДРО — грузится всегда, в каждой сессии',
    coreBody: ['тезис проекта · стек · жёсткие правила', 'старт: ~5-8 заметок, засеивает /sma-start'],
    index: 'MEMORY.md — генерируемый индекс',
    periphery: 'ПЕРИФЕРИЯ — подтягивается по тегу, только когда нужна задаче',
    peripheryEmpty: 'области появятся по мере роста дерева файлов',
    areaLine: (a) => `area:${a.tag.padEnd(22)} ${String(a.count).padStart(5)} файлов → заметки по запросу`,
    load: 'загрузка:  node scripts/sma/cli.mjs load --tags <область>',
    reflexes: 'РЕФЛЕКСЫ — уроки, срабатывающие В МОМЕНТ действия (WARN до повтора)',
    mined: (n) => `добыто из ВАШЕЙ истории git (excavate): находок ${n}`,
    minedZero: 'находок в истории пока нет — рефлексы копятся из реальных промахов',
    kind: { 'revert-pair': 'пары коммит ↔ revert', 'fix-forward': 'цепочки чинки красного CI', 'typo-chain': 'цепочки typo/oops' },
    kindLine: (label, n) => ` · ${label}: ${n}`,
    drafts: (n) => `→ черновиков bug-lesson: ${n} — node scripts/sma/cli.mjs excavate --write-drafts`,
    corpus: (n) => `найден существующий корпус: заметок ${n} — превью ДОБАВЛЯЕТ, ничего не заменяет`,
    emptyRepo: 'в каталоге нет файлов под git — показана раскладка свежего проекта',
  },
}

/**
 * renderPreview(analysis, {lang}) — pure text render (LF). No clock, no locale
 * formatting, no randomness: byte-identical for the same analysis.
 */
export function renderPreview(a, { lang = 'en' } = {}) {
  const t = L[lang] ?? L.en
  const out = []
  out.push(t.title(a.repoDir))
  out.push(t.subtitle)
  out.push('')
  if (a.empty) out.push(`(${t.emptyRepo})`, '')

  out.push(boxTop(t.core))
  for (const line of t.coreBody) out.push(boxLine(line))
  if (a.corpus.present && a.corpus.notes > 0) out.push(boxLine(t.corpus(a.corpus.notes)))
  out.push(boxBottom())
  out.push(connector())
  out.push(`${' '.repeat(Math.floor((W + 4) / 2) - Math.floor(t.index.length / 2))}${t.index}`)
  out.push(connector())

  out.push(boxTop(t.periphery))
  if (a.areas.length === 0) out.push(boxLine(t.peripheryEmpty))
  for (const area of a.areas) out.push(boxLine(t.areaLine(area)))
  out.push(boxLine(''))
  out.push(boxLine(t.load))
  out.push(boxBottom())
  out.push(connector())

  out.push(boxTop(t.reflexes))
  if (a.catchTotal === 0) {
    out.push(boxLine(t.minedZero))
  } else {
    out.push(boxLine(t.mined(a.catchTotal)))
    for (const kind of Object.keys(a.byKind).sort()) {
      const label = t.kind[kind] ?? kind
      out.push(boxLine(t.kindLine(label, a.byKind[kind])))
    }
    out.push(boxLine(t.drafts(a.catchTotal)))
  }
  out.push(boxBottom())
  return out.join('\n')
}

// ── selftest (the P-BL-174 falsifiable check) ────────────────────────────────

/**
 * previewSelftest() — hermetic, no real git, no fs writes:
 *   1. a fixture runGit (ls-files list; empty log) analyzed + rendered TWICE →
 *      byte-equal (determinism)
 *   2. a THROWING runGit (no git / empty repo) → graceful empty-repo render, no crash
 *   3. a synthetic analysis with catches renders every kind line (both languages)
 * Returns 1 on full pass, else 0. Never throws.
 */
export function previewSelftest() {
  try {
    const fixtureGit = (args) => {
      if (args[0] === 'ls-files') return ['src/app/a.ts', 'src/app/b.ts', 'src/lib/c.ts', 'docs/readme.md', 'scripts/x.mjs'].join('\n')
      return '' // log — zero catches
    }
    const io = { exists: () => false, readdir: () => [], readFile: () => '' }
    const a1 = analyzeRepo({ repoDir: 'fixture', runGit: fixtureGit, io })
    const a2 = analyzeRepo({ repoDir: 'fixture', runGit: fixtureGit, io })
    const r1 = renderPreview(a1, { lang: 'en' })
    const r2 = renderPreview(a2, { lang: 'en' })
    if (r1 !== r2) return 0
    if (!r1.includes('CORE') || !r1.includes('area:')) return 0

    const broken = analyzeRepo({
      repoDir: 'nowhere',
      runGit: () => {
        throw new Error('not a git repository')
      },
      io,
    })
    if (!broken.empty) return 0
    const rEmpty = renderPreview(broken, { lang: 'en' })
    if (!rEmpty.includes('no git-tracked files')) return 0

    const synth = {
      repoDir: 'x',
      empty: false,
      fileCount: 3,
      areas: [{ dir: 'src', count: 3, tag: 'src' }],
      byKind: { 'revert-pair': 2, 'fix-forward': 1 },
      catchTotal: 3,
      corpus: { notes: 4, present: true },
    }
    for (const lang of ['en', 'ru']) {
      const r = renderPreview(synth, { lang })
      if (!r.includes(': 2') || !r.includes(': 1')) return 0 // both kind lines rendered
      if (renderPreview(synth, { lang }) !== r) return 0
    }
    return 1
  } catch {
    return 0
  }
}
