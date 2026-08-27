/**
 * poll.mjs — THE TELEGRAM LINK, STEP ONE: a long-polling loop that exists only when the owner
 * has connected a bot, and that can do exactly one thing — answer.
 *
 * ═══════════════ WITHOUT A TOKEN THERE IS NO LOOP AT ALL ════════════════════════════
 * `createTelegramBridge` returns NULL for a config with no `telegram.botToken`. Not a loop
 * that idles, not a loop that polls and gets refused — nothing is constructed, no timer is
 * armed and no request is ever made, so a daemon that never heard of Telegram behaves exactly
 * as it did before this module existed. The decision has ONE owner (this factory), which is
 * why the composition root can be a single line and why the suite can assert the ABSENCE of
 * the loop rather than the value of a flag.
 *
 * ═══════════════ WHAT STEP ONE IS, AND WHAT IT IS NOT ═══════════════════════════════
 * It is a LINK. Text from the paired chat gets one honest sentence back: the connection is
 * alive, and the brain arrives in a later step. That is the whole behaviour, and the reason
 * it is worth shipping on its own is that everything expensive about a bridge — the token
 * never leaking, a stranger never reaching anything, the loop not existing when it was not
 * asked for — is decided HERE, before there is anything behind it worth reaching.
 *
 * A STRANGER NEVER CAUSES AN ACTION. Any chat that is not the paired one gets a single
 * sentence saying whose bot this is, and nothing else happens: no state moves, no offset
 * decision is taken on its behalf, nothing is written down. The unpaired case is checked
 * BEFORE the content is looked at, so a photo from a stranger cannot even reach the
 * «text only» branch.
 *
 * ═══════════════ STEP TWO: THE CHAT PROVES ITSELF, AND NOBODY OPENS A FILE ══════════
 * There is now exactly ONE thing an unpaired chat may do, and it lives inside the stranger
 * branch rather than beside it: send back the PAIRING CODE the owner is looking at in the
 * window. The order is what makes that safe — the code is only ever considered for a daemon
 * whose config carries NO pair yet (`paired === null`), so a bot that already belongs to a
 * chat cannot be taken over by anybody who guesses a code, and a chat that gets the code
 * wrong is refused with the same sentence every other stranger gets.
 *
 * WRITING THE PAIR DOWN IS SOMEBODY ELSE'S JOB. This loop calls `onPaired` — the collaborator
 * the composition root wires to the config applier — and believes nothing until it answers.
 * A refusal is told to the chat as a refusal: a «готово» over a link that was not persisted
 * is the one outcome worse than a failed pairing, because the person stops trying.
 *
 * The code is one-time and time-limited, and NEITHER property is enforced here: both live in
 * pairing.mjs and in the applier that spends the code by removing it. A loop that also kept a
 * «used» flag would be a second opinion about the same fact.
 *
 * VOICE, PHOTOS AND DOCUMENTS ARE ANSWERED POLITELY AND DROPPED. Step one understands text.
 * Saying so is better than silence: the owner learns the bot is alive and that this particular
 * thing is not built yet.
 *
 * ═══════════════ THE TOKEN, AGAIN, AT THE LOG ═══════════════════════════════════════
 * Every word this loop logs passes `redactBotToken` a second time. The client already reduces
 * everything it produces; this belt is here because a log line is assembled from more than one
 * error's words, and the cheapest place to be wrong about that is the place nobody re-reads.
 */

import {
  createTelegramClient,
  redactBotToken,
  telegramBotToken,
  telegramChatId,
  telegramConfigured,
} from './client.mjs'
import { matchesPairingCode } from './pairing.mjs'

/** The paired owner's answer at step one — the link, said plainly, with the next step named. */
export const LINK_REPLY = 'Связь есть. Мозг подключается следующим шагом — пока решения и разговор в окне.'

/** The one message a chat gets when its code was right: the pair is made, and it is named. */
export const PAIRED_REPLY = 'Готово — этот чат подключён к SMA. Дальше пишите сюда, окно покажет то же самое.'

/** Anybody else. One sentence, and nothing behind it. */
export const STRANGER_REPLY = 'Этот бот принадлежит владельцу SMA.'

