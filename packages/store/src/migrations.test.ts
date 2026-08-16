/**
 * 迁移的行为回归。**覆盖范围**：`schema.ts` 的 `MIGRATIONS`。
 *
 * 只测「转换数据」的那几条。纯建表的不测——建错了任何一条查询都会红，
 * 而数据转换错了是静默的：代码全绿、界面上冒出一个 `undefined` 或者一句旧文案。
 */

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { MIGRATIONS } from './schema.ts'

/** 跑到某一条迁移之前的库。外键默认关着，所以可以只插 steps 不建父行。 */
function dbBefore(id: number): Database {
  const db = new Database(':memory:')
  for (const m of MIGRATIONS) {
    if (m.id >= id) break
    db.exec(m.sql)
  }
  return db
}

function applyOne(db: Database, id: number): void {
  db.exec(MIGRATIONS.find((m) => m.id === id)!.sql)
}

function insertStep(db: Database, id: string, toolName: string, payload: unknown): void {
  db.query(
    `INSERT INTO steps (id, run_id, seq, kind, tool_name, payload, status, created_at)
     VALUES (?, 'rn', 1, 'tool_action', ?, ?, 'done', 0)`,
  ).run(id, toolName, JSON.stringify(payload))
}

function payloadOf(
  db: Database,
  id: string,
): { action: { kind: string; objectLabel: string }; outcome?: { message: string } } {
  const row = db
    .query<{ payload: string }, [string]>('SELECT payload FROM steps WHERE id = ?')
    .get(id)!
  return JSON.parse(row.payload)
}

/**
 * 动作轴从九个值收敛到六个。
 *
 * **不转数据就等于没改完**：代码里枚举改了，账本里的老 step 还带着 `execute`/`plan`，
 * 回放时前端查不到动词，卡片标题掉回原始工具名——界面上直接出现 `update_plan`。
 */
describe('迁移 16：动作轴收敛到六枚举', () => {
  const cases: [string, string, string, string][] = [
    // id, 老 kind, 新 kind, 对象名
    ['s_exec', 'execute', 'run', '命令'],
    ['s_deleg', 'delegate', 'run', '编排节点'],
    ['s_search', 'search', 'query', '内容'],
    ['s_fetch', 'fetch', 'read', '网页'],
  ]

  test('四个退役值各自转到对应的动作', () => {
    const db = dbBefore(16)
    for (const [id, oldKind, , label] of cases) {
      insertStep(db, id, 't', {
        kind: 'tool_result',
        action: { kind: oldKind, objectLabel: label, target: null },
      })
    }
    applyOne(db, 16)
    for (const [id, , newKind, label] of cases) {
      expect(payloadOf(db, id).action.kind).toBe(newKind)
      // 对象名不动：换的是动作，不是被操作的东西。
      expect(payloadOf(db, id).action.objectLabel).toBe(label)
    }
  })

  /** 待办不是方案。`plan` 那条要同时把对象名还回去，否则读出来还是「创建计划」。 */
  test('plan 转成 write，且对象名从「计划」改成「待办」', () => {
    const db = dbBefore(16)
    insertStep(db, 's_plan', 'update_plan', {
      kind: 'tool_result',
      action: { kind: 'plan', objectLabel: '计划', target: null },
      outcome: { message: '计划已更新（1/3）：正在「甲」' },
    })
    applyOne(db, 16)
    const p = payloadOf(db, 's_plan')
    expect(p.action.kind).toBe('write')
    expect(p.action.objectLabel).toBe('待办')
    // 回执文案也是落盘的，不转的话展开体里还写着「计划已更新」。
    expect(p.outcome?.message).toBe('待办已更新（1/3）：正在「甲」')
  })

  test('六个合法值原样不动 —— 迁移只碰退役值', () => {
    const db = dbBefore(16)
    for (const kind of ['query', 'read', 'write', 'edit', 'delete', 'run']) {
      insertStep(db, `ok_${kind}`, 't', {
        kind: 'tool_result',
        action: { kind, objectLabel: '文件', target: 'a.ts' },
      })
    }
    applyOne(db, 16)
    for (const kind of ['query', 'read', 'write', 'edit', 'delete', 'run']) {
      expect(payloadOf(db, `ok_${kind}`).action.kind).toBe(kind)
    }
  })

  /** 没有 action 的行（纯文本 step、以及名字不在注册表里的调用）不许被 json_set 塞进一个键。 */
  test('没有 action 的行不长出 action', () => {
    const db = dbBefore(16)
    insertStep(db, 's_none', 'weird', {
      kind: 'tool_result',
      outcome: { message: '未知工具: weird' },
    })
    applyOne(db, 16)
    const row = db
      .query<{ payload: string }, [string]>('SELECT payload FROM steps WHERE id = ?')
      .get('s_none')!
    expect(JSON.parse(row.payload).action).toBeUndefined()
  })
})

/**
 * 工具改名，落库的 `tool_name` 要跟着转。
 *
 * 不转的后果实测撞过：待办面板整个空了。面板是从账本投影的（找最后一条成功的
 * 待办提交，整表在它的 args 里），投影按新名字找，老行还叫旧名字，一条都匹配不上，
 * 用户看到的是「之前的数据没了」。
 */
