/**
 * `qy serve` —— 本地 HTTP + WebSocket 服务。
 *
 * 桌面端和手机端连的是**同一个**服务、走**同一套**协议。桌面端并不通过 Tauri IPC
 * 拿数据，它就是这个服务的一个 Web 客户端——这样手机端不需要第二套后端，
 * 也不会出现「桌面能做但手机做不了」的能力漂移。
 *
 * 绑定地址的取舍：默认绑 0.0.0.0 才能让手机连上，但那也意味着同一 Wi-Fi 下
 * 任何设备都能触达。所以令牌鉴权是强制的，不是可选项（见 pairing.ts）。
 * 只想本机用就传 --host 127.0.0.1。
 */

import { join } from 'node:path'
import type { Summarizer } from '@qywork/agent'
import { buildAdapter, ProviderError } from '@qywork/ai'
import type {
  AgentEvent,
  ClientCommand,
  CommandRejectedFrame,
  CommandRejectReason,
  ConversationId,
  EventEnvelope,
  HelloFrame,
  Run,
  RunId,
  RunUsage,
} from '@qywork/core'
import { PROTOCOL_VERSION } from '@qywork/core'
import {
  acquireExtensions,
  collectSecrets,
  configPath,
  isDue,
  loadSchedules,
  type QyConfig,
  RuntimeCompaction,
  releaseExtensions,
  resolveApiKey,
  type Schedule,
  Session,
  saveSchedules,
} from '@qywork/runtime'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  getConversation,
  getRun,
  listMessages,
  recoverStaleRuns,
  type Store,
  setConversationModel,
  upsertWorkspace,
} from '@qywork/store'
import { type BuiltinBackend, type Role, TeamOrchestrator } from '@qywork/team'
import { detectSandbox } from '@qywork/tools'
import type { ServerWebSocket } from 'bun'
import { handleApi, json } from './api/index.ts'
import { EventBus } from './bus.ts'
import * as git from './git.ts'
import { extractToken, Pairing, preferredLanAddress } from './pairing.ts'
import { RunManager } from './runs.ts'

export interface ServeOptions {
  store: Store
  config: QyConfig
  /**
   * 正文库。不传则自动挨着主账本开一个（`:memory:` 账本对应内存正文库）。
   * 超预算的工具输出落在这里，模型用 read_resource 读回。
   */
  content?: ContentStore
  workspaceRoot: string
  port: number
  host: string
  /** web 构建产物目录；不存在时只提供 API。 */
  staticDir?: string
  /** 由外部注入的令牌（Tauri spawn 时用环境变量传），不传则自己生成。 */
  token?: string
}

interface SocketData {
  id: string
  authed: boolean
  origin: 'desktop' | 'mobile' | 'cli' | 'external'
}

