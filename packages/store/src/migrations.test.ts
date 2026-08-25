/**
 * 迁移的行为回归。**覆盖范围**：`schema.ts` 的 `MIGRATIONS` 与 `ROW_COLUMNS`。
 *
 * 只测「转换数据」的那几条。纯建表的不测——建错了任何一条查询都会红，
 * 而数据转换错了是静默的：代码全绿、界面上冒出一个 `undefined` 或者一句旧文案。
 */

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { MIGRATIONS, ROW_COLUMNS } from './schema.ts'

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
describe('行类型与 DDL 对齐', () => {
  test('每张表声明的列名与迁移跑完之后的真实列名一致', () => {
    const db = new Database(':memory:')
    for (const m of MIGRATIONS) db.exec(m.sql)

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
