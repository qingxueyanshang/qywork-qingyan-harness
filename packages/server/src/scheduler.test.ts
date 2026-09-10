/**
 * 定时任务的完整触发链路。**覆盖范围**：`scheduler.ts` 与 `api/schedules.ts`，
 * 并穿过 `store/schedules.ts` 的认领事务、`run-control.ts` 的起轮与 `tools/schedules.ts` 的
 * 模型工具投影。
 *
 * 两条断言直接复现原始失败形状：
 *
 * - **E04**：服务以工作区 A 启动，工作区 B 的到期任务照样触发；模型返回 401 之后，任务 API、
 *   `list_schedules` 工具与再取一次（刷新）读到同一个 Run 终态。
 * - **E05**：同一到期时机两个 `serve()` 实例只产生一条会话、一条 Run、一次模型请求。
 *
 * 计时器是真的：两条都由 `serve()` 自己的 `setInterval` 驱动，测试不直接调推进函数。
 * 注入的只有 tick 间隔与假 provider 的响应。
 *
 * 单进程内的两个实例不可能真正交错（认领事务是同步的），跨操作系统进程的竞争由
 * `schedule-race.test.ts` 覆盖。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@qywork/agent'
import { ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { configPath, loadConfig, type QyConfig } from '@qywork/runtime'
import { createSchedule, listSchedules, Store, upsertWorkspace } from '@qywork/store'
import { registerBuiltinTools } from '@qywork/tools'
import { tickSchedules } from './scheduler.ts'
import { serve } from './server.ts'

/** 401 假 provider：只计数、只回鉴权失败。auth_failed 不在重发名单里，一次就落终态。 */
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

let home = ''
let root = ''
let prevHome: string | undefined

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'qywork-sched-'))
  prevHome = process.env.QYWORK_HOME
  home = await mkdtemp(join(tmpdir(), 'qywork-sched-home-'))
  process.env.QYWORK_HOME = home
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
  await writeFile(configPath(), JSON.stringify(config), 'utf8')
})

