/**
 * poll.mjs — THE TELEGRAM LINK: a long-polling loop that exists only when the owner has
 * connected a bot, and that carries the paired chat's words to the SAME brain the window talks
 * to — nothing more, and in particular nothing the window would not do.
 *
 * ═══════════════ WITHOUT A TOKEN THERE IS NO LOOP AT ALL ════════════════════════════
 * `createTelegramBridge` returns NULL for a config with no `telegram.botToken`. Not a loop
 * that idles, not a loop that polls and gets refused — nothing is constructed, no timer is
 * armed and no request is ever made, so a daemon that never heard of Telegram behaves exactly
 * as it did before this module existed. The decision has ONE owner (this factory), which is
 * why the composition root can be a single line and why the suite can assert the ABSENCE of
 * the loop rather than the value of a flag.
 *
 * ═══════════════ ONE BRAIN, AND THAT IS THE WHOLE POINT ═════════════════════════════
 * The owner's own words: «мозг должен быть идентичным — один в один как бы я писал в фронте».
 * So this module HAS no brain of its own and no read model of its own: it receives ONE
 * collaborator, `chatTurn`, which is the front door's own assembly (`runChatTurn` in
 * front/server.mjs) — the same engine, the same board snapshot, the same transcript directory,
 * the same free branch. A bot that computed its own answer to «сколько ждёт одобрения?» would
 * be a SECOND mind that agrees with the window until the day it does not, and the person would
 * have no way to tell which of the two lied. Nothing here reads the queue, the ledger or the
 * config's projects; ask the brain or say nothing.
 *
 * THE TRANSCRIPT IS SHARED, and follows from the same decision: the turn is written by the
 * engine into the daemon's own `historyDir`, so the «Разговор» screen reads a Telegram sentence
 * with the SAME `readHistory` it reads its own. The conversation id is kept HERE, in the loop's
 * closure, so a second message continues the thread instead of starting a stranger beside it.
 * It is hint plumbing, exactly like the chat-turn registry: a restart starts a new thread and
 * loses nothing but the thread — every turn of the old one is already on the book.
 *
 * ═══════════════ WHAT THE BRIDGE MAY NOT DO ════════════════════════════════════════
 * ЗАДАЧА СТАВИТСЯ СЛОВОМ, РЕШЕНИЕ — НЕТ, И РАЗНИЦА ЗДЕСЬ НАМЕРЕННАЯ. Кнопок в этом модуле
 * нет вовсе — телефон это место, где владелец идёт по улице, и «одобрено» не должно нажаться
 * по дороге. Но постановку задачи отсутствие кнопок отнимать не вправе: слово владельца —
 * «задачи с телефона ставим обязательно, они обязаны быть идентичными, это просто двери».
 * Поэтому черновик здесь называется вслух и ЖДЁТ СЛОВА: человек отвечает «да», и следующий
 * ход — обычный ход того же мозга — ставит задачу той же дверью, что и окно. Ни строки логики
 * согласия в этом модуле нет: он по-прежнему только возит слова туда и обратно.
 *
 * А ПРЕДЛОЖЕНИЕ РЕШЕНИЯ ОСТАЁТСЯ ФРАЗОЙ. Приёмка — рука человека в окне: здесь она не
 * получает ни кнопки, ни слова, и «да» её не заменяет (движок соглашением ставит задачу и
 * ничего не принимает). Бот называет задачу и говорит, где решают.
 *
 * A STRANGER NEVER CAUSES AN ACTION. Any chat that is not the paired one gets a single
 * sentence saying whose bot this is, and nothing else happens: the brain is not consulted, no
 * state moves, nothing is written down. The unpaired case is checked BEFORE the content is
 * looked at, so a photo from a stranger cannot even reach the «text only» branch.
 *
 * VOICE, PHOTOS AND DOCUMENTS ARE ANSWERED POLITELY AND DROPPED. The link understands text.
 * Saying so is better than silence: the owner learns the bot is alive and that this particular
 * thing is not built yet.
 *
 * ═══════════════ ЦИКЛ, КОТОРЫЙ НЕ ИМЕЕТ ПРАВА ВСТАТЬ ════════════════════════════════
 * Окно раздаёт тот же процесс, и тик конвейера идёт в том же процессе. Значит цикл опроса —
 * сосед двери и тика, и его беда становится их бедой. 29.08 это и случилось: журнал шёл стеной
 * «getUpdates: This operation was aborted», дверь висела при живом процессе, и оба штатных
 * стопа того дня сказали «дверь молчит, а процесс жив».
 *
 * Отсюда три обещания, и все три проверяются подделками, а не живой связью:
 *   1. У КРУГА ЕСТЬ ПОТОЛОК, свой собственный (`roundTimeoutMs`), а не только у клиента: клиент
 *      здесь внедряемый, и обещание не имеет права держаться на том, кем его подменили.
 *      Просроченный круг ОБРЫВАЮТ и бросают — «подождать ещё немного» и значит встать.
 *   2. ПАУЗА ПОСЛЕ ОТКАЗА РАСТЁТ до потолка, а не остаётся постоянной: отказ, который не
 *      проходит сам, иначе повторяется с той же частотой до утра.
 *   3. ОДИНАКОВЫЕ ОТКАЗЫ СХЛОПЫВАЮТСЯ в несколько строк со счётом. Шестьдесят одинаковых строк
 *      сообщают ровно столько же, сколько одна, и стоят журнала, в котором больше ничего не видно.
 *
 * ═══════════════ THE TOKEN, AGAIN, AT THE LOG ═══════════════════════════════════════
 * Every word this loop logs passes `redactBotToken` a second time. The client already reduces
 * everything it produces; this belt is here because a log line is assembled from more than one
 * error's words, and the cheapest place to be wrong about that is the place nobody re-reads.
 */

