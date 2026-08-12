/**
 * 用户驱动的动作：切会话、发消息、打断、重试、切模型、压缩、跑 team。
 *
 * 与 `connection.ts` 的分工：那边处理**服务端说了什么**，这边处理
 * **用户点了什么**。两边都只经 `setState` 改同一份 store，没有第二本账。
 */

import type { Attachment, Conversation, EffortLevel } from '@qywork/core'
import { produce } from 'solid-js/store'
import { client, reloadActiveConversation } from './connection.ts'
import {
  addWorkspace,
  isDesktopShell,
  loadWorkspaceExtensions,
  watchWorkspace,
} from './settings.ts'
import { setState, state } from './state.ts'
import { setWorkspace } from './ui.ts'

export async function loadConversations(): Promise<void> {
  const res = await client.api<{ conversations: Conversation[] }>('/api/conversations')
  setState('conversations', res.conversations)
  if (!state.activeConversation && res.conversations[0]) {
    await selectConversation(res.conversations[0].id)
  }
}

/**
 * 切到另一个项目。**不重启任何东西。**
 *
 * 这条路以前是「换掉整个 sidecar」：换项目要重启服务、断掉 WebSocket、
 * 打断正在跑的那一轮，而且只有桌面端做得到。根因是服务端把「哪个根」
 * 存成了进程级常量；那份常量已经删了，现在它按会话 / 按请求查表
 * （`workspaceOf` 与 `?ws=`），所以切项目就只是换一个参数。
 *
 * 顺序有讲究：**先把活动项目改掉，再拉数据**——`client.api` 按当前活动项目
 * 拼 `?ws=`，反过来的话拉回来的还是上一个项目的会话。
 *
 * 会话选择要清空：那个 id 属于上一个项目，留着会让界面去订阅一条
 * 在新项目里不存在的会话。
 */
export async function activateWorkspace(path: string): Promise<void> {
  const { workspace: ws } = await addWorkspace(path)
  setWorkspace({ id: ws.id, root: ws.rootPath, name: ws.name })
  setState({ activeConversation: null, transcript: [], fileChanges: [], error: null, git: null })
  client.subscribe([])
  await loadConversations()
  // 扩展清单跟着项目走。失败不阻断切换——它只影响左栏底部那行摘要。
  await loadWorkspaceExtensions()
    .then((ext) => setState('extensions', ext))
    .catch(() => setState('extensions', null))
  // 文件监听的句柄在 Rust 侧，只有桌面端有。失败不阻断切换：
  // 没有监听只是外部编辑器的改动不会实时推，会话本身照常。
  if (isDesktopShell()) await watchWorkspace(ws.rootPath).catch(() => {})
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

/** 切换当前会话的思考强度。与 `setModel` 同样不做乐观更新，理由同上。 */
export function setEffort(effort: EffortLevel | null): void {
  const id = state.activeConversation
  if (!id) return
  client.send({ type: 'conversation.setEffort', conversationId: id as never, effort })
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
  /** **协议**，不是厂商。 */
  provider: string
  /** 厂商 id；null = 未收录。 */
  vendor: string | null
  /** 这个模型吃哪几档思考强度。空数组 = 这条链路上调不了，界面据此不显示那个开关。 */
  effortLevels: EffortLevel[]
  /** 计价币种。阿里 / 月之暗面 / 智谱三家官网按人民币标价，符号不能一律画 $。 */
  currency: 'USD' | 'CNY'
  /** false = 内置目录里没有，来自用户自己配的档案（自建端点 / 中转）。 */
  known: boolean
}

export interface VendorOption {
  id: string
  displayName: string
  defaultKind: string
  defaultBaseUrl?: string
  apiKeyEnv: string
}

export interface ModelCatalog {
  models: ModelOption[]
  vendors: VendorOption[]
}

/** 模型列表按需拉取：不是每个会话都会点开选择器，没必要开屏就请求。 */
export async function loadModels(): Promise<ModelCatalog> {
  return client.api<ModelCatalog>('/api/models')
}

/** 当前会话正在用的模型。会话不存在时返回 null，不编一个默认值糊弄。 */
export function activeModel(): string | null {
  const id = state.activeConversation
  if (!id) return null
  return state.conversations.find((c) => c.id === id)?.model ?? null
}

/** 当前会话的思考强度。null = 跟随配置默认，不是「关掉」。 */
export function activeEffort(): EffortLevel | null {
  const id = state.activeConversation
  if (!id) return null
  return state.conversations.find((c) => c.id === id)?.effort ?? null
}

export async function newConversation(): Promise<void> {
  const { conversation } = await client.api<{ conversation: Conversation }>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({}),
  })
  setState('conversations', (c) => [conversation, ...c])
  await selectConversation(conversation.id)
}

export function sendMessage(content: string, attachments?: Attachment[]): void {
  const id = state.activeConversation
  // 只带附件不带文字也算一条有效消息——「看这张图」这种意图，
  // 逼用户再打几个字没有道理。
  if (!id || (!content.trim() && !attachments?.length)) return
  setState(
    produce((s) => {
      // 乐观插入：用户按下回车立刻看到自己的消息，不等服务端回执。
      s.transcript.push({
        id: `local_${Date.now()}`,
        kind: 'user',
        text: content,
        ...(attachments?.length ? { attachments } : {}),
      })
      s.running = true
      s.error = null
    }),
  )
  client.send({
    type: 'message.send',
    clientRequestId: crypto.randomUUID(),
    conversationId: id as never,
    content,
    ...(attachments?.length ? { attachments } : {}),
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
