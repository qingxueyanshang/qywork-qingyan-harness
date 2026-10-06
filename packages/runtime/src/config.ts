/**
 * 本地配置。
 *
 * 无账号体系：全部配置保存在本机的一个 JSON 文件中，接口由用户填写。
 * 不提供云同步、登录与数据上报。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import {
  CHAT_REASONING_PROTOCOLS,
  type ChatReasoningProtocol,
  findMediaModel,
  lookupModel,
  mediaKindsOf,
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
 * 权限模式。只有两种，不提供逐次审批。
 *
 * 逐次审批的粒度与实际授权不一致：用户看到 `npm test` 后批准，
 * 实际批准的是「任意本机操作 + 全部凭证」：`run_command` 是唯一能同时
 * 绕过 `resolveInWorkspace` 与 SSRF 防护的路径。审批弹窗频繁时，用户会开启
 * 「全部自动批准」开关，审批随之失效。因此只提供两种边界明确的模式。
 *
 * - `auto`：不弹窗。文件工具的路径限定在工作区内，`run_command` 经 `policy.ts` 的
 *   拒绝清单检查。被拒绝时不弹窗，而是把理由作为工具失败返回给模型，由模型改用其他做法。
 * - `full`：不裁决，全部放行；路径边界与受保护目录同样不设。
 *
 * `full` 唯一不豁免的是凭证剥离：它防范的是凭证泄漏，不是越权。
 * 不要把「禁止写 `.qy/`」也写成不豁免：`resolveWritablePath` 在 `unrestricted` 下
 * 直接放行，写成不豁免与代码不符。
 */

/**
 * 指向具体模型的二元指针。
 *
 * 不使用 `"接口/模型"` 拼接串：模型 id 本身可能含斜杠
 * （openrouter 的 `anthropic/claude-3`），拼接后无法无歧义地拆分。
 */
export interface ModelRef {
  /** `providers` 的键。 */
  provider: string
  model: string
}

