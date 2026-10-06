/**
 * 插件加载与注册。
 *
 * 加载顺序刻意固定为「按目录名字典序」：插件之间存在先到先得的资源（工具名、
 * 扩展名归属），随机顺序会使同一份安装在不同机器上得到不同结果。
 *
 * 隔离：插件代码在独立子进程中运行（见 host.ts），宿主一侧只持有 RPC 句柄。
 * 若在同进程中 `import()`，插件能直接读取宿主的 `process.env` 并取得 API Key。
 *
 * 边界的确切范围见 host.ts 文件头。概括而言：宿主的环境与进程内对象始终被隔离；
 * 文件系统与网络取决于运行时：node 20+ 提供沙箱，node 22.15+ 另外提供网络访问限制，
 * bun 上两者都没有。因此隔离状态是两个分别上报的布尔值，
 * 不是一句「有沙箱」。`qy plugins` 可显示当前的隔离状态。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  boundExecutedOutcome,
  sanitizeToolName,
  type ToolContext,
  type ToolSpec,
} from '@qywork/agent'
import { CALL_TIMEOUT_MS, checkPermission, type HostCallContext, PluginHost } from './host.ts'
import {
  ManifestError,
  type PluginManifest,
  type PreviewerContribution,
  type ProviderContribution,
  parseManifest,
  type RoleContribution,
} from './manifest.ts'

export interface LoadedPlugin {
  manifest: PluginManifest
  dir: string
  /** 隔离进程句柄。纯声明式插件（只注册预览器等）没有代码，为 null。 */
  host: PluginHost | null
}

/** 插件工具的注册名。必须规范化，理由见调用处。 */
export function pluginToolName(pluginId: string, tool: string): string {
  return sanitizeToolName(`${pluginId}__${tool}`)
}

/**
 * 某个插件所属工具的名称前缀。
 *
 * 必须调用本函数，不要自行拼接 `${id}__`。注册名已经规范化，id 含点的插件
 * （清单推荐反向域名，`com.example` 是常见写法）用原始 id 拼接的前缀无法匹配任何工具，
 * `qy plugins` 会报告「0 个工具」，而工具实际均已注册。
 */
export function pluginToolPrefix(pluginId: string): string {
  return sanitizeToolName(`${pluginId}__`)
}

export interface PluginRegistry {
  plugins: LoadedPlugin[]
  previewers: Map<string, { plugin: string; contribution: PreviewerContribution }>
  roles: Map<string, { plugin: string; contribution: RoleContribution }>
  providers: Map<string, { plugin: string; contribution: ProviderContribution }>
  /**
   * 插件贡献的工具规格。此处只生成，不写入 ToolRegistry。
   *
   * 直接向调用方传入的 registry 注册会把「加载一次扩展」与「取得一份工具表」
   * 绑定：每创建一个 Session（server 每条消息创建一个）就要重新加载扩展，
   * 即重新启动插件子进程，而旧的子进程无人关闭。生成与注册分开后，
   * 扩展可以按工作区缓存，工具表按会话分别注册。
   */
  toolSpecs: ToolSpec[]
  /** 加载失败的插件及原因。界面必须显示，不能静默跳过。 */
  failures: { dir: string; reason: string }[]
}

/**
 * 宿主能力实现。第三个参数是本次工具调用的可信身份。
 *
 * 它不能由实现方自行推断，也不能由插件自报：一个 handler 服务所有插件，而私有存储、
 * 配额与路径裁决都需要知道调用方是哪个插件、属于哪一轮执行。身份由
 * `PluginHost` 按 callId 保管，插件一侧只有 parentCallId。
 */
export type PluginCapabilityHandler = (
  method: string,
  params: Record<string, unknown>,
  context: HostCallContext,
) => Promise<unknown>

export interface LoadOptions {
  /** 插件请求宿主能力时的实现。权限校验由本模块在调用它之前完成。 */
  onCapability?: PluginCapabilityHandler
  onLog?: (line: string) => void
  /** 工作区根目录。沙箱据此决定插件进程可读写的范围。 */
  workspaceRoot?: string
}

