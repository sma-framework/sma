/**
 * Дела встроенных навыков работника — ПИН замороженного списка.
 *
 * Что здесь закрепляется. Тексты навыков уезжают в рабочую копию КАЖДОГО проекта КАЖДОГО
 * пользователя: это поверхность продукта, а не наша внутренняя записка. Поэтому список
 * заморожен и припинен побуквенно — новая запись обязана стать осознанным перепином этого
 * дела, а не молчаливой добавкой, о которой узнают из чужого дерева.
 *
 * Чего эти дела НЕ доказывают, и это сказано вслух: они не доказывают, что работник навык
 * ВЫЗВАЛ. Материализация текстов в копию — следующая волна; живой вызов виден только в
 * стенограмме оплаченной попытки. Дело, которое утверждало бы это чтением списка, было бы
 * зелёным в мире, где ничего никуда не доезжает.
 */

import { describe, it, expect } from 'vitest'

import { WORKER_SKILLS } from '../src/queue/worker-skills.mjs'
import { APPROACH_MARKERS, LESSON_MARKERS } from '../src/front/journal.mjs'

/**
 * Шейпы внутренних реестровых идентификаторов СТРОЯТСЯ ИЗ ЧАСТЕЙ, а не пишутся литералом.
 * Литерал реестра в этом файле сам был бы нарушением закона о чистоте продукта — дело,
 * ловящее утечку ценой собственной утечки, ловит её впустую.
 */
const REGISTER_SHAPES = [
  new RegExp('\\b[TDQ]-\\d+(?:\\.\\d+)?-(?:[A-Z]{2,}-)?\\d+[a-z]?\\b'),
  new RegExp('\\b' + 'S' + 'B' + '-\\d{3}\\b'),
  new RegExp('\\b' + 'B' + 'L' + '-\\d{3}\\b'),
  new RegExp('(?<![\\p{L}])фаз[аыуе]\\s+\\d', 'u'),
  new RegExp('\\bплан\\p{L}*\\s+\\d+[.-]\\d+', 'u'),
]

const bySlug = (slug: string) => WORKER_SKILLS.find((s: any) => s.slug === slug)

