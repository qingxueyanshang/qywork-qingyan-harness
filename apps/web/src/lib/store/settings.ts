/**
 * 设置面：模型配置、工作区、插件、定时任务、team.json。
 *
 * 全是「打开某个面板才会用到」的请求，与主链路无关，所以单独一块——
 * 它们加起来比会话链路还长，混在一起会让读 store 的人以为这些是热路径。
 */

import type { Attachment, EffortLevel, PermissionMode } from '@qywork/core'
import { client } from './connection.ts'
import type { WorkspaceInfo } from './ui.ts'

// ───────────────────────── 配置 ─────────────────────────

/** 指向一个具体模型的二元指针。模型 id 本身含斜杠，所以不能拼成一个串。 */
export interface ModelRef {
  provider: string
  model: string
}

/** 一个模型在这个接口下的那一格。 */
export interface RedactedModel {
  maxOutputTokens?: number
  /** 保存时原样回传，避免把探测的实测结果洗掉。 */
  capabilities?: unknown
  /**
   * 用户为这个模型选定的思考档。
   *
   * 和 `capabilities` 一样住在这一格：档位集合逐模型不同，全局一个值在
   * Claude 上选的 `xhigh` 换到 DeepSeek 就是个它没有的档。
   */
  effort?: EffortLevel
}

/** 接口的对外形状：明文 key 不出服务进程，只回「有没有」。 */
export interface RedactedProvider {
  kind: string
  baseUrl?: string
  headers?: Record<string, string>
  models: Record<string, RedactedModel>
  hasApiKey: boolean
  /**
   * **只写。** 读接口永远不回它（回的是上面那个 `hasApiKey`），
   * 只有用户在设置里真的敲了新 key 时才带上；不带 = 沿用服务端已有的那份。
   *
   * 之前这个键没写进类型，改 key 的地方只能 `as Partial<...>` 硬转——
   * 转过去之后拼错键名也不会报错，而拼错的后果是保存成功、key 没变、
   * 下一次调模型才炸。写进类型是为了让编译器接着管这一格。
   */
  apiKey?: string
}
/**
 * 服务端配置的对外形状。**这是一份手抄，而且是故意抄不全的。**
 *
 * 抄是因为够不着：真源 `QyConfig` 在 `@qywork/runtime`(L5)，界面只依赖
 * `@qywork/core`(L0)。抄不全是因为 `sandboxNetwork` 只有内核沙箱的平台上才生效，
 * Windows 上画个开关等于画个假的（见 CLAUDE.md B5）。
 *
 * 所以这里少一个字段是有意的，**但它不能因此在保存时被抹掉**：保存走的是
 * 整份 PUT，服务端 `mergeConfig` 靠 `{ ...current, ...incoming }` 保住客户端
 * 不认识的键。那条语义由 `server/src/api/config.test.ts`「客户端不认识的顶层
 * 字段不会被抹掉」钉住——改这里之前先看那条。
 */
/** 用户在模型库里改过的模型参数。键是模型 id——参数是模型的属性，与接口无关。 */
export interface CatalogEntry {
  displayName?: string
  vendor?: string
  contextWindow?: number
  maxOutputTokens?: number
  /** 思考怎么发。`qy probe --save` 写这里，用户也能在模型库里改。 */
  thinking?: string
  /** 不选档时发不发思考。 */
  thinksByDefault?: boolean
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  currency?: 'USD' | 'CNY'
}

export interface RedactedConfig {
  active: ModelRef
  providers: Record<string, RedactedProvider>
  /** 模型库里改过的那些条目。没改过的不在这里——它们的真源是内置目录。 */
  catalog?: Record<string, CatalogEntry>
  // 思考档位**不在顶层**：它是「接口 × 模型」那一格的属性，见 `RedactedModel.effort`。
  mode?: PermissionMode
  additionalDirectories?: string[]
  envAllowList?: string[]
}
export interface ConfigPayload {
  path: string
  config: RedactedConfig
  notices: string[]
  problems: string[]
}

