/**
 * Tests for scripts/sma/lib/tool-gate.mjs — the PARKING TICKET.
 *
 * A dangerous call inside a live attempt is not refused: it is HELD. The session
 * physically stands on the call while a person looks at it, and continues — the same
 * session, the same call — the moment the button is pressed.
 *
 * THE FOUR THINGS THESE TESTS EXIST TO PIN:
 *
 *   1. THE REFUSAL IS BUILT INSIDE THE HOOK. Measured on a live run: a hook that
 *      outlives the timeout it declared is CANCELLED by the harness and the command
 *      RUNS. So the hook carries its own deadline, strictly smaller than the declared
 *      one, and answers «deny» by itself when it expires. The inequality is asserted
 *      here so nobody can level the two numbers in a later edit.
 *
 *   2. ONE FORM OF THE DECISION STRING, IN ONE PLACE. The button builds it and the
 *      hook reads it. A test that built the string by hand would prove the two sides
 *      agree with the TEST, not with each other — so the producer builds and the
 *      consumer parses, and a foreign look-alike is refused.
 *
 *   3. THE GATE IS NOT CLOSED FOR STRANGERS. It lives in a settings file shared by
 *      the whole machine, so it rides along with workers of other windows and of
 *      production, where our attempt directory does not exist at all. No attempt
 *      directory → ALLOW plus a line saying the gate is not configured. Inside a
 *      CONFIGURED gate the posture is the opposite: anything broken is a refusal.
 *
 *   4. APPROVING ONE COMMAND DOES NOT OPEN ANOTHER. The ticket id carries a
 *      fingerprint of the call's arguments, so different arguments mint a different
 *      ticket and the same call twice mints the same one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync, symlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ЖИВОЙ модуль поправок, а не подделка: слово кладёт настоящая дверная функция, читает
// настоящий читатель, а шапку строит настоящий производитель. Подделка здесь доказывала бы
// согласие теста с самим собой — ровно тот класс, которым зелёный сьют однажды скрыл вызов
// несуществующего метода.
import { appendRedirect, redirectFileOf, readPendingRedirectsFile, correctionsPreamble } from '../../../daemon/src/runner/redirects.mjs'

import {
  TICKET_HOOK_TIMEOUT_S,
  TICKET_OWN_DEADLINE_MS,
  TICKET_DEADLINE_MARGIN_MS,
  TICKET_DECISION_FORM,
  TICKET_DECISION_PREFIX,
  GATE_NOT_CONFIGURED,
  formatDecision,
  parseDecision,
  ticketIdFor,
  ticketsDirOf,
  ticketPathOf,
  decisionPathOf,
  readWaitingTicket,
  closeWaitingTickets,
  hookResponseFor,
  decideOnEvent,
} from '../lib/tool-gate.mjs'

let root: string
let runDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sma-gate-'))
  runDir = join(root, 'runs', 'R-1000_1')
  mkdirSync(runDir, { recursive: true })
})

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* a temp directory that survives a test run is litter, never a failure */
  }
})

/** Часы и сон, которые двигают ВРЕМЯ, а не ждут его: дедлайн проверяется мгновенно. */
function fakeClockAndSleep(startMs = 1_000_000) {
  let nowMs = startMs
  return {
    clock: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms
    },
    advance: (ms: number) => {
      nowMs += ms
    },
  }
}

const bashEvent = (command: string) => ({ tool_name: 'Bash', tool_input: { command } })

describe('tool-gate — собственный дедлайн', () => {
  it('собственный дедлайн СТРОГО меньше объявленного харнессу срока, с запасом не меньше двух минут', () => {
    const declaredMs = TICKET_HOOK_TIMEOUT_S * 1000
    expect(TICKET_OWN_DEADLINE_MS).toBeLessThan(declaredMs)
    expect(declaredMs - TICKET_OWN_DEADLINE_MS).toBeGreaterThanOrEqual(TICKET_DEADLINE_MARGIN_MS)
    expect(TICKET_DEADLINE_MARGIN_MS).toBeGreaterThanOrEqual(120_000)
  })

  it('истёкший дедлайн даёт ОТКАЗ, а не проскок, и билет помечен истёкшим', async () => {
    const t = fakeClockAndSleep()
    const verdict = await decideOnEvent({
      event: bashEvent('git push origin HEAD'),
      env: { SMA_RUN_DIR: runDir },
      clock: t.clock,
      sleep: t.sleep,
    })
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain(verdict.ticketId as string)
    const ticket = JSON.parse(readFileSync(ticketPathOf(runDir, verdict.ticketId as string), 'utf8'))
    expect(ticket.status).toBe('expired')
    expect(ticket.waitedMs).toBeGreaterThanOrEqual(TICKET_OWN_DEADLINE_MS)
  })
})

