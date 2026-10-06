/**
 * 定时任务的完整触发链路。**覆盖范围**：`scheduler.ts` 与 `api/schedules.ts`，
 * 并经过 `store/schedules.ts` 的认领事务、`run-control.ts` 的投递与 `tools/schedules.ts` 的
 * 模型工具投影。
 *
 * 四条断言直接复现原始失败形状：
 *
 * - 服务以工作区 A 启动，工作区 B 的到期任务同样触发；模型返回 401 之后，任务 API、
 *   `list_schedules` 工具与再次读取（刷新）得到同一个 Run 终态。
 * - 同一到期时机两个 `serve()` 实例只产生一条会话、一条 Run、一次模型请求。
 * - 目标会话已被进程内占位时，本次触发排入跟进队列，而不是产生一条 `run.error`。
 * - 认领新建会话时广播 `conversation.created`，信封上不带会话归属。
 *
 * 使用真实计时器：两条均由 `serve()` 自身的 `setInterval` 驱动，测试不直接调用推进函数。
 * 只注入 tick 间隔与假 provider 的响应。
 *
 * 单进程内的两个实例无法真正交错执行（认领事务是同步的），跨操作系统进程的竞争由
 * `schedule-race.test.ts` 覆盖。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@qywork/agent'
import { ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import type { ConversationId, EventEnvelope, WorkspaceId } from '@qywork/core'
import { configPath, loadConfig, type QyConfig } from '@qywork/runtime'
import {
  createConversation,
  createSchedule,
  listSchedules,
  type ScheduleClaim,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import { registerBuiltinTools } from '@qywork/tools'
import { tickSchedules } from './scheduler.ts'
import { serve } from './server.ts'

/** 401 假 provider：只计数，只返回鉴权失败。auth_failed 不在重发列表中，一次请求即进入终态。 */
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
  // 同一进程中还运行其他测试文件，不恢复 QYWORK_HOME 会影响它们。
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

/** 创建任务的会话。任务绑定该会话，触发时消息发送到该会话。 */
function homeConversation(store: Store, workspaceId: WorkspaceId, title: string): ConversationId {
  return createConversation(store, {
    workspaceId,
    provider: 'fake',
    model: 'deepseek-v4-flash',
    title,
  }).id
}

/** 已到期的间隔任务，绑定到给定会话。 */
function dueSchedule(
  store: Store,
  workspaceRoot: string,
  title: string,
  home: ConversationId,
  draft: { newConversation?: boolean } = {},
): string {
  const s = createSchedule(
    store,
    workspaceRoot,
    { title, prompt: `执行 ${title}`, kind: 'interval', everyMinutes: 1, ...draft },
    home,
  )
  store.db.query('UPDATE schedules SET created_at = ? WHERE id = ?').run(Date.now() - 120_000, s.id)
  return s.id
}

function countOf(store: Store, sql: string): number {
  return store.db.query<{ n: number }, []>(sql).get()?.n ?? 0
}

/** 模型工具的读取方式：端口按会话工作区限定范围，与 `runtime/session.ts` 的注入方式相同。 */
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
    requestPermission: async () => ({ allowed: true }),
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

test('E04：以 A 启动的服务同样触发 B 的到期任务，401 终态在 API、模型工具与刷新后一致', async () => {
  const dirA = await mkdtemp(join(root, 'a-'))
  const dirB = await mkdtemp(join(root, 'b-'))
  const store = new Store({ path: join(root, 'e04.sqlite3') })
  const wsA = upsertWorkspace(store, dirA, 'A')
  const wsB = upsertWorkspace(store, dirB, 'B')
  const homeB = homeConversation(store, wsB.id, 'B 排任务的会话')
  const scheduleId = dueSchedule(store, dirB, 'B 的日报', homeB)

  const handle = serve({
    store,
    config: await loadConfig(),
    workspaceRoot: dirA,
    port: 0,
    host: '127.0.0.1',
    // 由真实计时器驱动生产代码的推进函数；测试不直接调用 tickSchedules。
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
              conversation_id: string
            },
            []
          >(
            `SELECT r.id AS id, r.status AS status, r.error_code AS error_code,
                    r.error_message AS error_message, r.workspace_id AS workspace_id,
                    r.conversation_id AS conversation_id
             FROM runs r WHERE r.status NOT IN ('queued','running')`,
          )
          .get(),
      '定时任务的 Run 落终态',
    )

    runId = run.id
    // 触发发生在 B，而不是服务启动时所用的 A。
    expect(run.workspace_id).toBe(wsB.id)
    expect(run.status).toBe('failed')
    expect(run.error_code).toBe('auth_failed')
    expect(run.error_message ?? '').not.toBe('')
    // 该轮在创建任务的会话中运行，没有新建会话。
    expect(run.conversation_id).toBe(homeB)
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

    // 刷新后读取到相同结果：投影每次实时计算，不存在另一份缓存。
    expect(await fetchB()).toEqual(first)

    // 模型工具读到同一个终态。
    const toolText = await listViaTool(store, dirB)
    expect(toolText).toContain('B 的日报')
    expect(toolText).toContain('失败：')
    expect(toolText).toContain((run.error_message ?? '').split('\n')[0]!)

    // A 的面板不显示 B 的任务。
    const forA = (await (
      await fetch(`http://127.0.0.1:${handle.port}/api/schedules?ws=${wsA.id}`, { headers: auth })
    ).json()) as Payload
    expect(forA.schedules).toEqual([])
  } finally {
    handle.stop()
    store.close()
  }

  // 重启：投影没有进程内缓存，使用新连接读取同一数据库应得到相同的终态。
  const reopened = new Store({ path: join(root, 'e04.sqlite3') })
  try {
    const after = listSchedules(reopened, dirB, Date.now())[0]!
    expect(after.lastRun?.status).toBe('failed')
    expect(after.lastRun?.runId).toBe(runId)
  } finally {
    reopened.close()
  }
}, 30_000)

