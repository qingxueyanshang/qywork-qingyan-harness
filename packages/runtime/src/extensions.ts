/**
 * 扩展装配：插件与 Agent Team 后端的加载入口。
 *
 * **库存在不等于功能存在**：`loadPlugins()` 只有定义处一个引用、`teamBackends`
 * 在握手里硬编码成 `[]` 的话，两样都等于没有。而握手里报假的能力清单比不报更糟
 * ——客户端会据此做出「隐藏入口」的正确行为，接线之后反而找不到 bug。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolSpec } from '@qywork/agent'
import {
  loadMcpServers,
  type McpConfig,
  type McpRegistry,
  parseMcpConfig,
  toolNamePrefix,
} from '@qywork/mcp'
import { loadPlugins, type PluginRegistry, pluginToolPrefix } from '@qywork/plugins'
import type { Role, TeamRules } from '@qywork/team'
import {
  AGENTS_DIR,
  globalScopeRoot,
  resolveInWorkspace,
  type Scope,
  scopePaths,
  scopeRoots,
} from '@qywork/tools'
import { makeCapabilityHandler } from './capabilities.ts'
import { isWorkspaceTrusted, loadConfig } from './config.ts'

/** 全局根下装插件的子目录名。 */
export const PLUGINS_SUBDIR = 'plugins'
/** 各层根目录下的 MCP 配置文件名。三层都按这个名字找。 */
export const MCP_FILE = 'mcp.json'

/** 项目层（工作区 `.agents/`）里 MCP 配置的位置。写回、报路径用它。 */
export const MCP_CONFIG = `${AGENTS_DIR}/${MCP_FILE}`

/**
 * 插件的唯一目录：`~/.qywork/plugins/`。
 *
 * **插件不分层。** 它贡献的是工具、预览器、供应商——那些是这个 agent 的能力，
 * 不是某个仓库的内容。分层的代价是同一个插件在两个仓库里各存一份、各自升级，
 * 而「在全局装了却没生效」只能靠一条 failure 文案解释。
 *
 * 「这个项目要不要加载某个插件」是**开关**，将来由工作区面板控制，
 * 不是把插件复制两份。
 */
export function globalPluginsDir(): string {
  return join(globalScopeRoot(), PLUGINS_SUBDIR)
}

/**
 * team 配置**只有工作区一份，不分层**。
 *
 * 它描述的是「这个项目怎么分工」——角色、后端、编排图全是项目属性，
 * 跟到别的仓库去只会派错人。所以它留在 `.qy/`，不进 `.agents/`。
 */
export const TEAM_CONFIG = '.qy/team.json'

export interface Extensions {
  plugins: PluginRegistry
  team: WorkspaceTeamConfig
  mcp: McpRegistry
  /** 插件与 MCP 一起贡献的工具规格，已按名去重。由会话注册进自己的表。 */
  toolSpecs: ToolSpec[]
  /** 关掉本份扩展持有的全部子进程。 */
  stop(): void
}

export interface WorkspaceTeamConfig {
  roles: Role[]
  rules: TeamRules
  /** 配置文件解析失败的原因。UI 要显示，不能静默当作「没配」。 */
  error: string | null
}

/**
 * 加载工作区扩展。
 *
 * **永不抛异常**：一个坏掉的插件或写错的 team.json 不该让整个会话起不来。
 * 失败信息收在返回值里交给 UI。
 */
export async function loadExtensions(
  workspaceRoot: string,
  onLog?: (line: string) => void,
): Promise<Extensions> {
  const plugins = await loadInstalledPlugins(workspaceRoot, onLog)

  const mcp = await loadWorkspaceMcp(workspaceRoot, onLog)

  // 插件先到先得，MCP 撞名时丢弃并记 failure。顺序固定（插件在前）才能保证
  // 同一份配置在不同机器上得到相同结果。
  const toolSpecs = [...plugins.toolSpecs]
  const taken = new Set(toolSpecs.map((t) => t.name))
  for (const spec of mcp.toolSpecs) {
    if (taken.has(spec.name)) {
      mcp.failures.push({ server: 'mcp', reason: `工具名已被插件占用：${spec.name}` })
      continue
    }
    taken.add(spec.name)
    toolSpecs.push(spec)
  }

  return {
    plugins,
    team: await loadTeamConfig(workspaceRoot),
    mcp,
    toolSpecs,
    stop: () => {
      for (const p of plugins.plugins) p.host?.stop()
      mcp.stopAll()
    },
  }
}

// ───────────────────────── 按工作区缓存 ─────────────────────────

/**
 * 扩展按工作区共享，引用计数决定何时真的关掉子进程。
 *
 * 为什么需要：server 是**每条消息新建一个 Session**的。加载扩展如果绑在 Session 上，
 * 每发一句话就重起一遍全部插件子进程和 MCP server（npx 起的 server 要几秒），
 * 而旧的那批没有任何人关——实测这是一条真实的进程泄漏，只是之前
 * `dispose()` 从没被调用过，所以连泄漏都看不见。
 *
 * 缓存的是 **Promise** 而不是结果：两条消息几乎同时进来时，第二条要等第一条那次
 * 加载，而不是自己再起一遍。
 */
