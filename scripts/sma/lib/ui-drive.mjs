/**
 * ui-drive.mjs — the pure half of the live UI run: step parsing, finding
 * classification, receipt rendering, exit-code law.
 *
 * ═══════════════════ WHY THIS EXISTS: THE SILENT-FALLBACK CLASS ═════════════════
 * The retroactive UI audit already claimed it could look at a running app. It could
 * not. Its capture shelled out to `npx playwright screenshot ... 2>/dev/null`, and on
 * any machine without that package cached npx refuses non-interactively ("canceled due
 * to missing packages and no YES option"); with a stale browser cache it fails on a
 * build mismatch instead. Both errors went to /dev/null, so the audit continued as a
 * code-only read and reported a score as if the UI had been seen. A tool that cannot
 * look is honest; a tool that cannot look but scores anyway is worse than none — the
 * operator stops checking by hand precisely because the machine claimed it checked.
 *
 * So the law here is: A RUN THAT DID NOT HAPPEN IS NEVER A PASS. Every failure to
 * launch is loud, carries the one command that fixes it, and exits non-zero. There is
 * no code path in this module that turns an absent browser into an empty finding list.
 *
 * ═══════════════════ SCREENSHOTS ARE NOT THE POINT ══════════════════════════════
 * A screenshot shows a rendered shell; it does not show that the shell is wired to
 * anything. A panel that paints perfectly while every data call 404s photographs as a
 * clean pass. So the run collects what a picture cannot carry — uncaught exceptions,
 * failed requests, HTTP>=400, and whether the declared click path actually completes —
 * and those, not the pixels, decide the verdict.
 *
 * Node built-ins only; the browser lives in the runner and is injected for tests.
 */

import { join } from 'node:path'

/** Viewports every run captures, so a responsive break cannot hide behind one width. */
export const VIEWPORTS = Object.freeze([
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
])

/**
 * resolveDriveViewport(name) -> {ok:true, viewport} | {ok:false, reason}
 *
 * The width the scripted path and the sweep are walked at. By default both walk the desktop,
 * where an operator's claim about a window is usually made — but a claim like «the phone can
 * take the task through to approval» is about a NARROW screen, and walking it wide would
 * prove the opposite of what was said out loud.
 *
 * The choice is restricted to the frozen list above, and that restriction is the point rather
 * than a convenience: every width in it is already opened and already measured on every run,
 * so a path walked at one of them is walked where the evidence already lives. An arbitrary
 * pixel number would add a width nobody measures — one more run, no more knowledge — and the
 * receipt would start naming sizes that appear nowhere else in it.
 *
 * @param {string} name
 */
export function resolveDriveViewport(name) {
  const asked = String(name ?? '').trim()
  const viewport = VIEWPORTS.find((v) => v.name === asked)
  if (viewport) return { ok: true, viewport }
  const allowed = VIEWPORTS.map((v) => `${v.name} (${v.width}px)`).join(', ')
  return {
    ok: false,
    reason: asked
      ? `unknown width "${asked}" — the path may be walked at one of the widths this run already opens: ${allowed}`
      : `--at needs a width name — one of the widths this run already opens: ${allowed}`,
  }
}

/**
 * SMA_UI_RECEIPTS — where this run puts its receipt, its journal and its screenshots.
 *
 * WHY THERE IS AN OVERRIDE AT ALL. The default — `.planning/ui-reviews/` under the tree being
 * run from — is right for a person checking their own checkout, and it is what the phase
 * machinery reads. It is exactly wrong for a run made in a THROWAWAY copy: the copy is removed
 * at acceptance and the evidence goes with it, so the one artifact that proved the window
 * works stops existing at the moment somebody wants to look at it. That happened twice in one
 * shift before this seam existed.
 *
 * IT IS AN ENVIRONMENT VARIABLE AND NOT A FLAG, deliberately. The command that raises a live
 * scene is the one that knows the run is happening in a copy, and it runs whatever trailing
 * command an operator wrote; a flag would mean every such command had to remember to carry it,
 * and the one that forgot would fail silently — by writing somewhere that disappears.
 */
export const RECEIPTS_ENV = 'SMA_UI_RECEIPTS'

/**
 * receiptsRoot({env, cwd}) → the directory this run's `run-<stamp>` folder goes into.
 *
 * The override wins when it names anything at all; otherwise the tree's own reviews folder,
 * unchanged. Nothing here creates a directory — this decides a PATH, and the command makes it.
 *
 * @param {{env?:object, cwd?:string}} [opts]
 * @returns {string}
 */
export function receiptsRoot({ env = {}, cwd = '.' } = {}) {
  const named = env[RECEIPTS_ENV]
  if (typeof named === 'string' && named.trim() !== '') return named.trim()
  return join(cwd, '.planning', 'ui-reviews')
}

/** Severity vocabulary, shared with the retroactive audit so one glossary covers both. */
export const BLOCKER = 'BLOCKER'
export const WARNING = 'WARNING'

/**
 * How many interactive elements one sweep will press. A cap has to exist — a page can
 * expose hundreds — but a SILENT cap is a lie: it makes partial coverage read as total.
 * Whatever this number leaves untouched is counted and named in the receipt.
 */
export const SWEEP_CAP = 40

