import { useEffect } from 'react'

/**
 * console-context — как ЭКРАН сообщает оболочке, что у него сейчас открыто.
 *
 * ═══════════════════ ЗАЧЕМ ЭТО ВООБЩЕ НУЖНО ═══════════════════════════════════════
 *
 * Плавающее окно разговора живёт в оболочке и обязано отвечать «в контексте открытого
 * экрана». Оболочка знает ровно одно: КАКОЙ экран на стекле. Этого мало: список задач
 * раскрывает фазу внутри себя, тем же экраном, и снаружи это движение невидимо — окно
 * говорило бы «Задачи», пока человек читает стадию фазы, и его вопрос «что дальше?»
 * уехал бы не туда.
 *
 * Поэтому направление ровно обратное соседнему механизму навигации: там экран просит
 * оболочку ПЕРЕЙТИ, здесь экран РАССКАЗЫВАЕТ оболочке, где он стоит. Событие окна — то же
 * средство, что и у навигации, по той же причине: экран не тянется в состояние оболочки, а
 * оболочка не заводит по пропсу на каждый экран, который однажды захочет рассказать о себе.
 *
 * ═══════════════════ МОЛЧАНИЕ — ТОЖЕ ОТВЕТ ════════════════════════════════════════
 *
 * Экран, который ничего не рассказал, не оставляет за собой чужой контекст: рассказ
 * снимается при уходе экрана, и окно возвращается к тому единственному, что знает оболочка,
 * — имени экрана из реестра. Так окно НИКОГДА не показывает контекст того, что уже закрыто:
 * пустой рассказ честнее устаревшего.
 */

export const CONSOLE_CONTEXT_EVENT = 'sma:console-context'

/**
 * «Откройся» — просьба показать окно разговора, не трогая его состояние снаружи.
 *
 * Кнопка на баннере остановленной задачи зовёт ИМЕННО ЭТО, а не заводит второй разговор:
 * окно уже стоит в оболочке, уже знает контекст открытой задачи (экран ей его рассказал) и
 * уже умеет всё, что нужно, — от кнопки требуется одно слово «покажись».
 */
export const CONSOLE_OPEN_EVENT = 'sma:console-open'

/** Показать окно разговора. Слушает его оболочка. */
export function openSystemConsole(): void {
  window.dispatchEvent(new CustomEvent(CONSOLE_OPEN_EVENT))
}

/** Какого рода место открыто — от этого зависят быстрые реплики окна. */
export type ConsoleContextKind = 'list' | 'phase' | 'task' | 'screen'

export interface ConsoleContext {
  kind: ConsoleContextKind
  /** Одна строка в шапку окна: «фаза 14 · стадия 3 из 4», «Задачи · 6 единиц работы». */
  line: string
  /** Задача на глазу — окну есть кому передать поправку. */
  taskId?: string
  /** Фаза на глазу. */
  phase?: string
  /** Задачу прямо сейчас держит работник: у поправки есть живая сессия, в которую ехать. */
  live?: boolean
}

/** Рассказать оболочке, что открыто. `null` — «рассказывать больше нечего». */
export function tellConsoleContext(context: ConsoleContext | null): void {
  window.dispatchEvent(new CustomEvent<ConsoleContext | null>(CONSOLE_CONTEXT_EVENT, { detail: context }))
}

/**
 * Рассказ как он читается на приёме: чужое или битое событие — не рассказ.
 *
 * Событие едет через объект окна, куда может крикнуть что угодно на странице, поэтому поля
 * проверяются здесь заново, а не принимаются на слово отправителя — тот же порядок, каким
 * оболочка читает просьбу о переходе.
 */
export function readConsoleContext(e: Event): ConsoleContext | null {
  const detail = (e as CustomEvent<ConsoleContext | null>).detail
  if (!detail || typeof detail !== 'object') return null
  const kinds: ConsoleContextKind[] = ['list', 'phase', 'task', 'screen']
  if (!kinds.includes(detail.kind)) return null
  if (typeof detail.line !== 'string' || detail.line.trim() === '') return null
  return {
    kind: detail.kind,
    line: detail.line,
    ...(typeof detail.taskId === 'string' ? { taskId: detail.taskId } : {}),
    ...(typeof detail.phase === 'string' ? { phase: detail.phase } : {}),
    ...(detail.live === true ? { live: true } : {}),
  }
}

/**
 * Экранная сторона провода: рассказывать, пока экран на глазу, и снять рассказ, уходя.
 *
 * Строка контекста — единственная зависимость эффекта, потому что именно она (а не объект,
 * пересобираемый каждым рендером) отличает «человек ушёл вглубь» от «экран просто
 * перерисовался». Поля рядом со строкой читаются через ссылку: они меняются вместе с ней.
 */
export function useTellConsoleContext(context: ConsoleContext | null): void {
  const line = context ? context.line : null
  const kind = context ? context.kind : null
  const taskId = context?.taskId ?? null
  const phase = context?.phase ?? null
  const live = context?.live === true

  useEffect(() => {
    if (!line || !kind) {
      tellConsoleContext(null)
      return
    }
    tellConsoleContext({
      kind,
      line,
      ...(taskId ? { taskId } : {}),
      ...(phase ? { phase } : {}),
      ...(live ? { live: true } : {}),
    })
    return () => tellConsoleContext(null)
  }, [line, kind, taskId, phase, live])
}
