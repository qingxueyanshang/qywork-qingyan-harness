/**
 * 指令处理共享的依赖包。
 *
 * 单独一个文件是为了打断环：`commands.ts` 要调 `run-control.ts` 与 `team-run.ts`，
 * 而它们都要这个类型。放在任何一边都会让两个模块互相 import。
 */

import type { QyConfig } from '@qywork/runtime'
import type { ContentStore, Store } from '@qywork/store'
import type { ServerWebSocket } from 'bun'
import type { EventBus } from './bus.ts'
import type { RunManager } from './runs.ts'

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
}

/** 每条 WebSocket 连接自带的状态。握手前 `authed` 为 false。 */
export interface SocketData {
  id: string
  authed: boolean
  origin: 'desktop' | 'mobile' | 'cli' | 'external'
}
