/**
 * 本地配置。
 *
 * 无账号体系（需求 11）：所有配置就是本机一个 JSON 文件，用户自己填接口。
 * 不做云同步、不做登录、不上报。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  CHAT_REASONING_PROTOCOLS,
  type ChatReasoningProtocol,
  lookupModel,
  type TransportCapabilities,
} from '@qywork/ai'
import {
  CACHE_ROUTINGS,
  type CacheRouting,
  EFFORT_ORDER,
  type EffortLevel,
  log,
  MEDIA_KIND_OUTPUT,
  MEDIA_KINDS,
  MEDIA_OUTPUTS,
  type MediaKind,
  type MediaOutput,
  type PermissionMode,
  PROVIDER_KINDS,
  type ProviderKind,
  REASONING_ECHOES,
  type ReasoningEcho,
  THINKING_MODES,
  type ThinkingMode,
  TOOL_SCHEMA_MODES,
} from '@qywork/core'
import { globalScopeRoot, normalizeAdditionalDirectories } from '@qywork/tools'

/**
 * 权限模式。**只有两种**，刻意不做逐次审批。
 *
 * 逐次审批的问题不是麻烦，是**粒度骗人**：用户看到 `npm test` 点批准，
 * 实际批准的是「任意本机操作 + 全部凭证」——`run_command` 是唯一一条能同时
 * 绕开 `resolveInWorkspace` 和 SSRF 闸的路径。而弹窗多了之后，用户会去开
 * 一个「全部自动批准」的开关，因此防线归零。与其如此，不如把两端做清楚。
 *
 * - `auto`：不弹窗。文件工具的路径锁在工作区内，`run_command` 过 `policy.ts` 的
 *   一张拒绝清单。**被拒不是弹窗，是把理由作为工具失败返回给模型**，让它换个做法。
 * - `full`：不裁决，全放行；路径边界与受保护目录跟着一起不设。
 *
 * `full` 唯一不豁免的是**凭证剥离**——那一层防的是凭证泄漏，不是越权。
 * 不要把「禁止写 `.qy/`」也写成不豁免：`resolveWritablePath` 在 `unrestricted` 下
 * 直接放行，写成不豁免与代码相反。
 */

/**
 * 指向一个具体模型的二元指针。
 *
 * **不用 `"接口/模型"` 拼接串**：模型 id 本身就含斜杠
 * （openrouter 的 `anthropic/claude-3`），拼起来就没法无歧义地拆回去。
 */
export interface ModelRef {
  /** `providers` 的键。 */
  provider: string
  model: string
}

export interface QyConfig {
  updates?: { autoCheck: boolean; autoDownload: boolean }
  /**
   * 当前生效的「接口 × 模型」。**可缺省**：出厂不预设模型，用户配好之前它就是没有。
   * 缺省时新会话不带默认模型、发送在起 run 前被明确拒绝（`no_model`），不回落到任何模型。
   */
  active?: ModelRef
  providers: Record<string, StoredProvider>
  /** 用户改过的模型参数，键由 `catalogKey` 造。见 `StoredCatalogEntry`。 */
  catalog?: Record<string, StoredCatalogEntry>
  /**
   * 各类别的默认生成模型：生成工具不点名模型时用它。与 `active` 同一种指针，指向某个接口的 `media` 表。
   * 缺某一类就是那一类没有默认；该类别加进第一个模型时由设置页设上。
   */
  mediaDefaults?: Partial<Record<MediaOutput, ModelRef>>
  /** 权限模式，默认 auto。 */
  mode?: PermissionMode
  /**
   * 允不允许 agent 操作本机上别的应用（电脑控制）。**缺席按启用，只有显式 `false` 才关。**
   *
   * 关着时装配方不注入桌面端口，桌面工具整组不注册——不是注册一组必然报错的名字。
   *
   * 它与握手里的 `capabilities.desktop` 是两件事：那一份报的是这台机器此刻的客观
   * 状态（宿主连没连上、worker 起没起来、系统授没授权），这一格是用户的选择。
   *
   * 占用真实鼠标键盘的那一半由 `desktopForeground` 单独管，它缺席按关闭。
   */
  desktopEnabled?: boolean
  /**
   * 允不允许 agent 用前台操作：指针、键盘与窗口管理。**默认关**。
   *
   * 关着时只有后台语义动作可用——它们经控件接口发出，不动真实指针、不改焦点、
   * 不抢前台。开着时模型可以发出会打断用户的输入，因此它是用户的一次显式选择，
   * 后台失败不会自动升级到前台。
   *
   * 它随每条桌面请求下发到执行组件：运行中关掉，下一次派发就被拒。
   */
  desktopForeground?: boolean
  /**
   * 工作区之外**额外**可读写的绝对路径。
   *
   * **它是「要沙箱」和「要操作电脑」的交汇点。** 这两个需求方向相反：一个要把边界收紧到工作区，一个
   * 要伸到工作区之外。没有这个清单的话，想碰工作区外的任何路径只能整个切到 `full`——那不是放开一
   * 个目录，是放弃全部裁决。有了它，边界仍然是白名单，只是白名单里不止一项。
   *
   * **三层都接了才算数。** 路径解析（`resolveInWorkspace`）、静态规则（`policy.ts`）、
   * 沙箱 bind 清单（`sandbox.ts`）。**少接一层这个字段就是只声明没消费**，
   * 测试覆盖「清单内可写 / 清单外仍拒 / 软链逃逸 / 相对路径被拒」四条。
   *
   * **`full` 下这一层整个不设。** 不要写成「`full` 不豁免它」——那与代码相反：
   * `Session.makeToolContext` 在 `full` 下传 `unrestrictedPaths: true`，`resolveInWorkspace` 直接返
   * 回目标路径。「完全访问」的定义就是不裁决，路径层跟着一起不设；只放开权限闸而留着路径层，会变
   * 成「`read_file` 被拒、`run_command` 读到」的两套账（见 CLAUDE.md E）。真正不受模式影响的是凭证
   * 剥离。
   *
   * 只接受绝对路径——相对路径的基准是启动 qy 时所在的目录，换个地方启动含义就变。
   */
  additionalDirectories?: string[]
  /**
   * shell 命令能不能出网。默认 `'allow'`。
   *
   * 只有两档，**刻意不做域名白名单**：中间态需要在沙箱里起代理、沙箱外做转发、
   * 还要让 TLS 校验认一张自签 CA。那套组件会在别人的机器上以各种方式坏掉，
   * 而坏掉的表现是「网络时好时坏」——比没有这个功能糟得多。
   *
   * `'deny'` 只在**有内核沙箱的平台上**生效（`qy config` 会报当前是哪档）。
   * 没有沙箱的平台上它是一句空话，所以那里会明确提示它没生效——
   * 静默无效正是本项目反复在修的那类问题。
   */
  sandboxNetwork?: 'allow' | 'deny'
  /**
   * 允许透传给子进程的环境变量名（大小写不敏感）。
   *
   * 默认会剥掉名字像凭证的变量，但有些命令真的需要（`GITHUB_TOKEN` 之类）。
   * **它只豁免「名字模式匹配」，不豁免「值匹配」**——一个变量的值若等于
   * 已配置的 API Key，不管它叫什么都必须剥。
   */
  envAllowList?: string[]
}

