/**
 * 电脑控制协调器：应用进程级对象，由 `serve` 装配。
 *
 * 只执行已绑定身份的操作，不规划任务，不另存任务进度。
 *
 * 边界：
 *
 * 1. **OS 句柄不出本层。** 模型取得的是 `dw_N` 形式的不透明 id；句柄、pid 与进程
 *    启动时刻记录在本模块，发送请求时才组装为目标身份交给宿主。
 * 2. **每个窗口只保留一份观察。** 同一窗口再次观察后，上一份编号作废；宿主代际变化
 *    （重连、更换 worker）时全部作废。动作只接受表中仍存在的编号。每份观察只含同一次读取
 *    的节点，动作与等待之后按其读取范围整份重新读取，不与其他读取结果拼接。
 * 3. **占用按窗口归属，冲突当场判定，权威只在本模块。** 执行者首次在某个窗口上观察或执行
 *    动作时取得该窗口，直到本次执行释放；窗口已归属其他执行者时立即拒绝并写明占用方，不排队。
 *    `ref` 在观察中产生、在动作中使用，其间只有同一窗口上的他人动作会使它不再成立，因此不同
 *    窗口互不等待。不要改回整台桌面一把锁：占用到整轮结束才释放，其他会话在任何窗口上都会
 *    无期限等待。宿主执行线程逐条执行请求，一次动作内的指针与按键不会与其他请求交错；宿主一侧
 *    不记录占用者，只按请求自带的身份派发。
 * 4. **释放过程中仍视为占用。** 顺序固定：禁止新派发 → 结清在途调用 → 请宿主撤销尚未派发的
 *    请求。宿主确认该执行者名下已无执行中的请求后才交还其窗口；无法确认时这些窗口保持占用并
 *    拒绝他人，直到宿主代际变化。
 * 5. **「正在操作的应用」按执行者各记一项。** 每个执行者只写入自己的一项；执行者释放时移除，
 *    宿主断开或代际变化时全部清空。
 * 6. **控件编号只在本模块发放与转换。** 宿主的 ref 含下标路径与身份段，只用于
 *    宿主重新定位控件；端口交出的是按控件身份分配的短编号 `e<n>`。发往宿主的每一处按
 *    本次观察的对应表转换回完整 ref，宿主回包中的 ref 在 `#absorb` 中替换为短编号。
 *    工具层不做转换，也不另存对应关系。
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

/** 读取控件树的默认上限。请求未指定时使用；指定时也不超过工具一侧声明的上限。 */
const DEFAULT_MAX_NODES = 1500
const DEFAULT_MAX_DEPTH = 20
/** 读取控件树的时间预算。UIA 等跨进程接口没有请求级的硬性上限，只能为采集端设定预算。 */
const READ_TREE_BUDGET_MS = 4_000
/** 等待时两次判定的最小间隔。判定在宿主一侧执行，此值只是其轮询下限。 */
const WAIT_POLL_MS = 250
/**
 * 等待请求的期限超出调用方所请求时长的部分。
 *
 * 宿主在到期后还要按读取范围重新读取一次才回执，这部分时长必须覆盖该次读取；过短时
 * 本地超时先触发，一次正常到期的等待会被记为宿主不可用。
 */
const WAIT_SLACK_MS = READ_TREE_BUDGET_MS + 2_000
/**
 * 撤销请求的期限。
 *
 * 其回执回答「该执行者名下是否还有可能正在执行的请求」，因此必须给宿主留出足够
 * 时间等待当前调用结束：读取控件树的预算是 `READ_TREE_BUDGET_MS`，另加一次 UIA 连接
 * 超时的余量。期限过短时，每次在读取控件树中途停止都会使桌面阻塞到宿主代际变化为止。
 */
const CANCEL_DEADLINE_MS = READ_TREE_BUDGET_MS + 4_000
/**
 * 一次采集等待一帧的上限。
 *
 * WGC 的帧由合成器推送，实测一到两个合成周期即可到达；后备的 `PrintWindow` 是同步调用。
 * 3 秒的上限为挂起的应用预留，到期即如实返回失败。
 */
const CAPTURE_BUDGET_MS = 3_000
/**
 * 单张图像编码后的字节上限。
 *
 * 宿主连接的单帧上限是 8 MiB，base64 将字节数放大为 4/3，因此 4 MiB 的 PNG 在连接上
 * 约占 5.4 MiB。超过此值的请求在采集端即被拒绝，避免单帧中断宿主连接。
 */
