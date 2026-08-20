/** 模型目录、会话、消息、run。前端进来第一屏要的全在这。 */

import type { ModelSpec } from '@qywork/ai'
import {
  applySpecOverride,
  builtinCatalog,
  effortIsTransmittable,
  lookupModel,
  unknownModel,
  VENDORS,
} from '@qywork/ai'
import type { ConversationId, EffortLevel, RunId } from '@qywork/core'
import { catalogKey, contextPanel, resolveModel, type StoredCatalogEntry } from '@qywork/runtime'
import {
  archiveConversation,
  createConversation,
  currentGoal,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  listProviderRequests,
  listRuns,
  listSteps,
  setConversationTitle,
} from '@qywork/store'
import { type ApiHandler, json } from './types.ts'

/** 一个接口下挂着的一个模型。**只列配置里真有的**——没配的选了也发不出去。 */
interface ModelRow {
  id: string
  /** 内置目录里的显示名；目录里没有就是 id 本身。 */
  label: string
  /** 这个模型吃哪几档思考强度。空数组 = 这条链路上调不了，界面据此不显示开关。 */
  effortLevels: EffortLevel[]
  /**
   * 用户为这个模型选定的档。`null` = 没选过，不发思考字段。
   *
   * **和 `effortLevels` 一起下发**：一个是「这个模型有哪几档」，一个是
   * 「当前选的是哪档」，两者都逐模型不同，分两处取必然出现「档位面是 A 模型的、
   * 选定值是 B 模型的」。不走握手也是这个原因——握手是连接级、只报一次，
   * 用户切一次模型那个值就不再成立。
   */
  effort: EffortLevel | null
  /** 计价币种。缺省是 USD，阿里 / 月之暗面 / 智谱三家官网按人民币标价。 */
  currency: 'USD' | 'CNY'
  /** false = 内置目录里没有，计价与能力都只能按保守值算。 */
  known: boolean
}

/** 一个接口。名字是用户自己起的，界面上就按它分组。 */
interface ProviderRow {
  name: string
  models: ModelRow[]
}

/**
 * 模型库里的一条 = **一个模型的参数**。
 *
 * 它和接口是两件事，库里一个接口字段都没有：库回答「这个模型多大、多贵、
 * 吃哪几档思考」，接口回答「用谁的端点和哪把 key」。两者唯一的接点是接口下
 * 那一行模型 id——参数照着 id 从库里查（`lookupModel` + `applySpecOverride`）。
 *
 * `source` 分两种，与「改过没有」一一对应：`seed` 是源码里的内置值，
 * `user` 是用户在库里改过或自己加的。分开报是为了让「还原成内置值」有依据——
 * 不报的话，界面没法判断这一条能不能还原、还原成什么。
 */
interface LibraryModel {
  id: string
  label: string
  contextWindow: number
  maxOutputTokens: number
  input: number
  output: number
  /** 缓存命中价。 */
  cacheRead: number
  /** 缓存写入价（5 分钟档）。`computeCost` 只按这一档算。 */
  cacheWrite: number
  currency: 'USD' | 'CNY'
  effortLevels: EffortLevel[]
  /**
   * 这条链路上思考**怎么发**（协议标识），以及**不选档时发不发**。
   *
   * 与 `effortLevels` 同属「这个模型在这条协议上的思考能力」，一起下发才是完整的
   * 一格。少给这两个，模型库上就只能看见档位而看不见「它到底会不会思考」——
   * 而 `qy probe --save` 写回的正是这三项。
   */
  thinking: string
  thinksByDefault: boolean
  source: 'seed' | 'user'
  /**
   * 这条价目的偏离说明：分时段折扣、长上下文换档。**没有偏离就不带这个键。**
   *
   * 一个数组而不是几个并列的可选字符串：界面对它们的处置完全一样（原样列出来），
   * 分成几个键只会让渲染那边多一段拼接，而且下一种偏离又要再加一个键。
   *
   * **上面那几个价是厂商公布的标准价**，界面必须把这些一起显示出来——
   * 只画一个数字的话，用户对着账单会发现「怎么和这里写的不一样」，而差价是两倍。
   * 这属于能力边界，不许折叠也不许降对比度（CLAUDE.md B7）。
   */
  priceNotes?: string[]
}

