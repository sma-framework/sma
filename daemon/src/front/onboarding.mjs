/**
 * onboarding.mjs — the first-run interview: the engine behind the «Первый запуск»
 * screen (D-9.7-16, T-9.7-43/44).
 *
 * WHAT IT IS: a state machine over four steps of plain-language questions —
 * «О проекте · Как выкатываете · Что значит готово · Записная книжка» — asked one
 * at a time, in the user's own words, with no field names on screen. When the
 * interview ends it produces EXACTLY the artifacts the terminal onboarding
 * produces: `.sma/profile.json` and the starter corpus notes.
 *
 * THE LAW IT ENFORCES — ONE WRITER (D-9.7-16). This module writes NO profile and
 * NO note of its own. `complete()` hands the collected answers to
 * `scripts/sma/lib/profile-writer.mjs` and returns what that module reports. The
 * screen and the terminal flow therefore cannot drift: they are not two writers
 * agreeing, they are one writer called twice. The parity test compares the BYTES
 * of the two paths, so the day someone adds a second write path here, it fails.
 *
 *   screen «Первый запуск» ─┐
 *                           ├─▶ writeProfile + seedCorpusNotes ─▶ .sma/profile.json
 *   terminal  /sma-start ───┘                                     .claude/memory/*.md
 *
 * WHICH MAKES THE SCREEN'S FOOTER TRUE. It says «Привычнее в терминале? sma start
 * — всё сохранится». That promise is honest only while both paths write the same
 * file the same way; this module is the half of that promise the screen owes.
 *
 * DESIGN LAWS:
 *   - THE ENGINE ONLY. Questions, cursor, draft. HTTP handlers live at the door
 *     (the front server), rendering lives in the screen — a state machine that can
 *     be driven from a test without a socket is the point.
 *   - AN ANSWER IS NEVER LOST TO A RESTART. Every accepted answer is mirrored to
 *     `.sma/onboarding-draft.json` atomically; a new engine over the same directory
 *     resumes exactly where the interview stopped. `complete()` drops the draft.
 *   - THE CURSOR IS DERIVED, NEVER STORED. «The next question» is the first one
 *     nobody has visited, in screen order. A skipped question is VISITED but
 *     UNANSWERED, so the cursor moves on and the answer stays absent — a skip is
 *     an answer the profile simply will not carry.
 *   - SECRETS ARE REFUSED AT THE DOOR (T-9.7-43). The writer's own heuristic runs
 *     on every answer BEFORE it reaches memory or the draft file: a token typed
 *     into a text box must not survive in a file on the way to the profile that
 *     would have rejected it.
 *   - UNKNOWN KEYS ARE REFUSED BY NAME. A key from another step, or no step at
 *     all, throws instead of silently landing in a map nobody reads.
 *   - THERE IS AN EXIT THAT WRITES NOTHING (D-11-DEFER-17). `complete()` is one way
 *     out of the interview and `declineForNow()` is the other: it records «позже»
 *     in the DAEMON's own data directory and leaves the project untouched — no
 *     profile, no starter notes, not even the draft, which stays so the interview
 *     can be picked up later. A window with only the writing exit is a wall.
 *
 * Node built-ins only; zero npm deps. Every fs call is dependency-injectable.
 */

import {
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  writeFileSync as fsWriteFileSync,
  renameSync as fsRenameSync,
  readFileSync as fsReadFileSync,
  rmSync as fsRmSync,
} from 'node:fs'
import { join } from 'node:path'

import { atomicWriteJson, readJsonSafe } from '../../../scripts/sma/lib/fs-atomics.mjs'
import {
  assertNoSecrets,
  writeProfile as defaultWriteProfile,
  seedCorpusNotes as defaultSeedCorpusNotes,
} from '../../../scripts/sma/lib/profile-writer.mjs'

/** Named error: a step/key pair that the interview does not know (or a base key asked as a chip). */
export class UnknownQuestionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnknownQuestionError'
  }
}

