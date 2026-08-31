/**
 * start-map.mjs — the value map `/sma-start` shows BEFORE its first question.
 *
 * WHY IT EXISTS. The onboarding used to open with a lecture and then ~23 questions:
 * a person who had installed the framework ten seconds earlier was asked what must
 * never break in their project, by a system they had not yet seen do anything. That
 * is the wrong order. Every adoption story we watched had the same shape — install,
 * account, integrations, questions — and the first useful thing arrived after all
 * of it. So the first screen of `/sma-start` is now a MAP: five things this system
 * will do in THIS repository, each one carrying a number read from the repository
 * itself, and only then the interview.
 *
 * WHAT MAKES IT HONEST. The map is not a brochure: the counts in it come from the
 * user's own tree and their own git history, so a repository with no history says
 * so instead of promising catches it has not got. It is read-only, needs no answer,
 * and writes nothing — the person can walk away after reading it and the project is
 * exactly as it was.
 *
 * CONSUME, NEVER REIMPLEMENT. The analysis is `memory-preview.analyzeRepo` — the
 * same ls-files fold and the same excavate history mining the memory preview draws.
 * This module adds the promises and their renderer, nothing else, so the two
 * onboarding pictures can never disagree about the same repository.
 *
 * SUBSTRATE LAW: Node built-ins only, read-only git through an injected runner
 * (shell OFF), zero network, zero LLM, no clock in the rendered bytes — the same
 * repository at the same HEAD renders byte-identically, and that determinism is the
 * falsifiable check.
 */

import { analyzeRepo } from './memory-preview.mjs'

/**
 * analyzeForMap({repoDir, runGit, io}) — the map's input fold.
 *
 * Deliberately a delegation, not a second analysis: the map and the memory preview
 * describe the same repository, so they read it with the same code. Every failure
 * degrades inside `analyzeRepo` (no git, empty tree, no corpus) — it never throws,
 * because this runs during onboarding, where a crash costs the adopter.
 */
export function analyzeForMap({ repoDir, runGit, io } = {}) {
  return analyzeRepo({ repoDir, runGit, io })
}

// ── the copy ─────────────────────────────────────────────────────────────────
//
// Five promises, EN and RU in parity: same order, same numbers, same count. None
// of them is a question — a map that asks something is an interview with a header.

const L = {
  en: {
    title: (d) => `What SMA will do in this project — ${d}`,
    subtitle: 'the map first, the questions after (read-only: nothing has been written yet)',
    fresh: 'this directory has no git-tracked files yet, so the map shows what a fresh project starts with',
    leads: [
      'REMEMBERS this project so you stop re-explaining it',
      'CATCHES the repeats this history has already paid for',
      'KEEPS parallel terminals off each other\'s work',
      'TURNS «done» into something a command can check',
      'ASKS before anything dangerous or public',
    ],
    memory: (files, areas) =>
      `${files} tracked files fold into ${areas} memory areas: a CORE that loads every`,
    memoryTail: 'session, the rest pulled by tag only when a task needs it',
    memoryFresh: 'the corpus starts at ~5-8 CORE notes, seeded from your answers below',
    corpus: (n) => `a corpus is already here: ${n} note(s), kept as they are`,
    mined: (n) => `${n} catch(es) mined from YOUR git history by excavate:`,
    // the kind ids excavate actually emits (revert-pair | typo-chain | ci-fix-forward);
    // an unknown kind falls back to its raw id rather than being dropped
    kind: { 'revert-pair': 'commit ↔ revert pairs', 'ci-fix-forward': 'red-CI fix-forward chains', 'typo-chain': 'typo/oops fix chains' },
    kindLine: (label, n) => ` · ${label}: ${n}`,
    minedTail: 'each becomes a WARN at the moment of the act, before the repeat lands',
    minedZero: 'no catches in this history yet, so reflexes accrue from real misses later',
    coordination: 'claims, slots and merges live in plain files in this repo: no server,',
    coordinationTail: 'no account, no second terminal waiting on a first one',
    receipts: 'a claim ships the command that reproduces it, and an unverified claim',
    receiptsTail: 'stays marked unverified instead of being taken on trust',
    safety: 'the commands you name as dangerous become a question, never a silent run,',
    safetyTail: 'and nothing leaves this machine unless you send it',
    closeRead: 'Nothing above needed an answer from you: it was read from this repository.',
    closeNext: 'Now the questions, in plain language, so the map above becomes yours. Any of them can be skipped.',
  },
  ru: {
    title: (d) => `Что SMA сделает в Вашем проекте — ${d}`,
    subtitle: 'сначала карта, потом вопросы (только чтение: пока ничего не записано)',
    fresh: 'в этом каталоге ещё нет файлов под git, поэтому показана раскладка свежего проекта',
    leads: [
      'ПОМНИТ этот проект, чтобы Вы не объясняли его заново',
      'ЛОВИТ повторы, за которые эта история уже заплатила',
      'РАЗВОДИТ параллельные терминалы, чтобы они не мешали друг другу',
      'ПРЕВРАЩАЕТ «готово» в то, что проверяется командой',
      'СПРАШИВАЕТ перед опасным и перед публичным',
    ],
    memory: (files, areas) =>
      `${files} файлов под git сворачиваются в ${areas} областей памяти: ЯДРО грузится`,
    memoryTail: 'каждую сессию, остальное подтягивается по тегу, только когда нужно задаче',
    memoryFresh: 'корпус начинается с ~5-8 заметок ЯДРА, засеянных Вашими ответами ниже',
    corpus: (n) => `корпус уже здесь: заметок ${n}, они остаются как есть`,
    mined: (n) => `находок в ВАШЕЙ истории git (excavate): ${n}`,
    kind: { 'revert-pair': 'пары коммит ↔ revert', 'ci-fix-forward': 'цепочки чинки красного CI', 'typo-chain': 'цепочки typo/oops' },
    kindLine: (label, n) => ` · ${label}: ${n}`,
    minedTail: 'каждая становится предупреждением В МОМЕНТ действия, до повтора',
    minedZero: 'находок в этой истории пока нет, рефлексы накопятся из реальных промахов',
    coordination: 'заявки, слоты и слияния лежат обычными файлами в этом репозитории: без',
    coordinationTail: 'сервера, без аккаунта, без ожидания одного терминала другим',
    receipts: 'к заявлению прилагается команда, которая его воспроизводит, а непроверенное',
    receiptsTail: 'остаётся помеченным как непроверенное, а не принимается на слово',
    safety: 'команды, которые Вы назовёте опасными, становятся вопросом, а не тихим',
    safetyTail: 'запуском, и ничего не уходит с этой машины, пока Вы не отправите сами',
    closeRead: 'Ничего из этого не потребовало Вашего ответа: всё прочитано из репозитория.',
    closeNext: 'Теперь вопросы, простыми словами, чтобы карта выше стала Вашей. Любой можно пропустить.',
  },
}

