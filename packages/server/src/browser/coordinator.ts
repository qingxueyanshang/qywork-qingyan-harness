/**
 * 浏览器控制协调器：应用进程级对象，由 `serve` 装配。
 *
 * 它只执行已经绑定身份的操作——不规划任务，不存第二份「任务进行到哪」。
 *
 * 归属模型：标签页归属键是会话 id，跨消息稳定。AI 在某会话里 `create` 的页归它，
 * 之后该会话的每一条消息都能直接 observe/act——协调器在第一次操作时按会话归属自动附上
 * CDP 会话，不经交接。归属存在原生宿主上（`Tab.conversation_id`），会话删除即关它名下的页。
 *
 * 三条边界：
 *
 * 1. **控制槽按执行者分配，独占降到页这一级。** 每次执行各有自己的 CDP 连接、页会话表
 *    与观察表，同一条会话的父子与并行成员各操作各的页；两个执行者碰同一页时，后到的
 *    一方拿到明确失败，不排队、不抢占。
 *    这条不影响归属：C 的 run 释放后 C 的页仍归 C，C 的下一条消息接着用。
 * 2. **只操作本工作区里自己会话的页。** 工作区先收口：别的工作区的页不列出来、也附不上，
 *    连用户页都只在本工作区里可见。其上再判会话归属，用户页要用户在聊天里点名后模型
 *    `bind` 才归本会话。
 * 3. **宿主断开或重连即全部控制作废**：CDP 连接、页会话丢弃；归属留在宿主上，重连后接着用。
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
 * 浏览器控制的最低 Chromium 主版本。WebView2 Runtime 与 Chrome / Edge / Chromium 同按它判。
 *
 * 这个主版本上 `Emulation.setFocusEmulationEnabled` 被接受，附加目标、跨站子会话、
 * 页面输入、截图、AX 树、`DOM.setFileInputFiles` 与逐下载钩子都已实测通过
 * （WebView2 152.0.4191.66）。低于它不发布 AI 控制能力，手动浏览不受影响。
 */
export const MIN_CHROMIUM_MAJOR = 152

/**
 * 这一页正被另一个执行者占着。
 *
 * 本次调用还没有向宿主或 CDP 发出任何帧，因此按 `BrowserRefusal` 声明 `executed:false`：
 * 调用方据此知道页面没被动过。已发出的动作即使随后失败也不得用这个形状。
 */
export class BrowserBusyError extends Error implements BrowserRefusal {
  readonly errorKind = 'browser_busy' as const
  readonly executed = false as const
}
/** 这个端口已经释放过。上一条消息的 Run 收尾后再调工具走到这里，不复活。 */
export class BrowserReleasedError extends Error {}
/**
 * 这个 tabId 不在本次执行看得见的清单里：跨工作区、跨会话、未接管的用户页、认不出的 id
 * 都走这条。
 *
 * 判定在同步段完成，一帧都没发出去，因此同样按 `BrowserRefusal` 声明 `executed:false`。
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

/** 一次观察在协调器里保留多久。只留最近几份，旧编号本来就要求重新观察。 */
const MAX_OBSERVATIONS = 8

/**
 * 动作与导航的后处理绝对预算：静默等待、导航确认、观察采集共用这一个截止时间。
 *
 * 各阶段不重新给满额度，否则一条默认 15000 ms 的 CDP 命令就能让整次调用远超上限。
 * 导航命令本身的 30000 ms 在这份预算之外。这些是工程预算，不是网站就绪保证。
 */
const FOLLOW_UP_BUDGET_MS = 10_000
/** 静默等待的阶段上限。到点即采，采得到就按 `deadline` 如实标注。 */
const QUIET_LIMIT_MS = 1_500
/** 静默采样间隔。 */
const QUIET_SAMPLE_MS = 100
/** 探针命令的单条上限，再短也按剩余预算取小。 */
const PROBE_TIMEOUT_MS = 2_000
/** 等导航提交事件的上限。 */
const COMMIT_WAIT_MS = 3_000
/** 导航命令本身的上限。 */
const NAVIGATE_TIMEOUT_MS = 30_000
/**
 * 一次释放的绝对清理预算：撤销授权、页内等待器清理、detach、断连共用它。
 *
 * 按页重新给满预算的话，控制着多页的执行收尾时间随页数线性增长，而释放发生在
 * 用户按下停止之后，那段时间里界面没有任何可解释的进展。
 */
