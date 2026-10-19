/**
 * 画布服务：对 `*.canvas.json` 的写入与画布上的生成只经由此处执行。界面经由 `api/canvas.ts`，
 * Agent 经由 `CanvasPort`，两处调用同一个实例。
 *
 * 本服务独占的状态：
 * - 写入次序：同一个画布文件的修改串行执行（读 → 应用 → 写 `.part` → 改名前复读 → 改名）；
 * - 正在运行的卡片、卡片上显示的最近一次失败：只保存在进程内，重启后清空。每次生成的结果（含失败原文）
 *   在收尾时追加到画布文件的生成记录（`runs`）中，随文件保留。
 *
 * 本服务之外还有其他写入者（Agent 的 `write_file`、CLI 会话、外部编辑器），因此改名前再读取一次：
 * 字节已变化时在新内容上重新应用，不覆盖其他写入者的改动。
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { CanvasPort, CanvasRender, MediaPort } from '@qywork/agent'
import { type TaskPhase, taskPhase } from '@qywork/ai'
import {
  type AgentEvent,
  activeMediaParams,
  addVersions,
  applyCanvasOps,
  artImageRefs,
  artPageSize,
  type CanvasBatchRunResult,
  type CanvasCancelOutcome,
  type CanvasClip,
  type CanvasDoc,
  type CanvasGenerateNode,
  type CanvasMade,
  type CanvasNode,
  type CanvasNodeState,
  type CanvasOp,
  type CanvasPixels,
  type CanvasResult,
  type CanvasRunRecord,
  type CanvasRunResult,
  type CanvasTaskInfo,
  type CanvasVersion,
  type CanvasView,
  canvasFileKind,
  canvasMediaOf,
  cardIdOf,
  compilePrompt,
  displayNameOf,
  emptyCanvas,
  type GenerateOutput,
  inputsOf,
  type MediaParamDefinition,
  type MentionStyle,
  mediaInputsOf,
  mediaOperationFor,
  newCanvasId,
  parseCanvas,
  recordRun,
  resolveArtRef,
  serializeCanvas,
  settleVersion,
  textReferenceProblems,
  toPosixPath,
} from '@qywork/core'
import {
  freeLandingPath,
  type GeneratedFile,
  generateMedia,
  landFiles,
  renameWithRetry,
  resolveInWorkspace,
  resolveWritablePath,
  resumeMedia,
  TASK_SUFFIX,
} from '@qywork/tools'
import type { BrowserCoordinator } from './browser/coordinator.ts'
import { agentView, checkActiveParams, prepareAgentOps } from './canvas-agent-ops.ts'
import { findByName } from './files.ts'
import { mediaDurationOf, mediaSizeOf } from './media-size.ts'

/** 画布文件的后缀。文件树按它把文件交给画布页签打开。 */
export const CANVAS_SUFFIX = '.canvas.json'

/** 画布服务的失败。`status` 是 HTTP 状态码；`message` 由界面直接显示，由工具原样交给模型。 */
export class CanvasFailure extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 422,
  ) {
    super(message)
  }
}

/** 读写文件的函数。只在测试中替换，用于在写入中途插入外部改动或故障。 */
export interface CanvasIo {
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

const NODE_IO: CanvasIo = {
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text, 'utf8'),
  rename: renameWithRetry,
}

/** 每个画布文件为撤销与重做保留的整份文档数，超出时丢弃最早的一份。 */
const SNAPSHOTS = 100

/** 文档内容的指纹。撤销请求据此确认当前文件仍是该次编辑写入的内容。 */
function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** 一次写入前后两份文档的指纹；没有改动时两者相同。 */
export interface CanvasStep {
  before: string
  after: string
}

/** PNG 文件头。取帧只接受 PNG：浏览器导出的格式即为 PNG，其他格式表明请求并非来自取帧。 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** 改名前复读发现文件已变化时，重新应用的次数上限。 */
const MAX_REAPPLY = 5

/**
 * 写入队列、运行中集合与失败记录的键：按字面拼接得到的画布绝对路径。
 * 不使用相对路径：多个工作区并存时，两个工作区根下同名的画布会冲突。
 * 不等待 `realpath`：键必须在调用时同步得出，才能按调用顺序排队。
 */
function keyOf(workspaceRoot: string, path: string): string {
  return resolve(workspaceRoot, path)
}

/** 一次视频生成产物中的视频文件（同时返回的还可能有尾帧图）。 */
function videoOf(files: GeneratedFile[]): GeneratedFile {
  return files.find((f) => f.mime.startsWith('video/')) ?? files[0]!
}

/**
 * 视频对应的版本改为指向产物；随视频返回的尾帧图各添加一个节点，名称为 `<卡片名>_尾帧`，位于卡片右侧，
 * 下一段可直接以它作为首帧。`sizes` 是各产物的像素宽高（`sizesOf`），节点框按它确定比例。
 */
function settleVideo(
  doc: CanvasDoc,
  nodeId: string,
  versionId: string,
  files: GeneratedFile[],
  sizes: Map<string, CanvasPixels>,
): CanvasResult {
  const video = videoOf(files)
  const settled = settleVersion(doc, nodeId, versionId, video.path, sizes.get(video.path))
  const node = settled.ok ? settled.doc.nodes.find((n) => n.id === nodeId) : undefined
  const frames = files.filter((f) => f !== video && f.mime.startsWith('image/'))
  if (!settled.ok || !node || frames.length === 0) return settled
  return applyCanvasOps(
    settled.doc,
    frames.map((f) => ({
      op: 'add_file' as const,
      path: f.path,
      name: `${displayNameOf(node)}_尾帧`,
      beside: node.id,
      ...sizeField(sizes.get(f.path)),
    })),
  )
}

/** 图片恢复记录替换为首张产物，其余图片成为同一卡片的版本。 */
function settleImages(
  doc: CanvasDoc,
  nodeId: string,
  versionId: string,
  files: GeneratedFile[],
  sizes: Map<string, CanvasPixels>,
  warning?: string,
): CanvasResult {
  const first = files[0]!
  const settled = settleVersion(doc, nodeId, versionId, first.path, sizes.get(first.path))
  if (!settled.ok) return settled
  const node = settled.doc.nodes.find((n) => n.id === nodeId) as CanvasGenerateNode
  const version = node.versions.find((v) => v.id === versionId)!
  if (warning) version.warning = warning
  if (files.length === 1) return settled
  const added = addVersions(
    settled.doc,
    nodeId,
    files.slice(1).map((f) => ({
      id: newCanvasId(),
      path: f.path,
      made: version.made,
      ...sizeField(sizes.get(f.path)),
      ...(warning ? { warning } : {}),
    })),
  )
  return added.ok
    ? applyCanvasOps(added.doc, [{ op: 'update', id: nodeId, current: node.current! }])
    : added
}

/** 可选的 `size` 字段：无法读取尺寸时不写入该键。 */
function sizeField(size: CanvasPixels | null | undefined): { size?: CanvasPixels } {
  return size ? { size } : {}
}

