/**
 * 插件进程隔离。
 *
 * 进程隔离不能由「只安装可信插件」的说明代替。同进程加载时，插件的权限声明是协作式的：
 * 它只约束经由宿主 API 的调用路径，无法阻止插件直接 `import('node:fs')` 读取用户的 `~/.ssh`，
 * 也无法阻止插件通过 `import('node:child_process')` 启动反弹 shell。
 *
 * 在文档中写「只安装可信插件」是以免责声明代替安全边界。
 * 插件生态的意义在于安装他人编写的插件，要求用户先审计源码等于取消该生态。
 *
 * 隔离方式：子进程 + stdio JSON-RPC。不使用 `worker_threads`：worker 与主线程共享同一进程与
 * 同一份 `process.env`，宿主的 API Key 对它直接可读。只有子进程能取得剥离凭证后的独立环境。
 *
 * 该边界经实测能拦截的内容：
 * - 宿主的环境变量（API Key、令牌、代理配置）：只传入 PATH 与几个必需项，由回归测试锁定。
 * - 宿主的进程内对象：sink 句柄、AbortSignal、权限回调与工具注册表位于宿主进程中。
 * - 崩溃与无响应：插件段错误不会导致宿主退出，超时只拒绝当次调用。
 * - 宿主能力的越权使用：`host.*` 的每次调用都经过 manifest 权限检查。
 *
 * 强制隔离的实际范围（`resolvePluginRuntime` 如实报告，两个维度分开）：
 * - `sandboxed`：Node 的 `--permission` 限制文件系统、子进程、worker 与原生插件。
 *   需要 node 20+。
 * - `netGuarded`：网络访问限制（`netguard.ts`）移除进程内的直接网络通道，
 *   网络访问只剩 `host.net.fetch`。需要 node 22.15 / 23.5+。
 *
 * 两者都不成立时（bun、低版本 node、用户指定了运行时），插件进程是普通的 Node/Bun
 * 进程：它能通过 `import('node:fs')` 读取主目录，通过 `import('node:net')` 打开套接字。
 * 此时 manifest 权限约束的是「经由宿主执行的操作」，不是「插件能执行的操作」。
 *
 * 即使两者都成立，仍有一个定义上的缺口：取得 `process:exec` 的插件能启动子进程，
 * 从而能运行 curl，因此这种情况下 `netGuarded` 如实报告 false。
 * 此外，网络访问限制是进程内的移除而不是内核边界，准确的表述是
 * 「网络访问从默认可用变为必须主动绕过」，不是「插件完全无法联网」。
 *
 * 以上措辞是边界声明。不要写成「插件无法取得 fs / net / child_process」：
 * 这种写法错误且危险，它使权限清单看似沙箱，用户会据此判断
 * 「该插件只声明了读权限，安装没有风险」。修改此处必须同步修改
 * ARCHITECTURE §24 的表格，文档对隔离范围的描述不得超出实现。
 *
 * 通信使用 stdout/stdin 上的行分隔 JSON：
 * - 每行一个 JSON 对象，以 `\n` 结束。插件的 `console.log` 会写入 stdout，
 *   因此解析失败的行一律忽略，不作为协议错误处理，否则插件中的一句调试输出
 *   就会破坏整个通道。
 * - 插件的诊断输出写入 stderr，由宿主转发到日志。
 *
 * 权限在宿主侧强制执行，不在插件侧。插件请求宿主能力时，宿主按 manifest 声明的权限校验，
 * 插件运行时的声明无效。校验表是本文件末尾的 `requiredPermissions()`，未登记的方法一律拒绝。
 */

import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import type { PluginManifest, PluginPermission } from './manifest.ts'
import { type PluginRuntime, resolvePluginRuntime } from './runtime.ts'

/** 单次插件调用的超时。插件阻塞不得阻塞整轮 agent。 */
export const CALL_TIMEOUT_MS = 60_000
/** 启动握手超时。 */
const READY_TIMEOUT_MS = 10_000

/**
 * 一次工具调用的可信身份，由宿主按 `ToolContext` 组装。
 *
 * 插件参数中的工作区、会话与 Run 一律无效。插件的反向 RPC 只携带 `parentCallId`，
 * 宿主从待决调用表取回上下文；调用结束、超时或取消后 parentCallId 立即失效，
 * 迟到的反向 RPC 因此没有可用身份。
 *
 * `signal` 是宿主进程内的对象，不跨越 RPC 边界：插件取得的始终只有 callId。
 */
