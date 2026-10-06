/**
 * 用户驱动的动作：切换会话、发送消息、中断、重试、切换模型、压缩、继续执行目标、运行 team。
 *
 * 与 `connection.ts` 的分工：`connection.ts` 处理服务端推送的事件，本文件处理
 * 用户操作。两者都只经由 `setState` 修改同一份 store，不存在第二本账。
 */

import type { Attachment, Conversation, EffortLevel } from '@qywork/core'
import { produce } from 'solid-js/store'
import { ApiError } from '../client.ts'
import { readSession, writeSession } from '../session.ts'
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
import { hasRun, isRunning, LOCAL_ID_PREFIX, prepayBusy, setState, state } from './state.ts'
import { setOpenFile, setWorkspace, workspace } from './ui.ts'

/**
 * 获取当前项目的会话列表，并保证始终有一条活动会话。
 *
 * 最后一个分支是必需的：模型选择器（`disabled={!state.activeConversation}`）、
 * 思考强度、`sendMessage` 都以存在活动会话为前提。没有活动会话时，
 * 输入框可以输入，但无法发送，也无法选择模型；而新项目与新安装的应用
 * 恰好处于该状态，即每位用户看到的第一屏。
 *
 * 新建空会话没有代价：这是用户接下来必然执行的第一个操作，
 * 且空会话不占用额度、不发送请求。
 */
export async function loadConversations(): Promise<void> {
  const res = await client.api<{ conversations: Conversation[] }>('/api/conversations')
  setState('conversations', res.conversations)
  if (state.activeConversation) return
  // 刷新后回到刷新前的会话；它已被删除或归档时不在列表中，改为第一条。
  const saved = readSession<string>(conversationKey())
  const pick = res.conversations.find((c) => c.id === saved) ?? res.conversations[0]
  if (pick) {
    await selectConversation(pick.id)
    return
  }
  await newConversation()
}

/** 当前会话的记录键，按项目区分：会话 id 只在所属项目的列表中有效。 */
function conversationKey(): string {
  return `qywork.conversation:${workspace()?.id ?? ''}`
}

/**
 * 切换到另一个项目，不重启任何进程。
 *
 * 切换项目只是更换参数，因为服务端按会话 / 按请求查找项目（`workspaceOf` 与 `?ws=`），
 * 不保存进程级的「当前根目录」。若把根目录存为进程级常量，切换项目就需要替换整个
 * sidecar：重启服务、断开 WebSocket、中断正在运行的轮次，且只有桌面端能够完成。
 *
 * 顺序不能调换：先修改活动项目，再获取数据。`client.api` 按当前活动项目
 * 拼接 `?ws=`，顺序颠倒时取回的仍是上一个项目的会话。
 *
 * 必须清空会话选择：该 id 属于上一个项目，保留会使界面订阅一条
 * 在新项目中不存在的会话。
 *
 * 打开的文件同样须清空，理由相同：它是上一个项目中的相对路径。保留时新项目中
 * 通常没有该文件，面板会显示无法取得内容的空白区域，而旁边的文件树已属于新项目。
 * 面板中「展开了哪些目录 / 选中了哪一行 / 正在查看哪个 diff」不在此处清除：
 * 它们是面板的局部状态，由 `SidePanel` 按项目 id 整体重新挂载处理（见该处注释）。
 *
 * 可多开的页面不在此处关闭。它们按项目分别记录（`ui.ts` 的 `panels`），切换项目只是
 * 换用另一个键读取：终端中的命令继续运行，浏览器页面保持不变，切回后仍是原状态。
 */
