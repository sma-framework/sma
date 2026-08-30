/**
 * УМОЛЧАНИЕ ИЗВЕСТНОГО КЛЮЧА ЖИВЁТ В МАНИФЕСТЕ СХЕМЫ, А НЕ В ВЫХОДНОМ КОДЕ.
 *
 * Что было. `query config-get workflow.mvp_mode` отвечал «Error: Key not found» и кодом 1 —
 * хотя ключ ОПИСАН в манифесте схемы настроек, а путеводитель планирования, который его
 * спрашивает, знает про умолчание и оборачивает вызов в `2>/dev/null || echo false`. Такой
 * вызов редко ходит один: работник собирает несколько запросов в ОДИН пакетный вызов, и
 * упавший ключ отравляет весь пакет — модель выходит без файла, гейт честно отказывает, и
 * три попытки подряд сгорают на настройке, которой просто нет на диске.
 *
 * Что проверяется здесь:
 *   1. известный манифесту ключ, которого нет в config.json, отвечает умолчанием ИЗ МАНИФЕСТА
 *      и кодом 0 — и при живом config.json, и когда файла нет вовсе;
 *   2. неизвестный ключ по-прежнему ошибка с кодом 1: умолчание не превращает опечатку в
 *      тихий `false`;
 *   3. значение с диска и флаг `--default` по-прежнему сильнее умолчания схемы;
 *   4. карта умолчаний — ОДНА, и она в манифесте: код читает её оттуда, а не держит вторую
 *      копию у себя, и каждый её ключ схема признаёт своим;
 *   5. два манифеста не расходятся: там, где умолчание того же пути настройки называет и
 *      манифест значений, слова обоих совпадают.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const configSchema = require_('../../../sma-core/bin/lib/config-schema.cjs')
const SCHEMA_MANIFEST = require_('../../../sma-core/bin/shared/config-schema.manifest.json')
const DEFAULTS_MANIFEST = require_('../../../sma-core/bin/shared/config-defaults.manifest.json')

const SMA_TOOLS = fileURLToPath(new URL('../../../sma-core/bin/sma-tools.cjs', import.meta.url))

let cwd: string

/** Один прогон настоящего верба: что он напечатал, что сказал в stderr и с каким кодом вышел. */
function configGet(...args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SMA_TOOLS, 'query', 'config-get', ...args, '--cwd', cwd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err: any) {
    return { status: err.status ?? -1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(join(cwd, '.planning'), { recursive: true })
  writeFileSync(join(cwd, '.planning', 'config.json'), JSON.stringify(config, null, 2), 'utf8')
}

/** Значение по пути с точками внутри вложенного объекта, или undefined. */
function atPath(source: Record<string, any>, keyPath: string): unknown {
  let current: any = source
  for (const key of keyPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sma-config-default-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('config-get: умолчание известного ключа', () => {
  it('известный манифесту ключ, которого нет в config.json, отвечает умолчанием, а не ошибкой', () => {
    // Живой config.json БЕЗ этого ключа — ровно та обстановка, в которой сгорели три попытки:
    // файл есть, читается, а ключа в нём нет.
    writeConfig({ mode: 'interactive', workflow: { auto_advance: false } })

    const got = configGet('workflow.mvp_mode')

    expect(got.status).toBe(0)
    expect(got.stdout.trim()).toBe('false')
    expect(got.stderr).not.toContain('Key not found')
  })

  it('тот же ключ без config.json вовсе — тоже умолчание', () => {
    const got = configGet('workflow.mvp_mode')

    expect(got.status).toBe(0)
    expect(got.stdout.trim()).toBe('false')
  })

  it('--raw отдаёт то же умолчание голым значением', () => {
    writeConfig({ mode: 'interactive' })

    const got = configGet('workflow.mvp_mode', '--raw')

    expect(got.status).toBe(0)
    expect(got.stdout.trim()).toBe('false')
  })

  it('неизвестный ключ — по-прежнему ошибка с кодом 1', () => {
    writeConfig({ mode: 'interactive' })

    const got = configGet('workflow.mvp_moode')

    expect(got.status).toBe(1)
    expect(got.stderr).toContain('Key not found')
  })

  it('значение с диска сильнее умолчания схемы', () => {
    writeConfig({ workflow: { mvp_mode: true } })

    const got = configGet('workflow.mvp_mode')

    expect(got.status).toBe(0)
    expect(got.stdout.trim()).toBe('true')
  })

  it('--default сильнее умолчания схемы: спросивший назвал своё', () => {
    writeConfig({ mode: 'interactive' })

    const got = configGet('workflow.mvp_mode', '--default', 'да')

    expect(got.status).toBe(0)
    expect(got.stdout.trim()).toContain('да')
  })
})

describe('config-get: карта умолчаний одна и она в манифесте', () => {
  it('код отдаёт ровно ту карту, что лежит в манифесте схемы', () => {
    expect(configSchema.CONFIG_KEY_DEFAULTS).toEqual(SCHEMA_MANIFEST.defaults)
  })

  it('каждый ключ карты умолчаний схема признаёт своим', () => {
    for (const keyPath of Object.keys(SCHEMA_MANIFEST.defaults)) {
      expect(configSchema.isValidConfigKey(keyPath), `${keyPath} не в схеме`).toBe(true)
    }
  })

  it('умолчание ключа берётся по пути, а неизвестный путь остаётся отсутствием', () => {
    expect(configSchema.configKeyDefault('workflow.mvp_mode')).toEqual({ has: true, value: false })
    expect(configSchema.configKeyDefault('workflow.mvp_moode')).toEqual({ has: false, value: undefined })
    // Прототипные имена не выдают чужого значения за умолчание настройки.
    expect(configSchema.configKeyDefault('constructor')).toEqual({ has: false, value: undefined })
  })

  it('два манифеста не расходятся об одном и том же пути', () => {
    for (const [keyPath, value] of Object.entries(SCHEMA_MANIFEST.defaults as Record<string, unknown>)) {
      const other = atPath(DEFAULTS_MANIFEST as Record<string, any>, keyPath)
      if (other === undefined) continue // путь называет только манифест схемы — расходиться не с чем
      expect(other, `${keyPath}: манифесты называют разные умолчания`).toEqual(value)
    }
  })
})
