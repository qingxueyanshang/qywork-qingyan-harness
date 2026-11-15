import { definePort } from '@qywork/agent'
import type { TodoItem } from '@qywork/core'

/**
 * 待办变更广播。可选：装配方未注入时没有待办面板，工具仍能正常记录。
 *
 * 独立为一个端口而不复用 `ctx.emit`：emit 是**增量文本**语义（stdout 分段到达），
 * 待办是**整表快照**语义，合用一条通道时前端无法区分应追加还是应替换。
 */
export type TodoBroadcast = (todos: TodoItem[]) => void

export const TodoBroadcast = definePort<TodoBroadcast>('todoBroadcast')
