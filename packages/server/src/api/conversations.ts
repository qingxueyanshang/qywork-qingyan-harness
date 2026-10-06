/** 模型目录、会话、消息与 run 的接口，前端首屏所需的数据均由此提供。 */

import { rm } from 'node:fs/promises'
import { MAX_RESENDS } from '@qywork/agent'
import type { MediaOperation, MediaParamSpec, ModelSpec } from '@qywork/ai'
import {
  applySpecOverride,
  applyTransportCapabilities,
  builtinCatalog,
  describeParam,
  effortIsTransmittable,
  lookupMediaModel,
  lookupModel,
  mediaCatalog,
  officialBaseUrl,
  unknownModel,
  VENDORS,
} from '@qywork/ai'
import type {
  ConversationChangesPageResponse,
  ConversationHistoryPageResponse,
  ConversationId,
  ConversationLiveSnapshot,
  ConversationRunsResponse,
  ConversationUsageResponse,
  EffortLevel,
  MediaKind,
  MediaOutput,
  MessageId,
  RunId,
  ToolSchemaMode,
} from '@qywork/core'
import { MEDIA_KIND_OUTPUT } from '@qywork/core'
import {
  catalogKey,
  contextPanel,
  exportConversationDiagnostics,
  listMediaModels,
  type QyConfig,
  resolveModel,
  type StoredCatalogEntry,
} from '@qywork/runtime'
import {
  archiveConversation,
  createConversation,
  currentGoal,
  deleteConversation,
  getConversation,
  listChildConversations,
  listConversationChangesPage,
  listConversationHistoryPage,
  listConversations,
  listProviderRequests,
  listRuns,
  setConversationTitle,
  usageEntries,
  usageTotals,
} from '@qywork/store'
import { attachmentsDirOf } from './attachments.ts'
import { type ApiHandler, type ApiRequestDeps, json } from './types.ts'

/** 接口下配置的一个模型。只列出配置中存在的模型：未配置的模型无法发出请求。 */
export interface ModelRow {
  chatToolSchema: ToolSchemaMode
  id: string
  /** Base URL 留空时使用的官方地址；未登记时省略。 */
  defaultBaseUrl?: string
  /** 内置目录中的显示名；目录未收录时为 id 本身。 */
  label: string
  /** 该模型支持的思考强度档位。空数组表示当前接口无法调节思考强度，界面据此不显示开关。 */
  effortLevels: EffortLevel[]
  /**
   * 用户为该模型选定的档位。`null` 表示未选择，请求不发送思考字段。
   *
   * 必须与 `effortLevels` 一起下发：`effortLevels` 是该模型支持的档位，本字段是当前选定的档位，
   * 两者均逐模型不同，分两处获取会出现档位列表属于 A 模型、选定值属于 B 模型的情况。
   * 不经由握手下发的原因相同：握手是连接级、只上报一次，用户切换模型后该值即失效。
   */
  effort: EffortLevel | null
  /** 计价币种。缺省为 USD，阿里、月之暗面、智谱三家官网按人民币标价。 */
  currency: 'USD' | 'CNY'
  /**
   * 是否接受图片输入。该能力逐模型不同，因此与 `effortLevels` 一起在此下发，
   * 不经由握手：握手是连接级、只上报一次，用户切换模型后该值即失效。
   *
   * 界面只在值为 `false` 时隐藏图片附件入口。`null` 表示没有可靠来源，不限制图片附件。
   */
  vision: boolean | null
  /** 是否支持通过当前协议直接输入视频。 */
  video: boolean
  /** false 表示内置目录未收录，计价与能力按保守值计算。 */
  known: boolean
}

/** 一个接口。名称由用户设定，界面按名称分组。 */
export interface ProviderRow {
  name: string
  models: ModelRow[]
}

/**
 * `/api/models` 的响应形状。
 *
 * 导出该类型供测试与前端直接引用：各自按实现另写一份形状时，修改字段名不会使它们的
 * 类型检查失败，因为它们校验的是自行定义的形状。
 */