export function loadServerConfig(): Promise<ConfigPayload> {
  return client.api<ConfigPayload>('/api/config')
}

/**
 * 把 `client.api` 抛出来的错误还原成人能读的一句话。
 *
 * `client.api` 的消息是 `<状态码> <路径>: <响应体前 200 字>`——响应体是 JSON。
 * 原样显示等于把接口细节甩给用户。这里只取其中真正说明原因的字段
 * （`problems` 数组或 `message`），取不到才回落到原文——**回落到原文而不是
 * 一句「操作失败」**：原文再难看也带着信息，泛化的失败提示一点都不带。
 */
export function explainApiError(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : String(e)
  const at = raw.indexOf('{')
  if (at >= 0) {
    try {
      const body = JSON.parse(raw.slice(at)) as {
        problems?: string[]
        message?: string
        error?: string
      }
      if (body.problems?.length) return body.problems.join('；')
      if (body.message) return body.message
      // 服务端多数错误只带 `error` 一个键（`api/types.ts` 的 `json`）。不认它的话
      // 界面上显示的是「422 /api/xxx: {"error":"标题不能为空"}」这种原样回显。
      if (body.error) return body.error
    } catch {
      // 响应体被 client.api 截断到 200 字时会解析失败，走回落。
    }
  }
  return raw || fallback
}

/**
 * 保存配置。
 *
 * 服务端会先 `diagnoseConfig` 再落盘，有致命问题回 422 且**不写**。
 *
 * 422 由 `client.api` 抛成 `Error`，消息形如
 * `422 /api/config: {"error":"invalid","problems":[...]}`——直接显示给用户
 * 是一串原始 JSON。这里把 `problems` 挖出来还原成人话：保存失败必须说清
 * **哪一条**不合格，「保存失败」和一坨 JSON 是同一个层次的不可用。
 */
export async function saveServerConfig(config: RedactedConfig): Promise<ConfigPayload> {
  try {
    await client.api<{ ok: boolean }>('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ config }),
    })
  } catch (e) {
    throw new Error(explainApiError(e, '保存失败'))
  }
  return loadServerConfig()
}

/**
 * 切换权限模式。
 *
 * 走 `/api/config` 这条**已有的**写入路径，不新开接口：配置的真源是那一个
 * `config.json`，多一条写入路径就多一本账。代价是要先读一次全量再写回去——
 * 一次多余的往返，换掉「两个地方都能写同一个文件」这种必然漂移的结构。
 *
 * 写成功后就地更新握手带来的 `capabilities.mode`：服务端只在握手时报一次，
 * 不这么做的话按钮点完不变，看起来像没生效。
 */
export async function setPermissionMode(mode: PermissionMode): Promise<void> {
  const payload = await loadServerConfig()
  await saveServerConfig({ ...payload.config, mode })
}

// ───────────────────────── 测连接 ─────────────────────────

/**
 * 一次探测的结果。
 *
 * `probes` 是**每一步的原始结论**，不只是最后那个总结。结论错了要能查——
 * 只给「支持思考：是」的话，错了没有任何线索。
 *
 * `detail` 由服务端脱敏后才下发：它是 provider 的原始错误消息，可能回显
 * 请求 URL 甚至凭证。
 */
export interface ProbeStep {
  name: string
  ok: boolean
  detail: string
  /** true = 这一步没有真的验证任何东西（本协议下客户端不发这个字段）。 */
  skipped?: boolean
}
export interface ProbeOutcome {
  reachable: boolean
  thinking: string | null
  /** 本协议下无从探测的轴。**与「探了、被拒了」不是一回事**，不能合并显示。 */
  untested: ('thinking' | 'effort')[]
  effortLevels: EffortLevel[]
  thinksByDefault: boolean
  probes: ProbeStep[]
}
export interface ProbeResult {
  outcome: ProbeOutcome
  /** 可以安全写回配置的那一部分，没探过的轴一条都不含。 */
  capabilities: Record<string, unknown>
}