const CAPTURE_MAX_BYTES = 4 * 1024 * 1024
/** 接受图像点作为落点的动作。其余动作只能按控件执行。 */
const FOREGROUND_POINTER: ReadonlySet<string> = new Set(['click', 'hover', 'drag', 'wheel'])
/**
 * 可以不指定目标、直接投递给窗口的动作。
 *
 * 键盘输入发往目标窗口的焦点所在位置，而不是某个指定的控件。准入判定在 worker 一侧
 * （目标窗口未被禁用；需要前台的窗口还要求前台窗口即目标窗口），这里不拦截。
 */
const WINDOW_TARGET: ReadonlySet<string> = new Set(['type_text', 'press_key'])
/**
 * 单个窗口的编号表最多记录的控件身份数，超过即淘汰最久未出现的身份。
 *
 * 必须高于单次读取的节点数（工具侧上限 4000）：同一份观察中的控件在表中互相淘汰时，
 * 下一份观察中它们会获得新编号。
 */
export const MAX_WINDOW_REFS = 8192
/** 宿主在 `filteredBy` 中记录读取范围的条目前缀，其后是宿主的完整 ref。 */
const ROOT_FILTER = 'root='

/**
 * 端口已释放，或当前没有可用的宿主。
 *
 * 判定在本地完成，本次操作未向宿主发送任何帧，因此按 `DesktopRefusal` 声明
 * `executed:false`。
 */
export class DesktopUnavailableError extends Error implements DesktopRefusal {
  readonly errorKind = 'desktop_unavailable' as const
  readonly executed = false as const
}

/** 目标窗口、观察编号或控件引用在本地即判定不一致。同样未发送任何帧。 */
export class DesktopTargetError extends Error implements DesktopRefusal {
  readonly errorKind = 'invalid_argument' as const
  readonly executed = false as const
}

/**
 * 宿主 ref 中的控件身份，作为编号表的键。
 *
 * 有 RuntimeId 时取 `#` 之后的身份段：控件移动位置、下标路径变化后，仍是同一个键。
 * 身份段以 `~` 开头（属性指纹）或为空时取整条 ref：指纹对同角色同名的兄弟控件不唯一，
 * 单独作键会把两个控件编为同一个编号。
 */
function identityOfRef(hostRef: string): string {
  const at = hostRef.indexOf('#')
  const segment = at < 0 ? '' : hostRef.slice(at + 1)
  return segment === '' || segment.startsWith('~') ? hostRef : segment
}

/**
 * 单个窗口的控件编号表：控件身份 → `e<n>`。
 *
 * 编号只增不减，被淘汰的身份再次出现时分配新编号。RuntimeId 可能被另一个控件复用，因此表
 * 按窗口隔离并设上限；同一编号不会分配给两个身份。`Map` 的插入顺序即最近出现的先后顺序。
 */
class WindowRefs {
  #ids = new Map<string, string>()
  #last = 0