interface Entry {
  promise: Promise<Extensions>
  refs: number
}
const shared = new Map<string, Entry>()

export async function acquireExtensions(
  workspaceRoot: string,
  onLog?: (line: string) => void,
): Promise<Extensions> {
  let entry = shared.get(workspaceRoot)
  if (!entry) {
    entry = { promise: loadExtensions(workspaceRoot, onLog), refs: 0 }
    shared.set(workspaceRoot, entry)
  }
  entry.refs++
  try {
    return await entry.promise
  } catch (err) {
    // 加载整体失败时不能把坏 Promise 留在缓存里，否则后面每次都拿到同一个失败。
    entry.refs--
    if (entry.refs <= 0) shared.delete(workspaceRoot)
    throw err
  }
}

export function releaseExtensions(workspaceRoot: string): void {
  const entry = shared.get(workspaceRoot)
  if (!entry) return
  entry.refs--
  if (entry.refs > 0) return
  shared.delete(workspaceRoot)
  void entry.promise.then((ext) => ext.stop()).catch(() => {})
}

/**
 * 装在 `~/.qywork/plugins/` 里的插件。
 *
 * 只有这一个目录，所以没有跨层去重——同一个 id 在同一个目录下不可能出现两次。
 * 工具名仍然要去重：两个不同的插件可以声明同一个工具名，撞车的表现是
 * 「有一个插件的工具凭空消失」，所以撞了要记 failure 而不是安静丢掉。
 */
async function loadInstalledPlugins(
  workspaceRoot: string,
  onLog?: (line: string) => void,
): Promise<PluginRegistry> {
  const dir = globalPluginsDir()
  const reg = await loadPlugins(dir, {
    ...(onLog ? { onLog } : {}),
    workspaceRoot,
    onCapability: makeCapabilityHandler({ workspaceRoot }),
  }).catch(
    (err): PluginRegistry => ({
      plugins: [],
      previewers: new Map(),
      roles: new Map(),
      providers: new Map(),
      toolSpecs: [],
      failures: [{ dir, reason: err instanceof Error ? err.message : String(err) }],
    }),
  )

  // 工具按**名字**去重，不按插件 id 前缀：注册名是消毒过的
  //（`test.probe` → `test_probe__probe`），按 id 拼前缀会一个都匹配不上。
  const taken = new Set<string>()
  const toolSpecs: ToolSpec[] = []
  for (const spec of reg.toolSpecs) {
    if (taken.has(spec.name)) {
      reg.failures.push({ dir, reason: `工具名已被另一个插件占用：${spec.name}` })
      continue
    }
    taken.add(spec.name)
    toolSpecs.push(spec)
  }
  return { ...reg, toolSpecs }
}

/**
 * 读三层的 `mcp.json` 并把里面的 server 全部连上。
 *
 * 一个 server 都没有 = 没配 MCP，返回空注册表，不是错误。
 *
 * 同名 server **先认领的赢**：全局配了一个 `github`，工作区又配了一个同名的，
 * 用的是工作区那份——这正是「这个项目要连另一个实例」的表达方式。
 *
 * `cwd` 仍然锁在工作区内。全局那份写了工作区外的 cwd 会失败，而不是被放行：
 * 一个跨工作区的配置能把 server 的工作目录指到任意位置，那条路不该开。
 */
export async function loadWorkspaceMcp(
  workspaceRoot: string,
  onLog?: (line: string) => void,
): Promise<McpRegistry> {
  const empty: McpRegistry = {
    servers: [],
    failures: [],
    toolSpecs: [],
    stopAll: () => {},
  }

  const all = await loadScopedMcpConfig(workspaceRoot)
  if (all.error) onLog?.(`[qy] ${MCP_FILE}：${all.error}`)

  /*
   * 项目层要先授权。这里必须**重新合成**而不是把项目层那几个名字过滤掉：
   * `loadScopedMcpConfig` 里先认领的赢，项目层已经把同名的全局 server 丢掉了，
   * 事后过滤的结果是这个名字一个都不剩。
   */
  const pending = Object.keys(all.servers).filter((n) => all.scopeOf[n] === 'project')
  const trusted = pending.length === 0 || isWorkspaceTrusted(await loadConfig(), workspaceRoot)
  const config = trusted
    ? all
    : await loadScopedMcpConfig(workspaceRoot, { scopes: ['builtin', 'global'] })
  if (!trusted) onLog?.(`[qy] 项目层 MCP 未授权，本轮不启动：${pending.join('、')}`)

  if (Object.keys(config.servers).length === 0) return empty

  return loadMcpServers(config, workspaceRoot, {
    ...(onLog ? { onLog } : {}),
    // cwd 必须锁在工作区内：mcp.json 是工作区里的文件，一个被克隆下来的仓库
    // 不该能把 server 的工作目录指到别处。
    resolveCwd: (rel) => resolveInWorkspace(workspaceRoot, rel, { mustExist: true }),
  }).catch(
    (err): McpRegistry => ({
      ...empty,
      failures: [{ server: MCP_CONFIG, reason: err instanceof Error ? err.message : String(err) }],
    }),
  )
}