/**
 * 一个接口 = 一套凭证 + 一个端点 + 挂在它下面的若干模型。
 *
 * **凭证挂在接口这一层，不挂在模型上。** 扁平档案（一个档案一个模型）会让
 * 同一家的三个模型把同一把 key 和同一个 baseUrl 各存三份——
 * 改一次端点得改三处，漏一处的表现是「有的模型可用有的不可用」。
 */
export interface StoredProvider {
  kind: ProviderKind
  /**
   * 明文 key。**取 key 只有这一条路。**
   *
   * **不要再并排加一个 `apiKeyEnv`（环境变量名）之类的第二取值口。** 两格意味着
   * 两条取值路径：界面上看到的和实际发出去的可以是两把不同的 key，而两边都显示「已配置」。
   * 剥离不依赖它——按值剥认的是这里的明文，按名字剥认的是
   * `CREDENTIAL_NAME_PATTERN`，两条都还在。
   */
  apiKey?: string
  baseUrl?: string
  headers?: Record<string, string>
  /** 键是模型 id。 */
  models: Record<string, StoredModel>
  /**
   * 这个接口下的生成模型，键是模型 id。与对话模型共用上面的 key 与地址。
   *
   * **不并进 `models`**：输入框模型选择、子 agent 可选清单、`resolveModel` 都把 `models` 当对话模型遍历，
   * 并进去就得在每一处排除生成模型，漏掉一处，生成模型就会被当成对话模型发请求。
   */
  media?: Record<string, StoredMediaModel>
}

/** 一个生成模型挂在这个接口下的那一格。 */
export interface StoredMediaModel {
  /** 走哪种生成协议。添加时按接口地址给默认值（`defaultMediaKind`），之后以这里为准。 */
  kind: MediaKind
}

/**
 * 模型库的键：**模型 id + 协议**。
 *
 * 两维是因为同一个模型换条协议能力就不同（DeepSeek 走 chat/completions 时
 * 思考无从控制，走 Responses 时 `reasoning.effort:'none'` 能真的关掉），
 * 内置目录本来就按这两维索引（`lookupModel`）。一维覆盖会把一份参数
 * 套到两条 seed 上。
 *
 * 分隔符取 `|`：模型 id 含斜杠（openrouter 的 `anthropic/claude-3`）但不含它。
 * **不要改成 `/`**，改了就没法无歧义地拆回去，一次性迁移的幂等判据也跟着失效。
 */
export function catalogKey(model: string, kind: ProviderKind): string {
  return `${model}|${kind}`
}

/**
 * 用户改过的**模型参数**，也是内置目录之上**唯一的覆盖层**。
 *
 * 窗口、上限、单价是模型本身的属性；思考三项（`thinking` / `effortLevels` /
 * `thinksByDefault`）是这个模型在这条协议上的能力。两类都由键的第二维
 * （协议）区分开，不再各存一处。探测不能发明这些官方模型事实。
 *
 * **它和接口无关。** 库回答的是「这个模型在这条协议上是什么样」，接口回答的是「用谁的端点和
 * 哪把 key」。两者唯一的接点是接口下那一行模型 id ——参数照着
 * `catalogKey(id, 接口的 kind)` 从库里查。
 *
 * **为什么要能改。** 内置目录是源码里的一份 seed，其中七家的窗口 / 价格记于 2026-07-30、
 * 没有逐条实测（`catalog.ts` 里写明了）。厂商调价之后目录即失真，唯一的出口是
 * 账本上那个数——没有覆盖机制的话用户改不了它。
 *
 * 字段全部可选：只写改过的那几个，其余照 seed。目录里没有的 id 也能写一条
 * （`vendor` 决定它在界面上归到哪个分组），那正好补上「未收录模型计价按 0 算、
 * 账本报 $0」这个洞。
 *
 * 字段必须与 `@qywork/ai` 的 `SpecOverride` 一致——合并发生在那一层。
 */
