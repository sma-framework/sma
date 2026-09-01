import { useState } from 'react'

import { useStateQuery } from '../../api/queries'
import type { RemoteAccess } from '../../api/types'
import { CAVEAT_KEYS, COPY, LANGS, LANG_LABEL, OS_KEYS } from './copy'
import type { Copy, Lang, OsKey, Step } from './copy'

/**
 * «Работать удалённо» — онбординг приватной сети, который ОБЪЯСНЯЕТ И ПРОВЕРЯЕТ.
 *
 * ═════════════════ ЧТО ЭТОТ ЭКРАН ДЕЛАЕТ — И ЧЕГО НЕ ДЕЛАЕТ НИКОГДА ═════════════════
 *
 * Он говорит требование словами, показывает ФАКТ о двери этого демона и даёт готовые к
 * копированию команды. Он не ставит программ, не правит настроек и не открывает ни одной
 * двери демона: во всём файле нет ни одного пишущего вызова, и это проверяется тестом, а не
 * обещанием в комментарии.
 *
 * Решение принято сразу и стоит того, чтобы быть записанным: поставить чужую программу за
 * человека из НАШЕГО установщика — значит привести в дом чужую зависимость, чужую границу
 * доверия и чужую лицензию. Продукт живёт на машине человека, и молча приводить туда третью
 * сторону он не должен. Поэтому «скачайте вот это» здесь текст и команда, а не кнопка.
 *
 * ═════════════════ ПОЧЕМУ ФАКТ, А НЕ СОВЕТ ═════════════════
 *
 * Половина вопроса «почему у меня не открывается со второй машины» отвечается двумя
 * значениями: на что демон привязан и есть ли на машине приватная сеть. Оба приезжают
 * посчитанными демоном (`remoteAccess` в общей полезной нагрузке) — окно их не вычисляет,
 * потому что второе мнение о том, кому видна дверь, было бы вторым ответом на вопрос
 * безопасности. Самый важный случай экрана — тот, где сеть ЕСТЬ, а демон всё равно слушает
 * петлю: адреса для второй машины нет, и сказано, почему.
 *
 * ═════════════════ ПОЧЕМУ ТУТ ЖИВУТ ДВА ЯЗЫКА ═════════════════
 *
 * Единственный экран окна, который заранее пишется не для одного читателя: он про то, как
 * ЛЮБОЙ человек уводит своё окно на вторую машину. Текст лежит данными в `copy.ts`, составы
 * двух языков сверяются тестом, а переключатель ниже только выбирает между ними.
 */

/** Одна команда: показана целиком и копируется целиком. Ничего не выполняет. */
function CommandLine({ command, copy }: { command: string; copy: Copy }) {
  const [taken, setTaken] = useState(false)

  const take = () => {
    // Буфер обмена — единственное, что этот экран трогает во внешнем мире, и он не всегда
    // доступен (старый браузер, страница без защищённого контекста). Отказ буфера не должен
    // выглядеть как отказ экрана: команда всё равно на глазах, её можно выделить руками.
    void navigator.clipboard
      ?.writeText(command)
      .then(() => {
        setTaken(true)
        window.setTimeout(() => setTaken(false), 1600)
      })
      .catch(() => setTaken(false))
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 rounded-[8px] border border-bd2 bg-bg px-3 py-1.5 font-mono text-[11.5px] leading-[1.5] break-all whitespace-pre-wrap text-tx">
        {command}
      </code>
      <button
        type="button"
        onClick={take}
        className="flex-none rounded-[8px] border border-bd2 px-3 py-1.5 text-[11px] text-tx2 hover:text-tx"
      >
        {taken ? copy.copiedLabel : copy.copyLabel}
      </button>
    </div>
  )
}

