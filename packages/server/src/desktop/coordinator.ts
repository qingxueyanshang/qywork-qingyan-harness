/**
 * 电脑操作协调器：应用进程级对象，由 `serve` 装配。
 *
 * 它只执行已经绑定身份的操作——不规划任务，不存第二份「任务进行到哪」。
 *
 * 四条边界：
 *
 * 1. **OS 句柄不出这一层。** 模型拿到的是 `dw_N` 这样的不透明 id；句柄、pid 与进程
 *    启动时刻记在这里，发请求时才拼成目标身份交给宿主。
 * 2. **观察按窗口留一份。** 同一个窗口再观察一次，上一份编号即作废；宿主换代际
 *    （重连、换 worker）时全部作废。动作只认还在表里的编号。
 * 3. **排队与撤销按执行者记。** 每次执行领一份端口，`release` 撤销这个执行者名下
 *    尚未派发的请求，并让它在途的调用按执行事实收尾。已经交给 OS 的动作不回滚。
 * 4. **「正在操作哪个应用」是进程级读数。** 物理桌面只有一个，两个执行者同时操作时
 *    后到的那一次覆盖它；持有它的执行者释放、宿主断开都要清回 `null`。
 */

import type {
  DesktopActResult,
  DesktopElement,
  DesktopFollowUp,
  DesktopPort,
  DesktopRefusal,
  DesktopSnapshot,
  DesktopWaitCondition,
  DesktopWaitResult,
  DesktopWindowInfo,
} from '@qywork/agent'
import type { DesktopNode, DesktopObservation, DesktopTarget } from '@qywork/core'
import { log } from '@qywork/core'
import { type DesktopBridge, DesktopBridgeError, type NativeDesktopHost } from './bridge.ts'

/** 读树的默认上限。请求里没给时用它，给了也不超过工具那侧声明的上限。 */
const DEFAULT_MAX_NODES = 1500
const DEFAULT_MAX_DEPTH = 20
/** 读树的时间预算。UIA 这类跨进程接口没有请求级硬上界，只能给采集端一个预算。 */
const READ_TREE_BUDGET_MS = 4_000
/** 等待时两次重读之间隔多久。 */
const WAIT_POLL_MS = 200
/** 撤销请求的期限。它只是通知宿主别再派发，不值得等一个长超时。 */
const CANCEL_DEADLINE_MS = 2_000

/**
 * 端口已经释放，或者此刻没有可用的宿主。
 *
 * 判定落在本地，本次操作没有向宿主发出任何帧，因此按 `DesktopRefusal` 声明
 * `executed:false`。
 */
export class DesktopUnavailableError extends Error implements DesktopRefusal {
  readonly errorKind = 'desktop_unavailable' as const
  readonly executed = false as const
}

/** 目标窗口、观察编号或控件引用在本地就对不上。同样一帧都没发出去。 */
export class DesktopTargetError extends Error implements DesktopRefusal {
  readonly errorKind = 'invalid_argument' as const
  readonly executed = false as const
}

/** 一个已发现窗口的完整身份。`windowId` 之外的三项都不交给模型。 */
interface KnownWindow {
  windowId: string
  handle: number
  pid: number
  processStartedAt: number
  app: string
  title: string
}

/** 一次观察的记录。动作前的唯一匹配与前置条件按它判。 */
interface ObservationRecord {
  observationId: string
  windowId: string
  /** 采集这一份时的宿主代际。代际一变这份记录即作废。 */
  epochKey: string
  elements: DesktopElement[]
}