describe('tool-gate — форма решения', () => {
  it('строка, построенная ПРОИЗВОДИТЕЛЕМ, разбирается ПОТРЕБИТЕЛЕМ', () => {
    const id = ticketIdFor({ attemptId: 'R-1000_1', tool: 'Bash', input: { command: 'git push origin HEAD' } })
    const line = formatDecision({ ticketId: id, decision: 'approve', reason: 'посмотрел, это наша ветка' })
    const parsed = parseDecision(line)
    expect(parsed).not.toBe(null)
    expect(parsed!.ticketId).toBe(id)
    expect(parsed!.decision).toBe('approve')
    expect(parsed!.reason).toBe('посмотрел, это наша ветка')
  })

  it('форма объявлена ОДНОЙ константой, и обе половины строятся из неё', () => {
    expect(TICKET_DECISION_FORM).toContain(TICKET_DECISION_PREFIX)
    expect(formatDecision({ ticketId: 'tk-abc', decision: 'deny' }).startsWith(TICKET_DECISION_PREFIX)).toBe(true)
  })

  it('чужая ПОХОЖАЯ строка решением не считается — частичное совпадение ничего не значит', () => {
    expect(parseDecision('одобряю tk-abc, действуй')).toBe(null)
    expect(parseDecision('sma-tool-decision/0 tk-abc approve')).toBe(null)
    expect(parseDecision('пожалуйста, sma-tool-decision/1 tk-abc approve')).toBe(null)
    expect(parseDecision(`${TICKET_DECISION_PREFIX} tk-abc maybe`)).toBe(null)
    expect(parseDecision(`${TICKET_DECISION_PREFIX} не-билет approve`)).toBe(null)
    expect(parseDecision('')).toBe(null)
    expect(parseDecision(null as never)).toBe(null)
  })
})

describe('tool-gate — гейт НЕ СКОНФИГУРИРОВАН', () => {
  it('нет каталога попытки в окружении → РАЗРЕШЕНО плюс строка «гейт не сконфигурирован»', async () => {
    const verdict = await decideOnEvent({ event: bashEvent('git push origin HEAD'), env: {} })
    expect(verdict.decision).toBe('allow')
    expect(verdict.configured).toBe(false)
    expect(verdict.reason).toContain(GATE_NOT_CONFIGURED)
  })

  it('имя есть, а каталога на диске нет → тоже РАЗРЕШЕНО: это чужой демон, а не наша попытка', async () => {
    const verdict = await decideOnEvent({
      event: bashEvent('git push origin HEAD'),
      env: { SMA_RUN_DIR: join(root, 'runs', 'never-created') },
    })
    expect(verdict.decision).toBe('allow')
    expect(verdict.configured).toBe(false)
    expect(verdict.reason).toContain(GATE_NOT_CONFIGURED)
  })

  it('каталог ЕСТЬ, но гейт сломался → ОТКАЗ: внутри настроенного гейта fail-open запрещён', async () => {
    const t = fakeClockAndSleep()
    // Каталог билетов занят ФАЙЛОМ с тем же именем — запись билета не может состояться.
    writeFileSync(ticketsDirOf(runDir), 'не каталог', 'utf8')
    const verdict = await decideOnEvent({
      event: bashEvent('git push origin HEAD'),
      env: { SMA_RUN_DIR: runDir },
      clock: t.clock,
      sleep: t.sleep,
    })
    expect(verdict.decision).toBe('deny')
    expect(verdict.configured).toBe(true)
    expect(verdict.reason).toMatch(/сломал|ошибк/i)
  })
})

