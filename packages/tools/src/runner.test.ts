/**
 * 命令 runner 的契约：**它只负责决定由谁作为父进程**，不承担其他职责。
 *
 * 覆盖 `runner.ts` 的两侧：启动 runner 的一侧（`startCommandRunner`）与
 * runner 自身的主循环（`runCommandRunner`）。
 *
 * **此处不验证「端口不被继承」**：验证需要启动真实监听、让父进程退出、再检查端口，
 * 是一次跨进程的手工实测，结论与实测记录写在 `runner.ts` 的模块注释中。
 * 此处锁定的是「执行结果与直接 spawn 一致」：输出、退出码、可被终止。
 */

import { describe, expect, test } from 'bun:test'
import { startCommandRunner } from './runner.ts'

/** runner 一侧的入口。正式路径是 `qy runner`，测试中直接调用该函数。 */
const RUNNER_ARGV = [
  process.execPath,
  '-e',
  `import { runCommandRunner } from ${JSON.stringify(Bun.fileURLToPath(new URL('./runner.ts', import.meta.url)))}; runCommandRunner()`,
]

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  let out = ''
  const dec = new TextDecoder()
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += dec.decode(value, { stream: true })
  }
  return out
}

describe('命令由 runner 代为执行', () => {
  test('输出与退出码原样返回', async () => {
    const runner = startCommandRunner(RUNNER_ARGV)
    try {
      const proc = await runner.spawn({
        argv: [process.execPath, '-e', 'process.stdout.write("hi"); process.exit(3)'],
        detached: false,
      })
      expect(proc.pid).toBeGreaterThan(0)
      const out = await readAll(proc.stdout)
      expect(out).toBe('hi')
      expect(await proc.exited).toBe(3)
    } finally {
      runner.stop()
    }
  })

  test('stderr 与 stdout 分开', async () => {
    const runner = startCommandRunner(RUNNER_ARGV)
    try {
      const proc = await runner.spawn({
        argv: [process.execPath, '-e', 'process.stdout.write("O"); process.stderr.write("E")'],
        detached: false,
      })
      const [out, err] = await Promise.all([readAll(proc.stdout), readAll(proc.stderr)])
      expect(out).toBe('O')
      expect(err).toBe('E')
    } finally {
      runner.stop()
    }
  })

  /**
   * 进程退出不等于输出已收取完毕。
   *
   * 后代进程仍持有写端时，这两条流必须保持打开：关闭后读端立即收到 EOF，
   * `collectProcess` 的 `backgroundHeld` 始终为 false，而它是「命令已退出，
   * 但后台进程仍在运行，其后续输出不在本结果中」这一提示的唯一来源。
   */
  test('进程退出后仍有后代进程持有管道时，流不随之关闭', async () => {
    const runner = startCommandRunner(RUNNER_ARGV)
    try {
      const proc = await runner.spawn({
        /*
         * 启动一个继承 stdout 的孙进程，自身写入一行后退出。
         *
         * **`detached` 不能省略**：不带它时 Bun 会在中间进程退出时一并结束孙进程
         * （`unref` 也无法保留，本机实测），管道因此正常 EOF，该断言恒为真。
         */
        argv: [
          process.execPath,
          '-e',
          `Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 3000)'], { stdout: 'inherit', detached: true }).unref(); process.stdout.write('hi')`,
        ],
        detached: false,
      })
      expect(await proc.exited).toBe(0)

      const reader = proc.stdout.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('hi')
      const state = await Promise.race([
        reader.read().then(() => 'eof'),
        Bun.sleep(500).then(() => 'open'),
      ])
      expect(state).toBe('open')
      // 读端取消后这条流才结束：结束读取由读端决定，不是退出码的副作用。
      await reader.cancel()
    } finally {
      runner.stop()
    }
  })

  /** 终止由 runner 执行（它是父进程），调用方只发送一条终止请求。 */
  test('kill 之后进程结束', async () => {
    const runner = startCommandRunner(RUNNER_ARGV)
    try {
      const proc = await runner.spawn({
        argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
        detached: false,
      })
      proc.kill()
      expect(await proc.exited).not.toBeNull()
    } finally {
      runner.stop()
    }
  })

  /** runner 退出后须明确报告，不伪装为仍可执行；重启一次意味着重建「哪些命令仍在运行」的记录。 */
  test('runner 退出之后再发送命令会抛出错误', async () => {
    const runner = startCommandRunner(RUNNER_ARGV)
    runner.stop()
    await Bun.sleep(300)
    expect(runner.spawn({ argv: [process.execPath, '-e', ''], detached: false })).rejects.toThrow(
      /runner/,
    )
  })
})
