/**
 * 设置相关的请求：模型配置、工作区、插件、定时任务、team.json。
 *
 * 这些请求只在打开对应面板时使用，与会话主链路无关，因此单独成为一个模块：
 * 它们的总代码量超过会话链路，混放会使阅读 store 的人误认为它们位于热路径上。
 */

import type {
  Attachment,
  Conversation,
  EffortLevel,
  MediaKind,
  MediaOutput,
  MediaParamDefinition,
  PermissionMode,
  ScheduleView,
  ThinkingMode,
  ToolCallCheck,
  ToolSchemaMode,
} from '@qywork/core'
import { createSignal } from 'solid-js'
import { ApiError } from '../client.ts'
import { client, invalidateExtensions } from './connection.ts'
import { tauriInvoke } from './shell.ts'
import type { WorkspaceInfo } from './ui.ts'

// ───────────────────────── 配置 ─────────────────────────

/** 指向一个具体模型的二元组。模型 id 本身可能含斜杠，因此不能拼接为一个字符串。 */
export interface ModelRef {
  provider: string
  model: string
}

/** 单个模型在接口下的配置项。 */
export interface RedactedModel {
  maxOutputTokens?: number
  /** 保存时原样回传，避免覆盖探测得到的实测结果。 */
  capabilities?: unknown
  /**
   * 用户为该模型选定的思考档位。
   *
   * 与 `capabilities` 一样存放在模型配置项中：各模型的档位集合不同，若使用全局值，
   * 在 Claude 上选定的 `xhigh` 切换到 DeepSeek 后是该模型不支持的档位。
   */
  effort?: EffortLevel
  /** 当前接口端点对控制参数的传输校准结论；不写入全局模型目录。 */
  transport?: {
    effort?: boolean
    effortLevels?: EffortLevel[]
    thinking?: ThinkingMode
    toolCalls?: ToolCallCheck
  }
}

/** 接口的对外结构：明文 key 不离开服务进程，只返回是否已设置。 */
export interface RedactedProvider {
  kind: string
  baseUrl?: string
  headers?: Record<string, string>
  models: Record<string, RedactedModel>
  /** 该接口下的生成模型，键为模型 id。与 `models` 分开存放：输入框的模型选择只列出 `models`。 */
  media?: Record<string, { kind: MediaKind }>
  hasApiKey: boolean
  /**
   * 只写字段。读接口从不返回它（返回的是上方的 `hasApiKey`），
   * 仅在用户于设置中输入新 key 时携带；不携带表示沿用服务端已有的 key。
   *
   * 写入类型定义是为了由编译器检查该字段：使用 `as Partial<...>` 强制转换时，键名拼错
   * 不会报错，保存成功而 key 未改变，直到下一次调用模型才失败。
   */
  apiKey?: string
}
/**
 * 服务端配置的对外结构。该类型是手工复制的副本，且有意不完整。
 *
 * 需要复制是因为无法引用：真源 `QyConfig` 位于 `@qywork/runtime`(L5)，界面只依赖
 * `@qywork/core`(L0)。不完整是因为 `sandboxNetwork` 只在具备内核沙箱的平台上生效，
 * 在 Windows 上显示该开关没有实际作用（见 CLAUDE.md B5）。
 *
 * 因此缺少该字段是有意的，但保存时不得因此清除它：保存使用
 * 整份 PUT，服务端 `mergeConfig` 通过 `{ ...current, ...incoming }` 保留客户端
 * 未知的键。该语义由 `server/src/api/config.test.ts` 中保留未知顶层字段的测试锁定，
 * 修改此处前先阅读该测试。
 */