/**
 * ══════════ WHEN A PAGE IS READY TO BE MEASURED AND PRESSED ══════════
 *
 * Opening used to mean «the document exists and something has been painted, plus 400 ms».
 * On a window whose first answer takes sixteen seconds that is an almost empty page, and
 * both things this engine does at that moment are then done on nothing:
 *
 *  - THE OVERFLOW MEASUREMENT. An empty page does not slide sideways by itself, so «no
 *    overflow» can be true only because there is nothing to show yet. A gate that is green
 *    before the fix and green after it proves nothing — the same disease the element scan
 *    was written to cure, arriving through the clock instead of through the tree.
 *  - THE SWEEP'S DENOMINATOR. The list of controls is collected once, and collected early
 *    it holds whatever the shell painted first. One run reported «pressed 1 of 1 · nothing
 *    was left untouched» on a screen carrying about two dozen controls. That reads as total
 *    coverage while being nearly none, and a silent cap is the one thing this module says
 *    out loud it will not do.
 *
 * So readiness is a MEASURED signal, not a longer sleep: the page is sampled until BOTH of
 * these hold — what it shows has stopped changing (element count and the length of its text),
 * and it is no longer waiting on a call of its own. Stillness alone is not enough, and this
 * was measured rather than reasoned: on the window this was written for, the shell paints a
 * skeleton of one control and then holds perfectly still for thirty-one seconds while its
 * first state call runs. A stillness test passes that skeleton in a second and hands back
 * «1 control found, nothing left untouched» for a screen that turned out to carry sixteen.
 *
 * A channel held open for the life of the screen is NOT a call to wait for — waiting on it
 * would be «networkidle» again, which is how this tool once declared broken exactly the apps
 * that stream. A channel is told apart by the KIND the browser gives it, and by nothing else.
 * An «it has been open a long time, so it must be a channel» rule was tried and thrown out
 * the same hour it was written: on the window this was made for, the state call grew from
 * sixteen seconds to forty-six as tasks accumulated, walked straight past the threshold, and
 * the sweep went back to reporting «1 of 1» — a fixed number of seconds cannot tell a slow
 * answer from a channel, it can only be overtaken by one.
 *
 * The price is stated rather than hidden: an endless channel the browser does NOT label as one
 * costs a run its ceiling and then says «still waiting on N calls». That is loud and wrong in
 * the safe direction; the other way round is a receipt that describes a page nobody saw.
 *
 * A hard wait long enough for the slowest door would tax every fast page for nothing and still
 * guarantee nothing. A page that never settles inside READY_CEILING_MS does not quietly pass:
 * it becomes a named finding, because a number measured on a page that was still loading is a
 * number about nothing.
 */
export const READY_POLL_MS = 250
export const READY_SETTLE_MS = 1000
export const READY_CEILING_MS = 150000

/**
 * Kinds of request that are channels rather than answers: they are open for as long as the
 * screen is, and nobody is waiting for them to come back.
 */
export const STREAM_RESOURCE_TYPES = Object.freeze(['eventsource', 'websocket'])

/**
 * readiness(samples, {settleMs}) -> {ready, heldMs, waitedMs, ink, reason}
 *
 * Pure, so the rule can be proved without a browser. `samples` are taken in order, each
 * {at: epoch ms, signature: what the page showed, ink: whether it showed anything at all,
 * pending: how many calls of its own it is still waiting on, channels excluded}.
 * Ready means all three: something is painted, the signature has not changed for settleMs,
 * and nothing is outstanding.
 *
 * @param {Array<{at:number, signature:string, ink?:boolean, pending?:number}>} samples
 * @param {{settleMs?:number}} [opts]
 */
export function readiness(samples = [], { settleMs = READY_SETTLE_MS } = {}) {
  const list = (Array.isArray(samples) ? samples : []).filter((s) => s && Number.isFinite(Number(s.at)))
  if (list.length === 0) {
    return { ready: false, heldMs: 0, waitedMs: 0, ink: false, reason: 'the page was never sampled' }
  }
  const last = list[list.length - 1]
  const waitedMs = Number(last.at) - Number(list[0].at)
  const ink = Boolean(last.ink)
  let heldSince = Number(last.at)
  for (let i = list.length - 2; i >= 0; i -= 1) {
    if (list[i].signature !== last.signature) break
    heldSince = Number(list[i].at)
  }
  const heldMs = Number(last.at) - heldSince
  const pending = Math.max(0, Number(last.pending) || 0)
  const ready = ink && pending === 0 && heldMs >= settleMs
  const reason = ready
    ? ''
    : !ink
      ? 'nothing was painted at all — the measurement would have been taken on an empty page'
      : pending > 0
        ? `after ${waitedMs} ms the page was still waiting on ${pending} call(s) of its own`
        : `after ${waitedMs} ms what the page shows had held still for only ${heldMs} ms`
  return { ready, heldMs, waitedMs, ink, pending, reason }
}

/**
 * SWEEP_SPARSE_FLOOR / sweepSparseNote(total) — the denominator has to be able to look thin.
 *
 * «1 of 1 · nothing was left untouched» is a true sentence and a false impression: it is the
 * shape a complete sweep has, worn by a sweep that saw one button. Below the floor the
 * receipt says so in words, so a reader cannot mistake an empty denominator for a full one.
 *
 * @param {number} total controls the sweep found
 * @returns {string} the sentence, or '' when the denominator needs no warning
 */
export const SWEEP_SPARSE_FLOOR = 2
export function sweepSparseNote(total) {
  const n = Number(total) || 0
  if (n >= SWEEP_SPARSE_FLOOR) return ''
  if (n <= 0) {
    return 'No interactive control was found at all — this sweep says nothing about the surface. The denominator is empty, not complete.'
  }
  return (
    `Only ${n} interactive control was found on the whole page — «${n} of ${n}» has the shape of full coverage and is ` +
    'nearly none. Whatever else this screen carries, the sweep never saw it.'
  )
}

