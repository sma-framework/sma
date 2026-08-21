/**
 * УБОРКА КОПИИ ЗАДАЧИ — после приёмки сразу, у закрытых суточным обходом.
 *
 * Копия работника (`wt/<taskId>` в каталоге `.sma-worktrees`) создавалась под каждую задачу и
 * не убиралась никогда: приёмка сливала ветку и уходила, обхода не существовало. На машине
 * основателя это выглядело как копии закрытых задач, лежащие неделями вместе с ветками.
 *
 * ПОЧЕМУ ЗДЕСЬ НЕТ НИ ОДНОГО УДАЛЕНИЯ. Этот файл не трогает ни диск, ни git: он зовёт ВЕРБ
 * ПРОЕКТА (`scripts/sma/cli.mjs worktree remove … --force --delete-branch --json`). Порядок
 * уборки — «снять ссылки внутри копии → посмотреть, что будет потеряно → отдать копию git →
 * снять ветку, записав её вершину» — живёт в вербе, и живёт он там не из любви к слоям:
 * измерено дважды на настоящем git, что `git worktree remove`, встретив ссылку внутри копии,
 * ИДЁТ ПО НЕЙ и опустошает каталог-цель в ОСНОВНОМ дереве. Второй порядок уборки в демоне
 * означал бы второй шанс это повторить. Здесь — только выбор жертвы и запись следа.
 *
 * ПОЧЕМУ ПРОВАЛЫ УБИРАЕТ ОБХОД, А НЕ ТИК. Тик не знает, будет ли повтор: повторы раздаёт
 * очередь по своему расписанию, и копия, убранная сразу после провала, отняла бы у повтора
 * готовую среду. Поэтому: после приёмки — сразу (работа принята, повторов не будет), после
 * провала/возврата/отмены — только обход и только у задач, закрытых больше суток назад.
 * Копия задачи, ждущей приёмки или возвращённой, не убирается НИКОГДА — это рабочее место
 * человека, а не мусор.
 *
 * ПОЧЕМУ СТРОКА УБОРКИ ОТДЕЛЬНАЯ И БЕЗ `endedAt`/`outcome`. Уборка происходит после того, как
 * попытка кончилась, иногда через сутки. Дописать её в строку попытки значило бы растянуть
 * длительность попытки до момента обхода и переписать, чем она кончилась. Отдельная строка
 * той же попытки складывается свёрткой рядом с исходом, ничего не искажая: что удалено, кем,
 * когда и какой была вершина ветки — это и есть «видно, к чему откатывать».
 */

import { existsSync as nodeExistsSync } from 'node:fs'
import { join } from 'node:path'

import { parseVerbResult } from '../loop.mjs'
import { latestRowPerId } from './adapter.mjs'
import { foldAttemptRows } from './attempt-ledger.mjs'
import { WORKTREE_COPIES_DIR } from '../../../scripts/sma/lib/constants.mjs'

/**
 * Каталог, внутри которого только и живут копии задач. Гард пути смотрит на этот сегмент.
 *
 * ИМЯ БЕРЁТСЯ ОТТУДА ЖЕ, ОТКУДА ЕГО БЕРЁТ ПРОВИЗИЯ, а не пишется здесь ещё раз: этот модуль
 * ОТКАЗЫВАЕТСЯ удалять всё, что лежит вне названного каталога, — значит вторая буква того же
 * имени означала бы, что провизия кладёт копию туда, куда уборке смотреть не позволено, и
 * узналось бы это молчаливым «refused-path» через месяц.
 */
const COPIES_DIR = WORKTREE_COPIES_DIR

/** Ветка копии задачи. Терминальные (`sma-wt/`), сравнительные и долгоживущие — не наши. */
const TASK_BRANCH_RE = /^(?:refs\/heads\/)?wt\/(.+)$/

const DAY_MS = 24 * 60 * 60 * 1000

/** Статусы, при которых копия — рабочее место, а не остаток: её не убирает никто. */
const LIVE_STATUSES = new Set(['queued', 'claimed', 'awaiting_approval', 'returned', 'approving'])

