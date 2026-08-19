/**
 * СБОР ПАМЯТИ ПОПЫТКИ — в момент приёмки, до того как копия исчезнет.
 *
 * Работник пишет урок и записку о подходе В СВОЮ КОПИЮ: у копии свой корпус, своя ветка,
 * своя приёмка — в этом и смысл писать там, а не в общем дереве. Дальше начинается место,
 * где память терялась молча, и терялась ДВУМЯ разными способами:
 *
 *   (1) ЗАПИСКА О ПОДХОДЕ жила только в журнале попытки. Её читал человек в карточке — и
 *       никто больше: в корпус она не уезжала никогда, значит следующая попытка той же
 *       задачи не могла узнать, что уже пробовали и от чего отказались.
 *   (2) УРОК жил черновиком в копии. Если корпус проекта отслеживается git — черновик
 *       приезжает слиянием ветки, и переносить нечего. Если корпус в `.gitignore` (так живёт
 *       этот продукт), слияние не несёт НИЧЕГО, а уборка копии сносит каталог вместе с
 *       уроком. Урок при этом не «где-то лежит» — его физически больше нет.
 *
 * ПОЧЕМУ ЭТО СТОИТ ДО УБОРКИ, А НЕ РЯДОМ С НЕЙ. Порядок здесь — не вкус, а само содержание
 * гарантии: копия перестаёт быть ценностью только после того, как урок спасён. Поэтому сбор
 * идёт первым, а при провале на игнорируемом корпусе он ПРЯМО ПРОСИТ уборку не начинаться и
 * называет причину. Копия, оставленная на диске, — неудобство; копия, убранная вместе с
 * единственным экземпляром урока, — потеря без следа.
 *
 * ПОЧЕМУ КОНВЕЙЕР, А НЕ КОПИРОВАНИЕ ФАЙЛА В КОРПУС. Черновик приходит из чужого дерева, где
 * его писала модель. Класть такой файл в корпус копированием значило бы обойти всё, ради
 * чего конвейер записи существует: проверку схемы, вычистку секретов, отказ положить рядом
 * запись, которая противоречит уже лежащей, и пересборку индекса. Поэтому перенос — это
 * только перенос ЧЕРНОВИКА в каталог черновиков проекта (и никогда поверх существующего), а
 * дверь в корпус одна: `memory write --apply … --confirm … --yes`. Индекс после этого
 * пересобирает сам конвейер — здесь второго индексатора нет.
 *
 * ПОЧЕМУ СЛЕД — ОТДЕЛЬНЫЙ КЛЮЧ СТРОКИ, А НЕ ЧАСТЬ УБОРКИ. Сбор и уборка отвечают на разные
 * вопросы («что доехало до корпуса» и «что удалено с диска»), происходят в разные моменты и
 * проваливаются независимо. Сложенные в один объект, они однажды объяснили бы отсутствие
 * урока успехом удаления.
 */

import {
  existsSync as nodeExistsSync,
  readdirSync as nodeReaddirSync,
  readFileSync as nodeReadFileSync,
  copyFileSync as nodeCopyFileSync,
  mkdirSync as nodeMkdirSync,
} from 'node:fs'
import { basename, join } from 'node:path'

import { parseVerbResult } from '../loop.mjs'
import { insideCopiesDir } from './worktree-cleanup.mjs'
import { parseNote } from '../../../scripts/sma/lib/frontmatter.mjs'
import { PIPELINE_DRAFT_KIND, appliedDraftPath } from '../../../scripts/sma/lib/write-pipeline.mjs'

/** Одна durable-фраза записки. Длинный текст едет телом — заявление остаётся одним. */
const CLAIM_CAP = 512

/** Тело записки тоже данные, и данные ограничены. */
const BODY_CAP = 4096

/** Сколько уроков одной попытки этот модуль вообще берётся применить. */
const LESSON_CAP = 12

/** Каталог памяти проекта или копии — одно правило имени для обоих. */
function corpusOf(dir) {
  return join(dir, '.claude', 'memory')
}

function draftsOf(dir) {
  return join(corpusOf(dir), 'drafts')
}

function say(log, entry) {
  if (typeof log === 'function') {
    try {
      log(entry)
    } catch {
      /* журнал наблюдает за сбором, а не управляет им */
    }
  }
}

/** Один верб проекта через переданный раннер; ответ — последняя JSON-строка stdout. */
async function runVerb(verbRunner, args, cwd) {
  const res = await verbRunner('node', ['scripts/sma/cli.mjs', ...args], { cwd })
  return { code: res && Number.isFinite(res.code) ? res.code : 0, ...parseVerbResult(res && res.stdout) }
}

function capped(text, cap) {
  const t = String(text ?? '').replace(/\r?\n/g, ' ').trim()
  return t.length > cap ? t.slice(0, cap) : t
}

