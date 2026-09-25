/**
 * 电脑控制协调器：应用进程级对象，由 `serve` 装配。
 *
 * 它只执行已经绑定身份的操作——不规划任务，不存第二份「任务进行到哪」。
 *
 * 五条边界：
 *
 * 1. **OS 句柄不出这一层。** 模型拿到的是 `dw_N` 这样的不透明 id；句柄、pid 与进程
 *    启动时刻记在这里，发请求时才拼成目标身份交给宿主。
 * 2. **观察按窗口留一份。** 同一个窗口再观察一次，上一份编号即作废；宿主换代际
 *    （重连、换 worker）时全部作废。动作只认还在表里的编号。每份观察只含同一次读取
 *    的节点，动作与等待之后按它的读取范围整份重读，不与别的读取拼接。
 * 3. **占用是执行者级的，权威只有这里一处。** 物理桌面只有一个，同一时刻只有一个
 *    执行者能在窗口上观察与动作；同时要桌面的其余执行者排队等它释放。宿主那侧不记
 *    谁在占用，它只按请求自己带的身份派发。
 * 4. **释放中仍占用。** 顺序固定：禁新派发 → 撤掉排队中的自己 → 结清在途调用 →
 *    让宿主撤销尚未派发的请求。宿主确认这个执行者名下已无在执行的请求之后，才让
 *    下一个进来；确认不了就整条挡住，等宿主换代际。
 * 5. **「正在操作哪个应用」跟随占用。** 只有持有桌面的那个执行者写得动它；它释放、
 *    宿主断开或换代际都要清回 `null`。
 * 6. **控件编号在这里发放，也只在这里翻译。** 宿主的 ref 带下标路径与身份段，只用于
 *    宿主重新定位控件；端口交出去的是按控件身份分配的短编号 `e<n>`。进宿主的每一处按
 *    本次观察的对应表翻回完整 ref，宿主回包里的 ref 在 `#absorb` 换成短编号。工具层
 *    不翻译、不另存对应关系。
 */

import type {
  DesktopActResult,
  DesktopBlockingWindowInfo,
  DesktopElement,
  DesktopFollowUp,
  DesktopImage,
  DesktopImagePoint,
  DesktopPort,
  DesktopRefusal,
  DesktopSnapshot,
  DesktopText,
  DesktopWaitCondition,
  DesktopWaitResult,
  DesktopWindowInfo,
} from '@qywork/agent'
import type {
  DesktopAction,
  DesktopBlockingWindow,
  DesktopDispatch,
  DesktopImageGeometry,
  DesktopNode,
  DesktopObservation,
  DesktopRect,
  DesktopTarget,
  DesktopTargetEvent,
  DesktopTreeBody,
  DesktopWindow,
} from '@qywork/core'
import { imagePointToScreen, imageRectToScreen, log } from '@qywork/core'
import {
  type DesktopBridge,
  DesktopBridgeError,
  type DesktopCallResult,
  type NativeDesktopHost,
} from './bridge.ts'

/** 读树的默认上限。请求里没给时用它，给了也不超过工具那侧声明的上限。 */
const DEFAULT_MAX_NODES = 1500
const DEFAULT_MAX_DEPTH = 20
/** 读树的时间预算。UIA 这类跨进程接口没有请求级硬上界，只能给采集端一个预算。 */
const READ_TREE_BUDGET_MS = 4_000
/** 等待时两次判定之间至少隔多久。判定在宿主那一侧做，这个数只是它的轮询下界。 */
const WAIT_POLL_MS = 250
/**
 * 等待请求的期限比调用方要的时长多出来的那一段。
 *
 * 宿主到点之后还要按读取范围重读一次才回执，这一段要盖得住那次读取；给短了的话，本地的
 * 超时会先到，一次正常到期的等待会被记成宿主不可用。
 */
const WAIT_SLACK_MS = READ_TREE_BUDGET_MS + 2_000
/**
 * 撤销请求的期限。
 *
 * 它的回执说的是「这个执行者名下还有没有可能正在执行的请求」，所以要给宿主留出足够
 * 时间等手上那一次调用收完：读树的预算是 `READ_TREE_BUDGET_MS`，再加一次 UIA 连接
 * 超时的余量。给得太短的话，每次在读树中途停止都会让桌面挡到宿主换代际为止。
 */
const CANCEL_DEADLINE_MS = READ_TREE_BUDGET_MS + 4_000
/**
 * 一次采集等一帧的上限。
 *
 * WGC 的帧由合成器推过来，实测一两个合成周期就到；退路的 `PrintWindow` 是同步调用。
 * 给到 3 秒是留给挂起的应用，到期即如实回失败。
 */
const CAPTURE_BUDGET_MS = 3_000
/**
 * 一张图编码之后的字节上限。
 *
 * 宿主连接的单帧上限是 8 MiB，base64 把字节数放大到 4/3，因此 4 MiB 的 PNG 在连接上
 * 约占 5.4 MiB。超过这个数的请求在采集端就被拒，不让一帧把宿主连接打断。
 */
const CAPTURE_MAX_BYTES = 4 * 1024 * 1024
/**
 * 走前台投递的动作。
 *
 * 只用来判「这一次算不算前台接管」，让运行态读数说得出此刻在前台操作，
 * 而且只在宿主真的派发了之后才上调。**准入不在这里判**：前台模式有没有开由宿主
 * 那一侧按请求自带的开关裁决，在这里再判一遍就是第二处裁决。
 */
const FOREGROUND_ACTIONS: ReadonlySet<string> = new Set([
  'click',
  'hover',
  'drag',
  'wheel',
  'type_text',
  'press_key',
  'activate',
  'set_window_state',
  'move_window',
  'resize_window',
  'close_window',
])
/** 接受图像点落点的那几种。其余动作只能按控件执行。 */
const FOREGROUND_POINTER: ReadonlySet<string> = new Set(['click', 'hover', 'drag', 'wheel'])
/**
 * 可以不给目标、直接投给窗口的那几种。
 *
 * 键盘输入去的是系统焦点所在，不是某个被点名的控件。准入判定在 worker 那一侧
 * （前台窗口就是目标窗口且窗口未被禁用），这里只是不拦。
 */
