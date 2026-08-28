/**
 * Tests for scripts/sma/lib/ui-drive.mjs (the live UI run: step parsing, the
 * severity rubric, the verdict, the receipt).
 *
 * The load-bearing behaviors — every one of them guards the same law: A RUN THAT
 * DID NOT HAPPEN IS NEVER A PASS. The capture path this replaces failed silently
 * (`npx playwright screenshot ... 2>/dev/null`) and let a code-only read be scored
 * as if the UI had been looked at, which is why these are pinned:
 *   Test 1 — parseSteps: a valid script parses; an UNKNOWN verb is an error, not a
 *            skip (a silently dropped step turns an unrun check into a green one).
 *   Test 2 — classify: the rubric — page exception / failed request / same-origin
 *            4xx / any 5xx / failed step BLOCK; cross-origin 4xx and a console
 *            error WARN.
 *   Test 3 — classify drops the browser's own echo of a failed fetch, so one defect
 *            is one line rather than two.
 *   Test 4 — dedupe: a defect observed once per viewport collapses to one finding
 *            that KEEPS its occurrence count.
 *   Test 5 — verdict: blockers FAIL with exit 1; warnings alone still PASS with 0;
 *            and ran:false is NOT-RUN with exit 3 — never an empty pass.
 *   Test 6 — missingDriverMessage carries the install command, because a diagnosis
 *            the operator cannot act on costs the same as no diagnosis.
 *   Test 7 — renderReceipt states the path walked and both severity lists.
 *
 * Zero fs, zero browser — the impure half lives in the runner and is not imported.
 */

import { describe, it, expect } from 'vitest'
import {
  BLOCKER,
  DESTRUCTIVE_RE,
  READY_CEILING_MS,
  READY_SETTLE_MS,
  STREAM_RESOURCE_TYPES,
  SWEEP_CAP,
  WARNING,
  classify,
  dedupe,
  isStreamClose,
  missingDriverMessage,
  parseSteps,
  readiness,
  redactUrl,
  renderCoverage,
  renderReceipt,
  resolveDriveViewport,
  sweepSparseNote,
  verdict,
  worstOverflow,
} from '../lib/ui-drive.mjs'

describe('parseSteps', () => {
  it('parses every verb shape', () => {
    const r = parseSteps([
      'click:Save',
      'type:#email=a@b.c',
      'wait:500',
      'shot:after',
      'expect:Done',
      'goto:/inbox',
      'key:Control+K',
    ])
    expect(r.ok).toBe(true)
    expect(r.steps.map((s: { verb: string }) => s.verb)).toEqual([
      'click',
      'type',
      'wait',
      'shot',
      'expect',
      'goto',
      'key',
    ])
    // Комбинация едет драйверу как написана: разбирать её здесь значило бы завести второй
    // словарь имён клавиш рядом с тем, который уже есть у драйвера.
    expect(r.steps[6]).toMatchObject({ arg: 'Control+K' })
    expect(r.steps[1]).toMatchObject({ selector: '#email', text: 'a@b.c' })
    expect(r.steps[2]).toMatchObject({ ms: 500 })
  })

  it('refuses an unknown verb instead of skipping it', () => {
    const r = parseSteps(['click:Save', 'clik:Save'])
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('unknown verb "clik"')
  })

  it('refuses a malformed step rather than guessing', () => {
    expect(parseSteps(['type:#email']).ok).toBe(false)
    expect(parseSteps(['wait:soon']).ok).toBe(false)
    expect(parseSteps(['justtext']).ok).toBe(false)
  })
})

