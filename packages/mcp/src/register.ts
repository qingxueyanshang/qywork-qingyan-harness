/**
 * 将 MCP server 的工具接入工具注册表。
 *
 * 权限：server 提供的 hint 一律不用于放宽权限。MCP 的工具定义中有 `annotations.readOnlyHint` 等
 * 提示，表面上可用于决定是否弹出授权，但不能这样使用。这些字段由 server 自行填写，而 server
 * 是第三方代码：恶意或编写有误的 server 声明 `readOnlyHint: true` 的工具仍然可以删除数据库。
 * 规范本身也写明客户端不得据此做安全决策。
 *
 * 因此此处的规则是单向的：
 *
 * - hint 可以使权限更严格（`destructiveHint` → 按 delete 进行权限检查）；
 * - hint 永远不能使权限更宽松。默认全部按 `execute` 处理，交给裁决层。
 *
 * 放宽只能来自用户的决定（`mode: "full"`，或今后分类器规则中的
 * allow 条目），不能来自 server 的自我声明。这一区别即 MCP
 * 权限模型的全部内容。
 *
 * 命名：注册名是 `mcp__<server>__<tool>`，与插件的 `<id>__<tool>` 采用同一种隔离方式：
 * 两个 server 各带一个 `search` 不会互相覆盖，模型也能从名称看出调用的是哪个 server。
 */

import { boundExecutedOutcome, sanitizeToolName, type ToolSpec } from '@qywork/agent'
import type { McpCallResult, McpClient, McpToolDef } from './client.ts'

/**
 * 注册名。必须经过清洗：server 名来自用户配置、工具名来自第三方 server，
 * 两者都可能含 `.` `:` `/`，而 provider 只接受 `^[a-zA-Z0-9_-]+$`。
 * 不转换时，配置一个名为 `my.server` 的 MCP 后，每一轮 run 都会被 400 拒绝。
 */
export function toolName(server: string, tool: string): string {
  return sanitizeToolName(`mcp__${server}__${tool}`)
}

/**
 * 某个 server 的工具名前缀。
 *
 * 必须使用该函数，不要自行拼接 `mcp__${name}__`。注册名经过清洗，
 * 名为 `my.server` 的 server 注册后为 `mcp__my_server__foo`，
 * 用未清洗的名称拼接前缀将无法匹配任何工具：`load.ts` 的「产出为零」判定与三个
 * CLI 的工具计数都会归零，表现为已安装却报告 0 个工具或注册失败。
 */
export function toolNamePrefix(server: string): string {
  return sanitizeToolName(`mcp__${server}__`)
}

/** 权限 scope 中使用的目标字符串。裁决层据此识别对应的 server 与工具。 */
export function permissionLabel(server: string, tool: string): string {
  return `mcp:${server}/${tool}`
}

