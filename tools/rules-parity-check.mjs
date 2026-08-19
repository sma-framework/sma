/**
 * rules-parity-check.mjs — ONE READING COMMAND OVER TWO LIVE SETTINGS FILES.
 *
 * ═══════════════════════════ WHAT THIS COMMAND ANSWERS ═══════════════════════════
 * «Does the unattended worker play by the same rules as my own terminal?» — asked of the two
 * files that actually decide it: the settings of the person's own configuration directory,
 * and the settings of the worker account the daemon spawns into.
 *
 *     node tools/rules-parity-check.mjs                    # this machine, the first worker
 *     node tools/rules-parity-check.mjs --worker max-2     # a named account
 *     node tools/rules-parity-check.mjs --config <path> --json
 *
 * THE RULE IT CHECKS IS NOT «THE TWO FILES ARE EQUAL», and the difference matters. A
 * permission file has a narrowing half (`deny`, `ask`) that can only take rights away and a
 * widening half (`allow`, `defaultMode`) that can only add them. Copying the widening half
 * onto a worker hands an unattended session the rights of a person sitting at a keyboard —
 * measured, not argued: with the author's own settings in place a worker's `git push` goes
 * through, and without them the same call is refused. So the rule is: the narrowing half
 * matches rule for rule, the widening half is DECLARED not-mirrored and absent from the
 * worker. The verdict itself lives in `scripts/sma/lib/rules-parity.mjs`; this file is the
 * MOUTH — it finds the two files, reads them, prints, and returns an exit code.
 *
 * WHAT IT NEVER DOES: write. Not to the person's settings, not to the worker's, not to a
 * temporary file beside either. A tool that can write into a live personal configuration
 * will one day write into one, so this one holds no write path at all — and the suite proves
 * that by driving this entry point over a filesystem whose every write method throws.
 *
 * OUTPUT CONTRACT. The counted rules of both sides, one line per check, every divergence by
 * name, then the two lines that state where the boundaries differ ON PURPOSE, and a LAST
 * LINE that is a bare number 0..3. Exit 0 only on a full set; 1 on a divergence or on
 * nothing to read; 2 on a misused command line. `--json` prints the same verdict as an
 * object first and the same bare number last.
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'

import { compareRules, NOT_MIRRORED, WIDENING_KEYS } from '../scripts/sma/lib/rules-parity.mjs'
import { readFounderLayer, PERSONAL_LAYER_DECLARATION } from '../daemon/src/runner/personal-layer.mjs'
import { expandHome } from '../daemon/src/runner/readiness.mjs'
import { resolveConfigPath } from '../daemon/src/config.mjs'

/** How many checks make a full set. The last line of every mode is «how many of these». */
export const RULES_PARITY_CHECKS = 3

export const USAGE = [
  'usage: node tools/rules-parity-check.mjs [--worker <id>] [--config <path>] [--terminal <dir>] [--json]',
  '',
  '  Читающая сверка правил ДВУХ живых файлов: настроек Вашего терминала и настроек аккаунта',
  '  работника. Ни один из них командой не изменяется — записи в ней нет вовсе.',
  '',
  '  Правило: сужающее (deny, ask) совпадает буква в букву; расширяющее (allow, defaultMode)',
  '  объявлено незеркалируемым и у работника отсутствует. Последняя строка вывода — число',
  `  выполненных проверок (0..${RULES_PARITY_CHECKS}); код 0 только при полном наборе.`,
  '',
  '  --worker выбирает аккаунт по идентификатору из настроек демона (по умолчанию первый),',
  '  --config подменяет сами настройки демона, --terminal — каталог настроек человека.',
].join('\n')

/**
 * parseArgv(argv) → `{worker, config, terminal, json}` or `{error}`.
 * Every flag needs a value except `--json`; an unknown flag is an error rather than a guess,
 * because a misspelled `--worker` that silently checked a different account would be worse
 * than no answer at all.
 */
export function parseArgv(argv) {
  const list = Array.isArray(argv) ? argv.map(String) : []
  const out = { worker: null, config: null, terminal: null, json: false }
  const valued = new Set(['--worker', '--config', '--terminal'])
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i]
    if (valued.has(arg)) {
      const value = list[i + 1]
      if (value === undefined || value.startsWith('--')) return { error: `флаг ${arg} требует значения` }
      out[arg.slice(2)] = value
      i += 1
    } else if (arg === '--json') {
      out.json = true
    } else {
      return { error: `неизвестный аргумент "${arg}"` }
    }
  }
  return out
}

