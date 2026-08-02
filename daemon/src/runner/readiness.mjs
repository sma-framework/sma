/**
 * readiness.mjs — can this worker actually start an attempt AT ALL?
 *
 * WHY THIS EXISTS: the shipped default pool is a pool of PLACEHOLDERS — four accounts
 * pointing at `~/.sma-accounts/…` directories that a fresh install has never created. A
 * task routed to such a worker used to die on the way to the spawn and leave nothing
 * behind: no attempt row, no log line, an empty card and «All systems green» in the log.
 * That is the one failure mode the product promises it does not have — «каждая карточка
 * отвечает ПОЧЕМУ». This module answers the question BEFORE the attempt starts, so the
 * refusal is a named, recorded, human-readable one instead of a silence.
 *
 * WHAT IT CHECKS — the cheapest honest signal only: does the account's CLI home exist on
 * this machine? Credentials themselves are never read (the config carries env-var NAMES,
 * never values — config.mjs law), so «configured» is exactly what we can prove: the
 * directory the child would be spawned with. A worker that passes may still fail later
 * for a real reason; a worker that fails HERE could never have started.
 *
 * The reason code is one of the EXISTING closed vocabulary (adapter.mjs FAIL_REASONS):
 * `missing_access` — «нужен человек: не хватает доступа». No new vocabulary, so every
 * card, label and report that already renders a failure renders this one too.
 *
 * PURE + DI: fs / homedir are injected (tests never touch a real home). Node built-ins.
 */

import { existsSync as fsExistsSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { join, isAbsolute } from 'node:path'

/** The reason a not-yet-configured account fails an attempt (adapter.mjs vocabulary). */
export const NOT_CONFIGURED_REASON = 'missing_access'

/**
 * expandHome(path, homedir) — `~/x` → `<home>/x`. The config is a human-edited file and
 * `~` is what a human writes; every consumer of an account dir must read it the same way.
 *
 * @param {string} path
 * @param {Function} [homedir]
 * @returns {string}
 */
export function expandHome(path, homedir = osHomedir) {
  const s = String(path ?? '')
  if (s === '~') return homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(homedir(), s.slice(2))
  return s
}

/**
 * workerReadiness(worker, {fsImpl, homedir}) → {ready, reason?, detail}.
 * `ready:false` means the attempt cannot even START. `detail` is a human sentence for the
 * daemon log — the durable card carries the REASON CODE, never free text.
 *
 * @param {object} worker a config.workers[] entry
 * @param {{fsImpl?:object, homedir?:Function}} [io]
 * @returns {{ready:boolean, reason?:string, detail:string}}
 */
export function workerReadiness(worker, { fsImpl, homedir = osHomedir } = {}) {
  const existsSync = (fsImpl && fsImpl.existsSync) || fsExistsSync
  if (!worker || typeof worker !== 'object') {
    return { ready: false, reason: NOT_CONFIGURED_REASON, detail: 'нет профиля работника' }
  }
  const account = worker.account
  const dir = account && account.configDir
  if (!dir) {
    return { ready: false, reason: NOT_CONFIGURED_REASON, detail: `у работника "${worker.id}" нет account.configDir` }
  }
  const resolved = expandHome(dir, homedir)
  let exists = false
  try {
    exists = existsSync(resolved)
  } catch {
    exists = false // an unreadable path is an absent one, never a crash
  }
  if (!exists) {
    return {
      ready: false,
      reason: NOT_CONFIGURED_REASON,
      detail: `аккаунт "${account.name ?? worker.id}" не настроен: каталог ${isAbsolute(resolved) ? resolved : dir} не существует`,
    }
  }
  return { ready: true, detail: `аккаунт "${account.name ?? worker.id}" готов` }
}

/**
 * poolReadiness(config, io) → {total, ready:[ids], blocked:[{id, detail}]}.
 * The boot-time picture of the whole pool: it is what decides whether the daemon may
 * report «all systems green» or must say out loud that nothing can run yet. Disabled
 * workers are not counted — a switched-off worker is a choice, not a defect.
 *
 * @param {object} config
 * @param {{fsImpl?:object, homedir?:Function}} [io]
 * @returns {{total:number, ready:string[], blocked:Array<{id:string, detail:string}>}}
 */
export function poolReadiness(config, io = {}) {
  const workers = (config && Array.isArray(config.workers) ? config.workers : []).filter(
    (w) => w && w.enabled !== false,
  )
  const ready = []
  const blocked = []
  for (const w of workers) {
    const r = workerReadiness(w, io)
    if (r.ready) ready.push(w.id)
    else blocked.push({ id: w.id, detail: r.detail })
  }
  return { total: workers.length, ready, blocked }
}