/** Named error: «позже» was asked for with nowhere on the daemon's side to remember it. */
export class NoStateDirError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NoStateDirError'
  }
}

/** The draft file, next to the profile it will become. */
export const DRAFT_FILE = 'onboarding-draft.json'

/**
 * Where «спросите меня позже» is remembered — in the DAEMON's own data directory, never in
 * the project (D-11-DEFER-17).
 *
 * THE EXIT THAT LEAVES THE DISK ALONE. Until now the only way out of the interview was
 * `complete()`, which writes `.sma/profile.json` AND seeds starter notes into the project.
 * So a person who did not want to be interviewed had to be interviewed anyway, and a project
 * that has no profile BY DESIGN (developer mode) could never reach «Агенты» or «Память» at
 * all — the first run took the whole window and had no door.
 *
 * The flag lives here rather than in the project because declining is a fact about this
 * PERSON at this daemon, not about the project's files: writing anything at all into someone
 * else's tree is the thing the decline was declining. A project that is later opened by a
 * daemon that never heard the answer asks again, which is the honest behaviour.
 */
export const DECLINED_FILE = 'onboarding-declined.json'

/** The draft schema version — a stale shape is ignored rather than half-read. */
export const DRAFT_VERSION = 1

// ─────────────────────────── the interview ───────────────────────────────────
//
// Four steps, 12 base questions, 13 optional topics — the screen's own content,
// verbatim. Every key here is routed by the writer's INTERVIEW_MAP: a question
// with nowhere to land is a question that wastes the user's time, and the suite
// pins that correspondence.
//
// `questions` are asked always; `extras` are chips the user may add («хотите
// рассказать подробнее») and are asked after the base questions of their step.

/** @typedef {{key:string, title:string, question:string, hint:string}} Question */
/** @typedef {{step:number, label:string, questions:Question[], extras:Question[]}} Step */

