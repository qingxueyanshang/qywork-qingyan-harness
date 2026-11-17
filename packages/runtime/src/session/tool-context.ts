/** 本轮的工具上下文：按会话与本轮绑定的端口、只读根、凭证清单与权限裁决。 */

import { isAbsolute, resolve } from 'node:path'
import { provide, runDensity, TodoPort, type ToolContextBase } from '@qywork/agent'
import type { LlmAdapter } from '@qywork/ai'
import type { AgentEvent, ConversationId, GoalWriteResult, RunId } from '@qywork/core'
import {
  createSchedule,
  currentGoal,
  deleteSchedule,
  fileReadHash,
  getConversation,
  latestTodos,
  listMessages,
  listSchedules,
  recordFileRead,
  updateGoal,
} from '@qywork/store'
import {
  CanvasPort,
  FileReadPort,
  GoalPort,
  HistoryPort,
  MediaPort,
  SchedulePort,
  SkillSourcePaths,
  TodoBroadcast,
} from '@qywork/tools'
import { collectSecrets, listMediaModels, type ModelRef } from '../config.ts'
import { makeMediaPort } from '../media.ts'
import { RuntimeSink } from '../sink.ts'
import { historyPortFor } from './history-port.ts'
import { recordMediaSpend } from './media-spend.ts'
import { decide } from './permission.ts'
import type { SessionState } from './types.ts'

