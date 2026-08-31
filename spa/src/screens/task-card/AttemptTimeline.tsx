import { useState } from 'react'
import type { MaterializedEntry, MemoryTrace, TaskAttempt } from '../../api/types'
import { useDiagnosticsQuery } from '../../api/queries'
import { AttemptLog } from '../../shell/AttemptLog'
import { clockLabel, receiptChecks, receiptProofLabel } from '../../shell/format'
import { sessionReturn } from './session-return'

/**
 * AttemptTimeline — the whole history of one task, in the order it happened.
 *
 * Every run at the task is a row: when it started, how it ended, and — one click away — the
 * receipt it ended with. A retry is not a new story but the next row of the same one, which
 * is why the chain is read top to bottom and never re-sorted.
 *
 * ═══════════════ WHAT THE PERSON SAID SITS WHERE THEY SAID IT ═══════════════
 *
 * A returned task carries the comment that sent it back. The read model builds those
 * comments by walking the attempts that ended in «возвращена», in order — so the n-th
 * comment belongs to the n-th returned run, and this is where it is shown: under that run,
 * not in a pile at the bottom. If the two ever fall out of step, the row simply carries no
 * comment; nothing is guessed.
 *
 * Nothing on this timeline is markup. A failure reason, a receipt figure and a person's own
 * comment all reach the glass as text nodes.
 */

/** How a run ended, in words. A run still going says so; a run that failed says why. */
function outcomeWords(attempt: TaskAttempt): string {
  if (attempt.outcome === 'returned') return 'возвращена на доработку'
  if (attempt.outcome === 'completed' || attempt.outcome === 'approved') return 'готово'
  if (attempt.outcome === 'failed') return attempt.reasonLabel ?? 'не получилось, причина не записана'
  if (attempt.reasonLabel) return attempt.reasonLabel
  return attempt.endedAt ? 'завершён' : 'идёт сейчас'
}

/**
 * Сколько подход длился — вторая половина двухслойной ошибки (разведка 11.08, Multica:
 * «Failed after 1m 20s»). Цена попытки говорится рядом с исходом, не вычисляется в уме.
 */
