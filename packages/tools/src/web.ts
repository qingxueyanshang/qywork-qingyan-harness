/**
 * 联网工具。
 *
 * 两条与本地工具不同的约束：
 *
 * 1. **必须过 SSRF 闸**（`net-safety.ts`）。URL 来自模型，模型的 URL 来自它读到的
 *    网页内容——不挡内网就是把 SSRF 递给了模型。
 * 2. **产出进 sink**。网页正文是典型的「不可重放」内容：同一个 URL 明天抓到的
 *    不是同一份字节。截断丢掉的部分再也拿不回来，所以必须先落盘。
 */

import { chargeBatchBudget, type ToolContext, type ToolSpec } from '@qywork/agent'
import { estimateText } from '@qywork/ai'
import type { IntermediateResourceRef } from '@qywork/core'
import { type SafetyOptions, safeFetch } from './net-safety.ts'
import { deliver } from './sink.ts'

/** 用户配置注入 ctx.resources 的键。没配就用默认（最严格）策略。 */
export const NET_POLICY_KEY = 'qywork.netPolicy'

function policyOf(ctx: ToolContext): SafetyOptions {
  const raw = ctx.resources.get(NET_POLICY_KEY)
  return (raw as SafetyOptions | undefined) ?? {}
}

export const webFetchTool: ToolSpec = {
  name: 'web_fetch',
  description:
    '抓取一个网页并返回正文（HTML 会转成纯文本）。用于读文档、看 issue、查 API 说明。' +
    '只允许 http/https 且不能指向内网地址。超长正文会自动落盘，用 read_resource 取回全文。',
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
  summary: '取一个网页并转成正文',
  targetExtractor: (a) => (typeof a.url === 'string' ? a.url : null),
  // 出网是有副作用的：会把 URL（可能含敏感路径）暴露给第三方，也可能触发对方的写操作。
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
      // 被安全策略挡住时**说清是哪条规则**：模型据此判断该换个 URL 还是放弃，
      // 只说「失败了」它会原地重试同一个地址。
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
    })
    // 摘录也记进本批预算：`deliver` 已经把它压到 8 KB 以内，
    // 但一波五次外取加起来仍然是一笔——批级上界要看得见全部来源。
    chargeBatchBudget(ctx, estimateText(landed.text))

    const resources: IntermediateResourceRef[] = landed.resourceId
      ? [
          {
            resourceId: landed.resourceId as never,
            status: landed.status,
            contentHash: null,
            sizeBytes: landed.coverage.totalBytes ?? 0,
            mimeType: contentType || null,
            coverage: landed.coverage,
          },
        ]
      : []

    return {
      status: 'success',
      // 重定向链要告诉模型：最终 URL 可能与它要的不是一回事，
      // 而它接下来可能会基于这个 URL 拼相对路径。
      message: res.redirects.length
        ? `已抓取（经 ${res.redirects.length} 次重定向，最终 ${res.url}）`
        : '已抓取',
      data: {
        url: res.url,
        finalUrl: res.url,
        contentType,
        content: landed.text,
        ...(landed.coverage.truncated ? { coverage: landed.coverage } : {}),
        ...(res.redirects.length ? { redirects: res.redirects } : {}),
      },
      ...(resources.length ? { resources } : {}),
    }
  },
}

/**
 * HTML 转纯文本。
 *
 * 刻意不引 DOM 解析库：agent 要的是可读正文，不是精确的文档结构。
 * 引一个 200 kB 的解析器换取「列表缩进更准」不划算。
 *
 * 顺序很重要：先剥 script/style（它们的内容不是正文，混进去全是噪音），
 * 再把块级标签换成换行（否则整页会挤成一行），最后才剥剩下的标签。
 */
export function htmlToText(html: string): string {
  return (
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, '')
      // 开闭标签都换成换行：只换闭标签的话相邻段落之间只有一个换行，
      // 段落感丢失（正文会读起来像一整段）。多出来的空行后面会被压掉。
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
      // &amp; 必须**最后**替换，否则 &amp;lt; 会被两步还原成 <，
      // 把页面里本来要显示的实体文本变成标签。
      .replace(/&amp;/g, '&')
      // 三个以上换行压成两个：保留段落感，去掉大片空白。
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/**
 * 网页搜索。
 *
 * 用 DuckDuckGo 的 HTML 端点：不需要 API Key，也就不需要用户先去申请一个才能用。
 * 代价是解析的是 HTML 而不是结构化响应，站点改版会失效——所以解析失败时
 * **明确说是解析失败**，而不是返回空结果让模型以为「没搜到」。
 */
export const webSearchTool: ToolSpec = {
  name: 'web_search',
  description:
    '搜索网页，返回标题、链接与摘要。用于找文档、找报错的解决方案、查库的用法。' +
    '拿到链接后用 web_fetch 读全文。',
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
  summary: '按关键词搜网页',
  targetExtractor: (a) => (typeof a.query === 'string' ? a.query : null),
  permissionEffect: 'network',
  parallelSafe: true,
  resourceKeys: (a) => [`search:${String(a.query ?? '')}`],

  async fn(args, ctx) {
    const query = String(args.query ?? '').trim()
    if (!query) return { status: 'failure', message: '缺少 query' }
    const limit = Math.min(20, Math.max(1, Number(args.limit ?? 8)))

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
      // 区分「搜索引擎改版了解析不出来」和「确实没结果」：
      // 页面里有结果容器但一条都没解析出来 = 前者。
      const looksLikeResults = html.includes('result__a') || html.includes('result__url')
      return {
        status: looksLikeResults ? 'failure' : 'success',
        message: looksLikeResults
          ? '搜索结果解析失败（搜索引擎页面结构可能已变），请改用 web_fetch 直接访问已知地址'
          : `没有找到「${query}」的结果`,
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
 * 它的链接是包了一层跳转的（`/l/?uddg=<编码后的真实地址>`），必须解出来——
 * 把跳转链接交给模型，它下一步 web_fetch 会抓到跳转页而不是目标页。
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

    // 摘要在结果块之后，尽力取，取不到不算失败。
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