export interface QyConfig {
  updates?: { autoCheck: boolean; autoDownload: boolean }
  /**
   * 当前生效的「接口 × 模型」。可缺省：出厂不预设模型，用户完成配置之前该字段不存在。
   * 缺省时新会话不带默认模型，发送在启动 run 前被明确拒绝（`no_model`），不回退到任何模型。
   */
  active?: ModelRef
  providers: Record<string, StoredProvider>
  /** 用户修改过的模型参数，键由 `catalogKey` 生成。见 `StoredCatalogEntry`。 */
  catalog?: Record<string, StoredCatalogEntry>
  /**
   * 各类别的默认生成模型：生成工具未指定模型时使用。与 `active` 是同一种指针，指向某个接口的 `media` 表。
   * 缺少某一类别表示该类别没有默认模型；该类别添加第一个模型时由设置页设置。
   */
  mediaDefaults?: Partial<Record<MediaOutput, ModelRef>>
  /** 权限模式，默认 auto。 */
  mode?: PermissionMode
  /**
   * 是否允许 agent 控制内置浏览器。缺省时视为启用，只有显式 `false` 表示关闭。
   *
   * 关闭时装配方不注入浏览器端口，浏览器工具整组不注册；运行中关闭后，下一次页面操作即被拒绝。
   * 只限制 AI 控制：用户在内置浏览器中手动浏览不受影响。
   */
  browserEnabled?: boolean
  /**
   * 是否允许 agent 操作本机上的其他应用（电脑控制）。缺省时视为启用，只有显式 `false` 表示关闭。
   *
   * 关闭时装配方不注入桌面端口，桌面工具整组不注册，而不是注册一组调用必然报错的工具。
   *
   * 它与握手中的 `capabilities.desktop` 含义不同：后者报告本机当前的客观
   * 状态（宿主是否已连接、worker 是否已启动、系统是否已授权），本字段是用户的选择。
   *
   * 占用真实鼠标键盘的操作由 `desktopForeground` 单独控制，缺省时视为启用。
   */
  desktopEnabled?: boolean
  /**
   * 是否允许 agent 使用前台操作：指针、键盘与窗口管理。缺省时视为启用，显式 `false` 表示关闭。
   *
   * 关闭时只有后台语义动作可用：它们经控件接口发出，不移动真实指针、不改变焦点、
   * 不切换前台窗口。启用后可以使用真实鼠标键盘与窗口管理；后台动作失败不会自动重发为前台动作。
   *
   * 该值随每条桌面请求下发到执行组件：运行中关闭后，下一次派发即被拒绝。
   */
  desktopForeground?: boolean
  /**
   * 是否允许 agent 使用 Office 工具制作 Word / PPT / Excel。缺省时视为启用，只有显式 `false` 表示关闭。
   *
   * 关闭时装配方不注入 Office 端口，工具不注册。本机没有可用的 Python 与文档库时，
   * 开启状态下同样不注册：该情形由能力状态决定，与本字段无关。
   */
  officeEnabled?: boolean
  /**
   * 是否允许 agent 使用画布与生成工具（`read_canvas`、`edit_canvas`、`run_canvas`、`retrieve_canvas`、`generate_*`、`retrieve_video`）。
   * 缺省时视为启用，只有显式 `false` 表示关闭。
   *
   * 关闭时这些工具均不注册，提示词中的画布能力行与生成模型参数表随之省略。
   * 只限制 agent：用户在画布页直接运行生成卡不受影响。开启而未配置某一类生成模型时，
   * 该类别的生成工具同样不注册：该情形由模型配置决定，与本字段无关。
   */
  mediaEnabled?: boolean
  /**
   * Office 工具使用的 Python 解释器绝对路径。缺省时在 PATH 中查找 `python`，排除 Windows 商店别名。
   */
  officePython?: string
  /**
   * 工作区之外额外可读写的绝对路径。
   *
   * 该字段同时服务于沙箱与电脑控制两项需求，二者方向相反：前者把边界收紧到工作区，后者
   * 需要访问工作区之外。没有该清单时，访问工作区外的任何路径只能切换到 `full`，即放弃全部裁决，
   * 而不只是开放一个目录。有了该清单，边界仍是白名单，只是白名单中不止一项。
   *
   * 三层都必须接入该字段：路径解析（`resolveInWorkspace`）、静态规则（`policy.ts`）、
   * 沙箱 bind 清单（`sandbox.ts`）。缺少任何一层，该字段即只有声明而没有消费方。
   * 测试覆盖「清单内可写 / 清单外仍拒 / 软链逃逸 / 相对路径被拒」四种情形。
   *
   * `full` 下该层不设。不要写成「`full` 不豁免它」，这与代码不符：
   * `Session.makeToolContext` 在 `full` 下传 `unrestrictedPaths: true`，`resolveInWorkspace` 直接返
   * 回目标路径。「完全访问」的定义是不裁决，路径层同样不设；只放开权限检查而保留路径层，会形
   * 成「`read_file` 被拒、`run_command` 读到」的两套账（见 CLAUDE.md E）。不受模式影响的是凭证
   * 剥离。
   *
   * 只接受绝对路径：相对路径以启动 qy 时所在的目录为基准，从其他目录启动时含义改变。
   */
  additionalDirectories?: string[]
  /**
   * shell 命令是否允许网络访问。默认 `'allow'`。
   *
   * 只有两档，不提供域名白名单：中间档需要在沙箱内启动代理、在沙箱外转发，
   * 并使 TLS 校验信任自签 CA。这套组件在不同机器上会以多种方式失效，
   * 失效时网络间歇性不可用，危害大于不提供该功能。
   *
   * `'deny'` 只在具备内核沙箱的平台上生效（`qy config` 报告当前档位）。
   * 没有沙箱的平台上该值不生效，`configNotices` 会明确提示，
   * 不允许静默失效。
   */
  sandboxNetwork?: 'allow' | 'deny'
  /**
   * 允许透传给子进程的环境变量名（大小写不敏感）。
   *
   * 默认剥离名称形似凭证的变量，但部分命令确实需要这类变量（如 `GITHUB_TOKEN`）。
   * 它只豁免名称模式匹配，不豁免值匹配：变量的值若等于
   * 已配置的 API Key，无论名称如何都必须剥离。
   */
  envAllowList?: string[]
}

/**
 * 接口 = 一套凭证 + 一个端点 + 其下的若干模型。
 *
 * 凭证属于接口层，不属于模型。扁平档案（一个档案一个模型）会使
 * 同一厂商的三个模型把同一个 key 与同一个 baseUrl 各存三份：
 * 修改端点须改三处，遗漏一处时部分模型可用、部分不可用。
 */
export interface StoredProvider {
  kind: ProviderKind
  /**
   * 明文 key。这是取得 key 的唯一途径。
   *
   * 不要并列添加 `apiKeyEnv`（环境变量名）等第二个取值字段。两个字段意味着
   * 两条取值路径：界面显示的与实际发送的可能是两个不同的 key，而两者都显示「已配置」。
   * 凭证剥离不依赖第二个字段：按值剥离依据此处的明文，按名称剥离依据
   * `CREDENTIAL_NAME_PATTERN`，两条规则均已存在。
   */
  apiKey?: string
  baseUrl?: string
  headers?: Record<string, string>
  /** 键是模型 id。 */
  models: Record<string, StoredModel>
  /**
   * 该接口下的生成模型，键是模型 id。与对话模型共用本接口的 key 与地址。
   *
   * 不合并到 `models`：输入框模型选择、子 agent 可选清单、`resolveModel` 都把 `models` 作为对话模型遍历，
   * 合并后须在每一处排除生成模型；遗漏一处，生成模型就会被当作对话模型发送请求。
   */
  media?: Record<string, StoredMediaModel>
}

