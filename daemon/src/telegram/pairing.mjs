/**
 * pairing.mjs — THE PAIRING CODE, and the one shape the window is told about a link.
 *
 * WHAT IT IS FOR. Step one of the bridge learned WHICH chat belongs to the owner by reading
 * `telegram.chatId` out of the config file — a number a person had to find, by hand, in a
 * file. That is enough for the one person who wrote the daemon and is not enough for anybody
 * else: an owner who installed SMA must be able to connect a bot from the window, and a
 * numeric chat id is not something a window can ask for. So the direction is reversed. The
 * window mints a SHORT CODE, the person sends that code to their own bot, and the bot writes
 * the chat down itself. Nobody opens a file.
 *
 * ═══════════════ THE CODE IS ONE-TIME AND IT DIES ON ITS OWN ════════════════════════
 * A pairing code is a bearer credential for exactly one act — «this chat is the owner's» —
 * so it carries the two properties that act needs and no others:
 *   - IT EXPIRES. `PAIRING_TTL_MS` from the minute it was minted, checked against a clock the
 *     caller passes in, never against a stored «is it still valid» flag. An expired code is
 *     not a code: `matchesPairingCode` refuses it before it compares anything.
 *   - IT IS SPENT ON USE. The pairing block is REMOVED from the config the moment a chat is
 *     written down (applyTelegramPair), so the second message carrying the same code arrives
 *     at a daemon that has no pairing at all and is refused as an ordinary stranger. Being
 *     one-time is therefore a property of the STATE, not a counter somebody has to maintain.
 *
 * THE ALPHABET HAS NO LOOK-ALIKES. `0/O` and `1/I` are not in it, because this code is read
 * off one screen and typed into another by a human; a code that pairs on the third attempt
 * teaches its owner that the window is broken.
 *
 * ═══════════════ THE TOKEN IS NEVER PART OF THE VIEW ════════════════════════════════
 * `telegramLinkView` is the ONLY shape of the link that leaves the daemon, and the bot token
 * appears in it as four characters — the tail, so a person can tell WHICH bot is connected —
 * and in no other form. There is no branch, no flag and no query parameter that makes it
 * return more: the whole value never enters the object in the first place.
 *
 * Node built-ins only (randomBytes). The clock and the randomness are injectable so the suite
 * drives expiry and minting without waiting and without guessing.
 */

import { randomBytes as cryptoRandomBytes } from 'node:crypto'

import { telegramBotToken, telegramChatId } from './client.mjs'

/** How long one pairing code lives. Ten minutes: long enough to find the chat, short enough. */
export const PAIRING_TTL_MS = 10 * 60 * 1000

/** No `0`, `O`, `1`, `I` — a human reads this off a screen and types it into a phone. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Eight characters, shown as two groups of four. 32^8 ≈ 10^12 for a ten-minute window. */
export const PAIRING_CODE_LENGTH = 8

/** How many characters of the token the window may see — enough to recognise, never to use. */
export const TOKEN_TAIL_LENGTH = 4

/** The three states of the link, and the whole vocabulary the window renders. */
export const LINK_STATUSES = Object.freeze(['off', 'awaiting_code', 'linked'])

/**
 * mintPairing({now, randomBytes}) → {code, expiresAt}.
 *
 * The code is drawn from the alphabet by REJECTION-FREE indexing — one byte per character,
 * taken modulo the alphabet — because the bias that introduces is over an alphabet of 32 into
 * 256, which divides exactly. (An alphabet whose size did not divide 256 would need
 * rejection sampling; this one is chosen so it does not.)
 */
export function mintPairing({ now = Date.now(), randomBytes = cryptoRandomBytes } = {}) {
  const bytes = randomBytes(PAIRING_CODE_LENGTH)
  let raw = ''
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    raw += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length]
  }
  const at = Number(now)
  return {
    code: `${raw.slice(0, 4)}-${raw.slice(4)}`,
    expiresAt: (Number.isFinite(at) ? at : Date.now()) + PAIRING_TTL_MS,
  }
}