/** 一个 server 在配置里来自哪一层。设置页据此决定开关归谁、能不能改。 */
export interface ScopedMcpConfig extends McpConfig {
  scopeOf: Record<string, Scope>
  /** 每一层的文件路径，存在与否都列出来——「该去哪儿加」比「这里没有」有用。 */
  files: { scope: Scope; path: string }[]
}

/**
 * 三层的 `mcp.json` 合成一份。
 *
 * **加载器和设置页共用它**：页面上列出来的 server，必须就是模型真的连上的那批。
 */
export async function loadScopedMcpConfig(
  workspaceRoot: string,
  opts: { scopes?: readonly Scope[] } = {},
): Promise<ScopedMcpConfig> {
  const servers: ScopedMcpConfig['servers'] = {}
  const scopeOf: Record<string, Scope> = {}
  const files: { scope: Scope; path: string }[] = []
  const errors: string[] = []

  for (const { scope, dir } of scopePaths(scopeRoots(workspaceRoot), '')) {
    if (opts.scopes && !opts.scopes.includes(scope)) continue
    const path = join(dir, MCP_FILE)
    files.push({ scope, path })
    const raw = await readFile(path, 'utf8').catch(() => null)
    if (raw === null) continue
    const parsed = parseMcpConfig(raw)
    if (parsed.error) {
      errors.push(`${path}：${parsed.error}`)
      continue
    }
    for (const [name, spec] of Object.entries(parsed.servers)) {
      if (name in servers) continue
      servers[name] = spec
      scopeOf[name] = scope
    }
  }

  return { servers, scopeOf, files, error: errors.length ? errors.join('\n') : null }
}

/**
 * 读工作区的 team 配置。
 *
 * 这里只有**角色（子 agent）与编排图**。外部 CLI 不进这个文件：它由本机探测得到
 * （`@qywork/team` 的 `detectClis`），编排图里用 `cli:<id>` 指向它。
 */
export async function loadTeamConfig(workspaceRoot: string): Promise<WorkspaceTeamConfig> {
  const empty: WorkspaceTeamConfig = { roles: [], rules: {}, error: null }
  const raw = await readFile(join(workspaceRoot, TEAM_CONFIG), 'utf8').catch(() => null)
  if (raw === null) return empty

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    // 配置坏了要**说出来**。静默当作「没配 team」，界面上等同于这个功能不存在。
    return { ...empty, error: `${TEAM_CONFIG} 解析失败：${String(err)}` }
  }

  const obj = (parsed ?? {}) as Record<string, unknown>

  const roles: Role[] = []
  for (const value of (obj.roles as unknown[]) ?? []) {
    const r = value as Record<string, unknown>
    const id = String(r.id ?? '').trim()
    // 只要有 id 就收：角色不再引用别的条目，也就没有「引用不到」这回事。
    if (!id) continue
    roles.push({
      id,
      name: String(r.name ?? id),
      description: String(r.description ?? ''),
      systemPrompt: String(r.systemPrompt ?? ''),
      ...(r.provider ? { provider: String(r.provider) } : {}),
      ...(r.model ? { model: String(r.model) } : {}),
      ...(r.effort ? { effort: r.effort as NonNullable<Role['effort']> } : {}),
      // allowedTools 的空数组与不填**语义不同**（前者=不给任何工具，后者=继承全部），
      // 所以只在字段真的存在时才写入。
      ...(Array.isArray(r.allowedTools) ? { allowedTools: r.allowedTools.map(String) } : {}),
    })
  }

  // 编排图不在这个文件里：它由模型每次现画（`workflow` 工具），跑完随那次工具调用
  // 的结果落库。留一个手写的 `plan` 字段就是两个来源同一个执行器。
  const dropped = ((obj.roles as unknown[]) ?? []).length - roles.length

  // rules 只认 `shared`：并发上限由 workflow 每次调用给，这个文件里写不了它。
  const shared = (obj.rules as TeamRules | undefined)?.shared
  return {
    roles,
    rules: shared ? { shared } : {},
    error: dropped > 0 ? `${dropped} 条角色少了 id，已忽略` : null,
  }
}

/**
 * 工具名前缀，转出给 CLI 用。
 *
 * CLI 不直接依赖 `@qywork/mcp` / `@qywork/plugins`（依赖图里它只挂 runtime），
 * 但 `qy mcp` / `qy doctor` / `qy plugins` 都要按前缀数「这个 server / 插件贡献了
 * 几个工具」。三处原本各自拼 `mcp__${name}__` / `${id}__`，**都没消毒**，
 * 带点的名字一条都匹配不上，体检结果直接骗人。转出来是为了只有一份实现。
 */
export { pluginToolPrefix, toolNamePrefix }
