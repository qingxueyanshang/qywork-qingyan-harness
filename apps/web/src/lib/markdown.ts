/**
 * Markdown 渲染。
 *
 * 四项设计取舍，前两项是实测约束：
 *
 * 1. 流式期关闭语言自动检测。highlight.js 的自动检测会把每个代码块与全部
 *    已注册语言逐一评分，模型每产出一个 token 就重新执行一次，长代码块会导致界面无响应。
 *    因此增长中的末段只高亮显式标注了语言的块，定稿后再整段重新渲染并开启自动检测。
 * 2. 必须净化。结果原样写入 innerHTML，而模型输出不可信：模型读取的可能是其他
 *    仓库的 README，`<img onerror>` 这类注入是现实威胁。
 *
 * 3. highlight.js 按需加载。其公共语言包约 200 kB，同步 import 会使首屏包从
 *    44 kB 增至 273 kB，而大多数会话的前几屏没有代码块。此处先渲染未高亮的结果，
 *    库在后台加载完成后置位信号，由 Solid 的细粒度更新自动重新渲染受影响的片段，
 *    代码块先显示、随后着色，不出现白屏等待。
 *    读取 `highlightReady()` 的位置不得包裹 `untrack`：包裹后无法建立订阅，库加载完成后
 *    也不会重新渲染。
 *
 * 4. 流式期按 token 边界增量解析（`createStreamRenderer`）。整段重新解析在 Chromium 中
 *    是线性且开销较低的（2026-08-20 实测：20000 字 3.0ms、40000 字 5.7ms、80000 字 12ms），
 *    开销主要在随之而来的整段 `innerHTML` 重建：40000 字的单次更新实测 18.2ms，其中解析只占 5.7ms。
 *    增量渲染把两部分开销都限制在活动区内（同一份文档每次更新 0.01–0.03ms），代价见 `createStreamRenderer`。
 *
 * 不要以 Bun 中的耗时作为判据：同一段代码在 `bun` 中执行 20000 字 84ms、40000 字 318ms（二次方增长），
 * 原因是 JSC 对 `src = src.substring(raw.length)` 逐 token 复制字符串，V8 不复制。
 * 本模块只在浏览器中运行，判据以浏览器为准。
 */

import { Lexer, marked, Parser, Renderer, Tokenizer, type Tokens } from 'marked'
import { createSignal } from 'solid-js'
import {
  escapeAttrValue,
  filterXSS,
  friendlyAttrValue,
  getDefaultWhiteList,
  safeAttrValue,
} from 'xss'
import { localHtmlUrl, localPath } from './links.ts'

type Hljs = typeof import('highlight.js/lib/common').default

let hljs: Hljs | null = null
let loading: Promise<void> | null = null

/** 高亮库就绪信号。读取该信号的渲染在库加载完成后自动重新执行。 */
const [hljsReady, setHljsReady] = createSignal(false)

/**
 * 高亮库就绪信号，供渲染方订阅。
 *
 * 增量渲染的已定稿 HTML 中是未高亮的代码块，库加载完成后必须使缓存整体失效并重建，
 * 否则这些代码块始终不着色。
 */
export const highlightReady = hljsReady

function ensureHljs(): void {
  if (hljs || loading) return
  loading = import('highlight.js/lib/common')
    .then((m) => {
      hljs = m.default
      setHljsReady(true)
    })
    .catch(() => {
      // 加载失败时持续使用未高亮版本：代码块仍可阅读、可复制，只是没有颜色，
      // 优于整段渲染失败。
      loading = null
    })
}

/** 纯文本块的 language-text 是自动检测的噪声，不显示角标。 */
const PLAIN_LANGS = new Set(['text', 'plaintext', 'txt', 'plain', ''])

const WHITELIST = {
  ...getDefaultWhiteList(),
  // 高亮与角标依赖 class；不放行 class 将使高亮完全失效。
  span: ['class'],
  code: ['class'],
  pre: ['class'],
  div: ['class'],
  // 代码块右上角的复制按钮。不放行 button 时复制按钮无法显示。
  button: ['class', 'type', 'aria-label', 'data-tip'],
  table: ['class'],
  a: ['href', 'title', 'target', 'rel'],
  // 被其他块隔开的续号列表，marked 输出 `<ol start="2">`；移除该属性后，
  // 第二段会从 1 重新编号（xss 默认白名单中 ol 没有任何属性）。
  ol: ['start'],
}

marked.setOptions({ gfm: true, breaks: false })

/**
 * 自动链接的右边界。GFM 的自动链接匹配到空白或 `<` 为止，尾部回退只去除 ASCII 标点；
 * 中文正文中 URL 之后紧跟全角标点而不是空格，`http://localhost:8000，选…`
 * 因此会连同后面整句一起写入 href。
 *
 * 只在非 ASCII 的标点、符号与空白处截止，不在非 ASCII 字母处截止：
 * 包含汉字的路径是合法地址，按字母截止会把它截短为无法打开的前缀。
 */
