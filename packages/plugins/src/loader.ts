/**
 * 插件加载与注册。
 *
 * 加载顺序刻意固定为「按目录名字典序」：插件之间存在先到先得的资源（工具名、
 * 扩展名归属），随机顺序会让同一份安装在不同机器上表现不同。
 *
 * 隔离：**插件代码在独立子进程里跑**（见 host.ts），宿主这边只有 RPC 句柄。
 * 曾经这里是同进程 `import()`，插件能直接读宿主的 `process.env` 拿走 API Key。
 *
 * 边界的确切范围见 host.ts 顶部。简而言之：宿主的环境与进程内对象一定挡住；
 * 文件系统与网络**取决于运行时**——node 20+ 给沙箱、node 22.15+ 再给出网闸，
 * bun 上两样都没有。所以隔离状态是**两个分开上报的布尔值**，
 * 不是一句「有沙箱」。用 `qy plugins` 可以直接看当前是哪种。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sanitizeToolName, type ToolSpec } from '@qywork/agent'
import { checkPermission, PluginHost } from './host.ts'
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

/** 插件工具的注册名。消毒是硬要求，理由见调用处。 */
export function pluginToolName(pluginId: string, tool: string): string {
  return sanitizeToolName(`${pluginId}__${tool}`)
}

/**
 * 「这个插件的工具」的名字前缀。
 *
 * **必须走这里，不要自己拼 `${id}__`。** 注册名消毒过，一个 id 带点的插件
 * （清单推荐反向域名，`com.example` 是常态）拿原始 id 拼前缀一条都匹配不上，
 * 表现是 `qy plugins` 报「0 个工具」而工具其实全都在。
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
   * 插件贡献的工具规格。**这里只产出，不写进 ToolRegistry。**
   *
   * 之前是直接往调用方给的 registry 里注册，于是「加载一次扩展」和
   * 「拿到一份工具表」被绑死了：每建一个 Session（server 是每条消息一个）
   * 就得重新加载一遍扩展，也就重新起一遍插件子进程——而旧的那批没人关。
   * 产出与注册分开之后，扩展可以按工作区缓存，工具表按会话各注册各的。
   */
  toolSpecs: ToolSpec[]
  /** 加载失败的插件及原因。UI 要能显示出来，不能静默跳过。 */
  failures: { dir: string; reason: string }[]
}

/**
 * 宿主能力实现。第三个参数是**发起调用的插件 id**。
 *
 * 它不能由实现方自己推断：一个 handler 服务所有插件，而私有存储、配额、
 * 审计日志都得知道是谁在调。让 handler 去猜等于给了所有插件同一份存储。
 */
export type PluginCapabilityHandler = (
  method: string,
  params: Record<string, unknown>,
  pluginId: string,
) => Promise<unknown>

export interface LoadOptions {
  /** 插件请求宿主能力时的实现。权限校验由本模块在调用它之前完成。 */
  onCapability?: PluginCapabilityHandler
  onLog?: (line: string) => void
  /** 工作区根。沙箱据此决定插件进程能读写哪一块。 */
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
   * 只有**工具**贡献需要代码，所以只有它起进程。
   *
   * 这里曾经把 `renders:'custom'` 的预览器和 `protocol:'custom'` 的 provider 也算进来，
   * 于是这两类插件各白起一个子进程——而宿主**从来不会向它们发起渲染 / adapter 调用**：
   * `registry.previewers` / `roles` / `providers` 在 `runtime/src/extensions.ts` 合并之后，
   * 全仓没有任何读取点。为一条不存在的调用链付一个常驻进程的代价，是纯粹的浪费。
   *
   * 三条贡献通道本身按用户决定先保留（清单类型、注册、冲突检测原样）。
   * 等哪天真接上消费端，把对应的条件加回这里——**连同消费者一起加**。
   */
  const needsCode = (manifest.contributes.tools?.length ?? 0) > 0

  if (!needsCode) return { manifest, dir, host: null }

