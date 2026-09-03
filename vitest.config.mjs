import { readdirSync, readFileSync } from 'node:fs'
import { availableParallelism, cpus } from 'node:os'
import { join } from 'node:path'
import { defaultExclude, defineConfig } from 'vitest/config'

/**
 * ПОТОЛОК ПОТОКОВ НА ОДИН ПРОГОН — почему прогон больше не забирает машину целиком.
 *
 * По умолчанию vitest берёт столько рабочих, сколько у машины потоков, и это верно ровно
 * для одного прогона на пустой машине. Здесь прогонов не один: четыре работника, сдающие
 * работу одновременно, — это четыре полных набора разом, и замер 02.09.2026 показал, во что
 * это обходится: под полусотней процессов node свободной памяти оставалось 0,2–0,3 ГБ, а
 * процессор стоял в полке. Проигрывают при этом ВСЕ прогоны сразу, включая тот, который
 * начался первым: время каждого растёт быстрее, чем падает время очереди.
 *
 * Отсюда потолок — треть потоков машины, и он ВЫЧИСЛЕН, а не вписан константой: на шести
 * потоках это два рабочих, на двенадцати — четыре, на тридцати двух — десять. Константа
 * («4») была бы правдой ровно про ту машину, на которой её замерили, и молча стала бы либо
 * удавкой, либо той же полкой на следующей. Треть выбрана так, чтобы ТРИ прогона умещались
 * рядом, не отнимая машину друг у друга и не отнимая её у человека.
 *
 * Потолок общий на весь прогон, а не на проект: пул у vitest один, поэтому параллельная
 * группа и последовательная делят одно и то же число рабочих. Последовательной это ничего
 * не меняет — `fileParallelism: false` и так держит её на одном файле за раз.
 *
 * Что это НЕ делает: не убирает ни одного теста и не меняет глубину набора. Полный прогон
 * остаётся полным; меняется только то, сколько машины он берёт под себя.
 *
 * ОБХОДНОЙ ПУТЬ ДЛЯ ПРОГОНА, КОТОРЫЙ НА МАШИНЕ ОДИН. Треть — правда про соседей, и она же
 * ложь про посадку: сведение ветки меряет дерево ОДИН раз, машина в этот момент ничем не
 * занята, а прогон всё равно брал треть и стоял втрое дольше нужного. Поэтому потолок
 * переопределяется извне — `SMA_TEST_WORKERS=<число>|max`, — и называет его тот, кто ЗНАЕТ
 * обстановку: посадка передаёт `max` (вся машина), работникам во флоте не передаёт никто, и
 * у них остаётся треть. Переменная, а не флаг, по одной причине: прогон запускается не одной
 * дверью (`npm test`, `npm run test:fast`, дочерний процесс посадки), а окружение доезжает
 * через все три одинаково. Число выше машинного смысла не имеет — больше процессов на те же
 * потоки быстрее не считают, — поэтому оно подрезается до числа потоков машины.
 */
export const MACHINE_THREADS = (() => {
  try {
    const n = availableParallelism()
    if (Number.isFinite(n) && n > 0) return n
  } catch {
    /* availableParallelism появился не везде — падать на этом нельзя */
  }
  const n = cpus()?.length
  return Number.isFinite(n) && n > 0 ? n : 1
})()

/** Имя переменной окружения, которой переопределяют потолок потоков на один прогон. */
export const TEST_WORKERS_ENV = 'SMA_TEST_WORKERS'

/**
 * Потолок ЭТОГО прогона: названный снаружи или общий (треть машины).
 *
 * `max` — вся машина: так зовёт себя прогон, который на машине один (посадка). Число —
 * столько рабочих, сколько названо, но не больше, чем у машины потоков. Мусор («»,
 * «сколько-нибудь», ноль, минус) молча роняет ответ обратно на треть: сорванная переменная
 * не должна отнимать машину у соседей и не должна ронять прогон.
 *
 * Отдельной функцией, а не выражением на месте, чтобы правило было проверяемо тестом со
 * своим окружением, а не только своим результатом на этой машине.
 */
