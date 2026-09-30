/**
 * 扩展装配：插件与 Agent Team 后端的加载入口。
 *
 * **库存在不等于功能存在**：`loadPlugins()` 只有定义处一个引用、`teamBackends`
 * 在握手里硬编码成 `[]` 的话，两样都等于没有。而握手里报假的能力清单比不报更糟
 * ——客户端会据此做出「隐藏入口」的正确行为，接线之后反而找不到 bug。
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
  mcp: Omit<McpRegistry, 'stopAll'>
  mcpConfig: ScopedMcpConfig
  /** 插件与 MCP 一起贡献的工具规格，已按名去重。由会话注册进自己的表。 */
  toolSpecs: ToolSpec[]
  /** 关掉本份扩展持有的全部子进程。 */
  stop(): Promise<void>
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

/** 全局修改刷新已缓存工作区；项目覆盖使有效配置未变时保留原连接。 */
export async function refreshExtensions(
  workspaceRoot: string,
  global: boolean,
  retryNames: readonly string[] = [],
): Promise<void> {
  const entries = [...shared.values()].filter(
    (entry) => global || cacheKey(entry.root) === cacheKey(workspaceRoot),
  )
  for (const entry of entries) {
    const lease = await acquireExtensions(entry.root, undefined, false, retryNames)
    await lease.stop()
  }
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
 * 读工作区的 team 配置。
 *
 * 这里只有**角色（子 agent）与编排图**。外部 CLI 不进这个文件：它由本机探测得到
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