describe('classify — the severity rubric', () => {
  const origin = 'http://localhost:5173'

  it('blocks on a page exception, a failed request, and a failed step', () => {
    const f = classify(
      {
        pageErrors: ['x is not a function'],
        requestFailures: [{ method: 'GET', url: `${origin}/api/state`, error: 'net::ERR_FAILED' }],
        stepFailures: [{ step: 'click:Save', error: 'element not found' }],
      },
      { origin }
    )
    expect(f).toHaveLength(3)
    expect(f.every((x: { severity: string }) => x.severity === BLOCKER)).toBe(true)
  })

  it('blocks a same-origin 4xx and any 5xx, but only warns on a foreign 4xx', () => {
    const f = classify(
      {
        httpErrors: [
          { status: 404, method: 'GET', url: `${origin}/api/state` },
          { status: 404, method: 'GET', url: 'https://cdn.example.com/pixel.gif' },
          { status: 503, method: 'GET', url: 'https://cdn.example.com/app.js' },
        ],
      },
      { origin }
    )
    expect(f.find((x: { detail: string }) => x.detail.includes('/api/state'))?.severity).toBe(BLOCKER)
    expect(f.find((x: { detail: string }) => x.detail.includes('pixel.gif'))?.severity).toBe(WARNING)
    expect(f.find((x: { detail: string }) => x.detail.includes('app.js'))?.severity).toBe(BLOCKER)
  })

  it('drops the browser echo of a failed fetch so one defect is one line', () => {
    const f = classify(
      {
        httpErrors: [{ status: 404, method: 'GET', url: `${origin}/api/state` }],
        consoleErrors: ['Failed to load resource: the server responded with a status of 404 (Not Found)', 'TypeError: real bug'],
      },
      { origin }
    )
    expect(f).toHaveLength(2)
    expect(f.filter((x: { kind: string }) => x.kind === 'console-error')).toHaveLength(1)
    expect(f.find((x: { kind: string }) => x.kind === 'console-error')?.detail).toContain('real bug')
  })
})

describe('the sweep — pressing everything, safely', () => {
  it('refuses destructive controls in both languages the operator may see', () => {
    for (const name of ['Delete account', 'Remove', 'Reset settings', 'Sign out', 'Publish', 'Pay now', 'Удалить проект', 'Очистить', 'Выкат', 'Выйти']) {
      expect(DESTRUCTIVE_RE.test(name), `${name} must be refused`).toBe(true)
    }
  })

  it('refuses the control that starts the machine — the sweep may not switch the engine on', () => {
    for (const name of [
      'Включить конвейер',
      'Выключить конвейер',
      'ВКЛЮЧИТЬ КОНВЕЙЕР',
      'Enable pipeline',
      'Disable pipeline',
      'Start engine',
    ]) {
      expect(DESTRUCTIVE_RE.test(name), `${name} must be refused`).toBe(true)
    }
  })

  it('refuses approval — a draft accepted by the sweep is a decision nobody made', () => {
    for (const name of ['Одобрить', 'Одобряем…', 'Одобрить черновик', 'Принять', 'Принимаем…', 'Approve', 'Approve draft', 'Accept']) {
      expect(DESTRUCTIVE_RE.test(name), `${name} must be refused`).toBe(true)
    }
  })

  it('presses ordinary controls, including words that merely contain a risky substring', () => {
    for (const name of [
      'Save',
      'Задачи',
      'Open backlog',
      'Next',
      'Undelete',
      // «Конвейер памяти» merely carries the word: refusing it would hide an ordinary
      // control from the sweep to guard a switch that is not there.
      'Конвейер памяти',
      'Ранее принятый черновик',
      'Acceptance criteria',
      'Approved runs',
    ]) {
      expect(DESTRUCTIVE_RE.test(name), `${name} must be pressed`).toBe(false)
    }
  })

  it('blocks a control that could not be operated and warns on one nobody can name', () => {
    const f = classify({
      deadControls: [{ name: 'Save', error: 'element is not enabled' }],
      unnamedControls: [{ tag: 'button', hint: 'no aria-label, text, title, placeholder or name' }],
    })
    expect(f.find((x: { kind: string }) => x.kind === 'control-dead')?.severity).toBe(BLOCKER)
    expect(f.find((x: { kind: string }) => x.kind === 'control-unnamed')?.severity).toBe(WARNING)
  })

  it('blocks sideways scroll, and reports it as the measurement it is', () => {
    const f = classify({ overflows: [{ scrollWidth: 1360, clientWidth: 375, viewport: 'mobile' }] })
    expect(f[0].severity).toBe(BLOCKER)
    expect(f[0].detail).toContain('1360px')
    expect(f[0].detail).toContain('375px')
  })
})

/**
 * The measurement used to look at the DOCUMENT only, and a window that carries its minimum
 * width on a container inside the page therefore measured clean at phone width while most
 * of the screen lay past the edge. A check that is green before the fix and green after it
 * is not a gate: it manufactures confidence. These pin the fix.
 */
