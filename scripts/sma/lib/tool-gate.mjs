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
 * ═══════════════ WHY THE DECISION'S FORM IS NOT DECLARED IN THIS FILE ════════════
 * The button in the window builds the decision string and this hook reads it, from two
 * different processes — one of them a browser bundle where `node:fs` does not exist. An
 * agreement between two sides that is written down twice is an agreement that will drift.
 * So the form, its producer and its parser live in `tool-decision.mjs`, which imports
 * nothing at all and is imported by BOTH sides; this module re-exports them so a caller
 * holding the gate needs no second import. A look-alike is not a decision: a correction
 * that merely mentions a ticket id releases nothing and goes on to the worker.
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
 * ═══════════════ AND NOW ALSO THE POSTMAN: A WORD FOR THE TURN IN FLIGHT ════════
 * The same hook stands before EVERY tool call of the worker's session, which makes it the
 * only place in this product that can reach a turn already running. So it carries a second
 * errand beside the parking ticket: a person typing «нет, не так» into a busy task can now
 * choose a fate that kills nobody. That word is stored as one more line in the task's
 * correction file — the file this hook already holds a path to — and this module hands it
 * over as `additionalContext` in the very same answer that lets the call through. The turn
 * keeps everything it was holding in its head; nothing restarts.
 *
 * THE LIMIT IS NAMED, NOT HIDDEN: delivery happens ONLY at a tool-call boundary. A turn that
 * makes no further tool calls will not see the word before it ends — the continuation loop
 * then collects it on the way out, because an unconsumed line stays pending. The three fates
 * add up rather than compete, which is the whole reason this costs one field and not a channel.
 *
 * ON A REFUSAL THE WORD DOES NOT TRAVEL. It rides `allow` and only `allow`: a call the person
 * refused, or one whose deadline expired, is not a delivery boundary, and a word handed over
 * beside a refusal would arrive attached to the wrong sentence. Left unconsumed it is DELAYED,
 * never lost — the next boundary or the continuation loop takes it.
 *
 * THE HARVEST IS A POSTMAN, NOT A GUARD, AND ITS BREAKAGE DOES NOT CHANGE A VERDICT. The
 * corrections module declares its own posture — «an unreadable store loses only unconsumed
 * corrections, never wedges a tick» — and this module mirrors that rule rather than inventing
 * a second one: a correction file that cannot be read or marked leaves the word pending and
 * the call's decision exactly as the classifier and the person made it. Fail-closed still
 * governs the TICKET, which is what safety hangs on.
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
// THE FORM OF A DECISION comes from the one file both sides import — the window's bundle and
// this hook. Re-exported here so a caller that already holds the gate needs no second import,
// and so `TICKET_DECISION_FORM` names the same string in both processes by construction.
import { parseDecision } from './tool-decision.mjs'
import { readPendingRedirectsFile, markConsumedFile, correctionsPreamble } from '../../../daemon/src/runner/redirects.mjs'

export { formatDecision, parseDecision, TICKET_DECISION_FORM, TICKET_DECISION_PREFIX } from './tool-decision.mjs'

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

/** Что отвечает хук, когда каталога попытки нет вовсе. Одно место, одни слова. */
export const GATE_NOT_CONFIGURED = 'гейт не сконфигурирован'

/** Каталог билетов внутри каталога попытки — вложенный, чтобы не мешать четырём файлам. */
export const TICKETS_DIRNAME = 'tickets'

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
 * ticketIdFor({attemptId, tool, input}) → `tk-<16 hex>`.
 *
 * THE ARGUMENTS ARE IN THE ID. Approving one command therefore does not open another:
 * the same call asks for the same ticket, and a call with different arguments asks for
 * a new one. The attempt id is in the fingerprint too — an approval does not survive
 * into the next attempt, where the context that justified it no longer exists.
 */
export function ticketIdFor({ attemptId, tool, input } = {}) {
  const material = `${String(attemptId ?? '')}\u0000${String(tool ?? '')}\u0000${stableJson(input ?? null)}`
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
 * readWaitingTicket({runDir, clock, fsImpl}) → the ticket a person is being waited on for, or
 * null. Read by the card door as well as by the suite, so «ждут вас» on the screen and
 * the file the hook is standing over are the same object and cannot disagree.
 *
 * A TICKET WHOSE DEADLINE HAS PASSED IS NOT «ЖДУТ ВАС». Three paths close a ticket — approval,
 * refusal, and its own deadline — and ALL THREE are written by the hook's process. Kill that
 * process and the file stays `waiting` for ever: the card then tells a person he is being
 * waited on for a call that no longer exists, and he presses «Одобрить» into nothing. The card
 * asks this question only of a row that is still CLAIMED, which is exactly the state a dead
 * process leaves behind.
 *
 * THE READER DOES NOT INVENT A VERDICT — it stops ignoring one. The deadline in the file was
 * written by the WRITER, at the moment it started waiting, and it is the same number the hook
 * would have refused on had it lived. So this is a read of a recorded fact, not a rule invented
 * on the reading side (which is what the «инварианты ставятся на записи» law forbids).
 *
 * A ticket with NO deadline, or one whose deadline cannot be read, is left alone: «not
 * understood» is not «expired», and an old-format file must not disappear from a person's
 * screen because a field was added after it was written.
 */
export function readWaitingTicket({ runDir, clock = Date.now, fsImpl } = {}) {
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
    if (isPastDeadline(row, clock)) continue // срок записал писатель — читатель перестаёт его игнорировать
    if (!newest || String(row.seenAt ?? '') > String(newest.seenAt ?? '')) newest = row
  }
  return newest
}