/**
 * Controls the sweep will NOT press, matched on their visible name.
 *
 * The sweep runs unattended against whatever the operator points it at — often a real
 * development database, sometimes something worse. Pressing every button on a page is
 * the job; pressing «Delete account» is destroying the user's data on our own
 * initiative, which no review is worth. These are SKIPPED and NAMED in the receipt, so
 * the gap is visible and a human can walk them deliberately.
 *
 * English and Russian, because the operator's UI is not always English.
 *
 * Two classes were added after a run — not after a reading — showed the sweep could press
 * them, and this list is a safety floor, so it is never economised on:
 *
 *  - STARTING THE MACHINE. The window carries a switch «Включить конвейер»; pressing it
 *    sets workers loose on the queue by themselves, at night, spending the owner's
 *    subscription. A review tool that starts the engine on its own initiative is worse
 *    than no review. Its opposite («Выключить конвейер») is refused too: stopping a
 *    running machine unattended is also an intervention nobody asked for.
 *  - APPROVING. Drafts of skills, agents and memory are merged by «Одобрить» / «Принять».
 *    A draft approved by a sweep is a decision no human made, and the merge is real.
 *
 * The list only GROWS: nothing already refused is ever taken out of it.
 *
 * The pipeline entries name the VERB together with the noun on purpose. A bare «конвейер»
 * would also refuse ordinary labels that merely carry the word — «конвейер памяти» is the
 * product's own name for the memory write path — and hiding a control from the sweep to
 * guard a switch that is not there buys nothing.
 */
export const DESTRUCTIVE_RE =
  /\b(delete|remove|destroy|drop|erase|wipe|purge|reset|revoke|deactivate|uninstall|logout|sign\s*out|publish|deploy|pay|buy|checkout|subscribe|confirm\s+payment|approv(?:e|ing)|accept(?:ing)?|(?:enable|disable|start|stop)\s+(?:the\s+)?(?:pipeline|engine))\b|удал|стереть|очист|сброс|отозв|выйти|выход|опубликов|выкат|оплат|купить|подтвердить\s+платёж|(?:включить|выключить)\s+конвейер|одобр|принять|принима/i

/**
 * What counts as something a user can press. Kept as one selector so the receipt's
 * denominator ("touched 12 of 31") means the same thing on every page.
 */
export const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="tab"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/**
 * The verbs a caller may script. Anything else is refused at parse time, never ignored.
 *
 * `key` presses a combination on the page — «Control+K», «Escape», «Enter». It exists
 * because a whole class of a window's surface is reachable ONLY from the keyboard: a
 * shortcut that opens a panel has no control to click, so without this verb the rule
 * «touched the interface — drive it yourself» could not be kept for shortcuts at all, and
 * a keyboard feature would end up signed off by reading its handler. The argument is handed
 * to the driver as written: naming the combination is the caller's business, and a name the
 * driver does not know fails the step loudly instead of passing quietly.
 */
export const STEP_VERBS = Object.freeze(['goto', 'click', 'type', 'wait', 'shot', 'expect', 'key'])

/**
 * ═══════ УЧЁТНЫЕ ДАННЫЕ НАЗЫВАЮТСЯ, А НЕ ПИШУТСЯ ═══════
 *
 * `SECRET_PREFIX` — приставка, которой шаг `type` говорит: значение лежит В ОКРУЖЕНИИ, здесь
 * стоит только его имя.
 *
 * ЗАЧЕМ ЭТО НУЖНО, СКАЗАННОЕ ОДНОЙ ПРИЧИНОЙ. Квитанция печатает пройденный путь ШАГАМИ КАК
 * ОНИ НАПИСАНЫ (`renderReceipt`, раздел «Path walked»), а вход в окно — это шаг `type` с
 * паролем. Без этой формы самый обычный вход записывал бы пароль на диск, в файл, который
 * потом прикладывают к отчёту и коммитят. Отозвать его оттуда нельзя: файл уже написан.
 * С приставкой на диск уезжает ИМЯ переменной, а значение читается в момент прогона и нигде
 * не остаётся — ни в квитанции, ни в журнале, ни в аргументах, которые видит соседний процесс.
 *
 * ФОРМА ИМЕНИ — ПЕРЕМЕННАЯ ОКРУЖЕНИЯ, И ПРОВЕРЯЕТСЯ ОНА ПРИ РАЗБОРЕ. Имя с пробелом или
 * дефисом переменной не бывает; пропустив такое, разбор набрал бы в поле пароля литерал
 * «env:APP PASSWORD» и получил бы обычный отказ входа — жалобу на приложение вместо жалобы
 * на опечатку. Ошибка при разборе видна ДО того, как открылось окно.
 *
 * ЛИТЕРАЛ, НАЧИНАЮЩИЙСЯ С `env:`, НАБРАТЬ БОЛЬШЕ НЕЛЬЗЯ, и это осознанный размен: текст,
 * который выглядит как ссылка на переменную, в поле ввода почти всегда ею и является, а цена
 * ошибки в другую сторону — записанный на диск пароль.
 */
export const SECRET_PREFIX = 'env:'

/** Имя переменной окружения: буква или подчёркивание, дальше буквы, цифры, подчёркивания. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * parseSteps(argv) -> {ok:true, steps} | {ok:false, errors}
 *
 * A step is `<verb>:<arg>`; `type` splits its arg once more on `=`. An unknown verb is
 * an ERROR, not a skip: a typo'd step that is silently dropped turns an unrun check
 * into a green one, which is the exact failure this module exists to prevent.
 *
 * @param {string[]} argv
 * @returns {{ok:boolean, steps?:Array<object>, errors?:string[]}}
 */
