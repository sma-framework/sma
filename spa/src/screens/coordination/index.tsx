import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, isNotReady } from '../../api/client'
import { onFrame } from '../../api/hints'
import { COORDINATION_KEY, useClaimClear, useCoordinationQuery } from '../../api/queries'
import type { CoordinationClaim, CoordinationCollision, CoordinationSession } from '../../api/types'
import { plural } from '../../shell/format'
import { Waiting } from '../../shell/Waiting'

/**
 * «Координация» — who else has this checkout open right now, what each of them reserved before
 * changing it, and where two reservations cover the same ground.
 *
 * ═════════════════════ A COLLISION IS THE REASON THIS SCREEN EXISTS ═════════════════════
 *
 * Sessions and reservations are context; an OVERLAP is the fact somebody has to act on. So it is
 * shown first and loudly, and its count sits in the header where a person sees it without
 * scrolling. A collision that has to be scrolled past to be found is a collision ignored in
 * silence, which the house rule of this product forbids in as many words.
 *
 * ═════════════════════ TAKING SOMEBODY ELSE'S RESERVATION AWAY COSTS A REASON ═════════════
 *
 * The runtime treats a foreign clear as a RISKY OPERATION: the verb refuses it without a written
 * reason, and it journals the steal with the former holder's name. The window does not soften
 * that by a field — the reason is required HERE, before the request, so a person is refused on
 * the screen they are standing on rather than by a door they cannot see. The button stays off
 * until something is typed, and what is typed goes through as the evidence, word for word.
 *
 * ═════════════════════ ONE READING, ON THE RHYTHM, PLUS ONE BELL ═════════════════════
 *
 * The snapshot is polled, because a collision appearing while a person watches is precisely
 * what this screen is for and a stale «всё чисто» is worse here than anywhere. The bell buys
 * latency on top of that and nothing else: after a reservation is cleared — by this window or
 * by a terminal — the panel is right immediately instead of within a poll. The connection is
 * the live layer's own; nothing here opens a second one.
 */

/** How long a reason may be. The limit is the door's; it is said here so nobody is refused late. */
const REASON_CAP = 2000

function CardHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex items-baseline gap-2.5 border-b border-bd px-[18px] py-[13px]">
      <span className="text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">{title}</span>
      {note ? <span className="text-[11px] text-tx3 tabular-nums">{note}</span> : null}
    </div>
  )
}

/** What a refused clear should say — the runtime's own sentence, behind a lead that names it. */
function clearWords(err: unknown): string {
  if (isNotReady(err)) return 'Снятие брони пока не работает — дверь не отвечает. Бронь на месте.'
  if (err instanceof ApiError && (err.status === 409 || err.status === 400) && err.detail) {
    return `Отказано: ${err.detail}`
  }
  return 'Снять не удалось. Бронь осталась на месте.'
}

/** The one bell of this screen: something in the ledger moved. It carries no fields. */
function useCoordinationBells(): void {
  const queryClient = useQueryClient()
  useEffect(
    () =>
      onFrame((evt) => {
        if (evt.event !== 'coordination.updated') return
        void queryClient.invalidateQueries({ queryKey: COORDINATION_KEY })
      }),
    [queryClient],
  )
}

/**
 * Two reservations over the same ground, and the ground itself. Every row carries its own top
 * rule, including the first: what sits above it is the sentence explaining the panel, not a row.
 */
function CollisionRow({ collision }: { collision: CoordinationCollision }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-bd px-[18px] py-[13px]">
      <div className="flex min-w-0 flex-wrap items-baseline gap-2 text-[12.5px] text-tx">
        <span className="font-semibold">{collision.a}</span>
        <span aria-hidden className="text-tx3">
          ↔
        </span>
        <span className="font-semibold">{collision.b}</span>
      </div>
      <div className="font-mono text-[11px] leading-[1.55] break-all text-tx2">
        {collision.overlap.join(' · ')}
      </div>
    </div>
  )
}

