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
