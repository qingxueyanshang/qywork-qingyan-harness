/** 时间线导出成片与 Art 节点录制视频的上传会话，以及大模型发起、等待界面完成的导出请求。 */

import { randomUUID } from 'node:crypto'
import { type FileHandle, mkdir, open, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canvasMediaOf, displayNameOf } from '@qywork/core'
import { freeLandingPath, renameWithRetry } from '@qywork/tools'
import {
  type CanvasDocs,
  type CanvasDocsDeps,
  CanvasFailure,
  type CanvasWorkspace,
} from './docs.ts'
import { keyOf } from './states.ts'

/** 导出所需的依赖，由 `CanvasService` 的依赖中取用。 */
export interface CanvasExportsDeps extends Pick<CanvasDocsDeps, 'publish'> {
  /** 导出会话无写入时的作废时限（毫秒）。只在测试中缩短。 */
  exportIdleMs?: number
  /** 大模型请求导出后等待界面开始导出的时限（毫秒）。只在测试中缩短。 */
  exportClaimMs?: number
}

/**
 * 大模型发起的一次时间线导出：等待界面以现有的导出会话完成它。`claimed` 为界面开始导出后的会话号，
 * 之前为 null；`timer` 在界面开始导出之前计时，到期即失败（没有界面接手）。
 */
interface ExportRequest {
  claimed: string | null
  timer: ReturnType<typeof setTimeout>
  done: Promise<{ nodeId: string; path: string }>
  resolve: (r: { nodeId: string; path: string }) => void
  reject: (err: Error) => void
}

/** 时间线导出的上传会话。`part` 是正在写入的临时文件的绝对路径，`target` 是预期的工作区路径（完成时再按重名规则选定）。 */
interface ExportSession {
  root: string
  canvas: string
  source: string
  target: string
  part: string
  /** 先登记会话、再创建文件：启动清理按会话号判断临时文件是否在用，后登记会误删正在创建的文件。 */
  file: Promise<FileHandle>
  timer: ReturnType<typeof setTimeout>
}

/** 成片与导出临时文件所在的工作区目录。 */
const EXPORT_DIR = 'generated'
/** 导出临时文件名 `.<会话号>.part`。启动清理只删除此格式的文件，不涉及生成写入的 `.part` 与用户文件。 */
const EXPORT_PART = /^\.([0-9a-f-]{36})\.part$/

/** 导出会话的空闲上限：编码一块数据不会超过此时长，超过即表明浏览器端已断开。 */
const EXPORT_IDLE_MS = 10 * 60_000
/** 大模型请求导出后，界面打开画布并开始导出的上限：超过即视为没有界面接手。 */
const EXPORT_CLAIM_MS = 30_000

export class CanvasExports {
  private readonly exports = new Map<string, ExportSession>()
  private readonly exportIdleMs: number
  /** 大模型发起、尚未结束的导出。键与 `CanvasStates.running` 相同：`画布绝对路径#节点 id`。 */
  private readonly exportRequests = new Map<string, ExportRequest>()
  private readonly exportClaimMs: number

  constructor(
    private readonly docs: CanvasDocs,
    private readonly deps: CanvasExportsDeps,
  ) {
    this.exportIdleMs = deps.exportIdleMs ?? EXPORT_IDLE_MS
    this.exportClaimMs = deps.exportClaimMs ?? EXPORT_CLAIM_MS
  }