const RULE = '─'.repeat(72)

/** One promise: its numbered lead, then its indented body lines. */
function block(n, lead, lines) {
  return [`${n}. ${lead}`, ...lines.map((l) => `   ${l}`), '']
}

/**
 * renderStartMap(analysis, {lang}) — pure text render (LF). No clock, no locale
 * formatting, no randomness: byte-identical for the same analysis. Contains no
 * question, by construction — the questions start after it.
 */
export function renderStartMap(a, { lang = 'en' } = {}) {
  const t = L[lang] ?? L.en
  const out = [t.title(a.repoDir), t.subtitle, RULE, '']
  if (a.empty) out.push(`(${t.fresh})`, '')

  const memory = a.empty
    ? [t.memoryFresh]
    : [t.memory(a.fileCount, a.areas.length), t.memoryTail]
  if (a.corpus?.present && a.corpus.notes > 0) memory.push(t.corpus(a.corpus.notes))
  out.push(...block(1, t.leads[0], memory))

  const reflexes = []
  if (a.catchTotal > 0) {
    reflexes.push(t.mined(a.catchTotal))
    for (const kind of Object.keys(a.byKind ?? {}).sort()) {
      reflexes.push(t.kindLine(t.kind[kind] ?? kind, a.byKind[kind]))
    }
    reflexes.push(t.minedTail)
  } else {
    reflexes.push(t.minedZero)
  }
  out.push(...block(2, t.leads[1], reflexes))

  out.push(...block(3, t.leads[2], [t.coordination, t.coordinationTail]))
  out.push(...block(4, t.leads[3], [t.receipts, t.receiptsTail]))
  out.push(...block(5, t.leads[4], [t.safety, t.safetyTail]))

  out.push(RULE, t.closeRead, t.closeNext)
  return out.join('\n')
}

// ── selftest (the falsifiable check) ─────────────────────────────────────────

/**
 * startMapSelftest() — hermetic, no real git, no fs writes:
 *   1. a fixture repo analyzed + rendered TWICE → byte-equal (determinism)
 *   2. a THROWING git (no repository) → the fresh-project map, five promises, no crash
 *   3. both languages render five promises and ask nothing (no «?» in a map)
 * Returns 1 on full pass, else 0. Never throws.
 */
export function startMapSelftest() {
  try {
    const fixtureGit = (args) => {
      if (args[0] === 'ls-files') return ['src/app/a.ts', 'src/app/b.ts', 'src/lib/c.ts', 'docs/readme.md'].join('\n')
      return '' // log — zero catches
    }
    const io = { exists: () => false, readdir: () => [], readFile: () => '' }
    const leads = (text) => text.split('\n').filter((l) => /^\d\. /.test(l)).length

    const a1 = analyzeForMap({ repoDir: 'fixture', runGit: fixtureGit, io })
    const a2 = analyzeForMap({ repoDir: 'fixture', runGit: fixtureGit, io })
    if (renderStartMap(a1, { lang: 'en' }) !== renderStartMap(a2, { lang: 'en' })) return 0

    const broken = analyzeForMap({
      repoDir: 'nowhere',
      runGit: () => {
        throw new Error('not a git repository')
      },
      io,
    })
    if (!broken.empty) return 0

    const synth = {
      repoDir: 'x',
      empty: false,
      fileCount: 4,
      areas: [{ dir: 'src', count: 3, tag: 'src' }],
      byKind: { 'revert-pair': 2, 'ci-fix-forward': 1 },
      catchTotal: 3,
      corpus: { notes: 4, present: true },
    }
    for (const lang of ['en', 'ru']) {
      for (const analysis of [a1, broken, synth]) {
        const r = renderStartMap(analysis, { lang })
        if (leads(r) !== 5) return 0
        if (r.includes('?')) return 0
        if (renderStartMap(analysis, { lang }) !== r) return 0
      }
    }
    return 1
  } catch {
    return 0
  }
}
