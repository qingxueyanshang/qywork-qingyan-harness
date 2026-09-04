/**
 * 迁移的行为回归。**覆盖范围**：`schema.ts` 的 `MIGRATIONS` 与 `ROW_COLUMNS`、
 * `db.ts` 的迁移执行，以及 `repos.ts` 的启动恢复查询。
 *
 * 只测「转换数据」的那几条。纯建表的不测——建错了任何一条查询都会红，
 * 而数据转换错了是静默的：代码全绿、界面上冒出一个 `undefined` 或者一句旧文案。
 */

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './db.ts'
import { recoverStaleRuns } from './repos.ts'
import { MIGRATIONS, ROW_COLUMNS } from './schema.ts'

function executeMigration(db: Database, migration: (typeof MIGRATIONS)[number]): void {
  if (migration.sql) db.exec(migration.sql)
  migration.apply?.(db)
}

/** 跑到某一条迁移之前的库。外键默认关着，所以可以只插 steps 不建父行。 */
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

/** 整份 payload，用于断言「一个字节都没动」。 */
function payloadJson(db: Database, id: string): unknown {
  const row = db.query('SELECT payload FROM steps WHERE id = ?').get(id) as { payload: string }
  return JSON.parse(row.payload)
}

/** `outcome.data`，迁移 27 只动这里。 */
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
      // 对象名不动：换的是动作，不是被操作的对象。
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
 * 那批行的来历：动作轴与回执文案分两批改，中间跑过真实轮次，因此落下
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
    // 对象名不动：换的是动作，不是被操作的对象。
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

/**
 * 外置工具的对象名收成「MCP」/「插件」两个类名。
 *
 * 卡片是动词 + 对象 + 目标三层；老行把具体的 `mcp:<server>/<tool>` 填进对象名，
 * 标题和目标因此一字不差。不转的表现是回放时老卡片写「调用mcp:github/search」、
 * 新卡片写「调用MCP · mcp:github/search」。
 */