import {
  createTelegramClient,
  redactBotToken,
  TELEGRAM_CALL_TIMEOUT_MS,
  telegramBotToken,
  telegramChatId,
  telegramConfigured,
} from './client.mjs'
import { matchesPairingCode } from './pairing.mjs'

/** The one message a chat gets when its code was right: the pair is made, and it is named. */
export const PAIRED_REPLY = 'Готово — этот чат подключён к SMA. Дальше пишите сюда, окно покажет то же самое.'

/** The code was right and the daemon could not write the pair down. Said, never swallowed. */
export const PAIRING_FAILED_REPLY =
  'Код принят, но записать пару не удалось — повторите отправку кода, он ещё действует.'

/** Anybody else. One sentence, and nothing behind it. */
export const STRANGER_REPLY = 'Этот бот принадлежит владельцу SMA.'

/** The owner sent something that is not text. */
export const NON_TEXT_REPLY = 'Пока только текст — голос, фото и документы этот шаг ещё не понимает.'

/** A bridge nobody wired a brain into: honest about it, and it invents nothing in its place. */
export const NO_BRAIN_REPLY = 'Связь есть, но разговор к этому боту не подключён — он живёт в окне.'

/** The turn reached the engine and the engine could not finish. Said plainly, without detail. */
export const TURN_FAILED_REPLY = 'Не смог ответить на этот ход. Попробуйте ещё раз — разговор в окне работает.'

/** The engine answered with no words at all — vanishingly rare, and never silence on the phone. */
export const EMPTY_ANSWER_REPLY = 'Ответ пришёл пустым — повторите вопрос, пожалуйста.'

/**
 * Черновик на телефоне ждёт СЛОВА, а не кнопки: кнопок здесь нет и не будет, поэтому «да» —
 * единственный способ согласиться, и он же работает в окне. Фраза зовёт человека сказать это
 * слово, а не отсылает его к другому экрану, которого у него сейчас нет под рукой.
 */
export const DRAFT_NOTE = 'Пока не поставлено. Скажите «да» — и я поставлю отсюда.'

/** And a decision is the one thing a phone must never make by a tap on a notification. */
export const DECISION_NOTE = 'Решение принимается в окне — здесь кнопок нет.'

/** What Telegram accepts in ONE message. Longer answers are cut, never truncated. */
export const TELEGRAM_TEXT_LIMIT = 4096

/** How often «печатает…» may be repeated while a turn is thinking. Never more often than this. */
export const TYPING_INTERVAL_MS = 4000

/** How long the Bot API holds one poll open, in seconds. */
export const POLL_TIMEOUT_SECONDS = 25

/** How long the loop waits after the FIRST refused round before asking again. */
export const POLL_BACKOFF_MS = 5000