const RELEASE_BUDGET_MS = 5_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** 距截止时间还剩多少毫秒。 */
const leftMs = (deadline: number) => deadline - Date.now()
/** 探针命令的超时：剩余预算与单条上限取小。 */
const probeTimeout = (deadline: number) => Math.max(1, Math.min(PROBE_TIMEOUT_MS, leftMs(deadline)))

/** 等一个兑现，或到点为止。到点时清掉定时器，不留悬着的计时。 */
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
 * 建立在发命令之前、结束时 `stop`：事件可能先于命令回包到达，判断「这段时间里有没有
 * 导航」必须覆盖命令本身。`Page` 域事件由页会话初始化时的 `Page.enable` 发布，
 * 这里不另开事件源。
 */
interface NavWatch {
  /** 收到的导航事件条数。静默采样按它是否增长判断本次窗口内有没有导航。 */
  events(): number
  /** 有导航开始但还没收到结束事件。 */
  loading(): boolean
  /** 已经收到提交证据。 */
  committed(): boolean
  /** 提交时兑现，等导航确认用它，不轮询。 */
  commit: Promise<void>
  stop(): void
}

/**
 * 一次执行的控制槽。每个 owner 至多一个，宿主或 CDP 断连、释放、初始化失败时消亡。
 *
 * 它是「这次执行手里有哪条 CDP 连接、附着哪些页」的账，**不是归属账**——归属在宿主上
 * 按会话记。`sessions` 与 `attaching` 合起来就是这次执行占着的页，页级互斥只认它们。
 */
interface Control {
  owner: number
  /** 这次执行归哪条会话（顶层会话）。归属判定与占页都按它。 */
  conversationId: string
  /** 建槽时的宿主连接纪元。异步提交点按它核对宿主身份，重连后的槽不被旧回调改写。 */
  epoch: number
  client: CdpClient | null
  /** 建连的在途 Promise。同槽并发附页共用它，不为第二页再连一条。 */
  connecting: Promise<CdpClient> | null
  /** tabId → CDP 页会话 id。只是本次执行已经附上的那些，不是归属。 */
  sessions: Map<string, string>
  /**
   * tabId → 占页的在途 Promise。同槽同页并发调用共用一次。
   *
   * 登记即占住这一页：从冲突检查到这里是同一个同步段，中间不得插 await，否则两个
   * 执行者会双双通过检查并各自向同一页发输入。
   */
  attaching: Map<string, Promise<void>>
  /** 观察编号 → 该次观察的 ref 表。动作只认这里有的编号。 */
  observations: Map<string, ObservationRecord>
  /** downloadId → tabId。本槽已登记、尚未被宿主裁决的下载授权，释放时按 id 撤销。 */
  arms: Map<string, string>
  /** 本槽在途的下载等待。释放时逐条终结，不等各自的期限。 */
  waits: Set<(reason: string) => void>
  /** 这一次释放的收尾。非 `null` 即槽正在清理：别的执行者要等它结束才能接手它占着的页。 */
  releasing: Promise<void> | null
}

/**
 * 一次执行持有的控制身份。端口闭包持有它，`released` 置上之后这个端口永不再取得控制。
 *
 * 已释放状态跟着端口走，不进协调器的集合：进程级的「已释放 owner」集合会随轮数一直增长。
 */
interface Lease {
  owner: number
  conversationId: string
  /** 这次执行所在的工作区。列页、建页与接管都按它收口，跨工作区的 tabId 一律拒绝。 */
  workspaceId: string
  released: boolean
}

/**
 * 只比第一段主版本。不要改回逐段比较：后三段是 Chrome、Edge、WebView2 各自的构建号，
 * 彼此不可比，同一主版本上较早的 Edge 构建会被一个 WebView2 构建号拒掉。读不出主版本的一律不达标。
 */
export function meetsRuntimeFloor(version: string, floor = MIN_CHROMIUM_MAJOR): boolean {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isFinite(major) && major >= floor
}

export class BrowserCoordinator {
  #bridge: BrowserBridge
  /** owner → 控制槽。每次执行一个，互不相干；碰同一页才互斥。 */
  #controls = new Map<number, Control>()
  #nextOwner = 0
  #nextDownload = 0
  #offHostChange: () => void
  #offClosed: () => void

