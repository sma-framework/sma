/**
 * ВОРОТА ДОКУМЕНТА ДЛЯ СТУПЕНИ ДИЗАЙНА — на существующей функции, без единой новой строки
 * логики ворот.
 *
 * У документарной ступени один выход и один вопрос на выходе: «документ, который ступень
 * должна, есть на диске И достался истории?». Этот вопрос в доме уже задан один раз —
 * общей функцией, которая читает карту «стадия → чем доказывается», ищет файл в каталоге
 * фазы и спрашивает git о коммите. Пятая ступень НИЧЕГО к этой функции не добавляет: она
 * добавляет строку в карту. Поэтому этот файл проверяет не новую логику, а то, что новая
 * строка карты удовлетворяет СТАРУЮ функцию — и что все её отказы для новой ступени
 * закрыты, а не открыты.
 *
 * ПОЧЕМУ ОТКАЗЫ ВАЖНЕЕ УСПЕХА. Успех ворот виден сразу: ступень закрылась. Отказ виден
 * только тогда, когда его нет — когда ступень закрылась, НЕ оставив договора, и фаза
 * поехала в исполнение по документу, которого никто не видел. Три отказа проверяются
 * поимённо: файла нет вовсе; файл есть, но лежит только на этой машине; стадия не объявлена
 * в карте. Последний — не теоретический: закрытый словарь и карта артефактов ведутся
 * руками в разных файлах, и стадия, дошедшая до ворот без строки в карте, обязана быть
 * ОТКАЗАНА, а не пропущена по умолчанию.
 *
 * ДВА ФАЙЛА ОДНОГО ДОГОВОРА: ПРАВИЛО «НОВЕЙШИЙ ВЫИГРЫВАЕТ» И НЕВИДИМАЯ АРХИВНАЯ ВЕРСИЯ.
 * Договор фазы живёт под именем-суффиксом, и у него может быть предыдущая редакция. Дом
 * различает их формой имени: действующая редакция несёт суффикс через ДЕФИС, архивная —
 * через ТОЧКУ с номером версии. Разница не косметическая: поиск сравнивает конец имени, и
 * архивная редакция концом не совпадает — значит воротам она невидима вовсе. Это и есть
 * провод, на который опирается работа с версиями договора: положить рядом старую редакцию
 * нельзя так, чтобы ворота закрылись на ней. Оба свойства — «берётся последний по имени»
 * и «архивная невидима» — здесь утверждены прогоном, а не намерением.
 *
 * ВСЯ РАБОТА С ДИСКОМ И GIT — ЧЕРЕЗ ШОВ. Дерево каталогов задано таблицей в памяти, ответ
 * git — заглушкой; ни временного каталога, ни настоящего репозитория. Заглушки нарочно
 * беднее настоящих: они умеют ровно то, что функция у них спрашивает, и падают на всём
 * остальном — подделка, умеющая больше библиотеки, прячет вызов, которого в жизни нет.
 *
 * ЭТОТ ФАЙЛ КРАСЕН ПРИ РОЖДЕНИИ. Строки «дизайн» в карте артефактов ещё нет, поэтому ворота
 * отвечают на успешный случай отказом «стадия не объявлена». Красный прогон снят в
 * квитанцию; работа, добавляющая строку карты, делает файл зелёным.
 */

import { describe, it, expect } from 'vitest'

import { documentGate } from '../src/loop.mjs'

const PROJECT = '/proj'
const PHASE = 7
const PHASE_DIR = '07-primer'
const ROOT = `${PROJECT}/.planning/phases`
const SHA = 'a1b2c3d'

/** Пути этого дома приходят и со слэшем, и с обратным слэшем — сравниваем в одном написании. */
function norm(p: string): string {
  return String(p)
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/(.)\/$/, '$1')
}

/**
 * Дерево каталогов в памяти: имя каталога → его файлы. Каталога, которого в таблице нет,
 * не существует — и чтение его падает так же, как падает настоящий node.
 */
function fakeFs(tree: Record<string, string[]>) {
  const has = (p: string) => Object.prototype.hasOwnProperty.call(tree, norm(p))
  return {
    existsSync: (p: string) => has(p),
    readdirSync: (p: string) => {
      if (!has(p)) throw new Error(`ENOENT: ${norm(p)}`)
      return tree[norm(p)]
    },
  }
}