describe('迁移 17：update_plan → write_todos', () => {
  test('老名字转成新名字，别的工具不动', () => {
    const db = dbBefore(17)
    insertStep(db, 'old', 'update_plan', {
      kind: 'tool_result',
      args: { todos: [{ id: 't1', content: '甲', status: 'in_progress' }] },
    })
    insertStep(db, 'other', 'read_file', { kind: 'tool_result', args: { path: 'a.ts' } })
    applyOne(db, 17)

    const name = (id: string) =>
      db.query<{ n: string }, [string]>('SELECT tool_name AS n FROM steps WHERE id = ?').get(id)!.n
    expect(name('old')).toBe('write_todos')
    expect(name('other')).toBe('read_file')
  })

  /** 转完之后，整表 todos 还在原处——改的是名字，不是内容。 */
  test('args 里的整表原样保留', () => {
    const db = dbBefore(17)
    insertStep(db, 'old', 'update_plan', {
      kind: 'tool_result',
      args: { todos: [{ id: 't1', content: '甲', status: 'completed' }] },
    })
    applyOne(db, 17)
    const row = db
      .query<{ payload: string }, [string]>('SELECT payload FROM steps WHERE id = ?')
      .get('old')!
    expect(JSON.parse(row.payload).args.todos[0].content).toBe('甲')
  })
})

/**
 * 迁移 16 已经转过这句话，这里再转一遍——针对的是**它执行之后**才写进来的行。
 *
 * 那批行的来历：动作轴与回执文案分两批改，中间跑过真实轮次，于是落下
 * 「新动作 + 旧文案」的组合（标题读作「创建待办」，展开体写着「计划已更新」）。
 */
describe('迁移 18：再扫一遍待办回执的旧文案', () => {
  test('新动作 + 旧文案的行，文案转掉，动作不动', () => {
    const db = dbBefore(18)
    insertStep(db, 'mixed', 'write_todos', {
      kind: 'tool_result',
      action: { kind: 'write', objectLabel: '待办', target: null },
      outcome: { message: '计划已更新（1/3）：正在「甲」' },
    })
    applyOne(db, 18)

    const p = payloadOf(db, 'mixed')
    expect(p.outcome?.message).toBe('待办已更新（1/3）：正在「甲」')
    expect(p.action.kind).toBe('write')
    expect(p.action.objectLabel).toBe('待办')
  })

  /** 幂等：已经是新文案的行不该被再改一次，别的工具的回执一个字都不能动。 */
  test('新文案与无关回执原样不动', () => {
    const db = dbBefore(18)
    insertStep(db, 'done', 'write_todos', {
      kind: 'tool_result',
      action: { kind: 'edit', objectLabel: '待办', target: null },
      outcome: { message: '待办已更新（2/3）：正在「乙」' },
    })
    insertStep(db, 'other', 'run_command', {
      kind: 'tool_result',
      action: { kind: 'run', objectLabel: '命令', target: 'ls' },
      outcome: { message: '命令执行成功' },
    })
    applyOne(db, 18)

    expect(payloadOf(db, 'done').outcome?.message).toBe('待办已更新（2/3）：正在「乙」')
    expect(payloadOf(db, 'other').outcome?.message).toBe('命令执行成功')
  })
})

/**
 * 外置工具（MCP / 插件）的动作转成 `call`。
 *
 * 不转的表现是同一件事在时间线上有两种说法：老行写着「运行 mcp:github/create_issue」，
 * 今天调同一个工具记的是「调用」。判据是工具名里的 `__`——只有 `mcp__<server>__<tool>`
 * 与插件的 `<id>__<tool>` 会带它，内置工具名一个都不含。
 */
describe('迁移 19：外置工具的动作转成 call', () => {
  const kindOf = (db: Database, id: string) => payloadOf(db, id).action.kind

  test('MCP 与插件的行一律转成 call，不管旧值是什么', () => {
    const db = dbBefore(19)
    const rows: [string, string, string][] = [
      // id, tool_name, 旧 kind
      ['m_run', 'mcp__github__create_issue', 'run'],
      ['m_del', 'mcp__github__delete_repo', 'delete'],
      ['m_res', 'mcp__demo__fetch_resource', 'read'],
      ['p_write', 'com_example_mytool__count_lines', 'write'],
      ['p_query', 'demo_lines__scan', 'query'],
    ]
    for (const [id, tool, kind] of rows) {
      insertStep(db, id, tool, {
        kind: 'tool_result',
        action: { kind, objectLabel: 'mcp:github/create_issue', target: null },
      })
    }
    applyOne(db, 19)
    for (const [id] of rows) expect(kindOf(db, id)).toBe('call')
    // 对象名不动：换的是动作，不是被操作的东西。
    expect(payloadOf(db, 'm_run').action.objectLabel).toBe('mcp:github/create_issue')
  })

  test('内置工具的行原样不动 —— 判据是名字里的双下划线', () => {
    const db = dbBefore(19)
    const builtin: [string, string, string][] = [
      ['b_run', 'run_command', 'run'],
      ['b_read', 'read_file', 'read'],
      ['b_todos', 'write_todos', 'edit'],
      ['b_res', 'read_resource', 'read'],
      ['b_skill', 'read_skill', 'read'],
    ]
    for (const [id, tool, kind] of builtin) {
      insertStep(db, id, tool, {
        kind: 'tool_result',
        action: { kind, objectLabel: '文件', target: 'a.ts' },
      })
    }
    applyOne(db, 19)
    for (const [id, , kind] of builtin) expect(kindOf(db, id)).toBe(kind)
  })

  /** `json_set` 会给没有 action 的行凭空长出一个键，WHERE 必须把它们挡在外面。 */
  test('没有 action 的行不长出 action', () => {
    const db = dbBefore(19)
    insertStep(db, 'noaction', 'mcp__demo__echo', { kind: 'tool_result', args: { text: 'x' } })
    applyOne(db, 19)
    const row = db
      .query<{ payload: string }, [string]>('SELECT payload FROM steps WHERE id = ?')
      .get('noaction')!
    expect(JSON.parse(row.payload).action).toBeUndefined()
  })
})
