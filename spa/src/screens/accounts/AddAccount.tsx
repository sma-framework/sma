import { useState } from 'react'
import { ApiError, isNotReady } from '../../api/client'
import { useAccountAdd, useDiagnosticsQuery } from '../../api/queries'
import type { AccountAddResult } from '../../api/types'
import { openScreen } from '../../shell/navigation'

/**
 * «Добавить аккаунт» — the form that takes a subscription into the pool, and the three steps
 * that follow it.
 *
 * ═════════════════ THE FORM ASKS FOR A NAME, NEVER FOR A SECRET ═════════════════
 *
 * The one field a person could misread is the last one, and it is the one that matters: it
 * wants the NAME of an environment variable, not the token that lives in it. The label says
 * so, the placeholder looks like a name and nothing like a credential, and the shape is
 * checked HERE, before anything is sent — a pasted token carries lowercase, dashes or dots
 * somewhere, so it dies on the grammar in this browser instead of travelling to the daemon to
 * be refused there. The daemon holds the same grammar and IS the authority; this check exists
 * so the request never carries the secret in the first place.
 *
 * ══════════════════ THE LOGIN IS THE ONE STEP A MACHINE CANNOT DO ══════════════════
 *
 * Everything else here is the window's work. The login is not: it opens a browser, it asks a
 * person to be a person, and there is no headless form of it. So the scenario is stated in
 * full, with the exact command and the directory already in it, and the window admits which
 * part it is handing over. What it will NOT do is pretend the handover did not happen.
 *
 * ══════════════════════ AND THE STEPS DO NOT SKIP ══════════════════════
 *
 * Adding, logging in and switching on are three acts. «Включите» does not light up until the
 * pool has actually been re-read and the profile found in it — a button that offers to enable
 * something the machine has not confirmed exists is a button that teaches a person to stop
 * reading.
 */

/**
 * The lanes a subscription can be put on, in the daemon's own words. The queue's vocabulary is
 * frozen; the door refuses anything outside it, so the form offers exactly it.
 */
const LANES: readonly { value: string; label: string }[] = [
  { value: 'prod', label: 'прод-код' },
  { value: 'research', label: 'ресёрч' },
  { value: 'paperwork', label: 'бумага' },
  { value: 'forge', label: 'кузница' },
] as const

/**
 * What an environment variable's NAME looks like. Same grammar the daemon holds — written
 * here for the reason in the header: so a credential pasted into this field never leaves the
 * browser. It is not a second authority; a name this accepts may still be refused there.
 */
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/

function addWords(err: unknown): string {
  if (isNotReady(err)) return 'Дверь аккаунтов пока не отвечает. Ничего не записано.'
  if (err instanceof ApiError && err.detail) return `Отказано: ${err.detail}`
  return 'Аккаунт не добавился. В конфигурации ничего не изменилось.'
}

/** A line a person is going to paste into a terminal, with the one button that helps. */
function CommandLine({ line }: { line: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-start gap-2.5 rounded-[9px] border border-bd bg-surf px-3 py-2.5">
      <code className="min-w-0 flex-1 font-mono text-[11.5px] leading-[1.6] break-all text-tx">{line}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(line).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }}
        className="flex-none text-[11.5px] whitespace-nowrap text-blue hover:text-teal"
      >
        {copied ? 'скопировано' : 'скопировать'}
      </button>
    </div>
  )
}

/**
 * The login line, spelled the way the machine that will run it spells it. The daemon returns
 * the variable and the command in SEPARATE fields precisely so that this choice is made here,
 * against the platform it actually reported, and not guessed once for everybody.
 */
function loginLine(platform: string | null, env: Record<string, string>, cmd: string): string {
  const pairs = Object.entries(env)
  if (platform === 'win32') {
    const sets = pairs.map(([k, v]) => `$env:${k}="${v}"`).join('; ')
    return sets === '' ? cmd : `${sets}; ${cmd}`
  }
  const sets = pairs.map(([k, v]) => `${k}="${v}"`).join(' ')
  return sets === '' ? cmd : `${sets} ${cmd}`
}

function StepHead({ n, title, done }: { n: number; title: string; done?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden
        className={`flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full text-[11px] font-bold ${
          done ? 'bg-ok-s text-ok-tx' : 'bg-idle-s text-idle-tx'
        }`}
      >
        {done ? '✓' : n}
      </span>
      <span className="text-[12.5px] font-semibold text-tx">{title}</span>
    </div>
  )
}

/**
 * The scenario, once the profile is written: the one step a person performs, the check that
 * the window really can make, and the door to the switch.
 */
