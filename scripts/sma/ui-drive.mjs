#!/usr/bin/env node
/**
 * ui-drive.mjs — open a running app, walk it, and write a receipt of what was seen.
 *
 * Usage:
 *   node scripts/sma/ui-drive.mjs <url> [step ...] [--no-sweep] [--min-viewport <px>]
 *                                       [--at <desktop|tablet|mobile>]
 *
 * Steps: goto:<path> | click:<visible text> | type:<selector>=<text>
 *        wait:<ms> | shot:<name> | expect:<visible text>
 *
 * --at names the width the scripted path and the sweep are walked at (every width is opened
 *      and measured regardless); without it both walk the desktop, as they always have.
 *
 * Exit: 0 clean (or warnings only) · 1 blocking findings · 2 bad arguments
 *       3 NOT RUN — no browser driver, nothing was looked at
 *
 * ═══════════════════════ THE IMPURE HALF, KEPT THIN ══════════════════════════════
 * Everything decidable — step parsing, the severity rubric, the verdict, the receipt —
 * lives in lib/ui-drive.mjs under test. This file only drives a browser and writes
 * files, so the part that can be wrong about a verdict is the part a test can pin.
 *
 * ═══════════════════════ NO DEPENDENCY, NO PRETENDING ════════════════════════════
 * SMA ships with zero runtime dependencies and this does not change that: the browser
 * driver is resolved at RUN time, and when it is absent the run exits 3 with the one
 * install command that fixes it. What it must never do is what the old capture path
 * did — swallow the failure and let a code-only read be scored as if the UI had been
 * looked at. Absent driver is a status of its own, never an empty finding list.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  DESTRUCTIVE_RE,
  INTERACTIVE_SELECTOR,
  OVERFLOW_SCAN_DEPTH,
  OVERFLOW_SCAN_NODES,
  READY_CEILING_MS,
  READY_POLL_MS,
  READY_SETTLE_MS,
  STREAM_RESOURCE_TYPES,
  SWEEP_CAP,
  VIEWPORTS,
  classify,
  isStreamClose,
  missingDriverMessage,
  parseSteps,
  readiness,
  redactUrl,
  renderReceipt,
  resolveDriveViewport,
  sweepSparseNote,
  verdict,
  worstOverflow,
} from './lib/ui-drive.mjs'

/**
 * Press every control the page exposes and record what broke — the part of QA that is
 * mechanical, and therefore belongs to a script rather than to a model's attention span.
 *
 * One thing it refuses to CLAIM: that a control which left the screen before its turn is
 * broken. The list is made once, and on a screen where a press replaces the screen — a list
 * of tasks that opens a card — the rest of the list stops existing. Clicking a handle to a
 * node that is gone times out, and reporting that as a dead button is a blocker manufactured
 * by the order the sweep happens to walk in. So each control is checked to be STILL THERE
 * immediately before its press: gone ones are counted and named, present ones that still
 * cannot be operated are dead exactly as before.
 *
 * Three things it refuses to do, each for a reason worth stating:
 *  - it will not press a destructive control (DESTRUCTIVE_RE); unattended data loss is
 *    not a price a review may pay on the operator's behalf
 *  - it will not pretend the cap does not exist; whatever it did not reach is counted
 *  - it will not leave the page somewhere else: after a click that navigated, it returns
 *    to the start URL, so control N+1 is pressed on the page it was found on
 *
 * @returns {Promise<{touched:number, total:number, skipped:number, refused:string[], vanished:string[], sparse:string}>}
 */
