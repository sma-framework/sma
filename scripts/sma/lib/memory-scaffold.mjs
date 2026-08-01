/**
 * memory-scaffold.mjs — the memory SYSTEM a fresh install ships: structure, never content.
 *
 * The installed CLAUDE.md rules block tells every agent to read
 * `.claude/memory/MEMORY.md` at session start and to regenerate the index after
 * writing a note. Until this module existed, a fresh install had NO
 * `.claude/memory/` at all: the pointer was a lie, `build-index --write` died
 * with ENOENT (the writer creates the file, never the corpus dir), and the
 * closed tag vocabulary appeared only if the user happened to finish
 * `/sma-start`. The system was reachable by ritual, not by installation.
 *
 * So the installer materializes the SKELETON — and only the skeleton:
 *   TAGS.md    the closed vocabulary (facets area/kind/phase, strict line grammar)
 *   MEMORY.md  the generated index of an EMPTY corpus (0 notes, 0 core)
 *   episodes/  an EMPTY directory (a `.gitkeep` placeholder, nothing else) —
 *              the place history goes, shipped as architecture and never as
 *              content. Same law one level down: zero episodes, ever.
 *
 * and nothing else. Zero notes, ever. A note is a `.md` carrying a leading `---`
 * frontmatter fence; the two files above deliberately carry none — every reader
 * in the corpus (frontmatter.mjs, generator.mjs, lint.mjs) classifies them as
 * structural. That is the machine-checkable line between "the memory system
 * ships" and "somebody's memory ships": the author's corpus is content, and
 * content is never a deliverable.
 *
 * MEMORY.md is produced by the REAL generator (generator.buildIndex), not by a
 * hand-written template, so the byte the installer writes is the byte a later
 * `sma build-index --write` produces — a fresh install is lint-clean and
 * regen-identical from minute one instead of starting one step stale.
 *
 * NOTHING here overwrites. Every write is guarded by existsSync: re-running the
 * installer over a live corpus is a no-op on that corpus. Same posture as
 * `sma deleteme` (which never touches `.claude/memory/`) and as profile-writer's
 * seeder — the corpus is the USER's asset, and an installer that can clobber it
 * is a data-loss bug waiting for its first victim.
 *
 * Node built-ins only; zero npm deps.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { EPISODES_DIRNAME } from './episodes.mjs'
import { atomicWriteRaw } from './fs-atomics.mjs'

/**
 * STARTER_TAGS — the starter closed vocabulary written when a corpus has none.
 *
 * SINGLE SOURCE, two consumers: this scaffold (install time) and
 * profile-writer's `seedCorpusNotes` (onboarding time) import the SAME binding,
 * so the registry a user gets from `npx sma-framework` and the one `/sma-start`
 * seeds cannot drift into two dialects of the same vocabulary.
 *
 * The tag IDENTIFIERS are the contract (lint MEM-VOCAB checks every note tag
 * against them); the descriptions are prose for the human reading the file.
 */
export const STARTER_TAGS = `# TAGS — закрытый словарь меток

Метки живут в трёх гранях. Строка грамматики строгая: \`- <метка> — <описание>\`.

## area

- tech — инфраструктура, сборка, выкладка, техническая часть проекта.
- workflow — процесс работы: планирование, исполнение, проверка, правила.

## kind

- procedural-rule — правило «как делать», применяется всегда.
- decision — принятое решение и его основание.
- episodic — что произошло в конкретный раз.
- status — текущее состояние дел.
- reference — справка: адреса, версии, таблицы фактов.
- bug-lesson — урок из поломки, с разделами **Why:** и **How to apply:**.

## phase

- Открытая грань: \`phase:NN\` — необязательная метка привязки к этапу.
`

/** The corpus directory, relative to the project root. */
export const CORPUS_RELATIVE_DIR = join('.claude', 'memory')