export interface StoredCatalogEntry {
  displayName?: string
  /** 归到哪个厂商分组。目录里已有的条目不必写——按 seed 走。 */
  vendor?: string
  contextWindow?: number
  maxOutputTokens?: number
  /**
   * 接不接受图片输入。缺省 = 按目录里那条走（未收录的落在「不裁决」那一档）。
   * 只有填 `false` 才会挡住图片——中转站的自定义模型名靠这一格纠正。
   */
  vision?: boolean
  /** 每百万 token 的输入 / 输出单价。 */
  input?: number
  output?: number
  /** 缓存命中价。 */
  cacheRead?: number
  /** 缓存写入价。只覆盖 5 分钟那一档——`computeCost` 只按它算。 */
  cacheWrite?: number
  currency?: 'USD' | 'CNY'
  thinking?: ThinkingMode
  effortLevels?: EffortLevel[]
  thinksByDefault?: boolean
  chatReasoningProtocol?: ChatReasoningProtocol
  /**
   * 带 tool_calls 的历史要不要回传推理原文。同属「这条模型在这条协议上的能力」，
   * 只有 Responses 适配器消费它——保存会把同一条 entry 扇出到该 id 用到的每种协议，
   * chat 键上那份副本无害。
   */
  reasoningEcho?: ReasoningEcho
  /**
   * 缓存路由亲和键发不发。与思考三项同属「这条模型在这条协议上的能力」，
   * 落点也是同一处（手填或目录 seed；当前探针不探缓存命中）。
   *
   * 它比思考更需要按端点填：缓存是「端点 × 模型」那一格的属性，
   * 同一个模型换个中转站就是另一条结论。
   */
  cacheRouting?: CacheRouting
}

/**
 * 一个模型挂在**这个接口下**的那一格。
 *
 * 模型能力全在模型库里，按「模型 × 协议」索引；这里存用户偏好，以及当前接口
 * 接受哪些思考档位的实测结论。后者只作用于当前路线，不修改官方模型目录。
 */
export interface StoredModel {
  /**
   * 用户为这个模型选定的思考档。`undefined` = 没选过，不发思考字段。
   *
   * **挂在「接口 × 模型」这一格，理由是档位集合逐模型不同。**
   * 不能是全局一个 `config.effort`——本仓的模型档位面从 0 档到 5 档都有：
   *
   * ```
   * claude-opus-5        low medium high xhigh max
   * deepseek-v4-flash              high       max      ← 没有 low/medium/xhigh
   * gemini-3.1-pro       low medium high                ← 没有 xhigh/max
   * kimi-k3              low        high       max      ← 没有 medium
   * qwen3.7-max          （一档都没有）
   * deepseek(responses)  （同一个模型换条协议就没档了）
   * ```
   *
   * 一个全局值装不下这件事：在 Claude 上选的 `xhigh` 换到 DeepSeek 就是个
   * 它词表里没有的值。只调一家模型时全局字段够用，本仓同时接多家，还允许
   * Agent Team 的每个角色各带一个模型（`team-run.ts` 的 `backend.model`）。
   *
   * 注意这**不是第二条线**：真源仍然只有 config.json 这一处，只是键从全局
   * 变成了「接口 × 模型」。真正的第二条线是会话表上那一列，已经删掉。
   */
  effort?: EffortLevel
  /** 这个具体接口是否透传控制面；不属于全局模型能力。 */
  transport?: TransportCapabilities
}

/**
 * 把「接口这一层」和「模型这一格」摊平成发一次请求需要的全部信息。
 *
 * 派生值，不落盘。落盘的是两层结构，但调用方要的是一份平的——
 * 让每个调用方自己去拼，拼法就会各不相同。
 */
export interface ResolvedModel {
  /** 接口名，即 `providers` 的键。 */
  provider: string
  kind: ProviderKind
  model: string
  apiKey?: string
  baseUrl?: string
  headers?: Record<string, string>
  /** 模型库里这一条。按「模型 id × 接口的 kind」取，库里没有就是 undefined。 */
  spec?: StoredCatalogEntry
  /** 用户为这个模型选定的思考档。undefined = 没选过，不发思考字段。 */
  effort?: EffortLevel
  transport?: TransportCapabilities
}

/**
 * 全局层的根。配置文件、全局记忆、全局技能都在这棵树下。
 *
 * 定义在 `@qywork/tools`：那边的作用域解析要用同一个根，而 tools 在更底层、
 * 引不到这里。两处各算一遍的话，某次改 `QYWORK_HOME` 就会让配置和全局记忆
 * 落在两个地方。
 */
export function configDir(): string {
  return globalScopeRoot()
}

export function configPath(): string {
  return join(configDir(), 'config.json')
}

export function dataPath(): string {
  return join(configDir(), 'qywork.sqlite3')
}

/**
 * 无可用模型时的拒绝文案。启动 run 的路径（`session.ask`、`run-control`、`team-run`）
 * 共用此常量；界面端在选择器空态与提交拦截处显示相同文案。
 */
export const NO_MODEL_MESSAGE = '未配置模型'

/**
 * 出厂配置：不预设任何模型，仅含空接口表与默认权限模式。首次启动即为未配置状态，
 * 由界面提示用户配置。
 */