export async function activateWorkspace(input: WorkspaceInput): Promise<void> {
  // 新建与切换共用这一次 upsert；服务端同时保证至少有一条用户会话并返回完整列表。
  const { workspace: ws, conversations } = await addWorkspace(input)
  const first = conversations[0]
  if (!first) throw new Error('项目没有可用会话')
  setWorkspace({ id: ws.id, root: ws.rootPath, name: ws.name })
  setOpenFile(null)
  setState({ conversations, activeConversation: null, fileChanges: [], git: null })
  syncViews()
  await selectConversation(first.id)
  // 桌面端记录最后打开的目录，下次启动时据此回到该项目。
  // 落盘失败不阻断切换：只影响下次启动的默认项目。
  if (isDesktopShell()) await rememberWorkspace(ws.rootPath).catch(() => {})
}

/**
 * 切到另一条会话。
 *
 * 两处必须有终态，否则都会静默失败：
 *
 * 1. `discardPace()` 与切换视图表必须在同一处。若只在 `reloadActiveConversation`
 *    中丢弃积压内容，那发生在 await 之后，其间到达的 delta 会写入新会话的正文
 *    末尾，使新会话开头出现上一条会话的半句话。
 * 2. 获取失败时写入该会话的 `error`。调用点写的是 `void selectConversation(id)`，
 *    其中任何一次 `client.api` 抛错都会成为 unhandled rejection：视图表刚建立且为空、
 *    正文未加载，界面停在空会话上且没有任何说明，表现为点击会话后没有反应。
 */
export async function selectConversation(id: string): Promise<void> {
  const current = state.views[id]
  if (state.activeConversation === id && current && current.history.loading !== 'unloaded') return
  setState({ activeConversation: id, fileChanges: [] })
  writeSession(conversationKey(), id)
  discardPace()
  // 在此处显式建立视图表并订阅，不等待 effect 执行：下方紧接着 await，
  // 重新获取的结果要写入该会话的视图表，视图表尚未建立时正文无处写入。
  syncViews()
  try {
    await reloadActiveConversation()
  } catch (e) {
    setState('views', id, 'error', {
      code: 'internal_error',
      message: `无法打开会话：${e instanceof Error ? e.message : String(e)}`,
    })
  }
}

/**
 * 停止当前会话正在执行的全部任务。
 *
 * 按会话寻址：会话中运行的不只有 run，而界面上的停止按钮只有一个。
 */
export function interrupt(): void {
  const id = state.activeConversation
  if (!id) return
  client.send({ type: 'conversation.interrupt', conversationId: id as never })
}

/**
 * 设定目标（`/goal`），或改写当前目标。这是设定目标的唯一入口。
 *
 * 空正文在此处直接拦截：空的 `/goal` 发送到服务端只会得到一条拒绝，
 * 而用户看到的是刚输入的内容消失、界面上多出一条错误提示。
 *
 * 不在此处判定「已有目标」：这是账本的规则（改写运行中的目标是合法的），
 * 前端复制一份判定会形成两处可能不一致的规则。
 */
export function setGoal(objective: string): void {
  const id = state.activeConversation
  const text = objective.trim()
  if (!id || !text) return
  client.send({ type: 'goal.set', conversationId: id as never, objective: text })
}

/**
 * 让已停止的目标继续自动执行。
 *
 * 它不只是把状态改回 `active`，而是重新启用逐轮自动继续本身。
 * 服务端的自动继续标记保存在进程内存中，不写入磁盘（`server/runs.ts` 的 `GoalArm`），
 * 因此进程重启、会话恢复之后目标仍在账本中，却不会自动开始下一轮；此时该按钮
 * 是恢复循环的唯一操作。
 *
 * 停止不在此处：开始执行后停止目标即中断当前轮次（`interrupt`），run 结束时服务端
 * 会把目标置回 `paused` 并解除标记。另设一条「暂停目标」指令等于为同一操作
 * 提供第二个入口。
 */
export function resumeGoal(): void {
  const id = state.activeConversation
  // 运行中服务端会返回 conflict，前端此处的判断只用于避免无效点击。
  if (!id || isRunning()) return
  client.send({ type: 'goal.resume', conversationId: id as never })
}

