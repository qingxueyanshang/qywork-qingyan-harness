/** 覆盖 server.ts 的本机更新鉴权与更新设置的读取，以及 runs/commands 的更新与任务互斥。 */
import { expect, spyOn, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QyConfig } from '@qywork/runtime'
import { Store } from '@qywork/store'
import { CanvasDocs } from './canvas/docs.ts'
import { handleCommand } from './commands.ts'
import type { CommandDeps } from './deps.ts'
import { serve } from './server.ts'

test('配对令牌不能取得更新占位；宿主占位后新指令被明确拒绝，取消后恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-api-'))
  const previousHome = process.env.QYWORK_HOME
  process.env.QYWORK_HOME = root
  const store = new Store({ path: join(root, 'data.sqlite3') })
  let completeScan!: () => void
  const scanning = new Promise<void>((resolve) => {
    completeScan = resolve
  })
  const list = CanvasDocs.prototype.list
  const scan = spyOn(CanvasDocs.prototype, 'list').mockImplementation(async function (
    this: CanvasDocs,
    root,
  ) {
    await scanning
    return list.call(this, root)
  })
  const handle = serve({
    store,
    config: { providers: {}, mode: 'auto' },
    workspaceRoot: root,
    port: 0,
    host: '127.0.0.1',
    token: 'pairing-token',
    updateHostKey: 'owner-key',
  })
  const base = `http://127.0.0.1:${handle.port}/internal/app-update`
  const request = (body: string, key = 'owner-key') =>
    fetch(base, {
      method: 'POST',
      headers: { 'x-qywork-update-key': key, Authorization: 'Bearer pairing-token' },
      body,
    })
  const claimUpdate = async () =>
    (await request('{"action":"claim"}')).json() as Promise<{ claimed: boolean; busy: number }>
  try {
    expect((await request('{"action":"claim"}', 'pairing-token')).status).toBe(401)
    expect((await request('null')).status).toBe(400)
    expect((await request('{')).status).toBe(400)
    handle.runs.reserve('busy' as never, new AbortController())
    expect(await (await request('{"action":"claim"}')).json()).toEqual({ claimed: false, busy: 2 })
    completeScan()
    let claim = await claimUpdate()
    const deadline = performance.now() + 2000
    while (claim.busy === 2 && performance.now() < deadline) {
      expect(claim.claimed).toBe(false)
      await Bun.sleep(5)
      claim = await claimUpdate()
    }
    expect(claim).toEqual({ claimed: false, busy: 1 })
    handle.runs.release('busy' as never)
    expect(await (await request('{"action":"claim"}')).json()).toEqual({ claimed: true, busy: 0 })
    const frames: string[] = []
    const deps = {
      runs: handle.runs,
      ws: { data: { authed: true }, send: (value: string) => frames.push(value) },
    } as unknown as CommandDeps
    await handleCommand(
      {
        type: 'message.send',
        conversationId: 'new' as never,
        content: 'hello',
        clientRequestId: 'update-request',
      },
      deps,
    )
    expect(JSON.parse(frames[0]!)).toMatchObject({
      type: 'command.rejected',
      reason: 'conflict',
      clientRequestId: 'update-request',
    })
    expect(handle.runs.reserve('new' as never, new AbortController())).toBe(false)
    await request('{"action":"cancel"}')
    expect(handle.runs.reserve('new' as never, new AbortController())).toBe(true)
    handle.runs.release('new' as never)
  } finally {
    completeScan()
    await handle.stop()
    scan.mockRestore()
    store.close()
    if (previousHome === undefined) delete process.env.QYWORK_HOME
    else process.env.QYWORK_HOME = previousHome
    // 临时目录由 run-tests 在测试进程退出后清理，避免与未退出的 Git 查询争用目录。
  }
})

/**
 * 外壳的自动更新只经此动作取得设置。原始失败形状：外壳自行解析 `config.json`，配置字段改名并附带迁移后，
 * 外壳一侧无法取得设置，自动更新静默停用。
 */
test('更新设置取自已加载的配置：缺省时均开启，显式关闭与运行中的修改原样返回', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-prefs-'))
  const previousHome = process.env.QYWORK_HOME
  process.env.QYWORK_HOME = root
  const store = new Store({ path: join(root, 'data.sqlite3') })
  const config: QyConfig = { providers: {}, mode: 'auto' }
  const handle = serve({
    store,
    config,
    workspaceRoot: root,
    port: 0,
    host: '127.0.0.1',
    token: 'pairing-token',
    updateHostKey: 'owner-key',
  })
  const preferences = async (key = 'owner-key') => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/app-update`, {
      method: 'POST',
      headers: { 'x-qywork-update-key': key },
      body: '{"action":"preferences"}',
    })
    return { status: res.status, body: res.status === 200 ? await res.json() : null }
  }
  try {
    expect(await preferences('pairing-token')).toEqual({ status: 401, body: null })
    expect(await preferences()).toEqual({
      status: 200,
      body: { autoCheck: true, autoDownload: true },
    })
    // 设置页保存时原地改写同一个配置对象，外壳的下一轮查询即取得新值。
    config.updates = { autoCheck: false, autoDownload: false }
    expect(await preferences()).toEqual({
      status: 200,
      body: { autoCheck: false, autoDownload: false },
    })
  } finally {
    await handle.stop()
    store.close()
    if (previousHome === undefined) delete process.env.QYWORK_HOME
    else process.env.QYWORK_HOME = previousHome
  }
})
