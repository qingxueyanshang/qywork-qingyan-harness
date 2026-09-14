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
 * 1. **一个宿主同一时刻只有一个 AI 执行在控制。** 抢不到的一方拿到明确失败，不排队、不抢占。
 *    这条不影响归属：C 的 run 释放后 C 的页仍归 C，C 的下一条消息接着用。
 * 2. **只操作自己会话的页。** 别的会话拿不到这一页的会话，也附不上它。用户页要用户在聊天里
 *    点名后模型 `bind` 才归本会话。
 * 3. **宿主断开即当前控制作废**：CDP 连接、页会话丢弃；归属留在宿主上，重连后接着用。
 */

import { stat } from 'node:fs/promises'
import type {
  BrowserActInput,
  BrowserActResult,
  BrowserDownloadResult,
  BrowserObservation,
  BrowserPort,
  BrowserTabInfo,
  BrowserWaitResult,
} from '@qywork/agent'
import type { BrowserEventFrame } from '@qywork/core'
import { log } from '@qywork/core'
import { type BrowserBridge, BrowserBridgeError } from './bridge.ts'
import { CdpClient, CdpInitError } from './cdp.ts'
import {
  actOnPage,
  clickForDownload,
  type ObservationRecord,
  observePage,
  type PageHandle,
  uploadToPage,
  waitOnPage,
} from './page.ts'

/**
 * 浏览器控制的最低 WebView2 Runtime 版本。
 *
 * 这个版本上 `Emulation.setFocusEmulationEnabled` 被接受，附加目标、跨站子会话、
 * 页面输入、截图、AX 树、`DOM.setFileInputFiles` 与逐下载钩子都已实测通过。
 * 低于它不发布 AI 控制能力，手动浏览不受影响。
 */
export const MIN_RUNTIME_VERSION = '152.0.4191.66'

export class BrowserBusyError extends Error {}
/** 这个端口已经释放过。上一条消息的 Run 收尾后再调工具走到这里，不复活。 */
export class BrowserReleasedError extends Error {}
/** 这一页不归本会话。跨会话隔离与「用户页未 bind」都走这条。 */
export class BrowserNotOwnedError extends Error {}

/** 一次观察在协调器里保留多久。只留最近几份，旧编号本来就要求重新观察。 */
const MAX_OBSERVATIONS = 8

/**
 * 当前控制槽。宿主断开、释放控制、初始化失败三种情况下都回到 `null`。
 *
 * 它是「此刻哪一个 Run 在用 CDP 连接」的账，**不是归属账**——归属在宿主上按会话记。
 */
interface Control {
  owner: number
  /** 这个 Run 归哪条会话（顶层会话）。归属判定与自动附页都按它。 */
  conversationId: string
  client: CdpClient | null
  /** tabId → CDP 页会话 id。只是本 Run 已经附上的那些，不是归属。 */
  sessions: Map<string, string>
  /** 观察编号 → 该次观察的 ref 表。动作只认这里有的编号。 */
  observations: Map<string, ObservationRecord>
}

/** 版本按点分数字逐段比较。段数不同时缺的段按 0 算。 */
export function meetsRuntimeFloor(version: string, floor = MIN_RUNTIME_VERSION): boolean {
  const left = version.split('.').map((p) => Number.parseInt(p, 10) || 0)
  const right = floor.split('.').map((p) => Number.parseInt(p, 10) || 0)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] ?? 0
    const b = right[i] ?? 0
    if (a !== b) return a > b
  }
  return true
}

export class BrowserCoordinator {
  #bridge: BrowserBridge
  #control: Control | null = null
  #nextOwner = 0
  /** 已经释放过的执行。它们不得再取得控制槽。 */
  #retired = new Set<number>()
  #offHostChange: () => void
  #offClosed: () => void