export interface CanvasServiceDeps {
  /** 当前模型的参数表，用于投影画布偏好为实际发送参数。 */
  paramSpecsOf?(
    output: GenerateOutput,
    pick: { provider: string; model: string } | undefined,
  ): readonly MediaParamDefinition[] | undefined
  /** 发送一条全局事件（不带会话 id）。 */
  publish(event: AgentEvent): void
  /** 与对话共用更新占位；文件校验结束后、开始生成前再检查一次。 */
  updating?(): boolean
  /** 本次生成所用模型在提示词中指代素材的方式；未提供时按节点名写入提示词。 */
  mentionStyleOf?(
    output: GenerateOutput,
    pick: { provider: string; model: string } | undefined,
  ): MentionStyle | undefined
  /** 只替换给出的函数，其余使用默认实现。 */
  io?: Partial<CanvasIo>
  /** 新节点、新连线的 id。只在测试中注入，使两条路径写出的文件可以逐字节比较。 */
  newId?: () => string
  /** 导出会话无写入时的作废时限（毫秒）。只在测试中缩短。 */
  exportIdleMs?: number
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

/** 画布所在的项目：根目录用于定位文件，id 写入 `canvas.run` 事件。 */
export interface CanvasWorkspace {
  id: string
  root: string
}

/**
 * 设计稿页面的渲染：页面原文、页面文件的绝对路径与显示尺寸 → PNG（base64）与页面脚本报错。
 * 由服务端以内置浏览器的隐藏页实现（`BrowserCoordinator.renderArt`），按会话绑定后交给画布端口。
 */
export type ArtRender = (page: {
  html: string
  pagePath: string
  width: number
  height: number
}) => Promise<{ png: string; errors: string[] }>

/**
 * 运行或取回的计费归属与中止时机由调用方提供：界面发起时使用服务端创建的端口（花费记为不属于任何轮次），
 * Agent 发起时使用其本轮的 `ctx.media`（花费计入本轮）与本轮的中止信号。
 */
export interface CanvasRunOptions {
  media: MediaPort
  signal?: AbortSignal
  /** 批量派发时再次检查已有远端任务，防止等待期间新出现的待取回版本被重复提交。 */
  rejectPending?: true
}

/** 生成记录中在开始时确定、在生成过程中补充的字段；结果、结束时刻与失败原文在收尾时补充。 */
type RunFacts = Omit<CanvasRunRecord, 'node' | 'end' | 'result' | 'message'>

/** 生成卡的一次远端视频任务，以及指向该任务的版本（取得任务号时未能写入画布则为 null）。 */
interface CanvasTask {
  taskId: string
  provider: string
  model: string
  /** 任务记录的工作区路径。 */
  record: string
  versionId: string | null
}

/** 撤销远端任务的结果：`unsupported` 表示接口不支持撤销。由调用方按配置实现，见 `cancel`。 */
export type CanvasCancelTask = (task: {
  taskId: string
  provider: string
  model: string
}) => Promise<'cancelled' | 'started' | 'unsupported'>

/** 一张卡的一次生成（运行或取回）。 */
interface RunEntry {
  startedAt: number
  action: 'run' | 'retrieve'
  version?: string
  /** false 仅在已接通发送边界的视频准备阶段使用；未接通的类型不能据此声称未付费。 */
  requestSent?: boolean
  stopMessage?: string
  done?: Promise<CanvasRunResult>
  /** 停止本地等待；只有 cancelled 表示远端确已撤销。 */
  stop: AbortController
  task?: CanvasTask
  /** 平台报告的排队中 / 生成中；报告之前不存在。 */
  phase?: TaskPhase
  /** 远端已撤销：收尾时删除该版本与任务记录，不记录失败。 */
  cancelled?: true
}

export class CanvasService {
  private readonly queues = new Map<string, Promise<unknown>>()
  /** 键：`画布绝对路径#节点 id`。多个工作区并存时相对路径会冲突。 */
  private readonly running = new Map<string, RunEntry>()
  private readonly shutdown = new AbortController()
  private recovering = false
  private recovery: Promise<void> | undefined
  /** 按画布文件的绝对路径记录本服务读取或写入过的文档（规范化后的文本），键为指纹。只增不改，超出上限时丢弃最早的一份。 */
  private readonly snapshots = new Map<string, Map<string, string>>()
  private readonly failures = new Map<string, string>()
  private readonly io: CanvasIo

  private readonly exports = new Map<string, ExportSession>()
  private readonly exportIdleMs: number

  constructor(private readonly deps: CanvasServiceDeps) {
    this.io = { ...NODE_IO, ...deps.io }
    this.exportIdleMs = deps.exportIdleMs ?? EXPORT_IDLE_MS
  }

  /** 扫描中的恢复同样视为忙碌，防止在找到待接续的卡片之前取得更新占位。 */
  get busyCount(): number {
    return Math.max(this.running.size, Number(this.recovering))
  }

  /** 启动时取回各工作区已有的生成结果，沿用原恢复记录，不重新生成。 */
  recover(
    workspaces: CanvasWorkspace[],
    media: (ws: CanvasWorkspace, version: CanvasVersion) => MediaPort | undefined,
  ): Promise<void> {
    if (this.recovery) return this.recovery
    this.recovering = true
    this.recovery = (async () => {
      const pending: Promise<void>[] = []
      try {
        for (const ws of workspaces) {
          // 删除失败的临时文件留待下次启动时再删除，不影响接续任务。
          await this.sweepExports(ws.root).catch(() => {})
          for (const path of await this.list(ws.root)) {
            if (this.shutdown.signal.aborted) return
            const view = await this.read(ws.root, path).catch(() => null)
            if (!view) continue
            for (const node of view.doc.nodes) {
              if (node.type !== 'generate') continue
              const versions = node.versions.filter((v) => v.path.endsWith(TASK_SUFFIX))
              if (!versions.length) continue
              pending.push(
                (async () => {
                  for (const version of versions) {
                    if (this.shutdown.signal.aborted) return
                    try {
                      const port = media(ws, version)
                      if (!port) continue
                      const { done } = await this.retrieve(ws, path, node.id, version.id, {
                        media: port,
                      })
                      await done
                    } catch (err) {
                      // 用户已先行取回同一卡片时由该次调用继续处理；其余错误保留任务记录供手动重试。
                      if (!(err instanceof CanvasFailure && err.status === 409)) {
                        this.failures.set(`${keyOf(ws.root, path)}#${node.id}`, String(err))
                      }
                      return
                    }
                  }
                })(),
              )
            }
          }
        }
      } finally {
        await Promise.all(pending)
        this.recovering = false
      }
    })()
    return this.recovery
  }

  /** 停止本地等待，保留远端任务记录；结束进行中的导出并删除临时文件；等待收尾完成后再关闭账本。 */
  async stop(): Promise<void> {
    this.shutdown.abort()
    await Promise.all([...this.exports.keys()].map((id) => this.dropExport(id)))
    await this.recovery?.catch(() => {})
    await Promise.all([...this.running.values()].map((run) => run.done))
  }

  /** 画布文件的绝对路径。不在工作区中、不存在或不是画布文件时，均按参数错误返回 422 / 404。 */
  async locate(workspaceRoot: string, path: string): Promise<string> {
    if (!path.endsWith(CANVAS_SUFFIX)) throw new CanvasFailure(`${path} 不是画布文件`, 422)
    try {
      return await resolveInWorkspace(workspaceRoot, path, { mustExist: true, literal: true })
    } catch {
      throw new CanvasFailure(`${path} 不存在或不在当前项目中`, 404)
    }
  }

