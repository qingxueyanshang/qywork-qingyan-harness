/**
 * 插件进程隔离。
 *
 * **为什么必须做，而不是留一句「只装可信的插件」。** 同进程加载下，插件的权限声明是**协作式**的：
 * 它约束的是通过宿主 API 的调用路径，挡不住插件直接 `import('node:fs')` 读走用户的 `~/.ssh`，也挡
 * 不住它 `import('node:child_process')` 起个反弹 shell。
 *
 * 文档里写「只装可信的插件」是**用免责声明代替安全边界**。
 * 插件生态的意义就是装别人写的插件；要求用户先审计源码等于取消了这个生态。
 *
 * **隔离方式：子进程 + stdio JSON-RPC。** 不用 `worker_threads`：worker 与主线程共享同一个进程和同
 * 一份 `process.env`，宿主的 API Key 对它是直接可读的。子进程才能给一份洗过的环境。
 *
 * **这道边界**实测**挡住了什么、没挡住什么。** 挡住的：
 * - 宿主的环境变量（API Key、令牌、代理配置）——只给 PATH 和几个必需项，有回归测试锁住。
 * - 宿主的进程内对象——sink 句柄、AbortSignal、权限回调、工具注册表都在另一个进程里。
 * - 崩溃与卡死——插件段错误不会带走宿主，超时只拒绝这一次调用。
 * - 宿主能力的越权使用——`host.*` 每一次都过 manifest 权限闸。
 *
 * **强制隔离的实际范围**（`resolvePluginRuntime` 会如实报告，两个维度分开）：
 * - `sandboxed`：Node 的 `--permission` 关住文件系统、子进程、worker、原生插件。
 *   需要 node 20+。
 * - `netGuarded`：出网闸（`netguard.ts`）拆掉进程内的直接出网通道，
 *   出网只剩 `host.net.fetch`。需要 node 22.15 / 23.5+。
 *
 * **两者都不成立时**（bun、低版本 node、用户指定了运行时），插件进程就是一个
 * 普通的 Node/Bun 进程：它能 `import('node:fs')` 读主目录、`import('node:net')`
 * 开套接字。此时 **manifest 权限管的是「通过宿主做事」，不是「插件能做什么」**。
 *
 * 就算两者都成立，也仍然有一条**定义上**的缺口：拿到 `process:exec` 的插件
 * 能起子进程，能起子进程就能跑 curl。所以那种情况下 `netGuarded` 如实报 false。
 * 而且出网闸是**进程内的拆除不是内核边界**——准确的说法是
 * 「联网从默认可用变成必须刻意绕」，不是「插件绝对上不了网」。
 *
 * 这段话的措辞是**边界声明**。不要写成「插件拿不到 fs / net / child_process」，
 * 那是错的而且错得危险：它让权限清单看起来像一道沙箱，因此用户会据此判断
 * 「这个插件只声明了读，装了没风险」。改这里的人必须同时改
 * ARCHITECTURE §24 那张表——不能让文档又一次比实现乐观。
 *
 * 通信走 stdout/stdin 的行分隔 JSON：
 * - 每行一个 JSON 对象，`\n` 结束。插件的 `console.log` 会污染 stdout，
 *   所以**解析失败的行一律忽略**而不是当协议错误——否则插件里一句调试打印
 *   就会把整个通道破坏掉。
 * - 插件的诊断输出走 stderr，由宿主转发到日志。
 *
 * **权限在宿主侧强制，不在插件侧。** 插件请求宿主能力时，宿主按 manifest 声明的权限校验，插件运行时
 * 的声明不作数。校验表在本文件末尾的 `requiredPermission()`，未登记的方法一律拒绝。
 */

import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import type { PluginManifest, PluginPermission } from './manifest.ts'
import { type PluginRuntime, resolvePluginRuntime } from './runtime.ts'

/** 单次插件调用的超时。插件卡住不能把整轮 agent 拖死。 */
const CALL_TIMEOUT_MS = 60_000
/** 启动握手超时。 */
const READY_TIMEOUT_MS = 10_000

