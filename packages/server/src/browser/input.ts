/**
 * 受控页面上的输入发送：执行记账、按键集合、按住计时与鼠标事件。
 *
 * 三条不变量：
 *
 * 1. **一份按下账。** 本地只记这次动作按着哪些键（`Keyboard`）用来算下一条事件的字段；
 *    页面上可能还按着什么以 `CdpClient` 的按下表为准，收尾与回执都只认那一份。
 * 2. **按住靠服务端计时。** 时长用本地定时器走完再发下一条事件，不在事件的 `timestamp`
 *    里填将来的时间；定时等待随客户端取消或断开立即结束，不睡满按住时长。
 * 3. **不补发。** 某一段迟到了就照实晚发，不把后面几段的按下与抬起挤在一起补跑。
 */

import { type BrowserExecution, keyEvent, modifierBits } from '@qywork/agent'
import {
  CdpCancelledError,
  type CdpClient,
  CdpDisconnectedError,
  CdpError,
  CdpTimeoutError,
} from './cdp.ts'

/**
 * 一次输入动作的绝对期限。
 *
 * 定位、布局复核、全部业务事件与按住时长合用它，单条命令从剩余预算取小。**不要改成每条
 * 命令各给一份额度**：2000 个码点乘以单条上限，一次调用能挂住几十分钟。它要大于按住时长
 * 的合计上限（`INPUT_LIMITS.totalMs`），给定位与复核留出余量。
 */
export const ACTION_BUDGET_MS = 30_000
/** 单条输入事件的上限。剩余预算更少时按剩余预算发。 */
export const EVENT_TIMEOUT_MS = 5_000
/** 输入收尾的独立预算。业务预算用尽之后仍要能把按下的键与鼠标放开。 */
const TEARDOWN_BUDGET_MS = 3_000

/** 距截止时间还剩多少毫秒。 */
export const leftMs = (deadline: number) => deadline - Date.now()

/** 一条命令的超时：剩余预算与本条上限取小。发命令前由调用方判定预算是否已经耗尽。 */
export function within(deadline: number, capMs: number): { timeoutMs: number } {
  return { timeoutMs: Math.max(1, Math.min(capMs, leftMs(deadline))) }
}

export type Point = { x: number; y: number }

/**
 * 一次输入动作的发送记账。
 *
 * 一个单元就是回执里 `confirmedUnits` 的一格，由调用方在单元完成时 `unit()`。
 * 已发出却没等到确认的那一条决定终态是 `unknown` 而不是 `partial` ——它可能已经在
 * 页面上生效了，说成「没做」会诱使调用方重放。收尾没能确认松开的键同样是 `unknown`。
 */
export class Execution {
  /** 本次动作的绝对期限。定位、布局复核、业务事件与按住时长共用它。 */
  readonly deadline = Date.now() + ACTION_BUDGET_MS
  #confirmed = 0
  #unknown = false
  #finished = false
  #reason: string | null = null
  #unreleased: string[] = []

