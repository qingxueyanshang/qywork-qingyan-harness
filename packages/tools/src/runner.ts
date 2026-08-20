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
/**
 * 读端不要这条流了。**runner 收到后只是不再转发，仍旧把管道读空**——
 * 停读会让还扣着写端的后台进程在管道写满时卡死，而那些进程正是用户要留下的。
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
  /** 这条管道真的关了（所有继承过写端的进程都撒手了）。 */
  | { t: 'eof'; id: number; ch: 'out' | 'err' }
  | { t: 'exit'; id: number; code: number }
  | { t: 'fail'; id: number; message: string }

/** 一个还没结束的调用：两条流的写端 + 退出的解析器。 */
interface Pending {
  /**
   * 两条流的写端。收到 EOF、或读端自己 cancel 之后置 `null`。
   *
   * **置 null 之后不能再入队**：往已关闭或已弃用的 controller 里 `enqueue` 会抛，
   * 而这里是 IPC 回调，抛出去没有人接。
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

  /** 退出码和两条流都到齐了才丢掉这一条，不然后到的消息就没有着落了。 */
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
         * **退出不关流。**
         *
         * 关掉的话读端立刻拿到 EOF，于是「进程退出了但后代仍扣着写端」这件事
         * 在直接 spawn 那条路上看得见、在 runner 这条路上永远看不见——
         * `collectProcess` 的 `backgroundHeld` 因此恒为 false，
         * 而它是「后台还留着进程在跑」这句话唯一的来源。
         * 收手由读端决定（`collectProcess` 排空到点就 cancel），这里只如实转发。
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
      // 读端撒手就通知 runner 别再转发这条。**只发一次**：置 null 之后
      // 这条流不会再有第二次 cancel。
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
      // 退出码不是每个调用方都会等（起完就不管的那种）。runner 挂掉时这里会 reject，
      // 而没有处理器的 rejection 会把整个进程带下去，所以先挂一个空的。
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
    // 读端已经 cancel 过了（`collectProcess` 撞上输出上限时就会）。
  }
}

/**
 * runner 那一侧的主循环。由 CLI 的隐藏子命令进入，不单独成一个可执行文件——
 * 打包之后没有独立的脚本可跑，只有那一个二进制。
 */
export function runCommandRunner(): void {
  /**
   * 还没收完的调用。
   *
   * **退出之后不立刻丢**：管道可能还被后代扣着，那时读端要么等到真 EOF、
   * 要么撒手（`detach`），这两件事都发生在退出之后。
   */
  interface Call {
    proc: { pid: number; kill(): void }
    /** 读端已撒手的那条流：不再转发，但继续读空——停读会把还在写的进程卡死。 */
    dropped: { out: boolean; err: boolean }
    exited: boolean
    open: number
  }
  const live = new Map<number, Call>()
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
       * **脱开 runner 的生命周期。** 不 unref 的话 runner 退出时 Bun 会把它起的
       * 子进程一并带走——而那些正是「命令留下的服务」，用户要它们活着。
       * runner 退出只该带走那份监听句柄，不该带走任何进程。
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

/** 一条流转发到底。`end` 在真 EOF 时调一次——那是「没人再扣着写端了」的唯一信号。 */
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
