/**
 * 按需工具的读取入口 `load_tool`，及外部工具改为按需的分档。
 *
 * 按需工具（`ToolSpec.deferred`）在工具表中只有桩定义：名称、一句用途与任意对象参数。完整的说明与参数定义由 `load_tool`
 * 作为工具结果返回，追加在对话末尾。**不要改为加载时修改工具表**：工具表位于请求最前部（`agent/registry.ts` 文件头），
 * 任何变化都使整个前缀缓存失效，长对话中一次未命中即按全价重读全部上下文。工具表固定，读取不影响缓存命中；
 * 也没有「已加载」的状态需要跨轮保存，上下文压缩折叠了读取结果时，模型再读取一次即可。
 *
 * 外部工具（MCP 与插件）的 `parameters` 由第三方提供，大小不受本仓库控制。实测数据（2026-08-16，四个真实 MCP server，
 * JSON 按 2 字符/token 估算）：
 * ```
 * @modelcontextprotocol/server-filesystem           14 个工具   4225 token
 * @modelcontextprotocol/server-everything           15 个工具   3041 token
 * @modelcontextprotocol/server-memory               11 个工具   2537 token
 * @modelcontextprotocol/server-sequential-thinking   1 个工具   2016 token
 * ```
 * 合计 41 个工具 11819 token，单个工具从 98 到 2016 不等：一个工具的体积可与一整个 server 相当，
 * 因此按总量而不是 server 数量分档，见 `EXTERNAL_SCHEMA_BUDGET_TOKENS`。
 */

import { deferredDefinition, type ToolRegistry, type ToolSpec } from '@qywork/agent'
import { estimateSchemas, type TokenDensity } from '@qywork/ai'

/**
 * 外部工具 schema 的常驻预算。总量不超过它时照常全量注册，超过时全部改为按需。
 *
 * 取 1600：七个普通工具的 schema 约 1600 token（工具定义实测 2.3–2.9 字符/token，Claude 为 1.6）。
 * 语义是「一个小 server 全量常驻，两个 server 或一个大工具改为按需」：低于此线时改为按需节省不足 2000 token，
 * 却需多一次往返，开销高于节省。修改此常数前先按当前估算重新测量这四个 server，不要依据上表推算。
 */
export const EXTERNAL_SCHEMA_BUDGET_TOKENS = 1600

/** 这批工具的 schema 发送时的大小。与请求使用同一估算口径（`estimateSchemas`）。 */
export function externalSchemaTokens(specs: readonly ToolSpec[], density: TokenDensity): number {
  return estimateSchemas(
    specs.map((s) => ({ name: s.name, description: s.description, parameters: s.parameters })),
    density,
  )
}

/**
 * 外部工具一句用途的截断长度。外部工具的说明即第三方提供的原文，可能包含多段。实测（2026-08-16，
 * 四个真实 server 共 41 个工具）：原样拼接为 2620 token，每条取首行截断到 100 字为 1187 token。
 */
const BRIEF_MAX_CHARS = 100

/**
 * 由外部工具得到按需形态。一句用途取说明中第一行有内容的文本：须跳过空行与 markdown 标题行，第三方说明常以空行或
 * `## Overview` 开头，只取第一行时该工具只剩名称，模型无法据此判断是否需要读取它的定义。
 */
export function deferExternal(spec: ToolSpec): ToolSpec {
  const first =
    spec.description
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('#')) ?? spec.name
  const brief = first.length > BRIEF_MAX_CHARS ? `${first.slice(0, BRIEF_MAX_CHARS)}…` : first
  return { ...spec, deferred: { brief } }
}

/** `load_tool`。注册时绑定所在的工具表，读取的是该表中的定义。 */
export function makeLoadToolTool(registry: ToolRegistry): ToolSpec {
  return {
    name: 'load_tool',
    description:
      '读取按需工具的完整说明与参数定义。工具表中说明写有「调用前先用 load_tool 读取完整定义」的工具，' +
      '调用前用本工具读取，之后以原名直接调用，参数按读取到的定义填写。一次可以读取多个。' +
      '读取结果在对话中保留；上下文压缩后不再能看到定义时，再读取一次。',
    parameters: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          description: '要读取的工具名，取自工具表',
          items: { type: 'string' },
        },
      },
      required: ['names'],
      additionalProperties: false,
    },
    verb: '读取',
    category: 'context',
    facet: '工具定义',
    summary: '读取按需工具的完整参数定义',
    targetExtractor: (a) =>
      Array.isArray(a.names) ? a.names.map(String).join('、') || null : null,
    // 只读取本进程工具表中的定义，不访问工作区也不访问网络。
    permissionEffect: 'internal_control',
    parallelSafe: true,

    async fn(args, ctx) {
      const names = Array.isArray(args.names)
        ? args.names.map((n) => String(n).trim()).filter(Boolean)
        : []
      if (!names.length) {
        return { status: 'failure', message: '缺少 names', errorKind: 'invalid_args' }
      }
      const definitions: string[] = []
      const resident: string[] = []
      const missing: string[] = []
      for (const name of names) {
        const spec = registry.get(name)
        if (!spec) missing.push(name)
        else if (spec.deferred) {
          const detail = spec.deferred.detail?.(ctx) ?? null
          definitions.push(
            detail ? `${deferredDefinition(spec)}\n${detail}` : deferredDefinition(spec),
          )
        } else resident.push(name)
      }
      const parts: string[] = []
      if (definitions.length)
        parts.push(`以下工具现在可以按定义直接调用：${definitions.join('\n')}`)
      if (resident.length) parts.push(`${resident.join('、')} 的完整定义已在工具表中，直接调用。`)
      if (missing.length) {
        // 列出按需工具的名称而不是只返回「未找到」：模型给出的名称通常只与实际名称相差一个字，给出候选后即可自行修正。
        const available = registry
          .list()
          .filter((s) => s.deferred)
          .map((s) => s.name)
        parts.push(
          `工具表中没有：${missing.join('、')}。` +
            (available.length ? `按需工具：${available.join('、')}。` : ''),
        )
      }
      const ok = definitions.length > 0 || resident.length > 0
      return {
        status: ok ? 'success' : 'failure',
        message: parts.join('\n'),
        ...(ok ? {} : { errorKind: 'not_found' }),
        data: { loaded: names.filter((n) => registry.get(n)?.deferred) },
      }
    },
  }
}
