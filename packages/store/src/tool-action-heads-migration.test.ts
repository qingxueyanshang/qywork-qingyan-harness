/**
 * 覆盖迁移 81（`081-tool-action-heads.ts`）：历史工具行由「动作 + 对象名」转换为开头、动词与对象，
 * 执行后确定的对象写入结果的 `subject`。
 *
 * 原始失败形状：历史记录只有 `objectLabel`，新界面按 `head` 与 `verb` 显示，转换缺失时历史中的工具行标题为空。
 * 另覆盖迁移 82（`082-interrupted-steps.ts`）：停止时被收尾的历史工具行补写中断类别；
 * 迁移 83（`083-canvas-tool-head.ts`）与迁移 84（`084-web-tool-head.ts`）：类目改名后改写历史工具行的开头。
 */
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { migration081 } from './migrations/081-tool-action-heads.ts'
import { migration082 } from './migrations/082-interrupted-steps.ts'
import { migration083 } from './migrations/083-canvas-tool-head.ts'
import { migration084 } from './migrations/084-web-tool-head.ts'

/** 在只含 steps 表的内存库中插入一行，执行迁移 81 的全部批次，返回转换后的 payload；未改写时返回 null。 */
function convertToolAction(
  tool: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const db = new Database(':memory:')
  try {
    db.run('CREATE TABLE steps (id TEXT PRIMARY KEY, kind TEXT, tool_name TEXT, payload TEXT)')
    const raw = JSON.stringify(payload)
    db.query('INSERT INTO steps (id, kind, tool_name, payload) VALUES (?, ?, ?, ?)').run(
      's',
      'tool_action',
      tool,
      raw,
    )
    let after = 0
    for (;;) {
      const next = migration081.background!(db, {} as never, after)
      if (next === null) break
      after = next
    }
    const row = db.query("SELECT payload FROM steps WHERE id = 's'").get() as { payload: string }
    return row.payload === raw ? null : (JSON.parse(row.payload) as Record<string, unknown>)
  } finally {
    db.close()
  }
}

const old = (kind: string, objectLabel: string, target: string | null) => ({
  kind,
  objectLabel,
  target,
})