  constructor(bridge: BrowserBridge) {
    this.#bridge = bridge
    // 断开与重连都让全部控制作废：重连后的调试端点是新的，旧连接上的页会话已经不存在。
    this.#offHostChange = bridge.onHostChange(() => this.#dropAll())
    // 宿主侧关掉的页（用户关、按会话关）要从持有它的控制槽里摘掉会话，
    // 否则取消时的清理命令会对着一个不存在的 CDP 会话逐条报错。
    this.#offClosed = bridge.onEvent((frame) => {
      if (frame.kind === 'closed') this.#forget(frame.tabId)
    })
  }

  /**
   * AI 控制能力是否可用。
   *
   * 宿主没连上、或它报的运行时版本低于下限，都不发布——不是握手里写死一个 true，
   * 也不做一个点了必然报错的入口。
   */
  available(): boolean {
    return this.#host() !== null
  }

  /**
   * 订阅宿主事件：导航、标题、关闭、归属变化、下载被拦与下载完成。
   *
   * 下载的终态只从这里来——`download.arm` 的回执只说明授权登记成功，
   * 文件落没落盘要等 `download.finished` 再核对磁盘。
   */
  onEvent(listener: (frame: BrowserEventFrame) => void): () => void {
    return this.#bridge.onEvent(listener)
  }

  /**
   * 关掉一条会话名下的全部 AI 页。只有会话删除走这条，页面不留孤儿；归档不关页。
   *
   * 先让这条会话**全部**执行者的控制槽收尾，再发一次 `close.conversation`：反过来的话
   * 清理命令打在已经不存在的页会话上，逐条报错。归属在宿主上，所以只发一条，
   * 由宿主按会话过滤删页。
   */
  async closeConversation(conversationId: string): Promise<void> {
    const mine = [...this.#controls.values()].filter((c) => c.conversationId === conversationId)
    await Promise.all(mine.map((control) => this.#teardown(control)))
    await this.#bridge.request('close.conversation', { conversationId }).catch((err) => {
      log.info('browser', `按会话关页未送达：${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /**
   * 给一次执行造一个端口。
   *
   * 端口自己不占控制槽，第一次操作才占。`conversationId` 是这个 Run 的归属，
   * 传进来的都是顶层会话（成员会话记派它的那条）；`workspaceId` 是那条会话所在的
   * 工作区，装配方查不到就不该造端口，这里不接受空值。
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

  /** 达标的宿主。版本不达标与没连上在这里合成同一个「没有可用宿主」。 */
  #host(): NativeBrowserHost | null {
    const host = this.#bridge.host()
    return host && meetsRuntimeFloor(host.runtimeVersion) ? host : null
  }

  /**
   * 存活页清单：**本工作区里**本会话自己的页 + 用户手动开的页。
   * 别的工作区的页与别的会话的页都不列出来，也不给它们 tabId。
   *
   * `controlled` = 这一页归本会话（可以直接操作）。用户页 `controlled:false`，
   * 要用户在聊天里点名后 `bind` 才归本会话。
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
   * 释放之后这个端口**永久出局**（`lease.released`），但**归属留在宿主上**：会话的页仍归它，
   * 下一条消息用新端口接着操作。重复调用加入同一次收尾，不提前返回一个伪完成。
   */
  async #release(lease: Lease): Promise<void> {
    lease.released = true
    const control = this.#controls.get(lease.owner)
    if (!control) return
    await this.#teardown(control)
  }

  /**
   * 收尾一个控制槽：关业务入口 → 终结本槽下载等待 → 撤销未消费授权 → 取消客户端 → 断连。
   *
   * 槽在整段清理期间**仍留在表里**，别的执行者因此不会附到一个正在被清理的页；清理结束后
   * 按对象相等删除，重连后建出的新槽不被这一次收尾删掉。全程共用一个截止时间。
   */
  #teardown(control: Control): Promise<void> {
    if (control.releasing) return control.releasing
    const deadline = Date.now() + RELEASE_BUDGET_MS
    const client = control.client
    // `cancel` 的同步前缀就关掉业务发送口，因此这一句放在 await 之前：等到异步段里再关，
    // 排队中的动作还会发到网站上。
    const cancelling = client ? client.cancel('执行结束', deadline) : null
    for (const abort of [...control.waits]) abort('浏览器控制已释放，这次下载没有确认到终态')
    control.waits.clear()
    // 收尾正文放进微任务：它同步执行的话，`releasing` 还没赋值，`#alive` 会把清理中的槽判成有效。
    const done = Promise.resolve()
      .then(async () => {
        await this.#revokeArms(control, deadline)
        if (cancelling) {
          await cancelling.catch((err: unknown) => {
            log.warn('browser', `取消收尾失败：${err instanceof Error ? err.message : String(err)}`)
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

  /** 宿主断开、重连或服务退出：全部控制槽收尾。别的会话的页面与归属都留在宿主上。 */
  #dropAll(): void {
    for (const control of [...this.#controls.values()]) {
      void this.#teardown(control).catch(() => {})
    }
  }

  /**
   * 这个槽此刻还作数吗。
   *
   * 三项缺一不可：它仍是本次执行当前的槽、没有在清理、宿主连接纪元没变。
   * 每个异步提交点都要过这一关——建连、占页与观察的回包都可能在释放或重连之后到达。
   *
   * 页还占不占得住**不看它**：清理中的槽仍会对它附着的页发收尾命令，那些页要等收尾
   * 结束才放给别人，判据是 `#holderOf`。
   */
  #alive(control: Control): boolean {
    return (
      this.#controls.get(control.owner) === control &&
      control.releasing === null &&
      this.#host()?.connectionEpoch === control.epoch
    )
  }

  /**
   * 取本次执行的控制槽，没有就建一个。
   *
   * 本 owner 的槽正在清理时等它结束再建新的——宿主断连与初始化失败会在端口不知情的
   * 情况下拆掉槽。这一等是本槽自己的收尾，有界（`RELEASE_BUDGET_MS`），不是全局队列。
   */
  async #acquire(lease: Lease): Promise<Control> {
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

  /** 从持有这一页的控制槽里摘掉它的会话与观察。宿主关页事件与本地 close 都走它。 */
  #forget(tabId: string): void {
    for (const control of this.#controls.values()) {
      const sessionId = control.sessions.get(tabId)
      if (sessionId === undefined) continue
      control.sessions.delete(tabId)
      control.client?.forgetSession(sessionId)
      this.#dropObservations(control, tabId)
    }
  }

  /** 作废一页的全部观察编号。作废范围只到这一页，别的标签页的编号仍然有效。 */
  #dropObservations(control: Control, tabId: string): void {
    for (const [id, record] of [...control.observations]) {
      if (record.tabId === tabId) control.observations.delete(id)
    }
  }

  /**
   * 建一页。**建页不占页**：它只让宿主把页记到本会话名下，控制权要等第一次 observe
   * 或 act 时按页级互斥去取。
   *
   * 因此 `opened` 事件先于 create 回包到达也不会有两个入口分别附页；本次执行释放之后
   * 回包才到时，这一页照样如实返回——它已经在宿主的存活表里，归属也已经落下。
   */
  async #open(lease: Lease, url: string): Promise<BrowserTabInfo> {
    await this.#acquire(lease)
    const data = await this.#bridge.request('create', {
      url,
      workspaceId: lease.workspaceId,
      conversationId: lease.conversationId,
    })
    const tabId = data?.tabId
    if (!tabId) throw new BrowserBridgeError('宿主没有给出 tabId')
    return { tabId, url: data?.url ?? url, title: data?.title ?? '', controlled: true }
  }

  /**
   * 接管一页到本会话，并占住它。
   *
   * 归属判定在宿主：用户页 → 归本会话；已归本会话 → 幂等；已归另一条会话 → 拒绝。
   * `bind` 只在「用户点名了自己开的页」时用；本会话自己开的页由后续操作直接占页，
   * 不需要显式 bind。
   *
   * 回的地址与标题取宿主快照：接管成功时它已经带上新归属，不另读一份 bind 回包。
   */
  async #bind(lease: Lease, tabId: string): Promise<BrowserTabInfo> {
    const control = await this.#acquire(lease)
    await this.#hold(lease, control, tabId, 'bind')
    const snap = this.#bridge.tab(tabId)
    return { tabId, url: snap?.url ?? '', title: snap?.title ?? '', controlled: true }
  }

  /**
   * 取这一页的 CDP 句柄。占控制槽、核归属、占页三步都在这里。
   *
   * **归属跨消息稳定**：本会话上一条消息建的页仍归它，这一步按宿主快照核对归属后
   * 直接占页——所以下一条消息直接 observe/act 就能用，不需要交接。
   */
  async #pageOf(lease: Lease, tabId: string): Promise<{ control: Control; page: PageHandle }> {
    const control = await this.#acquire(lease)
    await this.#hold(lease, control, tabId, 'page')
    const client = control.client
    const sessionId = control.sessions.get(tabId)
    if (!client || !sessionId) throw new BrowserBridgeError(`标签页 ${tabId} 没有可用的会话`)
    return { control, page: { client, sessionId, tabId } }
  }

  /** 此刻占着这一页的另一个槽。清理中的槽同样算占着：它还会对这一页发收尾命令。 */
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
   * 导航是否发生按本次的 CDP 事件与 `Page.navigate` 的回执判定，不按「令牌没变就是
   * 同文档」推断——令牌没变也可能是导航还没提交。
   */
  async #navigate(
    lease: Lease,
    input: { tabId: string; action: 'goto' | 'back' | 'forward' | 'reload'; url?: string },
  ): Promise<FollowUpObservation> {
    const { control, page } = await this.#pageOf(lease, input.tabId)
    // 换文档即换观察：旧编号指向的节点已经不存在。只清这一页的——别的标签页没被这次导航动过。
    this.#dropObservations(control, input.tabId)
    const { client, sessionId } = page
    // 基线现取。观察表里最后那一份是另一个时刻、可能是另一页的值，当基线会判错。
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
        // errorText 表示这次导航失败，页面还停在原处。不能接着采一份旧页快照当跳转成功。
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
      // 没确认到提交就不报 quiet：那一刻的静默可能属于还没被替换掉的旧文档。
      return await this.#followUp(control, page, deadline, committed ? settle : 'deadline')
    } finally {
      watch.stop()
    }
  }

  /**
   * 观察一页，或读一个 `select` 的一页选项。
   *
   * `optionsFor` 按原观察实时读取：不采新快照、不发新编号、不移动页面，因此也不进
   * 观察表——那一份旧观察本来就还在表里，再登记一个编号就是同一份定位信息的第二本账。
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
   * 采集一次观察并登记编号。公开 observe 与三处自动观察共用它。
   *
   * 登记前再核一次控制槽：采集期间控制可能已经释放、被宿主断开或经重连换成了新槽，
   * 那份结果不进表，也不从旧记录里补一个编号顶替。
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
      throw new BrowserReleasedError('本次执行的浏览器控制已经结束，这份观察不登记')
    }
    control.observations.set(record.observationId, record)
    // 只留最近几份。旧编号本来就要求重新观察，留着它们只是让内存跟着轮数长。
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
   * 观察没取得时回 `observationError` 而不是抛错：动作已经发出去了，把它丢进异常会让
   * 调用方分不清「没操作」与「操作后没看见」，从而重复提交。取消之后不再开新观察。
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
      return { observation: null, observationError: '已取消，动作之后没有再观察' }
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
   * 等导航提交。
   *
   * 事件到了就是提交。上限内一条都没到时现读一次文档与基线比：换了文档或地址同样算
   * 提交。两者都没有时返回 false——那时不得声称静默，这次导航可能仍未提交。
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
   * 连续两次采样 `readyState` 为 complete 且 DOM 变更计数不变才算静默；期间收到导航
   * 事件就重新计数，正在加载的旧文档不得提前通过。**静默只说明此刻可以采一份快照**：
   * 尚未发出的延迟请求预知不了，它不表示网站业务已经完成。
   *
   * 探针读数缺字段时按未静默处理——把缺席当成 complete 会让一个仍在加载的页面通过。
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
            // 探针随旧文档一起没了。只读等待器可以重建，动作一概不重发。
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
      log.warn('browser', `静默等待跳过：${err instanceof Error ? err.message : String(err)}`)
    }
    return 'deadline'
  }

  async #act(lease: Lease, input: BrowserActInput): Promise<BrowserActResult> {
    const { control, page } = await this.#pageOf(lease, input.tabId)
    const record = this.#recordOf(control, input.tabId, input.observationId)
    // 订阅先于动作建立：点击触发的导航可能在动作回包之前就开始了。
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
    input: { tabId: string; selector: string; timeoutMs: number },
  ): Promise<BrowserWaitResult> {
    const { control, page } = await this.#pageOf(lease, input.tabId)
    const receipt = await waitOnPage(page, input.selector, input.timeoutMs)
    // 等待按选择器结果直接采集：选择器已经是调用方给的就绪判据，不再叠一层静默等待。
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
   * 一次下载：先登记本次身份的授权，再用 Input 事件点元素触发，然后等这一份身份的终态。
   *
   * 顺序不能反。授权是按 `downloadId` 加绝对路径登记的一次性凭据，先触发再授权的话钩子
   * 拿不到授权，这次下载直接被取消。终态按 `downloadId` 认领——按 tabId 认的话，同一页上
   * 一次调用的迟到 finished 会结算这一次。等到终态之后还要核对磁盘：事件只说明宿主写完了，
   * 文件在不在、多大要自己看。
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
      if ('expired' in out) throw new BrowserBridgeError('下载没有在期限内给出结果，授权已撤销')
      const frame = out.frame
      // 终态到达即授权已被宿主裁决，收尾时不必再撤一次。
      control.arms.delete(downloadId)
      if (frame.kind === 'download.blocked') {
        return {
          ...(frame.reason ? { blocked: frame.reason } : { blocked: 'blocked' }),
          ...(frame.suggestedName ? { suggestedName: frame.suggestedName } : {}),
        }
      }
      // 成功要有宿主给出的实际落点。缺路径的终态不能用请求路径补成成功。
      if (frame.success === false || !frame.path) return { blocked: 'failed' }
      const info = await stat(frame.path).catch(() => null)
      if (!info) throw new BrowserBridgeError(`宿主报下载完成，但 ${frame.path} 不在磁盘上`)
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
   * 取本槽的 CDP 连接，没有就建一条。
   *
   * 建连的在途 Promise 挂在槽上：同一槽的两页并发附加共用一次握手，不各建一条连接。
   * 连上时若本槽已经作废，这条连接立即关掉且不登记——留着它等于一条无人收尾的连接。
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
            throw new BrowserReleasedError('本次执行的浏览器控制已经结束，这条连接不登记')
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
   * 占住一页并建立它的 CDP 会话。`bind` 与全部页面操作共用这一个入口。
   *
   * 准入、冲突检查与登记在同一个同步段里完成，正文推迟到登记之后的微任务：先发 bind、
   * 先建连接或先 await 的话，两个执行者会双双通过检查，各自向同一页发输入。
   * 存活的持有者一律 busy；正在清理的持有者等它收尾结束（有界）再重查，不报 busy。
   *
   * 页会话初始化被拒（焦点仿真不可用）时撤销整个控制槽：带着一个焦点判定不成立的
   * 会话继续操作，输入会落在看不见的地方。
   */
  async #hold(lease: Lease, control: Control, tabId: string, mode: 'bind' | 'page'): Promise<void> {
    let marker = ''
    for (;;) {
      if (control.sessions.has(tabId)) return
      const inflight = control.attaching.get(tabId)
      if (inflight) return inflight
      if (!this.#alive(control)) {
        throw new BrowserReleasedError('本次执行的浏览器控制已经结束，这一页不附加')
      }
      const snap = this.#bridge.tab(tabId)
      if (!snap) throw new BrowserNotOwnedError(`认不出的标签页 ${tabId}`)
      if (snap.workspaceId !== lease.workspaceId) {
        throw new BrowserNotOwnedError(`标签页 ${tabId} 不在本工作区`)
      }
      // bind 是「用户点名了自己开的页」，因此额外接受无归属的页；页面操作只认本会话的页。
      const mine = snap.conversationId === lease.conversationId
      if (!mine && !(mode === 'bind' && snap.conversationId === null)) {
        throw new BrowserNotOwnedError(
          mode === 'bind' ? `标签页 ${tabId} 归另一条会话，接管不了` : `标签页 ${tabId} 不归本会话`,
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
          if (!data?.marker) throw new BrowserBridgeError('宿主没有给出标记')
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
          // 宿主已经关掉的页不再登记：迟到的附加会让一个不存在的页重新可操作。
          if (!this.#bridge.tab(tabId)) {
            await detach()
            throw new BrowserBridgeError(`标签页 ${tabId} 已经关闭`)
          }
          if (!this.#alive(control)) {
            await detach()
            throw new BrowserReleasedError('本次执行的浏览器控制已经结束，这一页不登记')
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
        // 槽已经开始收尾时占用留到收尾结束：清理命令还会打在这一页上，此刻放手会让
        // 接手者的等待器与旧连接的清理交错。
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
    // 归属与页级占用都走 pageOf：别的执行者持着这一页时 close 同样 busy，不做互斥的旁路。
    await this.#pageOf(lease, tabId)
    await this.#bridge.request('close', { tabId })
    this.#forget(tabId)
  }

  /**
   * 登记一次授权，身份先进本槽的账再发请求。
   *
   * 先登记的理由：arm 回包迟到或超时时宿主那边可能已经记上了，没有本地身份就撤不掉它。
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

  /** 撤销本槽的一份授权。走 bridge 直发，不经 `pageOf`——释放之后那条路已经不给控制。 */
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
   * 宿主换过连接时只清本地账：上一纪元的授权已经随断开在宿主侧清空，再发撤销是打在
   * 另一条连接上的无主请求。失败只记一行，断开路径本身也清授权。
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
