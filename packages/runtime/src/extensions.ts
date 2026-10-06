/**
 * 扩展装配：插件与 Agent Team 后端的加载入口。
 *
 * 库存在不等于功能可用：`loadPlugins()` 若只有定义处一处引用、`teamBackends`
 * 若在握手中硬编码为 `[]`，两项功能均不存在。握手报告错误的能力清单比不报告危害更大：
 * 客户端会据此正常隐藏入口，缺陷因此无法被发现。
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
  withFileLocks,
} from '@qywork/tools'
import { makeCapabilityHandler } from './capabilities.ts'

/** 全局根目录下存放插件的子目录名。 */
export const PLUGINS_SUBDIR = 'plugins'
/** 各层根目录下的 MCP 配置文件名。三层均按该文件名查找。 */
export const MCP_FILE = 'mcp.json'

/** 项目层（工作区 `.agents/`）中 MCP 配置的位置。写回与报告路径时使用。 */
export const MCP_CONFIG = `${AGENTS_DIR}/${MCP_FILE}`

/**
 * 插件的唯一目录：`~/.qywork/plugins/`。
 *
 * 插件不分层。插件提供的是工具、预览器、供应商，这些是 agent 的能力，
 * 不是某个仓库的内容。分层会使同一个插件在两个仓库中各存一份、各自升级，
 * 且「已在全局安装却未生效」只能依靠一条 failure 文案解释。
 *
 * 项目是否加载某个插件应由开关决定，计划由工作区面板控制，
 * 而不是把插件复制两份。
 */
export function globalPluginsDir(): string {
  return join(globalScopeRoot(), PLUGINS_SUBDIR)
}

/**
 * team 配置只在工作区中保存一份，不分层。
 *
 * 它描述项目的分工：角色、后端、编排图都是项目属性，
 * 带到其他仓库会使任务派发给错误的角色。因此它保存在 `.qy/`，不进入 `.agents/`。
 */
export const TEAM_CONFIG = '.qy/team.json'

export interface Extensions {
  plugins: PluginRegistry
  team: WorkspaceTeamConfig
  mcp: Omit<McpRegistry, 'stopAll'>
  mcpConfig: ScopedMcpConfig
  /** 插件与 MCP 一起贡献的工具规格，已按名去重。由会话注册进自己的表。 */
  toolSpecs: ToolSpec[]
  /** 关闭本份扩展持有的全部子进程。 */
  stop(): Promise<void>
}

export interface WorkspaceTeamConfig {
  roles: Role[]
  rules: TeamRules
  /** 配置文件解析失败的原因。UI 须显示该原因，不能静默视为未配置。 */
  error: string | null
}

/**
 * 加载工作区扩展。
 *
 * 不抛出异常：损坏的插件或错误的 team.json 不应导致整个会话无法启动。
 * 失败信息写入返回值，交给 UI。
 */
export async function loadExtensions(
  workspaceRoot: string,
  onLog?: (line: string) => void,
): Promise<Extensions> {
  return acquireExtensions(workspaceRoot, onLog)
}

// ───────────────────────── 按工作区缓存 ─────────────────────────

interface Connection {
  fingerprint: string
  registry: McpRegistry
  refs: number
}
interface Entry {
  root: string
  key: string
  users: number
  plugins: Promise<PluginRegistry>
  connections: Map<string, Connection>
  snapshot: Omit<Extensions, 'stop'> | null
  configKey: string
}
const shared = new Map<string, Entry>()

function cacheKey(root: string): string {
  const key = `${resolve(root)}|${resolve(globalScopeRoot())}`
  return process.platform === 'win32' ? key.toLowerCase() : key
}

async function releaseConnection(connection: Connection): Promise<void> {
  connection.refs--
  if (connection.refs === 0) await connection.registry.stopAll()
}