  /** 新建空画布：指定路径时不覆盖已有文件；省略路径时在根目录按时间命名。 */
  async create(workspaceRoot: string, opts: { path?: string; now?: Date } = {}): Promise<string> {
    if (opts.path !== undefined && !opts.path.endsWith(CANVAS_SUFFIX))
      throw new CanvasFailure('画布路径必须以 .canvas.json 结尾', 422)
    const now = opts.now ?? new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const stamp =
      `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
      `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
    for (let n = 1; ; n++) {
      const name = opts.path ?? `canvas-${stamp}${n === 1 ? '' : `-${n}`}${CANVAS_SUFFIX}`
      const abs = await resolveWritablePath(workspaceRoot, name, {
        literal: true,
        followFinalSymlink: false,
      })
      await mkdir(dirname(abs), { recursive: true })
      try {
        await writeFile(abs, serializeCanvas(emptyCanvas()), { flag: 'wx' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          if (opts.path !== undefined)
            throw new CanvasFailure(`${name} 已存在，请使用 edit_canvas 修改或指定其他路径`, 409)
          continue
        }
        throw err
      }
      this.changed()
      return this.relativeTo(workspaceRoot, abs)
    }
  }

  /**
   * 只调度本次指定的节点，不自动扩展到其他上游。执行仍走 run，共用状态、版本与计费。
   * 批内依赖失败时跳过下游，独立节点最多并行 4 个；中止后不再派发等待中的节点。
   */
  async runBatch(
    ws: CanvasWorkspace,
    path: string,
    nodeIds: string[],
    opts: CanvasRunOptions,
  ): Promise<CanvasBatchRunResult> {
    if (!nodeIds.length || nodeIds.some((id) => typeof id !== 'string' || !id.trim()))
      throw new CanvasFailure('必须指定要运行的生成节点', 422)
    const ids = [...new Set(nodeIds)]
    const view = await this.read(ws.root, path)
    const byId = new Map(view.doc.nodes.map((node) => [node.id, node]))
    for (const id of ids) {
      if (byId.get(id)?.type !== 'generate')
        throw new CanvasFailure(`不是可运行的生成节点：${id}`, 422)
    }
    const selected = new Set(ids)
    const dependencies = new Map(
      ids.map((id) => [
        id,
        inputsOf(view.doc, id)
          .map((e) => e.from)
          .filter((id) => selected.has(id)),
      ]),
    )
    // 在任何付费提交之前检查循环；顺序只描述本次调度，不写入第二份运行状态。
    const waiting = new Set(ids)
    const ordered: string[] = []
    while (waiting.size) {
      const ready = [...waiting].filter((id) =>
        dependencies.get(id)!.every((dep) => !waiting.has(dep)),
      )
      if (!ready.length) throw new CanvasFailure('指定节点之间存在循环依赖，未运行任何节点', 422)
      for (const id of ready) {
        waiting.delete(id)
        ordered.push(id)
      }
    }
    for (const id of ordered) waiting.add(id)
    type Entry = CanvasBatchRunResult[number]
    const results = new Map<string, Entry>()
    const active = new Map<string, Promise<Entry>>()
    const skip = (node: string, message: string, pending = false) => {
      results.set(node, { node, skipped: true, result: { ok: false, message, pending } })
      waiting.delete(node)
    }
    while (waiting.size || active.size) {
      for (const id of waiting) {
        if (opts.signal?.aborted || this.shutdown.signal.aborted) {
          skip(id, '运行已中止，未提交生成')
          continue
        }
        const deps = dependencies.get(id)!
        if (deps.some((dep) => !results.has(dep))) continue
        const failed = deps.filter((dep) => !results.get(dep)!.result.ok)
        if (failed.length) {
          skip(id, `上游节点未成功：${failed.join('、')}，未提交生成`)
          continue
        }
        const state = view.states[id]
        if (state?.state === 'pending') {
          skip(id, `已有待取回版本 ${state.version}，请使用 retrieve_canvas`, true)
          continue
        }
        if (state?.state === 'running') {
          skip(id, '该卡片正在生成，未重复提交')
          continue
        }
        if (active.size >= 4) break
        waiting.delete(id)
        active.set(
          id,
          (async (): Promise<Entry> => {
            try {
              const { done } = await this.run(ws, path, id, { ...opts, rejectPending: true })
              return { node: id, result: await done }
            } catch (err) {
              return {
                node: id,
                skipped: true,
                result: { ok: false, message: (err as Error).message, pending: false },
              }
            }
          })(),
        )
      }
      if (active.size) {
        const entry = await Promise.race(active.values())
        active.delete(entry.node)
        results.set(entry.node, entry)
      }
    }
    return ids.map((id) => results.get(id)!)
  }

  /**
   * 运行一张生成卡。运行中、输入尚无结果、提示词为空均在返回之前以 `CanvasFailure` 抛出；
   * 返回的 `done` 在生成结束且画布回写之后兑现，不会拒绝。
   *
   * 视频取得任务号后立即追加一个指向任务记录的版本，此后停止、查询被拒绝或进程退出均可取回；成功后按版本 id
   * 将该版本改为指向产物。图像与音频在成功后才追加版本，多张图像对应多个版本。
   */
  async run(
    ws: CanvasWorkspace,
    path: string,
    nodeId: string,
    opts: CanvasRunOptions,
  ): Promise<{ done: Promise<CanvasRunResult> }> {
    const { rel, key, node, doc } = await this.target(ws, path, nodeId)
    if (opts.rejectPending && node.versions.some((v) => v.path.endsWith(TASK_SUFFIX)))
      throw new CanvasFailure('已有待取回版本，请使用 retrieve_canvas，不要重复提交生成', 409)
    if (!node.prompt.trim()) throw new CanvasFailure(`「${node.name}」的提示词为空`, 422)
    const inputs: CanvasMade['inputs'] = []
    // art 在当前页面上修改：当前版本的文件作为第一项参考输入。文件已不存在时从头生成。
    const page =
      node.output === 'art' ? node.versions.find((v) => v.id === node.current)?.path : undefined
    if (page && (await this.isFile(ws.root, page))) inputs.push({ role: 'reference', path: page })
    // 文本卡不作为素材发送：提示词中的引用在编译时展开为文件当前的内容，引用不成立时不提交。
    const texts = await this.textsOf(ws.root, doc, nodeId)
    const broken = textReferenceProblems(doc, nodeId, texts)
    if (broken.length) {
      throw new CanvasFailure(`「${node.name}」的提示词引用不成立：${broken.join('；')}`, 422)
    }
    for (const edge of mediaInputsOf(doc, nodeId)) {
      const source = doc.nodes.find((n) => n.id === edge.from)!
      // 时间线不能作为输入（`validateCanvas` 拒绝），不会执行到此处。
      const file =
        source.type === 'file'
          ? source.path
          : source.type === 'generate'
            ? source.versions.find((v) => v.id === source.current)?.path
            : undefined
      if (!file || file.endsWith(TASK_SUFFIX)) {
        throw new CanvasFailure(`「${displayNameOf(source)}」尚无结果`, 422)
      }
      if (!(await this.isFile(ws.root, file))) {
        throw new CanvasFailure(`「${displayNameOf(source)}」的文件不存在：${file}`, 422)
      }
      inputs.push({ role: edge.role, path: file })
    }
    const pick =
      node.provider !== undefined && node.model !== undefined
        ? { provider: node.provider, model: node.model }
        : undefined
    const prompt = compilePrompt(doc, nodeId, this.deps.mentionStyleOf?.(node.output, pick), texts)
    const specs = this.deps.paramSpecsOf?.(node.output, pick)
    const params = specs
      ? activeMediaParams(
          specs,
          mediaOperationFor(
            node.output,
            inputs.map((i) => i.role),
          ),
          node.params,
          inputs.filter((i) => i.role === 'reference').length,
        )
      : node.params
    const made = (provider: string, model: string): CanvasMade => ({
      prompt,
      provider,
      model,
      params,
      inputs,
      at: new Date().toISOString(),
    })

    const facts: RunFacts = {
      action: 'run',
      start: new Date().toISOString(),
      ...(pick ?? {}),
      prompt,
      params,
      inputs,
    }
    opts.signal?.throwIfAborted()
    const entry = this.begin(key, ws, rel, nodeId)
    if (node.output === 'video') entry.requestSent = false
    const done = this.settleRun(key, ws, rel, nodeId, facts, async () => {
      let versionId: string | null = null
      const outcome = await generateMedia({
        roots: ws.root,
        media: opts.media,
        signal: this.signalFor(entry, opts.signal),
        onSubmit: () => {
          entry.requestSent = true
          this.deps.publish({
            type: 'canvas.run',
            workspaceId: ws.id,
            path: rel,
            nodeId,
            state: 'running',
          })
        },
        onStatus: (status) => this.advance(entry, ws, rel, nodeId, status),
        onSpend: (spend) => {
          facts.cost = spend.cost
          facts.currency = spend.currency
        },
        type: node.output,
        prompt,
        inputs,
        params,
        ...(pick ? { pick } : {}),
        onTask: async ({ record, taskId, provider, model }) => {
          facts.provider = provider
          facts.model = model
          const id = newCanvasId()
          await this.mutate(ws.root, rel, (d) =>
            addVersions(d, nodeId, [{ id, path: record, made: made(provider, model) }]),
          ).then(
            () => {
              versionId = id
              facts.version = id
              entry.version = id
            },
            () => {},
          )
          if (taskId)
            this.submitted(entry, ws, rel, nodeId, { taskId, provider, model, record, versionId })
        },
      })
      if (!outcome.ok) {
        if (versionId && !outcome.record) await this.dropVersion(ws.root, rel, nodeId, versionId)
        return {
          ok: false,
          message: outcome.message,
          pending: outcome.record !== undefined,
          ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}),
        }
      }
      facts.provider = outcome.provider
      facts.model = outcome.model
      const files = outcome.files
      const output = node.output === 'video' ? videoOf(files).path : files[0]?.path
      if (output) facts.output = output
      const sizes = await this.sizesOf(ws.root, files)
      const version = (path: string) => ({
        id: newCanvasId(),
        path,
        made: made(outcome.provider, outcome.model),
        ...sizeField(sizes.get(path)),
        ...(outcome.warning ? { warning: outcome.warning } : {}),
      })
      const id: string | null = versionId
      const images = node.output === 'art' ? await this.artImagesOf(ws.root, files[0]?.path) : null
      const warning =
        [
          outcome.warning,
          images?.missing.length ? `页面引用的图片不存在：${images.missing.join('、')}` : '',
        ]
          .filter(Boolean)
          .join('；') || undefined
      return this.writeBack(
        ws.root,
        rel,
        { files, sizes, params },
        (d) => {
          if (node.output === 'image' && id)
            return settleImages(d, nodeId, id, files, sizes, outcome.warning)
          if (node.output !== 'video') {
            const added = addVersions(
              d,
              nodeId,
              files.map((f) => version(f.path)),
            )
            return added.ok && images ? linkArtImages(added.doc, nodeId, images.found) : added
          }
          if (id) return settleVideo(d, nodeId, id, files, sizes)
          // 取得任务号时未能写入画布（文件被外部改写），成功后补充一个版本。
          const late = version(videoOf(files).path)
          const added = addVersions(d, nodeId, [late])
          return added.ok ? settleVideo(added.doc, nodeId, late.id, files, sizes) : added
        },
        warning,
      )
    })
    this.running.get(key)!.done = done
    return { done }
  }

