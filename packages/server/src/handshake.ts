/**
 * WebSocket 握手：校验令牌、报告能力。
 *
 * 拒绝连接只有一种原因，且是终态：无论重连多少次，携带的仍是同一个令牌，
 * 客户端据此不再退避重连。
 *
 * **这里不校验协议版本。** 手写版本号要防止的偏差（客户端与 sidecar 不是同一次构建产出）
 * 已从源头消除：开发时两端都从同一棵源码树运行（`scripts/dev.ts`），
 * 打包时出自同一次构建。完整理由写在 `HelloFrame` 的注释中。
 */

import type {
  BrowserCapability,
  DesktopCapability,
  EventEnvelope,
  HelloFrame,
  HelloOkFrame,
} from '@qywork/core'
import { log } from '@qywork/core'
import type { OfficeHost, QyConfig } from '@qywork/runtime'
import { detectSandbox } from '@qywork/tools'
import type { ServerWebSocket } from 'bun'
import pkg from '../package.json' with { type: 'json' }
import { probeEnvironment } from './api/host.ts'
import type { EventBus, Subscriber } from './bus.ts'
import type { SocketData } from './deps.ts'
import type { RunManager } from './runs.ts'

/**
 * 本包版本。**真源是根 `VERSION`**，由 `bun run scripts/sync-version.ts` 写入
 * 各包的 package.json；手写字面量不在该脚本的覆盖范围内，升级版本时不会更新。
 */
const PKG_VERSION: string = pkg.version

export function handleHello(
  ws: ServerWebSocket<SocketData>,
  frame: HelloFrame,
  deps: {
    bus: EventBus
    token: string
    unsubscribers: Map<string, () => void>
    /** 传入的是运行中的配置（`/api/config` 的 PUT 会就地修改它），不是启动时的快照。 */
    config: QyConfig
    /** 报告「当前哪些会话在运行」的权威，见 `busyConversations`。 */
    runs: RunManager
    /** Office 执行程序的宿主。「运行环境」中文档库一行读取其最近一次的探测结果。 */
    office?: OfficeHost
    /**
     * 内置浏览器当前的可用程度。
     *
     * **调用时读取而不是传入快照**：宿主在应用启动后才连接，握手与
     * `browser.state` 事件必须读取同一份判定，各存一份必然在重连时出现不一致。
     */
    browser(): BrowserCapability
    /**
     * 电脑控制当前的可用程度。**与 `browser` 理由相同，调用时读取**：宿主在应用启动
     * 之后才连接，握手与 `desktop.state` 事件必须读取同一份判定。
     */
    desktop(): DesktopCapability
    /**
     * 广播一次当前分支名。
     *
     * **新连接的客户端只能从该广播取得分支名**，没有其他途径；而 `.git/HEAD`
     * 的监听只在其变化时广播，刚连接的客户端无法等到。
     */
    announceGit(): void
    /** 补发完成后广播当前桌面目标，首次连接与缺口无法补发时也能恢复会话归属。 */
    announceDesktopTarget(): void
  },
) {
  if (frame.token !== deps.token) {
    log.warn('ws', '握手被拒绝：令牌无效', { id: ws.data.id, origin: frame.origin })
    ws.send(JSON.stringify({ type: 'hello.err', reason: 'bad_token', message: '令牌无效' }))
    ws.close(1008, 'unauthorized')
    return
  }
  ws.data.authed = true
  ws.data.origin = frame.origin

  /*
   * **先建立订阅，再计算补发。** 顺序不是风格问题：补发要按该客户端订阅的会话
   * 过滤，而订阅集就是过滤的判据。顺序颠倒时补发路径上没有判据可用，
   * 每次重连都会把窗口内所有会话的事件推送到当前界面。
   *
   * `?? null` 而不是 `?? []`：未声明订阅表示全部接收（首次连接时界面尚未选择会话），
   * 空数组表示明确不接收任何会话事件。两者含义不同，见 `Subscriber.conversations`。
   */
  const subscriber: Subscriber = {
    id: ws.data.id,
    origin: frame.origin,
    conversations: frame.subscribe ? new Set(frame.subscribe) : null,
    send: (f) => ws.send(JSON.stringify(f)),
  }
  const off = deps.bus.subscribe(subscriber)
  deps.unsubscribers.set(ws.data.id, off)

  // 断线补发：缺口在保留窗口内时逐条补发，无法补发时让客户端重新拉取全量。
  // 「能否补发」完全由 `replayFrom` 裁决（含「该位置是否属于本流」），
  // 这里只负责把结论转换为帧上的两个字段。
  let resync = false
  let backlog: EventEnvelope[] = []
  if (frame.resume) {
    const replay = deps.bus.replayFrom(frame.resume, subscriber)
    if (replay === null) resync = true
    else backlog = replay
  }
  log.info('ws', '握手成功', {
    id: ws.data.id,
    origin: frame.origin,
    resume: frame.resume ? (resync ? 'resync' : `replay ${backlog.length}`) : 'none',
    sameStream: frame.resume ? frame.resume.streamId === deps.bus.streamId : null,
    subscribe: frame.subscribe ? frame.subscribe.length : null,
  })

  const ok: HelloOkFrame = {
    type: 'hello.ok',
    serverVersion: PKG_VERSION,
    sessionId: ws.data.id,
    streamId: deps.bus.streamId,
    currentSeq: deps.bus.currentSeq,
    resync,
    /*
     * 运行中的会话**逐条报告**，此后由 `conversation.busy` 事件维持。
     * 缺少该字段时，缺口无法补发（`resync`）的重连之后，客户端持有的仍是断线前的
     * 状态：相应的轮次早已执行完毕，左栏却一直显示运行中。
     */
    busyConversations: deps.runs.busyConversations(),
    /*
     * **只报告进程级的能力。** 插件 / MCP / 外部 CLI 以工作区为单位，而该连接
     * 覆盖用户打开的所有项目：在这里报告等于「A 项目的插件显示在 B 项目上」，
     * 且只有重连时才会更新。它们由各自的设置页按项目实时读取。
     */
    capabilities: {
      sandbox: sandboxCapability(),
      // 同样**每次握手重新探测**：安装完成后重新连接即应显示，
      // 而不是要求用户重启整个服务，因为用户无从得知需要重启。这些探针都不缓存。
      environment: probeEnvironment({
        config: deps.config,
        ...(deps.office ? { office: deps.office } : {}),
      }),
      mode: deps.config.mode ?? 'auto',
      browser: deps.browser(),
      desktop: deps.desktop(),
    },
  }
  ws.send(JSON.stringify(ok))
  deps.announceGit()

  for (const f of backlog) ws.send(JSON.stringify(f))
  deps.announceDesktopTarget()
}

/**
 * 沙箱状态在握手中的形状。
 *
 * `detectSandbox()` 自带缓存，因此每次握手都调用也不会额外启动进程；
 * 但**必须每次握手都重新读取**，而不是在 serve 启动时计算一次并保存：
 * 否则「安装 bwrap 之后重新连接即生效」不再成立，
 * 用户必须重启整个服务，而用户无从得知需要重启。
 */
export function sandboxCapability(): { backend: string; active: boolean; reason: string } {
  const s = detectSandbox()
  return { backend: s.backend, active: s.active, reason: s.reason }
}