/**
 * И ДО КАКОЙ ПАУЗЫ ОНА ДОРАСТАЕТ, пока отказы идут подряд.
 *
 * ЗАМЕР 29.08: журнал демона шёл стеной «telegram getUpdates: This operation was aborted» —
 * строка за строкой, начиная сразу после «All systems green». Пауза была ПОСТОЯННОЙ, поэтому
 * отказ, который не проходит сам собой (сеть легла, токен отозвали, круг не укладывается в
 * срок), повторялся ровно с той же частотой хоть до утра: журнал становился стеной, в которой
 * не видно ничего другого, а цикл всё это время оставался занятым бесполезной работой.
 * Удвоение до потолка — тот же ответ, что у сторожа на неудавшийся подъём: повтор, который не
 * помог, не станет помогать чаще, если повторять его настойчивее.
 */
export const POLL_BACKOFF_MAX_MS = 60000

/**
 * ЖЁСТКИЙ ПОТОЛОК ОДНОГО КРУГА ОПРОСА — последний рубеж, за которым круг бросают.
 *
 * У клиента есть свой срок на вызов, и он честный. Но клиент здесь ВНЕДРЯЕМЫЙ, а обещание
 * «цикл не заклинит» не имеет права зависеть от того, кем его подменили: круг, который не
 * ответил вовсе, обязан кончиться и здесь. Потолок нарочно ВЫШЕ клиентского срока — иначе он
 * обрывал бы обычные долгие опросы вместо того, чтобы ловить заклинившие.
 */
export const POLL_ROUND_TIMEOUT_MS = POLL_TIMEOUT_SECONDS * 1000 + 2 * TELEGRAM_CALL_TIMEOUT_MS

/** Which updates are asked for at all — step one reads messages and nothing else. */
export const ALLOWED_UPDATES = Object.freeze(['message'])

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })

/**
 * splitForTelegram(text, limit) → the same words, in as few messages as the limit allows.
 *
 * WHY THE BOUNDARIES ARE CHOSEN IN THIS ORDER. An answer is prose: paragraphs first, because a
 * message that ends between two thoughts still reads like the answer it came from; then lines,
 * because a list cut mid-item reads like a broken list; and only then a hard cut, which is the
 * honest last resort for a single 5000-character paragraph nobody wrote by hand. NOTHING is
 * dropped at any level — the alternative to splitting is truncating, and an answer whose second
 * half was thrown away is worse than two messages.
 *
 * The chunks come back in READING ORDER and the caller sends them in that order: on a phone the
 * order of arrival IS the order of the text.
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
export function splitForTelegram(text, limit = TELEGRAM_TEXT_LIMIT) {
  const whole = String(text ?? '').trim()
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TELEGRAM_TEXT_LIMIT
  if (whole === '') return []
  if (whole.length <= cap) return [whole]
  return byParagraphs(whole, cap)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
}

/** Greedy packing of `parts` back into `glue`-joined chunks; whatever still overflows goes to `finer`. */
function pack(parts, glue, cap, finer) {
  const out = []
  let buf = ''
  for (const part of parts) {
    const joined = buf === '' ? part : `${buf}${glue}${part}`
    if (joined.length <= cap) {
      buf = joined
      continue
    }
    if (buf !== '') out.push(buf)
    buf = ''
    if (part.length <= cap) {
      buf = part
      continue
    }
    const pieces = finer(part, cap)
    out.push(...pieces.slice(0, -1))
    buf = pieces[pieces.length - 1] ?? ''
  }
  if (buf !== '') out.push(buf)
  return out
}

const byParagraphs = (text, cap) => pack(text.split(/\n{2,}/), '\n\n', cap, byLines)
const byLines = (text, cap) => pack(text.split('\n'), '\n', cap, byCharacters)

/** The last resort: a piece with no boundary inside it is cut where the limit falls. */
function byCharacters(text, cap) {
  const out = []
  for (let i = 0; i < text.length; i += cap) out.push(text.slice(i, i + cap))
  return out
}

/**
 * answerToText(answer) → what the phone is told, as PLAIN PROSE.
 *
 * The window renders an answer: buttons for a draft, buttons for a proposed decision, buttons
 * for the documents it names. None of that exists here, so the two that MATTER are said in
 * words, with the task named: черновик зовёт сказать «да» (постановка словом работает и
 * здесь, и в окне), предложение решения отсылает туда, где приёмку нажимают рукой. Silence
 * about them would be the worst of both: the bot would sound as if it had done something.
 *
 * @param {object} answer — the engine's answer, exactly as `handleChatTurn` returned it
 * @returns {string}
 */
