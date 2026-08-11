/**
 * MCP `resources/*`：两个工具，**一个字节都不进上下文**。
 *
 * ## 为什么不是「把 resource 注入上下文」
 *
 * MCP 规范把 resource 定位成「由应用决定怎么用的上下文数据」，而参考实现
 * （Claude Desktop 等）的做法是让**用户**挑一个 resource 附进对话。
 * 我们没有那个交互位——`qy exec` 根本没有人在场。
 *
 * 剩下两条路：
 *
 * 1. **全量注入**：起会话时把每个 server 的 resource 列表连同正文塞进前缀。
 *    一个暴露整个知识库的 server 能瞬间吃掉整个窗口，而且**它会进冻结前缀**，
 *    于是每一轮都在为一份可能一次都用不上的数据付钱。更糟的是前缀一变
 *    缓存全失效——resource 列表是 server 说了算的，它随时会变。
 * 2. **按需读**：给模型两个工具，让它自己决定看什么。
 *
 * 选 2。代价是模型要多一次工具调用，收益是**上下文占用与 resource 数量无关**。
 *
 * ## 三个已经踩过的坑
 *
 * 1. **不能叫 `read_resource`。** 那个名字已经被内置工具占了，而且语义相反：
 *    内置的读的是**我们自己落盘的中间产物**（命令输出、大文件的截断部分），
 *    这里读的是**外部 server 提供的数据**。重名会在注册期直接抛，
 *    但更糟的是万一没抛——模型会把两者混为一谈。
 * 2. **工具名必须带 `mcp__` 前缀。** `sink.ts` 的 `isContentAuthority` 按这个
 *    前缀判断「这个工具的结果是否可以落盘再按 id 读回」。少了前缀，
 *    一份超预算的 resource 正文会被直接截断丢掉，而且**不留 resource id**——
 *    模型连「还有没看到的部分」都不知道。
 * 3. **权限声明是 `read`，scope 用 `mcp:<server>/resource`。** 不是 `execute`：
 *    列清单和读正文都不产生副作用，按 execute 处理会让它们跟真正的工具调用
 *    走同一条裁决路径，白白多一层。
 */

import type { ToolSpec } from '@qywork/agent'
import type { McpClient } from './client.ts'
import { permissionLabel } from './register.ts'

/** 单次读回的文本上限。超出的部分交给 sink 落盘，模型可以再读回来。 */
const MAX_RESOURCE_CHARS = 60_000
/** 一次列出的条目上限。列表本身是要进上下文的，不能没有边界。 */
const MAX_LIST_ENTRIES = 200

export interface McpResourceDef {
  uri: string
  name?: string
  title?: string
  description?: string
  mimeType?: string
}