export function serve(opts: ServeOptions) {
  const bus = new EventBus()
  const runs = new RunManager(opts.store, bus)
  const pairing = new Pairing({ deviceName: hostLabel() })
  const token = opts.token ?? pairing.token

  const workspace = upsertWorkspace(
    opts.store,
    opts.workspaceRoot,
    opts.workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace',
  )

  // 正文库与主账本挨着放。开在这里而不是每个 run 现开：SQLite 连接有成本，
  // 而且 GC 需要一个跨 run 存活的句柄。
  const content =
    opts.content ?? new ContentStore(contentPathFor(opts.store.db.filename || ':memory:'))
  const ownsContent = opts.content === undefined

  /**
   * 真实的扩展清单。
   *
   * **握手里报假清单比不报更糟**：客户端会据此做出「隐藏入口」的正确行为，
   * 接线之后反而找不到 bug。曾经这里是硬编码的两个空数组。
   *
   * 异步加载、不阻塞服务启动：插件是子进程，一个慢插件不该让整个服务起不来。
   * 加载完成前握手拿到的是空清单——客户端在 `hello.ok` 之后还会收到
   * 能力更新（未来），当前先接受这个短暂窗口。
   */
  const extensions = {
    plugins: [] as string[],
    teamBackends: [] as string[],
    mcpServers: [] as string[],
  }
  let pluginTeardown: (() => void) | null = null
  // 服务全程持有一份引用：扩展按工作区共享，服务活着它就不该被回收。
  // 各个 Session 再各自 acquire / release，引用计数保证子进程只起一套。
  void acquireExtensions(opts.workspaceRoot, (line) => process.stderr.write(`${line}\n`))
    .then((ext) => {
      extensions.plugins = ext.plugins.plugins.map((p) => p.manifest.id)
      extensions.teamBackends = Object.keys(ext.team.backends)
      extensions.mcpServers = ext.mcp.servers.map((m) => m.name)
      for (const f of ext.mcp.failures) {
        process.stderr.write(`[qy] MCP ${f.server}：${f.reason}\n`)
      }
      for (const f of ext.plugins.failures) {
        process.stderr.write(`[qy] 插件加载失败 ${f.dir}：${f.reason}\n`)
      }
      if (ext.team.error) process.stderr.write(`[qy] team 配置：${ext.team.error}\n`)
      pluginTeardown = () => releaseExtensions(opts.workspaceRoot)
    })
    .catch((err) => {
      process.stderr.write(`[qy] 扩展加载失败：${String(err)}\n`)
    })

  // 回收上次进程留下的 running run。必须在开始服务**之前**做：
  // 留着不管的话 isBusy 会一直判真，用户在那个会话里发不出任何消息——会话被永久锁死。
  const stale = recoverStaleRuns(opts.store)
  if (stale.recovered > 0) {
    process.stderr.write(
      `[qy] 回收上次残留的 ${stale.recovered} 个执行记录` +
        (stale.ambiguous > 0 ? `，其中 ${stale.ambiguous} 个在工具执行期间中断，结果不可信` : '') +
        '\n',
    )
  }

  const unsubscribers = new Map<string, () => void>()

  /**
   * 定时任务调度器。
   *
   * ## 触发语义（这是本功能唯一真正的设计问题，不是工作量问题）
   *
   * - **跑在哪个会话**：每次触发**新建一个会话**，标题取任务标题。
   *   复用同一个会话的话，几十次触发之后上下文会长到每一轮都在压缩，
   *   而且任务之间会互相看见——「每天的日报」不该记得昨天那次的中间过程。
   *   新建会话也让每次触发都留下一个可以点开的现场。
   * - **权限按谁算**：与手动发消息完全一致（同一个 `startRun`、同一份 config）。
   *   给定时任务单开一档权限等于造一条绕过裁决的路。
   * - **失败了谁看得见**：`lastError` 落进任务本身，界面上和这条任务显示在一起。
   *   只广播事件是不够的——触发时没人开着界面，事件没有接收者。
   * - **会话忙就跳过**：上一轮还没跑完就不叠加，跳过并记一句原因。
   *
   * ## 30 秒一跳
   *
   * 调度精度是分钟级（`diagnoseSchedule` 拒绝小于 1 分钟的间隔），
   * 30 秒的 tick 保证分钟边界不会被整体错过一格。
   * `unref()` 让它不阻止进程退出——定时任务不该成为「关不掉」的理由。
   */
  const SCHEDULER_TICK_MS = 30_000
  const schedulerTimer = setInterval(() => {
    void tickSchedules()
  }, SCHEDULER_TICK_MS)
  schedulerTimer.unref?.()

  async function tickSchedules(): Promise<void> {
    const all = await loadSchedules().catch(() => [] as Schedule[])
    // 只管本工作区的：一台机器上可能同时开着两个工作区的 sidecar，
    // 不加这条过滤会让同一条任务被触发两次。
    const mine = all.filter((s) => s.workspaceRoot === opts.workspaceRoot)
    if (!mine.length) return

    const now = Date.now()
    let changed = false
    for (const s of mine) {
      if (!isDue(s, now)) continue
      s.lastRunAt = now
      changed = true
      try {
        const conv = createConversation(opts.store, {
          workspaceId: workspace.id as never,
          model: opts.config.profiles[opts.config.active]?.model ?? 'unknown',
          title: s.title,
        })
        s.lastRunConversationId = conv.id
        delete s.lastError
        await startRun(conv.id, s.prompt, undefined, {
          store: opts.store,
          content,
          config: opts.config,
          workspaceRoot: opts.workspaceRoot,
          workspaceId: workspace.id,
          bus,
          runs,
        })
      } catch (err) {
        // 失败也要把 lastRunAt 留在已更新的状态：否则下一个 tick 会立刻重试，
        // 一个稳定失败的任务会变成每 30 秒刷一个新会话。
        s.lastError = err instanceof Error ? err.message : String(err)
      }
    }
    if (changed) {
      // 只回写本工作区改过的那几条，其余原样带回——
      // 整表覆盖会把另一个 sidecar 刚写进去的状态抹掉。
      const byId = new Map(mine.map((s) => [s.id, s]))
      await saveSchedules(all.map((s) => byId.get(s.id) ?? s)).catch(() => {})
    }
  }

  /**
   * 局域网监听控制。
   *
   * 默认只绑 127.0.0.1——一启动就把工作区暴露在整个 Wi-Fi 上不是合理默认。
   * 用户点「允许手机接入」时**追加**一个 0.0.0.0 的监听器，而不是重启服务：
   * 重启会断掉桌面端的 WebSocket、丢掉正在跑的 run，代价太大。
   *
   * 两个监听器共用同一个 bus / runs / store，手机连上后看到的是同一份状态。
   * 这里用后赋值的引用是因为它们要复用主 server 的 handler，而 handler 又要
   * 能调到这几个函数——循环引用只能靠延迟解析打破。
   */
  let lanServer: ReturnType<typeof Bun.serve<SocketData>> | null = null
  let boundPort = opts.port

  let lanPort = 0

  /**
   * 局域网监听用**另一个端口**，不是主端口。
   *
   * `0.0.0.0:P` 与已绑的 `127.0.0.1:P` 在同一端口上冲突，直接报
   * 「Failed to start server. Is port P in use?」——实测撞到过。
   * 所以传 port 0 让内核挑一个空闲的，二维码指向这个新端口。
   */
  const enableLan = (): { port: number } => {
    if (!lanServer) {
      // 复用同一份 handler：两个监听器共用 bus / runs / store，
      // 手机连上后看到的是同一份状态，不是另一个副本。
      lanServer = Bun.serve<SocketData>({ ...handlers, port: 0, hostname: '0.0.0.0' })
      lanPort = lanServer.port ?? 0
    }
    return { port: lanPort }
  }
  const disableLan = (): void => {
    lanServer?.stop(true)
    lanServer = null
    lanPort = 0
  }
  const lanEnabled = (): boolean => lanServer !== null

  // handler 抽出来给两个监听器共用。
  // 只写第一个类型参数：Bun 的签名是 serve<WebSocketData, R extends string>，
  // 第二个是路由表的路径键，我们走 fetch 手动分派，没有路由表。
  const handlers = {
    // agent 的一轮可能跑很久，默认超时会把 WebSocket 掐掉。
    idleTimeout: 255,

    async fetch(req: Request, srv: Bun.Server<SocketData>) {
      const url = new URL(req.url)

      // ── WebSocket 升级 ──
      if (url.pathname === '/stream') {
        // 握手期就验令牌：不让未授权连接进入 ws 生命周期。
        if (!verifyToken(req, token)) {
          return new Response('unauthorized', { status: 401 })
        }
        const ok = srv.upgrade(req, {
          data: {
            id: crypto.randomUUID(),
            authed: true,
            origin: (url.searchParams.get('origin') as SocketData['origin']) ?? 'external',
          },
        })
        return ok ? undefined : new Response('upgrade failed', { status: 400 })
      }

      // ── 健康检查：唯一免鉴权的端点，只回协议版本 ──
      if (url.pathname === '/api/health') {
        return json({ ok: true, protocolVersion: PROTOCOL_VERSION })
      }

      if (url.pathname.startsWith('/api/')) {
        if (!verifyToken(req, token)) return json({ error: 'unauthorized' }, 401)
        try {
          const res = await handleApi(url, req, {
            store: opts.store,
            workspaceRoot: opts.workspaceRoot,
            workspaceId: workspace.id,
            config: opts.config,
            bus,
            runs,
            pairing,
            token,
            port: srv.port ?? opts.port,
            enableLan,
            disableLan,
            lanEnabled,
            lanPort: () => lanPort,
            // 定时任务的「立刻跑一次」走这条，与正常对话完全同一条路径。
            // 注入而不是让 api 模块 import：那会成环（server → api → server）。
            startRun: (conversationId, prompt) => {
              void startRun(conversationId, prompt, undefined, {
                store: opts.store,
                content,
                config: opts.config,
                workspaceRoot: opts.workspaceRoot,
                workspaceId: workspace.id,
                bus,
                runs,
              })
            },
          })
          if (res) return res
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 500)
        }
        return json({ error: 'not found' }, 404)
      }

      // ── 静态资源 ──
      if (opts.staticDir) {
        const served = await serveStatic(opts.staticDir, url.pathname)
        if (served) return served
      }
      return new Response('qywork server', { status: 200 })
    },

    websocket: {
      async message(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
        let frame: HelloFrame | ClientCommand
        try {
          frame = JSON.parse(String(raw))
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'bad json' }))
          return
        }

        if (frame.type === 'hello') {
          handleHello(ws, frame, { bus, token, unsubscribers, extensions })
          return
        }

        await handleCommand(frame as ClientCommand, {
          ws,
          store: opts.store,
          content,
          config: opts.config,
          workspaceRoot: opts.workspaceRoot,
          workspaceId: workspace.id,
          bus,
          runs,
        })
      },
      close(ws: ServerWebSocket<SocketData>) {
        unsubscribers.get(ws.data.id)?.()
        unsubscribers.delete(ws.data.id)
      },
    },
  }

  const server = Bun.serve<SocketData>({
    ...handlers,
    port: opts.port,
    hostname: opts.host,
  })
  boundPort = server.port ?? opts.port

  // git 状态轮询：文件监听在 Tauri 侧（notify），但 git 的 index/HEAD 变化
  // 也可能来自用户在终端里的操作，所以这里独立轮询一份。
  const gitTimer = setInterval(() => {
    void publishGitState(opts.workspaceRoot, bus)
  }, 4000)
  void publishGitState(opts.workspaceRoot, bus)

  return {
    server,
    bus,
    runs,
    content,
    token,
    port: boundPort,
    enableLan,
    disableLan,
    lanEnabled: () => lanServer !== null,
    pairingUrl: () => pairing.qrUrl(boundPort),
    lanUrl: () => `http://${preferredLanAddress()}:${boundPort}`,
    stop() {
      clearInterval(gitTimer)
      runs.interruptAll()
      disableLan()
      server.stop(true)
      // 插件是子进程，不显式关会留下孤儿——同一类坑已经在 sidecar 和截图脚本上踩过两次。
      pluginTeardown?.()
      // 只关自己开的：外部传进来的正文库归调用方管，替它关掉会让它下一次读直接炸。
      if (ownsContent) content.close()
    },
  }
}

