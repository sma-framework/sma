/**
 * ЦЕННИК — ОДИН НА ВСЁ ДЕРЕВО, И ОН НЕ ПРОСРОЧЕН.
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ, И ПОЧЕМУ ИМЕННО ЭТО. Список ставок жил внутри адаптера журналов
 * командной строки, и демон, которому та же цена нужна для своей книги расходов, до него не
 * доставал. Самый дешёвый выход из этого — завести второй список; он согласен с первым ровно
 * один день, тот, в который его написали. Дальше поправят один, а второй продолжит считать по
 * прошлогодней ставке, и никто об этом не узнает: отчёт с устаревшей ценой выглядит ровно так
 * же убедительно, как правильный. Поэтому здесь стоит утверждение о ДЕРЕВЕ, а не о модуле:
 * список ставок в нём ровно один, и его не может завести никто, не покраснев.
 *
 * И ДВЕ ПРОСРОЧЕННЫЕ СТАВКИ — каждая с числом. Ставки сверены с живой страницей платформы
 * 28.08.2026.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PRICING_USD_PER_MTOK, pricingVersion, pricingFor, priceUsd } from '../lib/pricing.mjs'
import {
  PRICING_USD_PER_MTOK as adapterTable,
  pricingVersion as adapterVersion,
} from '../lib/spend-adapter.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

// ── ставки ─────────────────────────────────────────────────────────────────────────────────

describe('ставки за миллион токенов', () => {
  it('версия таблицы приколочена — правка ставки без смены версии это подмена', () => {
    expect(pricingVersion).toBe('claude-pricing-2026-08-28')
  })

  it('haiku стоит 1 за вход и 5 за выход — прежние 0,8/4 были ценой ПРОШЛОГО поколения', () => {
    expect(PRICING_USD_PER_MTOK.haiku.input).toBe(1)
    expect(PRICING_USD_PER_MTOK.haiku.output).toBe(5)
    expect(PRICING_USD_PER_MTOK.haiku.cacheWrite).toBe(1.25)
    expect(PRICING_USD_PER_MTOK.haiku.cacheRead).toBe(0.1)
    // Миллион входа и миллион выхода: 6,00 по верной ставке против 4,80 по просроченной.
    expect(priceUsd({ model: 'claude-haiku-4-5', input: 1_000_000, output: 1_000_000 })).toBe(6)
  })

  it('sonnet остаётся 2/10 — объявленное повышение до 3/15 отменено, и это не «пока»', () => {
    expect(PRICING_USD_PER_MTOK.sonnet.input).toBe(2)
    expect(PRICING_USD_PER_MTOK.sonnet.output).toBe(10)
    // Миллион входа и миллион выхода: 12,00. По отменённым 3/15 вышло бы 18,00 — в полтора
    // раза больше, и ровно столько списал бы тот, кто исполнил бы комментарий-приказ.
    expect(priceUsd({ model: 'claude-sonnet-5', input: 1_000_000, output: 1_000_000 })).toBe(12)
  })

  it('fable и opus — на своих ставках, все четыре у каждого', () => {
    expect(PRICING_USD_PER_MTOK.fable).toEqual({ input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 })
    expect(PRICING_USD_PER_MTOK.opus).toEqual({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 })
  })

  it('семейство узнаётся по версионному имени, а незнакомая модель честно без цены', () => {
    expect(pricingFor('claude-opus-5')).toBe(PRICING_USD_PER_MTOK.opus)
    expect(pricingFor('us.anthropic.claude-mythos-1')).toBe(PRICING_USD_PER_MTOK.fable)
    expect(pricingFor('gpt-нечто')).toBeNull()
    // NULL, А НЕ НОЛЬ: ноль сказал бы «работа была бесплатной», а правда — «оценить некому».
    expect(priceUsd({ model: 'gpt-нечто', input: 1_000_000 })).toBeNull()
  })

  it('четыре ставки складываются каждая по своей — кэш не считается по цене входа', () => {
    // opus: 5,00 + 5,00 + 1,00 + 2,50 = 13,50.
    expect(
      priceUsd({
        model: 'claude-opus-5',
        input: 1_000_000,
        output: 200_000,
        cacheRead: 2_000_000,
        cacheWrite: 400_000,
      }),
    ).toBe(13.5)
  })
})

// ── один список на дерево ──────────────────────────────────────────────────────────────────

/** Исходники продукта, без тестов и без чужих деревьев. */
function sourceFiles(): string[] {
  const roots = ['daemon/src', 'scripts/sma', 'spa/src', 'supervisor', 'tools', 'bin']
  const out: string[] = []
  const walk = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // каталога может не быть в чужой копии — это не отказ
    }
    for (const e of entries) {
      const path = join(dir, e.name)
      if (e.isDirectory()) {
        if (['node_modules', '__tests__', 'fixtures', 'dist', '.git'].includes(e.name)) continue
        walk(path)
        continue
      }
      if (/\.(mjs|cjs|js|ts|tsx)$/.test(e.name)) out.push(path)
    }
  }
  for (const r of roots) walk(join(ROOT, r))
  return out
}

/** Ставка — это ненулевое число, приписанное к имени поля цены. Ноль — это счётчик, не ставка. */
const RATE_LINE = /\b(cacheRead|cacheWrite|cacheCreation)[A-Za-z]*\s*:\s*(?!0[,\s}])\d+(\.\d+)?/

describe('ценник в дереве ровно один', () => {
  it('таблица ставок объявлена в одном файле — и это lib/pricing.mjs', () => {
    const declaring = sourceFiles().filter((f) =>
      /export\s+const\s+PRICING_USD_PER_MTOK\s*=/.test(readFileSync(f, 'utf8')),
    )
    expect(declaring.map((f) => relative(ROOT, f).replace(/\\/g, '/'))).toEqual(['scripts/sma/lib/pricing.mjs'])
  })

  it('второго списка ставок в дереве нет — ни у демона, ни у окна, ни у подложки', () => {
    const offenders = sourceFiles()
      .filter((f) => !f.endsWith(join('lib', 'pricing.mjs')))
      .filter((f) => RATE_LINE.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f).replace(/\\/g, '/'))

    expect(offenders, 'ставки живут в pricing.mjs; второй список расходится с первым молча').toEqual([])
  })

  it('адаптер журналов не копирует таблицу, а отдаёт ТУ ЖЕ — сверено по ссылке', () => {
    expect(adapterTable).toBe(PRICING_USD_PER_MTOK)
    expect(adapterVersion).toBe(pricingVersion)
  })

  it('таблица заморожена — правка на ходу была бы вторым списком, только невидимым', () => {
    expect(Object.isFrozen(PRICING_USD_PER_MTOK)).toBe(true)
    expect(Object.isFrozen(PRICING_USD_PER_MTOK.haiku)).toBe(true)
  })
})