export function parseSteps(argv = []) {
  const steps = []
  const errors = []
  for (const raw of argv) {
    const idx = String(raw).indexOf(':')
    if (idx < 1) {
      errors.push(`step "${raw}" has no verb — expected <verb>:<arg>, verbs: ${STEP_VERBS.join(', ')}`)
      continue
    }
    const verb = String(raw).slice(0, idx)
    const arg = String(raw).slice(idx + 1)
    if (!STEP_VERBS.includes(verb)) {
      errors.push(`step "${raw}" uses unknown verb "${verb}" — verbs: ${STEP_VERBS.join(', ')}`)
      continue
    }
    if (verb === 'type') {
      const eq = arg.indexOf('=')
      if (eq < 1) {
        errors.push(`step "${raw}" needs type:<selector>=<text>`)
        continue
      }
      const selector = arg.slice(0, eq)
      const value = arg.slice(eq + 1)
      if (value.startsWith(SECRET_PREFIX)) {
        const name = value.slice(SECRET_PREFIX.length)
        if (!ENV_NAME_RE.test(name)) {
          errors.push(`step "${raw}" needs type:<selector>=${SECRET_PREFIX}<VARIABLE_NAME>`)
          continue
        }
        // Значения здесь нет и быть не может: этот модуль не читает окружение, он его НАЗЫВАЕТ.
        steps.push({ verb, selector, text: null, fromEnv: name, raw })
        continue
      }
      steps.push({ verb, selector, text: value, fromEnv: null, raw })
      continue
    }
    if (verb === 'wait') {
      const ms = Number(arg)
      if (!Number.isFinite(ms) || ms < 0) {
        errors.push(`step "${raw}" needs wait:<milliseconds>`)
        continue
      }
      steps.push({ verb, ms, raw })
      continue
    }
    if (!arg.trim()) {
      errors.push(`step "${raw}" has an empty argument`)
      continue
    }
    steps.push({ verb, arg, raw })
  }
  return errors.length ? { ok: false, errors } : { ok: true, steps }
}

/**
 * typeText(step, env) -> {ok:true, text} | {ok:false, reason}
 *
 * Что именно набирать в поле — ЕДИНСТВЕННЫЙ ответчик на этот вопрос. Обычный шаг отдаёт свой
 * текст; шаг с именем переменной отдаёт то, что лежит в окружении ПРЯМО СЕЙЧАС.
 *
 * НЕ ЗАДАННАЯ ПЕРЕМЕННАЯ — ОТКАЗ СЛОВАМИ, А НЕ ПУСТАЯ СТРОКА. Пустая строка в поле пароля
 * даёт обычное «неверный логин или пароль»: шаг выглядит выполненным, вина ложится на
 * приложение, и человек чинит не то. Отказ называет ИМЯ переменной — единственное, чего не
 * хватало, и единственное, что можно исправить. Пробельное значение считается не заданным по
 * той же причине: пароль из пробелов не заводят, а забытые кавычки в оболочке — заводят.
 *
 * ЧИСТАЯ: окружение приезжает аргументом, `process.env` этот модуль не знает. И значение
 * возвращается ТОЛЬКО наружу — ни в какую строку сообщения оно не попадает, потому что
 * сообщения этого модуля едут в квитанцию на диск.
 *
 * @param {{text?:string|null, fromEnv?:string|null, raw?:string}} step
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ok:true, text:string}|{ok:false, reason:string}}
 */
export function typeText(step, env = {}) {
  const name = step && typeof step.fromEnv === 'string' && step.fromEnv !== '' ? step.fromEnv : null
  if (name === null) return { ok: true, text: typeof step?.text === 'string' ? step.text : '' }
  const value = env ? env[name] : undefined
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, reason: `${name} is not set in the environment — nothing was typed, and nothing was guessed` }
  }
  return { ok: true, text: value }
}

/**
 * classify(observations, {origin}) -> findings[]
 *
 * The rubric, stated once so a reader can argue with it:
 *  - an uncaught page exception BLOCKS — the screen is broken, not merely ugly
 *  - a request that FELL OVER BLOCKS — the screen is decorative. A request the browser
 *    ABORTED is graded apart: it is a decision taken inside the page (a screen unmounted, a
 *    query was cancelled, a long-lived stream closed with its page), and no server can cause
 *    one. A recognised stream close is dropped; any other abort is REPORTED as a warning.
 *    Before this split, one app that streams collected 24 «failures» in a single run and the
 *    verdict said nothing about the app — a gate that is always red is a gate nobody reads
 *  - HTTP>=500 BLOCKS anywhere; HTTP>=400 BLOCKS on the app's OWN origin (its own API
 *    answering 404 is the panel-without-an-engine signature) and WARNs cross-origin,
 *    where an ad blocker or a third party is the likelier author
 *  - a scripted step that could not complete BLOCKS — a path the operator was told
 *    works, does not
 *  - a console error WARNs — noisy by nature, real often enough to report
 *  - a CAPTURE THAT IS NOT AN IMAGE WARNs, and the file is not published as a screenshot: the
 *    walk may have been perfectly valid, but a receipt that lists evidence it does not have is
 *    worse than one that lists none (see imageFacts)
 *
 * @param {{consoleErrors?:string[], pageErrors?:string[], requestFailures?:Array<object>,
 *          httpErrors?:Array<object>, stepFailures?:Array<object>, deadControls?:Array<object>,
 *          unnamedControls?:Array<object>, overflows?:Array<object>}} observations
 * @param {{origin?:string}} [opts]
 * @returns {Array<{severity:string, kind:string, detail:string}>}
 */