// ───────────────────────── WebSocket ─────────────────────────

function handleHello(
  ws: ServerWebSocket<SocketData>,
  frame: HelloFrame,
  deps: {
    bus: EventBus
    token: string
    unsubscribers: Map<string, () => void>
    extensions: { plugins: string[]; teamBackends: string[]; mcpServers: string[] }
  },
) {
  if (frame.token !== deps.token) {
    ws.send(JSON.stringify({ type: 'hello.err', reason: 'bad_token', message: '令牌无效' }))
    ws.close(1008, 'unauthorized')
    return
  }
  if (frame.protocolVersion !== PROTOCOL_VERSION) {
    ws.send(
      JSON.stringify({
        type: 'hello.err',
        reason: 'protocol_mismatch',
        message: `服务端协议版本 ${PROTOCOL_VERSION}，客户端 ${frame.protocolVersion}`,
      }),
    )
    ws.close(1008, 'protocol')
    return
  }

  ws.data.authed = true
  ws.data.origin = frame.origin

  // 断线补发：缺口在保留窗口内就逐条补，超出就让客户端重拉全量。
  let resync = false
  let backlog: EventEnvelope[] = []
  if (typeof frame.lastSeq === 'number') {
    const replay = deps.bus.replayFrom(frame.lastSeq)
    if (replay === null) resync = true
    else backlog = replay
  }

  const off = deps.bus.subscribe({
    id: ws.data.id,
    origin: frame.origin,
    conversations: new Set(frame.subscribe ?? []),
    send: (f) => ws.send(JSON.stringify(f)),
  })
  deps.unsubscribers.set(ws.data.id, off)

  ws.send(
    JSON.stringify({
      type: 'hello.ok',
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: '0.1.0',
      sessionId: ws.data.id,
      currentSeq: deps.bus.currentSeq,
      resync,
      capabilities: {
        // PTY 在 Tauri 侧，网络那头够不着——手机端不该看到终端入口。
        pty: false,
        git: true,
        fileWatch: true,
        plugins: deps.extensions.plugins,
        teamBackends: deps.extensions.teamBackends,
        mcpServers: deps.extensions.mcpServers,
        sandbox: sandboxCapability(),
      },
    }),
  )

  for (const f of backlog) ws.send(JSON.stringify(f))
}

