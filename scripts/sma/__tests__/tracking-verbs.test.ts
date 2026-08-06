/**
 * The four defects SMA's own tracking verbs showed when SMA was
 * used to run SMA's development. Every one of them was found by DOGFOODING, in a
 * live workspace, and every one of them was silent: the verb printed success.
 *
 *   1. `roadmap update-plan-progress` OVERWROTE the phase's `Plans:` line. The write
 *      was `(anchor\s*)[^\n]+`, so the figure replaced the WHOLE rest of the line —
 *      and, when the anchor was a bare `Plans:` checklist header, `\s*` crossed the
 *      newline and the figure landed on top of the first checklist row.
 *   2. `state advance-plan` answered "Cannot parse Current Plan or Total Plans in
 *      Phase from STATE.md" on a STATE.md that tracks position with
 *      `state record-session`. The message named no file, no field and no way out.
 *   3. `record-metric` / `add-decision` / `record-session` accepted ONLY `--flag`
 *      args while the shipped executor documentation calls them positionally. The
 *      mismatch failed silently: `record-session "" "Completed 11-02" "None"`
 *      answered `{"recorded": true}` and threw the text away.
 *   4. `state add-decision` wrote the literal `- [Phase ?]:` when `--phase` was
 *      omitted — four such rows accumulated in one decision log across three plans —
 *      and took `--summary` where its own name says `--decision`.
 *
 * The fixtures copy the SHAPES of the workspace where the defects were found
 * (a `**Plans:**` line carrying a phase-home note and a two-repo note; a STATE.md
 * whose position is prose plus frontmatter and which carries no plan counter at
 * all). Nothing here reads that workspace at runtime: every case builds its own
 * temp project.
 *
 * Layering: the pure transforms are pinned in-process, and a small set of cases
 * drives the REAL `sma-tools` binary, because three of the four defects were only
 * ever visible at the operator's terminal — the exit code and the printed envelope
 * are the contract, not the internal return value.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const require_ = createRequire(import.meta.url)
const repoRoot = join(__dirname, '..', '..', '..')
const smaTools = join(repoRoot, 'sma-core', 'bin', 'sma-tools.cjs')

const { replacePlansFigure } = require_(join(repoRoot, 'sma-core', 'bin', 'lib', 'roadmap.cjs'))
const { readPlanPosition, resolveDecisionPhase } = require_(
  join(repoRoot, 'sma-core', 'bin', 'lib', 'state.cjs'),
)
const { collectPositionals, parseNamedArgsWithPositionals } = require_(
  join(repoRoot, 'sma-core', 'bin', 'lib', 'command-arg-projection.cjs'),
)

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sma-tracking-verbs-'))
})

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

/**
 * Run the real sma-tools binary against `proj`.
 *
 * The spawn result is returned WHOLE (status + stdout + stderr) rather than parsed,
 * because two of these cases are about the exit code and one is about stderr. The
 * helpers below parse only where a JSON envelope is what is under test, and they
 * say what the child did when there is nothing to parse — an unexplained
 * `Unexpected end of JSON input` is the failure mode this suite must not have
 * under machine load (the load-sensitivity finding).
 */
function run(proj: string, args: string[]) {
  const res = spawnSync(process.execPath, [smaTools, ...args, '--cwd', proj], { encoding: 'utf8' })
  expect(res.stderr ?? '').not.toMatch(/MODULE_NOT_FOUND/)
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', signal: res.signal, error: res.error }
}

function runJson(proj: string, args: string[]): Record<string, unknown> {
  const res = run(proj, args)
  if (res.error || res.status !== 0 || res.stdout.trim() === '') {
    throw new Error(
      `sma-tools ${args.join(' ')} gave no parseable stdout — ` +
        `status=${res.status} signal=${res.signal} spawnError=${res.error ? res.error.message : 'none'}\n` +
        `stdout: ${JSON.stringify(res.stdout.slice(0, 300))}\n` +
        `stderr: ${JSON.stringify(res.stderr.slice(0, 600))}`,
    )
  }
  return JSON.parse(res.stdout) as Record<string, unknown>
}