/** @type {Step[]} */
export const STEPS = [
  {
    step: 1,
    label: 'О проекте',
    questions: [
      {
        key: 'about',
        title: 'Чем занимается проект',
        question: 'Чем занимается Ваш проект? Двумя-тремя фразами, своими словами.',
        hint: 'Например: интернет-магазин детской мебели, заказы, доставка, склад.',
      },
      {
        key: 'clients',
        title: 'Клиенты',
        question: 'Кто Ваши клиенты и что они делают у Вас чаще всего?',
        hint: 'Например: родители выбирают кроватку, оформляют доставку, звонят с вопросами по заказу.',
      },
      {
        key: 'core',
        title: 'Что нельзя ломать',
        question: 'Что в проекте важнее всего и ломать это нельзя ни при каких условиях?',
        hint: 'Например: оплата, оформление заказа, письма покупателям.',
      },
      {
        key: 'pain',
        title: 'Что отнимает время',
        question: 'Что чаще всего идёт не так и отнимает Ваше время?',
        hint: 'Например: остатки на складе расходятся, доставка теряет адреса, отчёты собираю руками.',
      },
    ],
    extras: [
      {
        key: 'team',
        title: 'Кто помогает',
        question: 'Кто ещё работает над проектом и за что отвечает?',
        hint: 'Например: я, продавец на телефоне, бухгалтер раз в месяц.',
      },
      {
        key: 'tools',
        title: 'Где ведёте дела',
        question: 'Где сейчас лежат заказы, задачи и переписка?',
        hint: 'Например: заказы в таблице, задачи в блокноте, переписка в мессенджере.',
      },
      {
        key: 'season',
        title: 'Сезонность',
        question: 'Есть ли периоды, когда нагрузка резко растёт?',
        hint: 'Например: август и декабрь, перед школой и перед праздниками.',
      },
      {
        key: 'goal',
        title: 'Цель на три месяца',
        question: 'Чего Вы хотите добиться в ближайшие три месяца?',
        hint: 'Например: меньше ручной работы с заказами, короткий отчёт каждое утро.',
      },
    ],
  },
  {
    step: 2,
    label: 'Как выкатываете',
    questions: [
      {
        key: 'flow',
        title: 'Порядок выкладки',
        question: 'Как Ваши изменения попадают к пользователям?',
        hint: 'Например: проверяю сам, выкладываю вечером, при поломке возвращаю прежнюю версию.',
      },
      {
        key: 'who',
        title: 'Кто решает',
        question: 'Кто принимает решение о выкладке и как Вы об этом узнаёте?',
        hint: 'Например: решаю я, короткое сообщение в мессенджер сразу после выкладки.',
      },
      {
        key: 'window',
        title: 'Когда можно',
        question: 'Когда выкладывать можно, а когда лучше не трогать?',
        hint: 'Например: с десяти до восемнадцати по будням, в пятницу вечером не трогать.',
      },
    ],
    extras: [
      {
        key: 'rollback',
        title: 'Если сломалось',
        question: 'Что Вы делаете, если после выкладки что-то сломалось?',
        hint: 'Например: возвращаю прежнюю версию, пишу клиентам, разбираюсь утром.',
      },
      {
        key: 'notify',
        title: 'Кого предупредить',
        question: 'Кого нужно предупредить заранее и в каком случае?',
        hint: 'Например: продавца на телефоне всегда, бухгалтера в конце месяца.',
      },
      {
        key: 'places',
        title: 'Где живёт проект',
        question: 'Где Ваш проект работает у пользователей?',
        hint: 'Например: сайт магазина, страница в мессенджере, две точки выдачи.',
      },
    ],
  },
  {
    step: 3,
    label: 'Что значит готово',
    questions: [
      {
        key: 'done',
        title: 'Признаки готовой работы',
        question: 'Когда работу можно считать готовой?',
        hint: 'Например: открывается без ошибок, оплата проходит, письмо покупателю приходит.',
      },
      {
        key: 'check',
        title: 'Что проверяете первым',
        question: 'Что Вы проверяете в первую очередь, когда смотрите работу?',
        hint: 'Например: цену в корзине, адрес доставки, что письмо пришло.',
      },
      {
        key: 'reject',
        title: 'Когда вернёте назад',
        question: 'При чём Вы точно вернёте работу назад?',
        hint: 'Например: цифры не сходятся, тон текста не мой, что-то показано клиентам без меня.',
      },
    ],
    extras: [
      {
        key: 'tone',
        title: 'Тон текстов',
        question: 'Как должны звучать тексты, которые видят Ваши клиенты?',
        hint: 'Например: спокойно и коротко, без шуток, обращение на Вы.',
      },
      {
        key: 'small',
        title: 'Мелочи',
        question: 'Какие мелочи Вы замечаете сразу и считаете важными?',
        hint: 'Например: опечатки в названиях, разные форматы дат, лишние пробелы.',
      },
      {
        key: 'report',
        title: 'Как отчитываться',
        question: 'В каком виде Вам удобно получать итог работы?',
        hint: 'Например: три строки, что сделано, что проверено, что осталось.',
      },
    ],
  },
  {
    step: 4,
    label: 'Записная книжка',
    questions: [
      {
        key: 'rules',
        title: 'Что запомнить',
        question: 'Что Вашим работникам стоит запомнить на будущее?',
        hint: 'Например: оплату по пятницам не трогать, перед выкладкой писать мне.',
      },
      {
        key: 'past',
        title: 'Не повторять',
        question: 'Был случай, который больше повторять не нужно?',
        hint: 'Например: письма ушли дважды, скидка сработала на весь каталог.',
      },
    ],
    extras: [
      {
        key: 'words',
        title: 'Ваши слова',
        question: 'Какие слова у Вас в ходу и что они значат?',
        hint: 'Например: «горячий заказ», это доставка сегодня.',
      },
      {
        key: 'ask',
        title: 'Когда спрашивать Вас',
        question: 'В каких случаях работник обязан спросить Вас, а не решать сам?',
        hint: 'Например: возврат денег, скидка больше десяти процентов, письмо всем клиентам.',
      },
      {
        key: 'people',
        title: 'Кому писать',
        question: 'Кому и куда писать, если Вас нет на связи?',
        hint: 'Например: продавцу в мессенджер, срочное, звонок.',
      },
    ],
  },
]

