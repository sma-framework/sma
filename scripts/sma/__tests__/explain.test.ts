/**
 * Tests for scripts/sma/lib/explain.mjs (Phase 49.3 Plan 09, Task 1 — D-49.3-15).
 *
 *  - Test 1 (getTopic parse): a fixture topic parses into {ok, id, title, summary,
 *    en, ru}; a topic missing the ## ru section returns {ok:false, missing:['ru']}.
 *  - Test 2 (unknown topic): renderTopic for an unknown id returns {found:false,
 *    catalog:[...]} — never an error (teaching-surface contract).
 *  - Test 3 (extractHandlersKeys): every key of a fixture `const HANDLERS = {` block
 *    is extracted — both quoted ('predict-score') and bare (status); text outside the
 *    block never contributes keys.
 *  - Test 4 (coverage): a HANDLERS key absent from COMMAND_TOPICS counts, AND a key
 *    mapped to a topic whose file does not exist counts.
 *  - Test 5 (lintTopics): over the REAL shipped corpus every file parses and every
 *    ## ru section is em-dash-free.
 *  - Test 6 (live coverage): coverage against the REAL cli.mjs source + REAL explainers
 *    returns count 0 — the honest assertion that keeps the tripwire meaningful.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COMMAND_TOPICS,
  extractHandlersKeys,
  getTopic,
  listTopics,
  renderTopic,
  coverage,
  lintTopics,
} from '../lib/explain.mjs'

const REAL_CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url))
const REAL_EXPLAINERS = fileURLToPath(new URL('../explainers', import.meta.url))

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-explain-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeTopic(id: string, body: string) {
  writeFileSync(join(dir, `${id}.md`), body, 'utf8')
}

describe('explain.mjs — topic parsing', () => {
  it('Test 1: getTopic parses a well-formed topic and flags a missing ## ru section', () => {
    writeTopic(
      'reflexes',
      '# Reflexes\n\nA scored miss becomes a rule.\n\n## en\nEnglish body line one.\nline two.\n\n## ru\nРусское тело.\nвторая строка.\n',
    )
    const ok = getTopic('reflexes', { explainersDir: dir })
    expect(ok.ok).toBe(true)
    expect(ok.id).toBe('reflexes')
    expect(ok.title).toBe('Reflexes')
    expect(ok.summary).toBe('A scored miss becomes a rule.')
    expect(ok.en).toContain('English body')
    expect(ok.ru).toContain('Русское тело')

    writeTopic('broken', '# Broken\n\nSummary.\n\n## en\nonly english.\n')
    const bad = getTopic('broken', { explainersDir: dir })
    expect(bad.ok).toBe(false)
    expect(bad.missing).toContain('ru')
  })

  it('Test 2: an unknown topic renders as {found:false, catalog}, never an error', () => {
    writeTopic('tour', '# Tour\n\nEntry point.\n\n## en\nen.\n\n## ru\nру.\n')
    const res = renderTopic('does-not-exist', { explainersDir: dir })
    expect(res.found).toBe(false)
    expect(Array.isArray(res.catalog)).toBe(true)
    expect(res.catalog.map((t: { id: string }) => t.id)).toContain('tour')
    // a known topic still renders
    const ok = renderTopic('tour', { explainersDir: dir, lang: 'ru' })
    expect(ok.found).toBe(true)
    expect(ok.body).toContain('ру')
  })
})

describe('explain.mjs — HANDLERS extraction + coverage', () => {
  it('Test 3: extractHandlersKeys reads quoted + bare keys, ignores text outside the block', () => {
    const fixture = [
      "const decoy = { notAKey: 1 }",
      "const HANDLERS = {",
      "  status: cmdStatus,",
      "  'predict-score': cmdPredictScore, // 49.1-08 — note: with a colon in the comment",
      "  claim: cmdClaim,",
      "  'next-slot': cmdNextSlot,",
      "}",
      "const afterBlock = { ghost: 2 }",
    ].join('\n')
    const keys = extractHandlersKeys(fixture)
    expect(keys).toEqual(['status', 'predict-score', 'claim', 'next-slot'])
    expect(keys).not.toContain('notAKey')
    expect(keys).not.toContain('ghost')
  })

  it('Test 4: coverage counts an unmapped key AND a key mapped to a missing topic file', () => {
    // only "tour" exists on disk
    writeTopic('tour', '# Tour\n\ns\n\n## en\ne\n\n## ru\nр\n')
    // explain -> tour (file exists); ghostcmd -> not in COMMAND_TOPICS; passport -> topic file absent here
    const cliSource = "const HANDLERS = {\n  explain: cmdExplain,\n  ghostcmd: cmdGhost,\n  passport: cmdPassport,\n}\n"
    const { uncovered, count } = coverage({ cliSource, explainersDir: dir })
    expect(count).toBe(2)
    expect(uncovered).toContain('ghostcmd') // not in COMMAND_TOPICS
    expect(uncovered).toContain('passport') // mapped, but topic file missing in this fixture dir
    expect(uncovered).not.toContain('explain') // mapped -> tour, which exists
    expect(COMMAND_TOPICS.explain).toBe('tour')
  })
})

describe('explain.mjs — the live corpus stays honest', () => {
  it('Test 5: lintTopics over the real corpus finds zero violations (parse + RU em-dash)', () => {
    const { violations } = lintTopics({ explainersDir: REAL_EXPLAINERS })
    expect(violations).toEqual([])
    // sanity: the corpus is non-trivial
    expect(listTopics({ explainersDir: REAL_EXPLAINERS }).length).toBeGreaterThanOrEqual(17)
  })

  it('Test 6: coverage against the real cli.mjs + real explainers is 0', () => {
    const cliSource = readFileSync(REAL_CLI, 'utf8')
    const { uncovered, count } = coverage({ cliSource, explainersDir: REAL_EXPLAINERS })
    expect(uncovered).toEqual([])
    expect(count).toBe(0)
  })
})
