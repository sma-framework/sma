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
  SWEEP_CAP,
  WARNING,
  classify,
  dedupe,
  isStreamClose,
  missingDriverMessage,
  parseSteps,
  renderCoverage,
  renderReceipt,
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
      // «Конвейер фаз» is a screen in the navigation, not the switch: refusing it would
      // hide a whole screen from the sweep to guard a control that is not there.
      'Конвейер фаз',
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

  it('names viewports skipped by a declared minimum width — a waiver is visible, never silent', () => {
    const md = renderCoverage({ ran: true, touched: 5, total: 5, skipped: 0, refused: [], viewportsSkipped: ['tablet (768px)', 'mobile (375px)'] })
    expect(md).toContain('declares a minimum width')
    expect(md).toContain('tablet (768px)')
    expect(md).toContain('nothing about narrower screens')
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