  /**
   * 还能不能继续发业务事件：没停过、客户端未取消、预算未尽。不能时记下原因。
   */
  open(client: CdpClient): boolean {
    if (this.#reason !== null) return false
    if (client.cancelled) this.stop('执行已停止')
    else if (leftMs(this.deadline) <= 0) this.stop('动作期限已到')
    return this.#reason === null
  }

  /** 计划里的单元一个不少地确认完了。 */
  finish(): void {
    this.#finished = true
  }

  /** 本地判定要停，记下第一个原因。已发出的事件不受影响。 */
  stop(reason: string): void {
    this.#reason ??= reason
  }

  /** 完成一个单元。 */
  unit(): void {
    this.#confirmed += 1
  }

  /**
   * 还能发时发一段事件，返回是否发成。
   *
   * 失败分两类：本地拒绝与协议错误回包都没有在页面上生效，按已确认前缀收场；
   * 超时、断连、取消是「已入网未确认」，整次动作按 `unknown` 收场。
   */
  async run(client: CdpClient, task: () => Promise<void>): Promise<boolean> {
    if (!this.open(client)) return false
    try {
      await task()
      return true
    } catch (err) {
      // 断连的长说明由后续观察那一格给出，这里只记原因本身。
      this.stop(
        err instanceof CdpDisconnectedError
          ? err.detail
          : err instanceof Error
            ? err.message
            : String(err),
      )
      if (
        err instanceof CdpTimeoutError ||
        err instanceof CdpDisconnectedError ||
        err instanceof CdpCancelledError
      ) {
        this.#unknown = true
      }
      return false
    }
  }

  /** 按住 `ms` 毫秒。被取消、断开或期限不够时记下原因并返回 `false`。 */
  async hold(client: CdpClient, ms: number): Promise<boolean> {
    if (ms <= 0) return this.open(client)
    if (ms > leftMs(this.deadline)) {
      this.stop('动作期限已到')
      return false
    }
    if (!(await pause(client.halted, ms))) {
      this.stop(client.cancelled ? '执行已停止' : '控制连接已断开')
      return false
    }
    return this.open(client)
  }

  /** 收尾之后仍未确认松开的键与鼠标键。 */
  unreleased(keys: string[]): void {
    this.#unreleased = keys
  }

  receipt(): BrowserExecution {
    const done = this.#finished && this.#reason === null
    const unreleased = this.#unreleased.length > 0 ? { unreleased: this.#unreleased } : {}
    const state =
      this.#unknown || this.#unreleased.length > 0 ? 'unknown' : done ? 'completed' : 'partial'
    return {
      state,
      confirmedUnits: this.#confirmed,
      ...(state === 'completed' ? {} : { reason: this.#reason ?? '动作没有做完' }),
      ...unreleased,
    }
  }
}

/** 等满 `ms` 返回 `true`；信号置位时立即返回 `false`。 */
function pause(signal: AbortSignal, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 输入收尾：把本客户端还按着的键与鼠标放开，返回这几个会话里仍未确认松开的键码与鼠标键。
 * 成功、失败、取消同一条路径。
 *
 * 用独立的清理预算，不从动作预算里扣：动作预算耗尽正是最需要收尾的时候。
 */
export async function settleInput(
  client: CdpClient,
  sessions: readonly string[],
  run?: Execution,
): Promise<void> {
  const deadline = Date.now() + TEARDOWN_BUDGET_MS
  await client.releaseHeldKeys(deadline)
  await client.releaseHeldMouse(deadline)
  if (!run) return
  const mine = (held: string) => sessions.includes(held.slice(0, held.lastIndexOf('|')))
  const left = [...client.heldKeys(), ...client.heldMouse()].filter(mine)
  run.unreleased(left.map((held) => held.slice(held.lastIndexOf('|') + 1)))
}

/**
 * 一个会话上这次动作按着的键。
 *
 * 只用来算下一条事件的 `key` / `text` / `modifiers`，不是释放依据：释放依据是
 * `CdpClient` 的按下表，见文件头第 1 条。
 */
export class Keyboard {
  #down: string[] = []

  constructor(
    readonly client: CdpClient,
    readonly sessionId: string,
  ) {}

  /** 此刻按着的修饰键的位，鼠标事件的 `modifiers` 取它。 */
  get modifiers(): number {
    return modifierBits(this.#down)
  }

  /**
   * 把按下集合换成 `keys`：先按与按下相反的顺序抬起不再需要的键，再按 `keys` 的顺序按下
   * 新增的键。已经按着的键不重发，页面看到的是一次按下与一次抬起，不是连续重复。
   */
  async to(keys: readonly string[], deadline: number): Promise<void> {
    for (const code of [...this.#down].reverse()) {
      if (keys.includes(code)) continue
      this.#down = this.#down.filter((c) => c !== code)
      await this.#send('keyUp', code, deadline)
    }
    for (const code of keys) {
      if (this.#down.includes(code)) continue
      this.#down.push(code)
      await this.#send('keyDown', code, deadline)
    }
  }

  /**
   * 发一条按键事件。字段按发出那一刻的按下集合算：修饰键自己的按下含自身，抬起不含自身。
   *
   * `nativeVirtualKeyCode` 各平台都填 Windows 虚拟键码，不按宿主平台分支：Windows 上它就是
   * 原生键码；Linux 的 Chrome 154 上填与不填，字符、回车、退格、方向键、Tab、`Ctrl+A`、
   * `Ctrl+Z` 与文本插入的结果完全一致。有字符的按下发 `keyDown` 带 `text`，否则 `rawKeyDown`。
   */
  async #send(type: 'keyDown' | 'keyUp', code: string, deadline: number): Promise<void> {
    const fields = keyEvent(code, this.#down)
    if (!fields) throw new CdpError(`认不出的键码 ${code}`)
    const text = type === 'keyDown' ? fields.text : undefined
    await this.client.send(
      'Input.dispatchKeyEvent',
      {
        type: type === 'keyUp' ? 'keyUp' : text === undefined ? 'rawKeyDown' : 'keyDown',
        key: fields.key,
        code: fields.code,
        windowsVirtualKeyCode: fields.keyCode,
        nativeVirtualKeyCode: fields.keyCode,
        modifiers: fields.modifiers,
        ...(text === undefined ? {} : { text }),
      },
      { sessionId: this.sessionId, ...within(deadline, EVENT_TIMEOUT_MS) },
    )
  }
}

/**
 * 按阶段执行一段按键计划，返回是否全部做完。一个阶段是一个单元。
 *
 * 每个阶段先换按下集合、再按住它的时长。`guard` 在第二个阶段起每次换集合之前调用，
 * 返回非空即停——文档换了之后，计划的后半段不能落到新页面上。最后一个阶段按完之后
 * 全部抬起；中途停下时由调用方的收尾放开。
 */
export async function runKeyPhases(
  keyboard: Keyboard,
  phases: readonly { keys: readonly string[]; durationMs?: number }[],
  run: Execution,
  guard: () => Promise<string | null>,
): Promise<boolean> {
  const { client } = keyboard
  for (const [i, phase] of phases.entries()) {
    if (i > 0 && run.open(client)) {
      const problem = await guard()
      if (problem) {
        run.stop(problem)
        return false
      }
    }
    if (!(await run.run(client, () => keyboard.to(phase.keys, run.deadline)))) return false
    if (!(await run.hold(client, phase.durationMs ?? 0))) return false
    run.unit()
  }
  return run.run(client, () => keyboard.to([], run.deadline))
}

/** 发一条鼠标事件。坐标必须属于接收命令的会话本地根，不能把顶层坐标交给子帧。 */
export async function mouseEvent(
  client: CdpClient,
  sessionId: string,
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
  point: Point,
  extra: Record<string, unknown>,
  deadline?: number,
): Promise<void> {
  await client.send(
    'Input.dispatchMouseEvent',
    { type, x: point.x, y: point.y, ...extra },
    { sessionId, ...(deadline === undefined ? {} : within(deadline, EVENT_TIMEOUT_MS)) },
  )
}

/**
 * 把指针移到落点。按下之前必须先发这一条。
 *
 * 让页面先收到指针进入与悬停，再按下。移动不构成渲染同步，不能靠它保证跨帧命中；
 * 调用方必须传入目标会话及其坐标。它不计入点击或拖动回执的单元数。
 */
export async function aimAt(
  client: CdpClient,
  sessionId: string,
  point: Point,
  modifiers: number,
  deadline?: number,
): Promise<void> {
  await mouseEvent(
    client,
    sessionId,
    'mouseMoved',
    point,
    { button: 'none', buttons: 0, modifiers },
    deadline,
  )
}
