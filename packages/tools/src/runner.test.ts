/**
 * 命令 runner 的契约：**它是「谁当父进程」这一件事**，别的都不管。
 *
 * 覆盖 `runner.ts` 的两侧：起 runner 的那一侧（`startCommandRunner`）与
 * runner 自己的主循环（`runCommandRunner`）。
 *
 * **不在这里验「端口不被继承」**——那要起一个真的监听 + 让父进程退出 + 事后看端口，
 * 是一次跨进程的手工实测，结论与实测记录写在 `runner.ts` 的模块注释里。
 * 这里锁的是「跑出来的东西和直接 spawn 一样」：输出、退出码、杀得掉。
 */

import { describe, expect, test } from 'bun:test'
import { startCommandRunner } from './runner.ts'

/** runner 那一侧的入口。正式路径是 `qy runner`，测试里直接进那个函数。 */
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

describe('命令由 runner 代跑', () => {
  test('输出与退出码原样回来', async () => {
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
   * 退出不等于收完。
   *
   * 后代还扣着写端时，这两条流必须继续开着：关掉的话读端立刻拿到 EOF，
   * `collectProcess` 的 `backgroundHeld` 就恒为 false——而它是「命令退出了，
   * 但后台进程还在跑，它之后的输出不在这份结果里」这句话唯一的来源。
   */
  test('进程退出后仍有后代扣着管道时，流不跟着关', async () => {
    const runner = startCommandRunner(RUNNER_ARGV)
    try {
      const proc = await runner.spawn({
        /*
         * 起一个继承了 stdout 的孙进程，自己写一行就退出。
         *
         * **`detached` 不能省**：不带它 Bun 会在中间那个进程退出时把孙进程一并
         * 带走（`unref` 也留不住，本机实测），于是管道照常 EOF，这条断言就恒真了。
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
      // 读端撒手之后这条流才结束——收手是读端的决定，不是退出码的副作用。
      await reader.cancel()
    } finally {
      runner.stop()
    }
  })

  /** 杀是 runner 做的（它才是父进程），调用方只发一句「杀掉」。 */
  test('kill 之后进程会结束', async () => {
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

  /** runner 死了就说清楚，不假装还能跑——重启一次意味着重建「哪些命令还在跑」那本账。 */
  test('runner 没了之后再要命令会抛', async () => {
    const runner = startCommandRunner(RUNNER_ARGV)
    runner.stop()
    await Bun.sleep(300)
    expect(runner.spawn({ argv: [process.execPath, '-e', ''], detached: false })).rejects.toThrow(
      /runner/,
    )
  })
})