  /**
   * 取回已有图片结果或视频任务：只查询与下载，不再提交。`versionId` 缺省时取当前版本，当前版本不是任务记录时取最新的任务记录版本。
   * 远端已失败或结果已过期时删除该版本与任务记录。
   */
  async retrieve(
    ws: CanvasWorkspace,
    path: string,
    nodeId: string,
    versionId: string | undefined,
    opts: CanvasRunOptions,
  ): Promise<{ done: Promise<CanvasRunResult> }> {
    const { rel, key, node } = await this.target(ws, path, nodeId)
    const tasks = node.versions.filter((v) => v.path.endsWith(TASK_SUFFIX))
    const version =
      versionId !== undefined
        ? tasks.find((v) => v.id === versionId)
        : (tasks.find((v) => v.id === node.current) ?? tasks.at(-1))
    if (!version) throw new CanvasFailure(`「${node.name}」没有待取回的任务`, 422)

    const facts: RunFacts = {
      action: 'retrieve',
      start: new Date().toISOString(),
      version: version.id,
    }
    const entry = this.begin(key, ws, rel, nodeId, 'retrieve')
    entry.version = version.id
    const done = this.settleRun(key, ws, rel, nodeId, facts, async () => {
      if (!(await this.isFile(ws.root, version.path))) {
        await this.dropVersion(ws.root, rel, nodeId, version.id)
        return { ok: false, message: `任务记录已不存在：${version.path}`, pending: false }
      }
      const task = await this.readTask(ws.root, version.path)
      if (task)
        this.submitted(entry, ws, rel, nodeId, {
          ...task,
          record: version.path,
          versionId: version.id,
        })
      const outcome = await resumeMedia({
        roots: ws.root,
        media: opts.media,
        signal: this.signalFor(entry, opts.signal),
        onStatus: (status) => this.advance(entry, ws, rel, nodeId, status),
        onSpend: (spend) => {
          facts.cost = spend.cost
          facts.currency = spend.currency
        },
        record: version.path,
      })
      if (!outcome.ok) {
        if (outcome.executed && !outcome.record) {
          await this.dropVersion(ws.root, rel, nodeId, version.id)
        }
        return {
          ok: false,
          message: outcome.message,
          pending: outcome.record !== undefined,
          ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}),
        }
      }
      const sizes = await this.sizesOf(ws.root, outcome.files)
      const output = node.output === 'video' ? videoOf(outcome.files).path : outcome.files[0]?.path
      if (output) facts.output = output
      return this.writeBack(
        ws.root,
        rel,
        { files: outcome.files, sizes, params: version.made.params },
        (d) =>
          node.output === 'image'
            ? settleImages(d, nodeId, version.id, outcome.files, sizes, outcome.warning)
            : settleVideo(d, nodeId, version.id, outcome.files, sizes),
        outcome.warning,
      )
    })
    this.running.get(key)!.done = done
    return { done }
  }

  /** 运行与取回共用的前置检查：画布、节点、未在运行。 */
  private async target(
    ws: CanvasWorkspace,
    path: string,
    nodeId: string,
  ): Promise<{ rel: string; key: string; doc: CanvasDoc; node: CanvasGenerateNode }> {
    const abs = await this.locate(ws.root, path)
    const rel = await this.relativeTo(ws.root, abs)
    const key = `${keyOf(ws.root, path)}#${nodeId}`
    if (this.running.has(key)) throw new CanvasFailure('该卡片正在生成', 409)
    const doc = await this.load(abs)
    const node = doc.nodes.find((n) => n.id === nodeId)
    if (!node) throw new CanvasFailure(`目标已不存在：${nodeId}`, 404)
    if (node.type !== 'generate') throw new CanvasFailure('只有生成节点能运行', 422)
    return { rel, key, doc, node }
  }

  private begin(
    key: string,
    ws: CanvasWorkspace,
    rel: string,
    nodeId: string,
    action: 'run' | 'retrieve' = 'run',
  ): RunEntry {
    if (this.shutdown.signal.aborted || this.deps.updating?.())
      throw new CanvasFailure('应用正在更新或关闭，请稍后重试', 409)
    if (this.running.has(key)) throw new CanvasFailure('该卡片正在生成', 409)
    const entry: RunEntry = {
      startedAt: Date.now(),
      action,
      stop: new AbortController(),
    }
    this.running.set(key, entry)
    this.failures.delete(key)
    this.deps.publish({
      type: 'canvas.run',
      workspaceId: ws.id,
      path: rel,
      nodeId,
      state: 'running',
    })
    return entry
  }

  /** 任务号落盘后即可对外读取，不必等生成结束或首次查询返回。 */
  private submitted(
    entry: RunEntry,
    ws: CanvasWorkspace,
    rel: string,
    nodeId: string,
    task: CanvasTask,
  ): void {
    entry.task = task
    entry.requestSent = true
    if (task.versionId) entry.version = task.versionId
    this.deps.publish({
      type: 'canvas.run',
      workspaceId: ws.id,
      path: rel,
      nodeId,
      state: 'running',
    })
  }

  /** 平台报告的状态变化：记录排队中 / 生成中，发送一条 `canvas.run` 使界面重新读取。无法识别的状态值不修改。 */
  private advance(
    entry: RunEntry,
    ws: CanvasWorkspace,
    rel: string,
    nodeId: string,
    status: string,
  ): void {
    const phase = taskPhase(status)
    if (!phase || phase === entry.phase) return
    entry.phase = phase
    this.deps.publish({
      type: 'canvas.run',
      workspaceId: ws.id,
      path: rel,
      nodeId,
      state: 'running',
    })
  }

  private signalFor(entry: RunEntry, signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([entry.stop.signal, this.shutdown.signal, ...(signal ? [signal] : [])])
  }

  /** 任务记录中的任务号、接口与模型；无法读取时返回 null（取消时视为无法撤销）。 */
  private async readTask(
    root: string,
    record: string,
  ): Promise<(CanvasTaskInfo & { taskId: string }) | null> {
    try {
      const r = JSON.parse(await readFile(join(root, record), 'utf8')) as Record<string, unknown>
      const { taskId, provider, model, output } = r
      return typeof taskId === 'string' &&
        typeof provider === 'string' &&
        typeof model === 'string' &&
        typeof output === 'string'
        ? { taskId, provider, model, output, record }
        : null
    } catch {
      return null
    }
  }

  /**
   * 取消一张卡片正在进行的生成。
   *
   * 图像、音频等单次请求没有远端任务可撤销：停止本地等待，收尾时记为结果未知，返回 `stopped`。
   * 不要改为继续等待：生成请求不设静默上限，远端既不返回也不断开连接时，停止是结束这次生成的唯一途径。
   *
   * 视频生成请求尚未发出（包含上传素材中）时正常取消，返回 `not_submitted`，不产生生成费用。
   * 请求发出但未取得任务号时立即停止本地等待，返回 `stopped`，不能无限等任务号。
   * 此时无法确定平台是否已受理，不声称远端已撤销、不自动重发；若停止期间取得任务号，保留记录供取回。
   * 撤销由 `cancelTask` 按接口能力执行：撤销成功时停止本地等待，收尾时删除该版本与任务记录、不记录失败，返回 `cancelled`。
   * 无法撤销或撤销请求失败时仍暂停本地等待并保留任务；新生成和取回遵守相同的取消能力判断。
   */
  async cancel(
    workspaceRoot: string,
    path: string,
    nodeId: string,
    cancelTask: CanvasCancelTask,
  ): Promise<CanvasCancelOutcome> {
    const entry = this.running.get(`${keyOf(workspaceRoot, path)}#${nodeId}`)
    if (!entry) throw new CanvasFailure('该卡片未在生成', 409)
    if (entry.cancelled) return 'cancelled'
    if (!entry.task) {
      entry.stop.abort()
      const result = await entry.done
      return result?.ok ? 'ended' : entry.requestSent === false ? 'not_submitted' : 'stopped'
    }
    const task = entry.task
    try {
      if ((await cancelTask(task)) === 'cancelled') entry.cancelled = true
    } catch (err) {
      entry.stopMessage = `未能确认远端取消：${err instanceof Error ? err.message : String(err)}`
    }
    entry.stop.abort()
    const result = await entry.done
    return result?.ok ? 'ended' : entry.cancelled ? 'cancelled' : 'stopped'
  }

  /** 收尾：清除运行标记、记录失败、发送结束事件。`work` 抛出异常时同样记为失败，`done` 不会拒绝。 */
  private async settleRun(
    key: string,
    ws: CanvasWorkspace,
    rel: string,
    nodeId: string,
    facts: RunFacts,
    work: () => Promise<CanvasRunResult>,
  ): Promise<CanvasRunResult> {
    let result: CanvasRunResult
    try {
      result = await work()
    } catch (err) {
      result = { ok: false, message: (err as Error).message, pending: false }
    }
    const entry = this.running.get(key)
    // 远端已撤销：删除该版本与任务记录，卡片恢复到本次生成之前的状态，不记录失败。
    if (!result.ok && entry?.cancelled && entry.task) {
      if (entry.task.versionId) await this.dropVersion(ws.root, rel, nodeId, entry.task.versionId)
      await rm(join(ws.root, entry.task.record), { force: true })
      result = { ok: false, message: '已取消生成', pending: false }
    }
    // 无回执时停止等待：远端仍可能完成。停止期间到达的任务号保留供取回，已成功的结果照常保留。
    const stopped = !result.ok && !entry?.cancelled && entry?.stop.signal.aborted === true
    const unsent = stopped && entry.requestSent === false
    if (stopped) {
      const pending = !!entry.task && (await this.isFile(ws.root, entry.task.record))
      result = {
        ok: false,
        message: unsent
          ? '已取消，未提交生成，不产生生成费用'
          : pending
            ? `已暂停等待；任务已提交，远端可能继续生成并计费，可取回原任务${entry.stopMessage ? `；${entry.stopMessage}` : ''}`
            : '已停止等待；远端结果未知',
        pending,
      }
    }
    const task = entry?.task
    const provider = facts.provider ?? task?.provider
    const model = facts.model ?? task?.model
    const record: CanvasRunRecord = {
      ...facts,
      node: nodeId,
      end: new Date().toISOString(),
      result:
        (!result.ok && entry?.cancelled) || unsent
          ? 'cancelled'
          : result.ok
            ? 'done'
            : result.pending
              ? 'pending'
              : stopped || result.diagnostic?.outcome === 'unknown'
                ? 'unknown'
                : 'failed',
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(task ? { task: task.taskId } : {}),
      ...(entry?.version ? { version: entry.version } : {}),
      ...(!result.ok && !entry?.cancelled ? { message: result.message } : {}),
      ...(!result.ok && result.diagnostic ? { diagnostic: result.diagnostic } : {}),
    }
    // 画布文件已被删除或损坏时无法写入记录；生成本身的结果不因此改变。
    await this.mutate(ws.root, rel, (d) => recordRun(d, record)).catch(() => {})
    this.running.delete(key)
    if (!result.ok && !entry?.cancelled && !unsent) this.failures.set(key, result.message)
    this.deps.publish({
      type: 'canvas.run',
      workspaceId: ws.id,
      path: rel,
      nodeId,
      ...(result.ok || entry?.cancelled || unsent
        ? { state: 'done' }
        : { state: 'failed', message: result.message }),
    })
    return result
  }

  /** 各产物的像素宽高，按工作区相对路径索引；无法读取的产物不在表中。 */
  private async sizesOf(root: string, files: GeneratedFile[]): Promise<Map<string, CanvasPixels>> {
    const sizes = new Map<string, CanvasPixels>()
    for (const f of files) {
      const size = await mediaSizeOf(join(root, f.path))
      if (size) sizes.set(f.path, size)
    }
    return sizes
  }

  /**
   * 产物已落盘，回写画布。成功时返回各产物的像素宽高与时长，以及实际发送的参数，供调用方核对结果。
   * 回写失败（节点或该版本已被外部修改）时，失败原文写明产物位置。
   */
  private async writeBack(
    root: string,
    rel: string,
    made: {
      files: GeneratedFile[]
      sizes: Map<string, CanvasPixels>
      params: Record<string, unknown>
    },
    change: (doc: CanvasDoc) => CanvasResult,
    warning?: string,
  ): Promise<CanvasRunResult> {
    const paths = made.files.map((f) => f.path)
    try {
      await this.mutate(root, rel, change)
      const outputs = await Promise.all(
        paths.map(async (path) => {
          const duration = await mediaDurationOf(join(root, path))
          return {
            path,
            ...sizeField(made.sizes.get(path)),
            ...(duration === null ? {} : { duration }),
          }
        }),
      )
      return { ok: true, outputs, params: made.params, ...(warning ? { warning } : {}) }
    } catch (err) {
      return {
        ok: false,
        message: `已生成，但回写画布失败（${(err as Error).message}），产物位于 ${paths.join('、')}`,
        pending: false,
      }
    }
  }

  private async dropVersion(root: string, rel: string, nodeId: string, versionId: string) {
    await this.mutate(root, rel, (d) =>
      applyCanvasOps(d, [{ op: 'remove', id: nodeId, version: versionId }]),
    ).catch(() => {})
  }

  /**
   * 设计稿页面按相对路径引用的工作区图片：`found` 为存在的图片（工作区路径），`missing` 为页面中写的、
   * 不存在或越出工作区的路径。页面无法读取时两者都为空。
   */
  private async artImagesOf(
    root: string,
    page: string | undefined,
  ): Promise<{ found: string[]; missing: string[] }> {
    const html = page ? await readFile(join(root, page), 'utf8').catch(() => '') : ''
    const found: string[] = []
    const missing: string[] = []
    for (const ref of artImageRefs(html)) {
      const path = page ? resolveArtRef(page, ref) : null
      if (path && (await this.isFile(root, path))) found.push(path)
      else missing.push(ref)
    }
    return { found, missing }
  }

  private isFile(root: string, path: string): Promise<boolean> {
    return stat(join(root, path)).then(
      (s) => s.isFile(),
      () => false,
    )
  }

  /**
   * 工作区中引用文本文件 `path` 的画布卡片，以及其中按文件当前内容已不成立的引用。
   * 供文件工具在写入 .md / .txt 后告知模型：改动会进入哪些卡下次发送的提示词、哪些引用的标题已不存在。
   * 无法读取的画布跳过：它们在被读取或运行时各自报错。
   */
  async textReferences(workspaceRoot: string, path: string): Promise<string[]> {
    const lines: string[] = []
    for (const canvas of await this.list(workspaceRoot)) {
      let doc: CanvasDoc
      try {
        doc = await this.load(await this.locate(workspaceRoot, canvas))
      } catch {
        continue
      }
      const file = doc.nodes.find((n) => n.type === 'file' && n.path === path)
      if (!file) continue
      const users = doc.edges
        .filter((e) => e.from === file.id && e.role === 'text')
        .map((e) => e.to)
      if (!users.length) continue
      const names = users.map((id) => {
        const n = doc.nodes.find((x) => x.id === id)
        return n ? displayNameOf(n) : id
      })
      lines.push(
        `画布 ${canvas} 中 ${users.length} 张卡引用此文件（${names.join('、')}），下次运行时发送修改后的内容。`,
      )
      const cache = new Map<string, string | null>()
      const label = `@[${displayNameOf(file)}`
      for (const [i, id] of users.entries()) {
        const texts = await this.textsOf(workspaceRoot, doc, id, cache)
        for (const p of textReferenceProblems(doc, id, texts)) {
          if (p.startsWith(label)) lines.push(`引用失效：「${names[i]}」${p}`)
        }
      }
    }
    return lines
  }

  /**
   * 设计稿卡按页面的显示尺寸（`artPageSize`，与画布显示相同）渲染并截图。生成卡取当前版本的页面，
   * `.html` 文件卡取其文件。不是设计稿卡、尚无结果或页面无法读取的项写明原因，其余照常渲染。
   */
  async renderArt(
    workspaceRoot: string,
    path: string,
    keys: string[],
    render: ArtRender,
  ): Promise<CanvasRender[]> {
    const { doc } = await this.read(workspaceRoot, path)
    const out: CanvasRender[] = []
    for (const key of keys) {
      const node =
        doc.nodes.find((n) => n.id === key) ?? doc.nodes.find((n) => displayNameOf(n) === key)
      if (!node) {
        out.push({ name: key, failure: '画布上没有这张卡' })
        continue
      }
      const name = displayNameOf(node)
      const art = node.type === 'generate' && node.output === 'art'
      const page = art
        ? node.versions.find((v) => v.id === node.current)?.path
        : node.type === 'file' && canvasFileKind(node.path) === 'art'
          ? node.path
          : undefined
      if (!page) {
        out.push({ name, failure: art ? '尚无结果' : '不是设计稿卡' })
        continue
      }
      const pagePath = join(workspaceRoot, page)
      const html = await readFile(pagePath, 'utf8').catch(() => null)
      if (html === null) {
        out.push({ name, failure: `页面文件不存在：${page}` })
        continue
      }
      const size = artPageSize(html)
      const shot = await render({ html, pagePath, width: size.w, height: size.h })
      out.push({ name, size, png: shot.png, errors: shot.errors })
    }
    return out
  }

  /**
   * 生成卡引用的文本卡文件当前的内容，按节点 id。文件不存在或无法读取时不提供该项，
   * 由 `textReferenceProblems` 报为失效。`cache` 按路径复用同一次读取画布中已读的文件。
   */
  private async textsOf(
    root: string,
    doc: CanvasDoc,
    nodeId: string,
    cache = new Map<string, string | null>(),
  ): Promise<Map<string, string>> {
    const texts = new Map<string, string>()
    for (const edge of inputsOf(doc, nodeId)) {
      if (edge.role !== 'text') continue
      const source = doc.nodes.find((n) => n.id === edge.from)
      if (source?.type !== 'file') continue
      if (!cache.has(source.path)) {
        cache.set(source.path, await readFile(join(root, source.path), 'utf8').catch(() => null))
      }
      const text = cache.get(source.path)
      if (typeof text === 'string') texts.set(source.id, text)
    }
    return texts
  }

  /**
   * 接收浏览器从视频节点截取的一帧或从 Art 节点截取的画面（PNG），按生成产物的落盘规则写入
   * `generated/<节点名>_<label>.png`（不覆盖，重名时加 `-2`），并在该节点右侧添加一个引用它的节点。
   * 返回新节点的 id 与文件路径。
   */
  async captureFrame(
    workspaceRoot: string,
    path: string,
    sourceId: string,
    label: string,
    bytes: Uint8Array,
  ): Promise<{ nodeId: string; path: string }> {
    if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
      throw new CanvasFailure('收到的不是 PNG 图片', 422)
    }
    const doc = await this.load(await this.locate(workspaceRoot, path))
    const source = doc.nodes.find((n) => n.id === sourceId)
    if (!source) throw new CanvasFailure(`目标已不存在：${sourceId}`, 404)
    const kind = canvasMediaOf(source)
    if (kind !== 'video' && kind !== 'art') {
      throw new CanvasFailure('只能从视频或 Art 节点截取画面', 422)
    }
    const name = `${displayNameOf(source)}_${label}`.replace(/[\\/:*?"<>|]/g, '_')
    // 必须写出完整扩展名：名称为 `12.4s` 时若不带扩展名，`.4s` 会被视为扩展名，文件保存为无法识别的类型。
    const [landed] = await landFiles(
      workspaceRoot,
      [{ bytes, mime: 'image/png' }],
      `generated/${name}.png`,
    )
    const { refs } = await this.apply(workspaceRoot, path, [
      { op: 'add_file', ref: '$frame', path: landed!.path, beside: source.id },
    ])
    return { nodeId: refs.$frame!, path: landed!.path }
  }

  /**
   * 时间线导出成片、Art 节点录制视频：浏览器一边编码一边将字节按位置写入 `generated/.<会话号>.part`（`exportWrite`），
   * 完成时（`exportFinish`）核对 mp4 文件头、保存为 `generated/<节点名>.mp4`（重名时加 `-2`），并在来源节点右侧添加节点。
   * 返回会话号。
   *
   * 临时文件的终态：完成时改名；失败、放弃、停止服务或 `EXPORT_IDLE_MS` 内无写入时删除（标签页关闭、网络断开时不会有调用方
   * 调用 `exportAbort`）；进程被结束时遗留的临时文件由下次启动的 `recover` 删除。
   */
  async exportStart(workspaceRoot: string, path: string, nodeId: string): Promise<string> {
    const canvas = await this.locate(workspaceRoot, path)
    const node = (await this.load(canvas)).nodes.find((n) => n.id === nodeId)
    if (!node) throw new CanvasFailure(`目标已不存在：${nodeId}`, 404)
    if (node.type !== 'timeline' && canvasMediaOf(node) !== 'art') {
      throw new CanvasFailure('只有时间线与 Art 节点能导出视频', 422)
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
      const doc = await this.load(await this.locate(workspaceRoot, session.canvas))
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
      const rel = await this.relativeTo(workspaceRoot, final)
      const { refs } = await this.apply(workspaceRoot, session.canvas, [
        { op: 'add_file', ref: '$export', path: rel, beside: session.source },
      ])
      return { nodeId: refs.$export!, path: rel }
    } catch (err) {
      await file.close().catch(() => {})
      await rm(session.part, { force: true })
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
    await (await session.file.catch(() => null))?.close().catch(() => {})
    await rm(session.part, { force: true })
  }

  /** 删除当前项目 `generated/` 中不属于进行中会话的导出临时文件，即进程被结束时未能删除的文件。 */
  private async sweepExports(root: string): Promise<void> {
    const dir = join(root, EXPORT_DIR)
    for (const name of await readdir(dir)) {
      const id = EXPORT_PART.exec(name)?.[1]
      if (id && !this.exports.has(id)) await rm(join(dir, name), { force: true })
    }
  }

  /**
   * 接收从本机选择的文件，按原名写入工作区 `uploads/`（不覆盖，重名时加 `-2`），并添加一个引用它的节点：
   * 给出 `beside` 时放在该节点右侧的空位，否则以 `near` 为中心查找空位。画布只引用文件，删除节点不删除文件。
   */
  async upload(
    workspaceRoot: string,
    path: string,
    name: string,
    bytes: Uint8Array,
    place: { near: { x: number; y: number } } | { beside: string },
  ): Promise<{ nodeId: string; path: string }> {
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
      throw new CanvasFailure(`文件名不合法：${name}`, 422)
    }
    await this.locate(workspaceRoot, path)
    const [landed] = await landFiles(
      workspaceRoot,
      // 按原名落盘：未登记的类型不改扩展名。
      [{ bytes, mime: 'application/octet-stream' }],
      `uploads/${name.replace(/[:*?"<>|]/g, '_')}`,
    )
    const { refs } = await this.apply(workspaceRoot, path, [
      {
        op: 'add_file',
        ref: '$file',
        path: landed!.path,
        ...('beside' in place ? { beside: place.beside } : { near: place.near }),
      },
    ])
    return { nodeId: refs.$file!, path: landed!.path }
  }

  /**
   * 从系统拖入的本机文件（绝对路径）：位于工作区中的直接引用，位于工作区外的按原名复制到 `uploads/`。
   * 第一个文件以 `near` 为中心查找空位，之后的依次排在前一个右侧。返回新节点的 id；任一路径不存在或不是文件时停止并报错。
   */
  async importPaths(
    workspaceRoot: string,
    path: string,
    files: string[],
    near: { x: number; y: number },
  ): Promise<string[]> {
    await this.locate(workspaceRoot, path)
    const ids: string[] = []
    for (const file of files) {
      const abs = await realpath(file).catch(() => {
        throw new CanvasFailure(`${file} 不存在`, 404)
      })
      if (!(await stat(abs)).isFile()) throw new CanvasFailure(`${file} 不是文件`, 422)
      const inside = await this.relativeTo(workspaceRoot, abs).catch(() => null)
      const rel =
        inside ??
        (
          await landFiles(
            workspaceRoot,
            [{ bytes: new Uint8Array(await readFile(abs)), mime: 'application/octet-stream' }],
            `uploads/${basename(abs)}`,
          )
        )[0]!.path
      const prev = ids.at(-1)
      const { refs } = await this.apply(workspaceRoot, path, [
        { op: 'add_file', ref: '$f', path: rel, ...(prev ? { beside: prev } : { near }) },
      ])
      ids.push(refs.$f!)
    }
    return ids
  }

  /** 工作区中的画布文件（工作区相对路径），按名称搜索，跳过依赖与构建产物目录（与文件树的搜索一致）。 */
  async list(workspaceRoot: string): Promise<string[]> {
    const { matches } = await findByName(workspaceRoot, CANVAS_SUFFIX, {
      hits: Number.POSITIVE_INFINITY,
      entries: Number.POSITIVE_INFINITY,
    })
    return matches
      .filter((m) => m.kind === 'file' && m.path.endsWith(CANVAS_SUFFIX))
      .map((m) => m.path)
  }

  /**
   * 读取画布与各节点状态。文件格式错误时返回 422，原文件不变。
   * `agent` 为真时生成卡的参数为实际发送的参数（`agentView`）；界面需要卡片保存的全部偏好，不使用该投影。
   */
  async read(workspaceRoot: string, path: string, agent = false): Promise<CanvasView> {
    const abs = await this.locate(workspaceRoot, path)
    const doc = await this.load(abs)
    const states: Record<string, CanvasNodeState> = {}
    const tasks: Record<string, CanvasTaskInfo> = {}
    const references: Record<string, string[]> = {}
    const read = new Map<string, string | null>()
    for (const node of doc.nodes) {
      if (node.type === 'generate') {
        const texts = await this.textsOf(workspaceRoot, doc, node.id, read)
        const broken = textReferenceProblems(doc, node.id, texts)
        if (broken.length) references[node.id] = broken
      }
      states[node.id] = await this.stateOf(
        workspaceRoot,
        keyOf(workspaceRoot, path),
        node,
        doc.runs?.findLast((r) => r.node === node.id),
      )
      if (node.type === 'generate') {
        for (const version of node.versions.filter((v) => v.path.endsWith(TASK_SUFFIX))) {
          const task = await this.readTask(workspaceRoot, version.path)
          if (task) tasks[version.id] = task
        }
      }
    }
    const view: CanvasView = {
      path: await this.relativeTo(workspaceRoot, abs),
      doc,
      states,
      ...(Object.keys(tasks).length ? { tasks } : {}),
      ...(Object.keys(references).length ? { references } : {}),
    }
    return agent ? agentView(view, this.deps.paramSpecsOf) : view
  }

  /**
   * 应用一批界面操作并写入，整批成立才写入，返回应用后的文档与批内名称对照。
   * 文件节点的路径先按工作区核实，并规范化为正斜杠相对路径；运行中的卡片不能删除（409）。
   * 大模型的操作走 `applyAgent`。
   */
  apply(
    workspaceRoot: string,
    path: string,
    ops: CanvasOp[],
  ): Promise<{ doc: CanvasDoc; refs: Record<string, string>; step: CanvasStep }> {
    return this.enqueue(keyOf(workspaceRoot, path), async () => {
      const abs = await this.locate(workspaceRoot, path)
      const normalized = await Promise.all(ops.map((op) => this.normalizePath(workspaceRoot, op)))
      const r = await this.commit(abs, (doc) => {
        this.refuseRemovingRunning(workspaceRoot, path, doc, normalized)
        return applyCanvasOps(doc, normalized, this.deps.newId)
      })
      return { doc: r.doc, refs: r.refs, step: r.step }
    })
  }

  /**
   * 大模型提交的一批操作：逐条生效。某条不成立时跳过并记录原因（`at` 为该条在 `ops` 中的序号），
   * 其余照常执行；引用了被跳过操作的批内名称的操作同样不成立。每条按大模型的规则核对（`prepareAgentOps`）。
   *
   * 全部成立时整批应用一次，与界面相同。有不成立的条目时，依次把每一条加入已保留的条目试应用，成立才保留，
   * 最后把保留的条目整批应用一次：未给出位置的新卡于本批全部连线之后按组排位（core `arrangeNew`），
   * 逐条分别写入会使新卡先于连线排位。
   */
  applyAgent(
    workspaceRoot: string,
    path: string,
    ops: CanvasOp[],
  ): Promise<{
    before: CanvasDoc
    doc: CanvasDoc
    refs: Record<string, string>
    step: CanvasStep
    skipped: { at: number; error: string }[]
  }> {
    return this.enqueue(keyOf(workspaceRoot, path), async () => {
      const abs = await this.locate(workspaceRoot, path)
      const unready: { at: number; error: string }[] = []
      const ready: { at: number; op: CanvasOp }[] = []
      for (const [at, op] of ops.entries()) {
        try {
          ready.push({ at, op: await this.normalizePath(workspaceRoot, op) })
        } catch (err) {
          if (!(err instanceof CanvasFailure)) throw err
          unready.push({ at, error: err.message })
        }
      }
      let before: CanvasDoc = emptyCanvas()
      let skipped: { at: number; error: string }[] = []
      const specs = this.deps.paramSpecsOf
      const attempt = (doc: CanvasDoc, list: CanvasOp[], newId?: () => string): CanvasResult => {
        try {
          const prepared = prepareAgentOps(doc, list, specs)
          this.refuseRemovingRunning(workspaceRoot, path, doc, prepared)
          const applied = applyCanvasOps(doc, prepared, newId)
          if (applied.ok) checkActiveParams(doc, applied.doc, prepared, specs)
          return applied
        } catch (err) {
          return { ok: false, error: (err as Error).message }
        }
      }
      const r = await this.commit(abs, (doc) => {
        before = doc
        skipped = [...unready]
        const all = attempt(
          doc,
          ready.map((x) => x.op),
          this.deps.newId,
        )
        if (all.ok || ready.length === 0) {
          return all.ok ? all : { ok: true, doc, refs: {} }
        }
        // 试应用使用另一个 id 来源：结果只用于判定，不应消耗最终写入所用的 id。
        const kept: CanvasOp[] = []
        for (const { at, op } of ready) {
          const tried = attempt(doc, [...kept, op])
          if (tried.ok) kept.push(op)
          else skipped.push({ at, error: tried.error })
        }
        if (kept.length === 0) return { ok: true, doc, refs: {} }
        const final = attempt(doc, kept, this.deps.newId)
        if (!final.ok) throw new CanvasFailure(final.error, 422)
        return final
      })
      skipped.sort((a, b) => a.at - b.at)
      return { before, doc: r.doc, refs: r.refs, step: r.step, skipped }
    })
  }

  /**
   * 撤销与重做：当前文件的指纹仍为 `from` 时，恢复为本服务记录的、指纹为 `to` 的文档。
   * 期间文件被其他写入者修改（Agent、生成回写、手动编辑）时返回 409，不覆盖；`to` 已不在记录中时返回 404。
   * 恢复的文档均由本服务读取或写入过，版本记录与实际内容一致。
   */
  restore(workspaceRoot: string, path: string, from: string, to: string): Promise<CanvasStep> {
    return this.enqueue(keyOf(workspaceRoot, path), async () => {
      const abs = await this.locate(workspaceRoot, path)
      const text = this.snapshots.get(abs)?.get(to)
      if (text === undefined) throw new CanvasFailure('该步骤已无法撤销', 404)
      const target = this.parse(text)
      const r = await this.commit(abs, (doc) => {
        if (fingerprint(serializeCanvas(doc)) !== from) {
          throw new CanvasFailure('画布在此之后已被修改，无法撤销', 409)
        }
        return { ok: true, doc: target, refs: {} }
      })
      return r.step
    })
  }

  /**
   * 串行修改一个画布文件。`change` 抛出 `CanvasFailure` 或返回 `ok: false` 时均不写入。
   *
   * 调用时立即进入队列，路径解析在队列中执行：若先解析再排队，同一客户端连续发送的两次修改
   * 可能按解析完成的先后落盘，导致后发送的先写入。
   */
  mutate(
    workspaceRoot: string,
    path: string,
    change: (doc: CanvasDoc) => CanvasResult,
  ): Promise<Extract<CanvasResult, { ok: true }> & { step: CanvasStep }> {
    return this.enqueue(keyOf(workspaceRoot, path), async () =>
      this.commit(await this.locate(workspaceRoot, path), change),
    )
  }

  /** 记录一份文档，返回其指纹。 */
  private remember(abs: string, text: string): string {
    const fp = fingerprint(text)
    let kept = this.snapshots.get(abs)
    if (!kept) {
      kept = new Map()
      this.snapshots.set(abs, kept)
    }
    kept.delete(fp)
    kept.set(fp, text)
    for (const oldest of kept.keys()) {
      if (kept.size <= SNAPSHOTS) break
      kept.delete(oldest)
    }
    return fp
  }

  /**
   * 读取 → 应用 → 写 `.part` → 改名前复读 → 改名。应用前后字节相同时不写入、不发送通知。
   * 前后两份均按规范化文本记录，供撤销恢复。
   */
  private async commit(
    abs: string,
    change: (doc: CanvasDoc) => CanvasResult,
  ): Promise<Extract<CanvasResult, { ok: true }> & { step: CanvasStep }> {
    for (let attempt = 0; attempt < MAX_REAPPLY; attempt++) {
      const before = await this.readText(abs)
      const current = this.parse(before)
      const r = change(current)
      if (!r.ok) throw new CanvasFailure(r.error, 422)
      const was = this.remember(abs, serializeCanvas(current))
      const text = serializeCanvas(r.doc)
      if (text === before) return { ...r, step: { before: was, after: was } }
      const part = `${abs}.part`
      try {
        await this.io.writeFile(part, text)
        if ((await this.readText(abs)) !== before) continue
        await this.io.rename(part, abs)
      } finally {
        await rm(part, { force: true })
      }
      this.changed()
      return { ...r, step: { before: was, after: this.remember(abs, text) } }
    }
    throw new CanvasFailure('画布文件正在被连续修改，请稍后重试', 409)
  }

  /** 一个节点的状态，次序见 `CanvasNodeState`。`canvasKey` 见 `keyOf`。 */
  private async stateOf(
    workspaceRoot: string,
    canvasKey: string,
    node: CanvasNode,
    lastRun?: CanvasRunRecord,
  ): Promise<CanvasNodeState> {
    const exists = (path: string) =>
      stat(join(workspaceRoot, path)).then(
        (s) => s.isFile(),
        () => false,
      )
    if (node.type === 'file') {
      return (await exists(node.path)) ? { state: 'normal' } : { state: 'missing' }
    }
    if (node.type === 'timeline') {
      const found = await Promise.all(node.clips.map((c) => exists(c.path)))
      return found.every(Boolean) ? { state: 'normal' } : { state: 'missing' }
    }
    const key = `${canvasKey}#${node.id}`
    const run = this.running.get(key)
    if (run) {
      return {
        state: 'running',
        startedAt: run.startedAt,
        action: run.action,
        ...(run.version ? { version: run.version } : {}),
        ...(run.requestSent !== undefined && !run.task
          ? { stage: run.requestSent ? ('submitting' as const) : ('preparing' as const) }
          : {}),
        ...(run.task ? { taskId: run.task.taskId } : {}),
        ...(run.phase ? { phase: run.phase } : {}),
      }
    }
    const tasks = node.versions.filter((v) => v.path.endsWith(TASK_SUFFIX))
    const pending = tasks.find((v) => v.id === node.current)
    if (pending) return { state: 'pending', version: pending.id }
    const relevant =
      lastRun?.action !== 'retrieve' || !node.current || lastRun.version === node.current
    if (relevant && (lastRun?.result === 'unknown' || lastRun?.result === 'failed'))
      return {
        state: lastRun.result,
        message: lastRun.message ?? (lastRun.result === 'unknown' ? '远端结果未知' : '生成失败'),
      }
    const failure = this.failures.get(key)
    if (relevant && failure !== undefined) return { state: 'failed', message: failure }
    const current = node.versions.find((v) => v.id === node.current)
    if (!current) return { state: 'empty' }
    return (await exists(current.path)) ? { state: 'normal' } : { state: 'missing' }
  }

  /** 删除节点或正在生成的版本：目标运行中时拒绝，否则生成成功后无法找到回写位置。 */
  private refuseRemovingRunning(
    workspaceRoot: string,
    path: string,
    doc: CanvasDoc,
    ops: CanvasOp[],
  ): void {
    const canvasKey = keyOf(workspaceRoot, path)
    for (const op of ops) {
      if (op.op !== 'remove') continue
      // 大模型按卡片名称引用，先按 id、再按名称找到节点。
      const node =
        doc.nodes.find((n) => n.id === op.id) ?? doc.nodes.find((n) => displayNameOf(n) === op.id)
      if (!node || !this.running.has(`${canvasKey}#${node.id}`)) continue
      const inFlight =
        op.version === undefined ||
        (node?.type === 'generate' &&
          node.versions.some((v) => v.id === op.version && v.path.endsWith(TASK_SUFFIX)))
      if (inFlight) throw new CanvasFailure('该卡片正在生成，请在生成结束后删除', 409)
    }
  }

  /**
   * `add_file` / `update` 中的文件路径：必须是工作区中已有的文件，写为正斜杠相对路径；
   * 同时从文件头读取像素宽高填入 `size`，节点框按文件的比例确定。操作已给出 `w` / `h` 时不读取。
   */
  private async normalizePath(workspaceRoot: string, op: CanvasOp): Promise<CanvasOp> {
    if ((op.op === 'add_timeline' || op.op === 'update') && op.clips !== undefined) {
      const clips = await Promise.all(op.clips.map((c) => this.normalizeClip(workspaceRoot, c)))
      op = { ...op, clips }
    }
    if ((op.op !== 'add_file' && op.op !== 'update') || op.path === undefined) return op
    const abs = await this.existingFile(workspaceRoot, op.path)
    const path = await this.relativeTo(workspaceRoot, abs)
    if (op.w !== undefined || op.h !== undefined) return { ...op, path }
    return { ...op, path, ...sizeField(await mediaSizeOf(abs)) }
  }

  /** 时间线片段：文件按 `normalizePath` 的规则核实；出点超过视频时长（可读取时长时）返回 422。 */
  private async normalizeClip(workspaceRoot: string, clip: CanvasClip): Promise<CanvasClip> {
    const abs = await this.existingFile(workspaceRoot, clip.path)
    const path = await this.relativeTo(workspaceRoot, abs)
    const duration = await mediaDurationOf(abs)
    // 容差为一帧：界面按播放器读取的时长裁剪，与 `mvhd` 的取整值可能相差几毫秒。
    if (duration !== null && clip.out > duration + 1 / 30) {
      throw new CanvasFailure(
        `片段超出视频时长：${path} 时长为 ${Math.round(duration * 100) / 100} 秒，出点为 ${clip.out} 秒`,
        422,
      )
    }
    return { ...clip, path }
  }

  private async existingFile(workspaceRoot: string, path: string): Promise<string> {
    let abs: string
    try {
      abs = await resolveInWorkspace(workspaceRoot, path, { mustExist: true, literal: true })
    } catch {
      throw new CanvasFailure(`${path} 不存在或不在当前项目中`, 422)
    }
    if (!(await stat(abs)).isFile()) throw new CanvasFailure(`${path} 不是文件`, 422)
    return abs
  }

  private async relativeTo(workspaceRoot: string, abs: string): Promise<string> {
    const rel = relative(await realpath(workspaceRoot), abs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new CanvasFailure(`${abs} 不在工作区中，画布只引用工作区中的文件`, 422)
    }
    return toPosixPath(rel)
  }

  private async load(abs: string): Promise<CanvasDoc> {
    return this.parse(await this.readText(abs))
  }

  private parse(text: string): CanvasDoc {
    const r = parseCanvas(text)
    if (!r.ok) throw new CanvasFailure(`画布文件格式错误：${r.error}`, 422)
    return r.doc
  }

  private async readText(abs: string): Promise<string> {
    try {
      return await this.io.readFile(abs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CanvasFailure('画布文件不存在', 404)
      }
      throw err
    }
  }

  /** 磁盘内容已变化：更新各客户端的文件快照，不计入「本轮改动」。 */
  private changed(): void {
    this.deps.publish({ type: 'file.changed', runId: null, changes: [] })
  }

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    const settled = next.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(key, settled)
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key)
    })
    return next
  }
}

