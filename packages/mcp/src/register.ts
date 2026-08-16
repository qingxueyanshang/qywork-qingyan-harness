/**
 * 把 MCP server 的工具接进工具注册表。
 *
 * ## 权限：server 给的 hint 一律不用来放宽
 *
 * MCP 的工具定义里有 `annotations.readOnlyHint` 之类的提示，看起来正好能拿来
 * 决定要不要弹授权。**不能这么用。** 那些字段是 server 自己填的，
 * 而 server 是第三方代码——一个恶意（或只是写错了）的 server 声明
 * `readOnlyHint: true` 的工具照样可以删库。规范自己也写明客户端不得据此做安全决策。
 *
 * 所以这里的规则是单向的：
 *
 * - hint 可以让权限**更严**（`destructiveHint` → 走 delete 闸）；
 * - hint **永远不能**让权限更松。默认全部按 `execute` 处理，交给裁决层。
 *
 * 放宽只能来自**用户的**决定（`mode: "full"`，或将来分类器规则里的
 * allow 条目），不能来自 server 的自我声明。这条区别就是整个 MCP
 * 权限模型的全部内容。
 *
 * ## 命名
 *
 * 注册名是 `mcp__<server>__<tool>`，与插件的 `<id>__<tool>` 同一套隔离思路：
 * 两个 server 各带一个 `search` 不会互相覆盖，模型也能从名字看出它在调谁。
 */

import { sanitizeToolName, type ToolSpec } from '@qywork/agent'
import type { McpCallResult, McpClient, McpToolDef } from './client.ts'

/** 单次工具结果的文本上限。MCP 结果不过 sink，超了只能截断，所以要说出来。 */
const MAX_RESULT_CHARS = 60_000

/**
 * 注册名。**必须消毒**：server 名来自用户配置、工具名来自第三方 server，
 * 两者都可能带 `.` `:` `/`，而 provider 只接受 `^[a-zA-Z0-9_-]+$`。
 * 不转的话配一个叫 `my.server` 的 MCP，之后每一轮 run 都被 400 打死。
 */
export function toolName(server: string, tool: string): string {
  return sanitizeToolName(`mcp__${server}__${tool}`)
}

/**
 * 「这个 server 的工具」的名字前缀。
 *
 * **必须走这里，不要自己拼 `mcp__${name}__`。** 注册名是消毒过的，
 * 一个叫 `my.server` 的 server 注册出来是 `mcp__my_server__foo`，
 * 拿未消毒的名字拼前缀一条都匹配不上——`load.ts` 的「产出为零」判定和三个
 * CLI 的工具计数都栽在这上面，表现是「装好了却报 0 个工具 / 报注册失败」。
 */
export function toolNamePrefix(server: string): string {
  return sanitizeToolName(`mcp__${server}__`)
}

/** 权限 scope 里用的目标串。裁决层按它识别「这是哪个 server 的哪个工具」。 */
export function permissionLabel(server: string, tool: string): string {
  return `mcp:${server}/${tool}`
}

