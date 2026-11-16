/** 建行阶段：同一个写事务中写入用户消息、标题与 run 行，随后启动心跳。其后的步骤都在 `Session.ask` 的 try 中。 */

import { deriveConversationTitle } from '@qywork/core'
import {
  appendMessage,
  createRun,
  markRunRunning,
  setConversationTitle,
  touchRun,
} from '@qywork/store'
import type { AskOptions, SessionState } from '../types.ts'
import type { AskState, TurnPlan } from './state.ts'

export function openRun(
  session: SessionState,
  plan: TurnPlan,
  prompt: string,
  options: AskOptions | undefined,
): AskState {
  const { store } = session.opts
  const { contextSnapshot, conversation, conversationId, model, startedAt } = plan
  /*
   * 追加用户消息、生成标题、创建轮次、标记 running 在同一个写事务中完成。`createRun` 发现该会话被
   * 另一个进程占用时抛出 `ConversationBusyError`，整个事务回滚：被拒绝的消息不写入数据库，
   * 不留下没有回答的用户消息。
   */
  const run = store.tx(() => {
    const userMessageId = appendMessage(store, {
      conversationId,
      role: 'user',
      content: prompt,
      ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
      ...(options?.origin ? { origin: options.origin } : {}),
    }).id

    /*
     * 标题在第一条用户消息写入数据库之后产生，全项目只有这一处产生点。
     * 创建会话时不生成标题：界面端先创建会话、后发送第一条消息，此时正文尚不存在。
     *
     * 只在标题为空时写入：用户修改过的名称不得被下一条消息覆盖。准备阶段读取 `conversation` 之后
     * 间隔若干 await，用户可能刚修改过名称，因此「标题为空」由写入语句自行判断（`onlyIfEmpty`）。
     */
    if (!conversation?.title) {
      const derived = deriveConversationTitle(prompt)
      if (derived) setConversationTitle(store, conversationId, derived, { onlyIfEmpty: true })
    }

    const created = createRun(store, {
      conversationId,
      workspaceId: session.workspaceId as never,
      model,
      clientRequestId: options?.clientRequestId ?? crypto.randomUUID(),
      userMessageId,
      // 高水位：本轮固定在刚写入的消息。排队期间新到达的消息不进入本轮。
      messageIdUpperBound: userMessageId,
      contextSnapshot,
      ...(options?.dispatch ? { dispatch: options.dispatch } : {}),
      createdAt: startedAt,
    })
    markRunRunning(store, created.id)
    return created
  })
  const userMessageId = run.userMessageId

  /*
   * 心跳：告知其他进程本轮仍在运行。
   *
   * 账本是共享的，一台机器上同时存在多个写入者（两个工作区的 sidecar、
   * 开发态热重载、终端中的 `qy exec`）。后启动的进程在启动时回收残留 run，
   * 判据即该心跳与 `owner_pid`（见 `store/repos/runs.ts` 的 `isOrphan`）：
   * 不推送心跳时，其他进程启动后即会将正在运行的 run 判定为中断。
   *
   * `unref()`：该定时器不应阻止进程退出。
   */
  const heartbeat = setInterval(() => touchRun(store, run.id), HEARTBEAT_MS)
  heartbeat.unref?.()
  session.mediaSpends.set(run.id, [])
  return { ...plan, prompt, options, run, userMessageId, heartbeat, finished: false, failure: null }
}

/** 心跳间隔。回收方按 60 秒判定过期（`store/repos/runs.ts`），留有六倍余量。 */
const HEARTBEAT_MS = 10_000