/**
 * 设计稿页面引用的工作区图片连到该 art 卡：未放上画布的先放上，已连接的不重复连接。
 * 连线使图片来源在画布上可见，重新生成时这些图片也作为参考图交给模型。
 * 不成立时（例如该卡已不存在）保持原文档：版本已写入，补连线不应使回写失败。
 */
function linkArtImages(doc: CanvasDoc, nodeId: string, paths: readonly string[]): CanvasResult {
  const connected = new Set(inputsOf(doc, nodeId).map((e) => e.from))
  const ops: CanvasOp[] = []
  for (const [i, path] of paths.entries()) {
    const placed = doc.nodes.find((n) => n.type === 'file' && n.path === path)
    if (placed && connected.has(placed.id)) continue
    const from = placed ? placed.id : `$img${i}`
    if (!placed) ops.push({ op: 'add_file', ref: from, path })
    ops.push({ op: 'connect', from, to: nodeId, role: 'reference' })
  }
  if (!ops.length) return { ok: true, doc, refs: {} }
  const linked = applyCanvasOps(doc, ops)
  return linked.ok ? linked : { ok: true, doc, refs: {} }
}

/**
 * 一批操作前后的差异：新增或内容有变化的节点 id、删除的节点名称，以及每条执行了的 `replace_text` 替换的处数。
 * 节点按序列化后的内容比较，位置随排位移动的节点同样计入。
 */
