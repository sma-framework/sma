/**
 * bug-journal-sweep.mjs — ЕДИНЫЙ ЖУРНАЛ СРЫВОВ, СВЕДЁННЫЙ ОДНОЙ КОМАНДОЙ, без демона.
 *
 * ЧТО ЭТО ДЕЛАЕТ. Ровно то же, что тик демона делает шагом (1c): спрашивает очередь, какие
 * задачи она называет сорвавшимися, кладёт рядом слово реестра попыток о каждой и дописывает
 * в `<ledgerDir>/bugs.jsonl` то, чего там ещё нет. ТА ЖЕ функция (`sweepBugJournal`), а не
 * её пересказ: журнал, наполненный историей одной командой и продолженный другим кодом, —
 * это два кода, которые разойдутся, и никто об этом не узнает.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ КОМАНДА, ЕСЛИ ТИК И ТАК ХОДИТ. Затем, что первый раз журнал наполняется по
 * истории, а история уже случилась: демон, который сейчас работает, начнёт писать со
 * следующего запуска, а вопрос «почему у нас срывались задачи» задан сегодня. Команда
 * читает только: SELECT по очереди (её собственным читателем — `adapter.list`, а не своим
 * запросом) и файлы реестра. Ничего в очереди она не трогает — ни pg-boss не поднимает, ни
 * состояний не правит.
 *
 * КАК ЗАПУСКАТЬ:
 *   node tools/bug-journal-sweep.mjs              # свести и дописать
 *   node tools/bug-journal-sweep.mjs --dry        # только показать, ничего не писать
 *   node tools/bug-journal-sweep.mjs --json       # то же самое машинно
 *   node tools/bug-journal-sweep.mjs --config <путь> --ledger <каталог>
 *
 * ПОЧЕМУ `--dry` РЕАЛИЗОВАН ПОДМЕНОЙ ШВА ЗАПИСИ, а не флагом внутри прохода: проход не
 * должен знать слова «репетиция». Ему дают шов, который считает записи и ничего не пишет, —
 * и это тот же самый проход, что бежит в демоне, с точностью до одной функции.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createPgBossQueue } from '../daemon/src/queue/pgboss-backend.mjs'
import { readAttempts } from '../daemon/src/queue/attempt-ledger.mjs'
import { appendBug, readBugs, sweepBugJournal, summarizeBugs } from '../daemon/src/queue/bug-journal.mjs'
import { REASON_LABELS } from '../daemon/src/queue/adapter.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const configPath = arg('config') || process.env.SMA_DAEMON_CONFIG || join(homedir(), '.sma-daemon', 'config.json')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
// ТОТ ЖЕ ВЫВОД, ЧТО У ДЕМОНА: каталог реестра рядом с файлом настроек, когда файл о нём
// молчит (config.mjs, derivedDirsFor). Здесь он повторён одной строкой намеренно — тянуть
// ради одного пути весь загрузчик настроек значило бы записать в файл человека производные
// ключи, которых он там не держит.
const ledgerDir = arg('ledger') || config.ledgerDir || join(configPath, '..', 'ledger')

const dry = has('dry')
const asJson = has('json')

const adapter = createPgBossQueue({ queueUrl: config.queueUrl, ledgerDir, log: () => {} })

const written = []
const ledger = {
  readAttempts: (taskId) => readAttempts(ledgerDir, taskId),
  readBugs: () => readBugs(ledgerDir),
  appendBug: (entry) => {
    written.push(entry)
    return dry ? entry : appendBug(ledgerDir, entry)
  },
}

const before = readBugs(ledgerDir)
const summary = await sweepBugJournal({ adapter, ledger })
const after = dry ? [...before, ...written] : readBugs(ledgerDir)
const totals = summarizeBugs(after)

if (asJson) {
  console.log(JSON.stringify({ ledgerDir, dry, sweep: summary, totals, appended: written }, null, 2))
} else {
  console.log(`журнал: ${join(ledgerDir, 'bugs.jsonl')}${dry ? '  (репетиция — ничего не записано)' : ''}`)
  console.log(`просмотрено сорвавшихся задач: ${summary.examined}; дописано: ${summary.appended}; уже было: ${summary.skipped}`)
  console.log(`\nв журнале задач: ${totals.tasks}`)
  console.log('по проектам: ' + Object.entries(totals.byProject).map(([k, v]) => `${k} — ${v}`).join('; '))
  console.log('\nпо причинам:')
  for (const [code, count] of Object.entries(totals.byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${code}${REASON_LABELS[code] ? ` — ${REASON_LABELS[code]}` : ''}`)
  }
  if (totals.disagreed.length > 0) {
    // ГЛАВНОЕ ЧИСЛО ЭТОГО ОТЧЁТА. Здесь экран показывает не то слово, на котором работа
    // сломалась: причина есть, но до карточки доехала другая.
    console.log(`\nэкран показывает не ту причину (слово очереди ≠ слово реестра): ${totals.disagreed.length}`)
    console.log('  ' + totals.disagreed.join(', '))
  }
  if (totals.queueOnly.length > 0) {
    // ПРИЧИНА, КОТОРАЯ ПЕРЕЖИВЁТ НЕ ВСЁ: слово есть только у строки задания, а её очередь
    // хранит по своему сроку. Реестр об этих задачах молчит — попытки не было вовсе.
    console.log(`\nпричина только у очереди (реестр молчит, слово смертно): ${totals.queueOnly.length}`)
    console.log('  ' + totals.queueOnly.join(', '))
  }
  console.log(
    `\nпричина не сохранилась НИГДЕ: ${totals.silent.length}` +
      (totals.silent.length > 0 ? `\n  ${totals.silent.join(', ')}` : ''),
  )
}

process.exit(0)