describe('worstOverflow — the offender is found where the content is, not where the document is', () => {
  it('finds a container wider than its own visible width, even when the document is clean', () => {
    const worst = worstOverflow(
      [
        { element: 'html', scrollWidth: 375, clientWidth: 375, scrollable: false },
        { element: 'body', scrollWidth: 375, clientWidth: 375, scrollable: false },
        { element: 'div#root', scrollWidth: 1360, clientWidth: 375, scrollable: true },
      ],
      { viewport: 'mobile' }
    )
    expect(worst).toMatchObject({ element: 'div#root', scrollWidth: 1360, clientWidth: 375, viewport: 'mobile' })
  })

  it('reports the widest offender once, not every box it drags along with it', () => {
    const worst = worstOverflow(
      [
        { element: 'html', scrollWidth: 900, clientWidth: 375 },
        { element: 'div#root', scrollWidth: 1360, clientWidth: 375 },
        { element: 'div.table', scrollWidth: 500, clientWidth: 375 },
      ],
      { viewport: 'mobile' }
    )
    expect(worst?.element).toBe('div#root')
  })

  it('says nothing at all about a page where every box fits — no false alarm', () => {
    expect(
      worstOverflow(
        [
          { element: 'html', scrollWidth: 1440, clientWidth: 1440 },
          { element: 'div#root', scrollWidth: 1440, clientWidth: 1440 },
          // Sub-pixel rounding is not a defect: the threshold is a whole pixel.
          { element: 'div.card', scrollWidth: 301, clientWidth: 300 },
        ],
        { viewport: 'desktop' }
      )
    ).toBeNull()
  })

  it('does not judge a box that has no visible width to be wider than', () => {
    expect(worstOverflow([{ element: 'head', scrollWidth: 0, clientWidth: 0 }], { viewport: 'mobile' })).toBeNull()
  })

  it('names the element and how much lies past the edge, so the finding can be acted on', () => {
    const f = classify({
      overflows: [{ element: 'div#root', scrollWidth: 1360, clientWidth: 375, scrollable: true, viewport: 'mobile' }],
    })
    expect(f[0].severity).toBe(BLOCKER)
    expect(f[0].detail).toContain('div#root')
    expect(f[0].detail).toContain('985px')
    expect(f[0].detail).toContain('mobile')
  })

  it('tells apart content reached by dragging and content that cannot be reached at all', () => {
    const scrolls = classify({
      overflows: [{ element: 'div#root', scrollWidth: 1360, clientWidth: 375, scrollable: true, viewport: 'mobile' }],
    })
    const clipped = classify({
      overflows: [{ element: 'div#root', scrollWidth: 1360, clientWidth: 375, scrollable: false, viewport: 'mobile' }],
    })
    expect(scrolls[0].detail).toContain('dragging')
    expect(clipped[0].detail).toContain('cannot be reached at all')
  })
})

describe('renderCoverage — the denominator is never hidden', () => {
  it('names what it did not reach rather than reporting only what it touched', () => {
    const md = renderCoverage({ ran: true, touched: SWEEP_CAP, total: 60, skipped: 18, refused: ['Удалить'] })
    expect(md).toContain(`${SWEEP_CAP} of 60`)
    expect(md).toContain('18 were NOT pressed')
    expect(md).toContain('refused as destructive')
    expect(md).toContain('Удалить')
  })

  it('says plainly when the surface was never swept, instead of printing a zero', () => {
    const md = renderCoverage({ ran: false })
    expect(md).toContain('not swept')
    expect(md).not.toMatch(/\b0 of 0\b/)
  })

  it('claims full coverage only when nothing was left out', () => {
    expect(renderCoverage({ ran: true, touched: 12, total: 12, skipped: 0, refused: [] })).toContain('Nothing was left untouched')
  })

  it('records the width the path was walked at, when the operator declared one', () => {
    const md = renderCoverage({
      ran: true,
      touched: 5,
      total: 5,
      skipped: 0,
      refused: [],
      pathViewport: { name: 'mobile', width: 375, height: 812 },
    })
    expect(md).toContain('walked at')
    expect(md).toContain('mobile (375×812)')
  })

  it('says nothing about the path width when none was declared — the default receipt is unchanged', () => {
    expect(renderCoverage({ ran: true, touched: 5, total: 5, skipped: 0, refused: [] })).not.toContain('walked at')
    expect(renderCoverage({ ran: false })).not.toContain('walked at')
  })

  it('names viewports skipped by a declared minimum width — a waiver is visible, never silent', () => {
    const md = renderCoverage({ ran: true, touched: 5, total: 5, skipped: 0, refused: [], viewportsSkipped: ['tablet (768px)', 'mobile (375px)'] })
    expect(md).toContain('declares a minimum width')
    expect(md).toContain('tablet (768px)')
    expect(md).toContain('nothing about narrower screens')
  })
})

