/**
 * 扩展装配：插件与 Agent Team 后端的加载入口。
 *
 * 这两样此前都写好了库但**从没被调用过**——`loadPlugins()` 全项目只有定义处
 * 一个引用，`teamBackends` 在握手里是硬编码的 `[]`。库存在不等于功能存在，
 * 而握手里报假的能力清单比不报更糟：客户端会据此做出「隐藏入口」的正确行为，
 * 接线之后反而找不到 bug。
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
import {
  type Backend,
  type BuiltinBackend,
  CLI_PRESETS,
  type CliBackend,
  type PlanNode,
  type Role,
  type TeamRules,
} from '@qywork/team'
import { AGENTS_DIR, resolveInWorkspace, type Scope, scopePaths, scopeRoots } from '@qywork/tools'
import { makeCapabilityHandler } from './capabilities.ts'

/** 各层根目录下的子路径。三层都按这几个名字找。 */
export const PLUGINS_SUBDIR = 'plugins'
export const MCP_FILE = 'mcp.json'

/** 用户层（工作区 `.agents/`）里的位置。安装、写回、报路径用它们。 */
export const PLUGINS_DIR = `${AGENTS_DIR}/${PLUGINS_SUBDIR}`
export const MCP_CONFIG = `${AGENTS_DIR}/${MCP_FILE}`

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
  backends: Record<string, Backend>
  roles: Role[]
  plan: PlanNode[]
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
  const plugins = await loadScopedPlugins(workspaceRoot, onLog)

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

/** 进程退出前收掉所有扩展。只给 CLI / 测试用。 */
export function releaseAllExtensions(): void {
  for (const root of [...shared.keys()]) {
    const entry = shared.get(root)
    shared.delete(root)
    void entry?.promise.then((ext) => ext.stop()).catch(() => {})
  }
}

/**
 * 三层的插件目录合起来，同 id 只留优先级最高的那份。
 *
 * `loadPlugins` 一次只认一个目录，所以这里逐层调用再合并。合并按 **id** 去重，
 * 不是按目录——两个层里同名的插件是一个东西的两份，装两遍会让工具名撞车，
 * 而撞车的表现是「有一个插件的工具凭空消失」。
 */
