/**
 * 命令跑在一个**先于监听端口出生**的子进程里。
 *
 * ## 为什么必须这样
 *
 * Windows 上句柄是继承的：`qy serve` 绑好端口之后再 spawn 出去的任何进程，都会
 * 拿到那个监听 socket 的一份句柄。命令自己派生的后台服务（`run.ps1 start` 那种）
 * 活得比 sidecar 久，于是 **sidecar 退出之后端口仍然被攥着**——连接表里记的还是
 * 那个已经退出的 PID，看着像「没人占着却起不来」。
 *
 * 本机实测（Bun 1.3.14 / Windows 11，父进程先 `Bun.serve` 再 spawn，父退出后看端口）：
 *
 * ```
 * 直接 spawn 一个活着的子进程（powershell / node / bun）  可绑，没继承
 * 命令里再派生一层（cmd /c ping、bash -lc "… &"）        被占，继承了
 * node:child_process、detached、windowsHide              一样被占
 * Bun.serve 换成 node:http 的监听                        一样被占
 * reusePort 想抢回来                                     抢不回来
 * 先 spawn 一个子进程、再开始监听                        可绑，没继承   ← 唯一成立的做法
 * ```
 *
 * 最后一行就是这个模块：**在 `serve()` 之前**起一个 runner，之后所有 `run_command`
 * 都由它来 spawn。它出生时监听 socket 还不存在，所以它和它的子孙手里都没有那份句柄，
 * 谁活多久都不会把端口带走。
 *
 * ## 边界
 *
 * - **没有 runner 就直接 spawn**（`qy exec` 一次性执行、测试进程都是这条）。
 *   那些进程里根本没有监听 socket，没有可继承的东西，不需要绕这一圈。
 * - runner 只转发字节，不解析命令、不判权限：裁决在 `policy.ts`，沙箱在
 *   `spawnGuarded`，这里只负责「谁是父进程」。
 * - 它死了就直接抛，不自动重启：重启一次意味着「哪些命令还在跑」这本账要跟着重建，
 *   而那是第二套生命周期。跑不了命令时说出来，比悄悄换一条路诚实。
 */

/** `collectProcess` / `killTree` 真正用到的那几样。Bun 的 Subprocess 天然满足。 */
export interface ProcessLike {
  readonly pid: number
  readonly exited: Promise<number>
  readonly exitCode: number | null
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  kill(): void
}

interface SpawnRequest {
  t: 'spawn'
  id: number
  argv: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  /** 非 Windows 上自成进程组，树杀才有整组可杀（同 `spawnGuarded` 的理由）。 */
  detached: boolean
}
interface KillRequest {
  t: 'kill'
  id: number
}
type Request = SpawnRequest | KillRequest

type Reply =
  | { t: 'pid'; id: number; pid: number }
  | { t: 'out'; id: number; d: string }
  | { t: 'err'; id: number; d: string }
  | { t: 'exit'; id: number; code: number }
  | { t: 'fail'; id: number; message: string }

/** 一个还没结束的调用：两条流的写端 + 退出的解析器。 */
interface Pending {
  out: ReadableStreamDefaultController<Uint8Array>
  err: ReadableStreamDefaultController<Uint8Array>
  settle: (code: number) => void
  reject: (e: Error) => void
  pid: (n: number) => void
}

/** 起 runner 的那一侧。 */
export interface CommandRunner {
  spawn(input: {
    argv: string[]
    cwd?: string
    env?: Record<string, string | undefined>
    detached: boolean
  }): Promise<ProcessLike>
  stop(): void
}

const B64 = {
  encode: (u: Uint8Array) => Buffer.from(u).toString('base64'),
  decode: (s: string) => new Uint8Array(Buffer.from(s, 'base64')),
}

/**
 * 起一个 runner 子进程。**必须在绑端口之前调用**，否则它一样会拿到那份句柄。
 *
 * `argv` 由调用方给：源码直跑时是 `[bun, <入口>.ts, 'runner']`，打包之后是
 * `[qy, 'runner']`——这个模块不猜自己被怎么装起来的。
 */