/**
 * A claim about a narrow screen has to be walked on a narrow screen. The path and the sweep
 * used to be nailed to the desktop, so a run could open the phone, measure it, and then walk
 * the path somewhere else entirely — and the receipt said nothing about the difference.
 */
/**
 * READINESS. A run used to open a page, wait for the first ink plus 400 ms, and measure. On
 * a window whose first answer takes sixteen seconds that is an empty page: «no overflow»
 * was then true because there was nothing to overflow, and the sweep collected its whole
 * list of controls before the screen existed — one real run reported «1 of 1 · nothing was
 * left untouched» on a screen holding about two dozen of them. Both numbers read like
 * results. Neither was about the app.
 */
describe('readiness — a page is measured when it has stopped changing, not when it first blinks', () => {
  const sample = (at: number, signature: string, ink = true) => ({ at, signature, ink })

  it('calls a page ready once what it shows has held still long enough', () => {
    const r = readiness([sample(0, 'a'), sample(250, 'a'), sample(500, 'a'), sample(1000, 'a')])
    expect(r.ready).toBe(true)
    expect(r.heldMs).toBeGreaterThanOrEqual(READY_SETTLE_MS)
    expect(r.reason).toBe('')
  })

  it('refuses a page that is still growing, and says how briefly it held still', () => {
    const r = readiness([sample(0, '10:20'), sample(250, '40:300'), sample(500, '210:1800')])
    expect(r.ready).toBe(false)
    expect(r.reason).toContain('held still for only')
  })

  it('refuses a painted-nothing page even when it has been unchanged for ages — an empty page changes least of all', () => {
    const r = readiness([sample(0, '3:0', false), sample(2000, '3:0', false), sample(4000, '3:0', false)])
    expect(r.ready).toBe(false)
    expect(r.reason).toContain('nothing was painted')
  })

  it('is not ready when nothing was sampled at all, instead of assuming the best', () => {
    const r = readiness([])
    expect(r.ready).toBe(false)
    expect(r.reason).toContain('never sampled')
  })

  it('a page that came alive late is ready — it is the stillness that counts, not the wait', () => {
    const r = readiness([sample(0, '3:0', false), sample(8000, '900:4200'), sample(9000, '900:4200'), sample(9600, '900:4200')])
    expect(r.ready).toBe(true)
    expect(r.waitedMs).toBe(9600)
  })

  /**
   * The case that made stillness alone insufficient, and it was measured rather than argued:
   * on the window this was written for the shell paints one control and then holds perfectly
   * still for thirty-one seconds while its first state call runs. Read as ready, that skeleton
   * hands back «1 of 1, nothing left untouched» for a screen that turned out to carry sixteen
   * controls. So a page still waiting on a call of its own is not ready, however still it is.
   */
  it('refuses a skeleton that holds still while it is still waiting on its own call', () => {
    const r = readiness([
      { at: 0, signature: '26:139', ink: true, pending: 1 },
      { at: 4000, signature: '26:139', ink: true, pending: 1 },
      { at: 8000, signature: '26:139', ink: true, pending: 1 },
    ])
    expect(r.ready).toBe(false)
    expect(r.reason).toContain('still waiting on 1 call')
  })

  it('calls the same page ready the moment its answer arrives and the picture settles', () => {
    const r = readiness([
      { at: 0, signature: '26:139', ink: true, pending: 1 },
      { at: 31000, signature: '76:872', ink: true, pending: 0 },
      { at: 32250, signature: '76:872', ink: true, pending: 0 },
    ])
    expect(r.ready).toBe(true)
  })

  it('a channel is told apart by KIND, never by how long it has been open', () => {
    expect(STREAM_RESOURCE_TYPES).toContain('eventsource')
    expect(STREAM_RESOURCE_TYPES).toContain('websocket')
    // Measured, not preferred: the door of the window this was written for grew from sixteen
    // seconds to forty-six in one afternoon. Any fixed «open this long means it is a channel»
    // number is eventually overtaken by an honest answer, and the sweep goes back to measuring
    // a skeleton. The ceiling — the one number left — must be able to outlast such a door.
    expect(READY_CEILING_MS).toBeGreaterThan(60000)
  })

  it('a page that never settled is a BLOCKING finding that names where and how long — never a quiet pass', () => {
    const findings = classify({
      notSettled: [{ where: 'mobile (375px)', waitedMs: 25000, reason: 'after 25000 ms what the page shows had held still for only 250 ms' }],
    })
    const f = findings.find((x: { kind: string }) => x.kind === 'page-not-settled')
    expect(f?.severity).toBe(BLOCKER)
    expect(f?.detail).toContain('mobile (375px)')
    expect(f?.detail).toContain('25s')
    expect(f?.detail).toContain('still loading')
    expect(verdict(findings, { ran: true })).toMatchObject({ status: 'FAIL', exitCode: 1 })
  })

  it('a settled page adds nothing — the receipt of a healthy run is unchanged', () => {
    expect(classify({ notSettled: [] })).toEqual([])
  })
})