/** A temp project carrying the given .planning files and phase plan/summary files. */
function makeProject(
  name: string,
  files: { roadmap?: string; state?: string; phaseDir?: string; plans?: string[]; summaries?: string[] },
): string {
  const proj = join(tmp, name)
  mkdirSync(join(proj, '.planning', 'phases'), { recursive: true })
  if (files.roadmap !== undefined) writeFileSync(join(proj, '.planning', 'ROADMAP.md'), files.roadmap, 'utf8')
  if (files.state !== undefined) writeFileSync(join(proj, '.planning', 'STATE.md'), files.state, 'utf8')
  if (files.phaseDir) {
    const dir = join(proj, '.planning', 'phases', files.phaseDir)
    mkdirSync(dir, { recursive: true })
    for (const p of files.plans ?? []) writeFileSync(join(dir, p), '---\nwave: 1\n---\n# plan\n', 'utf8')
    for (const s of files.summaries ?? []) writeFileSync(join(dir, s), '# summary\n', 'utf8')
  }
  return proj
}

// ─── Defect 1 — the Plans line is edited, not replaced ───────────────────────

/**
 * The live line, verbatim in shape: a figure followed by a parenthetical, the
 * phase home path, and the note that the plans' product paths point at a sibling
 * repository. Every byte after the figure is content a human wrote and the verb
 * has no business touching.
 */
const LIVE_PLANS_TAIL =
  '(15 планов / 5 волн). Дом фазы: `.planning/phases/11-plan-tracking/`. ' +
  'Все продуктовые пути в планах ведут в соседний репозиторий `../product`.'

describe('roadmap update-plan-progress — the figure moves, the line survives', () => {
  it('replaces ONLY the count token and preserves the rest of the line byte-for-byte', () => {
    const content = `### Phase 11: plan-tracking\n\n**Plans:** 2/15 plans executed ${LIVE_PLANS_TAIL}\n`
    const { content: after, result } = replacePlansFigure(content, '0*11', '3/15 plans executed', 'ROADMAP.md')
    expect(after).toBe(`### Phase 11: plan-tracking\n\n**Plans:** 3/15 plans executed ${LIVE_PLANS_TAIL}\n`)
    expect(result).toMatchObject({ plans_line: 'updated' })
    // the whole tail, not a trimmed approximation of it
    expect(after).toContain(LIVE_PLANS_TAIL)
  })

  it('accepts every count spelling the template and this verb produce', () => {
    const cases: [string, string][] = [
      ['**Plans**: 15 plans', '**Plans**: 1/15 plans executed'],
      ['**Plans**: 1 plan', '**Plans**: 1/15 plans executed'],
      ['**Plans:** 9/9 plans complete', '**Plans:** 1/15 plans executed'],
      ['Plans: 2/15 plans executed', 'Plans: 1/15 plans executed'],
    ]
    for (const [line, expected] of cases) {
      const { content: after } = replacePlansFigure(`### Phase 11: x\n\n${line} — keep me\n`, '0*11', '1/15 plans executed', 'R.md')
      expect(after).toBe(`### Phase 11: x\n\n${expected} — keep me\n`)
    }
  })

  it('fills the unfilled template placeholder (nothing to lose there)', () => {
    const content = '### Phase 11: x\n\n**Plans**: [Number of plans, e.g., "3 plans" or "TBD"]\n'
    const { content: after, result } = replacePlansFigure(content, '0*11', '0/4 plans executed', 'R.md')
    expect(after).toBe('### Phase 11: x\n\n**Plans**: 0/4 plans executed\n')
    expect(result).toMatchObject({ plans_line: 'filled' })
  })

  it('REFUSES a line whose shape it does not recognise instead of overwriting it', () => {
    const prose = '**Plans**: спланировано 31.07.2026 — 25 планов / 8 волн + 2 гэп-плана'
    const content = `### Phase 11: x\n\n${prose}\n`
    const { content: after, result } = replacePlansFigure(content, '0*11', '1/25 plans executed', 'R.md')
    expect(after).toBe(content) // untouched, byte for byte
    expect(result).toMatchObject({ plans_line: 'preserved-unrecognized' })
    expect(String((result as Record<string, unknown>).plans_line_value)).toContain('спланировано')
  })

  it('never writes a figure onto a bare `Plans:` CHECKLIST header', () => {
    const content = '### Phase 11: x\n\nPlans:\n\n- [ ] 11-01-PLAN.md\n- [ ] 11-02-PLAN.md\n'
    const { content: after, result } = replacePlansFigure(content, '0*11', '1/2 plans executed', 'R.md')
    expect(after).toBe(content)
    expect(result).toMatchObject({ plans_line: 'absent' })
  })

  it('at the operator terminal: the live line keeps its prose across a real run', () => {
    const roadmap =
      '# Roadmap\n\n## Current Milestone: v2.1.178\n\n### Phase 11: plan-tracking\n\n' +
      '**Goal**: SMA V5.3\n' +
      `**Plans:** 2/15 plans executed ${LIVE_PLANS_TAIL}\n\n` +
      'Plans:\n\n- [ ] 11-01-PLAN.md\n- [ ] 11-02-PLAN.md\n'
    const proj = makeProject('d1-live', {
      roadmap,
      phaseDir: '11-plan-tracking',
      plans: ['11-01-PLAN.md', '11-02-PLAN.md'],
      summaries: ['11-01-SUMMARY.md'],
    })
    const out = runJson(proj, ['roadmap', 'update-plan-progress', '11'])
    expect(out).toMatchObject({ updated: true, plans_line: 'updated' })
    const after = readFileSync(join(proj, '.planning', 'ROADMAP.md'), 'utf8')
    expect(after).toContain(`**Plans:** 1/2 plans executed ${LIVE_PLANS_TAIL}`)
    // the checklist is intact and the completed plan is checked off
    expect(after).toContain('- [x] 11-01-PLAN.md')
    expect(after).toContain('- [ ] 11-02-PLAN.md')
    // the pre-fix output injected the figure INTO the list; it must not be there
    expect(after).not.toMatch(/^\d+\/\d+ plans/m)
  })
})

