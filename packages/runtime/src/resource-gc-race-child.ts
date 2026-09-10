/**
 * `resource-gc-race.test.ts` 的子进程入口：四种角色各起一个操作系统进程，共享同一对库文件。
 *
 * 单进程内造不出这条竞争。锁顺序是同步代码，同一个线程里两个连接只能排队：
 * 持锁的一侧停在回调里，撞锁的一侧只能阻塞到 `busy_timeout` 上限。
 * 所以写入方、回收方、主库写入方各占一个进程，用 HTTP 屏障把起跳时刻对齐。
 *
 * 角色由 `QY_RACE_MODE` 选，参数走环境变量而不是位置参数：Windows 的命令行转义
 * 会改写含反斜杠与引号的路径，环境变量原样传。
 *
 * 每个角色在 stdout 上打**一行** JSON，父进程按行解析。时间戳一律用 `Date.now()`：
 * 跨进程比较只有它是同一把尺。
 */

import type { ConversationId, RunId } from '@qywork/core'
import { ContentStore, contentPathFor, Store, setConversationTitle } from '@qywork/store'
import { collectResourceGarbage, RuntimeSink } from './sink.ts'

const mode = process.env.QY_RACE_MODE ?? ''
const dbPath = process.env.QY_RACE_DB ?? ''
const barrier = Number(process.env.QY_RACE_BARRIER ?? '0')
const count = Number(process.env.QY_RACE_COUNT ?? '1')
const bytes = Number(process.env.QY_RACE_BYTES ?? '1024')
const durationMs = Number(process.env.QY_RACE_MS ?? '1000')
const runId = (process.env.QY_RACE_RUN ?? '') as RunId
const convId = (process.env.QY_RACE_CONV ?? '') as ConversationId

if (!dbPath) throw new Error('QY_RACE_DB 未设置')

/** 每次都换一份字节，否则内容寻址会把 N 次写入去重成一个 blob，竞争窗口只剩一个。 */
function makeBody(seq: number): Uint8Array {
  const body = new Uint8Array(bytes)
  const seed = new Uint8Array(Math.min(bytes, 64 * 1024))
  crypto.getRandomValues(seed)
  for (let off = 0; off < bytes; off += seed.length) body.set(seed.subarray(0, bytes - off), off)
  body[0] = seq & 0xff
  body[1] = (seq >> 8) & 0xff
  return body
}

async function waitAtBarrier(): Promise<void> {
  if (barrier > 0) await fetch(`http://127.0.0.1:${barrier}/ready`)
}

const store = new Store({ path: dbPath })
const content = new ContentStore(contentPathFor(dbPath))

try {
  if (mode === 'land') {
    const sink = new RuntimeSink(store, content, runId)
    // 正文在屏障之前造好：屏障放行之后的第一件事必须是 put，否则占锁窗口被生成时间稀释。
    const bodies = Array.from({ length: count }, (_, i) => makeBody(i))
    await waitAtBarrier()
    const startedAt = Date.now()
    const hashes: string[] = []
    const landMs: number[] = []
    for (const body of bodies) {
      const t = performance.now()
      hashes.push(sink.land({ toolName: 'run_command', sourceType: 'shell', body }).contentHash)
      landMs.push(Math.round(performance.now() - t))
    }
    process.stdout.write(`${JSON.stringify({ startedAt, endedAt: Date.now(), hashes, landMs })}\n`)
  } else if (mode === 'gc') {
    await waitAtBarrier()
    const startedAt = Date.now()
    const errors: string[] = []
    let iterations = 0
    let removed = 0
    let maxMs = 0
    while (Date.now() - startedAt < durationMs) {
      const t = performance.now()
      try {
        removed += collectResourceGarbage(store, content).removed
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
      maxMs = Math.max(maxMs, Math.round(performance.now() - t))
      iterations++
      // 让出一小段。不让的话这个循环会一直霸着主库写锁重排队，写入方可能整段等不到写权，
      // 5 秒的 `busy_timeout` 一过就变成 BUSY——那是测试自己造出来的饥饿，不是被测行为。
      await Bun.sleep(2)
    }
    process.stdout.write(
      `${JSON.stringify({ startedAt, endedAt: Date.now(), iterations, removed, maxMs, errors })}\n`,
    )
  } else if (mode === 'mainwrite') {
    await waitAtBarrier()
    const startedAt = Date.now()
    const errors: string[] = []
    let writes = 0
    let maxMs = 0
    while (Date.now() - startedAt < durationMs) {
      const t = performance.now()
      try {
        store.tx(() => setConversationTitle(store, convId, `t${writes}`))
        writes++
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
      maxMs = Math.max(maxMs, Math.round(performance.now() - t))
      // 与回收方同一条理由：让出一小段，写入方才拿得到写权。
      await Bun.sleep(1)
    }
    process.stdout.write(
      `${JSON.stringify({ startedAt, endedAt: Date.now(), writes, maxMs, errors })}\n`,
    )
  } else if (mode === 'die') {
    /*
     * 正文定稿之后、主库提交之前把自己杀掉。这是 `land` 事务里唯一一个「正文已落、
     * 引用未登记」的时刻，也是原始失败形状的那个窗口。
     */
    class DieAfterPut extends ContentStore {
      override put(raw: Uint8Array, resourceId?: string): ReturnType<ContentStore['put']> {
        super.put(raw, resourceId)
        process.exit(9)
      }
    }
    const dying = new DieAfterPut(contentPathFor(dbPath))
    new RuntimeSink(store, dying, runId).land({
      toolName: 'run_command',
      sourceType: 'shell',
      body: makeBody(0),
    })
    throw new Error('land 应当在 put 之后就随进程退出')
  } else {
    throw new Error(`未知角色：${mode}`)
  }
} finally {
  content.close()
  store.close()
}
