/** 模型目录、会话、消息、run。前端进来第一屏要的全在这。 */

import type { ModelSpec, ProviderProfile } from '@qywork/ai'
import { builtinCatalog, effortIsTransmittable, lookupModel, VENDORS } from '@qywork/ai'
import type { ConversationId, EffortLevel, RunId } from '@qywork/core'
import { contextPanel, resolveModel } from '@qywork/runtime'
import {
  createConversation,
  currentGoal,
  getConversation,
  listConversations,
  listMessages,
  listRuns,
  listSteps,
} from '@qywork/store'
import { type ApiHandler, json } from './types.ts'

interface ModelRow {
  id: string
  label: string
  provider: string
  vendor: string | null
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
  known: boolean
}

/**
 * 把 `qy probe --save` 实测出来的能力叠到目录条目上。
 *
 * **与 `buildAdapter` 是同一件事**（`ai/src/factory.ts:68-78`），必须同一个口径：
 * 那边决定请求里真的发哪几档，这里决定界面上能选哪几档。这里不叠的话，
 * **校准过的档位决定得了发出去的请求，却决定不了界面上的选项**——探测器写回的
 * capabilities 有生产者没消费者，用户探完一看界面纹丝不动。
 *
 * 顺序与那边一致：目录是猜的，探测是实测的，越往后越权威。
 */
function withProbed(
  spec: ModelSpec,
  stored: { capabilities?: ProviderProfile['capabilities'] } | undefined,
): ModelSpec {
  const probed = stored?.capabilities
  if (!probed) return spec
  return {
    ...spec,
    ...(probed.thinking ? { thinking: probed.thinking } : {}),
    ...(probed.effortLevels ? { effortLevels: probed.effortLevels } : {}),
    ...(probed.thinksByDefault !== undefined ? { thinksByDefault: probed.thinksByDefault } : {}),
  }
}

export const handleConversationsApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/models') {
    // 可选模型 = 内置目录 ∪ 用户档案里声明的模型。
    // 并集是必须的：用户接自建端点或中转时，模型 id 内置目录里根本没有，
    // 只列内置的会让「切模型」在最需要它的场景下没有选项。
    const seen = new Set<string>()
    const models: ModelRow[] = []
    for (const spec of builtinCatalog()) {
      if (seen.has(spec.id)) continue
      seen.add(spec.id)
      // **按这个模型实际会走哪条协议查目录，不是按目录里那条的原生协议。**
      //
      // 同一个模型在两条协议下的思考控制面是两套（DeepSeek 就是活例子）。
      // 用原生那条报出去，经中转站以兼容协议调 Claude 的用户会看到五档
      // 思考强度，而那条协议根本不发 Anthropic 的思考字段——又一个
      // 选了没反应的控件，且只在某些配置下才犯，最难被当成 bug 报出来。
      const stored = resolveModel(d.config, spec.id)
      const actual = withProbed(lookupModel(spec.id, stored?.kind ?? spec.provider), stored)
      models.push({
        id: spec.id,
        label: spec.displayName,
        provider: actual.provider,
        vendor: spec.vendor,
        // 界面据此决定还要不要显示思考强度那个开关。空数组 = 这条链路上
        // 调不了思考，显示出来就是一个选了没反应的控件。
        effortLevels: effortIsTransmittable(actual) ? actual.effortLevels : [],
        effort: stored?.effort ?? null,
        currency: spec.pricing.currency ?? 'USD',
        known: true,
      })
    }
    for (const [name, provider] of Object.entries(d.config.providers)) {
      for (const id of Object.keys(provider.models)) {
        if (seen.has(id)) continue
        seen.add(id)
        const actual = withProbed(lookupModel(id, provider.kind), {
          capabilities: provider.models[id]?.capabilities,
        })
        models.push({
          id,
          label: `${id}（${name}）`,
          provider: provider.kind,
          vendor: null,
          // 未收录的模型目录里查不到档位，**但探过就算数**：`qy probe --save`
          // 写回的 capabilities 是实测事实，比「按 unknownModel() 给空」准。
          // 写死 `[]` 的话，自建端点探完了界面上照样没有档位可选。
          effortLevels: effortIsTransmittable(actual) ? actual.effortLevels : [],
          effort: provider.models[id]?.effort ?? null,
          // 未收录的计价本来就是 0，币种给 USD 只是占位——前端按「未知计价」显示。
          currency: 'USD',
          known: false,
        })
      }
    }
    return json({
      models,
      // 厂商表给设置页填表用：选了厂商就能带出协议、端点、key 的环境变量名。
      vendors: VENDORS,
      active: d.config.active.model,
    })
  }

  if (p === '/api/conversations') {
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { title?: string; model?: string }
      const conv = createConversation(d.store, {
        workspaceId: d.workspaceId as never,
        model: body.model ?? d.config.active.model,
        ...(body.title ? { title: body.title } : {}),
      })
      return json({ conversation: conv })
    }
    return json({ conversations: listConversations(d.store, d.workspaceId as never) })
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
    // 窗口按**这条会话的模型**解析。`active.provider` 是接口名不是协议名，
    // 拿它当 kind 会让中转站上的 claude 走错目录条目。
    const stored = resolveModel(d.config, conv.model)
    const kind = stored?.kind ?? d.config.providers[d.config.active.provider]?.kind
    const spec = lookupModel(conv.model, kind ?? 'openai_compatible')
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

  if (p === '/api/runs/active') {
    return json({
      active: d.runs.listActive().map((r) => ({ runId: r.runId, startedAt: r.startedAt })),
    })
  }

  return null
}