describe('tool-gate — парковка и решение', () => {
  it('безопасный вызов разрешается мгновенно и билета не оставляет', async () => {
    const t = fakeClockAndSleep()
    const verdict = await decideOnEvent({
      event: bashEvent('git status --porcelain'),
      env: { SMA_RUN_DIR: runDir },
      clock: t.clock,
      sleep: t.sleep,
    })
    expect(verdict.decision).toBe('allow')
    expect(verdict.dangerous).toBe(false)
    expect(verdict.ticketId).toBe(null)
    expect(existsSync(ticketsDirOf(runDir))).toBe(false)
  })

  it('опасный вызов кладёт билет со статусом ожидания, и пока вызов СТОИТ — карточка его видит', async () => {
    const id = ticketIdFor({ attemptId: 'R-1000_1', tool: 'Bash', input: { command: 'npm publish' } })
    let nowMs = 1_000_000
    let ticks = 0
    const seenWhileWaiting: Array<Record<string, unknown> | null> = []
    // Решение приходит на ТРЕТЬЕМ опросе — до него вызов физически стоит, и на каждом
    // такте карточка читает билет тем же кодом, каким его прочитает дверь.
    const sleep = async (ms: number) => {
      nowMs += ms
      ticks += 1
      // ЧИТАТЕЛЬ СМОТРИТ НА ТЕ ЖЕ ЧАСЫ, что и вызов, который стоит: билет несёт СВОЙ срок, и
      // читатель его уважает, так что чтение по чужим часам ответило бы «этого никто не ждёт»
      // про вызов, который в эту самую секунду стоит.
      if (ticks <= 2) seenWhileWaiting.push(readWaitingTicket({ runDir, clock: () => nowMs }) as never)
      if (ticks === 3) writeFileSync(decisionPathOf(runDir, id), formatDecision({ ticketId: id, decision: 'approve' }), 'utf8')
    }
    const verdict = await decideOnEvent({
      event: bashEvent('npm publish'),
      env: { SMA_RUN_DIR: runDir },
      clock: () => nowMs,
      sleep,
    })
    expect(seenWhileWaiting.length).toBe(2)
    expect(seenWhileWaiting[0]).not.toBe(null)
    expect((seenWhileWaiting[0] as Record<string, unknown>).status).toBe('waiting')
    expect((seenWhileWaiting[0] as Record<string, unknown>).id).toBe(id)
    expect(verdict.ticketId).toBe(id)
    expect(verdict.decision).toBe('allow')
    const ticket = JSON.parse(readFileSync(ticketPathOf(runDir, id), 'utf8'))
    expect(ticket.status).toBe('approved')
    expect(ticket.command).toContain('publish')
    expect(ticket.class).toBe('publish')
  })

  it('решение ФАЙЛОМ рядом с билетом отпускает вызов, отказ человека несёт его причину', async () => {
    const t = fakeClockAndSleep()
    const id = ticketIdFor({ attemptId: 'R-1000_1', tool: 'Bash', input: { command: 'rm -rf ./dist' } })
    mkdirSync(ticketsDirOf(runDir), { recursive: true })
    writeFileSync(decisionPathOf(runDir, id), formatDecision({ ticketId: id, decision: 'deny', reason: 'не трогай сборку' }), 'utf8')
    const verdict = await decideOnEvent({
      event: bashEvent('rm -rf ./dist'),
      env: { SMA_RUN_DIR: runDir },
      clock: t.clock,
      sleep: t.sleep,
    })
    expect(verdict.decision).toBe('deny')
    expect(verdict.decidedBy).toBe('file')
    expect(verdict.reason).toContain('не трогай сборку')
  })

  it('решение СТРОКОЙ переписки отпускает вызов, и запись отмечается потреблённой', async () => {
    const t = fakeClockAndSleep()
    const id = ticketIdFor({ attemptId: 'R-1000_1', tool: 'Bash', input: { command: 'git tag -a v1 -m x' } })
    const redirects = join(root, 'redirects', 'S-1.ndjson')
    mkdirSync(join(root, 'redirects'), { recursive: true })
    writeFileSync(
      redirects,
      `${JSON.stringify({ kind: 'ask', id: 'rd-1', ts: 'x', mode: 'queue', text: formatDecision({ ticketId: id, decision: 'approve', reason: 'да' }) })}\n`,
      'utf8',
    )
    const verdict = await decideOnEvent({
      event: bashEvent('git tag -a v1 -m x'),
      env: { SMA_RUN_DIR: runDir, SMA_REDIRECTS_FILE: redirects },
      clock: t.clock,
      sleep: t.sleep,
    })
    expect(verdict.decision).toBe('allow')
    expect(verdict.decidedBy).toBe('redirect')
    // Отмечена потреблённой — строка решения НИКОГДА не доезжает до работника указанием.
    const lines = readFileSync(redirects, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l))
    expect(lines.some((l) => l.kind === 'done' && l.id === 'rd-1')).toBe(true)
  })

  it('чужая поправка в переписке НЕ считается решением и остаётся работнику', async () => {
    const t = fakeClockAndSleep()
    const redirects = join(root, 'redirects', 'S-2.ndjson')
    mkdirSync(join(root, 'redirects'), { recursive: true })
    writeFileSync(
      redirects,
      `${JSON.stringify({ kind: 'ask', id: 'rd-9', ts: 'x', mode: 'queue', text: 'нет, не так — перепиши тест' })}\n`,
      'utf8',
    )
    const verdict = await decideOnEvent({
      event: bashEvent('git merge main'),
      env: { SMA_RUN_DIR: runDir, SMA_REDIRECTS_FILE: redirects },
      clock: t.clock,
      sleep: t.sleep,
    })
    expect(verdict.decision).toBe('deny') // дедлайн истёк, решения не было
    const lines = readFileSync(redirects, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l))
    expect(lines.some((l) => l.kind === 'done')).toBe(false)
  })
})

