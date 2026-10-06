/**
 * 命令运行在一个先于监听端口创建的子进程中。
 *
 * **必须如此的原因。** Windows 上句柄会被继承：`qy serve` 绑定端口之后再 spawn 的任何进程，都会
 * 获得该监听 socket 的一份句柄。命令自行派生的后台服务（如 `run.ps1 start`）存活时间比 sidecar 长，
 * 因此 **sidecar 退出之后端口仍被持有**：连接表中记录的仍是已退出的 PID，现象是「端口无人占用
 * 却无法启动」。
 *
 * 实测过六种写法（detached、windowsHide、`node:child_process`、`node:http` 监听、`reusePort`），
 * 只要先监听后派生，端口一律被占用；**先 spawn 子进程再开始监听是唯一可行的做法**。
 *
 * 本模块即实现这一做法：**在 `serve()` 之前**启动 runner，之后所有 `run_command` 都由它 spawn。
 * runner 创建时监听 socket 尚不存在，因此它及其后代进程都不持有该句柄，无论存活多久都不会占用端口。
 *
 * **边界**：
 * - **没有 runner 时直接 spawn**（`qy exec` 一次性执行、测试进程均属此类）。
 *   这些进程中没有监听 socket，没有可继承的句柄，无需经由 runner。
 * - runner 只转发字节，不解析命令、不判定权限：裁决在 `policy.ts`，沙箱在
 *   `spawnGuarded`，这里只负责决定由谁作为父进程。
 * - runner 退出后直接抛出错误，不自动重启：重启意味着「哪些命令仍在运行」的记录需要随之重建，
 *   而那是第二套生命周期。无法执行命令时直接报错，不静默改用其他方式。
 */

/** `collectProcess` / `killTree` 实际使用的成员。Bun 的 Subprocess 直接满足该接口。 */
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
  /** 非 Windows 上自成进程组，树杀才能终止整个进程组（理由同 `spawnGuarded`）。 */
  detached: boolean
}
interface KillRequest {
  t: 'kill'
  id: number
}
/**
 * 读端不再需要这条流。**runner 收到后只停止转发，仍持续读空管道**：
 * 停止读取会使仍持有写端的后台进程在管道写满时阻塞，而这些进程正是用户需要保留的。
 */
interface DetachRequest {
  t: 'detach'
  id: number
  ch: 'out' | 'err'
}
type Request = SpawnRequest | KillRequest | DetachRequest

type Reply =
  | { t: 'pid'; id: number; pid: number }
  | { t: 'out'; id: number; d: string }
  | { t: 'err'; id: number; d: string }
  /** 该管道已真正关闭（所有继承写端的进程都已关闭写端）。 */
  | { t: 'eof'; id: number; ch: 'out' | 'err' }
  | { t: 'exit'; id: number; code: number }
  | { t: 'fail'; id: number; message: string }

/** 一个尚未结束的调用：两条流的写端与退出结果的解析器。 */
interface Pending {
  /**
   * 两条流的写端。收到 EOF 或读端自行 cancel 之后置为 `null`。
   *
   * **置为 null 之后不能再入队**：向已关闭或已弃用的 controller 调用 `enqueue` 会抛出异常，
   * 而此处是 IPC 回调，异常无人捕获。
   */
  streams: {
    out: ReadableStreamDefaultController<Uint8Array> | null
    err: ReadableStreamDefaultController<Uint8Array> | null
  }
  exited: boolean
  settle: (code: number) => void
  reject: (e: Error) => void
  pid: (n: number) => void
}

/** 启动 runner 的一侧。 */
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
 * 启动一个 runner 子进程。**必须在绑定端口之前调用**，否则它同样会获得该句柄。
 *
 * `argv` 由调用方提供：从源码直接运行时为 `[bun, <入口>.ts, 'runner']`，打包后为
 * `[qy, 'runner']`。本模块不推测自身的安装方式。
 */