  constructor(bridge: BrowserBridge) {
    this.#bridge = bridge
    this.#offHostChange = bridge.onHostChange((host) => {
      if (!host) this.#dropControl()
    })
    // 宿主侧关掉的页（用户关、按会话关）要从当前控制槽里摘掉会话，
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
    const host = this.#bridge.host()
    return host !== null && meetsRuntimeFloor(host.runtimeVersion)
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

  /** 当前控制者的 CDP 客户端与页会话表。没有控制者时为 `null`。 */
  control(): { client: CdpClient; sessions: Map<string, string> } | null {
    const control = this.#control
    if (!control?.client) return null
    return { client: control.client, sessions: control.sessions }
  }

  /**
   * 关掉一条会话名下的全部 AI 页。会话删除/归档走这条，页面不留孤儿。
   *
   * 归属在宿主上，所以只发一条 `close.conversation`，由宿主按会话过滤删页；
   * 若当前控制槽正好属于这条会话，一并丢弃它的 CDP 连接。
   */
  async closeConversation(conversationId: string): Promise<void> {
    if (this.#control?.conversationId === conversationId) this.#dropControl()
    await this.#bridge.request('close.conversation', { conversationId }).catch((err) => {
      log.info('browser', `按会话关页未送达：${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /**
   * 给一次执行造一个端口。
   *
   * 端口自己不占控制槽，第一次操作才占。`conversationId` 是这个 Run 的归属，
   * 传进来的都是顶层会话（成员会话记派它的那条）。
   */
  portFor(conversationId: string): BrowserPort {
    this.#nextOwner += 1
    const owner = this.#nextOwner
    return {
      tabs: async () => this.#tabs(conversationId),
      open: (url) => this.#open(owner, conversationId, url),
      bind: (tabId) => this.#bind(owner, conversationId, tabId),
      close: (tabId) => this.#close(owner, conversationId, tabId),
      navigate: (input) => this.#navigate(owner, conversationId, input),
      observe: (input) => this.#observe(owner, conversationId, input),
      act: (input) => this.#act(owner, conversationId, input),
      wait: (input) => this.#wait(owner, conversationId, input),
      upload: (input) => this.#upload(owner, conversationId, input),
      download: (input) => this.#download(owner, conversationId, input),
      armDownload: (tabId, absolutePath, deadlineMs) =>
        this.#arm(owner, conversationId, tabId, absolutePath, deadlineMs),
      disarmDownload: (tabId) => this.#disarm(owner, conversationId, tabId),
      release: () => this.#release(owner),
    }
  }

  /**
   * 存活页清单：本会话自己的页 + 用户手动开的页。别的会话的页不列出来，也不给它 tabId。
   *
   * `controlled` = 这一页归本会话（可以直接操作）。用户页 `controlled:false`，
   * 要用户在聊天里点名后 `bind` 才归本会话。
   */
  async #tabs(conversationId: string): Promise<BrowserTabInfo[]> {
    return this.#bridge
      .tabs()
      .filter((tab) => tab.conversationId === conversationId || tab.conversationId === null)
      .map((tab) => ({
        tabId: tab.tabId,
        url: tab.url,
        title: tab.title,
        controlled: tab.conversationId === conversationId,
      }))
  }

  /**
   * 释放这次执行。
   *
   * 释放之后这个端口**永久出局**（`#retired`），但**归属留在宿主上**：会话的页仍归它，
   * 下一条消息用新端口接着操作。断当前 CDP 连接、清本 Run 的页会话，不清宿主归属。
   */
  async #release(owner: number): Promise<void> {
    this.#retired.add(owner)
    const control = this.#control
    if (!control || control.owner !== owner) return
    this.#control = null
    if (control.client) {
      await control.client.cancel('执行结束')
      control.client.close()
    }
  }

  stop(): void {
    this.#offHostChange()
    this.#offClosed()
    this.#dropControl()
  }

  #acquire(owner: number, conversationId: string): Control {
    if (this.#retired.has(owner)) {
      throw new BrowserReleasedError('本次执行的浏览器控制已经结束')
    }
    const existing = this.#control
    if (existing) {
      if (existing.owner !== owner) {
        throw new BrowserBusyError('浏览器已被另一个任务控制')
      }
      return existing
    }
    if (!this.available()) {
      throw new BrowserBridgeError('浏览器宿主不可用')
    }
    const control: Control = {
      owner,
      conversationId,
      client: null,
      sessions: new Map(),
      observations: new Map(),
    }
    this.#control = control
    return control
  }

  #dropControl(): void {
    const control = this.#control
    this.#control = null
    control?.client?.close()
  }

  /** 从当前控制槽摘掉一页的会话与观察。宿主关页事件与本地 close 都走它。 */
  #forget(tabId: string): void {
    const control = this.#control
    if (!control) return
    const sessionId = control.sessions.get(tabId)
    control.sessions.delete(tabId)
    if (sessionId) control.client?.forgetSession(sessionId)
    for (const [id, record] of [...control.observations]) {
      if (record.tabId === tabId) control.observations.delete(id)
    }
  }

  async #open(owner: number, conversationId: string, url: string): Promise<BrowserTabInfo> {
    const control = this.#acquire(owner, conversationId)
    const data = await this.#bridge.request('create', { url, conversationId })
    const tabId = data?.tabId
    const marker = data?.marker
    if (!tabId || !marker) throw new BrowserBridgeError('宿主没有给出 tabId 与标记')
    try {
      await this.#attach(control, tabId, marker)
    } catch (err) {
      // 附不上就把刚建出来的这一页收掉：它是本次调用的产物，留着等于一个谁也管不到的页。
      await this.#bridge.request('close', { tabId }).catch(() => {})
      throw err
    }
    return { tabId, url: data?.url ?? url, title: data?.title ?? '', controlled: true }
  }

  /**
   * 接管一页到本会话。
   *
   * 归属判定在宿主：用户页 → 归本会话；已归本会话 → 幂等；已归另一条会话 → 拒绝。
   * 拿到 marker 之后附上 CDP 会话。`bind` 只在「用户点名了自己开的页」时用；本会话
   * 自己开的页由后续操作自动附页，不需要显式 bind。
   */
  async #bind(owner: number, conversationId: string, tabId: string): Promise<BrowserTabInfo> {
    const control = this.#acquire(owner, conversationId)
    const data = await this.#bridge.request('bind', { tabId, conversationId })
    const marker = data?.marker
    if (!marker) throw new BrowserBridgeError('宿主没有给出标记')
    await this.#attach(control, tabId, marker)
    return { tabId, url: data?.url ?? '', title: data?.title ?? '', controlled: true }
  }

  /**
   * 取这一页的 CDP 句柄。占控制槽、核归属、自动附页三步都在这里。
   *
   * **归属跨消息稳定**：本会话上一条消息建的页仍归它，这一步按宿主快照核对归属后
   * 自动附上 CDP 会话——所以下一条消息直接 observe/act 就能用，不需要交接。
   */
  async #pageOf(
    owner: number,
    conversationId: string,
    tabId: string,
  ): Promise<{ control: Control; page: PageHandle }> {
    const control = this.#acquire(owner, conversationId)
    if (!control.sessions.has(tabId)) {
      const snap = this.#bridge.tab(tabId)
      if (!snap) throw new BrowserBridgeError(`认不出的标签页 ${tabId}`)
      if (snap.conversationId !== conversationId) {
        throw new BrowserNotOwnedError(`标签页 ${tabId} 不归本会话`)
      }
      await this.#attach(control, tabId, snap.marker)
    }
    const client = control.client
    const sessionId = control.sessions.get(tabId)
    if (!client || !sessionId) throw new BrowserBridgeError(`标签页 ${tabId} 没有可用的会话`)
    return { control, page: { client, sessionId, tabId } }
  }

  #recordOf(control: Control, tabId: string, observationId: string): ObservationRecord {
    const record = control.observations.get(observationId)
    if (!record || record.tabId !== tabId) {
      throw new BrowserBridgeError(`观察 ${observationId} 已经失效，请重新观察`)
    }
    return record
  }

  async #navigate(
    owner: number,
    conversationId: string,
    input: { tabId: string; action: 'goto' | 'back' | 'forward' | 'reload'; url?: string },
  ): Promise<BrowserTabInfo> {
    const { control, page } = await this.#pageOf(owner, conversationId, input.tabId)
    // 换文档即换观察：旧编号指向的节点已经不存在，留着只会让下一次动作打在别处。
    control.observations.clear()
    const { client, sessionId } = page
    if (input.action === 'goto') {
      await client.send('Page.navigate', { url: input.url ?? '' }, { sessionId, timeoutMs: 30_000 })
    } else if (input.action === 'reload') {
      await client.send('Page.reload', {}, { sessionId, timeoutMs: 30_000 })
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
    const head = await client.send<{ result: { value: { url: string; title: string } } }>(
      'Runtime.evaluate',
      { expression: '({ url: location.href, title: document.title })', returnByValue: true },
      { sessionId, timeoutMs: 30_000 },
    )
    return {
      tabId: input.tabId,
      url: head.result.value.url,
      title: head.result.value.title,
      controlled: true,
    }
  }

  async #observe(
    owner: number,
    conversationId: string,
    input: { tabId: string; frame?: string; screenshot?: boolean; offset?: number },
  ): Promise<BrowserObservation> {
    const { control, page } = await this.#pageOf(owner, conversationId, input.tabId)
    const { observation, record } = await observePage(page, {
      ...(input.frame !== undefined ? { frame: input.frame } : {}),
      ...(input.screenshot !== undefined ? { screenshot: input.screenshot } : {}),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
    })
    control.observations.set(record.observationId, record)
    // 只留最近几份。旧编号本来就要求重新观察，留着它们只是让内存跟着轮数长。
    while (control.observations.size > MAX_OBSERVATIONS) {
      const oldest = control.observations.keys().next().value
      if (oldest === undefined) break
      control.observations.delete(oldest)
    }
    return observation
  }

  async #act(
    owner: number,
    conversationId: string,
    input: BrowserActInput,
  ): Promise<BrowserActResult> {
    const { control, page } = await this.#pageOf(owner, conversationId, input.tabId)
    return actOnPage(page, this.#recordOf(control, input.tabId, input.observationId), input)
  }

  async #wait(
    owner: number,
    conversationId: string,
    input: { tabId: string; selector: string; timeoutMs: number },
  ): Promise<BrowserWaitResult> {
    const { page } = await this.#pageOf(owner, conversationId, input.tabId)
    return waitOnPage(page, input.selector, input.timeoutMs)
  }

  async #upload(
    owner: number,
    conversationId: string,
    input: { tabId: string; observationId: string; ref: string; paths: string[] },
  ): Promise<{ files: string[] }> {
    const { control, page } = await this.#pageOf(owner, conversationId, input.tabId)
    return uploadToPage(
      page,
      this.#recordOf(control, input.tabId, input.observationId),
      input.ref,
      input.paths,
    )
  }

  /**
   * 一次下载：先登记授权，再用 Input 事件点元素触发，然后等宿主给终态。
   *
   * 顺序不能反。授权是按这个绝对路径登记的一次性凭据，先触发再授权的话钩子拿不到
   * 授权，这次下载直接被取消。等到 `download.finished` 之后还要核对磁盘——
   * 事件只说明宿主写完了，文件在不在、多大要自己看。
   */
  async #download(
    owner: number,
    conversationId: string,
    input: {
      tabId: string
      observationId: string
      ref: string
      absolutePath: string
      timeoutMs: number
    },
  ): Promise<BrowserDownloadResult> {
    const { control, page } = await this.#pageOf(owner, conversationId, input.tabId)
    const record = this.#recordOf(control, input.tabId, input.observationId)

    let settle: ((frame: BrowserEventFrame) => void) | null = null
    const outcome = new Promise<BrowserEventFrame>((resolve) => {
      settle = resolve
    })
    const off = this.#bridge.onEvent((frame) => {
      if (frame.tabId !== input.tabId) return
      if (frame.kind === 'download.finished' || frame.kind === 'download.blocked') settle?.(frame)
    })

    try {
      await this.#arm(owner, conversationId, input.tabId, input.absolutePath, input.timeoutMs)
      await clickForDownload(page, record, input.ref)
      const frame = await Promise.race([
        outcome,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), input.timeoutMs)),
      ])
      if (!frame) {
        await this.#disarm(owner, conversationId, input.tabId).catch(() => {})
        throw new BrowserBridgeError('下载没有在期限内给出结果，授权已撤销')
      }
      if (frame.kind === 'download.blocked') {
        return {
          ...(frame.reason ? { blocked: frame.reason } : { blocked: 'blocked' }),
          ...(frame.suggestedName ? { suggestedName: frame.suggestedName } : {}),
        }
      }
      if (frame.success === false) return { blocked: 'failed' }
      const path = frame.path ?? input.absolutePath
      const info = await stat(path).catch(() => null)
      if (!info) throw new BrowserBridgeError(`宿主报下载完成，但 ${path} 不在磁盘上`)
      return { path, bytes: info.size }
    } finally {
      off()
    }
  }

  /**
   * 建立这一页的 CDP 会话。
   *
   * 页会话初始化被拒（焦点仿真不可用）时撤销整个控制：带着一个焦点判定不成立的
   * 会话继续操作，输入会落在看不见的地方。
   */
  async #attach(control: Control, tabId: string, marker: string): Promise<void> {
    if (control.sessions.has(tabId)) return
    const host = this.#bridge.host()
    if (!host) throw new BrowserBridgeError('浏览器宿主未连接')
    if (!control.client) control.client = await CdpClient.connect(host.debugPort)
    try {
      const { sessionId } = await control.client.attachByMarker(marker)
      control.sessions.set(tabId, sessionId)
    } catch (err) {
      if (err instanceof CdpInitError) await this.#release(control.owner)
      throw err
    }
  }

  async #close(owner: number, conversationId: string, tabId: string): Promise<void> {
    // 归属核对走 pageOf；核过之后再关。
    await this.#pageOf(owner, conversationId, tabId)
    await this.#bridge.request('close', { tabId })
    this.#forget(tabId)
  }

  async #arm(
    owner: number,
    conversationId: string,
    tabId: string,
    absolutePath: string,
    deadlineMs: number,
  ): Promise<void> {
    await this.#pageOf(owner, conversationId, tabId)
    await this.#bridge.request(
      'download.arm',
      { tabId, path: absolutePath, conversationId },
      deadlineMs,
    )
  }

  async #disarm(owner: number, conversationId: string, tabId: string): Promise<boolean> {
    await this.#pageOf(owner, conversationId, tabId)
    const data = await this.#bridge.request('download.disarm', { tabId })
    return data?.removed === true
  }
}