async function sweep(page, url, { deadControls, unnamedControls }) {
  const handles = await page.locator(INTERACTIVE_SELECTOR).all()
  const visible = []
  for (const h of handles) {
    if (await h.isVisible().catch(() => false)) visible.push(h)
  }
  // The list is collected ONCE, so how much of the page it holds is the whole worth of the
  // sweep. A denominator this thin is stated in the receipt rather than left to look complete.
  const sparse = sweepSparseNote(visible.length)

  const refused = []
  const vanished = []
  let touched = 0
  for (const el of visible) {
    if (touched >= SWEEP_CAP) break
    // Still on the screen? A node the page has since thrown away cannot be pressed, and that
    // is a fact about the walk, not about the control.
    const present = await el.evaluate((e) => e.isConnected && e.getClientRects().length > 0).catch(() => false)
    if (!present) {
      vanished.push('(a control that was on the screen when the list was made)')
      continue
    }
    const name = (
      await el
        .evaluate((e) => {
          const t = e
          return (
            t.getAttribute('aria-label') ||
            (t.innerText || '').trim() ||
            t.getAttribute('title') ||
            t.getAttribute('placeholder') ||
            t.getAttribute('name') ||
            ''
          )
        })
        .catch(() => '')
    ).slice(0, 60)

    if (!name) {
      const tag = await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => 'element')
      unnamedControls.push({ tag, hint: 'no aria-label, text, title, placeholder or name' })
    }
    if (name && DESTRUCTIVE_RE.test(name)) {
      refused.push(name)
      continue
    }

    touched += 1
    try {
      await el.click({ timeout: 4000 })
      await page.waitForTimeout(250)
    } catch (err) {
      deadControls.push({ name: name || '(unnamed control)', error: err.message.split('\n')[0] })
    }
    if (page.url() !== url) await open(page, url, 15000).catch(() => {})
  }

  return {
    touched,
    total: visible.length,
    skipped: Math.max(0, visible.length - touched - refused.length - vanished.length),
    refused,
    vanished,
    sparse,
  }
}

/**
 * What each page is still waiting on. Channels are never entered here: a screen that holds one
 * open for its whole life is not «still loading», and waiting on it would bring back the
 * networkidle mistake this file already carries a paragraph about.
 */
const waitingOn = new WeakMap()
function callsOf(page) {
  let map = waitingOn.get(page)
  if (!map) {
    map = new Map()
    waitingOn.set(page, map)
  }
  return map
}

/**
 * How many answers this page is still waiting for. Age is deliberately NOT consulted: a door
 * that takes a minute is still a door, and the moment this counted long calls as channels the
 * sweep started measuring skeletons again. What is not waited for is decided by kind alone.
 */
function outstandingCalls(page) {
  return callsOf(page).size
}

/**
 * awaitReady(page) — sample the page until what it shows stops changing.
 *
 * The signature is deliberately crude and general: how many elements the page holds and how
 * long its text is. It needs no knowledge of the app under test, which is the point — a
 * readiness check that knows one window's markup measures that window and nothing else.
 * Sampling stops the moment the signature has held for READY_SETTLE_MS, so a fast page pays
 * about a second and no more; a slow door is waited out up to READY_CEILING_MS, and a page
 * that never settles returns `ready:false` for the caller to record as a finding.
 *
 * @returns {Promise<{ready:boolean, waitedMs:number, heldMs:number, ink:boolean, reason:string}>}
 */
async function awaitReady(page, { ceilingMs = READY_CEILING_MS, settleMs = READY_SETTLE_MS, pollMs = READY_POLL_MS } = {}) {
  const began = Date.now()
  const samples = []
  let state = readiness(samples, { settleMs })
  for (;;) {
    const snap = await page
      .evaluate(() => {
        const body = document.body
        const text = body ? (body.innerText || '').trim() : ''
        return { nodes: document.querySelectorAll('*').length, ink: text.length }
      })
      .catch(() => null)
    samples.push({
      at: Date.now(),
      signature: snap ? `${snap.nodes}:${snap.ink}` : 'unreadable',
      ink: Boolean(snap && snap.ink > 0),
      pending: outstandingCalls(page),
    })
    state = readiness(samples, { settleMs })
    if (state.ready || Date.now() - began >= ceilingMs) break
    await page.waitForTimeout(pollMs).catch(() => {})
  }
  return { ...state, waitedMs: Date.now() - began }
}

