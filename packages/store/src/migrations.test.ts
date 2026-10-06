/**
 * 迁移行为的回归测试。覆盖范围：`schema.ts` 的 `MIGRATIONS` 与 `ROW_COLUMNS`、
 * `db.ts` 的迁移执行，以及 `repos.ts` 的启动恢复查询。
 *
 * 只测试转换数据的迁移，不测试纯建表的迁移：建表出错时任何一条查询都会失败，
 * 而数据转换出错不会报错，只会使界面显示 `undefined` 或旧文案。
 */

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeMigration, Store } from './db.ts'
import { recoverStaleRuns } from './repos.ts'
import { MIGRATIONS, ROW_COLUMNS } from './schema.ts'

/** 执行到指定迁移之前的库。外键默认关闭，因此可以只插入 steps 而不创建父行。 */
function dbBefore(id: number): Database {
  const db = new Database(':memory:')
  for (const m of MIGRATIONS) {
    if (m.id >= id) break
    executeMigration(db, m)
  }
  return db
}

function applyOne(db: Database, id: number): void {
  executeMigration(db, MIGRATIONS.find((m) => m.id === id)!)
}

function insertStep(db: Database, id: string, toolName: string, payload: unknown): void {
  db.query(
    `INSERT INTO steps (id, run_id, seq, kind, tool_name, payload, status, created_at)
     VALUES (?, 'rn', 1, 'tool_action', ?, ?, 'done', 0)`,
  ).run(id, toolName, JSON.stringify(payload))
}

/** 完整的 payload，用于断言内容未发生任何改动。 */
function payloadJson(db: Database, id: string): unknown {
  const row = db.query('SELECT payload FROM steps WHERE id = ?').get(id) as { payload: string }
  return JSON.parse(row.payload)
}

/** `outcome.data`，迁移 27 只修改此处。 */
function dataOf(db: Database, id: string): Record<string, unknown> {
  return (payloadJson(db, id) as { outcome: { data: Record<string, unknown> } }).outcome.data
}

function payloadOf(
  db: Database,
  id: string,
): {
  action: { kind: string; objectLabel: string; target: string | null }
  outcome?: { message: string }
} {
  const row = db
    .query<{ payload: string }, [string]>('SELECT payload FROM steps WHERE id = ?')
    .get(id)!
  return JSON.parse(row.payload)
}

/**
 * 动作轴从九个值收敛为六个。
 *
 * 不转换数据等于修改未完成：代码中的枚举已修改，账本中的旧 step 仍带有 `execute`/`plan`，
 * 回放时前端没有对应动词，卡片标题回退为原始工具名，界面显示 `update_plan`。
 */
