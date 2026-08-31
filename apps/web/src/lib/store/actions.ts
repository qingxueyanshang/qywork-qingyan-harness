/**
 * 用户驱动的动作：切会话、发消息、打断、重试、切模型、压缩、续起目标、跑 team。
 *
 * 与 `connection.ts` 的分工：那边处理**服务端说了什么**，这边处理
 * **用户点了什么**。两边都只经 `setState` 改同一份 store，没有第二本账。
 */

import type { Attachment, Conversation, EffortLevel } from '@qywork/core'
import { produce } from 'solid-js/store'
import { ApiError } from '../client.ts'
import { client, discardPace, reloadActiveConversation, syncViews } from './connection.ts'
import {
  addWorkspace,
  loadServerConfig,
  type ModelOption,
  modelCatalog,
  rememberWorkspace,
  saveServerConfig,
  type WorkspaceInput,
} from './settings.ts'
import { isDesktopShell, tauriInvoke } from './shell.ts'
import { isRunning, markBusy, setState, state } from './state.ts'
import { closeAllPanelTabs, setOpenFile, setWorkspace } from './ui.ts'

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
 * 切到另一个项目。**不重启任何进程。**
 *
 * 切项目只是换一个参数，因为服务端按会话 / 按请求查表（`workspaceOf` 与 `?ws=`），
 * 不存进程级的「当前根」。一旦把根存成进程级常量，这条路就变成「换掉整个
 * sidecar」——重启服务、断掉 WebSocket、打断正在跑的那一轮，而且只有桌面端做得到。
 *
 * 顺序有讲究：**先把活动项目改掉，再拉数据**——`client.api` 按当前活动项目
 * 拼 `?ws=`，反过来的话拉回来的还是上一个项目的会话。
 *
 * 会话选择要清空：那个 id 属于上一个项目，留着会让界面去订阅一条
 * 在新项目里不存在的会话。
 *
 * **打开的文件也要清空**，理由同上：那是上一个项目里的相对路径。留着的话新项目里
 * 大概率没有这个文件，面板会给一块取不到内容的空白，而它旁边的树已经是新项目的了。
 * 面板里那些「展开了哪些目录 / 选中了哪一行 / 正在看哪个 diff」不在这里清——
 * 它们是面板的局部状态，由 `SidePanel` 按项目 id 整块重挂负责（见那边的注释）。
 *
 * **终端页和浏览器页要连着里面的进程一起关掉**：那个 shell 跑在上一个项目的目录里，
 * 靠重挂是收不掉的（PTY 在 Rust 侧，只认显式关闭）。
 */
export async function activateWorkspace(input: WorkspaceInput): Promise<void> {
  // 新建与切换共用这一次 upsert；服务端同时保证至少有一条用户会话并返回完整列表。
  const { workspace: ws, conversations } = await addWorkspace(input)
  const first = conversations[0]
  if (!first) throw new Error('项目没有可用会话')
  setWorkspace({ id: ws.id, root: ws.rootPath, name: ws.name })
  setOpenFile(null)
  closeAllPanelTabs()
  setState({ conversations, activeConversation: null, fileChanges: [], git: null })
  syncViews()
  await selectConversation(first.id)
  // 桌面端记住最后打开的目录，下次启动才能回到这个项目。
  // 落盘失败不阻断切换：影响的只是下次启动的默认项目。
  if (isDesktopShell()) await rememberWorkspace(ws.rootPath).catch(() => {})
}

/**
 * 切到另一条会话。
 *
 * **两处必须有终态，否则都是静默失败：**
 *
 * 1. `discardPace()` 和换表必须在同一处。只在 `reloadActiveConversation`
 *    里丢积压的话，那是 await 之后的事——这中间到达的 delta 会落在新会话的正文
 *    末尾，表现成「切过去，开头多了半句上一条会话的话」。
 * 2. 拉取失败落这条会话的 `error`。调用点写的是 `void selectConversation(id)`，
 *    里面任何一条 `client.api` 抛错都会变成 unhandled rejection：表刚建出来是空的、
 *    正文没加载上，界面停在一个空会话上，一个字的解释都没有。
 *    **这就是「点了会话没反应」**。
 */
