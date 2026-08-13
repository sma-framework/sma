import { useEffect, useState } from 'react'
import { useSearchQuery } from '../../api/queries'
import type { SearchHit } from '../../api/types'
import { plural } from '../../shell/format'
import { KindBadge, SEARCH_DEBOUNCE_MS, SEARCH_Q_CAP, groupHits, openHit } from '../../shell/search-hits'

/**
 * «Поиск» — one question, and an answer out of every corpus at once: the screens, the work,
 * the lessons, the rules and the helpers, and the attempts.
 *
 * ═══════════════════ THE ANSWER'S ORDER IS THE DAEMON'S, NOT THIS SCREEN'S ═══════════════
 *
 * Five corpora are ranked into ONE list by the side that can see all five, and that order is
 * left alone here. What this screen adds is grouping — and it groups without overruling: a
 * group appears where its best hit appeared, and inside a group the order is untouched. So the
 * first thing on the screen is still what the daemon thought was the best answer, and a person
 * reads five short lists instead of one long one.
 *
 * ═══════════════════ IT ASKS AFTER THE TYPING STOPS, AND NOT AT ALL WHEN EMPTY ═══════════
 *
 * The question settles for a breath before it is sent, so a five-letter word is one question
 * rather than five. An empty question is not asked at all: the daemon would answer an empty
 * list, and a request whose answer is already known is a request not worth making. The length
 * the door refuses is the length this field stops accepting — a person is told about a limit
 * by the field, never by a refusal after the fact.
 *
 * ═══════════════════ WHAT A HIT SAYS, AND WHAT IT DOES NOT ═══════════════════════════════
 *
 * A hit carries what it is, when it would be needed, and where it lives in the window — and
 * nothing else. There is no path on disk in it, no value out of a corpus, and the search that
 * built it does not read the fields a secret could hide in. What clicking it opens is decided
 * in one place, shared with the palette, so both surfaces lead to the same room.
 */

function HitRow({ hit, first }: { hit: SearchHit; first: boolean }) {
  // A hit whose ref points at nothing this window can open is drawn as text. A row that looks
  // like a button and answers nothing teaches a person to distrust every other row.
  const [dead, setDead] = useState(false)
  const border = first ? '' : 'border-t border-bd'

  if (dead) {
    return (
      <div className={`flex flex-col gap-1 px-[18px] py-[11px] ${border}`}>
        <div className="flex min-w-0 items-baseline gap-2.5">
          <KindBadge kind={hit.kind} />
          <span className="min-w-0 flex-1 text-[12.5px] text-tx">{hit.title}</span>
        </div>
        <span className="text-[11.5px] leading-[1.5] text-tx3">
          Открыть это отсюда пока некуда — в окне нет своей страницы для такой находки.
        </span>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (!openHit(hit)) setDead(true)
      }}
      className={`flex w-full flex-col gap-1 px-[18px] py-[11px] text-left hover:bg-surf ${border}`}
    >
      <div className="flex min-w-0 items-baseline gap-2.5">
        <KindBadge kind={hit.kind} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-tx">{hit.title}</span>
      </div>
      {hit.hint ? <span className="text-[11.5px] leading-[1.5] text-tx2">{hit.hint}</span> : null}
    </button>
  )
}

export function Screen() {
  const [question, setQuestion] = useState('')
  const [asked, setAsked] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => setAsked(question), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [question])

  const found = useSearchQuery(asked)
  const hits = found.data?.hits ?? []
  const groups = groupHits(hits)
  const askedSomething = asked.trim().length > 0

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-3 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-tx">Поиск</h1>
        <span className="flex-1" />
        {askedSomething && !found.isFetching ? (
          <span className="flex-none text-[11.5px] text-tx3 tabular-nums">
            {hits.length > 0
              ? `${hits.length} ${plural(hits.length, 'находка', 'находки', 'находок')}`
              : 'ничего'}
          </span>
        ) : null}
      </header>

      <div className="flex flex-none flex-col gap-2 border-b border-bd px-7 py-4">
        <input
          value={question}
          autoFocus
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={SEARCH_Q_CAP}
          placeholder="Что ищем"
          aria-label="Что ищем"
          className="w-full max-w-[620px] rounded-[10px] border border-bd bg-input px-[13px] py-2.5 text-[13.5px] text-tx outline-none focus:border-blue"
        />
        <span className="text-[11.5px] text-tx3">
          Один вопрос уходит сразу во все: экраны, задачи, память, правила и агенты, попытки.
          То же окно открывается по Ctrl + P из любого места.
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
        <div className="flex max-w-[860px] flex-col gap-[22px]">
          {!askedSomething ? (
            <p className="m-0 text-[13px] leading-[1.6] text-tx2">
              Напишите слово — хоть название экрана, хоть кусок задачи, хоть то, чему система
              однажды научилась. Порядок ответа выбирает не этот экран: находки приходят уже
              выстроенными по тому, насколько они подходят вопросу.
            </p>
          ) : null}

          {askedSomething && found.isLoading ? (
            <p className="m-0 text-[13px] text-tx2">Спрашиваю…</p>
          ) : null}

          {found.isError ? (
            <p className="m-0 text-[13px] leading-[1.6] text-tx2">
              Поиск сейчас не отвечает. Ничего не потеряно — это чтение, оно ничего не меняет;
              попробуйте ещё раз.
            </p>
          ) : null}

          {askedSomething && !found.isLoading && !found.isError && hits.length === 0 ? (
            <p className="m-0 text-[13px] leading-[1.6] text-tx2">
              По этому вопросу ничего не нашлось. Значения учётных записей и содержимое секретов
              не находятся никогда — их никто и не читает.
            </p>
          ) : null}

          {groups.map((group) => (
            <div key={group.kind} className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
              <div className="flex items-baseline gap-2.5 border-b border-bd px-[18px] py-[13px]">
                <span className="text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">{group.label}</span>
                <span className="text-[11px] text-tx3 tabular-nums">{group.hits.length}</span>
              </div>
              {group.hits.map((hit, i) => (
                <HitRow key={`${hit.kind}-${i}-${hit.title}`} hit={hit} first={i === 0} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
