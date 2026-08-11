/**
 * Markdown 渲染。
 *
 * 移植自原版 `RunRenderer.tsx` 的关键取舍——它踩过的坑不该再踩一遍：
 *
 * 1. **流式期关掉语言自动检测。** highlight.js 的 auto-detect 会拿每个代码块去和所有
 *    已注册语言打分，模型每吐一个 token 就重跑一次，长代码块会直接卡死。
 *    所以增长中的尾段只高亮显式标了语言的块，定稿后再整段重渲染并开启自动检测。
 * 2. **必须净化。** 结果会原样进 innerHTML，而模型输出不可信——它读的可能是别人
 *    仓库里的 README，`<img onerror>` 这类注入是现实威胁。
 *
 * 另加一条本版的取舍：**highlight.js 按需加载**。它的公共语言包约 200 kB，
 * 同步 import 会让首屏包从 44 kB 涨到 273 kB，而大多数会话的头几屏根本没有代码块。
 * 这里先用未高亮的结果渲染，后台把库拉回来后置位信号，由 Solid 的细粒度更新
 * 自动重渲染受影响的那几段——用户看到的是代码块「先出现、随后上色」，不是白屏等待。
 */

import { marked } from 'marked'
import { createSignal } from 'solid-js'
import { filterXSS, getDefaultWhiteList } from 'xss'

type Hljs = typeof import('highlight.js/lib/common').default

let hljs: Hljs | null = null
let loading: Promise<void> | null = null

/** 高亮库就绪信号。读它的渲染会在库加载完后自动重跑。 */
const [hljsReady, setHljsReady] = createSignal(false)

function ensureHljs(): void {
  if (hljs || loading) return
  loading = import('highlight.js/lib/common')
    .then((m) => {
      hljs = m.default
      setHljsReady(true)
    })
    .catch(() => {
      // 拉不动就一直用未高亮版本：代码块仍然可读、可复制，只是没有颜色。
      // 比整段渲染失败好得多。
      loading = null
    })
}

/** 纯文本块的 language-text 是自动检测的噪音，不显角标。 */
const PLAIN_LANGS = new Set(['text', 'plaintext', 'txt', 'plain', ''])

const WHITELIST = {
  ...getDefaultWhiteList(),
  // 高亮和角标依赖 class；不放行 class 等于高亮全废。
  span: ['class'],
  code: ['class'],
  pre: ['class'],
  div: ['class'],
  table: ['class'],
  a: ['href', 'title', 'target', 'rel'],
}

marked.setOptions({ gfm: true, breaks: false })

export interface RenderOptions {
  /** true = 内容仍在增长：跳过语言自动检测（见文件头第 1 条）。 */
  streaming?: boolean
}

export function renderMarkdown(source: string, opts: RenderOptions = {}): string {
  if (!source) return ''

  // 读一次信号，让库加载完成后这次渲染自动失效重跑。
  const ready = hljsReady()

  const renderer = new marked.Renderer()

  renderer.code = ({ text, lang }) => {
    const language = (lang ?? '').trim().toLowerCase()
    // 有代码块才去拉高亮库。没有代码块的会话永远不会付这 200 kB。
    ensureHljs()

    let highlighted = escapeHtml(text)
    let shownLang = language

    if (ready && hljs) {
      if (language && hljs.getLanguage(language)) {
        highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value
      } else if (!opts.streaming && text.length < 20_000) {
        // 自动检测只在定稿后跑，且给长度上限——超长块的检测成本没有回报。
        const auto = hljs.highlightAuto(text)
        highlighted = auto.value
        shownLang = auto.language ?? ''
      }
    }

    const badge =
      shownLang && !PLAIN_LANGS.has(shownLang)
        ? `<span class="code-lang">${escapeHtml(shownLang)}</span>`
        : ''
    return `<pre class="code-block"><code class="hljs">${highlighted}</code>${badge}</pre>`
  }

  // 外链一律新窗口打开并断开 opener——模型给的链接不可信。
  renderer.link = ({ href, title, text }) => {
    const t = title ? ` title="${escapeHtml(title)}"` : ''
    return `<a href="${escapeHtml(href ?? '')}"${t} target="_blank" rel="noreferrer noopener">${text}</a>`
  }

  const raw = marked.parse(source, { renderer, async: false }) as string
  // 窄屏上宽表格必须能独立横向滚，否则会把整页撑出横向滚动条。
  const wrapped = raw
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>')
  return filterXSS(wrapped, { whiteList: WHITELIST })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
