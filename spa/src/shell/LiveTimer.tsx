/**
 * LiveTimer — ЧИП-ТАЙМЕР В ШАПКЕ СУЩНОСТИ: единственное на экране, что движется само.
 *
 * ═══════════════ ПОЧЕМУ СЕКУНДА ЖИВЁТ ЗДЕСЬ, А НЕ В ЭКРАНЕ ═══════════════
 *
 * Интервал, заведённый в компоненте страницы, перерисовывает КАЖДУЮ СЕКУНДУ всю страницу — со
 * стадиями фазы, лентой подхода и разбором различий вместе с ней. Экран от этого не ломается,
 * он просто начинает греть машину ради одной строки текста, и заметить это можно только
 * профилировщиком.
 *
 * Поэтому часы дёргает САМ ЧИП: состояние `now` принадлежит ему, и перерисовывается по тику
 * ровно он. Страница вокруг о секунде не знает вовсе.
 *
 * Что показывать — решает `timerChip()`, чистая функция, утверждённая прогоном. Здесь только
 * часы и разметка: нет момента или сущности нечего отсчитывать — компонент честно не рисует
 * ничего, и место в шапке остаётся пустым.
 */

import { useEffect, useState } from 'react'

import { timerChip, type Moment, type TimerState } from './live-timer'

export function LiveTimer({ state, since }: { state: TimerState; since: Moment }) {
  const [now, setNow] = useState(() => Date.now())

  // Тикаем только пока есть что тикать: у закрытой сущности и у сущности без момента интервала
  // нет вовсе. `state`/`since` в зависимостях — сменилось состояние, часы перезаводятся.
  const ticking = timerChip(state, since, now) !== null
  useEffect(() => {
    if (!ticking) return
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [ticking, state, since])

  const chip = timerChip(state, since, now)
  if (!chip) return null

  return (
    <span
      className={`flex flex-none items-center gap-1.5 rounded-[6px] border px-2.5 py-1 ${chip.tone}`}
      // Живое время читается вслух помощником целиком, а не по цифре в секунду.
      aria-label={chip.text}
      title={chip.text}
    >
      <svg
        aria-hidden
        width="11"
        height="11"
        viewBox="0 0 12 12"
        className={`flex-none ${chip.spinning ? 'animate-spin' : ''}`}
      >
        <circle
          cx="6"
          cy="6"
          r="4.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeDasharray="21 8"
        />
      </svg>
      <span className="font-mono text-[11px] font-semibold tabular-nums">{chip.text}</span>
    </span>
  )
}