function LoginScenario({
  added,
  platform,
  onVerify,
}: {
  added: AccountAddResult
  platform: string | null
  onVerify: (id: string) => Promise<boolean>
}) {
  const [checking, setChecking] = useState(false)
  const [found, setFound] = useState<boolean | null>(null)

  const line = loginLine(platform, added.login.env, added.login.cmd)
  const otherForm =
    platform === 'win32'
      ? `${Object.entries(added.login.env)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ')} ${added.login.cmd}`
      : null

  const check = () => {
    setChecking(true)
    void onVerify(added.id).then(
      (ok) => {
        setFound(ok)
        setChecking(false)
      },
      () => {
        setFound(false)
        setChecking(false)
      },
    )
  }

  return (
    <div className="flex flex-col gap-4 border-t border-bd px-[18px] py-[15px]">
      <p className="m-0 text-[12.5px] leading-[1.6] text-tx">
        Профиль <span className="font-mono text-tx">{added.id}</span> записан и{' '}
        <span className="font-semibold">выключен</span>. Осталось три шага — и только первый из
        них делает человек.
      </p>

      <div className="flex flex-col gap-2">
        <StepHead n={1} title="Выполните в терминале" />
        <div className="flex flex-col gap-2 pl-[32px]">
          <p className="m-0 text-[12px] leading-[1.6] text-tx2">
            Это вход в аккаунт: откроется браузер, и в конце команда напечатает токен. Логин —
            единственный шаг, который окно сделать не может, поэтому команда отдаётся Вам целиком,
            с уже подставленным каталогом.
          </p>
          <CommandLine line={line} />
          {otherForm ? (
            <p className="m-0 text-[11px] leading-[1.55] text-tx3">
              Строка для PowerShell. В bash или Git Bash то же самое пишется так:{' '}
              <code className="font-mono break-all">{otherForm}</code>
            </p>
          ) : null}
          <p className="m-0 text-[12px] leading-[1.6] text-tx2">
            Напечатанный токен положите в переменную окружения{' '}
            <span className="font-mono text-tx">{added.login.tokenEnv}</span> на этой машине. В
            конфигурацию уехало только ЭТО ИМЯ — сам токен не проходит через окно и не пишется на
            диск демона.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <StepHead n={2} title="Проверьте" done={found === true} />
        <div className="flex flex-col gap-2 pl-[32px]">
          <p className="m-0 text-[12px] leading-[1.6] text-tx2">
            Кнопка перечитывает пул работников у демона и говорит, что там на самом деле лежит.
          </p>
          <button
            type="button"
            onClick={check}
            disabled={checking}
            className="self-start rounded-[9px] border border-bd2 px-4 py-2 text-[12px] font-semibold text-tx hover:border-blue hover:text-blue disabled:opacity-60"
          >
            {checking ? 'Читаю…' : 'Перечитать пул'}
          </button>
          {found === true ? (
            <p className="m-0 text-[12px] leading-[1.6] text-ok-tx">
              Профиль на месте и выключен — запись дошла до работающего демона, не только до файла.
            </p>
          ) : null}
          {found === false ? (
            <p className="m-0 text-[12px] leading-[1.6] text-err-tx">
              В пуле профиля нет. Запись до работающего демона не дошла — включать нечего.
            </p>
          ) : null}
          <p className="m-0 text-[11px] leading-[1.55] text-tx3">
            Чего окно проверить НЕ может: заполнена ли переменная{' '}
            <span className="font-mono">{added.login.tokenEnv}</span>. Её значение не приходит
            сюда ни в каком виде — это и есть граница приватности. Демон читает переменную в
            момент запуска работника; если Вы задали её уже после того, как демон стартовал, его
            нужно перезапустить.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <StepHead n={3} title="Включите" />
        <div className="flex flex-col gap-2 pl-[32px]">
          <p className="m-0 text-[12px] leading-[1.6] text-tx2">
            Включение — отдельный акт и отдельная кнопка: тумблер работника на экране «Агенты».
            Второго способа включить аккаунт окно не заводит.
          </p>
          <button
            type="button"
            onClick={() => openScreen({ screen: 'agents' })}
            disabled={found !== true}
            className="self-start rounded-[9px] bg-blue px-4 py-2 text-[12px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
          >
            Открыть «Агенты»
          </button>
          {found === true ? null : (
            <p className="m-0 text-[11px] text-tx3">Откроется после успешной проверки на шаге 2.</p>
          )}
        </div>
      </div>
    </div>
  )
}

