/**
 * ПЕСОЧНИЦА ДЛЯ ЧУЖОГО ДОКУМЕНТА — и маленький конвертер markdown, который в неё кладут.
 *
 * Здесь нет разметки и нет React: это счёт, а не показ. Всё, что решает, ЧТО именно окажется
 * внутри глухого iframe, вынесено сюда чистыми функциями — потому что «выжил ли `<script>`
 * после конвертации» проверяется прогоном, а на живом экране выглядит одинаково в обоих
 * случаях: пустое место там, где скрипт не выполнился, и пустое место там, где он выполнился
 * молча.
 *
 * ДВА ПРАВИЛА, НА КОТОРЫХ СТОИТ ВСЁ ОСТАЛЬНОЕ:
 *
 *   (1) ЭКРАНИРОВАНИЕ ИДЁТ ПЕРВЫМ. Текст файла экранируется ЦЕЛИКОМ до того, как конвертер
 *       увидит в нём хоть один заголовок. Значит `<script>` автора становится `&lt;script&gt;`
 *       — обычным текстом — ещё до первого преобразования, и ни одна последующая замена не
 *       может его воскресить: теги в результате бывают только НАШИ, из короткого закрытого
 *       списка. Обратный порядок (сначала разметка, потом «почистить») — это гонка между
 *       чистильщиком и автором документа, и её выигрывает автор.
 *
 *   (2) ССЫЛКА ПУСКАЕТСЯ ТОЛЬКО ПО http/https. Всё прочее — `javascript:`, `data:`, `file:` —
 *       не становится ссылкой вовсе: подпись и адрес печатаются текстом. Кавычки внутри
 *       адреса уже экранированы правилом (1), поэтому из атрибута выйти нечем.
 *
 * ЧТО ЗДЕСЬ НАМЕРЕННО НЕ РЕАЛИЗОВАНО: таблицы, сноски, html внутри markdown. Это не бедность
 * конвертера, а его граница — он покрывает то, из чего состоят планы, сводки и записи приёмки,
 * а не весь CommonMark. Незнакомая конструкция остаётся текстом, и это всегда безопасный исход.
 */

/** Что за документ перед нами — и стоит ли вообще предлагать отрисованный вид. */
export type Rendered = 'markdown' | 'html'

/** Два вида одного файла: отрисованный в песочнице и сырой текст. */
export type ArtifactView = 'rendered' | 'text'

/**
 * Права песочницы — ПУСТАЯ строка, и это утверждение, а не забывчивость.
 *
 * `sandbox=""` снимает с рамки всё сразу: скрипты, формы, плагины, собственное происхождение,
 * навигацию верхнего окна. Любое `allow-*` здесь — открытая дверь: `allow-scripts` вернул бы
 * выполнение кода из чужого файла, а `allow-scripts` вместе с `allow-same-origin` дал бы этому
 * коду доступ к приложению, в котором он открыт.
 */
export const SANDBOX_ALLOWANCES = ''

/**
 * Политика внутри рамки — вторая половина «без сети».
 *
 * Пустой sandbox выключает скрипты, но НЕ выключает пассивную загрузку: картинка по внешнему
 * адресу — это уже сигнал наружу о том, что документ открыли. `default-src 'none'` закрывает
 * сеть целиком; исключения ровно два, и оба никуда не ходят: свои стили строкой и картинки,
 * которые несёт сам документ (`data:`).
 */
export const SANDBOX_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"

/*
  РАМКА КРАСИТСЯ ТЕМОЙ ОКНА, А НЕ ТЕМОЙ ОПЕРАЦИОННОЙ СИСТЕМЫ.

  Здесь стояло `color-scheme: light dark`, и это отдавало выбор цвета текста системе
  человека: у владельца окно было светлым, а система — тёмной, поэтому браузер красил
  текст внутри рамки БЕЛЫМ, а фон рамка не рисует вовсе (она прозрачна над светлой
  подложкой окна). Получался белый текст на белом — документ открывался пустым листом
  (жалоба владельца 27.08: «файлы внутри фазы когда открываю — белый бекграунд»).

  Теперь цвет текста и подложки приезжает СНАРУЖИ, значениями из темы самого окна, и
  рамка не спрашивает систему ни о чём: `color-scheme: only light` гасит и её
  самодеятельность с формами и полосами прокрутки.
*/
const DOC_STYLE = `
:root { color-scheme: only light }
body { margin: 0; padding: 2px 2px 24px; font: 13px/1.7 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
       color: var(--doc-tx); background: transparent }
h1,h2,h3,h4,h5,h6 { margin: 1.4em 0 .5em; line-height: 1.3 }
h1 { font-size: 1.5em } h2 { font-size: 1.28em } h3 { font-size: 1.12em }
p, ul, ol, pre { margin: .7em 0 }
ul, ol { padding-left: 1.5em }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .92em }
pre { padding: .7em .9em; overflow-x: auto; border-radius: 6px; background: rgba(127,127,127,.14) }
pre code { font-size: .9em }
a { color: inherit }
hr { border: 0; border-top: 1px solid rgba(127,127,127,.35) }
img, table { max-width: 100% }
`.trim()

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Правило (1) в одну строку: пять знаков, из которых собирается любая разметка.
 *
 * Нулевой байт выбрасывается заодно — не ради разметки, а ради конвертера: им помечаются места
 * вынутого кода в `inlineMarkup`, и документ, принесший свой собственный нулевой байт, иначе
 * попал бы в чужую метку.
 */