interface LibraryVendor {
  id: string
  displayName: string
  models: LibraryModel[]
}

/**
 * 模型库：**参数表**，按厂商分组。
 *
 * 三条口径：
 *
 * - **同一个 id 只出一条。** 目录里同 id 多条是给 `lookupModel` 按协议查能力用的
 *   （DeepSeek 有兼容和 Responses 两条）。协议是接口的属性，摆进参数表就是让
 *   用户在两条看起来一样的模型之间选，而他手里没有判据。
 * - **用户加的模型也在表里**，按它的 `vendor` 归组；没写 vendor 的归到「自定义」。
 *   不列的话，「未收录模型计价按 0 算、账本报 $0」就仍然没有出口。
 * - **档位按厂商默认协议算。** 这一条还没挂到任何接口上，真正能调哪几档由
 *   接口那侧说了算。
 */
function buildLibrary(overrides: Record<string, StoredCatalogEntry>): LibraryVendor[] {
  const rows = new Map<string, { spec: ModelSpec; source: 'seed' | 'user' }>()
  for (const m of builtinCatalog()) {
    if (rows.has(m.id)) continue
    // 覆盖按「模型 + 协议」两维存（`catalogKey`），而这张表一个模型只出一行——
    // 取该模型在目录里的首条协议。写回时由保存侧套到这个 id 的全部协议上，
    // 读写两侧的口径差**只在这一处**，不要在别处再各自换算一次。
    const o = overrides[catalogKey(m.id, m.provider)]
    rows.set(m.id, { spec: applySpecOverride(m, o), source: o ? 'user' : 'seed' })
  }
  // 目录里没有的（用户自己加的一条）补进来：`unknownModel` 给一组保守默认值，
  // 覆盖里写了什么就显示什么。键的第二维在这里丢掉——自加模型只可能有一条协议。
  for (const [key, o] of Object.entries(overrides)) {
    const id = key.split('|')[0] ?? key
    if (rows.has(id)) continue
    rows.set(id, {
      spec: applySpecOverride(unknownModel(id, 'openai_chat_completions'), o),
      source: 'user',
    })
  }

  const groups = new Map<string, LibraryVendor>()
  for (const v of VENDORS) groups.set(v.id, { id: v.id, displayName: v.displayName, models: [] })
  // 「自定义」不是一家厂商，是「没挂到任何一家名下」的那些。放最后。
  const custom: LibraryVendor = { id: '', displayName: '自定义', models: [] }

  for (const { spec, source } of rows.values()) {
    const notes = [spec.offPeak?.note, spec.longContext?.note].filter((n) => n !== undefined)
    const row: LibraryModel = {
      id: spec.id,
      label: spec.displayName,
      contextWindow: spec.contextWindow,
      maxOutputTokens: spec.maxOutputTokens,
      input: spec.pricing.input,
      output: spec.pricing.output,
      cacheRead: spec.pricing.cacheRead,
      cacheWrite: spec.pricing.cacheWrite5m,
      currency: spec.pricing.currency ?? 'USD',
      effortLevels: effortIsTransmittable(spec) ? spec.effortLevels : [],
      thinking: spec.thinking,
      thinksByDefault: spec.thinksByDefault,
      source,
      ...(notes.length ? { priceNotes: notes } : {}),
    }
    const group = (spec.vendor && groups.get(spec.vendor)) || custom
    group.models.push(row)
  }

  return [...groups.values(), custom].filter((v) => v.models.length > 0)
}

