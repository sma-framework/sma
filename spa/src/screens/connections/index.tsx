import { useState } from 'react'
import { isNotReady } from '../../api/client'
import { useHarnessQuery, useTelegramLink, useToggleMcp } from '../../api/queries'
import type { McpCard, TelegramLink } from '../../api/types'
import { ForgeDialog } from '../agents/ForgeDialog'
import { OPEN_SCREEN_EVENT } from '../../shell/navigation'
import type { OpenScreenDetail } from '../../shell/navigation'

/**
 * «Подключения» — the tools the workers may reach for, and the one boolean we own.
 *
 * ══════════════════ THE SWITCH FLIPS A FLAG; IT NEVER WRITES A COMMAND ══════════════════
 *
 * Every row here is an EXISTING entry in the registry a person keeps on the machine: its
 * command, its arguments and the NAMES of the variables it needs are written there by hand,
 * by a human, on the host. The window can do exactly one thing to such an entry — flip
 * `enabled` — and the door it uses accepts exactly two fields, an id and a boolean, refusing
 * a body with any third key before it even opens the registry. There is therefore no shape of
 * this screen, and no text a person could type into it, that turns into a command to run.
 * That is the MCP law of the product, and this screen is its face.
 *
 * Which is why «+ Подключить инструмент» does NOT add a row. It sends a described REQUEST to
 * the forge, and a request becomes a draft — a proposal a person reads and copies into the
 * registry themselves. The list of sent requests below is honest about that: it says the
 * connection appears when a human writes it down, not when the forge answers.
 *
 * Secrets are named, never shown. A row says «SOME_TOKEN — есть» or «— не задан», because
 * knowing WHICH variable is missing is what a person needs, and the value itself is nobody's
 * business on a screen — the read model does not carry it in the first place.
 */

function Switch({
  on,
  label,
  disabled,
  onFlip,
}: {
  on: boolean
  label: string
  disabled: boolean
  onFlip: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onFlip}
      className={`flex h-[18px] w-8 flex-none items-center rounded-full p-0.5 disabled:opacity-60 ${
        on ? 'bg-green justify-end' : 'bg-bd2 justify-start'
      }`}
    >
      <span aria-hidden className="h-3.5 w-3.5 rounded-full bg-white shadow-panel" />
    </button>
  )
}

/** One connection: what it is for, which of its variables are filled in, and the flag. */
function McpRow({ card, first }: { card: McpCard; first: boolean }) {
  const toggle = useToggleMcp()
  const [problem, setProblem] = useState<string | null>(null)

  const flip = () => {
    setProblem(null)
    // The whole request: the entry's id and a boolean. Nothing else exists to send.
    toggle.mutate(
      { serverId: card.id, enabled: !card.enabled },
      {
        onError: (err) =>
          setProblem(
            isNotReady(err)
              ? 'Переключение пока не работает — дверь не отвечает.'
              : card.enabled
                ? 'Выключить не удалось. Подключение осталось включённым.'
                : 'Включить не удалось. Подключение осталось выключенным.',
          ),
      },
    )
  }

  const envNames = Object.entries(card.envStatus)

  return (
    <div className={`flex flex-col gap-1.5 py-[11px] ${first ? '' : 'border-t border-bd'}`}>
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className={`h-2 w-2 flex-none rounded-full ${card.enabled ? 'bg-green' : 'bg-tx3'}`}
        />
        <span className="w-[118px] flex-none truncate text-[12.5px] font-semibold text-tx">{card.title}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-tx2">{card.purposeRu}</span>
        <span className={`flex-none text-[11.5px] ${card.enabled ? 'text-ok-tx' : 'text-tx3'}`}>
          {card.enabled ? 'включён' : 'выключен'}
        </span>
        <Switch
          on={card.enabled}
          label={`${card.title} — включён`}
          disabled={toggle.isPending}
          onFlip={flip}
        />
      </div>

      {envNames.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pl-5">
          {envNames.map(([name, status]) => (
            <span
              key={name}
              className={`rounded-full px-2 py-px text-[10.5px] ${
                status === '[set]' ? 'bg-ok-s text-ok-tx' : 'bg-warn-s text-warn-tx'
              }`}
            >
              {name} — {status === '[set]' ? 'есть' : 'не задан'}
            </span>
          ))}
        </div>
      ) : null}

      {problem ? <p className="m-0 pl-5 text-[11.5px] text-err-tx">{problem}</p> : null}
    </div>
  )
}

/**
 * «Свой бот Telegram» — the one connection a person makes from the window rather than from a
 * file, and the three states it can be in.
 *
 * ══════════════════ THE TOKEN GOES IN ONCE AND IS NEVER SHOWN BACK ══════════════════
 *
 * The field below is the ONLY place the token ever exists in this window, and it is cleared
 * the moment the door accepts it. Nothing on this screen reads it back: what the daemon
 * returns is four characters of the tail, which is enough to answer «which bot is this?» and
 * useless for anything else. So «I forgot my token» is deliberately answered by BotFather and
 * not by this screen — and «my code ran out» is answered by the «Новый код» button, which
 * mints a fresh code for the bot already stored WITHOUT asking for the credential again.
 *
 * ══════════════════ AND THE CHAT PROVES ITSELF, IT IS NOT TYPED IN ══════════════════
 *
 * There is no field here for a chat id, and that is the whole point of step two: a person
 * cannot be asked for a number they would have to dig out of a file. The window shows a short
 * code, the person sends it to their own bot, and the bot writes the chat down itself. Until
 * that happens the state says «ждёт код» and the bot serves nobody.
 */
