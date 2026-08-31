/**
 * Заметка `notes/proba-potolka.md` — обещание, которое до сих пор никто не проверял.
 *
 * Обещание было дано словами и словами же осталось: файла в дереве не было вовсе —
 * не было даже каталога `notes/`. Слово, данное в карточке и не закреплённое
 * проверкой, живёт ровно до следующего чужого коммита: удалить такой файл может
 * кто угодно, и ни один прогон не покраснеет. Поэтому обещание переезжает сюда.
 *
 * Что проверяется (и почему именно это):
 *   1. файл есть на диске — иначе обещание не выполнено вообще;
 *   2. в нём есть слово «проба» — ровно то, что было обещано; файл-пустышка
 *      с нужным именем прошёл бы проверку «файл есть», но обещания не сдержал;
 *   3. файл ОТСЛЕЖИВАЕТСЯ git — иначе он живёт только в чьей-то рабочей копии
 *      и до человека не доедет. Именно так тихо исчезают заметки: лежит на диске,
 *      прогон зелёный, а в ветке ничего нет.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const NOTE_REL = 'notes/proba-potolka.md'
const NOTE = join(REPO_ROOT, NOTE_REL)

describe('notes/proba-potolka.md — обещанная заметка', () => {
  it('лежит на диске', () => {
    expect(existsSync(NOTE)).toBe(true)
  })

  it('содержит слово «проба»', () => {
    expect(readFileSync(NOTE, 'utf8').toLowerCase()).toContain('проба')
  })

  it('отслеживается git, а не живёт в одной рабочей копии', () => {
    const tracked = execFileSync('git', ['ls-files', '--', NOTE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim()
    expect(tracked).toBe(NOTE_REL)
  })
})