const DEFAULT_CONFIG: QyConfig = {
  providers: {},
  mode: 'auto',
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 迁移前挂在 `StoredModel` 上的两个字段。**只有 `migrateModelLibrary` 读它们**，
 * 解析链一处都不碰——留第二条读取路径就是两本账。
 */
interface LegacyStoredModel {
  maxOutputTokens?: number
  capabilities?: {
    thinking?: ThinkingMode
    effortLevels?: EffortLevel[]
    thinksByDefault?: boolean
    cacheRouting?: CacheRouting
  }
}

/**
 * 一次性迁移：模型库的旧形状 → `catalogKey(id, kind)` 两维键。
 *
 * 三条来源，接口下那两个字段优先（旧解析链里它们本就排在模型库之后）：
 * 一维 `catalog[id]` 的语义是「一份套到所有协议」，所以按该 id 在 `providers`
 * 里出现过的每个 kind 各写一份；`models[id].maxOutputTokens` 与 `.capabilities`
 * 的协议由所在接口直接给出，并进同一个键。
 *
 * 幂等判据是键的形状——一维键与那两个字段跑完一次就不复存在，**不引入版本号**。
 * 同一个键被同协议的多个接口写成不同值时不猜：留接口名字典序靠前的那份，
 * 其余逐条返回给调用方点名。
 *
 * **只改内存里这份，不落盘**：下一次保存配置时旧键随整份写回一起消失。
 */
function migrateModelLibrary(cfg: QyConfig): string[] {
  const providers = cfg.providers ?? {}
  const flatKeys = Object.keys(cfg.catalog ?? {}).filter((k) => !k.includes('|'))
  const hasLegacyFields = Object.values(providers).some((p) =>
    Object.values(p.models ?? {}).some((m) => 'maxOutputTokens' in m || 'capabilities' in m),
  )
  if (flatKeys.length === 0 && !hasLegacyFields) return []

  const notices: string[] = []
  const catalog: Record<string, StoredCatalogEntry> = {}
  for (const [key, entry] of Object.entries(cfg.catalog ?? {})) {
    if (key.includes('|')) catalog[key] = entry
  }

  const kindsOf = new Map<string, Set<ProviderKind>>()
  for (const p of Object.values(providers)) {
    for (const id of Object.keys(p.models ?? {})) {
      const set = kindsOf.get(id) ?? new Set<ProviderKind>()
      set.add(p.kind)
      kindsOf.set(id, set)
    }
  }

  for (const id of flatKeys) {
    const entry = cfg.catalog?.[id]
    if (!entry) continue
    const kinds = kindsOf.get(id)
    if (!kinds) {
      notices.push(`模型库中的 ${id} 未挂在任何接口下，无法判定协议，该条目已丢弃。`)
      continue
    }
    for (const kind of kinds) {
      const key = catalogKey(id, kind)
      catalog[key] = { ...catalog[key], ...entry }
    }
  }

  const owner = new Map<string, string>()
  for (const name of Object.keys(providers).sort()) {
    const p = providers[name]
    if (!p) continue
    for (const [id, model] of Object.entries(p.models ?? {})) {
      const legacy = model as StoredModel & LegacyStoredModel
      const caps = legacy.capabilities
      const entry: StoredCatalogEntry = {
        ...(legacy.maxOutputTokens ? { maxOutputTokens: legacy.maxOutputTokens } : {}),
        ...(caps?.thinking ? { thinking: caps.thinking } : {}),
        ...(caps?.effortLevels ? { effortLevels: caps.effortLevels } : {}),
        ...(caps?.thinksByDefault !== undefined ? { thinksByDefault: caps.thinksByDefault } : {}),
        ...(caps?.cacheRouting ? { cacheRouting: caps.cacheRouting } : {}),
      }
      delete legacy.maxOutputTokens
      delete legacy.capabilities

      const fields = Object.keys(entry)
      if (fields.length === 0) continue
      const key = catalogKey(id, p.kind)
      const held = owner.get(key)
      if (held === undefined) {
        owner.set(key, name)
        catalog[key] = { ...catalog[key], ...entry }
        continue
      }
      const kept = catalog[key] as Record<string, unknown>
      const source = entry as Record<string, unknown>
      const differing = fields.filter((f) => JSON.stringify(kept[f]) !== JSON.stringify(source[f]))
      if (differing.length > 0) {
        notices.push(
          `模型 ${id} 在接口 ${name} 与 ${held} 下的 ${differing.join('、')} 取值不同；` +
            `两个接口协议相同、模型库中仅有一格，已按 ${held} 的取值写入。`,
        )
      }
    }
  }

  if (Object.keys(catalog).length > 0) cfg.catalog = catalog
  else delete cfg.catalog
  return notices
}

/**
 * 配置里读到曾作为思考强度保存的 `none` 时迁成“未选择”：它不再是用户档位，
 * provider 字段随之省略并沿用模型默认。
 *
 * 只改内存，与模型库迁移相同；用户下一次保存配置时旧值自然消失。
 */
function migrateDisabledEffort(cfg: QyConfig): string[] {
  const notices: string[] = []
  for (const [providerName, provider] of Object.entries(cfg.providers ?? {})) {
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      const legacy = model as { effort?: string }
      if (legacy.effort !== 'none') continue
      delete legacy.effort
      notices.push(
        `接口 ${providerName} / ${modelId} 的旧思考值 none 已迁为未选择，将沿用模型默认。`,
      )
    }
  }
  return notices
}