describe('the sweep denominator — thin coverage may not wear the shape of full coverage', () => {
  it('names a page where a single control was found, instead of reporting 1 of 1', () => {
    const note = sweepSparseNote(1)
    expect(note).toContain('Only 1 interactive control')
    expect(note).toContain('nearly none')
  })

  it('says plainly when nothing at all was found — an empty denominator is not a complete one', () => {
    expect(sweepSparseNote(0)).toContain('says nothing about the surface')
  })

  it('stays silent on an ordinary page — this is a warning, not a running commentary', () => {
    expect(sweepSparseNote(2)).toBe('')
    expect(sweepSparseNote(26)).toBe('')
  })

  it('the coverage carrying a thin denominator prints it and drops the claim of completeness', () => {
    const md = renderCoverage({ ran: true, touched: 1, total: 1, skipped: 0, refused: [], sparse: sweepSparseNote(1) })
    expect(md).toContain('pressed: **1 of 1**')
    expect(md).toContain('Only 1 interactive control')
    expect(md).not.toContain('Nothing was left untouched')
  })

  it('a control that left the screen before its turn is counted and named, not called dead', () => {
    const md = renderCoverage({
      ran: true,
      touched: 17,
      total: 20,
      skipped: 0,
      refused: [],
      vanished: ['(a control that was on the screen when the list was made)', '(another)'],
    })
    expect(md).toContain('2 were gone before their turn')
    expect(md).toContain('says nothing about them')
    expect(md).not.toContain('Nothing was left untouched')
  })

  it('a full sweep still says nothing was left untouched — the old receipt is not disturbed', () => {
    const md = renderCoverage({ ran: true, touched: 26, total: 26, skipped: 0, refused: [] })
    expect(md).toContain('Nothing was left untouched.')
  })
})

describe('resolveDriveViewport — the path may be walked only where the run already measures', () => {
  it('gives the phone its frozen size', () => {
    expect(resolveDriveViewport('mobile')).toMatchObject({ ok: true, viewport: { name: 'mobile', width: 375, height: 812 } })
    expect(resolveDriveViewport('desktop')).toMatchObject({ ok: true, viewport: { width: 1440, height: 900 } })
  })

  it('refuses an unknown name and NAMES what would have been accepted', () => {
    const r = resolveDriveViewport('phone')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('phone')
    expect(r.reason).toContain('mobile (375px)')
    expect(r.reason).toContain('desktop (1440px)')
  })

  it('refuses a missing value rather than quietly walking somewhere else', () => {
    for (const bad of [undefined, '', '   ', '375']) {
      const r = resolveDriveViewport(bad as string)
      expect(r.ok, `${String(bad)} must be refused`).toBe(false)
      expect(r.reason).toContain('mobile (375px)')
    }
  })
})