export interface HostCallContext {
  pluginId: string
  workspaceRoot: string
  conversationId: string
  runId: string
  stepId?: string
  signal: AbortSignal
  /** 本次调用的绝对期限（毫秒时间戳）。宿主据此拒绝超期的反向 RPC。 */
  deadline: number
  /** 工作区之外额外可读写的绝对路径，来自会话配置。 */
  additionalDirectories?: string[]
  /** 「完全访问」模式：路径层不裁决。 */
  unrestrictedPaths?: boolean
}

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

/** 处理插件对宿主能力的反向请求。宿主按权限放行或拒绝，身份由待决调用表给出。 */
export type HostCapabilityHandler = (
  method: string,
  params: Record<string, unknown>,
  context: HostCallContext,
) => Promise<unknown>

export interface PluginHostOptions {
  manifest: PluginManifest
  dir: string
  /** 插件入口的绝对路径。 */
  entry: string
  /**
   * 运行插件所用的运行时。未填写时自动解析（优先 node，只有 node 能提供强制隔离）。
   *
   * 不能默认使用 `process.execPath`：发布产物是单文件二进制，该路径指向 qy 本身。
   */
  runtime?: string
  /** 工作区根目录。沙箱据此决定插件可读写的范围。 */
  workspaceRoot?: string
  /** 宿主能力实现。插件的 `host.*` 调用最终由此实现处理，权限已在外层校验。 */
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
      context: HostCallContext
      unlisten: () => void
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

  /** 解析得到的运行时。启动后才有值，供上层如实报告隔离状态。 */
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
    // 两个维度分开报告。合并为「已沙箱」会把网络也报告为已限制。
    this.opts.onLog?.(
      `[${this.opts.manifest.id}] 运行时 ${rt.command}` +
        `（沙箱 ${rt.sandboxed ? '有' : '无'} · 网络访问限制 ${rt.netGuarded ? '有' : '无'}）：${rt.note}`,
    )

