# Recipe: a browser check that can be a receipt

SMA accepts "done" only when a **command** re-runs the claim. This recipe shows how to
make a UI check meet that bar, and why the browser library that performs it belongs in
**your** devDependencies rather than in SMA's core.

Read this before wiring any user-interface verification into a plan.

---

## 1. Why an interactive browser tool cannot be a receipt

Interactive browser tooling — an MCP browser server, a driven browser session, any
"click around and tell me what you see" surface — is LLM-in-the-loop by construction: a
model decides what to look at, interprets what it sees, and writes the conclusion as
prose. Three properties a receipt needs are missing.

| A receipt needs | An interactive browser session gives |
|---|---|
| A command anyone can re-run | A conversation that cannot be replayed step for step |
| A deterministic outcome (an exit code) | An interpretation that shifts with the model, the prompt, and the run |
| An artifact bound to a digest | Screenshots and prose, both unstable |

Those tools are excellent for exploring and debugging, and nothing here discourages
using them for that. They are simply not evidence. Exploration answers *what is going
on right now*; a receipt answers *does this still hold* — and it has to answer that on a
fresh clone, months later, with no model in the room.

## 2. The receipt contract, restated

`sma receipt-hash "<command>"` binds three things into one digest: the exact command
string, its exit code, and its normalized stdout. `sma reverify` re-runs the command and
compares digests; a mismatch is a divergence, recorded and scored.

A UI check therefore qualifies as evidence exactly when it is:

1. **One command.** A script invoked by a single line, with no interactive step, no
   manual setup, and no "then open the app and look".
2. **Deterministic.** The same tree and the same seeded data produce the same exit code
   and the same stdout, on your machine and in CI.
3. **Self-asserting.** The script itself decides pass or fail and exits `0` or non-zero.
   A human or a model reading the output and forming an opinion is not a check.

If the output cannot be made byte-stable (a timing number, a generated id), keep the
command bound and drop the noisy stdout with `--exit-only`. The command and the exit
code stay part of the digest; only the unstable text is excluded.

## 3. The recipe

### 3.1 The browser library lives in YOUR devDependencies

```bash
pnpm add -D <your-browser-driver>     # or npm i -D / yarn add -D
```

**SMA's core takes no browser dependency, ever.** Not now, not as an optional extra, not
behind a flag. Three reasons, in order of weight:

- **Supply chain.** A browser driver pulls a large transitive tree and, on install, a
  browser binary. Every consumer of SMA would inherit that surface — including the many
  who will never run a UI check.
- **Install weight and platform breakage.** Headless browser installs fail in exactly
  the environments where SMA has to keep working: locked-down corporate machines,
  minimal CI images, unusual architectures. A memory-and-coordination tool must not
  become unusable because a browser download failed.
- **Ownership.** Your project already chose its browser stack, its fixtures, and its
  selectors. SMA needs one thing from that stack: the exit code.

The seam is deliberately narrow: SMA runs a command, hashes the result, and re-runs it
later. It never imports your driver, never parses your DOM, and never learns your
selectors.

### 3.2 The script asserts a deterministic node, not a picture

Good assertion targets, roughly in order of stability:

| Target | Example assertion |
|---|---|
| Accessibility node | a node with role `table` and accessible name `Workers` exists |
| DOM selector + text | `[data-testid="worker-row"]` appears exactly 3 times |
| Console | zero `error`-level console messages during load |
| Network response | `GET /api/state` answered `200` with `workers.length === 3` |
| Computed property | the primary button's contrast ratio computed from the DOM is at least 4.5 |

A sketch — the shape matters, not the driver:

```js
// e2e/check-roster.mjs — one command, one deterministic assertion, exit 0 or 1.
import { launch } from '<your-browser-driver>'

const errors = []
const browser = await launch({ headless: true })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })          // fixed viewport
await page.emulateMediaFeatures([                              // no animation timing
  { name: 'prefers-reduced-motion', value: 'reduce' },
])
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

await page.goto('http://127.0.0.1:8787/roster', { waitUntil: 'networkidle0' })
await page.waitForSelector('[data-testid="worker-row"]')       // a condition, not a sleep

const rows = await page.$$eval('[data-testid="worker-row"]', (n) => n.length)
await browser.close()

const ok = rows === 3 && errors.length === 0
process.stdout.write(`roster rows=${rows} console-errors=${errors.length}\n`)
process.exit(ok ? 0 : 1)
```

Note what the script does NOT do: it takes no screenshot, waits on no timeout, talks to
no third-party host, and prints no timestamp. Every one of those would make the digest
drift and turn an honest receipt into a flapping one.

### 3.3 Wire it as a receipt

```bash
# start whatever the check needs, then:
node scripts/sma/cli.mjs receipt-hash "node e2e/check-roster.mjs"
```

Paste the printed digest into the plan's summary:

```yaml
receipts:
  - id: R-ROSTER-RENDERS
    assertion: the roster screen renders every seeded worker row with no console error
    check_command: node e2e/check-roster.mjs
    expected_sha256: <the digest printed above>
```

From then on `sma reverify` re-runs the command and compares. The claim is now
falsifiable by anyone with the repository, which is the whole point.

## 4. Forbidden as receipts: pixel diffs

**A pixel diff is never a receipt.** Not with a tolerance, not with a golden image, not
"just for the header". Rendering is not deterministic across the axes a receipt must
survive: font hinting and fallback per operating system, GPU and compositor differences,
antialiasing, scrollbar width, device pixel ratio, image decoding, animation timing, and
the driver's own version. A digest over that is a coin flip with extra steps, and a
flapping receipt is worse than no receipt: it trains everyone to ignore divergences.

Visual comparison is a fine **review** aid — show the reviewer the before and after. If
a visual property genuinely matters, name it and assert it structurally: a computed
style, a bounding box within a tolerance you wrote down on purpose, a contrast ratio
computed from the DOM. Then it is a number a script can defend.

The same ban covers "a model looked at the screenshot and said it looks right". That is
an opinion with a timestamp, not evidence.

## 5. Determinism checklist

Run through this before hashing a UI check:

- [ ] Fixed viewport and device pixel ratio.
- [ ] Motion reduced or animations disabled.
- [ ] Seeded, checked-in fixture data — never a live database.
- [ ] Waits on a condition (selector, response, idle), never on a sleep.
- [ ] No third-party network calls; block them explicitly.
- [ ] Stdout carries no clock, no random id, no absolute path. If it must, use `--exit-only`.
- [ ] The browser driver version is pinned in the lockfile.
- [ ] Two consecutive local runs print identical stdout and the same exit code.

## 6. What this recipe deliberately leaves out

- **No shipped script, no config, no default.** The check belongs to your repository,
  next to your selectors and your fixtures.
- **No scoring of front-end quality.** Turning DOM, accessibility, and console signals
  into a graded arena for front-end tasks is a separate thing. This recipe covers one
  question only: can a UI claim become a re-runnable receipt.

> **Since this recipe was written, SMA ships one implementation of it** —
> `scripts/sma/ui-drive.mjs`, the engine behind the `sma-ui-qa` reviewer. It obeys the same
> contract: a command that writes a receipt and exits non-zero on a blocking finding, with
> the browser driver **resolved at run time and never installed on your behalf**
> (`SMA_UI_DRIVER` points at one you already have). It does not replace the recipe: your
> selectors, your fixtures and your product's own claims still belong in your repository.
> And it holds the rule that matters here — **a run that did not happen is never a pass**:
> with no driver it exits 3 and says `NOT RUN`, rather than returning an empty finding list
> that reads as clean.
- **A self-removal condition.** If a platform ships genuinely replayable browser checks —
  a recorded session that re-derives its own verdict byte for byte — this recipe shrinks
  to one line pointing at it. A bridge is supposed to become unnecessary.

---

## Кратко по-русски

Квитанция в SMA это перезапускаемая команда: `sma receipt-hash "<команда>"` связывает в
один дайджест саму команду, её код возврата и нормализованный вывод, а `sma reverify`
прогоняет её заново и сравнивает.

Интерактивные браузерные инструменты (MCP-браузер и любая «посмотри и расскажи»
поверхность) квитанциями быть не могут: в контуре стоит модель, а разговор не
переигрывается. Годная форма UI-проверки одна: **headless-скрипт «команда + код
возврата»**, который сам решает pass/fail.

Три правила рецепта:

1. **Браузерная библиотека живёт в devDependencies ПОТРЕБИТЕЛЯ**, а не в ядре SMA.
   Ядро остаётся браузер-свободным: цепочка поставки, вес установки и поломки на
   ограниченных машинах дороже удобства. Шов узкий: SMA запускает команду и хеширует
   результат.
2. **Утверждать нужно структурный узел**, а не картинку: узел дерева доступности,
   селектор и его текст, ноль ошибок в консоли, статус и тело сетевого ответа,
   вычисленное свойство стиля.
3. **Пиксель-диффы как квитанции запрещены** — ни с допуском, ни с эталонным
   изображением. Отрисовка не детерминирована по шрифтам, GPU, сглаживанию, плотности
   пикселей и таймингу анимаций; мерцающая квитанция хуже её отсутствия. Пиксельное
   сравнение годится для ревью, но не как доказательство. Вердикт модели по скриншоту
   запрещён по той же причине.

Проверьте по чеклисту из раздела 5: фиксированный вьюпорт, отключённые анимации,
засеянные фикстуры, ожидание условия вместо паузы, никакой сторонней сети, в выводе нет
часов и случайных идентификаторов (иначе `--exit-only`), версия драйвера закреплена в
lock-файле, два подряд запуска дают одинаковый вывод и код возврата.
