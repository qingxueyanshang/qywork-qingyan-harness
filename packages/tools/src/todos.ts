/**
 * 待办整表工具。它提交整份清单；绑定父待办的成功子任务由 loop 在落账后发同型投影。
 *
 * **待办不是方案。** 这里管的是**待办清单**：一条一句话，三个状态，做完打勾。它回答「进行到哪了」。
 * **方案**是另一件事——为什么这么做、取舍是什么、验收标准，那是一篇文档，
 * 回答「打算怎么做」，这个产品里还没有它。所以这个工具和它的面板都不叫「计划」，
 * 免得一个待办清单顶着方案的名字。
 *
 * **为什么是「整表替换」而不是「增删改单条」**：
 * - 单条操作要求模型记住每条的 id，而它经常记错，改到别的条目上。
 * - 全量提交下，「清单变了」这件事本身是**原子可见**的——前端拿到的永远是
 *   一份自洽的清单，不会出现「第 3 条已完成但第 2 条还没开始」这种中间态被渲染出来。
 * - 清单本来就该整体重排：做到一半发现方向错了，正确的动作是重写整张清单，
 *   不是给旧的打补丁。
 *
 * **硬约束：同时最多一条 in_progress。** 允许多条并行会让「当前在做什么」
 * 失去意义，而那正是这个面板存在的全部理由。违反时**拒绝并说明**，不静默纠正——
 * 静默改写等于告诉模型清单已被原样接受。
 */

import type { ToolSpec } from '@qywork/agent'
import { type TodoItem, todoProgress } from '@qywork/core'

/** 待办条目上限。超过这个数说明该拆任务了，而不是把清单当笔记本用。 */
const MAX_ITEMS = 40

export const writeTodosTool: ToolSpec = {
  name: 'write_todos',
  // 「什么时候该列、多久提交一次」写在系统提示词里（`runtime/prompt.ts`），
  // 不在这里重复一遍——同一条规矩两处写迟早会漂成两句话。这里只说怎么调。
  description:
    '提交或更新当前任务的待办清单。' +
    '每次提交**完整的**清单（整表替换），不是增量——没变的条目也要原样带上。' +
    '同一时刻只能有一条 in_progress。',
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
   * 判据必须走 `ctx.todos`（会话级，读的是账本里上一条 `write_todos` step）。
   * 不要改用 `ctx.state`：它是 **run 级**的（一条消息一个 run，Map 新建），
   * 跨轮查不到上一份清单，表现是下一轮的第一次提交一律说成「创建」。
   * 也不要拍成常量——那是反过来的同一个毛病，永远说「修改」。
   *
   * 全做完之后再提交一份算**新**清单：那已经是下一件事了，说「创建」才对。
   *
   * 读不到（`qy exec` 没有会话）时按 write：说「创建」最多把一次修订说小了，
   * 说「编辑」却是在没有清单时声称改过一份不存在的清单。
   *
   * 不为它造一个 `plan` 动作：配上对象「待办」读作「规划待办」，动宾同义反复。
   */
  actionKind: (_args, ctx) => {
    const prev = ctx?.todos?.read()
    if (!prev?.length) return 'write'
    return prev.every((t) => t.status === 'completed') ? 'write' : 'edit'
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

    // 事件从工具里发出去，而不是由 loop 猜——只有这里知道清单的确切内容。
    ctx.emitTodos?.(todos)

    return { status: 'success', message: progressLine(todos), data: { todos } }
  },
}

/**
 * 回执正文。步数由 `todoProgress` 算，**与输入框上那条状态条是同一个函数**——
 * 口径靠共享代码统一，不靠两边约定（各算各的时，同一屏上卡片写「0/5」、
 * 状态条写「第 1 / 5 步」，说的是同一份清单的同一时刻）。
 *
 * 没有进行中的那一条时**要说出来**：整表语义下模型很容易打完勾就不认领下一条，
 * 而那正是清单停在半路的样子。
 */
function progressLine(todos: TodoItem[]): string {
  const p = todoProgress(todos)
  if (p.current) return `第 ${p.step}/${p.total} 步：${p.current.content}`
  if (p.done === p.total) return `${p.total} 步全部完成`
  return `已完成 ${p.done}/${p.total} 步，未认领下一条`
}

type ParseResult = { ok: true; todos: TodoItem[] } | { ok: false; message: string }

/**
 * 校验并归一化待办清单。
 *
 * 校验失败**返回结构化失败让模型自己修**，不做静默纠正：
 * 静默把两条 in_progress 改成一条，等于告诉模型清单已被原样接受，
 * 下一轮它会继续按错误的理解推进。
 */
function parseTodos(raw: unknown): ParseResult {
  if (!Array.isArray(raw)) return { ok: false, message: 'todos 必须是数组' }
  if (raw.length === 0) return { ok: false, message: '清单不能为空；不需要清单时不要调用本工具' }
  if (raw.length > MAX_ITEMS) {
    return {
      ok: false,
      message: `待办最多 ${MAX_ITEMS} 条，当前 ${raw.length} 条，超出上限，请拆分任务`,
    }
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
      message: `同时只能有一条 in_progress，当前有 ${inProgress} 条。将其余条目标为 pending 或 completed。`,
    }
  }

  return { ok: true, todos }
}