/** 正式 Flash 名称更新后，清掉未使用的旧思考记录，避免它们被当作自建模型。 */
function migrateRetiredDeepSeekOverrides(cfg: QyConfig): string[] {
  const retired = new Set(['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])
  const used = new Set(
    Object.values(cfg.providers ?? {}).flatMap((p) => Object.keys(p.models ?? {})),
  )
  const notices: string[] = []
  for (const [key, entry] of Object.entries(cfg.catalog ?? {})) {
    const id = key.split('|')[0]!
    if (!retired.has(id) || used.has(id)) continue
    // 有人工维护的价格、窗口等规格时保留；这里只清理由旧探测留下的思考记录。
    if (
      Object.keys(entry).some(
        (field) => !['thinking', 'effortLevels', 'thinksByDefault'].includes(field),
      )
    )
      continue
    delete cfg.catalog![key]
    notices.push(`已移除未使用的旧模型 ${id} 的思考记录；正式名称为 deepseek-flash。`)
  }
  return notices
}

export async function loadConfig(): Promise<QyConfig> {
  const raw = await readFile(configPath(), 'utf8').catch(() => null)
  if (raw === null) return structuredClone(DEFAULT_CONFIG)

  let parsed: Partial<QyConfig>
  try {
    parsed = JSON.parse(raw) as Partial<QyConfig>
  } catch {
    // 配置坏了不能让整个 CLI 起不来：用默认值继续，并让调用方看得见这件事。
    log.error('config', '配置文件解析失败，已使用默认配置', { path: configPath() })
    return structuredClone(DEFAULT_CONFIG)
  }

  const cfg: QyConfig = { ...structuredClone(DEFAULT_CONFIG), ...parsed }

  // 模型库的旧形状就地迁成两维键。冲突点名在这里记：这一步在解析阶段，
  // 而 `configNotices` 拿到的已经是迁完的配置，看不见旧键了。
  for (const n of migrateModelLibrary(cfg)) log.warn('config', n)
  for (const n of migrateDisabledEffort(cfg)) log.warn('config', n)
  for (const n of migrateRetiredDeepSeekOverrides(cfg)) log.warn('config', n)

  /*
   * `providers` 是对象就是两层新格式，原样加载。
   *
   * **active 缺席是合法的**——出厂不预设模型，用户配好之前它就是没有。这里不再
   * 校验 active 是否为 ModelRef：坏的 active 由 `diagnoseConfig` / `resolveModel` 兜，
   * 空的 active 是正常状态。
   */
  if (isRecord(parsed.providers)) return cfg

  /*
   * 剩下的是旧的扁平档案（`profiles`）或损坏配置：模型这一块整块回空。
   *
   * 一条旧档案要拆成「一个接口 + 一个模型」，而两条同 kind 同 baseUrl 的档案
   * 该并成一个接口还是两个、key 归谁，只能猜。猜错的表现是「配置看起来还在，
   * 请求发去了另一个端点」——比明说「重配一次」糟得多。
   *
   * 所以模型那部分整块清空、其余设置（权限、额外目录、思考强度）照旧保留，
   * 再由 `configNotices` 点名说清楚。先例是 `autoApprove`：一律忽略，但必须说出来。
   */
  delete cfg.active
  cfg.providers = {}
  return cfg
}

export async function saveConfig(cfg: QyConfig): Promise<void> {
  await mkdir(dirname(configPath()), { recursive: true })
  await writeFile(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
}

/**
 * 这个模型该走哪个接口、带什么凭证。
 *
 * 规则：**先找哪个接口声明了这个模型**，找不到就挂到当前接口上——后者覆盖
 * 「同一家换个模型」这个最常见的情形（例如 DeepSeek 接口下在 v4-flash 和
 * v4-pro 之间切）。不传模型名就是当前生效的那一格。
 *
 * 两个接口都声明了同一个模型时**当前接口优先**。旧实现在这里是
 * `Object.values(...).find(...)`，取的是对象键的枚举顺序——用户选了 A 接口，
 * 请求可能发去 B，而且换个顺序保存一次结果就变了。
 *
 * 多个接口都声明了它、又都不是当前接口时**返回 undefined，不按枚举顺序挑**：
 * 挑错了是端点、key、价目表三样一起换，还不报错。宁可解析失败让调用方报错。
 * 这只在裸模型名入口（CLI `--model`、单轮指定、手动压缩）遇到多接口同名时发生；
 * 传 `ModelRef` 的路径接口已经写死，不到这里。
 *
 * 传 `ModelRef` 则**接口是指定死的**，不再去猜：`classifier` 这类配置写的就是
 * 「哪个接口的哪个模型」，猜一遍只会把用户写死的那一项改掉。
 *
 * 抽出来是因为有多个消费方：`Session.resolveProfile` 决定这一轮真的发给谁，
 * `/api/models` 决定界面上这个模型该显示成什么协议、有哪几档思考强度。
 * 两处各写一遍的话，界面说「这个模型能调思考」而实际那条协议不发，
 * 又是一个选了没反应的控件——而且是**只在某些配置下**才犯。
 */
export function resolveModel(cfg: QyConfig, model?: string | ModelRef): ResolvedModel | undefined {
  const ref = typeof model === 'object' ? model : undefined
  const wanted = typeof model === 'object' ? model.model : (model ?? cfg.active?.model)
  // 既没点名模型、也没有当前默认 → 无从解析。
  if (wanted === undefined) return undefined

  let name: string | undefined
  if (ref) {
    name = ref.provider
  } else {
    const owners = Object.keys(cfg.providers).filter((n) => cfg.providers[n]?.models[wanted])
    const preferred = cfg.active?.provider
    if (preferred && owners.includes(preferred)) {
      name = preferred
    } else if (owners.length > 1) {
      // 多接口同名、又都不是当前接口：不猜。见函数头说明。
      return undefined
    } else {
      name = owners[0] ?? preferred
    }
  }
  if (name === undefined) return undefined

  const provider = cfg.providers[name]
  if (!provider) return undefined
  const declared = provider.models[wanted]
  // 库里的覆盖按「模型 id × 这个接口的协议」取。声不声明过这个模型都取得到——
  // 参数是模型在这条协议上的属性，不是接口下那一格的属性。
  const spec = cfg.catalog?.[catalogKey(wanted, provider.kind)]

  return {
    provider: name,
    kind: provider.kind,
    model: wanted,
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.headers ? { headers: provider.headers } : {}),
    ...(declared?.effort ? { effort: declared.effort } : {}),
    ...(declared?.transport ? { transport: declared.transport } : {}),
    ...(spec ? { spec } : {}),
  }
}

/** 发一次生成请求需要的全部信息。派生值，不落盘。 */
export interface ResolvedMediaModel {
  /** 接口名，即 `providers` 的键。 */
  provider: string
  model: string
  kind: MediaKind
  output: MediaOutput
  apiKey?: string
  baseUrl?: string
  headers?: Record<string, string>
}

/**
 * 找到这一次要用的生成模型：点名了按点名的接口与模型取，没点名取该类别的默认。
 *
 * 点名的模型不在那个接口的 `media` 表里、或类别对不上，返回 undefined，**不回落到别的模型**：
 * 调用方点了名，换一个等于替它改了选择，而生成按次计费。
 */
export function resolveMediaModel(
  cfg: QyConfig,
  output: MediaOutput,
  ref?: ModelRef,
): ResolvedMediaModel | undefined {
  const target = ref ?? cfg.mediaDefaults?.[output]
  if (!target) return undefined
  const provider = cfg.providers[target.provider]
  const stored = provider?.media?.[target.model]
  if (!provider || !stored || MEDIA_KIND_OUTPUT[stored.kind] !== output) return undefined
  return {
    provider: target.provider,
    model: target.model,
    kind: stored.kind,
    output,
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.headers ? { headers: provider.headers } : {}),
  }
}

/** 已配置的一个生成模型。`isDefault` 表示它是该类别的默认。 */
export interface MediaModelEntry {
  provider: string
  model: string
  kind: MediaKind
  output: MediaOutput
  isDefault: boolean
}

/** 已配置的全部生成模型，按接口在配置里的顺序。 */
export function listMediaModels(cfg: QyConfig): MediaModelEntry[] {
  const rows: MediaModelEntry[] = []
  for (const [provider, p] of Object.entries(cfg.providers)) {
    for (const [model, m] of Object.entries(p.media ?? {})) {
      const output = MEDIA_KIND_OUTPUT[m.kind]
      const d = cfg.mediaDefaults?.[output]
      rows.push({
        provider,
        model,
        kind: m.kind,
        output,
        isDefault: d?.provider === provider && d.model === model,
      })
    }
  }
  return rows
}

/**
 * 收集本机所有已知凭证明文，交给起子进程的工具去剥。
 *
 * **所有接口**的 key 都要收，不只是 `active` 那个：用户配了三家就有三把 key，
 * 模型能读到哪一把跟当前用哪个模型毫无关系。
 *
 * 按值剥是唯一不依赖命名习惯的一条：用户把 key 复制进 `MY_STUFF`，
 * 只有按值才抓得到。所以这个函数存在的意义就是**把明文都找齐**。
 * 名字那条判据由 `CREDENTIAL_NAME_PATTERN` 兜，与配置无关。
 */
export function collectSecrets(cfg: QyConfig): { values: string[] } {
  const values = new Set<string>()
  for (const p of Object.values(cfg.providers ?? {})) {
    if (p.apiKey) values.add(p.apiKey)
  }
  return { values: [...values] }
}

/**
 * 配置合规性检查：仅检出结构性错误——此类配置落盘后会静默破坏后续请求。包含两类：
 * 思考档位与模型库枚举值须在允许集合内（越界值将原样发送至 provider 并返回 400，或导致
 * 对应字段不再发送）；`active` 须指向已存在的接口。两类均阻止保存（返回 422 且不落盘）。
 *
 * 缺少 API Key 不属此列，由 `diagnoseRunnable` 处理：若将其计为保存阻断，则「新增接口、
 * 新增模型、随后补填 Key」的配置顺序无法完成。返回空数组表示结构合规、允许落盘；
 * 本函数不校验 Key 的有效性。
 */
export function diagnoseConfig(cfg: QyConfig): string[] {
  const problems: string[] = []
  if (
    cfg.updates !== undefined &&
    (!cfg.updates ||
      typeof cfg.updates.autoCheck !== 'boolean' ||
      typeof cfg.updates.autoDownload !== 'boolean')
  ) {
    problems.push('更新设置必须包含 autoCheck 和 autoDownload 布尔值')
  }
  // 非布尔值落盘之后按真值判定，「关着」会被读成「开着」，而界面上那个开关显示的是
  // 它自己算出来的另一个结果。
  if (cfg.desktopEnabled !== undefined && typeof cfg.desktopEnabled !== 'boolean') {
    problems.push('desktopEnabled 必须是 true 或 false')
  }
  if (cfg.desktopForeground !== undefined && typeof cfg.desktopForeground !== 'boolean') {
    problems.push('desktopForeground 必须是 true 或 false')
  }

  /*
   * 思考档位必须在词表里。
   *
   * 校验必须落在这里——**配置写入的唯一闸门**（`/api/config` 不合法回 422
   * 且不落盘）。落盘一个不在词表里的值，下一轮就被原样发给 provider，
   * 然后是一个 400，而错误信息里只有 provider 的原话。
   */
  for (const [name, p] of Object.entries(cfg.providers)) {
    for (const [id, m] of Object.entries(p.models)) {
      if (m.effort !== undefined && !EFFORT_ORDER.includes(m.effort)) {
        problems.push(
          `${name} / ${id} 的思考强度 "${m.effort}" 不是有效值。\n` +
            `  可选：${EFFORT_ORDER.join('、')}\n` +
            `  这是**档位全集**；该模型实际支持的档位以官方目录和界面选项为准。`,
        )
      }
      if (m.transport?.effort !== undefined && typeof m.transport.effort !== 'boolean') {
        problems.push(
          `${name} / ${id} 的 transport.effort 必须是 true 或 false。\n` +
            `  它只表示当前接口是否透传 effort，不定义模型有哪些档位。`,
        )
      }
      const levels = m.transport?.effortLevels
      if (
        levels !== undefined &&
        (!Array.isArray(levels) || levels.some((level) => !EFFORT_ORDER.includes(level)))
      ) {
        problems.push(`${name} / ${id} 的 transport.effortLevels 必须是有效思考档位数组。`)
      }
      if (m.transport?.thinking !== undefined && !THINKING_MODES.includes(m.transport.thinking)) {
        problems.push(`${name} / ${id} 的 transport.thinking 不是有效参数格式。`)
      }
      const check = m.transport?.toolCalls
      if (
        check !== undefined &&
        (!check ||
          !PROVIDER_KINDS.includes(check.kind) ||
          typeof check.model !== 'string' ||
          typeof check.baseUrl !== 'string' ||
          !TOOL_SCHEMA_MODES.includes(check.schema) ||
          !Number.isFinite(check.checkedAt) ||
          !['passed', 'failed', 'inconclusive'].includes(check.status))
      ) {
        problems.push(`${name} / ${id} 的 transport.toolCalls 不是有效工具检测记录。`)
      }
    }
  }

  /*
   * 模型库那几个枚举必须在词表里，键的协议维也是。
   *
   * 不验的后果**大多是静默的**：`thinking` 打错 → `effortIsTransmittable` 恒 false
   * → 这个模型的 effort 从此不再发送；`cacheRouting` 打错 → 亲和键不再发送；
   * 键的协议维打错 → 这条覆盖永远匹配不上任何请求（取法见 `resolveModel`）。
   * 三种都不报错，而模型库界面把用户填的字符串原样显示回去，看着像生效了。
   *
   * 文案要带**改哪**：这条挡的是 `qy exec` 启动，只说「值不对」而不说去哪改，
   * 用户手边未必有终端。
   */
  const vocabularies = [
    ['thinking', THINKING_MODES],
    ['chatReasoningProtocol', CHAT_REASONING_PROTOCOLS],
    ['reasoningEcho', REASONING_ECHOES],
    ['cacheRouting', CACHE_ROUTINGS],
  ] as const
  for (const [key, entry] of Object.entries(cfg.catalog ?? {})) {
    const kind = key.slice(key.lastIndexOf('|') + 1)
    if (!PROVIDER_KINDS.includes(kind as ProviderKind)) {
      problems.push(
        `模型库的键 "${key}" 里的协议 "${kind}" 不是有效值。\n` +
          `  可选：${PROVIDER_KINDS.join('、')}\n` +
          `  这条覆盖永远匹配不上任何请求。改 ${configPath()} 里 "catalog" 下的键名。`,
      )
    }
    for (const [field, allowed] of vocabularies) {
      const value = (entry as Record<string, unknown>)[field]
      if (value === undefined) continue
      if (!(allowed as readonly string[]).includes(value as string)) {
        problems.push(
          `模型库 "${key}" 的 ${field} "${String(value)}" 不是有效值。\n` +
            `  可选：${allowed.join('、')}\n` +
            `  在设置 → 模型库里重选，或改 ${configPath()} 里 "catalog" 下的这一格。`,
        )
      }
    }
  }

  /*
   * 生成模型的协议必须在词表里，默认生成模型必须指向存在且类别对得上的那一格。
   * 前者错了适配器无从分派；后者错了生成工具不点名时解析不出模型，报的却是「没有默认模型」。
   */
  for (const [name, p] of Object.entries(cfg.providers)) {
    for (const [id, m] of Object.entries(p.media ?? {})) {
      if (!MEDIA_KINDS.includes(m?.kind)) {
        problems.push(
          `${name} / ${id} 的生成协议 "${String(m?.kind)}" 不是有效值。\n` +
            `  可选：${MEDIA_KINDS.join('、')}\n` +
            `  改 ${configPath()} 里这个接口 "media" 下的这一格。`,
        )
      }
    }
  }
  for (const [output, ref] of Object.entries(cfg.mediaDefaults ?? {})) {
    const stored = ref ? cfg.providers[ref.provider]?.media?.[ref.model] : undefined
    if (!MEDIA_OUTPUTS.includes(output as MediaOutput)) {
      problems.push(`默认生成模型的类别 "${output}" 不是有效值。可选：${MEDIA_OUTPUTS.join('、')}`)
    } else if (!ref || !stored) {
      problems.push(
        `默认生成模型 "${ref?.provider} / ${ref?.model}" 不在配置里。\n` +
          `  改 ${configPath()} 里的 "mediaDefaults"。`,
      )
    } else if (MEDIA_KIND_OUTPUT[stored.kind] !== output) {
      problems.push(`默认生成模型 "${ref.provider} / ${ref.model}" 不属于 ${output} 类别。`)
    }
  }

  /*
   * 没有 active 不是致命问题——出厂就是这个状态，也是保存中间态（删光模型再存）的合法形状。
   * **不能报成 problem**：`/api/config` PUT 见 problem 就回 422 且不落盘，那样用户删光最后
   * 一个模型就再也存不下。「没模型」的拦截在起 run 的路径上（`no_model`），不在这里。
   */
  if (!cfg.active) return problems

  const stored = cfg.providers[cfg.active.provider]
  if (!stored) {
    const names = Object.keys(cfg.providers)
    problems.push(
      `配置中不存在名为 "${cfg.active.provider}" 的接口。\n` +
        `  已有接口：${names.length ? names.join('、') : '（无）'}\n` +
        `  修改 ${configPath()} 中的 "active.provider"，或运行 qy init 重建配置。`,
    )
  }

  return problems
}

/**
 * 运行前置检查：`active` 接口是否已配置 API Key。与 `diagnoseConfig` 区分——缺少 Key
 * 属配置过程中的合法中间态，仅阻止运行、不阻止保存：设置页据此提示，配置照常落盘；
 * `qy exec` 据此提前退出并给出配置文件路径，而非 provider 返回的 401。本机端点
 * （localhost / 127.0.0.1）不要求 Key。`active` 指向不存在的接口属结构性错误，
 * 由 `diagnoseConfig` 处理。
 */
export function diagnoseRunnable(cfg: QyConfig): string[] {
  // 出厂没有 active 是正常状态。「没配模型」的拦截在起 run 的路径上（no_model），不在这里。
  if (!cfg.active) return []
  const stored = cfg.providers[cfg.active.provider]
  if (!stored) return []
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)(:|\/|$)/i.test(stored.baseUrl ?? '')
  if (stored.apiKey || local) return []
  return [
    `未配置 API Key：接口 "${cfg.active.provider}" 的 apiKey 为空。\n` +
      `  配置文件：${configPath()}\n` +
      `  推荐做法：运行 qy init\n` +
      `  或手动改为：\n${indent(exampleProvider(cfg.active, stored))}`,
  ]
}