export interface ModelsResponse {
  providers: ProviderRow[]
  /** 当前选中的接口与模型，形状与配置中的 `active` 一致。 */
  active: QyConfig['active']
  library: LibraryVendor[]
  /**
   * 已配置的生成模型，按接口在配置中的顺序排列。与 `providers` 分开：生成模型不能用于对话，
   * 输入框的模型选择只读取 `providers`，无需逐行排除。
   */
  media: MediaModelRow[]
  /** 内置生成目录，供模型库的生成类页签使用。只收录各厂商的最新一代模型。 */
  mediaLibrary: MediaLibraryModel[]
}

/** 接口下配置的一个生成模型。 */
export interface MediaModelRow {
  provider: string
  id: string
  kind: MediaKind
  output: MediaOutput
  label: string
  operations: MediaOperation[]
  /** 是否为该类别的默认模型。 */
  isDefault: boolean
  /** false 表示生成目录未收录，参数表取协议默认值。 */
  known: boolean
  /** 画布生成面板上的参数控件。仅包含目录中标注了 `label` 的参数，其余参数只提供给大模型。 */
  params: MediaParamRow[]
}

/** 生成面板上的一个参数控件，取自目录的 `MediaParamSpec`，不含提供给大模型的说明。 */
export type MediaParamRow = Omit<MediaParamSpec, 'description'> & { label: string }

/** 生成目录中的一个条目。`params` 是供用户阅读的参数表，每行一个参数，文字与提供给大模型的相同。 */
export interface MediaLibraryModel {
  id: string
  label: string
  vendor: string | null
  kind: MediaKind
  /** 目录中的原生协议及已实现的兼容映射。 */
  kinds: MediaKind[]
  output: MediaOutput
  operations: MediaOperation[]
  maxImages: number
  maxVideos: number
  params: string[]
}

/**
 * 模型库中的一个条目，即一个模型的参数。
 *
 * 模型库与接口相互独立，模型库中不含任何接口字段：模型库描述模型的上下文大小、价格与
 * 支持的思考档位，接口描述使用哪个端点与哪个 key。两者唯一的关联是接口下配置的模型 id，
 * 参数按 id 从模型库查询（`lookupModel` + `applySpecOverride`）。
 */
export interface LibraryModel {
  id: string
  label: string
  contextWindow: number
  /** `null` 表示该模型的输出上限未经测定，请求中不发送该字段。 */
  maxOutputTokens: number | null
  /**
   * 是否接受图片输入。`null` 表示厂商规格页未注明，不等于不支持；
   * 界面按三态显示，不要折算为布尔值。
   */
  vision: boolean | null
  input: number | null
  output: number | null
  /** 缓存命中价。 */
  cacheRead: number | null
  /** 缓存写入价（5 分钟档）。`computeCost` 只按该档计算。 */
  cacheWrite: number | null
  currency: 'USD' | 'CNY'
  effortLevels: EffortLevel[]
  /**
   * 不选择强度时模型是否思考。必须与 `effortLevels` 一起下发才能完整描述思考能力：
   * 缺少该字段时，没有可选档位但默认思考的模型与不支持思考的模型显示相同。
   *
   * 协议内部字段（以哪套参数发送思考设置）不下发：该字段由适配器处理，用户无法也不应判断。
   */
  thinksByDefault: boolean
  /**
   * 该价目的偏离说明：分时段折扣、长上下文分档价格。没有偏离时不带该键。
   *
   * 使用数组而不是多个并列的可选字符串：界面对各项的处理完全相同（原样列出），
   * 拆成多个键会使渲染侧多一段拼接，且每新增一种偏离都要新增一个键。
   *
   * 上述价格是厂商公布的标准价，界面必须同时显示偏离说明：只显示一个价格时，
   * 用户的实际账单会与界面不一致，差额可达两倍。
   * 该说明属于能力边界，不得折叠，也不得降低对比度（CLAUDE.md B7）。
   */
  priceNotes?: string[]
}

