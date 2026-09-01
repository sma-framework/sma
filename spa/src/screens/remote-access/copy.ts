/**
 * copy.ts — весь текст экрана «Работать удалённо», на двух языках, ДАННЫМИ.
 *
 * ═══════════ ПОЧЕМУ ТЕКСТ ЖИВЁТ ОТДЕЛЬНО ОТ РАЗМЕТКИ ═══════════
 * Этот экран — почти целиком текст: требование словами, четыре оговорки, прямой отказ и
 * готовые команды. Разметка у него простая, а вот СОСТАВ сказанного — это и есть работа, и
 * состав должен переживать перерисовку. Пока оговорки лежат в JSX, «убрать один абзац, он
 * длинный» — правка на минуту, которую никто не заметит; пока они лежат здесь списком с
 * именами, тот же ход виден и тесту, и глазу.
 *
 * ═══════════ ПОЧЕМУ ДВА ЯЗЫКА, А НЕ ОДИН ═══════════
 * Остальное окно говорит по-русски: у него один читатель. Этот экран — единственный,
 * который заранее пишется НЕ для основателя: он про то, как ЛЮБОЙ человек уводит своё окно
 * на вторую машину, и его читают там же, где читают README, — на двух языках. Составы
 * сверяются тестом ключ в ключ, поэтому «дописать по-русски и забыть по-английски» здесь
 * невозможно молча.
 *
 * ═══════════ ЧЕГО ЗДЕСЬ НЕТ ═══════════
 * Ни одного текста, который обещает действие экрана. Экран не ставит программ и не пишет
 * настроек; всё, что ниже, — объяснение и готовая к копированию команда, которую человек
 * запускает сам. Команды поэтому одинаковы в обоих языках буква в букву: команда — не проза,
 * и переводить её было бы способом её сломать.
 */

export type Lang = 'ru' | 'en'

/** Порядок здесь — порядок кнопок переключателя языка. */
export const LANGS: readonly Lang[] = ['ru', 'en']

/** Имя языка на нём самом — вне `Copy`, потому что переводу оно как раз не подлежит. */
export const LANG_LABEL: Record<Lang, string> = { ru: 'Русский', en: 'English' }

/**
 * ЧЕТЫРЕ ВЕЩИ, КОТОРЫЕ ЭКРАН ОБЯЗАН СКАЗАТЬ. Без любой из них он продаёт обещание, которое
 * сегодняшняя установка не держит, — поэтому они перечислены здесь данными, а не абзацем.
 */
export type CaveatKey = 'hostAwake' | 'noAutostart' | 'tokenBecomesPassword' | 'bindIsAGate'
export const CAVEAT_KEYS: readonly CaveatKey[] = [
  'hostAwake',
  'noAutostart',
  'tokenBecomesPassword',
  'bindIsAGate',
]

/** Системы, под которые лежат готовые команды. */
export type OsKey = 'macos' | 'windows' | 'linux'
export const OS_KEYS: readonly OsKey[] = ['macos', 'windows', 'linux']

/** Кому видна дверь демона — те же три слова, что приезжают в `remoteAccess.reach`. */
export type ReachKey = 'this_machine_only' | 'named_address' | 'every_interface'

/** Один шаг: что делает человек, и — если для этого есть команда — сама команда. */
export interface Step {
  text: string
  command: string | null
}

export interface Caveat {
  title: string
  body: string
}

export interface Copy {
  title: string
  subtitle: string
  /** Сказано вслух и на самом экране: он объясняет и проверяет, а не делает. */
  installsNothing: string
  requirement: { title: string; body: string }
  facts: {
    title: string
    bindLabel: string
    reachLabel: string
    networkLabel: string
    openFromLabel: string
    reach: Record<ReachKey, string>
    visibleYes: string
    visibleNo: string
    networkDetected: string
    networkAbsent: string
    networkUnreadable: string
    lanIsNotAMesh: string
    openFromNone: string
    waiting: string
  }
  setup: {
    title: string
    body: string
    vendorNeutral: string
    tested: string
    osLabel: Record<OsKey, string>
    steps: Record<OsKey, Step[]>
  }
  caveatsTitle: string
  caveats: Record<CaveatKey, Caveat>
  rotate: { title: string; body: string; steps: Step[] }
  refusal: { title: string; body: string }
  runbook: { label: string; path: string }
  copyLabel: string
  copiedLabel: string
}

/** Команда — одна на оба языка. Переведённая команда это сломанная команда. */
const MESH_UP = 'tailscale up'
const MESH_IP = 'tailscale ip -4'
const DAEMON_STOP = 'node supervisor/daemon-control.mjs stop'
const MINT_TOKEN = 'node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"'
const OPEN_WINDOW = 'node scripts/sma/cli.mjs open'

