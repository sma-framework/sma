/**
 * report.mjs — the LOCAL, self-contained static-HTML report (49.1-24, B23,
 * D-49.1-07). Zero server, zero daemon, zero DB — it must open file:// offline.
 * The live-server panel (the deferred `sma ui`) stays REJECTED (V3 candidate).
 *
 * renderReport(data) is a PURE transform: fixtures / gathered sources in, ONE
 * self-contained HTML string out (inline CSS, no external asset URLs, no fetches).
 * The six sections + process metrics per D-49.1-07: sessions, predictions,
 * calibration (per domain), reflex firings, collisions, corpus health, metrics.
 *
 * SECURITY (T-49.1-51): every interpolated value is HTML-escaped through the
 * single `esc` helper — journal text lands in a browser context, so a
 * <script>-bearing journal string must render as inert text, never live markup.
 * No inline event handlers, no external assets.
 *
 * HONESTY (no-fake-dashboard-data): each empty source renders «Нет данных», never
 * a fabricated number.
 *
 * Product-neutral styling now (light, minimal); the design pass (design-seed
 * `sma-report` «New») will restyle onto the brand system.
 *
 * Node built-ins only; zero npm deps. The .sma report dir is dependency-injectable.
 */

import { atomicWriteRaw } from './fs-atomics.mjs'
import { join } from 'node:path'

// ── escaping ──────────────────────────────────────────────────────────────────