describe('встроенные навыки работника — замороженный список с одним владельцем', () => {
  it('пин: слаги побуквенно и по порядку — новая запись есть ОСОЗНАННЫЙ перепин этого дела', () => {
    expect(WORKER_SKILLS.map((s: any) => s.slug)).toEqual(['sma-receipt', 'sma-lesson', 'sma-ask', 'sma-browser'])
  })

  it('список и каждая запись заморожены — текст, уезжающий в чужое дерево, не правится по дороге', () => {
    expect(Object.isFrozen(WORKER_SKILLS)).toBe(true)
    for (const skill of WORKER_SKILLS as any[]) expect(Object.isFrozen(skill)).toBe(true)
  })

  it('у каждой записи слаг, заголовок и непустое тело', () => {
    for (const skill of WORKER_SKILLS as any[]) {
      expect(skill.slug).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(typeof skill.title).toBe('string')
      expect(skill.title.trim().length).toBeGreaterThan(0)
      expect(typeof skill.body).toBe('string')
      expect(skill.body.trim().length).toBeGreaterThan(200)
    }
  })

  it('тело каждой записи — SKILL.md той формы, которую читает сканер навыков: шапка с именем и описанием', () => {
    // Правила разбора шапки взяты с читателя (harness.mjs readFrontmatter): фенс `---\n`
    // в самом начале, закрывающий фенс, плоские скаляры `ключ: значение`. Тело, шапку
    // которого читатель не разберёт, сканер молча посчитает не-навыком — и никто не узнает.
    for (const skill of WORKER_SKILLS as any[]) {
      expect(skill.body.startsWith('---\n')).toBe(true)
      const close = skill.body.indexOf('\n---', 3)
      expect(close).toBeGreaterThan(0)
      const head = skill.body.slice(4, close)
      expect(head).toMatch(/^name:\s*\S/m)
      expect(head).toMatch(/^description:\s*\S/m)
      // Текст после шапки — то, что работник читает; пустая шапка без текста навыком не является.
      expect(skill.body.slice(close + 4).trim().length).toBeGreaterThan(100)
    }
  })

  it('в телах НЕТ внутренних реестровых идентификаторов — они уезжают в чужие деревья, обоснование пишется словами', () => {
    for (const skill of WORKER_SKILLS as any[]) {
      for (const shape of REGISTER_SHAPES) {
        expect(shape.test(skill.body), `навык ${skill.slug} несёт внутренний идентификатор`).toBe(false)
        expect(shape.test(skill.title), `заголовок ${skill.slug} несёт внутренний идентификатор`).toBe(false)
      }
    }
  })

  it('тексты ССЫЛАЮТСЯ на команды продукта, а не пересказывают их своими словами', () => {
    // Две копии одного знания — способ, каким одна из них отстаёт. Навык называет команду,
    // владелец команды остаётся один.
    expect(bySlug('sma-receipt')!.body).toContain('node scripts/sma/cli.mjs receipt-hash')
    expect(bySlug('sma-receipt')!.body).toContain('node scripts/sma/cli.mjs reverify')
    expect(bySlug('sma-lesson')!.body).toContain('node scripts/sma/cli.mjs memory write')
    expect(bySlug('sma-lesson')!.body).toContain('--corpus .claude/memory')
  })

  it('маркеры в телах — ТЕ ЖЕ константы, что печатает журнал: разъехавшийся маркер тихо теряет записку', () => {
    expect(bySlug('sma-lesson')!.body).toContain(LESSON_MARKERS.written)
    expect(bySlug('sma-lesson')!.body).toContain(LESSON_MARKERS.none)
    expect(bySlug('sma-ask')!.body).toContain(APPROACH_MARKERS.approach)
  })

  it('навык про окно браузера называет команду продукта, а не пересказывает драйвер', () => {
    // Агент ломится в окно вслепую ровно потому, что не знает, чем его открывают. Навык
    // называет ту самую команду и ту самую переменную драйвера — второго словаря нет.
    const browser = bySlug('sma-browser')!.body
    expect(browser).toContain('node scripts/sma/ui-drive.mjs')
    expect(browser).toContain('SMA_UI_DRIVER')
    expect(browser).toContain('shot:')
  })

  it('навык про окно учит брать учётные данные ТОЛЬКО из окружения — и не писать их в файлы', () => {
    const browser = bySlug('sma-browser')!.body
    expect(browser).toContain('env:')
    // Запрет назван прямым текстом: подразумеваемый запрет работник не читает.
    expect(browser).toMatch(/не пиш\p{L}*\s+в файл/iu)
    // И сам текст навыка не несёт ни одного придуманного примера пароля: текст уезжает в
    // чужое дерево, а пример учётных данных в нём кто-нибудь однажды подставит всерьёз.
    expect(browser).not.toMatch(/admin\s*[:/]\s*admin/i)
  })

  it('навык про окно называет честное «не смог» кодом, а не настроением', () => {
    // Драйвера в дереве может не быть, и тогда прогон честно выходит кодом 3. Навык, который
    // не назовёт этот исход, оставит работнику ровно один выход — назвать непроверенное
    // проверенным.
    const browser = bySlug('sma-browser')!.body
    expect(browser).toContain('NOT RUN')
    expect(browser).toMatch(/(?<![\p{L}])код(?:ом|е|а)?\s+3(?![\d])/u)
  })

  it('навык про вопросы НЕ обещает механизма, которого нет: диалога по ходу работы', () => {
    const ask = bySlug('sma-ask')!.body
    // Механизм «спросить по ходу и дождаться ответа» строится прямо сейчас и в продукте
    // ещё не существует. Навык, обещающий его, — ложь работнику, который будет ЖДАТЬ.
    expect(ask).not.toContain('дождитесь ответа')
    expect(ask).not.toContain('дождаться ответа')
    expect(ask).not.toContain('спросите по ходу')
    // И честная половина сказана прямо, а не подразумевается умолчанием.
    expect(ask).toContain('середина работы ответа не даёт')
  })
})