/** Шаги под одну систему: что делает человек, и — где она есть — сама команда. */
function StepList({ steps, copy }: { steps: Step[]; copy: Copy }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-3 p-0">
      {steps.map((step, i) => (
        <li key={i} className="flex flex-col gap-1.5">
          <div className="flex gap-2.5">
            <span className="flex-none text-[11.5px] text-tx3 tabular-nums">{i + 1}</span>
            <span className="min-w-0 text-[12.5px] leading-[1.55] text-tx2">{step.text}</span>
          </div>
          {step.command ? (
            <div className="pl-[22px]">
              <CommandLine command={step.command} copy={copy} />
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

/** Заголовок карточки — одинаковый во всех шести блоках экрана. */
function CardTitle({ children }: { children: string }) {
  return <div className="mb-2.5 text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">{children}</div>
}

/** Одна строка факта: подпись, значение и объяснение под ним. */
function Fact({ label, value, note }: { label: string; value: string; note: string | null }) {
  return (
    <div className="flex flex-col gap-1 border-t border-bd py-2.5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="flex-none text-[11.5px] text-tx3">{label}</span>
        <span className="min-w-0 font-mono text-[12.5px] break-all text-tx">{value}</span>
      </div>
      {note ? <p className="m-0 text-[11.5px] leading-[1.5] text-tx2">{note}</p> : null}
    </div>
  )
}

/** ФАКТЫ — три проверки: дверь, кому она видна, есть ли приватная сеть. */
function Facts({ remote, copy }: { remote: RemoteAccess | undefined; copy: Copy }) {
  if (!remote) return <p className="m-0 text-[12.5px] text-tx2">{copy.facts.waiting}</p>

  const net = remote.privateNetwork
  const networkNote = !net.readable
    ? copy.facts.networkUnreadable
    : net.detected
      ? copy.facts.networkDetected
      : copy.facts.networkAbsent
  const mesh = net.interfaces.filter((i) => i.kind === 'mesh')
  const lan = net.interfaces.filter((i) => i.kind === 'lan')
  const networkValue = net.detected ? mesh.map((i) => `${i.address} (${i.interface})`).join(', ') : '—'

  return (
    <div className="flex flex-col">
      <Fact
        label={copy.facts.bindLabel}
        value={`${remote.bind}:${remote.port}`}
        note={remote.visibleBeyondThisMachine ? copy.facts.visibleYes : copy.facts.visibleNo}
      />
      <Fact label={copy.facts.reachLabel} value={remote.bind} note={copy.facts.reach[remote.reach]} />
      <Fact label={copy.facts.networkLabel} value={networkValue} note={networkNote} />
      {lan.length > 0 ? (
        <p className="m-0 pb-2.5 text-[11.5px] leading-[1.5] text-tx3">
          {lan.map((i) => `${i.address} (${i.interface})`).join(', ')} — {copy.facts.lanIsNotAMesh}
        </p>
      ) : null}
      <Fact
        label={copy.facts.openFromLabel}
        value={remote.openFrom ?? '—'}
        note={remote.openFrom ? null : copy.facts.openFromNone}
      />
    </div>
  )
}

export function Screen() {
  const state = useStateQuery()
  const [lang, setLang] = useState<Lang>('ru')
  const [os, setOs] = useState<OsKey>('macos')
  const copy = COPY[lang]
  const remote = state.data?.remoteAccess

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none flex-wrap items-center gap-2.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 mr-2 min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-tx">
          {copy.title}
        </h1>
        <div className="flex flex-none gap-1.5">
          {LANGS.map((code) => (
            <button
              key={code}
              type="button"
              aria-pressed={lang === code}
              onClick={() => setLang(code)}
              className={`rounded-[8px] border px-3 py-1.5 text-[11px] ${
                lang === code ? 'border-bd2 bg-card text-tx' : 'border-transparent text-tx3 hover:text-tx2'
              }`}
            >
              {LANG_LABEL[code]}
            </button>
          ))}
        </div>
      </header>

      <div className="flex flex-none items-center border-b border-bd px-7 py-3">
        <span className="text-[12.5px] leading-[1.5] text-tx2">{copy.installsNothing}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
        <div className="flex max-w-[820px] flex-col gap-[22px]">
          <p className="m-0 text-[12.5px] leading-[1.55] text-tx2">{copy.subtitle}</p>

          <div className="rounded-[14px] border border-bd bg-card px-5 py-[18px] shadow-panel">
            <CardTitle>{copy.requirement.title}</CardTitle>
            <p className="m-0 text-[12.5px] leading-[1.55] text-tx2">{copy.requirement.body}</p>
          </div>

          <div className="rounded-[14px] border border-bd bg-card px-5 py-[18px] shadow-panel">
            <CardTitle>{copy.facts.title}</CardTitle>
            <Facts remote={remote} copy={copy} />
          </div>

          <div className="rounded-[14px] border border-bd bg-card px-5 py-[18px] shadow-panel">
            <CardTitle>{copy.setup.title}</CardTitle>
            <p className="m-0 mb-2 text-[12.5px] leading-[1.55] text-tx2">{copy.setup.body}</p>
            <p className="m-0 mb-2 text-[12.5px] leading-[1.55] text-tx2">{copy.setup.vendorNeutral}</p>
            <p className="m-0 mb-3.5 text-[11.5px] leading-[1.5] text-tx3">{copy.setup.tested}</p>

            <div className="mb-3.5 flex flex-wrap gap-1.5">
              {OS_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={os === key}
                  onClick={() => setOs(key)}
                  className={`rounded-[8px] border px-3 py-1.5 text-[11.5px] ${
                    os === key ? 'border-bd2 bg-bg text-tx' : 'border-transparent text-tx3 hover:text-tx2'
                  }`}
                >
                  {copy.setup.osLabel[key]}
                </button>
              ))}
            </div>

            <StepList steps={copy.setup.steps[os]} copy={copy} />
          </div>

          <div className="rounded-[14px] border border-bd bg-card px-5 py-[18px] shadow-panel">
            <CardTitle>{copy.caveatsTitle}</CardTitle>
            <div className="flex flex-col">
              {CAVEAT_KEYS.map((key, i) => (
                <div key={key} className={`flex flex-col gap-1 py-3 ${i === 0 ? 'pt-0' : 'border-t border-bd'}`}>
                  <span className="text-[12.5px] font-semibold text-tx">{copy.caveats[key].title}</span>
                  <p className="m-0 text-[12.5px] leading-[1.55] text-tx2">{copy.caveats[key].body}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[14px] border border-bd bg-card px-5 py-[18px] shadow-panel">
            <CardTitle>{copy.rotate.title}</CardTitle>
            <p className="m-0 mb-3.5 text-[12.5px] leading-[1.55] text-tx2">{copy.rotate.body}</p>
            <StepList steps={copy.rotate.steps} copy={copy} />
          </div>

          <div className="rounded-[14px] border border-warn-s bg-warn-s px-5 py-[18px]">
            <div className="mb-2.5 text-[10px] font-semibold tracking-[0.1em] text-warn-tx uppercase">
              {copy.refusal.title}
            </div>
            <p className="m-0 text-[12.5px] leading-[1.55] text-tx">{copy.refusal.body}</p>
          </div>

          <p className="m-0 text-[11.5px] leading-[1.5] text-tx3">
            {copy.runbook.label}: <span className="font-mono text-tx2">{copy.runbook.path}</span>
          </p>
        </div>
      </div>
    </section>
  )
}
