/**
 * `qy serve`：本地 HTTP 与 WebSocket 服务。
 *
 * 桌面端与手机端连接同一个服务、使用同一套协议。桌面端不经由 Tauri IPC 取得数据，
 * 它是本服务的一个 Web 客户端：手机端因此无需第二套后端，两端的能力也不会出现差异。
 *
 * 绑定地址：默认绑定 0.0.0.0，手机因此能够连接，同一 Wi-Fi 下的任何设备也都能访问，
 * 所以令牌鉴权是强制的（见 pairing.ts）。仅供本机使用时传 --host 127.0.0.1。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lookupMediaModel } from '@qywork/ai'
import type { AgentEvent, ClientCommand, EventEnvelope, HelloFrame } from '@qywork/core'
import { log, NATIVE_BROWSER_PATH, NATIVE_DESKTOP_PATH } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import {
  acquireExtensions,
  collectResourceGarbage,
  collectSecrets,
  configDir,
  createOfficeHost,
  importLegacySchedules,
  releaseExtensions,
  resolveMediaModel,
} from '@qywork/runtime'
import type { ProcessExitObservation, ScheduleClaim, Store } from '@qywork/store'
import {
  ContentStore,
  contentPathFor,
  getWorkspaceByPath,
  listWorkspaces,
  mostRecentWorkspace,
  recoverStaleRuns,
  upsertWorkspace,
} from '@qywork/store'
import type { ServerWebSocket } from 'bun'
import { uiMediaPort } from './api/canvas.ts'
import { handleApi, json } from './api/index.ts'
import { BrowserBridge } from './browser/bridge.ts'
import { browserCapability } from './browser/capability.ts'
import { BrowserCoordinator } from './browser/coordinator.ts'
import { EventBus } from './bus.ts'
import { CanvasService } from './canvas.ts'
import { handleCommand, reject } from './commands.ts'
import type { SocketData } from './deps.ts'
import { DesktopBridge } from './desktop/bridge.ts'
import { desktopCapability } from './desktop/capability.ts'
import { DesktopCoordinator } from './desktop/coordinator.ts'
import { createGitWatch } from './git-watch.ts'
import { handleHello } from './handshake.ts'
import { CORS_HEADERS, hostLabel, serveStatic, withCors } from './http-util.ts'
import { extractToken, Pairing, preferredLanAddress } from './pairing.ts'
import { sanitizeProcessExitObservation } from './process-exit.ts'
import { submitMessage } from './run-control.ts'
import { RunManager } from './runs.ts'
import { startScheduler } from './scheduler.ts'
import { SubagentRegistry } from './subagents.ts'

export interface ServeOptions {
  store: Store
  config: QyConfig
  /**
   * 正文库。未传入时在主账本旁打开一个（`:memory:` 账本对应内存正文库）。
   * 超出预算的工具输出写入此处，模型用 read_resource 读取。
   */
  content?: ContentStore
  /**
   * 启动时作为项目的目录。
   *
   * 未传入是合法的，且与传入进程 cwd 含义不同。未传入时由服务端决定：
   * 账本中有项目时使用最近打开的项目，没有任何项目时创建默认工作区。
   *
   * 不要以进程 cwd 作为默认值：桌面外壳的 cwd 是安装目录或 `src-tauri`，
   * 登记后会产生一个用户未请求的项目。
   */
  workspaceRoot?: string
  port: number
  host: string
  /** web 构建产物目录；不存在时只提供 API。 */
  staticDir?: string
  /** 由外部注入的令牌（Tauri 启动子进程时经环境变量传入），未传入时自行生成。 */
  token?: string
  /**
   * 原生宿主连接的凭据（桌面外壳启动子进程时经环境变量传入）。
   *
   * 一份凭据用于两条宿主路径：`/native/browser` 与 `/native/desktop` 由同一个桌面外壳进程发起，
   * 同一次启动只有一个随机值；宿主类型由服务端按 URL 路径判定，不采用客户端自报的字段。
   *
   * 未传入时两条路径都不存在：宿主连接一律拒绝，浏览器控制与电脑控制两项能力都不发布。
   * 不要为它设置默认值：有默认值即任何人都能注册宿主。
   */
  hostKey?: string
  updateHostKey?: string
  /** 桌面外壳观察到的上一个 qy serve 进程的终态，仅用于本次启动时回收孤儿 run。 */
  previousProcessExit?: ProcessExitObservation
  /**
   * 调度 tick 间隔，毫秒。缺省为 `SCHEDULER_TICK_MS`。
   *
   * 仅用于让回归测试以真实计时器驱动生产环境的推进路径，避免等待时间达到分钟级。
   * 不要用它调节生产精度：到期判定以分钟为单位，修改此值只会增加无效的 tick。
   */
  schedulerTickMs?: number
}

