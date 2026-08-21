/**
 * Markdown 渲染。
 *
 * 四条取舍，前两条是踩过的坑：
 *
 * 1. **流式期关掉语言自动检测。** highlight.js 的 auto-detect 会拿每个代码块去和所有
 *    已注册语言打分，模型每吐一个 token 就重跑一次，长代码块会直接卡死。
 *    所以增长中的尾段只高亮显式标了语言的块，定稿后再整段重渲染并开启自动检测。
 * 2. **必须净化。** 结果会原样进 innerHTML，而模型输出不可信——它读的可能是别人
 *    仓库里的 README，`<img onerror>` 这类注入是现实威胁。
 *
 * 3. **highlight.js 按需加载。**它的公共语言包约 200 kB，
 * 同步 import 会让首屏包从 44 kB 涨到 273 kB，而大多数会话的头几屏根本没有代码块。
 * 这里先用未高亮的结果渲染，后台把库拉回来后置位信号，由 Solid 的细粒度更新
 * 自动重渲染受影响的那几段——用户看到的是代码块「先出现、随后上色」，不是白屏等待。
 * **读 `highlightReady()` 的地方不许套 `untrack`**，套了就建不起订阅，库到了也不会重渲染。
 *
 * 4. **流式期按 token 边界增量解析**（`createStreamRenderer`）。整段重解析在 Chromium 里
 * 是线性且不贵的（2026-08-20 实测：20000 字 3.0ms、40000 字 5.7ms、80000 字 12ms），
 * **贵的是它带来的整段 `innerHTML` 重建**——40000 字的一档实测 18.2ms，其中解析只占 5.7ms。
 * 增量把两半一起收敛到活动区（同一份文档每档 0.01–0.03ms），代价见 `createStreamRenderer`。
 *
 * **不要拿 Bun 里的耗时当判据**：同一段代码 `bun` 跑 20000 字 84ms、40000 字 318ms（二次），
 * 那是 JSC 对 `src = src.substring(raw.length)` 逐 token 搬字符串的行为，V8 不搬。
 * 这个模块只在浏览器里跑，判据以浏览器为准。
 */

import { Lexer, marked, Parser, Renderer, type Tokens } from 'marked'
import { createSignal } from 'solid-js'
import { filterXSS, getDefaultWhiteList } from 'xss'

type Hljs = typeof import('highlight.js/lib/common').default

let hljs: Hljs | null = null
let loading: Promise<void> | null = null

/** 高亮库就绪信号。读它的渲染会在库加载完后自动重跑。 */
const [hljsReady, setHljsReady] = createSignal(false)

/**
 * 高亮库就绪信号，给渲染方订阅用。
 *
 * 增量渲染的已定稿 HTML 里是**未高亮**的代码块，库到了必须把缓存整份作废重建，
 * 否则那些块永远灰着。
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
  // 中间隔了别的块的续号列表，marked 会给出 `<ol start="2">`；剥掉这个属性，
  // 第二段会从 1 重新数（xss 默认表里 ol 是空的）。
  ol: ['start'],
}

marked.setOptions({ gfm: true, breaks: false })

export interface RenderOptions {
  /** true = 内容仍在增长：跳过语言自动检测（见文件头第 1 条）。 */
  streaming?: boolean
}

/**
 * 配一个渲染器。
 *
 * 每次渲染新建：`marked.Renderer` 会被 `Parser` 挂上当次的 options，
 * 跨调用复用等于让两次渲染共享可变状态。
 */
function makeRenderer(opts: RenderOptions, ready: boolean): Renderer {
  const renderer = new Renderer()

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

  return renderer
}

/**
 * 渲染结果落地前的收尾：表格包壳 + 净化。
 *
 * **必须是最后一步**：结果会原样进 innerHTML，模型输出不可信。
 * 按片调用是安全的——包壳的两个标记与净化都不跨片（一张表是一个 token）。
 */
function finish(raw: string): string {
  // 窄屏上宽表格必须能独立横向滚，否则会把整页撑出横向滚动条。
  const wrapped = raw
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>')
  return filterXSS(wrapped, { whiteList: WHITELIST })
}

/** 整段渲染。定稿走这条：它不受增量的已知偏差影响，也开着语言自动检测。 */
export function renderMarkdown(source: string, opts: RenderOptions = {}): string {
  if (!source) return ''
  // 读一次信号，让库加载完成后这次渲染自动失效重跑。
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
 * ## 边界由 lexer 划，不由文本扫描划
 *
 * **不要改回「按最后一个空行切」。** 逐字符差分测过，至少五类块跨空行：松散列表的紧凑/松散
 * 定型、有序列表续号、列表项内的四空格续行、含内部空行的缩进代码、HTML 块。
 * 认全它们等于在扫描器里重写一遍块级语法，而块结构的权威本来就是 lexer。
 *
 * ## 为什么留两个 token 不定稿
 *
 * 增长中的末 token 会变型并**向前合并一格**：`1. 一

2` 里的 `2` 是段落，
 * 长成 `2. 二` 之后与前面那个 list token 合并成一个。留一个的话这一合并就落在已定稿区里，
 * 改不动了——12 个用例逐字符差分实测，留 1 个有 4 例分叉且终态也错，留 2 个只剩下面那条
 * 已知偏差，留 3 个不再改善。不会级联更远：能被回并的只有列表与缩进代码，
 * 它们若与更前面的块可并，lexer 早就并成一个 token 了。
 *
 * ## 已定稿的 def 必须种副本进去
 *
 * marked 的引用式链接表**先到先得**（`this.tokens.links[tag] || (...)`）。把状态里那张表
 * 直接交给 lexer 的话，尾块里半截的 `[spec]: htt` 会被当成合法 def 写进去并永久占位，
 * 之后补全的那条再也进不来。所以交副本，且只把**已定稿区**里的 def 记进状态。
 *
 * ## 已知偏差
 *
 * use 已定稿、def 隔两个块以上才到的前向引用，流式期保持字面文本。定稿时的整段重渲染
 * （`renderMarkdown`）纠正它——差别只存在于流式期。
 *
 * ## 最坏情形
 *
 * 整篇是一个松散列表时顶层只有两个 token，边界推不动，退化为每档重解析全文
 * （2026-08-20 实测 Chromium，3492 字最慢 7.2ms 一档）。这就是渲染层那道降频闸门要留着的原因。
 */
export interface StreamChunk {
  /** true = 之前给出的都作废，从空容器重新贴。高亮库到位时会发生一次。 */
  reset: boolean
  /** 这一档新定稿的 HTML，追加在已定稿区末尾。 */
  settled: string
  /** 活动区 HTML，整段替换。 */
  live: string
}

export interface StreamRenderer {
  /** 传当前全文，拿这一档要落地的东西。**只接受追加**：文本变短视为换了一份，整份重来。 */
  push(source: string): StreamChunk
}

/** 留几个顶层 token 不定稿。判据见 `createStreamRenderer` 的说明，不要调小。 */
const KEEP_TOKENS = 2

export function createStreamRenderer(): StreamRenderer {
  let prefixLen = 0
  let links: Record<string, Tokens.Link> = {}
  let lastReady = false

  return {
    push(source) {
      // 订阅高亮库的就绪信号：已定稿的代码块是未高亮的，库到了整份重来。
      const ready = hljsReady()
      let reset = false
      // `Lexer.lex` 自己会把 \r\n 归一，`token.raw` 的长度只与归一后的文本对得上。
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