/**
 * 沙箱状态的握手形态。
 *
 * `detectSandbox()` 自己带缓存，所以每次握手都调不额外起进程；
 * 但**必须每次握手都重新取**而不是在 serve 启动时算一次存下来——
 * 那样一来「装上 bwrap 之后重连一下就生效」这件事就不成立了，
 * 用户得重启整个服务，而他不会知道要重启。
 */
function sandboxCapability(): { backend: string; active: boolean; reason: string } {
  const s = detectSandbox()
  return { backend: s.backend, active: s.active, reason: s.reason }
}

interface CommandDeps {
  ws: ServerWebSocket<SocketData>
  store: Store
  content: ContentStore
  config: QyConfig
  workspaceRoot: string
  workspaceId: string
  bus: EventBus
  runs: RunManager
}

async function handleCommand(cmd: ClientCommand, deps: CommandDeps): Promise<void> {
  if (!deps.ws.data.authed) return

  switch (cmd.type) {
    case 'subscribe':
      deps.bus.setSubscription(deps.ws.data.id, cmd.conversationIds)
      return

    case 'permission.resolve': {
      const by = deps.ws.data.origin === 'mobile' ? 'mobile' : 'desktop'
      deps.runs.resolvePermission(cmd.requestId, cmd.granted, by, cmd.scopeId)
      return
    }

    case 'run.interrupt':
      deps.runs.interrupt(cmd.runId)
      return

    case 'message.send':
      await startRun(cmd.conversationId, cmd.content, cmd.model, deps)
      return

    case 'conversation.setModel': {
      const updated = setConversationModel(deps.store, cmd.conversationId, cmd.model)
      if (!updated) {
        reject(deps.ws, cmd.type, 'invalid_payload', '会话不存在')
        return
      }
      // 广播而不是只回发起方：手机和桌面可能同时开着这个会话。
      deps.bus.publish(
        {
          type: 'conversation.updated',
          conversationId: updated.id,
          model: updated.model,
          title: updated.title,
        },
        cmd.conversationId,
      )
      return
    }

    case 'run.retry': {
      await retryRun(cmd.runId, cmd.clientRequestId, deps)
      return
    }

    case 'team.run': {
      await runTeam(cmd.conversationId, cmd.goal, cmd.clientRequestId, deps)
      return
    }

    case 'conversation.compact': {
      // 手动压缩是与「provider 拒绝驱动」并列的第二条入口。原版文件名就写着
      // `Rejection-driven / manual`——手动那条没有 provider 拒绝可依据，
      // 由用户的显式意图代替判据。
      if (deps.runs.isBusy(cmd.conversationId)) {
        reject(deps.ws, cmd.type, 'conflict', '该会话正在执行，请先中断再压缩')
        return
      }
      const conv = getConversation(deps.store, cmd.conversationId)
      if (!conv) {
        reject(deps.ws, cmd.type, 'invalid_payload', '会话不存在')
        return
      }
      await compactConversation(cmd.conversationId, deps)
      return
    }

    default: {
      // 协议里没有的 type。客户端比服务端新，或者是伪造流量——两种都必须回执，
      // 静默吞掉会让前者表现为「功能时灵时不灵」，让后者完全无声无息。
      const unknown = cmd as { type?: unknown }
      reject(deps.ws, String(unknown.type ?? '(missing)'), 'unknown_command', '服务端不认识该指令')
      return
    }
  }
}