test('PUT 是部分更新：只发送 enabled 而不带时刻时，启停不被判定为不合法', async () => {
  const dir = await mkdtemp(join(root, 'put-'))
  const store = new Store({ path: join(root, 'put.sqlite3') })
  const ws = upsertWorkspace(store, dir, 'W')
  const home = homeConversation(store, ws.id, '排任务的会话')
  const interval = createSchedule(
    store,
    dir,
    { title: '每五分钟', prompt: 'p', kind: 'interval', everyMinutes: 5 },
    home,
  )
  const daily = createSchedule(
    store,
    dir,
    { title: '每天九点', prompt: 'p', kind: 'daily', atHour: 9, atMinute: 30 },
    home,
  )

  const handle = serve({
    store,
    config: await loadConfig(),
    workspaceRoot: dir,
    port: 0,
    host: '127.0.0.1',
    // tick 间隔设为很长：本用例只验证 HTTP 接口，不应由自动触发修改游标。
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

    // 切换触发方式：与新 kind 无关的旧字段写入 NULL，不保留不再生效的时刻。
    expect((await put(interval.id, { kind: 'daily', atHour: 9, atMinute: 0 })).status).toBe(200)
    const switched = store.db
      .query<{ kind: string; every_minutes: number | null; at_hour: number | null }, [string]>(
        'SELECT kind, every_minutes, at_hour FROM schedules WHERE id = ?',
      )
      .get(interval.id)
    expect(switched).toEqual({ kind: 'daily', every_minutes: null, at_hour: 9 })

    // 绑定会话与「每次新建会话」不接受客户端改写。
    expect(
      (await put(interval.id, { conversationId: 'cv_forged', newConversation: true })).status,
    ).toBe(200)
    const kept = listSchedules(store, dir, Date.now()).find((r) => r.id === interval.id)!
    expect(kept.conversationId).toBe(home)
    expect(kept.newConversation).toBe(false)
  } finally {
    handle.stop()
    store.close()
  }
}, 30_000)

test('一条投递失败不影响同一批中的后一条：认领已提交，跳过即静默丢失一次触发', async () => {
  const dir = await mkdtemp(join(root, 'isolate-'))
  const store = new Store({ path: join(root, 'isolate.sqlite3') })
  const ws = upsertWorkspace(store, dir, 'W')
  const home = homeConversation(store, ws.id, '排任务的会话')
  const first = dueSchedule(store, dir, '先跑的', home)
  const second = dueSchedule(store, dir, '后跑的', home)

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
      submit: async (claim: ScheduleClaim) => {
        started.push(claim.schedule.prompt)
        if (claim.schedule.prompt.includes('先跑的')) throw new Error('装配失败')
      },
    })
  } finally {
    process.stderr.write = originalWrite
  }

  try {
    // 两条均已投递：抛错的一条未导致另一条被跳过。同一毫秒创建的两条按 id 排序，不对顺序作断言。
    expect(started.length).toBe(2)
    expect(started).toContain('执行 先跑的')
    expect(started).toContain('执行 后跑的')
    // 失败的任务在日志中单独记录一行，能够识别是哪一条任务。
    const failure = lines.find((l) => l.includes('启动失败'))
    expect(failure).toContain('先跑的')
    expect(failure).toContain(first)
    expect(lines.filter((l) => l.includes('启动失败')).length).toBe(1)
    // 两条的认领均已提交：游标已推进、会话已确定，投影按「没有执行记录」显示。
    const views = listSchedules(store, dir, Date.now())
    expect(views.map((v) => v.id).sort()).toEqual([first, second].sort())
    for (const v of views) {
      expect(v.lastRunAt).toBeGreaterThan(0)
      expect(v.conversationId).toBe(home)
      expect(v.lastRun?.runId).toBe(null)
    }
  } finally {
    store.close()
  }
})