/**
 * ОТПЕЧАТОК ПРОДУКТА — версия проекта плюс короткий sha его HEAD.
 *
 * Валидатор корпуса требует от перепроверяемого заявления его проверку: либо команду, либо
 * отпечаток эпохи. Работник не может назвать ни версии проекта, ни коммита — он сидит в копии,
 * заведённой ради одной задачи, а о продукте, в который его правка попадёт, знает не он, а
 * приёмка. Поэтому отпечаток ставится ЗДЕСЬ, в момент переноса, и составляется из того, что
 * читается прямо у проекта. Ни версии, ни коммита не нашлось — заявление всё равно едет со
 * словом 'unknown': честно названная неизвестная эпоха полезнее молчаливой потери урока.
 */
function productFingerprint(projectDir, { execGit, readFileSync } = {}) {
  let version = 'unknown'
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim() !== '') version = pkg.version.trim()
  } catch {
    /* без package.json эпоха называется словом, а не выдумывается */
  }
  let sha = ''
  if (typeof execGit === 'function') {
    try {
      sha = String(execGit(['rev-parse', '--short', 'HEAD'], { cwd: projectDir }) || '').trim().split(/\s+/)[0]
    } catch {
      /* нет git или нет коммитов — отпечаток остаётся одной версией */
    }
  }
  return sha ? `${version}+${sha}` : version
}

/** Идентификатор записи по имени файла черновика: `<id>.md` — закон имени корпуса. */
function idFromDraftPath(p) {
  const name = basename(String(p ?? '').replace(/[\\/]+/g, '/'))
  return name.endsWith('.md') ? name.slice(0, -3) : ''
}

/**
 * harvestTaskMemory — собрать память ОДНОЙ принятой задачи в корпус проекта.
 *
 * @param {{taskId:string, projectDir:string, ledger:object, verbRunner:Function,
 *          execGit?:Function, fsImpl?:object, clock?:Function, log?:Function}} opts
 * @returns {Promise<{ok:boolean, mode:'tracked'|'untracked', copied:string[], applied:string[],
 *          drafted:string[], refused:Array<{id:string, reason:string}>, skipCleanup:boolean,
 *          reason?:string}>}
 *          НИКОГДА не бросает: сбор зовёт дверь приёмки, и слияние к этому моменту уже
 *          произошло — исключение отсюда отменило бы принятую работу.
 */