afterAll(async () => {
  // 同一个进程里跑着别的测试文件，QYWORK_HOME 不还回去会跟着漏过去。
  if (prevHome === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = prevHome
  provider.stop(true)
  await rm(root, { recursive: true, force: true }).catch(() => {})
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

async function waitFor<T>(read: () => T | null, note: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${note}`)
    await Bun.sleep(20)
  }
}

/** 一条已经到期的间隔任务。 */
function dueSchedule(store: Store, workspaceRoot: string, title: string): string {
  const s = createSchedule(store, workspaceRoot, {
    title,
    prompt: `执行 ${title}`,
    kind: 'interval',
    everyMinutes: 1,
  })
  store.db.query('UPDATE schedules SET created_at = ? WHERE id = ?').run(Date.now() - 120_000, s.id)
  return s.id
}

function countOf(store: Store, sql: string): number {
  return store.db.query<{ n: number }, []>(sql).get()?.n ?? 0
}

/** 模型工具的读法：端口按会话工作区收窄，与 `runtime/session.ts` 的注入同形。 */
async function listViaTool(store: Store, workspaceRoot: string): Promise<string> {
  const registry = new ToolRegistry()
  registerBuiltinTools(registry)
  const spec = registry.get('list_schedules')
  if (!spec) throw new Error('list_schedules 没有注册')
  const ctx: ToolContext = {
    workspaceRoot,
    conversationId: 'cv_probe',
    runId: 'rn_probe',
    model: 'deepseek-v4-flash',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => true,
    schedules: {
      list: () => listSchedules(store, workspaceRoot, Date.now()),
      create: () => {
        throw new Error('本次只读')
      },
      remove: () => null,
    },
  }
  return (await spec.fn({}, ctx)).message ?? ''
}

test('E04：以 A 启动的服务照样触发 B 的到期任务，401 终态在 API、模型工具与刷新后一致', async () => {
  const dirA = await mkdtemp(join(root, 'a-'))
  const dirB = await mkdtemp(join(root, 'b-'))
  const store = new Store({ path: join(root, 'e04.sqlite3') })
  const wsA = upsertWorkspace(store, dirA, 'A')
  const wsB = upsertWorkspace(store, dirB, 'B')
  const scheduleId = dueSchedule(store, dirB, 'B 的日报')

  const handle = serve({
    store,
    config: await loadConfig(),
    workspaceRoot: dirA,
    port: 0,
    host: '127.0.0.1',
    // 真实计时器驱动生产的推进函数；测试不直接调 tickSchedules。
    schedulerTickMs: 40,
  })
  const auth = { authorization: `Bearer ${handle.token}` }
  let runId = ''

  try {
    const run = await waitFor(
      () =>
        store.db
          .query<
            {
              id: string
              status: string
              error_code: string | null
              error_message: string | null
              workspace_id: string
            },
            []
          >(
            `SELECT r.id AS id, r.status AS status, r.error_code AS error_code,
                    r.error_message AS error_message, r.workspace_id AS workspace_id
             FROM runs r WHERE r.status NOT IN ('queued','running')`,
          )
          .get(),
      '定时任务的 Run 落终态',
    )

    runId = run.id
    // 触发发生在 B，而不是服务启动时挂着的 A。
    expect(run.workspace_id).toBe(wsB.id)
    expect(run.status).toBe('failed')
    expect(run.error_code).toBe('auth_failed')
    expect(run.error_message ?? '').not.toBe('')
    expect(countOf(store, 'SELECT COUNT(*) AS n FROM conversations')).toBe(1)

    type Payload = {
      schedules: {
        id: string
        lastRun: {
          conversationId: string
          runId: string | null
          status: string | null
          errorMessage: string | null
        } | null
      }[]
    }
    const fetchB = async (): Promise<Payload> =>
      (await (
        await fetch(`http://127.0.0.1:${handle.port}/api/schedules?ws=${wsB.id}`, { headers: auth })
      ).json()) as Payload

    const first = await fetchB()
    expect(first.schedules.length).toBe(1)
    expect(first.schedules[0]!.id).toBe(scheduleId)
    expect(first.schedules[0]!.lastRun).toEqual({
      conversationId: expect.any(String),
      runId: run.id,
      status: 'failed',
      errorMessage: run.error_message,
    })

    // 刷新读到同一份：投影每次现算，没有第二本缓存的错误账。
    expect(await fetchB()).toEqual(first)

    // 模型工具读到同一个终态。
    const toolText = await listViaTool(store, dirB)
    expect(toolText).toContain('B 的日报')
    expect(toolText).toContain('失败：')
    expect(toolText).toContain((run.error_message ?? '').split('\n')[0]!)

    // A 的面板看不到 B 的任务。
    const forA = (await (
      await fetch(`http://127.0.0.1:${handle.port}/api/schedules?ws=${wsA.id}`, { headers: auth })
    ).json()) as Payload
    expect(forA.schedules).toEqual([])
  } finally {
    handle.stop()
    store.close()
  }

  // 重启：投影没有进程内缓存，换一个连接读同一个库应当得到同一份终态。
  const reopened = new Store({ path: join(root, 'e04.sqlite3') })
  try {
    const after = listSchedules(reopened, dirB, Date.now())[0]!
    expect(after.lastRun?.status).toBe('failed')
    expect(after.lastRun?.runId).toBe(runId)
  } finally {
    reopened.close()
  }
}, 30_000)