/**
 * open(page, target) — navigate, WITHOUT waiting for the network to fall silent.
 *
 * «networkidle» means «no connection for half a second», which an app that pushes live
 * updates never achieves: its channel is open for as long as the screen is. Every open of
 * such an app therefore timed out and was written down as a failed step — the tool declared
 * broken exactly the apps that work hardest. So the stream is left alone to do its job.
 *
 * What is waited for instead is the page HOLDING STILL (see awaitReady). It used to be the
 * first ink plus 400 ms, and on a window whose first answer takes sixteen seconds that meant
 * the overflow was measured, and the sweep's list of controls collected, on a page that had
 * barely started. Both then described nothing while reading like a clean result.
 *
 * @returns {Promise<{ready:boolean, waitedMs:number, heldMs:number, ink:boolean, reason:string}>}
 */
async function open(page, target, timeout = OPEN_TIMEOUT_MS) {
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout })
  return awaitReady(page)
}

/**
 * How long the DOCUMENT itself may take. It used to be twenty seconds, from before any of
 * this was measured. An app that computes a screen on its own single thread does not answer
 * anything at all while it is doing so — measured on the window this was written for: a page
 * asked for while the state call ran waited thirty-four seconds for plain HTML. Calling that
 * app broken is the same mistake as calling a streaming app broken for never falling silent.
 * A server that is actually dead still fails, just later and with the same words.
 */
const OPEN_TIMEOUT_MS = 90000

/** Screenshots are binaries: the run directory disowns them before the first capture. */
const SHOT_IGNORE = ['# Screenshots — never commit binary assets', '*.png', '*.webp', '*.jpg', '*.jpeg', '']

/**
 * Resolve a browser driver without declaring a dependency on one. Tries the packages a
 * project may already carry, in the order that costs least to import.
 *
 * SMA_UI_DRIVER points at a driver installed somewhere else — a global install, another
 * checkout, a shared tools folder. It exists so that wanting a live UI check never
 * forces a 120 MB dependency into a project that did not ask for one.
 *
 * @returns {Promise<{ok:true, chromium:object} | {ok:false, reason:string}>}
 */
async function resolveDriver() {
  const tried = []
  const external = process.env.SMA_UI_DRIVER
  // A pointed-at install is a FOLDER to a human and a module specifier to node, so both
  // the folder and its entry file are tried — the operator should not have to know which.
  const externalCandidates = external
    ? [pathToFileURL(join(external, 'index.js')).href, pathToFileURL(external).href, external]
    : []
  const candidates = [...externalCandidates, 'playwright', 'playwright-core', '@playwright/test']
  for (const pkg of candidates) {
    try {
      const mod = await import(pkg)
      const chromium = mod.chromium ?? mod.default?.chromium
      if (chromium) return { ok: true, chromium }
      tried.push(`${pkg} (no chromium export)`)
    } catch {
      tried.push(pkg)
    }
  }
  return { ok: false, reason: `not resolvable from this project: ${tried.join(', ')}` }
}

/** The driver hint, appended to the missing-driver message so both ways out are visible. */
function driverHint() {
  return process.env.SMA_UI_DRIVER
    ? `  SMA_UI_DRIVER is set to "${process.env.SMA_UI_DRIVER}" and did not resolve — check the path.`
    : '  Already have it elsewhere? Point at it: SMA_UI_DRIVER=/path/to/node_modules/playwright'
}