/** Прошёл ли записанный писателем срок билета. Нечитаемый или отсутствующий срок — «не знаем». */
function isPastDeadline(row, clock) {
  const at = Date.parse(String((row && row.deadlineAt) ?? ''))
  if (!Number.isFinite(at)) return false
  const now = typeof clock === 'function' ? Number(clock()) : Number(clock)
  return Number.isFinite(now) && now >= at
}

/** Что написано в закрытом вместе с попыткой билете — одни слова, в одном месте. */
export const TICKET_CLOSED_WITH_ATTEMPT =
  'попытка завершилась, никто больше не ждёт ответа по этому билету'

/**
 * closeWaitingTickets({runDir, reason, clock, fsImpl}) → сколько билетов помечено.
 *
 * ВТОРОЙ КОНЕЦ ЛЕЧЕНИЯ ОСИРОТЕВШЕГО БИЛЕТА. Фильтр у читателя выше лечит файлы, которые УЖЕ
 * лежат на диске; эта функция лечит будущие — завершение попытки помечает оставшиеся
 * ожидающие билеты её каталога закрытыми ВМЕСТЕ С ПОПЫТКОЙ, с причиной словами. Один конец без
 * другого оставляет половину: без читателя лежащие сейчас файлы врут вечно, без писателя
 * каждый новый билет врёт ровно до своего срока.
 *
 * РЕШЁННОЕ ЧЕЛОВЕКОМ НЕ ПЕРЕПИСЫВАЕТСЯ. Трогаются только `waiting`: одобрение и отказ — это
 * запись о том, что человек сделал, и переписать её значило бы стереть его след.
 *
 * FAIL-OPEN ЦЕЛИКОМ: нет каталога, нечитаемый каталог, порванный или незаписываемый билет —
 * это «нечего помечать», и никогда не ошибка попытки. Попытка не имеет права провалиться
 * из-за уборки за собой.
 */
export function closeWaitingTickets({ runDir, reason = TICKET_CLOSED_WITH_ATTEMPT, clock = Date.now, fsImpl } = {}) {
  const io = resolveIo(fsImpl)
  const dir = ticketsDirOf(runDir)
  if (!runDir || !io.existsSync(dir)) return 0
  let names = []
  try {
    names = io.readdirSync(dir)
  } catch {
    return 0
  }
  let closed = 0
  for (const name of names) {
    if (!String(name).endsWith('.json')) continue
    const path = join(dir, String(name))
    let row = null
    try {
      row = JSON.parse(String(io.readFileSync(path, 'utf8')))
    } catch {
      continue // порванный билет пропускается, остальные всё ещё помечаются
    }
    if (!row || row.status !== 'waiting') continue
    try {
      writeTicket(io, path, {
        ...row,
        status: 'closed',
        decidedAt: new Date(typeof clock === 'function' ? clock() : Date.now()).toISOString(),
        decidedBy: 'attempt-end',
        reason: String(reason),
      })
      closed += 1
    } catch {
      /* билет, который не записался, — не причина провалить попытку */
    }
  }
  return closed
}

/**
 * hookResponseFor({decision, reason, steerTexts}) → the object the harness reads.
 *
 * The shape is not guessed: a live probe of this vendor version answered a `deny` in
 * this shape with `is_error=true` on the tool result AND put the call into
 * `result.permission_denials` with its tool name and command — which is exactly the
 * evidence a person needs afterwards to see what the worker was not allowed to do.
 *
 * `additionalContext` was proved by a live probe too, and the same way — a real session of
 * this CLI, one tool call, one stub hook. The stream answered `hook_response … outcome
 * success`, the model's own reasoning said it had received additional context from a hook,
 * and its final message quoted the word back verbatim, all under ONE session id. So the
 * carrier below is a measured fact rather than a reading of the vendor's documentation.
 *
 * THE SHAPE WITHOUT A WORD IS BYTE FOR BYTE THE OLD ONE. The key appears only when there is
 * something to say: a hook that always emitted an empty extra field would change the answer
 * every existing reader parses, in exchange for nothing.
 *
 * The WORDING is not built here. `correctionsPreamble` belongs to the module that owns what a
 * correction IS, and it is the same sentence the continuation loop puts a resumed session
 * under — one sentence minted once, so the founder is not quoted differently depending on
 * which road his word took.
 */