async function refreshEntry(
  entry: Entry,
  onLog?: (line: string) => void,
  retryNames: readonly string[] = [],
): Promise<void> {
  await withFileLocks(
    [`${entry.root}/.agents/.extensions-${entry.key.replace(/[^a-z0-9]/gi, '_')}`],
    async () => {
      const config = await loadScopedMcpConfig(entry.root)
      const configKey = JSON.stringify(config)
      const retry = new Set(
        retryNames.filter((name) => entry.connections.get(name)?.registry.failures.length),
      )
      if (entry.snapshot && entry.configKey === configKey && retry.size === 0) return
      const plugins = await entry.plugins
      const connections = new Map<string, Connection>()
      const resolved = await Promise.all(
        Object.entries(config.servers)
          .filter(([, spec]) => spec.enabled !== false)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(async ([name, spec]): Promise<[string, Connection]> => {
            const fingerprint = JSON.stringify(spec)
            const prior = entry.connections.get(name)
            if (prior?.fingerprint === fingerprint && !retry.has(name)) return [name, prior]
            const registry = await loadMcpServers(
              { servers: { [name]: spec }, error: null },
              entry.root,
              {
                ...(onLog ? { onLog } : {}),
                resolveCwd: (path) => resolveInWorkspace(entry.root, path, { mustExist: true }),
              },
            )
            return [name, { fingerprint, registry, refs: 1 }]
          }),
      )
      for (const [name, connection] of resolved) connections.set(name, connection)
      const mcp: Extensions['mcp'] = {
        servers: [...connections.values()].flatMap((c) => c.registry.servers),
        failures: [...connections.values()].flatMap((c) => c.registry.failures),
        toolSpecs: [],
      }
      if (config.error) mcp.failures.push({ server: MCP_CONFIG, reason: config.error })
      const toolSpecs = [...plugins.toolSpecs]
      const taken = new Set(toolSpecs.map((t) => t.name))
      for (const [name, connection] of connections) {
        for (const spec of connection.registry.toolSpecs) {
          if (taken.has(spec.name)) {
            mcp.failures.push({ server: name, reason: `工具名冲突：${spec.name}` })
            continue
          }
          taken.add(spec.name)
          mcp.toolSpecs.push(spec)
          toolSpecs.push(spec)
        }
      }
      const retired = [...entry.connections]
        .filter(([name, value]) => connections.get(name) !== value)
        .map(([, value]) => value)
      entry.connections = connections
      entry.configKey = configKey
      entry.snapshot = {
        plugins,
        team: await loadTeamConfig(entry.root),
        mcp,
        mcpConfig: config,
        toolSpecs,
      }
      // 当前连接的持有权已转移；旧会话仍持有的连接只由它们自己的 release 关闭。
      const closed = await Promise.allSettled(retired.map(releaseConnection))
      for (const result of closed)
        if (result.status === 'rejected')
          mcp.failures.push({
            server: MCP_CONFIG,
            reason: `旧连接关闭失败：${String(result.reason)}`,
          })
    },
  )
}

/** 每次取得独立句柄。live 仅用于后台常驻持有，不固定旧 MCP 快照。 */
export async function acquireExtensions(
  workspaceRoot: string,
  onLog?: (line: string) => void,
  live = false,
  retryNames: readonly string[] = [],
): Promise<Extensions> {
  const key = cacheKey(workspaceRoot)
  let entry = shared.get(key)
  if (!entry) {
    entry = {
      root: workspaceRoot,
      key,
      users: 0,
      plugins: loadInstalledPlugins(workspaceRoot, onLog),
      connections: new Map(),
      snapshot: null,
      configKey: '',
    }
    shared.set(key, entry)
  }
  const owner = entry
  owner.users++
  let held: Connection[] = []
  let released: Promise<void> | null = null
  const release = (): Promise<void> => {
    if (released) return released
    released = (async () => {
      const results = await Promise.allSettled(held.map(releaseConnection))
      owner.users--
      if (owner.users === 0) {
        if (shared.get(key) === owner) shared.delete(key)
        results.push(
          ...(await Promise.allSettled([...owner.connections.values()].map(releaseConnection))),
        )
        for (const plugin of (await owner.plugins).plugins) plugin.host?.stop()
      }
      const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason)
      if (errors.length) throw new AggregateError(errors, '扩展资源关闭失败')
    })()
    return released
  }
  try {
    await refreshEntry(owner, onLog, retryNames)
    const snapshot = owner.snapshot!
    if (!live) {
      held = [...owner.connections.values()]
      for (const connection of held) connection.refs++
    }
    return {
      get plugins() {
        return (live ? owner.snapshot! : snapshot).plugins
      },
      get team() {
        return (live ? owner.snapshot! : snapshot).team
      },
      get mcpConfig() {
        return (live ? owner.snapshot! : snapshot).mcpConfig
      },
      get mcp() {
        return (live ? owner.snapshot! : snapshot).mcp
      },
      get toolSpecs() {
        return (live ? owner.snapshot! : snapshot).toolSpecs
      },
      stop: release,
    }
  } catch (error) {
    await release()
    throw error
  }
}

