/**
 * import-scanner.mjs — ДВЕРЬ ИМПОРТА: чужое хозяйство → черновики кузницы.
 *
 * ═════════════════════════ ЧТО ЭТО ═══════════════════════════════════════════════
 * «Переезд за минуты, а не переписывание». У проекта уже есть свои определения
 * агентов и навыков, написанные под другой инструмент. Этот модуль их ЧИТАЕТ,
 * показывает человеку, что нашлось и что с чем конфликтует, и по ЯВНОМУ выбору
 * кладёт каждое выбранное определение ЧЕРНОВИКОМ — через ту же дверь кузницы,
 * которой пользуется всё остальное хозяйство.
 *
 * Две функции, обе чистые при подставленной fs:
 *   scanEstate({repoDir, …})            → что у проекта есть и с чем это конфликтует
 *   enrollSelections({selections, …})   → выбранное становится черновиками
 *
 * ═════════════════════════ НОЛЬ МОДЕЛИ В СКАНЕРЕ ═════════════════════════════════
 * Чужие определения — ТРЕТЬЕСТОРОННИЙ ВВОД. Здесь этот текст не попадает в промпт
 * вообще: в модуле нет ни одного обращения к модели, ни одного запуска сессии, ни
 * одного импорта из слоя запуска. Разбор построчный, детерминированный, без зависимостей
 * (никакого YAML-пакета, никакого динамического исполнения строк). Неоднозначная
 * форма НЕ угадывается: элемент помечается kind:'unknown', и выбор отдаётся человеку
 * в мастере. Дешевле, безопаснее и честнее, чем звать модель на чужой текст.
 *
 * ═════════════════════════ ОДНА ДВЕРЬ, А НЕ ВТОРАЯ ═══════════════════════════════
 * Импортированное едет ровно тем же путём, что определение, собранное кузницей:
 *   draftPathFor → lintDraft → writeForgeReceipt → ожидание одобрения человеком
 *   → и только потом ОТДЕЛЬНЫЙ человеческий шаг включения.
 * Этот модуль НЕ содержит собственной проверки потолка возможностей, НЕ дублирует
 * lint и НЕ включает ничего сам: он не пишет конфиг ростера, не трогает реестр
 * инструментов, не зовёт ни одного применителя активации. Чужая ЗАЯВЛЕННАЯ
 * способность едет в черновик ДОСЛОВНО, как данные, — именно поэтому существующий
 * потолок кузницы её и ловит; наши безопасные умолчания стоят только там, где чужое
 * определение молчит.
 *
 * ═════════════════════════ КОЛЛИЗИИ: ОТКАЗ ИЛИ СУФФИКС ═══════════════════════════
 * Существующее имя НИКОГДА не перезаписывается тихо. Кандидат, чей слаг уже занят —
 * работником ростера, определением парка или просто файлом на целевом пути, —
 * приезжает с {collision:{existingKind, suggestion:'<слаг>-imported'}}. Записать его
 * можно ТОЛЬКО назвав overrideSlug, и проверка повторяется в момент записи, а не
 * только в скане: тихая перезапись невозможна структурно, а не по договорённости.
 *
 * ═════════════════════════ ФОРМАТЫ ═══════════════════════════════════════════════
 * FORMAT_PARSERS — замороженный реестр; формат Claude Code первым. Новый чужой
 * формат = ещё один маленький парсер с тем же контрактом кандидата, а не редизайн
 * двери.
 *
 * Только встроенные модули Node; каждый вызов fs подставляем, поэтому весь сьют
 * работает на фикстурах и не касается диска. Ноль зависимостей, ноль сети.
 */

import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  readdirSync as fsReaddirSync,
  mkdirSync as fsMkdirSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs'

import { draftPathFor, lintDraft, writeForgeReceipt } from '../forge/forge.mjs'

// ── named error (the collision gate, mappable to a clean 409 at the door) ──

export class SlugCollisionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SlugCollisionError'
  }
}

/** Форма слага — та же, что у кузницы (draftPathFor всё равно проверит ещё раз). */
const SLUG_RE = /^[a-z0-9-]{3,48}$/