export async function selectConversation(id: string): Promise<void> {
  setState({ activeConversation: id, fileChanges: [] })
  discardPace()
  // 建表与订阅在这里显式走一次，不等那个 effect：下面紧接着就 await，
  // 而重拉回来要写的正是这条会话的表，表还没建的话那一份正文无处可落。
  syncViews()
  try {
    await reloadActiveConversation()
  } catch (e) {
    setState('views', id, 'error', {
      code: 'internal_error',
      message: `打不开这条会话：${e instanceof Error ? e.message : String(e)}`,
    })
  }
}

/**
 * 中断当前 run。
 *
 * 发的必须是 `run.started` 事件带回来的**真实 runId**。
 * 拿 `transcript.find(status === 'running').id` 是**步骤 id**，服务端查 run 查不到，
 * 因此静默什么也不做——中断按钮从来不生效，而 UI 上完全看不出来。
 */
export function interrupt(): void {
  const runId = state.lastRunId
  if (!runId) return
  client.send({ type: 'run.interrupt', runId: runId as never })
}

/**
 * 立一个目标（`/goal`），或改写现在这个。**立目标的唯一入口。**
 *
 * 空正文在这里就挡掉：一条空的 `/goal` 发上去只会换回一句服务端的拒绝，
 * 而用户看到的是自己刚打的字消失了、界面上多一条红字。
 *
 * 不在这里判「已经有目标了」——那是账本的规则（改写在跑的那个是合法的），
 * 前端抄一份判定就是两处会漂的规矩。
 */
export function setGoal(objective: string): void {
  const id = state.activeConversation
  const text = objective.trim()
  if (!id || !text) return
  client.send({ type: 'goal.set', conversationId: id as never, objective: text })
}

/**
 * 让停下来的目标接着自动跑。
 *
 * **它不只是把状态改回 `active`，是重新启用「一轮接一轮」这件事本身。**
 * 服务端的续起标记挂在进程里、不落盘（`server/runs.ts` 的 `GoalArm`），所以
 * 进程重启、会话恢复之后目标还在账本里，却不会自己再起一轮——那时候点这个按钮
 * 是唯一能把循环接上的动作。
 *
 * 停止不在这里：跑起来之后停它就是中断这一轮（`interrupt`），run 收尾时服务端
 * 会把目标置回 `paused` 并解除标记。再开一条「暂停目标」的指令等于给同一件事
 * 开第二个入口。
 */
export function resumeGoal(): void {
  const id = state.activeConversation
  // 正在跑的时候服务端会回 conflict，前端这层只是不让按钮白点。
  if (!id || isRunning()) return
  client.send({ type: 'goal.resume', conversationId: id as never })
}

/**
 * 切换当前会话的模型。
 *
 * 只发指令、不改本地状态：等服务端的 `conversation.updated` 广播回来再更新。
 * 乐观更新在这里是错的——切换可能失败（会话已删），而模型显示错了会直接
 * 导致费用估算和能力预期都对不上。
 */
