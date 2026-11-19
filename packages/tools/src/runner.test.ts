/**
 * 命令 runner 的契约：**它只负责决定由谁作为父进程**，不承担其他职责。
 *
 * 覆盖 `runner.ts` 的两侧：启动 runner 的一侧（`startCommandRunner`）与
 * runner 自身的主循环（`runCommandRunner`）。
 *
 * **此处不验证「端口不被继承」**：验证需要启动真实监听、让父进程退出、再检查端口，
 * 是一次跨进程的手工实测，结论与实测记录写在 `runner.ts` 的模块注释中。
 * 此处锁定的是「执行结果与直接 spawn 一致」：输出、退出码、可被终止；以及父进程的停止路径不执行时
 * runner 终止哪些命令。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startCommandRunner } from './runner.ts'

/** runner 一侧的入口。正式路径是 `qy runner`，测试中直接调用该函数。 */
const RUNNER_ARGV = [
  process.execPath,
  '-e',
  `import { runCommandRunner } from ${JSON.stringify(Bun.fileURLToPath(new URL('./runner.ts', import.meta.url)))}; runCommandRunner()`,
]

/**
 * 持有 runner 的父进程：启动两条命令，输出各进程的 pid 后保持运行。
 * `running` 的 shell 等待其后台进程，尚未退出；`left` 的 shell 启动后台进程后即退出，后台进程仍持有输出管道。
 */
