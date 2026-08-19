/**
 * tool-gate.mjs — the PARKING TICKET: a dangerous call is held, not refused.
 *
 * ═══════════════ WHAT HAPPENS, IN ONE PARAGRAPH ══════════════════════════════════
 * A blocking hook runs before every tool call of a worker's session. It classifies the
 * call. Harmless → «allow» in milliseconds and the process is gone. Dangerous → a
 * TICKET is written into the attempt's own directory and the hook simply does not
 * answer: the session physically stands on that call, in that same session, with the
 * whole context it had. A person sees «ждут вас» on the card, presses «Одобрить», and
 * the very same call continues. Nothing restarts, nothing is re-read, and the
 * subscription window is not spent twice.
 *
 * ═══════════════ WHY THE REFUSAL IS BUILT HERE AND NOT LEFT TO THE HARNESS ═══════
 * Because the harness fails OPEN, and that was measured rather than assumed. A hook
 * declared with a timeout of 15 seconds was made to sleep for 40; the stream showed
 * `hook_response outcome=cancelled exit=1` — and then the tool result came back
 * `is_error=false`. The command RAN. A hook that outlives its declared timeout is
 * cancelled and the call goes through.
 *
 * So «fail closed» cannot be switched on; it has to be BUILT. This module declares
 * both numbers side by side — the timeout it asks the harness for, and its OWN
 * deadline, strictly smaller — and when its own deadline passes it answers `deny`
 * ITSELF, with the ticket's text, while the harness is still waiting. The margin
 * between the two is stated as a third constant and asserted by the suite, so nobody
 * can level them in a later edit and quietly restore the open door.
 *
 * ═══════════════ WHY IT IS NOT CLOSED FOR STRANGERS ══════════════════════════════
 * The hook is installed in the worker account's settings file, which is shared by
 * every daemon on this machine. It therefore rides along with the workers of other
 * windows and of production — sessions whose attempts have no directory of ours at
 * all. If «no attempt directory» meant «deny», this module would stop other people's
 * work from a file they never asked for. So that single case is an ALLOW, and it says
 * out loud that the gate is not configured. Closedness belongs INSIDE our attempt:
 * once the attempt directory is there, anything that breaks is a refusal by name.
 *
 * ═══════════════ WHY THE DECISION HAS ONE FORM, DECLARED HERE ════════════════════
 * The button in the window builds the decision string and this hook reads it, from two
 * different processes. An agreement between two sides that lives in two places is an
 * agreement that will drift. So the form is ONE exported constant, its builder and its
 * parser live beside it, and the suite builds with the producer and reads with the
 * consumer. A look-alike is not a decision: a correction that merely mentions a ticket
 * id releases nothing.
 *
 * ═══════════════ WHAT THIS DOES NOT PROTECT AGAINST, SAID OUT LOUD ═══════════════
 * A worker holding an open shell can write into its own attempt directory, so it can
 * forge the FILE channel of a decision. That is accepted honestly rather than papered
 * over: the ticket is a CONVENIENCE FOR THE PERSON — the soft boundary inside what is
 * already permitted — while the hard boundary is the refusal in the launch arguments,
 * which the worker cannot reach. The button's channel (the correction file in the
 * daemon's own data directory) is not the worker's to write, and a decision that came
 * from the ticket's own directory says so in the record.
 *
 * Node built-ins only. Clock, sleep and filesystem are injectable so the suite proves
 * the expired deadline in milliseconds and never touches a real attempt.
 */

import { createHash } from 'node:crypto'
import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  mkdirSync as fsMkdirSync,
  readdirSync as fsReaddirSync,
} from 'node:fs'
import { basename, join } from 'node:path'

import { classifyForWorker } from './worker-danger.mjs'
import { readPendingRedirectsFile, markConsumedFile } from '../../../daemon/src/runner/redirects.mjs'

/**
 * The timeout DECLARED to the harness, in seconds. The hook entry written into the
 * worker's settings takes this number from here and never spells it by hand.
 */
export const TICKET_HOOK_TIMEOUT_S = 720

/**
 * OUR OWN deadline, in milliseconds — strictly smaller than the declared one. When it
 * passes, this module answers `deny` itself. See the header: a hook that lets the
 * harness reach the declared timeout has its refusal cancelled and the call executed.
 */
export const TICKET_OWN_DEADLINE_MS = 600_000

/**
 * The minimum distance between the two above. Two minutes is not a style preference:
 * it is the room a slow disk, a loaded machine and one last poll need to finish before
 * the harness stops listening.
 */
export const TICKET_DEADLINE_MARGIN_MS = 120_000

