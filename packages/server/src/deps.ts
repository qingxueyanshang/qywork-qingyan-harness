/**
 * 指令处理共用的依赖集合。
 *
 * 独立成文件以避免循环依赖：`commands.ts` 调用 `run-control.ts` 与 `team-run.ts`，
 * 而后两者都需要该类型。放在任一方都会使两个模块互相 import。
 */

import type { OfficePort } from '@qywork/agent'
import type { OfficeHost, QyConfig } from '@qywork/runtime'
import type { ContentStore, Store } from '@qywork/store'
import type { ServerWebSocket } from 'bun'
import type { BrowserCoordinator } from './browser/coordinator.ts'
import type { EventBus } from './bus.ts'
import type { CanvasService } from './canvas.ts'
import type { DesktopCoordinator } from './desktop/coordinator.ts'
import type { RunManager } from './runs.ts'
import type { SubagentRegistry } from './subagents.ts'

/**
 * **此处不含 `workspaceRoot`。**
 *
 * 运行目录是会话的属性，不是连接的属性，由
 * `workspaceRootOf(store, conversationId)` 实时查询（`@qywork/store`）。
 * 不要在此处设置进程级常量：那样一个进程只能服务一个项目，切换项目必须重启；
 * 而同一条会话可以同时在桌面端和手机上打开，当前工作区不应由连接决定。
 */
export interface CommandDeps {
  ws: ServerWebSocket<SocketData>
  store: Store
  content: ContentStore
  config: QyConfig
  bus: EventBus
  runs: RunManager
  /** 运行中的子 agent。生命期跟随会话，因此它与 `runs` 同级，不归属于任务派发通道。 */
  subagents: SubagentRegistry
  /**
   * 内置浏览器的控制协调器。**没有原生宿主时不传入**：会话装配据此决定
   * 本轮是否提供浏览器能力，不提供必然报错的端口。
   */
  browser?: BrowserCoordinator
  /**
   * 电脑控制的协调器。**没有宿主凭据时不传入**：会话装配据此决定本轮是否提供
   * 桌面能力；用户是否启用由协调器按配置实时判定。
   */
  desktop?: DesktopCoordinator
  /** 画布服务：会话中的 `canvas` 工具与界面共用同一实例。未传入时会话中没有 `canvas` 工具。 */
  canvas?: CanvasService
  /** Office 执行程序的宿主。会话按其当前是否提供端口决定是否注册 `office`。 */
  office?: OfficeHost
}

/** 会话装配时的 Office 端口：宿主当前提供端口时附带，否则不附带（工具不注册）。 */
export function officePortOf(deps: Pick<CommandDeps, 'office'>): { office?: OfficePort } {
  const port = deps.office?.port()
  return port ? { office: port } : {}
}

/** 每条 WebSocket 连接各自的状态。握手前 `authed` 为 false。 */
export interface SocketData {
  id: string
  authed: boolean
  origin: 'desktop' | 'mobile' | 'cli' | 'external'
  /**
   * 该连接对应的原生宿主类型。`null` 表示普通配对客户端。
   *
   * **由服务端在升级时按 URL 路径判定并固定**，不读取客户端自报的任何字段：三类帧
   * （聊天指令、浏览器资源操作、桌面控件操作）经由三条完全不同的处理路径，
   * 依据自报字段区分等于允许任何已配对客户端注册为宿主。
   */
  native: 'browser' | 'desktop' | null
  /** 升级成功的时刻，关闭时用于计算连接的持续时长。 */
  openedAt: number
}