describe('按工具名与参数转换', () => {
  test('文件读写：分段读取写入行号范围，写文件改名时写入实际路径', () => {
    const read = convertToolAction('read_file', {
      kind: 'tool_result',
      action: old('read', '文件', 'src/a.ts'),
      args: { path: 'src/a.ts', offset: 395 },
      outcome: {
        status: 'success',
        executed: true,
        message: '',
        data: { startLine: 395, endLine: 448, totalLines: 700 },
      },
    })
    expect(read?.action).toEqual({
      kind: 'read',
      head: '文件读写',
      verb: '读取',
      object: 'src/a.ts',
      target: 'src/a.ts',
    })
    expect((read?.outcome as { subject?: string }).subject).toBe('src/a.ts:395-448')

    const write = convertToolAction('write_file', {
      kind: 'tool_result',
      action: old('write', '文件', 'page.html'),
      args: { path: 'page.html', mode: 'create' },
      outcome: {
        status: 'success',
        executed: true,
        message: '',
        fileChanges: [{ path: 'page-2.html', changeType: 'created' }],
      },
    })
    expect((write?.outcome as { subject?: string }).subject).toBe('page-2.html')
  })

  test('原先显示错误的工具按实际动作转换，动作随动词重新得出', () => {
    const open = convertToolAction('open_in_panel', {
      kind: 'tool_result',
      action: old('read', '文件', 'page.html'),
      args: { path: 'page.html' },
    })
    expect(open?.action).toMatchObject({ kind: 'call', head: '文件读写', verb: '打开' })

    const capture = convertToolAction('capture_canvas_frame', {
      kind: 'tool_result',
      action: old('write', '画布', 'a.canvas.json'),
      args: { path: 'a.canvas.json', node: '封面', at: 12.5 },
    })
    expect(capture?.action).toMatchObject({
      head: '画布读写',
      verb: '截取',
      object: '封面 12.5 秒',
    })
  })

  test('浏览器与电脑控制不显示不透明编号，窗口标题写入 subject', () => {
    const act = convertToolAction('browser_act', {
      kind: 'tool_result',
      action: old('call', '浏览器控制', 'tab_7'),
      args: { tabId: 'tab_7', action: 'click', ref: '12' },
    })
    expect(act?.action).toMatchObject({
      head: '网页控制',
      verb: '点击',
      object: '元素',
      target: 'tab_7',
    })

    const observe = convertToolAction('desktop_observe', {
      kind: 'tool_result',
      action: old('read', '电脑控制', 'dw_3'),
      args: { windowId: 'dw_3' },
      outcome: { status: 'success', executed: true, message: '', data: { title: '记事本' } },
    })
    expect(observe?.action).toMatchObject({ head: '电脑控制', verb: '查看', object: '窗口' })
    expect((observe?.outcome as { subject?: string }).subject).toBe('记事本')
  })

  test('外部工具按名称前缀归类，对象由权限范围转换为「server／工具」', () => {
    const mcp = convertToolAction('mcp__github__search', {
      kind: 'tool_result',
      action: old('call', 'MCP', 'mcp:github/search'),
      args: {},
    })
    expect(mcp?.action).toMatchObject({ head: 'MCP 调用', verb: '调用', object: 'github／search' })

    const plugin = convertToolAction('shot__capture', {
      kind: 'tool_result',
      action: old('call', '插件', 'plugin:shot/capture'),
      args: {},
    })
    expect(plugin?.action).toMatchObject({ head: '插件调用', object: 'shot／capture' })
  })

  /** 原始失败形状：资源工具的旧目标按权限范围拆分，`file:///notes/a.md` 显示为「file:／//notes/a.md」。 */
  test('MCP 资源工具：读取显示资源地址，列出显示「server／list_resources」，与注册时的对象相同', () => {
    const fetched = convertToolAction('mcp__notes__fetch_resource', {
      kind: 'tool_result',
      action: old('call', 'MCP', 'file:///notes/a.md'),
      args: { uri: 'file:///notes/a.md' },
    })
    expect(fetched?.action).toMatchObject({ head: 'MCP 调用', object: 'file:///notes/a.md' })

    const listed = convertToolAction('mcp__notes__list_resources', {
      kind: 'tool_result',
      action: old('call', 'MCP', 'mcp:notes/resource'),
      args: {},
    })
    expect(listed?.action).toMatchObject({ head: 'MCP 调用', object: 'notes／list_resources' })
  })

  test('已删除的旧工具按其领域归类，不落入「会话读取」', () => {
    const canvas = convertToolAction('canvas', {
      kind: 'tool_result',
      action: old('write', '画布', 'a.canvas.json'),
      args: { path: 'a.canvas.json' },
    })
    expect(canvas?.action).toMatchObject({ head: '画布读写', object: 'a.canvas.json' })
    const video = convertToolAction('retrieve_video', {
      kind: 'tool_result',
      action: old('read', '视频', 'generated/a.mp4'),
      args: {},
    })
    expect(video?.action).toMatchObject({ head: '媒体生成' })
  })

  test('待办按原动作区分创建与更新', () => {
    const edit = convertToolAction('write_todos', {
      kind: 'tool_result',
      action: old('edit', '待办', null),
      args: { todos: [] },
    })
    expect(edit?.action).toMatchObject({ verb: '更新', object: '待办清单', kind: 'edit' })
  })

  test('已转换的行与没有 action 的行不改写', () => {
    expect(
      convertToolAction('read_file', {
        kind: 'tool_result',
        action: { kind: 'read', head: '文件读写', verb: '读取', object: 'a.ts', target: 'a.ts' },
      }),
    ).toBeNull()
    expect(convertToolAction('read_file', { kind: 'tool_call' })).toBeNull()
  })
})

test('分批执行：逐批推进，全部处理完返回 null，原字段 objectLabel 被删除', () => {
  const db = new Database(':memory:')
  db.run('CREATE TABLE steps (id TEXT PRIMARY KEY, kind TEXT, tool_name TEXT, payload TEXT)')
  const insert = db.query('INSERT INTO steps (id, kind, tool_name, payload) VALUES (?, ?, ?, ?)')
  insert.run(
    's1',
    'tool_action',
    'run_command',
    JSON.stringify({ kind: 'tool_call', action: old('run', '命令', 'npm test'), args: {} }),
  )
  insert.run('s2', 'user', null, JSON.stringify({ kind: 'user' }))
  const batch = migration081.background!
  let after = 0
  for (;;) {
    const next = batch(db, {} as never, after)
    if (next === null) break
    after = next
  }
  const row = db.query("SELECT payload FROM steps WHERE id = 's1'").get() as { payload: string }
  const payload = JSON.parse(row.payload) as { action: Record<string, unknown> }
  expect(payload.action).toEqual({
    kind: 'run',
    head: '命令执行',
    verb: '运行',
    object: 'npm test',
    target: 'npm test',
  })
  db.close()
})

