/**
 * lib/ui-stage.mjs — the decidable half of the live window scene (scripts/sma/ui-stage.mjs).
 *
 * ═══════════════════════ WHAT LIVES HERE, AND WHY ════════════════════════════════
 * Pure functions over strings and numbers: the argument grammar, the address the run
 * engine is handed, the config object the scene's door is built from, the KIT of trees and
 * text the scene stands the window on, and the words a missing build is refused with. The
 * impure half — taking a port, making a directory, writing the kit down, minting a token,
 * taking the whole thing down again — stays in the command, so the part that can be wrong
 * about an ADDRESS or about a FIXTURE is the part a test can pin without a socket.
 *
 * ═══════════════════════ THE TOKEN IS NOT A FILE ═════════════════════════════════
 * Nothing here mints, stores or reads a credential. The scene's token is made in the
 * command's own memory and travels to whatever the scene runs through the ENVIRONMENT
 * and through the printed address — never through a file. A scene that had to write a
 * token down would be a scene that makes every worker walk around this product's own
 * ban on secrets in the tree.
 *
 * Node built-ins only; nothing here touches the disk or the network (`join` shapes paths,
 * it does not visit them).
 */

import { join } from 'node:path'

/** The scene never binds anything but loopback: it is a window for one machine's operator. */
export const STAGE_HOST = '127.0.0.1'

/** The prefix of the throwaway directory the scene lives in, under the system temp dir. */
export const STAGE_DIR_PREFIX = 'sma-ui-stage-'

/**
 * …and the one directory the scene makes that it does NOT throw away: where the run engine
 * puts its receipt. It is a sibling of the throwaway dir, not a child, and that is the whole
 * design — evidence whose lifetime is the scene's lifetime is evidence nobody can read
 * afterwards, which is exactly how two runs lost their screenshots and their verdict in one
 * shift. It sits outside every working copy, so removing a copy cannot take it.
 */
export const STAGE_RECEIPTS_DIR = 'sma-ui-receipts'

/** What a trailing command may write instead of the address it cannot know in advance. */
export const URL_PLACEHOLDER = '{url}'

/** …and the same address, handed to that command through its environment. */
export const URL_ENV = 'SMA_STAGE_URL'

/** Bad arguments — nothing was raised (the ui-drive vocabulary, deliberately). */
export const EXIT_BAD_ARGS = 2

/** No build to open — NOT RUN, never a quiet pass. */
export const EXIT_NO_BUILD = 3

/**
 * parseStageArgs(argv) — the whole grammar of the command.
 *
 *   node scripts/sma/ui-stage.mjs                       → raise and HOLD until a signal
 *   node scripts/sma/ui-stage.mjs -- <cmd> [args…]      → raise, run <cmd>, take it down
 *
 * There is deliberately no `--port` and no `--dir`. A port a caller names is a port that
 * may belong to the real daemon, and this scene's whole reason to exist is that it can
 * never be that daemon; the free one is found by TAKING it, which no argument can do.
 *
 * @param {string[]} [argv]
 * @returns {{ok:true, hold:boolean, command:string[]} | {ok:false, error:string}}
 */
export function parseStageArgs(argv = []) {
  const list = (Array.isArray(argv) ? argv : []).map((a) => String(a))
  const cut = list.indexOf('--')
  const head = cut < 0 ? list : list.slice(0, cut)
  const command = cut < 0 ? [] : list.slice(cut + 1)
  const stray = head.filter((a) => a !== '')
  if (stray.length > 0) {
    return { ok: false, error: `unknown argument: ${stray[0]} — the scene takes none before «--».` }
  }
  if (cut >= 0 && command.length === 0) {
    return { ok: false, error: '«--» stands with no command after it — nothing would be run.' }
  }
  return { ok: true, hold: cut < 0, command }
}