/**
 * 切换当前会话的模型。
 *
 * 只发送指令，不修改本地状态：等服务端广播 `conversation.updated` 后再更新。
 * 此处不能做乐观更新：切换可能失败（会话已删除），而模型显示错误会直接
 * 导致费用估算与能力预期都不一致。
 */
export function setModel(provider: string, model: string): void {
  const id = state.activeConversation
  if (!id) return
  client.send({ type: 'conversation.setModel', conversationId: id as never, provider, model })
}

/**
 * 切换当前模型的思考强度。
 *
 * 写入「接口 × 模型」对应的配置项，经由 `/api/config` 这条已有的写入路径：配置的
 * 真源是 config.json，不新增接口。档位不是全局单一值：本仓库同时接入多家
 * 模型，可用档位从 0 档到 5 档不等（Claude 五档、DeepSeek 三档，也有模型没有档位），
 * 且 Agent Team 的每个角色各自使用一个模型，全局单一值必然与部分模型不匹配。
 *
 * 只负责落盘。界面上的对应行由调用方就地更新：模型目录的 signal 位于选择器组件中，
 * 从此处修改它需要反向依赖组件，会形成循环依赖。
 */
export async function setEffort(
  provider: string,
  model: string,
  effort: EffortLevel,
): Promise<void> {
  const payload = await loadServerConfig()
  const owner = payload.config.providers[provider]
  if (!owner) return
  const entry = { ...owner.models[model] }
  entry.effort = effort
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
 * 与「发送前检查触发的自动压缩」并列的第二个触发点，但压缩本身只有一份实现：
 * 两者都调用 `RuntimeCompaction.run()`，此处经由 `conversation.compact` 指令
 * （`server/run-control.ts`）。用户在长会话中主动触发，是为了在下一轮之前先
 * 释放上下文空间，而不是等待占用接近阈值。
 *
 * 自动压缩在发送前按占用检查（见 `agent/loop/compact.ts`）；provider 的容量拒绝不触发压缩，
 * 只如实报错。
 *
 * 结果通过 compaction 事件返回（done 与 failed 都会返回），因此此处不做乐观更新。
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
  /** 未填写时使用当前会话的模型。 */
  model?: string
}

export interface TeamInfo {
  roles: TeamRoleRow[]
  error: string | null
}

export function loadTeam(): Promise<TeamInfo> {
  return client.api<TeamInfo>('/api/team')
}

/** 本机已安装的外部 agent CLI。只读：数据来自探测，没有对应的写接口。 */
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
 * 当前会话使用的「接口 × 模型」。会话不存在时返回 null，不编造默认值。
 *
 * 两项一起返回。只返回模型名时，若两个接口配置了同一个 id，选择器会高亮
 * 两项，而用户实际切换到的只有一项。
 */
export function activeModel(): { provider: string; model: string } | null {
  const id = state.activeConversation
  if (!id) return null
  const conv = state.conversations.find((c) => c.id === id)
  return conv ? { provider: conv.provider, model: conv.model } : null
}

/**
 * 当前「接口 × 模型」在目录中对应的行。
 *
 * 逐模型不同的能力（思考档位、是否接受图片）一律从该行读取。分两处各自解析
 * 必然出现「档位来自 A 模型、图片入口按 B 模型判定」的情况，而用户随时可能切换模型。
 */
export function activeModelRow(): ModelOption | null {
  const c = modelCatalog()
  const ref = activeModel()
  if (!c || !ref) return null
  const owner = c.providers.find((p) => p.name === ref.provider)
  return owner?.models.find((m) => m.id === ref.model) ?? null
}

/** 重命名。空标题的校验只在服务端进行（返回 422 且不落盘），两端各写一份必然出现不一致。 */
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

/** 归档：只从列表中移除，服务端不删除任何数据。 */
export async function archiveConversation(id: string): Promise<void> {
  await client.api(`/api/conversations/${encodeURIComponent(id)}/archive`, { method: 'POST' })
  await dropConversation(id)
}

