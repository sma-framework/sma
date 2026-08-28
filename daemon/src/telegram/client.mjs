/**
 * client.mjs — the minimal Telegram Bot API client: `getUpdates`, `sendMessage`,
 * `sendChatAction`, nothing else.
 *
 * WHAT IT IS. The owner creates their OWN bot in Telegram and connects it inside SMA; this
 * module is the one place in the product that speaks to `api.telegram.org`. It is deliberately
 * three methods wide — a link needs to receive a message, answer it, and say «печатает…» while
 * the answer is being thought of. Nothing else is added: every method here is a capability the
 * bridge can reach, and a bridge that cannot press a button cannot press one by accident.
 *
 * ═══════════════ THE TOKEN IS READ AT THE MOMENT OF THE CALL ════════════════════════
 * Nothing here captures the token at construction. `config.telegram.botToken` is read INSIDE
 * every call, so a token the owner changes (or removes) in the config file is a token that
 * takes effect on the next request rather than after a restart — and a client built for a
 * config that has since lost its token refuses honestly instead of calling with a stale one.
 *
 * ═══════════════ AND IT NEVER LEAVES THIS MODULE, IN ANY SHAPE ══════════════════════
 * A Bot API url carries the credential IN THE PATH: `https://api.telegram.org/bot<token>/…`.
 * That is not a detail — it means the ordinary, careful habits are not enough here: a fetch
 * failure quotes the url it failed on, an HTTP error quotes the request, and either one lands
 * in a log line or on a receipt with the whole credential inside it. So EVERY string this
 * module produces — every error message, every word handed to a caller — goes through
 * `redactBotToken` first, which collapses the credential to `bot[REDACTED]` by three
 * independent rules (the literal token, its secret half, and the shape of the url path
 * whatever token it carried). The original error object is never re-thrown and never attached
 * as a cause: it carries the url in its own message and stack, and an error nobody constructed
 * here is an error nobody masked here.
 *
 * Node built-ins only — `fetch` is the platform's, and it is injectable (`fetchImpl`) so the
 * suite drives a stand-in transport and never touches the real api.telegram.org.
 */

/** Where the Bot API lives. Injectable per client so a test can point somewhere that is not it. */
export const TELEGRAM_API_BASE = 'https://api.telegram.org'

/** What a credential looks like after this module is done with it. */
export const REDACTED_BOT_PATH = 'bot[REDACTED]'

/** How long one ordinary call may take before it is abandoned (a long poll names its own). */
export const TELEGRAM_CALL_TIMEOUT_MS = 20000

/** Named error for a call made with no token in the config — a refusal, never a call. */
export class TelegramTokenMissingError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TelegramTokenMissingError'
  }
}

/** Named error for anything the Bot API (or the transport under it) answered with. */
export class TelegramApiError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TelegramApiError'
  }
}

/**
 * redactBotToken(text, token) — the ONE reduction every outgoing string passes through.
 *
 * Three rules, because one is not enough on its own:
 *   1. the literal token, wherever it appears (a message that quotes only the credential);
 *   2. the SECRET HALF of `<id>:<secret>`, because a truncated url can carry the tail alone
 *      and a half-credential is still a credential;
 *   3. the SHAPE `/bot…` of the api path, whatever it carries — this one holds for a token
 *      that is not the one this process knows about (a stale error, a second bot, a typo).
 * Rule 3 runs last and is idempotent, so a string already reduced by rule 1 stays exactly
 * `bot[REDACTED]` rather than growing a second layer of markers.
 *
 * @param {unknown} text
 * @param {string|null|undefined} token
 * @returns {string}
 */