  const host = new PluginHost({
    manifest,
    dir,
    entry,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    onCapability: async (method, params) => {
      // **权限在这里强制**，不信任插件的自我声明。
      const verdict = checkPermission(host, method)
      if (!verdict.ok) throw new Error(verdict.message)
      if (!options.onCapability) throw new Error(`宿主未提供能力实现：${method}`)
      return options.onCapability(method, params, manifest.id)
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

    // 命名空间前缀：插件工具永远不可能与内置工具或其他插件撞名。
    //
    // **必须消毒**：清单推荐反向域名风格的 id（`com.example.tool`），
    // 而 provider 只接受 `^[a-zA-Z0-9_-]+$`。不转的话装一个带点的插件，
    // 之后每一轮 run 都被 400 打死，错误信息还不说是谁干的。
    const name = pluginToolName(manifest.id, t.name)
    if (registry.toolSpecs.some((s) => s.name === name)) {
      // 消毒会制造碰撞（`a.b` 与 `a_b` 同名）。查重并报出来，不静默覆盖。
      registry.failures.push({ dir: plugin.dir, reason: `工具名消毒后与已有的撞了：${name}` })
      continue
    }
    const spec: ToolSpec = {
      name,
      description: t.description,
      parameters: t.parameters,
      actionKind: t.actionKind,
      objectLabel: t.objectLabel,
      permissionEffect: t.permissionEffect,
      // 插件工具同 MCP，归「外部扩展」——清单里不让插件自己声明类目，
      // 否则一个插件就能把自己塞进「文件与草稿」，和内置工具混在一栏里。
      category: 'external',
      facet: plugin.manifest.id,
      summary: t.description,
      // 跨进程调用。**不传 ctx**——它带着 sink 句柄、AbortSignal、
      // 权限回调这些宿主内部对象，序列化过去等于把它们交出去。
      // 插件要用宿主能力就走 host.* RPC，那条路上有权限闸。
      fn: async (args) => {
        try {
          const result = await host.call(t.name, args)
          return normalizeOutcome(result, t.name)
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
      // 先到先得，不覆盖。冲突记入 failures 让用户看得见，
      // 静默覆盖会让「装了插件但没生效」变成无法排查的现象。
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
 * 归一化插件返回值。
 *
 * 插件是第三方代码，返回什么形状都有可能。**必须在信任边界上收敛**——
 * 直接把它当 ToolOutcome 塞进账本，一个返回 `undefined` 的插件就能让
 * 下游所有读 `outcome.message` 的地方崩掉。
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

  // fail-closed 是对的，但**拒绝要说出理由**。
  //
  // 实测踩过：插件返回了一个结构完全正常的 `{content: "..."}`，
  // 界面上显示的就是 `✗ 失败` 两个字——插件作者无从判断是自己形状写错了，
  // 还是插件逻辑真的失败了。这与「MCP server 未运行」不带死因是同一类问题。
  //
  // 只在**插件自己没给 message** 时补这句话：它给了就用它的，
  // 那是插件对失败原因的第一手描述，比我们的猜测有用。
  const explain = (): string => {
    if (status === 'success') return '完成'
    if (r.status === undefined) {
      const keys = Object.keys(r).slice(0, 6).join('、') || '（空对象）'
      return `插件工具 ${toolName} 的返回里没有 status 字段，按失败处理。拿到的字段：${keys}。期望形如 {status:'success'|'failure', message?, executed?, data?}`
    }
    return `插件工具 ${toolName} 返回 status=${JSON.stringify(r.status)}`
  }

  return {
    status,
    // executed 缺省取 true：插件已经跑过了，无法判定时保守假设它有副作用。
    // 写成 `!== false` 而不是 `Boolean(r.executed)`——后者会把「没填」也当成 false。
    executed: r.executed !== false,
    message: typeof r.message === 'string' && r.message ? r.message : explain(),
    ...(typeof r.data === 'object' && r.data !== null
      ? { data: r.data as Record<string, unknown> }
      : {}),
  }
}
