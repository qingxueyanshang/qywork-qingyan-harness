/**
 * `qy exec` 与 `qy tui` 的启动段。**覆盖范围**：`index.ts` 的 `runExec` 与 `tui.ts` 的
 * `runTui` 里「开主库 → 导入旧任务文件 → 开正文库 → 回收孤儿正文」这四步，
 * 以及给交互式那条路做入口的 `tui-child.ts`。
 *
 * 两条都起真进程：这两个入口各自开库、各自装配，在同一个测试进程里调它们既跑不到
 * `runExec`（没有导出），也会让 `runTui` 去抢测试进程的 stdin。
 *
 * 模型请求一律回 401：要验的是起轮之前那几步，`auth_failed` 不在重发名单里，一次就落终态。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Schedule } from '@qywork/core'
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
 * 一份「上一个进程留下的现场」：旧任务文件还在，正文库中存在一条尚未登记完成的孤儿记录，
 * 另有一条仍被引用的正文。两库都关掉再交给子进程——Windows 上同一个文件两个写句柄要撞锁。
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
  // 正文提交了、引用没登记——进程在主库提交前退出留下的就是这个形状。
  const orphan = content.put(enc.encode(`${name} 上次没登记完`))

  const legacy: Schedule[] = [
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

/** 重开两库核对结果，核完关掉。 */
function verify(f: Fixture): void {
  const store = new Store({ path: f.dbPath })
  const content = new ContentStore(f.contentPath)
  try {
    // 旧文件改名了，且只改名一次：重启时文件不在就不再导入。
    expect(existsSync(join(f.home, 'schedules.json'))).toBe(false)
    expect(existsSync(join(f.home, 'schedules.json.imported'))).toBe(true)

    const rows = listSchedules(store, f.ws, Date.now())
    expect(rows.map((s) => s.id)).toEqual([f.scheduleId])
    expect(rows[0]?.title).toBe('旧文件里的任务')
    expect(rows[0]?.everyMinutes).toBe(30)

    // 孤儿收掉了，仍被引用的一个字节没动。
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

test('qy exec 跑一次：旧任务文件导进表并改名，孤儿正文回收', async () => {
  const f = await fixture('exec')
  const before = providerCalls
  const { exitCode, stderr } = await run(
    [process.execPath, CLI, 'exec', '汇报一次', '--cwd', f.ws, '--json'],
    f.home,
  )
  // 401 落终态，`qy exec` 以 1 退出——这一轮确实发出去了，不是在开库那一步就停了。
  expect(exitCode).toBe(1)
  expect(providerCalls).toBeGreaterThan(before)
  expect(stderr).not.toContain('正文回收失败')
  verify(f)
}, 120_000)

test('qy tui 起一次：同样导入并回收，读不到输入就收尾', async () => {
  const f = await fixture('tui')
  const { exitCode, stderr } = await run([process.execPath, TUI_CHILD, f.home, f.ws], f.home)
  expect(exitCode).toBe(0)
  // stderr 上有一条模型不在内置目录的提醒；回收失败会另写一行，不能被它盖过去。
  expect(stderr).not.toContain('正文回收失败')
  verify(f)
}, 120_000)

test('第二次起同一个 home 不再导入，也不误删仍被引用的正文', async () => {
  const f = await fixture('twice')
  await run([process.execPath, TUI_CHILD, f.home, f.ws], f.home)
  verify(f)

  // 再放一个孤儿，再起一次：改名后的文件不会被当成待导入的输入，任务仍是一条。
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