describe('dedupe', () => {
  it('collapses a repeat observation but keeps the count', () => {
    const out = dedupe([
      { severity: BLOCKER, kind: 'http-error', detail: '404 GET /api/state' },
      { severity: BLOCKER, kind: 'http-error', detail: '404 GET /api/state' },
      { severity: BLOCKER, kind: 'http-error', detail: '404 GET /api/events' },
    ])
    expect(out).toHaveLength(2)
    expect(out[0].occurrences).toBe(2)
    expect(out[1].occurrences).toBe(1)
  })
})

describe('verdict', () => {
  it('fails on a blocker and passes on warnings alone', () => {
    expect(verdict([{ severity: BLOCKER }])).toMatchObject({ status: 'FAIL', exitCode: 1, blockers: 1 })
    expect(verdict([{ severity: WARNING }])).toMatchObject({ status: 'PASS-WITH-WARNINGS', exitCode: 0 })
    expect(verdict([])).toMatchObject({ status: 'PASS', exitCode: 0 })
  })

  it('reports a run that never happened as NOT-RUN, never as an empty pass', () => {
    const v = verdict([], { ran: false })
    expect(v.status).toBe('NOT-RUN')
    expect(v.exitCode).toBe(3)
    expect(v.status).not.toBe('PASS')
  })
})

describe('missingDriverMessage', () => {
  it('says it is not a pass and carries the command that fixes it', () => {
    const msg = missingDriverMessage('not resolvable')
    expect(msg).toContain('NOT RUN')
    expect(msg).toContain('not a pass')
    expect(msg).toContain('npx playwright install chromium')
  })
})

describe('renderReceipt', () => {
  it('states the path walked and both severity lists', () => {
    const md = renderReceipt({
      url: 'http://localhost:5173',
      steps: [{ raw: 'click:Save' }],
      shots: ['run/01-open-desktop.png'],
      findings: [
        { severity: BLOCKER, kind: 'http-error', detail: '404 GET /api/state', occurrences: 5 },
        { severity: WARNING, kind: 'console-error', detail: 'deprecation notice', occurrences: 1 },
      ],
      verdict: verdict([{ severity: BLOCKER }, { severity: WARNING }]),
    })
    expect(md).toContain('click:Save')
    expect(md).toContain('404 GET /api/state')
    expect(md).toContain('seen 5×')
    expect(md).toContain('deprecation notice')
    expect(md).toContain('**FAIL**')
  })

  it('says so plainly when no steps were scripted', () => {
    const md = renderReceipt({ url: 'http://x', verdict: verdict([]) })
    expect(md).toContain('no steps were scripted')
  })
})

/**
 * A live-updates app holds a channel open for the life of its screen, and closing the page
 * aborts it. Counting that as a failed request handed a permanent FAIL to exactly the apps
 * that work — the tool's own failure class, turned inward (found by the live run of 13.08,
 * where one screen collected 24 of them and the verdict said nothing about the screen).
 */