/** HTML-escape a value (T-49.1-51). Non-strings coerce to '' or their String form. */
function esc(v) {
  if (v == null) return ''
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** An honest empty-state paragraph (no fabricated numbers). */
function emptyState() {
  return '<p class="empty">Нет данных</p>'
}

/** Wrap a section body under a stable id + RU heading. */
function section(id, title, bodyHtml) {
  return `<section id="${esc(id)}"><h2>${esc(title)}</h2>${bodyHtml}</section>`
}

// ── per-section renderers (each fail-soft to an empty state) ──────────────────

function renderSessions(list) {
  const rows = Array.isArray(list) ? list : []
  if (!rows.length) return emptyState()
  const items = rows
    .map((s) => {
      const blockers = Array.isArray(s?.blockers) ? s.blockers : []
      const bl = blockers.length
        ? `<ul class="blockers">${blockers.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
        : ''
      return (
        `<li class="card">` +
        `<div class="row"><span class="id">${esc(s?.id)}</span>` +
        `<span class="badge">${esc(s?.status)}</span></div>` +
        `<div class="desc">${esc(s?.description)}</div>${bl}</li>`
      )
    })
    .join('')
  return `<ul class="cards">${items}</ul>`
}

function renderPredictions(list) {
  const rows = Array.isArray(list) ? list : []
  if (!rows.length) return emptyState()
  const items = rows
    .map(
      (p) =>
        `<tr><td>${esc(p?.domain)}</td><td>${esc(p?.verdict)}</td><td>${esc(p?.ts)}</td></tr>`,
    )
    .join('')
  return `<table><thead><tr><th>Домен</th><th>Вердикт</th><th>Когда</th></tr></thead><tbody>${items}</tbody></table>`
}

function renderCalibration(list) {
  const rows = Array.isArray(list) ? list : []
  if (!rows.length) return emptyState()
  const items = rows
    .map((c) => {
      const rate = typeof c?.rate === 'number' ? `${Math.round(c.rate * 100)}%` : '—'
      return (
        `<tr><td>${esc(c?.domain)}</td><td>${esc(rate)}</td>` +
        `<td>${esc(c?.n)}</td><td>${esc(c?.hits)}</td><td>${esc(c?.misses)}</td></tr>`
      )
    })
    .join('')
  return `<table><thead><tr><th>Домен</th><th>Точность</th><th>N</th><th>Попал</th><th>Мимо</th></tr></thead><tbody>${items}</tbody></table>`
}

function renderReflex(list) {
  const rows = Array.isArray(list) ? list : []
  if (!rows.length) return emptyState()
  const items = rows
    .map(
      (r) =>
        `<tr><td>${esc(r?.noteId)}</td><td>${esc(r?.target)}</td>` +
        `<td>${esc(r?.actor)}</td><td>${esc(r?.ts)}</td></tr>`,
    )
    .join('')
  return `<table><thead><tr><th>Заметка</th><th>Цель</th><th>Кто</th><th>Когда</th></tr></thead><tbody>${items}</tbody></table>`
}

function renderCollisions(list) {
  const rows = Array.isArray(list) ? list : []
  if (!rows.length) return emptyState()
  const items = rows
    .map((c) => {
      const actors = Array.isArray(c?.actors) ? c.actors.map((a) => esc(a)).join(', ') : ''
      return (
        `<tr><td>${esc(c?.type)}</td><td>${actors}</td>` +
        `<td>${esc(c?.scope)}</td><td>${esc(c?.ts)}</td></tr>`
      )
    })
    .join('')
  return `<table><thead><tr><th>Тип</th><th>Участники</th><th>Область</th><th>Когда</th></tr></thead><tbody>${items}</tbody></table>`
}

function renderCorpus(corpus) {
  if (!corpus || typeof corpus !== 'object') return emptyState()
  const tile = (label, val) =>
    `<div class="tile"><div class="tile-label">${esc(label)}</div>` +
    `<div class="tile-val">${esc(val ?? '—')}</div></div>`
  return (
    `<div class="tiles">` +
    tile('Критичные', corpus.lintCritical) +
    tile('Предупреждения', corpus.lintWarn) +
    tile('Файлов в корпусе', corpus.corpusFiles) +
    tile('Отпечаток индекса', corpus.indexCommit) +
    `</div>`
  )
}

function renderMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return emptyState()
  const parts = []

  // Lead time per plan.
  const lt = metrics.leadTime
  if (lt && lt.available && Array.isArray(lt.plans) && lt.plans.length) {
    const rows = lt.plans
      .map((p) => {
        const hours = typeof p?.ms === 'number' ? (p.ms / 3600000).toFixed(1) + ' ч' : '—'
        return `<tr><td>${esc(p?.id)}</td><td>${esc(hours)}</td></tr>`
      })
      .join('')
    parts.push(
      `<h3>Время выполнения планов</h3><table><thead><tr><th>План</th><th>Длительность</th></tr></thead><tbody>${rows}</tbody></table>`,
    )
  } else {
    parts.push(`<h3>Время выполнения планов</h3>${emptyState()}`)
  }

  // Rework rate.
  const rw = metrics.reworkRate
  if (rw && rw.available && typeof rw.rate === 'number') {
    const pct = `${Math.round(rw.rate * 100)}%`
    parts.push(
      `<h3>Доля переделок</h3><p class="stat">${esc(pct)} <span class="muted">(${esc(rw.rework)} из ${esc(rw.total)})</span></p>`,
    )
  } else {
    parts.push(`<h3>Доля переделок</h3>${emptyState()}`)
  }

  // Deviations by kind.
  const dev = metrics.deviations
  if (dev && dev.available && dev.byKind && Object.keys(dev.byKind).length) {
    const rows = Object.entries(dev.byKind)
      .map(([kind, n]) => `<tr><td>${esc(kind)}</td><td>${esc(n)}</td></tr>`)
      .join('')
    parts.push(
      `<h3>Отклонения по типу</h3><table><thead><tr><th>Тип</th><th>Число</th></tr></thead><tbody>${rows}</tbody></table>`,
    )
  } else {
    parts.push(`<h3>Отклонения по типу</h3>${emptyState()}`)
  }

  return parts.join('')
}

// ── inline stylesheet (product-neutral; design pass restyles) ─────────────────

const STYLE = `
  :root { --fg:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --bg:#fafafa; --card:#fff; --accent:#2563eb; }
  * { box-sizing:border-box; }
  body { font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--fg); background:var(--bg); margin:0; padding:2rem; line-height:1.5; }
  header { border-bottom:1px solid var(--line); padding-bottom:1rem; margin-bottom:1.5rem; }
  h1 { margin:0 0 .25rem; font-size:1.5rem; }
  h2 { font-size:1.15rem; margin:0 0 .75rem; }
  h3 { font-size:.95rem; margin:1rem 0 .5rem; color:var(--muted); }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:1.25rem; margin-bottom:1.25rem; }
  table { width:100%; border-collapse:collapse; font-size:.9rem; }
  th,td { text-align:left; padding:.4rem .6rem; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:600; }
  .cards { list-style:none; margin:0; padding:0; display:grid; gap:.75rem; }
  .card { border:1px solid var(--line); border-radius:8px; padding:.75rem; }
  .row { display:flex; justify-content:space-between; align-items:center; }
  .id { font-weight:600; }
  .badge { font-size:.75rem; background:var(--accent); color:#fff; border-radius:999px; padding:.1rem .5rem; }
  .desc { color:var(--muted); margin-top:.35rem; }
  .blockers { margin:.35rem 0 0; padding-left:1.1rem; color:#b91c1c; font-size:.85rem; }
  .empty { color:var(--muted); font-style:italic; margin:.25rem 0; }
  .tiles { display:flex; flex-wrap:wrap; gap:.75rem; }
  .tile { border:1px solid var(--line); border-radius:8px; padding:.75rem 1rem; min-width:120px; }
  .tile-label { color:var(--muted); font-size:.8rem; }
  .tile-val { font-size:1.3rem; font-weight:600; }
  .stat { font-size:1.2rem; font-weight:600; }
  .muted { color:var(--muted); font-weight:400; font-size:.9rem; }
  footer { color:var(--muted); font-size:.8rem; border-top:1px solid var(--line); padding-top:1rem; margin-top:1.5rem; }
`

/**
 * renderReport(data) -> a single self-contained HTML string.
 * @param {{generatedAt?:string, sessions?:object[], predictions?:object[],
 *   calibration?:object[], reflex?:object[], collisions?:object[],
 *   corpus?:object|null, metrics?:object}} data
 * @returns {string}
 */
export function renderReport(data = {}) {
  const generatedAt = typeof data.generatedAt === 'string' ? data.generatedAt : new Date().toISOString()

  const body =
    section('sessions', 'Сессии терминалов', renderSessions(data.sessions)) +
    section('predictions', 'Предсказания', renderPredictions(data.predictions)) +
    section('calibration', 'Калибровка по доменам', renderCalibration(data.calibration)) +
    section('reflex', 'Срабатывания рефлексов', renderReflex(data.reflex)) +
    section('collisions', 'Лента коллизий', renderCollisions(data.collisions)) +
    section('corpus', 'Здоровье памяти', renderCorpus(data.corpus)) +
    section('metrics', 'Метрики процесса', renderMetrics(data.metrics))

  // Footer: house HTML rule — generated-at timestamp (English machine line + RU line).
  const footer =
    `<footer><div>Generated: ${esc(generatedAt)}</div>` +
    `<div>Последнее обновление: ${esc(generatedAt)} (локальный отчёт SMA, только для чтения)</div></footer>`

  return (
    `<!DOCTYPE html>\n` +
    `<html lang="ru"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>SMA — локальный отчёт</title><style>${STYLE}</style></head>` +
    `<body><header><h1>SMA — локальный отчёт</h1>` +
    `<div class="muted">Статичный файл, без сервера и без базы данных. Данные настоящие или честно пустые.</div>` +
    `</header>${body}${footer}</body></html>\n`
  )
}

/** The default output path — <smaRoot>/report/index.html (gitignored .sma/). */
export function defaultReportPath(dirs = {}) {
  const smaRoot = dirs.smaRoot ?? '.sma'
  return join(smaRoot, 'report', 'index.html')
}

/**
 * writeReport({ out, html }) -> { written }. Atomic write (fs-atomics), creating
 * parent dirs. Never partial: temp-sibling + rename.
 * @param {{out:string, html:string}} opts
 */
export function writeReport(opts = {}) {
  const out = opts.out
  const html = typeof opts.html === 'string' ? opts.html : ''
  atomicWriteRaw(out, html)
  return { written: out }
}
