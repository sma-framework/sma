/**
 * Tests for scripts/sma/lib/deps-guard.mjs — СТРАЖ СКЛАДА ЗАВИСИМОСТЕЙ.
 *
 * ЧТО СЛУЧИЛОСЬ И ПОЧЕМУ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Копия работника получает зависимости
 * ССЫЛКОЙ на каталоги основного дерева. 31.08.2026 склад основателя опустошался ТРИЖДЫ за
 * сутки, и журналы называют механизм точно: в 17:27:58Z из соседнего окна прошёл сырой
 * `git worktree remove --force <копия>` при трёх живых ссылках внутри — метка времени
 * каталога `node_modules` основного дерева сменилась через полторы секунды. Установка в
 * копии — второй путь того же класса: в 17:54:36Z `npm ci` шёл с cwd внутри копии, и склад
 * уцелел лишь потому, что человек снял ссылку ПЕРЕД установкой.
 *
 * ПОЭТОМУ ЗДЕСЬ НАСТОЯЩИЕ ССЫЛКИ, А НЕ ПОДДЕЛКА ФАЙЛОВОЙ СИСТЕМЫ — для двух отказов,
 * которые судят по ФАКТУ («а ссылка ли это?»): подделка, отвечающая «да», проверяет только
 * саму себя. Пригодность среды — вопрос о ФОРМЕ дерева, и его удобнее задавать подделке:
 * пустой склад, пропавшая зависимость и висячая ссылка собираются в памяти за три строки,
 * и ни один каталог человека при этом не участвует.
 *
 * Песочницы одноразовые (`mkdtemp`), уносятся целиком, и ни одна рабочая копия
 * разработчика в этом файле не участвует.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import {
  dependencyDirsOf,
  linkedDepsOf,
  installTargetOf,
  installRefusal,
  copyRemovalTargetsOf,
  copyRemovalRefusal,
  checkEnvironmentFitness,
  ENV_BROKEN_PREFIX,
} from '../lib/deps-guard.mjs'

const IS_WIN = process.platform === 'win32'

let sandbox: string
let mainTree: string
let copyTree: string

function write(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
}

/** A dependency directory attached BY REFERENCE — exactly as provisioning attaches it. */
function link(target: string, at: string): void {
  mkdirSync(dirname(at), { recursive: true })
  symlinkSync(target, at, IS_WIN ? 'junction' : 'dir')
}