const WINDOW_TARGET: ReadonlySet<string> = new Set(['type_text', 'press_key'])
/**
 * 一个窗口的编号表最多记多少个控件身份，超过即淘汰最久没出现的那个。
 *
 * 要高于单次读取的节点数（工具侧上限 4000）：同一份观察里的控件在表里互相挤掉的话，
 * 下一份观察里它们会拿到新号。
 */
export const MAX_WINDOW_REFS = 8192
/** 宿主在 `filteredBy` 里记读取范围的那一项的前缀，其后是宿主的完整 ref。 */
const ROOT_FILTER = 'root='

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

/**
 * 宿主 ref 里的控件身份，编号表的键。
 *
 * 有 RuntimeId 时取 `#` 之后的身份段：控件挪了位置、下标路径变了，它仍是同一个键。
 * 身份段以 `~` 开头（属性指纹）或为空时取整条 ref：指纹对同角色同名的兄弟控件不唯一，
 * 单独作键会把两个控件编成同一个号。
 */
function identityOfRef(hostRef: string): string {
  const at = hostRef.indexOf('#')
  const segment = at < 0 ? '' : hostRef.slice(at + 1)
  return segment === '' || segment.startsWith('~') ? hostRef : segment
}

/**
 * 一个窗口的控件编号表：控件身份 → `e<n>`。
 *
 * 编号只增不减，淘汰掉的身份再出现时拿新号。RuntimeId 可能被另一个控件复用，表因此按窗口
 * 隔离、有上限；同一个号不会发给两个身份。`Map` 的插入顺序就是最近出现的先后。
 */
class WindowRefs {
  #ids = new Map<string, string>()
  #last = 0

  /** 这个宿主 ref 在本窗口的编号。见过的身份沿用原号，并记为最近出现。 */
  of(hostRef: string): string {
    const key = identityOfRef(hostRef)
    const known = this.#ids.get(key)
    if (known !== undefined) {
      this.#ids.delete(key)
      this.#ids.set(key, known)
      return known
    }
    this.#last += 1
    const id = `e${this.#last}`
    this.#ids.set(key, id)
    if (this.#ids.size > MAX_WINDOW_REFS) {
      const oldest = this.#ids.keys().next().value
      if (oldest !== undefined) this.#ids.delete(oldest)
    }
    return id
  }
}

/** 一个已发现窗口的完整身份。`windowId` 之外的三项都不交给模型。 */
interface KnownWindow {
  windowId: string
  handle: number
  pid: number
  processStartedAt: number
  app: string
  title: string
  /** 这个窗口的控件编号表。窗口身份一变即换一个 `windowId`，表随之重开。 */
  refs: WindowRefs
}

/** 一次观察的记录。动作前的唯一匹配与前置条件按它判。 */
interface ObservationRecord {
  observationId: string
  windowId: string
  /** 采集这一份时的宿主代际。代际一变这份记录即作废。 */
  epochKey: string
  /**
   * 读取范围的根：`ref` 是交给端口的短编号，`host` 是宿主的完整 ref。缺席表示整窗。
   * 动作与等待之后按 `host` 重读。
   */
  scope?: { ref: string; host: string }
  /** 端口形状：`ref` 与 `parentRef` 是本窗口的短编号。 */
  elements: DesktopElement[]
  /** 本次观察里短编号 → 宿主的完整 ref。发往宿主的控件引用一律按它翻译。 */
  hostRefs: Map<string, string>
  truncatedBy: string[]
  filteredBy: string[]
  visited: number
  capturedAt: number
  windowEnabled: boolean
  windowCovered: boolean
}

/**
 * 一张已经交给模型的图。`imageRef` 指的就是这一条。
 *
 * 绑定四项：目标窗口身份（`windowId` 加它的身份键）、宿主三条代际（`epochKey`）、
 * 几何（含窗口矩形代际）与采集时刻。任一项对不上，按这个 ref 定位的请求都不该派发。
 */
interface ImageRecord {
  imageRef: string
  windowId: string
  /** 采集时那个窗口的身份键。窗口关掉重开之后它就变了。 */
  identityKey: string
  epochKey: string
  geometry: DesktopImageGeometry
  capturedAt: number
}

/** 一次执行持有的身份。`released` 置上之后这个端口永不再取得能力。 */
interface Lease {
  owner: number
  executorId: string
  conversationId: string
  released: boolean
  /** 本执行者的观察记录，按 `windowId` 各留最近一份。 */
  observations: Map<string, ObservationRecord>
  /** 本执行者交出去的图，按 `imageRef` 索引。 */
  images: Map<string, ImageRecord>
}

/** 排在桌面占用后面的执行者。撤销时按 `lease` 认领自己那一条。 */
interface Waiter {
  lease: Lease
  resolve: () => void
  reject: (err: Error) => void
}

/** 宿主代际键。三项任一变化即旧观察与旧引用整体作废。 */
function epochKeyOf(host: NativeDesktopHost): string {
  return `${host.hostId}#${host.hostEpoch}#${host.connectionEpoch}`
}

/** 窗口身份键。句柄与 pid 都会被复用，三项一起才认得出还是不是同一个窗口。 */
function identityKey(w: { handle: number; pid: number; processStartedAt: number }): string {
  return `${w.handle}:${w.pid}:${w.processStartedAt}`
}

/**
 * 一个控件的端口形状。`ref` 与 `parentRef` 按 `refOf` 换成短编号，`parentRef` 指同一张表
 * 里的父控件。
 */