  /** 该宿主 ref 在本窗口的编号。已出现过的身份沿用原编号，并记为最近出现。 */
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

/** 已发现窗口的完整身份。句柄、pid 与进程启动时刻不交给模型。 */
interface KnownWindow {
  windowId: string
  handle: number
  pid: number
  processStartedAt: number
  app: string
  title: string
  /** 该窗口的控件编号表。窗口身份变化即分配新的 `windowId`，编号表随之重建。 */
  refs: WindowRefs
}

/** 一次观察的记录。动作前的唯一匹配与前置条件按它判定。 */
interface ObservationRecord {
  observationId: string
  windowId: string
  /** 采集本份记录时的宿主代际。代际变化即作废。 */
  epochKey: string
  /**
   * 读取范围的根：`ref` 是交给端口的短编号，`host` 是宿主的完整 ref。缺省表示整个窗口。
   * 动作与等待之后按 `host` 重新读取。
   */
  scope?: { ref: string; host: string }
  /** 端口形状：`ref` 与 `parentRef` 是本窗口的短编号。 */
  elements: DesktopElement[]
  /** 本次观察中短编号 → 宿主完整 ref 的对应表。发往宿主的控件引用一律按它转换。 */
  hostRefs: Map<string, string>
  truncatedBy: string[]
  filteredBy: string[]
  visited: number
  capturedAt: number
  windowEnabled: boolean
  windowCovered: boolean
}

/**
 * 已交给模型的图像。`imageRef` 指向该记录。
 *
 * 绑定四项：目标窗口身份（`windowId` 及其身份键）、宿主的三项代际（`epochKey`）、
 * 几何（含窗口矩形代际）与采集时刻。任一项不一致，按该 ref 定位的请求都不应派发。
 */
interface ImageRecord {
  imageRef: string
  windowId: string
  /** 采集时窗口的身份键。窗口关闭后重新打开即变化。 */
  identityKey: string
  epochKey: string
  geometry: DesktopImageGeometry
  capturedAt: number
}

/** 一次执行持有的身份。`released` 置位后，该端口不再取得任何能力。 */
interface Lease {
  owner: number
  executorId: string
  conversationId: string
  released: boolean
  /** 本执行者的观察记录，按 `windowId` 各保留最近一份。 */
  observations: Map<string, ObservationRecord>
  /** 本执行者交出的图像，按 `imageRef` 索引。 */
  images: Map<string, ImageRecord>
  /** 本执行者取得的窗口。释放并经宿主确认后交还。 */
  windows: Set<string>
  /** 本执行者正在操作的应用，见 `#setTarget`。 */
  target: { app: string; foreground: boolean } | null
  /**
   * 释放时宿主无法确认其名下请求是否执行完毕的原因。非 `null` 时其窗口保持占用，他人按此原因被拒绝，
   * 直到宿主代际变化：交还等于两个执行者同时操作同一个窗口。
   */
  unsettled: string | null
}

/** 宿主代际键。三项中任一项变化，旧观察与旧引用即整体作废。 */
function epochKeyOf(host: NativeDesktopHost): string {
  return `${host.hostId}#${host.hostEpoch}#${host.connectionEpoch}`
}

/** 窗口身份键。句柄与 pid 都会被复用，三项组合才能判定是否为同一个窗口。 */
function identityKey(w: { handle: number; pid: number; processStartedAt: number }): string {
  return `${w.handle}:${w.pid}:${w.processStartedAt}`
}

/**
 * 控件的端口形状。`ref` 与 `parentRef` 按 `refOf` 转换为短编号，`parentRef` 指向同一张表
 * 中的父控件。
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
  /** 身份键 → 不透明 id。同一窗口再次被发现时沿用同一个 id。 */
  #byIdentity = new Map<string, string>()
  #leases = new Map<number, Lease>()
  /** 窗口归属：不透明 id → 取得该窗口的执行者。权威只有这一份。 */
  #owners = new Map<string, Lease>()
  #targetChanges = new Set<(targets: DesktopTargetEvent['targets']) => void>()
  /** 会话标题，用于拒绝原因中写明占用方。会话不存在时为 `undefined`。 */
  #titleOf: (conversationId: string) => string | undefined
  #offHostChange: () => void