describe('tool-gate — отпечаток аргументов', () => {
  it('повтор ТОГО ЖЕ вызова даёт ТОТ ЖЕ билет; другие аргументы — другой', () => {
    const a = ticketIdFor({ attemptId: 'R-1', tool: 'Bash', input: { command: 'git push origin HEAD' } })
    const again = ticketIdFor({ attemptId: 'R-1', tool: 'Bash', input: { command: 'git push origin HEAD' } })
    const other = ticketIdFor({ attemptId: 'R-1', tool: 'Bash', input: { command: 'git push origin main' } })
    expect(a).toBe(again)
    expect(other).not.toBe(a)
    // И тот же вызов в ДРУГОЙ попытке — тоже другой билет: одобрение не переживает попытку.
    expect(ticketIdFor({ attemptId: 'R-2', tool: 'Bash', input: { command: 'git push origin HEAD' } })).not.toBe(a)
  })

  it('порядок ключей во входе билет не меняет — отпечаток берётся с сортировкой', () => {
    const a = ticketIdFor({ attemptId: 'R-1', tool: 'Bash', input: { command: 'x', description: 'y' } })
    const b = ticketIdFor({ attemptId: 'R-1', tool: 'Bash', input: { description: 'y', command: 'x' } })
    expect(a).toBe(b)
  })
})