function durationWords(attempt: TaskAttempt): string | null {
  if (!attempt.startedAt || !attempt.endedAt) return null
  const ms = Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt)
  if (!Number.isFinite(ms) || ms < 0) return null
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec} с`
  const min = Math.floor(sec / 60)
  return `${min} мин ${sec % 60} с`
}

/** Один пункт манифеста, словами: путь плюс то немногое, что о нём стоит сказать. */
function entryWords(entry: MaterializedEntry): string {
  if (entry.mode === 'link') return entry.target ? `${entry.path} → ${entry.target}` : entry.path
  if (entry.mode === 'copy' && (entry.files ?? 0) > 0) return `${entry.path} (${entry.files})`
  if (entry.mode === 'skipped') return entry.reason ? `${entry.path} (${entry.reason})` : entry.path
  return entry.path
}

/**
 * ЧТО КОПИЯ ПОЛУЧИЛА — сгруппировано по судьбе пункта, а не перечислено подряд.
 *
 * Список манифеста в реальном проекте — это десяток строк, из которых человеку важна не
 * каждая, а разница: что принесли файлами, что подключили ссылкой (и значит зависимости
 * никто не ставил заново), что уже лежало в git, и что НЕ пустили. Пункт, которого в
 * проекте не нашлось (`absent`), не говорит ни о чём — про него строки нет.
 */
function materializedWords(list: MaterializedEntry[]): string[] {
  const say = (label: string, test: (e: MaterializedEntry) => boolean): string | null => {
    const hit = list.filter(test).map(entryWords)
    return hit.length > 0 ? `${label}: ${hit.join(', ')}` : null
  }
  return [
    say('скопировано', (e) => e.mode === 'copy' && (e.files ?? 0) > 0),
    say('уже в копии и не устарело', (e) => e.mode === 'copy' && (e.files ?? 0) === 0),
    say('подключено ссылкой', (e) => e.mode === 'link'),
    say('уже в git', (e) => e.mode === 'tracked'),
    say('пропущено', (e) => e.mode === 'skipped'),
  ].filter((line): line is string => line !== null)
}

/** Кто убрал копию. Незнакомое слово показывается как записано — не переводится наугад. */
function cleanupWho(by: string): string {
  if (by === 'approve') return 'приёмка'
  if (by === 'sweep') return 'суточный обход'
  return by
}

/**
 * ГДЕ РАБОТАЛИ И К ЧЕМУ ОТКАТЫВАТЬ — строки о копии этой попытки.
 *
 * Работник пишет только в свою копию на своей ветке, отведённой от известного коммита.
 * Пока это знание жило в строке попытки на диске, откат оставался словами: человеку нечего
 * было назвать команде. Здесь оно становится текстом на карточке — путь, ветка, база,
 * что копия получила и когда её убрали.
 *
 * ЗАКОН ЭТОГО ХЕЛПЕРА: ничего не выдумывать. Нет поля — нет строки; пустой массив — блока
 * на карточке не будет вовсе. Прочерк вместо данных врёт не меньше, чем выдуманное число,
 * и попытки, сделанные до того, как строка научилась нести эти поля, обязаны молчать.
 */
function copyLines(attempt: TaskAttempt): string[] {
  const lines: string[] = []
  if (attempt.worktreePath) lines.push(`копия: ${attempt.worktreePath}`)

  const where = [
    attempt.branch ? `ветка ${attempt.branch}` : null,
    attempt.base ? `база ${attempt.base.slice(0, 7)}` : null,
  ].filter(Boolean)
  if (where.length > 0) lines.push(where.join(' · '))

  const ms = attempt.provisionMs
  if (typeof ms === 'number' && Number.isFinite(ms)) {
    lines.push(ms >= 1000 ? `подготовлена за ${(ms / 1000).toFixed(1)} с` : `подготовлена за ${ms} мс`)
  }

  if (Array.isArray(attempt.materialized)) lines.push(...materializedWords(attempt.materialized))

  const cleanup = attempt.cleanup
  if (cleanup && cleanup.ok) {
    lines.push(`убрана ${clockLabel(cleanup.at)} (${cleanupWho(cleanup.by)})`)
    if (cleanup.branchTip) lines.push(`вершина ветки ${cleanup.branchTip.slice(0, 7)} — с неё работу ещё можно поднять`)
    if (cleanup.dirtyFiles && cleanup.dirtyFiles.length > 0) {
      lines.push(`потеряно при уборке: ${cleanup.dirtyFiles.join(', ')}`)
    }
  } else if (cleanup && !cleanup.ok) {
    lines.push(`уборка не удалась: ${cleanup.error ?? 'причина не записана'}`)
  } else if (attempt.worktreePath && attempt.endedAt) {
    lines.push('копия ещё на диске')
  }

  return lines
}

/**
 * Сколько имён файлов показать, прежде чем сказать «и ещё N». Двенадцать — столько, сколько
 * человек прочитывает глазами, не прокручивая; остальное честно посчитано, а не отброшено.
 */
const ROLLBACK_NAMES_CAP = 12

/** Список имён с честным хвостом. `cut` — сколько путей срезал ещё потолок строки попытки. */
function namesLine(names: string[], cut: number | null | undefined): string {
  const shown = names.slice(0, ROLLBACK_NAMES_CAP)
  const hiddenHere = names.length - shown.length
  const more = hiddenHere + (typeof cut === 'number' && Number.isFinite(cut) ? cut : 0)
  return shown.join(', ') + (more > 0 ? ` … и ещё ${more}` : '')
}

/**
 * Почему гейт открылся без квитанции — СЛОВАМИ, теми же, что записал демон. Незнакомая
 * причина показывается как записана: выдуманное объяснение хуже непонятного кода.
 */
function unverifiedWhy(reason: string | undefined): string {
  if (reason === 'preexisting_red_only') return 'в дереве уже были красные рецепты, и они остались красными'
  if (reason === 'no_recipes_in_tree') return 'в дереве нет рецептов, которые можно перепроверить'
  return reason ?? 'причина не записана'
}

/**
 * ЧТО ИЗМЕНИЛОСЬ, ЧТО ИСЧЕЗЛО И ЧЕГО НИКТО НЕ ПЕРЕПРОВЕРЯЛ — строки блока отката.
 *
 * ЗАКОН ЭТОГО ХЕЛПЕРА тот же, что у copyLines: ничего не выдумывать. Нет поля — нет строки.
 *
 * Три вещи, которые здесь стоит прочитать глазами:
 *   1. исчезнувшее идёт ОТДЕЛЬНОЙ строкой. Цена ошибки несимметрична: «изменён» вместо
 *      «удалён» отправляет человека искать файл, которого больше нет;
 *   2. «не перепроверено» появляется ровно там, где доказательство это говорит. Тик считает
 *      этот признак с тех пор, как появился дифференциальный гейт, и до сих пор не показывал
 *      его никому — «готово» и «готово, но никто не перепроверял» читались одинаково;
 *   3. запись, чьи строки противоречат друг другу, рисуется КАК противоречие: названы оба
 *      исхода, победитель не выбирается. Молчаливый выбор победителя и есть та аномалия.
 */
function rollbackLines(attempt: TaskAttempt): string[] {
  const lines: string[] = []

  const files = attempt.files
  if (Array.isArray(files) && files.length > 0) {
    lines.push(`изменено: ${files.length} — ${namesLine(files.map((f) => f.path), attempt.filesOverflow)}`)
  }

  const gone = attempt.deletions
  if (Array.isArray(gone) && gone.length > 0) {
    lines.push(`исчезло: ${gone.length} — ${namesLine(gone, attempt.deletionsOverflow)}`)
  }

  const proof = attempt.proof
  if (proof && proof.kind === 'gate' && proof.unverified) {
    lines.push(`не перепроверено: ${unverifiedWhy(proof.reason)}`)
    const numbers = [
      typeof proof.preexistingRed === 'number' ? `красных до: ${proof.preexistingRed}` : null,
      typeof proof.newRed === 'number' ? `новых: ${proof.newRed}` : null,
      typeof proof.commits === 'number' ? `коммитов: ${proof.commits}` : null,
    ].filter(Boolean)
    if (numbers.length > 0) lines.push(numbers.join(' · '))
  }

  const conflict = attempt.conflict
  if (conflict && Array.isArray(conflict.outcomes) && conflict.outcomes.length > 1) {
    lines.push(
      `запись противоречит себе: исходов ${conflict.outcomes.length} — ${conflict.outcomes.join(' и ')}` +
        ` (строк: ${conflict.rows}); победитель не выбран`,
    )
  }

  return lines
}

/** Отпечаток коммита слияния и репозиторий, в котором оно произошло. */
export interface MergePoint {
  sha: string | null
  repo: string | null
}

/**
 * ЧЕМ ЭТО ОТКАТЫВАЕТСЯ — ОДНА команда, целиком, готовая к копированию.
 *
 * Сюжетов ровно два, и путать их нельзя.
 *
 * РАБОТА ПРИНЯТА И СЛИТА. Откатывается приёмка: слияние всегда идёт без ускоренной
 * перемотки, поэтому у коммита слияния ровно два родителя и первый — основная ветка. Номер
 * стороны поэтому всегда единица, и команда всегда одна и та же.
 *
 * РАБОТА НЕ ПРИНЯТА. В основном дереве откатывать НЕЧЕГО: работник пишет только в свою копию
 * на своей ветке. Убрать нужно копию — и верб уборки принимает ПУТЬ КОПИИ, а не имя ветки
 * (его собственная строка использования говорит именно так). Поэтому сюда подставляется
 * `worktreePath` ИЗ ЗАПИСИ, и собирать путь самостоятельно нельзя: нет пути в записи — нет и
 * команды, вместо неё честная строка о том, что путь не записан.
 *
 * НИ ОДНОГО ИМЕНИ ФАЙЛА В КОМАНДЕ. Команда собирается из отпечатка (проверенного по форме на
 * двери) и пути; имена файлов приходят из чужого репозитория и служат только глазам.
 */
function rollbackCommand(attempt: TaskAttempt, merge: MergePoint | null): { command: string | null; notes: string[] } {
  const notes: string[] = []

  // (1) принято и слито
  if (merge && merge.sha) {
    const command = merge.repo
      ? `git -C ${merge.repo} revert -m 1 ${merge.sha}`
      : `git revert -m 1 ${merge.sha}`
    if (!merge.repo) notes.push('выполняется в каталоге проекта — путь репозитория в записи не сохранён')
    if (merge.sha.length < 40) {
      notes.push('запись о приёмке старше этой версии: отпечаток короткий, git примет его, пока он однозначен')
    }
    return { command, notes }
  }

  // (2) не принято — копия ещё на диске
  const removed = attempt.cleanup && attempt.cleanup.ok
  if (attempt.endedAt && !removed) {
    if (!attempt.worktreePath) {
      return { command: null, notes: ['путь копии не записан — команды отката копии здесь нет'] }
    }
    return {
      command: `node scripts/sma/cli.mjs worktree remove ${attempt.worktreePath} --force --delete-branch`,
      notes: ['выполняется в каталоге проекта; основное дерево команда не трогает'],
    }
  }

  return { command: null, notes: [] }
}

/**
 * ПОД КАКИМ СЛОЕМ РАБОТАЛ РАБОТНИК — строки о личном слое этой попытки.
 *
 * Аккаунт работника перед каждым запуском получает слой автора: файл инструкций, хуки и
 * два сужающих списка правил. Не получает — allow, defaultMode и плагины автора, и об
 * этом здесь сказано СЛОВАМИ, прямо в строке: обещание «та же сессия» без названных
 * границ — обещание, которое некому проверить. Ниже — вторая половина: что сессия
 * действительно загрузила, дочитанное из её init-кадра.
 *
 * ЗАКОН ЭТОГО ХЕЛПЕРА тот же, что у copyLines: ничего не выдумывать. Нет поля — нет
 * строки; попытка, сделанная до того, как строка научилась нести слой, молчит целиком.
 */
function layerLines(attempt: TaskAttempt): string[] {
  const lines: string[] = []
  const layer = attempt.personalLayer

  if (layer) {
    const head = [
      layer.claudeMd === undefined ? null : `CLAUDE.md ${layer.claudeMd && layer.claudeMd !== 'absent' ? '✓' : '—'}`,
      typeof layer.hooks === 'number' ? `хуков ${layer.hooks}` : null,
      layer.permissions
        ? `правил deny ${layer.permissions.deny} / ask ${layer.permissions.ask} (allow не зеркалится)`
        : null,
      Array.isArray(layer.plugins) ? `плагины: ${layer.plugins.length > 0 ? layer.plugins.join(', ') : '—'}` : null,
      layer.connectors === undefined
        ? null
        : layer.connectors === 'disabled'
          ? 'подключения claude.ai выключены'
          : `подключения claude.ai: ${layer.connectors}`,
    ].filter(Boolean)
    if (head.length > 0) lines.push(`личный слой: ${head.join(' · ')}`)

    if (layer.autoMemoryDir) lines.push(`авто-память проекта: ${layer.autoMemoryDir}`)

    // Куда убрали прежние настройки аккаунта перед перезаписью — единственная дорога назад,
    // если работник ушёл с чужими правилами: без неё «настройки перезаписаны» звучит как
    // «настройки потеряны».
    if (layer.backup) lines.push(`прежние настройки аккаунта убраны в: ${layer.backup}`)

    // Что сессия ПОДНЯЛА на самом деле — не то же самое, что положило зеркало, и вся
    // ценность этой строки в разнице между двумя половинами. Поэтому серверы и плагины здесь
    // названы ПОИМЁННО, а не числом: расхождение между «положили» и «загрузилось» читается по
    // именам, а два одинаковых счётчика выглядят согласием даже тогда, когда сошлись случайно.
    const session = [
      typeof layer.initHooks === 'number' ? `хуков SessionStart ${layer.initHooks}` : null,
      typeof layer.initClaudeAiTools === 'number' ? `чужих подключений ${layer.initClaudeAiTools}` : null,
      Array.isArray(layer.initMcpServers)
        ? `серверы MCP: ${layer.initMcpServers.length > 0 ? layer.initMcpServers.join(', ') : '—'}`
        : null,
      Array.isArray(layer.initPlugins)
        ? `плагины сессии: ${layer.initPlugins.length > 0 ? layer.initPlugins.join(', ') : '—'}`
        : null,
      layer.permissionMode ? `режим разрешений: ${layer.permissionMode}` : null,
    ].filter(Boolean)
    if (session.length > 0) lines.push(`в сессии: ${session.join(' · ')}`)
  }

  const mcp = attempt.mcpConfig
  if (mcp && mcp.path) {
    lines.push(`MCP: наш файл, серверов ${Array.isArray(mcp.servers) ? mcp.servers.length : 0}`)
  }

  return lines
}

/**
 * Имя заметки, а не путь до неё. Заметка живёт по длинной дороге внутри рабочей копии, и
 * человеку на карточке нужно одно слово, по которому её можно найти в корпусе. Разделители
 * обоих видов — путь приходит с машины, а не из браузера.
 */
function noteName(path: string): string {
  const tail = String(path).split(/[\\/]/).pop() ?? String(path)
  return tail.endsWith('.md') ? tail.slice(0, -3) : tail
}

/**
 * ЧЕМУ ПОПЫТКА НАУЧИЛА, ЧТО ОНА ПРАВДА ПРОЧЛА И КУДА УЕХАЛА ЕЁ ЗАПИСКА.
 *
 * Продукт обещает маховик, который крутится в обе стороны: работник не только берёт из
 * памяти проекта, но и оставляет в ней урок каждой задачей — или говорит, почему урока
 * нет. Обещание проверяемо ровно настолько, насколько его видно, и до этих строк его не
 * было видно нигде: урок, след чтения и судьба записки писались в журнал и не доходили ни
 * до одного экрана.
 *
 * ТРИ СТРОКИ ИЗ ДВУХ РАЗНЫХ ИСТОЧНИКОВ, и разница названа честно:
 *   • урок и след чтения — из слоя памяти журнала, а он принадлежит ПОСЛЕДНЕЙ попытке
 *     задачи (её пишет каждая, читается верхняя). Поэтому `trace` приходит только в
 *     свежий ряд: показать урок второй попытки под первой значило бы выдумать.
 *   • судьба записки и применённые уроки — из строки САМОЙ этой попытки: сбор идёт при
 *     её приёмке и принадлежит ей одной.
 *
 * ЗАКОН ЭТОГО ХЕЛПЕРА тот же, что у copyLines и layerLines: ничего не выдумывать. Нет
 * поля — нет строки; попытка старше слоя молчит целиком, и прочерк вместо данных врёт не
 * меньше выдуманного числа.
 */
function lessonLines(attempt: TaskAttempt, trace: MemoryTrace | null): string[] {
  const lines: string[] = []

  const lesson = trace?.lesson ?? null
  if (lesson) {
    if (lesson.written) lines.push(`Урок: записан ${noteName(lesson.written)}`)
    else if (lesson.none) lines.push(`Урок: нет — ${lesson.none}`)
    else if (lesson.missing === true) lines.push('Урок: не оставлен, причина не названа')
  }

  const loaded = trace?.loaded ?? null
  if (loaded) {
    const reads = Array.isArray(loaded.reads) ? loaded.reads : []
    const reflexes = Array.isArray(trace?.reflexes) ? trace.reflexes : []
    const auto = Array.isArray(trace?.autoMemoryReads) ? trace.autoMemoryReads : []
    const parts = [
      `индекс ${loaded.index ? '✓' : '—'}`,
      `заметок ${reads.length}`,
      // Откуда взяты рефлексы — часть числа, а не примечание к нему: «сработало 0» из
      // непрочитанного журнала и «сработало 0» из прочитанного — разные факты.
      trace?.reflexSource ? `рефлексов ${reflexes.length} (${trace.reflexSource})` : `рефлексов ${reflexes.length}`,
      typeof loaded.loadCalls === 'number' && loaded.loadCalls > 0 ? `вызовов загрузки ${loaded.loadCalls}` : null,
    ].filter(Boolean)
    lines.push(`Память: ${parts.join(' · ')}`)
    // Записная книжка аккаунта — ОТДЕЛЬНОЙ строкой, потому что это не память проекта.
    if (auto.length > 0) lines.push(`авто-память аккаунта: ${auto.length}`)
  }

  // СУДЬБА ЗАПИСКИ О ПОДХОДЕ. До приёмки она обещание («уедет черновиком»), после — факт с
  // именами. Обещание снимается ровно в тот момент, когда появляется запись сбора: два
  // текста одновременно означали бы, что мы всё ещё обещаем то, что уже сделали.
  const harvest = attempt.memoryHarvest ?? null
  if (!harvest && trace?.approach === 'journaled') {
    lines.push('Записка о подходе → в память проекта после приёмки')
  }
  if (harvest) {
    const applied = Array.isArray(harvest.applied) ? harvest.applied : []
    const drafted = Array.isArray(harvest.drafted) ? harvest.drafted : []
    const copied = Array.isArray(harvest.copied) ? harvest.copied : []
    const refused = Array.isArray(harvest.refused) ? harvest.refused : []
    const parts = [
      applied.length > 0 ? `применено: ${applied.map(noteName).join(', ')}` : null,
      drafted.length > 0 ? `черновик записки: ${drafted.map(noteName).join(', ')}` : null,
      copied.length > 0 ? `вынесено из копии: ${copied.length}` : null,
    ].filter(Boolean)
    lines.push(parts.length > 0 ? `Приёмка собрала — ${parts.join(' · ')}` : 'Приёмка собрала — переносить было нечего')
    // Отказ конвейера НЕ прячется за удачным итогом: человек обязан узнать судьбу урока, а
    // не вывести её из молчания.
    for (const r of refused) {
      if (r && r.reason) lines.push(`не принято (${r.id ?? 'без имени'}): ${r.reason}`)
    }
    // Копию держат ТОЛЬКО когда урок нигде больше не живёт (черновики не вынесены); отказ
    // конвейера на применении копию не держит — тогда честно: «сбор не удался», без слов о копии.
    if (harvest.ok === false) {
      lines.push(harvest.skipCleanup === true ? 'сбор не удался — копия сохранена, урок жив только в ней' : 'сбор не удался — см. причину выше; копия убрана как обычно')
    }
  }

  return lines
}

/**
 * ЧЕМ ЭТА ПОПЫТКА ДОКАЗЫВАЕТ, ЧТО РАБОТАЛА ПОД ТВОИМИ ПРАВИЛАМИ — строка паритета.
 *
 * Обещание «безголовая сессия работника — та же сессия, что ты получаешь в своём терминале»
 * ничего не стоит, пока оно СКАЗАНО, и держит вес, когда оно ДОКАЗАНО. Тик оставляет на
 * каждой попытке каталог прогона и считает по нему пятёрку квитанций — хуки, память, правила,
 * навыки, права — тем же модулем, который читает команда проверки. Здесь этот вердикт
 * становится текстом на карточке: счёт, имена непрошедших квитанций и путь, по которому
 * человек откроет каталог и посмотрит сам.
 *
 * ПОЧЕМУ ЧИСЛО, А НЕ ГАЛОЧКА. Пять из пяти — это «одна квитанция с названной границей и
 * четыре чистых», а не «всё хорошо»: права не бывают зелёными вовсе, потому что до процесса
 * доезжает только список инструментов. Поэтому счёт печатается как счёт, а предупреждения
 * считаются отдельно — сведённые в одну галочку, они бы обещали то, чего продукт не даёт.
 *
 * ЗАКОН ЭТОГО ХЕЛПЕРА тот же, что у copyLines, layerLines и lessonLines: ничего не выдумывать.
 * Нет вердикта — нет строки о вердикте; нет каталога — нет пути. `null` значит «никто не
 * проверял», и молчание об этом честнее, чем нарисованный ноль.
 */
function parityLine(attempt: TaskAttempt): string[] {
  const lines: string[] = []
  const parity = attempt.parity
  if (parity && Number.isFinite(parity.fulfilled) && Number.isFinite(parity.total)) {
    const failed = Array.isArray(parity.failed) ? parity.failed : []
    const parts = [
      failed.length > 0
        ? `Паритет: ${parity.fulfilled}/${parity.total} — не прошли: ${failed.join(', ')}`
        : `Паритет: ${parity.fulfilled}/${parity.total}`,
    ]
    if (failed.length === 0 && parity.warn > 0) parts.push(`предупреждений ${parity.warn}`)
    if (attempt.runDir) parts.push(attempt.runDir)
    lines.push(parts.join(' · '))
  } else if (attempt.runDir) {
    // Вердикта нет, а каталог есть — путь всё равно полезен: по нему запускают проверку.
    lines.push(`каталог прогона: ${attempt.runDir}`)
  }
  return lines
}

/** The colour of the mark beside a row — the same three tones the rest of the window uses. */
function dotTone(attempt: TaskAttempt): string {
  if (attempt.outcome === 'failed') return 'bg-err'
  if (attempt.outcome === 'returned') return 'bg-warn'
  if (attempt.outcome === 'completed' || attempt.outcome === 'approved') return 'bg-green'
  return 'bg-blue'
}

/**
 * WHAT THIS ATTEMPT PROVED. Two layers, in order of how much they say:
 *   1. the parsed checks, when a receipt carried them;
 *   2. the proof the tick really wrote — the gate that opened and its evidence.
 *
 * Until today only (1) was shown, and since nothing in the daemon produces those four
 * numbers it meant every real attempt read «квитанции нет» — a sentence that was false on a
 * task whose gate had opened on a re-verified branch. «Нет» is now said only when there is
 * genuinely nothing: no checks AND no reference.
 */
function Checks({ attempt }: { attempt: TaskAttempt }) {
  const checks = receiptChecks(attempt.receipt)
  const proof = receiptProofLabel(attempt.proof)
  if (checks.length === 0 && !proof) {
    return <p className="m-0 text-[12px] text-tx3">Квитанции нет — проверки не дошли до записи.</p>
  }
  return (
    <div className="flex flex-col gap-1.5">
      {proof ? <p className="m-0 text-[12px] text-tx2">{proof}</p> : null}
      {checks.map((c) => (
        <div key={c.text} className="flex justify-between gap-3.5 text-[12px]">
          <span className="text-tx2">{c.text}</span>
          <span className={c.ok ? 'flex-none text-ok-tx' : 'flex-none text-err-tx'}>{c.ok ? '✓' : '✗'}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * ВЕРНУТЬСЯ В СЕССИЮ РАБОТНИКА — одна строка и одна кнопка, которая её отдаёт.
 *
 * Строку собирает чистый модуль под систему, о которой сказал демон; здесь только показ и
 * кнопка. Команда остаётся ТЕКСТОВЫМ УЗЛОМ: путь копии и каталог аккаунта приходят из данных
 * и в разметку не превращаются. Отказ буфера обмена ничего не ломает — строка на месте, её
 * по-прежнему можно выделить и скопировать руками.
 */
function ReturnLine({ command, notes }: { command: string; notes: string[] }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mb-2 flex flex-col gap-0.5 text-[11px] leading-[1.45] text-tx3">
      <div className="flex items-baseline justify-between gap-2">
        <span>вернуться в сессию работника:</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(command).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }}
          className="flex-none text-[11px] whitespace-nowrap text-blue hover:text-teal"
        >
          {copied ? 'скопировано' : 'скопировать'}
        </button>
      </div>
      <code className="mt-0.5 block rounded-[6px] border border-bd bg-card px-2 py-1 font-mono text-[10.5px] break-all text-tx2 select-all">
        {command}
      </code>
      {notes.map((n) => (
        <span key={n} className="break-words">
          {n}
        </span>
      ))}
    </div>
  )
}

function Row({
  attempt,
  note,
  last,
  taskId,
  trace,
  merge,
  platform,
}: {
  attempt: TaskAttempt
  /** The comment that sent this run back, when this run was sent back. */
  note: string | null
  last: boolean
  /** Whose story this is — the transcript door needs the task to name the attempt. */
  taskId: string | null
  /**
   * Коммит слияния приёмки. Приёмка бывает у ЗАДАЧИ, а не у подхода, и относится к тому
   * подходу, чью работу приняли, — поэтому приходит только в свежий ряд, а всем прочим
   * `null`. Показать команду отмены приёмки под вчерашней попыткой значило бы предложить
   * человеку откатить не то, что он видит.
   */
  merge: MergePoint | null
  /**
   * След памяти задачи — и он принадлежит ПОСЛЕДНЕЙ попытке, поэтому приходит только в
   * свежий ряд, а всем прочим `null`. Показать урок сегодняшней попытки под вчерашней —
   * то же выдумывание, что и прочерк вместо данных.
   */
  trace: MemoryTrace | null
  /**
   * Система, о которой сказал демон, — ею и написана строка возврата: одна и та же переменная
   * пишется в PowerShell и в POSIX-оболочке по-разному. `null` — окно ещё не спросило или
   * дверь не ответила, и тогда панели возврата нет: оболочку не угадывают.
   */
  platform: string | null
}) {
  /**
   * ЧТО В ИТОГЕ — РАСКРЫТО НА ТОМ ПОДХОДЕ, РАДИ КОТОРОГО КАРТОЧКУ И ОТКРЫЛИ.
   *
   * Everything this window knows about «кто что делал» — the tools, the files, the commands,
   * the skills, the connections, the handoffs to sub-agents — lives inside this fold, and the
   * fold used to start shut on every row. So the answer to the one question a task card is
   * opened with sat behind a control nobody had a reason to press, and was never seen at all.
   * The freshest run, and any run still going, now opens by itself; the older ones stay
   * folded, because six attempts unfolded at once is not a card.
   *
   * `null` means «никто не трогал»: the row follows the rule above and re-folds by itself
   * once a NEWER attempt takes its place. A click pins the row either way, and a pin is what
   * the person said — nothing later un-says it.
   */
  const openByDefault = last || !attempt.endedAt
  const [pinned, setPinned] = useState<boolean | null>(null)
  const open = pinned ?? openByDefault
  const who = [attempt.workerId, attempt.provider].filter(Boolean).join(' · ')
  const copy = copyLines(attempt)
  const layer = layerLines(attempt)
  const lesson = lessonLines(attempt, trace)
  const parity = parityLine(attempt)
  const rollback = rollbackLines(attempt)
  const undo = rollbackCommand(attempt, merge)
  const back = sessionReturn(attempt, platform)

  return (
    <div className="flex gap-3.5">
      <div className="w-[76px] flex-none pt-px text-right text-[11px] text-tx3 tabular-nums">
        {clockLabel(attempt.startedAt)}
      </div>
      <div className="relative flex w-4 flex-none justify-center">
        <div className={`absolute top-0 left-1/2 w-px bg-bd2 ${last ? 'h-3' : 'bottom-0'}`} />
        <div className={`relative z-10 mt-1 h-[7px] w-[7px] flex-none rounded-full ${dotTone(attempt)}`} />
      </div>
      <div className="min-w-0 flex-1 pb-6">
        <button
          type="button"
          onClick={() => setPinned(!open)}
          aria-expanded={open}
          className="flex items-baseline gap-2 text-left"
        >
          <span className="text-[12.5px] text-tx">
            Подход {attempt.attempt ?? '—'} · {outcomeWords(attempt)}
            {durationWords(attempt) ? (
              <span className="text-tx3 tabular-nums"> · {durationWords(attempt)}</span>
            ) : null}
          </span>
          <span aria-hidden className="text-[9px] text-tx3">
            {open ? '▾' : '▸'}
          </span>
        </button>

        {who ? <div className="mt-1 text-[11px] text-tx3">{who}</div> : null}

        {open ? (
          <div className="mt-2.5 max-w-[440px] rounded-[9px] border border-bd bg-surf px-3.5 py-3">
            <div className="mb-2 flex justify-between gap-3.5 text-[11px] text-tx3 tabular-nums">
              <span>начат {clockLabel(attempt.startedAt)}</span>
              <span>завершён {clockLabel(attempt.endedAt)}</span>
            </div>
            {/* КОПИЯ: где работали и к чему откатывать. Строки приходят из строки попытки —
                той же, что писал тик; пустой список означает «попытка этого не знает», и
                тогда блока нет вовсе. Всё здесь — текстовые узлы: путь и имя ветки приходят
                из данных и в разметку не превращаются. */}
            {copy.length > 0 ? (
              <div className="mb-2 flex flex-col gap-0.5 text-[11px] leading-[1.45] text-tx3">
                {copy.map((line) => (
                  <span key={line} className="break-words">
                    {line}
                  </span>
                ))}
              </div>
            ) : null}
            {/* ВОЗВРАТ: сессия этого подхода жива, и вот чем в неё зайти. Панель приходит
                ровно тогда, когда для строки есть всё нужное; нет сессии или неизвестна
                система — блока нет вовсе, потому что оболочку не угадывают. */}
            {back ? <ReturnLine command={back.command} notes={back.notes} /> : null}
            {/* ОТКАТ: что изменилось, что исчезло, чего никто не перепроверял — и ОДНА
                команда, которой это откатывается. Строки приходят из строки попытки и из
                записи о приёмке; пустой список означает «попытка этого не знает», и тогда
                блока нет вовсе. Имена файлов и путь приходят из чужого репозитория и
                остаются текстовыми узлами — в разметку они не превращаются. */}
            {rollback.length > 0 || undo.command || undo.notes.length > 0 ? (
              <div className="mb-2 flex flex-col gap-0.5 text-[11px] leading-[1.45] text-tx3">
                {rollback.map((line) => (
                  <span key={line} className="break-words">
                    {line}
                  </span>
                ))}
                {undo.command ? (
                  <>
                    <span className="mt-1">откатывается одной командой:</span>
                    <code className="mt-0.5 block rounded-[6px] border border-bd bg-card px-2 py-1 font-mono text-[10.5px] break-all text-tx2 select-all">
                      {undo.command}
                    </code>
                  </>
                ) : null}
                {undo.notes.map((n) => (
                  <span key={n} className="break-words">
                    {n}
                  </span>
                ))}
              </div>
            ) : null}
            {/* ЛИЧНЫЙ СЛОЙ: под какими правилами это работало. Те же текстовые узлы —
                путь авто-памяти и имена плагинов приходят из данных и в разметку не
                превращаются. Пустой список означает «попытка этого не знает», и тогда
                блока нет вовсе. */}
            {layer.length > 0 ? (
              <div className="mb-2 flex flex-col gap-0.5 text-[11px] leading-[1.45] text-tx3">
                {layer.map((line) => (
                  <span key={line} className="break-words">
                    {line}
                  </span>
                ))}
              </div>
            ) : null}
            {/* УРОК, СЛЕД ПАМЯТИ И СУДЬБА ЗАПИСКИ. Тем же блоком, что копия и личный слой,
                и по тому же закону: строки приходят из журнала и строки попытки, пустой
                список означает «попытка этого не знает» — и тогда блока нет вовсе. Имя
                заметки и причина отказа приходят из данных и остаются текстовыми узлами. */}
            {lesson.length > 0 ? (
              <div className="mb-2 flex flex-col gap-0.5 text-[11px] leading-[1.45] text-tx3">
                {lesson.map((line) => (
                  <span key={line} className="break-words">
                    {line}
                  </span>
                ))}
              </div>
            ) : null}
            {/* ПАРИТЕТ: чем эта попытка доказывает, что шла под правилами проекта. Тем же
                блоком и по тому же закону, что копия, слой и урок: строка приходит из строки
                попытки, пустой список означает «попытка этого не знает» — и тогда блока нет
                вовсе. Счёт и путь к каталогу приходят из данных и остаются текстовыми узлами. */}
            {parity.length > 0 ? (
              <div className="mb-2 flex flex-col gap-0.5 text-[11px] leading-[1.45] text-tx3">
                {parity.map((line) => (
                  <span key={line} className="break-words">
                    {line}
                  </span>
                ))}
              </div>
            ) : null}
            {/* Сырой слой двухслойной ошибки: человеческая строка уже в заголовке ряда
                (reasonLabel), здесь — код причины как он записан, для баг-репорта. */}
            {attempt.outcome === 'failed' && attempt.failureReason ? (
              <p className="m-0 mb-2 rounded-[7px] bg-err-s px-2.5 py-1.5 font-mono text-[11px] text-err-tx">
                {attempt.failureReason}
              </p>
            ) : null}
            <Checks attempt={attempt} />
            {/* Свёртка раскрылась — вот и повесть подхода: приказ, ход, результат на одной
                странице (разведка 11.08, Paperclip). Тот же читатель, что «Живой поток». */}
            {taskId ? (
              <div className="mt-3 border-t border-bd pt-3">
                <AttemptLog taskId={taskId} attempt={attempt} />
              </div>
            ) : null}
          </div>
        ) : null}

        {note ? (
          <div className="mt-2.5 max-w-[440px] rounded-[10px] border border-bd bg-surf px-3.5 py-2.5">
            <div className="mb-1 text-[10.5px] text-tx3">Вы вернули с комментарием</div>
            <div className="text-[12.5px] leading-[1.5] text-tx">{note}</div>
          </div>
        ) : null}

        {/*
          КОНСПЕКТ ПЕРЕДАЧИ — рядом с моментом возврата, потому что он и есть то, с чем задача
          возвращается в работу: ровно этот текст уедет в промпт следующего подхода. Показан
          как есть, без сокращений на нашей стороне: обрезка случилась ОДИН раз, при записи, и
          если бы окно резало ещё раз, человек читал бы не то, что получит работник.

          ПУСТОГО СЛУЧАЯ НА ЭКРАНЕ НЕТ. Нет файла — нет панели; ни прочерка, ни «неизвестно».
          «Передавать было нечего» — это сведение, и оно приезжает словами ВНУТРИ конспекта.
        */}
        {attempt.continuationSummary ? (
          <div className="mt-2.5 max-w-[440px] rounded-[10px] border border-bd bg-surf px-3.5 py-2.5">
            <div className="mb-1 text-[10.5px] text-tx3">Конспект передачи</div>
            <div className="whitespace-pre-wrap text-[12.5px] leading-[1.5] text-tx">
              {attempt.continuationSummary.text}
            </div>
            {attempt.continuationSummary.truncated ? (
              <div className="mt-1.5 text-[10.5px] text-tx3">
                Конспект обрезан по потолку — работник получит ровно этот же текст.
              </div>
            ) : null}
          </div>
        ) : null}

        {/*
          КОНТЕКСТ ЗАДАЧИ — то, с чем ЭТОТ подход ушёл в работу: тот же текст, слово в слово,
          который работник получил блоком данных в промпте и файлом в своей копии.

          ПОКАЗАН У ПОДХОДА, А НЕ В ШАПКЕ ЗАДАЧИ, и это разные утверждения. Человек дописывает
          контекст после сорванного подхода — строка задачи становится другой, а этот подход
          ушёл с тем, что у него было. Здесь стоит историческая правда попытки; расхождение со
          строкой не рассинхрон, а весь смысл панели.

          ПУСТОГО СЛУЧАЯ НА ЭКРАНЕ НЕТ. Нет поля — нет панели; ни прочерка, ни «неизвестно».
        */}
        {attempt.taskContext ? (
          <div className="mt-2.5 max-w-[440px] rounded-[10px] border border-bd bg-surf px-3.5 py-2.5">
            <div className="mb-1 text-[10.5px] text-tx3">Контекст задачи</div>
            <div className="whitespace-pre-wrap text-[12.5px] leading-[1.5] text-tx">{attempt.taskContext}</div>
            <div className="mt-1.5 text-[10.5px] text-tx3">
              С этим контекстом ушёл этот подход — слова задачи могли поменяться после него.
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function AttemptTimeline({
  attempts,
  returnedNotes,
  taskId = null,
  memoryTrace = null,
  merge = null,
}: {
  attempts: TaskAttempt[]
  returnedNotes: string[]
  /** Present when the timeline lives on a task card — unlocks the per-attempt transcript. */
  taskId?: string | null
  /**
   * Коммит слияния приёмки — то, чем отменяется ПРИНЯТАЯ работа. Приходит в последний ряд
   * и только в него, по той же причине, что и след памяти. `null` у задачи, которую не
   * принимали, и у принятых до того, как запись научилась нести отпечаток целиком.
   */
  merge?: MergePoint | null
  /**
   * След памяти задачи из журнала. Приходит в ПОСЛЕДНИЙ ряд и только в него: слой памяти
   * пишет каждая попытка, а читается верхний — то есть свежий. Отсутствует у задач старше
   * слоя, и тогда о памяти не говорится ничего.
   */
  memoryTrace?: MemoryTrace | null
}) {
  // ЧЕМ НАПИСАНА СТРОКА ВОЗВРАТА. Систему называет демон — тот самый, что держит сессии, — и
  // спрошена она ОДИН раз на всю ленту, а не в каждом ряду. Ответ кэшируется навсегда: это
  // свойство машины, а не состояние работы.
  const platform = useDiagnosticsQuery().data?.platform ?? null

  if (attempts.length === 0) {
    return <p className="m-0 text-[12.5px] text-tx3">Работа ещё не начиналась — задача ждёт своей очереди.</p>
  }

  // The n-th comment belongs to the n-th run that was sent back — the order the read model
  // built them in. A run that is not a return takes no comment.
  let returned = 0

  return (
    <div className="flex flex-col">
      {attempts.map((a, i) => {
        const note = a.outcome === 'returned' ? (returnedNotes[returned++] ?? null) : null
        const last = i === attempts.length - 1
        return (
          <Row
            key={`${a.attempt ?? i}-${a.startedAt ?? i}`}
            attempt={a}
            note={note}
            last={last}
            taskId={taskId}
            trace={last ? memoryTrace : null}
            merge={last ? merge : null}
            platform={platform}
          />
        )
      })}
    </div>
  )
}