  constructor(
    bridge: DesktopBridge,
    enabled: () => boolean,
    titleOf: (conversationId: string) => string | undefined,
  ) {
    this.#bridge = bridge
    this.#enabled = enabled
    this.#titleOf = titleOf
    // 宿主断开或代际变化：已发现的窗口、窗口归属与正在操作的应用均不再成立；无法确认是否结束的
    // 窗口随之交还，因为它针对的执行实例已不存在。
    this.#offHostChange = bridge.onHostChange(() => {
      this.#windows.clear()
      this.#byIdentity.clear()
      this.#owners.clear()
      for (const lease of this.#leases.values()) {
        lease.windows.clear()
        lease.target = null
      }
      this.#publishTargets()
    })
  }

  /**
   * 电脑控制能力是否可用。
   *
   * 四项缺一不可：用户已启用、宿主已连接、worker 已就绪、系统已授权。
   * 装配方据此决定是否注入端口，而不是先提供端口、调用时再报错。
   */
  available(): boolean {
    const host = this.#bridge.host()
    return this.#enabled() && host !== null && host.workerReady && host.authorized
  }

  /** 各执行者正在操作的应用及其所属会话。握手与实时事件都读取这一份。 */
  targets(): DesktopTargetEvent['targets'] {
    return [...this.#leases.values()].flatMap((lease) =>
      lease.target ? [{ conversationId: lease.conversationId, ...lease.target }] : [],
    )
  }

  onTargetChange(listener: (targets: DesktopTargetEvent['targets']) => void): () => void {
    this.#targetChanges.add(listener)
    return () => this.#targetChanges.delete(listener)
  }

  /**
   * 为一次执行创建端口。
   *
   * `executorId` 每次不同：窗口归属与撤销按它记录，因此两条会话、父任务与子任务
   * 各自占用、各自撤销。`conversationId` 用于拒绝原因与目标状态的归属。
   *
   * 端口本身不占用任何窗口，首次在某个窗口上观察或执行动作时才取得该窗口。
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
      windows: new Set(),
      target: null,
      unsettled: null,
    }
    this.#leases.set(lease.owner, lease)
    return {
      foregroundEnabled: () => this.#bridge.foregroundEnabled(),
      windows: () => this.#windowList(lease),
      observe: (input) => this.#observe(lease, input),
      elements: (windowId) => this.#elements(lease, windowId),
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

  /** 本次执行是否仍能操作桌面。每个发送请求的入口都必须先经过此检查。 */
  #liveHost(lease: Lease): NativeDesktopHost {
    if (lease.released) throw new DesktopUnavailableError('本次执行的电脑控制已经结束')
    if (!this.available()) throw new DesktopUnavailableError('电脑控制此刻不可用')
    const host = this.#bridge.host()
    if (!host) throw new DesktopUnavailableError('桌面宿主未连接')
    return host
  }

  /**
   * 取得窗口。已归属本执行者时为空操作；归属其他执行者时立即拒绝，原因写明占用方。
   *
   * 窗口发现不经过这里：它不绑定任何窗口，也不改变任何状态。绑定窗口的观察、采集、动作、
   * 读取文本与等待都必须先经过这里。不要改为排队等待：占用到对方整轮结束才释放，排队的调用
   * 会无期限挂起，模型与界面都无法说明原因。
   */
  #claim(lease: Lease, windowId: string): void {
    const owner = this.#owners.get(windowId)
    if (owner === lease) return
    if (owner !== undefined) throw new DesktopUnavailableError(this.#busy(lease, owner))
    this.#owners.set(windowId, lease)
    lease.windows.add(windowId)
  }

  /** 窗口已归属其他执行者时的拒绝原因。 */
  #busy(lease: Lease, owner: Lease): string {
    if (owner.unsettled !== null) return owner.unsettled
    if (owner.released) return '该窗口上一次的电脑控制正在结束，稍后再试'
    const title = this.#titleOf(owner.conversationId)
    const who =
      owner.conversationId === lease.conversationId
        ? '本会话的另一个执行者'
        : title
          ? `会话「${title}」`
          : '另一个会话'
    return `该窗口正被${who}操作，对方本轮结束后释放`
  }

  async #windowList(lease: Lease): Promise<DesktopWindowInfo[]> {
    this.#liveHost(lease)
    const result = await this.#bridge.request('list_windows', { executorId: lease.executorId })
    const observation = expect(result, 'windows')
    const out = this.#register(observation.windows)
    // 本次未再出现的窗口立即作废：句柄会被 OS 复用，保留旧 id 等于提供一个可能
    // 指向另一个窗口的目标。**只有整机清单可用于这种裁剪**：动作回执带回的只是单个进程的窗口，
    // 据此裁剪会把其他进程的窗口一并作废。
    const seen = new Set(observation.windows.map(identityKey))
    for (const [key, id] of [...this.#byIdentity]) {
      if (seen.has(key)) continue
      this.#byIdentity.delete(key)
      this.#windows.delete(id)
    }
    return out
  }

  /**
   * 把一批窗口登记为不透明 id。**这是 id 的唯一产生处**：同一个窗口在窗口清单中与在
   * 动作回执中取得的是同一个 id，模型因此无需区分它来自哪条路径。
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
      // 编号表随窗口身份保留，再次发现同一窗口时沿用：新建编号表会使同一个控件更换编号。
      const refs = this.#windows.get(windowId)?.refs ?? new WindowRefs()
      this.#windows.set(windowId, { windowId, ...w, refs })
      out.push({ windowId, app: w.app, title: w.title })
    }
    return out
  }

  /** 把不透明 id 还原为目标身份。无法识别的 id 在本地即拒绝，不发送任何帧。 */
  #targetOf(windowId: string): KnownWindow {
    const known = this.#windows.get(windowId)
    if (!known) {
      throw new DesktopTargetError(`无法识别的窗口 ${windowId}，请重新调用 desktop_windows`)
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
    const known = this.#targetOf(input.windowId)
    this.#claim(lease, input.windowId)
    // 子树根必须来自本执行者对该窗口的上一份观察：自行编造编号等于让宿主定位一个
    // 从未观察过的位置。
    const root =
      input.root === undefined ? undefined : this.#recordOf(lease, input.windowId, input.root)
    // 目标在**发送请求之前**登记：读取控件树可能在 provider 上阻塞直到超时，回包后才登记时，
    // 界面在这段时间内无法显示正在操作的对象。
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
   * 用一份读取结果整份替换本执行者对该窗口的观察，并分配新编号。
   *
   * 不要改为与上一份拼接：拼入的旧节点会带上新编号、新时刻与本次读取的完整性，
   * 而它们的状态与可用动作仍停留在上一次读取的时刻。必须更换编号：旧编号对应的表
   * 已不是当前这张，保留它等于让模型在两份表之间选择。
   *
   * 整窗读取的第一项是窗口元素本身：标记 `windowRoot`，其名称即当前的窗口标题，并据此刷新
   * 窗口表中的标题字段：窗口表只在发现窗口时写入，页面切换后仍是旧标题。
   *
   * 宿主回包中含 ref 的三处在这里替换为短编号：控件的 `ref` / `parentRef`、`scope`，以及
   * `filteredBy` 中的 `root=` 条目。
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
   * 取回一次观察记录。代际变化、窗口不一致、编号已更换，三种情形都返回 `null`。
   *
   * worker 未就绪时同样返回 `null`，且不能等代际变化后再判定：产生该观察的执行实例已不存在，
   * 而宿主要到下一个 worker 握手成功后才报告新的 `hostEpoch`。这段时间内代际仍是旧值，
   * 只按代际判定时，模型会用一份已作废的引用发送动作。
   */
  #elements(lease: Lease, windowId: string): DesktopElement[] | null {
    if (lease.released) return null
    const host = this.#bridge.host()
    if (!host || !host.workerReady) return null
    const record = lease.observations.get(windowId)
    if (!record || record.epochKey !== epochKeyOf(host)) return null
    return record.elements
  }

  /**
   * 该短编号在本执行者对该窗口最近一份观察中对应的宿主 ref。观察无效或编号不在其中时在本地拒绝，
   * 不发送任何帧：自行编造编号等于让宿主定位一个从未观察过的位置。
   */
  #recordOf(lease: Lease, windowId: string, ref: string): string {
    if (!this.#elements(lease, windowId)) {
      throw new DesktopTargetError('本次执行没有该窗口的有效观察，请先观察')
    }
    const hostRef = lease.observations.get(windowId)?.hostRefs.get(ref)
    if (hostRef === undefined) {
      throw new DesktopTargetError(`该窗口最近一份观察中没有控件 ${ref}，请重新观察`)
    }
    return hostRef
  }

  /**
   * 截取目标窗口的图像。
   *
   * 三种取景：整个窗口、窗口内的屏幕矩形、上一张图像中的一块区域。第三种使用 `imageRef`，
   * 与后续按图像定位的动作经由同一条换算与核对路径：
   * **这里换算为屏幕矩形并附带窗口几何代际，宿主在派发前重新核对窗口矩形**。
   *
   * 失效的 `imageRef` 在本地即拒绝，不发送任何帧：换算需要采集时刻的几何，而该几何
   * 已不成立。
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
    const host = this.#liveHost(lease)
    const known = this.#targetOf(input.windowId)
    this.#claim(lease, input.windowId)
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
   * 本次采集的区域，以及是否附带窗口几何代际。
   *
   * `imageRef` 分支的失效判据有四条，每条都是可核实的事实：本执行者交出过该 ref、
   * 宿主代际未变化、该图像采自同一个窗口身份、所给矩形与图像有交集。任一条不成立即
   * 在本地拒绝，**不构造一个可发送的矩形**。
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
      throw new DesktopTargetError('按上一张图像截取区域时必须提供 imageRect')
    }
    const record = this.#imageOf(lease, known, input.windowId, input.imageRef)
    const region = imageRectToScreen(record.geometry, input.imageRect)
    if (!region) {
      throw new DesktopTargetError(`提供的矩形不在 ${input.imageRef} 的覆盖范围内`)
    }
    return { region, expectGeneration: record.geometry.generation }
  }

  /**
   * 取出一张已交出的图像，并核对它当前是否仍然成立。
   *
   * 四条判据都是可核实的事实：本执行者交出过该 ref、宿主代际未变化、该图像采自
   * 同一个窗口身份、窗口几何代际随请求交给宿主再次核对。任一条不成立即在本地拒绝，
   * **不构造一个可发送的坐标**。
   */
  #imageOf(lease: Lease, known: KnownWindow, windowId: string, imageRef: string): ImageRecord {
    const record = lease.images.get(imageRef)
    if (!record) {
      throw new DesktopTargetError(`无法识别的图像 ${imageRef}，请重新采图`)
    }
    const invalid = this.#imageInvalid(record, known, windowId)
    if (invalid !== null) throw new DesktopTargetError(invalid)
    return record
  }

  /** 该图像此刻不再适用于该窗口的原因；仍然适用时为 `null`。 */
  #imageInvalid(record: ImageRecord, known: KnownWindow, windowId: string): string | null {
    const host = this.#bridge.host()
    if (!host || record.epochKey !== epochKeyOf(host)) {
      return `${record.imageRef} 已失效：桌面宿主的代际已变化，请重新采图`
    }
    if (record.windowId !== windowId || record.identityKey !== identityKey(known)) {
      return `${record.imageRef} 不是从该窗口采集的，请重新采图`
    }
    return null
  }

  /**
   * 本执行者是否看过该窗口的当前状态：有一份有效观察，或有一张仍然适用的该窗口图像。
   *
   * 投递给窗口焦点的键盘输入据此准入。按键不经由控件或图像点定位，不核对时可以向一个从未看过的
   * 窗口输入；只认观察则拒绝只截过图的窗口，而自绘界面只能截图。
   */
  #seen(lease: Lease, known: KnownWindow, windowId: string): boolean {
    if (this.#elements(lease, windowId)) return true
    for (const record of lease.images.values()) {
      if (this.#imageInvalid(record, known, windowId) === null) return true
    }
    return false
  }

  async #act(
    lease: Lease,
    input: {
      windowId: string
      ref?: string
      at?: DesktopImagePoint
      action: DesktopAction
    },
  ): Promise<DesktopActResult> {
    this.#liveHost(lease)
    const known = this.#targetOf(input.windowId)
    this.#claim(lease, input.windowId)
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
      // 前台读数取宿主回执：宿主按实际投递方式上报本次是否占用了用户的前台，不要改为按动作种类
      // 推断，一般窗口上的指针与键盘动作经窗口消息投递，不占用前台。未派发且未占用前台时桌面未被操作，
      // 读数不变。
      if (result.foreground === true || result.dispatch !== 'not_dispatched') {
        this.#setTarget(lease, known.app, result.foreground === true)
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
      // 执行事实取自异常自带的字段：压缩为一句失败时，调用方无法区分「未执行」
      // 与「可能已执行」，而后者禁止重发。
      return {
        dispatch: err.dispatch,
        actionId,
        reason: err.message,
        ...this.#followUp(
          lease,
          input.windowId,
          err.dispatch,
          undefined,
          '宿主不可用，动作之后未重新读取',
        ),
      }
    }
  }

  /**
   * 本次动作的目标：控件引用、由上一张图像中的点换算出的屏幕坐标，或两者都不提供。
   *
   * **前两种只能提供一种。** 提供控件时按观察编号核对它是否仍在该份表中；提供图像点时
   * 经由与按图像重新截取相同的换算与代际核对路径，失效的 `imageRef` 在本地即拒绝，
   * 不发送任何帧。图像点同时带回该图像中合成的弹出窗口：落点可能位于其中一个上，
   * 由 worker 核对它仍在原处，并把点击投递给它。
   *
   * 两者都不提供时目标是窗口本身，只有键盘输入可以这样发送：它发往目标窗口的焦点所在位置。
   * 此处只核对本执行者观察或截取过该窗口（`#seen`），窗口能否接收输入由 worker 判定。
   */
  #aim(
    lease: Lease,
    known: KnownWindow,
    input: {
      windowId: string
      ref?: string
      at?: DesktopImagePoint
      action: DesktopAction
    },
  ): {
    ref?: string
    point?: { x: number; y: number }
    expectGeneration?: string
    expectPopups?: DesktopImageGeometry['popups']
  } {
    if (input.ref !== undefined && input.at !== undefined) {
      throw new DesktopTargetError('控件与图像点只能提供其中一个')
    }
    if (input.ref !== undefined) {
      return { ref: this.#recordOf(lease, input.windowId, input.ref) }
    }
    if (input.at === undefined) {
      if (!WINDOW_TARGET.has(input.action.kind)) {
        throw new DesktopTargetError('必须提供控件或图像点')
      }
      if (!this.#seen(lease, known, input.windowId)) {
        throw new DesktopTargetError('本次执行没有观察或截取过该窗口，请先观察或截图')
      }
      return {}
    }
    if (!FOREGROUND_POINTER.has(input.action.kind)) {
      throw new DesktopTargetError(`${input.action.kind} 只能按控件执行，不接受图像点`)
    }
    const record = this.#imageOf(lease, known, input.windowId, input.at.imageRef)
    const { imageWidth, imageHeight } = record.geometry
    // 图像外的坐标在本地拒绝：换算出的屏幕点位于窗口外时，宿主只能报告「落点不在窗口内」，
    // 而调用方需要的是「该点不在那张图像上」。
    if (input.at.x < 0 || input.at.y < 0 || input.at.x >= imageWidth || input.at.y >= imageHeight) {
      throw new DesktopTargetError(
        `提供的坐标不在 ${input.at.imageRef} 的覆盖范围内（图像尺寸为 ${imageWidth}×${imageHeight}）`,
      )
    }
    const point = imagePointToScreen(record.geometry, input.at.x, input.at.y)
    return {
      point,
      expectGeneration: record.geometry.generation,
      expectPopups: record.geometry.popups,
    }
  }

  /**
   * 发给宿主的动作载荷。只有终点为控件的拖拽带控件引用，该引用必须在本执行者对该窗口
   * 最近一份观察中，并转换为宿主 ref；其余动作原样返回。
   *
   * 终点写在动作内而不是单独设字段：只有拖拽有终点，多出一个空字段会使调用方为它提供
   * 一个不会被读取的值。像素偏移无需核对，由宿主在派发前限制在目标窗口内。
   */
  #hostAction(lease: Lease, windowId: string, action: DesktopAction): DesktopAction {
    if (action.kind !== 'drag' || action.to.kind !== 'ref') return action
    return { ...action, to: { kind: 'ref', ref: this.#recordOf(lease, windowId, action.to.ref) } }
  }

  /**
   * 读取控件的文档文本与选区。
   *
   * **不更换观察编号**：读取文本不改变控件表，更换编号会使调用方刚取得的 `ref` 一并作废。
   */
  async #readText(
    lease: Lease,
    input: { windowId: string; ref: string; maxChars: number },
  ): Promise<DesktopText> {
    this.#liveHost(lease)
    const known = this.#targetOf(input.windowId)
    this.#claim(lease, input.windowId)
    const ref = this.#recordOf(lease, input.windowId, input.ref)
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
   * 等待一个后置条件成立。
   *
   * 判定由宿主执行：这里只发送一条请求并等待其终态，不在本地按固定间隔重新读取。期限比
   * 调用方请求的时长多出一段，因为宿主到期后还要按当前观察的读取范围重新读取一次。
   *
   * **等待期间本次执行仍占用该窗口**：引用在观察中产生、在动作中使用，期间放行其他执行者
   * 会使引用不再成立。占用不会因等待而无限期持续：`release` 调用后即撤销该请求，宿主在
   * 一个轮询间隔内以 `cancelled` 结束，窗口随即交还。
   */
  async #wait(
    lease: Lease,
    input: {
      windowId: string
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
    const known = this.#targetOf(input.windowId)
    this.#claim(lease, input.windowId)
    const ref =
      input.ref === undefined ? undefined : this.#recordOf(lease, input.windowId, input.ref)
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
   * 随动作回执一并带回的阻塞窗口清单。
   *
   * 经由 `#register`，与 `desktop_windows` 使用同一条登记路径：调用方取得的 `windowId` 可以
   * 直接用于观察，无需先重新列出窗口。这一批不裁剪旧窗口，因为它只覆盖目标所在的进程。
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
   * 动作或等待之后的重新读取。
   *
   * 取得读取结果时整份替换观察并更换编号。没有新观察时，只有请求的动作未派发且宿主未报告
   * 重新读取失败，才保留上一份观察与编号。窗口准备后即使输入被拒绝，
   * 也可能带回新观察或重新读取错误；出现错误时不能保留旧表。已派发或结果未知且没有观察时，
   * 控件表同样整份作废。
   *
   * `dispatch` 为 `null` 表示本次调用不派发动作（等待），它总是带有一份重新读取结果。
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
    if (dispatch === 'not_dispatched' && error === undefined) {
      return { observation: null, observationError: '动作未派发，上一份观察仍然有效' }
    }
    lease.observations.delete(windowId)
    return { observation: null, observationError: error ?? '宿主未回传动作之后的观察' }
  }

  /**
   * 释放本次执行。重复调用为空操作，不构成第二条路径。
   *
   * 顺序固定，任何一步都不能提前：
   *
   * 1. 置位 `released`：此后该端口的所有入口都被 `#liveHost` 拒绝，不再有新派发。
   * 2. 本地在途调用按执行事实结束。无论撤销帧能否发出，它们都已没有回执可等待。
   * 3. 请宿主撤销该执行者名下尚未派发的请求，并报告其名下是否还有可能正在执行的
   *    请求。**只有报告为「没有」时才交还其窗口**：截止时刻已到而执行状态未知时交还，
   *    等于两个执行者同时操作同一个窗口。
   */
  async #release(lease: Lease): Promise<void> {
    if (lease.released) return
    lease.released = true
    lease.observations.clear()
    lease.images.clear()
    this.#leases.delete(lease.owner)
    if (lease.target !== null) {
      lease.target = null
      this.#publishTargets()
    }
    this.#bridge.settleExecutor(lease.executorId, '本次执行的电脑控制已经结束')
    const before = this.#bridge.host()
    if (!before) {
      // 宿主已断开，该执行实例名下的请求随之作废，无需等待结清。
      this.#returnWindows(lease)
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
    // 等待回执期间宿主代际变化或断开：旧执行实例名下的请求均已作废。
    const after = this.#bridge.host()
    const sameHost = after !== null && epochKeyOf(after) === epochKeyOf(before)
    if (settled || !sameHost) {
      this.#returnWindows(lease)
      return
    }
    if (lease.windows.size === 0) return
    log.warn('desktop', '执行者释放后仍可能有请求在执行，其窗口暂不交还', {
      executorId: lease.executorId,
    })
    lease.unsettled = '该窗口上一次的电脑控制尚未确认结束，当前无法操作'
  }

  /** 交还执行者取得的窗口。只删除仍归属它的条目：宿主代际变化后窗口归属已整体清空。 */
  #returnWindows(lease: Lease): void {
    for (const windowId of lease.windows) {
      if (this.#owners.get(windowId) === lease) this.#owners.delete(windowId)
    }
    lease.windows.clear()
  }

  /**
   * 写入本执行者的目标。`foreground` 是本次动作的回执；缺省表示本次只是读取，同一应用时沿用
   * 最近一次动作的读数，更换应用时为后台。
   *
   * 每个执行者只写入自己的一项：调用方已取得该窗口，两个执行者不会互相覆盖。
   */
  #setTarget(lease: Lease, app: string, foreground?: boolean): void {
    const current = lease.target
    const same = current !== null && current.app === app
    const next = foreground ?? (same && current.foreground)
    if (same && current.foreground === next) return
    lease.target = { app, foreground: next }
    this.#publishTargets()
  }

  #publishTargets(): void {
    const targets = this.targets()
    for (const listener of [...this.#targetChanges]) listener(targets)
  }
}

/** 交给调用方的记录形状。应用名与标题取自窗口表，不取自观察。 */
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
 * 取出指定种类的观察。
 *
 * 种类不一致即协议错误，应抛出而不是当作空结果：把一份 `element` 读成 `windows`
 * 会使调用方得到一张空的窗口表，与「本机没有窗口」无法区分。
 *
 * 宿主拒绝请求时，原因在 `reason` 或 `observationError` 中，必须一并带上：缺少原因时，
 * 目标失效、组件未启动、协议不一致三种情形都只剩「未回传观察」一句。
 */
function expect<K extends DesktopObservation['kind']>(
  result: DesktopCallResult,
  kind: K,
): Extract<DesktopObservation, { kind: K }> {
  const observation = result.observation
  if (observation?.kind !== kind) {
    throw new DesktopBridgeError(
      `宿主未回传 ${kind} 观察：${result.reason ?? result.observationError ?? '未说明原因'}`,
      result.dispatch,
    )
  }
  return observation as Extract<DesktopObservation, { kind: K }>
}
