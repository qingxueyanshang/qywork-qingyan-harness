/**
 * HTTP API 各域共用的依赖与出参。
 *
 * **为什么 `startRun` 是注入进来的。** `api/schedules.ts` 的「立刻跑一次」必须走与正常对话**完全相
 * 同**的执行路径 ——另写一条只在定时任务上跑的简化路径，等于给自己开了第二本账，而那条路上的 bug
 * 只有定时任务会遇到，也就最晚被发现。
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
  /**
   * 「当前项目换了」——把分支监听重新指过去并报一份新的。
   *
   * 与 `startRun` 同一个理由注入：监听住在 `server.ts`，反向 import 会成环。
   * 只有 upsert 项目那条路该调它：那个动作改的正是 `last_opened_at`，
   * 而监听盯的就是「最近打开的那个」。
   */
  watchGit(): void
}

/**
 * 处理器看到的依赖 = `ApiDeps` + **这一次请求问的是哪个项目**。
 *
 * 两个字段由派发器按 `?ws=<workspaceId>` 当场解析（见 `api/index.ts`），
 * 不带参数时落到最近打开的那个。**它们不是进程常量**——那份常量已经删了，
 * 它正是「一个进程只服务得了一个项目、换项目只能重启」的成因。
 */
export interface ApiRequestDeps extends ApiDeps {
  workspaceRoot: string
  workspaceId: string
}

/**
 * 一个域的路由处理器。
 *
 * **返回 `null` 表示「这条路由不由本模块处理」**，不是「处理了但没有结果」——
 * 派发器靠它往下走。任何真实结果都必须是一个 `Response`，包括错误。
 */
export type ApiHandler = (url: URL, req: Request, d: ApiRequestDeps) => Promise<Response | null>

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
