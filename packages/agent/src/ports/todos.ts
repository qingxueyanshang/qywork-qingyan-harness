import type { RunId, TodoItem } from '@qywork/core'
import { definePort } from './key.ts'

/**
 * 待办端口：**只读**，因为待办不存在独立的第二份状态。
 *
 * 事实均记录在 tool steps 中：`write_todos` 写入整表，`subagent` 在自己的 step 上留下
 * 待验收回执；只有前者改变清单状态。`read()` 从同一账本读取；增加
 * `write()` 会使同一份清单存于两处，两本账终将不一致。
 *
 * 该端口存在的唯一理由：**「这是第一份清单，还是修改已有清单」是会话级事实**，
 * 而 `ctx.state` 是 run 级的（一条消息对应一个 run，Map 每次新建），从中无法查到
 * 上一轮的清单，动作词因此只能恒为「创建」或恒为「修改」。
 *
 * `write_todos` 据此判定动作词，Agent Loop 据此判断一次正常 end_turn 后是否仍有未完成项，
 * 因此定义在 agent 包。
 *
 * 可选：`qy exec` 等一次性执行没有会话，因此无法读取上一份清单。工具必须能降级，
 * 见 `write_todos` 的 `actionKind`：无法读取时称「创建」，会把一次修订描述得比实际范围小；
 * 反之称「修改」会在没有清单时声称修改了一份不存在的清单。未提供时循环沿用普通问答的结束语义。
 */
export interface TodoPort {
  /** 从 tool steps 读取清单；指定 runId 时按本轮提交或父任务回执的接续关系取清单。 */
  read(runId?: RunId): TodoItem[] | null
}

export const TodoPort = definePort<TodoPort>('todos')