/** Один верб проекта через переданный раннер; ответ — последняя JSON-строка stdout. */
async function runVerb(verbRunner, args, cwd) {
  const res = await verbRunner('node', ['scripts/sma/cli.mjs', ...args], { cwd })
  return { code: res && Number.isFinite(res.code) ? res.code : 0, ...parseVerbResult(res && res.stdout) }
}

/** Сегменты пути, в обоих начертаниях разделителя — на Windows приходят оба. */
function pathSegments(p) {
  return String(p ?? '').split(/[\\/]+/)
}

/**
 * Копия задачи или что-то другое: удалять «что-то другое» этому модулю не поручали.
 *
 * ЭКСПОРТИРУЕТСЯ, потому что путь копии берётся из строки попытки не только здесь: сбор
 * памяти читает ту же строку, чтобы забрать из копии черновик урока. Два места, решающие
 * «этот ли каталог мне позволено трогать», рано или поздно разойдутся в ответе, и разойдутся
 * молча — поэтому вопрос задаётся ОДНОЙ функцией, а не двумя одинаковыми.
 */
export function insideCopiesDir(p) {
  return pathSegments(p).includes(COPIES_DIR)
}

function say(log, entry) {
  if (typeof log === 'function') {
    try {
      log(entry)
    } catch {
      /* журнал наблюдает за уборкой, а не управляет ею */
    }
  }
}

/**
 * cleanupTaskWorktree — убрать копию ОДНОЙ задачи и записать это в её попытку.
 *
 * `path` — НЕОБЯЗАТЕЛЬНАЯ подсказка от того, кто уже видел копию своими глазами (обход: он
 * нашёл её в списке деревьев и по ней же принял решение). Она перебивает журнал намеренно:
 * решать про один каталог, а удалять другой, названный строкой попытки месячной давности, —
 * это тот самый разрыв между вычислением и действием, ради которого дверь и обход вообще
 * проверяются проводами. Гард пути применяется к подсказке ровно так же.
 *
 * @param {{taskId:string, by:string, projectDir:string, path?:string, ledger:object,
 *          verbRunner:Function, clock?:Function, log?:Function}} opts
 * @returns {Promise<{ok:boolean, removed:boolean, removedPath:string|null,
 *          removedBranch:string|null, branchTip:string|null, reason?:string}>}
 *          Никогда не бросает: неудачная уборка — это ответ, а не исключение, потому что
 *          вызывает её приёмка, и приёмка от неудачи не отменяется.
 */