export async function loadPlugins(
  pluginsDir: string,
  options: LoadOptions = {},
): Promise<PluginRegistry> {
  const registry: PluginRegistry = {
    plugins: [],
    previewers: new Map(),
    roles: new Map(),
    providers: new Map(),
    toolSpecs: [],
    failures: [],
  }

  const entries = await readdir(pluginsDir, { withFileTypes: true }).catch(() => [])
  // 字典序：同一份安装在不同机器上必须得到相同的先到先得结果。
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  for (const name of dirs) {
    const dir = join(pluginsDir, name)
    try {
      const plugin = await loadOne(dir, options)
      register(plugin, registry)
      registry.plugins.push(plugin)
    } catch (err) {
      registry.failures.push({
        dir,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return registry
}

async function loadOne(dir: string, options: LoadOptions): Promise<LoadedPlugin> {
  const manifestPath = join(dir, 'qywork.plugin.json')
  const raw = await readFile(manifestPath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ManifestError(manifestPath, `JSON 解析失败：${String(err)}`)
  }
  const manifest = parseManifest(parsed, manifestPath)

  const entry = join(dir, manifest.main ?? 'index.js')
  /*
   * 只有工具贡献需要代码，因此只为工具贡献启动进程。
   *
   * 不要把 `renders:'custom'` 的预览器与 `protocol:'custom'` 的 provider 计入：
   * 宿主从不向它们发起渲染或 adapter 调用（`registry.previewers` / `roles` /
   * `providers` 在 `runtime/src/extensions.ts` 合并后全仓没有读取点），
   * 计入会为不存在的调用链各启动一个常驻进程。
   *
   * 三类贡献按用户决定保留（清单类型、注册与冲突检测不变）。
   * 接入消费端时在此处加回对应条件，且与消费者在同一次改动中添加。
   */
  const needsCode = (manifest.contributes.tools?.length ?? 0) > 0

  if (!needsCode) return { manifest, dir, host: null }

  const host = new PluginHost({
    manifest,
    dir,
    entry,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    onCapability: async (method, params, context) => {
      // 权限在此处强制执行，不信任插件运行时的声明。
      const verdict = checkPermission(host, method)
      if (!verdict.ok) throw new Error(verdict.message)
      if (!options.onCapability) throw new Error(`宿主未提供能力实现：${method}`)
      return options.onCapability(method, params, context)
    },
    ...(options.onLog ? { onLog: options.onLog } : {}),
  })

  await host.start().catch((err) => {
    throw new ManifestError(entry, `插件进程启动失败：${String(err)}`)
  })

  return { manifest, dir, host }
}

function register(plugin: LoadedPlugin, registry: PluginRegistry): void {
  const { manifest, host } = plugin

  for (const t of manifest.contributes.tools ?? []) {
    if (!host) throw new ManifestError(plugin.dir, `工具 ${t.name} 需要入口代码，但插件未启动进程`)

    // 命名空间前缀：插件工具不会与内置工具或其他插件重名。
    //
    // 必须规范化：清单推荐反向域名风格的 id（`com.example.tool`），
    // 而 provider 只接受 `^[a-zA-Z0-9_-]+$`。不转换时，安装一个 id 含点的插件后，
    // 每一轮 run 都会被 400 拒绝，且错误信息不指明来源。
    const name = pluginToolName(manifest.id, t.name)
    if (registry.toolSpecs.some((s) => s.name === name)) {
      // 规范化会产生重名（`a.b` 与 `a_b` 同名）。此处查重并报告，不静默覆盖。
      registry.failures.push({ dir: plugin.dir, reason: `工具名规范化后与已有工具重名：${name}` })
      continue
    }
    const spec: ToolSpec = {
      name,
      description: t.description,
      // 清单中的 schema 由插件编写，适配器不得将其改写为 strict 形状：
      // 否则模型按改写后的形状传参，插件按原形状校验，两者不一致。
      parameters: t.parameters,
      strict: false,
      // 恒为 call，不采用清单中的声明：插件工具是第三方代码通过 RPC 提供的能力，
      // 「这是一次外置调用」是宿主确知的事实，不应由插件自称为读、写或运行。
      actionKind: 'call',
      // 对象名恒为「插件」，不采用清单中的声明，理由同 `actionKind`：卡片的对象层表示
      // 能力类别，具体是哪个插件的哪个工具由下方的 target 表示。
      objectLabel: '插件',
      // target 同时承载权限 scope（scope = `<effect>:<target>`），因此带
      // `plugin:` 前缀并使用未规范化的 id，与 MCP 的 `mcp:<server>/<tool>` 格式对齐，
      // 使两类外置工具的 scope 不会成为同一个字符串。
      targetExtractor: () => `plugin:${manifest.id}/${t.name}`,
      permissionEffect: t.permissionEffect,
      // 插件工具归入「插件」类目，理由与 MCP 相同：不允许插件在清单中自行声明类目，
      // 否则插件能把自身放入「文件与草稿」，与内置工具混列在同一栏。
      category: 'plugins',
      facet: plugin.manifest.id,
      summary: t.description,
      // 跨进程调用。ctx 不离开宿主进程：它包含 sink 句柄、AbortSignal 等
      // 宿主内部对象，序列化传递等于交出这些对象。此处只从 ctx
      // 取出本次调用的身份并保留在宿主内存中，插件一侧取得的仍只有 callId；
      // 插件使用宿主能力须经由 host.* RPC，该路径上有权限检查，身份按 callId 取回。
      fn: async (args, ctx) => {
        try {
          const result = await host.call(t.name, args, callContext(manifest.id, ctx))
          // 插件结果没有大小上限：按本轮剩余额度定稿，超出额度的 message 与 data 整体存入正文库。
          return boundExecutedOutcome(ctx, normalizeOutcome(result, t.name), {
            toolName: name,
            sourceType: `plugin:${manifest.id}`,
          })
        } catch (err) {
          return {
            status: 'failure' as const,
            executed: true,
            message: `插件工具 ${name} 执行失败：${err instanceof Error ? err.message : String(err)}`,
            errorKind: 'plugin_error',
          }
        }
      },
    }
    registry.toolSpecs.push(spec)
  }

  for (const p of manifest.contributes.previewers ?? []) {
    for (const ext of p.extensions) {
      const key = ext.toLowerCase()
      // 先到先得，不覆盖。冲突记入 failures 以显示给用户，
      // 静默覆盖会使「插件已安装但未生效」无法排查。
      if (registry.previewers.has(key)) {
        registry.failures.push({
          dir: plugin.dir,
          reason: `扩展名 ${key} 已被 ${registry.previewers.get(key)!.plugin} 占用`,
        })
        continue
      }
      registry.previewers.set(key, { plugin: manifest.id, contribution: p })
    }
  }

  for (const r of manifest.contributes.roles ?? []) {
    registry.roles.set(`${manifest.id}:${r.id}`, { plugin: manifest.id, contribution: r })
  }
  for (const pr of manifest.contributes.providers ?? []) {
    registry.providers.set(`${manifest.id}:${pr.id}`, { plugin: manifest.id, contribution: pr })
  }
}

/**
 * 从工具上下文中提取本次调用的可信身份。
 *
 * 只取插件能力需要的字段。`signal` 是宿主进程内的对象，保留在宿主内存中按 callId
 * 取回，不写入 RPC 帧。
 */
function callContext(pluginId: string, ctx: ToolContext): HostCallContext {
  return {
    pluginId,
    workspaceRoot: ctx.workspaceRoot,
    conversationId: ctx.conversationId,
    runId: ctx.runId,
    ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
    signal: ctx.signal,
    deadline: Date.now() + CALL_TIMEOUT_MS,
    ...(ctx.additionalDirectories ? { additionalDirectories: ctx.additionalDirectories } : {}),
    ...(ctx.unrestrictedPaths ? { unrestrictedPaths: true } : {}),
  }
}

/**
 * 归一化插件返回值。
 *
 * 插件是第三方代码，返回值可能是任意形状，必须在信任边界上归一化：
 * 直接作为 ToolOutcome 写入账本时，一个返回 `undefined` 的插件就会使
 * 下游所有读取 `outcome.message` 的位置崩溃。
 */
export function normalizeOutcome(
  raw: unknown,
  toolName: string,
): {
  status: 'success' | 'failure'
  executed: boolean
  message: string
  data?: Record<string, unknown>
} {
  if (typeof raw !== 'object' || raw === null) {
    return {
      status: 'failure',
      executed: true,
      message: `插件工具 ${toolName} 返回了非对象结果（${typeof raw}）`,
    }
  }
  const r = raw as Record<string, unknown>
  const status = r.status === 'success' ? 'success' : 'failure'

  // fail-closed 正确，但拒绝时必须说明原因。
  //
  // 实测情形：插件返回结构完整的 `{content: "..."}` 时，界面只显示 `✗ 失败`，
  // 插件作者无法判断是返回形状错误还是插件逻辑失败。
  //
  // 只在插件未提供 message 时补充说明：插件提供的 message
  // 是对失败原因的第一手描述，比本地推断准确。
  const explain = (): string => {
    if (status === 'success') return '完成'
    if (r.status === undefined) {
      const keys = Object.keys(r).slice(0, 6).join('、') || '（空对象）'
      return `插件工具 ${toolName} 的返回值中没有 status 字段，按失败处理。收到的字段：${keys}。期望的形状为 {status:'success'|'failure', message?, executed?, data?}`
    }
    return `插件工具 ${toolName} 返回 status=${JSON.stringify(r.status)}`
  }

  return {
    status,
    // executed 缺省取 true：插件已经执行，无法判定时按有副作用处理。
    // 写成 `!== false` 而不是 `Boolean(r.executed)`：后者会把「未填写」也视为 false。
    executed: r.executed !== false,
    message: typeof r.message === 'string' && r.message ? r.message : explain(),
    ...(typeof r.data === 'object' && r.data !== null
      ? { data: r.data as Record<string, unknown> }
      : {}),
  }
}
