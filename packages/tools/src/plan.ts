/**
 * 计划工具。移植自原版 `plugins/planning.py` + `execution/plan_rules.py` 的核心约束。
 *
 * 这个工具是 `todos` 事件的**唯一生产者**——在它之前，协议里定义了事件、
 * 前端写好了渲染，但没有任何代码发它，任务清单面板永远是空的。
 *
 * ## 为什么是「整表替换」而不是「增删改单条」
 *
 * 原版用的是全量提交，照搬。理由不是省事：
 *
 * - 单条操作要求模型记住每条的 id，而它经常记错，改到别的条目上。
 * - 全量提交下，「计划变了」这件事本身是**原子可见**的——前端拿到的永远是
 *   一份自洽的清单，不会出现「第 3 条已完成但第 2 条还没开始」这种中间态被渲染出来。
 * - 计划本来就该整体重排：做到一半发现方向错了，正确的动作是重写整个计划，
 *   不是给旧计划打补丁。
 *
 * ## 硬约束：同时最多一条 in_progress
 *
 * 这是原版 `plan_rules.py` 里最有价值的一条。允许多条并行会让「当前在做什么」
 * 失去意义，而那正是这个面板存在的全部理由。违反时**拒绝并说明**，不静默纠正——
 * 静默改写会让模型以为自己的计划被接受了。
 */

import type { ToolSpec } from '@qywork/agent'
import type { TodoItem } from '@qywork/core'

/** ctx.state 里存当前计划的键。整个 run 共用一份。 */
export const PLAN_STATE_KEY = 'qywork.plan'

/** 计划条目上限。超过这个数说明该拆任务了，而不是把清单当笔记本用。 */
const MAX_ITEMS = 40

export const updatePlanTool: ToolSpec = {
  name: 'update_plan',
  description:
    '提交或更新当前任务的执行计划。多步骤任务开始前先建计划，每完成一步就更新状态。' +
    '每次提交**完整的**清单（整表替换），不是增量。' +
    '同一时刻只能有一条 in_progress。单步就能做完的小任务不需要建计划。',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: '完整的计划清单，按执行顺序排列',
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
  actionKind: 'plan',
  objectLabel: '计划',
  targetExtractor: () => null,
  // 纯内部记账，不碰工作区也不出网，不该弹权限窗打断用户。
  permissionEffect: 'internal_control',
  // 计划要按顺序覆盖，两次并发提交谁赢全看调度。
  parallelSafe: false,

  async fn(args, ctx) {
    const parsed = parsePlan(args.todos)
    if (!parsed.ok) {
      return { status: 'failure', message: parsed.message, errorKind: 'invalid_plan' }
    }

    const todos = parsed.todos
    ctx.state.set(PLAN_STATE_KEY, todos)

    // 事件从工具里发出去，而不是由 loop 猜——只有这里知道计划的确切内容。
    ctx.emitTodos?.(todos)

    const done = todos.filter((t) => t.status === 'completed').length
    const current = todos.find((t) => t.status === 'in_progress')
    return {
      status: 'success',
      message: current
        ? `计划已更新（${done}/${todos.length}）：正在「${current.content}」`
        : `计划已更新（${done}/${todos.length}）`,
      data: { todos },
    }
  },
}

type ParseResult = { ok: true; todos: TodoItem[] } | { ok: false; message: string }

/**
 * 校验并归一化计划。
 *
 * 校验失败**返回结构化失败让模型自己修**，不做静默纠正：
 * 悄悄把两条 in_progress 改成一条，模型会以为自己的计划原样被接受了，
 * 下一轮继续按错误的理解推进。
 */
function parsePlan(raw: unknown): ParseResult {
  if (!Array.isArray(raw)) return { ok: false, message: 'todos 必须是数组' }
  if (raw.length === 0) return { ok: false, message: '计划不能为空；不需要计划就别调这个工具' }
  if (raw.length > MAX_ITEMS) {
    return { ok: false, message: `计划最多 ${MAX_ITEMS} 条，当前 ${raw.length} 条——该拆任务了` }
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