// ─── Defect 2 — advance-plan reads the shapes in the wild, or says why not ───

/** The live shape: frontmatter position, prose Current Position, NO plan counter. */
const LIVE_STATE = [
  '---',
  'sma_state_version: 1.0',
  'milestone: v2.1.178',
  'current_phase: 11',
  'current_phase_name: plan-tracking',
  'status: In progress',
  '---',
  '',
  '# SMA Project State (private workspace)',
  '',
  '## Current Position',
  '',
  'Phase: 11 (plan-tracking) — EXECUTING',
  '',
  '## Session',
  '',
  '**Last session:** 2026-08-05',
  '**Stopped At:** Completed 11-02',
  '**Resume File:** None',
  '',
  '## Decisions',
  '',
  '- [Phase 8]: 08-01: v2-грамматика',
  '',
].join('\n')

describe('state advance-plan — the counter it can read, and a way out when it cannot', () => {
  it('reads the three counter shapes that exist in the wild', () => {
    expect(readPlanPosition('**Current Plan:** 2\n**Total Plans in Phase:** 6\n')).toMatchObject({
      currentPlan: 2,
      totalPlans: 6,
      source: 'legacy',
    })
    expect(readPlanPosition('Plan: 2 of 6 in current phase\n')).toMatchObject({
      currentPlan: 2,
      totalPlans: 6,
      source: 'compound',
    })
    expect(readPlanPosition('---\ncurrent_plan: 2\ntotal_plans_in_phase: 6\n---\n\n# S\n')).toMatchObject({
      currentPlan: 2,
      totalPlans: 6,
      source: 'frontmatter',
    })
  })

  it('reports no source at all for the STATE.md that tracks position another way', () => {
    const position = readPlanPosition(LIVE_STATE)
    expect(position.source).toBeNull()
    expect(Number.isNaN(position.currentPlan)).toBe(true)
  })

  it('at the operator terminal: the refusal names the file, the fields, and the alternative', () => {
    const proj = makeProject('d2-refusal', { state: LIVE_STATE })
    const out = runJson(proj, ['state', 'advance-plan'])
    expect(out.advanced).toBe(false)
    // the file — the old message named none
    expect(String(out.state_file)).toContain('STATE.md')
    expect(String(out.error)).toContain('STATE.md')
    // what was searched for
    const searched = (out.searched as string[]).join(' | ')
    expect(searched).toContain('Current Plan')
    expect(searched).toContain('Total Plans in Phase')
    expect(searched).toContain('current_plan')
    // the working alternative, named by verb
    expect(String(out.hint)).toContain('record-session')
    expect(String(out.hint)).toContain('begin-phase')
    // and the dead-end wording is gone
    expect(String(out.error)).not.toContain('Cannot parse')
  })

  it('at the operator terminal: a frontmatter counter advances AND persists across runs', () => {
    const proj = makeProject('d2-frontmatter', {
      state: '---\nsma_state_version: 1.0\ncurrent_phase: 11\ncurrent_plan: 2\ntotal_plans_in_phase: 6\nstatus: executing\n---\n\n# State\n\n## Current Position\n\nPhase: 11 (x)\n',
    })
    expect(runJson(proj, ['state', 'advance-plan'])).toMatchObject({ advanced: true, current_plan: 3, total_plans: 6 })
    // The second run is the real test: a write that drops total_plans_in_phase makes
    // the verb work exactly once and refuse forever after.
    expect(runJson(proj, ['state', 'advance-plan'])).toMatchObject({ advanced: true, current_plan: 4, total_plans: 6 })
    const after = readFileSync(join(proj, '.planning', 'STATE.md'), 'utf8')
    expect(after).toMatch(/^current_plan: 4$/m)
    expect(after).toMatch(/^total_plans_in_phase: 6$/m)
  })
})