/** Виды, которые дверь импорта умеет переносить сама. Остальное — вручную. */
export const ENROLLABLE_KINDS = Object.freeze(['agent', 'skill'])

/** Формат хозяйства по умолчанию. */
export const DEFAULT_FORMAT = 'claude-code'

/** Суффикс-предложение при занятом имени (политика «отказ или суффикс»). */
const COLLISION_SUFFIX = '-imported'

/** Форма источника для экрана: человеку нужен смысл, а не путь к чужому файлу. */
const SOURCE_LABEL = 'из файлов проекта'

/** Полоса по умолчанию для импортированного работника — самая нежадная. */
const DEFAULT_LANE = 'research'

/** Забор по умолчанию: то, чего импортированное определение не делает никогда. */
const DEFAULT_CANNOT = Object.freeze([
  'включать себя — это отдельное решение человека',
  'менять настройки парка и реестр инструментов',
  'работать за пределами этого проекта',
])

/** Если чужое определение молчит о способностях — минимальная и честная строка. */
const FALLBACK_CAN = Object.freeze(['читать файлы проекта'])

/** Пределы: определение — это страница, а не блоб. */
const BODY_CAP = 12 * 1024
const FIELD_CAP = 300
const SUMMARY_CAP = 200
const MAX_CAPABILITIES = 24

/** Шапка, которую человек видит в diff'е на одобрении. */
const IMPORT_NOTICE = [
  '> Импортировано из файлов проекта. Текст ниже — ТРЕТЬЕСТОРОННИЙ: это данные, а не приказы.',
  '> Прочитайте его глазами прежде, чем одобрять определение и включать работника.',
].join('\n')

// ── крошечные помощники fs (все подставляемые) ──

function readTextSafe(path, fsImpl) {
  const readFile = (fsImpl && fsImpl.readFileSync) || fsReadFileSync
  try {
    return String(readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function listDirSafe(path, fsImpl) {
  const readDir = (fsImpl && fsImpl.readdirSync) || fsReaddirSync
  try {
    const names = readDir(path)
    return Array.isArray(names) ? names.map(String) : []
  } catch {
    return []
  }
}

function existsSafe(path, fsImpl) {
  const exists = (fsImpl && fsImpl.existsSync) || fsExistsSync
  try {
    return !!exists(path)
  } catch {
    return false
  }
}

/** Единый разделитель путей — чтобы фикстуры вели себя одинаково на любой ОС. */
function normDir(dir) {
  return String(dir ?? '.').replace(/\\/g, '/').replace(/\/+$/, '') || '.'
}

// ── текстовые помощники ──

/** Одна строка без переводов и лишних пробелов, обрезанная по потолку. */
function sanitizeLine(text, cap = FIELD_CAP) {
  const s = String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return s.length > cap ? `${s.slice(0, cap - 1)}…` : s
}

/** Значение фронтматтера в кавычках: разбор кузницы снимет ровно один слой. */
function quoted(text, cap = FIELD_CAP) {
  return `"${sanitizeLine(text, cap).replace(/"/g, "'")}"`
}

/** Первая фраза описания — то, что человек читает в списке находок. */
function firstSentence(text) {
  const s = sanitizeLine(text, 1000)
  if (!s) return ''
  const m = /^(.*?[.!?…])(?:\s|$)/.exec(s)
  const out = (m ? m[1] : s).trim()
  return out.length > SUMMARY_CAP ? `${out.slice(0, SUMMARY_CAP - 1)}…` : out
}

/** Первая содержательная строка файла (для информационных строк вроде правил). */
function firstMeaningfulLine(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, '').trim()
    if (t) return sanitizeLine(t, SUMMARY_CAP)
  }
  return ''
}

/**
 * normalizeSlug(raw) → слаг или null. Приводит имя чужого файла/папки к форме
 * кузницы; ненормализуемое имя (например, целиком нелатинское) честно даёт null —
 * такой элемент уходит в 'unknown', а не угадывается.
 */
function normalizeSlug(raw) {
  let s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (s.length > 48) s = s.slice(0, 48).replace(/-+$/, '')
  return SLUG_RE.test(s) ? s : null
}

// ── разбор чужого фронтматтера (своя грамматика, ноль зависимостей) ──

/** Снять один слой кавычек. */
function unquote(v) {
  const t = String(v ?? '').trim()
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * parseForeignFrontmatter(text) → {frontmatter, body}. Идиома разбора кузницы,
 * повторённая для ЧУЖОГО формата (функция кузницы намеренно не импортируется: у
 * неё своя зона ответственности — свой, доверенный, черновик). Ведущий забор `---`,
 * плоские `key: value`, inline-массивы `key: [a, b]`, дефис-списки. Никакого
 * стороннего YAML. Сломанный или отсутствующий забор → {frontmatter:null}: значения
 * — инертные данные, разбор не бросает никогда.
 */
function parseForeignFrontmatter(text) {
  const s = String(text ?? '').replace(/\r\n/g, '\n')
  if (!s.startsWith('---\n')) return { frontmatter: null, body: s }
  const close = s.indexOf('\n---', 3)
  if (close === -1) return { frontmatter: null, body: s }
  const block = s.slice(4, close)
  const body = s.slice(close + 4).replace(/^\n/, '')
  const fm = {}
  const lines = block.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }
    const m = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line)
    if (!m) {
      i += 1
      continue
    }
    const key = m[1].toLowerCase()
    const rest = m[2].trim()
    if (rest === '') {
      const arr = []
      let j = i + 1
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        arr.push(unquote(lines[j].replace(/^\s*-\s+/, '').trim()))
        j += 1
      }
      fm[key] = arr.length ? arr : ''
      i = arr.length ? j : i + 1
      continue
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim()
      fm[key] = inner === '' ? [] : inner.split(',').map((x) => unquote(x.trim()))
      i += 1
      continue
    }
    fm[key] = unquote(rest)
    i += 1
  }
  return { frontmatter: fm, body }
}

