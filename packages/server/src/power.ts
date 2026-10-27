/**
 * 系统电源：任务运行期间阻止系统因空闲而睡眠，并在下一次定时任务到期时唤醒系统。
 *
 * 两项都由已有的权威推导，本模块不保存任务状态：忙态取自 RunManager 与画布服务，下次触发时刻
 * 取自定时任务表。每个 tick 重新读取并同步到系统，只在取值变化时调用系统接口。
 *
 * 阻止的只是空闲超时：用户手动睡眠、合盖、关闭显示器都不受影响。
 */

import { dlopen, FFIType, type Pointer, ptr } from 'bun:ffi'
import { log } from '@qywork/core'

/**
 * 每 10 秒同步一次。
 *
 * 唤醒定时器唤醒的系统在无人操作时约 2 分钟后再次睡眠（Windows 的无人参与睡眠超时）。调度 tick
 * 在唤醒后 30 秒内开始执行到期任务，本模块须在剩余时间内取得请求。
 */
const POWER_TICK_MS = 10_000

export interface PowerPort {
  /** 持有或释放「系统保持运行」请求。 */
  hold(on: boolean): void
  /** 在该时刻（毫秒时间戳）唤醒系统；null 取消。不支持唤醒的平台忽略。 */
  wakeAt(at: number | null): void
}

export interface PowerGuardDeps {
  /** 是否有任务在运行。 */
  busy(): boolean
  /** 下一次定时任务的触发时刻；没有时为 null。 */
  nextWakeAt(): number | null
  port: PowerPort
}

/**
 * 启动时立即同步一次，此后每个 tick 同步一次。`stop()` 释放请求并取消唤醒。
 *
 * 读取失败（账本异常）只写日志：计时器回调中未捕获的异常会终止进程。
 */
export function startPowerGuard(
  deps: PowerGuardDeps,
  tickMs = POWER_TICK_MS,
): { sync(): void; stop(): void } {
  let held = false
  let wake: number | null = null
  const sync = () => {
    try {
      const busy = deps.busy()
      if (busy !== held) {
        deps.port.hold(busy)
        held = busy
      }
      const at = deps.nextWakeAt()
      if (at !== wake) {
        deps.port.wakeAt(at)
        wake = at
      }
    } catch (err) {
      log.error(
        'power',
        `同步系统电源状态失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  sync()
  const timer = setInterval(sync, tickMs)
  timer.unref?.()
  return {
    sync,
    stop() {
      clearInterval(timer)
      if (held) deps.port.hold(false)
      if (wake !== null) deps.port.wakeAt(null)
      held = false
      wake = null
    },
  }
}

/** 当前平台的系统接口；平台不支持或系统接口无法加载时返回 null，并写日志。 */
export function systemPowerPort(): PowerPort | null {
  try {
    if (process.platform === 'win32') return windowsPort()
    if (process.platform === 'darwin') {
      return childPort(['caffeinate', '-i', '-w', String(process.pid)])
    }
    if (process.platform === 'linux') {
      return childPort([
        'systemd-inhibit',
        '--what=idle:sleep',
        '--who=qywork',
        '--why=任务运行中',
        'tail',
        `--pid=${process.pid}`,
        '-f',
        '/dev/null',
      ])
    }
  } catch (err) {
    log.error('power', `无法加载系统电源接口：${err instanceof Error ? err.message : String(err)}`)
  }
  return null
}

const ES_CONTINUOUS = 0x80000000
const ES_SYSTEM_REQUIRED = 0x00000001
/** 1601-01-01 与 1970-01-01 之间的毫秒数。 */
const FILETIME_EPOCH_MS = 11_644_473_600_000n

/**
 * Windows：`SetThreadExecutionState` 的状态按线程保存，此处只在 JS 主线程调用；主线程与进程同生命期，
 * 进程退出时系统自动收回请求。唤醒使用可唤醒系统的等待定时器，句柄常驻进程内，进程退出时随之销毁。
 * 能否唤醒由电源选项「允许使用唤醒定时器」决定。
 */
function windowsPort(): PowerPort {
  const { symbols: k } = dlopen('kernel32.dll', {
    SetThreadExecutionState: { args: [FFIType.u32], returns: FFIType.u32 },
    CreateWaitableTimerW: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
    SetWaitableTimer: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    CancelWaitableTimer: { args: [FFIType.ptr], returns: FFIType.i32 },
  })
  let timer: Pointer | null = null
  return {
    hold(on) {
      if (
        k.SetThreadExecutionState(on ? ES_CONTINUOUS | ES_SYSTEM_REQUIRED : ES_CONTINUOUS) === 0
      ) {
        log.error('power', on ? '无法阻止系统睡眠' : '无法释放阻止睡眠的请求')
      }
    },
    wakeAt(at) {
      if (at === null) {
        if (timer) k.CancelWaitableTimer(timer)
        return
      }
      timer ??= k.CreateWaitableTimerW(null, 1, null)
      // 正值为绝对时刻，以 FILETIME 表示：自 1601-01-01 起的 100 纳秒数。
      const due = new BigInt64Array([(BigInt(at) + FILETIME_EPOCH_MS) * 10_000n])
      if (!timer || k.SetWaitableTimer(timer, ptr(due), 0, null, null, 1) === 0) {
        log.error('power', '无法设置唤醒定时器', { at })
      }
    },
  }
}

/**
 * macOS 与 Linux：持有期间运行一个子进程，由它向系统登记请求，释放时结束该子进程。子进程在本进程
 * 退出后自行结束（`caffeinate -w`、`tail --pid`），本进程崩溃时请求不会残留。
 * 这两个平台的定时唤醒需要管理员权限（`pmset`、`rtcwake`），不设置。
 */
function childPort(cmd: string[]): PowerPort {
  let child: ReturnType<typeof Bun.spawn> | null = null
  return {
    hold(on) {
      const current = child
      child = null
      current?.kill()
      if (!on) return
      try {
        const proc = Bun.spawn(cmd, { stdio: ['ignore', 'ignore', 'ignore'] })
        child = proc
        void proc.exited.then((code) => {
          if (child === proc)
            log.error('power', `阻止睡眠的进程已退出（${cmd[0]}，退出码 ${code}）`)
        })
      } catch (err) {
        log.error('power', `无法阻止系统睡眠：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    wakeAt() {},
  }
}