export async function cleanupTaskWorktree({ taskId, by = 'approve', projectDir, path: pathHint, ledger, verbRunner, clock = Date.now, log } = {}) {
  const nothing = (reason) => ({ ok: true, removed: false, removedPath: null, removedBranch: null, branchTip: null, reason })
  try {
    if (!taskId || typeof verbRunner !== 'function') {
      return { ok: false, removed: false, removedPath: null, removedBranch: null, branchTip: null, reason: 'not-wired' }
    }

    // (1) ГДЕ КОПИЯ. Строка попытки — первый и главный источник: её писал тик, который эту
    // копию и получил. Список деревьев спрашивается только когда строка молчит (старая
    // установка, попытка до того, как строка научилась нести путь).
    const rows = ledger && typeof ledger.readAttempts === 'function' ? ledger.readAttempts(taskId) || [] : []
    const attempt = rows.reduce((max, r) => (Number.isFinite(r && r.attempt) && r.attempt > max ? r.attempt : max), 0) || 1
    let path = typeof pathHint === 'string' && pathHint.trim() !== '' ? pathHint : null
    if (!path) {
      for (const r of rows) {
        if (r && typeof r.worktreePath === 'string' && r.worktreePath.trim() !== '') path = r.worktreePath
      }
    }
    if (!path) {
      const list = await runVerb(verbRunner, ['worktree', 'list', '--json'], projectDir)
      const trees = Array.isArray(list.worktrees) ? list.worktrees : []
      const hit = trees.find((t) => {
        const m = TASK_BRANCH_RE.exec(String((t && t.branch) || ''))
        return m && m[1] === taskId
      })
      path = hit && hit.path ? hit.path : null
    }
    if (!path) {
      // Нечего убирать — и нечего записывать: строка уборки означала бы удаление, которого
      // не было, а журнал попытки читают через месяцы буквально.
      say(log, { type: 'worktree-cleanup-skip', taskId, by, reason: 'no-worktree' })
      return nothing('no-worktree')
    }

    // (2) ГАРД ДО ПЕРВОГО ВЫЗОВА. Путь приходит ИЗ ДАННЫХ (строка леджера), а уходит в
    // команду удаления — значит, между ними должна стоять проверка, которую нельзя обойти
    // содержимым журнала. Верб откажет и сам (основное дерево, незарегистрированный путь),
    // но отказ на нашей стороне означает, что верб для чужого пути даже не запускался.
    if (!insideCopiesDir(path)) {
      say(log, { type: 'worktree-cleanup-refused', taskId, by, path, reason: 'refused-path' })
      return { ok: false, removed: false, removedPath: path, removedBranch: null, branchTip: null, reason: 'refused-path' }
    }

    // (3) ВЕРБ ПРОЕКТА — единственная рука, которая здесь что-то удаляет.
    const res = await runVerb(verbRunner, ['worktree', 'remove', path, '--force', '--delete-branch', '--json'], projectDir)
    const ok = res.ok === true
    const removedBranch = res.branch ?? `wt/${taskId}`
    const branchTip = res.branchTip ?? null

    // (4) СЛЕД. Пишется и на успехе, и на неудаче: «на диске осталось» — тоже факт, который
    // человек обязан узнать, а не догадаться по отсутствию строки.
    const cleanup = {
      at: new Date(typeof clock === 'function' ? clock() : clock).toISOString(),
      by,
      removedPath: path,
      removedBranch,
      branchTip,
      unlinked: Array.isArray(res.unlinked) ? res.unlinked : [],
      dirtyFiles: Array.isArray(res.dirtyFiles) ? res.dirtyFiles : [],
      forced: true,
      ok,
    }
    if (!ok) cleanup.error = String(res.message || res.error || 'remove failed')
    if (ledger && typeof ledger.recordAttempt === 'function') {
      try {
        ledger.recordAttempt({ taskId, attempt, cleanup })
      } catch (err) {
        say(log, { type: 'worktree-cleanup-ledger-error', taskId, error: String((err && err.message) || err) })
      }
    }
    say(log, { type: ok ? 'worktree-cleanup' : 'worktree-cleanup-error', taskId, by, path, branch: removedBranch, ...(ok ? {} : { error: cleanup.error }) })

    return {
      ok,
      removed: ok,
      removedPath: path,
      removedBranch,
      branchTip,
      ...(ok ? {} : { reason: cleanup.error }),
    }
  } catch (err) {
    // Уборка НИКОГДА не бросает наружу: её зовёт дверь приёмки, и слияние уже произошло.
    const reason = String((err && err.message) || err)
    say(log, { type: 'worktree-cleanup-error', taskId, by, error: reason })
    return { ok: false, removed: false, removedPath: null, removedBranch: null, branchTip: null, reason }
  }
}

/**
 * createWorktreeSweeper — суточный обход копий закрытых задач.
 *
 * @param {{projectsOf:Function, adapter:object, ledger:object, verbRunner:Function,
 *          clock?:Function, log?:Function, olderThanMs?:number, everyMs?:number,
 *          fsImpl?:object}} opts
 * @returns {{run:Function}} `run({force})` → `{scanned, removed, skipped, errors}` либо
 *          `{skipped:true}`, если сутки с прошлого обхода ещё не прошли.
 */