export const handleConversationsApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/models') {
    /*
     * 可选模型 = **用户配置里的接口 × 它挂着的模型**，模型库不并进来。
     *
     * 并集那版列的是「世上有哪些模型」，而用户要选的是「我配好的哪一个」——
     * 选一个没挂在任何接口下的模型，请求会按当前接口发出去，端点、key、价目表
     * 全是另一家的，且不报错。接口这一层不出现在选择器里，配了三个接口也没法切。
     */
    const overrides = d.config.catalog ?? {}
    const providers: ProviderRow[] = Object.entries(d.config.providers).map(([name, provider]) => ({
      name,
      models: Object.keys(provider.models).map((id) => {
        const declared = provider.models[id]
        // 能力（思考三项）与参数（窗口、上限、单价）同在模型库这一个覆盖层里，
        // 按「模型 + 协议」取——`qy probe --save` 落的就是这个键。
        const spec = applySpecOverride(
          lookupModel(id, provider.kind),
          overrides[catalogKey(id, provider.kind)],
        )
        return {
          id,
          label: spec.catalogued === false ? id : spec.displayName,
          // 界面据此决定还要不要显示思考强度那个开关。空数组 = 这条链路上
          // 调不了思考，显示出来就是一个选了没反应的控件。
          effortLevels: effortIsTransmittable(spec) ? spec.effortLevels : [],
          effort: declared?.effort ?? null,
          currency: spec.pricing.currency ?? 'USD',
          known: spec.catalogued !== false,
        }
      }),
    }))
    return json({ providers, active: d.config.active, library: buildLibrary(overrides) })
  }

  if (p === '/api/conversations') {
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as {
        title?: string
        provider?: string
        model?: string
      }
      // 接口和模型是一对：给了模型没给接口就退回整对默认值，
      // 而不是把新模型挂到默认接口下——那个组合用户从没配过。
      const ref =
        body.provider && body.model
          ? { provider: body.provider, model: body.model }
          : d.config.active
      const conv = createConversation(d.store, {
        workspaceId: d.workspaceId as never,
        provider: ref.provider,
        model: ref.model,
        ...(body.title ? { title: body.title } : {}),
      })
      return json({ conversation: conv })
    }
    return json({ conversations: listConversations(d.store, d.workspaceId as never) })
  }

  /*
   * 归档一条会话：只从列表里去掉，数据一条不动。形状与字段都对齐项目级的
   * `POST /api/workspaces/:id/archive`，只是范围缩到一条。
   *
   * **正在跑的不拦**：归档不删任何东西，那一轮照常跑完。（删除必须拦，见下。）
   */
  const archiveMatch = /^\/api\/conversations\/([^/]+)\/archive$/.exec(p)
  if (archiveMatch && req.method === 'POST') {
    const id = archiveMatch[1] as ConversationId
    if (!getConversation(d.store, id)) return json({ error: 'conversation not found' }, 404)
    // 已经归档过的回 false。这里当成功处理：用户要的终态（不在列表里）已经成立。
    archiveConversation(d.store, id)
    return json({ ok: true })
  }

  const oneMatch = /^\/api\/conversations\/([^/]+)$/.exec(p)
  if (oneMatch) {
    const id = oneMatch[1] as ConversationId

    /*
     * 重命名。PATCH 而不是 `POST /rename`：改的是这一行上的一个字段，与项目行
     * 的置顶同形状。空标题回 422 且不落盘——它在侧栏会被兜底成「新对话」，
     * 看起来像改名没生效。
     */
    if (req.method === 'PATCH') {
      const body = (await req.json().catch(() => ({}))) as { title?: unknown }
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      if (!title) return json({ error: '标题不能为空' }, 422)
      const conv = setConversationTitle(d.store, id, title)
      if (!conv) return json({ error: 'conversation not found' }, 404)
      // 广播而不是只回发起方：手机和桌面可能同时开着这个会话，
      // 与 `conversation.setModel` 同一条理由。
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
     * 硬删：消息、run、步骤等随 FK 级联一起走，不是打标记让它从列表消失
     * （那是上面那条「归档」）。
     *
     * **正在跑的回 409**，判据与 `conversation.compact` 同一个：级联删掉的
     * run / step 那一轮还在往里写。
     */
    if (req.method === 'DELETE') {
      if (!getConversation(d.store, id)) return json({ error: 'conversation not found' }, 404)
      if (d.runs.isBusy(id)) return json({ error: '该会话正在执行，请先中断再删除' }, 409)
      deleteConversation(d.store, id)
      return json({ ok: true })
    }
  }

  const convMatch = /^\/api\/conversations\/([^/]+)\/(messages|runs)$/.exec(p)
  if (convMatch) {
    const id = convMatch[1] as ConversationId
    if (!getConversation(d.store, id)) return json({ error: 'conversation not found' }, 404)
    return convMatch[2] === 'messages'
      ? json({ messages: listMessages(d.store, id) })
      : json({ runs: listRuns(d.store, id) })
  }

  // 上下文面板。**按会话现算，不靠事件残留**——事件只在 run 跑着时流，
  // 而用户恰恰是回头看的时候才想知道上下文被谁占的。
  const ctxMatch = /^\/api\/conversations\/([^/]+)\/context$/.exec(p)
  if (ctxMatch) {
    const id = ctxMatch[1] as ConversationId
    const conv = getConversation(d.store, id)
    if (!conv) return json({ error: 'conversation not found' }, 404)
    // 窗口按**这条会话的接口 × 模型**解析。`active.provider` 是接口名不是协议名，
    // 拿它当 kind 会让中转站上的 claude 走错目录条目。
    const stored = resolveModel(
      d.config,
      conv.provider ? { provider: conv.provider, model: conv.model } : conv.model,
    )
    const kind = stored?.kind ?? d.config.providers[d.config.active.provider]?.kind
    const spec = lookupModel(conv.model, kind ?? 'openai_chat_completions')
    return json({ context: contextPanel(d.store, id, spec.contextWindow) })
  }

  // 当前目标。**按会话读账本，和上下文面板同一条理由**——`goal` 事件只在变更
  // 那一刻发一次，界面刷新、切走再切回来就什么都没有了。而目标恰恰是跨轮、
  // 跨进程存在的东西：续起标记不落盘，重启之后账本里那个 `active` 的目标
  // 静静躺着等人点继续，界面看不见它就等于那个循环凭空消失了。
  const goalMatch = /^\/api\/conversations\/([^/]+)\/goal$/.exec(p)
  if (goalMatch) {
    const id = goalMatch[1] as ConversationId
    if (!getConversation(d.store, id)) return json({ error: 'conversation not found' }, 404)
    // 没立过目标就是 null，不是 404——「这条会话没有目标」是正常状态。
    return json({ goal: currentGoal(d.store, id) })
  }

  /*
   * 现在有没有一次授权在等这条会话拍板。
   *
   * **和上面两条同一个理由，但代价更大**：`permission.request` 只在发起那一刻广播
   * 一次，界面一重建（切走再切回、断线补不上缺口整条重拉）那张卡就没了，而服务端
   * 那个 promise 还在等——用户看到的是一轮卡着不动、没有任何可点的东西，
   * 五分钟后按拒绝超时。真源是 `RunManager` 内存里的那张表，这里只是把它读出来。
   */
  const permMatch = /^\/api\/conversations\/([^/]+)\/permission$/.exec(p)
  if (permMatch) {
    const id = permMatch[1] as ConversationId
    if (!getConversation(d.store, id)) return json({ error: 'conversation not found' }, 404)
    // 没人在等就是 null，不是 404——「这条会话现在不需要拍板」是正常状态。
    return json({ permission: d.runs.pendingFor(id) })
  }

  const stepMatch = /^\/api\/runs\/([^/]+)\/steps$/.exec(p)
  if (stepMatch) {
    return json({ steps: listSteps(d.store, stepMatch[1] as RunId) })
  }

  /*
   * 逐请求账本。
   *
   * `usage.turns` 回答不了「这一轮到底发了几次」——它只在拿到 usage 回报时
   * 才 push 一条，连接层失败后重发的那一次在它里面不存在。而这张表是**发出之前**
   * 就落行的，重发是独立一行（`retry_index`），所以它才是请求次数的真源。
   */
  const requestMatch = /^\/api\/runs\/([^/]+)\/requests$/.exec(p)
  if (requestMatch) {
    return json({ requests: listProviderRequests(d.store, requestMatch[1] as RunId) })
  }

  if (p === '/api/runs/active') {
    return json({
      active: d.runs.listActive().map((r) => ({ runId: r.runId, startedAt: r.startedAt })),
    })
  }

  return null
}
