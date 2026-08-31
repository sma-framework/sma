# The fleet window, and the one command that opens it

`sma open` performs the single sanctioned token-for-cookie exchange, so nobody has to paste an address together by hand.

## en
The daemon serves its own window, and that window is armed the way a door to a machine's whole work life should be: a token on every route, an HttpOnly SameSite=Strict session cookie, and a query string that is **never** a credential — with exactly one exception, the `GET /?token=…` bootstrap that trades the token for the cookie once. Visit the bare address and you get `401`. That is the design working, not a fault.

What was missing for a long time was the other half. The exchange existed; no command performed it. To open your own window you had to open `~/.sma-daemon/config.json`, lift a 64-character token out of it, and assemble an address by hand — after every daemon restart, for every person, with the newest user hitting it first and a bare `401` as the only explanation on offer.

`node scripts/sma/cli.mjs open` is that missing half. It reads the daemon's own config, builds the one-shot link, and hands it to your desktop's browser. Nothing in the front's authentication moves: this is the exchange the front already offers, typed for you instead of by you.

Two details are deliberate, and both are about where a credential is allowed to be written:

- **On the ordinary path the terminal never sees the token.** The browser gets the link, and the screen gets the bare address. A session transcript, a scrollback and a screenshot are not places a credential needs to live, and you can already see the window.
- **`--print` is the machine with no browser.** No launcher to hand it to, so the ready link goes on the screen as one line, because that is exactly what you asked for. A machine whose platform this does not know a launcher for takes the same road on its own, and says so rather than reporting a success that did not happen.

The daemon's boot line follows the same rule from the other side. Started in your own terminal, it prints the ready link right there. Started by a supervisor with its output redirected to a log file, it prints the address, the reason a bare visit answers `401`, and the command — never the token. The config file is mode 0600; a log file is not.

A wildcard bind is dialled as loopback: `0.0.0.0` is an address to listen on and not one to browse to, and the old boot line printed it verbatim.

Example: `node scripts/sma/cli.mjs open`, or `node scripts/sma/cli.mjs open --print` over SSH.

## ru
Демон раздаёт собственное окно, и это окно вооружено так, как и должна быть заперта дверь в рабочую жизнь целой машины: токен на каждом маршруте, сессионная кука HttpOnly с SameSite=Strict, и строка запроса, которая кредиталом не считается **никогда**, кроме единственного исключения: обмена `GET /?token=…`, который один раз меняет токен на куку. Зайдите по голому адресу и получите `401`. Это работающий замысел, а не поломка.

Долгое время не хватало второй половины. Обмен был, а команды, которая его выполняет, не было. Чтобы открыть собственное окно, приходилось открывать `~/.sma-daemon/config.json`, доставать оттуда токен из 64 знаков и склеивать адрес руками: после каждого перезапуска демона, у каждого человека, причём первым об это спотыкается новый пользователь, у которого нет привычки, и единственным объяснением ему служит голый `401`.

`node scripts/sma/cli.mjs open` и есть эта недостающая половина. Команда читает собственный конфиг демона, собирает одноразовую ссылку и отдаёт её браузеру. В проверке подлинности фронта не сдвигается ничего: это тот же обмен, который фронт и так предлагает, только набранный за Вас, а не Вами.

Две подробности сделаны намеренно, и обе про то, где кредиталу позволено быть записанным:

- **На обычном пути терминал токена не видит.** Ссылку получает браузер, а на экран уходит голый адрес. Стенограмма сессии, прокрутка терминала и снимок экрана не те места, где кредиталу нужно жить, а окно Вы и так уже видите.
- **`--print` это машина без браузера.** Отдавать ссылку некому, поэтому готовая ссылка выводится на экран одной строкой: Вы попросили ровно её. Машина, для платформы которой команда не знает запускателя, сворачивает на ту же дорогу сама и говорит об этом, вместо того чтобы отчитаться об успехе, которого не было.

Строка, которую печатает демон при подъёме, следует тому же правилу с другой стороны. Запущенный в Вашем терминале, он печатает готовую ссылку прямо там. Запущенный супервизором, с выводом, перенаправленным в файл журнала, он печатает адрес, причину, по которой голый заход отвечает `401`, и команду, но не токен. У файла настроек права 0600, у файла журнала их нет.

Привязка на все интерфейсы набирается как петля: `0.0.0.0` это адрес, на котором слушают, а не тот, по которому ходят браузером, и прежняя строка подъёма печатала его дословно.

Пример: `node scripts/sma/cli.mjs open`, или `node scripts/sma/cli.mjs open --print` по SSH.