// ── классификация (детерминированная, без догадок) ──

function unknownCandidate(file, slug, reason) {
  return {
    kind: 'unknown',
    slug: slug ?? null,
    name: sanitizeLine(file, FIELD_CAP),
    summary: '',
    reason,
    frontmatter: null,
    description: '',
    body: '',
  }
}

/**
 * classify({file, text, wanted}) → сырой кандидат. Форма узнаётся по МЕСТУ файла и
 * НАЛИЧИЮ полей карточки; всё, что не узналось однозначно, становится 'unknown' с
 * причиной — решение о таком элементе принимает человек в мастере.
 */
function classify({ file, text, wanted }) {
  const slug = normalizeSlug(file)
  if (text == null) return unknownCandidate(file, slug, 'файл не читается')

  const { frontmatter, body } = parseForeignFrontmatter(text)
  if (!frontmatter) return unknownCandidate(file, slug, 'не удалось разобрать заголовок определения')

  const name = sanitizeLine(frontmatter.name || frontmatter.title || file, FIELD_CAP)
  const description = sanitizeLine(frontmatter.description || frontmatter.purpose || '', FIELD_CAP * 4)
  if (!name || !description) {
    return unknownCandidate(file, slug, 'в заголовке определения нет имени или описания')
  }
  if (!slug) {
    return unknownCandidate(file, null, 'имя файла не приводится к допустимому слагу')
  }
  return {
    kind: wanted,
    slug,
    name,
    summary: firstSentence(description) || name,
    description,
    frontmatter,
    body: String(body ?? ''),
  }
}

// ── парсер формата Claude Code ──

/**
 * parseClaudeEstate({repoDir, fsImpl}) → сырые кандидаты формата Claude Code:
 *   .claude/agents/*.md          → 'agent'
 *   .claude/skills/<имя>/SKILL.md → 'skill'
 *   CLAUDE.md                    → 'rules' (информационная строка; переносится вручную)
 * Обход не бросает: недоступная папка = пусто, нечитаемый файл = кандидат 'unknown'.
 */
