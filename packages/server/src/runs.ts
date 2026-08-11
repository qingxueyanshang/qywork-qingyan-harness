/**
 * Run 管理器。
 *
 * 三件事：并发控制、中断、以及**跨端权限仲裁**。
 *
 * 权限仲裁是这里最微妙的部分：同一个请求会同时推给桌面和手机，谁先答谁生效，
 * 后到的应答直接丢弃（而不是覆盖）。超时按拒绝处理——一个悬而未决的授权请求
 * 会让 run 永远挂着，而「挂着」在 UI 上和「卡死」无法区分。
 *
 * ## 谁还在用它
 *
 * 两模式（`auto` / `full`）改造后，**工具授权不再走这里**——`Session.decide()`
 * 按规则 + 分类器就地裁决，被拒的调用以 `tool.finished{status:'failure',
 * errorKind:'permission_denied'}` 呈现，不问用户。
 *
 * 现在 `requestPermission` 只有一个生产者：Agent Team 的人工门禁
 * （`.qy/team.json` 的 `rules.humanGates`，见 `server.ts` 的 `runTeam`）。
 * 那是一条完整活着的链路——门禁请求发到桌面/手机，用户在 PermissionSheet 上
 * 应答，回执经 `permission.resolve` 回到这里。删掉它等于让编排的人工门禁
 * 静默超时（5 分钟后按拒绝），所以**别把它当成死代码清掉**。
 */

import type { AgentEvent, ConversationId, PermissionScope, RunId } from '@qywork/core'
import type { Store } from '@qywork/store'
import { getRun, listConversations } from '@qywork/store'
import type { EventBus } from './bus.ts'

export interface PendingPermission {
  requestId: string
  runId: RunId
  conversationId: ConversationId
  scope: string
  resolve(granted: boolean, by: 'desktop' | 'mobile' | 'policy' | 'timeout', scopeId?: string): void
  timer: ReturnType<typeof setTimeout>
}

/** 授权等待上限。超过按拒绝处理，绝不无限期挂着。 */
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000

export interface ActiveRun {
  runId: RunId
  conversationId: ConversationId
  controller: AbortController
  startedAt: number
}

/**
 * 已授予的范围。
 *
 * `once` 不进这张表——它按定义只对当次调用生效，记下来反而会误放行下一次。
 * `run` / `session` 带作用域键，超出作用域即失效；`always` 无界（当前进程内持久，
 * 落盘策略留给 permission_rules 表）。
 */
interface Grant {
  duration: 'run' | 'session' | 'always'
  runId?: RunId
  conversationId?: ConversationId
}

export class RunManager {
  private readonly active = new Map<string, ActiveRun>()
  private readonly pending = new Map<string, PendingPermission>()
  /** 同一会话同时只允许一个 run —— 两个 run 并发改同一批文件必然互相踩。 */
  private readonly byConversation = new Map<string, RunId>()
  private readonly grants = new Map<string, Grant>()

  /**
   * 判断已有授权是否覆盖本次请求。
   *
   * **全等匹配，不做前缀放宽。** scope 形如 `effect:target`，对 execute 来说
   * target 是整条命令——前缀匹配会让批准过 `execute:ls` 的用户在
   * `execute:ls && rm -rf /` 上被静默放行。代价是「本会话都允许」对每条新命令
   * 仍会再问一次；要按模式批量授权（如 `execute:npm *`）需要用户显式选择模式，
   * 那是另一个功能，不能靠匹配逻辑偷偷实现。
   */
  private isGranted(scope: string, runId: RunId, conversationId: ConversationId): boolean {
    const g = this.grants.get(scope)
    if (!g) return false
    if (g.duration === 'run' && g.runId !== runId) return false
    if (g.duration === 'session' && g.conversationId !== conversationId) return false
    return true
  }

  private recordGrant(
    scope: string,
    scopeId: string | null,
    runId: RunId,
    conversationId: ConversationId,
  ): void {
    if (scopeId === 'run' || scopeId === 'session' || scopeId === 'always') {
      this.grants.set(scope, { duration: scopeId, runId, conversationId })
    }
  }

