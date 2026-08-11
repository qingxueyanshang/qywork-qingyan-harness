/** 模型目录、会话、消息、run。前端进来第一屏要的全在这。 */

import { builtinCatalog } from '@qywork/ai'
import type { ConversationId, RunId } from '@qywork/core'
import {
  createConversation,
  getConversation,
  listConversations,
  listMessages,
  listRuns,
  listSteps,
} from '@qywork/store'
import { type ApiHandler, json } from './types.ts'

export const handleConversationsApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/models') {
    // 可选模型 = 内置目录 ∪ 用户档案里声明的模型。
    // 并集是必须的：用户接自建端点或中转时，模型 id 内置目录里根本没有，
    // 只列内置的会让「切模型」在最需要它的场景下没有选项。
    const seen = new Set<string>()
    const models: { id: string; label: string; provider: string; known: boolean }[] = []
    for (const spec of builtinCatalog()) {
      if (seen.has(spec.id)) continue
      seen.add(spec.id)
      models.push({ id: spec.id, label: spec.displayName, provider: spec.provider, known: true })
    }
    for (const [name, profile] of Object.entries(d.config.profiles)) {
      if (seen.has(profile.model)) continue
      seen.add(profile.model)
      models.push({
        id: profile.model,
        label: `${profile.model}（${name}）`,
        provider: profile.kind,
        known: false,
      })
    }
    return json({ models, active: d.config.profiles[d.config.active]?.model ?? null })
  }

  if (p === '/api/conversations') {
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { title?: string; model?: string }
      const conv = createConversation(d.store, {
        workspaceId: d.workspaceId as never,
        model: body.model ?? d.config.profiles[d.config.active]?.model ?? 'unknown',
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