function parseClaudeEstate({ repoDir, fsImpl } = {}) {
  const root = normDir(repoDir)
  const raw = []

  for (const entry of listDirSafe(`${root}/.claude/agents`, fsImpl)) {
    if (!/\.md$/i.test(entry)) continue
    const text = readTextSafe(`${root}/.claude/agents/${entry}`, fsImpl)
    raw.push(classify({ file: entry.replace(/\.md$/i, ''), text, wanted: 'agent' }))
  }

  for (const entry of listDirSafe(`${root}/.claude/skills`, fsImpl)) {
    const text = readTextSafe(`${root}/.claude/skills/${entry}/SKILL.md`, fsImpl)
    if (text == null) continue // не папка навыка — просто мимо
    raw.push(classify({ file: entry, text, wanted: 'skill' }))
  }

  const rulesText = readTextSafe(`${root}/CLAUDE.md`, fsImpl)
  if (rulesText != null && String(rulesText).trim()) {
    raw.push({
      kind: 'rules',
      slug: null,
      name: 'Правила проекта (CLAUDE.md)',
      summary: firstMeaningfulLine(rulesText),
      reason: 'правила проекта переносятся вручную: их место в памяти, а не в определении',
      frontmatter: null,
      description: '',
      body: '',
    })
  }

  return raw
}

/**
 * FORMAT_PARSERS — реестр форматов чужого хозяйства. Заморожен: новый формат = ещё
 * одна запись с тем же контрактом кандидата, а не переделка двери. Claude Code первым.
 */
export const FORMAT_PARSERS = Object.freeze({
  'claude-code': parseClaudeEstate,
})

// ── коллизии ──

function idOf(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') return entry.id ?? entry.slug ?? entry.name ?? null
  return null
}

function asList(value) {
  return Array.isArray(value) ? value : []
}

/**
 * buildTakenIndex(registries) → Map<слаг, чтоЗанимает>. Реестры инъецируются: ростер
 * работников (config.workers) и уже живущие в парке определения (agents/skills из
 * read-модели). Пустые реестры — не повод падать.
 */
function buildTakenIndex(registries) {
  const taken = new Map()
  const add = (entry, existingKind) => {
    const slug = normalizeSlug(idOf(entry))
    if (slug && !taken.has(slug)) taken.set(slug, existingKind)
  }
  const r = registries && typeof registries === 'object' ? registries : {}
  for (const w of asList(r.workers)) add(w, 'worker')
  for (const a of asList(r.agents)) add(a, 'agent')
  for (const s of asList(r.skills)) add(s, 'skill')
  return taken
}

/** Что занимает это имя: работник ростера, определение парка или файл на пути. */
function whatOccupies(slug, kind, taken, targetRoot, fsImpl) {
  if (taken.has(slug)) return taken.get(slug)
  let rel
  try {
    rel = draftPathFor(kind, slug)
  } catch {
    return null
  }
  return existsSafe(`${targetRoot}/${rel}`, fsImpl) ? 'definition-file' : null
}

/** Предложить свободное имя: `<слаг>-imported`, затем -imported-2 … -imported-9. */
function suggestFreeSlug(slug, kind, taken, targetRoot, fsImpl) {
  for (let n = 1; n <= 9; n += 1) {
    const suffix = n === 1 ? COLLISION_SUFFIX : `${COLLISION_SUFFIX}-${n}`
    const base = slug.slice(0, Math.max(3, 48 - suffix.length)).replace(/-+$/, '')
    const candidate = `${base}${suffix}`
    if (!SLUG_RE.test(candidate)) continue
    if (!whatOccupies(candidate, kind, taken, targetRoot, fsImpl)) return candidate
  }
  return null
}

/**
 * collectCandidates(...) → сырые кандидаты, размеченные коллизиями. Общий шаг скана
 * и записи: enroll СНОВА проходит этот путь, поэтому проверка занятости повторяется
 * в момент записи, а не переносится из прошлого ответа.
 */