const PARENT_SCRIPT = `
import { startCommandRunner } from ${JSON.stringify(Bun.fileURLToPath(new URL('./runner.ts', import.meta.url)))}
const runner = startCommandRunner(${JSON.stringify(RUNNER_ARGV)})
const firstLine = async (stream) => {
  const reader = stream.getReader()
  let text = ''
  while (!text.includes('\\n')) {
    const { done, value } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
  }
  return Number(text.trim())
}
const running = await runner.spawn({ argv: ['bash', '-c', 'sleep 600 & echo $!; wait'], detached: true })
const left = await runner.spawn({ argv: ['bash', '-c', 'sleep 600 & echo $!'], detached: true })
const pids = { shell: running.pid, running: await firstLine(running.stdout), left: await firstLine(left.stdout) }
await left.exited
console.log(JSON.stringify(pids))
setInterval(() => {}, 1000)
`

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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

  /** 原始失败形状：runner 启动的命令标准输入一律关闭，交互程序读取到输入结束即退出，无法根据输出写入下一行。 */
  test('请求输入管道时可分次写入标准输入，关闭后程序读取到输入结束', async () => {
    const runner = startCommandRunner(RUNNER_ARGV)
    try {
      const proc = await runner.spawn({
        argv: [
          process.execPath,
          '-e',
          'let all="";process.stdin.on("data",(d)=>{all+=d});process.stdin.on("end",()=>process.stdout.write("收到:"+all+"结束"))',
        ],
        detached: false,
        input: true,
      })
      if (!proc.input) throw new Error('请求输入管道时本应返回写端')
      proc.input.write(new TextEncoder().encode('a\n'))
      proc.input.write(new TextEncoder().encode('b\n'))
      proc.input.end()
      expect(await readAll(proc.stdout)).toBe('收到:a\nb\n结束')
      expect(await proc.exited).toBe(0)
    } finally {
      runner.stop()
    }
  })

  test('未请求输入管道时写端为 null', async () => {
    const runner = startCommandRunner(RUNNER_ARGV)
    try {
      const proc = await runner.spawn({
        argv: [process.execPath, '-e', 'process.stdout.write("ok")'],
        detached: false,
      })
      expect(proc.input).toBeNull()
      expect(await readAll(proc.stdout)).toBe('ok')
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
    const trigger = join(await mkdtemp(join(tmpdir(), 'qywork-runner-')), 'go')
    // 孙进程在触发文件出现后写入 `late`；3 秒内未出现时停止轮询并退出。
    const grandchild =
      `const f=${JSON.stringify(trigger)};const fs=require('node:fs');` +
      `const t=setInterval(()=>{if(fs.existsSync(f)){clearInterval(t);process.stdout.write('late')}},10);` +
      'setTimeout(()=>clearInterval(t),3000).unref()'
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
          `Bun.spawn([process.execPath, '-e', ${JSON.stringify(grandchild)}], { stdout: 'inherit', detached: true }).unref(); process.stdout.write('hi')`,
        ],
        detached: false,
      })
      expect(await proc.exited).toBe(0)

      const reader = proc.stdout.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('hi')
      // 中间进程退出之后才使孙进程写入：流随退出关闭时，此处读取到 EOF 而不是 `late`。
      await writeFile(trigger, '')
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('late')
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

  /**
   * 父进程的正常停止路径不执行时，命令以 detached 启动、自成会话，不随父进程结束：父进程被直接终止
   * （崩溃，或桌面外壳请求停止后超时），或终端信号同时终止父进程与 runner。runner 退出前终止尚未退出的
   * 命令的进程树；已退出的命令留下的后代进程保留，与正常停止时一致。
   *
   * 父进程自成进程组，进程组信号不送达测试进程。
   * 不在 Windows 上运行：Windows 上命令不以 detached 启动，且用例以 bash 派生后代进程。
   */
  describe.skipIf(process.platform === 'win32')('父进程的停止路径不执行', () => {
    type Parent = { pid: number; kill(signal?: number | NodeJS.Signals): void }
    const triggers: [string, (parent: Parent) => void][] = [
      ['父进程收到 SIGKILL', (parent) => parent.kill('SIGKILL')],
      ['进程组收到 SIGHUP', (parent) => process.kill(-parent.pid, 'SIGHUP')],
      ['进程组收到 SIGINT', (parent) => process.kill(-parent.pid, 'SIGINT')],
    ]
    test.each(triggers)(
      '%s：尚未退出的命令进程树被终止，已退出命令留下的进程保留',
      async (_label, send) => {
        const parent = Bun.spawn([process.execPath, '-e', PARENT_SCRIPT], {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'inherit',
          detached: true,
        })
        const reader = parent.stdout.getReader()
        let text = ''
        while (!text.includes('\n')) {
          const { done, value } = await reader.read()
          if (done) break
          text += new TextDecoder().decode(value)
        }
        const pids = JSON.parse(text) as { shell: number; running: number; left: number }
        try {
          expect([pids.shell, pids.running, pids.left].every(alive)).toBe(true)
          send(parent)
          for (let i = 0; i < 100 && (alive(pids.shell) || alive(pids.running)); i++) {
            await Bun.sleep(100)
          }
          expect({ shell: alive(pids.shell), running: alive(pids.running) }).toEqual({
            shell: false,
            running: false,
          })
          expect(alive(pids.left)).toBe(true)
        } finally {
          parent.kill('SIGKILL')
          for (const pid of Object.values(pids)) {
            try {
              process.kill(pid, 'SIGKILL')
            } catch {
              // 已结束。
            }
          }
        }
      },
      15_000,
    )
  })

  /** runner 退出后须明确报告，不伪装为仍可执行；重启一次意味着重建「哪些命令仍在运行」的记录。 */
  test('runner 退出之后再发送命令会抛出错误', async () => {
    const runner = startCommandRunner(RUNNER_ARGV)
    // runner 退出时尚未退出的调用以错误结束，以此确认 runner 已退出。
    const held = await runner.spawn({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      detached: false,
    })
    try {
      runner.stop()
      await expect(held.exited).rejects.toThrow(/runner/)
      await expect(
        runner.spawn({ argv: [process.execPath, '-e', ''], detached: false }),
      ).rejects.toThrow(/runner/)
    } finally {
      try {
        process.kill(held.pid)
      } catch {
        // 已随 runner 结束。
      }
    }
  })
})
