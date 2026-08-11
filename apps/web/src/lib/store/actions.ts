/**
 * 用户驱动的动作：切会话、发消息、打断、重试、切模型、压缩、跑 team。
 *
 * 与 `connection.ts` 的分工：那边处理**服务端说了什么**，这边处理
 * **用户点了什么**。两边都只经 `setState` 改同一份 store，没有第二本账。
 */

import type { Conversation } from '@qywork/core'
import { produce } from 'solid-js/store'
import { client, reloadActiveConversation } from './connection.ts'
import { setState, state } from './state.ts'

export async function loadConversations(): Promise<void> {
  const res = await client.api<{ conversations: Conversation[] }>('/api/conversations')
  setState('conversations', res.conversations)
  if (!state.activeConversation && res.conversations[0]) {
    await selectConversation(res.conversations[0].id)
  }
}

export async function selectConversation(id: string): Promise<void> {
  setState({ activeConversation: id, transcript: [], fileChanges: [], error: null })
  client.subscribe([id])
  await reloadActiveConversation()
}

/**
 * 中断当前 run。
 *
 * 曾经这里发的是 `transcript.find(status === 'running').id`——那是**步骤 id**，
 * 不是 run id。服务端拿它查 run 查不到，于是静默什么也不做：
 * 中断按钮从来没生效过，而 UI 上完全看不出来。
 * 现在用 `run.started` 事件带回来的真实 runId。
 */
export function interrupt(): void {
  const runId = state.lastRunId
  if (!runId) return
  client.send({ type: 'run.interrupt', runId: runId as never })
}

/**
 * 重试最后一轮。
 *
 * 只在 run 已结束时可用——还在跑的必须先中断，否则两个 run 会同时改同一个工作区。
 * 这个判断服务端也会做一遍（并回 `conflict`），前端这层只是不让按钮白点。
 */
export function retryLastRun(): void {
  const runId = state.lastRunId
  if (!runId || state.running) return
  setState('error', null)
  client.send({
    type: 'run.retry',
    runId: runId as never,
    clientRequestId: crypto.randomUUID(),
  })
}

/**
 * 切换当前会话的模型。
 *
 * 只发指令、不改本地状态：等服务端的 `conversation.updated` 广播回来再更新。
 * 乐观更新在这里是错的——切换可能失败（会话已删），而模型显示错了会直接
 * 导致费用估算和能力预期都对不上。
 */
export function setModel(model: string): void {
  const id = state.activeConversation
  if (!id) return
  client.send({ type: 'conversation.setModel', conversationId: id as never, model })
}

/**
 * 手动压缩当前会话上下文。
 *
 * 与「provider 拒绝后自动压缩」并列的第二条入口。用户在长会话里主动点它，
 * 是为了在下一轮之前先把上下文腾出来，而不是等撞上限。
 *
 * 结果通过 compaction 事件回来（done / failed 都会回），所以这里不做乐观更新。
 */
export function compactContext(): void {
  const id = state.activeConversation
  if (!id || state.running) return
  client.send({ type: 'conversation.compact', conversationId: id as never })
}

export interface TeamInfo {
  backends: string[]
  roles: { id: string; name: string; description: string; backend: string }[]
  plan: { id: string; roleId: string; task: string; needs?: string[] }[]
  error: string | null
}

export function loadTeam(): Promise<TeamInfo> {
  return client.api<TeamInfo>('/api/team')
}

/** 启动一轮编排。目标之外的一切来自工作区的 .qy/team.json —— 配置只有一个来源。 */
export function runTeam(goal: string): void {
  const id = state.activeConversation
  if (!id || state.running) return
  setState(
    produce((s) => {
      s.teamMembers = []
      s.running = true
      s.error = null
    }),
  )
  client.send({
    type: 'team.run',
    conversationId: id as never,
    goal,
    clientRequestId: crypto.randomUUID(),
  })
}

export interface ModelOption {
  id: string
  label: string
  provider: string
  /** false = 内置目录里没有，来自用户自己配的档案（自建端点 / 中转）。 */
  known: boolean
}

/** 模型列表按需拉取：不是每个会话都会点开选择器，没必要开屏就请求。 */
export async function loadModels(): Promise<ModelOption[]> {
  const res = await client.api<{ models: ModelOption[] }>('/api/models')
  return res.models
}

/** 当前会话正在用的模型。会话不存在时返回 null，不编一个默认值糊弄。 */
export function activeModel(): string | null {
  const id = state.activeConversation
  if (!id) return null
  return state.conversations.find((c) => c.id === id)?.model ?? null
}

export async function newConversation(): Promise<void> {
  const { conversation } = await client.api<{ conversation: Conversation }>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({}),
  })
  setState('conversations', (c) => [conversation, ...c])
  await selectConversation(conversation.id)
}

export function sendMessage(content: string): void {
  const id = state.activeConversation
  if (!id || !content.trim()) return
  setState(
    produce((s) => {
      // 乐观插入：用户按下回车立刻看到自己的消息，不等服务端回执。
      s.transcript.push({ id: `local_${Date.now()}`, kind: 'user', text: content })
      s.running = true
      s.error = null
    }),
  )
  client.send({
    type: 'message.send',
    clientRequestId: crypto.randomUUID(),
    conversationId: id as never,
    content,
  })
}

export function resolvePermission(granted: boolean, scopeId: string): void {
  const ask = state.permission
  if (!ask) return
  client.send({
    type: 'permission.resolve',
    requestId: ask.requestId,
    granted,
    ...(granted ? { scopeId } : {}),
  })
  setState('permission', null)
}