function collectCandidates({ repoDir, targetDir, fsImpl, registries, format = DEFAULT_FORMAT }) {
  const parser = FORMAT_PARSERS[format]
  if (typeof parser !== 'function') return null // неизвестный формат — не исключение, а честный отказ

  let raw
  try {
    raw = parser({ repoDir, fsImpl })
  } catch {
    raw = [] // чужое хозяйство не обязано быть исправным — скан не падает никогда
  }

  const taken = buildTakenIndex(registries)
  const target = normDir(targetDir ?? repoDir)
  for (const c of raw) {
    if (!c || !c.slug || !ENROLLABLE_KINDS.includes(c.kind)) continue
    const existingKind = whatOccupies(c.slug, c.kind, taken, target, fsImpl)
    if (existingKind) {
      c.collision = { existingKind, suggestion: suggestFreeSlug(c.slug, c.kind, taken, target, fsImpl) }
    }
  }
  return { raw, taken, target }
}

/** Публичная форма кандидата: смысл для экрана, без путей к чужим файлам. */
function toPublicCandidate(c) {
  return {
    kind: c.kind,
    slug: c.slug ?? null,
    name: c.name,
    summary: c.summary ?? '',
    source: SOURCE_LABEL,
    ...(c.reason ? { reason: c.reason } : {}),
    ...(c.collision ? { collision: c.collision } : {}),
  }
}

// ── скан ──

/**
 * scanEstate({repoDir, targetDir, fsImpl, registries, format}) →
 *   {format, candidates:[{kind, slug, name, summary, source, reason?, collision?}], notReady:[…]}
 *
 * Детерминированный обход чужого хозяйства. `targetDir` — куда потом лягут черновики
 * (по умолчанию тот же repoDir): коллизия считается и против файлов на целевом пути,
 * поэтому уже существующее определение не может быть перезаписано даже случайно.
 * Не бросает НИКОГДА: недоступная fs, битый файл, неизвестный формат — всё это
 * ответ, а не исключение.
 */
export function scanEstate({ repoDir, targetDir, fsImpl, registries, format = DEFAULT_FORMAT } = {}) {
  const collected = collectCandidates({ repoDir, targetDir, fsImpl, registries, format })
  if (!collected) {
    return {
      format,
      candidates: [],
      notReady: [{ id: 'format', title: 'Формат хозяйства', reason: `формат «${format}» пока не поддержан — известен ${Object.keys(FORMAT_PARSERS).join(', ')}` }],
    }
  }

  const candidates = collected.raw.map(toPublicCandidate)
  const notReady = []
  if (!candidates.some((c) => ENROLLABLE_KINDS.includes(c.kind))) {
    notReady.push({
      id: 'estate',
      title: 'Хозяйство проекта',
      reason: 'не нашлось ни одного определения, которое можно взять: нет .claude/agents/*.md и .claude/skills/*/SKILL.md',
    })
  }
  return { format, candidates, notReady }
}

// ── маппинг чужого определения в словарь черновиков ──

/**
 * foreignCapabilities(fm) → заявленные чужим определением способности, ДОСЛОВНО, как
 * данные. Именно поэтому потолок кузницы работает и для импорта: если чужой текст
 * требует себе запретного права, оно приезжает в `can[]` и существующий lint его там
 * находит. Ослаблять или переписывать эту строку здесь — значит открыть вторую дверь.
 */
function foreignCapabilities(fm) {
  const out = []
  const take = (value) => {
    const s = sanitizeLine(value, FIELD_CAP)
    if (s && !out.includes(s)) out.push(s)
  }
  for (const key of ['can', 'tools', 'allowed-tools', 'capabilities']) {
    const v = fm ? fm[key] : undefined
    if (Array.isArray(v)) v.forEach(take)
    else if (typeof v === 'string' && v.trim()) String(v).split(',').forEach(take)
  }
  return out.slice(0, MAX_CAPABILITIES)
}

/** Тело чужого определения переносится как данные, обрезанное по потолку страницы. */
function cappedBody(body) {
  const s = String(body ?? '').replace(/\r\n/g, '\n')
  return s.length > BODY_CAP ? `${s.slice(0, BODY_CAP)}\n\n… (текст обрезан при импорте)` : s
}

function dashList(items) {
  return items.map((x) => `  - ${sanitizeLine(x, FIELD_CAP)}`)
}