export interface LibraryVendor {
  id: string
  displayName: string
  models: LibraryModel[]
}

/**
 * 模型库：参数表，按厂商分组。
 *
 * 三条口径：
 *
 * - **同一个 id 只出现一次。** 目录中同一 id 的多个条目供 `lookupModel` 按协议查询能力
 *   （DeepSeek 有兼容协议与 Responses 两个条目）。协议是接口的属性，放进参数表会让
 *   用户在两个外观相同的模型之间选择，而用户没有判断依据。
 * - **用户添加的模型同样列出**，按其 `vendor` 分组；未填写 vendor 的归入「自定义」。
 *   不列出时，未收录模型计价为 0、账本记为 $0 的问题无处修正。
 * - **档位按厂商默认协议计算。** 模型库条目不关联任何接口，实际可用的档位由接口一侧决定。
 */
function buildLibrary(overrides: Record<string, StoredCatalogEntry>): LibraryVendor[] {
  const rows = new Map<string, ModelSpec>()
  for (const m of builtinCatalog()) {
    if (rows.has(m.id)) continue
    // 覆盖按「模型 + 协议」两个维度存储（`catalogKey`），而本表每个模型只占一行，
    // 因此取该模型在目录中的第一个协议。写回时由保存侧应用到该 id 的全部协议，
    // 读写两侧的口径差异只在此处处理，不要在别处另行换算。
    const o = overrides[catalogKey(m.id, m.provider)]
    rows.set(m.id, applySpecOverride(m, o))
  }
  // 补入目录未收录的模型（用户自行添加的条目）：`unknownModel` 提供一组保守默认值，
  // 覆盖中填写的值按原样显示。此处丢弃键的第二维：用户添加的模型只可能有一个协议。
  for (const [key, o] of Object.entries(overrides)) {
    const id = key.split('|')[0] ?? key
    if (rows.has(id)) continue
    rows.set(id, applySpecOverride(unknownModel(id, 'openai_chat_completions'), o))
  }

  const groups = new Map<string, LibraryVendor>()
  for (const v of VENDORS) groups.set(v.id, { id: v.id, displayName: v.displayName, models: [] })
  // 「自定义」不是厂商，而是未归入任何厂商的模型，排在最后。
  const custom: LibraryVendor = { id: '', displayName: '自定义', models: [] }

  for (const spec of rows.values()) {
    const notes = [
      spec.pricing.note,
      spec.offPeak?.note,
      ...(spec.longContext ?? []).map((t) => t.note),
    ].filter((n) => n !== undefined)
    const row: LibraryModel = {
      id: spec.id,
      label: spec.displayName,
      contextWindow: spec.contextWindow,
      maxOutputTokens: spec.maxOutputTokens,
      vision: spec.vision,
      input: spec.pricing.input,
      output: spec.pricing.output,
      cacheRead: spec.pricing.cacheRead,
      cacheWrite: spec.pricing.cacheWrite5m,
      currency: spec.pricing.currency ?? 'USD',
      effortLevels: effortIsTransmittable(spec) ? spec.effortLevels : [],
      thinksByDefault: spec.thinksByDefault,
      ...(notes.length ? { priceNotes: notes } : {}),
    }
    const group = (spec.vendor && groups.get(spec.vendor)) || custom
    group.models.push(row)
  }

  return [...groups.values(), custom].filter((v) => v.models.length > 0)
}

/**
 * 运行中轮次的只读快照，供刷新后恢复当前请求所处的阶段。
 *
 * 三项数据均实时读取，不新增状态表：运行中的轮次取自 `RunManager`（账本中的状态列在
 * 进程崩溃之后仍可能保留 `running`），请求时刻取自 `provider_requests` 中对应的行，
 * 重试次数与退避截止时刻取自失败诊断中的 `retry`。
 *
 * 只统计主请求（`purpose='turn'`）：摘要请求不发送 `run.request`，计入后会使刷新后的
 * 阶段与实时事件指向两次不同的请求。
 */