describe('isStreamClose — a stream ending with its page is a close, not a failure', () => {
  it('forgives an aborted event stream, whatever its age', () => {
    expect(isStreamClose({ error: 'net::ERR_ABORTED', resourceType: 'eventsource' })).toBe(true)
  })

  it('forgives an abort that arrived while the driver was closing the page', () => {
    expect(isStreamClose({ error: 'net::ERR_ABORTED', resourceType: 'fetch', whileClosing: true })).toBe(true)
  })

  it('forgives an abort of a call that had been open longer than any ordinary one', () => {
    expect(isStreamClose({ error: 'net::ERR_ABORTED', resourceType: 'fetch', ageMs: 9000 })).toBe(true)
  })

  it('does NOT forgive a short-lived aborted call — that one is still a defect', () => {
    expect(isStreamClose({ error: 'net::ERR_ABORTED', resourceType: 'fetch', ageMs: 120 })).toBe(false)
  })

  it('never forgives an error that is not an abort, however long it lived', () => {
    expect(isStreamClose({ error: 'net::ERR_CONNECTION_REFUSED', ageMs: 60000 })).toBe(false)
    expect(isStreamClose({ error: 'net::ERR_NAME_NOT_RESOLVED', resourceType: 'eventsource' })).toBe(false)
  })

  it('keeps the closed stream out of the findings, and the real failure in', () => {
    const findings = classify({
      requestFailures: [
        { method: 'GET', url: 'http://app/api/events', error: 'net::ERR_ABORTED', resourceType: 'eventsource' },
        { method: 'GET', url: 'http://app/api/state', error: 'net::ERR_CONNECTION_REFUSED', resourceType: 'fetch' },
      ],
    })
    const kinds = findings.map((f) => f.detail)
    expect(kinds.some((d) => d.includes('/api/events'))).toBe(false)
    expect(kinds.some((d) => d.includes('/api/state'))).toBe(true)
    expect(findings.find((f) => f.detail.includes('/api/state'))?.severity).toBe(BLOCKER)
  })

  it('reports an unexplained abort as a warning — a cancel is not a broken product', () => {
    const findings = classify({
      requestFailures: [
        { method: 'GET', url: 'http://app/api/memory/lint', error: 'net::ERR_ABORTED', resourceType: 'fetch', ageMs: 120 },
      ],
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe(WARNING)
    expect(findings[0].kind).toBe('request-cancelled')
    expect(findings[0].detail).toContain('/api/memory/lint')
  })

  it('names what it forgave in the coverage, so the receipt hides nothing', () => {
    const md = renderCoverage({ ran: true, touched: 3, total: 3, streamsClosed: 24 })
    expect(md).toContain('24')
    expect(md).toContain('CLOSE')
  })
})

/**
 * A RECEIPT IS EVIDENCE, AND EVIDENCE TRAVELS. These files are committed by design — the
 * law that a UI change is proved by running it rests on them, so they go into git, into
 * the planning repository, and from there to a remote. That is exactly why the address a
 * run was pointed at must not carry the key that opens it: for months every run wrote the
 * daemon's front token in the clear, and by the time it was counted there were 338 such
 * files carrying 22 distinct token values, published in one push.
 *
 * The token is not a per-run nonce that dies with the process — it is a CONFIGURED secret
 * (`config.token` on the daemon's front server), so a receipt from August still opens the
 * door in December.
 *
 * The redaction keeps everything a reader needs to reproduce the run — scheme, host, port,
 * path and every ordinary parameter — and destroys only the value that is a credential.
 * A receipt nobody can follow would trade one defect for another.
 */
describe('redactUrl — a receipt names where the run went, never the key that opened it', () => {
  it('destroys the credential and keeps the address', () => {
    const out = redactUrl('http://127.0.0.1:7777/app?token=28be9f01c7d24e6ab1&view=queue')
    expect(out, 'the secret survived into the receipt').not.toContain('28be9f01c7d24e6ab1')
    // everything a person needs to walk the same path again is still there
    expect(out).toContain('127.0.0.1:7777')
    expect(out).toContain('/app')
    expect(out).toContain('view=queue')
    // and the reader is told a value was removed rather than left to wonder
    expect(out).toMatch(/token=/)
  })

  it('covers the other spellings a credential arrives under', () => {
    for (const key of ['token', 'access_token', 'apiKey', 'api_key', 'secret', 'password', 'sig']) {
      const out = redactUrl(`http://h/p?${key}=SUPERSECRETVALUE`)
      expect(out, `${key} was left in the clear`).not.toContain('SUPERSECRETVALUE')
    }
  })

  it('is not fooled by case, and leaves an address with nothing to hide untouched', () => {
    expect(redactUrl('http://h/p?TOKEN=SUPERSECRETVALUE')).not.toContain('SUPERSECRETVALUE')
    expect(redactUrl('http://h/p?view=queue&at=mobile')).toBe('http://h/p?view=queue&at=mobile')
  })

  /**
   * The runner hands this whatever the operator typed and whatever the browser reported.
   * A redactor that throws would take down the receipt-writing step at the very end of a
   * run that already happened — losing the evidence to protect it.
   */
  it('never throws on something that is not a URL', () => {
    for (const junk of ['', 'not a url', '://', null, undefined, 42]) {
      expect(() => redactUrl(junk as any), `threw on ${String(junk)}`).not.toThrow()
    }
    expect(redactUrl('not a url')).toBe('not a url')
  })

  it('the rendered receipt carries the redacted address, not the raw one', () => {
    const md = renderReceipt({
      url: 'http://127.0.0.1:7777/app?token=28be9f01c7d24e6ab1',
      verdict: { status: 'PASS', blockers: 0, warnings: 0 },
    })
    expect(md, 'the receipt published the token').not.toContain('28be9f01c7d24e6ab1')
    expect(md).toContain('127.0.0.1:7777')
  })
})