function changesOf(
  before: CanvasDoc,
  after: CanvasDoc,
  ops: readonly CanvasOp[],
  skipped: readonly { at: number }[],
): { changed: string[]; removed: string[]; replaced: { at: number; count: number }[] } {
  const old = new Map(before.nodes.map((n) => [n.id, JSON.stringify(n)]))
  const edges = (doc: CanvasDoc, id: string) =>
    JSON.stringify(doc.edges.filter((e) => e.to === id).map((e) => [e.from, e.role]))
  const changed = after.nodes
    .filter(
      (n) => old.get(n.id) !== JSON.stringify(n) || edges(before, n.id) !== edges(after, n.id),
    )
    .map((n) => n.id)
  const kept = new Set(after.nodes.map((n) => n.id))
  const removed = before.nodes.filter((n) => !kept.has(n.id)).map(displayNameOf)
  const failed = new Set(skipped.map((s) => s.at))
  const replaced = ops.flatMap((op, at) => {
    if (op.op !== 'replace_text' || failed.has(at)) return []
    const target = cardIdOf(before, op.id)
    const node = target.ok ? before.nodes.find((n) => n.id === target.id) : undefined
    if (node?.type !== 'generate' || !op.old) return []
    return [{ at, count: node.prompt.split(op.old).length - 1 }]
  })
  return { changed, removed, replaced }
}