export function setModel(provider: string, model: string): void {
  const id = state.activeConversation
  if (!id) return
  client.send({ type: 'conversation.setModel', conversationId: id as never, provider, model })
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
export async function setEffort(
  provider: string,
  model: string,
  effort: EffortLevel | null,
): Promise<void> {
  const payload = await loadServerConfig()
  const owner = payload.config.providers[provider]
  if (!owner) return
  const entry = { ...owner.models[model] }
  if (effort) entry.effort = effort
  else delete entry.effort
  await saveServerConfig({
    ...payload.config,
    providers: {
      ...payload.config.providers,
      [provider]: { ...owner, models: { ...owner.models, [model]: entry } },
    },
  })
}

/**
 * 手动压缩当前会话上下文。
 *
 * 与「发送前检查触发的自动压缩」并列的第二个**触发点**，但压缩本身只有一份实现
 * ——两边都是 `RuntimeCompaction.run()`，这里走的是 `conversation.compact` 指令
 * （`server/run-control.ts`）。用户在长会话里主动点它，是为了在下一轮之前先把
 * 上下文腾出来，而不是等占用逼近阈值。
 *
 * 自动那条是发送前按占用检查（见 `agent/loop.ts`）；provider 的容量拒绝不触发压缩，
 * 只如实报错。
 *
 * 结果通过 compaction 事件回来（done / failed 都会回），所以这里不做乐观更新。
 */
export function compactContext(): void {
  const id = state.activeConversation
  if (!id || isRunning()) return
  client.send({ type: 'conversation.compact', conversationId: id as never })
}

export interface TeamRoleRow {
  id: string
  name: string
  description: string
  /** 不填就跟着当前会话的模型。 */
  model?: string
}

export interface TeamInfo {
  roles: TeamRoleRow[]
  error: string | null
}

export function loadTeam(): Promise<TeamInfo> {
  return client.api<TeamInfo>('/api/team')
}

/** 本机装了哪几家外部 agent CLI。**只读**：它来自探测，没有对应的写接口。 */
export interface CliAgentRow {
  id: string
  vendor: string
  path: string
  connected: boolean
}
export function loadTeamClis(): Promise<{ agents: CliAgentRow[] }> {
  return client.api<{ agents: CliAgentRow[] }>('/api/team/cli')
}

/**
 * 当前会话正在用的「接口 × 模型」。会话不存在时返回 null，不编一个默认值。
 *
 * **两个一起返回。** 只回模型名的话，两个接口挂同一个 id 时选择器高亮的是
 * 两条，而用户切过去的只有一条。
 */
export function activeModel(): { provider: string; model: string } | null {
  const id = state.activeConversation
  if (!id) return null
  const conv = state.conversations.find((c) => c.id === id)
  return conv ? { provider: conv.provider, model: conv.model } : null
}

/**
 * 当前这一对在目录里对应哪一行。
 *
 * 会话的 `provider` 是空串时（迁移 24 之前建的会话）按模型 id 找：先当前默认接口，
 * 再第一个声明了它的接口——**与服务端 `resolveModel` 的裸串入口同一条规则**。
 * 两处答案不一致的话，界面上的档位面属于 A 接口，而请求发给了 B。
 *
 * **逐模型不同的能力（思考档位、收不收图片）一律从这一行取。** 分两处各自解析
 * 必然出现「档位面是 A 模型的、图片入口按 B 模型算」，而用户随时会切模型。
 */
export function activeModelRow(): ModelOption | null {
  const c = modelCatalog()
  const ref = activeModel()
  if (!c || !ref) return null
  const owners = c.providers.filter((p) => p.models.some((m) => m.id === ref.model))
  const owner = ref.provider
    ? c.providers.find((p) => p.name === ref.provider)
    : (owners.find((p) => p.name === c.active.provider) ?? owners[0])
  return owner?.models.find((m) => m.id === ref.model) ?? null
}

/** 重命名。空标题的校验只在服务端（422 且不落盘），两边各写一份必然漂移。 */
export async function renameConversation(id: string, title: string): Promise<void> {
  const { conversation } = await client.api<{ conversation: Conversation }>(
    `/api/conversations/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify({ title }) },
  )
  setState(
    produce((s) => {
      const conv = s.conversations.find((c) => c.id === id)
      if (conv) conv.title = conversation.title
    }),
  )
}

/** 归档：只从列表里去掉，服务端一条数据不删。 */
export async function archiveConversation(id: string): Promise<void> {
  await client.api(`/api/conversations/${encodeURIComponent(id)}/archive`, { method: 'POST' })
  await dropConversation(id)
}

/**
 * 把当前会话导出为排障 JSON。
 *
 * 内容由服务端从消息、run、step 与逐请求账本现取；这里不读 `transcript()` 再拼一份
 * 已分页、已折叠的界面副本。桌面端交给系统保存对话框，浏览器与手机走原生下载。
 */
export async function exportActiveConversation(): Promise<'saved' | 'cancelled'> {
  const id = state.activeConversation
  if (!id) return 'cancelled'

  const path = `/api/conversations/${encodeURIComponent(id)}/export`
  const response = await client.raw(path)
  if (!response.ok) {
    const error = new ApiError(response.status, path, await response.text().catch(() => ''))
    throw new Error(error.detail)
  }

  const contents = await response.text()
  const fileName = `qywork-session-${id}.json`
  if (isDesktopShell()) {
    try {
      const saved = await tauriInvoke<string | null>('save_session_export', { fileName, contents })
      return saved ? 'saved' : 'cancelled'
    } catch (error) {
      // Tauri 移动壳没有可写的普通文件路径，退回同一份 Web 下载；桌面写入失败照实抛。
      if (!String(error).includes('移动端请使用浏览器下载')) throw error
    }
  }

  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return 'saved'
}

/** 删除：服务端是硬删，消息、run、步骤一并没了。 */
export async function deleteConversation(id: string): Promise<void> {
  await client.api(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await dropConversation(id)
}

/**
 * 从列表里摘掉一条，并保证还有一条是活动的。
 *
 * 摘掉的正是当前那条时，**必须先把 `activeConversation` 置空再重拉**：
 * `loadConversations` 见有活动会话就直接返回，不置空的话界面停在一条
 * 已经不存在的会话上，随后每条请求都 404。
 */
async function dropConversation(id: string): Promise<void> {
  const wasActive = state.activeConversation === id
  setState('conversations', (list) => list.filter((c) => c.id !== id))
  if (!wasActive) return
  setState({ activeConversation: null, fileChanges: [] })
  syncViews()
  await loadConversations()
}

export async function newConversation(): Promise<void> {
  const { conversation } = await client.api<{ conversation: Conversation }>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({}),
  })
  setState('conversations', (c) => [conversation, ...c])
  await selectConversation(conversation.id)
}

/**
 * 发一条消息。会话在跑时它不再被回绝，而是**排进队列**——去向由 `steer` 决定。
 *
 * `steer` 由调用方给：Enter 走默认档，Ctrl+Enter 走相反档（`Composer.tsx`）。
 * 会话空闲时这一格无意义，两种取值都是当场起一轮。
 */
export function sendMessage(content: string, attachments?: Attachment[], steer = false): void {
  const id = state.activeConversation
  // 只带附件不带文字也算一条有效消息——「看这张图」这种意图，
  // 逼用户再打几个字没有道理。
  if (!id || (!content.trim() && !attachments?.length)) return
  const requestId = crypto.randomUUID()
  const queued = state.busyConversations.includes(id)
  setState(
    produce((s) => {
      /*
       * 乐观呈现，不等服务端回执。**忙与闲落在两个地方**：
       * 闲时这条消息就是下一轮的开头，进会话流；忙时它排着队，进卡片区。
       * 都插进会话流的话，用户会看到一条还没发生的对话。
       *
       * 卡片的 id 用 `clientRequestId`——与服务端队列条目同源，
       * 随后那份快照整体覆盖时同一条不会闪重。
       */
      if (queued) {
        s.followUps.push({
          id: requestId,
          content,
          ...(attachments?.length ? { attachments } : {}),
          steer,
        })
      } else {
        s.views[id]?.transcript.push({
          id: `local_${Date.now()}`,
          kind: 'user',
          text: content,
          ...(attachments?.length ? { attachments } : {}),
        })
      }
      const v = s.views[id]
      if (v) v.error = null
    }),
  )
  /*
   * 乐观置忙：用户按下回车，左栏那一行和输入框立刻进入执行态，不等服务端回执。
   *
   * **写的是同一张表**，不是给「当前这条」另记一个布尔——服务端占位成功后会用
   * `conversation.busy` 覆盖同一格，被回绝时也由它把这格放下来。
   */
  markBusy(id, true)
  client.send({
    type: 'message.send',
    clientRequestId: requestId,
    conversationId: id as never,
    content,
    ...(attachments?.length ? { attachments } : {}),
    ...(steer ? { steer: true } : {}),
  })
}

/**
 * 改一条排着的跟进消息的去向；会话已经空闲时，服务端把它当「现在就发」处理。
 *
 * **两态由服务端在同一个同步块里裁决**，客户端不预判：它手里的忙闲是上一次
 * 事件留下的值，用户点下去那一刻可能已经不成立。
 */
export function steerFollowUp(id: string, steer: boolean): void {
  const conversationId = state.activeConversation
  if (!conversationId) return
  client.send({ type: 'followup.steer', conversationId: conversationId as never, id, steer })
}

/** 删掉一条排着的跟进消息。删了就既不注入也不火发。 */
export function dropFollowUp(id: string): void {
  const conversationId = state.activeConversation
  if (!conversationId) return
  client.send({ type: 'followup.drop', conversationId: conversationId as never, id })
}