export function classify(observations = {}, { origin = '' } = {}) {
  const findings = []
  const sameOrigin = (url) => Boolean(origin) && String(url ?? '').startsWith(origin)
  // The browser logs its own echo of every failed fetch. Reporting both turns one defect
  // into two lines that say the same thing, and a receipt nobody finishes reading is a
  // receipt nobody acts on — the http finding already carries the URL and the status.
  const isNetworkEcho = (msg) => /Failed to load resource/i.test(String(msg))

  for (const msg of observations.pageErrors ?? []) {
    findings.push({ severity: BLOCKER, kind: 'page-exception', detail: String(msg) })
  }
  for (const f of observations.requestFailures ?? []) {
    // A stream that ends because the page ended is a CLOSE. Counting it as a failure is how
    // this tool used to hand a permanent FAIL to every app that streams — see isStreamClose.
    if (isStreamClose(f)) continue
    // An ABORT is a decision taken inside the browser — a screen unmounted, a query was
    // cancelled, a page moved on. No server causes one: a server that fails answers with a
    // status (caught below) or drops the connection with a different error entirely. So an
    // unexplained abort is REPORTED and does not block; a connection that actually fell over
    // still does.
    if (isAbort(f.error)) {
      findings.push({
        severity: WARNING,
        kind: 'request-cancelled',
        detail: `${f.method ?? 'GET'} ${f.url} — отменён окном (${f.error}); сервер такого не вызывает`,
      })
      continue
    }
    findings.push({
      severity: BLOCKER,
      kind: 'request-failed',
      detail: `${f.method ?? 'GET'} ${f.url} — ${f.error ?? 'no response'}`,
    })
  }
  for (const h of observations.httpErrors ?? []) {
    const status = Number(h.status) || 0
    const blocks = status >= 500 || (status >= 400 && sameOrigin(h.url))
    findings.push({
      severity: blocks ? BLOCKER : WARNING,
      kind: 'http-error',
      detail: `${status} ${h.method ?? 'GET'} ${h.url}`,
    })
  }
  for (const s of observations.stepFailures ?? []) {
    findings.push({ severity: BLOCKER, kind: 'step-failed', detail: `${s.step} — ${s.error}` })
  }
  // A control that cannot be operated is a dead button to the user, whatever the source says.
  for (const d of observations.deadControls ?? []) {
    findings.push({ severity: BLOCKER, kind: 'control-dead', detail: `"${d.name}" — ${d.error}` })
  }
  // Sideways scroll at phone width is measured, not judged: scrollWidth exceeds clientWidth.
  // When the offender is NAMED (see worstOverflow) the finding says which box holds the
  // content and how much of it lies past the edge: «the page scrolls sideways» is not
  // something the person who has to fix it can act on.
  for (const o of observations.overflows ?? []) {
    findings.push({
      severity: BLOCKER,
      kind: 'overflow',
      detail: o.element
        ? `${o.element} holds ${o.scrollWidth}px of content in ${o.clientWidth}px of visible width (${o.viewport}) — ` +
          `${o.scrollWidth - o.clientWidth}px lie past the edge` +
          (o.scrollable
            ? '; that box scrolls sideways inside itself, so the rest is reached only by dragging the window contents'
            : '; nothing scrolls there, so what is past the edge cannot be reached at all')
        : `content is ${o.scrollWidth}px wide in a ${o.clientWidth}px viewport (${o.viewport}) — the page scrolls sideways`,
    })
  }
  // A page that never stopped loading was measured while it was still arriving, and every
  // number taken there — the overflow, the sweep's denominator — describes a page nobody
  // will ever see. Blocking on purpose: the alternative is a clean receipt for a run that
  // looked at a spinner.
  for (const n of observations.notSettled ?? []) {
    findings.push({
      severity: BLOCKER,
      kind: 'page-not-settled',
      detail:
        `${n.where ?? 'the page'} had not finished rendering after ${Math.round(Number(n.waitedMs) || 0) / 1000}s` +
        `${n.reason ? ` — ${n.reason}` : ''}; what was measured there was measured on a page that was still loading`,
    })
  }
  // СНИМОК, КОТОРЫЙ НЕ ИЗОБРАЖЕНИЕ, — это отсутствие доказательства, и сказать об этом обязана
  // сама квитанция. Предупреждение, а не блокер, и это решение: пройденный путь от неспособности
  // драйвера сфотографировать не портится — ложным становится только раздел «Screenshots»,
  // поэтому такой файл там и не публикуется (см. imageFacts и capture в ui-drive.mjs).
  for (const s of observations.blankShots ?? []) {
    findings.push({
      severity: WARNING,
      kind: 'shot-not-an-image',
      detail: `${s.file} — ${s.reason ?? 'не изображение'} (${s.bytes ?? 0} байт); этот прогон ничего не сфотографировал`,
    })
  }
  // A control nobody can name is unusable by screen reader and untestable by anyone.
  for (const u of observations.unnamedControls ?? []) {
    findings.push({ severity: WARNING, kind: 'control-unnamed', detail: `<${u.tag}> has no accessible name — ${u.hint}` })
  }
  for (const msg of observations.consoleErrors ?? []) {
    if (isNetworkEcho(msg)) continue
    findings.push({ severity: WARNING, kind: 'console-error', detail: String(msg) })
  }
  return dedupe(findings)
}

/**
 * Sub-pixel widths round, so a box is only «wider than its own window» when it is wider by
 * more than a whole pixel. The threshold predates the element scan and is deliberately
 * unchanged by it: noise from rounding was never the thing this finding was about.
 */
export const OVERFLOW_TOLERANCE_PX = 1

/**
 * How far down the tree the overflow scan walks, and how many boxes it will measure.
 *
 * ══════════ WHY A SCAN AT ALL — THE GATE THAT WAS GREEN BEFORE AND AFTER ══════════
 * This used to measure the DOCUMENT only: `documentElement.scrollWidth > clientWidth`.
 * A window whose minimum width sits on the page itself does slide sideways, and that was
 * caught. But a window that moved its minimum onto an inner container — precisely so the
 * page would stop sliding — became invisible to the measurement while getting no healthier:
 * at 375px the document measured 375 and «no overflow», while the container inside it held
 * 1360px of content, nine hundred and eighty five of them past the right edge. A person
 * looking at that screen sees a menu and two half-words; the instrument saw nothing.
 *
 * A check that is green before the fix and green after it is not a gate — it manufactures
 * confidence and proves nothing. So the measurement follows the content, not the document.
 *
 * The walk is bounded and that costs no knowledge: content that overflows the page at all
 * makes the boxes ABOVE it overflow too, so the frame of the window — the first few levels —
 * carries every escape. A strip deep inside one screen that scrolls itself is a design
 * decision, and measuring every node on every width would slow each run without adding a
 * fact.
 */
