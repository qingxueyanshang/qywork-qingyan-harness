/**
 * 待办工具。移植自原版 `plugins/planning.py` + `execution/plan_rules.py` 的核心约束。
 *
 * ## 待办不是方案
 *
 * 这里管的是**待办清单**：一条一句话，三个状态，做完打勾。它回答「进行到哪了」。
 * **方案**是另一件事——为什么这么做、取舍是什么、验收标准，那是一篇文档，
 * 回答「打算怎么做」。原版是两个工具两份东西（`write_todos` 落待办账本、
 * `write_plan` 落 `docs/*.md`）。qywork 现在只有待办这半边，
 * 曾经它叫 `update_plan`、面板叫「计划」，于是一个待办清单顶着方案的名字，
 * 而真正的方案在这个产品里根本不存在——名字先还回去，缺的那半边单独立项。
 *
 * 这个工具是 `todos` 事件的**唯一生产者**——在它之前，协议里定义了事件、
 * 前端写好了渲染，但没有任何代码发它，待办面板永远是空的。
 *
 * ## 为什么是「整表替换」而不是「增删改单条」
 *
 * 原版用的是全量提交，照搬。理由不是省事：
 *
 * - 单条操作要求模型记住每条的 id，而它经常记错，改到别的条目上。
 * - 全量提交下，「清单变了」这件事本身是**原子可见**的——前端拿到的永远是
 *   一份自洽的清单，不会出现「第 3 条已完成但第 2 条还没开始」这种中间态被渲染出来。
 * - 清单本来就该整体重排：做到一半发现方向错了，正确的动作是重写整张清单，
 *   不是给旧的打补丁。
 *
 * ## 硬约束：同时最多一条 in_progress
 *
 * 这是原版 `plan_rules.py` 里最有价值的一条。允许多条并行会让「当前在做什么」
 * 失去意义，而那正是这个面板存在的全部理由。违反时**拒绝并说明**，不静默纠正——
 * 静默改写会让模型以为自己的清单被接受了。
 */

import type { ToolSpec } from '@qywork/agent'
import type { TodoItem } from '@qywork/core'

/** ctx.state 里存当前待办清单的键。整个 run 共用一份。 */
export const TODOS_STATE_KEY = 'qywork.todos'

/** 待办条目上限。超过这个数说明该拆任务了，而不是把清单当笔记本用。 */
const MAX_ITEMS = 40

export const writeTodosTool: ToolSpec = {
  name: 'write_todos',
  description:
    '提交或更新当前任务的待办清单。多步骤任务开始前先列清单，每完成一步就更新状态。' +
    '每次提交**完整的**清单（整表替换），不是增量。' +
    '同一时刻只能有一条 in_progress。单步就能做完的小任务不需要列清单。',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: '完整的待办清单，按执行顺序排列',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '这一步要做什么，一句话' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: '当前状态',
            },
          },
          required: ['content', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
  /*
   * **首建是创建，改已有的才是编辑。**
   *
   * 这里曾经是一个专为它造的 `plan` 动作，配上对象「计划」，界面上读出来是
   * 「规划计划」——动宾同义反复。动作轴只表达做了什么动作：从无到有是创建，
   * 改一份已经在的是编辑。判据取**当前有没有一份没做完的清单**（和魔盒
   * `_write_todos_kind` 同一条）：全做完之后再提交一份，那是新一轮的清单。
   *
   * 拿不到 ctx 时按 write，不按 edit：说「创建」最多是把一次修订说小了，
   * 说「编辑」却可能在根本没有清单时声称改过一份不存在的东西。
   */
  actionKind: (_args, ctx) => {
    const todos = ctx?.state.get(TODOS_STATE_KEY)
    if (!Array.isArray(todos) || todos.length === 0) return 'write'
    return (todos as TodoItem[]).every((t) => t.status === 'completed') ? 'write' : 'edit'
  },
  objectLabel: '待办',
  category: 'planning',
  facet: '待办账本',
  summary: '提交或更新当前任务的待办清单（整表替换）',
  targetExtractor: () => null,
  // 纯内部记账，不碰工作区也不出网，不该弹权限窗打断用户。
  permissionEffect: 'internal_control',
  // 清单要按顺序覆盖，两次并发提交谁赢全看调度。
  parallelSafe: false,

  async fn(args, ctx) {
    const parsed = parseTodos(args.todos)
    if (!parsed.ok) {
      return { status: 'failure', message: parsed.message, errorKind: 'invalid_plan' }
    }

    const todos = parsed.todos
    ctx.state.set(TODOS_STATE_KEY, todos)

    // 事件从工具里发出去，而不是由 loop 猜——只有这里知道清单的确切内容。
    ctx.emitTodos?.(todos)

    const done = todos.filter((t) => t.status === 'completed').length
    const current = todos.find((t) => t.status === 'in_progress')
    return {
      status: 'success',
      message: current
        ? `待办已更新（${done}/${todos.length}）：正在「${current.content}」`
        : `待办已更新（${done}/${todos.length}）`,
      data: { todos },
    }
  },
}

type ParseResult = { ok: true; todos: TodoItem[] } | { ok: false; message: string }

/**
 * 校验并归一化待办清单。
 *
 * 校验失败**返回结构化失败让模型自己修**，不做静默纠正：
 * 悄悄把两条 in_progress 改成一条，模型会以为自己的清单原样被接受了，
 * 下一轮继续按错误的理解推进。
 */
function parseTodos(raw: unknown): ParseResult {
  if (!Array.isArray(raw)) return { ok: false, message: 'todos 必须是数组' }
  if (raw.length === 0) return { ok: false, message: '清单不能为空；不需要列清单就别调这个工具' }
  if (raw.length > MAX_ITEMS) {
    return { ok: false, message: `待办最多 ${MAX_ITEMS} 条，当前 ${raw.length} 条——该拆任务了` }
  }

  const todos: TodoItem[] = []
  let inProgress = 0

  for (const [i, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, message: `第 ${i + 1} 条不是对象` }
    }
    const row = item as Record<string, unknown>
    const content = String(row.content ?? '').trim()
    if (!content) return { ok: false, message: `第 ${i + 1} 条缺少 content` }

    const status = String(row.status ?? '')
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      return { ok: false, message: `第 ${i + 1} 条的 status 非法：${status}` }
    }
    if (status === 'in_progress') inProgress++

    todos.push({
      // id 由序号生成而不是让模型给：模型给的 id 经常在两次提交之间漂移，
      // 而整表替换的语义下 id 只用于前端 diff，序号足够且稳定。
      id: `todo_${i + 1}`,
      content,
      status,
    })
  }

  if (inProgress > 1) {
    return {
      ok: false,
      message: `同时只能有一条 in_progress，当前有 ${inProgress} 条。先把其他的标回 pending 或 completed。`,
    }
  }

  return { ok: true, todos }
}
