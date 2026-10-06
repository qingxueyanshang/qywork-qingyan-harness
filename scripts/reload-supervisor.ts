/**
 * 判定何时可以替换代码。
 *
 * 从 `dev.ts` 中独立出来，因为放在脚本顶层无法测试：防抖合并、有进行中的 run 时不替换、
 * 替换过程中出现新改动，这三项均依赖时序，时序错误表现为偶发中断一轮，
 * 难以复现。本文件只保留策略，启动进程、结束进程、等待就绪由调用方注入。
 *
 * 判据有两条，缺一不可：文件已变化，且该 sidecar 没有未执行完毕的 run。
 * 只看第一条即为 `bun --watch` 的行为，代价是中断执行到一半的那一轮。
 */

export interface ReloadDeps {
  /** 该 sidecar 是否还有未执行完毕的 run。 */
  busy(): boolean | Promise<boolean>
  /** 执行代码替换：结束旧进程、启动新进程、等待就绪。抛错不致命，下一次改动会再次触发。 */
  restart(): Promise<void>
  /** 一次保存通常连续产生多个事件（编辑器先写临时文件再改名），合并后再处理。 */
  debounceMs: number
  /** 有任务进行时的复查间隔。 */
  idlePollMs: number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  log(line: string): void
}

export interface ReloadSupervisor {
  /** 源码已变化。多次调用合并为一次处理。 */
  onChange(): void
  /**
   * sidecar 自行退出（崩溃、被其他进程结束、内部执行到 `process.exit`）。
   *
   * 不重新启动时界面无法连接后端：WebSocket 断开后，前端只显示
   * 「已 N 秒没有新数据」，停止按钮没有接收端，只能重启应用恢复，
   * 而窗口外观正常，用户无从得知需要重启。
   *
   * 连续启动失败后不再重试：启动失败通常是端口仍被占用或代码本身无法编译，
   * 无限重试只会填满终端，而真正的原因在第一条报错中。
   */
  onExit(code: number | null): void
}

/** Windows 控制台中断可能保留 NTSTATUS，也可能被 Bun 截断为低 8 位退出码。 */
export function isConsoleInterrupt(code: number | null, platform = process.platform): boolean {
  return platform === 'win32' && code !== null && (code === 58 || code >>> 0 === 0xc000013a)
}

export function createReloadSupervisor(deps: ReloadDeps): ReloadSupervisor {
  let timer: unknown = null
  let reloading = false
  let checking = false
  let generation = 0
  let crashes = 0

  const schedule = (ms: number): void => {
    if (timer !== null) deps.clearTimer(timer)
    timer = deps.setTimer(() => void tick(), ms)
  }

  const tick = async (): Promise<void> => {
    timer = null
    // 替换过程中出现新改动：排到之后处理，不并发执行两次替换。
    if (reloading || checking) return schedule(deps.debounceMs)
    const checkedGeneration = generation
    checking = true
    try {
      if (await deps.busy()) return schedule(deps.idlePollMs)
    } catch (err) {
      deps.log(`无法确认任务空闲，稍后重试：${err instanceof Error ? err.message : String(err)}`)
      return schedule(deps.idlePollMs)
    } finally {
      checking = false
    }
    // 查询期间旧进程可能自行退出，不能依据该查询结果再重启刚重新启动的新进程。
    if (checkedGeneration !== generation) return schedule(deps.debounceMs)
    reloading = true
    generation++
    try {
      deps.log('源码已变更且当前无运行中的任务，重启 sidecar')
      await deps.restart()
      // 替换成功说明当前源码树可以正常运行，此前的崩溃次数不再计入。
      crashes = 0
    } catch (err) {
      deps.log(`重启 sidecar 失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      // 必须在 finally 中复位：restart 抛错而该标志未复位时，
      // 此后每次改动都只会排到队尾，不再替换代码，且没有任何提示。
      reloading = false
    }
  }

  const onExit = (code: number | null): void => {
    // 替换代码时的退出由 supervisor 自身发起，不是崩溃。
    if (reloading) return
    generation++
    crashes++
    if (crashes > MAX_CRASH_RESTARTS) {
      deps.log(
        `sidecar 连续 ${crashes} 次启动失败（最后退出码 ${code}），不再重试，详见上方错误输出`,
      )
      return
    }
    deps.log(`sidecar 已退出（退出码 ${code}），正在重启`)
    reloading = true
    void deps
      .restart()
      .catch((err) =>
        deps.log(`重启 sidecar 失败：${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => {
        reloading = false
      })
  }

  return { onChange: () => schedule(deps.debounceMs), onExit }
}

/**
 * 连续启动失败达到该次数后放弃。
 *
 * 启动失败的原因通常是端口仍被占用或代码本身无法运行，无限重试只会填满终端，
 * 而真正的原因在第一条报错中。计数在成功替换一次代码之后重置，不按时间重置：
 * 按时间重置时，每 30 秒崩溃一次的 sidecar 会无限重试。
 */
const MAX_CRASH_RESTARTS = 3

/**
 * 判定该文件的变化是否属于源码变化。
 *
 * `dist/` 与 `node_modules/` 也在 `packages` 下，构建产物落盘不应触发替换代码；
 * `.test.ts` 不在 sidecar 的 import 图中，替换后不产生效果。
 *
 * 递归 watch 传入的是带子目录的相对路径（形如 `tools\src\files.ts`），
 * 因此可以判断 `/src/`；若只取得文件名，该过滤不会命中任何条目，
 * 结果是修改源码后不替换代码，且不报错。
 */
export function isSourceChange(file: unknown): boolean {
  if (typeof file !== 'string') return false
  const path = file.replaceAll('\\', '/')
  return path.endsWith('.ts') && !path.endsWith('.test.ts') && path.includes('/src/')
}

/**
 * `apps/web/src` 下的文件变化是否会改变正在运行的页面。
 *
 * watch 的根已限定在 web/src，因此无需再判断目录，只排除测试。扩展名不设白名单：
 * TSX、CSS、字体和图片都可能进入 Vite 的模块图，遗漏任意一种都会再次出现
 * 「后端已替换、前端仍为旧代码」的时间窗口。
 */
export function isWebSourceChange(file: unknown): boolean {
  if (typeof file !== 'string') return false
  const path = file.replaceAll('\\', '/')
  if (!path || path.endsWith('/')) return false
  return !/(^|\/)(__tests__)(\/|$)/.test(path) && !/\.(test|spec)\.[^/]+$/.test(path)
}
