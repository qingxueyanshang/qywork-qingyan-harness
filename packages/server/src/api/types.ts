/**
 * HTTP API 各域共用的依赖与出参。
 *
 * **`submitSchedule` 以注入方式提供的原因。** `api/schedules.ts` 的「立即运行」必须使用与自动
 * 触发完全相同的函数：另写一条只在该入口执行的简化路径，等同于新增一份独立的第二份状态，
 * 且该路径上的缺陷只有定时任务会遇到，因而最晚被发现。
 *
 * 该函数定义在 `server.ts`，而 `server.ts` 需要 import 这些 api 模块，
 * 反向 import 会成环。因此由 `server.ts` 在装配时注入：
 * 接口定义在上层，实现由下层注入（`SinkPort` 采用同一做法）。
 */

import type { ConversationId } from '@qywork/core'
import type { OfficeHost, QyConfig } from '@qywork/runtime'
import type { ScheduleClaim, Store } from '@qywork/store'
import type { EventBus } from '../bus.ts'
import type { CanvasService } from '../canvas.ts'
import type { Pairing } from '../pairing.ts'
import type { RunManager } from '../runs.ts'

export interface ApiDeps {
  store: Store
  config: QyConfig
  bus: EventBus
  runs: RunManager
  /** 画布服务：界面与 Agent 共用同一个实例，画布的写入与生成只经由它。 */
  canvas: CanvasService
  pairing: Pairing
  token: string
  port: number
  enableLan(): { port: number }
  disableLan(): void
  lanEnabled(): boolean
  lanPort(): number
  /** 交付一次定时触发（广播新建会话并发送用户消息）。由 `server.ts` 注入，见本文件头注释。 */
  submitSchedule(claim: ScheduleClaim): void
  /**
   * 当前项目已切换：把分支监听指向新项目并上报一份新的分支状态。
   *
   * 注入理由与 `submitSchedule` 相同：监听位于 `server.ts`，反向 import 会成环。
   * 只有 upsert 项目的路径应调用它：该操作修改的正是 `last_opened_at`，
   * 而监听跟随的是最近打开的项目。
   */
  watchGit(): void
  /**
   * 回收无人引用的正文，返回删除的 blob 数。
   *
   * 只提供这一个回调，不把 `ContentStore` 交给各域：正文库上还有 `put` / `collectGarbage`
   * 等可直接删除字节的方法，而 API 层只需要在删除会话之后回收一次空间。
   *
   * 抛出即表示回收失败。调用方必须把它与删除本身分开报告：会话已经删除，
   * 报告为删除失败会使用户再次删除，而那一次收到的是 404。
   */
  collectGarbage(): { removed: number }
  /**
   * 关闭一条会话名下的全部内置浏览器 AI 页面。只有删除会话调用它，归档不关闭页面。
   *
   * 归属在原生宿主上按会话记录（见 `browser/coordinator.ts`）；没有内置浏览器时为空操作。
   */
  closeBrowserPages(conversationId: ConversationId): Promise<void>
  /** Office 执行程序的宿主。「运行环境」中 Python 与文档库两行读取它的探测结果。 */
  office?: OfficeHost
}

/**
 * 处理器可见的依赖 = `ApiDeps` + 本次请求所指的项目。
 *
 * 两个字段由派发器按 `?ws=<workspaceId>` 实时解析（见 `api/index.ts`），
 * 未带参数时回退到最近打开的项目。它们不是进程常量：进程常量会使一个进程只能服务
 * 一个项目，切换项目必须重启。
 */
export interface ApiRequestDeps extends ApiDeps {
  workspaceRoot: string
  workspaceId: string
}

/**
 * 一个域的路由处理器。
 *
 * 返回 `null` 表示该路由不由本模块处理，而不是已处理但没有结果：
 * 派发器据此继续匹配下一个处理器。任何实际结果都必须是 `Response`，包括错误。
 */
export type ApiHandler = (url: URL, req: Request, d: ApiRequestDeps) => Promise<Response | null>

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
