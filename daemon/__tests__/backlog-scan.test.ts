/**
 * Tests for daemon/src/intake/backlog-scan.mjs + daemon/src/report.mjs
 * (Phase 9.5 Plan 07, Task 1; D-9.5-06/10/11, Pitfall 13).
 *
 * The two edges of the tick:
 *   - INTAKE  (backlog-scan): the platform parse contract ported 1:1 + the DoR split
 *     (missing `sp:N` → notReady «нет оценки»; `sp:N` > 13 → notReady «>13 SP…»;
 *     neither is EVER enqueued — D-9.5-10/11) + the Pitfall-13 age label.
 *   - OUTBOUND (report): the notify.mjs posture — explicit-pick allowlist (9 keys),
 *     off-by-default (no URL → zero fetch), response never read.
 */

import { describe, it, expect } from 'vitest'

import { parseBacklogContent, scanBacklog, toTask } from '../src/intake/backlog-scan.mjs'
import { reportTaskEvent, ALLOWED_REPORT_KEYS } from '../src/report.mjs'

// 4-5 real-shaped BACKLOG lines: an open+estimated one, a research-flavoured one, a
// CLOSED one, a PHASE-promoted one, one WITHOUT `sp:N`, and one with `sp:21` (>13).
const BACKLOG_FIXTURE = [
  '# Idea Board',
  '',
  '## Backlog',
  '',
  '- [ ] **BL-300** · Парсер источника — сделать X и Y ради Z. `size:S` `area:tech` `added:2026-07-17` `sp:3`',
  '- [ ] **BL-301** · Ресёрч рынка — изучить конкурентов ради позиционирования. `size:M` `area:content` `added:2026-07-17` `sp:5`',
  '- [x] **BL-302** · Закрытая задача — уже сделана. `size:S` `area:crm` `added:2026-07-10` `sp:2`',
  '- [ ] **BL-303** · Промо-фаза — большая работа. `size:L` `area:crm` `added:2026-07-17` `phase:60` `sp:8`',
  '- [ ] **BL-304** · Задача без оценки — что-то нужное. `size:M` `area:tech` `added:2026-07-17`',
  '- [ ] **BL-305** · Слишком крупная — целый эпик ради всего. `size:L` `area:tech` `added:2026-07-17` `sp:21`',
  'not a backlog line, ignored',
  '',
  '## Something Else',
  '- [ ] **BL-999** · Outside the backlog section. `sp:3`',
  ''
].join('\n')

describe('parseBacklogContent — faithful platform parser port', () => {
  it('extracts id/title/size/area/phase/open + storyPoints per line, only under ## Backlog', () => {
    const items = parseBacklogContent(BACKLOG_FIXTURE)
    const ids = items.map((i) => i.id)
    expect(ids).toEqual(['BL-300', 'BL-301', 'BL-302', 'BL-303', 'BL-304', 'BL-305'])
    // BL-999 is outside the ## Backlog section → never parsed
    expect(ids).not.toContain('BL-999')

    const bl300 = items.find((i) => i.id === 'BL-300')
    expect(bl300.title).toBe('Парсер источника')
    expect(bl300.description).toBe('сделать X и Y ради Z.')
    expect(bl300.open).toBe(true)
    expect(bl300.size).toBe('S')
    expect(bl300.area).toBe('tech')
    expect(bl300.storyPoints).toBe(3)

    expect(items.find((i) => i.id === 'BL-302').open).toBe(false) // [x] closed
    expect(items.find((i) => i.id === 'BL-303').phase).toBe('60') // phase-promoted
    expect(items.find((i) => i.id === 'BL-304').storyPoints).toBeNull() // no sp tag
    expect(items.find((i) => i.id === 'BL-305').storyPoints).toBe(21)
  })

  it('is CRLF-safe and never throws on malformed input', () => {
    const crlf = BACKLOG_FIXTURE.replace(/\n/g, '\r\n')
    expect(parseBacklogContent(crlf).map((i) => i.id)).toContain('BL-300')
    expect(() => parseBacklogContent('## Backlog\n- garbage line **not-an-id**')).not.toThrow()
    expect(parseBacklogContent('')).toEqual([])
    // @ts-expect-error — hostile non-string input must not throw
    expect(() => parseBacklogContent(null)).not.toThrow()
  })
})

describe('toTask — backlog line → canonical task shape', () => {
  it('maps source/priority/storyPoints/acceptance from the line', () => {
    const [item] = parseBacklogContent(BACKLOG_FIXTURE).filter((i) => i.id === 'BL-300')
    const task = toTask(item)
    expect(task.id).toBe('BL-300')
    expect(task.source).toBe('backlog')
    expect(task.title).toBe('Парсер источника')
    expect(task.priority).toBe(2) // size:S → 2
    expect(task.storyPoints).toBe(3)
    expect(task.acceptance).toBe('сделать X и Y ради Z.') // the post-delimiter detail
    expect(task.lane).toBe('prod') // area:tech default
  })

  it('routes a research-flavoured line to the research lane and size drives priority', () => {
    const [item] = parseBacklogContent(BACKLOG_FIXTURE).filter((i) => i.id === 'BL-301')
    const task = toTask(item)
    expect(task.lane).toBe('research')
    expect(task.priority).toBe(1) // size:M → 1
  })
})