export function hookResponseFor({ decision, reason, steerTexts } = {}) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision === 'allow' ? 'allow' : 'deny',
      permissionDecisionReason: String(reason ?? ''),
    },
  }
  const words = (Array.isArray(steerTexts) ? steerTexts : []).filter((t) => String(t ?? '').trim() !== '')
  if (words.length > 0) {
    out.hookSpecificOutput.additionalContext = correctionsPreamble(words.map((text) => ({ text })))
  }
  return out
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
 * harvestSteerTexts(file, fsImpl, clock) → the words meant for the turn running RIGHT NOW,
 * marked consumed on the way out. Never throws.
 *
 * WHAT IT TAKES, AND WHAT IT REFUSES TO TAKE:
 *   - only lines of the THIRD fate (`steer`). «Перебить» and «в очередь» are somebody else's
 *     errand — the loop kills or resumes on them — and a postman that ate them would make the
 *     founder's word vanish between two mechanisms that each thought the other had it;
 *   - and only lines that are NOT a ticket decision. A decision string belongs to the ticket
 *     and to nothing else, even when a wrong fate was picked for it in the window: it is read
 *     by the parked call above, and eating it here would leave a person pressing «Одобрить»
 *     into nothing. So the parser judges, not the mode field alone.
 *
 * NO PATH, NO DISK. An empty file name returns immediately — the hook rides in a settings file
 * shared by the whole machine, and a session that has no correction file must not pay for a
 * read it can never need. Same discipline as `decisionFromRedirects` above.
 *
 * ITS OWN BREAKAGE IS NOT A REFUSAL. The corrections module declares that an unreadable store
 * «loses only unconsumed corrections, never wedges a tick»; this mirrors that rule instead of
 * inventing a second one. A read that throws yields no word and no change of verdict; a mark
 * that throws still hands the word over — arriving twice is a nuisance, arriving never is the
 * broken promise this whole store was built to keep.
 */
function harvestSteerTexts(file, fsImpl, clock) {
  if (!file) return []
  let pending = []
  try {
    pending = readPendingRedirectsFile({ file, fsImpl })
  } catch {
    return [] // непрочитанное хранилище — это «слова нет», и никогда не отказ по вызову
  }
  const picked = []
  for (const row of pending) {
    if (!row || row.mode !== 'steer') continue
    if (parseDecision(row.text)) continue // это решение по билету — оно чужое, не трогаем
    const text = String(row.text ?? '').trim()
    if (text === '') continue
    picked.push({ id: row.id, text })
  }
  if (picked.length === 0) return []
  try {
    markConsumedFile({ file, ids: picked.map((r) => r.id), clock, fsImpl })
  } catch {
    /* непомеченное слово доедет ещё раз — это лучше, чем не доехать ни разу */
  }
  return picked.map((r) => r.text)
}

/**
 * decideOnEvent({event, env, clock, sleep, fsImpl}) → the verdict, as data.
 *
 * `steerTexts` is ALWAYS present and empty by default — the words this boundary picked up for
 * the turn in flight. It is filled on the two paths that let a call through INSIDE a
 * configured attempt, and on those only: the classifier's «not dangerous» and the person's
 * «одобрено». The early allow of a session that has no attempt directory of ours never looks
 * (there is nothing of ours to read there, and it is somebody else's work), and a refusal
 * never harvests — see the header: on a refusal the word waits rather than travels.
 *
 * @returns {Promise<{decision:'allow'|'deny', reason:string, configured:boolean,
 *                    dangerous:boolean, ticketId:(string|null),
 *                    decidedBy:(string|null), waitedMs:number, steerTexts:string[]}>}
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
  const base = { configured: false, dangerous: false, ticketId: null, decidedBy: null, waitedMs: 0, steerTexts: [] }

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
    // ПУТЬ К ПЕРЕПИСКЕ читается здесь, а не у самого билета: с этой волны он нужен обеим
    // разрешающим дорогам, а не только парковке.
    const redirectsFile = typeof (env && env.SMA_REDIRECTS_FILE) === 'string' ? env.SMA_REDIRECTS_FILE.trim() : ''
    const verdict = classifyForWorker(tool, input, { copyRoot: cwd })
    if (!verdict.dangerous) {
      // ГРАНИЦА ВЫЗОВА — ЭТО И ЕСТЬ ПОЧТА. Обычный безобидный вызов и есть тот момент, когда
      // идущий ход можно догнать словом, никого не убивая; других моментов у нас нет.
      return {
        ...base,
        configured: true,
        decision: 'allow',
        reason: 'не опасно по классификатору работника',
        steerTexts: harvestSteerTexts(redirectsFile, fsImpl, clock),
      }
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
          // ЖНЁМ ТОЛЬКО НА «ОДОБРЕНО». Отпущенный вызов — такая же граница, как безобидный, и
          // слово, лежавшее в той же переписке, едет вместе с ним. На отказе человека слово
          // НЕ трогаем: строка остаётся ждущей и доедет на следующей границе либо
          // продолжением после выхода — непотреблённое слово отложено, а не потеряно.
          steerTexts: found.decision === 'approve' ? harvestSteerTexts(redirectsFile, fsImpl, clock) : [],
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
          steerTexts: [], // истёкший срок — отказ, а отказ не почта: слово ждёт следующей границы
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