const URL_END = /(?!\p{ASCII})[\p{P}\p{S}\p{Z}]/u

marked.use({
  tokenizer: {
    /**
     * 先由 marked 识别，再截断；不要先截断再识别：截断需要扫描剩余正文，而该方法在
     * 每个行内 token 上都调用一次，先扫描会使每段正文产生平方级开销。
     * 截断后重新识别一次，用于保留 marked 自身的尾部标点回退。
     */
    url(src) {
      const token = Tokenizer.prototype.url.call(this, src)
      if (!token) return token
      const cut = token.raw.search(URL_END)
      return cut < 0 ? token : Tokenizer.prototype.url.call(this, src.slice(0, cut))
    },
  },
})

export interface RenderOptions {
  /** true 表示内容仍在增长：跳过语言自动检测（见文件头第 1 项）。 */
  streaming?: boolean
}

/**
 * 创建渲染器。
 *
 * 每次渲染都新建：`Parser` 会把当次的 options 设置到 `marked.Renderer` 上，
 * 跨调用复用会使两次渲染共享可变状态。
 */
function makeRenderer(opts: RenderOptions, ready: boolean): Renderer {
  const renderer = new Renderer()

  renderer.code = ({ text, lang }) => {
    const language = (lang ?? '').trim().toLowerCase()
    // 存在代码块时才加载高亮库。没有代码块的会话不承担这 200 kB 的开销。
    ensureHljs()

    let highlighted = escapeHtml(text)
    let shownLang = language

    if (ready && hljs) {
      if (language && hljs.getLanguage(language)) {
        highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value
      } else if (!opts.streaming && text.length < 20_000) {
        // 自动检测只在定稿后执行，并设长度上限：超长代码块的检测开销没有收益。
        const auto = hljs.highlightAuto(text)
        highlighted = auto.value
        shownLang = auto.language ?? ''
      }
    }

    const badge =
      shownLang && !PLAIN_LANGS.has(shownLang)
        ? `<span class="code-lang">${escapeHtml(shownLang)}</span>`
        : ''
    // 横向滚动由 pre 承担，角标与复制按钮位于外层 div。
    // 不要把它们移入 pre：pre 是滚动容器，绝对定位的子元素会随代码一起滚出可视区域，
    // 按钮将无法点击。
    return (
      `<div class="code-block"><pre class="code-body"><code class="hljs">${highlighted}</code></pre>` +
      `<div class="code-tools">${badge}` +
      `<button class="code-copy" type="button" data-tip="复制" aria-label="复制代码"></button>` +
      `</div></div>`
    )
  }

  // 外部链接一律在新窗口打开并断开 opener：模型提供的链接不可信。
  renderer.link = ({ href, title, text }) => {
    const t = title ? ` title="${escapeHtml(title)}"` : ''
    return `<a href="${escapeHtml(href ?? '')}"${t} target="_blank" rel="noreferrer noopener">${text}</a>`
  }

  // 本机文件的图片不内嵌，显示为路径链接，点击后在右侧预览。不要改为 `<img>`：相对地址按应用页面的地址解析，
  // 无法取得文件，净化也会将其清空，界面上显示为损坏的图片。
  const image = renderer.image.bind(renderer)
  renderer.image = (token) => {
    const path = localPath(token.href)
    if (!path) return image(token)
    return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noreferrer noopener">${escapeHtml(path)}</a>`
  }

  return renderer
}

/**
 * 渲染结果输出前的收尾：为表格添加外层容器并净化。
 *
 * 必须是最后一步：结果原样写入 innerHTML，模型输出不可信。
 * 按片段调用是安全的：外层容器的两个标记与净化都不跨片段（一张表格是一个 token）。
 */
function finish(raw: string): string {
  // 窄屏上宽表格必须能独立横向滚动，否则整页会出现横向滚动条。
  const wrapped = raw
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>')
  return filterXSS(wrapped, {
    whiteList: WHITELIST,
    safeAttrValue(tag, name, value, cssFilter) {
      // 仅保留可点击的本机文件地址（本地 HTML 由内置浏览器打开，其余由右侧文件预览打开）；不放行资源 src 与脚本协议。
      const decoded = friendlyAttrValue(value)
      if (tag === 'a' && name === 'href' && (localHtmlUrl(decoded, '/') || localPath(decoded)))
        return escapeAttrValue(decoded)
      return safeAttrValue(tag, name, value, cssFilter)
    },
  })
}

