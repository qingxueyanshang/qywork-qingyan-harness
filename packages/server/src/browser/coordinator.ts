/**
 * 浏览器控制协调器：应用进程级对象，由 `serve` 装配。
 *
 * 它只执行已绑定身份的操作，不规划任务，也不另行记录任务进度。
 *
 * 归属模型：标签页的归属键是会话 id，跨消息保持不变。AI 在某会话中 `create` 的页归该会话所有，
 * 此后该会话的每一条消息都能直接 observe/act：协调器在第一次操作时按会话归属自动附加
 * CDP 会话，无需交接。归属记录在原生宿主上（`Tab.conversation_id`），删除会话即关闭其名下的页。
 *
 * 三条边界：
 *
 * 1. **控制槽按执行者分配，互斥粒度为单页。** 每次执行各有独立的 CDP 连接、页会话表
 *    与观察表，同一会话的父子与并行成员各自操作自己的页；两个执行者访问同一页时，后到的
 *    一方收到明确失败，不排队、不抢占。
 *    本条不影响归属：C 的 run 释放后，C 的页仍归 C，供 C 的下一条消息继续使用。
 * 2. **只操作本工作区中本会话的页。** 先按工作区限定：其他工作区的页不列出，也无法附加，
 *    用户页同样只在本工作区中可见。在此基础上再判定会话归属：用户页须由用户在聊天中点名、模型
 *    `bind` 之后才归本会话。
 * 3. **宿主断开或重连时全部控制失效**：丢弃 CDP 连接与页会话；归属保留在宿主上，重连后继续使用。
 */

import { stat } from 'node:fs/promises'
import type {
  BrowserActInput,
  BrowserActResult,
  BrowserDownloadResult,
  BrowserObservation,
  BrowserOptionsPage,
  BrowserPort,
  BrowserRefusal,
  BrowserTabInfo,
  BrowserWaitResult,
  BrowserWaitState,
  FollowUpObservation,
} from '@qywork/agent'
import type { BrowserEventFrame } from '@qywork/core'
import { log } from '@qywork/core'
import { type BrowserBridge, BrowserBridgeError, type NativeBrowserHost } from './bridge.ts'
import { CdpClient, CdpDisconnectedError, CdpInitError } from './cdp.ts'
import {
  actOnPage,
  clickForDownload,
  type ObservationRecord,
  observePage,
  type PageHandle,
  readDocument,
  readSelectOptions,
  uploadToPage,
  waitOnPage,
} from './page.ts'

/**
 * 浏览器控制的最低 Chromium 主版本。WebView2 Runtime 与 Chrome / Edge / Chromium 均按此版本判定。
 *
 * 该主版本接受 `Emulation.setFocusEmulationEnabled`，附加目标、跨站子会话、
 * 页面输入、截图、AX 树、`DOM.setFileInputFiles` 与逐下载钩子均已实测通过
 * （WebView2 152.0.4191.66）。低于该版本时不发布 AI 控制能力，手动浏览不受影响。
 */
export const MIN_CHROMIUM_MAJOR = 152

/**
 * 该页正被另一个执行者占用。
 *
 * 本次调用尚未向宿主或 CDP 发出任何帧，因此按 `BrowserRefusal` 声明 `executed:false`：
 * 调用方据此确认页面未被修改。已发出的动作即使随后失败，也不得使用该错误类型。
 */
export class BrowserBusyError extends Error implements BrowserRefusal {
  readonly errorKind = 'browser_busy' as const
  readonly executed = false as const
}
/** 该端口已释放。上一条消息的 Run 收尾之后再调用工具时抛出此错误，端口不再恢复控制。 */
export class BrowserReleasedError extends Error {}
/** 用户关闭了浏览器控制（`browserEnabled`）。判定先于任何帧，因此声明 `executed:false`。 */
export class BrowserUnavailableError extends Error implements BrowserRefusal {
  readonly errorKind = 'browser_unavailable' as const
  readonly executed = false as const
}
/**
 * 该 tabId 不在本次执行可见的清单中：跨工作区、跨会话、未接管的用户页与无法识别的 id
 * 均使用此错误。
 *
 * 判定在同步段完成，未发出任何帧，因此同样按 `BrowserRefusal` 声明 `executed:false`。
 */
export class BrowserNotOwnedError extends Error implements BrowserRefusal {
  readonly errorKind = 'invalid_argument' as const
  readonly executed = false as const
}

/** 连接准备阶段失败，尚未进入页面业务动作。 */
class BrowserConnectionError extends Error implements BrowserRefusal {
  readonly errorKind = 'browser_disconnected' as const
  readonly executed = false as const

  constructor(cause: CdpDisconnectedError) {
    super(
      '浏览器控制连接准备失败，本次页面操作未执行。' +
        '请对原 tabId 调用 browser_observe 重连并取得新观察；无需新开标签或延长页面等待。' +
        `再次失败时停止重复调用并报告。原因：${cause.detail}`,
      { cause },
    )
  }
}

/** 协调器保留的观察份数上限。只保留最近几份：旧编号本身即要求重新观察。 */
const MAX_OBSERVATIONS = 8

/**
 * 动作与导航的后处理绝对预算：静默等待、导航确认与观察采集共用同一个截止时间。
 *
 * 各阶段不重新分配完整额度，否则一条默认 15000 ms 的 CDP 命令即可使整次调用远超上限。
 * 导航命令本身的 30000 ms 不计入该预算。这些是工程预算，不保证网站已就绪。
 */