export function resolveMaxWorkers(env = process.env, machineThreads = MACHINE_THREADS) {
  const share = Math.max(1, Math.floor(machineThreads / 3))
  const said = String((env && env[TEST_WORKERS_ENV]) ?? '').trim()
  if (!said) return share
  if (said.toLowerCase() === 'max') return Math.max(1, machineThreads)
  const asked = Number(said)
  if (!Number.isFinite(asked) || asked < 1) return share
  return Math.min(Math.floor(asked), Math.max(1, machineThreads))
}

export const RUN_MAX_WORKERS = resolveMaxWorkers()

/**
 * LIVE_MARKERS — чем «живой» тест отличается от юнита, и почему это ПРАВИЛО, а не список.
 *
 * Быстрый ярус — тот, что гоняют ПО ХОДУ работы, десятки раз за сессию, — обязан быть
 * дешёвым: никаких настоящих дочерних процессов, никаких настоящих копий репозитория,
 * никакого Postgres. Одноразовый каталог под `mkdtemp` живым тестом не делает и в маркеры
 * не входит: это несколько файлов на диске для внутрипроцессного кода, миллисекунды. Дорого
 * стоит ПРОЦЕСС — а настоящую копию иначе как через `git worktree add` и не завести, так что
 * `child_process` ловит и её. Отобрать такие файлы можно было списком имён, и список немедленно
 * начал бы врать: каждый новый живой тест попадал бы в быстрый ярус, пока кто-нибудь не
 * заметил бы, что пара минут превратилась в десятки, и не дописал бы ещё одну строку.
 * Ровно та болезнь, которую этот файл уже лечил на shebang'ах — список жертв против правила
 * о классе.
 *
 * Поэтому ярус вычисляется из ИСХОДНИКА теста: файл, который зовёт `child_process` (а через
 * него — и настоящую копию репозитория) или тянет Postgres, — живой по определению и в
 * быстрый ярус не идёт; `mkdtemp` сам по себе в маркеры не входит, см. абзац выше. Правило
 * ошибается только в безопасную сторону: лишний файл, отнесённый к живым, делает быстрый
 * ярус беднее, но никогда не делает его медленным вранием. Полный набор от этого не
 * меняется вовсе — он гоняет ВСЁ и остаётся единственным гейтом.
 *
 * Экспортируется, чтобы само правило было проверяемо тестом, а не только своим результатом.
 */
