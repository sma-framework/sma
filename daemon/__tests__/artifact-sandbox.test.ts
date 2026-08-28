/**
 * ЧУЖОЙ ДОКУМЕНТ, ОТРИСОВАННЫЙ В ГЛУХОЙ РАМКЕ, — ПРОВЕРЯЕТСЯ ПРОГОНОМ, А НЕ ГЛАЗОМ.
 *
 * ═══════════════ ЗАЧЕМ ЭТО ОТДЕЛЬНЫМ ПРОГОНОМ ═══════════════
 *
 * До 25.08 в `ArtifactViewer` стоял закон «TEXT IS SHOWN AS TEXT. ALWAYS» — и он был дешёв в
 * проверке: текст в `pre` либо текст, либо нет. Владелец снял его сознательно и заменил
 * песочницей, а песочница дешёвой в проверке НЕ бывает: и выполнившийся чужой скрипт, и
 * невыполнившийся выглядят на экране одинаково — пустым местом. Человек, открывший план и не
 * увидевший ничего странного, узнал ровно ноль о том, выполнился ли `onerror` из чужого файла.
 *
 * Поэтому оба замка утверждаются здесь, по функциям и по исходнику окна:
 *
 *   (1) КОНВЕРТЕР. Заголовки, списки, код-блоки, жирный/курсив и ссылки превращаются в разметку;
 *       `<script>` и `onerror` из документа НЕ выживают — они уезжают в текст экранированными,
 *       потому что экранирование идёт первым ходом, до любого преобразования;
 *   (2) РАМКА. Права песочницы — пустая строка, никакого `allow-*` в разметке окна, содержимое
 *       уезжает через `srcdoc`, а политика внутри документа закрывает сеть;
 *   (3) ПЕРЕКЛЮЧАТЕЛЬ. Сырой вид остаётся запасным и всегда достижим, а для файла, который не
 *       markdown и не html, он единственный.
 *
 * Ссылка `javascript:` проверяется отдельным случаем: адрес, не ставший ссылкой, — это то самое
 * место, где «почти безопасно» и «безопасно» расходятся.
 */

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

import {
  SANDBOX_ALLOWANCES,
  SANDBOX_CSP,
  artifactSrcDoc,
  escapeHtml,
  initialView,
  markdownToHtml,
  otherView,
  renderableAs,
  sandboxDoc,
} from '../../spa/src/screens/tasks/sandbox'

const VIEWER = new URL('../../spa/src/screens/tasks/ArtifactViewer.tsx', import.meta.url)