function elementOf(node: DesktopNode, refOf: (hostRef: string) => string): DesktopElement {
  return {
    ref: refOf(node.ref),
    ...(node.parentRef !== undefined ? { parentRef: refOf(node.parentRef) } : {}),
    depth: node.depth,
    role: node.role,
    name: node.name,
    automationId: node.automationId,
    ...(node.value !== undefined ? { value: node.value } : {}),
    enabled: node.enabled,
    offscreen: node.offscreen,
    ...(node.focused === true ? { focused: true } : {}),
    ...(node.rect !== undefined ? { rect: { ...node.rect } } : {}),
    actions: node.actions.map((a) => ({
      action: a.action,
      delivery: [...a.delivery],
      ...(a.unavailable !== undefined ? { unavailable: a.unavailable } : {}),
    })),
    ...(node.range !== undefined ? { range: { ...node.range } } : {}),
    ...(node.toggle !== undefined ? { toggle: node.toggle } : {}),
    ...(node.expand !== undefined ? { expand: node.expand } : {}),
    ...(node.selected !== undefined ? { selected: node.selected } : {}),
    ...(node.selection !== undefined
      ? {
          selection: {
            multiple: node.selection.multiple,
            required: node.selection.required,
            ...(node.selection.selected !== undefined
              ? { selected: [...node.selection.selected] }
              : {}),
            ...(node.selection.truncated === true ? { truncated: true } : {}),
          },
        }
      : {}),
    ...(node.scroll !== undefined ? { scroll: { ...node.scroll } } : {}),
    ...(node.text === true ? { text: true } : {}),
    ...(node.weakIdentity === true ? { weakIdentity: true } : {}),
  }
}

export class DesktopCoordinator {
  #bridge: DesktopBridge
  #enabled: () => boolean
  #nextOwner = 0
  #nextObservation = 0
  #nextAction = 0
  #nextWindow = 0
  #nextImage = 0
  /** 已发现的窗口，按不透明 id 索引。 */
  #windows = new Map<string, KnownWindow>()
  /** 身份键 → 不透明 id。同一个窗口再次被发现时沿用同一个 id。 */
  #byIdentity = new Map<string, string>()
  #leases = new Map<number, Lease>()
  /** 此刻持有桌面的执行者。`null` = 没人在占。 */
  #holder: Lease | null = null
  /** 等着进场的执行者，先到先得。 */
  #queue: Waiter[] = []
  /**
   * 挡住整个桌面的原因。`null` = 没挡。
   *
   * 上一个执行者释放时宿主说不出它名下的请求有没有执行完，这时不能放下一个进来：
   * 两个执行者会同时在动同一个桌面。挡到宿主换代际为止——那时旧执行实例名下的一切
   * 本来就已经作废。
   */
  #blocked: string | null = null
  /** 只有 `#holder` 写得动的目标快照，会话归属与应用、前台状态一起发布和清空。 */
  #target: DesktopTargetEvent['target'] = null
  #targetChanges = new Set<(target: DesktopTargetEvent['target']) => void>()
  #offHostChange: () => void