export const OVERFLOW_SCAN_DEPTH = 4
export const OVERFLOW_SCAN_NODES = 400

/**
 * worstOverflow(boxes, {viewport}) -> the single widest offender, or null.
 *
 * ONE finding per width, not one per box: a container that overflows drags its ancestors
 * into overflowing with it, so reporting all of them turns a single defect into a list and
 * a receipt nobody finishes reading is a receipt nobody acts on. The widest overhang is the
 * one that names the disease; the rest are its shadow.
 *
 * Boxes with no visible width at all (`clientWidth` 0 — `head`, an inline node, a hidden
 * branch) are not judged: there is no width to be wider than.
 *
 * @param {Array<{element?:string, scrollWidth?:number, clientWidth?:number, scrollable?:boolean}>} boxes
 * @param {{viewport?:string}} [opts]
 * @returns {{element?:string, scrollWidth:number, clientWidth:number, scrollable?:boolean, viewport:string}|null}
 */
export function worstOverflow(boxes = [], { viewport = '' } = {}) {
  let worst = null
  for (const b of boxes) {
    const scrollWidth = Number(b?.scrollWidth)
    const clientWidth = Number(b?.clientWidth)
    if (!Number.isFinite(scrollWidth) || !Number.isFinite(clientWidth) || clientWidth <= 0) continue
    if (scrollWidth <= clientWidth + OVERFLOW_TOLERANCE_PX) continue
    const over = scrollWidth - clientWidth
    if (!worst || over > worst.scrollWidth - worst.clientWidth) {
      worst = { element: b.element, scrollWidth, clientWidth, scrollable: b.scrollable === true, viewport }
    }
  }
  return worst
}

/**
 * How long a request must have been open before its abort reads as «this was a stream»
 * rather than «this call was cancelled». A page's ordinary fetches answer in well under a
 * second; a channel held open for the life of the screen is a different animal.
 */
export const STREAM_CLOSE_AGE_MS = 2000

/**
 * An abort is the browser saying «I stopped listening». It is the ONE network error a
 * server cannot cause, which is why it is graded apart from every other one.
 *
 * @param {string|undefined} error
 */
export function isAbort(error) {
  return /ABORTED|aborted/i.test(String(error ?? ''))
}

/**
 * isStreamClose(failure) — was this «failed request» simply a long-lived stream ending
 * with the page that opened it?
 *
 * ═══════════════════ WHY THIS EXISTS, IN ONE PARAGRAPH ═══════════════════
 *
 * An app that pushes live updates holds a channel open for as long as its screen is on the
 * glass. Closing the page aborts that channel — which the browser reports exactly like a
 * request that fell over. Before this, every live run of a streaming app collected one
 * «request-failed» per viewport per revisit and returned FAIL no matter how well the app
 * worked; a gate that is always red is a gate nobody reads, so the whole tool quietly stopped
 * meaning anything. This is the same failure class it was built to catch, turned inward.
 *
 * The three ways a close is recognised, all of them facts rather than guesses:
 *   - the browser itself calls the request an event stream;
 *   - the driver was closing the page when the abort arrived;
 *   - the request had been open longer than a page's ordinary call ever is.
 * ABORT is the only error text that qualifies: it means a client decided to stop listening.
 * A refused connection, a DNS failure or a timeout is never a close and still BLOCKS.
 *
 * @param {{error?:string, resourceType?:string, ageMs?:number, whileClosing?:boolean}} failure
 * @returns {boolean}
 */
export function isStreamClose(failure = {}) {
  if (!isAbort(failure.error)) return false
  if (String(failure.resourceType ?? '') === 'eventsource') return true
  if (failure.whileClosing === true) return true
  const age = Number(failure.ageMs)
  return Number.isFinite(age) && age >= STREAM_CLOSE_AGE_MS
}

/**
 * dedupe(findings) -> findings with an `occurrences` count.
 *
 * The same defect is observed once per viewport and again on every revisit, so a raw
 * list reads as fourteen problems where there are three. The count is KEPT rather than
 * discarded: "seen 6 times" distinguishes a constant failure from a one-off flake.
 *
 * @param {Array<{severity:string, kind:string, detail:string}>} findings
 */
export function dedupe(findings = []) {
  const seen = new Map()
  for (const f of findings) {
    const key = `${f.kind}\u0000${f.detail}`
    const hit = seen.get(key)
    if (hit) hit.occurrences += 1
    else seen.set(key, { ...f, occurrences: 1 })
  }
  return [...seen.values()]
}

/**
 * verdict(findings, {ran}) -> {status, exitCode, blockers, warnings}
 *
 * `ran:false` is NOT a pass and NOT an empty result — it is its own status, so a
 * caller can never read "no findings" out of a run that never started.
 *
 * @param {Array<{severity:string}>} findings
 * @param {{ran?:boolean}} [opts]
 */
export function verdict(findings = [], { ran = true } = {}) {
  if (!ran) return { status: 'NOT-RUN', exitCode: 3, blockers: 0, warnings: 0 }
  const blockers = findings.filter((f) => f.severity === BLOCKER).length
  const warnings = findings.filter((f) => f.severity === WARNING).length
  if (blockers) return { status: 'FAIL', exitCode: 1, blockers, warnings }
  if (warnings) return { status: 'PASS-WITH-WARNINGS', exitCode: 0, blockers, warnings }
  return { status: 'PASS', exitCode: 0, blockers, warnings }
}

/**
 * The message shown when the browser driver is absent. It carries the fix, because a
 * diagnosis the operator cannot act on costs the same as no diagnosis.
 *
 * @param {string} [reason]
 */