/** 整段渲染。定稿时使用：不受增量渲染已知偏差的影响，并开启语言自动检测。 */
export function renderMarkdown(source: string, opts: RenderOptions = {}): string {
  if (!source) return ''
  // 读取一次信号，使库加载完成后本次渲染自动失效并重新执行。
  const ready = hljsReady()
  const renderer = makeRenderer(opts, ready)
  return finish(marked.parse(source, { renderer, async: false }) as string)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 流式期的增量渲染。
 *
 * 边界由 lexer 划分，不由文本扫描划分；不要改为「按最后一个空行切分」。逐字符差分测试表明，至少五类块
 * 跨越空行：松散列表的紧凑 / 松散判定、有序列表续号、列表项内的四空格续行、含内部空行的缩进代码、HTML
 * 块。完整识别它们等于在扫描器中重写一遍块级语法，而块结构的权威是 lexer。
 *
 * 保留两个 token 不定稿的原因：增长中的末 token 会改变类型并与前一个 token 合并。`1. 一\n\n2` 中的 `2` 是段落，
 * 增长为 `2. 二` 后与前面的 list token 合并为一个。只保留一个时，该合并发生在已定稿区内，
 * 无法再修改。12 个用例逐字符差分实测：保留 1 个时有 4 例结果不一致且终态错误，保留 2 个时只剩下文
 * 所述的已知偏差，保留 3 个不再改善。合并不会向更前方级联：可回并的只有列表与缩进代码，
 * 它们若能与更前面的块合并，lexer 已经将其合并为一个 token。
 *
 * 已定稿的 def 必须以副本写入。marked 的引用式链接表以先写入者为准
 * （`this.tokens.links[tag] || (...)`）。若把状态中的表直接交给 lexer，末块中不完整的
 * `[spec]: htt` 会被当作合法 def 写入并永久占位，之后补全的 def 无法写入。因此交给 lexer 的是副本，
 * 且只把已定稿区中的 def 记入状态。
 *
 * 已知偏差：引用（use）已定稿、def 在两个块以上之后才到达的前向引用，流式期保持字面文本。
 * 定稿时的整段重新渲染（`renderMarkdown`）纠正该偏差，差异只存在于流式期。
 *
 * 最坏情形：整篇是一个松散列表时顶层只有两个 token，边界无法前移，退化为每次更新都重新解析全文
 * （2026-08-20 Chromium 实测，3492 字单次更新最慢 7.2ms）。渲染层的降频节流因此必须保留。
 */
export interface StreamChunk {
  /** true 表示之前输出的内容全部作废，从空容器重新写入。高亮库加载完成时发生一次。 */
  reset: boolean
  /** 本次更新新定稿的 HTML，追加到已定稿区末尾。 */
  settled: string
  /** 活动区 HTML，整段替换。 */
  live: string
}

export interface StreamRenderer {
  /** 传入当前全文，返回本次更新要写入的片段。只接受追加：文本变短视为内容已替换，整份重新渲染。 */
  push(source: string): StreamChunk
}

/** 保留不定稿的顶层 token 数。依据见 `createStreamRenderer` 的说明，不要调小。 */
const KEEP_TOKENS = 2

export function createStreamRenderer(): StreamRenderer {
  let prefixLen = 0
  let links: Record<string, Tokens.Link> = {}
  let lastReady = false

  return {
    push(source) {
      // 订阅高亮库的就绪信号：已定稿的代码块未经高亮，库加载完成后整份重新渲染。
      const ready = hljsReady()
      let reset = false
      // `Lexer.lex` 会把 \r\n 归一化，`token.raw` 的长度只与归一化后的文本一致。
      const text = source.replace(/\r\n|\r/g, '\n')
      if (ready !== lastReady || text.length < prefixLen) {
        lastReady = ready
        prefixLen = 0
        links = {}
        reset = true
      }

      const renderer = makeRenderer({ streaming: true }, ready)
      const lexer = new Lexer(marked.defaults)
      Object.assign(lexer.tokens.links, structuredClone(links))
      const tokens = lexer.lex(text.slice(prefixLen))

      let kept = 0
      let cut = tokens.length
      while (cut > 0 && kept < KEEP_TOKENS) {
        cut--
        if (tokens[cut]?.type !== 'space') kept++
      }

      const settledTokens = tokens.slice(0, cut)
      let settled = ''
      if (settledTokens.length > 0) {
        settled = finish(Parser.parse(settledTokens, { ...marked.defaults, renderer }))
        for (const token of settledTokens) {
          prefixLen += token.raw.length
          if (token.type === 'def') {
            const def = token as Tokens.Def
            links[def.tag] ??= { href: def.href, title: def.title } as Tokens.Link
          }
        }
      }
      const live = finish(Parser.parse(tokens.slice(cut), { ...marked.defaults, renderer }))
      return { reset, settled, live }
    },
  }
}
