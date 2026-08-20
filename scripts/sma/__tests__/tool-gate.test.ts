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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
      if (ticks <= 2) seenWhileWaiting.push(readWaitingTicket({ runDir }) as never)
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
    const waiting = readWaitingTicket({ runDir })
    expect(waiting).not.toBe(null)
    expect(waiting!.id).toBe('tk-visible')
    expect(waiting!.command).toBe('npm publish')
  })
})