/** 指令回执只回给发起方——别的客户端没发过这条指令，收到只会困惑。 */
function reject(
  ws: ServerWebSocket<SocketData>,
  command: string,
  reason: CommandRejectReason,
  message: string,
  clientRequestId?: string,
): void {
  const frame: CommandRejectedFrame = {
    type: 'command.rejected',
    command,
    reason,
    message,
    ...(clientRequestId ? { clientRequestId } : {}),
  }
  ws.send(JSON.stringify(frame))
}

/**
 * 重试一个已结束的 run。
 *
 * 三条硬约束：
 * - **只能重试已终结的 run**。还在跑的必须先中断，否则两个 run 同时往同一个
 *   工作区写文件，谁覆盖谁全看调度。
 * - **继承原 run 的 `messageIdUpperBound`**。重试要重现的是「当时那个上下文」，
 *   拿新的高水位会把重试期间用户新发的消息卷进来，那就不是重试了。
 * - **原 run 保留并标 `superseded_by`**，不删。那些步骤真实发生过，token 真的花了。
 */
async function retryRun(runId: RunId, clientRequestId: string, deps: CommandDeps): Promise<void> {
  const original = getRun(deps.store, runId)
  if (!original) {
    reject(deps.ws, 'run.retry', 'invalid_payload', 'run 不存在', clientRequestId)
    return
  }
  if (original.status === 'running' || original.status === 'queued') {
    reject(deps.ws, 'run.retry', 'conflict', '该 run 仍在执行，请先中断', clientRequestId)
    return
  }
  if (deps.runs.isBusy(original.conversationId)) {
    reject(deps.ws, 'run.retry', 'conflict', '该会话已有任务在执行', clientRequestId)
    return
  }

  // 原 run 的用户消息就是要重试的那句话。没有它（例如被清理过）无从重放。
  const userMessage = original.userMessageId
    ? listMessages(deps.store, original.conversationId, original.userMessageId).at(-1)
    : null
  if (!userMessage || userMessage.id !== original.userMessageId) {
    reject(deps.ws, 'run.retry', 'invalid_payload', '原始消息已不存在，无法重试', clientRequestId)
    return
  }

  await startRun(original.conversationId, userMessage.content, undefined, deps, {
    retryOf: original,
    clientRequestId,
  })
}

/**
 * 发起一轮。
 *
 * deps 里**不含 `ws`**：这条路径除了 `handleCommand`，还要给定时任务用，
 * 而定时触发没有发起方的连接。它本来也没用过 `ws`——事件全部走 bus 广播，
 * 因为同一个会话可能同时开在桌面端和手机上。
 */