  /** run 结束时回收该 run 名下的 run 级授权。 */
  private expireRunGrants(runId: RunId): void {
    for (const [scope, g] of this.grants) {
      if (g.duration === 'run' && g.runId === runId) this.grants.delete(scope)
    }
  }

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
  ) {}

  isBusy(conversationId: ConversationId): boolean {
    return this.byConversation.has(conversationId)
  }

  register(run: ActiveRun): void {
    this.active.set(run.runId, run)
    this.byConversation.set(run.conversationId, run.runId)
  }

  unregister(runId: RunId): void {
    const run = this.active.get(runId)
    if (run) this.byConversation.delete(run.conversationId)
    this.active.delete(runId)
    this.expireRunGrants(runId)
    // run 结束时把它名下所有未决授权按拒绝收敛，避免留下永远等不到应答的 promise。
    for (const [id, p] of this.pending) {
      if (p.runId === runId) {
        clearTimeout(p.timer)
        p.resolve(false, 'timeout')
        this.pending.delete(id)
      }
    }
  }

  interrupt(runId: RunId): boolean {
    const run = this.active.get(runId)
    if (!run) return false
    run.controller.abort()
    return true
  }

  interruptAll(): void {
    for (const run of this.active.values()) run.controller.abort()
  }

  listActive(): ActiveRun[] {
    return [...this.active.values()]
  }

  /**
   * 发起一次授权请求，等待任一端应答。
   * 返回的 promise 一定会 settle：要么客户端应答，要么超时按拒绝。
   */
  requestPermission(input: {
    runId: RunId
    conversationId: ConversationId
    toolName: string
    scope: string
    preview: string
    action: AgentEvent extends { action: infer A } ? A : never
  }): Promise<boolean> {
    // 已有覆盖性授权就不再打扰用户。这条必须在发事件之前判——
    // 否则 UI 会闪一下弹窗再自己消失。
    if (this.isGranted(input.scope, input.runId, input.conversationId)) {
      this.bus.publish(
        {
          type: 'permission.resolved',
          runId: input.runId,
          requestId: `auto_${crypto.randomUUID()}`,
          granted: true,
          scopeId: 'policy',
          resolvedBy: 'policy',
        },
        input.conversationId,
      )
      return Promise.resolve(true)
    }

    const requestId = crypto.randomUUID()
    const expiresAt = Date.now() + PERMISSION_TIMEOUT_MS

    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (
        granted: boolean,
        by: 'desktop' | 'mobile' | 'policy' | 'timeout',
        scopeId: string | null = null,
      ) => {
        // 后到的应答直接丢弃，不覆盖先到的决定。
        if (settled) return
        settled = true
        this.pending.delete(requestId)
        if (granted) {
          this.recordGrant(input.scope, scopeId, input.runId, input.conversationId)
        }
        this.bus.publish(
          {
            type: 'permission.resolved',
            runId: input.runId,
            requestId,
            granted,
            scopeId: granted ? (scopeId ?? 'once') : null,
            resolvedBy: by,
          },
          input.conversationId,
        )
        resolve(granted)
      }

      const timer = setTimeout(() => finish(false, 'timeout'), PERMISSION_TIMEOUT_MS)

      this.pending.set(requestId, {
        requestId,
        runId: input.runId,
        conversationId: input.conversationId,
        scope: input.scope,
        resolve: finish,
        timer,
      })

      this.bus.publish(
        {
          type: 'permission.request',
          runId: input.runId,
          requestId,
          toolName: input.toolName,
          action: input.action,
          preview: input.preview,
          scopes: DEFAULT_SCOPES,
          expiresAt,
        },
        input.conversationId,
      )
    })
  }

  resolvePermission(
    requestId: string,
    granted: boolean,
    by: 'desktop' | 'mobile',
    scopeId?: string,
  ): boolean {
    const p = this.pending.get(requestId)
    if (!p) return false
    clearTimeout(p.timer)
    p.resolve(granted, by, scopeId)
    return true
  }

  listPending(): { requestId: string; runId: RunId; scope: string }[] {
    return [...this.pending.values()].map((p) => ({
      requestId: p.requestId,
      runId: p.runId,
      scope: p.scope,
    }))
  }

  /** 进程退出前把还在跑的 run 收敛成 interrupted，不留孤儿 running 行。 */
  drain(): void {
    this.interruptAll()
    for (const run of this.active.values()) {
      const row = getRun(this.store, run.runId)
      if (row && row.status === 'running') {
        // finishRun 的调用留给 session 的 finally；这里只保证信号发出去了。
      }
    }
  }

  conversationsOf(workspaceId: string): ConversationId[] {
    return listConversations(this.store, workspaceId as never).map((c) => c.id)
  }
}

const DEFAULT_SCOPES: PermissionScope[] = [
  { id: 'once', label: '仅这次', duration: 'once' },
  { id: 'run', label: '本轮都允许', duration: 'run' },
  { id: 'session', label: '本会话都允许', duration: 'session' },
  { id: 'always', label: '一直允许', duration: 'always' },
]