  constructor(bridge: DesktopBridge, enabled: () => boolean) {
    this.#bridge = bridge
    this.#enabled = enabled
    // 宿主断开或换代际：已发现的窗口与正在操作的读数都不再成立，挡住桌面的那条理由
    // 也随之失效——它说的是一个已经不存在的执行实例。
    this.#offHostChange = bridge.onHostChange(() => {
      this.#windows.clear()
      this.#byIdentity.clear()
      this.#clearTarget()
      if (this.#blocked === null) return
      log.info('desktop', `桌面占用解除挂起：${this.#blocked}`)
      this.#blocked = null
      this.#handOver()
    })
  }

  /**
   * 电脑控制能力是否可用。
   *
   * 四项缺一不可：用户启用了、宿主连上了、worker 就绪了、系统授权了。
   * 装配方按它决定要不要注入端口——不是先给一个端口、调用时再报错。
   */
  available(): boolean {
    const host = this.#bridge.host()
    return this.#enabled() && host !== null && host.workerReady && host.authorized
  }

  /** 此刻哪条会话在操作哪个应用。握手与实时事件都取这一份。 */
  target(): DesktopTargetEvent['target'] {
    return this.#target
  }

  onTargetChange(listener: (target: DesktopTargetEvent['target']) => void): () => void {
    this.#targetChanges.add(listener)
    return () => this.#targetChanges.delete(listener)
  }

  /**
   * 给一次执行造一个端口。
   *
   * `executorId` 每次不同：占用、排队与撤销按它记，两条会话、父任务与子任务因此
   * 各占各的、各撤各的。`conversationId` 用于日志和目标读数的归属；桌面仍按执行者
   * 串行占用，不因界面切换会话而改变。
   *
   * 端口自己不占桌面，第一次在窗口上观察或动作才占。
   */
  portFor(conversationId: string): DesktopPort {
    this.#nextOwner += 1
    const lease: Lease = {
      owner: this.#nextOwner,
      executorId: `dx_${this.#nextOwner}`,
      conversationId,
      released: false,
      observations: new Map(),
      images: new Map(),
    }
    this.#leases.set(lease.owner, lease)
    return {
      windows: () => this.#windowList(lease),
      observe: (input) => this.#observe(lease, input),
      elements: (windowId, observationId) => this.#elements(lease, windowId, observationId),
      captureImage: (input) => this.#captureImage(lease, input),
      act: (input) => this.#act(lease, input),
      readText: (input) => this.#readText(lease, input),
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
    if (lease.released) throw new DesktopUnavailableError('本次执行的电脑控制已经结束')
    if (!this.available()) throw new DesktopUnavailableError('电脑控制此刻不可用')
    const host = this.#bridge.host()
    if (!host) throw new DesktopUnavailableError('桌面宿主未连接')
    return host
  }

  /**
   * 取得桌面占用。已经持有时是空操作，别人持有时排队等它释放。
   *
   * 窗口发现不走这里：它不绑定任何窗口，也不改变任何状态，而执行者要先看得见窗口
   * 才谈得上要不要这个桌面。绑定窗口的观察、动作与等待都要先过这一关——`ref` 是在
   * 观察里产生、在动作里消费的，两者之间插进另一个执行者的动作，`ref` 就不再成立。
   */
  #acquire(lease: Lease): Promise<void> {
    if (lease.released) {
      return Promise.reject(new DesktopUnavailableError('本次执行的电脑控制已经结束'))
    }
    if (this.#holder === lease) return Promise.resolve()
    if (this.#blocked !== null) {
      return Promise.reject(new DesktopUnavailableError(this.#blocked))
    }
    if (this.#holder === null) {
      this.#holder = lease
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ lease, resolve, reject })
    })
  }

  /** 把桌面交给下一个排队的。调用前占用必须已经空出来。 */
  #handOver(): void {
    this.#holder = null
    if (this.#blocked !== null) return
    for (;;) {
      const next = this.#queue.shift()
      if (!next) return
      if (next.lease.released) continue
      this.#holder = next.lease
      next.resolve()
      return
    }
  }

  /** 排队中撤销：还没轮到它就直接拿掉，不占着后面那些的位置。 */
  #dropWaiter(lease: Lease, reason: string): void {
    const at = this.#queue.findIndex((w) => w.lease === lease)
    if (at < 0) return
    const [waiter] = this.#queue.splice(at, 1)
    waiter?.reject(new DesktopUnavailableError(reason))
  }

  /**
   * 挡住整个桌面，排队的一并拒掉。
   *
   * 不让它们继续等：等的是一个说不出何时结束的状态，而工具调用挂在那里说不出原因。
   * 拒掉之后模型拿到的是一句明确的失败，重新观察即可。
   */
  #block(reason: string): void {
    this.#blocked = reason
    this.#holder = null
    for (const waiter of this.#queue.splice(0)) {
      waiter.reject(new DesktopUnavailableError(reason))
    }
  }

  async #windowList(lease: Lease): Promise<DesktopWindowInfo[]> {
    this.#liveHost(lease)
    const result = await this.#bridge.request('list_windows', { executorId: lease.executorId })
    const observation = expect(result, 'windows')
    const out = this.#register(observation.windows)
    // 这一次没再出现的窗口就地作废：句柄会被 OS 复用，留着旧 id 等于给一个可能
    // 指向另一个窗口的目标。**只有整机清单能这样剪**——动作回执带回的是单个进程的窗口，
    // 拿它剪会把别的进程的窗口一并作废。
    const seen = new Set(observation.windows.map(identityKey))
    for (const [key, id] of [...this.#byIdentity]) {
      if (seen.has(key)) continue
      this.#byIdentity.delete(key)
      this.#windows.delete(id)
    }
    return out
  }

  /**
   * 把一批窗口登记成不透明 id。**这是 id 的唯一产生处**：同一个窗口在窗口清单里与在
   * 动作回执里拿到的是同一个 id，模型因此不必分辨它是从哪一条路径来的。
   */
  #register(windows: DesktopWindow[]): DesktopWindowInfo[] {
    const out: DesktopWindowInfo[] = []
    for (const w of windows) {
      const key = identityKey(w)
      let windowId = this.#byIdentity.get(key)
      if (windowId === undefined) {
        this.#nextWindow += 1
        windowId = `dw_${this.#nextWindow}`
        this.#byIdentity.set(key, windowId)
      }
      // 编号表跟着窗口身份走，再次发现同一个窗口时沿用：换一张新表会让同一个控件换号。
      const refs = this.#windows.get(windowId)?.refs ?? new WindowRefs()
      this.#windows.set(windowId, { windowId, ...w, refs })
      out.push({ windowId, app: w.app, title: w.title })
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
    input: {
      windowId: string
      maxNodes?: number
      maxDepth?: number
      root?: string
      includeValue?: boolean
      includeState?: boolean
    },
  ): Promise<DesktopSnapshot> {
    this.#liveHost(lease)
    await this.#acquire(lease)
    // 排队可能等了很久：进场之后重新确认宿主还在、重新解析目标，并取当次的代际。
    // 等待期间宿主换过代际的话，这个不透明 id 已经不在窗口表里，要的是那一句拒绝。
    this.#liveHost(lease)
    const known = this.#targetOf(input.windowId)
    // 子树根必须来自本执行者对这个窗口的上一份观察：现编一个编号等于让宿主去定位一个
    // 没人见过的位置。
    const root =
      input.root === undefined ? undefined : this.#requireRef(lease, input.windowId, input.root)
    // 目标在**发请求之前**就登记：读树可能挂在 provider 上直到超时，等回包之后再登记的话，
    // 界面在这段时间里说不出正在操作谁。
    this.#setTarget(lease, known.app)
    const result = await this.#bridge.request('read_tree', {
      executorId: lease.executorId,
      target: this.#frameTarget(known),
      maxNodes: input.maxNodes ?? DEFAULT_MAX_NODES,
      maxDepth: input.maxDepth ?? DEFAULT_MAX_DEPTH,
      timeBudgetMs: READ_TREE_BUDGET_MS,
      ...(root !== undefined ? { root } : {}),
      ...(input.includeValue !== undefined ? { includeValue: input.includeValue } : {}),
      ...(input.includeState !== undefined ? { includeState: input.includeState } : {}),
    })
    return this.#absorb(lease, input.windowId, expect(result, 'tree'))
  }

  /**
   * 用一份读取结果整份替换本执行者对这个窗口的观察，并换一个新编号。
   *
   * 不要把它改回与上一份拼接：拼进来的旧节点带着新编号、新时刻与这次读取的完整性，
   * 而它们的状态与可用动作停在上一次读取那一刻。换编号是硬性的：旧编号对应的那张表
   * 已经不是这一张，留着它等于让模型在两份表之间挑。
   *
   * 整窗读的第一项是窗口元素本身：标上 `windowRoot`，它的名称就是此刻的窗口标题，一并刷新
   * 窗口表里的那一格——窗口表只在发现窗口时写入，页面换过之后仍是旧标题。
   *
   * 宿主回包里带 ref 的三处在这里换成短编号：控件的 `ref` / `parentRef`、`scope`，以及
   * `filteredBy` 里的 `root=` 那一项。
   */
  #absorb(lease: Lease, windowId: string, body: DesktopTreeBody): DesktopSnapshot {
    const host = this.#liveHost(lease)
    const known = this.#targetOf(windowId)
    const hostRefs = new Map<string, string>()
    const refOf = (hostRef: string): string => known.refs.of(hostRef)
    const elements = body.nodes.map((node) => {
      const element = elementOf(node, refOf)
      hostRefs.set(element.ref, node.ref)
      return element
    })
    const root = elements[0]
    if (body.scope === undefined && root !== undefined) {
      root.windowRoot = true
      if (root.name !== '') known.title = root.name
    }
    this.#nextObservation += 1
    const record: ObservationRecord = {
      observationId: `do_${this.#nextObservation}`,
      windowId,
      epochKey: epochKeyOf(host),
      ...(body.scope !== undefined ? { scope: { ref: refOf(body.scope), host: body.scope } } : {}),
      elements,
      hostRefs,
      truncatedBy: [...body.completeness.truncatedBy],
      filteredBy: body.completeness.filteredBy.map((f) =>
        f.startsWith(ROOT_FILTER) ? `${ROOT_FILTER}${refOf(f.slice(ROOT_FILTER.length))}` : f,
      ),
      visited: body.completeness.visited,
      capturedAt: body.capturedAt,
      windowEnabled: body.windowEnabled,
      windowCovered: body.windowCovered,
    }
    lease.observations.set(windowId, record)
    return snapshotOf(record, known)
  }

  /**
   * 取回一次观察记录。代际变了、窗口对不上、编号换过，三种都回 `null`。
   *
   * worker 没了也回 `null`，且这一条不能等代际变：产生这份观察的执行实例已经不在了，
   * 而宿主要到下一个 worker 握手成功才会报出新的 `hostEpoch`。那段时间里代际还是旧值，
   * 只按它判的话，模型会拿一份已经作废的引用去发动作。
   */
  #elements(lease: Lease, windowId: string, observationId: string): DesktopElement[] | null {
    if (lease.released) return null
    const host = this.#bridge.host()
    if (!host || !host.workerReady) return null
    const record = lease.observations.get(windowId)
    if (!record || record.observationId !== observationId) return null
    if (record.epochKey !== epochKeyOf(host)) return null
    return record.elements
  }

  /** 这个短编号在指定那份观察里对应的宿主 ref。观察失效或编号不在其中即在本地拒绝。 */
  #recordOf(lease: Lease, windowId: string, observationId: string, ref: string): string {
    if (!this.#elements(lease, windowId, observationId)) {
      throw new DesktopTargetError(`观察 ${observationId} 已经失效，请重新观察`)
    }
    const hostRef = lease.observations.get(windowId)?.hostRefs.get(ref)
    if (hostRef === undefined) {
      throw new DesktopTargetError(`观察 ${observationId} 里没有控件 ${ref}`)
    }
    return hostRef
  }

  /**
   * 采一张目标窗口的图。
   *
   * 三种取景：整窗、窗口内的屏幕矩形、上一张图里的一块。第三种是 `imageRef` 的消费端，
   * 走的就是后续按图定位的动作要走的那条换算与核对路径——
   * **这里换算成屏幕矩形并带上窗口几何代际，宿主在派发前重新核对窗口矩形**。
   *
   * 失效的 `imageRef` 在本地就拒绝，一帧都不发：换算要用采集那一刻的几何，而那份几何
   * 已经不成立了。
   */
  async #captureImage(
    lease: Lease,
    input: {
      windowId: string
      maxEdge: number
      region?: DesktopRect
      imageRef?: string
      imageRect?: DesktopRect
    },
  ): Promise<DesktopImage> {
    this.#liveHost(lease)
    await this.#acquire(lease)
    const host = this.#liveHost(lease)
    const known = this.#targetOf(input.windowId)
    const framed = this.#regionOf(lease, known, input)
    this.#setTarget(lease, known.app)
    const result = await this.#bridge.request(
      'capture_image',
      {
        executorId: lease.executorId,
        target: this.#frameTarget(known),
        maxEdge: input.maxEdge,
        maxBytes: CAPTURE_MAX_BYTES,
        timeBudgetMs: CAPTURE_BUDGET_MS,
        ...(framed.region !== undefined ? { region: framed.region } : {}),
        ...(framed.expectGeneration !== undefined
          ? { expectGeneration: framed.expectGeneration }
          : {}),
      },
      CAPTURE_BUDGET_MS + 5_000,
    )
    const observation = expect(result, 'image')
    this.#nextImage += 1
    const record: ImageRecord = {
      imageRef: `di_${this.#nextImage}`,
      windowId: input.windowId,
      identityKey: identityKey(known),
      epochKey: epochKeyOf(host),
      geometry: observation.geometry,
      capturedAt: observation.capturedAt,
    }
    lease.images.set(record.imageRef, record)
    return {
      app: known.app,
      title: known.title,
      imageRef: record.imageRef,
      data: observation.bytes,
      mime: observation.mime,
      geometry: observation.geometry,
      source: observation.source,
      capturedAt: observation.capturedAt,
    }
  }

  /**
   * 这次采集要采哪一块，以及要不要带上窗口几何代际。
   *
   * `imageRef` 那一支的失效判据四条，逐条都是可核实的事实：本执行者交出过这个 ref、
   * 宿主没换过代际、那张图采的是同一个窗口身份、那块矩形与图有交集。任一条不成立即
   * 在本地拒绝——**不伪造一个能发出去的矩形**。
   */
  #regionOf(
    lease: Lease,
    known: KnownWindow,
    input: { windowId: string; region?: DesktopRect; imageRef?: string; imageRect?: DesktopRect },
  ): { region?: DesktopRect; expectGeneration?: string } {
    if (input.imageRef === undefined) {
      return input.region === undefined ? {} : { region: input.region }
    }
    if (input.imageRect === undefined) {
      throw new DesktopTargetError('按上一张图取区域时要给 imageRect')
    }
    const record = this.#imageOf(lease, known, input.windowId, input.imageRef)
    const region = imageRectToScreen(record.geometry, input.imageRect)
    if (!region) {
      throw new DesktopTargetError(`给的矩形不在 ${input.imageRef} 覆盖的范围里`)
    }
    return { region, expectGeneration: record.geometry.generation }
  }

  /**
   * 取一张交出去过的图，并核对它此刻还成不成立。
   *
   * 四条判据逐条都是可核实的事实：本执行者交出过这个 ref、宿主没换过代际、那张图采的是
   * 同一个窗口身份、窗口几何代际随请求一起交给宿主再核一次。任一条不成立即在本地拒绝
   * ——**不伪造一个能发出去的坐标**。
   */
  #imageOf(lease: Lease, known: KnownWindow, windowId: string, imageRef: string): ImageRecord {
    const record = lease.images.get(imageRef)
    if (!record) {
      throw new DesktopTargetError(`认不出的图 ${imageRef}，请重新采图`)
    }
    const host = this.#bridge.host()
    if (!host || record.epochKey !== epochKeyOf(host)) {
      throw new DesktopTargetError(`${imageRef} 已经失效：桌面宿主换过代际，请重新采图`)
    }
    if (record.windowId !== windowId || record.identityKey !== identityKey(known)) {
      throw new DesktopTargetError(`${imageRef} 采的不是这个窗口，请重新采图`)
    }
    return record
  }

  /** 这个短编号在本执行者对该窗口的最近一份观察里对应的宿主 ref，不看观察编号。 */
  #requireRef(lease: Lease, windowId: string, ref: string): string {
    const hostRef = lease.observations.get(windowId)?.hostRefs.get(ref)
    if (hostRef === undefined) {
      throw new DesktopTargetError(`这个窗口最近一份观察里没有控件 ${ref}，请重新观察`)
    }
    return hostRef
  }

  async #act(
    lease: Lease,
    input: {
      windowId: string
      observationId: string
      ref?: string
      at?: DesktopImagePoint
      action: DesktopAction
    },
  ): Promise<DesktopActResult> {
    this.#liveHost(lease)
    // 观察已经占下了桌面，这里通常是空操作；观察之后被强制释放过才会真的排队。
    await this.#acquire(lease)
    this.#liveHost(lease)
    const known = this.#targetOf(input.windowId)
    const aimed = this.#aim(lease, known, input)
    const action = this.#hostAction(lease, input.windowId, input.action)
    this.#nextAction += 1
    const actionId = `da_${this.#nextAction}`
    this.#setTarget(lease, known.app)
    try {
      const scope = lease.observations.get(input.windowId)?.scope
      const result = await this.#bridge.request('act', {
        executorId: lease.executorId,
        actionId,
        target: this.#frameTarget(known),
        ...aimed,
        ...(scope !== undefined ? { root: scope.host } : {}),
        action,
        maxNodes: DEFAULT_MAX_NODES,
        maxDepth: DEFAULT_MAX_DEPTH,
        timeBudgetMs: READ_TREE_BUDGET_MS,
      })
      // 前台接管的读数按回执上调：宿主拒绝派发时桌面没有被碰，那时说「正在前台操作」
      // 是一句假话。
      if (FOREGROUND_ACTIONS.has(input.action.kind) && result.dispatch !== 'not_dispatched') {
        this.#setTarget(lease, known.app, true)
      }
      return {
        dispatch: result.dispatch,
        actionId,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...this.#blockedBy(result.blocking),
        ...this.#followUp(
          lease,
          input.windowId,
          result.dispatch,
          result.observation,
          result.observationError,
        ),
      }
    } catch (err) {
      if (!(err instanceof DesktopBridgeError)) throw err
      // 执行事实来自异常自己带的那一格：压成一句失败的话，调用方分不出「没执行」
      // 与「可能已经执行」，而后者禁止重发。
      return {
        dispatch: err.dispatch,
        actionId,
        reason: err.message,
        ...this.#followUp(
          lease,
          input.windowId,
          err.dispatch,
          undefined,
          '宿主不可用，动作之后没有重读',
        ),
      }
    }
  }

  /**
   * 这次动作打在哪儿：控件引用、上一张图里那个点换算出来的屏幕坐标，或者两样都不给。
   *
   * **前两种只能给一个。** 给控件时按观察编号核对它还在不在这一份表里；给图像点时走
   * 与按图重采同一条换算与代际核对路径，失效的 `imageRef` 在本地就拒绝，一帧都不发。
   *
   * 两样都不给时目标是窗口本身，只有键盘输入能这样发：它去的是系统焦点所在，
   * 准入由 worker 按「前台窗口就是目标窗口」判。
   */
  #aim(
    lease: Lease,
    known: KnownWindow,
    input: {
      windowId: string
      observationId: string
      ref?: string
      at?: DesktopImagePoint
      action: DesktopAction
    },
  ): { ref?: string; point?: { x: number; y: number }; expectGeneration?: string } {
    if (input.ref !== undefined && input.at !== undefined) {
      throw new DesktopTargetError('控件与图像点只能给一个')
    }
    if (input.ref !== undefined) {
      return { ref: this.#recordOf(lease, input.windowId, input.observationId, input.ref) }
    }
    if (input.at === undefined) {
      if (WINDOW_TARGET.has(input.action.kind)) return {}
      throw new DesktopTargetError('要给控件或图像点')
    }
    if (!FOREGROUND_POINTER.has(input.action.kind)) {
      throw new DesktopTargetError(`${input.action.kind} 只能按控件执行，不能给图像点`)
    }
    const record = this.#imageOf(lease, known, input.windowId, input.at.imageRef)
    const { imageWidth, imageHeight } = record.geometry
    // 图外的坐标在本地就拒：换算出来的屏幕点落在窗口外面，宿主只说得出「落点不在窗口里」，
    // 而调用方要的是「这个点不在那张图上」。
    if (input.at.x < 0 || input.at.y < 0 || input.at.x >= imageWidth || input.at.y >= imageHeight) {
      throw new DesktopTargetError(
        `给的坐标不在 ${input.at.imageRef} 覆盖的范围里（图是 ${imageWidth}×${imageHeight}）`,
      )
    }
    const point = imagePointToScreen(record.geometry, input.at.x, input.at.y)
    return { point, expectGeneration: record.geometry.generation }
  }

  /**
   * 发给宿主的动作载荷。只有拖拽的控件终点带控件引用，它要在本执行者对这个窗口的最近一份
   * 观察里，并翻成宿主 ref；其余动作原样交回。
   *
   * 终点写在动作里而不是另开一格：只有拖拽有终点，多一格空字段会让调用方按它给出
   * 一个不会被读的值。像素偏移不需要核对，它由宿主在派发前夹进目标窗口。
   */
  #hostAction(lease: Lease, windowId: string, action: DesktopAction): DesktopAction {
    if (action.kind !== 'drag' || action.to.kind !== 'ref') return action
    return { ...action, to: { kind: 'ref', ref: this.#requireRef(lease, windowId, action.to.ref) } }
  }

  /**
   * 读一个控件的文档文本与选区。
   *
   * **它不换观察编号**：读文本不动控件表，换号会让调用方手上刚拿到的 `ref` 一并作废。
   */
  async #readText(
    lease: Lease,
    input: { windowId: string; observationId: string; ref: string; maxChars: number },
  ): Promise<DesktopText> {
    this.#liveHost(lease)
    await this.#acquire(lease)
    this.#liveHost(lease)
    const known = this.#targetOf(input.windowId)
    const ref = this.#recordOf(lease, input.windowId, input.observationId, input.ref)
    this.#setTarget(lease, known.app)
    const result = await this.#bridge.request('read_text', {
      executorId: lease.executorId,
      target: this.#frameTarget(known),
      ref,
      maxChars: input.maxChars,
    })
    const observation = expect(result, 'text')
    return {
      app: known.app,
      title: known.title,
      text: observation.text,
      truncated: observation.truncated,
      selectionSupport: observation.selectionSupport,
      selection: observation.selection.map((s) => ({ ...s })),
    }
  }

  /**
   * 等一个后置条件成立。
   *
   * 判定下沉到宿主：这里只发一条请求并等它的终态，不在本地按固定间隔重读。期限比调用方
   * 要的时长多一段，宿主到点之后还要按当前观察的读取范围重读一次。
   *
   * **等待期间本次执行仍然占着桌面**：引用在观察里产生、在动作里消费，中间放别人进来
   * 它就不再成立。占用不会被等待卡死——`release` 一到就撤销这条请求，宿主在一个轮询间隔
   * 内以 `cancelled` 收尾，桌面随即交给下一个执行者。
   */
  async #wait(
    lease: Lease,
    input: {
      windowId: string
      observationId: string
      until: DesktopWaitCondition
      ref?: string
      value?: string
      role?: string
      query?: string
      title?: string
      timeoutMs: number
    },
  ): Promise<DesktopWaitResult> {
    this.#liveHost(lease)
    await this.#acquire(lease)
    this.#liveHost(lease)
    const known = this.#targetOf(input.windowId)
    const ref =
      input.ref === undefined
        ? undefined
        : this.#recordOf(lease, input.windowId, input.observationId, input.ref)
    this.#setTarget(lease, known.app)
    const scope = lease.observations.get(input.windowId)?.scope
    try {
      const result = await this.#bridge.request(
        'wait',
        {
          executorId: lease.executorId,
          target: this.#frameTarget(known),
          until: input.until,
          ...(scope !== undefined ? { root: scope.host } : {}),
          ...(ref !== undefined ? { ref } : {}),
          ...(input.value !== undefined ? { value: input.value } : {}),
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.query !== undefined ? { nameContains: input.query } : {}),
          ...(input.title !== undefined ? { name: input.title } : {}),
          pollMs: WAIT_POLL_MS,
          timeoutMs: input.timeoutMs,
          maxNodes: DEFAULT_MAX_NODES,
          maxDepth: DEFAULT_MAX_DEPTH,
          timeBudgetMs: READ_TREE_BUDGET_MS,
        },
        input.timeoutMs + WAIT_SLACK_MS,
      )
      const observation = expect(result, 'wait')
      return {
        found: observation.found,
        ...(observation.reason !== undefined ? { reason: observation.reason } : {}),
        ...this.#followUp(lease, input.windowId, null, observation, undefined),
      }
    } catch (err) {
      if (!(err instanceof DesktopBridgeError)) throw err
      lease.observations.delete(input.windowId)
      return {
        found: false,
        reason: lease.released ? 'cancelled' : 'unavailable',
        observation: null,
        observationError: err.message,
      }
    }
  }

  /**
   * 动作调用尚未返回时同次带回的那份窗口清单。
   *
   * 走 `#register`——与 `desktop_windows` 同一条登记路径：调用方拿到的 `windowId` 可以
   * 直接观察，不必先再列一次窗口。这一批不剪旧窗口，它只覆盖目标那一个进程。
   */
  #blockedBy(blocking: DesktopBlockingWindow[] | undefined): {
    blocking?: DesktopBlockingWindowInfo[]
  } {
    if (!blocking || blocking.length === 0) return {}
    const registered = this.#register(blocking)
    return {
      blocking: registered.map((info, at) => ({
        ...info,
        appeared: blocking[at]?.appeared === true,
      })),
    }
  }

  /**
   * 动作或等待之后的那份重读。
   *
   * 读到了就整份替换观察并换新编号。没读到时按执行事实分两种：**未派发的动作一条系统调用
   * 都没发出，上一份观察仍然成立，就地保留、编号不变**——作废它等于要求调用方为一件
   * 没有发生的事重新观察一次；已派发与结果未知那两种，控件表停在动作之前那一刻而动作
   * 可能已经生效，整份作废。
   *
   * `dispatch` 给 `null` 表示这次调用不派发动作（等待），它总带着一份重读。
   * 执行事实不受这里影响。
   */
  #followUp(
    lease: Lease,
    windowId: string,
    dispatch: DesktopDispatch | null,
    observation: DesktopObservation | undefined,
    error: string | undefined,
  ): DesktopFollowUp {
    if (observation?.kind === 'tree' || observation?.kind === 'wait') {
      return { observation: this.#absorb(lease, windowId, observation) }
    }
    if (dispatch === 'not_dispatched') {
      return { observation: null, observationError: '动作没有派发，上一份观察仍然有效' }
    }
    lease.observations.delete(windowId)
    return { observation: null, observationError: error ?? '宿主没有回传动作之后的读数' }
  }

  /**
   * 释放这次执行。重复调用是空操作，不是第二条路径。
   *
   * 顺序固定，每一步都不能提前：
   *
   * 1. `released` 置上——此后这个端口的任何入口都被 `#liveHost` 挡下，不再有新派发。
   * 2. 排队中的自己拿掉，它还没进场，直接让后面的人往前挪。
   * 3. 本地在途调用按执行事实收尾。撤销帧发不发得出去都不影响它们已经没有回执可等。
   * 4. 让宿主撤销这个执行者名下尚未派发的请求，并回答它名下还有没有可能正在执行的
   *    请求。**只有回答是「没有」才放下一个执行者进来**：截止时刻到了而执行状态未知
   *    时放行，等于两个执行者同时在动同一个桌面。
   */
  async #release(lease: Lease): Promise<void> {
    if (lease.released) return
    lease.released = true
    lease.observations.clear()
    lease.images.clear()
    this.#leases.delete(lease.owner)
    this.#dropWaiter(lease, '本次执行的电脑控制已经结束')
    const held = this.#holder === lease
    if (held) this.#clearTarget()
    this.#bridge.settleExecutor(lease.executorId, '本次执行的电脑控制已经结束')
    const before = this.#bridge.host()
    if (!before) {
      // 宿主没了，这个执行实例名下的一切随之作废，没有什么要等着结清。
      if (held) this.#handOver()
      return
    }
    const settled = await this.#bridge
      .request('cancel', { executorId: lease.executorId }, CANCEL_DEADLINE_MS)
      .then((result) => result.dispatch === 'not_dispatched')
      .catch((err: unknown) => {
        log.info(
          'desktop',
          `撤销排队请求未送达：${err instanceof Error ? err.message : String(err)}`,
        )
        return false
      })
    if (!held) return
    // 等回执期间宿主换了代际或断开：旧执行实例名下的一切本来就已作废，没有什么要挡。
    const after = this.#bridge.host()
    const sameHost = after !== null && epochKeyOf(after) === epochKeyOf(before)
    if (settled || !sameHost) {
      this.#handOver()
      return
    }
    log.warn('desktop', '执行者释放后仍可能有请求在执行，桌面暂不交给下一个执行者', {
      executorId: lease.executorId,
    })
    this.#block('上一次电脑控制还没有确认结清，此刻不能操作桌面')
  }

  #setTarget(lease: Lease, app: string, foreground = false): void {
    // 只有持有桌面的执行者写得动这个读数。少了这一条，两个执行者的目标会互相覆盖，
    // 界面上显示的是最后写进来的那一个，而不是此刻真在操作的那一个。
    if (this.#holder !== lease) return
    const takeover = this.#target?.foreground || foreground
    if (
      this.#target?.conversationId === lease.conversationId &&
      this.#target.app === app &&
      this.#target.foreground === takeover
    )
      return
    this.#target = { conversationId: lease.conversationId, app, foreground: takeover }
    for (const listener of [...this.#targetChanges]) listener(this.#target)
  }

  #clearTarget(): void {
    if (this.#target === null) return
    this.#target = null
    for (const listener of [...this.#targetChanges]) listener(null)
  }
}

/** 一份记录交给调用方的形状。应用名与标题来自窗口表，不是观察里的。 */
function snapshotOf(record: ObservationRecord, known: KnownWindow): DesktopSnapshot {
  return {
    windowId: record.windowId,
    app: known.app,
    title: known.title,
    observationId: record.observationId,
    capturedAt: record.capturedAt,
    ...(record.scope !== undefined ? { scope: record.scope.ref } : {}),
    elements: record.elements,
    truncated: record.truncatedBy.length > 0,
    truncatedBy: [...record.truncatedBy],
    filteredBy: [...record.filteredBy],
    visited: record.visited,
    windowEnabled: record.windowEnabled,
    windowCovered: record.windowCovered,
  }
}

/**
 * 取一份指定种类的观察。
 *
 * 种类对不上即协议错，抛出而不是当成空结果：把一份 `element` 读成 `windows`
 * 会让调用方拿到一张空的窗口表，而那与「这台机器上没有窗口」无法区分。
 *
 * 宿主拒绝这次请求时原因在 `reason` 或 `observationError` 里，要带上：少了它，
 * 目标失效、组件没起来、协议对不上三种都只剩「没有回传观察」这一句话。
 */
function expect<K extends DesktopObservation['kind']>(
  result: DesktopCallResult,
  kind: K,
): Extract<DesktopObservation, { kind: K }> {
  const observation = result.observation
  if (observation?.kind !== kind) {
    throw new DesktopBridgeError(
      `宿主没有回传 ${kind} 观察：${result.reason ?? result.observationError ?? '没有说明原因'}`,
      result.dispatch,
    )
  }
  return observation as Extract<DesktopObservation, { kind: K }>
}