const RU: Copy = {
  title: 'Работать удалённо',
  subtitle: 'Открыть это окно со второй машины: что для этого нужно, что уже есть на этой машине и чего мы делать не станем.',
  installsNothing:
    'Этот экран ничего не устанавливает и ничего не меняет в настройках. Он объясняет и проверяет; ставит и правит человек — своими руками и на своей машине.',
  requirement: {
    title: 'Что нужно: приватная сеть между машинами',
    body: 'Чтобы открыть это окно с ноутбука, обе машины должны оказаться в одной приватной сети — шифрованном туннеле, который видят только они. Порт наружу, в интернет, не открывается никогда: ни этим экраном, ни каким-либо другим.',
  },
  facts: {
    title: 'Как обстоят дела прямо сейчас',
    bindLabel: 'Демон слушает',
    reachLabel: 'Кому он виден',
    networkLabel: 'Приватная сеть',
    openFromLabel: 'Адрес для второй машины',
    reach: {
      this_machine_only:
        'Только этой машине. Со второй машины дверь не откроется — и это умолчание продукта, а не поломка.',
      named_address: 'Одному названному адресу. Дотянется тот, кто до этого адреса доезжает.',
      every_interface:
        'Каждому интерфейсу этой машины — включая те, о которых Вы не думали. Убедитесь, что среди них нет смотрящего в интернет.',
    },
    visibleYes: 'виден не только этой машине',
    visibleNo: 'виден только этой машине',
    networkDetected: 'Найдена: у машины есть адрес из диапазона, который раздают шифрованные приватные сети.',
    networkAbsent: 'Не найдена: ни одного адреса приватной сети на этой машине нет.',
    networkUnreadable:
      'Посмотреть не удалось — список сетевых интерфейсов не читается. Это «не смог посмотреть», а не «сети нет».',
    lanIsNotAMesh:
      'Локальная сеть — это не приватная сеть: провод в офисе видят все, кто в него включён, и он ничего не шифрует.',
    openFromNone:
      'Пока нет. Сеть может быть поднята, а демон всё равно слушать только эту машину: сеть и дверь — разные вещи.',
    waiting: 'Демон ещё не ответил — фактов пока нет.',
  },
  setup: {
    title: 'Как поднять приватную сеть',
    body: 'Ставите Вы, на обеих машинах. Мы намеренно не запускаем чужой установщик из своего: чужая программа, чужая лицензия и чужая граница доверия внутри нашей установки — не то, на что Вы соглашались, выбирая продукт, который живёт на Вашей машине.',
    vendorNeutral:
      'Подойдёт любая приватная сеть или шифрованный туннель. Требование к ней одно: обе машины видят друг друга по адресу, которого нет в интернете.',
    tested: 'Ниже — Tailscale: путь, который мы прошли сами на живой машине. Это пример, а не условие.',
    osLabel: { macos: 'macOS', windows: 'Windows', linux: 'Linux' },
    steps: {
      macos: [
        { text: 'Поставьте клиент приватной сети.', command: 'brew install --cask tailscale' },
        { text: 'Войдите и поднимите сеть — на обеих машинах под одной учётной записью.', command: MESH_UP },
        { text: 'Спросите у сети собственный адрес этой машины.', command: MESH_IP },
        {
          text: 'Вернитесь на этот экран: адрес для второй машины появится в фактах выше — когда демон начнёт смотреть в эту сеть, а не только в петлю.',
          command: null,
        },
      ],
      windows: [
        { text: 'Поставьте клиент приватной сети.', command: 'winget install --id Tailscale.Tailscale' },
        { text: 'Войдите и поднимите сеть — на обеих машинах под одной учётной записью.', command: MESH_UP },
        { text: 'Спросите у сети собственный адрес этой машины.', command: MESH_IP },
        {
          text: 'Вернитесь на этот экран: адрес для второй машины появится в фактах выше — когда демон начнёт смотреть в эту сеть, а не только в петлю.',
          command: null,
        },
      ],
      linux: [
        {
          text: 'Поставьте клиент приватной сети пакетом своего дистрибутива. Установщик, скачанный трубой в оболочку, мы не предлагаем — вслепую исполнять то, что приехало из сети, у нас не принято.',
          command: null,
        },
        { text: 'Войдите и поднимите сеть — на обеих машинах под одной учётной записью.', command: MESH_UP },
        { text: 'Спросите у сети собственный адрес этой машины.', command: MESH_IP },
        {
          text: 'Вернитесь на этот экран: адрес для второй машины появится в фактах выше — когда демон начнёт смотреть в эту сеть, а не только в петлю.',
          command: null,
        },
      ],
    },
  },
  caveatsTitle: 'Четыре вещи, которые нужно знать заранее',
  caveats: {
    hostAwake: {
      title: 'Машина-хозяйка должна быть включена и не спать',
      body: 'Окно раздаёт демон, а демон живёт на этой машине. Закрыли крышку ноутбука — окна нет, и никакая приватная сеть этого не заменит. Планируя работать удалённо, сначала решите, что будет держать хозяйскую машину бодрствующей.',
    },
    noAutostart: {
      title: 'После перезагрузки само не поднимается ничего',
      body: 'Ни база очереди, ни демон: на обычной установке автозапуска нет. Пока Вы не настроите его руками (supervisor/setup-macos.md, supervisor/setup-windows.md), удалённая работа хрупка у каждого — первая же перезагрузка хозяйской машины гасит окно, и вернуть его можно только с неё.',
    },
    tokenBecomesPassword: {
      title: 'Токен становится настоящим паролем',
      body: 'Пока демона слышно только с этой машины, токен — удобство. В ту секунду, когда до демона дотягиваются со второй, он остаётся единственным, что стоит между Вашей очередью и любым, кто окажется в той же сети. Смените токен ПЕРЕД тем, как открывать доступ, и не пересылайте ссылку с ним в переписке.',
    },
    bindIsAGate: {
      title: 'Смена bind — решение с последствиями, а не тумблер',
      body: '127.0.0.1 — это обещание «дальше этой машины ничего не уедет», и снимать его должен человек, который понимает, что снимает. Поэтому здесь нет переключателя: правку делают руками в файле настроек демона, после того как приватная сеть поднята и токен сменён. Дикую карту 0.0.0.0 берите последней — она открывает КАЖДЫЙ интерфейс, а не тот один, который Вы имели в виду.',
    },
  },
  rotate: {
    title: 'Сменить токен',
    body: 'Делается руками: этот экран настроек не пишет. После смены прежняя ссылка перестанет работать — окно открывают заново.',
    steps: [
      { text: 'Остановите демона.', command: DAEMON_STOP },
      { text: 'Отчеканьте новое значение.', command: MINT_TOKEN },
      { text: 'Впишите его полем token в файл настроек демона: ~/.sma-daemon/config.json', command: null },
      { text: 'Поднимите демона и откройте окно заново — ссылка соберётся уже с новым токеном.', command: OPEN_WINDOW },
    ],
  },
  refusal: {
    title: 'Пробросить порт в интернет мы не поможем',
    body: 'Демон говорит по http, без шифрования. Порт, выставленный в интернет, отдаёт токен открытым текстом любому, кто окажется на пути пакета, — а дальше первым же сканером находится Ваша очередь, Ваши ключи и Ваша машина. Ни этот экран, ни какой-либо другой не помогает открыть порт наружу; приватная сеть — не «усложнённый способ», а единственный, который мы готовы объяснять.',
  },
  runbook: { label: 'Подробнее — рунбук удалённого доступа', path: 'docs/REMOTE-ACCESS-RUNBOOK.md' },
  copyLabel: 'Копировать',
  copiedLabel: 'Скопировано',
}