describe('tool-gate — ответ харнессу', () => {
  it('ответ строится нашей функцией в форме, доказанной живым прогоном', () => {
    const res = hookResponseFor({ decision: 'deny', reason: 'билет tk-x ждёт человека' })
    expect(res.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(res.hookSpecificOutput.permissionDecisionReason).toContain('tk-x')
  })

  it('ожидающий билет читается с диска для карточки; пустой каталог — не ошибка', () => {
    expect(readWaitingTicket({ runDir })).toBe(null)
    mkdirSync(ticketsDirOf(runDir), { recursive: true })
    writeFileSync(
      ticketPathOf(runDir, 'tk-visible'),
      JSON.stringify({ id: 'tk-visible', status: 'waiting', command: 'npm publish', deadlineAt: '2026-08-19T00:00:00Z' }),
      'utf8',
    )
    // Часы НАЗВАНЫ, а не взяты у календаря: билет несёт свой срок, и читатель его уважает —
    // фикстура с прибитой датой иначе зеленела бы ровно до этой даты и краснела бы потом.
    const waiting = readWaitingTicket({ runDir, clock: () => Date.parse('2026-08-18T12:00:00Z') })
    expect(waiting).not.toBe(null)
    expect(waiting!.id).toBe('tk-visible')
    expect(waiting!.command).toBe('npm publish')
  })
})

/**
 * ═══ ОСИРОТЕВШИЙ БИЛЕТ ПЕРЕСТАЁТ ГОВОРИТЬ «ЖДУТ ВАС» ═══════════════════════════════════════
 *
 * ПОВОД. Билет закрывают три пути — одобрение, отказ, собственный дедлайн, — и ВСЕ ТРИ пишет
 * процесс хука. Умер процесс (убили сессию, упал демон, оборвался провайдер) — файл навсегда
 * остаётся `waiting`, и карточка задачи честно показывает «ждут вас» там, где уже никто не
 * ждёт. Читатель билета зовётся ровно у строки со статусом «захвачена», то есть ровно в том
 * состоянии, в котором живёт умерший процесс.
 *
 * ЛЕЧИТСЯ С ОБОИХ КОНЦОВ, и это не перестраховка:
 *   - ЧИТАТЕЛЬ перестаёт игнорировать срок, который записал сам писатель. Это не изобретённый
 *     вердикт — это прочитанный факт. Лечит все билеты, УЖЕ лежащие на диске;
 *   - ПИСАТЕЛЬ помечает оставшиеся ожидающие билеты при завершении попытки. Лечит будущие.
 *
 * Один конец без другого оставляет половину: без читателя лежащие сейчас файлы врут вечно, без
 * писателя каждый новый билет врёт ровно до своего срока.
 */
describe('tool-gate — истёкший билет не «ждут вас»', () => {
  const putTicket = (id: string, over: Record<string, unknown> = {}) => {
    mkdirSync(ticketsDirOf(runDir), { recursive: true })
    writeFileSync(
      ticketPathOf(runDir, id),
      JSON.stringify({
        schema: 'sma-ticket/1',
        id,
        attemptId: 'R-1000_1',
        status: 'waiting',
        tool: 'Bash',
        command: 'npm publish',
        seenAt: '2026-08-20T10:00:00Z',
        deadlineAt: '2026-08-20T10:10:00Z',
        ...over,
      }),
      'utf8',
    )
  }
  const at = (iso: string) => () => Date.parse(iso)

  it('истёкший билет читателем не возвращается — срок записал сам писатель', () => {
    putTicket('tk-old', { deadlineAt: '2026-08-20T10:10:00Z' })
    expect(readWaitingTicket({ runDir, clock: at('2026-08-20T10:11:00Z') })).toBe(null)
  })

  it('свежий билет возвращается как раньше', () => {
    putTicket('tk-fresh', { deadlineAt: '2026-08-20T10:10:00Z' })
    const waiting = readWaitingTicket({ runDir, clock: at('2026-08-20T10:05:00Z') })
    expect(waiting).not.toBe(null)
    expect(waiting!.id).toBe('tk-fresh')
  })

  it('из двух ожидающих возвращается новейший — поведение не изменилось', () => {
    putTicket('tk-a', { seenAt: '2026-08-20T10:00:00Z', deadlineAt: '2026-08-20T10:30:00Z' })
    putTicket('tk-b', { seenAt: '2026-08-20T10:02:00Z', deadlineAt: '2026-08-20T10:30:00Z' })
    expect(readWaitingTicket({ runDir, clock: at('2026-08-20T10:05:00Z') })!.id).toBe('tk-b')
  })

  it('билет БЕЗ записанного срока читается как раньше — фильтр судит только по прочитанному факту', () => {
    putTicket('tk-no-deadline', { deadlineAt: undefined })
    expect(readWaitingTicket({ runDir, clock: at('2030-01-01T00:00:00Z') })!.id).toBe('tk-no-deadline')
  })

  it('нечитаемый срок билета не выбрасывает его — непонятное не значит истёкшее', () => {
    putTicket('tk-broken-deadline', { deadlineAt: 'завтра' })
    expect(readWaitingTicket({ runDir, clock: at('2030-01-01T00:00:00Z') })!.id).toBe('tk-broken-deadline')
  })

  it('порванный билет пропускается, остальные читаются', () => {
    mkdirSync(ticketsDirOf(runDir), { recursive: true })
    writeFileSync(ticketPathOf(runDir, 'tk-torn'), '{не json', 'utf8')
    putTicket('tk-ok', { deadlineAt: '2026-08-20T10:30:00Z' })
    expect(readWaitingTicket({ runDir, clock: at('2026-08-20T10:05:00Z') })!.id).toBe('tk-ok')
  })
})

describe('tool-gate — завершение попытки закрывает оставшиеся билеты', () => {
  const putTicket = (id: string, over: Record<string, unknown> = {}) => {
    mkdirSync(ticketsDirOf(runDir), { recursive: true })
    writeFileSync(
      ticketPathOf(runDir, id),
      JSON.stringify({ schema: 'sma-ticket/1', id, status: 'waiting', tool: 'Bash', command: 'npm publish', seenAt: '2026-08-20T10:00:00Z', deadlineAt: '2026-08-20T10:10:00Z', ...over }),
      'utf8',
    )
  }
  const readTicket = (id: string) => JSON.parse(readFileSync(ticketPathOf(runDir, id), 'utf8'))

  it('оставшиеся ожидающие билеты помечаются закрытыми вместе с попыткой, с причиной словами', () => {
    putTicket('tk-1')
    putTicket('tk-2')
    const closed = closeWaitingTickets({ runDir, clock: () => Date.parse('2026-08-20T10:04:00Z') })

    expect(closed).toBe(2)
    for (const id of ['tk-1', 'tk-2']) {
      const row = readTicket(id)
      expect(row.status).not.toBe('waiting')
      expect(row.decidedBy).toBe('attempt-end')
      expect(String(row.reason ?? row.closedReason ?? '')).toContain('попытк')
    }
    expect(readWaitingTicket({ runDir, clock: () => Date.parse('2026-08-20T10:04:00Z') })).toBe(null)
  })

  it('уже решённый билет не переписывается — решение человека остаётся решением человека', () => {
    putTicket('tk-approved', { status: 'approved', decidedBy: 'file', humanReason: 'да, можно' })
    expect(closeWaitingTickets({ runDir })).toBe(0)
    expect(readTicket('tk-approved')).toMatchObject({ status: 'approved', decidedBy: 'file', humanReason: 'да, можно' })
  })

  it('повторное завершение ничего не ломает и никого не закрывает дважды', () => {
    putTicket('tk-1')
    expect(closeWaitingTickets({ runDir })).toBe(1)
    expect(closeWaitingTickets({ runDir })).toBe(0)
  })

  it('отсутствующий каталог, порванный билет и нечитаемый каталог — «нечего помечать», никогда не ошибка попытки', () => {
    expect(closeWaitingTickets({ runDir: join(root, 'нет-такого') })).toBe(0)
    expect(closeWaitingTickets({ runDir: '' })).toBe(0)

    mkdirSync(ticketsDirOf(runDir), { recursive: true })
    writeFileSync(ticketPathOf(runDir, 'tk-torn'), '{не json', 'utf8')
    putTicket('tk-ok')
    expect(closeWaitingTickets({ runDir })).toBe(1)

    expect(
      closeWaitingTickets({
        runDir,
        fsImpl: {
          existsSync: () => true,
          readdirSync: () => {
            throw new Error('каталог не читается')
          },
        },
      }),
    ).toBe(0)
  })
})

/**
 * ═══ СЛОВО ЖИВОМУ ХОДУ: ПРОВОД ОТ ДВЕРИ ДО STDOUT ХУКА ════════════════════════════════════
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ, И ПОЧЕМУ ИМЕННО ЭТО. Не «жатва вычислила массив», а «слово,
 * положенное дверью, доехало до того самого поля, которое читает CLI». Класс дефекта, ради
 * которого тесты написаны так: конверт разрешений считался, хэшировался и писался в журнал —
 * и не передавался запускаемому процессу, поэтому работник физически не мог тронуть ни одного
 * файла. Каждый кусок был зелёным, и ни один не был присоединён к соседнему. Поэтому здесь
 * утверждения идут ДО КОНЦА провода: `appendRedirect` (дверная функция) → файл → жатва →
 * `hookResponseFor` → поле `additionalContext` ответа.
 *
 * ЖИВОЙ МОДУЛЬ ПОПРАВОК. Подделок ровно две — часы и сон, ради мгновенного дедлайна; всё, что
 * касается хранилища, настоящее и лежит во временном каталоге ВНЕ рабочего дерева.
 *
 * ГРАНИЦА КАНАЛА НАЗВАНА, А НЕ СПРЯТАНА: доставка живёт только на границе вызова инструмента,
 * и только на разрешающем ответе. Отказ почтой не является, и это заперто отдельным тестом.
 */
describe('tool-gate — слово живому ходу', () => {
  const TASK = 'live-word-1'
  const WORD = 'сначала прогони сьют, потом коммить'
  let dataDir: string
  let file: string

  beforeEach(() => {
    dataDir = join(root, 'daemon-data')
    file = redirectFileOf({ dataDir, taskId: TASK }) as string
  })

  /** Кладёт строку ТОЙ ЖЕ функцией, какой её кладёт дверь окна. */
  const put = (text: string, mode: string, atMs: number) => {
    const res = appendRedirect({ dataDir, taskId: TASK, text, mode, clock: () => atMs })
    expect(res.ok).toBe(true)
    return res.id as string
  }

  const linesOf = () =>
    readFileSync(file, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((l) => JSON.parse(l))

  it('(а) слово, положенное дверью, доезжает до additionalContext ответа хука', async () => {
    const t = fakeClockAndSleep()
    put(WORD, 'steer', 1)

    const verdict = await decideOnEvent({
      event: bashEvent('git status --porcelain'),
      env: { SMA_RUN_DIR: runDir, SMA_REDIRECTS_FILE: file },
      clock: t.clock,
      sleep: t.sleep,
    })

    expect(verdict.decision).toBe('allow')
    expect(verdict.steerTexts).toEqual([WORD])

    const res = hookResponseFor(verdict)
    expect(res.hookSpecificOutput.additionalContext).toContain(WORD)
    // И ФОРМА СЛОВ — ОБЩАЯ С ЦИКЛОМ ПРОДОЛЖЕНИЯ, а не вторая склейка в хуке: сверяется с
    // ПРОИЗВОДИТЕЛЕМ, поэтому правка шапки в одном месте не разведёт две дороги одного слова.
    expect(res.hookSpecificOutput.additionalContext).toBe(correctionsPreamble([{ text: WORD }]))
  })

  it('(б) слово потребляется РОВНО ОДИН РАЗ — второй вызов приезжает пустым', async () => {
    const t = fakeClockAndSleep()
    const id = put(WORD, 'steer', 1)

    const first = await decideOnEvent({
      event: bashEvent('git status --porcelain'),
      env: { SMA_RUN_DIR: runDir, SMA_REDIRECTS_FILE: file },
      clock: t.clock,
      sleep: t.sleep,
    })
    expect(first.steerTexts).toEqual([WORD])
    expect(linesOf().some((l) => l.kind === 'done' && l.id === id)).toBe(true)

    const second = await decideOnEvent({
      event: bashEvent('git status --porcelain'),
      env: { SMA_RUN_DIR: runDir, SMA_REDIRECTS_FILE: file },
      clock: t.clock,
      sleep: t.sleep,
    })
    expect(second.decision).toBe('allow')
    expect(second.steerTexts).toEqual([])
    expect(hookResponseFor(second).hookSpecificOutput).not.toHaveProperty('additionalContext')
  })

  it('(в) чужого не ест: «после хода», «перебить» и решение по билету остаются нетронутыми', async () => {
    const t = fakeClockAndSleep()
    const ticketId = ticketIdFor({ attemptId: 'R-1000_1', tool: 'Bash', input: { command: 'npm publish' } })
    put('поправка на следующий заход', 'queue', 1)
    put('брось всё и вернись', 'interrupt', 2)
    // РЕШЕНИЕ, ПОЛОЖЕННОЕ ТРЕТЬИМ РЕЖИМОМ ПО ОШИБКЕ. Судит разборщик, а не поле режима:
    // строка адресована стоящему вызову, и съесть её значило бы оставить человека нажимать
    // «Одобрить» в пустоту.
    put(formatDecision({ ticketId, decision: 'approve', reason: 'да' }), 'steer', 3)

    const verdict = await decideOnEvent({
      event: bashEvent('git status --porcelain'),
      env: { SMA_RUN_DIR: runDir, SMA_REDIRECTS_FILE: file },
      clock: t.clock,
      sleep: t.sleep,
    })

    expect(verdict.decision).toBe('allow')
    expect(verdict.steerTexts).toEqual([])
    expect(linesOf().some((l) => l.kind === 'done')).toBe(false)
    expect(readPendingRedirectsFile({ file }).length).toBe(3)
  })

  it('(г) решение по-прежнему отпускает билет, и слово из того же файла едет вместе с ним', async () => {
    const t = fakeClockAndSleep()
    const ticketId = ticketIdFor({ attemptId: 'R-1000_1', tool: 'Bash', input: { command: 'npm publish' } })
    const decisionId = put(formatDecision({ ticketId, decision: 'approve', reason: 'посмотрел' }), 'queue', 1)
    put(WORD, 'steer', 2)

    const verdict = await decideOnEvent({
      event: bashEvent('npm publish'),
      env: { SMA_RUN_DIR: runDir, SMA_REDIRECTS_FILE: file },
      clock: t.clock,
      sleep: t.sleep,
    })

    expect(verdict.decision).toBe('allow')
    expect(verdict.decidedBy).toBe('redirect')
    expect(verdict.ticketId).toBe(ticketId)
    expect(verdict.steerTexts).toEqual([WORD])
    expect(hookResponseFor(verdict).hookSpecificOutput.additionalContext).toContain(WORD)
    // Строка решения потреблена как решение — она не имеет права доехать до работника словом.
    expect(linesOf().some((l) => l.kind === 'done' && l.id === decisionId)).toBe(true)
  })

  it('(д) без файла поправок — НИ ОДНОГО обращения к нему, и ответ прежней формы байт в байт', async () => {
    const t = fakeClockAndSleep()
    put(WORD, 'steer', 1) // слово ЕСТЬ на диске, но путь этой сессии не передан
    const touched: string[] = []
    const spy = {
      existsSync: (p: string) => {
        touched.push(String(p))
        return existsSync(p)
      },
      readFileSync: (p: string, e: string) => {
        touched.push(String(p))
        return readFileSync(p, e as never)
      },
      writeFileSync: (p: string, d: string, e: string) => writeFileSync(p, d, e as never),
      mkdirSync: (p: string, o: never) => mkdirSync(p, o),
      readdirSync: (p: string) => readdirSync(p),
      appendFileSync: (p: string, d: string, e: string) => {
        touched.push(String(p))
        return appendFileSync(p, d, e as never)
      },
    }

    const verdict = await decideOnEvent({
      event: bashEvent('git status --porcelain'),
      env: { SMA_RUN_DIR: runDir },
      clock: t.clock,
      sleep: t.sleep,
      fsImpl: spy,
    })

    expect(verdict.decision).toBe('allow')
    expect(verdict.steerTexts).toEqual([])
    // Хук живёт в файле настроек, общем для всей машины: чужая сессия не платит за чтение,
    // которое ей никогда не понадобится.
    expect(touched.filter((p) => p.includes('redirects')).length).toBe(0)
    // ФОРМА ОТВЕТА БЕЗ СЛОВА — ровно три прежних ключа, ни одного нового.
    expect(Object.keys(hookResponseFor(verdict).hookSpecificOutput).sort()).toEqual([
      'hookEventName',
      'permissionDecision',
      'permissionDecisionReason',
    ])
  })

  it('(е) на ОТКАЗЕ слово не едет и остаётся ждущим — отложено, а не потеряно', async () => {
    const t = fakeClockAndSleep()
    const ticketId = ticketIdFor({ attemptId: 'R-1000_1', tool: 'Bash', input: { command: 'rm -rf ./dist' } })
    mkdirSync(ticketsDirOf(runDir), { recursive: true })
    writeFileSync(decisionPathOf(runDir, ticketId), formatDecision({ ticketId, decision: 'deny', reason: 'не трогай сборку' }), 'utf8')
    const wordId = put(WORD, 'steer', 1)

    const verdict = await decideOnEvent({
      event: bashEvent('rm -rf ./dist'),
      env: { SMA_RUN_DIR: runDir, SMA_REDIRECTS_FILE: file },
      clock: t.clock,
      sleep: t.sleep,
    })

    expect(verdict.decision).toBe('deny')
    expect(verdict.steerTexts).toEqual([])
    expect(hookResponseFor(verdict).hookSpecificOutput).not.toHaveProperty('additionalContext')
    // Строка ЖДЁТ: её подберёт следующая граница вызова либо цикл продолжения после выхода.
    expect(linesOf().some((l) => l.kind === 'done' && l.id === wordId)).toBe(false)
    expect(readPendingRedirectsFile({ file }).map((r: { id: string }) => r.id)).toContain(wordId)
  })

  it('(ж) сломанная почта не меняет вердикт: непрочитанное — молчит, непомеченное — доезжает', async () => {
    const t = fakeClockAndSleep()
    put(WORD, 'steer', 1)
    const wrap = (over: Record<string, unknown>) => ({
      existsSync: (p: string) => existsSync(p),
      readFileSync: (p: string, e: string) => readFileSync(p, e as never),
      writeFileSync: (p: string, d: string, e: string) => writeFileSync(p, d, e as never),
      mkdirSync: (p: string, o: never) => mkdirSync(p, o),
      readdirSync: (p: string) => readdirSync(p),
      appendFileSync: (p: string, d: string, e: string) => appendFileSync(p, d, e as never),
      ...over,
    })

    // ХРАНИЛИЩЕ НЕ ЧИТАЕТСЯ. Слова нет — и вызов всё равно разрешён: почтальон сломался, а не
    // страж. Отказ здесь останавливал бы безобидную работу из-за чужого файла.
    const unreadable = await decideOnEvent({
      event: bashEvent('git status --porcelain'),
      env: { SMA_RUN_DIR: runDir, SMA_REDIRECTS_FILE: file },
      clock: t.clock,
      sleep: t.sleep,
      fsImpl: wrap({
        existsSync: (p: string) => {
          if (String(p).includes('redirects')) throw new Error('хранилище поправок не читается')
          return existsSync(p)
        },
      }),
    })
    expect(unreadable.decision).toBe('allow')
    expect(unreadable.steerTexts).toEqual([])

    // ОТМЕТКА НЕ ПИШЕТСЯ. Слово всё равно отдано: приехать дважды — неудобство, не приехать
    // ни разу — сорванное обещание, ради которого хранилище и заведено.
    const unmarkable = await decideOnEvent({
      event: bashEvent('git status --porcelain'),
      env: { SMA_RUN_DIR: runDir, SMA_REDIRECTS_FILE: file },
      clock: t.clock,
      sleep: t.sleep,
      fsImpl: wrap({
        appendFileSync: () => {
          throw new Error('отметку записать не удалось')
        },
      }),
    })
    expect(unmarkable.decision).toBe('allow')
    expect(unmarkable.steerTexts).toEqual([WORD])
  })
})

/**
 * УСТАНОВКА ЗАВИСИМОСТЕЙ СКВОЗЬ ССЫЛКУ — ЕДИНСТВЕННЫЙ ОТКАЗ БЕЗ БИЛЕТА.
 *
 * Билет означает «пусть посмотрит человек», и он уместен там, где человек МОЖЕТ сделать
 * вызов безопасным. Установка в каталог, чей `node_modules` — ссылка в чужое дерево,
 * безопасной не становится ни от чьего одобрения: нажавший «Одобрить» опустошит склад, в
 * котором сам же и работает (31.08.2026, трижды за сутки). Поэтому здесь отказ сразу и
 * словами — а установка в СВОЙ настоящий каталог фактом не подтверждается и уезжает на
 * обычную парковку, как всё остальное опасное.
 */
describe('tool-gate — установка сквозь ссылку отказывается по факту, а не паркуется', () => {
  it('node_modules копии — ссылка наружу → ОТКАЗ сразу, без билета и без ожидания', async () => {
    const main = join(root, 'main')
    const copy = join(root, 'copy')
    mkdirSync(join(main, 'node_modules'), { recursive: true })
    mkdirSync(copy, { recursive: true })
    symlinkSync(join(main, 'node_modules'), join(copy, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')

    const t = fakeClockAndSleep()
    const verdict = await decideOnEvent({
      event: { ...bashEvent('npm ci --no-audit'), cwd: copy },
      env: { SMA_RUN_DIR: runDir },
      clock: t.clock,
      sleep: t.sleep,
    })

    expect(verdict.decision).toBe('deny')
    expect(verdict.dangerous).toBe(true)
    expect(verdict.ticketId).toBe(null) // ждать по билету было бы нечего
    expect(verdict.waitedMs).toBe(0)
    expect(String(verdict.reason)).toContain('установка отменена')
    expect(existsSync(ticketsDirOf(runDir))).toBe(false)

    rmdirSync(join(copy, 'node_modules'))
  })

  it('ссылки нет — установка остаётся ОПАСНОЙ и паркуется билетом, как раньше', async () => {
    const copy = join(root, 'own-deps')
    mkdirSync(join(copy, 'node_modules'), { recursive: true })

    const t = fakeClockAndSleep()
    const verdict = await decideOnEvent({
      event: { ...bashEvent('npm ci'), cwd: copy },
      env: { SMA_RUN_DIR: runDir },
      clock: t.clock,
      sleep: t.sleep,
    })

    expect(verdict.decision).toBe('deny') // дедлайн истёк без человека — но это ПАРКОВКА
    expect(verdict.ticketId).toBeTruthy()
    const ticket = JSON.parse(readFileSync(ticketPathOf(runDir, verdict.ticketId as string), 'utf8'))
    expect(ticket.class).toBe('deps-install')
  })
})