    const proc = spawn(rt.command, [...rt.args, this.opts.entry], {
      cwd: this.opts.dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        // 不透传宿主环境变量。process.env 中有 API Key、令牌与代理配置，
        // 插件进程不需要它们，透传等同于泄露凭证。
        // 只传入必需的几项。
        PATH: process.env.PATH ?? '',
        ...(process.platform === 'win32'
          ? { SYSTEMROOT: process.env.SYSTEMROOT ?? '', TEMP: process.env.TEMP ?? '' }
          : { HOME: '/nonexistent' }),
        QYWORK_PLUGIN: this.opts.manifest.id,
        QYWORK_PLUGIN_PERMISSIONS: JSON.stringify(this.permissions),
      },
    })
    this.proc = proc

    // stdin 必须注册 error 监听。插件进程崩溃时宿主可能正在向其管道写入，
    // 而没有监听者的 stream error 事件会直接终止宿主进程。
    // 插件崩溃不得导致宿主退出，这是文件头列出的边界之一。
    // MCP 的 stdio 传输有相同处理，见 `mcp/src/transport.ts`。
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
      // 进程已退出，进行中的调用都不会再有答复，必须逐个拒绝：
      // 保留它们会使调用方一直等待到超时，而超时在用户看来是「无响应」。
      for (const [id] of [...this.pending]) {
        this.settle(id)?.reject(new Error(`插件进程退出（code=${code} signal=${signal}）`))
      }
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
        // 插件的 console.log 输出会进入此分支。忽略而不报告协议错误，
        // 否则一句调试输出就会破坏整个通道。
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

    // 插件调用宿主能力。身份只从待决调用表读取，不采用插件在参数中填写的内容。
    if (msg.type === 'host' && typeof msg.id === 'string') {
      const id = msg.id
      const parent = typeof msg.parentCallId === 'string' ? msg.parentCallId : ''
      const context = this.pending.get(parent)?.context
      if (!context) {
        this.send({
          type: 'host.result',
          id,
          ok: false,
          error: {
            message: parent
              ? `调用 ${parent} 已结束，宿主能力不再受理`
              : '宿主调用缺少 parentCallId，已拒绝',
            kind: 'call_context_gone',
          },
        })
        return
      }
      try {
        const result = await this.opts.onCapability(
          String(msg.method ?? ''),
          (msg.params as Record<string, unknown>) ?? {},
          context,
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
      // 插件已自行回复，无需再通知插件本次调用作废。
      const p = this.settle(msg.id, false)!
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

  /**
   * 调用插件导出的方法。
   *
   * 超时、取消与进程退出都经由 `settle` 处理：只删除待决项而保留调用身份时，
   * 插件一侧的执行仍能反向操作宿主，用户停止后仍会有写入落盘。
   * `settle` 同时通知插件本次调用作废，由插件自行停止。
   *
   * 超时与取消都不终止进程：可能只是当次调用较慢，其他调用仍在正常运行。
   */
  async call(
    method: string,
    params: Record<string, unknown>,
    context: HostCallContext,
  ): Promise<unknown> {
    if (!this.proc) throw new Error(`插件未启动：${this.opts.manifest.id}`)
    const id = crypto.randomUUID()

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.settle(id)?.reject(new Error(`调用已取消：${method}`))
      }
      // 期限取自上下文，上限为本地常量。两处分别计时会形成两份记录，
      // 先到期的一处会使另一处的期限永远不生效。
      const timeoutMs = Math.max(1, Math.min(CALL_TIMEOUT_MS, context.deadline - Date.now()))
      const timer = setTimeout(() => {
        this.settle(id)?.reject(new Error(`插件调用超时（${timeoutMs}ms）：${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        context,
        unlisten: () => context.signal.removeEventListener('abort', onAbort),
      })
      if (context.signal.aborted) {
        onAbort()
        return
      }
      context.signal.addEventListener('abort', onAbort, { once: true })
      this.send({ type: 'call', id, method, params })
    })
  }

  /**
   * 结束一次调用：移除待决项、清除定时器、撤销身份。
   *
   * `notifyPlugin` 为真时再发送一帧，通知插件本次调用作废。超时、取消与进程退出时发送；
   * 插件已自行回复时不发送：该调用已结束，再发送只会使插件的作废表多出一条无用记录。
   *
   * 返回 `null` 表示该调用已结束；重复结束是空操作，不是错误。
   */
  private settle(
    id: string,
    notifyPlugin = true,
  ): { resolve: (v: unknown) => void; reject: (e: Error) => void } | null {
    const p = this.pending.get(id)
    if (!p) return null
    this.pending.delete(id)
    clearTimeout(p.timer)
    p.unlisten()
    if (notifyPlugin) this.send({ type: 'call.cancelled', id })
    return { resolve: p.resolve, reject: p.reject }
  }

  stop(): void {
    const proc = this.proc
    if (!proc) return
    this.proc = null
    proc.kill()
    // 留出短暂时间供插件正常退出，之后强制终止。插件可能在 SIGTERM 处理中执行清理，
    // 但不能无限期等待，否则宿主退出时会留下孤儿进程。
    const timer = setTimeout(() => proc.kill('SIGKILL'), 2000)
    timer.unref?.()
  }
}

/**
 * 权限校验。
 *
 * 在宿主侧执行，不信任插件运行时的声明。方法名到权限的映射固定在此处，
 * 新增宿主能力时必须同时在此登记。未登记的方法得到 null 并被拒绝，
 * 这是有意的 fail-closed：遗漏登记的后果是「新能力不可用」，
 * 而不是「新能力对所有插件无条件开放」。
 */
export function requiredPermissions(method: string): PluginPermission[] | null {
  if (method.startsWith('fs.read')) return ['workspace:read']
  if (method.startsWith('fs.write') || method.startsWith('fs.delete')) return ['workspace:write']
  if (method.startsWith('net.')) return ['network']
  if (method.startsWith('exec.')) return ['process:exec']
  if (method.startsWith('storage.')) return ['storage']
  return null
}

export function checkPermission(
  host: PluginHost,
  method: string,
): { ok: true } | { ok: false; message: string } {
  const needed = requiredPermissions(method)
  if (needed === null) {
    return { ok: false, message: `未登记的宿主方法，已拒绝：${method}` }
  }
  for (const permission of needed) {
    if (!host.has(permission)) {
      return {
        ok: false,
        message: `插件未声明 ${permission} 权限，拒绝调用 ${method}`,
      }
    }
  }
  return { ok: true }
}