export function AddAccount({ onVerify }: { onVerify: (id: string) => Promise<boolean> }) {
  const add = useAccountAdd()
  const diagnostics = useDiagnosticsQuery()

  const [open, setOpen] = useState(false)
  const [id, setId] = useState('')
  const [lane, setLane] = useState<string>(LANES[0].value)
  const [configDir, setConfigDir] = useState('')
  const [tokenEnv, setTokenEnv] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [added, setAdded] = useState<AccountAddResult | null>(null)

  const trimmedId = id.trim()
  const trimmedDir = configDir.trim()
  const trimmedEnv = tokenEnv.trim()
  const envLooksLikeName = trimmedEnv === '' || ENV_NAME_RE.test(trimmedEnv)
  const ready = trimmedId !== '' && trimmedDir !== '' && trimmedEnv !== '' && envLooksLikeName

  const submit = () => {
    if (!ready) return
    setProblem(null)
    add.mutate(
      { id: trimmedId, lane, configDir: trimmedDir, oauthTokenEnv: trimmedEnv },
      {
        onSuccess: (result) => {
          setAdded(result)
          setId('')
          setConfigDir('')
          setTokenEnv('')
        },
        onError: (err) => setProblem(addWords(err)),
      },
    )
  }

  return (
    <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
      <div className="flex items-center gap-2.5 border-b border-bd px-[18px] py-[13px]">
        <span className="text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">Добавить аккаунт</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="text-[11.5px] text-blue hover:text-teal"
        >
          {open ? 'свернуть' : 'открыть форму'}
        </button>
      </div>

      {open ? (
        <div className="flex flex-col gap-3.5 px-[18px] py-[15px]">
          <p className="m-0 text-[12px] leading-[1.6] text-tx2">
            Новый аккаунт всегда пишется выключенным — попросить иначе этой формой нечем. Между
            «аккаунт есть» и «аккаунт можно тратить» стоит Ваш вход в него.
          </p>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="acc-id" className="text-[11.5px] text-tx2">
              Имя профиля
            </label>
            <input
              id="acc-id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="research-2"
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-[9px] border border-bd bg-input px-[11px] py-2 font-mono text-[12.5px] text-tx outline-none focus:border-blue"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11.5px] text-tx2">Полоса</span>
            <div className="flex flex-wrap gap-2">
              {LANES.map((o) => {
                const picked = o.value === lane
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setLane(o.value)}
                    aria-pressed={picked}
                    className={`rounded-[8px] border px-3 py-1.5 text-[11.5px] ${
                      picked ? 'border-blue text-blue' : 'border-bd2 text-tx2 hover:text-tx'
                    }`}
                  >
                    {o.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="acc-dir" className="text-[11.5px] text-tx2">
              Каталог конфигурации аккаунта — полный путь
            </label>
            <input
              id="acc-dir"
              value={configDir}
              onChange={(e) => setConfigDir(e.target.value)}
              placeholder="C:\Users\Вы\.claude-research"
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-[9px] border border-bd bg-input px-[11px] py-2 font-mono text-[12.5px] text-tx outline-none focus:border-blue"
            />
            <span className="text-[11px] leading-[1.5] text-tx3">
              Свой «дом» на аккаунт: в нём поселится вход. Каталога может ещё не быть — его создаст
              команда с шага 1.
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="acc-env" className="text-[11.5px] text-tx2">
              ИМЯ переменной окружения с токеном — не сам токен
            </label>
            <input
              id="acc-env"
              value={tokenEnv}
              onChange={(e) => setTokenEnv(e.target.value.toUpperCase())}
              placeholder="CLAUDE_TOKEN_RESEARCH"
              autoComplete="off"
              spellCheck={false}
              className={`w-full rounded-[9px] border bg-input px-[11px] py-2 font-mono text-[12.5px] text-tx outline-none ${
                envLooksLikeName ? 'border-bd focus:border-blue' : 'border-err-tx'
              }`}
            />
            <span className="text-[11px] leading-[1.5] text-tx3">
              Сюда пишется НАЗВАНИЕ переменной — заглавными буквами, цифрами и подчёркиванием.
              Значение переменной, то есть сам токен, окно не спрашивает, не показывает и не
              передаёт: он живёт только в окружении Вашей машины.
            </span>
            {envLooksLikeName ? null : (
              <span className="text-[11.5px] leading-[1.5] text-err-tx">
                Это не похоже на имя переменной. Похоже, вставлен сам токен — сотрите и напишите
                название, например CLAUDE_TOKEN_RESEARCH. Отправлено ничего не было.
              </span>
            )}
          </div>

          {problem ? <p className="m-0 text-[11.5px] leading-[1.5] text-err-tx">{problem}</p> : null}

          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-tx3">
              {ready ? 'Профиль запишется выключенным' : 'Заполните имя, каталог и название переменной'}
            </span>
            <button
              type="button"
              onClick={submit}
              disabled={!ready || add.isPending}
              className="flex-none rounded-[9px] bg-blue px-4 py-2 text-[12px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
            >
              {add.isPending ? 'Записываю…' : 'Добавить'}
            </button>
          </div>
        </div>
      ) : null}

      {added ? (
        <LoginScenario added={added} platform={diagnostics.data?.platform ?? null} onVerify={onVerify} />
      ) : null}
    </div>
  )
}