export interface RedactedConfig {
  updates?: { autoCheck: boolean; autoDownload: boolean }
  /** 当前默认「接口 × 模型」。可省略：出厂不预设模型，删除最后一个模型后同样不存在。 */
  active?: ModelRef
  /**
   * 各类别的默认生成模型。规则与 `active` 相同：保存时以该字段为准，未携带即表示没有默认值，
   * 因此删除某一类别的全部模型时须删除该类别的键，所有类别均被删除时省略整个字段。
   */
  mediaDefaults?: Partial<Record<MediaOutput, ModelRef>>
  providers: Record<string, RedactedProvider>
  /**
   * 模型参数的覆盖项，键为「模型 id | 协议」。
   *
   * 界面上的模型库表格只读。字段结构的真源在服务端（`StoredCatalogEntry`），
   * 此处不重复定义，只保证整份 PUT 时原样回传，否则会被清除。端点校准写入
   * `providers[].models[].transport`，不影响这份全局规格。
   */
  catalog?: Record<string, Record<string, unknown>>
  // 思考档位不在顶层：它是「接口 × 模型」配置项的属性，见 `RedactedModel.effort`。
  mode?: PermissionMode
  additionalDirectories?: string[]
  envAllowList?: string[]
  /** 是否允许 agent 控制内置浏览器。字段缺失视为启用，仅显式 `false` 表示关闭。 */
  browserEnabled?: boolean
  /** 是否允许 agent 操作本机上的其他应用。缺省为关闭。 */
  desktopEnabled?: boolean
  desktopForeground?: boolean
  /** 是否允许 agent 使用 `office` 工具。字段缺失视为启用，仅显式 `false` 表示关闭。 */
  officeEnabled?: boolean
  /** 是否允许 agent 使用画布与生成工具。字段缺失视为启用，仅显式 `false` 表示关闭。 */
  mediaEnabled?: boolean
}
export interface ConfigPayload {
  path: string
  config: RedactedConfig
  /** 该配置的版本指纹，保存时原样回传给服务端，用于乐观并发校验（见 `saveServerConfig`）。 */
  version: string
  notices: string[]
  problems: string[]
  /** `envAllowList` 留空时实际生效的列表，由服务端下发（真源在 `tools/shell.ts`）。 */
  defaultEnvAllowList: string[]
}

export function loadServerConfig(): Promise<ConfigPayload> {
  return client.api<ConfigPayload>('/api/config')
}

/** 本次保存中的接口改名关系；仅用于服务端回填密钥，不写入配置。 */
export interface ProviderRename {
  from: string
  to: string
}

/**
 * 将 `client.api` 抛出的错误转换为一句可读的说明。
 *
 * `client.api` 的消息格式为 `<状态码> <路径>: <响应体前 200 字>`，其中响应体是 JSON，
 * 原样显示会把接口细节暴露给用户。此处只取说明原因的字段
 * （`problems` 数组、`message` 或 `error`），无法取得时回退到原文，而不是
 * 「操作失败」：原文包含诊断信息，泛化的失败提示不包含任何信息。
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
      // 服务端多数错误只带 `error` 一个键（`api/types.ts` 的 `json`）。不识别该键时，
      // 界面显示原始文本，如「422 /api/xxx: {"error":「标题不能为空」}」。
      if (body.error) return body.error
    } catch {
      // 响应体被 client.api 截断到 200 字时解析失败，回退到原文。
    }
  }
  return raw || fallback
}

/**
 * 保存配置。
 *
 * 服务端先执行 `diagnoseConfig` 再落盘，存在致命问题时返回 422 且不写入。
 *
 * 422 由 `client.api` 抛出为 `Error`，消息形如
 * `422 /api/config: {"error":"invalid","problems":[...]}`，直接显示给用户
 * 是一段原始 JSON。此处提取 `problems` 并转换为可读文字：保存失败时必须指明
 * 哪一项不合格，只显示「保存失败」与显示整段 JSON 同样无法使用。
 *
 * `baseVersion` 是本次编辑所基于的版本指纹；服务端发现配置已被其他位置修改时返回 409，
 * 由 `configStore` 重新读取并重放。409 原样抛出（`ApiError`），不在此处包装为字符串：
 * 调用方需要按状态码判断是否重试。
 */
