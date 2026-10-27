/**
 * 系统电源。**覆盖范围**：`power.ts` 的 `startPowerGuard`，以及 `server.ts` 中忙态与下次触发时刻的装配。
 *
 * 系统接口以假端口代替：回归测试不应向本机系统登记请求与唤醒定时器。Windows 上的系统调用以
 * `powercfg /requests` 与 `powercfg /waketimers` 人工核对。
 *
 * 装配用例直接复现原始失败形状：定时任务触发的一轮正在运行时没有阻止睡眠的请求，下一次触发时刻
 * 没有唤醒定时器。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configPath, loadConfig, type QyConfig } from '@qywork/runtime'
import { createConversation, createSchedule, Store, upsertWorkspace } from '@qywork/store'
import { type PowerPort, startPowerGuard } from './power.ts'
import { serve } from './server.ts'

/** 记录系统当前状态的假端口：断言的是状态，不是调用次数。 */
function fakePort(): PowerPort & { held: boolean; wake: number | null } {
  const port = {
    held: false,
    wake: null as number | null,
    hold(on: boolean) {
      port.held = on
    },
    wakeAt(at: number | null) {
      port.wake = at
    },
  }
  return port
}

test('忙碌时持有请求、空闲时释放，唤醒时刻跟随下次触发，停止时全部收回', () => {
  const port = fakePort()
  let busy = false
  let next: number | null = 1_000
  const guard = startPowerGuard({ busy: () => busy, nextWakeAt: () => next, port }, 3_600_000)
  expect(port).toMatchObject({ held: false, wake: 1_000 })

  busy = true
  next = 2_000
  guard.sync()
  expect(port).toMatchObject({ held: true, wake: 2_000 })

  busy = false
  next = null
  guard.sync()
  expect(port).toMatchObject({ held: false, wake: null })

  busy = true
  next = 3_000
  guard.sync()
  guard.stop()
  expect(port).toMatchObject({ held: false, wake: null })
})

test('读取失败不终止同步，下一次读取成功后照常生效', () => {
  const port = fakePort()
  let broken = true
  const guard = startPowerGuard(
    {
      busy: () => {
        if (broken) throw new Error('账本已关闭')
        return true
      },
      nextWakeAt: () => null,
      port,
    },
    3_600_000,
  )
  expect(port.held).toBe(false)
  broken = false
  guard.sync()
  expect(port.held).toBe(true)
  guard.stop()
})

// ─────────────────────────── 装配 ───────────────────────────

/** 收到请求后挂起，直到测试放行；放行后返回 401，一次即进入终态。 */
let release: () => void = () => {}
const gate = new Promise<void>((resolve) => {
  release = resolve
})
const provider = Bun.serve({
  port: 0,
  async fetch() {
    await gate
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
  root = await mkdtemp(join(tmpdir(), 'qywork-power-'))
  prevHome = process.env.QYWORK_HOME
  home = await mkdtemp(join(tmpdir(), 'qywork-power-home-'))
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
  release()
  provider.stop(true)
  await rm(root, { recursive: true, force: true }).catch(() => {})
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

async function waitFor(ok: () => boolean, note: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${note}`)
    await Bun.sleep(20)
  }
}

test('定时任务触发的一轮运行期间阻止睡眠，结束后释放；唤醒时刻为该任务的下次触发', async () => {
  const dir = await mkdtemp(join(root, 'ws-'))
  const store = new Store({ path: join(root, 'power.sqlite3') })
  const ws = upsertWorkspace(store, dir, '定时')
  const conversation = createConversation(store, {
    workspaceId: ws.id,
    provider: 'fake',
    model: 'deepseek-v4-flash',
    title: '排任务的会话',
  })
  const made = createSchedule(
    store,
    dir,
    { title: '每分钟一次', prompt: '汇报一次。', kind: 'interval', everyMinutes: 1 },
    conversation.id,
  )
  store.db
    .query('UPDATE schedules SET created_at = ? WHERE id = ?')
    .run(Date.now() - 120_000, made.id)

  const port = fakePort()
  const handle = serve({
    store,
    config: await loadConfig(),
    workspaceRoot: dir,
    port: 0,
    host: '127.0.0.1',
    schedulerTickMs: 40,
    power: port,
    powerTickMs: 20,
  })
  try {
    await waitFor(() => port.held, '触发的一轮开始后持有请求')
    const lastRunAt = store.db
      .query<{ t: number }, [string]>('SELECT last_run_at AS t FROM schedules WHERE id = ?')
      .get(made.id)!.t
    await waitFor(() => port.wake === lastRunAt + 60_000, '唤醒时刻为下次触发')

    release()
    await waitFor(() => !port.held, '该轮结束后释放请求')
  } finally {
    await handle.stop()
    store.close()
  }
  expect(port).toMatchObject({ held: false, wake: null })
})
