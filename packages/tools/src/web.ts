/**
 * 联网工具。
 *
 * 与本地工具不同的两条约束：
 *
 * 1. 必须经过 SSRF 防护（`net-safety.ts`）。URL 来自模型，模型的 URL 来自它读取的
 *    网页内容；不拦截内网地址，等于把 SSRF 能力交给模型。
 * 2. 产出进入 sink。网页正文是典型的不可重放内容：同一个 URL 次日获取的
 *    不是同一份字节。截断丢弃的部分无法再取回，因此必须先落盘。
 */

import { deliveredTokens, recordBatchSpent, type ToolContext, type ToolSpec } from '@qywork/agent'
import type { IntermediateResourceRef } from '@qywork/core'
import { badIntMessage, intArg } from './args.ts'
import { type SafetyOptions, safeFetch } from './net-safety.ts'
import { deliver, excerptBytes } from './sink.ts'

/** 用户配置注入 ctx.resources 时使用的键。未配置时使用默认（最严格）策略。 */
export const NET_POLICY_KEY = 'qywork.netPolicy'

function policyOf(ctx: ToolContext): SafetyOptions {
  const raw = ctx.resources.get(NET_POLICY_KEY)
  return (raw as SafetyOptions | undefined) ?? {}
}

export const webFetchTool: ToolSpec = {
  name: 'web_fetch',
  description:
    '抓取一个网页并返回正文（HTML 会转为纯文本）。用于阅读文档、查看 issue、查询 API 说明。' +
    '只允许 http/https 且不能指向内网地址。超长正文会自动保存，用 read_resource 取回全文。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL，含协议' },
      raw: { type: 'boolean', description: 'true=返回原始 HTML，不转纯文本。默认 false' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '网页',
  category: 'web',
  facet: '抓取',
  summary: '获取网页并提取正文',
  targetExtractor: (a) => (typeof a.url === 'string' ? a.url : null),
  // 网络访问有副作用：会把 URL（可能含敏感路径）暴露给第三方，也可能触发对方的写操作。
  permissionEffect: 'network',
  // 不同 URL 之间互不影响，可以并行。
  parallelSafe: true,
  resourceKeys: (a) => [`url:${String(a.url ?? '')}`],

  async fn(args, ctx) {
    const url = String(args.url ?? '').trim()
    if (!url) return { status: 'failure', message: '缺少 url' }

    let res: Awaited<ReturnType<typeof safeFetch>>
    try {
      res = await safeFetch(url, { ...policyOf(ctx), signal: ctx.signal })
    } catch (err) {
      return {
        status: 'failure',
        message: `请求失败：${err instanceof Error ? err.message : String(err)}`,
        errorKind: 'network_error',
      }
    }

    if (res.blocked) {
      // 被安全策略拦截时说明是哪条规则：模型据此判断应更换 URL 还是放弃，
      // 只返回「失败」时它会原地重试同一个地址。
      return {
        status: 'failure',
        message: `${res.blocked.message}（规则：${res.blocked.reason}）`,
        errorKind: 'blocked_by_policy',
        data: { blockedUrl: res.blocked.url, reason: res.blocked.reason },
      }
    }

    if (!res.ok) {
      return {
        status: 'failure',
        message: `HTTP ${res.status}`,
        errorKind: 'http_error',
        data: { status: res.status, url: res.url },
      }
    }

    const contentType = res.contentType ?? ''
    const isHtml = contentType.includes('html')
    const text =
      args.raw === true || !isHtml
        ? new TextDecoder('utf-8').decode(res.body)
        : htmlToText(new TextDecoder('utf-8').decode(res.body))

    const landed = deliver(ctx.sink, {
      toolName: 'web_fetch',
      sourceType: 'http',
      body: new TextEncoder().encode(text),
      mimeType: contentType || 'text/plain',
      query: url,
      budget: excerptBytes(ctx),
    })
    // 摘录计入本次决策的额度：`deliver` 已把它限制在 8 KB 与剩余额度之内，
    // 一次决策中多次外部获取合计仍为一笔。
    // 必须使用 `recordBatchSpent` 而不是 `chargeBatchBudget`：抓取已发生、摘录已投递，
    // 超额时后者不累加，同一决策中其余读取工具会按不存在的余额准入。
    recordBatchSpent(ctx, deliveredTokens(landed.text, ctx.density))

    // 响应超过读取上限时，保存的也只是开头部分：在覆盖事实中记录取得不完整，
    // 避免它被当作完整的远端正文引用。
    const acquisition = res.truncated
      ? { acquisition: 'partial', acquiredBytes: res.body.byteLength }
      : {}
    const resources: IntermediateResourceRef[] = landed.resourceId
      ? [
          {
            resourceId: landed.resourceId as never,
            status: landed.status,
            contentHash: null,
            sizeBytes: landed.coverage.totalBytes ?? 0,
            mimeType: contentType || null,
            coverage: { ...landed.coverage, ...acquisition },
          },
        ]
      : []

    return {
      status: 'success',
      // 必须把重定向链告知模型：最终 URL 可能与请求的地址不同，
      // 而模型接下来可能基于该 URL 拼接相对路径。
      message:
        (res.redirects.length
          ? `已抓取（经 ${res.redirects.length} 次重定向，最终 ${res.url}）`
          : '已抓取') +
        (res.truncated ? `；响应超过读取上限，只取得开头 ${res.body.byteLength} 字节` : ''),
      data: {
        url: res.url,
        finalUrl: res.url,
        contentType,
        content: landed.text,
        ...(landed.coverage.truncated ? { coverage: landed.coverage } : {}),
        ...acquisition,
        ...(res.redirects.length ? { redirects: res.redirects } : {}),
      },
      ...(resources.length ? { resources } : {}),
    }
  },
}