/**
 * 实测这个接口下的这个模型。
 *
 * **探的是落盘配置**，不是界面上的草稿：请求体只带名字，key 由服务端自己取。
 * 允许探草稿就得让端点接收临时明文 key，等于多开一条 key 上行路径。
 *
 * 会真的发几个请求（每个 ≤16 token），所以只由用户点按钮触发。
 */
export function probeModel(
  provider: string,
  model: string,
  mode: 'reachability' | 'full',
): Promise<ProbeResult> {
  return scheduleWrite('/api/probe', {
    method: 'POST',
    body: JSON.stringify({ provider, model, mode }),
  })
}

export function loadWorkspace(): Promise<WorkspaceInfo> {
  return client.api<WorkspaceInfo>('/api/workspace')
}

/**
 * 本机已知的工作区列表（账本里出现过的）。
 *
 * 用来做「最近打开」——不必每次都开目录选择器翻一遍。
 */
export interface KnownWorkspace {
  id: string
  rootPath: string
  name: string
  lastOpenedAt: number
  /** 它下面挂着几条会话。口径与会话列表一致：不含机器会话，不含已归档。 */
  conversations: number
  /** 置顶时间。没有这个键 = 没置顶。置顶的排在列表最前。 */
  pinnedAt?: number
}
export function loadKnownWorkspaces(): Promise<{ workspaces: KnownWorkspace[] }> {
  return client.api<{ workspaces: KnownWorkspace[] }>('/api/workspaces')
}

/**
 * 把一个项目从列表里移除。
 *
 * **这是隐藏，不是删除。** 服务端只打 `removed_at` 标记：文件、会话、消息、run
 * 一条不动，重新添加同一个路径就整个回来。目录本身当然也不动——账本管的是
 * 「我开过哪些项目」，不是那些文件。
 *
 * **当前项目也能移除**，只要还剩别的可切；服务端会在 `next` 里回「接下来切哪个」。
 * 只有最后一个才移不掉（回 409）——移完没有任何项目可服务，那不是一个有终态的状态。
 */
export function removeKnownWorkspace(
  id: string,
): Promise<{ ok: boolean; next?: { id: string; rootPath: string } }> {
  return client.api<{ ok: boolean; next?: { id: string; rootPath: string } }>(
    `/api/workspaces/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
}

/**
 * 置顶 / 取消置顶。目标状态由调用方给，不是「翻转」——翻转在并发下会翻错方向。
 */
export function pinKnownWorkspace(id: string, pinned: boolean): Promise<{ ok: boolean }> {
  return client.api<{ ok: boolean }>(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned }),
  })
}

/**
 * 归档这个项目当前的全部会话：**从会话列表里去掉，数据不动**，
 * 此后新建的照常显示。
 *
 * 回的是归档条数而不是一个布尔——「0 条」和「成功」在界面上必须能分开。
 */
export function archiveWorkspaceChats(id: string): Promise<{ archived: number }> {
  return client.api<{ archived: number }>(`/api/workspaces/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
  })
}

/**
 * 在系统文件管理器里定位这个项目的目录。
 *
 * 只有桌面外壳有这个能力（走 Rust 侧的 `reveal_workspace`）。浏览器 / 手机端
 * 拿不到，所以那边**不显示这个入口**，而不是显示一个点了报错的按钮（B5）。
 */
export function revealWorkspace(path: string): Promise<void> {
  return tauriInvoke<void>('reveal_workspace', { path })
}

/**
 * 把一个本机目录加成项目，并把它顶成「最近打开」。
 *
 * **加和切是同一条路**：服务端 upsert，已有就更新 `last_opened_at`，没有就插一行。
 * 分成两个端点等于两条路写同一个字段，而那个字段正是 git 轮询和缺省 `?ws=` 的判据。
 */