/** The structural files the scaffold may ever write. Notes are NOT on this list. */
export const SCAFFOLD_FILES = ['TAGS.md', 'MEMORY.md', `${EPISODES_DIRNAME}/.gitkeep`]

/**
 * The placeholder that makes an EMPTY directory survive git. Deliberately empty
 * itself: a `.gitkeep` with prose in it is a file someone will one day edit,
 * and this one exists only so `episodes/` is a real, committed part of the
 * skeleton rather than a directory the first write has to invent.
 */
const GITKEEP = ''

/** Deterministic commit-anchor fallback — the exact one `sma build-index` uses. */
const FALLBACK_COMMIT = '0000000'

/**
 * Read the target repo's short HEAD; fail-open (no git / no commits yet is fine).
 *
 * `child_process` is imported LAZILY and only on the one path that needs it:
 * profile-writer.mjs imports STARTER_TAGS from this module and carries a stated
 * law of "no child_process anywhere", which a top-level import would quietly
 * break for its whole module graph.
 */
async function readCommitHash(projectDir, execGit) {
  try {
    let run = execGit
    if (!run) {
      const { execFileSync } = await import('node:child_process')
      run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    }
    return run(['rev-parse', '--short', 'HEAD'], projectDir).trim() || FALLBACK_COMMIT
  } catch {
    return FALLBACK_COMMIT
  }
}

/**
 * scaffoldMemory({projectDir, execGit}) — materialize the empty corpus.
 *
 * Writes `<projectDir>/.claude/memory/{TAGS.md,MEMORY.md,episodes/.gitkeep}`
 * ONLY where it is absent. Returns what it did, so the caller reports honestly:
 *   {dir, created: string[], kept: string[], notes: 0}
 *
 * `notes` is always 0 by construction — this function has no code path that can
 * write a note, which is the whole point.
 *
 * @param {{projectDir?:string, execGit?:Function}} [args]
 * @returns {Promise<{dir:string, created:string[], kept:string[], notes:number}>}
 */
export async function scaffoldMemory({ projectDir = process.cwd(), execGit } = {}) {
  const dir = join(projectDir, CORPUS_RELATIVE_DIR)
  const created = []
  const kept = []

  const tagsPath = join(dir, 'TAGS.md')
  if (existsSync(tagsPath)) kept.push('TAGS.md')
  else {
    atomicWriteRaw(tagsPath, STARTER_TAGS)
    created.push('TAGS.md')
  }

  const indexPath = join(dir, 'MEMORY.md')
  if (existsSync(indexPath)) kept.push('MEMORY.md')
  else {
    const generator = await import('./generator.mjs')
    // The corpus dir exists by now (TAGS.md made it) and holds no notes, so the
    // index is the honest "0 notes" shell — generated, not a template imitating
    // generated output.
    const index = generator.buildIndex({
      corpusDir: dir,
      tagsPath,
      commitHash: await readCommitHash(projectDir, execGit),
      dateMap: {},
    })
    atomicWriteRaw(indexPath, index)
    created.push('MEMORY.md')
  }

  // The episode layer ships as an EMPTY directory. The guard is on the
  // DIRECTORY, not on the placeholder: a live corpus whose episodes/ already
  // holds someone's history is left completely alone — not one byte rewritten,
  // and not even a `.gitkeep` added to it. Same law as the two files above, and
  // the reason is the same one the header states: an installer that can touch
  // the user's memory is a data-loss bug waiting for its first victim.
  const episodesDir = join(dir, EPISODES_DIRNAME)
  if (existsSync(episodesDir)) kept.push(`${EPISODES_DIRNAME}/`)
  else {
    // atomicWriteRaw mkdirs the parent, so the placeholder write IS the
    // directory creation — one guarded step, no unguarded mkdir before it.
    atomicWriteRaw(join(episodesDir, '.gitkeep'), GITKEEP)
    created.push(`${EPISODES_DIRNAME}/.gitkeep`)
  }

  return { dir, created, kept, notes: 0 }
}