/** The two filesystem methods this command is allowed to have, each one injectable. */
function io(fsImpl) {
  return {
    existsSync: (fsImpl && fsImpl.existsSync) || fsExistsSync,
    readFileSync: (fsImpl && fsImpl.readFileSync) || fsReadFileSync,
  }
}

/** A JSON file that may be absent or broken; both answers are named, never thrown. */
function readJson(fs, path) {
  if (!path || !fs.existsSync(path)) return { value: null, why: 'файла нет' }
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return { value: null, why: 'файл не объект' }
    return { value: parsed, why: null }
  } catch (err) {
    return { value: null, why: `не разбирается как JSON: ${err && err.message}` }
  }
}

/** `94` / `—` — a number when the side has such a list, a dash when it has no such key. */
function shown(value) {
  return value === null || value === undefined ? '—' : String(value)
}

/** One side's numbers on one line, so the two can be read against each other. */
function countLine(label, counts, path) {
  if (!counts) return `${label}: данных нет (${path})`
  return (
    `${label}: allow ${shown(counts.allow)} · deny ${shown(counts.deny)} · ` +
    `ask ${shown(counts.ask)} · defaultMode ${shown(counts.defaultMode)}  (${path})`
  )
}

/**
 * THE TWO SENTENCES THAT ARE NOT CHECKS, and both of them earn their place.
 *
 * The first stops a reader from «fixing» a difference that is deliberate: the boundaries of
 * the two sides are supposed to differ, and where they differ is stated rather than left to
 * be discovered as a suspicion. The second stops a reader from «fixing» a breakage that does
 * not exist: the worry that a composite command sneaks a forbidden call through a
 * substitution was measured and is false — the harness splits the substitution apart, refuses
 * the forbidden part by name and runs the safe part. Someone who did not know that would
 * narrow the allowed list to be safe, and narrowing the allowed list is precisely how an
 * unattended worker is turned into a session that cannot do its job.
 */
function deliberateLines() {
  return [
    'НАРОЧНО РАЗНЫЕ: у человека граница — его собственная подушка безопасности (список разрешений',
    '  и режим по умолчанию в его файле); у работника — запрет в аргументах запуска',
    '  (--disallowedTools) плюс парковочный билет на опасный вызов. Это разделение ролей,',
    '  а не расхождение: сужающее у них общее, расширяющее у каждого своё.',
    'СОСТАВНЫЕ КОМАНДЫ: подстановка вида $(...) раскладывается харнессом на части и проверяется',
    '  по частям — запрещённая часть отказывается по имени, безопасная выполняется (измерено',
    '  прогоном). Сужать список разрешённого ради этой мнимой поломки не нужно и вредно.',
  ]
}

/**
 * runCheck(argv, {fsImpl, log, err, env, homedir}) → the process exit code.
 * The whole body with every seam injected, so the suite drives the real entry point over
 * temporary directories and never looks at the configuration of the machine it runs on.
 */