/** 生成模型在所属接口下的配置项。 */
export interface StoredMediaModel {
  /** 生成请求使用的协议。添加时默认取目录协议，保存后不随接口地址变化。 */
  kind: MediaKind
}

/**
 * 模型库的键：模型 id + 协议。
 *
 * 使用两维是因为同一个模型在不同协议上能力不同（DeepSeek 经 chat/completions 时
 * 无法控制思考，经 Responses 时 `reasoning.effort:'none'` 能关闭思考），
 * 内置目录同样按这两维索引（`lookupModel`）。一维覆盖会把一份参数
 * 套用到两条 seed 上。
 *
 * 分隔符取 `|`：模型 id 可能含斜杠（openrouter 的 `anthropic/claude-3`），但不含 `|`。
 * 不要改成 `/`：改后无法无歧义地拆分，一次性迁移的幂等判据也随之失效。
 */
export function catalogKey(model: string, kind: ProviderKind): string {
  return `${model}|${kind}`
}

/**
 * 用户修改过的模型参数，也是内置目录之上唯一的覆盖层。
 *
 * 窗口、上限、单价是模型本身的属性；思考三项（`thinking` / `effortLevels` /
 * `thinksByDefault`）是该模型在该协议上的能力。两类都由键的第二维
 * （协议）区分，不分开存储。这些官方模型规格不由探测生成。
 *
 * 模型库与接口无关。模型库描述模型在某一协议上的规格，接口描述使用哪个端点与
 * 哪个 key。两者唯一的关联是接口下的模型 id：参数按
 * `catalogKey(id, 接口的 kind)` 从模型库中查询。
 *
 * 允许修改的原因：内置目录是源码中的 seed，其中七家厂商的窗口与价格记录于 2026-07-30，
 * 未逐条实测（见 `catalog.ts`）。厂商调价后目录即失准，并直接体现为
 * 账本金额错误；没有覆盖机制时用户无法修正。
 *
 * 字段全部可选：只写修改过的字段，其余沿用 seed。目录中没有的 id 也能写入条目
 * （`vendor` 决定它在界面上归入哪个分组），用于修正「未收录模型计价按 0 计算、
 * 账本显示 $0」的问题。
 *
 * 字段必须与 `@qywork/ai` 的 `SpecOverride` 一致：合并在该包中进行。
 */
export interface StoredCatalogEntry {
  displayName?: string
  /** 所属厂商分组。目录中已有的条目无需填写，沿用 seed。 */
  vendor?: string
  contextWindow?: number
  maxOutputTokens?: number
  /**
   * 是否接受图片输入。缺省时沿用目录条目（未收录的模型归入「不裁决」一档）。
   * 只有填 `false` 才拒绝图片；中转站的自定义模型名通过该字段纠正。
   */
  vision?: boolean
  /** 每百万 token 的输入 / 输出单价。 */
  input?: number
  output?: number
  /** 缓存命中价。 */
  cacheRead?: number
  /** 缓存写入价。只覆盖 5 分钟一档：`computeCost` 只按该档计算。 */
  cacheWrite?: number
  currency?: 'USD' | 'CNY'
  thinking?: ThinkingMode
  effortLevels?: EffortLevel[]
  thinksByDefault?: boolean
  chatReasoningProtocol?: ChatReasoningProtocol
  /**
   * 带 tool_calls 的历史是否回传推理原文。同属「该模型在该协议上的能力」，
   * 只有 Responses 适配器读取该字段；保存时同一条 entry 会复制到该 id 使用的每种协议，
   * chat 键上的副本不产生影响。
   */
  reasoningEcho?: ReasoningEcho
  /**
   * 缓存路由字段的发送方式。与思考三项同属「该模型在该协议上的能力」，
   * 来源也相同（手动填写或目录 seed；当前探针不检测缓存命中）。
   *
   * 该字段比思考参数更依赖端点：缓存是「端点 × 模型」组合的属性，
   * 同一个模型经不同中转站时结论可能不同。
   */
  cacheRouting?: CacheRouting
}

/**
 * 模型在所属接口下的配置项。
 *
 * 模型能力全部在模型库中，按「模型 × 协议」索引；此处存储用户偏好，以及当前接口
 * 接受哪些思考档位的实测结论。后者只作用于当前路线，不修改官方模型目录。
 */