async function startRun(
  conversationId: ConversationId,
  content: string,
  model: string | undefined,
  deps: Omit<CommandDeps, 'ws'>,
  retry?: { retryOf: Run; clientRequestId: string },
): Promise<void> {
  if (deps.runs.isBusy(conversationId)) {
    deps.bus.publish(
      {
        type: 'run.error',
        runId: '' as RunId,
        code: 'internal_error',
        message: '该会话已有任务在执行，请先中断',
        retryable: false,
      },
      conversationId,
    )
    return
  }

  const controller = new AbortController()
  let currentRunId: RunId | null = null

  const session = new Session({
    store: deps.store,
    config: deps.config,
    content: deps.content,
    workspaceRoot: deps.workspaceRoot,
    signal: controller.signal,
  })

  // 后台跑，不阻塞 WebSocket 消息循环——否则一轮 agent 跑十分钟，
  // 这十分钟里连中断指令都收不到。
  void (async () => {
    try {
      for await (const ev of session.ask(content, conversationId, {
        ...(model ? { model } : {}),
        ...(retry
          ? {
              clientRequestId: retry.clientRequestId,
              retryOf: {
                runId: retry.retryOf.id,
                userMessageId: retry.retryOf.userMessageId,
                messageIdUpperBound: retry.retryOf.messageIdUpperBound,
              },
            }
          : {}),
      })) {
        // 并非所有事件都带 runId（git.state / file.changed 是工作区级的），
        // 取之前先窄化，不能假设字段存在。
        if ('runId' in ev && ev.runId && currentRunId === null) {
          currentRunId = ev.runId as RunId
          deps.runs.register({
            runId: currentRunId,
            conversationId,
            controller,
            startedAt: Date.now(),
          })
        }
        deps.bus.publish(ev, conversationId)
      }
    } catch (err) {
      // 在 loop 之外抛出的错误（装配 adapter、解析档案）走这里。
      //
      // 这里曾经硬编码 `internal_error`——于是「没配 key」在 CLI 里报 no_api_key、
      // 在桌面端却报 internal_error，前端的「去配置」引导永远不触发。
      // 错误码是给前端决定引导动作用的，一旦压平成 internal_error 就等于没有分类。
      const pe = err instanceof ProviderError ? err : null
      const base = pe?.message ?? (err instanceof Error ? err.message : String(err))
      // 桌面端用户手边不一定有终端，「运行 qy init」对他们只是一句空话。
      // 把配置文件路径带上——那是他们真正能打开的东西。
      const message =
        pe?.code === 'no_api_key' || pe?.code === 'auth_failed'
          ? `${base}\n配置文件：${configPath()}`
          : base
      deps.bus.publish(
        {
          type: 'run.error',
          runId: (currentRunId ?? '') as RunId,
          code: pe?.code ?? 'internal_error',
          message,
          retryable: pe?.retryable ?? false,
        },
        conversationId,
      )
    } finally {
      if (currentRunId) deps.runs.unregister(currentRunId)
      // 每条消息一个 Session，每个 Session 都持有扩展的一份引用。
      // 不释放的话引用只增不减，插件与 MCP 子进程到进程退出都关不掉。
      session.dispose()
      void publishGitState(deps.workspaceRoot, deps.bus)
    }
  })()
}

/**
 * 启动一轮 Agent Team 编排。
 *
 * 编排图与角色来自工作区的 `.qy/team.json`。指令只带目标——
 * 让配置只有一个来源，否则「界面上看到的编排」和「实际跑的编排」会分叉。
 *
 * 每个成员的进展通过 `team.member` 事件广播。人工门禁（`humanGates`）走
 * `permission.request` / `permission.resolve` 通道——**两模式改造后它是这条通道
 * 仅剩的生产者**：工具授权已由 `Session.decide()` 就地裁决，不再问用户。
 * 别看到「权限」二字就以为这里也死了。
 */