export function runCheck(argv, { fsImpl, log = console.log, err = console.error, env = process.env, homedir = osHomedir } = {}) {
  const parsed = parseArgv(argv)
  if (parsed.error) {
    err(`rules-parity-check: ${parsed.error}`)
    err(USAGE)
    return 2
  }
  const fs = io(fsImpl)

  // ── (1) ГДЕ ДВА ФАЙЛА. Ни один путь не зашит именем машины: настройки демона говорят,
  // какой каталог у работника и какой каталог человека, ровно как их читает сам демон.
  const configPath = parsed.config ?? resolveConfigPath({ env, homedir })
  const config = readJson(fs, configPath)
  const workers = config.value && Array.isArray(config.value.workers) ? config.value.workers : []

  let worker = null
  if (parsed.worker) {
    worker = workers.find((w) => w && String(w.id) === parsed.worker) ?? null
    if (!worker) {
      err(`rules-parity-check: данных нет: работник "${parsed.worker}" в настройках демона не найден (${configPath})`)
      return 1
    }
  } else {
    worker = workers.find((w) => w && w.account && w.account.configDir) ?? null
    if (!worker) {
      err(`rules-parity-check: данных нет: настройки демона без работников с каталогом аккаунта (${configPath})`)
      return 1
    }
  }

  const terminalDir = expandHome(
    parsed.terminal ??
      (config.value && config.value.personalLayer && config.value.personalLayer.sourceDir) ??
      join(homedir(), '.claude'),
    homedir,
  )
  const workerDir = expandHome((worker.account && worker.account.configDir) || '', homedir)
  const terminalPath = join(terminalDir, 'settings.json')
  const workerPath = workerDir ? join(workerDir, 'settings.json') : ''

  const terminal = readJson(fs, terminalPath)
  const workerSettings = readJson(fs, workerPath)
  if (terminal.why) err(`rules-parity-check: настройки терминала — ${terminal.why} (${terminalPath})`)
  if (workerSettings.why) err(`rules-parity-check: настройки работника — ${workerSettings.why} (${workerPath})`)

  // ── (2) ЧТО ЗЕРКАЛО ПРЕДЛОЖИТ В СЛЕДУЮЩИЙ РАЗ. Not a restatement of the rule: the mirror's
  // own reading half is CALLED here (it only reads), and what it offers to carry is judged by
  // the very same function that judges the file on disk. A mirror that started carrying the
  // widening half would fail this line before anyone had to run a worker to find out.
  let offer = null
  let offerWhy = null
  try {
    offer = readFounderLayer({ sourceDir: terminalDir, fsImpl, homedir }).permissions
  } catch (error) {
    offerWhy = String((error && error.message) || error)
  }

  const verdict = compareRules({
    terminal: terminal.value,
    worker: workerSettings.value,
    declaration: PERSONAL_LAYER_DECLARATION,
  })
  const mirror = offer
    ? compareRules({ terminal: terminal.value, worker: { permissions: offer }, declaration: PERSONAL_LAYER_DECLARATION })
    : null

  const checks = [
    {
      id: 'narrowing',
      ok: verdict.denyEqual && verdict.askEqual,
      title: 'сужающее совпадает буква в букву',
      detail: verdict.counts.terminal && verdict.counts.worker
        ? `deny ${verdict.counts.worker.deny} из ${verdict.counts.terminal.deny}, ask ${verdict.counts.worker.ask} из ${verdict.counts.terminal.ask}`
        : 'данных нет',
    },
    {
      id: 'widening',
      ok: verdict.widened.length === 0 && verdict.allowDeclared && verdict.defaultModeDeclared,
      title: 'расширяющее не зеркалируется и объявлено',
      detail:
        verdict.widened.length > 0
          ? `у работника есть расширяющее: ${verdict.widened.join(', ')}`
          : `${WIDENING_KEYS.join(' и ')} — «${NOT_MIRRORED}»`,
    },
    {
      id: 'mirror',
      ok: Boolean(mirror && mirror.verdict === 'ok'),
      title: 'зеркало предлагает работнику ровно сужающее',
      detail: mirror
        ? mirror.verdict === 'ok'
          ? `deny ${offer.deny.length}, ask ${offer.ask.length}, расширяющего не несёт`
          : mirror.reasons.join('; ')
        : `данных нет: ${offerWhy || 'зеркало не прочитало каталог человека'}`,
    },
  ]

  const fulfilled = checks.filter((c) => c.ok).length
  const exitCode = fulfilled === RULES_PARITY_CHECKS ? 0 : 1

  if (parsed.json) {
    log(
      JSON.stringify(
        {
          terminal: { path: terminalPath, counts: verdict.counts.terminal },
          worker: { id: worker.id ?? null, path: workerPath, counts: verdict.counts.worker },
          declaration: PERSONAL_LAYER_DECLARATION,
          checks: checks.map(({ id, ok, title, detail }) => ({ id, ok, title, detail })),
          diffs: verdict.diffs,
          widened: verdict.widened,
          reasons: verdict.reasons,
          deliberate: deliberateLines(),
          verdict: exitCode === 0 ? 'ok' : 'fail',
          fulfilled,
          exitCode,
        },
        null,
        2,
      ),
    )
    log(String(fulfilled)) // the bare number stays the last line in every mode
    return exitCode
  }

  log(countLine('правила терминала', verdict.counts.terminal, terminalPath))
  log(countLine('правила работника', verdict.counts.worker, workerPath))
  for (const check of checks) log(`${check.ok ? 'OK  ' : 'FAIL'} — ${check.title}: ${check.detail}`)
  for (const diff of verdict.diffs) log(`  · ${diff.list}: ${diff.says}`)
  for (const reason of verdict.reasons) {
    if (!verdict.diffs.length || !reason.startsWith('сужающий список')) log(`  · ${reason}`)
  }
  for (const line of deliberateLines()) log(line)
  log(String(fulfilled))
  return exitCode
}

// CLI entry: only when executed directly, never on import (the suite imports this module).
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/rules-parity-check.mjs')) {
  process.exit(runCheck(process.argv.slice(2)))
}