  /**
   * 大模型导出时间线：向界面发出 `canvas.export`，界面打开该画布并执行与「导出」按钮相同的导出，
   * 本方法等待该时间线的导出会话完成，返回新增的视频卡与成片的工作区路径。编码只有界面一处（`renderTimeline`），
   * 成片与用户点击导出得到的完全相同。
   *
   * `exportClaimMs` 内没有界面开始导出（界面未打开该项目、命令行运行）时失败；界面导出失败或被取消时以其原因失败。
   * `signal` 中止即停止这次导出（`cancelRequest`）：界面已开始导出时结束其导出会话，界面的下一次写入被拒绝；
   * 未开始时撤销请求，界面随后以请求开始导出时被拒绝。同一时间线已有进行中的请求时等待同一次导出，停止对等待它的各方都生效。
   */
  async requestExport(
    ws: CanvasWorkspace,
    path: string,
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<{ nodeId: string; path: string }> {
    const abs = await this.docs.locate(ws.root, path)
    const rel = await this.docs.relativeTo(ws.root, abs)
    const node = (await this.docs.load(abs)).nodes.find((n) => n.id === nodeId)
    if (!node) throw new CanvasFailure(`目标已不存在：${nodeId}`, 404)
    if (node.type !== 'timeline') throw new CanvasFailure('只有时间线能导出成片', 422)
    if (!node.clips.length) throw new CanvasFailure('时间线中没有片段', 422)
    const key = `${keyOf(ws.root, path)}#${nodeId}`
    let request = this.exportRequests.get(key)
    if (!request) {
      let resolve!: ExportRequest['resolve']
      let reject!: ExportRequest['reject']
      const done = new Promise<{ nodeId: string; path: string }>((ok, fail) => {
        resolve = ok
        reject = fail
      })
      // 没有调用方等待时（均已中止）失败不应成为未处理的拒绝。
      done.catch(() => {})
      const fresh: ExportRequest = {
        claimed: null,
        done,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (fresh.claimed !== null) return
          this.settleExport(
            key,
            new CanvasFailure(
              '没有界面开始导出：qywork 界面未打开该项目，或画布无法在界面中打开；界面打开后重新导出',
              409,
            ),
          )
        }, this.exportClaimMs),
      }
      request = fresh
      this.exportRequests.set(key, request)
      this.deps.publish({ type: 'canvas.export', workspaceId: ws.id, path: rel, nodeId })
    }
    const waiting = request.done
    if (!signal) return waiting
    if (signal.aborted) {
      await this.cancelRequest(key)
      throw new CanvasFailure('已停止导出', 409)
    }
    return new Promise((resolve, reject) => {
      const stop = () => {
        void this.cancelRequest(key)
        reject(new CanvasFailure('已停止导出', 409))
      }
      signal.addEventListener('abort', stop, { once: true })
      waiting.then(
        (r) => {
          signal.removeEventListener('abort', stop)
          resolve(r)
        },
        (err: Error) => {
          signal.removeEventListener('abort', stop)
          reject(err)
        },
      )
    })
  }

  /** 停止大模型发起的一次导出：界面已开始时结束其导出会话（同时结束该请求），未开始时撤销请求。 */
  private async cancelRequest(key: string): Promise<void> {
    const request = this.exportRequests.get(key)
    if (!request) return
    if (request.claimed) await this.dropExport(request.claimed)
    else this.settleExport(key, new CanvasFailure('已停止导出', 409))
  }

  /** 结束一次大模型发起的导出：给出结果或失败原因。 */
  private settleExport(key: string, outcome: { nodeId: string; path: string } | Error): void {
    const request = this.exportRequests.get(key)
    if (!request) return
    this.exportRequests.delete(key)
    clearTimeout(request.timer)
    if (outcome instanceof Error) request.reject(outcome)
    else request.resolve(outcome)
  }

  /** 会话 `id` 认领的大模型导出请求的键；没有时为 undefined。 */
  private requestOf(id: string): string | undefined {
    for (const [key, request] of this.exportRequests) if (request.claimed === id) return key
    return undefined
  }

  /**
   * 时间线导出成片、Art 节点录制视频：浏览器在编码的同时将字节按位置写入 `generated/.<会话号>.part`（`exportWrite`），
   * 完成时（`exportFinish`）核对 mp4 文件头、保存为 `generated/<节点名>.mp4`（重名时加 `-2`），并在来源节点右侧添加节点。
   * 返回会话号。该节点有大模型发起、尚未认领的导出时由本会话认领，已被另一会话认领时拒绝（多个界面同时收到请求）。
   * `requested` 表示界面按大模型的请求开始导出：请求已结束（已由另一界面完成、已停止、已超时）时拒绝，
   * 不拒绝时该界面会把同一条时间线再导出一份。
   *
   * 临时文件的终态：完成时改名；失败、放弃、停止服务或 `EXPORT_IDLE_MS` 内无写入时删除（标签页关闭、网络断开时不会有调用方
   * 调用 `exportAbort`）；进程被结束时遗留的临时文件由下次启动的 `CanvasRuns.recover` 删除。
   */
  async exportStart(
    workspaceRoot: string,
    path: string,
    nodeId: string,
    requested = false,
  ): Promise<string> {
    const canvas = await this.docs.locate(workspaceRoot, path)
    const node = (await this.docs.load(canvas)).nodes.find((n) => n.id === nodeId)
    if (!node) throw new CanvasFailure(`目标已不存在：${nodeId}`, 404)
    if (node.type !== 'timeline' && canvasMediaOf(node) !== 'art') {
      throw new CanvasFailure('只有时间线与 Art 节点能导出视频', 422)
    }
    const key = `${keyOf(workspaceRoot, path)}#${nodeId}`
    if (this.exportRequests.get(key)?.claimed) {
      throw new CanvasFailure('该时间线正在由另一个界面导出', 409)
    }
    if (requested && !this.exportRequests.has(key)) {
      throw new CanvasFailure('该导出请求已结束', 409)
    }
    const target = `${EXPORT_DIR}/${displayNameOf(node).replace(/[\\/:*?"<>|]/g, '_')}.mp4`
    // 临时文件与成片同目录：完成时改名不跨卷。
    const dir = dirname(await freeLandingPath(workspaceRoot, target, 'video/mp4'))
    await mkdir(dir, { recursive: true })
    const id = randomUUID()
    const part = join(dir, `.${id}.part`)
    const session: ExportSession = {
      root: workspaceRoot,
      canvas: path,
      source: nodeId,
      target,
      part,
      file: open(part, 'wx+'),
      timer: setTimeout(() => void this.dropExport(id), this.exportIdleMs),
    }
    this.exports.set(id, session)
    try {
      await session.file
    } catch (err) {
      this.exports.delete(id)
      clearTimeout(session.timer)
      throw err
    }
    // 创建文件期间另一个界面可能已经认领，认领以此刻为准。
    const request = this.exportRequests.get(key)
    if (!request && requested) {
      await this.dropExport(id)
      throw new CanvasFailure('该导出请求已结束', 409)
    }
    if (request) {
      if (request.claimed) {
        await this.dropExport(id)
        throw new CanvasFailure('该时间线正在由另一个界面导出', 409)
      }
      request.claimed = id
      clearTimeout(request.timer)
    }
    return id
  }

  /** 将一块字节写入 `.part` 的 `at` 处。编码器在结尾会回写文件开头的索引，因此按位置写入，而不是追加。 */
  async exportWrite(
    workspaceRoot: string,
    id: string,
    at: number,
    bytes: Uint8Array,
  ): Promise<void> {
    const session = this.exportOf(workspaceRoot, id)
    clearTimeout(session.timer)
    session.timer = setTimeout(() => void this.dropExport(id), this.exportIdleMs)
    await (await session.file).write(bytes, 0, bytes.length, at)
  }

  async exportFinish(workspaceRoot: string, id: string): Promise<{ nodeId: string; path: string }> {
    const session = this.exportOf(workspaceRoot, id)
    this.exports.delete(id)
    clearTimeout(session.timer)
    const file = await session.file
    try {
      const head = new Uint8Array(8)
      await file.read(head, 0, 8, 0)
      await file.close()
      if (new TextDecoder().decode(head.subarray(4, 8)) !== 'ftyp') {
        throw new CanvasFailure('收到的不是 mp4 视频', 422)
      }
      const doc = await this.docs.load(await this.docs.locate(workspaceRoot, session.canvas))
      if (!doc.nodes.some((n) => n.id === session.source)) {
        throw new CanvasFailure(`目标已不存在：${session.source}`, 404)
      }
      const final = await this.claimExportName(workspaceRoot, session.target)
      try {
        await renameWithRetry(session.part, final)
      } catch (err) {
        await rm(final, { force: true })
        throw err
      }
      const rel = await this.docs.relativeTo(workspaceRoot, final)
      const { refs } = await this.docs.apply(workspaceRoot, session.canvas, [
        { op: 'add_file', ref: '$export', path: rel, beside: session.source },
      ])
      const landed = { nodeId: refs.$export!, path: rel }
      const asked = this.requestOf(id)
      if (asked) this.settleExport(asked, landed)
      return landed
    } catch (err) {
      await file.close().catch(() => {})
      await rm(session.part, { force: true })
      const asked = this.requestOf(id)
      if (asked) this.settleExport(asked, err as Error)
      throw err
    }
  }

  /**
   * 占用一个成片文件名：按重名规则选定，以独占方式创建空文件占用；同时完成的另一次导出先行占用时重新选定。返回绝对路径。
   * 不要改成选定后直接改名：改名会覆盖已存在的文件，两次导出同时选中同一个名称时后者会覆盖前者。
   */
  private async claimExportName(workspaceRoot: string, target: string): Promise<string> {
    for (;;) {
      const abs = await freeLandingPath(workspaceRoot, target, 'video/mp4')
      try {
        await (await open(abs, 'wx')).close()
        return abs
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
    }
  }

  /** 放弃导出：删除 `.part`。会话已结束或不属于当前项目时不执行任何操作。 */
  async exportAbort(workspaceRoot: string, id: string): Promise<void> {
    if (this.exports.get(id)?.root !== workspaceRoot) return
    await this.dropExport(id)
  }

  private exportOf(workspaceRoot: string, id: string): ExportSession {
    const session = this.exports.get(id)
    if (!session || session.root !== workspaceRoot) {
      throw new CanvasFailure('本次导出已结束或超时，请重新导出', 404)
    }
    return session
  }

  private async dropExport(id: string): Promise<void> {
    const session = this.exports.get(id)
    if (!session) return
    this.exports.delete(id)
    clearTimeout(session.timer)
    const asked = this.requestOf(id)
    if (asked) {
      this.settleExport(
        asked,
        new CanvasFailure('界面中的导出失败或被取消，失败原因显示在该画布上', 409),
      )
    }
    await (await session.file.catch(() => null))?.close().catch(() => {})
    await rm(session.part, { force: true })
  }

  /** 删除当前项目 `generated/` 中不属于进行中会话的导出临时文件，即进程被结束时未能删除的文件。 */
  async sweepExports(root: string): Promise<void> {
    const dir = join(root, EXPORT_DIR)
    for (const name of await readdir(dir)) {
      const id = EXPORT_PART.exec(name)?.[1]
      if (id && !this.exports.has(id)) await rm(join(dir, name), { force: true })
    }
  }

  /** 应用关闭：结束大模型发起、尚未结束的导出，结束进行中的导出会话并删除临时文件。 */
  async stop(): Promise<void> {
    for (const key of [...this.exportRequests.keys()]) {
      this.settleExport(key, new CanvasFailure('应用正在关闭，导出未完成', 409))
    }
    await Promise.all([...this.exports.keys()].map((id) => this.dropExport(id)))
  }
}