export function releaseExtensions(handle: Extensions): Promise<void> {
  return handle.stop()
}

/** 全局修改只刷新同一配置根的缓存工作区；有效配置未变时保留原连接。 */
export async function refreshExtensions(
  workspaceRoot: string,
  global: boolean,
  retryNames: readonly string[] = [],
): Promise<void> {
  const entries = [...shared.values()].filter(
    (entry) =>
      entry.key === cacheKey(entry.root) && (global || entry.key === cacheKey(workspaceRoot)),
  )
  for (const entry of entries) {
    const lease = await acquireExtensions(entry.root, undefined, false, retryNames)
    await lease.stop()
  }
}

/**
 * 安装在 `~/.qywork/plugins/` 中的插件。
 *
 * 只有这一个目录，因此不需要跨层去重：同一个 id 在同一目录下不会出现两次。
 * 工具名仍须去重：两个不同的插件可能声明同一个工具名，静默丢弃会使
 * 其中一个插件的工具无故缺失，因此冲突时记入 failure。
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

  // 工具按名称去重，不按插件 id 前缀：注册名经过规范化
  //（`test.probe` → `test_probe__probe`），按 id 拼接的前缀无法匹配任何工具。
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
 * 读取三层的 `mcp.json` 并连接其中的全部 server。
 *
 * 没有任何 server 表示未配置 MCP，返回空注册表，不是错误。
 *
 * 同名 server 以先读取的一层为准：全局配置了 `github`、工作区又配置了同名 server 时，
 * 使用工作区的配置，以此表示该项目需要连接另一个实例。
 *
 * `cwd` 仍限定在工作区内。全局配置中写了工作区外的 cwd 时加载失败，而不是放行：
 * 跨工作区的配置可以把 server 的工作目录指向任意位置，不应允许。
 */
export async function loadWorkspaceMcp(
  workspaceRoot: string,
  onLog?: (line: string) => void,
  loadedConfig?: ScopedMcpConfig,
): Promise<McpRegistry> {
  const empty: McpRegistry = {
    servers: [],
    failures: [],
    toolSpecs: [],
    stopAll: async () => {},
  }

  const config = loadedConfig ?? (await loadScopedMcpConfig(workspaceRoot))
  if (config.error) onLog?.(`[qy] ${MCP_FILE}：${config.error}`)

  if (Object.keys(config.servers).length === 0) return empty

  return loadMcpServers(config, workspaceRoot, {
    ...(onLog ? { onLog } : {}),
    // cwd 必须限定在工作区内：mcp.json 是工作区中的文件，克隆的仓库
    // 不应能把 server 的工作目录指向其他位置。
    resolveCwd: (rel) => resolveInWorkspace(workspaceRoot, rel, { mustExist: true }),
  }).catch(
    (err): McpRegistry => ({
      ...empty,
      failures: [{ server: MCP_CONFIG, reason: err instanceof Error ? err.message : String(err) }],
    }),
  )
}

