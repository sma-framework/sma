/**
 * УПАВШАЯ СБОРКА НЕ СТИРАЕТ ОКНО.
 *
 * ═══════════════ ЧТО БЫЛО НЕ ТАК ═══════════════
 *
 * Окно собиралось прямо в тот каталог, который демон отдаёт в браузер, а сборщик начинает с
 * того, что стирает выходной каталог дочиста. Упавшая сборка — и раздачи больше нет: человек
 * получает не «старое окно», а пустоту, гейт свежести раздачи в этом случае честно уходит в
 * «сравнивать не с чем» и МОЛЧИТ, а отказ двери говорит «сборка окна не прошла» и ни словом —
 * что заодно снесена раздача, работавшая до нажатия кнопки. Три этажа, и на каждом тихо.
 *
 * ═══════════════ ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ ═══════════════
 *
 *   1. Сборка идёт во ВРЕМЕННЫЙ каталог, и раздача подменяется ТОЛЬКО после успеха.
 *   2. Упавшая сборка оставляет прежнее окно на диске — байт в байт.
 *   3. «Успешная» сборка, не произведшая ни одного файла, раздачу тоже не трогает: подменить
 *      живое окно пустотой «по правилам» — та же беда с другого конца.
 *   4. Прежняя раздача, отложенная посадкой, возвращается на место целиком.
 *   5. Выходной каталог сборщика — одно определение на весь продукт, и настройка сборщика
 *      берёт его оттуда же, откуда постановка.
 *
 * НАСТОЯЩЕЕ ЗДЕСЬ — файлы: каталоги, копии и переименования делаются на диске во временном
 * дереве. Подделан ровно один шов — запуск сборщика, потому что поднимать настоящий бандлер
 * ради вопроса «что стало с каталогом» значило бы мерить минутами то, что решается байтами.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, it, expect } from 'vitest'

import {
  DIST_NOTHING_KEPT_NOTE,
  DIST_RESTORED_NOTE,
  DIST_UNTOUCHED_NOTE,
  dropKept,
  EMPTY_BUILD_NOTE,
  keepDist,
  restoreDist,
  spaOutDir,
  SPA_DEFAULT_OUT_DIR,
  SPA_DIST_REL,
  SPA_OUT_DIR_ENV,
  stageSpaBuild,
  STAGE_PREFIX,
} from '../lib/spa-dist.mjs'

/** Дерево с уже раздающимся окном — ровно то состояние, в котором нажимают «принять». */
function treeWithWindow(name: string, files: Record<string, string> = { 'index.html': 'ОКНО ВЕРШИНЫ' }) {
  const root = mkdtempSync(join(tmpdir(), `sma-spa-dist-${name}-`))
  const dist = join(root, ...SPA_DIST_REL.split('/'))
  mkdirSync(dist, { recursive: true })
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dist, ...rel.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text, 'utf8')
  }
  return { root, dist }
}

function readDist(dist: string, rel: string) {
  return readFileSync(join(dist, ...rel.split('/')), 'utf8')
}

/** Соседи раздачи — то, что осталось на диске от сборки. Пусто = за собой убрано. */
function neighbours(root: string) {
  return readdirSync(join(root, 'daemon', 'static')).filter((n) => n.startsWith('.app-'))
}