describe('迁移 20：外置工具的对象名收成类名', () => {
  const labelOf = (db: Database, id: string) => payloadOf(db, id).action.objectLabel

  test('MCP 转成「MCP」、插件转成「插件」，目标不动', () => {
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
    // 目标那一层本来就该是具体的那个，这次一个字节都不碰。
    for (const [id] of rows) expect(payloadOf(db, id).action.target).toBe('tgt')
  })

  test('内置工具的行原样不动 —— 判据是名字里的双下划线', () => {
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

  /** `json_set` 会给没有 action 的行凭空长出一个键，WHERE 必须把它们挡在外面。 */
  test('没有 action 的行不长出 action', () => {
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
 * `memory` 门面拆成三个名字，老行按行内的 `args.action` 分流。
 *
 * 不转的表现是回放历史时模型看到一个当前工具表里不存在的名字——账本里的
 * `tool_name` 与 `args` 会被原样重放成一次工具调用。
 */
describe('迁移 21：memory 拆成 read/write/delete_memory', () => {
  const nameOf = (db: Database, id: string) =>
    db.query<{ n: string }, [string]>('SELECT tool_name AS n FROM steps WHERE id = ?').get(id)!.n
  const argsOf = (db: Database, id: string) =>
    JSON.parse(
      db.query<{ payload: string }, [string]>('SELECT payload FROM steps WHERE id = ?').get(id)!
        .payload,
    ).args as Record<string, unknown>

  test('四个动作各自分流，list 归读', () => {
    const db = dbBefore(21)
    const rows: [string, Record<string, unknown>, string][] = [
      // id, 老 args, 期望的新名字
      ['m_read', { action: 'read', key: '包管理器' }, 'read_memory'],
      ['m_write', { action: 'write', key: '包管理器', content: 'pnpm' }, 'write_memory'],
      ['m_del', { action: 'delete', key: '包管理器' }, 'delete_memory'],
      ['m_list', { action: 'list' }, 'read_memory'],
    ]
    for (const [id, args] of rows) insertStep(db, id, 'memory', { kind: 'tool_result', args })
    applyOne(db, 21)
    for (const [id, , want] of rows) expect(nameOf(db, id)).toBe(want)
  })

  /** 名字改了之后这行已不是逐字记录，留着 `action` 只会给出一个今天不合法的调用形状。 */
  test('args.action 被清掉，别的参数原样保留', () => {
    const db = dbBefore(21)
    insertStep(db, 'm_write', 'memory', {
      kind: 'tool_result',
      args: { action: 'write', key: '包管理器', content: 'pnpm' },
    })
    applyOne(db, 21)
    expect(argsOf(db, 'm_write')).toEqual({ key: '包管理器', content: 'pnpm' })
  })

  test('缺 action 与值非法的都归读 —— 分不出动作时落到最保守的那个', () => {
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

  test('别的工具一个字节都不动', () => {
    const db = dbBefore(21)
    insertStep(db, 'other', 'read_file', { kind: 'tool_result', args: { path: 'a.ts' } })
    // 同名前缀的行也不能被一并带走——判据是整个名字相等。
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

describe('迁移 26：steps 重建，思考有自己的 kind', () => {
  /**
   * 这条是**重建表**——SQLite 改不了 CHECK 约束，只能建新表搬数据。
   * 搬漏一列、搬漏一批行都是静默的：库还在、查询还能跑，只是历史没了。
   * 所以断言逐行逐列比对，不是只数一个总数。
   */
  test('每一行每一列原样搬过去，索引跟着重建', () => {
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
    // 存量行的思考仍在原处——投影侧那条只读回落靠它。
    expect(after[1]!.content).toBe('旧的思考')
    expect(after[1]!.tool_call_id).toBe('c1')
    expect(after[2]!.created_at).toBe(7)

    // 新 kind 收得下。
    db.query(
      `INSERT INTO steps (id, run_id, seq, kind, content, status, created_at)
       VALUES ('s4', 'rn', 0, 'thinking', '想了想', 'done', 8)`,
    ).run()
    expect(db.query("SELECT COUNT(*) n FROM steps WHERE kind = 'thinking'").get()).toEqual({ n: 1 })

    // 退役的两个值不再收：留着只是给下一个人一个误用的机会。
    expect(() =>
      db
        .query(
          `INSERT INTO steps (id, run_id, seq, kind, status, created_at)
           VALUES ('s5', 'rn', 9, 'artifact', 'done', 9)`,
        )
        .run(),
    ).toThrow()

    // 索引必须跟着重建，否则删一个长会话会退化成全表扫。
    const idx = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='steps'")
      .all() as { name: string }[]
    expect(idx.map((i) => i.name)).toContain('idx_step_run_seq')
  })
})

describe('迁移 27：工具结果里的图像字节改成数组', () => {
  /** 旧形状：`envelopeResult` / `imagesOf` 都只认 `images`，这两个键对谁都不成立。 */
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

  test('imageData + mime 收成 images 数组，两个旧键一并去掉', () => {
    const db = dbBefore(27)
    insertStep(db, 's1', 'read_file', oldShape)
    applyOne(db, 27)

    const data = dataOf(db, 's1')
    expect(data).toEqual({ images: [{ data: 'iVBORw0KGgoAAAANSUhEUg', mime: 'image/png' }] })
    db.close()
  })

  /**
   * `mime` 必须搬进数组元素，不能留在 `data` 上。
   *
   * 留着的话 `envelopeResult` 摘掉 `images` 之后 `data` 仍非空，信封里会多一个
   * `{"result":{"mime":"image/png"}}`，与今天新落的行不同形——同一次调用在两轮里
   * 长得不一样，前缀缓存从那里断掉，而这件事不会有任何报错。
   */
  test('转完 data 上只剩 images 一个键', () => {
    const db = dbBefore(27)
    insertStep(db, 's1', 'read_file', oldShape)
    applyOne(db, 27)

    expect(Object.keys(dataOf(db, 's1'))).toEqual(['images'])
    db.close()
  })

  /**
   * 认的是 JSON 路径不是文本。实测库里有十条 `write_file` / `grep` 记录的正文
   * 含 `imageData` 这个标识符——按文本挑会把用户的源码改坏。
   */
  test('正文里含 imageData 这个词的记录不受影响', () => {
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

  test('已经是新形状的行原样不动，重复执行也不动', () => {
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

  /** 多张图的形状（MCP 一次能带回好几张）不在旧行里出现，转换只造一元数组。 */
  test('旧行只可能有一张图，转出来就是一元数组', () => {
    const db = dbBefore(27)
    insertStep(db, 's1', 'read_file', oldShape)
    applyOne(db, 27)

    expect((dataOf(db, 's1') as { images: unknown[] }).images).toHaveLength(1)
    db.close()
  })
})

/**
 * 行类型是 DDL 的镜像，这条测试是**让它保持是镜像的那个约束**。
 *
 * `schema.ts` 里的 `WorkspaceRow` 那几个接口没有任何检查强制它们跟表对齐：迁移加一列
 * 而接口忘了加，两边不一致不会有人发现——直到某个映射函数读了一个不存在的列，
 * 拿到 `undefined` 装进领域对象。所以列名单独列一份（`ROW_COLUMNS`，与接口同处同改），
 * 在这里跟真库比对。
 *
 * 比的是**集合**不是顺序：`SELECT *` 取的是名字，列的物理顺序改了不影响任何调用方。
 */
describe('迁移 40：派活卡的节点事实收成 nodes', () => {
  test('派一件与一张图的旧键都折成每格的状态与名字', () => {
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

describe('迁移 41：派活参数与回执改按 kind 记', () => {
  test('节点的 agent 改成 kind 字段，回执改名，续接调用从回执折出逐格状态，卡头对象名换新', () => {
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
    // 首派那条由迁移 40 按 step 终态估的状态以回执为准：glm 实际是 done。
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
    // 已经是新形状的行原样不动。
    expect(payloadJson(db, 'st_new')).toMatchObject({
      args: { kind: 'temp', name: '已是新形状', task: '看' },
    })
  })
})

describe('迁移 42：拿任务正文当名字的临时子 agent 改回原名', () => {
  test('名字是任务开头的改回临时子 agent，模型起的短名不动', () => {
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

describe('迁移 43：子 agent 的名字只有一份', () => {
  test('抄来的标题与「临时子 agent」换成目标名或模型 id', () => {
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

describe('迁移 44：临时子 agent 的格子名统一为模型名', () => {
  test('临时的换成模型名，角色的不动', () => {
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

describe('迁移 45：派一件那一格的耗时从 step 抄过来', () => {
  test('格子没有耗时的抄 step 的，已有的不动', () => {
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

describe('行类型与 DDL 对齐', () => {
  test('每张表声明的列名与迁移跑完之后的真实列名一致', () => {
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

describe('迁移 37：运行记录收口为唯一结构', () => {
  test('旧 step 一次迁成 child、workflow、compaction、batch 与独立思考', () => {
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

  test('接口证据冲突时不猜 provider', () => {
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