/** 一次执行持有的身份。`released` 置上之后这个端口永不再取得能力。 */
interface Lease {
  owner: number
  executorId: string
  conversationId: string
  released: boolean
  /** 本执行者的观察记录，按 `windowId` 各留最近一份。 */
  observations: Map<string, ObservationRecord>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 宿主代际键。三项任一变化即旧观察与旧引用整体作废。 */
function epochKeyOf(host: NativeDesktopHost): string {
  return `${host.hostId}#${host.hostEpoch}#${host.connectionEpoch}`
}

/** 窗口身份键。句柄与 pid 都会被复用，三项一起才认得出还是不是同一个窗口。 */
function identityKey(w: { handle: number; pid: number; processStartedAt: number }): string {
  return `${w.handle}:${w.pid}:${w.processStartedAt}`
}

/** 一个节点的端口形状。子节点不进去：层级不在端口契约里。 */
function elementOf(node: DesktopNode): DesktopElement {
  return {
    ref: node.ref,
    role: node.role,
    name: node.name,
    automationId: node.automationId,
    ...(node.value !== undefined ? { value: node.value } : {}),
    enabled: node.enabled,
    offscreen: node.offscreen,
    actions: [...node.actions],
  }
}

/** 控件树展平成表。定位按 role / name / automationId 做，不按路径。 */
function flatten(node: DesktopNode, out: DesktopElement[]): void {
  out.push(elementOf(node))
  for (const child of node.children) flatten(child, out)
}

export class DesktopCoordinator {
  #bridge: DesktopBridge
  #enabled: () => boolean
  #nextOwner = 0
  #nextObservation = 0
  #nextAction = 0
  #nextWindow = 0
  /** 已发现的窗口，按不透明 id 索引。 */
  #windows = new Map<string, KnownWindow>()
  /** 身份键 → 不透明 id。同一个窗口再次被发现时沿用同一个 id。 */
  #byIdentity = new Map<string, string>()
  #leases = new Map<number, Lease>()
  /** 此刻在操作哪个应用，以及是谁在操作。`null` = 没有执行者持着桌面目标。 */
  #targetApp: string | null = null
  #targetOwner: number | null = null
  #targetChanges = new Set<(app: string | null) => void>()
  #offHostChange: () => void