/** The owner sent something that is not text. */
export const NON_TEXT_REPLY = 'Пока только текст — голос, фото и документы этот шаг ещё не понимает.'

/** The code was right and the daemon could not write the pair down. Said, never swallowed. */
export const PAIRING_FAILED_REPLY =
  'Код принят, но записать пару не удалось — повторите отправку кода, он ещё действует.'

/** How long the Bot API holds one poll open, in seconds. */
export const POLL_TIMEOUT_SECONDS = 25

/** How long the loop waits after a refused round before asking again. */
export const POLL_BACKOFF_MS = 5000

/** Which updates are asked for at all — step one reads messages and nothing else. */
export const ALLOWED_UPDATES = Object.freeze(['message'])

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })

/**
 * createTelegramBridge({config, client, fetchImpl, log, sleep}) → the loop, or NULL.
 *
 * @param {{config:object, client?:object, fetchImpl?:Function, log?:Function, sleep?:Function}} o
 * @returns {null|{start:Function, stop:Function, pollOnce:Function, handleUpdate:Function, running:Function, offset:Function}}
 */
export function createTelegramBridge({
  config,
  client,
  fetchImpl,
  log = () => {},
  sleep = defaultSleep,
  onPaired,
  now = Date.now,
} = {}) {
  if (!telegramConfigured(config)) return null

  const api = client ?? createTelegramClient({ config, fetchImpl })
  let offset = 0
  let running = false
  let loop = null
  let aborter = null

  /** One line for the operator, with the credential reduced whatever it was assembled from. */
  const say = (line) => {
    try {
      log(redactBotToken(line, telegramBotToken(config)))
    } catch {
      /* a log that refuses never stops the link */
    }
  }

  /**
   * chatName(chat) — what to CALL this chat on the screen, or ''.
   *
   * A person recognises «Мария» and «Стройка — прораб»; nobody recognises `-1001234567890`.
   * Telegram names a group with `title` and a private chat with a first/last name or a
   * @username, so all three are read here and the first one that exists wins. A chat Telegram
   * named nothing gets no name at all — the window then shows the number, which is honest,
   * rather than a word this module invented.
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
   * claimPair(chatId, chat) → did the pair get WRITTEN DOWN?
   *
   * The loop does not touch the config file itself: it hands the fact to the collaborator the
   * composition root wired (`onPaired`), which is the one place that persists and refreshes
   * the in-process config. A bridge built with no such collaborator — every unit test of the
   * loop — cannot pair at all, which is the correct answer for a loop nobody gave a writer to.
   *
   * A refusal is REPORTED, never swallowed into a false «готово»: the caller keeps the chat a
   * stranger and the code unspent.
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
   * handleUpdate(update) → {action}. The whole of step one's behaviour, in the order that
   * matters: is this a message at all, is it the owner's chat, is it text.
   *
   * `action` is returned for the suite and for a later step that will want to know what
   * happened; nothing in this module branches on it.
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
      // run for a chat the owner has not paired. The ONE thing an unpaired chat may do is
      // prove itself with the code the owner is looking at in the window right now.
      const sent = typeof message.text === 'string' ? message.text.trim() : ''
      if (paired === null && sent !== '' && matchesPairingCode(config, sent, now())) {
        if (await claimPair(chatId, message.chat)) {
          await reply(chatId, PAIRED_REPLY)
          return { action: 'paired' }
        }
        // The code was right and the pair could NOT be written down. Saying «готово» here
        // would promise a link this daemon does not have, so the chat is told the truth and
        // stays a stranger — the code is untouched and the next message can pair for real.
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
    await reply(chatId, LINK_REPLY)
    return { action: 'answered' }
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

  async function run() {
    while (running) {
      aborter = typeof AbortController === 'function' ? new AbortController() : null
      try {
        await pollOnce(aborter ? { signal: aborter.signal } : {})
      } catch (err) {
        // A stop aborts the poll in flight: that refusal is the shutdown working, not a fault.
        if (!running) break
        say(`telegram: опрос не прошёл — ${(err && err.message) || err}`)
        await sleep(POLL_BACKOFF_MS)
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
  }
}