export interface McpResourceContents {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

/**
 * 两个 resource 工具。
 *
 * **只在 server 声明了 `capabilities.resources` 时才注册。** 不声明就注册的话，
 * 模型看到工具、调用、拿到一条 `Method not found`——那是一次纯浪费的往返，
 * 而且它会重试，因为它没法从错误里看出「这个 server 根本没有这个能力」。
 */
export function resourceToolsFor(client: McpClient): ToolSpec[] {
  if (client.capabilities.resources === undefined) return []
  const server = client.name
  const label = permissionLabel(server, 'resource')

  return [
    {
      // 名字里的 `mcp__` 不只是命名风格，是 sink 的落盘判据，见文件头第 2 条。
      name: sanitize(`mcp__${server}__list_resources`),
      description:
        `[MCP ${server}] 列出该 server 提供的 resource（uri、名称、类型），` +
        `不返回正文。拿到 uri 之后用 mcp__${server}__fetch_resource 读正文。`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'read',
      objectLabel: label,
      targetExtractor: () => label,
      permissionEffect: 'read',
      // 纯只读、无状态，可以与别的读操作同波次。
      parallelSafe: true,
      async fn(_args, ctx) {
        try {
          const list = await withAbort(client.listResources(), ctx.signal)
          if (list.length === 0) {
            return { status: 'success', message: `${server} 没有提供任何 resource` }
          }
          const shown = list.slice(0, MAX_LIST_ENTRIES)
          const lines = shown.map((r) => {
            const title = r.title ?? r.name ?? ''
            const type = r.mimeType ? `（${r.mimeType}）` : ''
            const desc = r.description ? ` — ${r.description}` : ''
            return `${r.uri}${type}${title ? ` ${title}` : ''}${desc}`
          })
          // 截断必须说出来。不说的话模型会以为自己看到了全部，
          // 然后基于一份不完整的清单下结论。
          if (list.length > shown.length) {
            lines.push(`…（共 ${list.length} 条，只列出前 ${shown.length} 条）`)
          }
          return { status: 'success', message: lines.join('\n') }
        } catch (err) {
          return fail(server, 'resources/list', err)
        }
      },
    },
    {
      name: sanitize(`mcp__${server}__fetch_resource`),
      description:
        `[MCP ${server}] 按 uri 读取一个 resource 的正文。` +
        `uri 从 mcp__${server}__list_resources 拿。` +
        `注意与内置的 read_resource 不是一回事——那个读的是本地落盘的中间产物。`,
      parameters: {
        type: 'object',
        properties: { uri: { type: 'string', description: 'resource 的 uri' } },
        required: ['uri'],
        additionalProperties: false,
      },
      actionKind: 'read',
      objectLabel: label,
      targetExtractor: (a) => (typeof a.uri === 'string' ? a.uri : label),
      permissionEffect: 'read',
      parallelSafe: true,
      async fn(args, ctx) {
        const uri = String(args.uri ?? '').trim()
        if (!uri) return { status: 'failure', message: 'uri 为空' }
        try {
          const contents = await withAbort(client.readResource(uri), ctx.signal)
          if (contents.length === 0) {
            return { status: 'failure', message: `${uri} 没有返回任何内容` }
          }
          const text = renderResourceContents(contents)
          const clamped =
            text.length > MAX_RESOURCE_CHARS
              ? `${text.slice(0, MAX_RESOURCE_CHARS)}\n…（正文超过 ${MAX_RESOURCE_CHARS} 字符，已截断）`
              : text
          return { status: 'success', message: clamped }
        } catch (err) {
          return fail(server, `resources/read ${uri}`, err)
        }
      },
    },
  ]
}

/**
 * 二进制 resource 只留一行占位。
 *
 * 把 base64 塞进 transcript 会瞬间吃掉几万 token，而模型多半用不上——
 * 这与 `renderContent` 对 image/audio 的处置是同一条理由。
 */
function renderResourceContents(contents: readonly McpResourceContents[]): string {
  return contents
    .map((c) => {
      if (typeof c.text === 'string') return c.text
      if (typeof c.blob === 'string') {
        const kb = Math.round((c.blob.length * 3) / 4 / 1024)
        return `[二进制 resource：${c.mimeType ?? '未知类型'}，约 ${kb} KB，未内联]`
      }
      return `[空 resource：${c.uri}]`
    })
    .join('\n')
    .trim()
}

function fail(
  server: string,
  what: string,
  err: unknown,
): {
  status: 'failure'
  executed: true
  message: string
  errorKind: string
} {
  return {
    status: 'failure',
    // 读失败也算「执行过」：我们无从判断 server 那边做了什么。
    executed: true,
    message: `MCP ${what} 失败（${server}）：${err instanceof Error ? err.message : String(err)}`,
    errorKind: 'mcp_transport_error',
  }
}

/** 与 `register.ts` 的 `callWithAbort` 同一条理由：用户点停止要立刻不再等。 */
function withAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (!signal) return p
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      if (signal.aborted) return reject(new Error('已取消'))
      signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true })
    }),
  ])
}

/** server 名来自用户配置，可能带 provider 不接受的字符。 */
function sanitize(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}