/**
 * The shape of this machine: a main tree that owns the dependency store, a manifest naming
 * the three directories provisioning links, and a copy carrying them as links.
 */
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'sma-deps-guard-'))
  mainTree = join(sandbox, 'main')
  copyTree = join(sandbox, 'copy')

  write(join(mainTree, '.sma', 'worktree-include'), JSON.stringify({ copy: [], link: ['node_modules', 'daemon/node_modules', 'spa/node_modules'] }))
  write(join(mainTree, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^4' } }))
  write(join(mainTree, 'node_modules', 'vitest', 'index.js'), '// dep\n')
  // Здоровая машина умеет ЗАПУСТИТЬ движок, а не только показать его папку: манифест с
  // файлом запуска и сам файл. Без них дерево этой песочницы честно непригодно.
  write(join(mainTree, 'node_modules', 'vitest', 'package.json'), JSON.stringify({ bin: { vitest: './vitest.mjs' } }))
  write(join(mainTree, 'node_modules', 'vitest', 'vitest.mjs'), '// entry\n')
  write(join(mainTree, 'daemon', 'package.json'), JSON.stringify({ dependencies: { 'pg-boss': '^11' } }))
  write(join(mainTree, 'daemon', 'node_modules', 'pg-boss', 'index.js'), '// dep\n')

  write(join(copyTree, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^4' } }))
  write(join(copyTree, 'daemon', 'package.json'), JSON.stringify({ dependencies: { 'pg-boss': '^11' } }))
  link(join(mainTree, 'node_modules'), join(copyTree, 'node_modules'))
  link(join(mainTree, 'daemon', 'node_modules'), join(copyTree, 'daemon', 'node_modules'))
})

afterEach(() => {
  // Ссылки снимаются ПЕРВЫМИ и по одной: рекурсивное удаление песочницы с живой ссылкой —
  // ровно тот случай, который этот файл и проверяет.
  for (const p of [join(copyTree, 'daemon', 'node_modules'), join(copyTree, 'node_modules')]) {
    try {
      rmdirSync(p)
    } catch {
      /* уже снята */
    }
  }
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* песочница в %TEMP%; остаток безвреден */
  }
})

describe('какие каталоги вообще стерегутся', () => {
  it('имена берутся из манифеста провизии, а в копии (манифеста нет) — разведываются', () => {
    expect(dependencyDirsOf({ root: mainTree })).toEqual(['node_modules', 'daemon/node_modules', 'spa/node_modules'])
    // В копии `.sma/` нет по построению — без разведки страж не увидел бы daemon/node_modules,
    // то есть промолчал бы ровно о том каталоге, который 31.08 в 19:28 и опустел.
    expect(dependencyDirsOf({ root: copyTree })).toEqual(['node_modules'])
    expect(dependencyDirsOf({ root: copyTree, discover: true })).toContain('daemon/node_modules')
  })

  it('ссылками названы только те каталоги, которые ими являются, и видно куда они ведут', () => {
    const linked = linkedDepsOf({ root: copyTree })
    expect(linked.map((l: any) => l.path).sort()).toEqual(['daemon/node_modules', 'node_modules'])
    expect(linked.every((l: any) => l.outside)).toBe(true)
    // В основном дереве это настоящие каталоги — беречь нечего, и страж молчит.
    expect(linkedDepsOf({ root: mainTree })).toEqual([])
  })
})

describe('установка сквозь ссылку — отказ словами', () => {
  it('находит каталог, в который целится установка, через все `cd` и `--prefix`', () => {
    expect(installTargetOf({ command: 'npm ci', cwd: copyTree })?.dir).toBe(copyTree)
    expect(installTargetOf({ command: `cd "${copyTree}" && cd daemon && npm ci --no-audit`, cwd: mainTree })?.dir).toBe(
      join(copyTree, 'daemon'),
    )
    expect(installTargetOf({ command: 'npm --prefix daemon install', cwd: copyTree })?.dir).toBe(join(copyTree, 'daemon'))
    // не установка: сборка, прогон, распаковка каталог не пересобирают
    expect(installTargetOf({ command: 'npm run build:spa', cwd: copyTree })).toBe(null)
    expect(installTargetOf({ command: 'npx vitest run', cwd: copyTree })).toBe(null)
  })

  it('ИМЕННО ТА команда, что шла 31.08 в 17:54 — отказ, и в словах названы обе стороны ссылки', () => {
    const res: any = installRefusal({ command: 'cd daemon && npm ci --no-audit --no-fund', cwd: copyTree })
    expect(res.refuse).toBe(true)
    expect(res.reason).toContain('установка отменена')
    expect(res.reason).toContain(join(mainTree, 'daemon', 'node_modules')) // куда ведёт ссылка
    expect(res.reason).toContain('записке о подходе') // выход, который у работника есть
  })

  it('ссылку сняли — отказывать не за что: это уже свой каталог', () => {
    rmdirSync(join(copyTree, 'daemon', 'node_modules'))
    mkdirSync(join(copyTree, 'daemon', 'node_modules'), { recursive: true })
    expect(installRefusal({ command: 'cd daemon && npm ci', cwd: copyTree }).refuse).toBe(false)
    // и в основном дереве установка человека никогда не останавливается
    expect(installRefusal({ command: 'npm ci', cwd: mainTree }).refuse).toBe(false)
  })

  it('сообщение коммита со словами «npm install» установкой не считается', () => {
    const res = installRefusal({ command: 'git commit -m "docs: npm install больше не нужен"', cwd: copyTree })
    expect(res.refuse).toBe(false)
  })

  it('ТЕКСТ внутри здесь-документа — данные, а не команда (замерено на этом самом страже)', () => {
    // Этим отказом страж однажды остановил дописывание ТЕСТА про `npm ci`: строка внутри
    // документа никогда не выполняется, она едет в файл. Страж, мешающий писать текст о
    // команде, будет выключен вместе со всем, что он бережёт.
    const command = ["cat >> notes.md <<'EOF'", 'cd daemon && npm ci --no-audit', 'EOF'].join('\n')
    expect(installRefusal({ command, cwd: copyTree }).refuse).toBe(false)
    // а та же команда ВНЕ документа — по-прежнему отказ
    expect(installRefusal({ command: 'cd daemon && npm ci --no-audit', cwd: copyTree }).refuse).toBe(true)
  })
})

describe('сырая уборка копии со ссылками — отказ с именем верба', () => {
  it('видит цель и в `git worktree remove`, и в рекурсивном удалении', () => {
    expect(copyRemovalTargetsOf({ command: `git worktree remove --force "${copyTree}"`, cwd: mainTree })).toEqual([copyTree])
    expect(copyRemovalTargetsOf({ command: 'rm -rf copy', cwd: sandbox })).toEqual([copyTree])
    expect(copyRemovalTargetsOf({ command: 'git worktree list', cwd: mainTree })).toEqual([])
  })

  it('КОМАНДА 17:27:58Z — отказ, названы все живые ссылки и верб, который убирает безопасно', () => {
    const res: any = copyRemovalRefusal({ command: `git worktree remove --force "${copyTree}"`, cwd: mainTree, root: mainTree })
    expect(res.refuse).toBe(true)
    expect(res.path).toBe(copyTree)
    expect(res.links.map((l: any) => l.path).sort()).toEqual(['daemon/node_modules', 'node_modules'])
    expect(res.reason).toContain('worktree remove') // верб проекта назван в отказе
    expect(res.reason).toContain('19:28') // и измеренный случай, ради которого отказ существует
  })

  it('ссылок внутри нет — уборка не останавливается ничем', () => {
    rmdirSync(join(copyTree, 'daemon', 'node_modules'))
    rmdirSync(join(copyTree, 'node_modules'))
    expect(copyRemovalRefusal({ command: `git worktree remove --force "${copyTree}"`, cwd: mainTree, root: mainTree }).refuse).toBe(false)
  })

  it('уборка ЧУЖОГО каталога, в котором ссылок нет, стража не касается', () => {
    const other = join(sandbox, 'scratch')
    mkdirSync(other, { recursive: true })
    expect(copyRemovalRefusal({ command: `rm -rf "${other}"`, cwd: sandbox, root: mainTree }).refuse).toBe(false)
  })

  it('спрошен ИЗ копии, где манифеста нет, — daemon/node_modules всё равно назван', () => {
    // Гейт вызовов работника стоит ВНУТРИ копии, а `.sma/` в копию не переносится: список
    // ссылок сводится к умолчанию `['node_modules']`. Снимаем корневую ссылку — и без
    // разведки подпроектов остаётся ровно тот каталог, который 31.08 в 19:28 и опустел,
    // а страж о нём молчит.
    rmdirSync(join(copyTree, 'node_modules'))
    const res: any = copyRemovalRefusal({ command: `git worktree remove --force "${copyTree}"`, cwd: copyTree, root: copyTree })
    expect(res.refuse).toBe(true)
    expect(res.links.map((l: any) => l.path)).toEqual(['daemon/node_modules'])
  })

  it('в команде нечего убирать — до диска дело не доходит вовсе', () => {
    // Этот вопрос задаётся перед КАЖДЫМ вызовом Bash в двух местах сразу. Разведка
    // подпроектов на каждом `git status` — цена, которую страж брал бы ни за что, поэтому
    // сначала разбирается команда. Считаем обращения, а не ловим исключение: все обращения
    // стража к диску обёрнуты в try, и брошенная ошибка ничего бы не доказала.
    let touched = 0
    const fsImpl: any = {
      readFileSync: () => {
        touched += 1
        throw new Error('ENOENT')
      },
      readdirSync: () => {
        touched += 1
        return []
      },
      lstatSync: () => {
        touched += 1
        throw new Error('ENOENT')
      },
    }
    expect(copyRemovalRefusal({ command: 'git status --porcelain', cwd: mainTree, root: mainTree, fsImpl }).refuse).toBe(false)
    expect(touched).toBe(0)
  })
})

describe('пригодность среды — «среда сломана» вместо «тесты красные»', () => {
  /** Подделка дерева: {путь -> содержимое каталога | текст файла}. */
  function fakeFs(spec: {
    files: Record<string, string>
    dirs: Record<string, Array<{ name: string; link?: boolean; dir?: boolean }>>
    dangling?: string[]
  }) {
    // Буква диска снимается нарочно: библиотека приводит путь к абсолютному (`/tree` на
    // Windows становится `C:\tree`), а спрашивают её здесь о ФОРМЕ дерева, а не о томе.
    const norm = (p: string) =>
      String(p)
        .replace(/\\/g, '/')
        .replace(/^[a-zA-Z]:/, '')
        .replace(/\/+$/, '')
    return {
      readFileSync: (p: string) => {
        const hit = spec.files[norm(p)]
        if (hit === undefined) throw new Error(`ENOENT ${p}`)
        return hit
      },
      readdirSync: (p: string, o?: any) => {
        const hit = spec.dirs[norm(p)]
        if (!hit) throw new Error(`ENOENT ${p}`)
        return o && o.withFileTypes
          ? hit.map((e) => ({
              name: e.name,
              isSymbolicLink: () => !!e.link,
              isDirectory: () => !!e.dir,
              isFile: () => !e.dir && !e.link,
            }))
          : hit.map((e) => e.name)
      },
      statSync: (p: string) => {
        const path = norm(p)
        if ((spec.dangling ?? []).includes(path)) throw new Error(`ENOENT ${p}`)
        if (spec.files[path] !== undefined || spec.dirs[path]) return { isDirectory: () => !!spec.dirs[path] }
        throw new Error(`ENOENT ${p}`)
      },
      lstatSync: () => ({ isSymbolicLink: () => false }),
      readlinkSync: () => '',
    } as any
  }

  const ROOT = '/tree'
  const healthy = () => ({
    files: {
      '/tree/package.json': JSON.stringify({ devDependencies: { vitest: '^4' } }),
      '/tree/node_modules/vitest': '',
      // МАНИФЕСТ ДВИЖКА И ЕГО ФАЙЛ ЗАПУСКА — часть здорового дерева, а не украшение:
      // склад, в котором папка движка есть, а запускать нечем, 31.08 читался как «тесты
      // красные», и разница видна только отсюда.
      '/tree/node_modules/vitest/package.json': JSON.stringify({ bin: { vitest: './vitest.mjs' } }),
      '/tree/node_modules/vitest/vitest.mjs': '',
      '/tree/daemon/package.json': JSON.stringify({ dependencies: { 'pg-boss': '^11' } }),
      '/tree/daemon/node_modules/pg-boss': '',
    },
    dirs: {
      '/tree': [{ name: 'daemon', dir: true }],
      '/tree/node_modules': [{ name: 'vitest', dir: true }],
      '/tree/daemon/node_modules': [{ name: 'pg-boss', dir: true }],
    },
  })

  it('здоровое дерево годится — и молчит', () => {
    const res: any = checkEnvironmentFitness({ root: ROOT, fsImpl: fakeFs(healthy()) })
    expect(res.fit).toBe(true)
    expect(res.reason).toBe(null)
  })

  it('ПУСТОЙ daemon/node_modules — ровно случай 31.08, 19:28 — назван средой, а не тестами', () => {
    const spec = healthy()
    spec.dirs['/tree/daemon/node_modules'] = []
    const res: any = checkEnvironmentFitness({ root: ROOT, fsImpl: fakeFs(spec) })
    expect(res.fit).toBe(false)
    expect(res.reason).toContain(ENV_BROKEN_PREFIX)
    expect(res.reason).toContain('ПУСТ')
    expect(res.reason).toContain('НЕ красные тесты')
    expect(res.broken[0].project).toBe('daemon')
  })

  it('объявленная зависимость не разрешается — названа по имени', () => {
    const spec = healthy()
    delete spec.files['/tree/daemon/node_modules/pg-boss']
    const res: any = checkEnvironmentFitness({ root: ROOT, fsImpl: fakeFs(spec) })
    expect(res.fit).toBe(false)
    expect(res.reason).toContain('pg-boss')
  })

  it('висячая ссылка в складе — след разорванного хранилища pnpm — тоже среда', () => {
    const spec: any = healthy()
    spec.dirs['/tree/node_modules'] = [
      { name: 'vitest', dir: true },
      { name: '@jridgewell', link: true },
    ]
    spec.dangling = ['/tree/node_modules/@jridgewell']
    const res: any = checkEnvironmentFitness({ root: ROOT, fsImpl: fakeFs(spec) })
    expect(res.fit).toBe(false)
    expect(res.reason).toContain('висячая ссылка')
    expect(res.reason).toContain('@jridgewell')
  })

  it('каталога зависимостей нет вовсе — сказано словами', () => {
    const spec = healthy()
    delete spec.dirs['/tree/node_modules']
    const res: any = checkEnvironmentFitness({ root: ROOT, fsImpl: fakeFs(spec) })
    expect(res.fit).toBe(false)
    expect(res.reason).toContain('нет каталога зависимостей')
  })

  /**
   * ═══ ДВИЖОК ТЕСТОВ — ОТДЕЛЬНЫЙ ВОПРОС, А НЕ ЧАСТЬ ОБЩЕЙ ПЕРЕКЛИЧКИ ══════════════════
   *
   * 31.08.2026 в складе осталось 39 записей из сотен, каталога `.bin` не было вовсе, и
   * `vitest` не находился КОМАНДОЙ. Перекличка объявленных зависимостей такой склад может
   * и пропустить: папка движка на месте, а запускать в ней нечего. Гейт обязан спросить
   * ровно то, что ему нужно от дерева, — «этот прогон вообще запустится?», — и ответить
   * своими словами, а не молча пропустить прогон, которого не будет.
   */
  it('папка движка есть, а файла запуска нет — это среда, и движок назван по имени', () => {
    const spec = healthy()
    delete spec.files['/tree/node_modules/vitest/vitest.mjs']
    const res: any = checkEnvironmentFitness({ root: ROOT, fsImpl: fakeFs(spec) })
    expect(res.fit, 'дерево, в котором нечем запуститься, не годится').toBe(false)
    expect(res.reason).toContain('движок тестов')
    expect(res.reason).toContain('vitest')
  })

  it('манифест движка не читается — тоже среда, а не красные тесты', () => {
    const spec = healthy()
    delete spec.files['/tree/node_modules/vitest/package.json']
    const res: any = checkEnvironmentFitness({ root: ROOT, fsImpl: fakeFs(spec) })
    expect(res.fit).toBe(false)
    expect(res.reason).toContain('движок тестов')
  })

  it('дерево, не объявлявшее движка, о нём и не спрашивается', () => {
    const spec: any = healthy()
    spec.files['/tree/package.json'] = JSON.stringify({ dependencies: { 'pg-boss': '^11' } })
    spec.files['/tree/node_modules/pg-boss'] = ''
    spec.dirs['/tree/node_modules'] = [{ name: 'pg-boss', dir: true }]
    delete spec.files['/tree/node_modules/vitest']
    delete spec.files['/tree/node_modules/vitest/package.json']
    delete spec.files['/tree/node_modules/vitest/vitest.mjs']
    const res: any = checkEnvironmentFitness({ root: ROOT, fsImpl: fakeFs(spec) })
    expect(res.fit, 'проект без движка тестов не сломан — он просто другой').toBe(true)
  })

  /**
   * ОТКАЗ БЕЗ КОМАНДЫ ВЫХОДА — это половина отказа: человек у окна читает «среда сломана» и
   * идёт спрашивать, чем её чинят. 31.08 чинилось одной командой, и она была известна.
   */
  it('отказ по среде несёт КОМАНДУ восстановления, а не только диагноз', () => {
    const spec = healthy()
    spec.dirs['/tree/daemon/node_modules'] = []
    const res: any = checkEnvironmentFitness({ root: ROOT, fsImpl: fakeFs(spec) })
    expect(res.fit).toBe(false)
    expect(res.reason, 'диагноз без команды заставляет человека спрашивать').toContain('--frozen-lockfile')
  })

  it('своя поломка читается как «годится»: страж не останавливает работу собственной ошибкой', () => {
    const broken: any = {
      readFileSync: () => {
        throw new Error('диск отвалился')
      },
      readdirSync: () => {
        throw new Error('диск отвалился')
      },
    }
    const res: any = checkEnvironmentFitness({ root: ROOT, fsImpl: broken })
    expect(res.fit).toBe(true)
  })

  it('на настоящем дереве этой песочницы среда годная — и через ссылки копии тоже', () => {
    expect(checkEnvironmentFitness({ root: mainTree }).fit).toBe(true)
    expect(checkEnvironmentFitness({ root: copyTree }).fit).toBe(true)
  })
})