export function answerToText(answer) {
  const a = answer && typeof answer === 'object' ? answer : {}
  const parts = []
  const said = typeof a.text === 'string' ? a.text.trim() : ''
  if (said !== '') parts.push(said)
  if (a.draft) parts.push(named(DRAFT_NOTE, a.draft.title))
  if (a.decision) parts.push(named(DECISION_NOTE, a.decision.title ?? a.decision.taskId))
  return parts.length ? parts.join('\n\n') : EMPTY_ANSWER_REPLY
}

/** «…в окне. Задача: «имя».» — a note that does not name its subject is a note about nothing. */
function named(note, title) {
  const name = typeof title === 'string' && title.trim() !== '' ? title.trim() : ''
  return name === '' ? note : `${note} Задача: «${name}».`
}

/**
 * createTelegramBridge({config, chatTurn, client, fetchImpl, log, sleep}) → the loop, or NULL.
 *
 * `chatTurn` is the ONE capability this loop has: `({text, conversationId}) → {conversationId,
 * answer}`, wired at the composition root to the front door's own `runChatTurn`. Absent, the
 * link still works and says so — it does not invent a smaller brain to stand in.
 *
 * @param {{config:object, chatTurn?:Function, client?:object, fetchImpl?:Function, log?:Function,
 *          sleep?:Function, onPaired?:Function, now?:Function}} o
 * @returns {null|{start:Function, stop:Function, pollOnce:Function, handleUpdate:Function, running:Function, offset:Function, conversationId:Function}}
 */