/**
 * stageUrl({host, port, token}) — the address the scene prints.
 *
 * It carries the token as a query parameter because that is the ONE exchange the front
 * honours from a URL (GET / mints the session cookie from it and nothing else does), and
 * because the run engine takes a plain url and has nowhere to put a header. It is printed
 * to a terminal, never written to a file — see the module header.
 *
 * @returns {string}
 */
export function stageUrl({ host = STAGE_HOST, port, token } = {}) {
  return `http://${host}:${port}/?token=${token}`
}

/**
 * stageCommandArgs(command, url) — the trailing command with every `{url}` filled in.
 * A command that names no placeholder is handed back untouched: it can still read the
 * address out of its environment (URL_ENV).
 *
 * @returns {string[]}
 */
export function stageCommandArgs(command = [], url = '') {
  return (Array.isArray(command) ? command : []).map((a) => String(a).split(URL_PLACEHOLDER).join(url))
}

// ═══════════════════ THE KIT: THE SCENE BRINGS ITS OWN TREES ═════════════════════
//
// A DOOR WITH NOTHING BEHIND IT ANSWERS «НЕ РЕАЛИЗОВАНО», AND THAT IS A LIE ABOUT THE
// PRODUCT. Measured on the raised scene: four read models answered 501 — the conversation,
// the backlog, coordination and the harness — because the scene wired the shell's three
// collaborators and stopped. For the command that only promised to raise and clean up, that
// was honest. For the worker who takes the scene to check «Задачи» or «Бэклог», it is a red
// verdict about somebody else's work: they go hunting a defect in a place that has none. We
// have already burnt half a shift on exactly that shape of false lead.
//
// So the scene carries a KIT: two project trees and the text to fill them with. The trees are
// TWO deliberately — the two-tree case is our own, and it is the treacherous one (work is
// routed to the tree the code is not in), so «switch the project» must be a thing a run can
// actually do rather than a control with one entry under it. They differ on purpose: the
// first is a busy checkout (a backlog, a live session, a held reservation, a collision
// journalled today, a skill of its own), the second is quiet (its own backlog and nothing
// else) — so a switch between them CHANGES the screen, which is the only way a run can tell
// that the switch happened at all.
//
// EVERYTHING HERE IS TEXT AND SHAPE. Not one byte of it is written by this module; the
// command writes the kit into the throwaway directory it already owns, and it dies with it.

/** Where the kit's trees live inside the scene's own throwaway directory. */
export const STAGE_PROJECTS_DIR = 'projects'

/**
 * The two trees, as the registry sees them. The ids are ordinary slugs and the names are what
 * a person reads in the switcher — neither carries a number from anybody's ledger.
 */
export const STAGE_PROJECTS = Object.freeze([
  Object.freeze({ id: 'stage-main', name: 'Сцена · основное дерево', dir: 'stage-main' }),
  Object.freeze({ id: 'stage-second', name: 'Сцена · второе дерево', dir: 'stage-second' }),
])

/**
 * stageProjects(home) → the registry entries for the kit's trees, rooted in the scene's own
 * directory. `path` is what every read model joins onto; nothing outside `home` is named.
 *
 * @returns {Array<{id:string, name:string, path:string}>}
 */
export function stageProjects(home = '') {
  return STAGE_PROJECTS.map((p) => ({ id: p.id, name: p.name, path: join(home, STAGE_PROJECTS_DIR, p.dir) }))
}

/** The first tree is the one the window opens on, and the one the busy fixture lives in. */
export const STAGE_ACTIVE_PROJECT = STAGE_PROJECTS[0].id

/**
 * A profile is what the first-run interview WRITES, and its presence is what tells the window
 * the house is already set up. Without one the scene opens on the interview forever — a real
 * state of a real install, but not the one a person raising a scene is trying to look at.
 */
function stageProfile(name) {
  return `${JSON.stringify({ project: name, stack: 'the scene fixture', ready: 'the suite is green' }, null, 2)}\n`
}

/**
 * The board a project keeps by hand. The shape is the one `deriveBacklog` parses by — a
 * bulleted line whose bold lead is «letters, dash, number» — and the ticked row is here on
 * purpose: a board that showed it would be a history, and the derive drops it.
 */