async function runTeam(
  conversationId: ConversationId,
  goal: string,
  clientRequestId: string,
  deps: CommandDeps,
): Promise<void> {
  if (!goal.trim()) {
    reject(deps.ws, 'team.run', 'invalid_payload', '目标为空', clientRequestId)
    return
  }
  if (deps.runs.isBusy(conversationId)) {
    reject(deps.ws, 'team.run', 'conflict', '该会话已有任务在执行', clientRequestId)
    return
  }

  // 只读一下 team 配置就还回去。服务本身全程持有一份引用，
  // 这里 acquire 只是为了拿到已加载好的那份，不是要延长它的寿命。
  const ext = await acquireExtensions(deps.workspaceRoot)
  const team = ext.team
  releaseExtensions(deps.workspaceRoot)

  if (team.roles.length === 0) {
    // 没配就明确说没配，并指出配在哪。回一个空跑的成功会让用户以为功能坏了。
    reject(
      deps.ws,
      'team.run',
      'invalid_payload',
      team.error ?? '未配置 Agent Team：在工作区 .qy/team.json 里定义 backends 与 roles',
      clientRequestId,
    )
    return
  }

  const controller = new AbortController()
  const runId = `rn_team_${clientRequestId.slice(0, 8)}` as RunId
  deps.runs.register({ runId, conversationId, controller, startedAt: Date.now() })

  const emit = (ev: AgentEvent) => deps.bus.publish(ev, conversationId)

  // 编排的用量是各成员之和。
  //
  // 之前这里恒为 0 —— 内置后端没接线时那还算诚实，接上之后它就是在骗人了：
  // 一轮编排可能烧掉比一次普通对话多得多的 token，而账面显示 $0.0000。
  const total: RunUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: 0,
    costUsd: 0,
    turns: [],
  }
  const addUsage = (u: RunUsage) => {
    total.inputTokens += u.inputTokens
    total.outputTokens += u.outputTokens
    total.reasoningTokens += u.reasoningTokens
    total.costUsd += u.costUsd
    // 缓存命中是「有回报才累加」：全程 null 表示没有一个成员回报过，
    // 累成 0 会让前端显示「缓存一次没命中」，那是个具体但错误的结论。
    if (u.cachedTokens !== null) total.cachedTokens = (total.cachedTokens ?? 0) + u.cachedTokens
    if (u.cacheWriteTokens !== null) {
      total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + u.cacheWriteTokens
    }
    total.turns.push(...u.turns)
  }

  void (async () => {
    try {
      const orchestrator = new TeamOrchestrator(
        {
          name: 'workspace',
          roles: team.roles,
          rules: team.rules,
          ...(team.plan.length ? { plan: team.plan } : {}),
        },
        {
          workspaceRoot: deps.workspaceRoot,
          signal: controller.signal,
          // 外部 CLI 后端要它自己的 key 才能干活，但 qywork 配置里那几把它一把用不上。
          // 按值剥掉——多余的凭证没有理由出现在别人的进程里。
          secrets: collectSecrets(deps.config),
          runId,
          emit,
          runBuiltin: (input) => runBuiltinMember(input, { deps, onUsage: addUsage }),
          awaitHumanGate: async (nodeId, summary) =>
            deps.runs.requestPermission({
              runId,
              conversationId,
              toolName: 'team',
              scope: `team:gate:${nodeId}`,
              preview: summary,
              action: { kind: 'delegate', objectLabel: '编排节点', target: nodeId } as never,
            }),
        },
      )
      const results = await orchestrator.run(goal)
      const failed = results.filter((r) => r.status === 'failed').length
      emit({
        type: 'run.finished',
        runId,
        status: failed > 0 ? 'failed' : 'done',
        stopReason: failed > 0 ? 'provider_error' : 'completed',
        usage: total,
        stepCount: results.length,
        durationMs: 0,
        fileChanges: [],
      })
    } catch (err) {
      emit({
        type: 'run.error',
        runId,
        code: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      })
    } finally {
      deps.runs.unregister(runId)
    }
  })()
}

/**
 * 内置后端：用本进程的 agent 跑一个编排成员。
 *
 * 在这之前它是一句「尚未接线」的显式失败——没装 codex / claude 的用户点「开始编排」
 * 什么都得不到。而 `qy` 自己就是一个完整的 agent，把它当成一个后端用不需要新东西，
 * 只需要一个独立会话。
 *
 * ## 每个成员一个独立会话，不共用
 *
 * 成员之间的上下文必须隔离：一个「审查者」角色看见「实现者」的完整思考过程，
 * 它就不再是独立视角了，而独立视角正是多角色的全部意义。节点之间要传递的东西
 * 由编排器显式拼进 prompt（`needs` 的产出），不靠共享上下文。
 *
 * ## 内层事件不往外发
 *
 * 成员会话有自己的 runId，把它的 tool.started / text.delta 广播到父会话上，
 * 前端会按那个陌生 runId 建出一条并不存在的 run。进度由编排器的 `team.member`
 * 事件表达，那是**为这件事设计的**通道。
 */