describe('сборка окна: раздача подменяется только после успеха', () => {
  it('сборщик пишет во ВРЕМЕННЫЙ каталог, и раздача становится новой одним движением', () => {
    const { root, dist } = treeWithWindow('green')
    try {
      let sawOutDir: string | null = null
      const res: any = stageSpaBuild({
        root,
        run: ({ env }: any) => {
          sawOutDir = env[SPA_OUT_DIR_ENV]
          // Сборщик, как он и делает: стирает свой выходной каталог и пишет туда заново.
          rmSync(sawOutDir as unknown as string, { recursive: true, force: true })
          mkdirSync(sawOutDir as unknown as string, { recursive: true })
          writeFileSync(join(sawOutDir as unknown as string, 'index.html'), 'ОКНО ВЕТКИ', 'utf8')
          // …и пока он это делает, раздача обязана стоять нетронутой.
          expect(readDist(dist, 'index.html'), 'раздачу нельзя трогать до успеха сборки').toBe('ОКНО ВЕРШИНЫ')
          return { ok: true, exitCode: 0 }
        },
      })
      expect(res.built).toBe(true)
      expect(res.distTouched).toBe(true)
      expect(String(sawOutDir), 'сборщику обязан быть назван ВРЕМЕННЫЙ каталог').toContain(STAGE_PREFIX)
      expect(readDist(dist, 'index.html')).toBe('ОКНО ВЕТКИ')
      expect(neighbours(root), 'после подмены рядом с раздачей не остаётся ничего').toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('упавшая сборка оставляет прежнее окно на диске — байт в байт', () => {
    const { root, dist } = treeWithWindow('red', { 'index.html': 'ОКНО ВЕРШИНЫ', 'assets/app.js': 'старый бандл' })
    try {
      const res: any = stageSpaBuild({
        root,
        run: ({ env }: any) => {
          // Сборщик стёр СВОЙ каталог и умер на середине — раздачи он не касался вовсе.
          rmSync(env[SPA_OUT_DIR_ENV], { recursive: true, force: true })
          return { ok: false, exitCode: 2 }
        },
      })
      expect(res.built).toBe(false)
      expect(res.distTouched, 'раздача не тронута — это ФАКТ, а не надежда').toBe(false)
      expect(res.exitCode).toBe(2)
      expect(res.note).toContain(DIST_UNTOUCHED_NOTE)
      expect(readDist(dist, 'index.html')).toBe('ОКНО ВЕРШИНЫ')
      expect(readDist(dist, 'assets/app.js')).toBe('старый бандл')
      expect(neighbours(root), 'временный каталог упавшей сборки за собой убирается').toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('сборка, вышедшая нулём и не произведшая ни одного файла, раздачу не подменяет', () => {
    const { root, dist } = treeWithWindow('empty')
    try {
      const res: any = stageSpaBuild({ root, run: () => ({ ok: true, exitCode: 0 }) })
      expect(res.built, 'пустой выход — это не собранное окно').toBe(false)
      expect(res.distTouched).toBe(false)
      expect(res.note).toBe(EMPTY_BUILD_NOTE)
      expect(readDist(dist, 'index.html')).toBe('ОКНО ВЕРШИНЫ')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('дерево без раздачи собирается впервые — подменять нечего, каталог просто встаёт на место', () => {
    const root = mkdtempSync(join(tmpdir(), 'sma-spa-dist-first-'))
    try {
      mkdirSync(join(root, 'daemon', 'static'), { recursive: true })
      const res: any = stageSpaBuild({
        root,
        run: ({ env }: any) => {
          writeFileSync(join(env[SPA_OUT_DIR_ENV], 'index.html'), 'ПЕРВОЕ ОКНО', 'utf8')
          return { ok: true, exitCode: 0 }
        },
      })
      expect(res.built).toBe(true)
      expect(readDist(join(root, ...SPA_DIST_REL.split('/')), 'index.html')).toBe('ПЕРВОЕ ОКНО')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('временный каталог, оставшийся от процесса, которого больше нет, убирается следующей сборкой', () => {
    const { root, dist } = treeWithWindow('orphan')
    try {
      const orphan = join(root, 'daemon', 'static', `${STAGE_PREFIX}давно-умерший`)
      mkdirSync(orphan, { recursive: true })
      writeFileSync(join(orphan, 'index.html'), 'мусор', 'utf8')
      const res: any = stageSpaBuild({
        root,
        run: ({ env }: any) => {
          writeFileSync(join(env[SPA_OUT_DIR_ENV], 'index.html'), 'ОКНО ВЕТКИ', 'utf8')
          return { ok: true, exitCode: 0 }
        },
      })
      expect(res.swept, 'сирота обязана быть убрана, а не накапливаться').toBe(1)
      expect(existsSync(orphan)).toBe(false)
      expect(readDist(dist, 'index.html')).toBe('ОКНО ВЕТКИ')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('прежняя раздача, отложенная до вердикта по ветке', () => {
  it('отложенное возвращается на место целиком и уносит с собой окно отказанной ветки', () => {
    const { root, dist } = treeWithWindow('keep', { 'index.html': 'ОКНО ВЕРШИНЫ', 'assets/app.js': 'бандл вершины' })
    try {
      const held: any = keepDist({ root })
      expect(held.kept, 'откладывать нечего — значит и возвращать будет нечего').toBeTruthy()
      // Сборка ветки прошла: на диске лежит окно, которого на вершине нет.
      writeFileSync(join(dist, 'index.html'), 'ОКНО ОТКАЗАННОЙ ВЕТКИ', 'utf8')
      rmSync(join(dist, 'assets'), { recursive: true, force: true })

      const back: any = restoreDist({ root, kept: held.kept })
      expect(back.restored).toBe(true)
      expect(back.note).toBe(DIST_RESTORED_NOTE)
      expect(readDist(dist, 'index.html')).toBe('ОКНО ВЕРШИНЫ')
      expect(readDist(dist, 'assets/app.js'), 'возврат обязан быть ЦЕЛЫМ, а не по одному файлу').toBe('бандл вершины')
      expect(neighbours(root), 'вернув отложенное, за собой убирают').toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ветка вошла — отложенное убирается, и раздача остаётся новой', () => {
    const { root, dist } = treeWithWindow('drop')
    try {
      const held: any = keepDist({ root })
      writeFileSync(join(dist, 'index.html'), 'ОКНО ПРИНЯТОЙ ВЕТКИ', 'utf8')
      expect(dropKept({ kept: held.kept })).toBe(true)
      expect(readDist(dist, 'index.html')).toBe('ОКНО ПРИНЯТОЙ ВЕТКИ')
      expect(neighbours(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('откладывать было нечего — возврат говорит это словами, а не возвращает пустоту', () => {
    const root = mkdtempSync(join(tmpdir(), 'sma-spa-dist-nokeep-'))
    try {
      mkdirSync(join(root, 'daemon', 'static'), { recursive: true })
      expect((keepDist({ root }) as any).keepNote).toBe(DIST_NOTHING_KEPT_NOTE)
      const back: any = restoreDist({ root, kept: null })
      expect(back.restored).toBe(false)
      expect(back.note).toBe(DIST_NOTHING_KEPT_NOTE)
      expect(existsSync(join(root, ...SPA_DIST_REL.split('/'))), 'возвращать было нечего — и ничего не создано').toBe(
        false,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('выходной каталог сборщика — одно определение на весь продукт', () => {
  it('названный снаружи каталог побеждает, пустое имя — нет', () => {
    expect(spaOutDir({ [SPA_OUT_DIR_ENV]: '/куда-нибудь/во-временное' })).toBe('/куда-нибудь/во-временное')
    expect(spaOutDir({ [SPA_OUT_DIR_ENV]: '   ' })).toBe(SPA_DEFAULT_OUT_DIR)
    expect(spaOutDir({})).toBe(SPA_DEFAULT_OUT_DIR)
  })

  it('настройка сборщика берёт каталог ОТСЮДА, а не пишет своё второе определение', () => {
    // Разойдясь с постановкой, настройка собирала бы окно прямо в живую раздачу — мимо
    // подмены и мимо всего, что доказано выше. Спрашивается связь, а не текст файла.
    const config = readFileSync(new URL('../../../spa/vite.config.ts', import.meta.url), 'utf8')
    expect(config).toContain('spaOutDir')
    expect(config, 'второе определение пути — это то, ради чего spaOutDir и написан').not.toMatch(
      /outDir:\s*['"]\.\.\/daemon/,
    )
  })
})