const MAIN_BACKLOG = [
  '# Бэклог — основное дерево сцены',
  '',
  'Файл ведёт человек. Окно его читает и никогда не пишет.',
  '',
  '- **SCN-1** · Переключение проектов проверяется на двух деревьях, а не на одном `opened:2026-08-20`',
  '- **SCN-2** · Квитанция прогона лежит вне рабочей копии и переживает её `opened:2026-08-22`',
  '- **SCN-3** · Каждая дверь окна отвечает по существу, а не отказом `opened:2026-08-25`',
  '- [x] **SCN-4** · Сцена убирает за собой порт и каталог',
  '',
  'Строка без идентификатора — это проза, и на доску она не попадает.',
  '',
].join('\n')

const SECOND_BACKLOG = [
  '# Бэклог — второе дерево сцены',
  '',
  '- **ALT-7** · Задача уехала в дерево, где нужного кода нет `opened:2026-08-24`',
  '- **ALT-8** · Второе дерево тихое: ни сессий, ни броней, ни столкновений `opened:2026-08-26`',
  '',
].join('\n')

/** One skill of the project store, so «Навыки» has a card that names where it came from. */
const MAIN_SKILL = [
  '---',
  'name: Обход сцены',
  'description: Как пройти поднятое окно и что смотреть на каждом экране.',
  '---',
  '',
  'Навык лежит в хранилище ПРОЕКТА — карточка в окне называет хранилище, из которого взята.',
  '',
].join('\n')

/**
 * stageProjectFiles(id) → the plain files of one tree: `[{path:[…segments], text}]`.
 *
 * An unknown id yields an empty tree rather than a throw: the kit is a fixture, and a fixture
 * that can crash the command that raises the window is worse than a thin one.
 *
 * @returns {Array<{path:string[], text:string}>}
 */
export function stageProjectFiles(id) {
  if (id === STAGE_PROJECTS[0].id) {
    return [
      { path: ['.sma', 'profile.json'], text: stageProfile(STAGE_PROJECTS[0].name) },
      { path: ['.planning', 'BACKLOG.md'], text: MAIN_BACKLOG },
      { path: ['.claude', 'skills', 'stage-walkthrough', 'SKILL.md'], text: MAIN_SKILL },
    ]
  }
  if (id === STAGE_PROJECTS[1].id) {
    return [
      { path: ['.sma', 'profile.json'], text: stageProfile(STAGE_PROJECTS[1].name) },
      { path: ['.planning', 'BACKLOG.md'], text: SECOND_BACKLOG },
    ]
  }
  return []
}

/**
 * The conversation the scene opens with. Turns are stamped with the PROJECT they were said
 * under — the same field the real transcript carries — so the «Разговор» screen narrows with
 * the switcher instead of showing one tree's words under the other's name.
 */
export const STAGE_CHAT_TURNS = Object.freeze([
  Object.freeze({
    conversationId: 'stage-main-1',
    project: STAGE_PROJECTS[0].id,
    role: 'user',
    text: 'Что сейчас открыто в основном дереве?',
  }),
  Object.freeze({
    conversationId: 'stage-main-1',
    project: STAGE_PROJECTS[0].id,
    role: 'assistant',
    text: 'Три строки бэклога, одна бронь и одно столкновение за сегодня. Это фикстура сцены — очередь пуста намеренно.',
  }),
  Object.freeze({
    conversationId: 'stage-second-1',
    project: STAGE_PROJECTS[1].id,
    role: 'user',
    text: 'А во втором дереве?',
  }),
  Object.freeze({
    conversationId: 'stage-second-1',
    project: STAGE_PROJECTS[1].id,
    role: 'assistant',
    text: 'Тихо: свой бэклог есть, работающих окон нет. Ровно тот случай, когда задача уезжает туда, где кода нет.',
  }),
])