async function main() {
  const argv = process.argv.slice(2)
  const noSweep = argv.includes('--no-sweep')
  // --min-viewport <px>: the app DECLARES a minimum width (a deliberate design decision,
  // not a hole — e.g. «окно сделано под 1440 px и выше»). Widths below the declaration
  // are then a promise the product never made: opening them would fail a floor the design
  // explicitly waived. The skip is NAMED in the receipt — silent narrowing of coverage is
  // the exact sin this engine exists to prevent.
  const mvIdx = argv.indexOf('--min-viewport')
  const minViewport = mvIdx >= 0 ? Number(argv[mvIdx + 1]) : 0
  if (mvIdx >= 0 && (!Number.isFinite(minViewport) || minViewport <= 0)) {
    process.stdout.write('SMA ui-drive: --min-viewport needs a positive pixel number.\n')
    process.exit(2)
  }
  // --at <desktop|tablet|mobile>: the operator DECLARES the width the scripted path and the
  // sweep are walked at. Both used to be nailed to the desktop, so a claim about a narrow
  // screen could not be walked at all — the run opened the phone, measured it, and then went
  // and walked the path somewhere else. The width is a name from the frozen list, never a
  // pixel number: see resolveDriveViewport for why that restriction is the point.
  const atIdx = argv.indexOf('--at')
  let pathViewport = null
  if (atIdx >= 0) {
    const asked = resolveDriveViewport(argv[atIdx + 1])
    if (!asked.ok) {
      process.stdout.write(`SMA ui-drive: ${asked.reason}\n`)
      process.exit(2)
    }
    pathViewport = asked.viewport
  }
  // A declared minimum that cuts off the declared path is a contradiction, and the run refuses
  // it out loud. Walking the path somewhere else instead — or quietly not walking it — would
  // hand back a receipt for a path nobody took, and a run that did not happen is never a pass.
  if (pathViewport && minViewport > pathViewport.width) {
    process.stdout.write(
      `SMA ui-drive: --at ${pathViewport.name} (${pathViewport.width}px) is below --min-viewport ${minViewport} — ` +
        'the width you asked the path to walk is the one you declared the app does not serve. Nothing was run.\n'
    )
    process.exit(2)
  }
  const positional = argv.filter(
    (a, i) =>
      a !== '--no-sweep' &&
      a !== '--min-viewport' &&
      a !== '--at' &&
      !(mvIdx >= 0 && i === mvIdx + 1) &&
      !(atIdx >= 0 && i === atIdx + 1)
  )
  const [url, ...stepArgv] = positional
  if (!url) {
    process.stdout.write(
      'usage: node scripts/sma/ui-drive.mjs <url> [step ...] [--no-sweep] [--min-viewport <px>] [--at <desktop|tablet|mobile>]\n'
    )
    process.exit(2)
  }

  const parsed = parseSteps(stepArgv)
  if (!parsed.ok) {
    process.stdout.write(`SMA ui-drive: bad steps — nothing was run.\n${parsed.errors.map((e) => `  - ${e}`).join('\n')}\n`)
    process.exit(2)
  }

  const driver = await resolveDriver()
  if (!driver.ok) {
    process.stdout.write(`${missingDriverMessage(driver.reason)}\n${driverHint()}\n`)
    process.exit(3)
  }

  const startedAt = new Date().toISOString()
  const outDir = join('.planning', 'ui-reviews', `run-${startedAt.replace(/[:.]/g, '-')}`)
  mkdirSync(outDir, { recursive: true })
  if (!existsSync(join(outDir, '.gitignore'))) writeFileSync(join(outDir, '.gitignore'), SHOT_IGNORE.join('\n'))

  let browser
  try {
    browser = await driver.chromium.launch()
  } catch (err) {
    // A stale browser cache lands here — the same install command is the fix, and the
    // run is still NOT RUN rather than an empty pass.
    process.stdout.write(`${missingDriverMessage(`browser will not launch — ${err.message.split('\n')[0]}`)}\n`)
    process.exit(3)
  }

  const consoleErrors = []
  const pageErrors = []
  const requestFailures = []
  const httpErrors = []
  const stepFailures = []
  const deadControls = []
  const unnamedControls = []
  const overflows = []
  const notSettled = []
  const shots = []
  /** Record a page that never stopped changing, naming WHERE it happened. */
  const noteReadiness = (where, state) => {
    if (state && state.ready === false) notSettled.push({ where, waitedMs: state.waitedMs, reason: state.reason })
  }
  let coverage = { ran: false }
  const stampViewportSkips = () => {
    if (skippedViewports.length) coverage = { ...coverage, viewportsSkipped: skippedViewports }
    // A declared width goes into the receipt, so «the path was walked on a phone» is a fact a
    // reader can check rather than a word they have to take.
    if (pathViewport) coverage = { ...coverage, pathViewport }
  }
  const origin = (() => {
    try {
      return new URL(url).origin
    } catch {
      return ''
    }
  })()

  // Pages the driver is deliberately shutting down. An abort that arrives while a page is
  // closing is the CLOSE, and the receipt must be able to tell the two apart.
  const closing = new WeakSet()


  /** Wire one page to the collectors, so no viewport observes less than another. */
  const watch = (page) => {
    // When each request STARTED — a channel held open for the life of the screen is told
    // apart from an ordinary call by how long it lived, not by its name.
    const startedAt = new WeakMap()
    const calls = callsOf(page)
    page.on('request', (r) => {
      startedAt.set(r, Date.now())
      const type = typeof r.resourceType === 'function' ? r.resourceType() : ''
      if (!STREAM_RESOURCE_TYPES.includes(type)) calls.set(r, { at: Date.now(), type })
    })
    page.on('requestfinished', (r) => calls.delete(r))
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => pageErrors.push(e.message))
    page.on('requestfailed', (r) => {
      calls.delete(r)
      const began = startedAt.get(r)
      requestFailures.push({
        method: r.method(),
        // redacted at the point of RECORDING, not at the point of printing: this object is
        // written to the run journal as well as rendered, and a credential removed in only
        // one of the two places is a credential still published
        url: redactUrl(r.url()),
        error: r.failure()?.errorText,
        resourceType: typeof r.resourceType === 'function' ? r.resourceType() : undefined,
        ageMs: typeof began === 'number' ? Date.now() - began : undefined,
        whileClosing: closing.has(page),
      })
    })
    page.on('response', (r) => {
      if (r.status() >= 400) httpErrors.push({ status: r.status(), method: r.request().method(), url: redactUrl(r.url()) })
    })
  }

  /** Close a page as an ANNOUNCED close, so the streams it was holding are not mourned. */
  const closePage = async (page) => {
    closing.add(page)
    await page.close()
  }

  const capture = async (page, name) => {
    const file = `${name}.png`
    await page.screenshot({ path: join(outDir, file) })
    shots.push(join(outDir, file))
  }

  // Without --at the path and the sweep walk exactly where they always did: 1440×900.
  const walkViewport = pathViewport ? { width: pathViewport.width, height: pathViewport.height } : { width: 1440, height: 900 }
  const openedViewports = VIEWPORTS.filter((vp) => vp.width >= minViewport)
  const skippedViewports = VIEWPORTS.filter((vp) => vp.width < minViewport).map((vp) => `${vp.name} (${vp.width}px)`)

  try {
    // Every declared width gets opened, because a layout that breaks only on mobile is
    // still broken — unless the app declares it does not serve that width at all.
    for (const vp of openedViewports) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } })
      watch(page)
      try {
        noteReadiness(`${vp.name} (${vp.width}px)`, await open(page, url))
      } catch (err) {
        // the address rides INSIDE a finding's prose here, which is the shape a redaction
        // at the printing edge would have missed entirely
        stepFailures.push({ step: `open ${redactUrl(url)} at ${vp.name}`, error: err.message.split('\n')[0] })
      }
      // Measured, not judged: a box holding more content than it can show means part of the
      // screen lies past the edge. The document is only the FIRST box measured — a window may
      // carry its minimum width on a container INSIDE the page, and then the document measures
      // perfectly clean while most of the screen is off it (see OVERFLOW_SCAN_DEPTH).
      const boxes = await page
        .evaluate(
          ({ maxDepth, maxNodes }) => {
            const name = (el) => {
              const tag = el.tagName.toLowerCase()
              if (el.id) return `${tag}#${el.id}`
              const cls = String(el.getAttribute('class') || '')
                .trim()
                .split(/\s+/)[0]
              return cls ? `${tag}.${cls}` : tag
            }
            const out = []
            const visit = (el, depth) => {
              if (depth > maxDepth || out.length >= maxNodes) return
              const overflowX = getComputedStyle(el).overflowX
              out.push({
                element: name(el),
                scrollWidth: el.scrollWidth,
                clientWidth: el.clientWidth,
                scrollable: overflowX === 'auto' || overflowX === 'scroll',
              })
              for (const child of el.children) visit(child, depth + 1)
            }
            visit(document.documentElement, 0)
            return out
          },
          { maxDepth: OVERFLOW_SCAN_DEPTH, maxNodes: OVERFLOW_SCAN_NODES }
        )
        .catch(() => null)
      const worst = worstOverflow(boxes ?? [], { viewport: vp.name })
      if (worst) overflows.push(worst)
      await capture(page, `01-open-${vp.name}`)
      await closePage(page)
    }

    // The scripted path is walked once — at desktop, where an operator's claim is usually
    // made, or at the width the operator declared with --at when the claim is about that one.
    if (parsed.steps.length) {
      const page = await browser.newPage({ viewport: walkViewport })
      watch(page)
      noteReadiness('the scripted path', await open(page, url).catch(() => null))
      let n = 1
      for (const step of parsed.steps) {
        const label = String(++n).padStart(2, '0')
        try {
          if (step.verb === 'goto') await open(page, new URL(step.arg, url).toString())
          else if (step.verb === 'click') await page.getByText(step.arg, { exact: false }).first().click({ timeout: 8000 })
          else if (step.verb === 'type') await page.fill(step.selector, step.text, { timeout: 8000 })
          else if (step.verb === 'wait') await page.waitForTimeout(step.ms)
          else if (step.verb === 'shot') await capture(page, `${label}-${step.arg.replace(/[^\w-]+/g, '_')}`)
          else if (step.verb === 'key') await page.keyboard.press(step.arg)
          else if (step.verb === 'expect') await page.getByText(step.arg, { exact: false }).first().waitFor({ timeout: 8000 })
          if (step.verb !== 'shot' && step.verb !== 'wait') {
            await page.waitForTimeout(400)
            await capture(page, `${label}-${step.verb}`)
          }
        } catch (err) {
          stepFailures.push({ step: step.raw, error: err.message.split('\n')[0] })
          await capture(page, `${label}-FAILED`)
        }
      }
      await closePage(page)
    }

    // The sweep runs LAST, on its own page: it presses things and navigates, and the
    // scripted path's verdict must not depend on wreckage the sweep left behind.
    if (!noSweep) {
      const page = await browser.newPage({ viewport: walkViewport })
      watch(page)
      // The sweep collects its list of controls ONCE, immediately after this open — so if the
      // page is not ready here, the denominator is whatever the shell painted first.
      noteReadiness('the sweep', await open(page, url).catch(() => null))
      coverage = { ran: true, ...(await sweep(page, url, { deadControls, unnamedControls })) }
      await capture(page, '99-after-sweep')
      await closePage(page)
    }
  } finally {
    await browser.close()
  }

  stampViewportSkips() // both paths — a declared skip is receipt material with or without a sweep
  // What was NOT counted as a failure is named out loud: a tool that quietly forgives things
  // is how a receipt starts meaning less than it says.
  const streamsClosed = requestFailures.filter((f) => isStreamClose(f)).length
  if (streamsClosed) coverage = { ...coverage, streamsClosed }
  const findings = classify(
    {
      consoleErrors,
      pageErrors,
      requestFailures,
      httpErrors,
      stepFailures,
      deadControls,
      unnamedControls,
      overflows,
      notSettled,
    },
    { origin }
  )
  const v = verdict(findings, { ran: true })
  const receipt = renderReceipt({ url, steps: parsed.steps, shots, findings, verdict: v, startedAt, coverage })
  writeFileSync(join(outDir, 'RUN.md'), receipt)
  // BOTH HALVES OF THE RECEIPT, OR NEITHER. The prose and the machine-readable journal are
  // one artifact in two files, and they are committed together; redacting only the prose
  // would leave the credential sitting in the JSON right beside it.
  writeFileSync(
    join(outDir, 'run.json'),
    `${JSON.stringify({ url: redactUrl(url), startedAt, verdict: v, coverage, findings, shots }, null, 2)}\n`,
  )

  process.stdout.write(`${receipt}\nReceipt: ${join(outDir, 'RUN.md')}\n`)
  process.exit(v.exitCode)
}

main().catch((err) => {
  // Failing loud is the whole point of this tool; a crash must not read as a clean run.
  process.stdout.write(`SMA ui-drive: NOT RUN — ${err.message}\n  This is not a pass.\n`)
  process.exit(3)
})