const FOLLOW_UP_BUDGET_MS = 10_000
/** 静默等待的阶段上限。到时即采集，采集成功时按 `deadline` 如实标注。 */
const QUIET_LIMIT_MS = 1_500
/** 静默采样间隔。 */
const QUIET_SAMPLE_MS = 100
/** 探针命令的单条上限；剩余预算更短时取剩余预算。 */
const PROBE_TIMEOUT_MS = 2_000
/** 等待导航提交事件的上限。 */
const COMMIT_WAIT_MS = 3_000
/** 导航命令本身的上限。 */
const NAVIGATE_TIMEOUT_MS = 30_000
/**
 * 一次释放的绝对清理预算：撤销授权、页内等待器清理、detach 与断开连接共用该预算。
 *
 * 若按页重新分配完整预算，控制多页的执行的收尾时间随页数线性增长，而释放发生在
 * 用户按下停止之后，这段时间内界面没有任何进展。
 */
const RELEASE_BUDGET_MS = 5_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** 距截止时间的剩余毫秒数。 */
const leftMs = (deadline: number) => deadline - Date.now()
/** 探针命令的超时：取剩余预算与单条上限中的较小值。 */
const probeTimeout = (deadline: number) => Math.max(1, Math.min(PROBE_TIMEOUT_MS, leftMs(deadline)))

/** 等待 `pending` 兑现，最长等待 `ms` 毫秒。兑现时清除定时器，不遗留未结束的计时。 */
function firstOf(pending: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, ms))
    void pending.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * 一次动作或导航期间的框架事件。
 *
 * 在发送命令之前建立，结束时调用 `stop`：事件可能先于命令响应到达，判断「这段时间内是否发生
 * 导航」必须覆盖命令本身。`Page` 域事件由页会话初始化时的 `Page.enable` 发布，
 * 此处不另建事件源。
 */
interface NavWatch {
  /** 收到的导航事件条数。静默采样据其是否增长判断本次窗口内是否发生导航。 */
  events(): number
  /** 导航已开始但尚未收到结束事件。 */
  loading(): boolean
  /** 已收到导航提交的证据。 */
  committed(): boolean
  /** 导航提交时兑现；等待导航确认时使用它，不轮询。 */
  commit: Promise<void>
  stop(): void
}

/**
 * 一次执行的控制槽。每个 owner 至多一个，在宿主或 CDP 断开、释放或初始化失败时销毁。
 *
 * 它记录本次执行持有的 CDP 连接与已附加的页，不记录归属：归属由宿主
 * 按会话记录。`sessions` 与 `attaching` 合起来即本次执行占用的页，页级互斥只以它们为准。
 */
interface Control {
  owner: number
  /** 本次执行所属的会话（顶层会话）。归属判定与占页均以它为准。 */
  conversationId: string
  /** 创建控制槽时的宿主连接纪元。异步提交点据此核对宿主身份，使重连后的槽不被旧回调改写。 */
  epoch: number
  client: CdpClient | null
  /** 建立连接的在途 Promise。同一控制槽并发附加页时共用它，不为第二页另建连接。 */
  connecting: Promise<CdpClient> | null
  /** tabId → CDP 页会话 id。仅包含本次执行已附加的页，不表示归属。 */
  sessions: Map<string, string>
  /**
   * tabId → 占页的在途 Promise。同一控制槽对同一页的并发调用共用同一个 Promise。
   *
   * 登记即占用该页：从冲突检查到登记是同一个同步段，中间不得插入 await，否则两个
   * 执行者会同时通过检查，并各自向同一页发送输入。
   */
  attaching: Map<string, Promise<void>>
  /** 观察编号 → 该次观察的 ref 表。动作只接受此表中的编号。 */
  observations: Map<string, ObservationRecord>
  /** downloadId → tabId。本槽已登记、尚未被宿主裁决的下载授权，释放时按 id 撤销。 */
  arms: Map<string, string>
  /** 本槽在途的下载等待。释放时逐条终止，不等待各自的期限。 */
  waits: Set<(reason: string) => void>
  /** 本次释放的收尾过程。非 `null` 表示控制槽正在清理：其他执行者须等待清理结束，才能接手它占用的页。 */
  releasing: Promise<void> | null
}

/**
 * 一次执行持有的控制身份。端口闭包持有它，`released` 置位之后该端口不再取得控制。
 *
 * 已释放状态随端口保存，不记入协调器的集合：进程级的「已释放 owner」集合会随轮数持续增长。
 */
interface Lease {
  owner: number
  conversationId: string
  /** 本次执行所在的工作区。列页、建页与接管均限定在该工作区内，跨工作区的 tabId 一律拒绝。 */
  workspaceId: string
  released: boolean
}

/**
 * 只比较第一段主版本。不要改成逐段比较：后三段是 Chrome、Edge、WebView2 各自的构建号，
 * 彼此不可比较，同一主版本上较早的 Edge 构建会因 WebView2 的构建号而被拒绝。无法读取主版本时一律判为不达标。
 */
export function meetsRuntimeFloor(version: string, floor = MIN_CHROMIUM_MAJOR): boolean {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isFinite(major) && major >= floor
}

export class BrowserCoordinator {
  #bridge: BrowserBridge
  #enabled: () => boolean
  /** owner → 控制槽。每次执行一个，彼此独立；访问同一页时才互斥。 */
  #controls = new Map<number, Control>()
  #nextOwner = 0
  #nextDownload = 0
  #offHostChange: () => void
  #offClosed: () => void