/**
 * buildDraft(kind, slug, candidate) → текст черновика в форме, которую требует
 * кузница (её REQUIRED_FIELDS). Имя и описание — чужие; полоса и забор — наши
 * безопасные умолчания; заявленные способности — чужие дословно. Поля активации не
 * пишутся НИКОГДА: черновик не включает себя.
 */
function buildDraft(kind, slug, candidate) {
  const name = candidate.name || slug
  const description = candidate.description || candidate.summary || name
  const body = cappedBody(candidate.body)

  if (kind === 'skill') {
    const fm = candidate.frontmatter || {}
    const useWhen = sanitizeLine(fm['use-when'] || fm['when-to-use'] || firstSentence(description) || name, FIELD_CAP)
    return [
      '---',
      `name: ${quoted(name)}`,
      `description: ${quoted(description)}`,
      `use-when: ${quoted(useWhen)}`,
      '---',
      '',
      `# ${sanitizeLine(name, FIELD_CAP)}`,
      '',
      IMPORT_NOTICE,
      '',
      body,
      '',
    ].join('\n')
  }

  const declared = foreignCapabilities(candidate.frontmatter)
  return [
    '---',
    `name: ${quoted(name)}`,
    `description: ${quoted(description)}`,
    `lane: ${DEFAULT_LANE}`,
    'can:',
    ...dashList(declared.length ? declared : FALLBACK_CAN),
    'cannot:',
    ...dashList(DEFAULT_CANNOT),
    '---',
    '',
    `# ${sanitizeLine(name, FIELD_CAP)}`,
    '',
    IMPORT_NOTICE,
    '',
    body,
    '',
  ].join('\n')
}

// ── запись через дверь кузницы ──

/**
 * resolveTargetSlug(candidate, overrideSlug, ctx) → имя, под которым черновик ляжет.
 * Политика «отказ или суффикс»: переименование принимается ТОЛЬКО у кандидата,
 * помеченного коллизией, и само проверяется заново — совпало ли оно с предложением
 * или нет. Занятое имя без переименования — SlugCollisionError, то есть отказ ЭТОГО
 * элемента, а не перезапись чужого файла.
 */
function resolveTargetSlug(candidate, overrideSlug, ctx) {
  const wanted = typeof overrideSlug === 'string' && overrideSlug.trim()
    ? overrideSlug.trim().toLowerCase()
    : null

  if (!candidate.collision) {
    if (wanted && wanted !== candidate.slug) {
      throw new SlugCollisionError('переименование принимается только у кандидата, помеченного коллизией')
    }
    return candidate.slug
  }

  if (!wanted) {
    const hint = candidate.collision.suggestion ? ` — предложение: «${candidate.collision.suggestion}»` : ''
    throw new SlugCollisionError(`имя «${candidate.slug}» уже занято (${candidate.collision.existingKind})${hint}`)
  }
  if (!SLUG_RE.test(wanted)) {
    throw new SlugCollisionError(`«${wanted}» не годится как имя: нужны 3..48 символов из a-z, 0-9 и дефиса`)
  }
  // повторная проверка ИМЕННО ЗДЕСЬ: ответ скана мог устареть, файл мог появиться
  if (whatOccupies(wanted, candidate.kind, ctx.taken, ctx.target, ctx.fsImpl)) {
    throw new SlugCollisionError(`имя «${wanted}» тоже занято`)
  }
  return wanted
}

/** Записать черновик, не перезаписав ничего: существующий путь — отказ, не перезапись. */
function writeDraftFile(abs, text, fsImpl) {
  if (existsSafe(abs, fsImpl)) {
    throw new SlugCollisionError('на целевом пути уже есть файл — перезапись невозможна')
  }
  const mkdir = (fsImpl && fsImpl.mkdirSync) || fsMkdirSync
  const writeFile = (fsImpl && fsImpl.writeFileSync) || fsWriteFileSync
  const dir = abs.slice(0, abs.lastIndexOf('/'))
  try {
    mkdir(dir, { recursive: true })
  } catch {
    /* папка уже есть — не повод отказывать */
  }
  writeFile(abs, text, 'utf8')
}

