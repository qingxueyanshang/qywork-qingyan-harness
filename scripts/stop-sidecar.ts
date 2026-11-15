/**
 * 开发脚本停止 sidecar 的方式，与桌面外壳相同（`apps/desktop/src-tauri/src/sidecar.rs` 的 `stop_child`）：
 * 经标准输入写入 `stop`，限时等待它自行退出，超时后终止进程。
 *
 * 不要改为直接终止：sidecar 的停止流程因此不执行，运行中的命令进程树、MCP 与插件都不会结束。
 */

/** 等待 sidecar 自行退出的上限，与外壳的 `STOP_GRACE` 取同一值。 */
export const STOP_GRACE_MS = 5_000

/** 停止所需的进程成员。Bun 以 `stdin: 'pipe'` 启动的子进程直接满足。 */
export interface StoppableSidecar {
  readonly exitCode: number | null
  readonly signalCode: string | null
  readonly exited: Promise<number>
  readonly stdin: { write(data: string): unknown; flush(): unknown }
  kill(): void
}

/**
 * 返回 sidecar 是否在时限内自行退出。指令写入失败或超时即终止进程，返回时进程均已退出。
 * `graceMs` 缺省为 `STOP_GRACE_MS`，仅供回归测试缩短等待。
 */
export async function stopSidecar(
  proc: StoppableSidecar,
  graceMs = STOP_GRACE_MS,
): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return true
  let requested = true
  try {
    proc.stdin.write('stop\n')
    proc.stdin.flush()
  } catch {
    requested = false
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const exitedInTime =
    requested &&
    (await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs)
      }),
    ]))
  clearTimeout(timer)
  if (!exitedInTime) {
    proc.kill()
    await proc.exited
  }
  return exitedInTime
}
