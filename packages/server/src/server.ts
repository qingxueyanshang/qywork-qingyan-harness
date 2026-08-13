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

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, ClientCommand, EventEnvelope, HelloFrame, Workspace } from '@qywork/core'
import type { QyConfig, Schedule } from '@qywork/runtime'
import {
  acquireExtensions,
  configDir,
  isDue,
  loadSchedules,
  releaseExtensions,
  updateSchedules,
} from '@qywork/runtime'
import type { Store } from '@qywork/store'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  getWorkspaceByPath,
  listWorkspaces,
  recoverStaleRuns,
  upsertWorkspace,
} from '@qywork/store'
import type { ServerWebSocket } from 'bun'
import { handleApi, json } from './api/index.ts'
import { sweepAttachments } from './attachments-gc.ts'
import { EventBus } from './bus.ts'
import { handleCommand } from './commands.ts'
import type { SocketData } from './deps.ts'
import { handleHello } from './handshake.ts'
import { CORS_HEADERS, hostLabel, publishGitState, serveStatic, withCors } from './http-util.ts'
import { extractToken, Pairing, preferredLanAddress } from './pairing.ts'
import { startRun } from './run-control.ts'
import { RunManager } from './runs.ts'

export interface ServeOptions {
  store: Store
  config: QyConfig
  /**
   * 正文库。不传则自动挨着主账本开一个（`:memory:` 账本对应内存正文库）。
   * 超预算的工具输出落在这里，模型用 read_resource 读回。
   */
  content?: ContentStore
  /**
   * 启动时用哪个目录当项目。
   *
   * **不给是合法的，而且和「给了进程 cwd」不是一回事。** 不给 = 由服务端决定：
   * 账本里有项目就用最近打开的那个，一个都没有才建默认工作区。
   *
   * 把进程 cwd 当默认值是错的：桌面外壳的 cwd 是安装目录或 `src-tauri`，
   * 登记进去就成了一个谁也没要过的项目（ROADMAP §33.2）。
   */
  workspaceRoot?: string
  port: number
  host: string
  /** web 构建产物目录；不存在时只提供 API。 */
  staticDir?: string
  /** 由外部注入的令牌（Tauri spawn 时用环境变量传），不传则自己生成。 */
  token?: string
}

/** 首次运行时建的那个工作区叫什么。已落盘的目录名是历史事实，别改（D2）。 */
const DEFAULT_WORKSPACE_NAME = '默认工作区'

/**
 * 决定启动时挂在哪个项目上。**这是「首次运行挂哪儿」的唯一权威。**
 *
 * 三条路，优先级从高到低：
 *
 * 1. 显式给了根 —— 照用（`qy serve --cwd <目录>` 是 CLI 的正常用法）。
 * 2. 账本里已有项目 —— 用最近打开的那个（`listWorkspaces` 已按「置顶 > 最近打开」
 *    排序，取第一条）。**首次之后每次启动都走这条**，所以用户在界面里切过的项目
 *    不会被启动目录顶掉。
 * 3. 一个都没有 —— 在 `~/.qywork/workspaces/默认工作区/` 建一个。
 *
 * 第 3 条是关键：原来无条件登记启动目录，于是首次运行「挂在启动目录上」——
 * 桌面端的启动目录就是 qywork 的源码树，用户拿到的默认项目是这个仓库本身。
 *
 * 目录用 `mkdirSync`：账本这一行必须和目录同生共死，异步建目录会留下一段
 * 「行已经在了、目录还没有」的窗口，而那段时间里任何工具调用都会因为根不存在而炸。
 */