/** 覆盖迁移 82：历史中停止时被收尾的工具行补写中断类别，界面显示「已中断」「结果不明」而不是「失败」。 */
test('迁移 82：两种中断回执补写错误类别，其余失败行不变', () => {
  const db = new Database(':memory:')
  db.run(
    'CREATE TABLE steps (id TEXT PRIMARY KEY, kind TEXT, tool_name TEXT, status TEXT, payload TEXT)',
  )
  const insert = db.query(
    "INSERT INTO steps (id, kind, tool_name, status, payload) VALUES (?, 'tool_action', 'run_command', 'failure', ?)",
  )
  const failure = (message: string, executed: boolean) =>
    JSON.stringify({ kind: 'tool_result', outcome: { status: 'failure', executed, message } })
  insert.run('a', failure('执行期间被中断，结果未知', true))
  insert.run('b', failure('未开始执行即被中断', false))
  insert.run('c', failure('命令退出码 1，进程被中断', true))
  let after = 0
  for (;;) {
    const next = migration082.background!(db, {} as never, after)
    if (next === null) break
    after = next
  }
  const outcome = (id: string) =>
    (
      JSON.parse(
        (db.query('SELECT payload FROM steps WHERE id = ?').get(id) as { payload: string }).payload,
      ) as {
        outcome: Record<string, unknown>
      }
    ).outcome
  expect(outcome('a')).toMatchObject({ errorKind: 'interrupted', resultState: 'unknown' })
  expect(outcome('b')).toMatchObject({ errorKind: 'interrupted' })
  expect(outcome('b').resultState).toBeUndefined()
  expect(outcome('c').errorKind).toBeUndefined()
  db.close()
})

/** 覆盖迁移 83：历史中画布类工具行的开头改为「画布控制」，与新写入的行和设置页的分组名一致。 */
test('迁移 83：开头为「画布读写」的工具行改为「画布控制」，其余行不变', () => {
  const db = new Database(':memory:')
  db.run('CREATE TABLE steps (id TEXT PRIMARY KEY, kind TEXT, tool_name TEXT, payload TEXT)')
  const insert = db.query(
    "INSERT INTO steps (id, kind, tool_name, payload) VALUES (?, 'tool_action', ?, ?)",
  )
  const row = (head: string, object: string) =>
    JSON.stringify({ kind: 'tool_result', action: { kind: 'write', head, verb: '导出', object } })
  insert.run('a', 'export_timeline', row('画布读写', '成片'))
  insert.run('b', 'write_file', row('文件读写', '画布读写.md'))
  let after = 0
  for (;;) {
    const next = migration083.background!(db, {} as never, after)
    if (next === null) break
    after = next
  }
  const action = (id: string) =>
    (
      JSON.parse(
        (db.query('SELECT payload FROM steps WHERE id = ?').get(id) as { payload: string }).payload,
      ) as { action: Record<string, unknown> }
    ).action
  expect(action('a')).toEqual({ kind: 'write', head: '画布控制', verb: '导出', object: '成片' })
  expect(action('b')).toEqual({
    kind: 'write',
    head: '文件读写',
    verb: '导出',
    object: '画布读写.md',
  })
  db.close()
})

/** 覆盖迁移 84：历史中网页搜索与获取的工具行开头改为「联网搜索」。 */
test('迁移 84：开头为「网络访问」的工具行改为「联网搜索」，其余行不变', () => {
  const db = new Database(':memory:')
  db.run('CREATE TABLE steps (id TEXT PRIMARY KEY, kind TEXT, tool_name TEXT, payload TEXT)')
  const insert = db.query(
    "INSERT INTO steps (id, kind, tool_name, payload) VALUES (?, 'tool_action', ?, ?)",
  )
  const row = (head: string, object: string) =>
    JSON.stringify({ kind: 'tool_result', action: { kind: 'read', head, verb: '获取', object } })
  insert.run('a', 'web_fetch', row('网络访问', 'https://example.com/'))
  insert.run('b', 'run_command', row('命令执行', 'curl 网络访问.txt'))
  // 按 rowid 区间分批：远在第一个区间之后、中间没有行的匹配行同样改写。
  db.query(
    "INSERT INTO steps (rowid, id, kind, tool_name, payload) VALUES (12345, 'c', 'tool_action', 'web_search', ?)",
  ).run(row('网络访问', '天气'))
  let after = 0
  for (;;) {
    const next = migration084.background!(db, {} as never, after)
    if (next === null) break
    after = next
  }
  const head = (id: string) =>
    (
      JSON.parse(
        (db.query('SELECT payload FROM steps WHERE id = ?').get(id) as { payload: string }).payload,
      ) as { action: { head: string } }
    ).action.head
  expect(head('a')).toBe('联网搜索')
  expect(head('b')).toBe('命令执行')
  expect(head('c')).toBe('联网搜索')
  db.close()
})