async function loadScopedPlugins(
  workspaceRoot: string,
  onLog?: (line: string) => void,
): Promise<PluginRegistry> {
  const merged: PluginRegistry = {
    plugins: [],
    previewers: new Map(),
    roles: new Map(),
    providers: new Map(),
    toolSpecs: [],
    failures: [],
  }
  const seen = new Set<string>()
  const takenTools = new Set<string>()

  for (const { dir } of scopePaths(scopeRoots(workspaceRoot), PLUGINS_SUBDIR)) {
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

    merged.failures.push(...reg.failures)
    for (const pl of reg.plugins) {
      const id = pl.manifest.id
      if (seen.has(id)) {
        // 说出来而不是安静丢掉：「我在全局装了但没生效」否则查不出原因。
        merged.failures.push({ dir, reason: `插件 ${id} 已被更高优先级的层提供，这一份被忽略` })
        continue
      }
      seen.add(id)
      merged.plugins.push(pl)
    }
    // 工具按**名字**去重，不按插件 id 前缀：注册名是消毒过的
    //（`test.probe` → `test_probe__probe`），按 id 拼前缀会一个都匹配不上。
    // 名字唯一本来就是硬约束，这里和 `loadExtensions` 合并 MCP 时同一个口径。
    for (const spec of reg.toolSpecs) {
      if (takenTools.has(spec.name)) {
        merged.failures.push({ dir, reason: `工具名已被更高优先级的层占用：${spec.name}` })
        continue
      }
      takenTools.add(spec.name)
      merged.toolSpecs.push(spec)
    }
    for (const [k, v] of reg.previewers) if (!merged.previewers.has(k)) merged.previewers.set(k, v)
    for (const [k, v] of reg.roles) if (!merged.roles.has(k)) merged.roles.set(k, v)
    for (const [k, v] of reg.providers) if (!merged.providers.has(k)) merged.providers.set(k, v)
  }
  return merged
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

  const config = await loadScopedMcpConfig(workspaceRoot)
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
 * 后端 = 外部 CLI（codex / claude / 自己的 qy）。**不内置各家的参数表**——
 * 它们各自演进，写死必然过期，而过期的表现是「昨天还能用今天报错」。
 * `CLI_PRESETS` 只作为 UI 预填的示例，用户配置才是权威。
 */
export async function loadTeamConfig(workspaceRoot: string): Promise<WorkspaceTeamConfig> {
  const empty: WorkspaceTeamConfig = { backends: {}, roles: [], plan: [], rules: {}, error: null }
  const raw = await readFile(join(workspaceRoot, TEAM_CONFIG), 'utf8').catch(() => null)
  if (raw === null) return empty

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    // 配置坏了要**说出来**。静默当作「没配 team」会让用户以为功能不存在。
    return { ...empty, error: `${TEAM_CONFIG} 解析失败：${String(err)}` }
  }

  const obj = (parsed ?? {}) as Record<string, unknown>
  const backends: Record<string, Backend> = {}
  for (const [id, value] of Object.entries((obj.backends as Record<string, unknown>) ?? {})) {
    const b = value as Record<string, unknown>

    // 内置后端：用本进程的 agent 跑，不需要机器上装任何外部 CLI。
    // 判据是显式的 kind，不是「没写 command 就当内置」——后者会把
    // 一条写漏了 command 的 CLI 配置默默变成内置，跑出来的东西完全不是用户要的。
    if (b.kind === 'builtin') {
      const builtin: BuiltinBackend = { kind: 'builtin' }
      if (b.provider) builtin.provider = String(b.provider)
      if (b.model) builtin.model = String(b.model)
      if (b.effort) builtin.effort = b.effort as NonNullable<BuiltinBackend['effort']>
      backends[id] = builtin
      continue
    }

    // preset 只做**默认值**，用户写的字段永远覆盖它。
    const preset = typeof b.preset === 'string' ? CLI_PRESETS[b.preset] : undefined
    const command = String(b.command ?? preset?.command ?? '')
    if (!command) continue
    backends[id] = {
      kind: 'cli',
      command,
      args: (b.args as string[]) ?? preset?.args ?? [],
      output: (b.output as CliBackend['output']) ?? preset?.output ?? 'text',
      ...(b.resultField || preset?.resultField
        ? { resultField: String(b.resultField ?? preset?.resultField) }
        : {}),
      ...(b.cwd ? { cwd: String(b.cwd) } : {}),
      ...(b.env ? { env: b.env as Record<string, string> } : {}),
      ...(b.timeoutMs ? { timeoutMs: Number(b.timeoutMs) } : {}),
    }
  }

  const roles: Role[] = []
  for (const value of (obj.roles as unknown[]) ?? []) {
    const r = value as Record<string, unknown>
    const id = String(r.id ?? '').trim()
    const backendId = String(r.backend ?? '').trim()
    const backend = backends[backendId]
    // 角色指向一个不存在的后端时**丢弃并记录**，不静默保留——
    // 保留下来会在编排时才失败，那时已经跑了一半。
    if (!id || !backend) continue
    roles.push({
      id,
      name: String(r.name ?? id),
      description: String(r.description ?? ''),
      systemPrompt: String(r.systemPrompt ?? ''),
      backend,
      // allowedTools 的空数组与不填**语义不同**（前者=不给任何工具，后者=继承全部），
      // 所以只在字段真的存在时才写入。
      ...(Array.isArray(r.allowedTools) ? { allowedTools: r.allowedTools.map(String) } : {}),
      ...(r.maxSteps ? { maxSteps: Number(r.maxSteps) } : {}),
    })
  }

  const plan: PlanNode[] = []
  const roleIds = new Set(roles.map((r) => r.id))
  for (const value of (obj.plan as unknown[]) ?? []) {
    const n = value as Record<string, unknown>
    const id = String(n.id ?? '').trim()
    const roleId = String(n.roleId ?? '').trim()
    if (!id || !roleIds.has(roleId)) continue
    plan.push({
      id,
      roleId,
      task: String(n.task ?? ''),
      ...(Array.isArray(n.needs) ? { needs: n.needs.map(String) } : {}),
      ...(n.passInput === false ? { passInput: false } : {}),
    })
  }

  const dropped =
    ((obj.roles as unknown[]) ?? []).length -
    roles.length +
    (((obj.plan as unknown[]) ?? []).length - plan.length)

  return {
    backends,
    roles,
    plan,
    rules: (obj.rules as TeamRules) ?? {},
    error: dropped > 0 ? `${dropped} 项配置引用了不存在的后端或角色，已忽略` : null,
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