export function redactBotToken(text, token) {
  let out = String(text ?? '')
  const raw = typeof token === 'string' ? token.trim() : ''
  if (raw !== '') {
    out = out.split(raw).join(REDACTED_BOT_PATH)
    const secret = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : ''
    // A very short tail is not a credential, and replacing by it would eat ordinary text.
    if (secret.length >= 8) out = out.split(secret).join(REDACTED_BOT_PATH)
  }
  return out.replace(/\/bot[^/\s'"]+/g, `/${REDACTED_BOT_PATH}`)
}

/**
 * telegramBotToken(config) → the token as a non-empty string, or null.
 *
 * THE SINGLE READER of that field. Everything that asks «is Telegram connected at all» asks
 * this, so «connected» has one definition and cannot drift between the client, the polling
 * loop and the composition root.
 */
export function telegramBotToken(config) {
  const raw = config && config.telegram ? config.telegram.botToken : undefined
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
}

/** telegramChatId(config) → the paired chat as a STRING (ids are compared, never arithmetic), or null. */
export function telegramChatId(config) {
  const raw = config && config.telegram ? config.telegram.chatId : undefined
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
}

/** telegramConfigured(config) — the predicate the daemon gates the whole bridge on. */
export function telegramConfigured(config) {
  return telegramBotToken(config) !== null
}

/**
 * telegramApiBase(config) → куда стучаться. По умолчанию — настоящий Bot API.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ ЧИТАЕТСЯ ИЗ КОНФИГА. Отправку, которая доказывается, нельзя доказать
 * подделкой функции: живой прогон падения демона обязан прогнать НАСТОЯЩИЙ `sendMessage`
 * через настоящий сокет и посмотреть на времена, — но слать при этом учебные сообщения в
 * чат владельца было бы наглостью. Один шов решает оба: адрес назначения объявляется в
 * конфиге прогона, а код отправки остаётся тем же самым, вплоть до заголовков.
 *
 * ЭТО НЕ ОСЛАБЛЕНИЕ. Токен всё так же читается в момент вызова и всё так же не покидает
 * модуль ни в одной строке: `redactBotToken` работает по ФОРМЕ пути `/bot…`, какой бы хост
 * перед ним ни стоял. Пустое или нестроковое значение — это отсутствие мнения, а не адрес:
 * тогда действует настоящий Bot API.
 */
export function telegramApiBase(config) {
  const raw = config && config.telegram ? config.telegram.apiBase : undefined
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim().replace(/\/+$/, '') : TELEGRAM_API_BASE
}

/**
 * A deadline for one request: this module's own timer, plus the caller's signal when it has
 * one. Both abort the SAME controller, so the transport sees a single signal and the caller
 * (the polling loop, stopping) does not have to know about the timer.
 */
function withDeadline({ signal, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (timer && typeof timer.unref === 'function') timer.unref()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * createTelegramClient({config, fetchImpl, apiBase}) → {sendMessage, getUpdates}.
 *
 * `config` is the LIVE daemon config object, not a copy of its token: see the header.
 *
 * @param {{config:object, fetchImpl?:Function, apiBase?:string}} o
 */
export function createTelegramClient({ config, fetchImpl, apiBase = TELEGRAM_API_BASE } = {}) {
  /**
   * One Bot API method. Everything that could carry the credential is reduced before it is
   * put into an error, and no error from below is re-thrown as it arrived.
   */
  async function call(method, payload, { signal, timeoutMs = TELEGRAM_CALL_TIMEOUT_MS } = {}) {
    const token = telegramBotToken(config)
    if (!token) {
      // The message names the FIELD, never a value: this is the one branch where the config
      // is known to be wrong, and quoting what it held would defeat the whole module.
      throw new TelegramTokenMissingError('telegram: config.telegram.botToken is not set — no call was made')
    }
    const safe = (text) => redactBotToken(text, token)
    const doFetch = fetchImpl ?? globalThis.fetch
    if (typeof doFetch !== 'function') throw new TelegramApiError('telegram: no fetch implementation is available')
    const url = `${apiBase}/bot${token}/${method}`
    const deadline = withDeadline({ signal, timeoutMs })

    let res
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: deadline.signal,
      })
    } catch (err) {
      // The transport quotes the url it failed on — this is the line that would otherwise
      // write the owner's credential into the daemon log.
      throw new TelegramApiError(`telegram ${method}: ${safe((err && err.message) || err)}`)
    } finally {
      deadline.done()
    }

    let body = null
    try {
      body = await res.json()
    } catch {
      body = null // a non-JSON answer is still an answer; the status below is what names it
    }
    if (!res || res.ok !== true) {
      const detail = body && body.description ? `: ${safe(body.description)}` : ''
      throw new TelegramApiError(`telegram ${method} answered HTTP ${(res && res.status) ?? '?'}${detail}`)
    }
    if (!body || body.ok !== true) {
      const detail = body && body.description ? safe(body.description) : 'the answer carried no result'
      throw new TelegramApiError(`telegram ${method} refused: ${detail}`)
    }
    return body.result
  }

  return {
    /**
     * sendMessage — PLAIN TEXT, always. No `parse_mode` is sent and none may be added: an
     * answer written by a model carries underscores, asterisks and square brackets as ordinary
     * punctuation, and asking Telegram to read them as markup turns an honest sentence into an
     * HTTP 400 («can't parse entities») — which is to say, into silence. Plain text cannot fail
     * that way, and the words arrive exactly as the window shows them.
     */
    async sendMessage({ chatId, text, signal } = {}) {
      return call('sendMessage', { chat_id: chatId, text: String(text ?? '') }, { signal })
    },
    /**
     * sendChatAction — the «…печатает» line in the chat. It is a COURTESY, never a step: the
     * caller ignores its result and its refusals, because an answer that arrives is worth more
     * than a status line that did not.
     */
    async sendChatAction({ chatId, action = 'typing', signal } = {}) {
      return call('sendChatAction', { chat_id: chatId, action: String(action) }, { signal })
    },
    /**
     * getUpdates — long polling. `timeout` is the SERVER's hold, in seconds; the client's own
     * deadline is that plus a margin, so an ordinary empty poll is never mistaken for a hang.
     */
    async getUpdates({ offset, timeout = 0, allowedUpdates, signal } = {}) {
      const result = await call(
        'getUpdates',
        {
          ...(Number.isFinite(offset) ? { offset } : {}),
          timeout,
          ...(Array.isArray(allowedUpdates) ? { allowed_updates: allowedUpdates } : {}),
        },
        { signal, timeoutMs: Math.max(TELEGRAM_CALL_TIMEOUT_MS, (Number(timeout) || 0) * 1000 + TELEGRAM_CALL_TIMEOUT_MS) },
      )
      return Array.isArray(result) ? result : []
    },
  }
}