/** server 在配置中所属的层。设置页据此决定开关的归属层与是否可修改。 */
export interface ScopedMcpConfig extends McpConfig {
  scopeOf: Record<string, Scope>
  /** 每一层的文件路径，无论文件是否存在都列出：用户需要知道在何处添加配置。 */
  files: { scope: Scope; path: string }[]
}

/**
 * 将三层的 `mcp.json` 合并为一份。
 *
 * 加载器与设置页共用该函数：页面上列出的 server 必须与模型实际连接的 server 一致。
 */
export async function loadScopedMcpConfig(workspaceRoot: string): Promise<ScopedMcpConfig> {
  const servers: ScopedMcpConfig['servers'] = {}
  const scopeOf: Record<string, Scope> = {}
  const files: { scope: Scope; path: string }[] = []
  const errors: string[] = []

  for (const { scope, dir } of scopePaths(scopeRoots(workspaceRoot), '')) {
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
 * 读取工作区的 team 配置。
 *
 * 此处只有角色（子 agent）与编排图。外部 CLI 不写入该文件：它由本机探测得到
 * （`@qywork/team` 的 `detectClis`），图上的节点用 kind cli 与它的 id 指向它。
 */
export async function loadTeamConfig(workspaceRoot: string): Promise<WorkspaceTeamConfig> {
  const empty: WorkspaceTeamConfig = { roles: [], rules: {}, error: null }
  const raw = await readFile(join(workspaceRoot, TEAM_CONFIG), 'utf8').catch(() => null)
  if (raw === null) return empty

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    // 配置损坏时必须报告。静默视为未配置 team 时，界面上等同于该功能不存在。
    return { ...empty, error: `${TEAM_CONFIG} 解析失败：${String(err)}` }
  }

  const obj = (parsed ?? {}) as Record<string, unknown>

  const roles: Role[] = []
  for (const value of (obj.roles as unknown[]) ?? []) {
    const r = value as Record<string, unknown>
    const id = String(r.id ?? '').trim()
    // 有 id 即接受：角色不引用其他条目，因此不存在引用缺失的情形。
    if (!id) continue
    roles.push({
      id,
      name: String(r.name ?? id),
      description: String(r.description ?? ''),
      systemPrompt: String(r.systemPrompt ?? ''),
      ...(r.provider ? { provider: String(r.provider) } : {}),
      ...(r.model ? { model: String(r.model) } : {}),
      ...(r.effort ? { effort: r.effort as NonNullable<Role['effort']> } : {}),
      // allowedTools 的空数组与不填语义不同（前者表示不提供任何工具，后者表示继承全部），
      // 因此只在字段存在时写入。
      ...(Array.isArray(r.allowedTools) ? { allowedTools: r.allowedTools.map(String) } : {}),
    })
  }

  // 编排图不在该文件中：它由模型每次即时生成（`workflow` 工具），执行完毕后随该次工具调用
  // 的结果落库。保留手写的 `plan` 字段会使同一个执行器有两个来源。
  const dropped = ((obj.roles as unknown[]) ?? []).length - roles.length

  // rules 只识别 `shared`：并发上限由每次 workflow 调用给出，无法在此文件中配置。
  const shared = (obj.rules as TeamRules | undefined)?.shared
  return {
    roles,
    rules: shared ? { shared } : {},
    error: dropped > 0 ? `${dropped} 个角色缺少 id，已忽略` : null,
  }
}

/**
 * 工具名前缀，导出供 CLI 使用。
 *
 * CLI 不直接依赖 `@qywork/mcp` / `@qywork/plugins`（依赖图中它经由 runtime 间接依赖这两个包），
 * 但 `qy mcp` / `qy doctor` / `qy plugins` 都需要按前缀统计每个 server / 插件提供的
 * 工具数。各处自行拼接 `mcp__${name}__` / `${id}__` 时未经规范化，
 * 带点的名称无法匹配任何工具，检查结果错误。因此导出，只保留一份实现。
 */
export { pluginToolPrefix, toolNamePrefix }