test('PUT 是部分更新：只发 enabled 不带时刻，启停不被判成不合法', async () => {
  const dir = await mkdtemp(join(root, 'put-'))
  const store = new Store({ path: join(root, 'put.sqlite3') })
  const ws = upsertWorkspace(store, dir, 'W')
  const interval = createSchedule(store, dir, {
    title: '每五分钟',
    prompt: 'p',
    kind: 'interval',
    everyMinutes: 5,
  })
  const daily = createSchedule(store, dir, {
    title: '每天九点',
    prompt: 'p',
    kind: 'daily',
    atHour: 9,
    atMinute: 30,
  })

  const handle = serve({
    store,
    config: await loadConfig(),
    workspaceRoot: dir,
    port: 0,
    host: '127.0.0.1',
    // tick 拉到很长：这条只验 HTTP 面，不该被自动触发插进来改游标。
    schedulerTickMs: 3_600_000,
  })
  const put = (id: string, body: unknown) =>
    fetch(`http://127.0.0.1:${handle.port}/api/schedules/${id}?ws=${ws.id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${handle.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  try {
    expect((await put(interval.id, { enabled: false })).status).toBe(200)
    expect((await put(daily.id, { enabled: false })).status).toBe(200)

    const rows = listSchedules(store, dir, Date.now())
    const one = rows.find((r) => r.id === interval.id)!
    const two = rows.find((r) => r.id === daily.id)!
    expect(one.enabled).toBe(false)
    expect(one.everyMinutes).toBe(5)
    expect(two.enabled).toBe(false)
    expect(two.atHour).toBe(9)
    expect(two.atMinute).toBe(30)

    // 切触发方式：与新 kind 无关的旧字段写 NULL，不留一个不再生效的时刻。
    expect((await put(interval.id, { kind: 'daily', atHour: 9, atMinute: 0 })).status).toBe(200)
    const switched = store.db
      .query<{ kind: string; every_minutes: number | null; at_hour: number | null }, [string]>(
        'SELECT kind, every_minutes, at_hour FROM schedules WHERE id = ?',
      )
      .get(interval.id)
    expect(switched).toEqual({ kind: 'daily', every_minutes: null, at_hour: 9 })
  } finally {
    handle.stop()
    store.close()
  }
}, 30_000)

test('一条起轮失败不影响同一批里后面那条：认领已提交，跳过就是静默丢一次触发', async () => {
  const dir = await mkdtemp(join(root, 'isolate-'))
  const store = new Store({ path: join(root, 'isolate.sqlite3') })
  upsertWorkspace(store, dir, 'W')
  const first = dueSchedule(store, dir, '先跑的')
  const second = dueSchedule(store, dir, '后跑的')

  const started: string[] = []
  const lines: string[] = []
  const originalWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write

  try {
    await tickSchedules({
      store,
      config: await loadConfig(),
      start: async (conversationId, prompt) => {
        started.push(prompt)
        if (prompt.includes('先跑的')) throw new Error('装配失败')
        void conversationId
      },
    })
  } finally {
    process.stderr.write = originalWrite
  }

  try {
    // 两条都起过轮：抛错那条没有把另一条一起跳掉。同一毫秒建的两条按 id 排，顺序不作断言。
    expect(started.length).toBe(2)
    expect(started).toContain('执行 先跑的')
    expect(started).toContain('执行 后跑的')
    // 失败那条单独一行，带得出是哪一条任务。
    const failure = lines.find((l) => l.includes('起轮失败'))
    expect(failure).toContain('先跑的')
    expect(failure).toContain(first)
    expect(lines.filter((l) => l.includes('起轮失败')).length).toBe(1)
    // 两条的认领都已提交：游标推进、会话建好，投影按「没有执行记录」显示。
    const views = listSchedules(store, dir, Date.now())
    expect(views.map((v) => v.id).sort()).toEqual([first, second].sort())
    for (const v of views) {
      expect(v.lastRunAt).toBeGreaterThan(0)
      expect(v.lastRun?.runId).toBe(null)
    }
  } finally {
    store.close()
  }
})

test('E05：同一到期时机两个 serve() 实例只产生一条会话、一条 Run、一次模型请求', async () => {
  const dir = await mkdtemp(join(root, 'race-'))
  const dbPath = join(root, 'e05.sqlite3')
  const seed = new Store({ path: dbPath })
  upsertWorkspace(seed, dir, 'W')
  dueSchedule(seed, dir, '只该跑一次')
  seed.close()

  const before = providerCalls
  const one = new Store({ path: dbPath })
  const two = new Store({ path: dbPath })
  const config = await loadConfig()
  const a = serve({
    store: one,
    config,
    workspaceRoot: dir,
    port: 0,
    host: '127.0.0.1',
    schedulerTickMs: 40,
  })
  const b = serve({
    store: two,
    config,
    workspaceRoot: dir,
    port: 0,
    host: '127.0.0.1',
    schedulerTickMs: 40,
  })

  try {
    await waitFor(
      () =>
        one.db
          .query<{ id: string }, []>("SELECT id FROM runs WHERE status NOT IN ('queued','running')")
          .get(),
      '两个实例中有一个把 Run 跑到终态',
    )
    // 落终态之后再多等几个 tick：漏掉的第二次触发要在这段时间里显形。
    await Bun.sleep(300)

    expect(countOf(one, 'SELECT COUNT(*) AS n FROM conversations')).toBe(1)
    expect(countOf(one, 'SELECT COUNT(*) AS n FROM runs')).toBe(1)
    expect(providerCalls - before).toBe(1)
  } finally {
    a.stop()
    b.stop()
    one.close()
    two.close()
  }
}, 30_000)