const EN: Copy = {
  title: 'Work remotely',
  subtitle: 'Opening this window from a second machine: what it takes, what this machine already has, and what we will not do.',
  installsNothing:
    'This screen installs nothing and changes no settings. It explains and it checks; installing and editing is done by a person, by hand, on their own machine.',
  requirement: {
    title: 'What it takes: a private network between the machines',
    body: 'To open this window from a laptop, both machines have to sit in one private network — an encrypted tunnel only they can see. A port is never opened outward to the internet: not by this screen and not by any other.',
  },
  facts: {
    title: 'How things stand right now',
    bindLabel: 'The daemon listens on',
    reachLabel: 'Who can see it',
    networkLabel: 'Private network',
    openFromLabel: 'Address for the second machine',
    reach: {
      this_machine_only:
        'This machine only. The door will not open from a second machine — and that is the product default, not a fault.',
      named_address: 'One named address. Whoever can route to that address can reach it.',
      every_interface:
        'Every interface this machine has — including ones you were not thinking about. Make sure none of them faces the internet.',
    },
    visibleYes: 'reachable beyond this machine',
    visibleNo: 'reachable from this machine only',
    networkDetected: 'Found: this machine holds an address from the range encrypted private networks hand out.',
    networkAbsent: 'Not found: this machine holds no private-network address at all.',
    networkUnreadable:
      'Could not look — the list of network interfaces is unreadable. That is "could not look", not "there is none".',
    lanIsNotAMesh:
      'A local network is not a private network: an office wire is visible to everyone plugged into it, and it encrypts nothing.',
    openFromNone:
      'Not yet. The network can be up while the daemon still listens to this machine alone: the network and the door are different things.',
    waiting: 'The daemon has not answered yet — no facts to show.',
  },
  setup: {
    title: 'Bringing a private network up',
    body: 'You install it, on both machines. We deliberately do not run somebody else’s installer from ours: another program, another licence and another trust boundary inside our install is not what you agreed to when you chose a product that lives on your own machine.',
    vendorNeutral:
      'Any private network or encrypted tunnel will do. There is one requirement: both machines see each other at an address that does not exist on the internet.',
    tested: 'Below is Tailscale — the path we walked ourselves on a live machine. An example, not a condition.',
    osLabel: { macos: 'macOS', windows: 'Windows', linux: 'Linux' },
    steps: {
      macos: [
        { text: 'Install a private-network client.', command: 'brew install --cask tailscale' },
        { text: 'Sign in and bring the network up — on both machines, under one account.', command: MESH_UP },
        { text: 'Ask the network for this machine’s own address.', command: MESH_IP },
        {
          text: 'Come back to this screen: the address for the second machine appears in the facts above once the daemon looks at that network rather than at the loopback alone.',
          command: null,
        },
      ],
      windows: [
        { text: 'Install a private-network client.', command: 'winget install --id Tailscale.Tailscale' },
        { text: 'Sign in and bring the network up — on both machines, under one account.', command: MESH_UP },
        { text: 'Ask the network for this machine’s own address.', command: MESH_IP },
        {
          text: 'Come back to this screen: the address for the second machine appears in the facts above once the daemon looks at that network rather than at the loopback alone.',
          command: null,
        },
      ],
      linux: [
        {
          text: 'Install a private-network client from your distribution’s packages. We do not offer an installer piped from the network into a shell — running what just arrived over the wire, unseen, is not something we ask of you.',
          command: null,
        },
        { text: 'Sign in and bring the network up — on both machines, under one account.', command: MESH_UP },
        { text: 'Ask the network for this machine’s own address.', command: MESH_IP },
        {
          text: 'Come back to this screen: the address for the second machine appears in the facts above once the daemon looks at that network rather than at the loopback alone.',
          command: null,
        },
      ],
    },
  },
  caveatsTitle: 'Four things to know before you start',
  caveats: {
    hostAwake: {
      title: 'The host machine has to be on, and awake',
      body: 'The window is served by the daemon, and the daemon lives on this machine. Close the laptop lid and there is no window — no private network replaces that. Before planning to work remotely, decide what will keep the host machine awake.',
    },
    noAutostart: {
      title: 'Nothing comes back up by itself after a reboot',
      body: 'Neither the queue database nor the daemon: an ordinary install has no autostart. Until you wire one by hand (supervisor/setup-macos.md, supervisor/setup-windows.md), remote work is fragile for everybody — the first reboot of the host machine puts the window out, and only that machine can bring it back.',
    },
    tokenBecomesPassword: {
      title: 'The token becomes a real password',
      body: 'While the daemon can only be heard from this machine, the token is a convenience. The second it can be reached from another machine, the token is the only thing standing between your queue and anyone else on that network. Rotate it BEFORE you open access, and never send a link carrying it through chat or mail.',
    },
    bindIsAGate: {
      title: 'Changing bind has consequences; it is not a toggle',
      body: '127.0.0.1 is a promise that nothing leaves this machine, and it should be withdrawn by a person who knows what they are withdrawing. That is why there is no switch here: the edit is made by hand in the daemon’s settings file, after the private network is up and the token has been rotated. Take the 0.0.0.0 wildcard last — it opens EVERY interface, not the one you had in mind.',
    },
  },
  rotate: {
    title: 'Rotate the token',
    body: 'Done by hand: this screen writes no settings. Once rotated, the old link stops working — open the window again.',
    steps: [
      { text: 'Stop the daemon.', command: DAEMON_STOP },
      { text: 'Mint a new value.', command: MINT_TOKEN },
      { text: 'Write it into the daemon’s settings file as the token field: ~/.sma-daemon/config.json', command: null },
      { text: 'Start the daemon and open the window again — the link is assembled with the new token.', command: OPEN_WINDOW },
    ],
  },
  refusal: {
    title: 'We will not help you forward a port to the internet',
    body: 'The daemon speaks http, unencrypted. A port exposed to the internet hands the token in clear text to anyone on the packet’s path — and the first scanner that comes along finds your queue, your keys and your machine. Neither this screen nor any other helps open a port outward; a private network is not "the hard way", it is the only way we are prepared to explain.',
  },
  runbook: { label: 'The remote-access runbook has the detail', path: 'docs/REMOTE-ACCESS-RUNBOOK.md' },
  copyLabel: 'Copy',
  copiedLabel: 'Copied',
}

export const COPY: Record<Lang, Copy> = { ru: RU, en: EN }