/**
 * THE INEQUALITY, ENFORCED AT LOAD TIME AND NOT ONLY IN THE SUITE.
 *
 * The suite asserts it too, but a suite is checked when somebody runs it; this is checked
 * when the hook starts, in the worker's own process, every time. If a later edit ever
 * levels the two numbers, the gate refuses to exist rather than silently becoming the
 * open door the measured cancellation makes it.
 */
if (TICKET_OWN_DEADLINE_MS + TICKET_DEADLINE_MARGIN_MS > TICKET_HOOK_TIMEOUT_S * 1000) {
  throw new Error(
    'tool-gate: собственный дедлайн должен быть строго меньше объявленного харнессу срока ' +
      `с запасом ${TICKET_DEADLINE_MARGIN_MS} мс (сейчас ${TICKET_OWN_DEADLINE_MS} против ${TICKET_HOOK_TIMEOUT_S * 1000})`,
  )
}

/** How often the parked call looks for a decision. */
export const TICKET_POLL_MS = 500

/** A command on a card is a line, not a document. */
export const TICKET_COMMAND_CAP = 400

/** Каталог билетов внутри каталога попытки — вложенный, чтобы не мешать четырём файлам. */
export const TICKETS_DIRNAME = 'tickets'

/**
 * THE FORM OF A DECISION — the single source both sides read. The button's producer and
 * this hook's parser are the two functions below it, and neither side owns a second idea
 * of what the string looks like. Declared FIRST, on purpose: everything else about the
 * decision string, including the prefix that identifies one, is read out of this line.
 */
export const TICKET_DECISION_FORM = 'sma-tool-decision/1 <ticketId> approve|deny [причина]'

/**
 * The prefix that makes a line a decision and not a sentence that mentions one — TAKEN
 * FROM the form above rather than spelled a second time. Two constants written by hand
 * are two constants that can disagree, and this pair is the whole agreement between the
 * window and the hook.
 */
export const TICKET_DECISION_PREFIX = TICKET_DECISION_FORM.split(' ')[0]

/** Что отвечает хук, когда каталога попытки нет вовсе. Одно место, одни слова. */
export const GATE_NOT_CONFIGURED = 'гейт не сконфигурирован'

/** Идентификатор билета: наша форма, и всё, что на неё не похоже, решением не считается. */
const TICKET_ID_RE = /^tk-[0-9a-f]{16}$/

/** Два исхода, которые человек может выбрать. Третьего слова нет. */
const DECISIONS = new Set(['approve', 'deny'])

/** Каждый вызов файловой системы — через один объект, и каждый заменяем в тестах. */
function resolveIo(fsImpl) {
  return {
    existsSync: (fsImpl && fsImpl.existsSync) || fsExistsSync,
    readFileSync: (fsImpl && fsImpl.readFileSync) || fsReadFileSync,
    writeFileSync: (fsImpl && fsImpl.writeFileSync) || fsWriteFileSync,
    mkdirSync: (fsImpl && fsImpl.mkdirSync) || fsMkdirSync,
    readdirSync: (fsImpl && fsImpl.readdirSync) || fsReaddirSync,
  }
}

