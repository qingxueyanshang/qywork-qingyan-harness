/**
 * 开发实例远程访问的网页：sidecar 以 `--static` 提供的构建产物，源码变化后由本模块重新构建。
 *
 * - 云端按文件名缓存构建产物中带内容哈希的文件；Vite 开发服务器的模块不带哈希，不能用于远程访问。
 * - 每次构建到新目录：运行中的 sidecar 继续提供自己的目录，换代后才删除更早的目录（`pruneBuilds`）。
 * - 源码变化后，构建成功才通知换代（`onBuilt`）。不要改为在 sidecar 的更新占位期间构建：占位期间全部指令以
 *   「应用正在更新」被拒绝，构建约需 10 秒。构建失败时不换代，下一次源码变化再构建，前后端仍同时换代。
 * - 首次构建（`start`）在后台进行，sidecar 同时启动并提供该目录：sidecar 按请求读取文件，构建完成前入口返回纯文本，
 *   云端只缓存 HTML 入口，不会缓存这段时间的响应。
 * - 构建期间再次变化时，本次结束后再构建一次，不并发构建。
 */

import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface RemoteWebDeps {
  /** 构建到 `dir`，成功返回 true。 */
  build(dir: string): Promise<boolean>
  /** 下一次构建的目录，目录名为递增的序号（`pruneBuilds` 按序号比较）。 */
  nextDir(): string
  /** 源码变化后的一次构建成功，产物在 `dir`。 */
  onBuilt(dir: string): void
  /** 一次保存通常连续产生多个事件，合并后再构建。 */
  debounceMs: number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  log(line: string): void
}

export interface RemoteWebBuilder {
  /** 首次构建：立即返回目录供 sidecar 启动时使用，在后台构建，不通知换代。 */
  start(): string
  /** 源码已变化。 */
  changed(): void
  /** sidecar 应提供的目录：首次构建的目录，或最近一次成功构建的目录。 */
  current(): string
}

export function createRemoteWebBuilder(deps: RemoteWebDeps): RemoteWebBuilder {
  let current = ''
  let timer: unknown = null
  let building = false
  let dirty = false

  const build = async (dir: string): Promise<boolean> => {
    const ok = await deps.build(dir)
    if (!ok) deps.log('远程访问的网页构建失败，sidecar 暂不换代，详见上方输出')
    return ok
  }

  /** 构建结束后处理期间积累的变化，直到没有新变化。 */
  const drain = async (): Promise<void> => {
    while (dirty) {
      dirty = false
      const dir = deps.nextDir()
      if (await build(dir)) {
        current = dir
        deps.onBuilt(dir)
      }
    }
  }

  const run = (first: Promise<unknown>): void => {
    building = true
    void first.then(drain).finally(() => {
      building = false
    })
  }

  return {
    start: () => {
      current = deps.nextDir()
      run(build(current))
      return current
    },
    changed: () => {
      if (building) {
        dirty = true
        return
      }
      if (timer !== null) deps.clearTimer(timer)
      timer = deps.setTimer(() => {
        timer = null
        dirty = true
        if (!building) run(Promise.resolve())
      }, deps.debounceMs)
    },
    current: () => current,
  }
}

/** 删除 `root` 下序号小于 `keep` 的构建目录；名称不是序号的条目不处理。 */
export function pruneBuilds(root: string, keep: string): void {
  const kept = Number(keep)
  for (const name of readdirSync(root)) {
    if (/^\d+$/.test(name) && Number(name) < kept) {
      rmSync(join(root, name), { recursive: true, force: true })
    }
  }
}