/**
 * normalizeCode(text) — what two codes are compared AS. Case is dropped, and every character
 * outside the alphabet with it, so `k3pm-7qrz` and `K3PM 7QRZ` are the same code and a stray
 * dash is not a failed pairing.
 */
export function normalizeCode(text) {
  return String(text ?? '')
    .toUpperCase()
    .split('')
    .filter((ch) => PAIRING_ALPHABET.includes(ch))
    .join('')
}

/**
 * codeFromMessage(text) — the code a message CARRIES, or ''.
 *
 * The LAST whitespace-separated word is taken rather than the whole message, so `/start
 * K3PM-7QRZ` — the form Telegram itself produces from a deep link — pairs exactly like the
 * bare code does, while a message that merely contains the letters of a code somewhere in a
 * sentence does not.
 */
export function codeFromMessage(text) {
  const words = String(text ?? '').trim().split(/\s+/)
  return normalizeCode(words[words.length - 1] ?? '')
}

/** The stored pairing block, validated into shape, or null. */
export function pairingOf(config) {
  const raw = config && config.telegram ? config.telegram.pairing : undefined
  if (!raw || typeof raw !== 'object') return null
  const code = typeof raw.code === 'string' ? raw.code : ''
  const expiresAt = Number(raw.expiresAt)
  if (normalizeCode(code).length !== PAIRING_CODE_LENGTH || !Number.isFinite(expiresAt)) return null
  return { code, expiresAt }
}

/** pairingLive(config, now) — is there a code that has not run out? */
export function pairingLive(config, now = Date.now()) {
  const pairing = pairingOf(config)
  return pairing !== null && Number(now) < pairing.expiresAt
}

/**
 * matchesPairingCode(config, text, now) — the ONE comparison that pairs a chat.
 *
 * Expiry is checked FIRST and independently of the letters: a code whose ten minutes are over
 * is refused without ever being compared, so «it still worked» can never be a property of
 * having typed the right characters.
 */
export function matchesPairingCode(config, text, now = Date.now()) {
  if (!pairingLive(config, now)) return false
  const pairing = pairingOf(config)
  const sent = codeFromMessage(text)
  return sent.length === PAIRING_CODE_LENGTH && sent === normalizeCode(pairing.code)
}

/** botTokenTail(config) — the four characters the window is allowed to see, or null. */
export function botTokenTail(config) {
  const token = telegramBotToken(config)
  return token === null ? null : token.slice(-TOKEN_TAIL_LENGTH)
}

/**
 * telegramLinkView(config, {now}) → the read model of the link, and the only one.
 *
 * `off` — no bot connected. `awaiting_code` — a token is stored and the pair is not confirmed;
 * `code` carries the live code, or NULL when the last one ran out (a dead code shown as if it
 * were usable is worse than none, so it is not shown at all — the window offers a new one).
 * `linked` — a chat has confirmed itself, and it is named by its TITLE when Telegram gave one.
 *
 * @param {object} config
 * @param {{now?:number}} [opts]
 * @returns {{status:string, tokenTail:string|null, code:string|null, expiresAt:number|null, codeExpired:boolean, chat:{id:string,title:string|null}|null}}
 */
export function telegramLinkView(config, { now = Date.now() } = {}) {
  const tokenTail = botTokenTail(config)
  if (tokenTail === null) {
    return { status: 'off', tokenTail: null, code: null, expiresAt: null, codeExpired: false, chat: null }
  }
  const chatId = telegramChatId(config)
  if (chatId !== null) {
    const rawTitle = config && config.telegram ? config.telegram.chatTitle : undefined
    const title = typeof rawTitle === 'string' && rawTitle.trim() !== '' ? rawTitle.trim() : null
    return {
      status: 'linked',
      tokenTail,
      code: null,
      expiresAt: null,
      codeExpired: false,
      chat: { id: chatId, title },
    }
  }
  const pairing = pairingOf(config)
  const live = pairingLive(config, now)
  return {
    status: 'awaiting_code',
    tokenTail,
    code: live ? pairing.code : null,
    expiresAt: live ? pairing.expiresAt : null,
    codeExpired: pairing !== null && !live,
    chat: null,
  }
}
