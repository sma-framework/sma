/**
 * lib/ui-stage.mjs — the decidable half of the live window scene (scripts/sma/ui-stage.mjs).
 *
 * ═══════════════════════ WHAT LIVES HERE, AND WHY ════════════════════════════════
 * Pure functions over strings and numbers: the argument grammar, the address the run
 * engine is handed, the config object the scene's door is built from, and the words a
 * missing build is refused with. The impure half — taking a port, making a directory,
 * minting a token, taking the whole thing down again — stays in the command, so the part
 * that can be wrong about an ADDRESS is the part a test can pin without a socket.
 *
 * ═══════════════════════ THE TOKEN IS NOT A FILE ═════════════════════════════════
 * Nothing here mints, stores or reads a credential. The scene's token is made in the
 * command's own memory and travels to whatever the scene runs through the ENVIRONMENT
 * and through the printed address — never through a file. A scene that had to write a
 * token down would be a scene that makes every worker walk around this product's own
 * ban on secrets in the tree.
 *
 * Node built-ins only; nothing here touches the disk or the network.
 */

/** The scene never binds anything but loopback: it is a window for one machine's operator. */
export const STAGE_HOST = '127.0.0.1'

/** The prefix of the throwaway directory the scene lives in, under the system temp dir. */
export const STAGE_DIR_PREFIX = 'sma-ui-stage-'

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

/**
 * stageConfig({port, token}) — the config the scene's door is built from.
 *
 * Made in memory, from nothing on disk: `loadConfig` is never called, so the operator's
 * own `~/.sma-daemon/config.json` is neither read nor written and this token never meets
 * a file. `port` is 0 at construction — the OS assigns the real one at bind time, and the
 * caller writes it back here once the door is actually holding it.
 *
 * @returns {object}
 */
export function stageConfig({ port = 0, token = '' } = {}) {
  return { bind: STAGE_HOST, port, token, workers: [] }
}

/**
 * stageDiskConfig() — ФАЙЛ НАСТРОЕК СЦЕНЫ, и он НАМЕРЕННО не совпадает с копией в памяти.
 *
 * ЗАЧЕМ. У настроек два класса: одни применяются сразу, другие — только с нового запуска
 * демона, потому что файл читается один раз. Второй класс молчал о себе, и это молчание
 * дважды заставило владельца решить, что правка подействовала. Теперь окно говорит «в файле
 * одно, работаю по другому» — и это утверждение можно УВИДЕТЬ только на сцене, где два
 * значения действительно разные. Совпадающая пара доказывала бы обратное: что экран умеет
 * молчать.
 *
 * ЭТО НЕ ПОДДЕЛКА ДВЕРИ. Файл настоящий, лежит во временном каталоге сцены, и дверь состояния
 * читает его тем же чтением, каким читает файл настоящий демон. Отличается он от копии в
 * памяти ровно тем, чем отличался бы файл, который человек поправил при живом демоне.
 *
 * ТОКЕНА ЗДЕСЬ НЕТ И БЫТЬ НЕ МОЖЕТ. Токен сцены минтуется в процессе и не встречается ни с
 * одним файлом — это отдельный закон сцены, и «показать расхождение» его не отменяет. Файл
 * несёт ровно две настройки второго класса и больше ничего.
 *
 * @returns {object}
 */
export function stageDiskConfig() {
  return { maxConcurrentAttempts: 4, pipeline: { maxTurns: 400 } }
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
 * announcement({url, port, dir}) — what the scene says once the door is holding the port.
 *
 * The port and the directory are printed because they are the claim this command makes:
 * that it is not standing on the real daemon's. A reader who cannot see them has to take
 * that on trust, and this product does not ask anybody to.
 *
 * @returns {string}
 */
export function announcement({ url, port, dir } = {}) {
  return [
    'SMA ui-stage: the window is up, on a port and a directory of its own.',
    `  address: ${url}`,
    `  port:    ${port}`,
    `  dir:     ${dir}`,
    '  The token was minted at boot, lives in this process only, and is written to no file.',
    // Сказано вслух, иначе следующий человек примет сцену за сломанный демон: расхождение
    // настроек здесь ПОСТАВЛЕНО, чтобы окно можно было увидеть говорящим о нём.
    '  Настройки второго класса на сцене намеренно расходятся с файлом — окно обязано это показать.',
  ].join('\n')
}

/** The line the holding scene ends its announcement with — how a person takes it down. */
export function holdNotice() {
  return '  Holding. Ctrl+C takes the window down and the directory with it.'
}