describe('scanBacklog — git fetch + age label + the DoR notReady split', () => {
  const makeDeps = ({ backlog = BACKLOG_FIXTURE, commitTs = '1700000000', now = 1700003600000 } = {}) => {
    const gitCalls: string[][] = []
    const execGit = (args: string[]) => {
      gitCalls.push(args)
      if (args[0] === 'log') return `${commitTs}\n`
      return ''
    }
    const fsImpl = { readFileSync: () => backlog }
    return { deps: { repoDir: '/repo', execGit, clock: () => now, fsImpl }, gitCalls }
  }

  it('git-fetches, enqueues ONLY ready open items, and labels the data age (Pitfall 13)', async () => {
    const { deps, gitCalls } = makeDeps()
    const res = await scanBacklog(deps)

    // git fetch ran before the read (freshness on the mini)
    expect(gitCalls.some((c) => c[0] === 'fetch')).toBe(true)

    // ready items: BL-300 + BL-301 only. Closed (302), phase-promoted (303),
    // untagged (304) and >13 (305) are NEVER enqueued.
    expect(res.items.map((t: any) => t.id)).toEqual(['BL-300', 'BL-301'])
    expect(res.items.map((t: any) => t.id)).not.toContain('BL-304')
    expect(res.items.map((t: any) => t.id)).not.toContain('BL-305')

    // dataAgeMs derives from the last commit touching BACKLOG.md
    expect(res.dataAgeMs).toBe(1700003600000 - 1700000000 * 1000)
  })

  it('splits notReady with reasons: missing estimate vs >13 SP (D-9.5-10/11)', async () => {
    const { deps } = makeDeps()
    const res = await scanBacklog(deps)
    const byId = Object.fromEntries(res.notReady.map((n: any) => [n.id, n.reason]))
    expect(byId['BL-304']).toMatch(/нет оценки/)
    expect(byId['BL-305']).toMatch(/>13 SP/)
    // never both surfaced AND enqueued
    expect(res.items.find((t: any) => t.id === 'BL-304')).toBeUndefined()
    expect(res.items.find((t: any) => t.id === 'BL-305')).toBeUndefined()
  })

  it('never throws when git fetch fails — still reads the local BACKLOG', async () => {
    const execGit = (args: string[]) => {
      if (args[0] === 'fetch') throw new Error('offline')
      if (args[0] === 'log') return '1700000000\n'
      return ''
    }
    const deps = { repoDir: '/repo', execGit, clock: () => 1700003600000, fsImpl: { readFileSync: () => BACKLOG_FIXTURE } }
    const res = await scanBacklog(deps)
    expect(res.items.map((t: any) => t.id)).toEqual(['BL-300', 'BL-301'])
  })
})

describe('reportTaskEvent — outbound notify posture (off by default, allowlist, no read)', () => {
  it('has exactly the 9 allowlisted keys incl. the D-9.5-11 aging expansion', () => {
    expect(ALLOWED_REPORT_KEYS).toEqual([
      'event', 'taskId', 'title', 'lane', 'receiptVerdict', 'branch', 'attempt', 'ts', 'queuedForHours',
    ])
  })

  it('serializes ONLY allowlisted keys — hostile extras are never picked', async () => {
    let sent: any = null
    const fetchImpl = async (_url: string, opts: any) => {
      sent = JSON.parse(opts.body)
      return { ok: true, status: 200 }
    }
    const res = await reportTaskEvent({
      config: { webhookUrl: 'https://example.test/hook' },
      event: {
        event: 'task.completed',
        taskId: 'BL-300',
        title: 'Парсер источника',
        lane: 'prod',
        receiptVerdict: 'green',
        branch: 'wt/BL-300',
        attempt: 1,
        queuedForHours: 3,
        // hostile extras that must NEVER cross the boundary:
        diff: 'huge diff hunk',
        transcriptPath: '/secret/path',
        oauthToken: 'sk-leak',
      },
      fetchImpl,
      clock: () => 1700003600000,
    })
    expect(res.delivered).toBe(true)
    expect(Object.keys(sent).sort()).toEqual([...ALLOWED_REPORT_KEYS].sort())
    expect(sent.diff).toBeUndefined()
    expect(sent.transcriptPath).toBeUndefined()
    expect(sent.oauthToken).toBeUndefined()
    expect(sent.ts).toBe(new Date(1700003600000).toISOString())
  })

  it('OFF BY DEFAULT — no configured webhookUrl → ZERO fetch calls', async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return { ok: true, status: 200 }
    }
    const res = await reportTaskEvent({ config: {}, event: { event: 'task.completed', taskId: 'BL-1' }, fetchImpl })
    expect(calls).toBe(0)
    expect(res.delivered).toBe(false)
  })

  it('swallows a fetch error to a journal event — never blocks the tick', async () => {
    const journalled: any[] = []
    const fetchImpl = async () => {
      throw new Error('receiver down')
    }
    const res = await reportTaskEvent({
      config: { webhookUrl: 'https://example.test/hook' },
      event: { event: 'task.failed', taskId: 'BL-9' },
      fetchImpl,
      journal: (e: any) => journalled.push(e),
    })
    expect(res.delivered).toBe(false)
    expect(journalled.length).toBe(1)
  })
})
