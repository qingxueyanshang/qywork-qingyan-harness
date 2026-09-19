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
import type { AgentEvent, ClientCommand, EventEnvelope, HelloFrame } from '@qywork/core'
import { log, NATIVE_BROWSER_PATH, NATIVE_DESKTOP_PATH } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import {
  acquireExtensions,
  collectResourceGarbage,
  collectSecrets,
  configDir,
  importLegacySchedules,
  releaseExtensions,
} from '@qywork/runtime'
import type { ProcessExitObservation, Store } from '@qywork/store'
import {
  ContentStore,
  contentPathFor,
  getWorkspaceByPath,
  mostRecentWorkspace,
  recoverStaleRuns,
  upsertWorkspace,
} from '@qywork/store'
import type { ServerWebSocket } from 'bun'
import { handleApi, json } from './api/index.ts'
import { BrowserBridge } from './browser/bridge.ts'
import { browserCapability } from './browser/capability.ts'
import { BrowserCoordinator } from './browser/coordinator.ts'
import { EventBus } from './bus.ts'
import { handleCommand } from './commands.ts'
import type { SocketData } from './deps.ts'
import { DesktopBridge } from './desktop/bridge.ts'
import { desktopCapability } from './desktop/capability.ts'
import { DesktopCoordinator } from './desktop/coordinator.ts'
import { createGitWatch } from './git-watch.ts'
import { handleHello } from './handshake.ts'
import { CORS_HEADERS, hostLabel, serveStatic, withCors } from './http-util.ts'
import { extractToken, Pairing, preferredLanAddress } from './pairing.ts'
import { sanitizeProcessExitObservation } from './process-exit.ts'
import { startRun } from './run-control.ts'
import { RunManager } from './runs.ts'
import { startScheduler } from './scheduler.ts'
import { SubagentRegistry } from './subagents.ts'

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
   * 一经登记便会产生一个无人请求过的项目。
   */
  workspaceRoot?: string
  port: number
  host: string
  /** web 构建产物目录；不存在时只提供 API。 */
  staticDir?: string
  /** 由外部注入的令牌（Tauri spawn 时用环境变量传），不传则自己生成。 */
  token?: string
  /**
   * 原生宿主连接的凭据（桌面外壳 spawn 时用环境变量传）。
   *
   * **一份凭据管两条宿主路径**：`/native/browser` 与 `/native/desktop` 由同一个桌面
   * 外壳进程发起，同一次启动只有一个随机值；是哪一种宿主由服务端按 URL 路径判定，
   * 不看客户端自报的字段。
   *
   * **不传两条路径都不存在**：宿主连接一律拒绝，浏览器控制与电脑操作两条能力都不发布。
   * 不给它一个默认值——默认值等于人人都能注册宿主。
   */
  hostKey?: string
  updateHostKey?: string
  /** 桌面外壳刚观察到的上一份 qy serve 终态。只用于本次启动的孤儿 run 回收。 */
  previousProcessExit?: ProcessExitObservation
  /**
   * 调度 tick 间隔，毫秒。缺省 `SCHEDULER_TICK_MS`。
   *
   * 唯一的用途是让回归测试用真实计时器驱动生产的那条推进路径，而不是把等待时间拉到分钟级。
   * 不要用它调节生产精度：到期判定是分钟级的，改这个数只会让 tick 空转。
   */
  schedulerTickMs?: number
}

/** 首次运行时建的那个工作区叫什么。已落盘的目录名是历史事实，别改（D2）。 */
const DEFAULT_WORKSPACE_NAME = '默认工作区'

/**
 * HTTP 入口的资源安全线，不是图片/视频的模型能力线。
 *
 * 浏览器拿不到绝对路径时才会把附件传给本机服务；桌面拖入始终只传路径。百炼官方
 * 临时文件协议的硬上限是 1 GB，因此允许这条兜底链覆盖到同一数量级，同时阻止一个
 * 已配对客户端用无界请求耗尽磁盘。具体模型更小的限制由 Provider 凭证/请求裁决。
 */
const MAX_HTTP_REQUEST_BODY_BYTES = 1024 * 1024 * 1024