export async function saveServerConfig(
  config: RedactedConfig,
  baseVersion?: string,
  renameProvider?: ProviderRename,
): Promise<ConfigPayload> {
  try {
    await client.api<{ ok: boolean }>('/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        config,
        ...(baseVersion ? { baseVersion } : {}),
        ...(renameProvider ? { renameProvider } : {}),
      }),
    })
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) throw e
    throw new Error(explainApiError(e, '保存失败'))
  }
  // 配置是模型目录的唯一权威，落盘后立即重算。这是目录唯一的失效点：
  // 由各消费者自行判断是否刷新，会使过期判据分散为多份。
  await reloadModelCatalog()
  return loadServerConfig()
}

/**
 * 切换权限模式。
 *
 * 使用已有的 `/api/config` 写入路径，不新增接口：配置的真源是唯一的
 * `config.json`，每增加一条写入路径就多一份记录。代价是先读取全量配置再写回，
 * 多一次往返，但避免了两处写入同一文件必然导致的不一致。
 *
 * 写入成功后调用方须立即更新握手时取得的 `capabilities.mode`：服务端只在握手时报告一次，
 * 不更新时按钮点击后状态不变。
 */
export async function setPermissionMode(mode: PermissionMode): Promise<void> {
  const payload = await loadServerConfig()
  await saveServerConfig({ ...payload.config, mode })
}

// ───────────────────────── 模型目录 ─────────────────────────

/** 接口下的一个模型。 */
export interface ModelOption {
  chatToolSchema: ToolSchemaMode
  id: string
  /** Base URL 留空时使用的官方地址；未登记时省略。 */
  defaultBaseUrl?: string
  /** 内置目录中的显示名；目录中没有时为 id 本身。 */
  label: string
  /** 该模型支持的思考强度档位。空数组表示当前链路无法调节，界面据此不显示档位开关。 */
  effortLevels: EffortLevel[]
  /** 用户为该模型选定的档位。null 表示未选择，不发送思考字段。与上一字段同源。 */
  effort: EffortLevel | null
  /** 计价币种。阿里 / 月之暗面 / 智谱三家官网按人民币标价，符号不能一律显示为 $。 */
  currency: 'USD' | 'CNY'
  /**
   * 是否接受图片输入。`null` 表示没有依据，照常允许；仅 `false` 时隐藏
   * 图片附件入口。与上方字段同源，各模型不同，因此不经由握手下发。
   */
  vision: boolean | null
  /** 是否支持通过当前协议直接输入视频。 */
  video: boolean
  /** false 表示内置目录中没有该模型，来自用户自行配置的模型 id（自建端点 / 中转）。 */
  known: boolean
}

/** 一个接口。名称由用户在设置中指定，选择器按名称分组。 */
export interface ProviderModels {
  name: string
  models: ModelOption[]
}

/**
 * 模型库中的一条记录，即一个模型的参数。
 *
 * 模型库与接口相互独立：模型库描述模型的窗口、价格与支持的思考档位，接口描述
 * 使用的端点与 key。因此该类型不含任何接口字段。
 *
 */
export interface LibraryModel {
  id: string
  label: string
  contextWindow: number
  /** `null` 表示该模型的输出上限未经测定，请求中不发送该字段。 */
  maxOutputTokens: number | null
  /** 是否接受图片输入。`null` 表示厂商规格页未注明，不表示不支持。 */
  vision: boolean | null
  /** null = 厂商尚未公布单价。 */
  input: number | null
  output: number | null
  /** 缓存命中价。 */
  cacheRead: number | null
  /** 缓存写入价（5 分钟档）。计价只按该档计算。 */
  cacheWrite: number | null
  currency: 'USD' | 'CNY'
  effortLevels: EffortLevel[]
  /** 未选择强度时是否思考。 */
  thinksByDefault: boolean
  /**
   * 价格的例外说明：分时段折扣、长上下文分档计价。上方各项价格是厂商公布的标准价。
   * 它是能力边界，必须显示：只显示一个数字时，用户对照账单会发现不一致，
   * 差价可达两倍。
   */
  priceNotes?: string[]
}

export interface LibraryVendor {
  id: string
  displayName: string
  models: LibraryModel[]
}

