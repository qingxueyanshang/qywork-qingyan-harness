/**
 * 生产环境的 tick 装配。**覆盖范围**：`server.ts` 不传 `schedulerTickMs` 时，`scheduler.ts`
 * 以 `SCHEDULER_TICK_MS` 登记计时器，且该计时器的回调使到期任务的 Run 进入终态。
 *
 * 它必须存在：其余调度用例都经由 `ServeOptions.schedulerTickMs` 注入毫秒级间隔，
 * 装配处未启动调度、或未注入时不使用缺省间隔，这些用例都无法发现。
 *
 * 本用例不注入间隔，也不等待真实的 tick：监视 `setInterval`，取出 `serve()` 以缺省间隔
 * 登记的回调并手动调用一次。只调用一次，验证的是装配与终态，不是间隔的精度。
 */

import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configPath, loadConfig, type QyConfig } from '@qywork/runtime'
import { createConversation, createSchedule, Store, upsertWorkspace } from '@qywork/store'
import { SCHEDULER_TICK_MS } from './scheduler.ts'
import { serve } from './server.ts'

/** 401 假 provider：`auth_failed` 不在重发名单中，一次即进入终态。 */
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
  root = await mkdtemp(join(tmpdir(), 'qywork-tick-'))
  prevHome = process.env.QYWORK_HOME
  home = await mkdtemp(join(tmpdir(), 'qywork-tick-home-'))
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
  if (prevHome === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = prevHome
  provider.stop(true)
  await rm(root, { recursive: true, force: true }).catch(() => {})
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

test('不注入间隔：生产环境的缺省 tick 使到期任务的 Run 进入终态', async () => {
  const dir = await mkdtemp(join(root, 'ws-'))
  const store = new Store({ path: join(root, 'tick.sqlite3') })
  const ws = upsertWorkspace(store, dir, '定时')
  const home = createConversation(store, {
    workspaceId: ws.id,
    provider: 'fake',
    model: 'deepseek-v4-flash',
    title: '排任务的会话',
  })
  const made = createSchedule(
    store,
    dir,
    { title: '每分钟一次', prompt: '汇报一次。', kind: 'interval', everyMinutes: 1 },
    home.id,
  )
  // 创建时即已到期：`isDue` 按 createdAt 与游标计算，回拨两分钟使第一次 tick 即可认领。
  store.db
    .query('UPDATE schedules SET created_at = ? WHERE id = ?')
    .run(Date.now() - 120_000, made.id)

  const config = await loadConfig()
  // 不替换实现：真实计时器照常登记，`handle.stop()` 负责清除。
  const timers = spyOn(globalThis, 'setInterval')
  let handle: ReturnType<typeof serve> | null = null
  try {
    handle = serve({ store, config, workspaceRoot: dir, port: 0, host: '127.0.0.1' })
    const ticks = timers.mock.calls.filter(([, ms]) => ms === SCHEDULER_TICK_MS)
    expect(ticks).toHaveLength(1)
    // 启动时不认领：终态只能由下面这次 tick 产生。
    expect(store.db.query('SELECT last_run_at FROM schedules WHERE id = ?').get(made.id)).toEqual({
      last_run_at: null,
    })

    const tick = ticks[0]![0] as () => void
    tick()

    // 短于测试的缺省时限（5 秒），使超时时报告下面的原因而不是测试超时。
    const deadline = Date.now() + 4_000
    let run: { status: string; error_code: string | null } | null = null
    while (Date.now() < deadline) {
      run =
        store.db
          .query<{ status: string; error_code: string | null }, []>(
            "SELECT status, error_code FROM runs WHERE status IN ('done','failed','interrupted') LIMIT 1",
          )
          .get() ?? null
      if (run) break
      await Bun.sleep(10)
    }
    if (!run) throw new Error('调用 tick 回调后没有进入终态的 Run')

    expect(run.status).toBe('failed')
    expect(run.error_code).toBe('auth_failed')
    expect(providerCalls).toBeGreaterThan(0)
    // 只认领一次：复用绑定的会话，只有一条 Run。
    const counts = store.db
      .query<{ conversations: number; runs: number }, []>(
        'SELECT (SELECT count(*) FROM conversations) AS conversations, (SELECT count(*) FROM runs) AS runs',
      )
      .get()
    expect(counts).toEqual({ conversations: 1, runs: 1 })
  } finally {
    timers.mockRestore()
    handle?.stop()
    store.close()
  }
})