/**
 * The coordination ledger of the busy tree, as ARGUMENTS to the runtime's own writers.
 *
 * The scene writes `.sma/` with `heartbeat`, `claimSlot` and `appendEvent` — the same three
 * that a terminal writes it with — because the daemon reads it back with that runtime's own
 * readers. A fixture hand-shaped into the file format would be a second writer of a format
 * nobody promised to keep, and it would go stale in silence the first time the real one moved.
 */
export const STAGE_LEDGER = Object.freeze({
  terminalId: 'stage-terminal',
  holderIdentity: 'Сцена',
  label: 'смотрит окно этой рабочей копии',
  globs: Object.freeze(['spa/src/**', 'daemon/src/front/**']),
  description: 'окно и его двери',
  otherActor: 'Соседнее окно',
  collisionScope: 'daemon/src/front/**',
})

/**
 * stageConfig({port, token, projects, activeProject}) — the config the scene's door is built
 * from.
 *
 * Made in memory, from nothing on disk: `loadConfig` is never called, so the operator's
 * own `~/.sma-daemon/config.json` is neither read nor written and this token never meets
 * a file. `port` is 0 at construction — the OS assigns the real one at bind time, and the
 * caller writes it back here once the door is actually holding it.
 *
 * The REGISTRY rides here too, and it is the only reason the read models have anything to
 * read: every one of them starts at `connectedProject(config)`, and with no registry all four
 * of them are an empty answer at best and a 501 at worst. It stays a value the caller passes,
 * not one this function invents, so a test can raise the same door over one tree or none.
 *
 * @returns {object}
 */
export function stageConfig({ port = 0, token = '', projects = [], activeProject = null } = {}) {
  return {
    bind: STAGE_HOST,
    port,
    token,
    workers: [],
    projects,
    ...(activeProject ? { activeProject } : {}),
  }
}

/**
 * missingBuildMessage(dir) — the refusal when there is no built window to open.
 *
 * The scene does NOT build. A build takes minutes, writes into the tree, and would turn
 * «open the window» into «change the repository», silently, on somebody else's behalf.
 * So the state is named with the one command that fixes it, and the scene exits.
 *
 * @returns {string}
 */
export function missingBuildMessage(dir) {
  return [
    `SMA ui-stage: NOT RUN — there is no built window at ${dir}.`,
    '  Build it first, then raise the scene:  npm run build:spa',
    '  The scene opens a build; it never makes one on your behalf.',
  ].join('\n')
}

/**
 * announcement({url, port, dir, projects, receipts}) — what the scene says once the door is
 * holding the port.
 *
 * The port and the directory are printed because they are the claim this command makes:
 * that it is not standing on the real daemon's. A reader who cannot see them has to take
 * that on trust, and this product does not ask anybody to.
 *
 * THE RECEIPTS PATH IS PRINTED FOR THE SAME REASON, and it is the one line here about
 * something that OUTLIVES the scene. A run whose receipt landed inside the working copy lost
 * its screenshots and its verdict the moment the copy was taken away at acceptance — twice in
 * one shift. So the scene hands the run engine a receipts root outside every checkout, and
 * says where it is, because an artifact nobody can find is the same as no artifact.
 *
 * @returns {string}
 */
export function announcement({ url, port, dir, projects = [], receipts = '' } = {}) {
  const names = projects.map((p) => `${p.name} (${p.id})`).join(' · ')
  return [
    'SMA ui-stage: the window is up, on a port and a directory of its own.',
    `  address: ${url}`,
    `  port:    ${port}`,
    `  dir:     ${dir}`,
    ...(names ? [`  trees:   ${names}`] : []),
    ...(receipts ? [`  receipts: ${receipts}  (outside every working copy — it outlives this scene)`] : []),
    '  The token was minted at boot, lives in this process only, and is written to no file.',
  ].join('\n')
}

/** The line the holding scene ends its announcement with — how a person takes it down. */
export function holdNotice() {
  return '  Holding. Ctrl+C takes the window down and the directory with it.'
}