// ─── Defect 3 — both spellings, and a flag always wins ───────────────────────

describe('argument projection — the flag spelling and the documented positional one', () => {
  it('fills empty slots from positionals, left to right', () => {
    const args = ['state', 'record-metric', '11', '16', '12min', '4', '7']
    expect(parseNamedArgsWithPositionals(args, ['phase', 'plan', 'duration', 'tasks', 'files'], ['phase', 'plan', 'duration', 'tasks', 'files'])).toEqual({
      phase: '11', plan: '16', duration: '12min', tasks: '4', files: '7',
    })
  })

  it('lets a flag win, and does not spend a positional on the slot it filled', () => {
    const args = ['state', 'record-metric', '--phase', '9', '04', '7min']
    expect(parseNamedArgsWithPositionals(args, ['phase', 'plan', 'duration'], ['phase', 'plan', 'duration'])).toEqual({
      phase: '9', plan: '04', duration: '7min',
    })
  })

  it('never offers a flag VALUE as a positional', () => {
    expect(collectPositionals(['state', 'add-decision', '--phase', '11', 'the text'], ['phase', 'summary'])).toEqual(['the text'])
    // an unknown/boolean flag consumes nothing
    expect(collectPositionals(['state', 'x', '--urgent', 'a'], ['phase'])).toEqual(['a'])
  })

  it('at the operator terminal: the documented positional record-session records the text', () => {
    const proj = makeProject('d3-session', { state: LIVE_STATE })
    // exactly the call sma-executor.md / forensics.md / milestone-summary.md print
    const out = runJson(proj, ['query', 'state.record-session', '', 'Completed 11-16-PLAN.md', 'None'])
    expect(out.recorded).toBe(true)
    expect(out.updated as string[]).toContain('Stopped At')
    const after = readFileSync(join(proj, '.planning', 'STATE.md'), 'utf8')
    expect(after).toContain('Completed 11-16-PLAN.md')
    // the value it replaced is gone — before the fix it stayed and the call lied
    expect(after).not.toContain('**Stopped At:** Completed 11-02')
  })

  it('at the operator terminal: the documented positional record-metric records the row', () => {
    const proj = makeProject('d3-metric', { state: LIVE_STATE })
    const out = runJson(proj, ['query', 'state.record-metric', '11', '16', '12min', '4', '7'])
    expect(out).toMatchObject({ recorded: true, phase: '11', plan: '16', duration: '12min' })
    expect(readFileSync(join(proj, '.planning', 'STATE.md'), 'utf8')).toContain('| Phase 11 P16 | 12min | 4 tasks | 7 files |')
  })
})