/** Один выбранный элемент: маппинг → путь → запись → lint кузницы → её квитанция. */
function enrollOne(sel, ctx) {
  const kind = sel && typeof sel.kind === 'string' ? sel.kind : null
  const slug = sel && typeof sel.slug === 'string' ? sel.slug : null

  if (!kind) return { slug, kind, status: 'refused', reason: 'в выборе не указан вид' }
  if (!ENROLLABLE_KINDS.includes(kind)) {
    return {
      slug,
      kind,
      status: 'manual',
      reason: 'это переносится вручную: автоматического места в словаре у такого элемента нет',
    }
  }
  if (!slug) return { slug, kind, status: 'refused', reason: 'в выборе не указано имя' }

  const candidate = ctx.byKey.get(`${kind}:${slug}`)
  if (!candidate) {
    return { slug, kind, status: 'refused', reason: 'кандидат не найден при повторном скане хозяйства' }
  }

  let finalSlug
  let relPath
  let abs
  try {
    finalSlug = resolveTargetSlug(candidate, sel.overrideSlug, ctx)
    relPath = draftPathFor(kind, finalSlug)
    abs = `${ctx.target}/${relPath}`
    writeDraftFile(abs, buildDraft(kind, finalSlug, candidate), ctx.fsImpl)
  } catch (err) {
    return { slug, kind, status: 'refused', reason: err && err.message ? err.message : 'элемент не записан' }
  }

  // ДВЕРЬ КУЗНИЦЫ, дословно: её lint и её квитанция, без второй проверки способностей.
  const lint = lintDraft({ kind, filePath: abs, fsImpl: ctx.fsImpl })
  const receiptRef = writeForgeReceipt({
    dataDir: ctx.dataDir,
    taskId: ctx.taskId ?? `import-${finalSlug}`,
    kind,
    filePath: abs,
    lint,
    sha256: lint.sha256,
    fsImpl: ctx.fsImpl,
  })

  return {
    slug: finalSlug,
    kind,
    path: relPath,
    lint: {
      ok: lint.passed,
      findings: lint.checks.filter((c) => !c.ok).map((c) => ({ name: c.name, detail: c.detail })),
    },
    status: 'awaiting_approval',
    receiptRef,
    ...(finalSlug !== candidate.slug ? { renamedFrom: candidate.slug } : {}),
  }
}

/**
 * enrollSelections({selections, repoDir, targetDir, fsImpl, registries, dataDir, taskId, format})
 *   → {results:[{slug, kind, path?, lint?:{ok, findings}, status, reason?, receiptRef?}]}
 *
 * Выбранное человеком хозяйство едет черновиками через СУЩЕСТВУЮЩУЮ дверь кузницы:
 * draftPathFor → lintDraft → writeForgeReceipt → ожидание одобрения. Красный lint не
 * хоронит партию — элемент возвращается с находками, остальные продолжают. Занятое
 * имя без явного переименования — отказ ЭТОГО элемента; чужой файл остаётся байт в
 * байт тем же. Ничего не включается: конфиг ростера и реестр инструментов не
 * трогаются вовсе — активация остаётся двумя человеческими шагами.
 */
export function enrollSelections({
  selections,
  repoDir,
  targetDir,
  fsImpl,
  registries,
  dataDir,
  taskId,
  format = DEFAULT_FORMAT,
} = {}) {
  const collected = collectCandidates({ repoDir, targetDir, fsImpl, registries, format })
  const byKey = new Map()
  if (collected) {
    for (const c of collected.raw) {
      if (c && c.slug) byKey.set(`${c.kind}:${c.slug}`, c)
    }
  }

  const ctx = {
    byKey,
    taken: collected ? collected.taken : new Map(),
    target: collected ? collected.target : normDir(targetDir ?? repoDir),
    fsImpl,
    dataDir,
    taskId,
  }

  const results = []
  for (const sel of asList(selections)) {
    try {
      results.push(enrollOne(sel, ctx))
    } catch (err) {
      // ни один элемент не роняет партию целиком
      results.push({ slug: sel && sel.slug, kind: sel && sel.kind, status: 'refused', reason: err && err.message })
    }
  }
  return { results }
}
