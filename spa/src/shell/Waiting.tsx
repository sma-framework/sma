/**
 * Waiting — ЧТО СТОИТ НА МЕСТЕ СОДЕРЖИМОГО, ПОКА СОДЕРЖИМОГО НЕТ.
 *
 * Один компонент на всё окно: и на переключение проекта, и на первое открытие, и на экран,
 * который ещё читает свой список. Экран не описывает своё ожидание — он НАЗЫВАЕТ, чего ждёт
 * («Открываю фазу»), а как это выглядит, решено один раз здесь и в `waiting.ts`.
 *
 * ═══════════════ ДВИЖЕНИЕ ОБЕЩАЕТ, СЛОВА ГОВОРЯТ ПРАВДУ ═══════════════
 *
 * Полоса-горизонт едет слоями с первой миллисекунды: окно живо, ответ в пути. Но красивое
 * ожидание умеет прятать зависание — сломанное выглядит ровно как задуманное, и человек ждёт
 * ответа, которого не будет. Поэтому через `WORDS_AFTER_MS` над полосой появляются слова: что
 * именно идёт и СКОЛЬКО УЖЕ идёт. Секунду отсчитывает сам компонент — по той же причине, что и
 * чип таймера: интервал, заведённый в экране, перерисовывал бы весь экран ради одной строки.
 *
 * ═══════════════ ПОЧЕМУ ПОЛОСА ВНИЗУ, А НЕ ВО ВЕСЬ ЭКРАН ═══════════════
 *
 * Заставка во весь экран отвечает на другой вопрос и создаёт новый: на неё смотрят ВМЕСТО
 * места, где появится ответ. Горизонт стоит внизу той самой области, в которую приедет
 * содержимое, — глаз остаётся там, где ему и надо быть.
 *
 * Помощнику это место читается словами, а не картинкой: у гребней `aria-hidden`, а сама
 * область объявлена занятой (`aria-busy`) и рассказывает о себе строкой (`role="status"`).
 */

import { useEffect, useState, type CSSProperties } from 'react'

import {
  WAIT_LAYERS,
  WAIT_SKY,
  WAIT_VIEWBOX,
  waitingWords,
  type WaitLayer,
} from './waiting-language'

/**
 * Скорость и смещение слоя — переменными, а не пятью наборами кадров: это свойства СЛОЯ, и
 * держать их в CSS значило бы разложить одно описание горизонта по двум файлам.
 *
 * Двойное приведение — цена пользовательских свойств: React знает про свойства CSS по именам,
 * а `--sma-wait-*` именем CSS не является ни для одного словаря типов.
 */
function layerStyle(layer: WaitLayer): CSSProperties {
  const vars: Record<string, string> = {
    '--sma-wait-drift': layer.drift,
    '--sma-wait-seconds': `${layer.seconds}s`,
  }
  return vars as unknown as CSSProperties
}

export function Waiting({ what, fill = false }: { what: string; fill?: boolean }) {
  // Отсчёт начинается в тот момент, когда ожидание появилось на экране, а не когда экран
  // смонтировался: компонент и живёт ровно столько, сколько длится ожидание.
  const [since] = useState(() => Date.now())
  const [now, setNow] = useState(since)

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])

  const words = waitingWords(what, now - since)

  return (
    <section role="status" aria-busy="true" aria-label={what} className={`flex flex-col ${fill ? 'p-7' : ''}`}>
      {/*
        КАРТОЧКА, А НЕ ЗАЛИВКА ОБЛАСТИ. Она стоит СВЕРХУ той области, куда приедет содержимое, —
        там, где через секунду начнётся ответ, — и занимает столько же места, сколько заняла бы
        первая карточка экрана. Полоса, прижатая к низу пустой области, оставляла бы над собой
        то самое белое поле, из-за которого всё и затевалось.
      */}
      <div className="sma-wait-appear overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
        {/*
          Место под слова занято ВСЕГДА, с первой миллисекунды. Иначе появление строки сдвинуло бы
          полосу ровно в тот момент, когда человек начинает читать, — а он и так уже ждёт.
        */}
        <div className="flex min-h-[54px] items-end px-5 pb-3.5" aria-live="polite">
          {words.shown ? (
            <p className="sma-wait-words m-0 text-[12.5px] leading-none text-tx2">{words.text}</p>
          ) : null}
        </div>

        <div className="leading-[0]">
          <svg
            aria-hidden
            viewBox={WAIT_VIEWBOX}
            preserveAspectRatio="none"
            className={`block w-full ${fill ? 'h-[190px]' : 'h-[110px]'}`}
          >
            <rect x="0" y="0" width="1600" height="400" fill={`var(${WAIT_SKY})`} />
            {WAIT_LAYERS.map((layer) => (
              <g key={layer.id} className="sma-wait-layer" style={layerStyle(layer)}>
                <path d={layer.d} fill={`var(${layer.fill})`} />
              </g>
            ))}
          </svg>
        </div>
      </div>
    </section>
  )
}