export function specFor(client: McpClient, def: McpToolDef): ToolSpec {
  const server = client.name
  const destructive = def.annotations?.destructiveHint === true

  return {
    name: toolName(server, def.name),
    description: `[MCP ${server}] ${def.description ?? def.name}`,
    // inputSchema 原样交给模型，不做修正：修改第三方 schema 后，
    // 模型按修改后的结构传参，server 按其自身的结构校验，两侧不一致。
    parameters: normalizeSchema(def.inputSchema),
    // 理由相同：适配器不得将其重排为 strict 结构。
    strict: false,

    // 恒为 call。MCP 工具是外部 server 提供的能力，不是本机执行的动作；
    // 该维度表达执行了什么动作，与下方的权限维度相互独立，不互相推导。
    actionKind: 'call',
    // 对象名是「MCP」这一类别，而不是具体工具：卡片由动词、对象、目标三层组成，
    // 对象与目标填同一字符串会使目标层失去作用（标题与目标完全相同）。
    objectLabel: 'MCP',
    // 一律归入「MCP」：该类别的作用是不与内置分类混排；
    // 第三方 server 提供什么、属于哪个领域，本地无法判断，推测一个类别填入更糟。
    category: 'mcp',
    facet: `MCP ${server}`,
    summary: def.description?.trim() || def.name,
    // target 同时承载权限 scope（scope = `<effect>:<target>`）。
    // 不要为了卡片显示而去掉 `mcp:` 前缀：去掉后，名为 `github` 的插件的
    // `search` 与该 server 的 `search` 会产生同一个 scope 字符串。
    targetExtractor: () => permissionLabel(server, def.name),

    // 权限效果直接声明：采纳 destructive 的 hint（更严格，按 delete 检查），
    // 不采纳 readOnlyHint（会更宽松）。默认 execute，交给裁决层。
    permissionEffect: destructive ? 'delete' : 'execute',

    // 不并行。MCP server 是外部进程，其并发处理方式无法预知，
    // 而并行带来的收益远小于并发调用冲突的排查成本。
    parallelSafe: false,

    async fn(args, ctx) {
      try {
        const res = await callWithAbort(client, def.name, args, ctx.signal)
        const images = imagesOf(res)
        const text = renderContent(res)

        const data = {
          ...(res.structuredContent !== undefined
            ? { structuredContent: res.structuredContent }
            : {}),
          // 图片的 base64 直接进入工具结果的图像块，不写入磁盘：工具结果本身即可携带
          // 字节（`agent` 的 `toolResultContent`），中间再写入一次磁盘只会多一个存储位置。
          ...(images.length ? { images } : {}),
        }

        // 正文与 structuredContent 一并按本轮剩余额度确定：超出额度时完整存入正文库、回执保留地址，
        // 不在此处按字符截断丢弃尾部。
        return boundExecutedOutcome(
          ctx,
          {
            // isError 表示工具执行失败，不是协议错误。此处原样传递，
            // 模型看到失败详情才能修改参数重试。
            status: res.isError ? 'failure' : 'success',
            executed: true,
            message: text || (res.isError ? 'MCP 工具报告失败但没有给出内容' : '完成'),
            ...(Object.keys(data).length ? { data } : {}),
            ...(res.isError ? { errorKind: 'mcp_tool_error' } : {}),
          },
          { toolName: toolName(server, def.name), sourceType: 'mcp' },
        )
      } catch (err) {
        return {
          status: 'failure',
          // 协议层失败（超时、进程退出）无法判定副作用是否发生。
          // 保守取 true：崩溃恢复与重试都依赖该字段，判定必须偏保守。
          executed: true,
          message: `MCP 调用失败（${server}/${def.name}）：${err instanceof Error ? err.message : String(err)}`,
          errorKind: 'mcp_transport_error',
        }
      }
    },
  }
}

/**
 * 中断必须能立即结束等待。
 *
 * `callTool` 只会等待自身的超时；用户点击停止后仍要再等待一分钟，
 * 表现为点击停止后界面无变化。此处使 abort 立即拒绝该 promise。
 * 注意 server 一侧的调用并未被取消：MCP 有 `notifications/cancelled`，
 * 但并非所有 server 都实现，因此此处只保证客户端不再等待，不声称远端已停止。
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
 * 单张图片的上限。超过时不携带，只在正文中保留占位行。
 *
 * 与 `tools/files.ts` 的图片上限取同一个值：同一张图片经由 `read_file` 或 MCP
 * 读取，不应得到两种结果。
 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * MCP 结果中的图片，交给工具结果的图像块。
 *
 * 取全部图片，而不是只取第一张：一次调用返回多张图片是 MCP 的常规用法（一组截图、一份图表
 * 的多个视图），只取第一张会静默丢弃其余图片。
 */
function imagesOf(res: McpCallResult): { data: string; mime: string }[] {
  const out: { data: string; mime: string }[] = []
  for (const block of res.content) {
    if (block.type !== 'image' || typeof block.data !== 'string' || !block.data) continue
    // base64 每 4 个字符对应 3 字节，足以判断上限，无需先解码。
    if ((block.data.length * 3) / 4 > MAX_IMAGE_BYTES) continue
    out.push({ data: block.data, mime: block.mimeType ?? 'image/png' })
  }
  return out
}

/**
 * 将 MCP 的内容块渲染为一段文本。
 *
 * 图片行是占位而不是丢弃：实际字节经 `imagesOf` 进入图像块，此处保留一行，使
 * 模型知道正文的该位置是一张图片。音频没有对应的内容块，只保留占位。
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
      // 未知块类型不能丢弃：MCP 今后增加新类型时，丢弃会使模型收到
      // 静默缺少一段的结果，比看到一行占位更难排查。
      parts.push(`[${block.type}]`)
    }
  }
  return parts.join('\n').trim()
}

function sizeOf(data: unknown): string {
  if (typeof data !== 'string') return '大小未知'
  // base64 每 4 个字符对应 3 字节。
  return `约 ${Math.round((data.length * 3) / 4 / 1024)} KB`
}

/**
 * 规范化为一个合法的 JSON Schema 对象。
 *
 * 部分 server 给出的 inputSchema 缺少 `type`，或整体为 null。直接交给 provider 会被
 * 400 拒绝，而错误信息只说明「tools[3].parameters 无效」，需要逐个检查才能找到对应的
 * server 与工具。
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