/**
 * The «Что уже готово» panel. Three promises the install makes to a person who
 * has not answered anything yet: the team already exists (it is installed, not
 * earned), the safety rules switch on as soon as the release habits are known,
 * and the notebook fills from the last step. Each line's `done` is DERIVED from
 * what has accumulated — never a stored flag, so it cannot disagree with the
 * answers.
 */
export const READY = [
  { lead: 'Команда собрана', tail: 'семь ролей', fromStep: null },
  { lead: 'Правила безопасности включены', tail: 'ничего не публикуется без Вас', fromStep: 2 },
  { lead: 'Записная книжка создана', tail: 'наполняется Вашими уроками', fromStep: 4 },
]

/** key -> {step, question, optional}. Keys are unique across the whole interview. */
const BY_KEY = new Map()
for (const step of STEPS) {
  for (const q of step.questions) BY_KEY.set(q.key, { step: step.step, question: q, optional: false })
  for (const q of step.extras) BY_KEY.set(q.key, { step: step.step, question: q, optional: true })
}

/** The step spec by its number. */
const BY_STEP = new Map(STEPS.map((s) => [s.step, s]))

// ─────────────────────────── the engine ──────────────────────────────────────

/** Resolve the injectable fs surface; defaults are the real node:fs calls. */
function resolveIo(fsImpl) {
  const io = fsImpl ?? {}
  return {
    existsSync: io.existsSync ?? fsExistsSync,
    mkdirSync: io.mkdirSync ?? fsMkdirSync,
    writeFileSync: io.writeFileSync ?? fsWriteFileSync,
    renameSync: io.renameSync ?? fsRenameSync,
    readFileSync: io.readFileSync ?? fsReadFileSync,
    rmSync: io.rmSync ?? fsRmSync,
  }
}

/** Trim and normalize line endings; a blank answer is «не ответил», not an empty string. */
function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : ''
}

/**
 * createOnboarding({targetDir, stateDir, fsImpl, writer}) — the first-run interview engine.
 *
 * `writer` is the profile writer, injected so a test can prove the engine has no
 * write path of its own: with an inert writer, `complete()` leaves the disk empty.
 * In production it is `scripts/sma/lib/profile-writer.mjs` — the ONE writer.
 *
 * `stateDir` is the DAEMON's own data directory and it holds exactly one fact: whether this
 * person said «позже» (DECLINED_FILE). Absent, `declineForNow()` refuses by name rather than
 * inventing somewhere to write — the whole point of the exit is that it writes nothing the
 * caller did not ask for.
 *
 * @param {{targetDir?:string, stateDir?:string, fsImpl?:object, writer?:{writeProfile:Function, seedCorpusNotes:Function}}} [args]
 * @returns {{getState:Function, answer:Function, addTopic:Function, complete:Function, declineForNow:Function}}
 */