/** 首次运行时创建的工作区名称。已写入磁盘的目录名是历史事实，不要修改（D2）。 */
const DEFAULT_WORKSPACE_NAME = '默认工作区'

/**
 * HTTP 入口的资源安全上限，不是图片或视频的模型能力上限。
 *
 * 仅当浏览器无法取得绝对路径时，附件才上传到本机服务；桌面拖入始终只传路径。百炼官方
 * 临时文件协议的上限是 1 GB，因此该后备路径允许达到同一数量级，同时阻止已配对客户端
 * 以无上限的请求耗尽磁盘。具体模型更小的限制由 Provider 凭证或请求判定。
 */
const MAX_HTTP_REQUEST_BODY_BYTES = 1024 * 1024 * 1024

/**
 * 决定启动时使用的项目，是首次运行时项目选择的唯一权威。
 *
 * 三种来源，优先级从高到低：
 *
 * 1. 显式传入根目录：直接使用（`qy serve --cwd <目录>` 是 CLI 的常规用法）。
 * 2. 账本中已有项目：使用最近打开的项目（`mostRecentWorkspace`）。
 *    首次之后的每次启动都经由此条，因此用户在界面中切换过的项目不会被启动目录替换。
 *    它与侧栏顺序无关：侧栏按「置顶 > 添加先后」稳定排列，不随切换重排。
 * 3. 没有任何项目：在 `~/.qywork/workspaces/默认工作区/` 创建一个。
 *
 * 第 3 条不能省略：无条件登记启动目录时，桌面端的启动目录是 qywork 的源码树，
 * 首次运行得到的默认项目将是本仓库。
 *
 * 使用 `mkdirSync` 创建目录：账本行与目录必须同时存在，异步创建会产生一段
 * 「行已存在、目录尚未创建」的时间窗，期间任何工具调用都因根目录不存在而失败。
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
  // 运行中的子 agent 与 run 同级：它们的生命周期跟随会话，而非派发它们的那一轮。
  const subagents = new SubagentRegistry()
  const runs = new RunManager(opts.store, bus, subagents)
  // 画布的写入与画布上的生成仅经由此实例；事件不带会话 id，推送给所有客户端。
  const canvas = new CanvasService({
    paramSpecsOf: (output, pick) => {
      const target = resolveMediaModel(opts.config, output, pick)
      return target ? lookupMediaModel(target.model, target.kind).params : undefined
    },
    publish: (event) => bus.publish(event),
    updating: () => runs.updating,
    mentionStyleOf: (output, pick) => {
      const target = resolveMediaModel(opts.config, output, pick)
      return target ? lookupMediaModel(target.model, target.kind).mention : undefined
    },
  })
  /*
   * 浏览器宿主连接与控制协调器。没有凭据时两者都不创建：宿主路径不接受连接，
   * 会话装配也无法取得端口，界面不会出现点击即报错的入口。
   */
  const browserBridge = opts.hostKey ? new BrowserBridge(opts.hostKey) : null
  const browser = browserBridge
    ? new BrowserCoordinator(browserBridge, () => opts.config.browserEnabled !== false)
    : null
  /*
   * 宿主连接或断开时重新广播能力投影。
   *
   * 握手只报告一次，而宿主在应用启动之后才连接：若只依赖握手中的值，界面需等到
   * 下一次重连才显示浏览器入口。判定与握手共用 `browserCapability`。
   */
  const offBrowserHost = browserBridge?.onHostChange(() => {
    bus.publish({ type: 'browser.state', browser: browserCapability(browserBridge) })
  })
  /*
   * 桌面宿主连接与电脑控制协调器。与浏览器共用同一份宿主凭据：两条路径由同一个
   * 桌面外壳进程发起，同一次启动只有一个随机值；宿主类型由 URL 路径判定，
   * 不采用客户端自报的字段。没有凭据时两者都不创建。
   *
   * 两个开关都在使用时读取 `opts.config`：该对象由 `/api/config` 的 PUT 原地改写，
   * 保存快照会使设置中的修改需重启才生效。前台接管开关随每条请求下发到 worker，
   * 运行中关闭后，下一次派发即被拒绝。
   *
   * 两个开关缺省时均视为启用（`!== false`），显式 `false` 为关闭。前台操作配置与控件能力
   * 分别判断；模型可见状态与 worker 请求帧读取同一份配置。
   */
  const desktopBridge = opts.hostKey
    ? new DesktopBridge(opts.hostKey, () => opts.config.desktopForeground !== false)
    : null
  const desktop = desktopBridge
    ? new DesktopCoordinator(desktopBridge, () => opts.config.desktopEnabled !== false)
    : null
  const offDesktopHost = desktopBridge?.onHostChange(() => {
    bus.publish({ type: 'desktop.state', desktop: desktopCapability(desktopBridge) })
  })
  const offDesktopTarget = desktop?.onTargetChange((target) => {
    bus.publish({ type: 'desktop.target', target })
  })
  /*
   * Office 执行程序：启动时探测一次本机的 Python、文档库与办公软件，之后按缓存为会话提供端口。
   * 开关在使用时读取 `opts.config`，理由与电脑控制相同：设置修改后无需重启。
   */
  const office = createOfficeHost(() => opts.config)
  void office.refresh()
  const gitWatch = createGitWatch(opts.store, bus)
  // 令牌只有这一个持有者。外部注入的令牌也交给它，使鉴权只有一条路径。
  const pairing = new Pairing({
    deviceName: hostLabel(),
    ...(opts.token ? { token: opts.token } : {}),
  })
  const token = pairing.token

  /*
   * 启动时的项目。三种来源，优先级从高到低：
   *
   * 1. 显式传入 `workspaceRoot`：直接使用（`qy serve --cwd <目录>`）。
   * 2. 账本中已有项目：使用最近打开的项目（`mostRecentWorkspace`）。
   * 3. 没有任何项目（首次运行）：创建默认工作区。
   *
   * 第 3 条不能省略：无条件登记 `opts.workspaceRoot` 时，首次运行使用的是启动目录，
   * 而桌面端的启动目录是本仓库，用户得到的默认项目将是 qywork 的源码树。
   */
  const workspaceRoot = bootstrapWorkspace(opts.store, opts.workspaceRoot)

  // 正文库与主账本放在同一目录。在此处打开而不是每个 run 单独打开：SQLite 连接有开销，
  // 且 GC 需要一个跨 run 存活的句柄。
  const content =
    opts.content ?? new ContentStore(contentPathFor(opts.store.db.filename || ':memory:'))
  const ownsContent = opts.content === undefined

  /**
   * 预加载启动项目的扩展，并在服务运行期间持有一份引用。
   *
   * 扩展清单不在此处保存供握手使用。扩展中的 MCP 与编排按工作区区分
   * （`.agents/mcp.json`、`.qy/team.json` 位于项目目录下），而一条 WebSocket 连接
   * 跨越用户打开的所有项目：保存一份会使 A 项目的 MCP 显示在 B 项目上，
   * 且只在重连时更新。清单由各项目的设置页按项目实时读取。
   *
   * 此处仍然 acquire：各个 Session 各自 acquire / release，引用计数保证
   * 子进程只启动一套；服务持有一份引用，使启动项目的插件不会在两轮之间反复启动与终止。
   * 异步执行、不阻塞服务启动：单个慢插件不应导致整个服务无法启动。
   */
  const extensionsReady = acquireExtensions(
    workspaceRoot,
    (line) => log.info('extensions', line),
    true,
  )
    .then((ext) => {
      for (const f of ext.mcp.failures) {
        log.warn('extensions', `MCP ${f.server}：${f.reason}`)
      }
      for (const f of ext.plugins.failures) {
        log.warn('extensions', `插件加载失败 ${f.dir}：${f.reason}`)
      }
      if (ext.team.error) log.warn('extensions', `team 配置：${ext.team.error}`)
      return ext
    })
    .catch((err) => {
      log.error('extensions', `扩展加载失败：${String(err)}`)
      return null
    })

  // 回收上次进程留下的 running run，必须在开始服务之前执行：
  // 不回收时 hasRun 始终为真，用户在该会话中无法发送任何消息，会话被永久锁定。
  //
  // 只回收无进程运行的 run（判据见 `store/repos.ts` 的 `isOrphan`）。不加区分地回收
  // 会使本进程启动时把其他进程正在运行的轮次判为中断：账本是共享的，
  // 一台机器上可以同时存在多个写入者。
  const previousExit = opts.previousProcessExit
    ? sanitizeProcessExitObservation(opts.previousProcessExit, collectSecrets(opts.config))
    : undefined
  const stale = recoverStaleRuns(opts.store, previousExit)
  if (stale.recovered > 0) {
    log.warn('runs', '已回收上次残留的执行记录', {
      recovered: stale.recovered,
      // 在工具执行期间中断、结果不可信的轮次数
      ambiguous: stale.ambiguous,
      previousExit: previousExit?.exitKind ?? null,
    })
  }
  // 跳过的数量同样记录。否则「回收了 0 个」有两种含义（没有残留，或残留均仍在运行），
  // 两者在排查会话为何仍显示执行中时指向不同的方向。
  if (stale.heldByOthers > 0) {
    log.info('runs', '另有执行记录由其他运行中的进程持有，未回收', {
      heldByOthers: stale.heldByOthers,
    })
  }

  /*
   * `~/.qywork/schedules.json` 的一次性导入，必须在开始服务之前执行：导入之后任务表的
   * 唯一权威是账本，调度、HTTP 接口与模型工具都只读取账本，运行期间不再读取该文件。
   *
   * 文件不合法时抛出异常，经现有的启动失败路径退出并保留原字节。静默视为空表会使界面上的
   * 定时任务全部消失，用户会重新创建一遍。
   */
  const importedSchedules = importLegacySchedules(opts.store)
  if (importedSchedules !== null) {
    log.info('scheduler', '已把定时任务文件导入账本', { count: importedSchedules })
  }

  /*
   * 正文回收。位于残留 run 回收与任务导入之后、开始接受执行之前：引用集合需在账本稳定后
   * 才有效，而本次回收要清除的正是上次进程在登记引用之前退出所留下的孤儿正文。
   *
   * 失败只写一行 stderr，不阻止启动：回收针对的是磁盘空间，不影响正确性；下一次启动或
   * 下一次删除会话时会再次回收。此处不设定时器，也不按时间删除仍被引用的正文。
   */
  const collectGarbage = () => collectResourceGarbage(opts.store, content)
  try {
    const { removed } = collectGarbage()
    if (removed > 0) log.info('content', '已回收未被引用的正文', { removed })
  } catch (err) {
    log.error('content', `正文回收失败：${err instanceof Error ? err.message : String(err)}`)
  }

  const unsubscribers = new Map<string, () => void>()

  /*
   * 交付一次定时触发：认领时新建的会话先广播，再把 prompt 作为一条用户消息发送。
   *
   * 两个入口（tick 与「立即运行」）共用此函数：分别实现时，其中一处若遗漏广播，
   * 该会话需刷新一次才出现在左栏。
   *
   * 使用 `submitMessage` 而不是 `startRun`：认领提交与进程内占位之间存在时间窗，
   * 用户恰好在此期间发送消息时，直接启动一轮会被拒绝为 `run.error`，本次触发随之丢失。
   * 经由 `submitMessage` 则作为跟进消息排队，与手动发送消息使用同一路径。
   */
  const submitSchedule = (claim: ScheduleClaim): Promise<void> => {
    if (claim.created) bus.publish({ type: 'conversation.created', conversation: claim.created })
    return submitMessage(
      claim.conversationId,
      { id: crypto.randomUUID(), content: claim.schedule.prompt, steer: false },
      {
        store: opts.store,
        content,
        config: opts.config,
        bus,
        runs,
        subagents,
        canvas,
        office,
        ...(browser ? { browser } : {}),
        ...(desktop ? { desktop } : {}),
      },
    )
  }

  /* 定时任务调度。推进函数位于 `scheduler.ts`，此处只负责启动与停止。 */
  const scheduler = startScheduler(
    {
      store: opts.store,
      config: opts.config,
      canStart: () => !runs.updating,
      submit: submitSchedule,
    },
    opts.schedulerTickMs,
  )

  /**
   * 局域网监听控制。
   *
   * 桌面端默认只绑定 127.0.0.1：启动即把工作区暴露给整个 Wi-Fi 不是合理的默认值。
   * 用户点击「允许手机接入」时追加一个 0.0.0.0 的监听器，而不是重启服务：
   * 重启会断开桌面端的 WebSocket 并丢弃正在运行的 run。
   *
   * 两个监听器共用同一个 bus / runs / store，手机连接后看到的是同一份状态。
   * 此处使用后赋值的引用，原因是监听器需复用主 server 的 handler，而 handler 又需
   * 调用这几个函数；循环引用只能通过延迟解析打破。
   */
  let lanServer: ReturnType<typeof Bun.serve<SocketData>> | null = null
  let boundPort = opts.port

  let lanPort = 0

  /**
   * 局域网监听使用另一个端口，不使用主端口。
   *
   * `0.0.0.0:P` 与已绑定的 `127.0.0.1:P` 在同一端口上冲突，直接报
   * 「Failed to start server. Is port P in use?」。
   * 因此传入 port 0 由内核选择空闲端口，二维码指向该端口。
   */
  const enableLan = (): { port: number } => {
    if (!lanServer) {
      // 复用同一份 handler：两个监听器共用 bus / runs / store，
      // 手机连接后看到的是同一份状态，而非副本。
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

  // handler 单独定义，供两个监听器共用。
  // 只写第一个类型参数：Bun 的签名是 serve<WebSocketData, R extends string>，
  // 第二个参数是路由表的路径键，此处经由 fetch 手动分派，没有路由表。
  const handlers = {
    // agent 的一轮可能运行很久，默认超时会断开 WebSocket。
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
        return json({
          claimed: canvas.busyCount === 0 && runs.claimUpdate(),
          busy: runs.busyConversations().length + canvas.busyCount,
        })
      }

      /*
       * ── 原生宿主连接 ──
       *
       * 必须排在 `/stream` 之前单独判断：这两条路径不校验配对令牌，校验的是宿主凭据与回环地址，
       * 且升级后各自使用独立的帧处理路径。宿主类型由路径决定并写入 `ws.data.native`，
       * 之后的三处分派都只读取该字段。
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
        // 握手阶段即校验令牌：未授权的连接不进入 ws 生命周期。
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

      // ── 跨源预检：必须在校验令牌之前响应 ──
      // 按规范预检请求不带 Authorization，按同一标准校验只会得到 401，
      // 而预检返回 401 时实际请求不会发出。详见 CORS_HEADERS。
      if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
        return new Response(null, { status: 204, headers: CORS_HEADERS })
      }

      // ── 健康检查：唯一免鉴权的端点，只返回 `{ ok: true }` ──
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
            canvas,
            pairing,
            token,
            port: srv.port ?? opts.port,
            enableLan,
            disableLan,
            lanEnabled,
            lanPort: () => lanPort,
            // 定时任务的「立即运行」经由此处，与自动触发使用同一个函数。
            // 以注入方式提供而不由 api 模块 import：后者会形成循环依赖（server → api → server）。
            //
            // 投递失败时当场写一行日志。认领已提交，HTTP 侧已返回 200；丢弃错误
            // 会留下一条有会话、无 Run 的记录，且无从查明成因。
            submitSchedule: (claim) => {
              void submitSchedule(claim).catch((err: unknown) => {
                log.error(
                  'scheduler',
                  `定时任务「${claim.schedule.title}」启动失败：${err instanceof Error ? err.message : String(err)}`,
                  { scheduleId: claim.schedule.id },
                )
              })
            },
            watchGit: () => gitWatch.retarget(),
            collectGarbage,
            closeBrowserPages: (conversationId) =>
              browser?.closeConversation(conversationId) ?? Promise.resolve(),
            office,
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
        // 宿主连接只处理各自的资源操作，这两条路径上不解析聊天指令。
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
            office,
            browser: () => browserCapability(browserBridge),
            desktop: () => desktopCapability(desktopBridge),
            announceGit: () => gitWatch.announce(),
            announceDesktopTarget: () => {
              bus.publish({ type: 'desktop.target', target: desktop?.target() ?? null })
            },
          })
          return
        }

        const cmd = frame as ClientCommand
        /*
         * 指令处理抛出异常时也必须回执。此处 await 之外没有捕获方，抛出即成为一条
         * unhandled rejection：客户端收不到任何帧，界面上无法区分「服务端正在处理」与
         * 「服务端出错」。
         *
         * 只回执并记录日志，不重试：重试会把一次故障放大为一连串相同的失败。
         */
        try {
          await handleCommand(cmd, {
            ws,
            store: opts.store,
            content,
            config: opts.config,
            bus,
            runs,
            subagents,
            canvas,
            office,
            ...(browser ? { browser } : {}),
            ...(desktop ? { desktop } : {}),
          })
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          log.error('ws', `指令 ${cmd.type} 处理失败：${detail}`, { id: ws.data.id })
          reject(
            ws,
            cmd.type,
            'internal_error',
            `服务端处理该指令时出错：${detail}`,
            'clientRequestId' in cmd ? cmd.clientRequestId : undefined,
          )
        }
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
       * 关闭码与原因是判断哪一端先断开的唯一依据：1000/1001 是对端正常关闭，1006 是未收到
       * 关闭帧（对端进程已退出或连接被中断），1008 是本端握手拒绝。时长用于区分
       * 「连接后立即断开」与「连接数小时后断开」。
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

  // 分支名跟随 `.git/HEAD`，理由与边界见 `git-watch.ts`。
  gitWatch.retarget()

  void canvas
    .recover(
      listWorkspaces(opts.store).map((ws) => ({ id: ws.id, root: ws.rootPath })),
      (ws, version) => {
        // 配置暂不可用时保留任务号，不能把启动恢复视为远端任务失败。
        if (!resolveMediaModel(opts.config, 'video', version.made)?.apiKey) return undefined
        return uiMediaPort({ store: opts.store, config: opts.config, workspaceId: ws.id })
      },
    )
    .catch((err: unknown) => log.error('canvas', `接续任务失败：${String(err)}`))

  return {
    server,
    bus,
    runs,
    content,
    token,
    browser,
    desktop,
    port: boundPort,
    // 启动横幅应显示实际生效的工作区。调用方传入的值可能为空（未传 --cwd），
    // 此时由 bootstrapWorkspace 决定，只有此处知道结果。
    workspaceRoot,
    enableLan,
    disableLan,
    lanEnabled: () => lanServer !== null,
    pairingUrl: () => pairing.qrUrl(boundPort),
    lanUrl: () => `http://${preferredLanAddress()}:${boundPort}`,
    async stop() {
      log.info('server', '停止服务', { port: boundPort })
      scheduler.stop()
      gitWatch.stop()
      offBrowserHost?.()
      browser?.stop()
      offDesktopHost?.()
      offDesktopTarget?.()
      desktop?.stop()
      runs.interruptAll()
      // 子 agent 跟随会话而非 run，关闭服务时需单独停止：否则会留下一批无人接收回执的进程。
      subagents.interruptAll()
      await canvas.stop()
      disableLan()
      server.stop(true)
      // 插件是子进程，不显式关闭会留下孤儿进程；sidecar 与截图脚本遵循同一约束。
      const ext = await extensionsReady
      if (ext) await releaseExtensions(ext)
      // 只关闭自己打开的正文库：外部传入的正文库由调用方管理，代为关闭会使其下一次读取抛出异常。
      if (ownsContent) content.close()
    },
  }
}

// ───────────────────────── WebSocket ─────────────────────────

export type AgentEventFrame = EventEnvelope<AgentEvent>