export function startCommandRunner(argv: string[]): CommandRunner {
  const pending = new Map<number, Pending>()
  let next = 1
  let dead: Error | null = null

  const child = Bun.spawn(argv, {
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    ipc(raw) {
      const msg = raw as Reply
      const p = pending.get(msg.id)
      if (!p) return
      if (msg.t === 'pid') p.pid(msg.pid)
      else if (msg.t === 'out') p.out.enqueue(B64.decode(msg.d))
      else if (msg.t === 'err') p.err.enqueue(B64.decode(msg.d))
      else if (msg.t === 'fail') {
        pending.delete(msg.id)
        p.reject(new Error(msg.message))
      } else {
        pending.delete(msg.id)
        closeQuietly(p.out)
        closeQuietly(p.err)
        p.settle(msg.code)
      }
    },
    onExit() {
      dead = new Error('命令 runner 已退出')
      for (const [, p] of pending) p.reject(dead)
      pending.clear()
    },
  })

  const send = (req: Request) => child.send(req)

  return {
    async spawn(input) {
      if (dead) throw dead
      const id = next++
      let outCtl!: ReadableStreamDefaultController<Uint8Array>
      let errCtl!: ReadableStreamDefaultController<Uint8Array>
      const stdout = new ReadableStream<Uint8Array>({
        start: (c) => {
          outCtl = c
        },
      })
      const stderr = new ReadableStream<Uint8Array>({
        start: (c) => {
          errCtl = c
        },
      })
      let exitCode: number | null = null
      const pidReady = Promise.withResolvers<number>()
      const exited = Promise.withResolvers<number>()
      pending.set(id, {
        out: outCtl,
        err: errCtl,
        pid: pidReady.resolve,
        reject: (e) => {
          pidReady.reject(e)
          exited.reject(e)
        },
        settle: (code) => {
          exitCode = code
          exited.resolve(code)
        },
      })
      send({
        t: 'spawn',
        id,
        argv: input.argv,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
        detached: input.detached,
      })

      const pid = await pidReady.promise
      return {
        pid,
        stdout,
        stderr,
        exited: exited.promise,
        get exitCode() {
          return exitCode
        },
        kill: () => send({ t: 'kill', id }),
      }
    },
    stop() {
      child.kill()
    },
  }
}

function closeQuietly(c: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    c.close()
  } catch {
    // 读端已经 cancel 过了（`collectProcess` 撞上输出上限时就会）。
  }
}

/**
 * runner 那一侧的主循环。由 CLI 的隐藏子命令进入，不单独成一个可执行文件——
 * 打包之后没有独立的脚本可跑，只有那一个二进制。
 */
export function runCommandRunner(): void {
  const live = new Map<number, { pid: number; kill(): void }>()
  const reply = (msg: Reply) => process.send?.(msg)

  /*
   * 父进程没了就跟着退。**不杀已经在跑的那些命令**——它们派生的服务是用户要的
   * 东西，而且手里没有那份监听句柄，留着不会占住任何端口。
   *
   * 两条判据都要：IPC 通道关闭是正常退出路径；父进程被强杀时那个事件不一定到，
   * 所以再盯一遍 pid。
   */
  process.on('disconnect', () => process.exit(0))
  const parent = process.ppid
  const watch = setInterval(() => {
    try {
      process.kill(parent, 0)
    } catch {
      clearInterval(watch)
      process.exit(0)
    }
  }, 3000)
  watch.unref?.()

  process.on('message', (raw: unknown) => {
    const req = raw as Request
    if (req.t === 'kill') {
      const p = live.get(req.id)
      if (p) killTreeHere(p)
      return
    }
    try {
      const proc = Bun.spawn(req.argv, {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        ...(req.cwd ? { cwd: req.cwd } : {}),
        ...(req.env ? { env: req.env } : {}),
        ...(req.detached ? { detached: true } : {}),
      } as Bun.SpawnOptions.OptionsObject<'ignore', 'pipe', 'pipe'>)
      /*
       * **脱开 runner 的生命周期。** 不 unref 的话 runner 退出时 Bun 会把它起的
       * 子进程一并带走——而那些正是「命令留下的服务」，用户要它们活着。
       * runner 退出只该带走那份监听句柄，不该带走任何进程。
       */
      proc.unref()
      live.set(req.id, proc)
      reply({ t: 'pid', id: req.id, pid: proc.pid })
      void relay(proc.stdout, (d) => reply({ t: 'out', id: req.id, d }))
      void relay(proc.stderr, (d) => reply({ t: 'err', id: req.id, d }))
      void proc.exited.then((code) => {
        live.delete(req.id)
        reply({ t: 'exit', id: req.id, code })
      })
    } catch (e) {
      reply({ t: 'fail', id: req.id, message: e instanceof Error ? e.message : String(e) })
    }
  })
}

async function relay(stream: ReadableStream<Uint8Array>, send: (d: string) => void): Promise<void> {
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value?.length) send(B64.encode(value))
  }
}

/** runner 自己那一份树杀。与 `sandbox.ts` 的同名函数同形，但那边不能反向依赖这里。 */
function killTreeHere(proc: { pid: number; kill(): void }): void {
  if (process.platform === 'win32') {
    Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(proc.pid)], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return
  }
  try {
    process.kill(-proc.pid, 'SIGKILL')
  } catch {
    proc.kill()
  }
}