/**
 * 决定启动时挂在哪个项目上。**这是「首次运行挂哪儿」的唯一权威。**
 *
 * 三条路，优先级从高到低：
 *
 * 1. 显式给了根 —— 照用（`qy serve --cwd <目录>` 是 CLI 的正常用法）。
 * 2. 账本里已有项目 —— 用最近打开的那个（`mostRecentWorkspace`）。
 *    **首次之后每次启动都走这条**，所以用户在界面里切过的项目不会被启动目录顶掉。
 *    注意它和侧栏顺序是两回事：侧栏按「置顶 > 添加先后」稳定排列，不跟着切换重排。
 * 3. 一个都没有 —— 在 `~/.qywork/workspaces/默认工作区/` 建一个。
 *
 * 第 3 条是关键：**不能无条件登记启动目录**，那样首次运行就「挂在启动目录上」——
 * 桌面端的启动目录是 qywork 的源码树，用户拿到的默认项目会是这个仓库本身。
 *
 * 目录用 `mkdirSync`：账本这一行必须和目录同生共死，异步建目录会留下一段
 * 「行已经在了、目录还没有」的窗口，而那段时间里任何工具调用都会因为根不存在而炸。
 */
function bootstrapWorkspace(store: Store, explicitRoot?: string): string {
  if (explicitRoot) {
    const name = explicitRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'
    const known = getWorkspaceByPath(store, explicitRoot)
    upsertWorkspace(store, explicitRoot, known?.name ?? name)
    return explicitRoot
  }

  const recent = mostRecentWorkspace(store)
  if (recent) return recent.rootPath

  const rootPath = join(configDir(), 'workspaces', DEFAULT_WORKSPACE_NAME)
  mkdirSync(rootPath, { recursive: true })
  log.info('server', '首次运行，已创建默认工作区', { rootPath })
  upsertWorkspace(store, rootPath, DEFAULT_WORKSPACE_NAME)
  return rootPath
}

