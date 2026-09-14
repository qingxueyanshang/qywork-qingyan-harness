/**
 * 指令处理共享的依赖包。
 *
 * 单独一个文件是为了打断环：`commands.ts` 要调 `run-control.ts` 与 `team-run.ts`，
 * 而它们都要这个类型。放在任何一边都会让两个模块互相 import。
 */

import type { QyConfig } from '@qywork/runtime'
import type { ContentStore, Store } from '@qywork/store'
import type { ServerWebSocket } from 'bun'
import type { BrowserCoordinator } from './browser/coordinator.ts'
import type { EventBus } from './bus.ts'
import type { RunManager } from './runs.ts'
import type { SubagentRegistry } from './subagents.ts'

/**
 * **这里没有 `workspaceRoot`。**
 *
 * 「跑在哪个目录下」是会话的属性，不是连接的属性——由
 * `workspaceRootOf(store, conversationId)` 当场查（`@qywork/store`）。
 * 别在这里挂一个进程级常量：那样一个进程只服务得了一个项目，换项目只能重启；
 * 而同一条会话可以同时开在桌面端和手机上，「当前工作区」本来就不该由连接来回答。
 */
export interface CommandDeps {
  ws: ServerWebSocket<SocketData>
  store: Store
  content: ContentStore
  config: QyConfig
  bus: EventBus
  runs: RunManager
  /** 在跑的子 agent。生命期跟会话，所以它与 `runs` 同级，不挂在派活通道上。 */
  subagents: SubagentRegistry
  /**
   * 内置浏览器的控制协调器。**没有原生宿主时不传**——会话装配据此决定
   * 要不要给这一轮浏览器能力，不给一个必然报错的端口。
   */
  browser?: BrowserCoordinator
}

/** 每条 WebSocket 连接自带的状态。握手前 `authed` 为 false。 */
export interface SocketData {
  id: string
  authed: boolean
  origin: 'desktop' | 'mobile' | 'cli' | 'external'
  /**
   * 这是不是原生浏览器宿主连接。
   *
   * **由服务端在升级时判定并写死**，不看客户端自报的 `origin`：宿主帧与聊天指令
   * 走两条完全不同的处理路径，靠自报字段区分等于让任何已配对客户端注册宿主。
   */
  native: boolean
  /** 升级成功的时刻，关闭时算这条连接活了多久。 */
  openedAt: number
}
