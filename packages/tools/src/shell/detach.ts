import type { ToolOutcome, ToolSpec } from '@qywork/agent'
import { CommandPort } from './port.ts'

/**
 * 可转入后台的工具：执行期间本会话收到用户的「调整方向」消息时（`CommandPort.steered`），
 * 把这次执行登记到后台任务表并立即返回；执行照常进行，结束时以回执送达，
 * 可经 `background_command` 读取、等待与停止。没有后台任务端口（成员会话、命令行）时照常等待。
 *
 * 用于生成、画布运行与取回、导出成片、制作文档、浏览器下载：它们的执行可能超过命令的前台等待上限，
 * 且执行不依赖当前这一步，可以脱离本轮继续。
 *
 * 工具收到的是本次执行自己的中止信号：转入后台之前随本轮停止而中止，转入后台之后只由任务表的停止中止。
 * 不要把本轮的 `ctx.signal` 直接交给工具：本轮结束时它中止，已转入后台的执行随之被取消。
 * 工具持有的文件锁随执行一直持有到结束，转入后台期间同一文件的写入排在其后。
 */
export function backgroundable(
  spec: ToolSpec,
  label: (args: Record<string, unknown>) => string,
): ToolSpec {
  return {
    ...spec,
    fn: async (args, ctx) => {
      const port = ctx.port(CommandPort)
      if (!port || ctx.stepId === undefined) return spec.fn(args, ctx)
      const own = new AbortController()
      const forward = () => own.abort(ctx.signal.reason)
      if (ctx.signal.aborted) own.abort(ctx.signal.reason)
      else ctx.signal.addEventListener('abort', forward, { once: true })
      const running = spec.fn(args, { ...ctx, signal: own.signal })
      const watch = new AbortController()
      let detached = false
      try {
        const first = await Promise.race([
          running.then((outcome) => ({ outcome })),
          port.steered(watch.signal).then(
            () => ({ steered: true }),
            () => new Promise<never>(() => {}),
          ),
        ])
        if ('outcome' in first) return first.outcome
        detached = true
        ctx.signal.removeEventListener('abort', forward)
        const name = label(args)
        let stopped = false
        const id = port.adopt({
          command: name,
          stepId: ctx.stepId,
          output: () => ({ stdout: '', stderr: '', dropped: { stdout: 0, stderr: 0 } }),
          input: null,
          stop: () => {
            stopped = true
            own.abort(new Error('已停止'))
          },
          settled: running.then(
            (outcome) => ({
              receipt: stopped
                ? null
                : `${name}${outcome.status === 'success' ? '' : '失败'}：${outcome.message}`,
              fileChanges: outcome.fileChanges ?? [],
            }),
            (error: unknown) => ({
              receipt: stopped
                ? null
                : `${name}失败：${error instanceof Error ? error.message : String(error)}`,
              fileChanges: [],
            }),
          ),
        })
        return detachedOutcome(name, id)
      } finally {
        watch.abort()
        if (!detached) ctx.signal.removeEventListener('abort', forward)
      }
    },
  }
}

function detachedOutcome(name: string, id: string): ToolOutcome {
  return {
    status: 'success',
    message:
      `执行期间用户发来调整方向的消息，已转入后台继续运行（${name}），任务编号 ${id}；结束时结果作为回执消息送达，` +
      '可用 background_command 读取、等待或停止',
    data: { taskId: id },
  }
}

/**
 * 纯等待的工具（浏览器等待、电脑等待）：等待期间本会话收到用户的「调整方向」消息时结束等待并返回，
 * 与等待子 agent 一致。等待本身不产生结果，没有可转入后台的任务。`advice` 是返回后的下一步（重新观察）。
 */
export function endsOnMessage(spec: ToolSpec, advice: string): ToolSpec {
  return {
    ...spec,
    fn: async (args, ctx) => {
      const port = ctx.port(CommandPort)
      if (!port) return spec.fn(args, ctx)
      const own = new AbortController()
      const forward = () => own.abort(ctx.signal.reason)
      if (ctx.signal.aborted) own.abort(ctx.signal.reason)
      else ctx.signal.addEventListener('abort', forward, { once: true })
      const running = spec.fn(args, { ...ctx, signal: own.signal })
      const watch = new AbortController()
      try {
        const first = await Promise.race([
          running.then((outcome) => ({ outcome })),
          port.steered(watch.signal).then(
            () => ({ steered: true }),
            () => new Promise<never>(() => {}),
          ),
        ])
        if ('outcome' in first) return first.outcome
        own.abort(new Error('等待已结束'))
        // 等待的结果已不再读取；它在中止之后结束，结果与异常都丢弃。
        running.catch(() => {})
        return {
          status: 'success',
          message: `等待期间用户发来调整方向的消息，已结束等待；${advice}`,
        }
      } finally {
        watch.abort()
        ctx.signal.removeEventListener('abort', forward)
      }
    },
  }
}