export interface HostRequest {
  id: string
  method: string
  params: Record<string, unknown>
}

export interface HostResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: { message: string; kind?: string }
}

/** 插件反过来请求宿主能力时走这个。宿主按权限放行或拒绝。 */
export type HostCapabilityHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>

export interface PluginHostOptions {
  manifest: PluginManifest
  dir: string
  /** 插件入口的绝对路径。 */
  entry: string
  /**
   * 用哪个运行时跑插件。不填则自动解析（优先 node，因为只有它能提供强制隔离）。
   *
   * **不能默认取 `process.execPath`**：发布产物是单文件二进制，那个路径是 qy 自己。
   */
  runtime?: string
  /** 工作区根。沙箱据此决定插件能读写哪一块。 */
  workspaceRoot?: string
  /** 宿主能力实现。插件的 `host.*` 调用最终落到这里，权限已在外层校验过。 */
  onCapability: HostCapabilityHandler
  /** 诊断输出。 */
  onLog?: (line: string) => void
}

export class PluginHost {
  private proc: ChildProcess | null = null
  private readonly pending = new Map<
    string,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private buffer = ''
  private ready = false
  private exited: { code: number | null; signal: string | null } | null = null

  constructor(private readonly opts: PluginHostOptions) {}

  get permissions(): PluginPermission[] {
    return this.opts.manifest.permissions ?? []
  }

  has(permission: PluginPermission): boolean {
    return this.permissions.includes(permission)
  }

  /** 解析出来的运行时。启动后才有值，供上层如实报告隔离状态。 */
  runtime: PluginRuntime | null = null

  async start(): Promise<void> {
    if (this.proc) return

    const rt = resolvePluginRuntime({
      ...(this.opts.runtime ? { override: this.opts.runtime } : {}),
      workspaceRoot: this.opts.workspaceRoot ?? this.opts.dir,
      pluginDir: this.opts.dir,
      permissions: this.permissions,
    })
    this.runtime = rt
    // 两个维度分开说。合成一句「已沙箱」会把网络也说成已关闭。
    this.opts.onLog?.(
      `[${this.opts.manifest.id}] 运行时 ${rt.command}` +
        `（沙箱 ${rt.sandboxed ? '有' : '无'} · 出网闸 ${rt.netGuarded ? '有' : '无'}）：${rt.note}`,
    )

    const proc = spawn(rt.command, [...rt.args, this.opts.entry], {
      cwd: this.opts.dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        // **不透传宿主环境变量。** process.env 里有 API Key、令牌、代理配置——
        // 一个插件进程本不需要它们，透传等于把凭证白送出去。
        // 只给最必要的几个。
        PATH: process.env.PATH ?? '',
        ...(process.platform === 'win32'
          ? { SYSTEMROOT: process.env.SYSTEMROOT ?? '', TEMP: process.env.TEMP ?? '' }
          : { HOME: '/nonexistent' }),
        QYWORK_PLUGIN: this.opts.manifest.id,
        QYWORK_PLUGIN_PERMISSIONS: JSON.stringify(this.permissions),
      },
    })
    this.proc = proc