/** 生成操作。与服务端生成目录的 `MediaOperation` 同一组值。 */
export type MediaOperationName =
  | 'generate'
  | 'edit'
  | 'text_to_video'
  | 'image_to_video'
  | 'first_last_frame'
  | 'reference_to_video'
  | 'video_to_video'
  | 'speech'

/** 接口下的一个生成模型。 */
export interface MediaModelOption {
  provider: string
  id: string
  kind: MediaKind
  output: MediaOutput
  label: string
  operations: MediaOperationName[]
  isDefault: boolean
  /** false 表示生成目录中没有该模型，参数表使用协议默认值。 */
  known: boolean
  /** 画布生成面板上的参数控件：目录中标注了界面名称的参数。 */
  params: MediaParamOption[]
}

/** 生成面板上的一个参数控件。取值约束与服务端的参数校验使用同一份目录。 */
export type MediaParamOption = MediaParamDefinition & { label: string }

/** 生成目录中的一条记录。`params` 每行一个参数，与发给模型的文字相同。 */
export interface MediaLibraryModel {
  id: string
  label: string
  vendor: string | null
  kind: MediaKind
  /** 由服务端模型目录给出的接入方式。 */
  kinds: MediaKind[]
  output: MediaOutput
  operations: MediaOperationName[]
  maxImages: number
  maxVideos: number
  maxAudios?: number
  params: string[]
}

export interface ModelCatalog {
  /** 可选项：配置中实际存在的接口 × 模型。 */
  providers: ProviderModels[]
  /** 已配置的生成模型。不能用于对话，输入框的模型选择不读取它。 */
  media: MediaModelOption[]
  /** 内置生成目录。添加模型时据此识别生成模型，模型库的生成类页签显示该目录。 */
  mediaLibrary: MediaLibraryModel[]
  /** 当前默认「接口 × 模型」。可省略：出厂不预设模型时该字段不存在。 */
  active?: { provider: string; model: string }
  /** 模型参数表，不是可选列表：按接口下已添加的模型 id 从此处查询参数。 */
  library: LibraryVendor[]
}

/** 模型列表按需获取：并非每个会话都会打开选择器，无需在启动时请求。 */
export async function loadModels(): Promise<ModelCatalog> {
  return client.api<ModelCatalog>('/api/models')
}

/**
 * 模型目录：配置的派生状态，全应用只有一份。
 *
 * 它由服务端按配置中的「接口 × 模型」实时计算：窗口、档位、思考参数的判定都在
 * `@qywork/ai` 中，界面无法引用，因此只能来自服务端。
 *
 * 失效点位于唯一的写入路径上（`saveServerConfig`），不由各消费者自行刷新。
 * 各组件分别持有永不失效的缓存时，实测结果：设置页校准思考参数并写回配置后，
 * 输入区的目录仍是启动时获取的版本，档位需要重新加载整个页面才出现。
 */
const [modelCatalog, setModelCatalog] = createSignal<ModelCatalog | null>(null)
/** 获取失败的原因。此时模型列表为空，界面上等同于没有其他模型可选。 */
const [modelCatalogError, setModelCatalogError] = createSignal<string | null>(null)
const [modelCatalogLoading, setModelCatalogLoading] = createSignal(false)
let catalogSeq = 0

export { modelCatalog, modelCatalogError, modelCatalogLoading }

/** 首次有组件使用时获取一次。已取得或正在获取时不重复请求。 */
export function ensureModelCatalog(): Promise<void> {
  if (modelCatalog() || modelCatalogLoading()) return Promise.resolve()
  return reloadModelCatalog()
}

export async function reloadModelCatalog(): Promise<void> {
  // 以最后发出的请求为准。写盘后发出的请求才能取得新目录，而更早发出的请求
  // 可能更晚返回，不比对序号会用落盘前的目录覆盖落盘后的目录。
  const seq = ++catalogSeq
  setModelCatalogLoading(true)
  try {
    const next = await loadModels()
    if (seq !== catalogSeq) return
    setModelCatalog(next)
    setModelCatalogError(null)
  } catch (e) {
    if (seq === catalogSeq) {
      setModelCatalogError(e instanceof Error ? e.message : '模型列表加载失败')
    }
  } finally {
    if (seq === catalogSeq) setModelCatalogLoading(false)
  }
}