export function createTelegramBridge({
  config,
  chatTurn,
  client,
  fetchImpl,
  log = () => {},
  sleep = defaultSleep,
  // ПАЙРИНГ ИЗ ОКНА — два сотрудника, а не знание этого цикла: кто записывает пару и по
  // каким часам живёт код. Одноразовость и срок принадлежат тому, кто код выдал; цикл,
  // который держал бы о том же второе мнение, однажды разошёлся бы с ним.
  onPaired,
  now = Date.now,
  // Потолок одного круга — внедряем, потому что проверять его настоящими минутами нельзя.
  roundTimeoutMs = POLL_ROUND_TIMEOUT_MS,
} = {}) {
  if (!telegramConfigured(config)) return null

  const api = client ?? createTelegramClient({ config, fetchImpl })
  let offset = 0
  let running = false
  let loop = null
  let aborter = null
  // THE THREAD, and the only state this module keeps about a conversation: the id the engine
  // minted on the first turn, handed back on the next one. The turns themselves live on the
  // shared transcript, which is what the «Разговор» screen reads.
  let conversationId = null

  /** One line for the operator, with the credential reduced whatever it was assembled from. */
  const say = (line) => {
    try {
      log(redactBotToken(line, telegramBotToken(config)))
    } catch {
      /* a log that refuses never stops the link */
    }
  }

  /** An answer, and the honest note when even the answer could not be delivered. */
  async function reply(chatId, text) {
    try {
      await api.sendMessage({ chatId, text })
      return true
    } catch (err) {
      say(`telegram: не удалось ответить — ${(err && err.message) || err}`)
      return false
    }
  }

  /**
   * «…печатает» while the turn is thought about, and not one call more often than the limit.
   *
   * Telegram clears the status by itself after a few seconds, so a turn that takes longer than
   * one interval has to say it again — hence a timer rather than a single call. It is armed
   * AFTER the previous action settles, so a slow Bot API cannot stack a queue of them, and the
   * timer is unref'd: a courtesy must never be the reason a process refuses to exit.
   *
   * Returns the stopper. Every refusal is swallowed: the answer is the work, this is a hint.
   */
  function startTyping(chatId) {
    let alive = true
    let timer = null
    const beat = async () => {
      if (!alive) return
      try {
        await api.sendChatAction({ chatId, action: 'typing' })
      } catch {
        /* a status line that did not arrive never costs an answer */
      }
      if (!alive) return
      timer = setTimeout(beat, TYPING_INTERVAL_MS)
      if (timer && typeof timer.unref === 'function') timer.unref()
    }
    void beat()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Как назвать чат в записи пары: имя, которое дал телеграм, а не число. Пусто — это тоже
   * ответ: чат без имени останется числом, и это честнее выдуманного названия.
   */
  function chatName(chat) {
    if (!chat || typeof chat !== 'object') return ''
    const first = [chat.first_name, chat.last_name].filter((p) => typeof p === 'string' && p.trim() !== '').join(' ')
    for (const candidate of [chat.title, first, chat.username]) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    }
    return ''
  }

  /**
   * ЗАПИСАТЬ ПАРУ — и поверить только тому, кто её записал.
   *
   * Единственный путь от сообщения в телеграме к файлу конфига, и идёт он через того же
   * применителя, которым пользуется дверь окна. «Готово» над незаписанной парой — исход хуже
   * неудачного пайринга: человек перестаёт пробовать, а связи нет. Поэтому отказ говорится
   * отказом, а код остаётся непотраченным.
   */
  async function claimPair(chatId, chat) {
    if (typeof onPaired !== 'function') return false
    try {
      const written = await onPaired({ chatId: String(chatId), chatTitle: chatName(chat) })
      return written !== false
    } catch (err) {
      say(`telegram: пару записать не удалось — ${(err && err.message) || err}`)
      return false
    }
  }

  /**
   * ONE TURN OF THE OWNER'S CONVERSATION — asked of the engine, answered in the owner's chat.
   *
   * The engine is asked with the thread's id (or without one, on the first turn), and whatever
   * it minted becomes the thread from here on. Its refusal is a sentence to the owner and a
   * line in the log, never a dead loop: a turn that threw has still been read, and the offset
   * has already moved past it.
   */
  async function answerTurn(chatId, text) {
    if (typeof chatTurn !== 'function') {
      await reply(chatId, NO_BRAIN_REPLY)
      return { action: 'answered' }
    }
    const stopTyping = startTyping(chatId)
    let turn = null
    try {
      turn = await chatTurn({ text, ...(conversationId ? { conversationId } : {}) })
    } catch (err) {
      say(`telegram: ход разговора не прошёл — ${(err && err.message) || err}`)
    } finally {
      stopTyping()
    }
    if (!turn) {
      await reply(chatId, TURN_FAILED_REPLY)
      return { action: 'failed' }
    }
    if (turn.conversationId) conversationId = turn.conversationId
    // In order, and one refusal stops the rest: a second half that arrives without its first
    // half is not half an answer, it is a different answer.
    for (const chunk of splitForTelegram(answerToText(turn.answer))) {
      if (!(await reply(chatId, chunk))) break
    }
    return { action: 'answered' }
  }

  /**
   * handleUpdate(update) → {action}. The whole of the link's behaviour, in the order that
   * matters: is this a message at all, is it the owner's chat, is it text.
   *
   * `action` is returned for the suite and for the operator's sake; nothing in this module
   * branches on it.
   */
  async function handleUpdate(update) {
    const message = update && typeof update === 'object' ? update.message : null
    if (!message || !message.chat || message.chat.id === undefined || message.chat.id === null) {
      return { action: 'ignored' } // an update step one does not read — no answer, no action
    }
    const chatId = message.chat.id
    const paired = telegramChatId(config)
    if (paired === null || String(chatId) !== paired) {
      // THE STRANGER BRANCH, and it is the first one on purpose: nothing below this line may
      // run for a chat the owner has not paired. Одно-единственное, что незнакомому чату
      // разрешено, живёт ВНУТРИ этой ветки, а не рядом с ней: доказать себя кодом, который
      // владелец прямо сейчас видит в окне. Порядок и делает это безопасным — код вообще
      // рассматривается только у демона, чей конфиг пары ещё НЕ несёт, поэтому бота,
      // который уже кому-то принадлежит, угадыванием кода не отобрать.
      const sent = typeof message.text === 'string' ? message.text.trim() : ''
      if (paired === null && sent !== '' && matchesPairingCode(config, sent, now())) {
        if (await claimPair(chatId, message.chat)) {
          await reply(chatId, PAIRED_REPLY)
          return { action: 'paired' }
        }
        await reply(chatId, PAIRING_FAILED_REPLY)
        return { action: 'refused' }
      }
      await reply(chatId, STRANGER_REPLY)
      return { action: 'refused' }
    }
    const text = typeof message.text === 'string' ? message.text.trim() : ''
    if (text === '') {
      await reply(chatId, NON_TEXT_REPLY)
      return { action: 'non-text' }
    }
    return answerTurn(chatId, text)
  }

  /**
   * pollOnce() — one long poll and its answers. The offset is advanced for EVERY update that
   * carries an id, before the answer is attempted: an update that was read must not come back
   * because replying to it failed, or the loop would answer the same message forever.
   */
  async function pollOnce({ signal } = {}) {
    const updates = await api.getUpdates({
      ...(offset > 0 ? { offset } : {}),
      timeout: POLL_TIMEOUT_SECONDS,
      allowedUpdates: [...ALLOWED_UPDATES],
      ...(signal ? { signal } : {}),
    })
    const actions = []
    for (const update of updates) {
      const id = update && Number(update.update_id)
      if (Number.isFinite(id)) offset = Math.max(offset, id + 1)
      actions.push(await handleUpdate(update))
    }
    return actions
  }

  /**
   * ОДИН КРУГ ПОД ЖЁСТКИМ ПОТОЛКОМ. Проигравший гонку круг БРОСАЕТСЯ, а не дожидается: цикл,
   * который «ещё немного подождёт» зависший опрос, и есть цикл, который встал. Перед тем как
   * бросить, опрос обрывают явно — сокет, о котором забыли, живёт своей жизнью.
   */
  async function guardedRound() {
    let timer = null
    const round = pollOnce(aborter ? { signal: aborter.signal } : {})
    try {
      return await Promise.race([
        round,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            if (aborter) {
              try {
                aborter.abort()
              } catch {
                /* an abort that refuses never stops the loop */
              }
            }
            reject(new Error(`круг опроса не уложился в ${Math.round(roundTimeoutMs / 1000)} с`))
          }, roundTimeoutMs)
          if (timer && typeof timer.unref === 'function') timer.unref()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function run() {
    // ШТОРМ ОДИНАКОВЫХ ОТКАЗОВ СХЛОПЫВАЕТСЯ. Один и тот же отказ, повторённый шестьдесят раз,
    // сообщает ровно столько же, сколько один, — а стоит журнала, в котором больше ничего не
    // видно. Поэтому новый отказ говорится сразу, а повтор — только когда счёт УДВАИВАЕТСЯ:
    // 1, 2, 4, 8… Так шестьдесят четыре строки становятся семью, и ни один отказ не пропадает.
    let backoffMs = POLL_BACKOFF_MS
    let sameRefusal = ''
    let sameCount = 0
    let saidAt = 0

    const sayRefusal = (text) => {
      if (text !== sameRefusal) {
        sameRefusal = text
        sameCount = 1
        saidAt = 1
        say(`telegram: опрос не прошёл — ${text}`)
        return
      }
      sameCount += 1
      if (sameCount >= saidAt * 2) {
        saidAt = sameCount
        say(`telegram: тот же отказ опроса подряд ${sameCount} раз — ${text}`)
      }
    }

    while (running) {
      aborter = typeof AbortController === 'function' ? new AbortController() : null
      try {
        await guardedRound()
        // Круг прошёл — счёт отказов закрывается вслух, иначе последняя строка журнала о
        // телеграме навсегда осталась бы жалобой на связь, которая давно вернулась.
        if (sameCount > 0) say(`telegram: опрос снова проходит (отказов подряд было ${sameCount}).`)
        sameRefusal = ''
        sameCount = 0
        saidAt = 0
        backoffMs = POLL_BACKOFF_MS
      } catch (err) {
        // A stop aborts the poll in flight: that refusal is the shutdown working, not a fault.
        if (!running) break
        sayRefusal(String((err && err.message) || err))
        await sleep(backoffMs)
        backoffMs = Math.min(backoffMs * 2, POLL_BACKOFF_MAX_MS)
      } finally {
        aborter = null
      }
    }
    loop = null
  }

  return {
    /** Starts the loop and answers with the promise of its whole life (the suite awaits it). */
    start() {
      if (running) return loop
      running = true
      say('telegram: связь включена — бот слушает.')
      loop = run()
      return loop
    },
    /** Stops it, aborting the poll that is in flight so a shutdown does not wait out a long poll. */
    stop() {
      running = false
      if (aborter) {
        try {
          aborter.abort()
        } catch {
          /* an abort that refuses never stops a shutdown */
        }
      }
      return loop ?? Promise.resolve()
    },
    pollOnce,
    handleUpdate,
    running: () => running,
    offset: () => offset,
    /** The thread the phone is currently on — read by the suite, written by the engine. */
    conversationId: () => conversationId,
  }
}