/**
 * 配置提醒：**不阻断运行**，但每次都要说。
 *
 * 两个落点共用这一份文案：终端（`qy` 启动时打印）和设置页（按 markdown 渲染）。
 * 所以正文写成 markdown（列表用 `- `，不用缩进和 `·`），出口也不能只给命令行的
 * ——桌面端用户手边不一定有终端，一条只说「跑 xxx 命令」的提醒对他等于没说。
 * 不为界面单开一份措辞：同一件事两套文案，迟早只改其中一套。
 *
 * 与 `diagnoseConfig` 分开是因为调用方对两者的处置完全不同：
 * `qy exec` 遇到 `diagnoseConfig` 的问题会**直接退出**（没有 key 就发不出请求，
 * 让它跑下去只会拿到一条 401）。而「权限模式是 full」不该阻断执行——
 * 它只是一件必须反复说清的事实。
 *
 * **不要合并成一个函数。** 合并之后加一条 full 模式的提醒，`qy exec` 在 full 下
 * 会**完全拒绝运行**：开了「完全访问」却一条命令都跑不了。
 * 「该说的」和「该拦的」是两件事，混在一个返回值里必然出这种错。
 */
export function configNotices(cfg: QyConfig): string[] {
  const notices: string[] = []

  // 额外根目录写错了要**当场说**，而不是让它安静地不生效。
  // 「配了但不管用」是这个字段第一次被删掉的原因，也是它最容易的失败方式。
  const extras = normalizeAdditionalDirectories(cfg.additionalDirectories)
  for (const p of extras.problems) notices.push(p)
  if (extras.dirs.length > 0) {
    // 不是错误，但必须每次都说：这几个目录在工作区之外，模型可以读写它们。
    notices.push(
      `已放开工作区之外的 ${extras.dirs.length} 个目录（模型可读写）：\n` +
        extras.dirs.map((d) => `- ${d}`).join('\n'),
    )
  }

  // 旧配置里的 autoApprove 已经取消。
  //
  // **只能往严的方向迁移**：`autoApprove: ["execute:"]` 的原意是「全部放行」，
  // 把它自动映射成 `mode: "full"` 是在用户没表态的情况下把防线拆掉。
  // 所以一律忽略、落到默认的 `auto`，并且**必须说出来**——
  // 静默收紧的表现是命令开始被拒，而配置里查不到原因。
  if ((cfg as { autoApprove?: unknown }).autoApprove !== undefined) {
    notices.push(
      `配置中的 autoApprove 已不再生效，权限改为两种模式。\n` +
        `- 当前按 "${cfg.mode ?? 'auto'}" 运行（默认 auto：不弹窗，由规则与分类器裁决）。\n` +
        `- 如需完全放开，在 ${configPath()} 中设置 "mode": "full"，该模式不做任何裁决。\n` +
        `- 删除 autoApprove 这一行即可消除本提示。`,
    )
  }

  /*
   * 当前模型不在内置目录、也没有实测能力 → **必须提醒**。
   *
   * 这条是跑双端点冒烟时照出来的：`gpt-5.4-mini` 不在目录里，
   * `lookupModel` 回落到 `unknownModel()` 的保守值，因此
   *
   * - 适配器**从不请求推理**（`thinking: 'none'` → 整个省略 reasoning 字段），
   *   实测 `reasoning_tokens` 恒为 0，而界面仍把它显示成会思考的模型；
   * - 计价全零，`qy usage` 报 $0——**账本与实际不符**。
   *
   * 两件事都完全静默。保守默认本身是对的（乱发字段会让不支持的端点每次 400），
   * 错的是不说。这正是 ARCHITECTURE §27 那条「不能把『没测』写成『不支持』」，
   * 只不过上一次是在探测器里，这一次在目录里。
   */
  // 旧的扁平 profiles 已经不再加载（见 `loadConfig`）。**必须说**——
  // 不说的话界面上是「配好的接口和 key 全没了」，而配置文件里还原样存着。
  if ((cfg as { profiles?: unknown }).profiles !== undefined) {
    notices.push(
      `配置中的 profiles 为旧格式，已不再加载。模型配置改为「接口 → 模型」两层。\n` +
        `- 当前使用默认接口，**API Key 需要重新填写**（旧的明文仍在配置文件中，可直接复制）。\n` +
        `- 在设置页「模型」中重新配置，或直接修改 ${configPath()} 的 "active" / "providers"。\n` +
        `- 配置完成后删除 profiles 这一段即可消除本提示。`,
    )
  }

  const active = resolveModel(cfg)
  // 模型库里已经有这一条就不提醒：用户已经明确补过模型规格。
  if (active && !active.spec) {
    const spec = lookupModel(active.model, active.kind)
    if (spec.catalogued === false) {
      notices.push(
        `模型 ${active.model} 不在内置目录中：\n` +
          `- 思考档位按当前接口的端点探测结果或模型规格配置确定\n` +
          `- 计价按 0 计算，用量显示为 $0\n` +
          `- 上下文按 ${Math.round(spec.contextWindow / 1000)}K 假设，真实窗口更大时压缩会提前触发\n` +
          `\n端点探测可以检测当前接口接受的思考档位，不能补出窗口和价格；这些规格需在模型库对应条目中明确填写。`,
      )
    }
  }

  if (cfg.sandboxNetwork === 'deny') {
    // 配了但这台机器上没有沙箱 = 完全没有生效。**必须说**——
    // 用户配这一条时想的是「模型跑的命令连不上外网」，而实际上一点约束都没有。
    notices.push(
      '配置中的 sandboxNetwork: "deny" 仅在具备内核沙箱的平台上生效' +
        '（Linux / WSL2 的 bubblewrap、macOS 的 seatbelt）。' +
        '本机档位见「权限与沙箱」一节，或 `qy config` 输出末行的「shell 沙箱」' +
        '——显示 none 即表示该配置未生效。',
    )
  }

  if (cfg.mode === 'full') {
    // 不是错误，是**必须每次都说**的事实。一个放弃了全部裁决的模式
    // 如果安静地跑，用户会忘记自己开过它。
    notices.push(
      `权限模式为 full：模型可以不经裁决执行任何命令、读写任何位置，` +
        `工作区内的 .qy/ 与 .agents/mcp.json 也一并可写。\n` +
        `仍然生效的只有凭证剥离——明文 key 不进子进程，这条与权限模式无关。`,
    )
  }

  return notices
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')
}

function exampleProvider(active: ModelRef, p: StoredProvider): string {
  return JSON.stringify(
    {
      active,
      providers: {
        [active.provider]: {
          kind: p.kind,
          apiKey: 'sk-你的key',
          ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
          models: { [active.model]: {} },
        },
      },
    },
    null,
    2,
  )
}