/**
 * HTML 转纯文本。
 *
 * 有意不引入 DOM 解析库：agent 需要的是可读正文，不是精确的文档结构。
 * 引入一个 200 kB 的解析器只为使列表缩进更准确，得不偿失。
 *
 * 顺序很重要：先去除 script/style（其内容不是正文，混入后只是噪声），
 * 再把块级标签替换为换行（否则整页会合并为一行），最后去除其余标签。
 */
export function htmlToText(html: string): string {
  return (
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, '')
      // 开闭标签都替换为换行：只替换闭标签时相邻段落之间只有一个换行，
      // 段落分隔丢失（正文读起来像一整段）。多出的空行由后续步骤压缩。
      .replace(/<\/?(p|div|section|article|tr|h[1-6]|blockquote|pre)\b[^>]*>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // &amp; 必须最后替换，否则 &amp;lt; 会经两步还原为 <，
      // 把页面上原本要显示的实体文本变成标签。
      .replace(/&amp;/g, '&')
      // 三个以上的换行压缩为两个：保留段落分隔，去除大片空白。
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/**
 * 网页搜索。
 *
 * 使用 DuckDuckGo 的 HTML 端点：不需要 API Key，用户无需先申请即可使用。
 * 代价是解析的是 HTML 而不是结构化响应，站点改版后会失效；因此解析失败时
 * 明确报告解析失败，而不是返回空结果：空结果在模型看来等同于未搜到。
 */
export const webSearchTool: ToolSpec = {
  name: 'web_search',
  description:
    '搜索网页，返回标题、链接与摘要。用于查找文档、查找报错的解决方案、查询库的用法。' +
    '获得链接后用 web_fetch 读取全文。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索词' },
      limit: { type: 'integer', description: '返回条数，默认 8，最大 20' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  actionKind: 'query',
  objectLabel: '网页',
  category: 'web',
  facet: '搜索',
  summary: '按关键词搜索网页',
  targetExtractor: (a) => (typeof a.query === 'string' ? a.query : null),
  permissionEffect: 'network',
  parallelSafe: true,
  resourceKeys: (a) => [`search:${String(a.query ?? '')}`],

  async fn(args, ctx) {
    const query = String(args.query ?? '').trim()
    if (!query) return { status: 'failure', message: '缺少 query' }
    // 无法解析为整数时终止：`Math.min(20, NaN)` 是 NaN，`slice(0, NaN)` 是空数组，
    // 继续执行会得到一次「搜索成功，0 条结果」。
    const rawLimit = intArg(args.limit, 8)
    if (rawLimit === null) {
      return {
        status: 'failure',
        message: badIntMessage('limit', args.limit),
        errorKind: 'invalid_args',
      }
    }
    const limit = Math.min(20, Math.max(1, rawLimit))

    const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    let res: Awaited<ReturnType<typeof safeFetch>>
    try {
      res = await safeFetch(endpoint, {
        ...policyOf(ctx),
        signal: ctx.signal,
        maxBytes: 2 * 1024 * 1024,
      })
    } catch (err) {
      return {
        status: 'failure',
        message: `搜索请求失败：${err instanceof Error ? err.message : String(err)}`,
        errorKind: 'network_error',
      }
    }
    if (res.blocked || !res.ok) {
      return {
        status: 'failure',
        message: res.blocked?.message ?? `搜索服务返回 HTTP ${res.status}`,
        errorKind: res.blocked ? 'blocked_by_policy' : 'http_error',
      }
    }

    const html = new TextDecoder('utf-8').decode(res.body)
    const results = parseDuckDuckGo(html, limit)

    if (results.length === 0) {
      // 区分「搜索引擎改版导致无法解析」与「确实没有结果」：
      // 页面中有结果容器却一条也未解析出 = 前者。
      const looksLikeResults = html.includes('result__a') || html.includes('result__url')
      return {
        status: looksLikeResults ? 'failure' : 'success',
        message: looksLikeResults
          ? '搜索结果解析失败（搜索引擎页面结构可能已变），请改用 web_fetch 直接访问已知地址'
          : `未找到「${query}」的结果`,
        ...(looksLikeResults ? { errorKind: 'parse_failed' } : {}),
        data: { results: [], query },
      }
    }

    return {
      status: 'success',
      message: `找到 ${results.length} 条：\n${results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join('\n')}`,
      data: { results, query },
    }
  },
}

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

/**
 * 解析 DuckDuckGo 的 HTML 结果页。
 *
 * 它的链接包了一层跳转（`/l/?uddg=<编码后的真实地址>`），必须解码：
 * 把跳转链接交给模型，它下一步 web_fetch 获取的会是跳转页而不是目标页。
 */
export function parseDuckDuckGo(html: string, limit: number): SearchHit[] {
  const out: SearchHit[] = []
  const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi

  for (;;) {
    if (out.length >= limit) break
    const m = blockRe.exec(html)
    if (!m) break
    const href = decodeRedirect(m[1]!)
    const title = htmlToText(m[2]!).replace(/\s+/g, ' ').trim()
    if (!href || !title) continue

    // 摘要位于结果块之后，尽量提取，提取不到不算失败。
    const tail = html.slice(m.index, m.index + 2000)
    const snipMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(tail)
    const snippet = snipMatch ? htmlToText(snipMatch[1]!).replace(/\s+/g, ' ').trim() : ''

    out.push({ title, url: href, snippet: snippet.slice(0, 300) })
  }
  return out
}

function decodeRedirect(href: string): string {
  const decoded = href.replace(/&amp;/g, '&')
  const m = /[?&]uddg=([^&]+)/.exec(decoded)
  if (m) {
    try {
      return decodeURIComponent(m[1]!)
    } catch {
      return ''
    }
  }
  if (decoded.startsWith('//')) return `https:${decoded}`
  return decoded.startsWith('http') ? decoded : ''
}