// ───────────────────────── 连接测试 ─────────────────────────

/**
 * 一次探测的结果。
 *
 * `probes` 是每一步的原始结论，而不只是最终汇总，以便核查结论：
 * 只给出「支持思考：是」时，结论有误也无从排查。
 *
 * `detail` 由服务端脱敏后下发：它是 provider 的原始错误消息，可能包含
 * 请求 URL 乃至凭证。
 */
export interface ProbeStep {
  name: string
  ok: boolean
  detail: string
  /** true 表示该步骤未实际验证任何能力（本协议下客户端不发送该字段）。 */
  skipped?: boolean
  /** 已发请求，但只得到超时、限速或上游暂不可用。 */
  inconclusive?: boolean
}
export interface ProbeOutcome {
  toolCalls?: ToolCallCheck
  effortSource: 'catalog' | 'probe'
  reachable: boolean
  /** 当前链路上无法探测的能力项。与「已探测但被拒绝」含义不同，不能合并显示。 */
  untested: 'effort'[]
  /** 已尝试但未形成能力结论；不得显示为「不支持」。 */
  inconclusive: 'effort'[]
  effortLevels: EffortLevel[]
  thinking?: ThinkingMode
  thinkingObserved: boolean
  probes: ProbeStep[]
}
export interface ProbeResult {
  outcome: ProbeOutcome
  /** 当前接口端点的传输校准；不包含未探测的能力项。 */
  transport: NonNullable<RedactedModel['transport']>
}

/**
 * 实测指定接口下的指定模型。
 *
 * 探测的是已落盘的配置，不是界面上的草稿：请求体只携带名称，key 由服务端读取。
 * 允许探测草稿就需要端点接收临时的明文 key，即新增一条 key 的上行路径。
 *
 * 该操作会发送连接、档位与两轮工具契约请求，因此只由用户点击按钮触发。
 */
export function probeModel(provider: string, model: string): Promise<ProbeResult> {
  return scheduleWrite('/api/probe', {
    method: 'POST',
    body: JSON.stringify({ provider, model }),
  })
}

/** 当前项目。 */
export function loadWorkspace(): Promise<WorkspaceInfo> {
  return client.api<WorkspaceInfo>('/api/workspace')
}

/**
 * 本机已知的工作区列表（账本中出现过的工作区）。
 *
 * 用于「最近打开」，无需每次通过目录选择器查找。
 */
export interface KnownWorkspace {
  id: string
  rootPath: string
  name: string
  lastOpenedAt: number
  /** 该工作区下的会话数。统计口径与会话列表一致：不含机器会话与已归档会话。 */
  conversations: number
  /** 置顶时间。缺少该键表示未置顶。置顶项排在列表最前。 */
  pinnedAt?: number
}
export function loadKnownWorkspaces(): Promise<{ workspaces: KnownWorkspace[] }> {
  return client.api<{ workspaces: KnownWorkspace[] }>('/api/workspaces')
}

/**
 * 从列表中移除一个项目。
 *
 * 该操作是隐藏而非删除。服务端只设置 `removed_at` 标记：文件、会话、消息、run
 * 均保持不变，重新添加同一路径即全部恢复。目录本身也不改动：账本记录的是
 * 打开过哪些项目，不管理项目中的文件。
 *
 * 当前项目也可以移除，前提是还有其他项目可切换；服务端在 `next` 中返回下一个切换目标。
 * 只有最后一个项目无法移除（返回 409）：移除后服务端没有任何可服务的项目，该状态无效。
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
 * 置顶 / 取消置顶。目标状态由调用方指定，而不是切换：并发时切换可能得到相反的结果。
 */
