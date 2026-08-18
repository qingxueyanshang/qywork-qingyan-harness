/**
 * 什么时候可以换代码。
 *
 * 从 `dev.ts` 里抽出来是因为**它在脚本顶层就测不到**：防抖合并、有活时不换、
 * 换的过程中又来改动这三件事全是时序，而时序错了的表现是「偶尔打断一轮」——
 * 那种 bug 不会有人复现给你看。这里只留策略，起进程/杀进程/等就绪由调用方注入。
 *
 * 判据是两条，缺一不可：**文件变了**，**且这个 sidecar 手上没有没跑完的 run**。
 * 只看第一条就是 `bun --watch` 的行为，代价是把跑到一半的那轮从中间掐断。
 */

export interface ReloadDeps {
  /** 这个 sidecar 手上还有没有没跑完的 run。 */
  busy(): boolean
  /** 真去换代码：杀掉旧的、起新的、等就绪。抛错不致命，下一次改动还会再来。 */
  restart(): Promise<void>
  /** 一次保存常常连着来好几个事件（编辑器先写临时文件再改名），攒一下再动。 */
  debounceMs: number
  /** 手上有活时多久回来看一眼。 */
  idlePollMs: number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  log(line: string): void
}

export interface ReloadSupervisor {
  /** 有源码变了。反复调用只会合并成一次。 */
  onChange(): void
}

export function createReloadSupervisor(deps: ReloadDeps): ReloadSupervisor {
  let timer: unknown = null
  let reloading = false

  const schedule = (ms: number): void => {
    if (timer !== null) deps.clearTimer(timer)
    timer = deps.setTimer(() => void tick(), ms)
  }

  const tick = async (): Promise<void> => {
    timer = null
    // 正在换的时候又有改动：排到后面去，不要并发两个换代码。
    if (reloading) return schedule(deps.debounceMs)
    if (deps.busy()) return schedule(deps.idlePollMs)

    reloading = true
    deps.log('源码变了且手上没有 run，换代码')
    try {
      await deps.restart()
    } catch (err) {
      deps.log(`换代码失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      // **必须在 finally 里放**：restart 抛出去而这个标志还立着的话，
      // 此后每一次改动都只会被排到后面，再也不会换代码，而且一声不吭。
      reloading = false
    }
  }

  return { onChange: () => schedule(deps.debounceMs) }
}

/**
 * 这个文件变了算不算「源码变了」。
 *
 * `dist/` 与 `node_modules/` 也在 `packages` 底下，构建产物落盘不该换代码；
 * `.test.ts` 不在 sidecar 的 import 图里，换了也白换。
 *
 * 递归 watch 给的是**带子目录的相对路径**（`tools\src\files.ts` 这种形状），
 * 所以这里判得了 `/src/`；要是哪天只拿到文件名，这个过滤会一条都不命中——
 * 表现是「改了源码它就是不换」，而不是报错。
 */
export function isSourceChange(file: unknown): boolean {
  if (typeof file !== 'string') return false
  const path = file.replaceAll('\\', '/')
  return path.endsWith('.ts') && !path.endsWith('.test.ts') && path.includes('/src/')
}
