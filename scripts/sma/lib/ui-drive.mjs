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

/** Viewports every run captures, so a responsive break cannot hide behind one width. */
export const VIEWPORTS = Object.freeze([
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
])

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
 * Controls the sweep will NOT press, matched on their visible name.
 *
 * The sweep runs unattended against whatever the operator points it at — often a real
 * development database, sometimes something worse. Pressing every button on a page is
 * the job; pressing «Delete account» is destroying the user's data on our own
 * initiative, which no review is worth. These are SKIPPED and NAMED in the receipt, so
 * the gap is visible and a human can walk them deliberately.
 *
 * English and Russian, because the operator's UI is not always English.
 */
export const DESTRUCTIVE_RE =
  /\b(delete|remove|destroy|drop|erase|wipe|purge|reset|revoke|deactivate|uninstall|logout|sign\s*out|publish|deploy|pay|buy|checkout|subscribe|confirm\s+payment)\b|удал|стереть|очист|сброс|отозв|выйти|выход|опубликов|выкат|оплат|купить|подтвердить\s+платёж/i

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

/** The verbs a caller may script. Anything else is refused at parse time, never ignored. */
export const STEP_VERBS = Object.freeze(['goto', 'click', 'type', 'wait', 'shot', 'expect'])

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
      steps.push({ verb, selector: arg.slice(0, eq), text: arg.slice(eq + 1), raw })
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
  for (const o of observations.overflows ?? []) {
    findings.push({
      severity: BLOCKER,
      kind: 'overflow',
      detail: `content is ${o.scrollWidth}px wide in a ${o.clientWidth}px viewport (${o.viewport}) — the page scrolls sideways`,
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
 *          viewportsSkipped?:string[], streamsClosed?:number}} [coverage]
 * @returns {string}
 */
export function renderCoverage(coverage) {
  const declared = (c) =>
    Array.isArray(c?.viewportsSkipped) && c.viewportsSkipped.length
      ? `- Viewports NOT opened — the app declares a minimum width: ${c.viewportsSkipped.join(', ')}. This run says nothing about narrower screens.`
      : ''
  if (!coverage || coverage.ran === false) {
    return ['_The interactive surface was not swept — only the scripted path was walked._', declared(coverage)]
      .filter(Boolean)
      .join('\n')
  }
  const { touched = 0, total = 0, skipped = 0, refused = [], streamsClosed = 0 } = coverage
  const lines = [`- Interactive controls pressed: **${touched} of ${total}**`]
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
  if (!skipped && !refused.length) lines.push('- Nothing was left untouched.')
  return lines.join('\n')
}

export function renderReceipt({ url, steps = [], shots = [], findings = [], verdict: v, startedAt = '', coverage } = {}) {
  const bySeverity = (sev) => findings.filter((f) => f.severity === sev)
  const line = (f) => `- **${f.kind}** — ${f.detail}${f.occurrences > 1 ? ` _(seen ${f.occurrences}×)_` : ''}`
  const out = [
    '# Live UI run',
    '',
    `- URL: ${url}`,
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