describe('迁移 16：动作轴收敛为六个枚举值', () => {
  const cases: [string, string, string, string][] = [
    // id, 旧 kind, 新 kind, 对象名
    ['s_exec', 'execute', 'run', '命令'],
    ['s_deleg', 'delegate', 'run', '编排节点'],
    ['s_search', 'search', 'query', '内容'],
    ['s_fetch', 'fetch', 'read', '网页'],
  ]

  test('四个停用值分别转为对应的动作', () => {
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
      // 对象名不变：更换的是动作，不是被操作的对象。
      expect(payloadOf(db, id).action.objectLabel).toBe(label)
    }
  })

  /** 待办不是计划。`plan` 行必须同时修改对象名，否则读取后的标题仍是「创建计划」。 */
  test('plan 转为 write，且对象名从「计划」改为「待办」', () => {
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
    // 回执文案同样已写入磁盘，不转换时展开内容中仍显示「计划已更新」。
    expect(p.outcome?.message).toBe('待办已更新（1/3）：正在「甲」')
  })

  test('六个合法值保持不变，迁移只修改停用值', () => {
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

  /** 没有 action 的行（纯文本 step，以及名称不在注册表中的调用）不得被 json_set 写入该键。 */
  test('没有 action 的行不会新增 action', () => {
    const db = dbBefore(16)
    insertStep(db, 's_none', 'weird', {
      kind: 'tool_result',
      outcome: { message: '未注册调用：weird' },
    })
    applyOne(db, 16)
    const row = db
      .query<{ payload: string }, [string]>('SELECT payload FROM steps WHERE id = ?')
      .get('s_none')!
    expect(JSON.parse(row.payload).action).toBeUndefined()
  })
})

/**
 * 工具改名后，账本中的 `tool_name` 必须随之转换。
 *
 * 不迁移时待办面板为空（已实测）。面板由账本投影得出（查找最后一条成功的
 * 待办提交，完整列表在其 args 中），投影按新名称查找，旧行仍是旧名称，因此没有任何匹配，
 * 已有的待办不再显示。
 */
describe('迁移 17：update_plan → write_todos', () => {
  test('旧名称转为新名称，其他工具不变', () => {
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

  /** 转换之后，完整的 todos 列表仍在原处：修改的是名称，不是内容。 */
  test('args 中的完整列表原样保留', () => {
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
 * 迁移 16 已转换过该文案，此处再次转换，针对迁移 16 执行之后写入的行。
 *
 * 这些行的成因：动作轴与回执文案分两次修改，期间执行过真实轮次，因此留下
 * 「新动作 + 旧文案」的组合（标题为「创建待办」，展开内容为「计划已更新」）。
 */
describe('迁移 18：再次扫描待办回执的旧文案', () => {
  test('新动作与旧文案组合的行：转换文案，动作不变', () => {
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

  /** 幂等：已是新文案的行不应再次修改，其他工具的回执不得有任何改动。 */
  test('新文案与无关回执保持不变', () => {
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
 * 外部工具（MCP / 插件）的动作转为 `call`。
 *
 * 不转换时同一操作在时间线上有两种表述：旧行显示「运行 mcp:github/create_issue」，
 * 调用同一工具的新行记录为「调用」。判据是工具名中的 `__`：只有 `mcp__<server>__<tool>`
 * 与插件的 `<id>__<tool>` 包含它，内置工具名均不包含。
 */
describe('迁移 19：外部工具的动作转为 call', () => {
  const kindOf = (db: Database, id: string) => payloadOf(db, id).action.kind

  test('MCP 与插件的行一律转为 call，与旧值无关', () => {
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
    // 对象名不变：更换的是动作，不是被操作的对象。
    expect(payloadOf(db, 'm_run').action.objectLabel).toBe('mcp:github/create_issue')
  })

  test('内置工具的行保持不变，判据是名称中的双下划线', () => {
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

  /** `json_set` 会为没有 action 的行新增该键，WHERE 必须排除这些行。 */
  test('没有 action 的行不会新增 action', () => {
    const db = dbBefore(19)
    insertStep(db, 'noaction', 'mcp__demo__echo', { kind: 'tool_result', args: { text: 'x' } })
    applyOne(db, 19)
    const row = db
      .query<{ payload: string }, [string]>('SELECT payload FROM steps WHERE id = ?')
      .get('noaction')!
    expect(JSON.parse(row.payload).action).toBeUndefined()
  })
})

/**
 * 外部工具的对象名收敛为「MCP」与「插件」两个类别名。
 *
 * 卡片由动词、对象、目标三层组成；旧行把具体的 `mcp:<server>/<tool>` 填入对象名，
 * 标题与目标因此完全相同。不转换时，回放的旧卡片显示「调用mcp:github/search」，
 * 新卡片显示「调用MCP · mcp:github/search」。
 */
describe('迁移 20：外部工具的对象名收敛为类别名', () => {
  const labelOf = (db: Database, id: string) => payloadOf(db, id).action.objectLabel

  test('MCP 转为「MCP」、插件转为「插件」，目标不变', () => {
    const db = dbBefore(20)
    const rows: [string, string, string, string][] = [
      // id, tool_name, 旧对象名, 期望的新对象名
      ['m_tool', 'mcp__github__search', 'mcp:github/search', 'MCP'],
      ['m_res', 'mcp__demo__fetch_resource', 'mcp:demo/resource', 'MCP'],
      ['p_lines', 'demo_lines__count', '文件', '插件'],
      ['p_probe', 'test_probe__probe', '宿主能力', '插件'],
    ]
    for (const [id, tool, old] of rows) {
      insertStep(db, id, tool, {
        kind: 'tool_result',
        action: { kind: 'call', objectLabel: old, target: 'tgt' },
      })
    }
    applyOne(db, 20)
    for (const [id, , , want] of rows) expect(labelOf(db, id)).toBe(want)
    // 目标层本应是具体名称，本次迁移不做任何改动。
    for (const [id] of rows) expect(payloadOf(db, id).action.target).toBe('tgt')
  })

  test('内置工具的行保持不变，判据是名称中的双下划线', () => {
    const db = dbBefore(20)
    const builtin: [string, string, string][] = [
      ['b_read', 'read_file', '文件'],
      ['b_run', 'run_command', '命令'],
      ['b_todos', 'write_todos', '待办'],
      ['b_res', 'read_resource', '资源'],
    ]
    for (const [id, tool, label] of builtin) {
      insertStep(db, id, tool, {
        kind: 'tool_result',
        action: { kind: 'read', objectLabel: label, target: 'a.ts' },
      })
    }
    applyOne(db, 20)
    for (const [id, , label] of builtin) expect(labelOf(db, id)).toBe(label)
  })

  /** `json_set` 会为没有 action 的行新增该键，WHERE 必须排除这些行。 */
  test('没有 action 的行不会新增 action', () => {
    const db = dbBefore(20)
    insertStep(db, 'noaction', 'mcp__demo__echo', { kind: 'tool_result', args: { text: 'x' } })
    applyOne(db, 20)
    const row = db
      .query<{ payload: string }, [string]>('SELECT payload FROM steps WHERE id = ?')
      .get('noaction')!
    expect(JSON.parse(row.payload).action).toBeUndefined()
  })
})

/**
 * `memory` 门面拆分为三个名称，旧行按行内的 `args.action` 分流。
 *
 * 不转换时，回放历史时模型会看到当前工具表中不存在的名称：账本中的
 * `tool_name` 与 `args` 会被原样重放为一次工具调用。
 */
describe('迁移 21：memory 拆分为 read/write/delete_memory', () => {
  const nameOf = (db: Database, id: string) =>
    db.query<{ n: string }, [string]>('SELECT tool_name AS n FROM steps WHERE id = ?').get(id)!.n
  const argsOf = (db: Database, id: string) =>
    JSON.parse(
      db.query<{ payload: string }, [string]>('SELECT payload FROM steps WHERE id = ?').get(id)!
        .payload,
    ).args as Record<string, unknown>

  test('四个动作分别分流，list 归入读取', () => {
    const db = dbBefore(21)
    const rows: [string, Record<string, unknown>, string][] = [
      // id, 旧 args, 期望的新名称
      ['m_read', { action: 'read', key: '包管理器' }, 'read_memory'],
      ['m_write', { action: 'write', key: '包管理器', content: 'pnpm' }, 'write_memory'],
      ['m_del', { action: 'delete', key: '包管理器' }, 'delete_memory'],
      ['m_list', { action: 'list' }, 'read_memory'],
    ]
    for (const [id, args] of rows) insertStep(db, id, 'memory', { kind: 'tool_result', args })
    applyOne(db, 21)
    for (const [id, , want] of rows) expect(nameOf(db, id)).toBe(want)
  })

  /** 名称修改后该行已不是逐字记录，保留 `action` 只会产生一个当前不合法的调用形状。 */
  test('args.action 被清除，其他参数原样保留', () => {
    const db = dbBefore(21)
    insertStep(db, 'm_write', 'memory', {
      kind: 'tool_result',
      args: { action: 'write', key: '包管理器', content: 'pnpm' },
    })
    applyOne(db, 21)
    expect(argsOf(db, 'm_write')).toEqual({ key: '包管理器', content: 'pnpm' })
  })

  test('缺少 action 或值非法时都归入读取：无法区分动作时取最保守的一项', () => {
    const db = dbBefore(21)
    insertStep(db, 'm_bare', 'memory', { kind: 'tool_result', args: { key: 'k' } })
    insertStep(db, 'm_junk', 'memory', {
      kind: 'tool_result',
      args: { action: '非法值', key: 'k' },
    })
    insertStep(db, 'm_noargs', 'memory', { kind: 'tool_call' })
    applyOne(db, 21)
    expect(nameOf(db, 'm_bare')).toBe('read_memory')
    expect(nameOf(db, 'm_junk')).toBe('read_memory')
    expect(nameOf(db, 'm_noargs')).toBe('read_memory')
    expect(argsOf(db, 'm_junk')).toEqual({ key: 'k' })
  })

  test('其他工具不发生任何改动', () => {
    const db = dbBefore(21)
    insertStep(db, 'other', 'read_file', { kind: 'tool_result', args: { path: 'a.ts' } })
    // 名称中包含 memory 的其他工具行也不能被一并修改：判据是完整名称相等。
    insertStep(db, 'mcp', 'mcp__demo__memory', {
      kind: 'tool_result',
      args: { action: 'write', key: 'k' },
    })
    applyOne(db, 21)
    expect(nameOf(db, 'other')).toBe('read_file')
    expect(argsOf(db, 'other')).toEqual({ path: 'a.ts' })
    expect(nameOf(db, 'mcp')).toBe('mcp__demo__memory')
    expect(argsOf(db, 'mcp')).toEqual({ action: 'write', key: 'k' })
  })
})

describe('迁移 26：重建 steps，思考使用独立的 kind', () => {
  /**
   * 本迁移重建表：SQLite 无法修改 CHECK 约束，只能新建表并迁移数据。
   * 遗漏一列或一批行都不会报错：库仍存在、查询仍能执行，只是历史丢失。
   * 因此断言逐行逐列比对，而不是只比较总数。
   */
  test('每一行每一列原样迁移，索引随之重建', () => {
    const db = dbBefore(26)
    const rows: [string, string, string | null, string | null, string | null][] = [
      ['s1', 'text', null, null, '正文'],
      ['s2', 'tool_action', 'read_file', 'c1', '旧的思考'],
      ['s3', 'compaction', null, null, null],
    ]
    for (const [id, kind, tool, callId, content] of rows) {
      db.query(
        `INSERT INTO steps (id, run_id, seq, kind, tool_name, tool_call_id, content, status, created_at)
         VALUES (?, 'rn', 1, ?, ?, ?, ?, 'done', 7)`,
      ).run(id, kind, tool, callId, content)
    }

    applyOne(db, 26)

    const after = db.query('SELECT * FROM steps ORDER BY id').all() as Record<string, unknown>[]
    expect(after.map((r) => r.id)).toEqual(['s1', 's2', 's3'])
    expect(after.map((r) => r.kind)).toEqual(['text', 'tool_action', 'compaction'])
    // 存量行的思考仍在原处：投影侧的只读回退路径依赖它。
    expect(after[1]!.content).toBe('旧的思考')
    expect(after[1]!.tool_call_id).toBe('c1')
    expect(after[2]!.created_at).toBe(7)

    // 新的 kind 可以写入。
    db.query(
      `INSERT INTO steps (id, run_id, seq, kind, content, status, created_at)
       VALUES ('s4', 'rn', 0, 'thinking', '想了想', 'done', 8)`,
    ).run()
    expect(db.query("SELECT COUNT(*) n FROM steps WHERE kind = 'thinking'").get()).toEqual({ n: 1 })

    // 两个停用值不再接受：保留只会留下误用的可能。
    expect(() =>
      db
        .query(
          `INSERT INTO steps (id, run_id, seq, kind, status, created_at)
           VALUES ('s5', 'rn', 9, 'artifact', 'done', 9)`,
        )
        .run(),
    ).toThrow()

    // 索引必须随之重建，否则删除长会话会退化为全表扫描。
    const idx = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='steps'")
      .all() as { name: string }[]
    expect(idx.map((i) => i.name)).toContain('idx_step_run_seq')
  })
})

describe('迁移 27：工具结果中的图像字节改为数组', () => {
  /** 旧形状：`envelopeResult` 与 `imagesOf` 都只识别 `images`，这两个键对两者都无效。 */
  const oldShape = {
    kind: 'tool_result',
    args: { path: 'shot.png' },
    outcome: {
      status: 'success',
      executed: true,
      message: '读取 shot.png（图片）',
      data: { imageData: 'iVBORw0KGgoAAAANSUhEUg', mime: 'image/png' },
    },
  }

  test('imageData 与 mime 合并为 images 数组，两个旧键一并删除', () => {
    const db = dbBefore(27)
    insertStep(db, 's1', 'read_file', oldShape)
    applyOne(db, 27)

    const data = dataOf(db, 's1')
    expect(data).toEqual({ images: [{ data: 'iVBORw0KGgoAAAANSUhEUg', mime: 'image/png' }] })
    db.close()
  })

  /**
   * `mime` 必须移入数组元素，不能留在 `data` 上。
   *
   * 保留时，`envelopeResult` 移除 `images` 之后 `data` 仍非空，信封中会多出
   * `{"result":{"mime":"image/png"}}`，与新写入的行形状不同：同一次调用在两轮中的
   * 序列化结果不一致，前缀缓存从该处失效，且不会有任何报错。
   */
  test('转换后 data 上只剩 images 一个键', () => {
    const db = dbBefore(27)
    insertStep(db, 's1', 'read_file', oldShape)
    applyOne(db, 27)

    expect(Object.keys(dataOf(db, 's1'))).toEqual(['images'])
    db.close()
  })

  /**
   * 按 JSON 路径识别，不按文本识别。实测库中有十条 `write_file` / `grep` 记录的正文
   * 含有 `imageData` 标识符：按文本筛选会损坏用户的源码。
   */
  test('正文中含有 imageData 一词的记录不受影响', () => {
    const db = dbBefore(27)
    const untouched = {
      kind: 'tool_result',
      args: { path: 'js/textures.js', content: 'const imageData = ctx.getImageData(0, 0)' },
      outcome: { status: 'success', executed: true, message: '写入', data: { bytes: 39 } },
    }
    insertStep(db, 's2', 'write_file', untouched)
    applyOne(db, 27)

    expect(payloadJson(db, 's2')).toEqual(untouched)
    db.close()
  })

  test('已是新形状的行保持不变，重复执行也不变', () => {
    const db = dbBefore(27)
    const newShape = {
      kind: 'tool_result',
      args: { path: 'shot.png' },
      outcome: {
        status: 'success',
        executed: true,
        message: '读取 shot.png（图片）',
        data: { images: [{ data: 'AAA', mime: 'image/png' }] },
      },
    }
    insertStep(db, 's3', 'read_file', newShape)
    insertStep(db, 's1', 'read_file', oldShape)

    applyOne(db, 27)
    const once = dataOf(db, 's1')
    applyOne(db, 27)

    expect(payloadJson(db, 's3')).toEqual(newShape)
    expect(dataOf(db, 's1')).toEqual(once)
    db.close()
  })

  /** 多图形状（MCP 一次可返回多张图）不会出现在旧行中，转换只生成单元素数组。 */
  test('旧行最多只有一张图，转换结果为单元素数组', () => {
    const db = dbBefore(27)
    insertStep(db, 's1', 'read_file', oldShape)
    applyOne(db, 27)

    expect((dataOf(db, 's1') as { images: unknown[] }).images).toHaveLength(1)
    db.close()
  })
})

describe('迁移 40：派发任务卡的节点事实合并为 nodes', () => {
  test('单项派发与图派发的旧键都折叠为每个节点的状态与名称', () => {
    const db = dbBefore(40)
    db.exec(`
INSERT INTO workspaces (id, name, root_path, last_opened_at, created_at) VALUES ('ws', 'w', 'C:/w', 0, 0);
INSERT INTO conversations (id, workspace_id, title, provider, model, created_at, updated_at)
  VALUES ('cv', 'ws', '', 'p', 'm', 0, 0), ('cv_a', 'ws', 'GLM 版', 'p', 'm', 0, 0),
         ('cv_b', 'ws', 'Qwen 版', 'p', 'm', 0, 0), ('cv_c', 'ws', '查资料', 'p', 'm', 0, 0);
INSERT INTO runs (id, conversation_id, workspace_id, model, client_request_id, created_at, status)
  VALUES ('rn', 'cv', 'ws', 'm', 'r', 0, 'done');
`)
    const insert = db.query(
      `INSERT INTO steps (id, run_id, seq, kind, tool_name, payload, status, created_at)
       VALUES (?, 'rn', ?, 'tool_action', ?, ?, ?, 0)`,
    )
    insert.run(
      'st_one',
      1,
      'subagent',
      JSON.stringify({ kind: 'tool_result', args: {}, outcome: {}, childConversationId: 'cv_c' }),
      'success',
    )
    insert.run(
      'st_graph',
      2,
      'workflow',
      JSON.stringify({
        kind: 'tool_result',
        args: {},
        outcome: {},
        children: { 'build.glm': 'cv_a', 'build.qwen': 'cv_b' },
      }),
      'failure',
    )
    insert.run(
      'st_plain',
      3,
      'read_file',
      JSON.stringify({ kind: 'tool_result', args: {} }),
      'success',
    )

    applyOne(db, 40)

    expect(payloadJson(db, 'st_one')).toEqual({
      kind: 'tool_result',
      args: {},
      outcome: {},
      nodes: { child: { phase: 'done', label: '查资料', subagentId: 'cv_c' } },
    })
    expect(payloadJson(db, 'st_graph')).toEqual({
      kind: 'tool_result',
      args: {},
      outcome: {},
      nodes: {
        'build.glm': { phase: 'failed', label: 'GLM 版', subagentId: 'cv_a' },
        'build.qwen': { phase: 'failed', label: 'Qwen 版', subagentId: 'cv_b' },
      },
    })
    expect(payloadJson(db, 'st_plain')).toEqual({ kind: 'tool_result', args: {} })
  })
})

describe('迁移 41：派发任务参数与回执改为按 kind 记录', () => {
  test('节点的 agent 改为 kind 字段，回执改名，续接调用从回执折叠出各节点状态，卡片标题的对象名更新', () => {
    const db = dbBefore(41)
    db.exec(`
INSERT INTO workspaces (id, name, root_path, last_opened_at, created_at) VALUES ('ws', 'w', 'C:/w', 0, 0);
INSERT INTO conversations (id, workspace_id, title, provider, model, created_at, updated_at)
  VALUES ('cv', 'ws', '', 'p', 'm', 0, 0);
INSERT INTO runs (id, conversation_id, workspace_id, model, client_request_id, created_at, status)
  VALUES ('rn', 'cv', 'ws', 'm', 'r', 0, 'done');
`)
    const insert = db.query(
      `INSERT INTO steps (id, run_id, seq, kind, tool_name, payload, status, created_at)
       VALUES (?, 'rn', ?, 'tool_action', ?, ?, ?, 0)`,
    )
    insert.run(
      'st_start',
      1,
      'workflow',
      JSON.stringify({
        kind: 'tool_result',
        args: {
          goal: '目标',
          nodes: [
            {
              id: 'glm',
              kind: 'agent',
              agent: 'racer-glm',
              task: '做',
              model: 'glm',
              provider: 'glm',
            },
            { id: 'tmp', kind: 'agent', agent: 'ad-hoc', task: '也做' },
            { id: 'cx', agent: 'cli:codex', task: '再做' },
            { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['glm', 'tmp', 'cx'] },
          ],
        },
        action: { kind: 'run', objectLabel: '编排', target: '目标' },
        nodes: {
          glm: { phase: 'failed', label: 'GLM', subagentId: 'cv_glm' },
          tmp: { phase: 'failed', label: '临时', subagentId: 'cv_tmp' },
        },
        outcome: {
          status: 'failure',
          executed: true,
          message: '到检查点',
          data: {
            workflowId: 'st_start',
            phase: 'waiting_review',
            checkpointId: 'cp',
            receipts: [
              {
                nodeId: 'glm',
                agent: 'racer-glm',
                label: 'GLM',
                status: 'done',
                output: '稿',
                durationMs: 5,
                conversationId: 'cv_glm',
              },
              {
                nodeId: 'tmp',
                agent: 'ad-hoc',
                label: '临时',
                status: 'failed',
                output: '',
                error: '超时',
                durationMs: 7,
                conversationId: 'cv_tmp',
              },
              {
                nodeId: 'cx',
                agent: 'cli:codex',
                label: 'OpenAI codex',
                status: 'skipped',
                output: '',
                error: '上游节点未成功',
                durationMs: 0,
              },
            ],
          },
        },
      }),
      'failure',
    )
    insert.run(
      'st_review',
      2,
      'workflow',
      JSON.stringify({
        kind: 'tool_result',
        args: {
          workflowId: 'st_start',
          checkpointId: 'cp',
          decision: 'revise',
          note: '返工',
          revisions: [{ nodeId: 'tmp', instruction: '再来' }],
        },
        action: { kind: 'run', objectLabel: '编排', target: 'st_start' },
        outcome: {
          status: 'success',
          executed: true,
          message: '到检查点',
          data: {
            workflowId: 'st_start',
            phase: 'waiting_review',
            checkpointId: 'cp',
            receipts: [
              {
                nodeId: 'tmp',
                agent: 'ad-hoc',
                label: '临时',
                status: 'done',
                output: '新稿',
                durationMs: 9,
                conversationId: 'cv_tmp',
              },
            ],
            review: { checkpointId: 'cp', decision: 'revise', note: '返工' },
          },
        },
      }),
      'success',
    )
    insert.run(
      'st_solo',
      3,
      'subagent',
      JSON.stringify({
        kind: 'tool_result',
        args: { agent: null, task: '看一眼' },
        action: { kind: 'run', objectLabel: '子 agent', target: null },
        nodes: { child: { phase: 'done', label: '看一眼的那个', subagentId: 'cv_solo' } },
        outcome: { status: 'success', executed: true, message: '返回了' },
      }),
      'success',
    )
    insert.run(
      'st_new',
      4,
      'subagent',
      JSON.stringify({
        kind: 'tool_result',
        args: { kind: 'temp', name: '已是新形状', task: '看' },
        action: { kind: 'run', objectLabel: '子 agent', target: '已是新形状' },
        outcome: { status: 'success', executed: true, message: '返回了' },
      }),
      'success',
    )

    applyOne(db, 41)

    const start = payloadJson(db, 'st_start') as {
      args: { nodes: Record<string, unknown>[] }
      action: { objectLabel: string }
      nodes: Record<string, unknown>
      outcome: { data: { receipts: Record<string, unknown>[] } }
    }
    expect(start.args.nodes).toEqual([
      { id: 'glm', kind: 'role', role: 'racer-glm', task: '做', model: 'glm', provider: 'glm' },
      { id: 'tmp', kind: 'temp', name: '临时子 agent', task: '也做' },
      { id: 'cx', kind: 'cli', cli: 'codex', task: '再做' },
      { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['glm', 'tmp', 'cx'] },
    ])
    expect(start.action.objectLabel).toBe('工作流')
    expect(start.outcome.data.receipts).toEqual([
      {
        nodeId: 'glm',
        label: 'GLM',
        status: 'done',
        output: '稿',
        durationMs: 5,
        subagentId: 'cv_glm',
      },
      {
        nodeId: 'tmp',
        label: '临时',
        status: 'failed',
        output: '',
        error: '超时',
        durationMs: 7,
        subagentId: 'cv_tmp',
      },
      {
        nodeId: 'cx',
        label: 'OpenAI codex',
        status: 'skipped',
        output: '',
        error: '上游节点未成功',
        durationMs: 0,
      },
    ])
    // 首次派发的状态由迁移 40 按 step 终态估算，此处以回执为准：glm 实际为 done。
    expect(start.nodes).toEqual({
      glm: { phase: 'done', label: 'GLM', subagentId: 'cv_glm', durationMs: 5 },
      tmp: { phase: 'failed', label: '临时', subagentId: 'cv_tmp', durationMs: 7, error: '超时' },
      cx: { phase: 'skipped', label: 'OpenAI codex', durationMs: 0, error: '上游节点未成功' },
    })
    const review = payloadJson(db, 'st_review') as {
      nodes: Record<string, unknown>
      action: { objectLabel: string }
    }
    expect(review.nodes).toEqual({
      tmp: { phase: 'done', label: '临时', subagentId: 'cv_tmp', durationMs: 9 },
    })
    expect(review.action.objectLabel).toBe('工作流')
    expect(payloadJson(db, 'st_solo')).toMatchObject({
      args: { kind: 'temp', name: '临时子 agent', task: '看一眼' },
      nodes: { child: { phase: 'done', label: '临时子 agent', subagentId: 'cv_solo' } },
    })
    // 已是新形状的行保持不变。
    expect(payloadJson(db, 'st_new')).toMatchObject({
      args: { kind: 'temp', name: '已是新形状', task: '看' },
    })
  })
})

describe('迁移 42：以任务正文为名称的临时子 agent 改回原名', () => {
  test('名称为任务开头的改回「临时子 agent」，模型命名的短名称不变', () => {
    const db = dbBefore(42)
    db.exec(`
INSERT INTO workspaces (id, name, root_path, last_opened_at, created_at) VALUES ('ws', 'w', 'C:/w', 0, 0);
INSERT INTO conversations (id, workspace_id, title, provider, model, created_at, updated_at)
  VALUES ('cv', 'ws', '', 'p', 'm', 0, 0);
INSERT INTO runs (id, conversation_id, workspace_id, model, client_request_id, created_at, status)
  VALUES ('rn', 'cv', 'ws', 'm', 'r', 0, 'done');
`)
    const insert = db.query(
      `INSERT INTO steps (id, run_id, seq, kind, tool_name, payload, status, created_at)
       VALUES (?, 'rn', ?, 'tool_action', 'subagent', ?, 'success', 0)`,
    )
    insert.run(
      'st_task_named',
      1,
      JSON.stringify({
        kind: 'tool_result',
        args: {
          kind: 'temp',
          name: '你是画面评审员。工作区 C:\\w 下有四个…',
          task: '你是画面评审员。工作区 C:\\w 下有四个目录，请逐一评估。',
        },
        nodes: {
          child: {
            phase: 'done',
            label: '你是画面评审员。工作区 C:\\w 下有四个…',
            subagentId: 'cv_x',
          },
        },
        outcome: { status: 'success', executed: true, message: '返回了' },
      }),
    )
    insert.run(
      'st_short_named',
      2,
      JSON.stringify({
        kind: 'tool_result',
        args: { kind: 'temp', name: '画面评审员', task: '你是画面评审员，请逐一评估。' },
        nodes: { child: { phase: 'done', label: '画面评审员', subagentId: 'cv_y' } },
        outcome: { status: 'success', executed: true, message: '返回了' },
      }),
    )

    applyOne(db, 42)

    expect(payloadJson(db, 'st_task_named')).toMatchObject({
      args: { kind: 'temp', name: '临时子 agent' },
      nodes: { child: { label: '临时子 agent', subagentId: 'cv_x' } },
    })
    expect(payloadJson(db, 'st_short_named')).toMatchObject({
      args: { kind: 'temp', name: '画面评审员' },
      nodes: { child: { label: '画面评审员' } },
    })
  })
})

describe('迁移 43：子 agent 的名称只保留一份', () => {
  test('复制而来的标题与「临时子 agent」替换为目标名或模型 id', () => {
    const db = dbBefore(43)
    const task = '你是资深网页游戏开发者。任务是从零开发…'
    db.exec(`
INSERT INTO workspaces (id, name, root_path, last_opened_at, created_at) VALUES ('ws', 'w', 'C:/w', 0, 0);
INSERT INTO conversations (id, workspace_id, title, provider, model, created_at, updated_at)
  VALUES ('cv', 'ws', '', 'p', 'm', 0, 0),
         ('cv_role', 'ws', '${task}', 'p', 'glm', 0, 0),
         ('cv_tmp', 'ws', '${task}', 'p', 'vision-x', 0, 0),
         ('cv_new', 'ws', '画面评审', 'p', 'm', 0, 0);
INSERT INTO runs (id, conversation_id, workspace_id, model, client_request_id, created_at, status)
  VALUES ('rn', 'cv', 'ws', 'm', 'r', 0, 'done');
`)
    const insert = db.query(
      `INSERT INTO steps (id, run_id, seq, kind, tool_name, payload, status, created_at)
       VALUES (?, 'rn', ?, 'tool_action', ?, ?, 'success', ?)`,
    )
    insert.run(
      'st_start',
      1,
      'workflow',
      JSON.stringify({
        kind: 'tool_result',
        args: { goal: '目标', nodes: [{ id: 'a', kind: 'role', role: 'racer', task: '做' }] },
        nodes: { a: { phase: 'failed', label: task, subagentId: 'cv_role' } },
        outcome: { status: 'failure', executed: true, message: '中断' },
      }),
      1,
    )
    insert.run(
      'st_review',
      2,
      'workflow',
      JSON.stringify({
        kind: 'tool_result',
        args: {
          workflowId: 'st_start',
          checkpointId: 'cp',
          decision: 'revise',
          note: '',
          revisions: [],
        },
        nodes: { a: { phase: 'done', label: '赛车组', subagentId: 'cv_role', durationMs: 3 } },
        outcome: { status: 'success', executed: true, message: '到检查点' },
      }),
      2,
    )
    insert.run(
      'st_tmp',
      3,
      'subagent',
      JSON.stringify({
        kind: 'tool_result',
        args: { kind: 'temp', name: '临时子 agent', task: '看图' },
        nodes: { child: { phase: 'done', label: '临时子 agent', subagentId: 'cv_tmp' } },
        outcome: { status: 'success', executed: true, message: '返回了' },
      }),
      3,
    )
    insert.run(
      'st_new',
      4,
      'subagent',
      JSON.stringify({
        kind: 'tool_result',
        args: { kind: 'temp', name: '画面评审', task: '看图' },
        nodes: { child: { phase: 'done', label: '画面评审', subagentId: 'cv_new' } },
        outcome: { status: 'success', executed: true, message: '返回了' },
      }),
      4,
    )

    applyOne(db, 43)

    expect(payloadJson(db, 'st_start')).toMatchObject({ nodes: { a: { label: 'racer' } } })
    expect(payloadJson(db, 'st_review')).toMatchObject({ nodes: { a: { label: '赛车组' } } })
    expect(payloadJson(db, 'st_tmp')).toMatchObject({
      args: { kind: 'temp', name: 'vision-x' },
      nodes: { child: { label: 'vision-x' } },
    })
    expect(payloadJson(db, 'st_new')).toMatchObject({ args: { name: '画面评审' } })
  })
})

describe('迁移 44：临时子 agent 的节点名统一为模型名', () => {
  test('临时子 agent 改为模型名，角色不变', () => {
    const db = dbBefore(44)
    db.exec(`
INSERT INTO workspaces (id, name, root_path, last_opened_at, created_at) VALUES ('ws', 'w', 'C:/w', 0, 0);
INSERT INTO conversations (id, workspace_id, title, provider, model, source, created_at, updated_at)
  VALUES ('cv', 'ws', '', 'p', 'm', NULL, 0, 0),
         ('cv_tmp', 'ws', 'GLM 车组', 'p', 'glm-5.3-flash', 'temp', 0, 0),
         ('cv_role', 'ws', '审查员', 'p', 'm', 'role', 0, 0);
INSERT INTO runs (id, conversation_id, workspace_id, model, client_request_id, created_at, status)
  VALUES ('rn', 'cv', 'ws', 'm', 'r', 0, 'done');
`)
    db.query(
      `INSERT INTO steps (id, run_id, seq, kind, tool_name, payload, status, created_at)
       VALUES ('st', 'rn', 1, 'tool_action', 'workflow', ?, 'success', 0)`,
    ).run(
      JSON.stringify({
        kind: 'tool_result',
        args: {},
        nodes: {
          a: { phase: 'done', label: 'GLM 车组', subagentId: 'cv_tmp' },
          b: { phase: 'done', label: '审查员', subagentId: 'cv_role' },
        },
        outcome: {},
      }),
    )

    applyOne(db, 44)

    expect(payloadJson(db, 'st')).toMatchObject({
      nodes: {
        a: { label: 'glm-5.3-flash', subagentId: 'cv_tmp' },
        b: { label: '审查员', subagentId: 'cv_role' },
      },
    })
  })
})

describe('迁移 45：单项派发节点的耗时从 step 复制', () => {
  test('节点没有耗时时复制 step 的耗时，已有的不变', () => {
    const db = dbBefore(45)
    db.exec(`
INSERT INTO workspaces (id, name, root_path, last_opened_at, created_at) VALUES ('ws', 'w', 'C:/w', 0, 0);
INSERT INTO conversations (id, workspace_id, title, provider, model, created_at, updated_at)
  VALUES ('cv', 'ws', '', 'p', 'm', 0, 0);
INSERT INTO runs (id, conversation_id, workspace_id, model, client_request_id, created_at, status)
  VALUES ('rn', 'cv', 'ws', 'm', 'r', 0, 'done');
`)
    const insert = db.query(
      `INSERT INTO steps (id, run_id, seq, kind, tool_name, payload, status, duration_ms, created_at)
       VALUES (?, 'rn', ?, 'tool_action', 'subagent', ?, 'success', ?, 0)`,
    )
    insert.run(
      'st_old',
      1,
      JSON.stringify({
        kind: 'tool_result',
        args: { kind: 'temp', name: 'x', task: '看' },
        nodes: { child: { phase: 'done', label: 'm', subagentId: 'cv_x' } },
        outcome: {},
      }),
      45918,
    )
    insert.run(
      'st_new',
      2,
      JSON.stringify({
        kind: 'tool_result',
        args: { kind: 'temp', name: 'y', task: '看' },
        nodes: { child: { phase: 'done', label: 'm', subagentId: 'cv_y', durationMs: 5 } },
        outcome: {},
      }),
      7,
    )

    applyOne(db, 45)

    expect(payloadJson(db, 'st_old')).toMatchObject({ nodes: { child: { durationMs: 45918 } } })
    expect(payloadJson(db, 'st_new')).toMatchObject({ nodes: { child: { durationMs: 5 } } })
  })
})

describe('迁移 46：临时子 agent 的节点名恢复为其名称', () => {
  test('临时子 agent 的节点名与单项派发参数的 name 都改为子会话标题，角色不变', () => {
    const db = dbBefore(46)
    db.exec(`
INSERT INTO workspaces (id, name, root_path, last_opened_at, created_at) VALUES ('ws', 'w', 'C:/w', 0, 0);
INSERT INTO conversations (id, workspace_id, title, provider, model, source, created_at, updated_at)
  VALUES ('cv', 'ws', '', 'p', 'm', NULL, 0, 0),
         ('cv_tmp', 'ws', '画面评审员', 'p', 'vision-x', 'temp', 0, 0),
         ('cv_role', 'ws', '审查员', 'p', 'm', 'role', 0, 0);
INSERT INTO runs (id, conversation_id, workspace_id, model, client_request_id, created_at, status)
  VALUES ('rn', 'cv', 'ws', 'm', 'r', 0, 'done');
`)
    const insert = db.query(
      `INSERT INTO steps (id, run_id, seq, kind, tool_name, payload, status, created_at)
       VALUES (?, 'rn', ?, 'tool_action', ?, ?, 'success', 0)`,
    )
    insert.run(
      'st_solo',
      1,
      'subagent',
      JSON.stringify({
        kind: 'tool_result',
        args: { kind: 'temp', name: 'vision-x', task: '看图' },
        nodes: { child: { phase: 'done', label: 'vision-x', subagentId: 'cv_tmp' } },
        outcome: {},
      }),
    )
    insert.run(
      'st_graph',
      2,
      'workflow',
      JSON.stringify({
        kind: 'tool_result',
        args: {},
        nodes: {
          a: { phase: 'done', label: 'vision-x', subagentId: 'cv_tmp' },
          b: { phase: 'done', label: '审查员', subagentId: 'cv_role' },
        },
        outcome: {},
      }),
    )

    applyOne(db, 46)

    expect(payloadJson(db, 'st_solo')).toMatchObject({
      args: { kind: 'temp', name: '画面评审员' },
      nodes: { child: { label: '画面评审员' } },
    })
    expect(payloadJson(db, 'st_graph')).toMatchObject({
      nodes: { a: { label: '画面评审员' }, b: { label: '审查员' } },
    })
  })
})

/**
 * 行类型是 DDL 的镜像，本测试是使两者保持一致的约束。
 *
 * `schema.ts` 中 `WorkspaceRow` 等接口没有任何检查强制它们与表结构一致：迁移新增一列
 * 而接口未同步时不会报错，映射函数读取不存在的列，
 * 取得 `undefined` 并放入领域对象。因此列名单独列出一份（`ROW_COLUMNS`，与接口同处同步修改），
 * 在此处与真实数据库比对。
 *
 * 比较的是集合而不是顺序：`SELECT *` 按名称取值，列的物理顺序变化不影响任何调用方。
 */
describe('行类型与 DDL 对齐', () => {
  test('每张表声明的列名与迁移执行完毕后的真实列名一致', () => {
    const db = new Database(':memory:')
    for (const m of MIGRATIONS) executeMigration(db, m)

    for (const [table, declared] of Object.entries(ROW_COLUMNS)) {
      const actual = db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name)
      expect({ [table]: [...actual].sort() }).toEqual({ [table]: [...declared].sort() })
    }
    db.close()
  })
})

describe('迁移 35：诊断列结构收敛', () => {
  test('迁移 34 已被其他历史结构占用时仍能启动并执行恢复查询', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migration-35-'))
    const path = join(dir, 'qywork.sqlite3')
    try {
      const raw = new Database(path, { create: true })
      raw.exec(
        'CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
      )
      const insert = raw.query('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)')
      for (const migration of MIGRATIONS) {
        if (migration.id >= 34) break
        executeMigration(raw, migration)
        insert.run(migration.id, migration.name, 0)
      }
      insert.run(34, 'provider_route_usage_index', 0)
      raw.close()

      const store = new Store({ path })
      try {
        expect(recoverStaleRuns(store)).toEqual({ recovered: 0, ambiguous: 0, heldByOthers: 0 })
        expect(
          store.db
            .query<{ name: string }, [number]>('SELECT name FROM _migrations WHERE id = ?')
            .get(34),
        ).toEqual({ name: 'provider_route_usage_index' })
        expect(
          store.db
            .query<{ name: string }, [number]>('SELECT name FROM _migrations WHERE id = ?')
            .get(35),
        ).toEqual({ name: 'ensure_execution_failure_diagnostics' })
      } finally {
        store.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('迁移 36：运行失败文案收敛', () => {
  test('重复超时只合并相同读数，废弃步数状态从账本移除', () => {
    const db = dbBefore(36)
    const insert = db.query(
      `INSERT INTO runs
       (id, conversation_id, workspace_id, model, client_request_id, status,
        stop_reason, error_message, created_at)
       VALUES (?, 'cv', 'ws', 'model', ?, 'failed', ?, ?, 0)`,
    )
    insert.run(
      'r_same',
      'req_same',
      'provider_error',
      '连接超时：60 秒内没有收到响应，60 秒未收到响应，已重发 5 次',
    )
    insert.run(
      'r_different',
      'req_different',
      'provider_error',
      '连接超时：60 秒内没有收到响应，30 秒未收到响应',
    )
    insert.run('r_steps', 'req_steps', 'max_steps', '旧版本：已达步数上限')
    insert.run('r_steps_detail', 'req_steps_detail', 'max_steps', '另一个真实错误')

    applyOne(db, 36)

    const rows = db
      .query<{ id: string; stop_reason: string | null; error_message: string | null }, []>(
        `SELECT id, stop_reason, error_message FROM runs ORDER BY id`,
      )
      .all()
    expect(rows).toEqual([
      {
        id: 'r_different',
        stop_reason: 'provider_error',
        error_message: '连接超时：60 秒内没有收到响应，30 秒未收到响应',
      },
      {
        id: 'r_same',
        stop_reason: 'provider_error',
        error_message: '连接超时，60 秒未收到响应，已重发 5 次',
      },
      { id: 'r_steps', stop_reason: null, error_message: null },
      { id: 'r_steps_detail', stop_reason: null, error_message: '另一个真实错误' },
    ])
    db.close()
  })
})

describe('迁移 37：运行记录收敛为唯一结构', () => {
  test('旧 step 一次迁移为 child、workflow、compaction、batch 与独立思考', () => {
    const db = dbBefore(37)
    db.query(
      `INSERT INTO conversations
       (id, workspace_id, title, provider, model, compaction_manifest, created_at, updated_at)
       VALUES ('cv', 'ws', '', '', 'm', ?, 0, 0)`,
    ).run(
      JSON.stringify({
        revision: 1,
        compactedThroughMessageId: null,
        compactedThroughStep: 'rn:000000003',
        condensedThrough: { messageId: 'msg', step: 'rn:000000002' },
        compactedMessageCount: 0,
        summary: '',
        facts: { filesTouched: [], openItems: [], userConstraints: [], resources: [] },
        createdAt: 0,
      }),
    )
    db.exec(`
INSERT INTO runs
  (id, conversation_id, workspace_id, model, client_request_id, status, step_count, created_at)
VALUES ('rn', 'cv', 'ws', 'm', 'req', 'done', 3, 0);
`)
    const insert = db.query(
      `INSERT INTO steps
       (id, run_id, seq, kind, tool_name, content, payload, status, created_at)
       VALUES (?, 'rn', ?, ?, ?, ?, ?, ?, 0)`,
    )
    insert.run(
      'st_child',
      1,
      'tool_action',
      'subagent',
      '先分析',
      JSON.stringify({
        kind: 'tool_result',
        args: {},
        outcome: {
          status: 'success',
          executed: true,
          message: 'ok',
          data: { conversationId: 'cv_child' },
        },
      }),
      'success',
    )
    insert.run(
      'st_workflow',
      2,
      'tool_action',
      'workflow',
      null,
      JSON.stringify({
        kind: 'tool_result',
        args: { goal: '做完', nodes: [{ id: 'a', agent: 'builder', task: '实现' }] },
        outcome: {
          status: 'success',
          executed: true,
          message: 'done',
          data: {
            nodes: [
              {
                nodeId: 'a',
                agent: 'builder',
                status: 'done',
                output: '完成',
                durationMs: 12,
                conversationId: 'cv_worker',
              },
            ],
          },
        },
      }),
      'success',
    )
    insert.run(
      'st_compact',
      3,
      'compaction',
      null,
      null,
      JSON.stringify({ kind: 'compaction', manifestRevision: 1, compactedMessages: 2 }),
      'done',
    )
    db.query(
      `INSERT INTO provider_requests
       (id, run_id, turn_index, provider_name, provider_kind, model, status,
        measured_input_tokens, sent_categories, payload_hash, created_at)
       VALUES ('pr', 'rn', 0, 'relay', 'openai_chat_completions', 'm', 'received',
               1, '{}', 'hash', 0)`,
    ).run()

    applyOne(db, 37)

    expect(payloadJson(db, 'st_child')).toMatchObject({ childConversationId: 'cv_child' })
    const workflow = payloadJson(db, 'st_workflow') as {
      outcome: { data: Record<string, unknown> }
    }
    expect(workflow.outcome.data).toMatchObject({
      workflowId: 'st_workflow',
      phase: 'completed',
      receipts: [
        {
          nodeId: 'a',
          agent: 'builder',
          label: 'builder',
          status: 'done',
          output: '完成',
          durationMs: 12,
          conversationId: 'cv_worker',
        },
      ],
    })
    expect(workflow.outcome.data.nodes).toBeUndefined()
    expect(payloadJson(db, 'st_compact')).toMatchObject({ phase: 'done' })

    const steps = db
      .query<
        {
          id: string
          seq: number
          kind: string
          content: string | null
          provider_batch_id: string | null
        },
        []
      >(
        `SELECT id, seq, kind, content, provider_batch_id
         FROM steps ORDER BY seq`,
      )
      .all()
    expect(steps).toEqual([
      {
        id: 'st_migrated_thinking_st_child',
        seq: 2,
        kind: 'thinking',
        content: '先分析',
        provider_batch_id: null,
      },
      {
        id: 'st_child',
        seq: 3,
        kind: 'tool_action',
        content: null,
        provider_batch_id: 'migrated:st_child',
      },
      {
        id: 'st_workflow',
        seq: 5,
        kind: 'tool_action',
        content: null,
        provider_batch_id: 'migrated:st_workflow',
      },
      {
        id: 'st_compact',
        seq: 7,
        kind: 'compaction',
        content: null,
        provider_batch_id: null,
      },
    ])
    const manifest = db
      .query<{ compaction_manifest: string }, []>(
        `SELECT compaction_manifest FROM conversations WHERE id = 'cv'`,
      )
      .get()!
    expect(JSON.parse(manifest.compaction_manifest)).toMatchObject({
      compactedThroughStep: 'rn:000000007',
      condensedThrough: { step: 'rn:000000005' },
    })
    expect(
      db
        .query<{ provider: string }, []>(`SELECT provider FROM conversations WHERE id = 'cv'`)
        .get(),
    ).toEqual({ provider: 'relay' })
    expect(
      db.query<{ step_count: number }, []>(`SELECT step_count FROM runs WHERE id = 'rn'`).get(),
    ).toEqual({
      step_count: 4,
    })
    db.close()
  })

  test('接口证据冲突时不推测 provider', () => {
    const db = dbBefore(37)
    db.exec(`
INSERT INTO conversations
  (id, workspace_id, title, provider, model, created_at, updated_at)
VALUES ('cv', 'ws', '', '', 'm', 0, 0);
INSERT INTO runs
  (id, conversation_id, workspace_id, model, client_request_id, status, created_at)
VALUES ('rn', 'cv', 'ws', 'm', 'req', 'done', 0);
INSERT INTO provider_requests
  (id, run_id, turn_index, provider_name, provider_kind, model, status,
   measured_input_tokens, sent_categories, payload_hash, created_at)
VALUES
  ('pr1', 'rn', 0, 'relay-a', 'openai_chat_completions', 'm', 'received', 1, '{}', 'a', 0),
  ('pr2', 'rn', 1, 'relay-b', 'openai_chat_completions', 'm', 'received', 1, '{}', 'b', 0);
`)

    applyOne(db, 37)

    expect(
      db
        .query<{ provider: string }, []>(`SELECT provider FROM conversations WHERE id = 'cv'`)
        .get(),
    ).toEqual({ provider: '' })
    db.close()
  })
})

describe('迁移 51：子会话轮次的派发来源', () => {
  test('回填为本轮之前最近一次派发该子会话的节点；此前没有派发记录的留空', () => {
    const db = dbBefore(51)
    db.exec(`
INSERT INTO conversations
  (id, workspace_id, title, provider, model, created_at, updated_at, parent_conversation_id)
VALUES ('cv', 'ws', '', 'p', 'm', 0, 0, NULL),
       ('cc', 'ws', '写手', 'p', 'm', 0, 0, 'cv');
INSERT INTO runs
  (id, conversation_id, workspace_id, model, client_request_id, status, created_at)
VALUES ('rn', 'cv', 'ws', 'm', 'req', 'done', 0),
       ('c0', 'cc', 'ws', 'm', 'c0', 'done', 50),
       ('c1', 'cc', 'ws', 'm', 'c1', 'done', 150),
       ('c2', 'cc', 'ws', 'm', 'c2', 'done', 350);
INSERT INTO steps (id, run_id, seq, kind, tool_name, payload, status, created_at)
VALUES ('st1', 'rn', 1, 'tool_action', 'workflow',
        '{"kind":"tool_result","args":{},"outcome":{"status":"success","executed":true,"message":""},"nodes":{"n1":{"phase":"done","label":"写手","subagentId":"cc"}}}',
        'success', 100),
       ('st2', 'rn', 2, 'tool_action', 'subagent',
        '{"kind":"tool_result","args":{},"outcome":{"status":"success","executed":true,"message":""},"nodes":{"child":{"phase":"done","label":"写手","subagentId":"cc"}}}',
        'success', 300);
`)

    applyOne(db, 51)

    const rows = db
      .query<{ id: string; dispatch_step_id: string | null; dispatch_node_id: string | null }, []>(
        'SELECT id, dispatch_step_id, dispatch_node_id FROM runs ORDER BY id',
      )
      .all()
    expect(rows).toEqual([
      { id: 'c0', dispatch_step_id: null, dispatch_node_id: null },
      { id: 'c1', dispatch_step_id: 'st1', dispatch_node_id: 'n1' },
      { id: 'c2', dispatch_step_id: 'st2', dispatch_node_id: 'child' },
      { id: 'rn', dispatch_step_id: null, dispatch_node_id: null },
    ])
    db.close()
  })
})

describe('迁移 52：清除观察器记录在隐藏目录下的路径', () => {
  test('只清除没有行数的隐藏目录条目；工具的精确明细与隐藏文件不变；派发任务卡的节点按路径清除', () => {
    const db = dbBefore(52)
    db.exec(`
INSERT INTO runs
  (id, conversation_id, workspace_id, model, client_request_id, status, created_at)
VALUES ('rn', 'cv', 'ws', 'm', 'req', 'done', 0);
INSERT INTO steps (id, run_id, seq, kind, tool_name, payload, status, created_at)
VALUES ('sh', 'rn', 1, 'tool_action', 'run_command',
        '{"kind":"tool_result","args":{"command":"x"},"outcome":{"status":"success","executed":true,"message":"",
          "fileChanges":[{"path":".chk/prof/Local State","changeType":"modified"},
                         {"path":"src/a.ts","changeType":"modified"},
                         {"path":".env","changeType":"created"},
                         {"path":"a/.cache/x","changeType":"created"}]}}',
        'success', 1),
       ('mem', 'rn', 2, 'tool_action', 'write_memory',
        '{"kind":"tool_result","args":{},"outcome":{"status":"success","executed":true,"message":"",
          "fileChanges":[{"path":".agents/memory/x.md","changeType":"created","additions":3,"deletions":0}]}}',
        'success', 2),
       ('wf', 'rn', 3, 'tool_action', 'workflow',
        '{"kind":"tool_result","args":{},"outcome":{"status":"success","executed":true,"message":""},
          "nodes":{"n1":{"phase":"done","label":"codex","fileChanges":[{"path":".chk/y","changeType":"created"},{"path":"out/z.html","changeType":"created"}]},
                   "n2":{"phase":"done","label":"写手","subagentId":"cc"}}}',
        'success', 3);
`)

    applyOne(db, 52)

    const paths = (id: string, path: string) =>
      db
        .query<{ v: string | null }, [string]>(
          `SELECT json_extract(payload, '${path}') AS v FROM steps WHERE id = ?`,
        )
        .get(id)?.v
    expect(
      JSON.parse(paths('sh', '$.outcome.fileChanges') ?? '[]').map((c: { path: string }) => c.path),
    ).toEqual(['src/a.ts', '.env'])
    expect(JSON.parse(paths('mem', '$.outcome.fileChanges') ?? '[]')).toEqual([
      { path: '.agents/memory/x.md', changeType: 'created', additions: 3, deletions: 0 },
    ])
    expect(
      JSON.parse(paths('wf', '$.nodes.n1.fileChanges') ?? '[]').map(
        (c: { path: string }) => c.path,
      ),
    ).toEqual(['out/z.html'])
    expect(JSON.parse(paths('wf', '$.nodes.n2') ?? '{}')).toEqual({
      phase: 'done',
      label: '写手',
      subagentId: 'cc',
    })
    db.close()
  })
})

describe('迁移 53：清除观察器记录在以点开头的路径下的条目', () => {
  test('隐藏文件与被删除的隐藏目录本身也清除；工具的精确明细不变', () => {
    const db = dbBefore(53)
    db.exec(`
INSERT INTO runs
  (id, conversation_id, workspace_id, model, client_request_id, status, created_at)
VALUES ('rn', 'cv', 'ws', 'm', 'req', 'done', 0);
INSERT INTO steps (id, run_id, seq, kind, tool_name, payload, status, created_at)
VALUES ('sh', 'rn', 1, 'tool_action', 'run_command',
        '{"kind":"tool_result","args":{"command":"x"},"outcome":{"status":"success","executed":true,"message":"",
          "fileChanges":[{"path":".chk","changeType":"deleted"},
                         {"path":".tmp-verify","changeType":"created"},
                         {"path":"src/a.ts","changeType":"modified"},
                         {"path":"a/.env","changeType":"created"}]}}',
        'success', 1),
       ('mem', 'rn', 2, 'tool_action', 'write_memory',
        '{"kind":"tool_result","args":{},"outcome":{"status":"success","executed":true,"message":"",
          "fileChanges":[{"path":".agents/memory/x.md","changeType":"created","additions":3,"deletions":0}]}}',
        'success', 2);
`)

    applyOne(db, 53)

    const paths = (id: string) =>
      db
        .query<{ v: string | null }, [string]>(
          `SELECT json_extract(payload, '$.outcome.fileChanges') AS v FROM steps WHERE id = ?`,
        )
        .get(id)?.v
    expect(JSON.parse(paths('sh') ?? '[]').map((c: { path: string }) => c.path)).toEqual([
      'src/a.ts',
    ])
    expect(JSON.parse(paths('mem') ?? '[]').map((c: { path: string }) => c.path)).toEqual([
      '.agents/memory/x.md',
    ])
    db.close()
  })
})

describe('迁移 55：工作区根路径按分隔符归一', () => {
  test('两种写法合并为最早的一行，会话与账目改为指向该行，任务的根路径随之修改', () => {
    const db = dbBefore(55)
    db.exec(`
INSERT INTO workspaces (id, name, root_path, last_opened_at, created_at)
VALUES ('ws_old', '正斜杠', 'C:/ws/demo', 10, 10),
       ('ws_new', '反斜杠', 'C:\\ws\\demo', 20, 20),
       ('ws_only', '只有一种写法', 'C:/ws/solo', 30, 30),
       ('ws_posix', 'POSIX', '/srv/ws', 40, 40);
INSERT INTO conversations
  (id, workspace_id, title, model, cache_generation, created_at, updated_at, provider)
VALUES ('cv_a', 'ws_old', 'A', 'm', 0, 1, 1, 'p'),
       ('cv_b', 'ws_new', 'B', 'm', 0, 2, 2, 'p');
INSERT INTO runs
  (id, conversation_id, workspace_id, model, client_request_id, status,
   input_tokens, output_tokens, reasoning_tokens, cost, usage_turns, step_count, created_at, currency)
VALUES ('rn_b', 'cv_b', 'ws_new', 'm', 'req', 'done', 0, 0, 0, 0, '[]', 0, 2, 'USD');
INSERT INTO permission_rules (id, workspace_id, scope, effect, created_at)
VALUES ('pr_old', 'ws_old', 'run_command:git', 'allow', 1),
       ('pr_dup', 'ws_new', 'run_command:git', 'deny', 2),
       ('pr_more', 'ws_new', 'write_file:src', 'allow', 3);
INSERT INTO permission_audit (id, workspace_id, action, scope, granted, resolved_by, created_at)
VALUES ('pa_b', 'ws_new', 'run_command', 'run_command:git', 1, 'user', 2);
INSERT INTO usage_ledger
  (id, kind, workspace_id, model, provider, input_tokens, output_tokens, reasoning_tokens,
   cost, occurred_at, currency)
VALUES ('ul_b', 'run', 'ws_new', 'm', 'p', 1, 2, 0, 0.5, 2, 'USD');
INSERT INTO schedules
  (id, workspace_root, title, prompt, kind, every_minutes, enabled, created_at)
VALUES ('sch_a', 'C:/ws/demo', '日报', 'p', 'interval', 30, 1, 1),
       ('sch_p', '/srv/ws', 'POSIX 的', 'p', 'interval', 30, 1, 2);
`)

    applyOne(db, 55)

    expect(
      db.query<{ id: string; root_path: string }, []>('SELECT id, root_path FROM workspaces').all(),
    ).toEqual([
      { id: 'ws_old', root_path: 'C:\\ws\\demo' },
      { id: 'ws_only', root_path: 'C:\\ws\\solo' },
      { id: 'ws_posix', root_path: '/srv/ws' },
    ])

    const owner = (id: string) =>
      db
        .query<{ workspace_id: string }, [string]>(
          'SELECT workspace_id FROM conversations WHERE id = ?',
        )
        .get(id)?.workspace_id
    expect([owner('cv_a'), owner('cv_b')]).toEqual(['ws_old', 'ws_old'])
    expect(db.query<{ workspace_id: string }, []>('SELECT workspace_id FROM runs').all()).toEqual([
      { workspace_id: 'ws_old' },
    ])
    expect(
      db.query<{ workspace_id: string }, []>('SELECT workspace_id FROM permission_audit').all(),
    ).toEqual([{ workspace_id: 'ws_old' }])
    expect(
      db.query<{ workspace_id: string }, []>('SELECT workspace_id FROM usage_ledger').all(),
    ).toEqual([{ workspace_id: 'ws_old' }])

    // 两个工作区都有同一 scope 的记录时，保留最早工作区的记录；不同 scope 的记录随之修改归属。
    expect(
      db
        .query<{ id: string; workspace_id: string; effect: string }, []>(
          'SELECT id, workspace_id, effect FROM permission_rules ORDER BY id',
        )
        .all(),
    ).toEqual([
      { id: 'pr_more', workspace_id: 'ws_old', effect: 'allow' },
      { id: 'pr_old', workspace_id: 'ws_old', effect: 'allow' },
    ])

    expect(
      db
        .query<{ id: string; workspace_root: string }, []>(
          'SELECT id, workspace_root FROM schedules ORDER BY id',
        )
        .all(),
    ).toEqual([
      { id: 'sch_a', workspace_root: 'C:\\ws\\demo' },
      { id: 'sch_p', workspace_root: '/srv/ws' },
    ])
    db.close()
  })
})

/** 对象名已修改，已写入磁盘的 step 不转换时，同一会话中会同时显示新旧两个名称。 */
describe('迁移 56：控制类工具的对象名', () => {
  test('两组工具自身的 step 随之转换，其他工具的同名对象名不变', () => {
    const db = dbBefore(56)
    insertStep(db, 's_desk', 'desktop_observe', {
      kind: 'tool_result',
      action: { kind: 'read', objectLabel: '电脑操作', target: 'dw_3' },
    })
    insertStep(db, 's_desk_bare', 'desktop_windows', {
      kind: 'tool_result',
      action: { kind: 'query', objectLabel: '电脑操作', target: '电脑操作' },
    })
    insertStep(db, 's_web', 'browser_act', {
      kind: 'tool_result',
      action: { kind: 'call', objectLabel: '浏览器', target: null },
    })
    insertStep(db, 's_plugin', 'plugin_x', {
      kind: 'tool_result',
      action: { kind: 'call', objectLabel: '浏览器', target: null },
    })
    applyOne(db, 56)
    expect(payloadOf(db, 's_desk').action).toEqual({
      kind: 'read',
      objectLabel: '电脑控制',
      target: 'dw_3',
    })
    expect(payloadOf(db, 's_desk_bare').action).toEqual({
      kind: 'query',
      objectLabel: '电脑控制',
      target: '电脑控制',
    })
    expect(payloadOf(db, 's_web').action.objectLabel).toBe('浏览器控制')
    expect(payloadOf(db, 's_plugin').action.objectLabel).toBe('浏览器')
    db.close()
  })
})

/**
 * 列改名之后原值即为绑定：已有行指向最近一次触发创建的会话，此后的触发发送到该会话。
 * 值被清空时，每条存量任务的下一次触发都会新建一条会话。
 */
describe('迁移 57：定时任务绑定会话', () => {
  test('原值保留，外键与索引随之改名，新列默认为 0', () => {
    const db = dbBefore(57)
    db.exec(`
INSERT INTO workspaces (id, name, root_path, last_opened_at, created_at)
VALUES ('ws_1', 'W', 'C:\\ws', 10, 10);
INSERT INTO conversations
  (id, workspace_id, title, model, cache_generation, created_at, updated_at, provider)
VALUES ('cv_bound', 'ws_1', '上次那条', 'm', 0, 1, 1, 'p');
INSERT INTO schedules
  (id, workspace_root, title, prompt, kind, every_minutes, enabled, created_at,
   last_run_at, last_run_conversation_id)
VALUES ('sch_bound', 'C:\\ws', '日报', 'p', 'interval', 30, 1, 1, 222, 'cv_bound'),
       ('sch_never', 'C:\\ws', '没跑过', 'p', 'interval', 30, 1, 2, NULL, NULL);
`)

    applyOne(db, 57)

    expect(
      db
        .query<
          {
            id: string
            conversation_id: string | null
            new_conversation: number
            last_run_at: number | null
          },
          []
        >('SELECT id, conversation_id, new_conversation, last_run_at FROM schedules ORDER BY id')
        .all(),
    ).toEqual([
      { id: 'sch_bound', conversation_id: 'cv_bound', new_conversation: 0, last_run_at: 222 },
      { id: 'sch_never', conversation_id: null, new_conversation: 0, last_run_at: null },
    ])

    // 索引按新名称重建，旧名称不再存在。主键的自动索引没有 SQL，不在此列表中。
    expect(
      db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND tbl_name = 'schedules' AND sql IS NOT NULL ORDER BY name`,
        )
        .all()
        .map((r) => r.name),
    ).toEqual(['idx_schedules_conversation', 'idx_schedules_workspace'])

    // `ON DELETE SET NULL` 随列名迁移：删除会话之后置空，触发游标保留。
    db.exec('PRAGMA foreign_keys = ON')
    db.query('DELETE FROM conversations WHERE id = ?').run('cv_bound')
    expect(
      db
        .query<{ conversation_id: string | null; last_run_at: number | null }, [string]>(
          'SELECT conversation_id, last_run_at FROM schedules WHERE id = ?',
        )
        .get('sch_bound'),
    ).toEqual({ conversation_id: null, last_run_at: 222 })
    db.close()
  })
})

describe('迁移 59：请求记录本次输入携带的图片批次', () => {
  /** 旧行没有该事实，只能为 NULL：按时间推算回填，等于声明模型看过一张未发送的图片。 */
  test('存量请求行加列后为 NULL，不按时间回填', () => {
    const db = dbBefore(59)
    db.exec(`
INSERT INTO provider_requests
  (id, run_id, turn_index, retry_index, purpose, model, status, measured_input_tokens,
   sent_categories, omitted_categories, payload_hash, sent_at, created_at)
VALUES ('pr_legacy', 'rn_legacy', 0, 0, 'turn', 'm', 'received', 10, '{}', '{}', 'h', 5, 5);
`)

    applyOne(db, 59)

    expect(
      db
        .query<{ id: string; input_image_batch_id: string | null }, []>(
          'SELECT id, input_image_batch_id FROM provider_requests',
        )
        .all(),
    ).toEqual([{ id: 'pr_legacy', input_image_batch_id: null }])
    db.close()
  })
})

describe('迁移 62：删除没有读写方的权限表', () => {
  test('存量库迁移后与新建库都没有 permission_rules / permission_audit', () => {
    const db = dbBefore(62)
    db.exec(`INSERT INTO permission_rules (id, workspace_id, scope, effect, created_at)
VALUES ('pr_x', 'ws', 'run_command:git', 'allow', 1);`)
    applyOne(db, 62)
    const tables = (d: Database) =>
      d
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name LIKE 'permission_%' OR name LIKE '%permission_scope' OR name = 'idx_audit_workspace'",
        )
        .all()
    expect(tables(db)).toEqual([])
    db.close()

    const fresh = dbBefore(Number.POSITIVE_INFINITY)
    expect(tables(fresh)).toEqual([])
    fresh.close()
  })
})

describe('迁移 65：消息表只存储用户消息', () => {
  test('存量用户消息逐列保留，runs 不再有 assistant_message_id', () => {
    const db = dbBefore(65)
    db.exec(`
INSERT INTO messages (id, conversation_id, role, content, attachments, created_at, origin)
VALUES ('ms_1', 'cv', 'user', '改一下登录页', '[]', 1, NULL),
       ('ms_2', 'cv', 'user', '子任务回执', NULL, 2, 'subagent');
`)
    applyOne(db, 65)

    expect(
      db
        .query(
          'SELECT id, role, content, attachments, created_at, origin FROM messages ORDER BY id',
        )
        .all(),
    ).toEqual([
      {
        id: 'ms_1',
        role: 'user',
        content: '改一下登录页',
        attachments: '[]',
        created_at: 1,
        origin: null,
      },
      {
        id: 'ms_2',
        role: 'user',
        content: '子任务回执',
        attachments: null,
        created_at: 2,
        origin: 'subagent',
      },
    ])
    const runColumns = db
      .query<{ name: string }, []>('PRAGMA table_info(runs)')
      .all()
      .map((c) => c.name)
    expect(runColumns).not.toContain('assistant_message_id')
    expect(() =>
      db.exec(
        "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('ms_3', 'cv', 'assistant', 'x', 3)",
      ),
    ).toThrow()
    db.close()
  })

  test('存量库中有助手行时迁移失败，不静默删除', () => {
    const db = dbBefore(65)
    db.exec(
      "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('ms_a', 'cv', 'assistant', '旧回复', 1)",
    )
    expect(() => db.transaction(() => applyOne(db, 65))()).toThrow()
    expect(db.query('SELECT id, role FROM messages').all()).toEqual([
      { id: 'ms_a', role: 'assistant' },
    ])
    db.close()
  })
})