export function pinKnownWorkspace(id: string, pinned: boolean): Promise<{ ok: boolean }> {
  return client.api<{ ok: boolean }>(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned }),
  })
}

/**
 * 归档该项目当前的全部会话：从会话列表中移除，数据保持不变，
 * 此后新建的会话照常显示。
 *
 * 返回归档条数而不是布尔值：界面上必须能区分「0 条」与「成功」。
 */
export function archiveWorkspaceChats(id: string): Promise<{ archived: number }> {
  return client.api<{ archived: number }>(`/api/workspaces/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
  })
}

/**
 * 在系统文件管理器中定位该项目的目录。
 *
 * 只有桌面外壳具备该能力（经由 Rust 侧的 `reveal_workspace`）。浏览器 / 手机端
 * 无法使用，因此不显示该入口，而不是显示一个点击即报错的按钮（B5）。
 */
export function revealWorkspace(path: string): Promise<void> {
  return tauriInvoke<void>('reveal_workspace', { path })
}

/** 在系统文件管理器中选中一个本机文件；调用方只在桌面端提供入口。 */
export function revealFile(path: string): Promise<void> {
  return tauriInvoke<void>('reveal_file', { path })
}

/**
 * 将一个本机目录添加为项目，并将其置于「最近打开」的首位。
 *
 * 添加与切换使用同一条路径：服务端执行 upsert，已存在时更新 `last_opened_at`，不存在时插入一行。
 * 拆分为两个端点会形成两条写入同一字段的路径，而该字段正是分支监听与缺省 `?ws=` 的判据。
 */
export interface WorkspaceInput {
  /** 本机已存在的目录。省略时在 `~/.qywork/workspaces/<name>/` 新建目录。 */
  path?: string
  /** 显示名。省略且提供了 `path` 时取目录名。两者均省略时返回 422。 */
  name?: string
}

export function addWorkspace(
  input: WorkspaceInput,
): Promise<{ workspace: KnownWorkspace; conversations: Conversation[] }> {
  return client.api<{ workspace: KnownWorkspace; conversations: Conversation[] }>(
    '/api/workspaces',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  )
}

// ───────────────────────── 插件安装 ─────────────────────────

/**
 * 安装插件即把一个本机已存在的目录复制到全局的 `plugins/` 目录。
 *
 * 没有 registry，因此不提供从市场安装；也有意不支持 `git clone <任意 URL>`：
 * 那等于从网络获取一段代码并在下次加载时运行。用户先自行 clone 并检查内容，
 * 再指定该目录；多出的这一步使用户能看到所安装的内容。
 */
/** 插件只有一个全局目录，因此安装与卸载都不指定层。 */
export function installPlugin(path: string): Promise<{ ok: boolean; id: string }> {
  return scheduleWrite('/api/plugins/install', {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
}
export function uninstallPlugin(id: string): Promise<{ ok: boolean }> {
  return scheduleWrite(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 打开系统目录选择器。用户取消时返回 null：取消不是错误。 */
export function pickWorkspace(): Promise<string | null> {
  return tauriInvoke<string | null>('pick_workspace')
}

/** 打开系统文件选择器，可多选。取消时返回空数组：取消不是错误。 */
export function pickFiles(): Promise<string[]> {
  return tauriInvoke<string[]>('pick_files')
}

/** 记住桌面端最后打开的项目，供下次启动选根目录。 */
export function rememberWorkspace(path: string): Promise<void> {
  return tauriInvoke<void>('remember_workspace', { path })
}

// ───────────────────────── 定时任务 ─────────────────────────

export interface SchedulesPayload {
  schedules: ScheduleView[]
  /** 由服务端下发，不由各客户端分别定义：它是功能前提，不是补充说明。 */
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
  } finally {
    if (path.startsWith('/api/skills') || path.startsWith('/api/mcp')) invalidateExtensions()
  }
}

export function updateSchedule(
  id: string,
  s: Partial<ScheduleView>,
): Promise<{ schedule: ScheduleView }> {
  return scheduleWrite(`/api/schedules/${id}`, { method: 'PUT', body: JSON.stringify(s) })
}
export function deleteSchedule(id: string): Promise<{ ok: boolean }> {
  return scheduleWrite(`/api/schedules/${id}`, { method: 'DELETE' })
}
/** 立即运行一次。不更新 lastRunAt：试运行不应取消当天的自动触发。 */
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
// agent 可以随时通过工具写入，因此用户在界面上也必须能查看与删除；以下接口用于消除这一不对称。

/**
 * 记忆 / 技能 / MCP / 插件所属的层。
 *
 * - `builtin` 随程序发布，只读，不在界面上显示（服务端目前没有内容）。
 * - `project` 是工作区的 `.agents/`，随仓库保存，其他 CLI 也能读取。
 * - `global` 是 `~/.qywork/`，跨工作区。
 *
 * 优先级为 `builtin > project > global`，同名时优先级高的层生效。解析在服务端完成：
 * 界面上列出的条目必须与模型实际加载的条目一致，前端不得另行计算。
 */
export type Scope = 'builtin' | 'project' | 'global'

/**
 * 可写的两层，顺序即界面上标签页的顺序。内置层随程序发布，写入的内容会在下次升级时丢失。
 *
 * 标签只在此处定义：各页分别硬编码时，同一层在记忆页与 MCP 页的名称可能不同，
 * 用户无法得知它们是同一层。
 */
export const WRITABLE_SCOPES: { id: Scope; label: string }[] = [
  { id: 'global', label: '全局' },
  { id: 'project', label: '项目' },
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
   * 覆盖该条目的层，未被覆盖时为 null。
   *
   * 列表返回全部层的全部条目，而不是去重后的结果：设置页按层分列，
   * 去重会使被项目层覆盖的全局记忆从界面上消失。实际生效的条目由该字段判断。
   */
  shadowedBy: Scope | null
}
export function loadMemory(): Promise<{ dirs: ScopeDir[]; entries: MemoryEntry[] }> {
  return client.api<{ dirs: ScopeDir[]; entries: MemoryEntry[] }>('/api/memory')
}
export function deleteMemory(key: string, scope: Scope): Promise<{ ok: boolean }> {
  return scheduleWrite(`/api/memory/${encodeURIComponent(key)}?scope=${scope}`, {
    method: 'DELETE',
  })
}

export interface SkillMeta {
  name: string
  description: string
  /** 技能目录的绝对路径。技能在界面上只读，用户据此找到修改位置。 */
  dir: string
  scope: Scope
  /** 覆盖该技能的层。同名技能只加载优先级最高的一个。 */
  shadowedBy: Scope | null
}
export function loadSkills(): Promise<{ dirs: ScopeDir[]; skills: SkillMeta[] }> {
  return client.api<{ dirs: ScopeDir[]; skills: SkillMeta[] }>('/api/skills')
}
/** 将本机已存在的技能目录整体复制到指定层。 */
export function importSkill(
  scope: Scope,
  path: string,
): Promise<{
  ok: boolean
  installed: { name: string; dir: string; active: boolean; effective: SkillMeta }[]
}> {
  return scheduleWrite('/api/skills/import', {
    method: 'POST',
    body: JSON.stringify({ scope, path }),
  })
}
/** 按目录名删除，而不是前置元信息中的 name：两者可以不同，而磁盘上只有目录。 */
export function deleteSkill(dirName: string, scope: Scope): Promise<{ ok: boolean }> {
  return scheduleWrite(`/api/skills/${encodeURIComponent(dirName)}?scope=${scope}`, {
    method: 'DELETE',
  })
}

// ───────────────────────── MCP ─────────────────────────

/**
 * 已连接的 server 及其提供的工具。
 *
 * `failures` 与 `unsupported` 与成功项一起返回：只提供 prompts 的 server 会
 * 连接并握手成功、注册 0 个工具且不报任何错误；已配置但未产生任何工具的状态
 * 是本页最需要显示的状态。
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
  /** 已配置但本次未连接成功的 server。不列出时它们会从界面上消失。 */
  configured: { name: string; scope: Scope }[]
  error: string | null
}
export function loadMcp(): Promise<McpPayload> {
  return client.api<McpPayload>('/api/mcp')
}

/**
 * 当前实际可调用的工具清单。输入区 `@` 与设置页都应以 `/api/tools` 为真源：
 * 它只列出注册成功的 MCP / 插件工具，不把清单中已声明但进程未启动的工具列为可调用。
 */
export interface ToolMeta {
  name: string
  category: string
  summary: string
  source: string
}
export function loadTools(): Promise<{ tools: ToolMeta[] }> {
  return client.api<{ tools: ToolMeta[] }>('/api/tools')
}

/** 将本机一份已有配置中的 server 合并到指定层。同名时不覆盖，服务端返回 409。 */
export function importMcp(
  scope: Scope,
  path: string,
): Promise<{
  ok: boolean
  names: string[]
  saved: boolean
  activation: { connected: boolean; failures: { server: string; reason: string }[] }
}> {
  return scheduleWrite(`/api/mcp/import?scope=${scope}`, {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
}

// ───────────────────────── 附件 ─────────────────────────

/**
 * 上传字节，取得可直接随消息发送的 `Attachment`。
 *
 * 仅在无法取得源路径时使用：剪贴板中只有位图，或浏览器不提供绝对路径。
 * 桌面端拖入与原生选择器提供的是源文件路径，该路径在 `Composer` 中直接组装，
 * 不传输任何字节。
 *
 * 直接用 File 作请求体，不先转换为 ArrayBuffer。浏览器与服务端都按流处理，
 * 不会产生与附件同等大小的临时内存副本。
 *
 * 携带会话 id：附件保存在 `~/.qywork/attachments/<会话id>/`，删除会话时整个目录一并删除。
 */
export async function uploadAttachment(file: File, conversationId: string): Promise<Attachment> {
  const res = await client.api<{ attachment: Attachment }>(
    `/api/attachments?conversation=${encodeURIComponent(conversationId)}`,
    {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        // 文件名可能含中文与空格，必须编码后再写入 header。
        'x-attachment-name': encodeURIComponent(file.name),
      },
      body: file,
    },
  )
  return res.attachment
}

/**
 * 按路径获取附件的原始字节，供界面显示。
 *
 * 返回 blob URL，使用完毕必须调用 `URL.revokeObjectURL`，否则解码后的位图
 * 会一直占用内存，直到整页刷新。
 *
 * 不直接把地址交给 `<img src>`：`<img>` 无法携带 Authorization 头，
 * 而把令牌放入 URL 会使其随日志留存。
 *
 * 文件不存在与超过预览上限均返回 null：两者在界面上的处理相同（无法显示，
 * 改为显示文件名），无需区分。
 */
export async function attachmentBlobUrl(path: string): Promise<string | null> {
  try {
    const res = await client.raw(`/api/attachments/raw?path=${encodeURIComponent(path)}`)
    if (!res.ok) return null
    return URL.createObjectURL(await res.blob())
  } catch {
    return null
  }
}

// ───────────────────────── 窗口控制 ─────────────────────────

/**
 * 最小化 / 最大化 / 关闭。
 *
 * 关闭系统装饰后，这三个操作没有其他入口。只有桌面端有窗口：
 * `isDesktopShell()` 为假时界面不渲染这组按钮，而不是渲染点击即报错的按钮。
 */
export function windowMinimize(): Promise<void> {
  return tauriInvoke<void>('window_minimize')
}
/** 返回切换后的状态：true 表示当前为最大化。 */
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
 * 语音输入与模型无关，也不经过服务端：`SpeechRecognition` 是浏览器
 * 自带的能力，识别结果直接是文字，追加到草稿即可。后端没有 STT 通路，
 * 不要在后端查找。
 *
 * 特性检测不通过时返回 null，界面据此不渲染麦克风按钮：Tauri 的 WebView2
 * 不一定提供该 API，而点击后无响应的按钮会被理解为功能故障。
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
