/**
 * `qy exec` 与 `qy tui` 的启动段。**覆盖范围**：`index.ts` 的 `runExec` 与 `tui.ts` 的
 * `runTui` 中「打开主库 → 导入旧任务文件 → 打开正文库 → 回收孤儿正文」这四步，
 * 以及交互模式的子进程入口 `tui-child.ts`。
 *
 * 两个用例都启动真实进程：这两个入口各自打开数据库、各自装配，在同一个测试进程中调用它们，既无法调用
 * `runExec`（未导出），也会使 `runTui` 争用测试进程的 stdin。
 *
 * 模型请求一律返回 401：要验证的是开始一轮之前的步骤，`auth_failed` 不在重发列表中，一次即进入终态。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type QyConfig, RuntimeSink } from '@qywork/runtime'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  createRun,
  listSchedules,
  Store,
  upsertWorkspace,
} from '@qywork/store'

const CLI = join(import.meta.dir, 'index.ts')
const TUI_CHILD = join(import.meta.dir, 'tui-child.ts')
const enc = new TextEncoder()

let providerCalls = 0
const provider = Bun.serve({
  port: 0,
  fetch() {
    providerCalls++
    return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  },
})

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'qywork-cli-life-'))
})

afterAll(async () => {
  provider.stop(true)
  await rm(root, { recursive: true, force: true }).catch(() => {})
})

interface Fixture {
  home: string
  ws: string
  dbPath: string
  contentPath: string
  scheduleId: string
  orphanHash: string
  keptHash: string
}

/**
 * 构造上一个进程遗留的现场：旧任务文件仍在，正文库中存在一条尚未完成登记的孤儿记录，
 * 另有一条仍被引用的正文。两个库都关闭后再交给子进程：Windows 上同一文件的两个写句柄会发生锁冲突。
 */
async function fixture(name: string): Promise<Fixture> {
  const home = await mkdtemp(join(root, `${name}-home-`))
  const ws = await mkdtemp(join(root, `${name}-ws-`))
  const config: QyConfig = {
    active: { provider: 'fake', model: 'deepseek-v4-flash' },
    providers: {
      fake: {
        kind: 'openai_responses',
        apiKey: 'sk-fake',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { 'deepseek-v4-flash': {} },
      },
    },
    mode: 'auto',
  }
  await writeFile(join(home, 'config.json'), JSON.stringify(config), 'utf8')

  const dbPath = join(home, 'qywork.sqlite3')
  const contentPath = contentPathFor(dbPath)
  const store = new Store({ path: dbPath })
  const content = new ContentStore(contentPath)
  const workspace = upsertWorkspace(store, ws, '启动')
  const conv = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'fake',
    model: 'deepseek-v4-flash',
    title: '上一次',
  })
  const run = createRun(store, {
    conversationId: conv.id,
    workspaceId: workspace.id,
    model: 'deepseek-v4-flash',
    clientRequestId: crypto.randomUUID(),
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  const kept = new RuntimeSink(store, content, run.id).land({
    toolName: 'run_command',
    sourceType: 'shell',
    body: enc.encode('还有人引用'),
  })
  // 正文已提交、引用未登记：进程在主库提交前退出时遗留的即为这种形状。
  const orphan = content.put(enc.encode(`${name} 上次没登记完`))

  // 旧文件中记录的原始形状。键名是历史事实，不随 `Schedule` 修改。
  const legacy = [
    {
      id: `sc_legacy_${name}`,
      workspaceRoot: ws,
      title: '旧文件里的任务',
      prompt: '汇报一次。',
      kind: 'interval',
      everyMinutes: 30,
      enabled: true,
      createdAt: 1_700_000_000_000,
    },
  ]
  await writeFile(join(home, 'schedules.json'), JSON.stringify(legacy), 'utf8')

  content.close()
  store.close()
  return {
    home,
    ws,
    dbPath,
    contentPath,
    scheduleId: legacy[0]!.id,
    orphanHash: orphan.contentHash,
    keptHash: kept.contentHash,
  }
}

/** 重新打开两个库核对结果，核对完毕后关闭。 */
function verify(f: Fixture): void {
  const store = new Store({ path: f.dbPath })
  const content = new ContentStore(f.contentPath)
  try {
    // 旧文件已改名，且只改名一次：重启时文件不存在即不再导入。
    expect(existsSync(join(f.home, 'schedules.json'))).toBe(false)
    expect(existsSync(join(f.home, 'schedules.json.imported'))).toBe(true)

    const rows = listSchedules(store, f.ws, Date.now())
    expect(rows.map((s) => s.id)).toEqual([f.scheduleId])
    expect(rows[0]?.title).toBe('旧文件里的任务')
    expect(rows[0]?.everyMinutes).toBe(30)

    // 孤儿正文已回收，仍被引用的正文未作任何改动。
    expect(content.info(f.orphanHash)).toBeNull()
    expect(content.info(f.keptHash)).not.toBeNull()
  } finally {
    content.close()
    store.close()
  }
}

async function run(argv: string[], home: string): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(argv, {
    env: { ...process.env, QYWORK_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return { exitCode, stderr }
}

test('qy exec 执行一次：旧任务文件导入数据表并改名，孤儿正文被回收', async () => {
  const f = await fixture('exec')
  const before = providerCalls
  const { exitCode, stderr } = await run(
    [process.execPath, CLI, 'exec', '汇报一次', '--cwd', f.ws, '--json'],
    f.home,
  )
  // 401 进入终态，`qy exec` 以 1 退出：本轮请求确实已发出，而不是在打开数据库时就已停止。
  expect(exitCode).toBe(1)
  expect(providerCalls).toBeGreaterThan(before)
  expect(stderr).not.toContain('正文回收失败')
  verify(f)
}, 120_000)

test('qy tui 启动一次：同样导入并回收，无法读取输入时结束', async () => {
  const f = await fixture('tui')
  const { exitCode, stderr } = await run([process.execPath, TUI_CHILD, f.home, f.ws], f.home)
  expect(exitCode).toBe(0)
  // stderr 中有一条模型不在内置目录的提醒；回收失败会另写一行，断言只针对后者。
  expect(stderr).not.toContain('正文回收失败')
  verify(f)
}, 120_000)

test('第二次以同一个 home 启动时不再导入，也不误删仍被引用的正文', async () => {
  const f = await fixture('twice')
  await run([process.execPath, TUI_CHILD, f.home, f.ws], f.home)
  verify(f)

  // 再放入一条孤儿正文并再次启动：改名后的文件不会被当作待导入的输入，任务仍为一条。
  const content = new ContentStore(f.contentPath)
  const second = content.put(enc.encode('第二次留下的孤儿'))
  content.close()

  const { exitCode } = await run([process.execPath, TUI_CHILD, f.home, f.ws], f.home)
  expect(exitCode).toBe(0)
  verify(f)

  const check = new ContentStore(f.contentPath)
  try {
    expect(check.info(second.contentHash)).toBeNull()
  } finally {
    check.close()
  }
}, 180_000)
