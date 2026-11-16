import { definePort } from '@qywork/agent'
import type { Goal, GoalAction, GoalWriteResult } from '@qywork/core'

/**
 * 目标端口：设定一个目标后逐轮推进直至完成。
 *
 * **为什么是端口。** 目标写入**账本**（`@qywork/store`），而 tools 在依赖图
 * 上**低于** store，工具直接引用它即构成反向边。因此实现由 runtime 注入：
 * runtime 同时持有账本与事件通道。
 *
 * **写入结果是返回值，不是异常。** 三种拒绝（revision 过期、状态不允许、缺少理由）都须**原样交给模型**：
 * 模型须知道具体是哪一种才能调整做法。异常会被注册表归并为一句「工具执行出错」。
 *
 * **变更事件由实现方发送。** 写入成功后 `goal` 事件由端口实现负责广播，不由工具再调用 `emitXxx`：
 * 目标变更与写入账本是同一件事，拆成两步会导致只完成其中一步。
 * （待办通道不同：待办不写入账本，工具是其唯一的真源。）
 *
 * 可选：`qy exec` 等一次性执行没有会话，因此没有目标。工具必须能降级，明确报告「这里没有目标账本」，
 * 不得声称已记录。这是**更严格**的一侧（循环无法启动），漏接不会使任何循环自行启动。
 */
export interface GoalPort {
  /** 当前会话的目标；未设定时为 null。 */
  read(): Goal | null
  /**
   * **没有 `create`。** 设定目标是用户的操作（`/goal`），不经由工具。
   *
   * `action` 只能取 `complete` / `blocked` 两个值；账本层还接受
   * `edit` / `pause` / `resume`，但这三个动作的生产者位于服务端与用户一侧。
   */
  update(input: {
    goalId: string
    revision: number
    action: GoalAction
    blockedReason?: string
  }): GoalWriteResult
}

export const GoalPort = definePort<GoalPort>('goals')
