/**
 * 受控页面上的输入发送：执行记账、按键集合、按住计时与鼠标事件。
 *
 * 三条不变量：
 *
 * 1. **按下状态只有一份记录。** 本地只记录本次动作按下的键（`Keyboard`），用于计算下一条事件的字段；
 *    页面上可能仍处于按下状态的键以 `CdpClient` 的按下表为准，收尾与回执只以该表为准。
 * 2. **按住时长由服务端计时。** 本地定时器计满时长后再发送下一条事件，不在事件的 `timestamp`
 *    中填写将来的时间；定时等待在客户端取消或断开时立即结束，不等满按住时长。
 * 3. **不补发。** 某一段延迟时按实际时间推后发送，不将后续各段的按下与抬起集中补发。
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
 * 定位、布局复核、全部业务事件与按住时长共用该期限，单条命令取剩余预算与单条上限的较小值。**不要改成每条
 * 命令各分配一份额度**：2000 个码点乘以单条上限，一次调用可阻塞数十分钟。该期限须大于按住时长
 * 的合计上限（`INPUT_LIMITS.totalMs`），为定位与复核留出余量。
 */
export const ACTION_BUDGET_MS = 30_000
/** 单条输入事件的上限。剩余预算更少时按剩余预算发。 */
export const EVENT_TIMEOUT_MS = 5_000
/** 输入收尾的独立预算。业务预算用尽之后仍须能够释放按下的键与鼠标键。 */
const TEARDOWN_BUDGET_MS = 3_000

/** 距截止时间的剩余毫秒数。 */
export const leftMs = (deadline: number) => deadline - Date.now()

/** 一条命令的超时：取剩余预算与本条上限中的较小值。发送命令前由调用方判定预算是否已耗尽。 */
export function within(deadline: number, capMs: number): { timeoutMs: number } {
  return { timeoutMs: Math.max(1, Math.min(capMs, leftMs(deadline))) }
}

export type Point = { x: number; y: number }

/**
 * 一次输入动作的发送记账。
 *
 * 一个单元对应回执中 `confirmedUnits` 的一次计数，由调用方在单元完成时调用 `unit()`。
 * 存在已发出但未确认的事件时，终态为 `unknown` 而不是 `partial`：该事件可能已在
 * 页面上生效，报告为未执行会导致调用方重放。收尾时未能确认释放的键同样使终态为 `unknown`。
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
   * 判断能否继续发送业务事件：未停止、客户端未取消、预算未耗尽。不能继续时记录原因。
   */
  open(client: CdpClient): boolean {
    if (this.#reason !== null) return false
    if (client.cancelled) this.stop('执行已停止')
    else if (leftMs(this.deadline) <= 0) this.stop('动作期限已到')
    return this.#reason === null
  }

  /** 计划中的全部单元均已确认。 */
  finish(): void {
    this.#finished = true
  }

  /** 本地判定停止，记录第一个原因。已发出的事件不受影响。 */
  stop(reason: string): void {
    this.#reason ??= reason
  }

  /** 完成一个单元。 */
  unit(): void {
    this.#confirmed += 1
  }

  /**
   * 可以继续发送时发送一段事件，返回是否发送成功。
   *
   * 失败分两类：本地拒绝与协议错误响应均未在页面上生效，按已确认的前缀结束；
   * 超时、断开与取消属于「已发出未确认」，整次动作以 `unknown` 结束。
   */
  async run(client: CdpClient, task: () => Promise<void>): Promise<boolean> {
    if (!this.open(client)) return false
    try {
      await task()
      return true
    } catch (err) {
      // 断开连接的完整说明由后续观察的 `observationError` 给出，此处只记录原因。
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

  /** 按住 `ms` 毫秒。被取消、断开或期限不足时记录原因并返回 `false`。 */
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

  /** 收尾之后仍未确认释放的键与鼠标键。 */
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
      ...(state === 'completed' ? {} : { reason: this.#reason ?? '动作未完成' }),
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
 * 输入收尾：释放本客户端仍按下的键与鼠标键，返回这些会话中仍未确认释放的键码与鼠标键。
 * 成功、失败与取消使用同一路径。
 *
 * 使用独立的清理预算，不从动作预算中扣除：动作预算耗尽时仍须完成收尾。
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
 * 本次动作在一个会话上按下的键。
 *
 * 只用于计算下一条事件的 `key` / `text` / `modifiers`，不作为释放依据：释放依据是
 * `CdpClient` 的按下表，见文件头第 1 条。
 */
export class Keyboard {
  #down: string[] = []

  constructor(
    readonly client: CdpClient,
    readonly sessionId: string,
  ) {}

  /** 当前按下的修饰键位，鼠标事件的 `modifiers` 取此值。 */
  get modifiers(): number {
    return modifierBits(this.#down)
  }

  /**
   * 将按下集合更换为 `keys`：先按与按下相反的顺序抬起不再需要的键，再按 `keys` 的顺序按下
   * 新增的键。已按下的键不重发，页面收到的是一次按下与一次抬起，而不是连续重复。
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
   * 发送一条按键事件。字段按发送时刻的按下集合计算：修饰键按下时包含自身，抬起时不包含自身。
   *
   * `nativeVirtualKeyCode` 在各平台均填写 Windows 虚拟键码，不按宿主平台分支：在 Windows 上它即为
   * 原生键码；在 Linux 的 Chrome 154 上，无论是否填写，字符、回车、退格、方向键、Tab、`Ctrl+A`、
   * `Ctrl+Z` 与文本插入的结果完全一致。带字符的按下发送带 `text` 的 `keyDown`，否则发送 `rawKeyDown`。
   */
  async #send(type: 'keyDown' | 'keyUp', code: string, deadline: number): Promise<void> {
    const fields = keyEvent(code, this.#down)
    if (!fields) throw new CdpError(`无法识别的键码 ${code}`)
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
 * 按阶段执行一段按键计划，返回是否全部完成。一个阶段是一个单元。
 *
 * 每个阶段先更换按下集合，再按住该阶段的时长。从第二个阶段起，每次更换集合之前调用 `guard`，
 * 返回非空即停止：文档更换之后，计划的后续部分不得作用于新页面。最后一个阶段完成之后
 * 全部抬起；中途停止时由调用方的收尾释放。
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

/** 发送一条鼠标事件。坐标必须属于接收命令的会话的本地根，不得将顶层坐标交给子帧。 */
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
 * 将指针移到落点。按下之前必须先发送此事件。
 *
 * 使页面先收到指针进入与悬停，再收到按下。移动不构成渲染同步，不能依靠它保证跨帧命中；
 * 调用方必须传入目标会话及其坐标。该事件不计入点击或拖动回执的单元数。
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