/**
 * 把当前会话导出为排障 JSON。
 *
 * 内容由服务端从消息、run、step 与逐请求账本实时读取；此处不读取 `transcript()` 再拼出一份
 * 已分页、已折叠的界面副本。桌面端交给系统保存对话框，浏览器与手机使用原生下载。
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
      // Tauri 移动端外壳没有可写的普通文件路径，回退到同一个 Web 下载流程；桌面端写入失败时如实抛出。
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

/**
 * 删除：服务端执行硬删除，消息、run、步骤一并删除。
 *
 * 返回值是回收失败的提示，不是删除失败：此时会话已不在账本中。
 * 两者合并为一个异常时，用户看到「删除失败」会再次点击，随后收到 404。
 */
export async function deleteConversation(id: string): Promise<string | null> {
  const res = await client.api<{ reclaimError?: string }>(
    `/api/conversations/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
  await dropConversation(id)
  return res.reclaimError ?? null
}

/**
 * 从列表中移除一条会话，并保证仍有一条活动会话。
 *
 * 移除的正是当前会话时，必须先把 `activeConversation` 置空再重新获取：
 * `loadConversations` 发现存在活动会话时直接返回，不置空会使界面停在
 * 已不存在的会话上，之后每个请求都返回 404。
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
 * 发送一条消息。有 run 正在运行时不拒绝，而是加入队列，去向由 `steer` 决定。
 *
 * `steer` 由调用方提供：Enter 使用默认值，Ctrl+Enter 使用相反值（`Composer.tsx`）。
 * 没有 run 运行时该参数无意义，两种取值都会立即开始一轮。
 */
export function sendMessage(content: string, attachments?: Attachment[], steer = false): void {
  const id = state.activeConversation
  // 只有附件没有文字也是有效消息：用户的意图可能就是让模型查看图片，
  // 不应要求用户额外输入文字。
  if (!id || (!content.trim() && !attachments?.length)) return
  const requestId = crypto.randomUUID()
  const queued = hasRun()
  setState(
    produce((s) => {
      /*
       * 乐观呈现，不等待服务端回执。忙碌与空闲两种状态写入不同位置：
       * 空闲时该消息是下一轮的开头，进入会话流；忙碌时它在队列中，进入卡片区。
       * 若都插入会话流，用户会看到一段尚未发生的对话。
       *
       * 卡片的 id 使用 `clientRequestId`，与服务端队列条目同源，
       * 随后的快照整体覆盖时同一条目不会重复出现。
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
          id: `${LOCAL_ID_PREFIX}${Date.now()}`,
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
   * 乐观置忙：用户按下回车后，左栏对应行与输入框立即进入执行状态，不等待服务端回执。
   *
   * 写入的是同一张表，而不是为当前会话另记一个布尔值：服务端占位成功后会用
   * `conversation.busy` 覆盖同一项。携带 `requestId` 是为了在该指令被拒时
   * 撤销此次预置（`applyRejected`）：被拒的指令服务端从未置忙，不会有忙闲事件到达。
   */
  prepayBusy(id, requestId)
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
 * 修改一条排队中的跟进消息的去向；会话已空闲时，服务端将其按「立即发送」处理。
 *
 * 两种状态由服务端在同一个同步块中裁决，客户端不预先判断：客户端持有的忙闲状态是
 * 上一次事件留下的值，用户点击时可能已不成立。
 */
export function steerFollowUp(id: string, steer: boolean): void {
  const conversationId = state.activeConversation
  if (!conversationId) return
  client.send({ type: 'followup.steer', conversationId: conversationId as never, id, steer })
}

/** 删除一条排队中的跟进消息。删除后既不注入也不发送。 */
export function dropFollowUp(id: string): void {
  const conversationId = state.activeConversation
  if (!conversationId) return
  client.send({ type: 'followup.drop', conversationId: conversationId as never, id })
}
