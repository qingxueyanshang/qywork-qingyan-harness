import { definePort } from '@qywork/agent'
import type { Schedule, ScheduleDraft, ScheduleView } from '@qywork/core'

/**
 * 定时任务端口。
 *
 * **为什么是端口。** 理由同 `GoalPort`：任务表位于账本（`@qywork/store`），而工具不持有账本
 * 句柄；写入哪一份账本、归属哪个工作区，由装配方决定。实现由 runtime 注入。
 *
 * **按当前工作区限定范围。** 任务表全机只有一份，方法不带工作区参数：带有该参数即允许模型列出
 * 甚至删除其他项目创建的任务，而模型从未见过那些任务。
 *
 * 可选：直接构造 `ToolContext` 的测试夹具无法注入。三个工具必须能降级，明确报告「本次执行没有
 * 定时任务表」，不得声称已记录。这是**更严格**的一侧（无法创建任务），漏接不会使任何任务被静默丢弃。
 */
export interface SchedulePort {
  /** 当前工作区的全部任务，带上次执行的 Run 终态投影。 */
  list(): ScheduleView[]
  /** 新建一条任务。校验由调用方预先完成，此处只负责落盘。 */
  create(draft: ScheduleDraft): Schedule
  /** 删除一条任务；不存在或不属于当前工作区时返回 null。 */
  remove(id: string): Schedule | null
}

export const SchedulePort = definePort<SchedulePort>('schedules')