export interface StoredModel {
  /**
   * 用户为该模型选定的思考档位。`undefined` 表示未选择，不发送思考字段。
   *
   * 该字段按「接口 × 模型」存储，因为各模型的档位集合不同。
   * 不能使用全局的 `config.effort`，本仓库接入的模型档位数从 0 到 5 不等：
   *
   * ```
   * claude-opus-5        low medium high xhigh max
   * deepseek-v4-flash              high       max      ← 没有 low/medium/xhigh
   * gemini-3.1-pro       low medium high                ← 没有 xhigh/max
   * kimi-k3              low        high       max      ← 没有 medium
   * qwen3.7-max          （无档位）
   * deepseek(responses)  （同一模型在该协议上无档位）
   * ```
   *
   * 单一全局值无法容纳这种差异：在 Claude 上选择的 `xhigh` 切换到 DeepSeek 后是
   * 其词表中不存在的值。只使用一家模型时全局字段足够，本仓库同时接入多家，还允许
   * Agent Team 的每个角色各带一个模型（`team-run.ts` 的 `backend.model`）。
   *
   * 这不构成第二个真源：真源仍只有 config.json，只是键的粒度为
   * 「接口 × 模型」。不要在会话表上另存思考档位，那会形成第二个真源。
   */
  effort?: EffortLevel
  /** 该接口对控制参数的透传能力；不属于全局模型能力。 */
  transport?: TransportCapabilities
}

/**
 * 把接口层与模型配置项展开为一次请求所需的全部信息。
 *
 * 派生值，不落盘。落盘的是两层结构，而调用方需要扁平结构；
 * 由各调用方自行组合会导致组合方式不一致。
 */
export interface ResolvedModel {
  /** 接口名，即 `providers` 的键。 */
  provider: string
  kind: ProviderKind
  model: string
  apiKey?: string
  baseUrl?: string
  headers?: Record<string, string>
  /** 模型库中的对应条目。按「模型 id × 接口的 kind」查询，模型库中没有时为 undefined。 */
  spec?: StoredCatalogEntry
  /** 用户为该模型选定的思考档位。undefined 表示未选择，不发送思考字段。 */
  effort?: EffortLevel
  transport?: TransportCapabilities
}

/**
 * 全局层的根目录。配置文件、全局记忆、全局技能都位于该目录下。
 *
 * 定义在 `@qywork/tools`：该包的作用域解析使用同一个根目录，而 tools 位于更底层，
 * 无法引用本包。两处各自计算时，修改 `QYWORK_HOME` 会使配置与全局记忆
 * 位于两个不同的目录。
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
 * 迁移前位于 `StoredModel` 上的两个字段。只有 `migrateModelLibrary` 读取它们，
 * 解析链不读取：保留第二条读取路径会形成两套账。
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
 * 一次性迁移：模型库的旧结构 → `catalogKey(id, kind)` 两维键。
 *
 * 三条来源，接口下的两个字段优先（旧解析链中它们排在模型库之后）：
 * 一维 `catalog[id]` 的语义是「同一份参数用于所有协议」，因此按该 id 在 `providers`
 * 中出现过的每个 kind 各写一份；`models[id].maxOutputTokens` 与 `.capabilities`
 * 的协议由所在接口直接确定，合并到同一个键。
 *
 * 幂等判据是键的形式：执行一次后一维键与这两个字段即不再存在，不引入版本号。
 * 同协议的多个接口为同一个键写入不同值时不推测：保留接口名字典序靠前的取值，
 * 其余逐条返回给调用方报告。
 *
 * 只修改内存中的配置，不落盘：下一次保存配置时，旧键随整份写回一并删除。
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
      notices.push(`模型库中的 ${id} 不属于任何接口，无法判定协议，该条目已丢弃。`)
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
            `两个接口协议相同，模型库中只有一个条目，已按 ${held} 的取值写入。`,
        )
      }
    }
  }

  if (Object.keys(catalog).length > 0) cfg.catalog = catalog
  else delete cfg.catalog
  return notices
}

/**
 * 配置中读取到曾作为思考强度保存的 `none` 时迁移为“未选择”：`none` 不再是用户档位，
 * provider 字段随之省略，沿用模型默认值。
 *
 * 只修改内存，与模型库迁移相同；用户下一次保存配置时旧值随之删除。
 */
function migrateDisabledEffort(cfg: QyConfig): string[] {
  const notices: string[] = []
  for (const [providerName, provider] of Object.entries(cfg.providers ?? {})) {
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      const legacy = model as { effort?: string }
      if (legacy.effort !== 'none') continue
      delete legacy.effort
      notices.push(
        `接口 ${providerName} / ${modelId} 的思考强度 none 已迁移为未选择，将沿用模型默认值。`,
      )
    }
  }
  return notices
}

