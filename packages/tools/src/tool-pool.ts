/**
 * 外部工具的待加载池，及其加载入口 `load_tool`。
 *
 * 解决的问题：MCP 与插件的工具若全部注册，每个工具的完整 JSON Schema 都会进入请求，
 * 且工具表位于 prompt 最前部（见 `agent/registry.ts` 文件头：顺序变化会使整个
 * 前缀缓存失效）。MCP 的 `parameters` 由第三方 server 提供，经
 * `mcp/register.ts` 的 `normalizeSchema` 只补充 `type`/`properties` 即原样透传，
 * 大小完全不受本仓库控制。
 *
 * 实测数据（2026-08-16，四个真实 MCP server，按本仓库 `estimateSchemas` 计算）。```
 * @modelcontextprotocol/server-filesystem           14 个工具   4225 token
 * @modelcontextprotocol/server-everything           15 个工具   3041 token
 * @modelcontextprotocol/server-memory               11 个工具   2537 token
 * @modelcontextprotocol/server-sequential-thinking   1 个工具   2016 token
 * ```
 *
 * 合计 41 个工具 11819 token，平均约 290 token/个，单个工具从 98 到 2016 不等：
 * 一个工具的体积可与一整个 server 相当，因此不能按安装的 server 数量确定档位。
 * 同一批工具的一行摘要清单（截断到 100 字）为 1187 token，约为十分之一。
 *
 * 阈值：总量小时全量常驻更合算。此时改为按需加载得不偿失：节省的 token 抵不过一次模型往返，
 * 而清单本身每条还占约 30 token。因此只有超过阈值才改为按需加载，见 `EXTERNAL_SCHEMA_BUDGET_TOKENS`。
 */

import type { ToolRegistry, ToolSpec } from '@qywork/agent'
import { estimateSchemas, type TokenDensity } from '@qywork/ai'

/**
 * 外部工具 schema 的常驻预算。总量不超过它时照常全量注册，超过才改为按需加载。
 *
 * 取 1600：上表按旧的估算口径（JSON 按 2 字符/token）测得，平均 290 token/个；
 * 按已标定模型的 JSON 档（2.5 字符/token）换算为 232 token/个，
 * 七个普通工具因此为 1624，取整为 1600。语义仍是
 * 「一个小 server 全量常驻，两个 server 或一个大工具改为按需加载」：
 * 低于此线时改为按需加载节省不足两千 token，却要多付出一次往返，得不偿失。
 *
 * 判据是总量而不是个数：单个工具可占一千多 token（sequential-thinking 换算后为 1613），
 * 按个数定档会把只有一个工具的 server 判为小配置。该值与此线只差十几个 token，
 * 修改此常数前先按新口径重新测量这四个 server，不要依据旧表推算。
 */
export const EXTERNAL_SCHEMA_BUDGET_TOKENS = 1600

/** 这批工具的 schema 发送时的大小。与请求使用同一估算口径（`estimateSchemas`）。 */
export function externalSchemaTokens(specs: readonly ToolSpec[], density: TokenDensity): number {
  return estimateSchemas(
    specs.map((s) => ({ name: s.name, description: s.description, parameters: s.parameters })),
    density,
  )
}

export interface LoadResult {
  /** 本次实际加入工具表的工具。 */
  loaded: string[]
  /** 已在表中的工具。这不是错误：重复注册会抛错，那是装配错误的信号，不应由模型触发。 */
  already: string[]
  /** 加载目标没有命中待加载池。 */
  notFound: string[]
}

/**
 * 待加载池。
 *
 * 池中的 spec 不在注册表中，因此既不进入 `registry.schemas()` 也不进入请求；
 * 加载经由 `registry.register()`，该方法本身会清空 `schemaCache`，
 * 下一次构造请求时自动包含新工具，无需另加通知机制。
 */
export class PendingToolPool {
  private readonly pending = new Map<string, ToolSpec>()

  constructor(
    private readonly deps: {
      registry: ToolRegistry
      /**
       * 加载完成后写入账本。会话级的事实必须写入会话级的存储：Session 每条消息新建一个，
       * 进程内集合的生命周期不超过这条消息。
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
   * 上下文末尾的清单：每行一条，只有名称和一句说明。
   *
   * 已加载的工具不再列出：它已在工具表中，再次列出等于提示模型再加载一次。
   */
  index(): { name: string; summary: string }[] {
    return [...this.pending.values()].map((s) => ({ name: s.name, summary: s.summary }))
  }

  load(names: readonly string[]): LoadResult {
    const out: LoadResult = { loaded: [], already: [], notFound: [] }
    for (const name of names) {
      if (this.deps.registry.has(name)) {
        out.already.push(name)
        continue
      }
      const spec = this.pending.get(name)
      if (!spec) {
        out.notFound.push(name)
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

/**
 * `load_tool` 除 `fn` 之外的全部字段。
 *
 * 单独导出供「该 agent 可调用的工具」清单使用（`server/api/workspace.ts`）：
 * 本工具只在建池时注册，不在 `registerBuiltinTools` 中，该清单构建的是一个空注册表，
 * 不单独列出就始终缺少这一项。不要让清单一侧再计算一次分档（测量 schema 总量、超过阈值才列出）：
 * 该判断的真源是建池处，计算两次就形成两本账，最终会出现分歧。
 *
 * 因此「只在超过阈值时注册」这一边界写在 `summary` 中，由清单如实显示。
 */
export const LOAD_TOOL_SPEC: Omit<ToolSpec, 'fn'> = {
  name: 'load_tool',
  description:
    '把外部工具（MCP server 与插件提供的）的参数说明加载进工具表，加载后即可直接调用。' +
    '名称取自上下文末尾「可加载的外部工具」清单，一次可以传多个。' +
    '不在该清单中的工具已在工具表内，直接调用，无需加载。',
  parameters: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        description: '要加载的工具名，取自上下文末尾的工具清单',
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
  summary: '按需加载 MCP 与插件工具的参数定义；仅在这些定义的总量超过阈值时提供',
  targetExtractor: (a) => (Array.isArray(a.names) ? a.names.map(String).join('、') || null : null),
  // 只修改本进程的工具表，不访问工作区也不访问网络，没有需要用户批准的副作用。
  permissionEffect: 'internal_control',
  parallelSafe: true,
}

export function makeLoadToolTool(pool: PendingToolPool): ToolSpec {
  return {
    ...LOAD_TOOL_SPEC,
    description: `${LOAD_TOOL_SPEC.description} 当前可加载：${pool
      .index()
      .map((s) => s.name)
      .join('、')}`,

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
        parts.push(`已加载 ${r.loaded.length} 个工具：${r.loaded.join('、')}，现在可以直接调用。`)
      }
      if (r.already.length) parts.push(`已在工具表中：${r.already.join('、')}。`)
      if (r.notFound.length) {
        // 列出可加载的名称而不是只返回「未找到」：模型通常只是把名称记错了一个字，
        // 给出候选后，它在下一轮即可自行修正（与 `read_skill` 的做法相同）。
        const available = pool.index().map((t) => t.name)
        parts.push(
          `加载目标未命中：${r.notFound.join('、')}。` +
            (available.length
              ? `可加载的工具：${available.join('、')}。`
              : '当前没有待加载的工具。'),
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