export function createOnboarding({ targetDir = process.cwd(), stateDir, fsImpl, writer } = {}) {
  const io = resolveIo(fsImpl)
  const write = writer ?? { writeProfile: defaultWriteProfile, seedCorpusNotes: defaultSeedCorpusNotes }

  const profilePath = join(targetDir, '.sma', 'profile.json')
  const draftPath = join(targetDir, '.sma', DRAFT_FILE)
  const declinedPath =
    typeof stateDir === 'string' && stateDir.trim() !== '' ? join(stateDir, DECLINED_FILE) : null

  /** @type {Record<string,string>} */
  let answers = {}
  /** @type {Record<string,boolean>} */
  let visited = {}
  /** @type {string[]} */
  let added = [] // optional topics pulled into the queue, in the order they joined
  let completed = false

  // «Позже», remembered across restarts on the daemon's side. A file that is not there, is
  // not readable, or does not say `declined: true` all mean the same thing: nobody declined.
  const declinedRecord = declinedPath ? readJsonSafe(declinedPath, { readFn: io.readFileSync }) : null
  let declined = !!(declinedRecord && declinedRecord.declined === true)

  // Resume: a draft left by a previous engine over this directory (T-9.7-44).
  const draft = readJsonSafe(draftPath, { readFn: io.readFileSync })
  if (draft && draft.version === DRAFT_VERSION) {
    for (const [key, text] of Object.entries(draft.answers ?? {})) {
      if (BY_KEY.has(key) && typeof text === 'string') answers[key] = text
    }
    for (const key of Object.keys(draft.visited ?? {})) {
      if (BY_KEY.has(key)) visited[key] = true
    }
    for (const key of Array.isArray(draft.added) ? draft.added : []) {
      const spec = BY_KEY.get(key)
      if (spec && spec.optional && !added.includes(key)) added.push(key)
    }
  }

  /** Persist the interview so far — atomically, so a crash never tears the draft. */
  function saveDraft() {
    atomicWriteJson(
      draftPath,
      { version: DRAFT_VERSION, answers, visited, added },
      { mkdirFn: io.mkdirSync, writeFn: io.writeFileSync, renameFn: io.renameSync },
    )
  }

  /** The questions of one step in asking order: the base set, then the added chips. */
  function queueOf(step) {
    const spec = BY_STEP.get(step)
    if (!spec) return []
    const chips = added.map((key) => BY_KEY.get(key)).filter((e) => e && e.step === step)
    return [...spec.questions.map((q) => ({ question: q, optional: false })), ...chips.map((e) => ({ question: e.question, optional: true }))]
  }

  /** Resolve (step, key) or throw by name — the engine's rejectUnknownKeys door. */
  function locate(step, key) {
    const found = BY_KEY.get(key)
    if (!found) {
      throw new UnknownQuestionError(
        `неизвестный вопрос «${key}» — интервью первого запуска такого не задаёт`,
      )
    }
    if (found.step !== step) {
      throw new UnknownQuestionError(
        `вопрос «${key}» принадлежит шагу ${found.step}, а не шагу ${step}`,
      )
    }
    return found
  }

  /**
   * The cursor: the first question nobody has visited, in screen order. Derived,
   * never stored — a skipped question is visited, so it is behind us; an answer
   * given out of order simply removes that question from what is left.
   */
  function cursor() {
    for (const step of STEPS) {
      const queue = queueOf(step.step)
      for (let index = 0; index < queue.length; index += 1) {
        const entry = queue[index]
        if (!visited[entry.question.key]) {
          return { step: step.step, index, ...entry }
        }
      }
    }
    return null
  }

  /** How many answers landed inside one step (the panels and meters all count this). */
  function answeredIn(step) {
    return Object.keys(answers).filter((key) => BY_KEY.get(key)?.step === step).length
  }

  function getState() {
    const at = cursor()
    const lastStep = STEPS[STEPS.length - 1].step

    return {
      // The need itself: no profile on disk, no completed interview, and nobody said «позже».
      needed: !completed && !declined && !io.existsSync(profilePath),
      done: completed,
      /** Whether the window is open because a person asked to be left alone for now. */
      declined,
      finished: at === null,

      step: at ? at.step : lastStep,
      questionIndex: at ? at.index : queueOf(lastStep).length,
      question: at ? { ...at.question, step: at.step, index: at.index, optional: at.optional } : null,

      answers: { ...answers },
      visited: { ...visited },
      totalAnswered: Object.keys(answers).length,
      totalQuestions: STEPS.reduce((sum, s) => sum + queueOf(s.step).length, 0),

      steps: STEPS.map((s) => ({
        step: s.step,
        label: s.label,
        answered: answeredIn(s.step),
        total: queueOf(s.step).length,
        current: at ? at.step === s.step : false,
      })),

      extraTopics: STEPS.flatMap((s) =>
        s.extras.map((q) => ({
          step: s.step,
          key: q.key,
          title: q.title,
          question: q.question,
          hint: q.hint,
          added: added.includes(q.key),
        })),
      ),

      ready: READY.map((r) => ({
        lead: r.lead,
        tail: r.tail,
        done: r.fromStep === null ? true : answeredIn(r.fromStep) > 0,
      })),
    }
  }

  /**
   * answer({step, key, text}) — record one answer and move on.
   *
   * Order is the safety story: locate the question, screen the text for secrets,
   * and only then touch memory or the draft. A refusal at either gate leaves both
   * exactly as they were (T-9.7-43).
   *
   * An empty text is a SKIP: visited, unanswered, cursor moves on.
   */
  function answer({ step, key, text } = {}) {
    const found = locate(step, key)
    assertNoSecrets({ [key]: text })

    const clean = normalizeText(text)
    if (clean) answers[key] = clean
    else delete answers[key]
    visited[key] = true

    // Answering a chip nobody queued pulls it into the interview on the spot.
    if (found.optional && !added.includes(key)) added.push(key)

    saveDraft()
    return getState()
  }

  /**
   * addTopic({step, key}) — pull an optional topic into the queue of its step; it
   * is asked after that step's base questions. A base question is not a chip.
   */
  function addTopic({ step, key } = {}) {
    const found = locate(step, key)
    if (!found.optional) {
      throw new UnknownQuestionError(`вопрос «${key}» задаётся всегда — его не нужно добавлять темой`)
    }
    if (!added.includes(key)) added.push(key)
    saveDraft()
    return getState()
  }

  /**
   * complete() — hand the answers to the ONE writer and close the need.
   *
   * Everything written here is written by `profile-writer.mjs`: the profile, its
   * bytes, the starter notes. The engine's only own file is the draft, and it
   * removes it. That is what makes the parity test a law rather than a hope.
   */
  function complete() {
    const collected = { ...answers }
    const written = write.writeProfile({ answers: collected, targetDir })
    const seeded = write.seedCorpusNotes({ answers: collected, targetDir })

    io.rmSync(draftPath, { force: true })
    completed = true

    return {
      profilePath: written.path,
      profile: written.profile,
      notes: seeded.files ?? [],
      notesDir: seeded.dir,
    }
  }

  /**
   * declineForNow() — «позже»: close the need WITHOUT writing anything into the project.
   *
   * It is the exact opposite of `complete()` and that is the whole design. `complete()` calls
   * the one writer and produces `.sma/profile.json` plus the starter corpus notes; this
   * records ONE boolean in the daemon's own data directory and touches the project not at
   * all — not the profile, not a note, not even the draft, which stays exactly where it was
   * so the interview can be resumed later from the same answers.
   *
   * With nowhere on the daemon's side to remember it, it refuses by name instead of picking a
   * directory of its own: an exit that quietly wrote somewhere unexpected would be the very
   * thing a person pressing «позже» is refusing.
   */
  function declineForNow() {
    if (!declinedPath) {
      throw new NoStateDirError(
        'некуда записать «позже»: демону не передан собственный каталог данных — в проект такое не пишется',
      )
    }
    atomicWriteJson(
      declinedPath,
      { version: DRAFT_VERSION, declined: true, at: new Date().toISOString() },
      { mkdirFn: io.mkdirSync, writeFn: io.writeFileSync, renameFn: io.renameSync },
    )
    declined = true
    return getState()
  }

  return { getState, answer, addTopic, complete, declineForNow }
}