// ─── Defect 4 — the phase is resolved honestly, or the write is refused ──────

describe('state add-decision — a phase number or nothing, never "[Phase ?]"', () => {
  it('resolves in the documented order: flag, frontmatter, body, prose', () => {
    expect(resolveDecisionPhase(tmp, LIVE_STATE, '42')).toMatchObject({ phase: '42', source: 'flag' })
    expect(resolveDecisionPhase(tmp, LIVE_STATE, undefined)).toMatchObject({ phase: '11', source: 'state_frontmatter' })
    expect(resolveDecisionPhase(tmp, '# S\n\n**Current Phase:** 9\n', undefined)).toMatchObject({
      phase: '9', source: 'state_body',
    })
    expect(resolveDecisionPhase(tmp, '# S\n\nPhase: 7 (checkout) — EXECUTING\n', undefined)).toMatchObject({
      phase: '7', source: 'state_prose',
    })
  })

  it('uses the phases directory only when exactly one phase lives there', () => {
    const one = makeProject('d4-onedir', { state: '# S\n', phaseDir: '07-a' })
    expect(resolveDecisionPhase(one, '# S\n', undefined)).toMatchObject({ phase: '07', source: 'phases_dir' })

    const two = makeProject('d4-twodirs', { state: '# S\n', phaseDir: '07-a' })
    mkdirSync(join(two, '.planning', 'phases', '09-b'), { recursive: true })
    expect(resolveDecisionPhase(two, '# S\n', undefined)).toMatchObject({ phase: null, source: null })
  })

  it('at the operator terminal: no --phase still writes a real number, and reports its source', () => {
    const proj = makeProject('d4-resolve', { state: LIVE_STATE })
    const out = runJson(proj, ['state', 'add-decision', '--summary', 'tighten the retry backoff'])
    expect(out).toMatchObject({ added: true, phase: '11', phase_source: 'state_frontmatter' })
    expect(String(out.decision)).toBe('- [Phase 11]: tighten the retry backoff')
    const after = readFileSync(join(proj, '.planning', 'STATE.md'), 'utf8')
    expect(after).toContain('- [Phase 11]: tighten the retry backoff')
    expect(after).not.toContain('[Phase ?]')
  })

  it('at the operator terminal: --decision is accepted, and so is the bare positional', () => {
    const proj = makeProject('d4-alias', { state: LIVE_STATE })
    expect(runJson(proj, ['state', 'add-decision', '--decision', 'the intuitive flag'])).toMatchObject({
      added: true, decision: '- [Phase 11]: the intuitive flag',
    })
    expect(runJson(proj, ['query', 'state.add-decision', 'the documented positional'])).toMatchObject({
      added: true, decision: '- [Phase 11]: the documented positional',
    })
    // --summary, the older spelling, is untouched
    expect(runJson(proj, ['state', 'add-decision', '--summary', 'the older flag'])).toMatchObject({
      added: true, decision: '- [Phase 11]: the older flag',
    })
  })

  it('at the operator terminal: an unresolvable phase REFUSES loudly and writes nothing', () => {
    const proj = makeProject('d4-refuse', { state: '# State\n\n## Decisions\n\n- none\n', phaseDir: '07-a' })
    mkdirSync(join(proj, '.planning', 'phases', '09-b'), { recursive: true })
    const before = readFileSync(join(proj, '.planning', 'STATE.md'), 'utf8')
    const res = run(proj, ['state', 'add-decision', '--summary', 'orphan decision'])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('--phase')
    expect(res.stderr).toContain('[Phase ?]')
    // the refusal is not a silent drop: the file is exactly as it was
    expect(readFileSync(join(proj, '.planning', 'STATE.md'), 'utf8')).toBe(before)
  })
})