function liveSnapshot(d: ApiRequestDeps, id: ConversationId): ConversationLiveSnapshot | null {
  const runId = d.runs.currentRunId(id)
  if (!runId) return null
  const rows = listProviderRequests(d.store, runId).filter((r) => r.purpose === 'turn')
  const last = rows.at(-1)
  const seq = d.bus.currentSeq
  if (!last) return { runId, seq, request: null }

  /*
   * 次数按故障链计数，不按 `retry_index`：该列在每个 turn 内从 0 开始，带上下文重发之后
   * 会把第 3 次重连报为第 0 次。链上前一行的裁决记录了即将进行的次数，
   * 该值即为本行的序号。
   */
  const settled = last.completedAt !== null
  const decided = settled ? last : rows.at(-2)
  const retry = decided?.diagnostic?.retry
  const resend = retry?.decision === 'resend' ? retry : null
  return {
    runId,
    seq,
    request: {
      requestId: last.id,
      attempt: resend?.attempt ?? 0,
      max: resend?.max ?? MAX_RESENDS,
      status: last.status,
      sentAt: last.sentAt,
      headersAt: last.headersAt,
      firstContentAt: last.firstContentAt,
      lastContentAt: last.lastContentAt,
      lastContentKind: last.lastContentKind,
      lastVisibleAt: last.lastVisibleAt,
      // 仅当本次请求已失败且下一次尚未登记时处于等待状态：下一行登记后，本行不再是当前请求。
      backoffUntil:
        settled && resend && resend.at !== null ? resend.at + (resend.backoffMs ?? 0) : null,
    },
  }
}

