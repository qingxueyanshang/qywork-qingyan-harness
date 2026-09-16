/** 覆盖 server.ts 的本机更新鉴权，以及 runs/commands 的更新与任务互斥。 */
import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '@qywork/store'
import { handleCommand } from './commands.ts'
import type { CommandDeps } from './deps.ts'
import { serve } from './server.ts'

test('配对令牌不能取得更新占位；宿主占位后新指令被明确拒绝，取消后恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-api-'))
  const previousHome = process.env.QYWORK_HOME
  process.env.QYWORK_HOME = root
  const store = new Store({ path: join(root, 'data.sqlite3') })
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
  try {
    expect((await request('{"action":"claim"}', 'pairing-token')).status).toBe(401)
    expect((await request('null')).status).toBe(400)
    expect((await request('{')).status).toBe(400)
    handle.runs.reserve('busy' as never)
    expect(await (await request('{"action":"claim"}')).json()).toEqual({ claimed: false, busy: 1 })
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
    expect(handle.runs.reserve('new' as never)).toBe(false)
    await request('{"action":"cancel"}')
    expect(handle.runs.reserve('new' as never)).toBe(true)
    handle.runs.release('new' as never)
  } finally {
    handle.stop()
    store.close()
    if (previousHome === undefined) delete process.env.QYWORK_HOME
    else process.env.QYWORK_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
