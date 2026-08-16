/**
 * 外部工具的待加载池，与它的取用口 `load_tool`。
 *
 * ## 要治的是什么
 *
 * MCP 与插件的工具原先全部注册，于是每个工具的**完整 JSON Schema** 都进请求，
 * 而且工具表渲染在 prompt 最前面（`agent/registry.ts` 顶部：顺序抖动会让整个
 * 前缀缓存失效）。MCP 那份 `parameters` 是第三方 server 给的，经
 * `mcp/register.ts` 的 `normalizeSchema` 只补 `type`/`properties` 就原样透传——
 * **大小完全不由我们控制**。
 *
 * ## 实测的量（2026-08-16，四个真实 MCP server，本仓 `estimateSchemas` 口径）
 *
 * ```
 * @modelcontextprotocol/server-filesystem           14 个工具   4225 token
 * @modelcontextprotocol/server-everything           15 个工具   3041 token
 * @modelcontextprotocol/server-memory               11 个工具   2537 token
 * @modelcontextprotocol/server-sequential-thinking   1 个工具   2016 token
 * ```
 *
 * 合计 41 个工具 11819 token，平均约 290 token/个，单个工具从 98 到 2016 不等
 * ——**一个工具就能顶一整个 server**，所以按「装了几个 server」拍脑袋定不了档。
 * 同一批工具的一行摘要清单（截到 100 字）是 1187 token，约十分之一。
 *
 * ## 阈值：小的时候全量常驻更划算
 *
 * 总量小时转按需是净亏：省下来的那点 token 抵不掉一次模型往返，而清单本身
 * 还要占约 30 token/条。所以只有超过阈值才转按需，见 `EXTERNAL_SCHEMA_BUDGET_TOKENS`。
 */

import type { ToolRegistry, ToolSpec } from '@qywork/agent'
import { estimateSchemas } from '@qywork/ai'

/**
 * 外部工具 schema 的常驻预算。总量不超过它就照旧全量注册，超过才转按需。
 *
 * 取 2000：按上面实测的平均 290 token/个，它约等于**七个普通工具**，
 * 也就是「一个小 server 全量常驻，两个 server 或一个大工具转按需」。
 * 低于这条线转按需省下的不足两千 token，却要多付一次往返——那是净亏。
 *
 * 判据是**总量**不是个数：单个工具能占 2000（sequential-thinking 就是），
 * 按个数定档会让「一个工具的 server」被判成小配置。
 */
export const EXTERNAL_SCHEMA_BUDGET_TOKENS = 2000

/** 这批工具的 schema 发出去有多大。与请求里那份同一把尺（`estimateSchemas`）。 */
export function externalSchemaTokens(specs: readonly ToolSpec[]): number {
  return estimateSchemas(
    specs.map((s) => ({ name: s.name, description: s.description, parameters: s.parameters })),
  )
}

export interface LoadResult {
  /** 这次真的装进工具表的。 */
  loaded: string[]
  /** 本来就在表里的。不是错误——重复注册会抛，那是装配错误的信号，不该由模型触发。 */
  already: string[]
  /** 池子里没有这个名字。 */
  unknown: string[]
}

/**
 * 待加载池。
 *
 * 池子里的 spec **不在注册表里**，所以既不进 `registry.schemas()` 也不进请求；
 * 装入走 `registry.register()`，那里本来就会把 `schemaCache` 置空，
 * 下一次构造请求自然带上新工具——不需要另加通知机制。
 */
export class PendingToolPool {
  private readonly pending = new Map<string, ToolSpec>()

  constructor(
    private readonly deps: {
      registry: ToolRegistry
      /**
       * 装好之后落账本。会话级的事实要落会话级的存储——Session 每条消息新建一个，
       * 进程内的集合活不过这条消息。
       */
      onLoaded(names: string[]): void
    },
  ) {}

  add(spec: ToolSpec): void {
    this.pending.set(spec.name, spec)
  }

  get size(): number {
    return this.pending.size
  }

  /**
   * 尾区清单：一行一条，只有名字和一句话。
   *
   * 装过的**不再列出来**——它已经在工具表里了，再列一遍会让模型以为还要再装一次。
   */
  index(): { name: string; summary: string }[] {
    return [...this.pending.values()].map((s) => ({ name: s.name, summary: s.summary }))
  }

  load(names: readonly string[]): LoadResult {
    const out: LoadResult = { loaded: [], already: [], unknown: [] }
    for (const name of names) {
      if (this.deps.registry.has(name)) {
        out.already.push(name)
        continue
      }
      const spec = this.pending.get(name)
      if (!spec) {
        out.unknown.push(name)
        continue
      }
      this.deps.registry.register(spec)
      this.pending.delete(name)
      out.loaded.push(name)
    }
    if (out.loaded.length) this.deps.onLoaded(out.loaded)
    return out
  }
}

export function makeLoadToolTool(pool: PendingToolPool): ToolSpec {
  return {
    name: 'load_tool',
    description:
      '把外部工具（MCP server 与插件提供的）的参数说明装进工具表，装完就能直接调用它们。' +
      '名字从尾区那份「可加载的外部工具」清单里取，一次可以传多个。' +
      '不在那份清单里的工具本来就在工具表里，直接调即可，不需要装。',
    parameters: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          description: '要装的工具名，取自尾区清单',
          items: { type: 'string' },
        },
      },
      required: ['names'],
      additionalProperties: false,
    },
    actionKind: 'read',
    objectLabel: '工具',
    category: 'session',
    facet: '外部工具',
    summary: '按需把外部工具的参数说明装进工具表',
    targetExtractor: (a) =>
      Array.isArray(a.names) ? a.names.map(String).join('、') || null : null,
    // 只动本进程的工具表，不碰工作区也不出网，没有需要用户批准的副作用。
    permissionEffect: 'internal_control',
    parallelSafe: true,

    async fn(args) {
      const names = Array.isArray(args.names)
        ? args.names.map((n) => String(n).trim()).filter(Boolean)
        : []
      if (!names.length) {
        return { status: 'failure', message: '缺少 names', errorKind: 'invalid_args' }
      }

      const r = pool.load(names)
      const parts: string[] = []
      if (r.loaded.length) {
        parts.push(`已装入 ${r.loaded.length} 个工具：${r.loaded.join('、')}，现在可以直接调用。`)
      }
      if (r.already.length) parts.push(`本来就在工具表里：${r.already.join('、')}。`)
      if (r.unknown.length) {
        // 列出可加载的名字而不是只说「找不到」：模型多半是名字记错了一个字，
        // 给它候选它下一轮就能自己修正（同 `read_skill` 的做法）。
        const available = pool.index().map((t) => t.name)
        parts.push(
          `没有这些工具：${r.unknown.join('、')}。` +
            (available.length ? `可加载的是：${available.join('、')}。` : '当前没有待加载的工具。'),
        )
      }

      const ok = r.loaded.length > 0 || r.already.length > 0
      return {
        status: ok ? 'success' : 'failure',
        message: parts.join(''),
        ...(ok ? {} : { errorKind: 'not_found' }),
        data: { ...r },
      }
    },
  }
}