/** Ключи в одном порядке: билет не имеет права зависеть от порядка полей во входе. */
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`
}

/**
 * formatDecision({ticketId, decision, reason}) → the decision string, built by the ONE
 * producer both the button and the suite use.
 */
export function formatDecision({ ticketId, decision, reason } = {}) {
  const word = DECISIONS.has(decision) ? decision : 'deny'
  const tail = String(reason ?? '').replace(/[\r\n]+/g, ' ').trim()
  return `${TICKET_DECISION_PREFIX} ${String(ticketId ?? '')} ${word}${tail ? ` ${tail}` : ''}`
}

/**
 * parseDecision(text) → `{ticketId, decision, reason}` or null.
 *
 * The line must BEGIN with the form. A correction that merely mentions a ticket id, or
 * carries the form somewhere in the middle of a sentence, is a correction — it goes to
 * the worker as a correction and releases nothing. Partial resemblance is not consent.
 */
export function parseDecision(text) {
  if (typeof text !== 'string') return null
  const line = text.trim()
  if (!line.startsWith(`${TICKET_DECISION_PREFIX} `)) return null
  const rest = line.slice(TICKET_DECISION_PREFIX.length + 1).trim()
  const parts = rest.split(/\s+/)
  const ticketId = parts.shift() || ''
  const decision = parts.shift() || ''
  if (!TICKET_ID_RE.test(ticketId)) return null
  if (!DECISIONS.has(decision)) return null
  return { ticketId, decision, reason: parts.join(' ') }
}

/**
 * ticketIdFor({attemptId, tool, input}) → `tk-<16 hex>`.
 *
 * THE ARGUMENTS ARE IN THE ID. Approving one command therefore does not open another:
 * the same call asks for the same ticket, and a call with different arguments asks for
 * a new one. The attempt id is in the fingerprint too — an approval does not survive
 * into the next attempt, where the context that justified it no longer exists.
 */
export function ticketIdFor({ attemptId, tool, input } = {}) {
  const material = `${String(attemptId ?? '')} ${String(tool ?? '')} ${stableJson(input ?? null)}`
  return `tk-${createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16)}`
}

/** Каталог билетов этой попытки. */
export function ticketsDirOf(runDir) {
  return join(String(runDir ?? ''), TICKETS_DIRNAME)
}

/** Файл билета. */
export function ticketPathOf(runDir, ticketId) {
  return join(ticketsDirOf(runDir), `${String(ticketId ?? '')}.json`)
}

/** Файл решения рядом с билетом — второй канал, доступный человеку и с диска. */
export function decisionPathOf(runDir, ticketId) {
  return join(ticketsDirOf(runDir), `${String(ticketId ?? '')}.decision`)
}

/**
 * readWaitingTicket({runDir, fsImpl}) → the ticket a person is being waited on for, or
 * null. Read by the card door as well as by the suite, so «ждут вас» on the screen and
 * the file the hook is standing over are the same object and cannot disagree.
 */
export function readWaitingTicket({ runDir, fsImpl } = {}) {
  const io = resolveIo(fsImpl)
  const dir = ticketsDirOf(runDir)
  if (!runDir || !io.existsSync(dir)) return null
  let names = []
  try {
    names = io.readdirSync(dir)
  } catch {
    return null // нечитаемый каталог билетов — «нечего показать», а не ошибка карточки
  }
  let newest = null
  for (const name of names) {
    if (!String(name).endsWith('.json')) continue
    let row = null
    try {
      row = JSON.parse(String(io.readFileSync(join(dir, String(name)), 'utf8')))
    } catch {
      continue // порванный билет пропускается, остальные всё ещё читаются
    }
    if (!row || row.status !== 'waiting') continue
    if (!newest || String(row.seenAt ?? '') > String(newest.seenAt ?? '')) newest = row
  }
  return newest
}

/**
 * hookResponseFor({decision, reason}) → the object the harness reads.
 *
 * The shape is not guessed: a live probe of this vendor version answered a `deny` in
 * this shape with `is_error=true` on the tool result AND put the call into
 * `result.permission_denials` with its tool name and command — which is exactly the
 * evidence a person needs afterwards to see what the worker was not allowed to do.
 */
export function hookResponseFor({ decision, reason } = {}) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision === 'allow' ? 'allow' : 'deny',
      permissionDecisionReason: String(reason ?? ''),
    },
  }
}

/** Команда — одна строка на карточке, обрезанная в одном месте. */
function commandOf(event) {
  const input = (event && event.tool_input) || {}
  const raw = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : ''
  return raw.length > TICKET_COMMAND_CAP ? `${raw.slice(0, TICKET_COMMAND_CAP)}…` : raw
}

/** Запись билета — атомарности не требует: файл читают только глазами и карточкой. */
function writeTicket(io, path, row) {
  io.writeFileSync(path, `${JSON.stringify(row, null, 2)}\n`, 'utf8')
}

/**
 * Решение из файла рядом с билетом. Нечитаемый файл — это ПОЛОМКА внутри настроенного
 * гейта, и она бросает: fail-open здесь запрещён.
 */
function decisionFromFile(io, runDir, ticketId) {
  const path = decisionPathOf(runDir, ticketId)
  if (!io.existsSync(path)) return null
  const text = String(io.readFileSync(path, 'utf8'))
  return parseDecision(text)
}

/** Решение из переписки с живой задачей + отметка записи потреблённой. */
function decisionFromRedirects(file, ticketId, fsImpl, clock) {
  if (!file) return null
  const pending = readPendingRedirectsFile({ file, fsImpl })
  for (const row of pending) {
    const parsed = parseDecision(row && row.text)
    if (!parsed || parsed.ticketId !== ticketId) continue
    // ПОТРЕБЛЕНА. Строка решения не имеет права доехать до работника как указание —
    // она адресована этому хуку и больше никому.
    markConsumedFile({ file, ids: [row.id], clock, fsImpl })
    return parsed
  }
  return null
}

/**
 * decideOnEvent({event, env, clock, sleep, fsImpl}) → the verdict, as data.
 *
 * @returns {Promise<{decision:'allow'|'deny', reason:string, configured:boolean,
 *                    dangerous:boolean, ticketId:(string|null),
 *                    decidedBy:(string|null), waitedMs:number}>}
 */
export async function decideOnEvent({
  event,
  env = process.env,
  clock = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fsImpl,
} = {}) {
  const io = resolveIo(fsImpl)
  const runDir = typeof (env && env.SMA_RUN_DIR) === 'string' ? env.SMA_RUN_DIR.trim() : ''
  const base = { configured: false, dangerous: false, ticketId: null, decidedBy: null, waitedMs: 0 }

  // ── ЕДИНСТВЕННОЕ исключение из отказа-по-умолчанию, и оно намеренное ──
  // Каталога попытки нет — значит это не наша попытка: чужое окно, работник продакшна,
  // терминал человека. Закрытость здесь остановила бы работу, которой мы не занимаемся.
  if (!runDir || !io.existsSync(runDir)) {
    return { ...base, decision: 'allow', reason: `${GATE_NOT_CONFIGURED} (нет каталога попытки)` }
  }

  const startedAt = clock()
  try {
    const attemptId = basename(runDir)
    const tool = (event && event.tool_name) || ''
    const input = (event && event.tool_input) || {}
    const cwd = (event && typeof event.cwd === 'string' && event.cwd) || (env && env.CLAUDE_PROJECT_DIR) || ''
    const verdict = classifyForWorker(tool, input, { copyRoot: cwd })
    if (!verdict.dangerous) {
      return { ...base, configured: true, decision: 'allow', reason: 'не опасно по классификатору работника' }
    }

    const ticketId = ticketIdFor({ attemptId, tool, input })
    const deadlineAt = startedAt + TICKET_OWN_DEADLINE_MS
    io.mkdirSync(ticketsDirOf(runDir), { recursive: true })
    const ticketPath = ticketPathOf(runDir, ticketId)
    const ticket = {
      schema: 'sma-ticket/1',
      id: ticketId,
      attemptId,
      status: 'waiting',
      tool,
      command: commandOf(event),
      class: verdict.class,
      reason: verdict.reason,
      seenAt: new Date(startedAt).toISOString(),
      deadlineAt: new Date(deadlineAt).toISOString(),
      decidedAt: null,
      decidedBy: null,
      waitedMs: null,
    }
    writeTicket(io, ticketPath, ticket)

    const redirectsFile = typeof (env && env.SMA_REDIRECTS_FILE) === 'string' ? env.SMA_REDIRECTS_FILE.trim() : ''
    for (;;) {
      const fromFile = decisionFromFile(io, runDir, ticketId)
      const found = fromFile || decisionFromRedirects(redirectsFile, ticketId, fsImpl, clock)
      if (found) {
        const waitedMs = clock() - startedAt
        const decidedBy = fromFile ? 'file' : 'redirect'
        writeTicket(io, ticketPath, {
          ...ticket,
          status: found.decision === 'approve' ? 'approved' : 'denied',
          decidedAt: new Date(clock()).toISOString(),
          decidedBy,
          humanReason: found.reason || null,
          waitedMs,
        })
        return {
          configured: true,
          dangerous: true,
          ticketId,
          decidedBy,
          waitedMs,
          decision: found.decision === 'approve' ? 'allow' : 'deny',
          reason:
            found.decision === 'approve'
              ? `билет ${ticketId} одобрен человеком${found.reason ? `: ${found.reason}` : ''}`
              : `билет ${ticketId} отклонён человеком${found.reason ? `: ${found.reason}` : ''}`,
        }
      }
      // ── СОБСТВЕННЫЙ ДЕДЛАЙН. Отказываем САМИ, пока харнесс ещё слушает ──
      if (clock() >= deadlineAt) {
        const waitedMs = clock() - startedAt
        writeTicket(io, ticketPath, {
          ...ticket,
          status: 'expired',
          decidedAt: new Date(clock()).toISOString(),
          decidedBy: 'deadline',
          waitedMs,
        })
        return {
          configured: true,
          dangerous: true,
          ticketId,
          decidedBy: 'deadline',
          waitedMs,
          decision: 'deny',
          reason:
            `билет ${ticketId}: ${verdict.reason}. Человек не ответил за отведённое время — ` +
            'вызов отклонён. Продолжайте другими средствами или попросите человека в окне.',
        }
      }
      await sleep(TICKET_POLL_MS)
    }
  } catch (err) {
    // ВНУТРИ настроенного гейта сломаться — значит отказать. Молчаливое «разрешаю» здесь
    // было бы ровно той дырой, ради которой всё остальное написано.
    return {
      ...base,
      configured: true,
      dangerous: true,
      decision: 'deny',
      waitedMs: clock() - startedAt,
      reason: `гейт сконфигурирован и сломался, поэтому вызов отклонён: ${String((err && err.message) || err)}`,
    }
  }
}
