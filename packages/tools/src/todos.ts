/**
 * 待办整表工具。它提交整份清单，也是父会话验收后改变完成状态的唯一入口。
 *
 * 待办不是方案。本工具管理待办清单：每条一句话，五种状态，完成后标记完成。它回答「进行到哪一步」。
 * 方案是另一类产物：说明为什么这样做、如何取舍、验收标准，它是一篇文档，
 * 回答「打算如何做」，本产品尚未提供。因此本工具与其面板都不称为「计划」，
 * 避免待办清单使用方案的名称。
 *
 * 采用整表替换而不是逐条增删改，原因如下：
 * - 逐条操作要求模型记住每条的 id，而模型经常记错，修改到其他条目。
 * - 全量提交时，清单的变化是原子可见的：前端收到的始终是一份自洽的清单，
 *   不会渲染出「第 3 条已完成而第 2 条尚未开始」这类中间状态。
 * - 清单本应整体调整：执行中途发现方向错误时，正确的做法是重写整张清单，
 *   而不是修补旧清单。
 *
 * 硬约束：同时最多一条 in_progress。允许多条并行会使「当前在做什么」
 * 失去意义，而这正是该面板存在的理由。受阻与失败的条目不计入这一条。
 * 违反时拒绝并说明，不静默纠正：静默改写等于告诉模型清单已被原样接受。
 *
 * 硬约束：blocked 必须带 `blocker`（`TODO_BLOCKERS` 之一）与 `need`，failed 必须带 `cause` 与 `attempts`，
 * 其余状态都不带。执行循环据此判定本轮是继续、停下等待用户还是结束（`agent/loop/turn-end.ts`），
 * 缺少原因的受阻与失败无法审计，也无法在最终回复中逐项说明。
 */

import type { ToolSpec } from '@qywork/agent'
import { TODO_BLOCKERS, TODO_STATUSES, type TodoItem, todoProgress } from '@qywork/core'

/** 待办条目上限。超过此数说明应拆分任务，而不是把清单当作笔记使用。 */
const MAX_ITEMS = 40

export const writeTodosTool: ToolSpec = {
  name: 'write_todos',
  // 何时列出清单、多久提交一次写在系统提示词中（`runtime/prompt.ts`），
  // 此处不重复：同一条规则写在两处，最终会出现两种表述。此处只说明调用方式。
  description:
    '提交或更新当前任务的待办清单。' +
    '每次提交**完整的**清单（整表替换），不是增量：未变化的条目也需原样包含。' +
    '同一时刻只能有一条 in_progress。标为 blocked 的条目必须填写 blocker 与 need，标为 failed 的条目必须填写 cause 与 attempts，其余状态都不填写。',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: '完整的待办清单，按执行顺序排列',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '该步骤要完成的工作，一句话' },
            status: {
              type: 'string',
              enum: [...TODO_STATUSES],
              description: '当前状态',
            },
            blocker: {
              type: 'string',
              enum: [...TODO_BLOCKERS],
              description: '受阻类别，仅 status 为 blocked 时填写',
            },
            need: {
              type: 'string',
              description: '仅 status 为 blocked 时填写：需要谁提供什么，一句话',
            },
            cause: {
              type: 'string',
              description: '仅 status 为 failed 时填写：失败原因',
            },
            attempts: {
              type: 'string',
              description: '仅 status 为 failed 时填写：做过的尝试，包括次数与每次的改动',
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
   * 首次提交是创建，修改已有清单才是编辑。
   *
   * 判据必须使用 `ctx.todos`（会话级，读取账本中上一条 `write_todos` step）。
   * 不要改用 `ctx.state`：它是 run 级的（每条消息一个 run，Map 重新创建），
   * 跨轮无法查到上一份清单，结果是下一轮的第一次提交一律显示为「创建」。
   * 也不要硬编码为常量，那是方向相反的同类缺陷，会始终返回「修改」。
   *
   * 全部完成后再提交一份视为新清单：它属于下一项任务，应返回「创建」。
   *
   * 无法读取（`qy exec` 没有会话）时按 write 处理：显示「创建」至多把一次修订说轻了，
   * 显示「编辑」则是在没有清单时声称修改了一份不存在的清单。
   *
   * 不为它新增 `plan` 动作：与对象「待办」组合后读作「规划待办」，动宾语义重复。
   */
  actionKind: (_args, ctx) => {
    const prev = ctx?.todos?.read()
    if (!prev?.length) return 'write'
    return prev.every((t) => t.status === 'completed') ? 'write' : 'edit'
  },
  objectLabel: '待办',
  category: 'planning',
  facet: '待办账本',
  summary: '提交或更新当前任务的待办清单（整体替换）',
  targetExtractor: () => null,
  // 纯内部记账，不访问工作区也不访问网络，不应弹出权限请求打断用户。
  permissionEffect: 'internal_control',
  // 清单需要按顺序覆盖，两次并发提交的结果取决于调度顺序。
  parallelSafe: false,

  async fn(args, ctx) {
    const parsed = parseTodos(args.todos)
    if (!parsed.ok) {
      return {
        status: 'failure',
        executed: false,
        message: parsed.message,
        errorKind: 'invalid_plan',
      }
    }

    const todos = parsed.todos

    // 事件由工具发出，而不是由 loop 推测：只有此处知道清单的确切内容。
    ctx.emitTodos?.(todos)

    return { status: 'success', message: progressLine(todos), data: { todos } }
  },
}

