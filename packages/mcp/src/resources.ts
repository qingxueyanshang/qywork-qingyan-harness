/**
 * MCP `resources/*`：提供两个工具，不向上下文预先注入任何 resource 内容。
 *
 * 不采用「把 resource 注入上下文」的原因：MCP 规范把 resource 定位为「由应用决定用法的上下文数据」，
 * 常见做法是由用户选择一个 resource 附加到对话中。本仓库没有该交互入口：`qy exec` 执行时没有用户在场。
 *
 * 其余两种做法：
 *
 * 1. 全量注入：启动会话时把每个 server 的 resource 列表连同正文写入前缀。
 *    暴露整个知识库的 server 可以立即占满整个窗口，且内容会进入冻结前缀，
 *    每一轮都要为一份可能从未使用的数据付费。此外前缀一旦变化，缓存全部失效，
 *    而 resource 列表由 server 决定，随时可能变化。
 * 2. 按需读取：为模型提供两个工具，由模型决定读取哪些内容。
 *
 * 采用第 2 种。代价是模型多一次工具调用，收益是上下文占用与 resource 数量无关。
 *
 * 三条约束：
 * 1. 不能命名为 `read_resource`。该名称已被内置工具占用，且语义相反：
 *    内置工具读取的是本地写入磁盘的中间产物（命令输出、大文件的截断部分），
 *    此处读取的是外部 server 提供的数据。重名会在注册时直接抛出异常；
 *    若未抛出，模型会混淆两者。
 * 2. 工具名必须带 `mcp__` 前缀，与内置工具、插件工具的命名空间隔离，模型也能从名称看出
 *    调用的是哪个 server。正文超出本轮剩余额度时由 `boundExecutedOutcome`（`@qywork/agent`）
 *    存入正文库、只投递头部，模型按回执中的 resource id 续读。
 * 3. 权限声明为 `read`，scope 为 `mcp:<server>/resource`，而不是 `execute`：
 *    列出清单与读取正文都不产生副作用，按 execute 处理会使它们与真正的工具调用
 *    经过同一条裁决路径，多出一层。
 */

import { boundExecutedOutcome, type ToolSpec } from '@qywork/agent'
import type { McpClient } from './client.ts'
import { permissionLabel, toolName } from './register.ts'

/** 单次列出的条目上限。列表本身会进入上下文，必须有上限。 */
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
 * 只在 server 声明了 `capabilities.resources` 时注册。未声明即注册时，
 * 模型看到工具并调用，只会得到 `Method not found`，这是一次无效的往返，
 * 且模型会重试，因为它无法从错误中判断该 server 不具备此能力。
 */
export function resourceToolsFor(client: McpClient): ToolSpec[] {
  if (client.capabilities.resources === undefined) return []
  const server = client.name
  // 权限 scope 的载体（scope = `<effect>:<target>`），也是卡片上的目标。
  // 对象层填写的是「MCP」，见下方两处 `objectLabel`。
  const target = permissionLabel(server, 'resource')

  return [
    {
      // 名称中的 `mcp__` 不只是命名风格，还是 sink 写入磁盘的判据，见文件头第 2 条。
      name: toolName(server, 'list_resources'),
      description:
        `[MCP ${server}] 列出该 server 提供的 resource（uri、名称、类型），` +
        `不返回正文。取得 uri 后用 mcp__${server}__fetch_resource 读取正文。`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      // 动作是 call：正文位于外部 server，此步骤是一次跨进程调用。
      // 权限维度另行确定，为 read：两个维度正交，见文件头第 3 条。
      actionKind: 'call',
      objectLabel: 'MCP',
      // MCP 的工具一律归入「MCP」：类目由第三方决定，混入内置分类会使
      // 「文件与草稿」一栏出现外部来源的工具。
      category: 'mcp',
      facet: `MCP ${server}`,
      summary: `列出 ${server} 提供的 resource`,
      targetExtractor: () => target,
      permissionEffect: 'read',
      // 纯只读、无状态，可与其他读操作同批执行。
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
          // 截断必须说明。不说明时模型会把清单视为全量，
          // 并基于不完整的清单得出结论。
          if (list.length > shown.length) {
            lines.push(`…（共 ${list.length} 条，只列出前 ${shown.length} 条）`)
          }
          return boundExecutedOutcome(
            ctx,
            { status: 'success', message: lines.join('\n') },
            { toolName: toolName(server, 'list_resources'), sourceType: 'mcp:resources' },
          )
        } catch (err) {
          return fail(server, 'resources/list', err)
        }
      },
    },
    {
      name: toolName(server, 'fetch_resource'),
      description:
        `[MCP ${server}] 按 uri 读取一个 resource 的正文。` +
        `uri 从 mcp__${server}__list_resources 取得。` +
        `注意与内置的 read_resource 不同：后者读取的是本地保存的中间产物。`,
      parameters: {
        type: 'object',
        properties: { uri: { type: 'string', description: 'resource 的 uri' } },
        required: ['uri'],
        additionalProperties: false,
      },
      actionKind: 'call',
      objectLabel: 'MCP',
      category: 'mcp',
      facet: `MCP ${server}`,
      summary: `读取 ${server} 的一个 resource 正文`,
      targetExtractor: (a) => (typeof a.uri === 'string' ? a.uri : target),
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
          // 超出本轮剩余额度时正文完整存入正文库、只投递头部，不在此处按字符截断丢弃尾部。
          return boundExecutedOutcome(
            ctx,
            { status: 'success', message: renderResourceContents(contents) },
            { toolName: toolName(server, 'fetch_resource'), sourceType: 'mcp:resource' },
          )
        } catch (err) {
          return fail(server, `resources/read ${uri}`, err)
        }
      },
    },
  ]
}

/**
 * 二进制 resource 只保留一行占位。
 *
 * 把 base64 写入 transcript 会立即占用数万 token，而模型通常用不上；
 * 理由与 `renderContent` 对 image/audio 的处理相同。
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
    // 读取失败也视为已执行：server 一侧执行了什么，本地无法判断。
    executed: true,
    message: `MCP ${what} 失败（${server}）：${err instanceof Error ? err.message : String(err)}`,
    errorKind: 'mcp_transport_error',
  }
}

/** 理由与 `register.ts` 的 `callWithAbort` 相同：用户点击停止后必须立即停止等待。 */
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