export function startCommandRunner(argv: string[]): CommandRunner {
  const pending = new Map<number, Pending>()
  let next = 1
  let dead: Error | null = null

  /** 退出码与两条流都结束后才删除该记录，否则后到达的消息无法找到对应的调用。 */
  const reap = (id: number, p: Pending): void => {
    if (p.exited && !p.streams.out && !p.streams.err) pending.delete(id)
  }

  const child = Bun.spawn(argv, {
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    ipc(raw) {
      const msg = raw as Reply
      const p = pending.get(msg.id)
      if (!p) return
      if (msg.t === 'pid') p.pid(msg.pid)
      else if (msg.t === 'out' || msg.t === 'err') p.streams[msg.t]?.enqueue(B64.decode(msg.d))
      else if (msg.t === 'eof') {
        closeQuietly(p.streams[msg.ch])
        p.streams[msg.ch] = null
        reap(msg.id, p)
      } else if (msg.t === 'fail') {
        pending.delete(msg.id)
        p.reject(new Error(msg.message))
      } else {
        /*
         * **进程退出时不关闭流。**
         *
         * 关闭后读端立即收到 EOF，「进程已退出但后代仍持有写端」这一状态
         * 在直接 spawn 的路径上可见、在 runner 路径上永远不可见：
         * `collectProcess` 的 `backgroundHeld` 因此始终为 false，
         * 而它是「后台仍有进程在运行」这一提示的唯一来源。
         * 何时结束读取由读端决定（`collectProcess` 排空时限到达即 cancel），这里只如实转发。
         */
        p.exited = true
        p.settle(msg.code)
        reap(msg.id, p)
      }
    },
    onExit() {
      dead = new Error('命令 runner 已退出')
      for (const [, p] of pending) {
        closeQuietly(p.streams.out)
        closeQuietly(p.streams.err)
        p.reject(dead)
      }
      pending.clear()
    },
  })

  const send = (req: Request) => child.send(req)

  return {
    async spawn(input) {
      if (dead) throw dead
      const id = next++
      const streams: Pending['streams'] = { out: null, err: null }
      // 读端放弃读取时通知 runner 停止转发该流。只发送一次：置为 null 之后
      // 该流不会再次 cancel。
      const pipe = (ch: 'out' | 'err') =>
        new ReadableStream<Uint8Array>({
          start: (c) => {
            streams[ch] = c
          },
          cancel: () => {
            const p = pending.get(id)
            if (!p) return
            p.streams[ch] = null
            send({ t: 'detach', id, ch })
            reap(id, p)
          },
        })
      const stdout = pipe('out')
      const stderr = pipe('err')
      let exitCode: number | null = null
      const pidReady = Promise.withResolvers<number>()
      const exited = Promise.withResolvers<number>()
      // 并非每个调用方都等待退出码（启动后不再跟踪的调用）。runner 退出时此处会 reject，
      // 而未处理的 rejection 会使整个进程退出，因此先注册一个空处理器。
      void exited.promise.catch(() => {})
      pending.set(id, {
        streams,
        exited: false,
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

function closeQuietly(c: ReadableStreamDefaultController<Uint8Array> | null): void {
  if (!c) return
  try {
    c.close()
  } catch {
    // 读端已 cancel（`collectProcess` 达到输出上限时会出现这种情况）。
  }
}

/**
 * runner 一侧的主循环。由 CLI 的隐藏子命令进入，不作为单独的可执行文件：
 * 打包后没有可单独运行的脚本，只有一个二进制文件。
 */
export function runCommandRunner(): void {
  /**
   * 输出尚未收取完毕的调用。
   *
   * **进程退出后不立即删除**：管道可能仍被后代进程持有，此时读端或者等到真正的 EOF，
   * 或者放弃读取（`detach`），两者都发生在退出之后。
   */
  interface Call {
    proc: { pid: number; kill(): void }
    /** 读端已放弃的流：不再转发，但继续读空；停止读取会使仍在写入的进程阻塞。 */
    dropped: { out: boolean; err: boolean }
    exited: boolean
    open: number
  }
  const live = new Map<number, Call>()
  const reply = (msg: Reply) => process.send?.(msg)

  /*
   * 父进程退出后随之退出。**不终止已在运行的命令**：它们派生的服务是用户需要的
   * 进程，且不持有监听句柄，保留它们不会占用任何端口。
   *
   * 两条判据都需要：IPC 通道关闭是正常退出路径；父进程被强制终止时该事件不一定到达，
   * 因此另外轮询父进程 pid。
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

  const reap = (id: number, c: Call): void => {
    if (c.exited && c.open === 0) live.delete(id)
  }

  process.on('message', (raw: unknown) => {
    const req = raw as Request
    if (req.t === 'kill') {
      const c = live.get(req.id)
      if (c) killTreeHere(c.proc)
      return
    }
    if (req.t === 'detach') {
      const c = live.get(req.id)
      if (c) c.dropped[req.ch] = true
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
       * **与 runner 的生命周期解耦。** 不调用 unref 时，runner 退出时 Bun 会一并结束它启动的
       * 子进程，而这些正是命令留下的服务，用户需要它们继续运行。
       * runner 退出不应结束任何子进程。
       */
      proc.unref()
      const call: Call = { proc, dropped: { out: false, err: false }, exited: false, open: 2 }
      live.set(req.id, call)
      reply({ t: 'pid', id: req.id, pid: proc.pid })
      for (const ch of ['out', 'err'] as const) {
        void relay(
          ch === 'out' ? proc.stdout : proc.stderr,
          (d) => {
            if (!call.dropped[ch]) reply({ t: ch, id: req.id, d })
          },
          () => {
            call.open -= 1
            if (!call.dropped[ch]) reply({ t: 'eof', id: req.id, ch })
            reap(req.id, call)
          },
        )
      }
      void proc.exited.then((code) => {
        call.exited = true
        reply({ t: 'exit', id: req.id, code })
        reap(req.id, call)
      })
    } catch (e) {
      reply({ t: 'fail', id: req.id, message: e instanceof Error ? e.message : String(e) })
    }
  })
}

/** 持续转发一条流直到结束。`end` 在真正 EOF 时调用一次，这是「已无进程持有写端」的唯一信号。 */
async function relay(
  stream: ReadableStream<Uint8Array>,
  send: (d: string) => void,
  end: () => void,
): Promise<void> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value?.length) send(B64.encode(value))
    }
  } finally {
    end()
  }
}

/** runner 自身的树杀实现，与 `sandbox.ts` 的 `killTree` 结构相同。不从该文件导入：`sandbox.ts` 已依赖本文件，反向导入会形成循环依赖。 */
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