/**
 * 回执正文。步数由 `todoProgress` 计算，与输入框上方的状态条使用同一个函数：
 * 口径由共享代码统一，不依赖两处约定（各自计算时，同一屏上卡片显示「0/5」、
 * 状态条显示「第 1 / 5 步」，而两者描述的是同一份清单的同一时刻）。
 *
 * 没有进行中的条目时必须说明：整表语义下模型容易在标记完成后不认领下一条，
 * 清单因此停滞在中途。
 */
function progressLine(todos: TodoItem[]): string {
  const p = todoProgress(todos)
  if (p.current) return `第 ${p.step}/${p.total} 步：${p.current.content}`
  if (p.done === p.total) return `${p.total} 步全部完成`
  if (p.done + p.blocked + p.failed === p.total) {
    const rest = [
      ...(p.blocked ? [`${p.blocked} 步受阻`] : []),
      ...(p.failed ? [`${p.failed} 步失败`] : []),
    ]
    return `已完成 ${p.done}/${p.total} 步，其余 ${rest.join('、')}`
  }
  return `已完成 ${p.done}/${p.total} 步，未认领下一条`
}

type ParseResult = { ok: true; todos: TodoItem[] } | { ok: false; message: string }

/** 可选参数是否填写。strict 模式下未填写的可选参数以 null 传入，空字符串同样视为未填写。 */
function filled(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && !value.trim())
}

/** 各状态允许填写的原因字段。不在其中的字段一律拒绝。 */
const REASON_FIELDS = {
  blocked: ['blocker', 'need'],
  failed: ['cause', 'attempts'],
} as const
const ALL_REASON_FIELDS = ['blocker', 'need', 'cause', 'attempts'] as const

/** 去掉首尾空白后的字符串；不是字符串时为空串。 */
function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 校验并归一化待办清单。
 *
 * 校验失败时返回结构化失败，由模型自行修正，不做静默纠正：
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

    const status = TODO_STATUSES.find((s) => s === row.status)
    if (!status)
      return { ok: false, message: `第 ${i + 1} 条的 status 非法：${String(row.status)}` }
    if (status === 'in_progress') inProgress++

    // id 由序号生成而不由模型提供：模型提供的 id 经常在两次提交之间变化，
    // 而整表替换语义下 id 只用于前端 diff，序号足够且稳定。
    const id = `todo_${i + 1}`
    const allowed: readonly string[] =
      status === 'blocked' || status === 'failed' ? REASON_FIELDS[status] : []
    const extra = ALL_REASON_FIELDS.filter((f) => !allowed.includes(f) && filled(row[f]))
    if (extra.length) {
      return {
        ok: false,
        message: `第 ${i + 1} 条的 status 为 ${status}，不填写 ${extra.join('、')}；blocked 只填写 blocker 与 need，failed 只填写 cause 与 attempts，其余状态都不填写。`,
      }
    }
    if (status === 'blocked') {
      const blocker = TODO_BLOCKERS.find((b) => b === row.blocker)
      const need = trimmed(row.need)
      if (!blocker || !need) {
        return {
          ok: false,
          message: `第 ${i + 1} 条标为 blocked，必须填写 blocker（${TODO_BLOCKERS.join('、')} 之一）与 need（需要谁提供什么）。不是在等待用户的困难不是受阻：按失败的处理方式重试或调整，仍无法完成时标为 failed。`,
        }
      }
      todos.push({ id, content, status, blocker, need })
      continue
    }
    if (status === 'failed') {
      const cause = trimmed(row.cause)
      const attempts = trimmed(row.attempts)
      if (!cause || !attempts) {
        return {
          ok: false,
          message: `第 ${i + 1} 条标为 failed，必须填写 cause（失败原因）与 attempts（做过的尝试，包括次数与每次的改动）。`,
        }
      }
      todos.push({ id, content, status, cause, attempts })
      continue
    }
    todos.push({ id, content, status })
  }

  if (inProgress > 1) {
    return {
      ok: false,
      message: `同时只能有一条 in_progress，当前有 ${inProgress} 条。将其余条目标为 pending 或 completed。`,
    }
  }

  return { ok: true, todos }
}
