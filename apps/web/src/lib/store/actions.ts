/**
 * 用户驱动的动作：切会话、发消息、打断、重试、切模型、压缩、跑 team。
 *
 * 与 `connection.ts` 的分工：那边处理**服务端说了什么**，这边处理
 * **用户点了什么**。两边都只经 `setState` 改同一份 store，没有第二本账。
 */

import type { Attachment, Conversation, EffortLevel } from '@qywork/core'
import { produce } from 'solid-js/store'
import { client, discardPace, reloadActiveConversation } from './connection.ts'
import {
  addWorkspace,
  isDesktopShell,
  loadServerConfig,
  loadWorkspaceExtensions,
  type RedactedConfig,
  saveServerConfig,
  watchWorkspace,
} from './settings.ts'
import { setState, state } from './state.ts'
import { setWorkspace } from './ui.ts'

/**
 * 拉这个项目的会话列表，并保证**总有一条是活动的**。
 *
 * 最后那条分支不是锦上添花：模型选择器（`disabled={!state.activeConversation}`）、
 * 思考强度、`sendMessage` 全都以「有一条活动会话」为前提。一条都没有时
 * 输入框看着能打字，但发不出去、模型也选不了——而新项目和新装的应用
 * 正好都是这个状态，也就是每个人的第一屏。
 *
 * 建一条空会话没有代价：它本来就是用户接下来必然要做的第一个动作，
 * 而空会话不占额度、不发请求。
 */
export async function loadConversations(): Promise<void> {
  const res = await client.api<{ conversations: Conversation[] }>('/api/conversations')
  setState('conversations', res.conversations)
  if (state.activeConversation) return
  if (res.conversations[0]) {
    await selectConversation(res.conversations[0].id)
    return
  }
  await newConversation()
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
  // 切过去用的是同一条 upsert：只给路径，名字由服务端沿用账本里那一行的。
  const { workspace: ws } = await addWorkspace({ path })
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

/**
 * 切到另一条会话。
 *
 * **两处以前会静默失败，都补上了终态：**
 *
 * 1. `discardPace()` 和清空 transcript 在同一处。以前只在 `reloadActiveConversation`
 *    里丢积压，而那是 await 之后的事——这中间到达的 delta 会落在新会话的正文末尾，
 *    表现成「切过去，开头多了半句上一条会话的话」。
 * 2. 拉取失败落 `state.error`。调用点写的是 `void selectConversation(id)`，
 *    里面任何一条 `client.api` 抛错都会变成 unhandled rejection：transcript 已经
 *    清空、新的没加载上，界面停在一个空会话上，一个字的解释都没有。
 *    **这就是「点了会话没反应」**。
 */
export async function selectConversation(id: string): Promise<void> {
  setState({ activeConversation: id, transcript: [], fileChanges: [], error: null })
  discardPace()
  client.subscribe([id])
  try {
    await reloadActiveConversation()
  } catch (e) {
    setState('error', {
      code: 'internal_error',
      message: `打不开这条会话：${e instanceof Error ? e.message : String(e)}`,
      retryable: true,
    })
  }
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
 * 切换当前模型的思考强度。
 *
 * **写「接口 × 模型」那一格**，走 `/api/config` 这条已有的写入路径——配置的
 * 真源就是那一个 config.json，不新开接口。档位不是全局一个值：本仓同时接多家
 * 模型，档位面从 0 档到 5 档都有（Claude 五档、DeepSeek 两档、Qwen 一档没有），
 * 而且 Agent Team 的每个角色各带一个模型——一个全局值套上去必然错配。
 *
 * 只负责落盘。界面那一行由调用方就地更新——模型目录的 signal 住在选择器组件里，
 * 从这里去改它要反向依赖组件，那条边一加就成环。
 */
export async function setEffort(effort: EffortLevel | null): Promise<void> {
  const model = activeModel()
  if (!model) return
  const payload = await loadServerConfig()
  const owner = ownerProvider(payload.config, model)
  if (!owner) return
  const providers = payload.config.providers
  const entry = { ...providers[owner]?.models[model] }
  if (effort) entry.effort = effort
  else delete entry.effort
  await saveServerConfig({
    ...payload.config,
    providers: {
      ...providers,
      [owner]: {
        ...providers[owner]!,
        models: { ...providers[owner]!.models, [model]: entry },
      },
    },
  })
}

/**
 * 这个模型挂在哪个接口下。
 *
 * 规则与服务端的 `resolveModel` 一致：**先找哪个接口声明了它，当前接口优先**，
 * 都没有就落到当前接口。两处答案不一致的话，写进去的那一格和读出来的不是同一格。
 */
function ownerProvider(config: RedactedConfig, model: string): string | undefined {
  const owners = Object.keys(config.providers).filter((n) => config.providers[n]?.models[model])
  if (owners.includes(config.active.provider)) return config.active.provider
  return (
    owners[0] ?? (config.providers[config.active.provider] ? config.active.provider : undefined)
  )
}

/**
 * 手动压缩当前会话上下文。
 *
 * 与「发送前检查触发的自动压缩」并列的第二个**触发点**，但压缩本身只有一份实现
 * ——两边都是 `RuntimeCompaction.run()`，这里走的是 `conversation.compact` 指令
 * （`server/run-control.ts`）。用户在长会话里主动点它，是为了在下一轮之前先把
 * 上下文腾出来，而不是等占用逼近阈值。
 *
 * （原来这句写的是「provider 拒绝后自动压缩」，那条路已经不触发压缩了，只如实报错，
 * 见 `agent/loop.ts` 发送前检查那段。）
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
  /** 用户为这个模型选定的档。null = 没选过，不发思考字段。与上一行同源。 */
  effort: EffortLevel | null
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