/** A terminal that has this checkout open right now. */
function SessionRow({ session, first }: { session: CoordinationSession; first: boolean }) {
  return (
    <div className={`flex min-w-0 items-baseline gap-3 px-[18px] py-[11px] ${first ? '' : 'border-t border-bd'}`}>
      <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full bg-ok-tx" />
      <span className="min-w-0 flex-1 text-[12.5px] text-tx">{session.title || session.id}</span>
      <span className="max-w-[200px] flex-none truncate text-[11px] text-tx3" title={session.id}>
        {session.id}
      </span>
      <span className="flex-none text-[11px] text-tx3">{session.age}</span>
    </div>
  )
}

/**
 * The question asked before a foreign reservation is taken away.
 *
 * It shows what this window actually knows about the reservation — the ground it covers, what it
 * was taken for, how long it has held — and it says plainly what the reason is FOR: it is written
 * into the record, not into a label that disappears. Who was holding it is named by the receipt
 * afterwards; the reading in front of this dialog does not carry a holder, and inventing one
 * would be worse than saying so.
 */
function ClearDialog({ claim, onClose }: { claim: CoordinationClaim; onClose: () => void }) {
  const clear = useClaimClear()
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)

  const written = reason.trim()
  const ready = written.length > 0 && written.length <= REASON_CAP

  const submit = () => {
    if (!ready) return
    setProblem(null)
    clear.mutate(
      { claim: claim.name, reason: written },
      {
        onSuccess: (result) => setReceipt(result?.receipt ?? null),
        onError: (err) => setProblem(clearWords(err)),
      },
    )
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-scrim p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Снять бронь «${claim.name}»`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        className="flex w-[440px] flex-col gap-3.5 rounded-[13px] border border-bd2 bg-card p-[18px] shadow-menu"
      >
        <div>
          <div className="text-[13.5px] font-semibold text-tx">Снять бронь: {claim.name}</div>
          <div className="mt-1 text-[11.5px] leading-[1.5] text-tx3">
            Держится {claim.age}
            {claim.desc ? ` · ${claim.desc}` : ''}
          </div>
        </div>

        {receipt ? (
          <>
            <p className="m-0 text-[12.5px] leading-[1.6] text-tx">
              Бронь снята. Причина записана в журнал вместе с тем, кто её держал.
            </p>
            <p className="m-0 font-mono text-[11px] break-all text-ok-tx">{receipt}</p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
              >
                Закрыть
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="m-0 text-[12px] leading-[1.6] text-tx2">
              Эта бронь чужая: кто-то взял её, чтобы менять эти файлы. Снятие записывается в
              журнал — напишите, почему её можно снять сейчас.
            </p>

            <textarea
              value={reason}
              autoFocus
              onChange={(e) => setReason(e.target.value)}
              maxLength={REASON_CAP}
              rows={3}
              placeholder="Почему бронь можно снять"
              aria-label="Почему бронь можно снять"
              className="w-full resize-none rounded-[9px] border border-bd bg-input px-[11px] py-2.5 text-[12.5px] text-tx outline-none focus:border-blue"
            />

            {problem ? <p className="m-0 text-[11.5px] leading-[1.5] text-err-tx">{problem}</p> : null}

            <div className="flex items-center justify-between gap-3 border-t border-bd pt-3">
              <span className="text-[11px] text-tx3">
                {ready ? 'Причина уйдёт в запись как есть' : 'Без причины снять нельзя'}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
                >
                  Отмена
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={!ready || clear.isPending}
                  className="rounded-[8px] bg-blue px-[15px] py-1.5 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
                >
                  {clear.isPending ? 'Снимаю…' : 'Снять бронь'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** A scope somebody reserved before changing it, and the one act available over it. */
function ClaimRow({
  claim,
  first,
  onClear,
}: {
  claim: CoordinationClaim
  first: boolean
  onClear: () => void
}) {
  return (
    <div className={`flex flex-col gap-1.5 px-[18px] py-[13px] ${first ? '' : 'border-t border-bd'}`}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-tx" title={claim.name}>
          {claim.name}
        </span>
        <span className="flex-none text-[11px] text-tx3">{claim.age}</span>
        <button
          type="button"
          onClick={onClear}
          className="flex-none rounded-[8px] border border-bd bg-card px-3 py-1 text-[11.5px] text-tx2 hover:text-tx"
        >
          Снять бронь
        </button>
      </div>
      {claim.desc ? <span className="text-[11.5px] leading-[1.5] text-tx2">{claim.desc}</span> : null}
      {claim.globs.length > 0 ? (
        <span className="font-mono text-[11px] leading-[1.55] break-all text-tx3">
          {claim.globs.join(' · ')}
        </span>
      ) : null}
    </div>
  )
}

export function Screen() {
  const snapshot = useCoordinationQuery()
  const [clearing, setClearing] = useState<CoordinationClaim | null>(null)
  useCoordinationBells()

  const sessions = snapshot.data?.sessions ?? []
  const claims = snapshot.data?.claims ?? []
  const collisions = snapshot.data?.collisions ?? []

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-3 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-tx">Координация</h1>
        <span className="flex-1" />
        {collisions.length > 0 ? (
          <span className="flex-none rounded-[9px] border border-bd bg-warn-s px-3 py-1.5 text-[11.5px] text-warn-tx">
            пересечений: {collisions.length}
          </span>
        ) : null}
      </header>

      <div className="flex flex-none items-center border-b border-bd px-7 py-3">
        <span className="text-[12.5px] text-tx2">
          Кто ещё открыл этот проект прямо сейчас, что каждый забронировал перед правкой и где две
          брони сошлись на одних файлах.
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
        <div className="flex max-w-[900px] flex-col gap-[22px]">
          {snapshot.isLoading ? <Waiting what="Читаю, кто здесь работает" /> : null}

          {snapshot.isError ? (
            <p className="m-0 text-[13px] text-tx2">
              Список сейчас не читается. На чужие брони это не влияет — они лежат в проекте и
              продолжают действовать.
            </p>
          ) : null}

          {collisions.length > 0 ? (
            <div className="overflow-hidden rounded-[14px] border border-bd bg-warn-s shadow-panel">
              <CardHead title="Пересечения" note={String(collisions.length)} />
              <div className="px-[18px] py-[11px] text-[12px] leading-[1.55] text-tx2">
                Две брони накрывают одни и те же файлы. Молча проходить мимо такого нельзя —
                договоритесь, кто из двоих правит их сейчас.
              </div>
              {collisions.map((c, i) => (
                <CollisionRow key={`${c.a}|${c.b}|${i}`} collision={c} />
              ))}
            </div>
          ) : null}

          <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
            <CardHead
              title="Сейчас в проекте"
              note={
                sessions.length > 0
                  ? `${sessions.length} ${plural(sessions.length, 'терминал', 'терминала', 'терминалов')}`
                  : undefined
              }
            />
            {sessions.length === 0 ? (
              <p className="m-0 px-[18px] py-4 text-[12.5px] text-tx2">
                Кроме Вас здесь сейчас никого — проект открыт в одном месте.
              </p>
            ) : (
              sessions.map((s, i) => <SessionRow key={s.id} session={s} first={i === 0} />)
            )}
          </div>

          <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
            <CardHead
              title="Брони на файлы"
              note={
                claims.length > 0
                  ? `${claims.length} ${plural(claims.length, 'бронь', 'брони', 'броней')}`
                  : undefined
              }
            />
            {claims.length === 0 ? (
              <p className="m-0 px-[18px] py-4 text-[12.5px] text-tx2">
                Ничего не забронировано — файлы никто за собой не закрепил.
              </p>
            ) : (
              claims.map((c, i) => (
                <ClaimRow key={c.name} claim={c} first={i === 0} onClear={() => setClearing(c)} />
              ))
            )}
          </div>

          <p className="m-0 max-w-[720px] text-[11.5px] leading-[1.6] text-tx3">
            Бронь — это предупреждение, а не замок: она говорит остальным, что эти файлы сейчас
            правят. Снять чужую можно, и каждое снятие остаётся в журнале вместе с причиной.
          </p>
        </div>
      </div>

      {clearing ? <ClearDialog claim={clearing} onClose={() => setClearing(null)} /> : null}
    </section>
  )
}