/**
 * 提供给会话的画布端口：使用同一个画布服务，绑定该会话所在的项目。
 * 运行与取回在工具中等待至结束；中止信号来自本轮，停止本轮即停止等待，视频版本保留以待取回。
 * 修改按大模型的规则核对（`prepareAgentOps`），读取的生成卡参数为实际发送的参数（`agentView`）。
 */
/** 绑定到一条会话的设计稿渲染：渲染页归该会话所有（`BrowserCoordinator.renderArt`）。 */
export function artRenderOf(
  browser: BrowserCoordinator,
  conversationId: string,
  workspaceId: string,
  workspaceRoot: string,
): ArtRender {
  return (page) => browser.renderArt(conversationId, workspaceId, { ...page, workspaceRoot })
}

export function canvasPort(
  service: CanvasService,
  ws: CanvasWorkspace,
  render?: ArtRender,
): CanvasPort {
  return {
    create: (path) => service.create(ws.root, { path }),
    list: () => service.list(ws.root),
    textReferences: (path) => service.textReferences(ws.root, path),
    ...(render
      ? {
          render: (path: string, nodes: string[]) =>
            service.renderArt(ws.root, path, nodes, render),
        }
      : {}),
    read: (path) => service.read(ws.root, path, true),
    edit: async (path, ops) => {
      const { before, doc, refs, skipped } = await service.applyAgent(ws.root, path, ops)
      return {
        view: await service.read(ws.root, path, true),
        refs,
        skipped,
        ...changesOf(before, doc, ops, skipped),
      }
    },
    run: async (path, nodeId, media, signal) =>
      (await service.run(ws, path, nodeId, { media, signal })).done,
    runBatch: (path, nodeIds, media, signal) =>
      service.runBatch(ws, path, nodeIds, { media, signal }),
    retrieve: async (path, nodeId, version, media, signal) =>
      (await service.retrieve(ws, path, nodeId, version, { media, signal })).done,
  }
}