    // stdin 上必须挂 error 监听。插件进程崩溃的瞬间宿主可能正在往它的管道里写，
    // 而**没有监听者的 stream error 事件会直接掀掉整个宿主进程**——
    // 一个装错的插件不该有能力做到这件事，那正是本文件开头承诺过的边界。
    // MCP 那条传输链上是同一件事，见 `mcp/src/transport.ts`。
    proc.stdin?.on('error', (err: Error) => {
      this.opts.onLog?.(`[${this.opts.manifest.id}] 写入失败：${err.message}`)
    })

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) this.opts.onLog?.(`[${this.opts.manifest.id}] ${line}`)
      }
    })

    proc.on('exit', (code, signal) => {
      this.exited = { code, signal }
      this.proc = null
      // 进程死了，所有在飞的调用都不会有答复了。**必须逐个拒绝**——
      // 留着它们会让调用方永远等到超时，而超时对用户表现为「卡住」。
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`插件进程退出（code=${code} signal=${signal}）`))
      }
      this.pending.clear()
    })

    await this.waitReady()
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (!this.ready) {
      if (this.exited) throw new Error(`插件启动即退出：${this.opts.manifest.id}`)
      if (Date.now() > deadline) {
        this.stop()
        throw new Error(`插件启动超时（${READY_TIMEOUT_MS}ms）：${this.opts.manifest.id}`)
      }
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const idx = this.buffer.indexOf('\n')
      if (idx < 0) break
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue

      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        // 插件里一句 console.log 就会走到这里。忽略而不是报协议错误——
        // 否则一句调试打印就能把整个通道破坏掉。
        this.opts.onLog?.(`[${this.opts.manifest.id}] ${line}`)
        continue
      }
      void this.dispatch(msg)
    }
  }

  private async dispatch(msg: Record<string, unknown>): Promise<void> {
    if (msg.type === 'ready') {
      this.ready = true
      return
    }

    // 插件调宿主能力。
    if (msg.type === 'host' && typeof msg.id === 'string') {
      const id = msg.id
      try {
        const result = await this.opts.onCapability(
          String(msg.method ?? ''),
          (msg.params as Record<string, unknown>) ?? {},
        )
        this.send({ type: 'host.result', id, ok: true, result })
      } catch (err) {
        this.send({
          type: 'host.result',
          id,
          ok: false,
          error: { message: err instanceof Error ? err.message : String(err) },
        })
      }
      return
    }

    // 插件回复宿主的调用。
    if (typeof msg.id === 'string' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok === false) {
        const e = msg.error as { message?: string } | undefined
        p.reject(new Error(e?.message ?? '插件返回失败'))
      } else {
        p.resolve(msg.result)
      }
    }
  }

  private send(payload: Record<string, unknown>): void {
    const stdin = this.proc?.stdin
    if (!stdin || stdin.destroyed) return
    stdin.write(`${JSON.stringify(payload)}\n`)
  }

  /** 调用插件导出的方法。超时会拒绝，但**不杀进程**——可能只是这一次调用慢。 */
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.proc) throw new Error(`插件未启动：${this.opts.manifest.id}`)
    const id = crypto.randomUUID()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`插件调用超时（${CALL_TIMEOUT_MS}ms）：${method}`))
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ type: 'call', id, method, params })
    })
  }

  stop(): void {
    const proc = this.proc
    if (!proc) return
    this.proc = null
    proc.kill()
    // 给一点时间优雅退出，之后强杀。插件可能在 SIGTERM 处理里做清理，
    // 但不能无限期等它——那样宿主退出时会留下孤儿进程。
    const timer = setTimeout(() => proc.kill('SIGKILL'), 2000)
    timer.unref?.()
  }
}

/**
 * 权限校验。
 *
 * **在宿主侧执行**，而不是信任插件运行时的声明。方法名到权限的映射写死在这里，
 * 加新的宿主能力时必须同时在这张表里登记——漏登记的方法会走到 default 分支被拒，
 * 这是刻意的 fail-closed：忘了登记的后果是「新能力用不了」，
 * 而不是「新能力对所有插件无条件开放」。
 */
export function requiredPermission(method: string): PluginPermission | null {
  if (method.startsWith('fs.read')) return 'workspace:read'
  if (method.startsWith('fs.write') || method.startsWith('fs.delete')) return 'workspace:write'
  if (method.startsWith('net.')) return 'network'
  if (method.startsWith('exec.')) return 'process:exec'
  if (method.startsWith('storage.')) return 'storage'
  return null
}

export function checkPermission(
  host: PluginHost,
  method: string,
): { ok: true } | { ok: false; message: string } {
  const needed = requiredPermission(method)
  if (needed === null) {
    return { ok: false, message: `未登记的宿主方法，已拒绝：${method}` }
  }
  if (!host.has(needed)) {
    return {
      ok: false,
      message: `插件未声明 ${needed} 权限，拒绝调用 ${method}`,
    }
  }
  return { ok: true }
}