function bootstrapWorkspace(
  store: Store,
  explicitRoot?: string,
): { workspace: Workspace; rootPath: string } {
  if (explicitRoot) {
    const name = explicitRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'
    const known = getWorkspaceByPath(store, explicitRoot)
    return {
      workspace: upsertWorkspace(store, explicitRoot, known?.name ?? name),
      rootPath: explicitRoot,
    }
  }

  const recent = listWorkspaces(store)[0]
  if (recent) return { workspace: recent, rootPath: recent.rootPath }

  const rootPath = join(configDir(), 'workspaces', DEFAULT_WORKSPACE_NAME)
  mkdirSync(rootPath, { recursive: true })
  process.stderr.write(`[qy] 首次运行，已创建默认工作区 ${rootPath}\n`)
  return { workspace: upsertWorkspace(store, rootPath, DEFAULT_WORKSPACE_NAME), rootPath }
}

export function serve(opts: ServeOptions) {
  const bus = new EventBus()
  const runs = new RunManager(opts.store, bus)
  // 令牌只有这一个持有者。外部注入的也交给它，鉴权才只有一条路径。
  const pairing = new Pairing({
    deviceName: hostLabel(),
    ...(opts.token ? { token: opts.token } : {}),
  })
  const token = pairing.token

  /*
   * 启动时的项目。三条路，优先级从高到低：
   *
   * 1. **显式给了 `workspaceRoot`** —— 照用（`qy serve --cwd <目录>`）。
   * 2. **账本里已有项目** —— 用最近打开的那个。`listWorkspaces` 已按
   *    「置顶 > 最近打开」排序，取第一条即可。
   * 3. **一个都没有（首次运行）** —— 建一个默认工作区。
   *
   * 第 3 条是补上的。原来无条件登记 `opts.workspaceRoot`，于是首次运行
   * 「挂在启动目录上」——桌面端的启动目录就是这个仓库自己，用户拿到的默认项目
   * 是 qywork 的源码树。
   */
  const { workspace, rootPath: workspaceRoot } = bootstrapWorkspace(opts.store, opts.workspaceRoot)

  // 正文库与主账本挨着放。开在这里而不是每个 run 现开：SQLite 连接有成本，
  // 而且 GC 需要一个跨 run 存活的句柄。
  const content =
    opts.content ?? new ContentStore(contentPathFor(opts.store.db.filename || ':memory:'))
  const ownsContent = opts.content === undefined

  /**
   * 预热启动那个项目的扩展，并全程持有一份引用。
   *
   * **扩展清单不在这里存一份给握手用了。** 扩展是按工作区的
   * （`.qy/plugins`、`.qy/mcp.json`、`.qy/team.json` 都在项目目录下），
   * 而一条 WebSocket 连接横跨用户开着的所有项目——存一份就等于「A 项目的插件
   * 显示在 B 项目上」，而且只在重连时才更新。清单改由 `/api/capabilities?ws=` 回答。
   *
   * 这里仍然 acquire：各个 Session 再各自 acquire / release，引用计数保证
   * 子进程只起一套；服务持有一份让启动项目的插件不会在两轮之间被反复拉起又杀掉。
   * 异步、不阻塞服务启动——一个慢插件不该让整个服务起不来。
   */
  let pluginTeardown: (() => void) | null = null
  void acquireExtensions(workspaceRoot, (line) => process.stderr.write(`${line}\n`))
    .then((ext) => {
      for (const f of ext.mcp.failures) {
        process.stderr.write(`[qy] MCP ${f.server}：${f.reason}\n`)
      }
      for (const f of ext.plugins.failures) {
        process.stderr.write(`[qy] 插件加载失败 ${f.dir}：${f.reason}\n`)
      }
      if (ext.team.error) process.stderr.write(`[qy] team 配置：${ext.team.error}\n`)
      pluginTeardown = () => releaseExtensions(workspaceRoot)
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

  // 附件目录的回收。只在启动时跑一次，判据是「有没有被消息引用」——
  // 运行期跑会误删「刚上传、还挂在输入框上没发出去」的那一份。
  // 失败不阻断启动：它回收的是磁盘空间，不是正确性。
  void sweepAttachments(opts.store, workspaceRoot)
    .then((r) => {
      if (r.removed > 0) {
        process.stderr.write(
          `[qy] 清理了 ${r.removed} 个没有被任何消息引用的附件（${Math.round(r.bytes / 1024)} KB）
`,
        )
      }
    })
    .catch(() => {})

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
    const mine = all.filter((s) => s.workspaceRoot === workspaceRoot)
    if (!mine.length) return

    const now = Date.now()
    // 先收集要打的补丁，最后**在一次串行的读-改-写里**落盘。
    // 直接改这份快照再整表回写的话，这段 await 期间用户在设置页新建 / 删除的任务
    // 会被这份过期快照抹掉——两条写入路径各拿各的快照，就是标准的丢更新。
    const patches = new Map<string, Partial<Schedule>>()
    for (const s of mine) {
      if (!isDue(s, now)) continue
      const patch: Partial<Schedule> = { lastRunAt: now }
      patches.set(s.id, patch)
      try {
        const conv = createConversation(opts.store, {
          workspaceId: workspace.id as never,
          model: opts.config.active.model,
          title: s.title,
        })
        patch.lastRunConversationId = conv.id
        await startRun(conv.id, s.prompt, undefined, {
          store: opts.store,
          content,
          config: opts.config,
          bus,
          runs,
        })
      } catch (err) {
        // 失败也要把 lastRunAt 留在已更新的状态：否则下一个 tick 会立刻重试，
        // 一个稳定失败的任务会变成每 30 秒刷一个新会话。
        patch.lastError = err instanceof Error ? err.message : String(err)
      }
    }
    if (patches.size === 0) return

    await updateSchedules((cur) =>
      cur.map((s) => {
        const patch = patches.get(s.id)
        if (!patch) return s
        // 成功那次要把上一轮的错误清掉；`lastError` 在补丁里没有就是「这次没错」。
        const { lastError: _prev, ...rest } = s
        return { ...rest, ...patch }
      }),
    ).catch(() => {})
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
        if (!pairing.verify(extractToken(req))) {
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

      // ── 跨源预检：必须答在验令牌之前 ──
      // 预检按规范不带 Authorization，用同一把尺子量它只会得到 401，
      // 而 401 的预检意味着**真正那条请求根本不会发出**。详见 CORS_HEADERS。
      if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
        return new Response(null, { status: 204, headers: CORS_HEADERS })
      }

      // ── 健康检查：唯一免鉴权的端点，只回协议版本 ──
      if (url.pathname === '/api/health') {
        return withCors(json({ ok: true }))
      }

      if (url.pathname.startsWith('/api/')) {
        if (!pairing.verify(extractToken(req))) {
          return withCors(json({ error: 'unauthorized' }, 401))
        }
        try {
          const res = await handleApi(url, req, {
            store: opts.store,
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
                bus,
                runs,
              })
            },
          })
          if (res) return withCors(res)
        } catch (err) {
          return withCors(json({ error: err instanceof Error ? err.message : String(err) }, 500))
        }
        return withCors(json({ error: 'not found' }, 404))
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
          handleHello(ws, frame, {
            bus,
            token,
            unsubscribers,
            config: opts.config,
          })
          return
        }

        await handleCommand(frame as ClientCommand, {
          ws,
          store: opts.store,
          content,
          config: opts.config,
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

  /*
   * git 状态轮询：文件监听在 Tauri 侧（notify），但 git 的 index/HEAD 变化
   * 也可能来自用户在终端里的操作，所以这里独立轮询一份。
   *
   * **只轮询最近打开的那个项目**，不是每个项目各轮一份：N 个项目就是每 4 秒
   * N 个 git 子进程，而用户同一时刻只看得见一个。「最近打开」由 `last_opened_at`
   * 定义，切项目时前端会 upsert 一次把它顶上来——所以这条轮询天然跟着当前项目走，
   * 不需要再记一个「当前是谁」的状态。
   */
  const pollGit = () => {
    const [recent] = listWorkspaces(opts.store)
    if (recent) void publishGitState(recent.rootPath, recent.id, bus)
  }
  const gitTimer = setInterval(pollGit, 4000)
  pollGit()

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

export type AgentEventFrame = EventEnvelope<AgentEvent>