export function serve(opts: ServeOptions) {
  const bus = new EventBus()
  // 在跑的子 agent 与 run 同级：它们的生命期跟着会话，不跟着派它们的那一轮。
  const subagents = new SubagentRegistry()
  const runs = new RunManager(opts.store, bus, subagents)
  /*
   * 浏览器宿主连接与控制协调器。**没有凭据就没有这两样**：宿主路径不接受连接，
   * 会话装配也拿不到端口，界面上不会出现一个点了报错的入口。
   */
  const browserBridge = opts.hostKey ? new BrowserBridge(opts.hostKey) : null
  const browser = browserBridge ? new BrowserCoordinator(browserBridge) : null
  /*
   * 宿主连上 / 断开时把能力投影重播一份。
   *
   * 握手只报一次，而宿主是应用起来之后才连上来的：只有握手那一份的话，界面要等
   * 下一次重连才看得见浏览器入口。判定与握手共用 `browserCapability`。
   */
  const offBrowserHost = browserBridge?.onHostChange(() => {
    bus.publish({ type: 'browser.state', browser: browserCapability(browserBridge) })
  })
  /*
   * 桌面宿主连接与电脑操作协调器。**与浏览器共用同一份宿主凭据**：两条路径由同一个
   * 桌面外壳进程发起，同一次启动只有一个随机值；哪一种宿主由 URL 路径判定，
   * 不看客户端自报的字段。没有凭据就没有这两样。
   *
   * 两个开关都现读 `opts.config`：那份对象由 `/api/config` 的 PUT 就地改写，
   * 存一份快照的话用户在设置里改完之后要等重启才生效。前台接管那一个随每条请求下发到
   * worker，运行中关掉在下一次派发就被拒。
   *
   * **两个开关的缺省不同，判据也因此不同。** 电脑操作缺席按启用（`!== false`），
   * 与浏览器控制一致：它只发后台语义动作，不动真实指针键盘。前台接管缺席按关闭
   * （`=== true`），它会占用用户的鼠标与键盘，只能由用户显式打开。
   */
  const desktopBridge = opts.hostKey
    ? new DesktopBridge(opts.hostKey, () => opts.config.desktopForeground === true)
    : null
  const desktop = desktopBridge
    ? new DesktopCoordinator(desktopBridge, () => opts.config.desktopEnabled !== false)
    : null
  const offDesktopHost = desktopBridge?.onHostChange(() => {
    bus.publish({ type: 'desktop.state', desktop: desktopCapability(desktopBridge) })
  })
  const offDesktopTarget = desktop?.onTargetChange((app, foreground) => {
    bus.publish({ type: 'desktop.target', app, foreground })
  })
  const gitWatch = createGitWatch(opts.store, bus)
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
   * 2. **账本里已有项目** —— 用最近打开的那个（`mostRecentWorkspace`）。
   * 3. **一个都没有（首次运行）** —— 建一个默认工作区。
   *
   * 第 3 条不能省：无条件登记 `opts.workspaceRoot` 的话，首次运行就「挂在启动
   * 目录上」——桌面端的启动目录是这个仓库自己，用户拿到的默认项目会是 qywork
   * 的源码树。
   */
  const workspaceRoot = bootstrapWorkspace(opts.store, opts.workspaceRoot)

  // 正文库与主账本挨着放。开在这里而不是每个 run 现开：SQLite 连接有成本，
  // 而且 GC 需要一个跨 run 存活的句柄。
  const content =
    opts.content ?? new ContentStore(contentPathFor(opts.store.db.filename || ':memory:'))
  const ownsContent = opts.content === undefined

  /**
   * 预热启动那个项目的扩展，并全程持有一份引用。
   *
   * **扩展清单不在这里存一份给握手用。** 扩展里的 MCP 与编排是按工作区的
   * （`.agents/mcp.json`、`.qy/team.json` 在项目目录下），而一条 WebSocket 连接
   * 横跨用户开着的所有项目——存一份就等于「A 项目的 MCP 显示在 B 项目上」，
   * 而且只在重连时才更新。要看清单去各自的设置页，它们按项目现取。
   *
   * 这里仍然 acquire：各个 Session 再各自 acquire / release，引用计数保证
   * 子进程只起一套；服务持有一份让启动项目的插件不会在两轮之间被反复拉起又杀掉。
   * 异步、不阻塞服务启动——一个慢插件不该让整个服务起不来。
   */
  let pluginTeardown: (() => void) | null = null
  void acquireExtensions(workspaceRoot, (line) => log.info('extensions', line))
    .then((ext) => {
      for (const f of ext.mcp.failures) {
        log.warn('extensions', `MCP ${f.server}：${f.reason}`)
      }
      for (const f of ext.plugins.failures) {
        log.warn('extensions', `插件加载失败 ${f.dir}：${f.reason}`)
      }
      if (ext.team.error) log.warn('extensions', `team 配置：${ext.team.error}`)
      pluginTeardown = () => releaseExtensions(workspaceRoot)
    })
    .catch((err) => {
      log.error('extensions', `扩展加载失败：${String(err)}`)
    })

  // 回收上次进程留下的 running run。必须在开始服务**之前**做：
  // 留着不管的话 hasRun 会一直判真，用户在那个会话里发不出任何消息——会话被永久锁死。
  //
  // 只回收**没人在跑**的那些（判据见 `store/repos.ts` 的 `isOrphan`）。无差别
  // 回收的话，本进程一启动就把别的进程正在跑的那一轮判成中断——账本是共享的，
  // 而一台机器上同时可以有好几个写入者。
  const previousExit = opts.previousProcessExit
    ? sanitizeProcessExitObservation(opts.previousProcessExit, collectSecrets(opts.config))
    : undefined
  const stale = recoverStaleRuns(opts.store, previousExit)
  if (stale.recovered > 0) {
    log.warn('runs', '已回收上次残留的执行记录', {
      recovered: stale.recovered,
      // 在工具执行期间中断的那些结果不可信
      ambiguous: stale.ambiguous,
      previousExit: previousExit?.exitKind ?? null,
    })
  }
  // 跳过的也要说。不说的话「回收了 0 个」有两种含义（没有残留 / 有但都还在运行），
  // 而这两种在排查「为什么那条会话还显示执行中」时是完全不同的方向。
  if (stale.heldByOthers > 0) {
    log.info('runs', '另有执行记录由其它运行中的进程持有，未回收', {
      heldByOthers: stale.heldByOthers,
    })
  }

  /*
   * `~/.qywork/schedules.json` 的一次性导入。**必须在开始服务之前**：导入之后任务表的
   * 唯一权威是账本，调度、HTTP 面与模型工具都只读账本，运行期不再读那个文件。
   *
   * 文件不合法时抛出，沿既有启动失败路径退出并保留原字节——静默当成空表等于界面上定时任务
   * 全部消失，用户会再建一遍。
   */
  const importedSchedules = importLegacySchedules(opts.store)
  if (importedSchedules !== null) {
    log.info('scheduler', '已把定时任务文件导入账本', { count: importedSchedules })
  }

  /*
   * 正文回收。放在残留 run 回收与任务导入**之后**、开始接受执行之前：引用集合要等账本
   * 稳定下来才算数，而这一次回收要清掉的正是上次进程在登记引用之前退出留下的孤儿。
   *
   * 失败只写一行 stderr，不拦启动：回收的是磁盘空间，不是正确性；下一次启动或下一次
   * 删除会话会再收一次。这里不加定时器，也不按时间删仍有引用的正文。
   */
  const collectGarbage = () => collectResourceGarbage(opts.store, content)
  try {
    const { removed } = collectGarbage()
    if (removed > 0) log.info('content', '已回收无人引用的正文', { removed })
  } catch (err) {
    log.error('content', `正文回收失败：${err instanceof Error ? err.message : String(err)}`)
  }

  const unsubscribers = new Map<string, () => void>()

  /*
   * 定时任务调度。推进函数在 `scheduler.ts`，这里只负责启停。
   *
   * 装配用的依赖与手动发消息完全一致：同一个 `startRun`、同一份 config。
   */
  const scheduler = startScheduler(
    {
      store: opts.store,
      config: opts.config,
      canStart: () => !runs.updating,
      start: (conversationId, prompt) =>
        startRun(conversationId, prompt, undefined, {
          store: opts.store,
          content,
          config: opts.config,
          bus,
          runs,
          subagents,
          ...(browser ? { browser } : {}),
          ...(desktop ? { desktop } : {}),
        }),
    },
    opts.schedulerTickMs,
  )

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
   * 「Failed to start server. Is port P in use?」。
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
  // 第二个是路由表的路径键，这里走 fetch 手动分派，没有路由表。
  const handlers = {
    // agent 的一轮可能跑很久，默认超时会把 WebSocket 掐掉。
    idleTimeout: 255,
    maxRequestBodySize: MAX_HTTP_REQUEST_BODY_BYTES,

    async fetch(req: Request, srv: Bun.Server<SocketData>) {
      const url = new URL(req.url)

      if (url.pathname === '/internal/app-update') {
        const address = srv.requestIP(req)?.address
        if (
          !opts.updateHostKey ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '') ||
          req.headers.get('x-qywork-update-key') !== opts.updateHostKey
        ) {
          return new Response('unauthorized', { status: 401 })
        }
        if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
        const body = (await req.json().catch(() => null)) as { action?: unknown } | null
        if (!body || typeof body !== 'object') return json({ error: 'invalid action' }, 400)
        if (body.action === 'cancel') {
          runs.cancelUpdate()
          return json({ claimed: false })
        }
        if (body.action !== 'claim') return json({ error: 'invalid action' }, 400)
        return json({ claimed: runs.claimUpdate(), busy: runs.busyConversations().length })
      }

      /*
       * ── 原生宿主连接 ──
       *
       * 必须排在 `/stream` 之前单独判：它们不验配对令牌，验的是宿主凭据加回环地址，
       * 而且升级后各走一条独立的帧处理路径。**是哪一种宿主由路径定**，写进
       * `ws.data.native`，之后的三处分派都只读这一格。
       */
      if (url.pathname === NATIVE_BROWSER_PATH || url.pathname === NATIVE_DESKTOP_PATH) {
        const kind = url.pathname === NATIVE_BROWSER_PATH ? 'browser' : 'desktop'
        const bridge = kind === 'browser' ? browserBridge : desktopBridge
        if (!bridge?.accepts(req, srv.requestIP(req)?.address ?? null)) {
          return new Response('unauthorized', { status: 401 })
        }
        const ok = srv.upgrade(req, {
          data: {
            id: crypto.randomUUID(),
            authed: true,
            origin: 'cli' as const,
            native: kind,
            openedAt: Date.now(),
          },
        })
        return ok ? undefined : new Response('upgrade failed', { status: 400 })
      }

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
            native: null,
            openedAt: Date.now(),
          },
        })
        return ok ? undefined : new Response('upgrade failed', { status: 400 })
      }

      // ── 跨源预检：必须答在验令牌之前 ──
      // 预检按规范不带 Authorization，用同一把尺子量它只会得到 401，
      // 而 401 的预检意味着**真正那条请求不会发出**。详见 CORS_HEADERS。
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
                subagents,
                ...(browser ? { browser } : {}),
                ...(desktop ? { desktop } : {}),
              })
            },
            watchGit: () => gitWatch.retarget(),
            collectGarbage,
            closeBrowserPages: (conversationId) =>
              browser?.closeConversation(conversationId) ?? Promise.resolve(),
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
        // 宿主连接只走各自的资源操作，聊天指令一概不在这两条路径上解析。
        if (ws.data.native === 'browser') {
          browserBridge?.message(ws, String(raw))
          return
        }
        if (ws.data.native === 'desktop') {
          desktopBridge?.message(ws, String(raw))
          return
        }
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
            runs,
            browser: () => browserCapability(browserBridge),
            desktop: () => desktopCapability(desktopBridge),
            announceGit: () => gitWatch.announce(),
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
          subagents,
          ...(browser ? { browser } : {}),
          ...(desktop ? { desktop } : {}),
        })
      },
      open(ws: ServerWebSocket<SocketData>) {
        if (ws.data.native) {
          if (ws.data.native === 'browser') browserBridge?.open(ws)
          else desktopBridge?.open(ws)
          log.info('ws', 'open', { id: ws.data.id, origin: `native-${ws.data.native}` })
          return
        }
        log.info('ws', 'open', { id: ws.data.id, origin: ws.data.origin })
      },
      /*
       * 关闭码与原因是「谁先断的」唯一线索：1000/1001 是对端正常关，1006 是没收到关闭帧
       * （对端进程没了、连接被掐），1008 是本端握手拒绝。时长用来区分「刚连上就断」
       * 与「挂了几小时才断」。
       */
      close(ws: ServerWebSocket<SocketData>, code: number, reason: string) {
        log.info('ws', 'close', {
          id: ws.data.id,
          origin: ws.data.origin,
          code,
          reason,
          seconds: Math.round((Date.now() - ws.data.openedAt) / 1000),
        })
        if (ws.data.native) {
          if (ws.data.native === 'browser') browserBridge?.close(ws)
          else desktopBridge?.close(ws)
          return
        }
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
  log.info('server', '开始服务', {
    port: boundPort,
    host: opts.host,
    workspace: workspaceRoot,
    streamId: bus.streamId,
  })

  // 分支名跟着 `.git/HEAD` 走，理由与边界都在 `git-watch.ts`。
  gitWatch.retarget()

  return {
    server,
    bus,
    runs,
    content,
    token,
    browser,
    desktop,
    port: boundPort,
    // 启动横幅要显示的是**真正生效的**工作区。调用方传进来的可能是 null
    // （没给 --cwd），那时由 bootstrapWorkspace 决定用哪个，只有这里知道结果。
    workspaceRoot,
    enableLan,
    disableLan,
    lanEnabled: () => lanServer !== null,
    pairingUrl: () => pairing.qrUrl(boundPort),
    lanUrl: () => `http://${preferredLanAddress()}:${boundPort}`,
    stop() {
      log.info('server', '停止服务', { port: boundPort })
      scheduler.stop()
      gitWatch.stop()
      offBrowserHost?.()
      browser?.stop()
      offDesktopHost?.()
      offDesktopTarget?.()
      desktop?.stop()
      runs.interruptAll()
      // 子 agent 跟会话不跟 run，关服时要单独停：不停就是一批没人收回执的进程。
      subagents.interruptAll()
      disableLan()
      server.stop(true)
      // 插件是子进程，不显式关会留下孤儿——sidecar 与截图脚本上是同一条约束。
      pluginTeardown?.()
      // 只关自己开的：外部传进来的正文库归调用方管，替它关掉会让它下一次读抛错。
      if (ownsContent) content.close()
    },
  }
}

// ───────────────────────── WebSocket ─────────────────────────

export type AgentEventFrame = EventEnvelope<AgentEvent>