export function createWorktreeSweeper({
  projectsOf,
  adapter,
  ledger,
  verbRunner,
  clock = Date.now,
  log,
  olderThanMs = DAY_MS,
  everyMs = DAY_MS,
  fsImpl,
} = {}) {
  const existsSync = (fsImpl && typeof fsImpl.existsSync === 'function' ? fsImpl.existsSync : nodeExistsSync)
  // Метка «когда обходили» живёт в памяти процесса, а не на диске: стартовый обход
  // (`run({force:true})` в composition root) покрывает рестарт, и лишний обход стоит одного
  // `worktree list`, тогда как файл-метка — ещё одно состояние, которое можно рассинхронить.
  let lastRunAt = null

  const now = () => (typeof clock === 'function' ? clock() : clock)

  /** Самая поздняя достоверная метка закрытия: сначала журнал попытки, потом строка очереди. */
  function closedAt(taskId, row) {
    const rows = ledger && typeof ledger.readAttempts === 'function' ? ledger.readAttempts(taskId) || [] : []
    const folded = foldAttemptRows(rows)
    let latest = 0
    for (const r of folded) {
      for (const mark of [r && r.endedAt, r && r.recordedAt]) {
        const t = mark ? Date.parse(mark) : NaN
        if (Number.isFinite(t) && t > latest) latest = t
      }
    }
    const queueMark = row && Number.isFinite(Date.parse(String(row.completedAt))) ? Date.parse(String(row.completedAt)) : Number(row && row.completedAt)
    if (Number.isFinite(queueMark) && queueMark > latest) latest = queueMark
    return latest > 0 ? latest : null
  }

  async function run({ force = false } = {}) {
    const at = now()
    if (!force && lastRunAt !== null && at - lastRunAt < everyMs) return { skipped: true }
    lastRunAt = at

    const out = { scanned: 0, removed: 0, skipped: 0, errors: 0 }

    let queueRows = []
    try {
      queueRows = (await adapter.list({})) || []
    } catch (err) {
      say(log, { type: 'worktree-sweep-error', error: String((err && err.message) || err) })
      return out
    }
    const byId = new Map(latestRowPerId(queueRows).map((r) => [r.id, r]))

    const dirs = []
    try {
      for (const d of projectsOf() || []) if (d && !dirs.includes(d)) dirs.push(d)
    } catch (err) {
      say(log, { type: 'worktree-sweep-error', error: String((err && err.message) || err) })
      return out
    }

    for (const projectDir of dirs) {
      // Проект без верба — не проект этого демона: спрашивать его нечем.
      if (!existsSync(join(projectDir, 'scripts', 'sma', 'cli.mjs'))) {
        say(log, { type: 'worktree-sweep-skip', projectDir, reason: 'no-verb' })
        continue
      }
      let trees = []
      try {
        const list = await runVerb(verbRunner, ['worktree', 'list', '--json'], projectDir)
        trees = Array.isArray(list.worktrees) ? list.worktrees : []
      } catch (err) {
        out.errors += 1
        say(log, { type: 'worktree-sweep-error', projectDir, error: String((err && err.message) || err) })
        continue
      }

      for (const tree of trees) {
        const m = TASK_BRANCH_RE.exec(String((tree && tree.branch) || ''))
        if (!m) continue // терминальная копия, сравнительная, долгоживущая — не наше дело
        const taskId = m[1]
        out.scanned += 1

        const row = byId.get(taskId)
        if (!row) {
          // Копия есть, задачи очередь не знает. Это может быть ручная копия человека —
          // молча удалить её было бы ровно тем «ужасом, который нельзя откатить».
          out.skipped += 1
          say(log, { type: 'worktree-sweep-skip', taskId, reason: 'unknown-task', path: tree && tree.path })
          continue
        }
        if (LIVE_STATUSES.has(String(row.status))) {
          out.skipped += 1
          say(log, { type: 'worktree-sweep-skip', taskId, reason: `status:${row.status}` })
          continue
        }
        const closed = closedAt(taskId, row)
        if (closed === null || at - closed <= olderThanMs) {
          // Возраст не доказан — копия остаётся. Дешевле лишний каталог, чем стёртая работа.
          out.skipped += 1
          say(log, { type: 'worktree-sweep-skip', taskId, reason: closed === null ? 'no-mark' : 'too-fresh' })
          continue
        }

        // Убирается ИМЕННО та копия, о которой обход только что вынес решение: путь берётся
        // из записи списка деревьев, а не переспрашивается у журнала.
        const res = await cleanupTaskWorktree({ taskId, by: 'sweep', projectDir, path: tree && tree.path, ledger, verbRunner, clock, log })
        if (res.ok && res.removed) out.removed += 1
        else if (!res.ok) out.errors += 1
        else out.skipped += 1
      }
    }

    return out
  }

  return { run }
}