export function addWorkspace(input: {
  /** 本机已存在的目录。不给就在 `~/.qywork/workspaces/<name>/` 建一个。 */
  path?: string
  /** 显示名。不给且给了 `path` 时取目录名。两个都不给回 422。 */
  name?: string
}): Promise<{ workspace: KnownWorkspace }> {
  return client.api<{ workspace: KnownWorkspace }>('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/**
 * 这个项目上装了什么。
 *
 * **按项目拉，不从握手拿**：三份清单都配在项目目录下，而一条连接横跨用户
 * 同时开着的所有项目——握手报一份就等于「A 项目的插件显示在 B 项目上」。
 */
export interface WorkspaceExtensions {
  plugins: string[]
  teamBackends: string[]
  mcpServers: string[]
}
export function loadWorkspaceExtensions(): Promise<WorkspaceExtensions> {
  return client.api<WorkspaceExtensions>('/api/capabilities')
}

// ───────────────────────── 插件安装 ─────────────────────────

/**
 * 装一个插件 = 把一个**本机已存在的目录**复制进那一层的 `plugins/`。
 *
 * 没有 registry，所以没有「从市场安装」；也刻意不做 `git clone <任意 URL>`——
 * 那等于「从网上取一段代码，下次加载就跑它」。用户先自己 clone、看过内容，
 * 再把目录指给这里，中间那一步「你看到了自己装的是什么」值这条命令的成本。
 */
/** 插件只有全局一个目录，所以装 / 卸都不带层。 */
export function installPlugin(path: string): Promise<{ ok: boolean; id: string }> {
  return scheduleWrite('/api/plugins/install', {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
}
export function uninstallPlugin(id: string): Promise<{ ok: boolean }> {
  return scheduleWrite(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ───────────────────────── 桌面外壳 ─────────────────────────

/**
 * 桌面外壳才有的能力：系统目录选择器、窗口控制。
 *
 * **换项目不在这个名单里**：服务端一次服务多个项目，换项目只是换一个 `?ws=`
 * 参数，浏览器和手机上照样能换。这里只剩「挑一个本机目录」需要外壳——
 * 那是系统对话框，Web 拿不到。
 */
export function isDesktopShell(): boolean {
  return typeof (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ === 'object'
}

interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
  /** 把一个 JS 回调换成 Rust 那边能 emit 回来的数字句柄。 */
  transformCallback(cb: (payload: unknown) => void, once?: boolean): number
}

function internals(): TauriInternals | undefined {
  return (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ as TauriInternals | undefined
}

export function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const api = internals()
  if (!api) return Promise.reject(new Error('不在桌面端，用不了这个能力'))
  return api.invoke(cmd, args) as Promise<T>
}

/**
 * 订阅一个 Rust 侧 emit 的事件。
 *
 * 走 `plugin:event|listen` 这条内部通道，而不是引 `@tauri-apps/api`：
 * 前端这份代码桌面与手机共用，多引一个只有桌面能用的包，手机端的构建里
 * 就会多出一坨永远不执行的东西（同 `lib.rs` 里那几个窗口命令的理由）。
 *
 * **不给退订**：现在的调用方都是「开一次听到进程结束」的常驻订阅，
 * 加一个没人调的退订接口只会让人以为该配对使用。真需要时再补。
 */
export function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<void> {
  const api = internals()
  if (!api) return Promise.reject(new Error('不在桌面端，用不了这个能力'))
  const id = api.transformCallback((raw) => handler((raw as { payload: T }).payload))
  return api.invoke('plugin:event|listen', {
    event,
    target: { kind: 'Any' },
    handler: id,
  }) as Promise<void>
}

/** 打开系统目录选择器。用户取消时返回 null——取消不是错误。 */
export function pickWorkspace(): Promise<string | null> {
  return tauriInvoke<string | null>('pick_workspace')
}

/**
 * 把文件监听改到这个项目的目录上。
 *
 * 换项目本身不需要外壳，但**文件监听需要**：notify 的句柄在 Rust 侧。
 * 不改的话，切到 B 之后外部编辑器改 B 的文件不会推事件——而界面看起来一切正常，
 * 只是永远不刷新，这种「安静的不工作」最难被发现。
 */
export function watchWorkspace(path: string): Promise<void> {
  return tauriInvoke<void>('watch_workspace', { path })
}

// ───────────────────────── 定时任务 ─────────────────────────

export interface ScheduleItem {
  id: string
  title: string
  prompt: string
  kind: 'interval' | 'daily'
  everyMinutes?: number
  atHour?: number
  atMinute?: number
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  lastRunConversationId?: string
  lastError?: string
  nextRunAt: number | null
  due: boolean
}
export interface SchedulesPayload {
  schedules: ScheduleItem[]
  /** 由服务端下发而不是每个客户端各写一遍：这是功能前提，不是补充说明。 */
  runtimeOnly: string
}

export function loadSchedules(): Promise<SchedulesPayload> {
  return client.api<SchedulesPayload>('/api/schedules')
}

async function scheduleWrite<T>(path: string, init: RequestInit): Promise<T> {
  try {
    return await client.api<T>(path, init)
  } catch (e) {
    throw new Error(explainApiError(e, '操作失败'))
  }
}

export function createSchedule(s: Partial<ScheduleItem>): Promise<{ schedule: ScheduleItem }> {
  return scheduleWrite('/api/schedules', { method: 'POST', body: JSON.stringify(s) })
}
export function updateSchedule(
  id: string,
  s: Partial<ScheduleItem>,
): Promise<{ schedule: ScheduleItem }> {
  return scheduleWrite(`/api/schedules/${id}`, { method: 'PUT', body: JSON.stringify(s) })
}
export function deleteSchedule(id: string): Promise<{ ok: boolean }> {
  return scheduleWrite(`/api/schedules/${id}`, { method: 'DELETE' })
}
/** 立刻跑一次。**不推进** lastRunAt——试跑不该顶掉当天的自动触发。 */
export function runScheduleNow(id: string): Promise<{ ok: boolean; conversationId: string }> {
  return scheduleWrite(`/api/schedules/${id}/run`, { method: 'POST' })
}

export interface TeamRaw {
  path: string
  exists: boolean
  raw: string
}
export function loadTeamRaw(): Promise<TeamRaw> {
  return client.api<TeamRaw>('/api/team/raw')
}
export async function saveTeamRaw(raw: string): Promise<{ ok: boolean }> {
  try {
    return await client.api<{ ok: boolean }>('/api/team/raw', {
      method: 'PUT',
      body: JSON.stringify({ raw }),
    })
  } catch (e) {
    throw new Error(explainApiError(e, '保存失败'))
  }
}

// ───────────────────────── 记忆与技能 ─────────────────────────

// 记忆是 `<作用域>/memory/*.md`，技能是 `<作用域>/skills/<name>/`，都是普通文件。
// agent 通过工具随时能写，所以人在界面上也要看得到、删得掉——这一组补的是那条不对称。

/**
 * 一条记忆 / 技能 / MCP / 插件来自哪一层。
 *
 * - `builtin` 随程序发布，只读，**用户看不到**（服务端现在也还没有内容）。
 * - `project` 是工作区 `.agents/`，跟着这个仓库走，别的 CLI 也读得到。
 * - `global` 是 `~/.qywork/`，跨工作区。
 *
 * 优先级 `builtin > project > global`，同名先认领的赢。**解析在服务端做**——
 * 界面上列出来的那条必须就是模型真的加载的那条，前端不许自己再算一遍。
 */
export type Scope = 'builtin' | 'project' | 'global'

/**
 * 可写的两层，顺序即界面上标签页的顺序。内置随程序发布，写进去下次升级就没了。
 *
 * **标签只有这一份**：写死在各页里的话，同一个层在记忆页叫一个名字、
 * 在 MCP 页叫另一个名字，而用户没法知道它们是同一层。
 */
export const WRITABLE_SCOPES: { id: Scope; label: string }[] = [
  { id: 'project', label: '项目' },
  { id: 'global', label: '全局' },
]

export interface ScopeDir {
  scope: Scope
  dir: string
}

export interface MemoryEntry {
  key: string
  preview: string
  scope: Scope
  /**
   * 盖住它的那一层，没被盖住时是 null。
   *
   * 列表回的是**全部层的全部条目**，不是去重后的那一份——设置页按层分列，
   * 去重会让被项目层盖住的那条全局记忆从界面上消失。哪条真正生效看这个字段。
   */
  shadowedBy: Scope | null
}
export function loadMemory(): Promise<{ dirs: ScopeDir[]; entries: MemoryEntry[] }> {
  return client.api<{ dirs: ScopeDir[]; entries: MemoryEntry[] }>('/api/memory')
}
/**
 * 读一条记忆的**全文**。
 *
 * 列表只回首行摘要，够渲染列表、不够编辑。编辑器必须走这条——
 * 拿摘要去填编辑框，用户不改字点一下保存就把正文截成一行了。
 *
 * **必须带层**：同一个 key 在两层里各有一份，不带层拿到的是优先级高的那份，
 * 而编辑框接着会把它存回用户点开的那一层。
 */
export function loadMemoryEntry(
  key: string,
  scope: Scope,
): Promise<{ key: string; content: string; scope: Scope }> {
  return client.api<{ key: string; content: string; scope: Scope }>(
    `/api/memory/${encodeURIComponent(key)}?scope=${scope}`,
  )
}
export function saveMemory(key: string, content: string, scope: Scope): Promise<{ ok: boolean }> {
  return scheduleWrite(`/api/memory/${encodeURIComponent(key)}?scope=${scope}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
}
export function deleteMemory(key: string, scope: Scope): Promise<{ ok: boolean }> {
  return scheduleWrite(`/api/memory/${encodeURIComponent(key)}?scope=${scope}`, {
    method: 'DELETE',
  })
}

export interface SkillMeta {
  name: string
  description: string
  /** 技能目录的绝对路径。技能只读，用户得知道去哪儿改。 */
  dir: string
  scope: Scope
  /** 盖住它的那一层。同名技能只有优先级最高的那个会被加载。 */
  shadowedBy: Scope | null
}
export function loadSkills(): Promise<{ dirs: ScopeDir[]; skills: SkillMeta[] }> {
  return client.api<{ dirs: ScopeDir[]; skills: SkillMeta[] }>('/api/skills')
}

// ───────────────────────── MCP ─────────────────────────

/**
 * 已连上的 server 与它们给出的工具。
 *
 * `failures` 和 `unsupported` 与成功项一起回：一个只提供 prompts 的 server 会
 * 连上、握手成功、注册 0 个工具、不报任何错——「配了但什么都没发生」是这一页
 * 最需要显示出来的状态。
 */
export interface McpServerRow {
  name: string
  scope: Scope
  serverInfo: { name?: string; version?: string }
  protocolVersion: string
  unsupported: string[]
  tools: { name: string; description: string }[]
}
export interface McpPayload {
  configPath: string
  files: { scope: Scope; path: string }[]
  servers: McpServerRow[]
  failures: { server: string; reason: string }[]
  /** 配置里有、但这一轮没连上的。不列的话它们凭空消失。 */
  configured: { name: string; scope: Scope }[]
  error: string | null
}
export function loadMcp(): Promise<McpPayload> {
  return client.api<McpPayload>('/api/mcp')
}
export function loadMcpRaw(
  scope: Scope,
): Promise<{ path: string; exists: boolean; raw: string; scope: Scope }> {
  return client.api<{ path: string; exists: boolean; raw: string; scope: Scope }>(
    `/api/mcp/raw?scope=${scope}`,
  )
}
export function saveMcpRaw(scope: Scope, raw: string): Promise<{ ok: boolean; path: string }> {
  return scheduleWrite(`/api/mcp/raw?scope=${scope}`, {
    method: 'PUT',
    body: JSON.stringify({ raw }),
  })
}

// ───────────────────────── 会话级开关 ─────────────────────────

/**
 * 一条可开关的条目。**只影响当前那一条会话。**
 *
 * 清单由服务端按三层解析出来，和 agent 真正加载的那份同源——前端各扫一遍
 * 就会出现「面板上关掉了，模型还在用」。内置层不在里面：用户看不见它。
 */
export interface ExtraRow {
  /** `<类目>:<标识>`。前缀就是类目。 */
  key: string
  label: string
  detail: string
  scope: Scope
  enabled: boolean
}

export async function loadExtras(conversationId: string): Promise<ExtraRow[]> {
  const r = await client.api<{ extras: ExtraRow[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/extras`,
  )
  return r.extras
}

export function setExtraEnabled(
  conversationId: string,
  key: string,
  enabled: boolean,
): Promise<{ ok: boolean }> {
  return scheduleWrite(`/api/conversations/${encodeURIComponent(conversationId)}/extras`, {
    method: 'PUT',
    body: JSON.stringify({ key, enabled }),
  })
}

// ───────────────────────── 附件 ─────────────────────────

/**
 * 上传一个附件，拿到可直接随消息发出去的 `Attachment`。
 *
 * 走原始字节而不是 base64 JSON：base64 会让传输体积涨三分之一，
 * 而这是本机回环，没有任何理由为它多付这一份。
 */
export async function uploadAttachment(file: File): Promise<Attachment> {
  const res = await client.api<{ attachment: Attachment }>('/api/attachments', {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      // 文件名可能带中文与空格，必须编码后再进 header。
      'x-attachment-name': encodeURIComponent(file.name),
    },
    body: await file.arrayBuffer(),
  })
  return res.attachment
}

// ───────────────────────── 窗口控制 ─────────────────────────

/**
 * 最小化 / 最大化 / 关闭。
 *
 * 系统装饰关掉之后这三个动作没有别的入口了。**只有桌面端有窗口**——
 * `isDesktopShell()` 为假时界面根本不渲染这组按钮，而不是渲染出来点了报错。
 */
export function windowMinimize(): Promise<void> {
  return tauriInvoke<void>('window_minimize')
}
/** 返回切换之后的状态：true = 现在是最大化。 */
export function windowToggleMaximize(): Promise<boolean> {
  return tauriInvoke<boolean>('window_toggle_maximize')
}
export function windowClose(): Promise<void> {
  return tauriInvoke<void>('window_close')
}
export function windowIsMaximized(): Promise<boolean> {
  return tauriInvoke<boolean>('window_is_maximized')
}

// ───────────────────────── 语音输入 ─────────────────────────

/**
 * 浏览器内置的语音识别构造器。
 *
 * **这条和大模型没有任何关系，也不经过服务端**——`SpeechRecognition` 是浏览器
 * 自带的能力，识别结果直接是文字，拼进草稿就完了。**后端没有 STT 通路**，
 * 别去那边找。
 *
 * 特性检测拿不到就返回 null，界面据此**不渲染那个按钮**——Tauri 的 WebView2
 * 未必带这套 API，而一个点了没反应的麦克风比没有麦克风更糟。
 */
export interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  start(): void
  stop(): void
  abort(): void
  onresult:
    | ((e: {
        resultIndex: number
        results: {
          length: number
          [i: number]: { isFinal: boolean; [j: number]: { transcript: string } }
        }
      }) => void)
    | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}

export function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = globalThis as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}