export function missingDriverMessage(reason = '') {
  return [
    'SMA ui-drive: NOT RUN — no browser driver available.',
    reason ? `  cause: ${reason}` : '',
    '  This is not a pass. Nothing was looked at.',
    '  Install the driver once (about 120 MB, cached for every later run):',
    '    npm install playwright && npx playwright install chromium',
    '  SMA does not depend on it: no run is attempted without it, and none is faked.',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * renderReceipt({url, steps, shots, findings, verdict, startedAt}) -> markdown
 *
 * The receipt is the artifact a reviewer reads instead of trusting a claim: what was
 * opened, what was pressed, what was seen, and the verdict that follows from it.
 *
 * @param {{url?:string, steps?:Array<{raw:string}>, shots?:string[],
 *          findings?:Array<{severity:string, kind:string, detail:string, occurrences?:number}>,
 *          verdict?:{status:string, blockers:number, warnings:number}, startedAt?:string}} [args]
 * @returns {string}
 */
/**
 * renderCoverage(coverage) -> markdown
 *
 * States the denominator out loud. "Touched 12 controls" invites the reader to assume
 * that was all of them; "touched 12 of 31 — 19 not pressed (cap)" cannot be misread.
 * A sweep that never ran says so rather than printing a flattering zero.
 *
 * What the run declined to count against the app is stated here too: a forgiving tool that
 * forgives QUIETLY is worth less than a strict one, because nobody can tell what it let past.
 *
 * @param {{touched?:number, total?:number, skipped?:number, refused?:string[], ran?:boolean,
 *          vanished?:string[], viewportsSkipped?:string[], streamsClosed?:number, sparse?:string,
 *          pathViewport?:{name:string, width:number, height:number}}} [coverage]
 * @returns {string}
 */
export function renderCoverage(coverage) {
  const declared = (c) =>
    Array.isArray(c?.viewportsSkipped) && c.viewportsSkipped.length
      ? `- Viewports NOT opened — the app declares a minimum width: ${c.viewportsSkipped.join(', ')}. This run says nothing about narrower screens.`
      : ''
  // The width the path was walked at is printed ONLY when the operator declared one. A claim
  // like «this goes through on a phone» is worth what the receipt can show about the width it
  // was tried at; without the declaration the line is absent and the receipt reads as before.
  const walkedAt = (c) => {
    const p = c?.pathViewport
    return p?.name ? `- Scripted path & sweep walked at: **${p.name} (${p.width}×${p.height})** — declared with \`--at\`.` : ''
  }
  if (!coverage || coverage.ran === false) {
    return [
      '_The interactive surface was not swept — only the scripted path was walked._',
      walkedAt(coverage),
      declared(coverage),
    ]
      .filter(Boolean)
      .join('\n')
  }
  const { touched = 0, total = 0, skipped = 0, refused = [], streamsClosed = 0, sparse = '', vanished = [] } = coverage
  const lines = [`- Interactive controls pressed: **${touched} of ${total}**`]
  if (sparse) lines.push(`- **${sparse}**`)
  if (walkedAt(coverage)) lines.push(walkedAt(coverage))
  if (declared(coverage)) lines.push(declared(coverage))
  if (streamsClosed) {
    lines.push(
      `- ${streamsClosed} long-lived stream(s) ended when their page did — counted as a CLOSE, not as a failed request.`
    )
  }
  if (skipped) lines.push(`- **${skipped} were NOT pressed** (sweep cap ${SWEEP_CAP}). This review says nothing about them.`)
  if (refused.length) {
    lines.push(
      `- **${refused.length} refused as destructive** and left for a human: ${refused.map((r) => `"${r}"`).join(', ')}`
    )
  }
  // The list of controls is made once. On a screen where pressing one REPLACES the screen —
  // a list that opens a card, a step that opens the next step — the ones further down the list
  // are gone by the time their turn comes. They were never pressed, so nothing is claimed about
  // them; calling them dead would be a blocker invented by the order the sweep walks in.
  if (vanished.length) {
    lines.push(
      `- **${vanished.length} were gone before their turn** — an earlier press replaced the screen they were on. ` +
        'They were not pressed and this review says nothing about them.'
    )
  }
  // «Nothing was left untouched» is only true when there was something to leave: a sweep
  // that found one control has not covered the page, whatever its own arithmetic says.
  if (!skipped && !refused.length && !sparse && !vanished.length) lines.push('- Nothing was left untouched.')
  return lines.join('\n')
}

/**
 * Query-string names whose VALUE is a credential rather than a coordinate.
 *
 * Matched case-insensitively and by whole name, so `token` and `access_token` are caught
 * while `tokenizer` or `secretary` are not — over-redaction costs the reader the very
 * detail the receipt exists to give.
 */
const SECRET_PARAM_RE = /^(?:token|access[_-]?token|id[_-]?token|refresh[_-]?token|auth|authorization|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|sig|signature|session)$/i

/** What replaces a credential — a word, so the reader sees a removal rather than a gap. */
export const REDACTED = 'REDACTED'

/**
 * redactUrl(u) — the address a run was pointed at, with any credential in it destroyed.
 *
 * A RECEIPT IS EVIDENCE, AND EVIDENCE TRAVELS. These files are committed by design: the
 * law that a UI change is proved by running it — never by reading the code — rests on
 * them, so they go into git, into the planning tree, and from there to a remote. An
 * address that carries the key to the door therefore publishes that key, once, to
 * everyone who can read the history. This was measured rather than feared: 338 receipts
 * carrying 22 distinct daemon front tokens, all published in a single push.
 *
 * And the value is not a nonce that dies with the process — the front server reads it
 * from configuration, so a receipt written in August still opens the door in December.
 *
 * WHAT SURVIVES: scheme, host, port, path, and every ordinary parameter. A reader must be
 * able to walk the same path again; a receipt nobody can follow would trade one defect for
 * another. Only the credential's VALUE is replaced, and the parameter keeps its name so
 * the reader is told a removal happened instead of being left to wonder.
 *
 * NEVER THROWS. It is handed whatever the operator typed and whatever the browser
 * reported. It runs at the very end of a run that already happened, on the writing step —
 * a redactor that died there would destroy the evidence in the act of protecting it, so
 * anything unparseable is returned exactly as it came.
 */
export function redactUrl(u) {
  if (typeof u !== 'string' || u === '') return u
  try {
    const parsed = new URL(u)
    let touched = false
    for (const name of [...parsed.searchParams.keys()]) {
      if (!SECRET_PARAM_RE.test(name)) continue
      parsed.searchParams.set(name, REDACTED)
      touched = true
    }
    return touched ? parsed.toString() : u
  } catch {
    // not an address this runtime can parse — hand it back untouched rather than lose it
    return u
  }
}

/** Первые восемь байт всякого PNG. Файл, который на них кончается, — подпись без картинки. */
export const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * imageFacts(bytes) → «это вообще изображение?» — по самому файлу, а не по его имени.
 *
 * ═══════ ПОЧЕМУ ЭТО ПОНАДОБИЛОСЬ: КВИТАНЦИЯ, ОБЕЩАВШАЯ СНИМОК, КОТОРОГО НЕТ ═══════
 *
 * Внизу каждой квитанции написано «снимок доказывает, что экран нарисовался». Драйвер, который
 * НИЧЕГО не рисует (подставной, отказавший, headless без гарантии захвата), кладёт на диск файл
 * с расширением .png — и путь к нему уезжал в раздел «Screenshots» рядом с вердиктом PASS.
 * Читатель такой квитанции видит список снимков и верит ему; открыв файл, он находит восемь
 * байт подписи. Ровно это и произошло: прогон, у которого не было ни одного шага и ни одного
 * пикселя, отчитался как зелёный со снимком, и целый круг работы ушёл на выяснение, чей это
 * файл. Проверка стоит одно чтение файла и снимает весь класс.
 *
 * ЧИТАЕТСЯ САМ ФАЙЛ, А НЕ ЕГО РАЗМЕР. Порог в килобайтах был бы гаданием: у пустой страницы
 * снимок честно маленький. Спрашивается структура — подпись, заголовок IHDR с ненулевыми
 * сторонами и завершающий IEND: файл, оборванный на середине записи, тоже не изображение.
 *
 * ЧИСТАЯ И ТОТАЛЬНАЯ: что угодно нечитаемое — это `{ok:false}` с причиной словами, никогда
 * исключение. Причина едет в квитанцию, поэтому она на языке квитанции.
 *
 * @param {Uint8Array|Buffer|null|undefined} bytes
 * @returns {{ok:boolean, bytes:number, width:number|null, height:number|null, reason:string|null}}
 */
export function imageFacts(bytes) {
  const b = bytes && typeof bytes.length === 'number' ? bytes : null
  const n = b ? b.length : 0
  const no = (reason) => ({ ok: false, bytes: n, width: null, height: null, reason })
  if (!b || n === 0) return no('файл пуст')
  if (n < PNG_SIGNATURE.length) return no('файл короче подписи PNG')
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (b[i] !== PNG_SIGNATURE[i]) return no('это не PNG — подпись не та')
  }
  // Первая запись PNG обязана быть IHDR, и лежит она по фиксированному смещению: длина (4) +
  // имя (4) сразу за подписью. Без неё у файла нет ни ширины, ни высоты — то есть картинки.
  if (n < 24) return no(`подпись PNG без изображения — ${n} байт`)
  const name = String.fromCharCode(b[12], b[13], b[14], b[15])
  if (name !== 'IHDR') return no('в файле нет заголовка изображения (IHDR)')
  const u32 = (o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]
  const width = u32(16)
  const height = u32(20)
  if (width === 0 || height === 0) return no('изображение нулевого размера')
  const tail = n >= 8 ? String.fromCharCode(b[n - 8], b[n - 7], b[n - 6], b[n - 5]) : ''
  if (tail !== 'IEND') return { ok: false, bytes: n, width, height, reason: 'файл оборван — нет конца изображения (IEND)' }
  return { ok: true, bytes: n, width, height, reason: null }
}

export function renderReceipt({ url, steps = [], shots = [], findings = [], verdict: v, startedAt = '', coverage } = {}) {
  const bySeverity = (sev) => findings.filter((f) => f.severity === sev)
  const line = (f) => `- **${f.kind}** — ${f.detail}${f.occurrences > 1 ? ` _(seen ${f.occurrences}×)_` : ''}`
  const out = [
    '# Live UI run',
    '',
    `- URL: ${redactUrl(url)}`,
    startedAt ? `- started: ${startedAt}` : '',
    `- verdict: **${v?.status ?? 'UNKNOWN'}** (${v?.blockers ?? 0} blocking, ${v?.warnings ?? 0} warning)`,
    '',
    '## Path walked',
    '',
    steps.length ? steps.map((s) => `1. \`${s.raw}\``).join('\n') : '_Open only — no steps were scripted._',
    '',
    '## Coverage',
    '',
    renderCoverage(coverage),
    '',
    '## Screenshots',
    '',
    shots.length ? shots.map((s) => `- \`${s}\``).join('\n') : '_none_',
    '',
    '## Blocking',
    '',
    bySeverity(BLOCKER).length ? bySeverity(BLOCKER).map(line).join('\n') : '_none_',
    '',
    '## Warnings',
    '',
    bySeverity(WARNING).length ? bySeverity(WARNING).map(line).join('\n') : '_none_',
    '',
    '---',
    '',
    'A screenshot proves a screen rendered. The blocking list above is what proves it works:',
    'a panel can photograph perfectly while every call behind it fails.',
    '',
  ]
  return out.filter((l) => l !== undefined).join('\n')
}