/** Flash 正式名称更新后，清除未使用的旧思考记录，避免其被当作自建模型。 */
function migrateRetiredDeepSeekOverrides(cfg: QyConfig): string[] {
  const retired = new Set(['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])
  const used = new Set(
    Object.values(cfg.providers ?? {}).flatMap((p) => Object.keys(p.models ?? {})),
  )
  const notices: string[] = []
  for (const [key, entry] of Object.entries(cfg.catalog ?? {})) {
    const id = key.split('|')[0]!
    if (!retired.has(id) || used.has(id)) continue
    // 有人工维护的价格、窗口等规格时保留；此处只清理旧探测留下的思考记录。
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

/**
 * 已收录生成模型保存的协议不在 `mediaKindsOf` 中时，改为目录协议。
 *
 * 此类协议没有已核实的请求格式：经中转站以 OpenAI 兼容协议调用 Grok 视频时，上游按 xAI 格式
 * 返回 `request_id`，适配器无法取得任务号。添加模型时按目录协议保存，设置页也只提供已核实的协议；
 * 已核实的选择不改写。
 *
 * 只修改内存，与模型库迁移相同；用户下一次保存配置时随整份写回。
 */
function migrateUnverifiedMediaKinds(cfg: QyConfig): string[] {
  const notices: string[] = []
  for (const [providerName, provider] of Object.entries(cfg.providers ?? {})) {
    for (const [id, stored] of Object.entries(provider.media ?? {})) {
      const spec = findMediaModel(id)
      if (!spec || mediaKindsOf(spec).includes(stored.kind)) continue
      notices.push(
        `接口 ${providerName} / ${id} 的生成协议 ${stored.kind} 不是该模型已核实的协议，已改为 ${spec.kind}。`,
      )
      stored.kind = spec.kind
    }
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
    // 配置损坏时不能导致整个 CLI 无法启动：使用默认值继续，并向调用方报告该错误。
    log.error('config', '配置文件解析失败，已使用默认配置', { path: configPath() })
    return structuredClone(DEFAULT_CONFIG)
  }

  const cfg: QyConfig = { ...structuredClone(DEFAULT_CONFIG), ...parsed }

  // 模型库的旧结构就地迁移为两维键。冲突在此处记录：迁移发生在解析阶段，
  // 而 `configNotices` 取得的已是迁移完成的配置，无法读取旧键。
  for (const n of migrateModelLibrary(cfg)) log.warn('config', n)
  for (const n of migrateDisabledEffort(cfg)) log.warn('config', n)
  for (const n of migrateRetiredDeepSeekOverrides(cfg)) log.warn('config', n)
  for (const n of migrateUnverifiedMediaKinds(cfg)) log.warn('config', n)

  /*
   * `providers` 为对象时即两层格式，原样加载。
   *
   * active 缺省是合法状态：出厂不预设模型，用户完成配置之前该字段不存在。此处不
   * 校验 active 是否为 ModelRef：无效的 active 由 `diagnoseConfig` / `resolveModel` 处理，
   * 空的 active 是正常状态。
   */
  if (isRecord(parsed.providers)) return cfg

  /*
   * 其余情形是旧的扁平档案（`profiles`）或损坏的配置：模型部分整体置空。
   *
   * 一条旧档案须拆分为「一个接口 + 一个模型」，而两条 kind 与 baseUrl 均相同的档案
   * 应合并为一个接口还是两个、key 归属哪个接口，只能推测。推测错误时配置看似仍在，
   * 请求却发往另一个端点，危害大于明确提示用户重新配置。
   *
   * 因此模型部分整体清空，其余设置（权限、额外目录、思考强度）保留，
   * 并由 `configNotices` 明确提示。`autoApprove` 采用相同处理：一律忽略，但必须提示。
   */
  delete cfg.active
  cfg.providers = {}
  return cfg
}

/** 重命名遇到读方占用时的重试上限。读取配置只占用文件几十微秒。 */
const RENAME_RETRY_MS = 1000

/**
 * 整份写回配置文件。
 *
 * 先写入同目录的临时文件再重命名：直接覆盖时若进程在写入中途退出，文件处于截断状态，下次读取解析失败、
 * 回退到默认配置，接口与 key 全部丢失。重命名在同一卷上是原子操作，读方只会读取到旧文件或新文件。
 *
 * Windows 上目标文件正被另一个进程读取时重命名返回 EPERM / EBUSY（读方打开文件时不允许删除共享），
 * 因此在 `RENAME_RETRY_MS` 内短暂休眠后重试。
 */
export async function saveConfig(cfg: QyConfig): Promise<void> {
  const path = configPath()
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
    const deadline = Date.now() + RENAME_RETRY_MS
    for (;;) {
      try {
        await rename(temporary, path)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if ((code !== 'EPERM' && code !== 'EBUSY') || Date.now() >= deadline) throw err
        await Bun.sleep(10)
      }
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * 解析模型应使用的接口与凭证。
 *
 * 规则：先查找声明了该模型的接口，未找到时归入当前接口。后者覆盖
 * 「同一厂商内更换模型」这一最常见的情形（例如在 DeepSeek 接口下于 v4-flash 与
 * v4-pro 之间切换）。不传模型名时取当前生效的「接口 × 模型」。
 *
 * 两个接口都声明了同一个模型时当前接口优先。不要改成
 * `Object.values(...).find(...)`：它取决于对象键的枚举顺序，用户选择 A 接口时
 * 请求可能发往 B，且保存顺序改变后结果随之改变。
 *
 * 多个接口都声明了该模型且均不是当前接口时，返回 undefined，不按枚举顺序选择：
 * 选错时端点、key、价目表同时改变且不报错，因此以解析失败交由调用方报错。
 * 该情形只在仅传模型名的入口（CLI `--model`、单轮指定、手动压缩）遇到多接口同名时出现；
 * 传 `ModelRef` 的路径已指定接口，不经过此处。
 *
 * 传 `ModelRef` 时接口已明确指定，不再推测：`classifier` 等配置写明的是
 * 「哪个接口的哪个模型」，再次推测只会改变用户指定的接口。
 *
 * 独立为函数是因为有多个消费方：`Session.resolveProfile` 决定本轮请求实际发往的接口，
 * `/api/models` 决定界面上该模型显示的协议与思考强度档位。
 * 两处各自实现时，界面显示该模型可调节思考，而实际协议不发送思考字段，
 * 控件选择后无效，且只在部分配置下出现。
 */
export function resolveModel(cfg: QyConfig, model?: string | ModelRef): ResolvedModel | undefined {
  const ref = typeof model === 'object' ? model : undefined
  const wanted = typeof model === 'object' ? model.model : (model ?? cfg.active?.model)
  // 既未指定模型、也没有当前默认模型时无法解析。
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
      // 多接口同名且均不是当前接口：不推测。见函数头说明。
      return undefined
    } else {
      name = owners[0] ?? preferred
    }
  }
  if (name === undefined) return undefined

  const provider = cfg.providers[name]
  if (!provider) return undefined
  const declared = provider.models[wanted]
  // 模型库中的覆盖按「模型 id × 该接口的协议」查询。无论接口是否声明过该模型都能取得：
  // 参数是模型在该协议上的属性，不是接口下模型配置项的属性。
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

/** 一次生成请求所需的全部信息。派生值，不落盘。 */
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
 * 解析本次使用的生成模型：指定时按指定的接口与模型查询，未指定时取该类别的默认模型。
 *
 * 指定的模型不在该接口的 `media` 表中或类别不一致时，返回 undefined，不回退到其他模型：
 * 调用方已指定模型，替换即改变调用方的选择，而生成按次计费。
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

/** 已配置的生成模型。`isDefault` 表示它是该类别的默认模型。 */
export interface MediaModelEntry {
  provider: string
  model: string
  kind: MediaKind
  output: MediaOutput
  isDefault: boolean
}

/** 已配置的全部生成模型，按接口在配置中的顺序。 */
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
 * 收集本机所有已知凭证明文，交给启动子进程的工具剥离。
 *
 * 收集所有接口的 key，不只是 `active` 接口的：用户配置三家接口就有三个 key，
 * 模型能读取哪一个与当前使用哪个模型无关。
 *
 * 按值剥离是唯一不依赖命名习惯的规则：用户把 key 复制到 `MY_STUFF` 时，
 * 只有按值匹配才能识别。因此该函数的用途是收集全部明文。
 * 按名称的判据由 `CREDENTIAL_NAME_PATTERN` 负责，与配置无关。
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
  // 非布尔值落盘后按真值判定，关闭会被读取为开启，而界面开关显示的是
  // 按另一种方式计算出的结果。
  if (cfg.browserEnabled !== undefined && typeof cfg.browserEnabled !== 'boolean') {
    problems.push('browserEnabled 必须是 true 或 false')
  }
  if (cfg.desktopEnabled !== undefined && typeof cfg.desktopEnabled !== 'boolean') {
    problems.push('desktopEnabled 必须是 true 或 false')
  }
  if (cfg.desktopForeground !== undefined && typeof cfg.desktopForeground !== 'boolean') {
    problems.push('desktopForeground 必须是 true 或 false')
  }
  if (cfg.officeEnabled !== undefined && typeof cfg.officeEnabled !== 'boolean') {
    problems.push('officeEnabled 必须是 true 或 false')
  }
  if (cfg.mediaEnabled !== undefined && typeof cfg.mediaEnabled !== 'boolean') {
    problems.push('mediaEnabled 必须是 true 或 false')
  }
  if (
    cfg.officePython !== undefined &&
    (typeof cfg.officePython !== 'string' || !isAbsolute(cfg.officePython))
  ) {
    problems.push('officePython 必须是 Python 解释器的绝对路径')
  }

  /*
   * 思考档位必须在词表里。
   *
   * 校验必须在此处进行：这是配置写入的唯一入口（`/api/config` 收到不合法内容时返回 422
   * 且不落盘）。不在词表中的值落盘后，下一轮会被原样发送给 provider，
   * 并返回 400，而错误信息中只有 provider 的原文。
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
   * 模型库中的枚举字段与键的协议维都必须在词表中。
   *
   * 不校验时错误大多是静默的：`thinking` 写错时 `effortIsTransmittable` 恒为 false，
   * 该模型的 effort 不再发送；`cacheRouting` 写错时缓存路由字段不再发送；
   * 键的协议维写错时该覆盖不匹配任何请求（查询方式见 `resolveModel`）。
   * 三种情形都不报错，而模型库界面原样显示用户填写的字符串，看似已生效。
   *
   * 文案必须写明修改位置：该检查会阻止 `qy exec` 启动，只说明取值无效而不说明修改位置时，
   * 用户未必有终端可用于排查。
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
        `模型库的键 "${key}" 中的协议 "${kind}" 不是有效值。\n` +
          `  可选：${PROVIDER_KINDS.join('、')}\n` +
          `  该覆盖不会匹配任何请求。修改 ${configPath()} 中 "catalog" 下的键名。`,
      )
    }
    for (const [field, allowed] of vocabularies) {
      const value = (entry as Record<string, unknown>)[field]
      if (value === undefined) continue
      if (!(allowed as readonly string[]).includes(value as string)) {
        problems.push(
          `模型库 "${key}" 的 ${field} "${String(value)}" 不是有效值。\n` +
            `  可选：${allowed.join('、')}\n` +
            `  在设置 → 模型库中重新选择，或修改 ${configPath()} 中 "catalog" 下的对应字段。`,
        )
      }
    }
  }

  /*
   * 生成模型的协议必须在词表中，默认生成模型必须指向已存在且类别一致的配置项。
   * 前者错误时适配器无法分派；后者错误时生成工具未指定模型即无法解析，报告的却是「没有默认模型」。
   */
  for (const [name, p] of Object.entries(cfg.providers)) {
    for (const [id, m] of Object.entries(p.media ?? {})) {
      if (!MEDIA_KINDS.includes(m?.kind)) {
        problems.push(
          `${name} / ${id} 的生成协议 "${String(m?.kind)}" 不是有效值。\n` +
            `  可选：${MEDIA_KINDS.join('、')}\n` +
            `  修改 ${configPath()} 中该接口 "media" 下的对应条目。`,
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
        `默认生成模型 "${ref?.provider} / ${ref?.model}" 不在配置中。\n` +
          `  修改 ${configPath()} 中的 "mediaDefaults"。`,
      )
    } else if (MEDIA_KIND_OUTPUT[stored.kind] !== output) {
      problems.push(`默认生成模型 "${ref.provider} / ${ref.model}" 不属于 ${output} 类别。`)
    }
  }

  /*
   * 没有 active 不是致命问题：出厂即为该状态，也是保存中间状态（删除全部模型后保存）的合法形式。
   * 不能报告为 problem：`/api/config` PUT 遇到 problem 即返回 422 且不落盘，用户删除最后
   * 一个模型后将无法保存。未配置模型的拦截位于启动 run 的路径上（`no_model`），不在此处。
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
  // 出厂没有 active 是正常状态。未配置模型的拦截位于启动 run 的路径上（no_model），不在此处。
  if (!cfg.active) return []
  const stored = cfg.providers[cfg.active.provider]
  if (!stored) return []
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)(:|\/|$)/i.test(stored.baseUrl ?? '')
  if (stored.apiKey || local) return []
  return [
    `未配置 API Key：接口 "${cfg.active.provider}" 的 apiKey 为空。\n` +
      `  配置文件：${configPath()}\n` +
      `  推荐做法：运行 qy init\n` +
      `  或手动修改为：\n${indent(exampleProvider(cfg.active, stored))}`,
  ]
}

/**
 * 配置提醒：不阻断运行，但每次都须显示。
 *
 * 终端（`qy` 启动时打印）与设置页（按 markdown 渲染）共用同一份文案。
 * 因此正文使用 markdown（列表用 `- `，不用缩进和 `·`），处理方式也不能只给出命令行操作：
 * 桌面端用户不一定有终端可用，只写「运行 xxx 命令」的提醒对其无效。
 * 不为界面另写一份措辞：同一件事有两套文案时，修改容易遗漏其中一套。
 *
 * 与 `diagnoseConfig` 分开是因为调用方对两者的处置完全不同：
 * `qy exec` 遇到 `diagnoseConfig` 的问题会直接退出（没有 key 时无法发送请求，
 * 继续执行只会得到 401）。而模型未收录等提醒不应阻断执行，
 * 因此不能与配置错误合并。
 */
export function configNotices(cfg: QyConfig): string[] {
  const notices: string[] = []

  // 额外根目录配置错误时必须立即提示，不允许静默失效。
  // 配置后不生效是该字段最常见的失败方式。
  const extras = normalizeAdditionalDirectories(cfg.additionalDirectories)
  for (const p of extras.problems) notices.push(p)
  if (extras.dirs.length > 0) {
    // 不是错误，但必须每次提示：这些目录在工作区之外，模型可以读写。
    notices.push(
      `已开放工作区之外的 ${extras.dirs.length} 个目录（模型可读写）：\n` +
        extras.dirs.map((d) => `- ${d}`).join('\n'),
    )
  }

  // 配置中的 autoApprove 已取消。
  //
  // 只能向更严格的方向迁移：`autoApprove: ["execute:"]` 的原意是「全部放行」，
  // 自动映射为 `mode: "full"` 等于在用户未确认的情况下取消全部裁决。
  // 因此一律忽略、回退到默认的 `auto`，并且必须提示：
  // 静默收紧会使命令开始被拒绝，而配置中无从查明原因。
  if ((cfg as { autoApprove?: unknown }).autoApprove !== undefined) {
    notices.push(
      `配置中的 autoApprove 已不再生效，权限改为两种模式。\n` +
        `- 当前按 "${cfg.mode ?? 'auto'}" 运行（默认 auto：不弹出确认框，由硬边界与静态规则裁决）。\n` +
        `- 如需完全访问，在 ${configPath()} 中设置 "mode": "full"，该模式不做任何裁决。\n` +
        `- 删除 autoApprove 字段即可消除本提示。`,
    )
  }

  // 扁平 profiles 已不再加载（见 `loadConfig`），必须提示：
  // 否则界面上已配置的接口与 key 全部消失，而配置文件中仍原样保存。
  if ((cfg as { profiles?: unknown }).profiles !== undefined) {
    notices.push(
      `配置中的 profiles 为旧格式，已不再加载。模型配置改为「接口 → 模型」两层。\n` +
        `- 当前使用默认接口，**API Key 需要重新填写**（旧的明文仍在配置文件中，可直接复制）。\n` +
        `- 在设置页「模型」中重新配置，或直接修改 ${configPath()} 的 "active" / "providers"。\n` +
        `- 配置完成后删除 profiles 字段即可消除本提示。`,
    )
  }

  /*
   * 当前模型不在内置目录中且没有实测能力时，必须提醒。
   *
   * 该问题由双端点冒烟测试发现：`gpt-5.4-mini` 不在目录中，
   * `lookupModel` 回退到 `unknownModel()` 的保守值，因此
   *
   * - 适配器从不请求推理（`thinking: 'none'` 时省略整个 reasoning 字段），
   *   实测 `reasoning_tokens` 恒为 0，而界面仍将其显示为支持思考的模型；
   * - 计价全部为零，`qy usage` 显示 $0，账本与实际不符。
   *
   * 两者都不报错。保守默认值本身正确（发送端点不支持的字段会使请求每次返回 400），
   * 缺少的是提示。对应 ARCHITECTURE §27「不能把『没测』写成『不支持』」一条。
   */
  const active = resolveModel(cfg)
  // 模型库中已有该模型的条目时不提醒：用户已明确填写模型规格。
  if (active && !active.spec) {
    const spec = lookupModel(active.model, active.kind)
    if (spec.catalogued === false) {
      notices.push(
        `模型 ${active.model} 不在内置目录中：\n` +
          `- 思考档位按当前接口的端点探测结果或模型规格配置确定\n` +
          `- 计价按 0 计算，用量显示为 $0\n` +
          `- 上下文窗口按 ${Math.round(spec.contextWindow / 1000)}K 计算，真实窗口更大时压缩会提前触发\n` +
          `\n端点探测可以检测当前接口接受的思考档位，无法取得窗口与价格；这些规格需在模型库对应条目中明确填写。`,
      )
    }
  }

  if (cfg.sandboxNetwork === 'deny') {
    // 已配置但本机没有沙箱时该配置完全不生效，必须提示：
    // 用户配置该项时预期模型执行的命令无法访问外网，而实际没有任何限制。
    notices.push(
      '配置中的 sandboxNetwork: "deny" 仅在具备内核沙箱的平台上生效' +
        '（Linux / WSL2 的 bubblewrap、macOS 的 seatbelt）。' +
        '本机档位见「权限与沙箱」一节，或 `qy config` 输出末行的「shell 沙箱」' +
        '；显示 none 即表示该配置未生效。',
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
