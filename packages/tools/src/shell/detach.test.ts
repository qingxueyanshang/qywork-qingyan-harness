/**
 * 覆盖 `shell/detach.ts` 的 `backgroundable`。
 *
 * 原始失败形状：生成、画布运行、制作文档等工具不读取用户消息的信号，执行期间插入的消息要等工具结束才送达，
 * 视频生成可达数分钟；只有运行命令会转入后台。
 */
import { expect, test } from 'bun:test'
import { openBatchBudget, Ports, provide, type ToolContext, type ToolSpec } from '@qywork/agent'
import { backgroundable, endsOnMessage } from './detach.ts'
import { CommandPort } from './port.ts'

type Adopted = Parameters<CommandPort['adopt']>[0]

function harness(steered: Promise<void>) {
  const adopted: Adopted[] = []
  const port = {
    steered: () => steered,
    adopt: (task: Adopted) => {
      adopted.push(task)
      return 'task_1'
    },
    list: () => [],
    output: () => null,
    stop: () => null,
    write: () => null,
    ended: () => null,
  } satisfies CommandPort
  const run = new AbortController()
  const ctx = {
    workspaceRoot: '.',
    conversationId: 'cv',
    runId: 'rn',
    model: 'm',
    stepId: 'st_1',
    contextWindow: 1000,
    state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY, 0),
    sink: null,
    port: new Ports([provide(CommandPort, port)]).get,
    signal: run.signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
  } as unknown as ToolContext
  return { adopted, ctx, run }
}

/** 由测试控制何时结束的工具；记录它收到的中止信号。 */
function slowTool() {
  let finish!: (message: string) => void
  let seen: AbortSignal | undefined
  const spec = {
    name: 'slow',
    fn: (_args: Record<string, unknown>, ctx: ToolContext) => {
      seen = ctx.signal
      return new Promise((resolve) => {
        finish = (message) => resolve({ status: 'success', message })
        ctx.signal.addEventListener('abort', () =>
          resolve({ status: 'failure', message: '已中止' }),
        )
      })
    },
  } as unknown as ToolSpec
  return { spec, finish: (m: string) => finish(m), signal: () => seen! }
}

test('执行期间收到「调整方向」消息：登记到后台任务表并立即返回，结束时的回执写明任务说明与结果', async () => {
  const { adopted, ctx } = harness(Promise.resolve())
  const tool = slowTool()
  const out = await backgroundable(tool.spec, () => '运行生成卡「封面」').fn({}, ctx)
  expect(out.status).toBe('success')
  expect(out.message).toContain('执行期间用户发来调整方向的消息')
  expect(out.message).toContain('任务编号 task_1')
  expect(adopted).toHaveLength(1)
  expect(adopted[0]!.command).toBe('运行生成卡「封面」')
  expect(adopted[0]!.stepId).toBe('st_1')
  tool.finish('已取得结果：cover.mp4')
  expect((await adopted[0]!.settled).receipt).toBe('运行生成卡「封面」：已取得结果：cover.mp4')
})

test('转入后台的执行失败或抛出时，回执在任务说明之后写明失败与原因', async () => {
  /** 晚于「调整方向」的消息结束的工具：结束前先让出一次计时器。 */
  const later = (end: () => never | { status: 'failure'; message: string }) =>
    ({
      name: 'later',
      fn: async () => {
        await new Promise((r) => setTimeout(r, 0))
        return end()
      },
    }) as unknown as ToolSpec

  const failing = harness(Promise.resolve())
  await backgroundable(
    later(() => ({ status: 'failure', message: '文件已被占用' })),
    () => '制作文档 report.docx',
  ).fn({}, failing.ctx)
  expect((await failing.adopted[0]!.settled).receipt).toBe(
    '制作文档 report.docx：失败，文件已被占用',
  )

  const throwing = harness(Promise.resolve())
  await backgroundable(
    later(() => {
      throw new Error('ENOENT')
    }),
    () => '生成图片',
  ).fn({}, throwing.ctx)
  expect((await throwing.adopted[0]!.settled).receipt).toBe('生成图片：失败，ENOENT')
})

test('转入后台之后本轮停止不再中止执行；任务表停止时中止且不送回执', async () => {
  const { adopted, ctx, run } = harness(Promise.resolve())
  const tool = slowTool()
  await backgroundable(tool.spec, () => '生成视频').fn({}, ctx)
  run.abort()
  expect(tool.signal().aborted).toBe(false)
  adopted[0]!.stop()
  expect(tool.signal().aborted).toBe(true)
  expect((await adopted[0]!.settled).receipt).toBeNull()
})

test('先于消息结束时原样返回结果，不登记任务；转入后台之前本轮停止仍中止执行', async () => {
  const never = new Promise<never>(() => {})
  const done = harness(never)
  const quick = slowTool()
  const pending = backgroundable(quick.spec, () => '读取文档').fn({}, done.ctx)
  quick.finish('读取完成')
  expect((await pending).message).toBe('读取完成')
  expect(done.adopted).toEqual([])

  const stop = harness(never)
  const slow = slowTool()
  const waiting = backgroundable(slow.spec, () => '读取文档').fn({}, stop.ctx)
  stop.run.abort()
  expect((await waiting).message).toBe('已中止')
})

test('纯等待收到消息时结束等待并返回下一步，不登记任务', async () => {
  const { adopted, ctx } = harness(Promise.resolve())
  const tool = slowTool()
  const out = await endsOnMessage(tool.spec, '先用 browser_observe 确认页面状态').fn({}, ctx)
  expect(out.status).toBe('success')
  expect(out.message).toBe(
    '等待期间用户发来调整方向的消息，已结束等待；先用 browser_observe 确认页面状态',
  )
  expect(tool.signal().aborted).toBe(true)
  expect(adopted).toEqual([])
})