async function runBuiltinMember(
  input: { role: Role; prompt: string; signal: AbortSignal },
  ctx: {
    deps: CommandDeps
    onUsage?: (u: RunUsage) => void
  },
): Promise<{ ok: boolean; output: string; error?: string; conversationId?: ConversationId }> {
  const { role } = input
  const backend = role.backend as BuiltinBackend
  const { deps } = ctx

  // profile 指定的是「用哪家的 key」。指了一个不存在的档案要**当场失败**——
  // 悄悄回落到当前档案会让「用便宜模型跑审查」这类配置静默失效，而账单在另一边。
  if (backend.profile && !deps.config.profiles[backend.profile]) {
    return {
      ok: false,
      output: '',
      error: `角色 ${role.id} 指定的供应商档案不存在：${backend.profile}`,
    }
  }
  const config = backend.profile ? { ...deps.config, active: backend.profile } : deps.config

  const session = new Session({
    store: deps.store,
    config,
    content: deps.content,
    workspaceRoot: deps.workspaceRoot,
    signal: input.signal,
    ...(role.systemPrompt ? { extraSystem: role.systemPrompt } : {}),
    ...(role.allowedTools ? { allowedTools: role.allowedTools } : {}),
  })

  let text = ''
  let error: string | null = null
  let conversationId: ConversationId | undefined

  try {
    for await (const ev of session.ask(
      input.prompt,
      undefined,
      backend.model ? { model: backend.model } : {},
    )) {
      if (ev.type === 'run.started') conversationId = ev.conversationId
      else if (ev.type === 'text.delta') text += ev.delta
      else if (ev.type === 'run.error') error = `[${ev.code}] ${ev.message}`
      else if (ev.type === 'run.finished') ctx.onUsage?.(ev.usage)
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    session.dispose()
  }

  const output = text.trim()
  return {
    // 没报错但一个字也没产出，算失败。返回 ok + 空串会被下游当成
    // 「这个角色认真看过，确实没什么可说的」——那是两件完全不同的事。
    ok: error === null && output.length > 0,
    output,
    ...(error ? { error } : output ? {} : { error: '该角色没有产出任何内容' }),
    ...(conversationId ? { conversationId } : {}),
  }
}

/**
 * 手动压缩一个会话。
 *
 * 与自动路径共用同一个 ，所以两条入口产出的 manifest 完全一致——
 * 两套压缩实现迟早会漂移，且漂移了很难发现。
 *
 * 事件走总线广播而不是只回发起方：压缩改变了会话的后续行为，
 * 另一端开着同一个会话的人必须看到。
 */
async function compactConversation(
  conversationId: ConversationId,
  deps: CommandDeps,
): Promise<void> {
  const emit = (ev: AgentEvent) => deps.bus.publish(ev, conversationId)
  // 手动压缩不属于任何 run，用空 runId——事件协议要求这个字段存在，
  // 但前端对压缩卡的渲染不依赖它。
  const runId = '' as RunId

  emit({ type: 'compaction', runId, phase: 'started' })
  try {
    const compaction = new RuntimeCompaction({
      store: deps.store,
      conversationId,
      messageIdUpperBound: null,
      summarize: makeServerSummarizer(deps, conversationId),
    })
    const outcome = await compaction.run()
    if (outcome.status === 'compacted') {
      emit({ type: 'compaction', runId, phase: 'done', manifest: outcome.manifest })
    } else {
      // skipped 也走 failed 通道并带上 reasonCode：用户点了按钮，
      // 「没什么可压的」也是必须回答的结果，静默等于按钮坏了。
      emit({ type: 'compaction', runId, phase: 'failed', reasonCode: outcome.reasonCode })
    }
  } catch (err) {
    emit({
      type: 'compaction',
      runId,
      phase: 'failed',
      reasonCode: err instanceof Error ? err.message.slice(0, 80) : 'internal_error',
    })
  }
}

/** 手动压缩用会话当前模型生成摘要，与自动路径口径一致。 */
function makeServerSummarizer(deps: CommandDeps, conversationId: ConversationId): Summarizer {
  const model =
    getConversation(deps.store, conversationId)?.model ??
    deps.config.profiles[deps.config.active]?.model
  const profile = model
    ? Object.values(deps.config.profiles).find((p) => p.model === model)
    : undefined
  const stored = profile ?? deps.config.profiles[deps.config.active]
  if (!stored || !model) return async () => null

  return async (prompt, budgetChars) => {
    const adapter = buildAdapter({
      kind: stored.kind,
      apiKey: resolveApiKey(stored),
      model,
      ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
      ...(stored.headers ? { headers: stored.headers } : {}),
      ...(stored.capabilities ? { capabilities: stored.capabilities } : {}),
    })
    let text = ''
    for await (const ev of adapter.stream({
      model: adapter.spec.id,
      system: [{ text: '你是会话摘要器。只输出摘要正文。' }],
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      maxOutputTokens: Math.min(adapter.spec.maxOutputTokens, Math.ceil(budgetChars / 2)),
      signal: AbortSignal.timeout(120_000),
    })) {
      if (ev.type === 'text_delta') text += ev.delta
    }
    return text.trim() || null
  }
}

// ───────────────────────── HTTP API ─────────────────────────

// ───────────────────────── 辅助 ─────────────────────────

async function publishGitState(root: string, bus: EventBus): Promise<void> {
  if (!(await git.isRepo(root))) return
  const s = await git.status(root)
  if (s) bus.publish(git.toStateEvent(s))
}

function verifyToken(req: Request, token: string): boolean {
  const got = extractToken(req)
  if (!got || got.length !== token.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ token.charCodeAt(i)
  return diff === 0
}

async function serveStatic(dir: string, pathname: string): Promise<Response | null> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '')
  // 静态目录同样要挡穿越：`GET /../../etc/passwd` 不能生效。
  if (rel.includes('..')) return null
  const file = Bun.file(join(dir, rel))
  if (await file.exists()) return new Response(file)
  // SPA 回退：未知路径交给前端路由（/m 是移动端入口）。
  const index = Bun.file(join(dir, 'index.html'))
  if (await index.exists()) return new Response(index)
  return null
}

function hostLabel(): string {
  return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'qywork'
}

export type AgentEventFrame = EventEnvelope<AgentEvent>