/** Исходник окна без блочных и строчных комментариев: утверждения про разметку — про КОД. */
function viewerCode(): string {
  return readFileSync(VIEWER, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('конвертер markdown — то, из чего состоят планы и сводки', () => {
  it('заголовки шести уровней становятся заголовками', () => {
    const html = markdownToHtml('# Первый\n\n### Третий')
    expect(html).toContain('<h1>Первый</h1>')
    expect(html).toContain('<h3>Третий</h3>')
  })

  it('маркированный и нумерованный списки — разные списки, а не один', () => {
    const html = markdownToHtml('- один\n- два\n\n1. раз\n2. два')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>один</li>')
    expect(html).toContain('</ul>')
    expect(html).toContain('<ol>')
    expect(html).toContain('<li>раз</li>')
    expect(html).toContain('</ol>')
  })

  it('код-блок сохраняет свой текст и не разбирается как разметка', () => {
    const html = markdownToHtml('```\n**не жирный**\n  отступ сохранён\n```')
    expect(html).toContain('<pre><code>')
    expect(html).toContain('**не жирный**')
    expect(html).toContain('  отступ сохранён')
    expect(html).not.toContain('<strong>')
  })

  it('жирный, курсив и код в строке', () => {
    const html = markdownToHtml('это **жирный**, это *курсив*, это `код`')
    expect(html).toContain('<strong>жирный</strong>')
    expect(html).toContain('<em>курсив</em>')
    expect(html).toContain('<code>код</code>')
  })

  it('внутри кода в строке разметка остаётся знаками', () => {
    const html = markdownToHtml('пример: `**звёздочки**`')
    expect(html).toContain('<code>**звёздочки**</code>')
    expect(html).not.toContain('<strong>')
  })

  it('ссылка http/https становится ссылкой', () => {
    const html = markdownToHtml('см. [доку](https://example.org/a?b=1)')
    expect(html).toContain('<a href="https://example.org/a?b=1"')
    expect(html).toContain('>доку</a>')
  })

  it('ссылка НЕ по http/https ссылкой не становится — печатается текстом', () => {
    const html = markdownToHtml('[жми](javascript:alert(1))')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('href=')
    expect(html).toContain('жми')
    expect(html).toContain('javascript:alert(1)')
  })

  it('скрипт из документа НЕ выживает', () => {
    const html = markdownToHtml('# Заголовок\n\n<script>alert(1)</script>\n')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('onerror из документа НЕ выживает — тег уезжает текстом', () => {
    const html = markdownToHtml('- <img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('кавычки закрыты, из атрибута ссылки выйти нечем', () => {
    const html = markdownToHtml('[x](https://a.example/" onmouseover="alert(1))')
    expect(html).not.toContain('onmouseover="alert(1)"')
    expect(escapeHtml('"')).toBe('&quot;')
    expect(escapeHtml("'")).toBe('&#39;')
  })
})

describe('рамка — пустой sandbox и закрытая сеть', () => {
  it('права песочницы — пустая строка, никаких allow-*', () => {
    expect(SANDBOX_ALLOWANCES).toBe('')
    expect(SANDBOX_ALLOWANCES).not.toContain('allow')
  })

  it('политика внутри документа закрывает сеть целиком', () => {
    expect(SANDBOX_CSP).toContain("default-src 'none'")
    expect(SANDBOX_CSP).not.toContain('http')
    expect(sandboxDoc('<p>x</p>')).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    )
  })

  it('политика объявлена ДО содержимого, иначе она не действует', () => {
    const doc = sandboxDoc('<p>тело</p>')
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<p>тело</p>'))
  })

  it('окно ставит рамке ровно эти права и не пишет allow-* руками', () => {
    const code = viewerCode()
    expect(code).toContain('sandbox={SANDBOX_ALLOWANCES}')
    expect(code).not.toContain('allow-')
    expect(code).toContain('srcDoc={srcDoc}')
  })

  it('вне рамки по-прежнему ничего не рендерится как разметка', () => {
    expect(readFileSync(VIEWER, 'utf8')).not.toContain('dangerouslySetInnerHTML')
  })
})

describe('что именно уезжает в рамку', () => {
  it('markdown-файл — конвертированным, html-файл — своим текстом целиком', () => {
    const md = artifactSrcDoc('.planning/phases/01/PLAN.md', '# План\n\n<script>alert(1)</script>')
    expect(md).toContain('<h1>План</h1>')
    expect(md).not.toContain('<script')

    const raw = '<!doctype html><html><body><b>отчёт</b><script>alert(1)</script></body></html>'
    const html = artifactSrcDoc('reports/run.html', raw)
    expect(html).toContain(raw)
  })

  it('файл, который не markdown и не html, отрисованного вида не получает', () => {
    expect(renderableAs('notes/log.txt')).toBeNull()
    expect(artifactSrcDoc('notes/log.txt', '# не заголовок')).toBeNull()
    expect(renderableAs('PLAN.MD')).toBe('markdown')
    expect(renderableAs('a/b/report.htm')).toBe('html')
  })
})

describe('переключатель вид/текст', () => {
  it('отрисованный вид — по умолчанию там, где он есть', () => {
    expect(initialView('SUMMARY.md')).toBe('rendered')
    expect(initialView('run.html')).toBe('rendered')
  })

  it('для прочих файлов вид один — сырой текст', () => {
    expect(initialView('receipt.json')).toBe('text')
    expect(initialView('Makefile')).toBe('text')
  })

  it('переключатель ходит между двумя видами и возвращается', () => {
    expect(otherView('rendered')).toBe('text')
    expect(otherView('text')).toBe('rendered')
    expect(otherView(otherView('rendered'))).toBe('rendered')
  })

  it('кнопка сырого вида есть в окне и подписана словом', () => {
    const code = viewerCode()
    expect(code).toContain('otherView(view)')
    expect(code).toContain("'текст'")
  })
})