export function makeToolContext(
  session: SessionState,
  runId: RunId,
  emit: (e: AgentEvent) => void,
  target: string | ModelRef,
  adapter: LlmAdapter,
  conversationId: ConversationId,
): ToolContextBase {
  const model = typeof target === 'string' ? target : target.model
  const secrets = collectSecrets(session.opts.config, session.extensions?.mcpConfig.servers)
  const store = session.opts.store
  // 逐模型的能力取自本轮的 adapter，与请求一侧是同一份规格。
  const spec = adapter.spec
  const attached = listMessages(store, conversationId, null).flatMap((m) =>
    m.attachments.map((a) =>
      isAbsolute(a.path) ? resolve(a.path) : resolve(session.opts.workspaceRoot, a.path),
    ),
  )
  const readOnly = [...session.skillDirs, ...attached]
  return {
    workspaceRoot: session.opts.workspaceRoot,
    conversationId,
    runId,
    model,
    // 投递预算按上下文窗口计算，且在执行时应用：切换模型只影响之后的读取，
    // 已写入数据库的 step 不做任何修改（投影因此仍是纯函数）。
    contextWindow: spec.contextWindow,
    // 预算扣减与原生视频的判定使用本轮密度，与请求一侧相同，理由见 `ToolContext.density`。
    density: runDensity(adapter),
    vision: spec.vision,
    ...(adapter.transmits.mediaUploadAbove !== undefined
      ? { videoUploadAbove: adapter.transmits.mediaUploadAbove }
      : {}),
    state: new Map(),
    // sink 绑定到本 run：登记行须能追溯到产生该正文的轮次，
    // run 被删除时引用随之消失，GC 才能回收正文。
    sink: new RuntimeSink(session.opts.store, session.opts.content, runId),
    // 装配方的端口加上本会话按会话与本轮绑定的端口，合为本轮的同一份集合。
    port: session.ports.with([
      /*
       * 读取记录绑定到会话，而不是 run。
       *
       * 服务端为每条消息新建一个 Session（`run-control.ts`），进程内没有
       * 会话级的生命周期可供依附，因此真源放在账本中，随会话一并删除。
       * 绑定到 run 时，每轮第一次修改文件必然先因「未读取」失败一次，
       * 而该守卫判定的是「待写入的版本是否就是读取过的版本」，与 run 边界无关。
       */
      provide(FileReadPort, {
        seen: (path) => fileReadHash(store, conversationId, path),
        mark: (path, hash) => recordFileRead(store, conversationId, path, hash),
      }),
      /*
       * 待办同样绑定到会话，且只读：父会话的整表提交与子任务的待验收回执
       * 本身就是需要写入的 tool step；只有 `write_todos` 改变当前快照。
       * 此处读取的结果供动作词、委派归属与 loop 收尾共用；run 级的 `ctx.state`
       * 无法跨轮查询这些会话级事实。
       */
      provide(TodoPort, { read: (runId) => latestTodos(store, conversationId, runId) }),
      /*
       * 目标同样绑定到会话：其生命周期与会话相同，只有跨轮保留才有意义。
       *
       * 事件在此处发出，不在工具中发出（对比 `TodoBroadcast`）：目标的真源是账本，
       * 写入与广播是同一操作的两部分，交给工具时可能只完成其中一部分。
       * 事件不带 runId：目标是会话级的，服务端在 run 之外也会修改它。
       *
       * 没有 create：设立目标是用户的操作，经由 `goal.set` 指令，不经过工具。
       */
      provide(GoalPort, {
        read: () => currentGoal(store, conversationId),
        update: (input) => announce(updateGoal(store, { conversationId, ...input }), emit),
      }),
      /*
       * 定时任务绑定到当前工作区：整台机器只有一张任务表，端口在此处固定归属，
       * 工具一侧没有跨项目的入口。写入与调度 tick 使用同一份仓储，不另设落盘路径。
       *
       * 创建的任务同时绑定到顶层会话：触发时消息发往该会话，而子会话不接受直接发送的消息
       * （`server/commands.ts` 的 `message.send` 直接拒绝），绑定到子会话的任务无法触发。
       */
      provide(SchedulePort, {
        list: () => listSchedules(store, session.opts.workspaceRoot, Date.now()),
        create: (draft) =>
          createSchedule(
            store,
            session.opts.workspaceRoot,
            draft,
            getConversation(store, conversationId)?.parentConversationId ?? conversationId,
          ),
        remove: (id) => deleteSchedule(store, id, session.opts.workspaceRoot),
      }),
      provide(SkillSourcePaths, () =>
        listMessages(store, conversationId, null).flatMap((m) => m.attachments.map((a) => a.path)),
      ),
      // 有画布时始终提供：画布上的 art 卡使用对话模型，没有配置生成模型也能运行。
      ...(listMediaModels(session.opts.config).length || session.ports.has(CanvasPort)
        ? [
            provide(
              MediaPort,
              makeMediaPort(session.opts.config, (spend) =>
                recordMediaSpend(session, runId, conversationId, spend, emit),
              ),
            ),
          ]
        : []),
      /*
       * 已折叠历史的读取通道。压缩是投影而不是删除，原文始终保留在账本中，
       * 该通道负责将原文提供给模型；缺少该通道时，摘要中的 `[message:…]` 标记指向
       * 模型无法访问的位置，压缩即等同于丢失信息。
       *
       * 使用 list + find 而不是为 store 增加按 id 读取的函数：这是模型主动发起的
       * 低频调用，且会话消息与单个 run 的 step 都是小集合。
       */
      provide(
        HistoryPort,
        historyPortFor(store, session.opts.content, conversationId as ConversationId),
      ),
      provide(TodoBroadcast, (todos) => {
        emit({ type: 'todos', runId, todos })
      }),
    ]).get,
    signal: session.opts.signal,
    secrets,
    ...(session.opts.config.envAllowList ? { envAllowList: session.opts.config.envAllowList } : {}),
    ...(session.extraDirs.length ? { additionalDirectories: session.extraDirs } : {}),
    // 本轮技能索引中各技能的目录：其中的参考文档、模板与代码可读、不可写。
    // 本会话的附件同样只读：附件是用户的显式授权（见 `withAttachments`），缩小发送的截图需经
    // `read_file` 的 region 截取局部放大。内核沙箱生效的平台上，`~/.qywork` 中的附件与技能缺少这一条即无法读取。
    ...(readOnly.length ? { readOnlyRoots: readOnly } : {}),
    // 路径范围不在此处固定：`decide` 每次调用时读取模式，放行时一并给出。
    requestPermission: (call) => decide(session, conversationId, call),
  }
}

/**
 * 目标写入成功时广播一次。
 *
 * 失败结果原样返回、不发出事件：失败结果是给模型的拒绝理由（例如 revision 过期），
 * 账本没有任何变化，广播会使界面上的目标无故闪烁。
 */
function announce(result: GoalWriteResult, emit: (e: AgentEvent) => void): GoalWriteResult {
  if (result.ok) emit({ type: 'goal', goal: result.goal })
  return result
}