/**
 * 「立即运行」与 tick 使用同一个投递函数，因此作为以下两条断言的确定性入口：
 * tick 由计时器驱动，无法在占位步骤中插入操作。
 */
function collectFrames(handle: ReturnType<typeof serve>): {
  frames: EventEnvelope[]
  stop(): void
} {
  const frames: EventEnvelope[] = []
  const stop = handle.bus.subscribe({
    id: `probe_${crypto.randomUUID()}`,
    origin: 'cli',
    conversations: null,
    send: (frame) => {
      frames.push(frame)
    },
  })
  return { frames, stop }
}

/*
 * 原始失败形状：触发时用户恰好在该会话中发送了消息，直接启动一轮会被进程内占位拒绝，
 * 产生一条 `run.error`，本次触发随之丢失。经由用户消息入口时，触发排入跟进队列。
 *
 * 只占位而不写入 run 行，对应 `startRun` 中「reserve 成功、runId 尚未取得」的阶段：
 * 认领事务查询 runs 表无法判定会话忙碌，唯一的判定依据是 `runs.hasRun`。
 */
test('目标会话正忙时触发排入跟进队列，不产生 run.error', async () => {
  const dir = await mkdtemp(join(root, 'busy-'))
  const store = new Store({ path: join(root, 'busy.sqlite3') })
  const ws = upsertWorkspace(store, dir, 'W')
  const home = homeConversation(store, ws.id, '排任务的会话')
  const scheduleId = dueSchedule(store, dir, '忙的时候到点', home)

  const handle = serve({
    store,
    config: await loadConfig(),
    workspaceRoot: dir,
    port: 0,
    host: '127.0.0.1',
    // tick 间隔设为很长：本用例使用「立即运行」，不应插入自动触发。
    schedulerTickMs: 3_600_000,
  })

  try {
    expect(handle.runs.reserve(home)).toBe(true)
    const probe = collectFrames(handle)
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/schedules/${scheduleId}/run?ws=${ws.id}`,
      { method: 'POST', headers: { authorization: `Bearer ${handle.token}` } },
    )
    expect(res.status).toBe(200)
    // 投递不等待结果（fire-and-forget），此处等待微任务队列清空。
    await Bun.sleep(50)
    probe.stop()

    expect(probe.frames.filter((f) => f.event.type === 'run.error')).toEqual([])
    const queued = probe.frames.find((f) => f.event.type === 'queue.changed')?.event
    expect(queued?.type === 'queue.changed' && queued.queue.map((q) => q.content)).toEqual([
      '执行 忙的时候到点',
    ])
  } finally {
    handle.stop()
    store.close()
  }
}, 30_000)

/*
 * 左栏必须立即显示该会话。`conversation.created` 是**工作区级**事件：信封不带
 * conversationId，否则只有已订阅该会话的客户端能收到，而列表中尚无该会话。
 */
test('认领新建会话时广播 conversation.created，信封不带会话归属', async () => {
  const dir = await mkdtemp(join(root, 'created-'))
  const store = new Store({ path: join(root, 'created.sqlite3') })
  const ws = upsertWorkspace(store, dir, 'W')
  const home = homeConversation(store, ws.id, '排任务的会话')
  const scheduleId = dueSchedule(store, dir, '每次新建会话的那条', home, { newConversation: true })

  const handle = serve({
    store,
    config: await loadConfig(),
    workspaceRoot: dir,
    port: 0,
    host: '127.0.0.1',
    schedulerTickMs: 3_600_000,
  })

  try {
    const probe = collectFrames(handle)
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/schedules/${scheduleId}/run?ws=${ws.id}`,
      { method: 'POST', headers: { authorization: `Bearer ${handle.token}` } },
    )
    expect(res.status).toBe(200)
    await Bun.sleep(50)
    probe.stop()

    const hit = probe.frames.find((f) => f.event.type === 'conversation.created')
    expect(hit).toBeDefined()
    expect(hit?.conversationId).toBe(undefined)
    const created = hit?.event.type === 'conversation.created' ? hit.event.conversation : null
    expect(created?.workspaceId).toBe(ws.id)
    expect(created?.id).not.toBe(home)
    // 广播的会话即本次触发进入的会话，账本中记录的也是该会话。
    expect(listSchedules(store, dir, Date.now())[0]!.conversationId).toBe(created?.id)
  } finally {
    handle.stop()
    store.close()
  }
}, 30_000)

test('E05：同一到期时机两个 serve() 实例只产生一条会话、一条 Run、一次模型请求', async () => {
  const dir = await mkdtemp(join(root, 'race-'))
  const dbPath = join(root, 'e05.sqlite3')
  const seed = new Store({ path: dbPath })
  const ws = upsertWorkspace(seed, dir, 'W')
  dueSchedule(seed, dir, '只该跑一次', homeConversation(seed, ws.id, '排任务的会话'))
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
    // 进入终态后再等待几个 tick：若存在第二次触发，会在这段时间内出现。
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