/**
 * Заглушка git: отвечает коротким хэшем на файлы, которые «закоммичены», и пустотой на все
 * остальные — ровно так же, как отвечает настоящий `git log -1` на неизвестный путь.
 */
function fakeGit(committed: string[]) {
  const set = new Set(committed.map(norm))
  return (args: string[]) => {
    const relPath = args[args.length - 1]
    return set.has(norm(relPath)) ? `${SHA}\n` : ''
  }
}

function designTask(stage: string = 'design') {
  return { id: 'phase-design-7', data: { kind: 'document', stage, phase: PHASE } }
}

function gate({ files, committed }: { files: string[]; committed: string[] }, stage?: string) {
  const deps = {
    fsImpl: fakeFs({ [ROOT]: [PHASE_DIR], [`${ROOT}/${PHASE_DIR}`]: files }),
    execGit: fakeGit(committed),
  }
  return documentGate(deps, designTask(stage), PROJECT)
}

const CONTRACT = `.planning/phases/${PHASE_DIR}/07-DESIGN.md`

describe('ступень дизайна закрывается на своём договоре', () => {
  it('договор на диске и в истории — ворота отдают квитанцию файла и коммита', () => {
    const verdict = gate({ files: ['07-DESIGN.md'], committed: [CONTRACT] })
    expect(verdict).toEqual({ receiptRef: `artifact:${CONTRACT}@${SHA}` })
  })

  it('квитанция несёт путь от корня чекаута, а не от диска этой машины', () => {
    const verdict = gate({ files: ['07-DESIGN.md'], committed: [CONTRACT] }) as { receiptRef: string }
    expect(verdict.receiptRef).not.toContain(PROJECT)
    expect(verdict.receiptRef.startsWith('artifact:.planning/')).toBe(true)
  })
})

describe('три отказа ворот — все закрытые, ни одного «по умолчанию пропустить»', () => {
  it('договора нет вовсе — отказ называет суффикс, которого не хватило', () => {
    const verdict = gate({ files: ['07-CONTEXT.md', '07-01-PLAN.md'], committed: [] }) as {
      reason: string
      detail: string
    }
    expect(verdict.reason).toBe('no_artifact')
    expect(verdict.detail).toContain('-DESIGN.md')
    expect(verdict).not.toHaveProperty('receiptRef')
  })

  it('договор есть на диске, но не закоммичен — истории он не достался, ворота закрыты', () => {
    const verdict = gate({ files: ['07-DESIGN.md'], committed: [] }) as { reason: string; detail: string }
    expect(verdict.reason).toBe('no_artifact')
    expect(verdict.detail).toContain('07-DESIGN.md')
    expect(verdict).not.toHaveProperty('receiptRef')
  })

  it('стадия вне словаря — отказ, а не самый мягкий из ворот', () => {
    const verdict = gate({ files: ['07-DESIGN.md'], committed: [CONTRACT] }, 'dizain') as {
      reason: string
      detail: string
    }
    expect(verdict.reason).toBe('no_artifact')
    expect(verdict.detail).toContain('не объявлена')
    expect(verdict).not.toHaveProperty('receiptRef')
  })
})

describe('редакции договора: новейшая выигрывает, архивная воротам невидима', () => {
  it('из двух действующих имён ворота берут последнее по имени', () => {
    const newest = `.planning/phases/${PHASE_DIR}/07-02-DESIGN.md`
    const verdict = gate({
      files: ['07-01-DESIGN.md', '07-02-DESIGN.md'],
      committed: [`.planning/phases/${PHASE_DIR}/07-01-DESIGN.md`, newest],
    })
    expect(verdict).toEqual({ receiptRef: `artifact:${newest}@${SHA}` })
  })

  it('архивная редакция через точку лежит рядом и на выбор не влияет', () => {
    const verdict = gate({
      files: ['07-DESIGN.md', '07-DESIGN.v1.md'],
      committed: [CONTRACT, `.planning/phases/${PHASE_DIR}/07-DESIGN.v1.md`],
    })
    expect(verdict).toEqual({ receiptRef: `artifact:${CONTRACT}@${SHA}` })
  })

  it('одна только архивная редакция ворот не открывает — действующего договора нет', () => {
    const verdict = gate({
      files: ['07-DESIGN.v1.md'],
      committed: [`.planning/phases/${PHASE_DIR}/07-DESIGN.v1.md`],
    }) as { reason: string }
    expect(verdict.reason).toBe('no_artifact')
    expect(verdict).not.toHaveProperty('receiptRef')
  })
})
