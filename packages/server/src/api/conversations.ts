/** 模型目录、会话、消息、run。前端进来第一屏要的全在这。 */

import { builtinCatalog, effortIsTransmittable, lookupModel, VENDORS } from '@qywork/ai'
import type { ConversationId, EffortLevel, RunId } from '@qywork/core'
import { resolveModel } from '@qywork/runtime'
import {
  createConversation,
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
  /** 计价币种。缺省是 USD，阿里 / 月之暗面 / 智谱三家官网按人民币标价。 */
  currency: 'USD' | 'CNY'
  known: boolean
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
      const actual = lookupModel(spec.id, resolveModel(d.config, spec.id)?.kind ?? spec.provider)
      models.push({
        id: spec.id,
        label: spec.displayName,
        provider: actual.provider,
        vendor: spec.vendor,
        // 界面据此决定还要不要显示思考强度那个开关。空数组 = 这条链路上
        // 调不了思考，显示出来就是一个选了没反应的控件。
        effortLevels: effortIsTransmittable(actual) ? actual.effortLevels : [],
        currency: spec.pricing.currency ?? 'USD',
        known: true,
      })
    }
    for (const [name, provider] of Object.entries(d.config.providers)) {
      for (const id of Object.keys(provider.models)) {
        if (seen.has(id)) continue
        seen.add(id)
        models.push({
          id,
          label: `${id}（${name}）`,
          provider: provider.kind,
          vendor: null,
          // 未收录 = 没测过它吃不吃 effort，按 `unknownModel()` 的口径给空。
          effortLevels: [],
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