export function specFor(client: McpClient, def: McpToolDef): ToolSpec {
  const server = client.name
  const destructive = def.annotations?.destructiveHint === true

  return {
    name: toolName(server, def.name),
    description: `[MCP ${server}] ${def.description ?? def.name}`,
    // inputSchema 原样交给模型。不做「修正」——改动一个第三方 schema 的结果是
    // 模型按我们改过的形状传参，server 按它自己的形状校验，两边对不上。
    parameters: normalizeSchema(def.inputSchema),

    // 恒为 call。MCP 工具是外部 server 提供的能力，不是我们在本机执行的东西——
    // 这条轴说的是「做了什么动作」，与下面的权限轴各管各的，不互相推导。
    actionKind: 'call',
    // 对象名是「MCP」这一类，不是具体哪个工具——卡片是「动词 + 对象 + 目标」三层，
    // 对象与目标填同一个串等于把目标那一层浪费掉（标题与目标一字不差）。
    objectLabel: 'MCP',
    // 一律归「外部扩展」：这一类的存在理由就是不与内置分类学混排——
    // 第三方 server 提供什么、算哪个领域，我们并不知道，猜一个填进去更糟。
    category: 'external',
    facet: `MCP ${server}`,
    summary: def.description?.trim() || def.name,
    // target 同时是权限 scope 的载体（scope = `<effect>:<target>`）。
    // **不要为了卡片好看去掉 `mcp:` 前缀**：去掉之后一个叫 `github` 的插件的
    // `search` 与这个 server 的 `search` 会产生同一个 scope 串。
    targetExtractor: () => permissionLabel(server, def.name),

    // 权限效果**直接声明**：destructive 的 hint 采纳（更严，走 delete 闸），
    // readOnlyHint **不采纳**（那会更松）。默认 execute，交给裁决层。
    permissionEffect: destructive ? 'delete' : 'execute',

    // 不并行。MCP server 是外部进程，它对并发的处理我们一无所知，
    // 而并行带来的收益远小于「两个调用互相踩」的排查成本。
    parallelSafe: false,

    async fn(args, ctx) {
      try {
        const res = await callWithAbort(client, def.name, args, ctx.signal)
        const text = renderContent(res)
        const clamped =
          text.length > MAX_RESULT_CHARS
            ? `${text.slice(0, MAX_RESULT_CHARS)}\n…（结果超过 ${MAX_RESULT_CHARS} 字符，已截断）`
            : text

        return {
          // isError 是「工具执行失败」，不是协议错误。原样传下去，
          // 模型看得见失败详情才能自己改参数重试。
          status: res.isError ? 'failure' : 'success',
          executed: true,
          message: clamped || (res.isError ? 'MCP 工具报告失败但没有给出内容' : '完成'),
          ...(res.structuredContent !== undefined
            ? { data: { structuredContent: res.structuredContent } }
            : {}),
          ...(res.isError ? { errorKind: 'mcp_tool_error' } : {}),
        }
      } catch (err) {
        return {
          status: 'failure',
          // 协议层失败（超时、进程退出）**无法判定副作用是否发生**。
          // 保守取 true——崩溃恢复和重试都靠这个字段，报错方向必须偏保守。
          executed: true,
          message: `MCP 调用失败（${server}/${def.name}）：${err instanceof Error ? err.message : String(err)}`,
          errorKind: 'mcp_transport_error',
        }
      }
    },
  }
}

/**
 * 中断要能真的打断等待。
 *
 * `callTool` 只会等到自己的超时；用户点了停止之后还要再干等一分钟，
 * 表现就是「点了没反应」。这里让 abort 立刻把 promise 拒掉。
 * 注意 server 那边的调用**并没有被取消**——MCP 有 `notifications/cancelled`，
 * 但不是所有 server 都实现，所以这里只保证客户端不再等，不宣称远端停了。
 */
function callWithAbort(
  client: McpClient,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<McpCallResult> {
  const call = client.callTool(tool, args)
  if (!signal) return call
  return Promise.race([
    call,
    new Promise<never>((_, reject) => {
      if (signal.aborted) return reject(new Error('已取消'))
      signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true })
    }),
  ])
}

/**
 * 把 MCP 的内容块渲染成一段文本。
 *
 * 图片/音频只留一行占位：把 base64 塞进 transcript 会瞬间吃掉几万 token，
 * 而模型多半也用不上——需要看图的场景应该走 resource 引用，不是内联字节。
 */
export function renderContent(res: McpCallResult): string {
  const parts: string[] = []
  for (const block of res.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'image' || block.type === 'audio') {
      parts.push(`[${block.type}：${block.mimeType ?? '未知类型'}，${sizeOf(block.data)}]`)
    } else if (block.type === 'resource') {
      const r = block.resource as { uri?: string; text?: string } | undefined
      parts.push(r?.text ?? `[resource：${r?.uri ?? '未知'}]`)
    } else if (block.type === 'resource_link') {
      parts.push(`[resource_link：${String(block.uri ?? '未知')}]`)
    } else {
      // 未知块类型不能丢——将来 MCP 加了新类型，丢掉会让模型收到一份
      // 悄悄少了一段的结果，那比看到一行占位难查得多。
      parts.push(`[${block.type}]`)
    }
  }
  return parts.join('\n').trim()
}

function sizeOf(data: unknown): string {
  if (typeof data !== 'string') return '大小未知'
  // base64 每 4 字符 3 字节。
  return `约 ${Math.round((data.length * 3) / 4 / 1024)} KB`
}

/**
 * 兜底成一个合法的 JSON Schema 对象。
 *
 * 有的 server 给的 inputSchema 缺 `type` 或干脆是 null。直接交给 provider 会被
 * 400 拒掉，而错误信息里只说「tools[3].parameters 无效」——查是哪个 server 的
 * 哪个工具要翻半天。
 */
function normalizeSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null) {
    return { type: 'object', properties: {} }
  }
  const s = { ...(schema as Record<string, unknown>) }
  if (s.type !== 'object') s.type = 'object'
  if (typeof s.properties !== 'object' || s.properties === null) s.properties = {}
  return s
}