function TelegramCard({ link }: { link: TelegramLink }) {
  const act = useTelegramLink()
  const [token, setToken] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const run = (action: 'connect' | 'code' | 'disconnect') => {
    setProblem(null)
    act.mutate(
      { action, ...(action === 'connect' ? { botToken: token.trim() } : {}) },
      {
        // The token leaves the window as soon as the door has it — success or not, it does not
        // stay in a React state where the next render could put it back on the screen.
        onSuccess: () => setToken(''),
        onError: (err) => {
          setToken('')
          setProblem(
            isNotReady(err)
              ? 'Подключение пока не работает — дверь не отвечает.'
              : action === 'connect'
                ? 'Подключить не удалось. Проверьте, что вставлен токен целиком — так, как его выдал @BotFather.'
                : action === 'code'
                  ? 'Новый код выдать не удалось. Прежний код мог ещё действовать.'
                  : 'Отключить не удалось. Бот остался подключённым.',
          )
        },
      },
    )
  }

  const until =
    link.expiresAt === null
      ? null
      : new Date(link.expiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

  const dot = link.status === 'linked' ? 'bg-green' : link.status === 'awaiting_code' ? 'bg-warn-tx' : 'bg-tx3'
  const word = link.status === 'linked' ? 'подключён' : link.status === 'awaiting_code' ? 'ждёт код' : 'не подключён'

  return (
    <div className="rounded-[14px] border border-bd bg-card px-5 py-[18px] shadow-panel">
      <div className="mb-3 flex items-center gap-3">
        <span className="text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">Telegram</span>
        <span aria-hidden className={`h-2 w-2 flex-none rounded-full ${dot}`} />
        <span
          className={`text-[11.5px] ${
            link.status === 'linked' ? 'text-ok-tx' : link.status === 'awaiting_code' ? 'text-warn-tx' : 'text-tx3'
          }`}
        >
          {word}
        </span>
        {link.tokenTail ? <span className="text-[11px] text-tx3">бот …{link.tokenTail}</span> : null}
      </div>

      {link.status === 'off' ? (
        <div className="flex flex-col gap-2.5">
          <p className="m-0 text-[12.5px] leading-[1.55] text-tx2">
            Заведите своего бота в Telegram — напишите @BotFather, это полминуты — и вставьте сюда токен,
            который он выдаст. Токен сохраняется у Вас на машине и обратно не показывается.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Токен бота от @BotFather"
              aria-label="Токен бота Telegram"
              autoComplete="off"
              spellCheck={false}
              className="min-w-[280px] flex-1 rounded-[8px] border border-bd2 bg-bg px-3 py-1.5 text-[12px] text-tx outline-none placeholder:text-tx3 focus:border-tx3"
            />
            <button
              type="button"
              disabled={act.isPending || token.trim() === ''}
              onClick={() => run('connect')}
              className="flex-none rounded-[8px] border border-bd2 px-3.5 py-1.5 text-[11.5px] text-tx2 hover:text-tx disabled:opacity-60"
            >
              Подключить
            </button>
          </div>
        </div>
      ) : null}

      {link.status === 'awaiting_code' ? (
        <div className="flex flex-col gap-2.5">
          {link.code ? (
            <>
              <p className="m-0 text-[12.5px] leading-[1.55] text-tx2">
                Откройте своего бота в Telegram и отправьте ему этот код одним сообщением. Бот сам запишет
                чат — номер искать не нужно.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-[10px] border border-bd2 bg-bg px-4 py-2 font-mono text-[18px] tracking-[0.18em] text-tx tabular-nums">
                  {link.code}
                </span>
                {until ? <span className="text-[11.5px] text-tx3">действует до {until}</span> : null}
              </div>
            </>
          ) : (
            <p className="m-0 text-[12.5px] leading-[1.55] text-warn-tx">
              Код перестал действовать — возьмите новый. Токен на месте, вводить его заново не нужно.
            </p>
          )}
        </div>
      ) : null}

      {link.status === 'linked' && link.chat ? (
        <p className="m-0 text-[12.5px] leading-[1.55] text-tx2">
          Чат подключён:{' '}
          <span className="text-tx">{link.chat.title ?? `№ ${link.chat.id}`}</span>
          {link.chat.title ? <span className="text-tx3"> (№ {link.chat.id})</span> : null}. Сообщения из него
          бот считает Вашими; из любого другого — нет.
        </p>
      ) : null}

      {link.status !== 'off' ? (
        <div className="mt-3.5 flex flex-wrap gap-2 border-t border-bd pt-3.5">
          <button
            type="button"
            disabled={act.isPending}
            onClick={() => run('code')}
            className="rounded-[8px] border border-bd2 px-3.5 py-1.5 text-[11.5px] text-tx2 hover:text-tx disabled:opacity-60"
          >
            {link.status === 'linked' ? 'Подключить другой чат' : 'Новый код'}
          </button>
          <button
            type="button"
            disabled={act.isPending}
            onClick={() => run('disconnect')}
            className="rounded-[8px] border border-bd2 px-3.5 py-1.5 text-[11.5px] text-tx2 hover:text-tx disabled:opacity-60"
          >
            Отключить
          </button>
        </div>
      ) : null}

      {problem ? <p className="m-0 mt-2.5 text-[11.5px] text-err-tx">{problem}</p> : null}
    </div>
  )
}

/** No link in the payload yet (an older daemon, or the picture has not arrived) reads as «off». */
const NO_LINK: TelegramLink = {
  status: 'off',
  tokenTail: null,
  code: null,
  expiresAt: null,
  codeExpired: false,
  chat: null,
}

export function Screen() {
  const harness = useHarnessQuery()
  const mcp = harness.data?.mcp ?? []
  const requests = (harness.data?.drafts ?? []).filter((d) => d.kind === 'mcp')

  const [asking, setAsking] = useState(false)
  const enabled = mcp.filter((c) => c.enabled).length

  const openTask = (taskId: string) => {
    const detail: OpenScreenDetail = { screen: 'task-card', taskId }
    window.dispatchEvent(new CustomEvent<OpenScreenDetail>(OPEN_SCREEN_EVENT, { detail }))
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-2.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 mr-2 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">Подключения</h1>
        <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
          <span className="text-[16px] font-bold text-tx tabular-nums">{mcp.length}</span>
          <span className="text-[11.5px] text-tx2">всего</span>
        </div>
        <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
          <span className="text-[16px] font-bold text-ok-tx tabular-nums">{enabled}</span>
          <span className="text-[11.5px] text-tx2">включены</span>
        </div>
      </header>

      <div className="flex flex-none items-center border-b border-bd px-7 py-3">
        <span className="text-[12.5px] text-tx2">С чем система соединена.</span>
      </div>

      {harness.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">
            {isNotReady(harness.error)
              ? 'Список подключений пока не отдаётся — дверь не отвечает.'
              : 'Связь потеряна. Подключения — на момент последнего, что было видно.'}
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
        <div className="flex max-w-[900px] flex-col gap-[22px]">
          <TelegramCard link={harness.data?.telegram ?? NO_LINK} />

          <div className="rounded-[14px] border border-bd bg-card px-5 py-[18px] shadow-panel">
            <div className="mb-3 text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">
              Инструменты работников
            </div>

            {mcp.length === 0 ? (
              <p className="m-0 text-[12.5px] text-tx2">
                Подключений нет. Запись в реестре делает человек на этой машине — из окна можно только
                попросить.
              </p>
            ) : (
              <div className="flex flex-col">
                {mcp.map((c, i) => (
                  <McpRow key={c.id} card={c} first={i === 0} />
                ))}
              </div>
            )}

            <div className="mt-3.5 border-t border-bd pt-3.5">
              {asking ? (
                <div className="flex flex-col gap-2.5">
                  <ForgeDialog
                    kind="mcp"
                    heading="Какой инструмент нужен"
                    placeholder="Опишите, какой инструмент нужен…"
                    submitLabel="Отправить"
                    note="Заявку готовит кузница, запись в реестр подключений делает человек на машине. Команда из окна не приходит."
                    rows={2}
                  />
                  <button
                    type="button"
                    onClick={() => setAsking(false)}
                    className="self-start rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
                  >
                    Свернуть
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAsking(true)}
                  className="rounded-[8px] border border-bd2 px-3.5 py-1.5 text-[11.5px] text-tx2 hover:text-tx"
                >
                  + Подключить инструмент
                </button>
              )}
            </div>
          </div>

          {requests.length > 0 ? (
            <div>
              <div className="mb-2 text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">Заявки</div>
              <div className="flex flex-col gap-2.5">
                {requests.map((r) => (
                  <div
                    key={r.id}
                    className="flex flex-wrap items-center gap-3 rounded-[12px] border border-bd bg-card px-4 py-3 shadow-panel"
                  >
                    <span className="min-w-0 flex-1 text-[12.5px] text-tx">{r.title ?? r.id}</span>
                    <span className="flex-none rounded-full bg-idle-s px-2.5 py-1 text-[10.5px] text-idle-tx">
                      {r.status === 'awaiting_approval' ? 'ждёт решения' : r.status}
                    </span>
                    <button
                      type="button"
                      onClick={() => openTask(r.id)}
                      className="flex-none rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
                    >
                      Квитанция проверок
                    </button>
                  </div>
                ))}
              </div>
              <p className="m-0 mt-2.5 text-[11px] leading-[1.5] text-tx3">
                Заявка — это предложение, а не подключение. Инструмент появится в списке выше, когда
                человек впишет его в реестр на машине; тумблер здесь только включает и выключает уже
                вписанное.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
