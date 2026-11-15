/**
 * 画布服务：对 `*.canvas.json` 的写入与画布上的生成只经由此实例执行。界面经由 `api/canvas.ts`，
 * Agent 经由 `CanvasPort`（`port.ts`），两处调用同一个实例。
 *
 * 本类只做装配与关闭：`docs`（文档的读取与写入）、`runs`（生成）、`exports`（导出会话）、`assets`（取帧、上传与渲染）
 * 共用同一个 `CanvasDocs` 与同一份 `CanvasStates`。新能力加在对应的部分中。
 */

import { CanvasAssets } from './assets.ts'
import { CanvasDocs, type CanvasDocsDeps } from './docs.ts'
import { CanvasExports, type CanvasExportsDeps } from './exports.ts'
import { CanvasRuns, type CanvasRunsDeps } from './runs.ts'
import { CanvasStates } from './states.ts'

export type CanvasServiceDeps = CanvasDocsDeps & CanvasRunsDeps & CanvasExportsDeps

export class CanvasService {
  private readonly shutdown = new AbortController()
  readonly docs: CanvasDocs
  readonly runs: CanvasRuns
  readonly exports: CanvasExports
  readonly assets: CanvasAssets

  constructor(deps: CanvasServiceDeps) {
    const states = new CanvasStates()
    this.docs = new CanvasDocs(deps, states)
    this.exports = new CanvasExports(this.docs, deps)
    this.runs = new CanvasRuns(this.docs, states, deps, this.shutdown.signal, (root) =>
      this.exports.sweepExports(root),
    )
    this.assets = new CanvasAssets(this.docs)
  }

  /** 停止本地等待，保留远端任务记录；结束进行中的导出并删除临时文件；等待收尾完成后再关闭账本。 */
  async stop(): Promise<void> {
    this.shutdown.abort()
    await this.exports.stop()
    await this.runs.drain()
  }
}
