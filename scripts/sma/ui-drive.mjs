#!/usr/bin/env node
/**
 * ui-drive.mjs — open a running app, walk it, and write a receipt of what was seen.
 *
 * Usage:
 *   node scripts/sma/ui-drive.mjs <url> [step ...]
 *
 * Steps: goto:<path> | click:<visible text> | type:<selector>=<text>
 *        wait:<ms> | shot:<name> | expect:<visible text>
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
  SWEEP_CAP,
  VIEWPORTS,
  classify,
  isStreamClose,
  missingDriverMessage,
  parseSteps,
  renderReceipt,
  verdict,
  worstOverflow,
} from './lib/ui-drive.mjs'

/**
 * Press every control the page exposes and record what broke — the part of QA that is
 * mechanical, and therefore belongs to a script rather than to a model's attention span.
 *
 * Three things it refuses to do, each for a reason worth stating:
 *  - it will not press a destructive control (DESTRUCTIVE_RE); unattended data loss is
 *    not a price a review may pay on the operator's behalf
 *  - it will not pretend the cap does not exist; whatever it did not reach is counted
 *  - it will not leave the page somewhere else: after a click that navigated, it returns
 *    to the start URL, so control N+1 is pressed on the page it was found on
 *
 * @returns {Promise<{touched:number, total:number, skipped:number, refused:string[]}>}
 */
async function sweep(page, url, { deadControls, unnamedControls }) {
  const handles = await page.locator(INTERACTIVE_SELECTOR).all()
  const visible = []
  for (const h of handles) {
    if (await h.isVisible().catch(() => false)) visible.push(h)
  }

  const refused = []
  let touched = 0
  for (const el of visible) {
    if (touched >= SWEEP_CAP) break
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

  return { touched, total: visible.length, skipped: Math.max(0, visible.length - touched - refused.length), refused }
}

/**
 * open(page, target) — navigate, WITHOUT waiting for the network to fall silent.
 *
 * «networkidle» means «no connection for half a second», which an app that pushes live
 * updates never achieves: its channel is open for as long as the screen is. Every open of
 * such an app therefore timed out and was written down as a failed step — the tool declared
 * broken exactly the apps that work hardest. So the wait is for the page to EXIST and to have
 * painted something, and the stream is left alone to do its job.
 */
async function open(page, target, timeout = 20000) {
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout })
  // A single-page app paints after its first answer arrives; wait for ink, not for silence.
  await page
    .waitForFunction(() => Boolean(document.body) && document.body.innerText.trim().length > 0, { timeout: 8000 })
    .catch(() => {})
  await page.waitForTimeout(400)
}

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
  const positional = argv.filter((a, i) => a !== '--no-sweep' && a !== '--min-viewport' && !(mvIdx >= 0 && i === mvIdx + 1))
  const [url, ...stepArgv] = positional
  if (!url) {
    process.stdout.write('usage: node scripts/sma/ui-drive.mjs <url> [step ...] [--no-sweep] [--min-viewport <px>]\n')
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
  const shots = []
  let coverage = { ran: false }
  const stampViewportSkips = () => {
    if (skippedViewports.length) coverage = { ...coverage, viewportsSkipped: skippedViewports }
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
    page.on('request', (r) => startedAt.set(r, Date.now()))
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => pageErrors.push(e.message))
    page.on('requestfailed', (r) => {
      const began = startedAt.get(r)
      requestFailures.push({
        method: r.method(),
        url: r.url(),
        error: r.failure()?.errorText,
        resourceType: typeof r.resourceType === 'function' ? r.resourceType() : undefined,
        ageMs: typeof began === 'number' ? Date.now() - began : undefined,
        whileClosing: closing.has(page),
      })
    })
    page.on('response', (r) => {
      if (r.status() >= 400) httpErrors.push({ status: r.status(), method: r.request().method(), url: r.url() })
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

  const openedViewports = VIEWPORTS.filter((vp) => vp.width >= minViewport)
  const skippedViewports = VIEWPORTS.filter((vp) => vp.width < minViewport).map((vp) => `${vp.name} (${vp.width}px)`)

  try {
    // Every declared width gets opened, because a layout that breaks only on mobile is
    // still broken — unless the app declares it does not serve that width at all.
    for (const vp of openedViewports) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } })
      watch(page)
      try {
        await open(page, url)
      } catch (err) {
        stepFailures.push({ step: `open ${url} at ${vp.name}`, error: err.message.split('\n')[0] })
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

    // The scripted path is walked once, at desktop, where the operator's claim was made.
    if (parsed.steps.length) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      watch(page)
      await open(page, url).catch(() => {})
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
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      watch(page)
      await open(page, url).catch(() => {})
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
    { consoleErrors, pageErrors, requestFailures, httpErrors, stepFailures, deadControls, unnamedControls, overflows },
    { origin }
  )
  const v = verdict(findings, { ran: true })
  const receipt = renderReceipt({ url, steps: parsed.steps, shots, findings, verdict: v, startedAt, coverage })
  writeFileSync(join(outDir, 'RUN.md'), receipt)
  writeFileSync(join(outDir, 'run.json'), `${JSON.stringify({ url, startedAt, verdict: v, coverage, findings, shots }, null, 2)}\n`)

  process.stdout.write(`${receipt}\nReceipt: ${join(outDir, 'RUN.md')}\n`)
  process.exit(v.exitCode)
}

main().catch((err) => {
  // Failing loud is the whole point of this tool; a crash must not read as a clean run.
  process.stdout.write(`SMA ui-drive: NOT RUN — ${err.message}\n  This is not a pass.\n`)
  process.exit(3)
})