export async function harvestTaskMemory({ taskId, projectDir, ledger, verbRunner, execGit, fsImpl, clock = Date.now, log } = {}) {
  const existsSync = (fsImpl && fsImpl.existsSync) || nodeExistsSync
  const readdirSync = (fsImpl && fsImpl.readdirSync) || nodeReaddirSync
  const readFileSync = (fsImpl && fsImpl.readFileSync) || nodeReadFileSync
  const copyFileSync = (fsImpl && fsImpl.copyFileSync) || nodeCopyFileSync
  const mkdirSync = (fsImpl && fsImpl.mkdirSync) || nodeMkdirSync

  const copied = []
  const applied = []
  const drafted = []
  const refused = []
  let mode = 'tracked'

  try {
    if (!taskId || typeof verbRunner !== 'function') {
      return { ok: false, mode, copied, applied, drafted, refused, skipCleanup: false, reason: 'not-wired' }
    }

    // (1) КАКОЙ ЭТО ПРОЕКТ — СПРОШЕНО У GIT, А НЕ ЗАЯВЛЕНО НАСТРОЙКОЙ. `check-ignore`
    // отвечает кодом: ноль — каталог памяти игнорируется, значит слияние ветки корпус не
    // принесёт и перенос обязателен. Ненулевой код (и вообще любой отказ git) читается как
    // «отслеживается» — сторона, на которой этот модуль ничего не копирует.
    if (typeof execGit === 'function') {
      try {
        execGit(['check-ignore', '-q', join('.claude', 'memory')], { cwd: projectDir })
        mode = 'untracked'
      } catch {
        mode = 'tracked'
      }
    }

    const rows = ledger && typeof ledger.readAttempts === 'function' ? ledger.readAttempts(taskId) || [] : []
    const attempt = rows.reduce((max, r) => (Number.isFinite(r && r.attempt) && r.attempt > max ? r.attempt : max), 0) || 1
    let worktreePath = null
    for (const r of rows) {
      if (r && typeof r.worktreePath === 'string' && r.worktreePath.trim() !== '') worktreePath = r.worktreePath
    }

    const journal = ledger && typeof ledger.readJournalEntries === 'function' ? ledger.readJournalEntries(taskId) || [] : []

    // (2) ЗАПИСКА О ПОДХОДЕ → ЧЕРНОВИК КОРПУСА. Идентификатор фиксирован по задаче и номеру
    // попытки, поэтому повтор приёмки не плодит вторую запись о том же: конвейер видит уже
    // лежащий черновик и отвечает `staged-draft` — это идемпотентный успех, а не отказ.
    // Записка НЕ применяется в корпус: это наблюдение одной сессии, которое читает человек.
    let approachRow = null
    for (const row of journal) {
      if (row && row.layer === 'approach' && row.payload && String(row.payload.approach ?? '').trim()) approachRow = row
    }
    if (approachRow) {
      const p = approachRow.payload
      const n = Number.isFinite(Number(approachRow.attempt)) ? Number(approachRow.attempt) : attempt
      const id = `approach-${String(taskId).toLowerCase()}-${n}`
      const rejected = Array.isArray(p.rejected) ? p.rejected : []
      const influences = Array.isArray(p.influences) ? p.influences : []
      const body = capped(
        [
          String(p.approach ?? ''),
          rejected.length ? `Отвергнуто: ${rejected.join('; ')}` : '',
          influences.length ? `Повлияло: ${influences.join('; ')}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        BODY_CAP,
      )
      const res = await runVerb(
        verbRunner,
        [
          'memory', 'write',
          '--corpus', corpusOf(projectDir),
          '--type', 'episodic',
          '--truth', 'observed',
          '--authority', 'self-observed',
          '--evidence', `attempt:${taskId}#${n}`,
          '--id', id,
          '--claim', capped(p.approach, CLAIM_CAP),
          '--body', body,
          '--areas', 'approach',
          '--language', 'ru',
          '--json',
        ],
        projectDir,
      )
      // `rejected` — единственный исход, на котором ничего не записано. `staged-draft`
      // покрывает и первый прогон, и повтор поверх уже лежащего черновика.
      if (res.outcome === 'rejected' || res.code !== 0) {
        refused.push({ id, reason: `записка о подходе отклонена конвейером: ${capped(res.reason ?? res.error ?? res.outcome ?? 'unknown', 200)}` })
      } else {
        drafted.push(id)
      }
    }

    // (3) ЧЕРНОВИКИ ИЗ КОПИИ — только на игнорируемом корпусе и только через каталог
    // черновиков. Гард пути тот же, что у уборки: путь пришёл ИЗ ДАННЫХ, а ведёт к чтению
    // чужого дерева, значит между ними стоит проверка, которую нельзя обойти содержимым
    // журнала. Существующий черновик НИКОГДА не перезаписывается — человек мог его править.
    let copyUnreachable = mode === 'untracked' ? 'копия задачи не найдена по строке попытки — переносить неоткуда' : null
    if (mode === 'untracked' && worktreePath) {
      if (!insideCopiesDir(worktreePath)) {
        copyUnreachable = `refused-path: путь копии вне каталога копий (${worktreePath})`
        say(log, { type: 'memory-harvest-refused', taskId, path: worktreePath, reason: 'refused-path' })
      } else {
        const from = draftsOf(worktreePath)
        const to = draftsOf(projectDir)
        if (!existsSync(from)) {
          copyUnreachable = 'в копии нет каталога черновиков — переносить нечего'
        } else {
          copyUnreachable = null
          let names = []
          try {
            names = readdirSync(from).filter((n) => typeof n === 'string' && n.endsWith('.md'))
          } catch (err) {
            copyUnreachable = `каталог черновиков копии не читается: ${String((err && err.message) || err)}`
          }
          for (const name of names) {
            if (name.endsWith('.applied.md')) continue // метка уже применённого — не черновик
            const target = join(to, name)
            // Никогда поверх существующего — и никогда второй раз поверх УЖЕ ПРИНЯТОГО: конвейер
            // уносит применённый черновик под метку, и без этой проверки повторная приёмка
            // положила бы копию рядом с записью, которая давно в корпусе.
            if (existsSync(target) || existsSync(appliedDraftPath(target))) continue
            let isPipelineDraft = false
            try {
              const parsed = parseNote(readFileSync(join(from, name), 'utf8'), { file: name })
              isPipelineDraft = String(parsed?.frontmatter?.draft_kind ?? '').trim() === PIPELINE_DRAFT_KIND
            } catch {
              isPipelineDraft = false // нечитаемый файл — не наш файл
            }
            if (!isPipelineDraft) continue
            try {
              mkdirSync(to, { recursive: true })
              copyFileSync(join(from, name), target)
              copied.push(join('drafts', name))
            } catch (err) {
              refused.push({ id: idFromDraftPath(name), reason: `перенос черновика не удался: ${String((err && err.message) || err)}` })
            }
          }
        }
      }
    }

    // (4) КАКИЕ УРОКИ ЭТА ЗАДАЧА ОБЪЯВИЛА. Первый источник — сам слой памяти попытки: он
    // несёт путь черновика, который написал работник. Второй — маска по имени в черновиках
    // проекта: попытка могла закончиться до того, как слой научился нести путь.
    const lessonIds = []
    const addLesson = (id) => {
      if (id && !lessonIds.includes(id) && lessonIds.length < LESSON_CAP) lessonIds.push(id)
    }
    for (const row of journal) {
      if (row && row.layer === 'memory' && row.payload && row.payload.lesson && row.payload.lesson.written) {
        addLesson(idFromDraftPath(row.payload.lesson.written))
      }
    }
    const mask = `lesson-${String(taskId).toLowerCase()}-`
    try {
      for (const name of readdirSync(draftsOf(projectDir))) {
        //  — метка съеденного черновика, а не второй урок с похожим именем.
        if (typeof name !== 'string' || !name.startsWith(mask) || !name.endsWith('.md') || name.endsWith('.applied.md')) continue
        addLesson(name.slice(0, -3))
      }
    } catch {
      /* каталога черновиков ещё нет — список остаётся тем, что назвал журнал */
    }

    // (5) ДВЕРЬ В КОРПУС. По одному черновику, с названным подтверждением и явным согласием —
    // ровно та форма приёмки, которую конвейер требует от человека. Уже лежащая в корпусе
    // запись — идемпотентный отказ: повтор приёмки не обязан ничего менять.
    const fingerprint = productFingerprint(projectDir, { execGit, readFileSync })
    for (const id of lessonIds) {
      if (existsSync(join(corpusOf(projectDir), `${id}.md`))) {
        refused.push({ id, reason: 'уже в корпусе — повторная приёмка ничего не меняет', idempotent: true })
        continue
      }
      const draftPath = join(draftsOf(projectDir), `${id}.md`)
      if (!existsSync(draftPath)) {
        refused.push({ id, reason: copyUnreachable ?? 'черновик урока не найден в корпусе проекта' })
        continue
      }
      const res = await runVerb(
        verbRunner,
        // `--product-version` здесь не украшение: без него урок, написанный ровно по
        // инструкции промпта, валидатор отказывается принять — и приёмка молча теряет
        // знание попытки. Штамп получают только записи, не принесшие своей проверки.
        ['memory', 'write', '--apply', draftPath, '--confirm', `${id}.md`, '--yes', '--corpus', corpusOf(projectDir), '--product-version', fingerprint, '--json'],
        projectDir,
      )
      if (res.applied === true) applied.push(id)
      else refused.push({ id, reason: capped(res.reason ?? res.error ?? 'конвейер отказал', 300) })
    }

    // (6) СЛЕД И РЕШЕНИЕ ПРО УБОРКУ. Не-идемпотентный отказ на игнорируемом корпусе означает,
    // что единственный экземпляр урока всё ещё в копии; удалять её после этого нельзя.
    const hardRefusals = refused.filter((r) => r.idempotent !== true)
    const unreachable = mode === 'untracked' && copyUnreachable !== null && lessonIds.length > 0
    const ok = hardRefusals.length === 0 && !unreachable
    const skipCleanup = mode === 'untracked' && !ok
    const reason = ok ? undefined : capped(unreachable ? copyUnreachable : hardRefusals[0].reason, 300)

    const memoryHarvest = {
      at: new Date(typeof clock === 'function' ? clock() : clock).toISOString(),
      by: 'approve',
      mode,
      copied,
      applied,
      drafted,
      refused: refused.map((r) => ({ id: r.id, reason: capped(r.reason, 300) })),
      ok,
    }
    if (ledger && typeof ledger.recordAttempt === 'function') {
      try {
        ledger.recordAttempt({ taskId, attempt, memoryHarvest })
      } catch (err) {
        say(log, { type: 'memory-harvest-ledger-error', taskId, error: String((err && err.message) || err) })
      }
    }
    say(log, { type: ok ? 'memory-harvest' : 'memory-harvest-error', taskId, by: 'approve', ...(ok ? {} : { reason }) })

    return { ok, mode, copied, applied, drafted, refused, skipCleanup, ...(reason ? { reason } : {}) }
  } catch (err) {
    // Сбор НИКОГДА не бросает наружу: его зовёт дверь приёмки, и работа уже слита. Копия при
    // этом сохраняется на игнорируемом корпусе — состояние урока неизвестно, а неизвестность
    // не повод удалять единственный его экземпляр.
    const reason = String((err && err.message) || err)
    say(log, { type: 'memory-harvest-error', taskId, by: 'approve', error: reason })
    return { ok: false, mode, copied, applied, drafted, refused, skipCleanup: mode === 'untracked', reason }
  }
}