export function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/\u0000/g, '')
    .replace(/[&<>"']/g, (ch) => ESCAPES[ch])
}

/** Правило (2): адрес не по http/https ссылкой не становится — печатается текстом рядом с подписью. */
function anchor(label: string, href: string): string {
  if (!/^https?:\/\//i.test(href)) return `${label} (${href})`
  return `<a href="${href}" rel="noreferrer nofollow">${label}</a>`
}

/**
 * Строчные преобразования — поверх УЖЕ экранированного текста.
 *
 * Код в обратных кавычках выдёргивается первым и возвращается на место последним: внутри него
 * `**` и `[]()` остаются знаками, а не разметкой, — иначе пример markdown, показанный в
 * документе, переставал быть примером.
 */
function inlineMarkup(escaped: string): string {
  const spans: string[] = []
  let s = escaped.replace(/`([^`]+)`/g, (_m, code: string) => {
    spans.push(`<code>${code}</code>`)
    return `\u0000${spans.length - 1}\u0000`
  })

  s = s.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => anchor(label, href))
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')

  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => spans[Number(i)])
}

/**
 * markdownToHtml — заголовки, списки, код-блоки, жирный/курсив, ссылки. Больше ничего.
 *
 * Возвращает ФРАГМЕНТ, а не документ: собрать его в документ — дело `sandboxDoc`, и только там
 * фрагмент встречается с политикой. Ни один вызывающий не должен захотеть отдать этот результат
 * куда-то ещё, кроме `srcdoc`; в дереве такого вызова нет.
 */
export function markdownToHtml(markdown: string): string {
  const lines = escapeHtml(markdown).split(/\r?\n/)
  const out: string[] = []
  const para: string[] = []
  let code: string[] | null = null
  let fence = ''
  let list: 'ul' | 'ol' | null = null

  const closePara = () => {
    if (para.length) {
      out.push(`<p>${inlineMarkup(para.join(' '))}</p>`)
      para.length = 0
    }
  }
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }
  const openList = (kind: 'ul' | 'ol') => {
    if (list !== kind) {
      closeList()
      out.push(`<${kind}>`)
      list = kind
    }
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const fenceHere = /^\s*(```|~~~)/.exec(line)

    if (code) {
      if (fenceHere && line.trim().startsWith(fence)) {
        out.push(`<pre><code>${code.join('\n')}</code></pre>`)
        code = null
        fence = ''
      } else {
        code.push(raw)
      }
      continue
    }

    if (fenceHere) {
      closePara()
      closeList()
      code = []
      fence = fenceHere[1]
      continue
    }

    if (!line.trim()) {
      closePara()
      closeList()
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closePara()
      closeList()
      const level = heading[1].length
      out.push(`<h${level}>${inlineMarkup(heading[2].trim())}</h${level}>`)
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closePara()
      closeList()
      out.push('<hr>')
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      closePara()
      openList('ul')
      out.push(`<li>${inlineMarkup(bullet[1])}</li>`)
      continue
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (numbered) {
      closePara()
      openList('ol')
      out.push(`<li>${inlineMarkup(numbered[1])}</li>`)
      continue
    }

    para.push(line)
  }

  if (code) out.push(`<pre><code>${code.join('\n')}</code></pre>`)
  closePara()
  closeList()

  return out.join('\n')
}

/**
 * sandboxDoc — единственная сборка документа для `srcdoc`, одна на оба вида файла.
 *
 * Политика стоит ПЕРВОЙ строкой головы, до любого содержимого: meta-CSP действует только когда
 * разбор дошёл до неё раньше, чем до того, что она ограничивает. Текст html-файла кладётся сюда
 * ЦЕЛИКОМ, ничего из него не вырезается и не переписывается — разбор сам справится с тем, что у
 * файла есть собственные `html`/`head`/`body`, а политика к этому моменту уже объявлена.
 */
export function sandboxDoc(inner: string, textColor = 'CanvasText'): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">` +
    `<style>:root{--doc-tx:${textColor}}${DOC_STYLE}</style></head><body>${String(inner ?? '')}</body></html>`
  )
}

/** Стоит ли предлагать отрисованный вид — и по какому правилу его строить. */
export function renderableAs(path: string): Rendered | null {
  const ext = /\.([a-z0-9]+)$/i.exec(String(path ?? ''))?.[1]?.toLowerCase()
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'html' || ext === 'htm') return 'html'
  return null
}

/**
 * Что именно уедет в `srcdoc` для этого файла — или `null`, если отрисовывать нечего.
 *
 * markdown идёт через конвертер, html — своим текстом целиком; документ вокруг них один и тот же.
 */
export function artifactSrcDoc(path: string, text: string, textColor?: string): string | null {
  const kind = renderableAs(path)
  if (!kind) return null
  const body = kind === 'markdown' ? markdownToHtml(text) : String(text ?? '')
  // Цвет приезжает ЗНАЧЕНИЕМ из темы окна и экранируется, как всё, что попадает в документ:
  // это строка из чужого места, даже когда чужое место — соседний файл этого же окна.
  const tx = escapeHtml(String(textColor ?? '').trim()).slice(0, 64) || 'CanvasText'
  return sandboxDoc(body, tx)
}

/** Отрисованный вид — по умолчанию там, где он есть; сырой текст — везде и всегда запасным. */
export function initialView(path: string): ArtifactView {
  return renderableAs(path) ? 'rendered' : 'text'
}

/** Переключатель ходит между двумя видами и никуда больше. */
export function otherView(view: ArtifactView): ArtifactView {
  return view === 'rendered' ? 'text' : 'rendered'
}
