/**
 * HTTP API 各域共用的依赖与出参。
 *
 * ## 为什么 `startRun` 是注入进来的
 *
 * `api/schedules.ts` 的「立刻跑一次」必须走与正常对话**完全相同**的执行路径
 * ——另写一条只在定时任务上跑的简化路径，等于给自己开了第二本账，
 * 而那条路上的 bug 只有定时任务会遇到，也就最晚被发现。
 *
 * 但 `startRun` 住在 `server.ts`，而 `server.ts` 要 import 这些 api 模块——
 * 反过来 import 会成环。所以由 `server.ts` 在装配时把它注入进来：
 * **接口定义在上层，实现由下层注入**（`SinkPort` 是同一个套路）。
 */

import type { ConversationId } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import type { Store } from '@qywork/store'
import type { EventBus } from '../bus.ts'
import type { Pairing } from '../pairing.ts'
import type { RunManager } from '../runs.ts'

export interface ApiDeps {
  store: Store
  workspaceRoot: string
  workspaceId: string
  config: QyConfig
  bus: EventBus
  runs: RunManager
  pairing: Pairing
  token: string
  port: number
  enableLan(): { port: number }
  disableLan(): void
  lanEnabled(): boolean
  lanPort(): number
  /** 起一轮。由 `server.ts` 注入，见本文件头注释。 */
  startRun(conversationId: ConversationId, prompt: string): void
}

/**
 * 一个域的路由处理器。
 *
 * **返回 `null` 表示「这条路由不归我管」**，不是「处理了但没有结果」——
 * 派发器靠它往下走。任何真实结果都必须是一个 `Response`，包括错误。
 */
export type ApiHandler = (url: URL, req: Request, d: ApiDeps) => Promise<Response | null>

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