export const handleConversationsApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/models') {
    /*
     * 可选模型 = 用户配置的接口 × 接口下配置的模型，不并入模型库。
     *
     * 并入模型库后列出的是存在哪些模型，而用户要选择的是已配置的模型：选择一个未配置在
     * 任何接口下的模型时，请求按当前接口发出，端点、key 与价目表均属于另一家，且不报错。
     * 选择器中没有接口这一层时，配置了多个接口也无法切换。
     */
    const overrides = d.config.catalog ?? {}
    const providers: ProviderRow[] = Object.entries(d.config.providers).map(([name, provider]) => ({
      name,
      models: Object.keys(provider.models).map((id) => {
        const declared = provider.models[id]
        // 模型能力与参数按「模型 + 协议」从官方目录与模型库获取；当前中转站是否透传
        // 控制参数只看该接口下此模型条目的 transport，不能写回全局目录。
        const spec = applyTransportCapabilities(
          lookupModel(id, provider.kind),
          declared?.transport,
          overrides[catalogKey(id, provider.kind)],
        )
        const effortLevels = effortIsTransmittable(spec) ? spec.effortLevels : []
        const defaultBaseUrl = officialBaseUrl(spec)
        return {
          id,
          ...(defaultBaseUrl ? { defaultBaseUrl } : {}),
          chatToolSchema: spec.chatToolSchema,
          label: spec.catalogued === false ? id : spec.displayName,
          // 界面据此决定是否显示思考强度开关。空数组表示当前接口无法调节思考强度，
          // 此时显示的开关选择后不产生任何效果。
          effortLevels,
          // 目录或端点校准变化后，旧选择不在可用档位中时视为未选择，不显示失效的状态。
          effort:
            declared?.effort && effortLevels.includes(declared.effort) ? declared.effort : null,
          currency: spec.pricing.currency ?? 'USD',
          vision: spec.vision,
          video: spec.video,
          known: spec.catalogued !== false,
        }
      }),
    }))
    const media: MediaModelRow[] = listMediaModels(d.config).map((m) => {
      const spec = lookupMediaModel(m.model, m.kind)
      return {
        provider: m.provider,
        id: m.model,
        kind: m.kind,
        output: m.output,
        label: spec.catalogued ? spec.displayName : m.model,
        operations: [...spec.operations],
        isDefault: m.isDefault,
        known: spec.catalogued,
        params: spec.params.flatMap(({ description: _d, label, ...rest }) =>
          label ? [{ ...rest, label }] : [],
        ),
      }
    })
    const mediaLibrary: MediaLibraryModel[] = mediaCatalog().map((spec) => ({
      id: spec.id,
      label: spec.displayName,
      vendor: spec.vendor,
      kind: spec.kind,
      kinds: [spec.kind, ...(Object.keys(spec.mappings ?? {}) as MediaKind[])],
      output: MEDIA_KIND_OUTPUT[spec.kind],
      operations: [...spec.operations],
      maxImages: spec.inputs.maxImages,
      maxVideos: spec.inputs.maxVideos,
      params: spec.params.map(describeParam),
    }))
    const res: ModelsResponse = {
      providers,
      active: d.config.active,
      library: buildLibrary(overrides),
      media,
      mediaLibrary,
    }
    return json(res)
  }

  if (p === '/api/conversations') {
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as {
        title?: string
        provider?: string
        model?: string
      }
      // 接口与模型成对使用：只给出模型而未给出接口时回退到整对默认值，
      // 不把新模型关联到默认接口下，因为用户从未配置过该组合。
      // 未配置默认模型时留空：发送在启动 run 前被 no_model 拦截，界面引导用户在选择器中选择模型。
      const ref =
        body.provider && body.model
          ? { provider: body.provider, model: body.model }
          : d.config.active
      const conv = createConversation(d.store, {
        workspaceId: d.workspaceId as never,
        provider: ref?.provider ?? '',
        model: ref?.model ?? '',
        ...(body.title ? { title: body.title } : {}),
      })
      return json({ conversation: conv })
    }
    return json({ conversations: listConversations(d.store, d.workspaceId as never) })
  }

  /*
   * 归档一条会话：只从列表中移除，不改动任何数据。形状与字段均与项目级的
   * `POST /api/workspaces/:id/archive` 一致，范围为单条会话。
   *
   * 运行中的会话不拦截：归档不删除任何数据，该轮照常执行完毕。删除必须拦截，见下文。
   *
   * 不关闭内置浏览器页面：归属未变，页面保留在宿主上；关闭页面只由删除会话触发。
   */
  const archiveMatch = /^\/api\/conversations\/([^/]+)\/archive$/.exec(p)
  if (archiveMatch && req.method === 'POST') {
    const id = archiveMatch[1] as ConversationId
    if (!getConversation(d.store, id)) return json({ error: 'conversation not found' }, 404)
    // 已归档的会话返回 false。此处按成功处理：用户要求的终态（不在列表中）已经成立。
    archiveConversation(d.store, id)
    return json({ ok: true })
  }

  const oneMatch = /^\/api\/conversations\/([^/]+)$/.exec(p)
  if (oneMatch) {
    const id = oneMatch[1] as ConversationId

    /*
     * 重命名。使用 PATCH 而不是 `POST /rename`：修改的是该行的一个字段，与项目行的
     * 置顶形状相同。空标题返回 422 且不落盘：空标题在侧栏中回退显示为「新对话」，
     * 界面上等同于改名未生效。
     */
    if (req.method === 'PATCH') {
      const body = (await req.json().catch(() => ({}))) as { title?: unknown }
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      if (!title) return json({ error: '标题不能为空' }, 422)
      const conv = setConversationTitle(d.store, id, title)
      if (!conv) return json({ error: 'conversation not found' }, 404)
      // 广播而不是只返回给发起方：手机与桌面可能同时打开该会话，
      // 理由与 `conversation.setModel` 相同。
      d.bus.publish(
        {
          type: 'conversation.updated',
          conversationId: conv.id,
          provider: conv.provider,
          model: conv.model,
          title: conv.title,
          updatedAt: conv.updatedAt,
        },
        id,
      )
      return json({ conversation: conv })
    }

    /*
     * 硬删除：消息、run、步骤等随外键级联删除，而不是打标记使会话从列表消失
     * （后者是上文的归档）。
     *
     * 运行中的会话返回 409，判据与 `conversation.compact` 相同：级联删除的
     * run / step 仍在被该轮写入。
     */
    if (req.method === 'DELETE') {
      if (!getConversation(d.store, id)) return json({ error: 'conversation not found' }, 404)
      if (d.runs.isBusy(id)) return json({ error: '该会话正在执行，请先中断再删除' }, 409)
      // 先关闭该会话名下的内置浏览器 AI 页面：会话删除后页面归属无从追溯，保留即成为孤立页面。
      await d.closeBrowserPages(id)
      deleteConversation(d.store, id)
      /*
       * 附件目录随会话一并删除。只删除该目录，不按 `Attachment.path` 逐条删除：
       * 路径型附件指向用户自己的文件（拖入的原图、项目中的文档），逐条删除即删除用户数据。
       * 该目录中只存放没有其他副本的字节（剪贴板位图、浏览器上传），删除不影响其他记录。
       *
       * 删除失败不改变接口结果：回收的是磁盘空间，与正确性无关。
       */
      await rm(attachmentsDirOf(id), { recursive: true, force: true }).catch(() => {})
      /*
       * 正文回收放在主库删除提交之后。若放在同一事务中，事务回滚会恢复引用，
       * 而已删除的字节无法恢复，形成悬空引用。
       *
       * 回收失败单独返回一个字段，不并入 `error`：会话已从账本中删除，报告删除失败会使用户
       * 再次删除并收到 404。本次未回收的空间在下次启动或下次删除时回收。
       */
      let reclaimError: string | null = null
      try {
        d.collectGarbage()
      } catch (err) {
        reclaimError = `已删除，但正文空间未回收：${err instanceof Error ? err.message : String(err)}`
      }
      return json(reclaimError ? { ok: true, reclaimError } : { ok: true })
    }
  }

  /*
   * 当前会话的诊断快照。必须在服务端从持久化账本实时读取，不能把前端已经折叠、
   * 分页过的投影重新拼接：排查「只调用工具、不说话」需要依据完整的 step 与
   * provider request 判断内容在哪一层消失。
   */
  const exportMatch = /^\/api\/conversations\/([^/]+)\/export$/.exec(p)
  if (exportMatch && req.method === 'GET') {
    const id = exportMatch[1] as ConversationId
    if (!getConversation(d.store, id)) return json({ error: 'conversation not found' }, 404)
    return new Response(exportConversationDiagnostics(d.store, id, d.config), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="qywork-session-${id}.json"`,
      },
    })
  }

  const convMatch =
    /^\/api\/conversations\/([^/]+)\/(history|changes|messages|runs|usage|queue)$/.exec(p)
  if (convMatch) {
    const id = convMatch[1] as ConversationId
    if (!getConversation(d.store, id)) return json({ error: 'conversation not found' }, 404)
    if (convMatch[2] === 'history') {
      const rawLimit = url.searchParams.get('limit')
      const limit = rawLimit === null ? 30 : Number(rawLimit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return json({ error: 'limit 必须是 1 到 100 的整数' }, 422)
      }
      const before = url.searchParams.get('before')?.trim() || null
      const page: ConversationHistoryPageResponse = {
        ...listConversationHistoryPage(d.store, id, {
          limit,
          before: before as MessageId | null,
        }),
        live: liveSnapshot(d, id),
      }
      return json(page)
    }
    if (convMatch[2] === 'changes') {
      const rawLimit = url.searchParams.get('limit')
      const limit = rawLimit === null ? 10 : Number(rawLimit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return json({ error: 'limit 必须是 1 到 100 的整数' }, 422)
      }
      const before = url.searchParams.get('before')?.trim() || null
      const page: ConversationChangesPageResponse = listConversationChangesPage(d.store, id, {
        limit,
        before: before as MessageId | null,
      })
      return json(page)
    }
    if (convMatch[2] === 'runs') {
      // 并入子会话的轮次：子会话不在本会话的对话流中，但其费用由本会话引发。
      // 名称取子会话标题，与卡片上显示的名称一致。
      const payload: ConversationRunsResponse = {
        runs: listRuns(d.store, id),
        childRuns: listChildConversations(d.store, id).flatMap((child) =>
          listRuns(d.store, child.id).map((run) => ({ name: child.title, run })),
        ),
      }
      return json(payload)
    }
    // 排队中的跟进消息。刷新与重连之后卡片据此重建；与 `queue.changed` 同源，
    // 均读取 `RunManager` 中的同一份队列，快照与增量因此不会不一致。
    if (convMatch[2] === 'queue') return json({ queue: d.runs.queueOf(id) })
    // 本会话的完整花费。真源是账本而不是 `runs` 上的 usage：压缩摘要调用同样由本会话
    // 引发并计费，但不属于任何一轮，将各 run 相加必然少计。
    // 不设时间窗：查询的是本会话的总花费，从会话创建时起算。
    const usage: ConversationUsageResponse = {
      totals: usageTotals(d.store, { conversationId: id }),
      entries: usageEntries(d.store, { conversationId: id }),
    }
    return json(usage)
  }

  // 上下文面板。按会话实时计算，不依赖已推送的事件：事件只在 run 运行时推送，
  // 而用户需要在事后查看上下文的占用构成。
  const ctxMatch = /^\/api\/conversations\/([^/]+)\/context$/.exec(p)
  if (ctxMatch) {
    const id = ctxMatch[1] as ConversationId
    const conv = getConversation(d.store, id)
    if (!conv) return json({ error: 'conversation not found' }, 404)
    if (!conv.provider) return json({ error: '该会话未记录所属接口，请重新选择模型后继续' }, 409)
    // 上下文窗口按本会话的接口 × 模型解析。`active.provider` 是接口名不是协议名，
    // 将其用作 kind 会使中转站上的 claude 匹配到错误的目录条目。
    const stored = resolveModel(d.config, { provider: conv.provider, model: conv.model })
    if (!stored) return json({ error: '会话绑定的接口或模型已不在配置中' }, 409)
    const kind = stored.kind
    const spec = lookupModel(conv.model, kind)
    return json({
      context: contextPanel(d.store, id, {
        ...spec,
        providerName: conv.provider,
        providerKind: kind,
      }),
    })
  }

  // 当前目标。按会话读取账本，理由与上下文面板相同：`goal` 事件只在变更时发送一次，
  // 界面刷新或切换会话后无法再取得。目标是跨轮次、跨进程存在的状态：自动继续标记不落盘，
  // 重启之后账本中 `active` 的目标处于等待用户点击继续的状态；界面不显示该目标时，用户无法继续它。
  const goalMatch = /^\/api\/conversations\/([^/]+)\/goal$/.exec(p)
  if (goalMatch) {
    const id = goalMatch[1] as ConversationId
    if (!getConversation(d.store, id)) return json({ error: 'conversation not found' }, 404)
    // 未设定目标时返回 null，不返回 404：会话没有目标是正常状态。
    return json({ goal: currentGoal(d.store, id) })
  }

  /*
   * 逐请求账本。
   *
   * `usage.turns` 无法回答一轮发送了几次请求：它只在取得 usage 数据时追加一条，
   * 连接层失败后重发的请求不在其中。本表在请求发出之前写入，每次重发是独立一行
   * （`retry_index`），因此是请求次数的真源。
   */
  const requestMatch = /^\/api\/runs\/([^/]+)\/requests$/.exec(p)
  if (requestMatch) {
    return json({ requests: listProviderRequests(d.store, requestMatch[1] as RunId) })
  }

  return null
}