  constructor(bridge: BrowserBridge, enabled: () => boolean) {
    this.#bridge = bridge
    this.#enabled = enabled
    // 断开与重连均使全部控制失效：重连后的调试端点已更换，旧连接上的页会话已不存在。
    this.#offHostChange = bridge.onHostChange(() => this.#dropAll())
    // 宿主侧关闭的页（用户关闭、按会话关闭）须从持有它的控制槽中移除会话，
    // 否则取消时的清理命令会对不存在的 CDP 会话逐条报错。
    this.#offClosed = bridge.onEvent((frame) => {
      if (frame.kind === 'closed') this.#forget(frame.tabId)
    })
  }

  /**
   * AI 控制能力是否可用。
   *
   * 用户关闭了浏览器控制、宿主未连接，或宿主报告的运行时版本低于下限时，均不发布：
   * 不在握手中固定写入 true，也不提供点击后必然报错的入口。
   * 开关只限制 AI 控制：握手中的浏览器能力取自宿主状态，用户手动浏览不受影响。
   */
  available(): boolean {
    return this.#enabled() && this.#host() !== null
  }

  /**
   * 订阅宿主事件：导航、标题、关闭、归属变化、下载被拦截与下载完成。
   *
   * 下载的终态只来自此处：`download.arm` 的回执只表示授权登记成功，
   * 文件是否已写入磁盘须在 `download.finished` 之后核对。
   */
  onEvent(listener: (frame: BrowserEventFrame) => void): () => void {
    return this.#bridge.onEvent(listener)
  }

  /**
   * 关闭一条会话名下的全部 AI 页。仅在删除会话时调用，不遗留无归属的页；归档不关闭页。
   *
   * 先使该会话全部执行者的控制槽完成收尾，再发送一次 `close.conversation`：顺序颠倒时，
   * 清理命令会发往已不存在的页会话并逐条报错。归属记录在宿主上，因此只发送一条，
   * 由宿主按会话筛选并关闭页。
   */
  async closeConversation(conversationId: string): Promise<void> {
    const mine = [...this.#controls.values()].filter((c) => c.conversationId === conversationId)
    await Promise.all(mine.map((control) => this.#teardown(control)))
    await this.#bridge.request('close.conversation', { conversationId }).catch((err) => {
      log.info(
        'browser',
        `按会话关闭页的请求未送达：${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }

  /**
   * 为一次执行创建端口。
   *
   * 端口本身不占用控制槽，第一次操作时才占用。`conversationId` 是该 Run 的归属，
   * 传入的均为顶层会话（成员会话记为派发它的会话）；`workspaceId` 是该会话所在的
   * 工作区，装配方无法查到时不应创建端口，此处不接受空值。
   */
  portFor(conversationId: string, workspaceId: string): BrowserPort {
    this.#nextOwner += 1
    const lease: Lease = { owner: this.#nextOwner, conversationId, workspaceId, released: false }
    return {
      tabs: async () => this.#tabs(lease),
      open: (url) => this.#open(lease, url),
      bind: (tabId) => this.#bind(lease, tabId),
      close: (tabId) => this.#close(lease, tabId),
      navigate: (input) => this.#navigate(lease, input),
      observe: (input) => this.#observe(lease, input),
      act: (input) => this.#act(lease, input),
      wait: (input) => this.#wait(lease, input),
      upload: (input) => this.#upload(lease, input),
      download: (input) => this.#download(lease, input),
      release: () => this.#release(lease),
    }
  }

  stop(): void {
    this.#offHostChange()
    this.#offClosed()
    this.#dropAll()
  }

  /** 版本达标的宿主。版本不达标与未连接在此统一视为「没有可用宿主」。 */
  #host(): NativeBrowserHost | null {
    const host = this.#bridge.host()
    return host && meetsRuntimeFloor(host.runtimeVersion) ? host : null
  }

  /**
   * 存活页清单：本工作区中本会话的页与用户手动打开的页。
   * 其他工作区与其他会话的页均不列出，也不提供它们的 tabId。
   *
   * `controlled` 表示该页归本会话（可直接操作）。用户页为 `controlled:false`，
   * 须由用户在聊天中点名、`bind` 之后才归本会话。
   */
  async #tabs(lease: Lease): Promise<BrowserTabInfo[]> {
    return this.#bridge
      .tabs()
      .filter(
        (tab) =>
          tab.workspaceId === lease.workspaceId &&
          (tab.conversationId === lease.conversationId || tab.conversationId === null),
      )
      .map((tab) => ({
        tabId: tab.tabId,
        url: tab.url,
        title: tab.title,
        controlled: tab.conversationId === lease.conversationId,
      }))
  }

  /**
   * 释放这次执行。
   *
   * 释放之后该端口永久失效（`lease.released`），但归属保留在宿主上：会话的页仍归该会话，
   * 下一条消息使用新端口继续操作。重复调用加入同一次收尾，不在收尾完成之前返回。
   */
  async #release(lease: Lease): Promise<void> {
    lease.released = true
    const control = this.#controls.get(lease.owner)
    if (!control) return
    await this.#teardown(control)
  }

  /**
   * 收尾一个控制槽：关闭业务入口 → 终止本槽的下载等待 → 撤销未使用的授权 → 取消客户端 → 断开连接。
   *
   * 控制槽在整个清理期间仍保留在表中，因此其他执行者不会附加到正在清理的页；清理结束后
   * 按对象相等删除，使重连后创建的新槽不被本次收尾删除。全程共用一个截止时间。
   */
  #teardown(control: Control): Promise<void> {
    if (control.releasing) return control.releasing
    const deadline = Date.now() + RELEASE_BUDGET_MS
    const client = control.client
    // `cancel` 的同步部分即关闭业务发送入口，因此本句必须位于 await 之前：在异步段中才关闭时，
    // 排队中的动作仍会发送到网站。
    const cancelling = client ? client.cancel('执行结束', deadline) : null
    for (const abort of [...control.waits]) abort('浏览器控制已释放，本次下载未确认终态')
    control.waits.clear()
    // 收尾主体放入微任务：若同步执行，`releasing` 尚未赋值，`#alive` 会将清理中的槽判定为有效。
    const done = Promise.resolve()
      .then(async () => {
        await this.#revokeArms(control, deadline)
        if (cancelling) {
          await cancelling.catch((err: unknown) => {
            log.warn(
              'browser',
              `收尾时取消客户端失败：${err instanceof Error ? err.message : String(err)}`,
            )
          })
        }
        client?.close()
      })
      .finally(() => {
        if (this.#controls.get(control.owner) === control) this.#controls.delete(control.owner)
      })
    control.releasing = done
    return done
  }

  /** 宿主断开、重连或服务退出：全部控制槽执行收尾。其他会话的页面与归属均保留在宿主上。 */
  #dropAll(): void {
    for (const control of [...this.#controls.values()]) {
      void this.#teardown(control).catch(() => {})
    }
  }

  /**
   * 判断该控制槽当前是否有效。
   *
   * 三项须同时满足：它仍是本次执行当前的槽、未在清理、宿主连接纪元未变。
   * 每个异步提交点都必须经过此检查：建立连接、占页与观察的响应都可能在释放或重连之后到达。
   *
   * 页是否仍被占用不以此判定：清理中的槽仍会对其附加的页发送收尾命令，这些页须等收尾
   * 结束才交给其他执行者，判据是 `#holderOf`。
   */
  #alive(control: Control): boolean {
    return (
      this.#controls.get(control.owner) === control &&
      control.releasing === null &&
      this.#host()?.connectionEpoch === control.epoch
    )
  }

  /**
   * 取得本次执行的控制槽，不存在时创建。
   *
   * 本 owner 的槽正在清理时，等待清理结束后再创建新槽：宿主断开与初始化失败会在端口不知情的
   * 情况下销毁控制槽。该等待针对本槽自身的收尾，有上限（`RELEASE_BUDGET_MS`），不是全局队列。
   *
   * 开关在此处逐次判定：建页、接管与全部页面操作均经过此处，运行中关闭后下一次操作即被拒绝。
   */
  async #acquire(lease: Lease): Promise<Control> {
    if (!this.#enabled()) throw new BrowserUnavailableError('浏览器控制已关闭')
    for (;;) {
      if (lease.released) throw new BrowserReleasedError('本次执行的浏览器控制已经结束')
      const existing = this.#controls.get(lease.owner)
      if (!existing) break
      if (existing.releasing) {
        await existing.releasing
        continue
      }
      return existing
    }
    const host = this.#host()
    if (!host) throw new BrowserBridgeError('浏览器宿主不可用')
    const control: Control = {
      owner: lease.owner,
      conversationId: lease.conversationId,
      epoch: host.connectionEpoch,
      client: null,
      connecting: null,
      sessions: new Map(),
      attaching: new Map(),
      observations: new Map(),
      arms: new Map(),
      waits: new Set(),
      releasing: null,
    }
    this.#controls.set(lease.owner, control)
    return control
  }

  /** 从持有该页的控制槽中移除它的会话与观察。宿主的关闭页事件与本地 close 均调用此方法。 */
  #forget(tabId: string): void {
    for (const control of this.#controls.values()) {
      const sessionId = control.sessions.get(tabId)
      if (sessionId === undefined) continue
      control.sessions.delete(tabId)
      control.client?.forgetSession(sessionId)
      this.#dropObservations(control, tabId)
    }
  }

  /** 使一页的全部观察编号失效。失效范围仅限该页，其他标签页的编号仍然有效。 */
  #dropObservations(control: Control, tabId: string): void {
    for (const [id, record] of [...control.observations]) {
      if (record.tabId === tabId) control.observations.delete(id)
    }
  }

  /**
   * 新建一页。建页不占用该页：只由宿主将该页记到本会话名下，控制权在第一次 observe
   * 或 act 时按页级互斥取得。
   *
   * 因此 `opened` 事件先于 create 响应到达时，也不会出现两个入口分别附加该页；本次执行释放之后
   * 响应才到达时，该页仍如实返回：它已在宿主的存活表中，归属也已确定。
   */
  async #open(lease: Lease, url: string): Promise<BrowserTabInfo> {
    await this.#acquire(lease)
    const data = await this.#bridge.request('create', {
      url,
      workspaceId: lease.workspaceId,
      conversationId: lease.conversationId,
    })
    const tabId = data?.tabId
    if (!tabId) throw new BrowserBridgeError('宿主未返回 tabId')
    return { tabId, url: data?.url ?? url, title: data?.title ?? '', controlled: true }
  }

  /**
   * 将一页接管到本会话，并占用该页。
   *
   * 归属由宿主判定：用户页 → 归本会话；已归本会话 → 幂等；已归另一条会话 → 拒绝。
   * `bind` 仅在用户点名其自行打开的页时使用；本会话打开的页由后续操作直接占用，
   * 无需显式 bind。
   *
   * 返回的地址与标题取自宿主快照：接管成功时快照已带有新归属，不另行读取 bind 响应。
   */
  async #bind(lease: Lease, tabId: string): Promise<BrowserTabInfo> {
    const control = await this.#acquire(lease)
    await this.#hold(lease, control, tabId, 'bind')
    const snap = this.#bridge.tab(tabId)
    return { tabId, url: snap?.url ?? '', title: snap?.title ?? '', controlled: true }
  }

  /**
   * 取得该页的 CDP 句柄。占用控制槽、核对归属、占页三步均在此完成。
   *
   * 归属跨消息保持不变：本会话上一条消息创建的页仍归本会话，此步按宿主快照核对归属后
   * 直接占页，因此下一条消息可直接 observe/act，无需交接。
   */
  async #pageOf(lease: Lease, tabId: string): Promise<{ control: Control; page: PageHandle }> {
    const control = await this.#acquire(lease)
    await this.#hold(lease, control, tabId, 'page')
    const client = control.client
    const sessionId = control.sessions.get(tabId)
    if (!client || !sessionId) throw new BrowserBridgeError(`标签页 ${tabId} 没有可用的会话`)
    return { control, page: { client, sessionId, tabId } }
  }

  /** 当前占用该页的另一个控制槽。清理中的槽同样视为占用：它仍会对该页发送收尾命令。 */
  #holderOf(self: Control, tabId: string): Control | null {
    for (const control of this.#controls.values()) {
      if (control === self) continue
      if (control.sessions.has(tabId) || control.attaching.has(tabId)) return control
    }
    return null
  }

  #recordOf(control: Control, tabId: string, observationId: string): ObservationRecord {
    const record = control.observations.get(observationId)
    if (!record || record.tabId !== tabId) {
      throw new BrowserBridgeError(`观察 ${observationId} 已经失效，请重新观察`)
    }
    return record
  }

  /**
   * 地址栏级导航，返回导航之后的观察。
   *
   * 导航是否发生按本次的 CDP 事件与 `Page.navigate` 的回执判定，不按「令牌未变即为
   * 同一文档」推断：令牌未变也可能是导航尚未提交。
   */
  async #navigate(
    lease: Lease,
    input: { tabId: string; action: 'goto' | 'back' | 'forward' | 'reload'; url?: string },
  ): Promise<FollowUpObservation> {
    const { control, page } = await this.#pageOf(lease, input.tabId)
    // 更换文档即更换观察：旧编号指向的节点已不存在。只清除该页的观察：其他标签页不受本次导航影响。
    this.#dropObservations(control, input.tabId)
    const { client, sessionId } = page
    // 基线在此时读取。观察表中最后一份是另一时刻、可能属于另一页的值，用作基线会导致误判。
    const baseline = await readDocument(page)
    const tree = await client.send<{ frameTree: { frame: { id: string } } }>(
      'Page.getFrameTree',
      {},
      { sessionId },
    )
    const watch = this.#watchNav(page, tree.frameTree.frame.id)
    try {
      if (input.action === 'goto') {
        const sent = await client.send<{ errorText?: string }>(
          'Page.navigate',
          { url: input.url ?? '' },
          { sessionId, timeoutMs: NAVIGATE_TIMEOUT_MS },
        )
        // errorText 表示本次导航失败，页面仍停留在原处。不得继续采集旧页快照并视为跳转成功。
        if (sent.errorText) throw new BrowserBridgeError(`导航失败：${sent.errorText}`)
      } else if (input.action === 'reload') {
        await client.send('Page.reload', {}, { sessionId, timeoutMs: NAVIGATE_TIMEOUT_MS })
      } else {
        const history = await client.send<{
          currentIndex: number
          entries: { id: number }[]
        }>('Page.getNavigationHistory', {}, { sessionId })
        const step = input.action === 'back' ? -1 : 1
        const entry = history.entries[history.currentIndex + step]
        if (!entry)
          throw new BrowserBridgeError(`没有可${input.action === 'back' ? '后退' : '前进'}的历史`)
        await client.send('Page.navigateToHistoryEntry', { entryId: entry.id }, { sessionId })
      }
      const deadline = Date.now() + FOLLOW_UP_BUDGET_MS
      const committed = await this.#awaitCommit(page, watch, baseline, deadline)
      const settle = await this.#quietWait(page, watch, deadline)
      // 未确认提交时不报告 quiet：此时的静默可能属于尚未被替换的旧文档。
      return await this.#followUp(control, page, deadline, committed ? settle : 'deadline')
    } finally {
      watch.stop()
    }
  }

  /**
   * 观察一页，或读取一个 `select` 的一页选项。
   *
   * `optionsFor` 按原观察实时读取：不采集新快照、不发放新编号、不移动页面，因此也不记入
   * 观察表：原观察仍在表中，再登记一个编号会使同一份定位信息存在两份记录。
   */
  async #observe(
    lease: Lease,
    input: {
      tabId: string
      frame?: string
      screenshot?: boolean
      offset?: number
      query?: string
      optionsFor?: { observationId: string; ref: string; offset?: number }
    },
  ): Promise<BrowserObservation | BrowserOptionsPage> {
    const { control, page } = await this.#pageOf(lease, input.tabId)
    if (input.optionsFor) {
      return readSelectOptions(
        page,
        this.#recordOf(control, input.tabId, input.optionsFor.observationId),
        input.optionsFor.ref,
        input.optionsFor.offset ?? 0,
      )
    }
    return this.#observeInto(control, page, {
      ...(input.frame !== undefined ? { frame: input.frame } : {}),
      ...(input.screenshot !== undefined ? { screenshot: input.screenshot } : {}),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      ...(input.query !== undefined ? { query: input.query } : {}),
    })
  }

  /**
   * 采集一次观察并登记编号。公开的 observe 与三处自动观察共用此方法。
   *
   * 登记前再次核对控制槽：采集期间控制可能已释放、因宿主断开而失效，或经重连更换为新槽，
   * 此时结果不记入表中，也不从旧记录中取一个编号代替。
   */
  async #observeInto(
    control: Control,
    page: PageHandle,
    opts: {
      frame?: string
      screenshot?: boolean
      offset?: number
      query?: string
      deadline?: number
    },
  ): Promise<BrowserObservation> {
    const { observation, record } = await observePage(page, opts)
    if (!this.#alive(control)) {
      throw new BrowserReleasedError('本次执行的浏览器控制已经结束，本次观察不登记')
    }
    control.observations.set(record.observationId, record)
    // 只保留最近几份。旧编号本身即要求重新观察，保留它们只会使内存随轮数增长。
    while (control.observations.size > MAX_OBSERVATIONS) {
      const oldest = control.observations.keys().next().value
      if (oldest === undefined) break
      control.observations.delete(oldest)
    }
    return observation
  }

  /**
   * 动作之后的后续观察。
   *
   * 未取得观察时返回 `observationError` 而不是抛出异常：动作已经发出，抛出异常会使
   * 调用方无法区分「未执行操作」与「操作后未取得观察」，从而重复提交。取消之后不再发起新的观察。
   */
  async #followUp(
    control: Control,
    page: PageHandle,
    deadline: number,
    settle?: 'quiet' | 'deadline',
  ): Promise<FollowUpObservation> {
    if (!page.client.connected) {
      return {
        observation: null,
        observationError: new CdpDisconnectedError('动作之后未取得观察').message,
      }
    }
    if (page.client.cancelled) {
      return { observation: null, observationError: '已取消，动作之后未再观察' }
    }
    try {
      const observation = await this.#observeInto(control, page, { deadline })
      return settle === undefined ? { observation } : { observation, settle }
    } catch (err) {
      return {
        observation: null,
        observationError: err instanceof Error ? err.message : String(err),
      }
    }
  }

  #watchNav(page: PageHandle, frameId?: string): NavWatch {
    let events = 0
    let inflight = 0
    let committed = false
    let settle: () => void = () => {}
    const commit = new Promise<void>((resolve) => {
      settle = resolve
    })
    const mine = (id: unknown) => frameId === undefined || id === frameId
    const off = page.client.onSessionEvent(page.sessionId, (event) => {
      const params = event.params
      const frame = params.frame as { id?: string } | undefined
      if (event.method === 'Page.frameStartedLoading' && mine(params.frameId)) {
        events += 1
        inflight += 1
        return
      }
      if (event.method === 'Page.frameStoppedLoading' && mine(params.frameId)) {
        events += 1
        inflight = Math.max(0, inflight - 1)
      } else if (event.method === 'Page.frameNavigated' && mine(frame?.id)) {
        events += 1
      } else if (event.method === 'Page.navigatedWithinDocument' && mine(params.frameId)) {
        events += 1
      } else {
        return
      }
      committed = true
      settle()
    })
    return {
      events: () => events,
      loading: () => inflight > 0,
      committed: () => committed,
      commit,
      stop: off,
    }
  }

  /**
   * 等待导航提交。
   *
   * 收到事件即视为提交。上限内未收到任何事件时，读取一次文档并与基线比较：文档或地址已更换同样视为
   * 提交。两者均未变化时返回 false：此时不得声称静默，本次导航可能仍未提交。
   */
  async #awaitCommit(
    page: PageHandle,
    watch: NavWatch,
    baseline: { token: string; url: string },
    deadline: number,
  ): Promise<boolean> {
    if (watch.committed()) return true
    if (await firstOf(watch.commit, Math.min(leftMs(deadline), COMMIT_WAIT_MS))) return true
    const head = await readDocument(page, probeTimeout(deadline)).catch(() => null)
    return head !== null && (head.token !== baseline.token || head.url !== baseline.url)
  }

  /**
   * 动作之后的有界静默等待。
   *
   * 连续两次采样 `readyState` 均为 complete 且 DOM 变更计数不变才视为静默；期间收到导航
   * 事件即重新计数，正在加载的旧文档不得提前通过。静默只表示此刻可以采集快照：
   * 尚未发出的延迟请求无法预知，静默不表示网站业务已经完成。
   *
   * 探针读数缺少字段时按未静默处理：将缺失视为 complete 会使仍在加载的页面通过。
   */
  async #quietWait(
    page: PageHandle,
    watch: NavWatch,
    deadline: number,
  ): Promise<'quiet' | 'deadline'> {
    const { client, sessionId } = page
    if (client.cancelled) return 'deadline'
    const stage = Math.min(deadline, Date.now() + QUIET_LIMIT_MS)
    try {
      let probe = await client.startProbe(sessionId, probeTimeout(deadline))
      try {
        let previous: { ready: string; mutations: number } | null = null
        let seen = watch.events()
        while (leftMs(stage) > 0) {
          await sleep(Math.min(QUIET_SAMPLE_MS, leftMs(stage)))
          const read = await client.readProbe(sessionId, probe, probeTimeout(deadline))
          const moved = watch.events() !== seen
          seen = watch.events()
          if (moved || watch.loading()) {
            previous = null
            continue
          }
          if (read.gone === true) {
            // 探针随旧文档一同销毁。只读等待器可以重建，动作一律不重发。
            previous = null
            if (leftMs(stage) <= 0) break
            probe = await client.startProbe(sessionId, probeTimeout(deadline))
            continue
          }
          if (typeof read.ready !== 'string' || typeof read.mutations !== 'number') {
            log.warn('browser', '静默探针读数不完整，本次按未静默处理')
            previous = null
            continue
          }
          if (
            previous?.ready === 'complete' &&
            read.ready === 'complete' &&
            previous.mutations === read.mutations
          ) {
            return 'quiet'
          }
          previous = { ready: read.ready, mutations: read.mutations }
        }
      } finally {
        await client.disposeWaiter(sessionId, probe).catch(() => {})
      }
    } catch (err) {
      log.warn('browser', `已跳过静默等待：${err instanceof Error ? err.message : String(err)}`)
    }
    return 'deadline'
  }

  async #act(lease: Lease, input: BrowserActInput): Promise<BrowserActResult> {
    const { control, page } = await this.#pageOf(lease, input.tabId)
    const record = this.#recordOf(control, input.tabId, input.observationId)
    // 订阅必须先于动作建立：点击触发的导航可能在动作响应之前开始。
    const watch = this.#watchNav(page)
    try {
      const receipt = await actOnPage(page, record, input)
      const deadline = Date.now() + FOLLOW_UP_BUDGET_MS
      const settle = await this.#quietWait(page, watch, deadline)
      return { ...receipt, ...(await this.#followUp(control, page, deadline, settle)) }
    } finally {
      watch.stop()
    }
  }

  async #wait(
    lease: Lease,
    input: {
      tabId: string
      selector: string
      state: BrowserWaitState
      expected?: string
      timeoutMs: number
    },
  ): Promise<BrowserWaitResult> {
    const { control, page } = await this.#pageOf(lease, input.tabId)
    const receipt = await waitOnPage(
      page,
      {
        selector: input.selector,
        state: input.state,
        ...(input.expected === undefined ? {} : { expected: input.expected }),
      },
      input.timeoutMs,
    )
    // 等待结束后直接采集观察：选择器已是调用方给出的就绪判据，不再附加静默等待。
    const deadline = Date.now() + FOLLOW_UP_BUDGET_MS
    return { ...receipt, ...(await this.#followUp(control, page, deadline)) }
  }

  async #upload(
    lease: Lease,
    input: { tabId: string; observationId: string; ref: string; paths: string[] },
  ): Promise<{ files: string[] }> {
    const { control, page } = await this.#pageOf(lease, input.tabId)
    return uploadToPage(
      page,
      this.#recordOf(control, input.tabId, input.observationId),
      input.ref,
      input.paths,
    )
  }

  /**
   * 执行一次下载：先登记本次下载身份的授权，再用 Input 事件点击元素触发下载，然后等待该身份的终态。
   *
   * 顺序不得颠倒。授权是按 `downloadId` 与绝对路径登记的一次性凭据，先触发再授权时钩子
   * 无法取得授权，本次下载即被取消。终态按 `downloadId` 认领：按 tabId 认领时，同一页上
   * 前一次调用迟到的 finished 会被计入本次下载。取得终态之后还须核对磁盘：事件只表示宿主已完成写入，
   * 文件是否存在及其大小须另行核对。
   */
  async #download(
    lease: Lease,
    input: {
      tabId: string
      observationId: string
      ref: string
      absolutePath: string
      timeoutMs: number
    },
  ): Promise<BrowserDownloadResult> {
    const { control, page } = await this.#pageOf(lease, input.tabId)
    const record = this.#recordOf(control, input.tabId, input.observationId)
    this.#nextDownload += 1
    const downloadId = `dl_${this.#nextDownload}`

    type Outcome = { frame: BrowserEventFrame } | { cancelled: string } | { expired: true }
    let settle: ((out: Outcome) => void) | null = null
    const outcome = new Promise<Outcome>((resolve) => {
      settle = resolve
    })
    const off = this.#bridge.onEvent((frame) => {
      if (frame.downloadId !== downloadId) return
      if (frame.kind === 'download.finished' || frame.kind === 'download.blocked') {
        settle?.({ frame })
      }
    })
    const abort = (reason: string) => settle?.({ cancelled: reason })
    control.waits.add(abort)
    const timer = setTimeout(() => settle?.({ expired: true }), input.timeoutMs)

    try {
      await this.#arm(control, input.tabId, input.absolutePath, input.timeoutMs, downloadId)
      await clickForDownload(page, record, input.ref)
      const out = await outcome
      if ('cancelled' in out) throw new BrowserReleasedError(out.cancelled)
      if ('expired' in out) throw new BrowserBridgeError('下载未在期限内返回结果，授权已撤销')
      const frame = out.frame
      // 终态到达表示授权已被宿主裁决，收尾时无需再次撤销。
      control.arms.delete(downloadId)
      if (frame.kind === 'download.blocked') {
        return {
          ...(frame.reason ? { blocked: frame.reason } : { blocked: 'blocked' }),
          ...(frame.suggestedName ? { suggestedName: frame.suggestedName } : {}),
        }
      }
      // 成功须有宿主给出的实际保存路径。缺少路径的终态不得以请求路径补充为成功。
      if (frame.success === false || !frame.path) return { blocked: 'failed' }
      const info = await stat(frame.path).catch(() => null)
      if (!info) throw new BrowserBridgeError(`宿主报告下载完成，但 ${frame.path} 不在磁盘上`)
      return { path: frame.path, bytes: info.size }
    } finally {
      off()
      clearTimeout(timer)
      control.waits.delete(abort)
      if (control.arms.has(downloadId)) {
        await this.#revokeArm(control, downloadId, Date.now() + RELEASE_BUDGET_MS).catch(() => {})
      }
    }
  }

  /**
   * 取得本槽的 CDP 连接，不存在时建立。
   *
   * 建立连接的在途 Promise 保存在控制槽上：同一控制槽的两页并发附加时共用一次握手，不各自建立连接。
   * 连接建立时若本槽已失效，立即关闭该连接且不登记：保留它会形成一条无人收尾的连接。
   */
  async #clientOf(control: Control): Promise<CdpClient> {
    if (control.client) return control.client
    if (!control.connecting) {
      const host = this.#host()
      if (!host) throw new BrowserBridgeError('浏览器宿主未连接')
      control.connecting = CdpClient.connect(host.debugPort)
        .then((client) => {
          if (!this.#alive(control)) {
            client.close()
            throw new BrowserReleasedError('本次执行的浏览器控制已经结束，该连接不登记')
          }
          control.client = client
          client.onDisconnect(() => {
            if (control.client === client) void this.#teardown(control).catch(() => {})
          })
          if (!client.connected) throw new CdpDisconnectedError('CDP 连接已断开')
          return client
        })
        .finally(() => {
          control.connecting = null
        })
    }
    return control.connecting
  }

  /**
   * 占用一页并建立其 CDP 会话。`bind` 与全部页面操作共用此入口。
   *
   * 准入、冲突检查与登记在同一个同步段中完成，主体推迟到登记之后的微任务：若先发送 bind、
   * 先建立连接或先 await，两个执行者会同时通过检查，并各自向同一页发送输入。
   * 持有者有效时一律返回 busy；持有者正在清理时等待其收尾结束（有上限）后重新检查，不返回 busy。
   *
   * 页会话初始化被拒绝（焦点仿真不可用）时撤销整个控制槽：在焦点判定不成立的
   * 会话上继续操作，输入会发送到不可见的位置。
   */
  async #hold(lease: Lease, control: Control, tabId: string, mode: 'bind' | 'page'): Promise<void> {
    let marker = ''
    for (;;) {
      if (control.sessions.has(tabId)) return
      const inflight = control.attaching.get(tabId)
      if (inflight) return inflight
      if (!this.#alive(control)) {
        throw new BrowserReleasedError('本次执行的浏览器控制已经结束，该页不附加')
      }
      const snap = this.#bridge.tab(tabId)
      if (!snap) throw new BrowserNotOwnedError(`无法识别的标签页 ${tabId}`)
      if (snap.workspaceId !== lease.workspaceId) {
        throw new BrowserNotOwnedError(`标签页 ${tabId} 不在本工作区`)
      }
      // bind 用于用户点名其自行打开的页，因此额外接受无归属的页；页面操作只接受本会话的页。
      const mine = snap.conversationId === lease.conversationId
      if (!mine && !(mode === 'bind' && snap.conversationId === null)) {
        throw new BrowserNotOwnedError(
          mode === 'bind'
            ? `标签页 ${tabId} 属于另一条会话，无法接管`
            : `标签页 ${tabId} 不归本会话`,
        )
      }
      const holder = this.#holderOf(control, tabId)
      if (!holder) {
        marker = snap.marker
        break
      }
      if (!holder.releasing) throw new BrowserBusyError(`标签页 ${tabId} 正被另一个任务操作`)
      await holder.releasing
    }
    const task = Promise.resolve()
      .then(async () => {
        if (mode === 'bind') {
          const data = await this.#bridge.request('bind', {
            tabId,
            workspaceId: lease.workspaceId,
            conversationId: lease.conversationId,
          })
          if (!data?.marker) throw new BrowserBridgeError('宿主未返回标记')
          marker = data.marker
        }
        try {
          const client = await this.#clientOf(control)
          const { sessionId } = await client.attachByMarker(marker)
          const detach = () =>
            client
              .send(
                'Target.detachFromTarget',
                { sessionId },
                { teardown: 'detach', timeoutMs: 3_000 },
              )
              .catch(() => {})
          // 宿主已关闭的页不再登记：迟到的附加会使不存在的页重新可操作。
          if (!this.#bridge.tab(tabId)) {
            await detach()
            throw new BrowserBridgeError(`标签页 ${tabId} 已经关闭`)
          }
          if (!this.#alive(control)) {
            await detach()
            throw new BrowserReleasedError('本次执行的浏览器控制已经结束，该页不登记')
          }
          control.sessions.set(tabId, sessionId)
        } catch (err) {
          if (err instanceof CdpInitError) await this.#teardown(control)
          if (err instanceof CdpDisconnectedError) {
            await this.#teardown(control)
            throw new BrowserConnectionError(err)
          }
          throw err
        }
      })
      .finally(() => {
        // 控制槽已开始收尾时，占用保持到收尾结束：清理命令仍会发往该页，此时释放占用会使
        // 接手者的等待器与旧连接的清理交错执行。
        if (control.releasing && !control.sessions.has(tabId)) {
          void control.releasing.finally(() => control.attaching.delete(tabId))
          return
        }
        control.attaching.delete(tabId)
      })
    control.attaching.set(tabId, task)
    return task
  }

  async #close(lease: Lease, tabId: string): Promise<void> {
    // 归属与页级占用均经由 pageOf 判定：其他执行者持有该页时 close 同样返回 busy，不绕过互斥。
    await this.#pageOf(lease, tabId)
    await this.#bridge.request('close', { tabId })
    this.#forget(tabId)
  }

  /**
   * 登记一次授权：先将身份记入本槽，再发送请求。
   *
   * 必须先登记：arm 响应迟到或超时时，宿主可能已经登记该授权，没有本地身份则无法撤销。
   */
  async #arm(
    control: Control,
    tabId: string,
    absolutePath: string,
    deadlineMs: number,
    downloadId: string,
  ): Promise<void> {
    control.arms.set(downloadId, tabId)
    await this.#bridge.request(
      'download.arm',
      { tabId, path: absolutePath, conversationId: control.conversationId, downloadId },
      deadlineMs,
    )
  }

  /** 撤销本槽的一份授权。经由 bridge 直接发送，不经 `pageOf`：释放之后 `pageOf` 不再提供控制。 */
  async #revokeArm(control: Control, downloadId: string, deadline: number): Promise<boolean> {
    const tabId = control.arms.get(downloadId)
    if (tabId === undefined) return false
    control.arms.delete(downloadId)
    const data = await this.#bridge.request(
      'download.disarm',
      { tabId, downloadId },
      Math.max(1, leftMs(deadline)),
    )
    return data?.removed === true
  }

  /**
   * 撤销本槽尚未被裁决的全部授权。
   *
   * 宿主更换过连接时只清除本地记录：上一纪元的授权已随断开在宿主侧清空，再发送撤销会成为
   * 另一条连接上的无主请求。失败时只记录一行日志，断开路径本身也会清除授权。
   */
  async #revokeArms(control: Control, deadline: number): Promise<void> {
    if (this.#bridge.host()?.connectionEpoch !== control.epoch) {
      control.arms.clear()
      return
    }
    for (const downloadId of [...control.arms.keys()]) {
      await this.#revokeArm(control, downloadId, deadline).catch((err: unknown) => {
        log.info(
          'browser',
          `撤销下载授权未送达：${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }
  }
}