  constructor(bridge: DesktopBridge, enabled: () => boolean) {
    this.#bridge = bridge
    this.#enabled = enabled
    // 宿主断开或换代际：已发现的窗口与正在操作的读数都不再成立。
    this.#offHostChange = bridge.onHostChange(() => {
      this.#windows.clear()
      this.#byIdentity.clear()
      this.#clearTarget()
    })
  }

  /**
   * 电脑操作能力是否可用。
   *
   * 四项缺一不可：用户启用了、宿主连上了、worker 就绪了、系统授权了。
   * 装配方按它决定要不要注入端口——不是先给一个端口、调用时再报错。
   */
  available(): boolean {
    const host = this.#bridge.host()
    return this.#enabled() && host !== null && host.workerReady && host.authorized
  }

  /** 此刻在操作哪个应用。界面按它显示运行态的目标。 */
  target(): string | null {
    return this.#targetApp
  }

  onTargetChange(listener: (app: string | null) => void): () => void {
    this.#targetChanges.add(listener)
    return () => this.#targetChanges.delete(listener)
  }

  /**
   * 给一次执行造一个端口。
   *
   * `executorId` 每次不同：排队归属与撤销按它记，两条会话、父任务与子任务因此
   * 各撤各的。`conversationId` 只进日志，控制归属不按它裁决——桌面是一台机器
   * 共有的资源，本批次不做跨执行者互斥。
   */
  portFor(conversationId: string): DesktopPort {
    this.#nextOwner += 1
    const lease: Lease = {
      owner: this.#nextOwner,
      executorId: `dx_${this.#nextOwner}`,
      conversationId,
      released: false,
      observations: new Map(),
    }
    this.#leases.set(lease.owner, lease)
    return {
      windows: () => this.#windowList(lease),
      observe: (input) => this.#observe(lease, input),
      elements: (windowId, observationId) => this.#elements(lease, windowId, observationId),
      setValue: (input) => this.#act(lease, 'set_value', input),
      invoke: (input) => this.#act(lease, 'invoke', input),
      wait: (input) => this.#wait(lease, input),
      release: () => this.#release(lease),
    }
  }

  stop(): void {
    this.#offHostChange()
    for (const lease of [...this.#leases.values()]) void this.#release(lease)
  }

  /** 本次执行还能不能操作桌面。每个发请求的入口都要过这一关。 */
  #liveHost(lease: Lease): NativeDesktopHost {
    if (lease.released) throw new DesktopUnavailableError('本次执行的电脑操作已经结束')
    if (!this.available()) throw new DesktopUnavailableError('电脑操作此刻不可用')
    const host = this.#bridge.host()
    if (!host) throw new DesktopUnavailableError('桌面宿主未连接')
    return host
  }

  async #windowList(lease: Lease): Promise<DesktopWindowInfo[]> {
    this.#liveHost(lease)
    const result = await this.#bridge.request('list_windows', { executorId: lease.executorId })
    const observation = expect(result.observation, 'windows')
    const seen = new Set<string>()
    const out: DesktopWindowInfo[] = []
    for (const w of observation.windows) {
      const key = identityKey(w)
      seen.add(key)
      let windowId = this.#byIdentity.get(key)
      if (windowId === undefined) {
        this.#nextWindow += 1
        windowId = `dw_${this.#nextWindow}`
        this.#byIdentity.set(key, windowId)
      }
      this.#windows.set(windowId, { windowId, ...w })
      out.push({ windowId, app: w.app, title: w.title })
    }
    // 这一次没再出现的窗口就地作废：句柄会被 OS 复用，留着旧 id 等于给一个可能
    // 指向另一个窗口的目标。
    for (const [key, id] of [...this.#byIdentity]) {
      if (seen.has(key)) continue
      this.#byIdentity.delete(key)
      this.#windows.delete(id)
    }
    return out
  }

  /** 把不透明 id 还原成目标身份。认不出的 id 在本地就拒绝，一帧都不发。 */
  #targetOf(windowId: string): KnownWindow {
    const known = this.#windows.get(windowId)
    if (!known) {
      throw new DesktopTargetError(`认不出的窗口 ${windowId}，请重新调用 desktop_windows`)
    }
    return known
  }

  #frameTarget(known: KnownWindow): DesktopTarget {
    return { window: known.handle, pid: known.pid, processStartedAt: known.processStartedAt }
  }

  async #observe(
    lease: Lease,
    input: { windowId: string; maxNodes?: number; maxDepth?: number },
  ): Promise<DesktopSnapshot> {
    const host = this.#liveHost(lease)
    const known = this.#targetOf(input.windowId)
    // 目标在**发请求之前**就登记：读树可能挂在 provider 上直到超时，等回包之后再登记的话，
    // 界面在这段时间里说不出正在操作谁。
    this.#setTarget(lease, known.app)
    const result = await this.#bridge.request('read_tree', {
      executorId: lease.executorId,
      target: this.#frameTarget(known),
      maxNodes: input.maxNodes ?? DEFAULT_MAX_NODES,
      maxDepth: input.maxDepth ?? DEFAULT_MAX_DEPTH,
      timeBudgetMs: READ_TREE_BUDGET_MS,
    })
    const observation = expect(result.observation, 'tree')
    const elements: DesktopElement[] = []
    flatten(observation.root, elements)
    this.#nextObservation += 1
    const record: ObservationRecord = {
      observationId: `do_${this.#nextObservation}`,
      windowId: input.windowId,
      epochKey: epochKeyOf(host),
      elements,
    }
    // 同一个窗口只留最近一份：留着旧编号等于让模型在一份已经不成立的快照上发动作。
    lease.observations.set(input.windowId, record)
    return {
      windowId: input.windowId,
      app: known.app,
      title: known.title,
      observationId: record.observationId,
      capturedAt: observation.capturedAt,
      elements,
      truncated: !observation.completeness.complete,
      truncatedBy: [...observation.completeness.truncatedBy],
    }
  }

  /** 取回一次观察记录。代际变了、窗口对不上、编号换过，三种都回 `null`。 */
  #elements(lease: Lease, windowId: string, observationId: string): DesktopElement[] | null {
    if (lease.released) return null
    const host = this.#bridge.host()
    if (!host) return null
    const record = lease.observations.get(windowId)
    if (!record || record.observationId !== observationId) return null
    if (record.epochKey !== epochKeyOf(host)) return null
    return record.elements
  }

  #recordOf(lease: Lease, windowId: string, observationId: string, ref: string): void {
    const elements = this.#elements(lease, windowId, observationId)
    if (!elements) {
      throw new DesktopTargetError(`观察 ${observationId} 已经失效，请重新观察`)
    }
    if (!elements.some((e) => e.ref === ref)) {
      throw new DesktopTargetError(`观察 ${observationId} 里没有控件 ${ref}`)
    }
  }

  async #act(
    lease: Lease,
    op: 'set_value' | 'invoke',
    input: { windowId: string; observationId: string; ref: string; value?: string },
  ): Promise<DesktopActResult> {
    this.#liveHost(lease)
    const known = this.#targetOf(input.windowId)
    this.#recordOf(lease, input.windowId, input.observationId, input.ref)
    this.#nextAction += 1
    const actionId = `da_${this.#nextAction}`
    this.#setTarget(lease, known.app)
    try {
      const result = await this.#bridge.request(op, {
        executorId: lease.executorId,
        actionId,
        target: this.#frameTarget(known),
        ref: input.ref,
        ...(input.value !== undefined ? { value: input.value } : {}),
      })
      // 动作改了控件树，旧编号不再成立：下一步必须重新观察。
      lease.observations.delete(input.windowId)
      return {
        dispatch: result.dispatch,
        actionId,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...followUpOf(result.observation, result.observationError),
      }
    } catch (err) {
      if (!(err instanceof DesktopBridgeError)) throw err
      lease.observations.delete(input.windowId)
      // 执行事实来自异常自己带的那一格：压成一句失败的话，调用方分不出「没执行」
      // 与「可能已经执行」，而后者禁止重发。
      return {
        dispatch: err.dispatch,
        actionId,
        reason: err.message,
        element: null,
        observationError: '宿主不可用，动作之后没有重读',
      }
    }
  }

  /**
   * 等一个控件满足后置条件。
   *
   * 按固定间隔重读同一个 `ref`，不派发任何动作。每一轮都重新检查本次执行还在不在：
   * 用户按下停止之后不再继续占着宿主轮询。
   */
  async #wait(
    lease: Lease,
    input: {
      windowId: string
      observationId: string
      ref: string
      until: DesktopWaitCondition
      value?: string
      timeoutMs: number
    },
  ): Promise<DesktopWaitResult> {
    this.#liveHost(lease)
    const known = this.#targetOf(input.windowId)
    this.#recordOf(lease, input.windowId, input.observationId, input.ref)
    this.#setTarget(lease, known.app)
    const deadline = Date.now() + input.timeoutMs
    let last: DesktopFollowUp = { element: null, observationError: '还没有读到这个控件' }
    for (;;) {
      if (lease.released) return { found: false, reason: 'cancelled', ...last }
      const result = await this.#bridge.request('read_element', {
        executorId: lease.executorId,
        target: this.#frameTarget(known),
        ref: input.ref,
      })
      last = followUpOf(result.observation, result.reason ?? '没有读到这个控件')
      if (last.element && satisfied(last.element, input.until, input.value)) {
        return { found: true, ...last }
      }
      if (Date.now() + WAIT_POLL_MS >= deadline) return { found: false, reason: 'timeout', ...last }
      await sleep(WAIT_POLL_MS)
    }
  }

  /**
   * 释放这次执行。
   *
   * 三步都要做且都要幂等：撤销宿主那边尚未派发的请求、让在途调用按执行事实收尾、
   * 丢掉本执行者的观察记录。重复调用是空操作，不是第二条路径。
   */
  async #release(lease: Lease): Promise<void> {
    if (lease.released) return
    lease.released = true
    lease.observations.clear()
    this.#leases.delete(lease.owner)
    if (this.#targetOwner === lease.owner) this.#clearTarget()
    // 先让本地在途的调用收尾：撤销帧发不发得出去都不影响它们已经没有回执可等。
    this.#bridge.settleExecutor(lease.executorId, '本次执行的电脑操作已经结束')
    if (!this.#bridge.host()) return
    await this.#bridge
      .request('cancel', { executorId: lease.executorId }, CANCEL_DEADLINE_MS)
      .then(() => undefined)
      .catch((err: unknown) => {
        log.info(
          'desktop',
          `撤销排队请求未送达：${err instanceof Error ? err.message : String(err)}`,
        )
      })
  }

  #setTarget(lease: Lease, app: string): void {
    if (this.#targetApp === app && this.#targetOwner === lease.owner) return
    this.#targetApp = app
    this.#targetOwner = lease.owner
    for (const listener of [...this.#targetChanges]) listener(app)
  }

  #clearTarget(): void {
    if (this.#targetApp === null && this.#targetOwner === null) return
    this.#targetApp = null
    this.#targetOwner = null
    for (const listener of [...this.#targetChanges]) listener(null)
  }
}

/** 后置条件判定。`value` 条件要求调用方给出目标值，端口那侧已经拦过缺席。 */
function satisfied(
  element: DesktopElement,
  until: DesktopWaitCondition,
  value: string | undefined,
): boolean {
  return until === 'enabled' ? element.enabled : element.value === value
}

/** 重读结果的两种形状。观察缺席时如实说明原因，不拿旧读数顶上。 */
function followUpOf(
  observation: DesktopObservation | undefined,
  error: string | undefined,
): DesktopFollowUp {
  if (observation?.kind === 'element') return { element: elementOf(observation.element) }
  return { element: null, observationError: error ?? '宿主没有回传动作之后的读数' }
}

/**
 * 取一份指定种类的观察。
 *
 * 种类对不上即协议错，抛出而不是当成空结果：把一份 `element` 读成 `windows`
 * 会让调用方拿到一张空的窗口表，而那与「这台机器上没有窗口」无法区分。
 */
function expect<K extends DesktopObservation['kind']>(
  observation: DesktopObservation | undefined,
  kind: K,
): Extract<DesktopObservation, { kind: K }> {
  if (observation?.kind !== kind) {
    throw new DesktopBridgeError(`宿主没有回传 ${kind} 观察`, 'not_dispatched')
  }
  return observation as Extract<DesktopObservation, { kind: K }>
}