export const LIVE_MARKERS = [
  // настоящий дочерний процесс: spawn/exec/fork — и настоящая копия репозитория тоже,
  // потому что `git worktree add` иначе не позвать
  /child_process/,
  // Postgres в любом виде — драйвер или очередь поверх него
  /\bpg-boss\b/,
  /from ['"]pg['"]/,
]

/** Живой ли этот тест — по его собственному исходнику. */
export function isLiveSuite(source) {
  if (typeof source !== 'string') return false
  return LIVE_MARKERS.some((re) => re.test(source))
}

/**
 * TEST_DIRS — два каталога, в которых живут тесты продукта. Держатся здесь, а не в двух
 * местах: `INCLUDE` ниже собирается из них же, поэтому «где лежат тесты» — один ответ.
 */
const TEST_DIRS = ['scripts/sma/__tests__', 'daemon/__tests__']

/** Все файлы тестов дерева, путями от корня — без глоба, обычным обходом каталога. */
export function allSuites(root = process.cwd()) {
  const found = []
  for (const dir of TEST_DIRS) {
    let entries
    try {
      entries = readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    } catch {
      continue // каталога нет — это не поломка конфига
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.test.ts')) continue
      const rel = join(e.parentPath ?? e.path ?? join(root, dir), e.name)
      found.push(rel.slice(root.length + 1).split('\\').join('/'))
    }
  }
  return found.sort()
}

/**
 * unitSuites() — быстрый ярус: всё, что не последовательная группа и не живой тест.
 * Читает исходники один раз, при сборке конфига быстрого яруса.
 */
export function unitSuites(root = process.cwd()) {
  const serial = new Set(SERIAL_SUITES)
  return allSuites(root).filter((rel) => {
    if (serial.has(rel)) return false
    try {
      return !isLiveSuite(readFileSync(join(root, rel), 'utf8'))
    } catch {
      return false
    }
  })
}

/**
 * SERIAL_SUITES — the files that must not run beside eleven other workers.
 *
 * Everything else in this suite is in-process. These seven are not: between them
 * they run the REAL installer five times (each copy is ~459 files), copy the whole
 * sma-core payload into a temp tree, spawn the real `sma-tools` binary twenty-two
 * times, spawn the 9.7k-line `cli.mjs` fourteen times, and drive ~60 REAL `git`
 * processes through mkdtemp repositories. That work is the POINT of these tests —
 * the defects they cover were only ever visible through a real child process — so
 * it cannot be mocked away without deleting the coverage.
 *
 * What it cannot survive is being stacked on top of the default file parallelism:
 * measured on this machine, one parallel full run in four was green and the
 * failing set differed every time, while a `--no-file-parallelism` run was
 * 2368/2368. A gate that is green one run in four is not a gate. So these
 * seven are pinned to their own project, run with
 * `fileParallelism: false`, in a LATER group order — `sequence.groupOrder` runs
 * groups from lowest to highest, so this group starts only once the parallel
 * group has finished and the machine is otherwise idle. The remaining ~129 files
 * keep the default parallelism and the whole suite still finishes in about a
 * minute.
 *
 * This is the smaller, honest half of the cure; the other half lives in the files
 * themselves (the races and the duplicate child-process deadlines were fixed, and
 * every spawn now reports status/signal/stderr instead of dying inside
 * `JSON.parse`). Pinning buys determinism, not silence: a real regression in any
 * of the seven still turns this suite red.
 */
export const SERIAL_SUITES = [
  'scripts/sma/__tests__/manifest.test.ts',
  'scripts/sma/__tests__/init-hooks.test.ts',
  // The install/uninstall inversion plus the four hook verbs driven by real
  // event frames: one more REAL installer run and a child process per verb.
  'scripts/sma/__tests__/hooks-wire.test.ts',
  'scripts/sma/__tests__/install-layout.test.ts',
  'scripts/sma/__tests__/undo.test.ts',
  'scripts/sma/__tests__/phase-id.test.ts',
  // Nine `sma-tools` spawns: three of the four tracking-verb defects it covers were
  // only ever visible at the operator's terminal (exit code + printed envelope), so
  // the child process is the coverage and cannot be mocked away.
  'scripts/sma/__tests__/tracking-verbs.test.ts',
  // Five throwaway repositories, five real `git worktree add`, and seven CLI spawns —
  // plus real junctions whose teardown order is itself the subject. None of it survives
  // being stacked beside eleven other workers on one machine.
  'scripts/sma/__tests__/worktree-materialize.test.ts',
  // Six more throwaway repositories with real junctions, six more CLI spawns, and one
  // case that is deliberately destructive to the target it created itself — the platform
  // control that justifies unhooking links before git ever sees the copy.
  'scripts/sma/__tests__/worktree-remove-safe.test.ts',
  // One more throwaway repository with a real linked copy, and four CLI spawns: which
  // tree a lesson lands in when nobody names a corpus is a question only a real
  // 'git worktree add' can answer, and a double would answer it from the very
  // assumption under test.
  'scripts/sma/__tests__/memory-write-corpus.test.ts',
  // The daemon's side of the same story. It drives ONE throwaway repository through the REAL
  // CLI twice — provision, then remove — so the verb answers the rest of that file fakes are
  // proved to be a SUBSET of the live ones. A fake that knows more than the library is how a
  // green suite once covered a call to a method that did not exist.
  'daemon/__tests__/worktree-cleanup.test.ts',
  // Три одноразовых репозитория с настоящими копиями и восемь запусков CLI: доехал ли урок
  // из копии в корпус — вопрос, на который отвечает настоящий конвейер записи, а подделка
  // отвечала бы на него из того самого допущения, которое проверяется.
  'daemon/__tests__/memory-harvest.test.ts',
  // Одноразовый репозиторий на каждый кейс и десяток запусков настоящего CLI: вопрос
  // «пересобрался ли производный индекс сам» — это вопрос о том, что процесс сделал с
  // диском, и внутрипроцессная подделка отвечала бы на него из допущения, которое и
  // проверяется. Часть кейсов запускает Node с выключенным встроенным SQLite.
  'scripts/sma/__tests__/memory-index-rebuild.test.ts',
  // Пять запусков настоящего CLI поверх временного дерева с четырьмя корпусами: что
  // именно верб НАПЕЧАТАЛ и с каким кодом вышел — вопрос о процессе, и подделка
  // отвечала бы на него из того же допущения, которое проверяется.
  'scripts/sma/__tests__/history-search.test.ts',
  // Три запуска настоящей командной строки и один одноразовый репозиторий: две самопроверки
  // верба слияния (их контракт — напечатанное число и код выхода, то есть вопрос о процессе)
  // и сам верб, прогнанный от начала до конца на красном прогоне. Внутрипроцессная подделка
  // ответила бы здесь из того самого допущения, которое и проверяется, — забытое ожидание
  // видно только по тому, что верб НАПЕЧАТАЛ и с каким кодом вышел.
  'scripts/sma/__tests__/merge-verb.test.ts',
  // Два настоящих прогона сьютера над одноразовыми деревьями: «запустился ли прогонятель
  // вообще» — вопрос о процессе, и внутрипроцессная подделка ответила бы на него из того
  // самого допущения, которое проверяется. Именно так и уехал прогонятель, отвечавший
  // «красные», не запустив ни одного теста.
  'scripts/sma/__tests__/merge-smoke.test.ts',
  // Одноразовый репозиторий с настоящим git и БОЕВАЯ фабрика демона без переопределений:
  // доехал ли прогонятель до ритуала — вопрос о собранном объекте, а не о тексте исходника.
  'daemon/__tests__/merge-wire.test.ts',
  // Семь одноразовых репозиториев с настоящими ветками, настоящим слиянием и настоящим
  // штампом поверх них: «зелёная ли вершина после кнопки» и «сколько раз пошёл набор» —
  // вопросы к диску и к процессу, и внутрипроцессная подделка отвечала бы на них из того
  // самого допущения, которое проверяется.
  'scripts/sma/__tests__/landing.test.ts',
  // Та же посадка, но собранная БОЕВОЙ фабрикой демона без переопределений: доехали ли обе
  // её половины до двери приёмки — вопрос о собранном объекте, а не о тексте исходника.
  'daemon/__tests__/landing-wire.test.ts',
  // Три одноразовых репозитория с настоящими ветками, разъехавшимися вершинами и настоящим
  // слиянием, прогнанные НАСТОЯЩИМ тиком: «стала ли вершина предком ветки» и «уцелели ли оба
  // дописанных абзаца» — вопросы к графу коммитов на диске, и внутрипроцессная подделка
  // отвечала бы на них из того самого допущения, которое проверяется.
  'daemon/__tests__/branch-sync-wire.test.ts',
  // Пять одноразовых репозиториев с настоящими `git worktree add` и настоящим ритуалом
  // слияния поверх них: «двинулась ли вершина», «остался ли конфликт в общем дереве»,
  // «уцелела ли копия исполнителя» — вопросы к диску, и рядом с одиннадцатью соседями
  // такие деревья жить не умеют.
  'scripts/sma/__tests__/worktree-wave-merge.test.ts',
  // Одноразовый репозиторий с настоящим git и запуск настоящего входа хука отдельным
  // процессом: «позвали ли подушку на живом вызове» — вопрос о том, что процесс оставил на
  // диске, и внутрипроцессная подделка ответила бы на него из того самого допущения,
  // которое и проверяется. Между вызовом функции и вызовом через хук стоят дверь, матчер,
  // бюджет времени и порядок потоков — там и живут дефекты этого класса.
  'scripts/sma/__tests__/pre-live-wire.test.ts',
  // Одноразовый репозиторий и шесть запусков настоящего сканера утечек, один из них —
  // по всему дереву: «краснеет ли ворота на заголовке теста» — вопрос о процессе над
  // отслеживаемым деревом, и внутрипроцессная подделка ответила бы на него из того
  // самого допущения, которое и проверяется. Планировать фикстуру в индекс ЭТОГО
  // репозитория нельзя — он общий с человеком.
  'scripts/sma/__tests__/rebrand-test-titles.test.ts',
]

/**
 * stripShebang() — the PATTERN rule behind a class of silently shrinking suites.
 *
 * An executable entry point opens with `#!/usr/bin/env node`. The module runner's
 * inline transform cannot parse that line: it throws `SyntaxError: Invalid or
 * unexpected token` and charges it to the file that IMPORTED the script, which
 * then collects ZERO tests. The failure names the victim, never the cause, so the
 * honest reading of the report is "that test file is broken" — and however many
 * cases it held quietly leave the count. It has happened once already, to a suite
 * of 14 cases, and every shebanged file in the tree is the same loaded gun:
 * `tools/verify-rebrand.mjs` becomes one the day anyone imports it.
 *
 * The old cure was a list of externals — one line per victim, added AFTER each
 * one bled. This is the same cure applied to the CLASS: the shebang is stripped
 * from any module whose first bytes are `#!`, so the interpreter line stays in the
 * file (it is product surface — those files are executed directly) and never
 * reaches the parser. Only the first line is touched, and it is replaced by
 * nothing rather than deleted, so every later line keeps its number and stack
 * traces still point where they should.
 *
 * Exported so the rule itself is testable (scripts/sma/__tests__/shebang.test.ts).
 */
export function stripShebang() {
  return {
    name: 'sma-strip-shebang',
    enforce: 'pre',
    transform(code) {
      if (typeof code !== 'string' || !code.startsWith('#!')) return null
      return { code: code.replace(/^#![^\n]*/, ''), map: null }
    },
  }
}

const INCLUDE = ['scripts/sma/__tests__/**/*.test.ts', 'daemon/__tests__/**/*.test.ts']

export default defineConfig({
  plugins: [stripShebang()],
  test: {
    // NOTE: `include` lives in the projects below, never here. `extends: true`
    // CONCATENATES array options, so a root include would be merged into the
    // serial project and every file would run twice (measured: 263 files /
    // 4721 tests instead of 134 / 2392).
    // globals:true lets daemon/src/queue/adapter.mjs's queueAdapterContractSuite
    // register its describe/it block WITHOUT a top-level `import … from 'vitest'`
    // in a runtime module (that import would break the production daemon, which
    // installs pg-boss only). Additive — the explicit-import suites are unaffected.
    globals: true,
    // Many suites spawn REAL node/git child processes by design (pre-bench, undo
    // drills, CLI round-trips). The vitest 5s default trips on cold-boot variance
    // under multi-terminal machine load; 30s bounds a hang without flaking.
    testTimeout: 30000,
    // The same reason, for the SAME suites' setup work — and the gap that was
    // left open: hookTimeout keeps its own 10s default when testTimeout is
    // raised. install-layout's beforeAll copies the entire sma-core payload
    // (459 files, 0.7–1.5s idle on this machine) and the preset group runs the
    // real installer; a loaded box pushes either past 10s, the HOOK dies, and
    // vitest charges the WHOLE FILE — which is exactly the "install-layout
    // (whole file)" red on record. Parity with testTimeout, not inflation: the
    // per-hook bound stays the same order as the per-test one.
    hookTimeout: 30000,
    // ПОТОЛОК ПОТОКОВ — см. RUN_MAX_WORKERS наверху файла. Вычислен из числа потоков
    // машины (треть), а не вписан числом: прогон перестаёт быть единственным жильцом
    // машины, и три прогона умещаются рядом. Глубины набора это не касается.
    maxWorkers: RUN_MAX_WORKERS,
    projects: [
      {
        extends: true,
        test: {
          name: 'parallel',
          include: INCLUDE,
          exclude: [...defaultExclude, ...SERIAL_SUITES],
        },
      },
      {
        extends: true,
        test: {
          name: 'serial',
          include: SERIAL_SUITES,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
