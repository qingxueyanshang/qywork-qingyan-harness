/**
 * 画布服务：对 `*.canvas.json` 的写入与画布上的生成只经这里执行。界面走 `api/canvas.ts`，
 * Agent 走 `CanvasPort`，两处调同一个实例。
 *
 * 独占的事实：
 * - 写入次序：同一个画布文件的修改串行执行（读 → 应用 → 写 `.part` → 改名前复读 → 改名）；
 * - 哪张卡在跑、每张卡最近一次失败的原文：只在进程内，重启即无。
 *
 * 画布文件之外还有写入者（Agent 的 `write_file`、CLI 会话、外部编辑器），所以改名前再读一次：
 * 字节变了就在新内容上重新应用，不覆盖别人的改动。
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
import type { CanvasPort, MediaPort } from '@qywork/agent'
import { type TaskPhase, taskPhase } from '@qywork/ai'
import {
  type AgentEvent,
  addVersions,
  applyCanvasOps,
  type CanvasClip,
  type CanvasDoc,
  type CanvasGenerateNode,
  type CanvasMade,
  type CanvasNode,
  type CanvasNodeState,
  type CanvasOp,
  type CanvasPixels,
  type CanvasResult,
  type CanvasRunResult,
  type CanvasVersion,
  type CanvasView,
  canvasMediaOf,
  compilePrompt,
  displayNameOf,
  emptyCanvas,
  inputsOf,
  type MediaOutput,
  type MentionStyle,
  newCanvasId,
  parseCanvas,
  serializeCanvas,
  settleVersion,
  toPosixPath,
} from '@qywork/core'
import {
  freeLandingPath,
  type GeneratedFile,
  generateMedia,
  landFiles,
  renameWithRetry,
  resolveInWorkspace,
  resumeMedia,
  TASK_SUFFIX,
} from '@qywork/tools'
import { findByName } from './files.ts'
import { mediaDurationOf, mediaSizeOf } from './media-size.ts'

/** 画布文件的后缀。文件树按它把文件交给画布页签打开。 */
export const CANVAS_SUFFIX = '.canvas.json'

/** 画布服务的失败。`status` 是 HTTP 状态码；`message` 界面直接显示、工具原样交给模型。 */
export class CanvasFailure extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 422,
  ) {
    super(message)
  }
}

/** 读写文件的函数。只在测试里替换，用来在写入中途插入外部改动或故障。 */
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

/** 撤销能换回的整份文档：每个画布文件记最近这么多份。 */
const SNAPSHOTS = 100

/** 文档内容的指纹。撤销请求用它确认「当前文件仍是那次编辑写下的那一份」。 */
function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** 一次写盘前后两份文档的指纹；没有改动时两者相同。 */
export interface CanvasStep {
  before: string
  after: string
}

/** PNG 文件头。取帧只收 PNG：浏览器导出的就是它，别的格式说明请求不是来自取帧。 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** 改名前复读发现文件变了时重新应用的次数上限。 */
const MAX_REAPPLY = 5

/**
 * 写入队列、在跑集合与失败记录的键：画布按字面拼出的绝对路径。
 * 不用相对路径：多个工作区并存时，两个工作区根下同名的画布会撞在一起。
 * 不等 `realpath`：键要在调用当下同步得出，才能按调用顺序排队。
 */
function keyOf(workspaceRoot: string, path: string): string {
  return resolve(workspaceRoot, path)
}

/** 一次视频生成的产物里那段视频（随它返回的还可能有尾帧图）。 */
function videoOf(files: GeneratedFile[]): GeneratedFile {
  return files.find((f) => f.mime.startsWith('video/')) ?? files[0]!
}

/**
 * 视频那一版改指到产物；随视频返回的尾帧图各加一个节点，名字 `<卡片名>_尾帧`，放在卡片右侧，
 * 下一段直接从它接出首帧。`sizes` 是各产物的像素宽高（`sizesOf`），框按它定比例。
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

/** 可选的 `size` 字段：读不出尺寸时不写这个键。 */
function sizeField(size: CanvasPixels | null | undefined): { size?: CanvasPixels } {
  return size ? { size } : {}
}

export interface CanvasServiceDeps {
  /** 发一条全局事件（不带会话 id）。 */
  publish(event: AgentEvent): void
  /** 与对话共用更新占位；文件校验结束后、开始生成前再检查一次。 */
  updating?(): boolean
  /** 这一次生成要用的模型在提示词里怎么指代素材；不给就按节点名写进提示词。 */
  mentionStyleOf?(
    output: MediaOutput,
    pick: { provider: string; model: string } | undefined,
  ): MentionStyle | undefined
  /** 只替换给出的那几个函数，其余用默认实现。 */
  io?: Partial<CanvasIo>
  /** 新节点、新连线的 id。只在测试里注入，让两条路径写出的文件可以逐字节比较。 */
  newId?: () => string
  /** 导出会话多久没有写入就作废（毫秒）。只在测试里缩短。 */
  exportIdleMs?: number
}

/** 时间线导出的上传会话。`part` 是正在写的临时文件的绝对路径，`target` 是想落成的工作区路径（完成时再按撞名规则挑）。 */
interface ExportSession {
  root: string
  canvas: string
  source: string
  target: string
  part: string
  /** 先登记会话、再建文件：启动清理按会话号判断临时文件是否在用，登记在后会删到正在建的那一个。 */
  file: Promise<FileHandle>
  timer: ReturnType<typeof setTimeout>
}

/** 成片与导出临时文件所在的工作区目录。 */
const EXPORT_DIR = 'generated'
/** 导出临时文件名 `.<会话号>.part`。启动清理只删这个形状的文件，不碰生成落盘的 `.part` 与用户文件。 */
const EXPORT_PART = /^\.([0-9a-f-]{36})\.part$/

/** 导出会话的空闲上限：编码一块不会超过它，超过说明浏览器那头已经不在了。 */
const EXPORT_IDLE_MS = 10 * 60_000

/** 画布所在的项目：根目录定位文件，id 写进 `canvas.run` 事件。 */
export interface CanvasWorkspace {
  id: string
  root: string
}

/**
 * 运行或取回由谁付费、何时中止，由调用方给：界面发起的用服务端造的端口（花费记成无轮次的账），
 * Agent 发起的用它本轮的 `ctx.media`（花费进本轮）与本轮的中止信号。
 */
export interface CanvasRunOptions {
  media: MediaPort
  signal?: AbortSignal
}

/** 生成卡的一次远端视频任务，以及指向它的那一版（任务号到手时没能写进画布则为 null）。 */
interface CanvasTask {
  taskId: string
  provider: string
  model: string
  /** 任务记录的工作区路径。 */
  record: string
  versionId: string | null
}

/** 撤销远端任务的结果：`unsupported` 是接口没有撤销。由调用方按配置实现，见 `cancel`。 */
export type CanvasCancelTask = (task: {
  taskId: string
  provider: string
  model: string
}) => Promise<'cancelled' | 'started' | 'unsupported'>

/** 一张卡的一次生成（运行或取回）。 */
interface RunEntry {
  startedAt: number
  done?: Promise<CanvasRunResult>
  /** 只停这一次生成的本地等待：远端撤销成功后用。 */
  stop: AbortController
  /** 这次生成会不会有远端任务：视频会，图像与音频是一次请求、没有任务号。 */
  expectsTask: boolean
  task?: CanvasTask
  /** 平台回报的排队中 / 生成中；回报之前没有。 */
  phase?: TaskPhase
  /** 任务号到手时兑现：取消在任务号到手之前到达时等它。 */
  taskArrived: Promise<void>
  arrive: () => void
  /** 远端已撤销：收尾时删掉这一版与任务记录，不记失败。 */
  cancelled?: true
}

export class CanvasService {
  private readonly queues = new Map<string, Promise<unknown>>()
  /** 键：`画布绝对路径#节点 id`。多个工作区并存时相对路径会撞。 */
  private readonly running = new Map<string, RunEntry>()
  private readonly shutdown = new AbortController()
  private recovering = false
  private recovery: Promise<void> | undefined
  /** 按画布文件的绝对路径记下本服务读过、写过的文档（规范化后的文本），键是指纹。只增不改，超出上限丢最早的。 */
  private readonly snapshots = new Map<string, Map<string, string>>()
  private readonly failures = new Map<string, string>()
  private readonly io: CanvasIo

  private readonly exports = new Map<string, ExportSession>()
  private readonly exportIdleMs: number

  constructor(private readonly deps: CanvasServiceDeps) {
    this.io = { ...NODE_IO, ...deps.io }
    this.exportIdleMs = deps.exportIdleMs ?? EXPORT_IDLE_MS
  }

  /** 扫描中的恢复也算忙，防止尚未找到待接续卡片时就取得更新占位。 */
  get busyCount(): number {
    return Math.max(this.running.size, Number(this.recovering))
  }

  /** 启动时接续各工作区已有的视频任务，沿用原任务号与取回路径，绝不重新生成。 */
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
          // 删不掉的留到下次启动再删，不影响接续任务。
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
                      // 用户先取回了同一卡片时沿用那次调用；其余错误保留任务记录供手动重试。
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

  /** 停止本地等待，保留远端任务记录；结束在办导出并删掉临时文件；等待收尾后再关闭账本。 */
  async stop(): Promise<void> {
    this.shutdown.abort()
    await Promise.all([...this.exports.keys()].map((id) => this.dropExport(id)))
    await this.recovery?.catch(() => {})
    await Promise.all([...this.running.values()].map((run) => run.done))
  }

  /** 画布文件的绝对路径。不在工作区里、不存在、不是画布文件，都按入参问题回 422 / 404。 */
  async locate(workspaceRoot: string, path: string): Promise<string> {
    if (!path.endsWith(CANVAS_SUFFIX)) throw new CanvasFailure(`${path} 不是画布文件`, 422)
    try {
      return await resolveInWorkspace(workspaceRoot, path, { mustExist: true, literal: true })
    } catch {
      throw new CanvasFailure(`${path} 不存在或不在这个项目里`, 404)
    }
  }

  /** 在工作区根新建一张空画布，返回工作区相对路径。 */
  async create(workspaceRoot: string, now = new Date()): Promise<string> {
    const p = (n: number) => String(n).padStart(2, '0')
    const stamp =
      `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
      `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
    for (let n = 1; ; n++) {
      const name = `canvas-${stamp}${n === 1 ? '' : `-${n}`}${CANVAS_SUFFIX}`
      try {
        await writeFile(join(workspaceRoot, name), serializeCanvas(emptyCanvas()), { flag: 'wx' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw err
      }
      this.changed()
      return name
    }
  }

  /**
   * 运行一张生成卡。在跑、输入还没有结果、提示词为空都在返回之前以 `CanvasFailure` 抛出；
   * 返回的 `done` 在生成结束、画布回写之后兑现，从不拒绝。
   *
   * 视频的任务号一到手就追加一版指向任务记录，之后停止、超时、进程退出都能取回；成功后按版本 id
   * 把这一版改指到产物。图像与音频成功后才追加版本，多张就是多版。
   */
  async run(
    ws: CanvasWorkspace,
    path: string,
    nodeId: string,
    opts: CanvasRunOptions,
  ): Promise<{ done: Promise<CanvasRunResult> }> {
    const { rel, key, node, doc } = await this.target(ws, path, nodeId)
    if (!node.prompt.trim()) throw new CanvasFailure(`「${node.name}」的提示词为空`, 422)
    const inputs: CanvasMade['inputs'] = []
    for (const edge of inputsOf(doc, nodeId)) {
      const source = doc.nodes.find((n) => n.id === edge.from)!
      // 时间线不能作为输入（`validateCanvas` 拒绝），不会走到这里。
      const file =
        source.type === 'file'
          ? source.path
          : source.type === 'generate'
            ? source.versions.find((v) => v.id === source.current)?.path
            : undefined
      if (!file || file.endsWith(TASK_SUFFIX)) {
        throw new CanvasFailure(`「${displayNameOf(source)}」还没有结果`, 422)
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
    const prompt = compilePrompt(doc, nodeId, this.deps.mentionStyleOf?.(node.output, pick))
    const made = (provider: string, model: string): CanvasMade => ({
      prompt,
      provider,
      model,
      params: node.params,
      inputs,
      at: new Date().toISOString(),
    })

    const entry = this.begin(key, ws, rel, nodeId, node.output === 'video')
    const done = this.settleRun(key, ws, rel, nodeId, async () => {
      let versionId: string | null = null
      const outcome = await generateMedia({
        roots: ws.root,
        media: opts.media,
        signal: this.signalFor(entry, opts.signal),
        onStatus: (status) => this.advance(entry, ws, rel, nodeId, status),
        type: node.output,
        prompt,
        inputs,
        params: node.params,
        ...(pick ? { pick } : {}),
        onTask: async ({ record, taskId, provider, model }) => {
          const id = newCanvasId()
          await this.mutate(ws.root, rel, (d) =>
            addVersions(d, nodeId, [{ id, path: record, made: made(provider, model) }]),
          ).then(
            () => {
              versionId = id
            },
            () => {},
          )
          entry.task = { taskId, provider, model, record, versionId }
          entry.arrive()
        },
      })
      if (!outcome.ok) {
        if (versionId && !outcome.record) await this.dropVersion(ws.root, rel, nodeId, versionId)
        return { ok: false, message: outcome.message, pending: outcome.record !== undefined }
      }
      const files = outcome.files
      const sizes = await this.sizesOf(ws.root, files)
      const version = (path: string) => ({
        id: newCanvasId(),
        path,
        made: made(outcome.provider, outcome.model),
        ...sizeField(sizes.get(path)),
      })
      const id: string | null = versionId
      return this.writeBack(ws.root, rel, files, (d) => {
        if (node.output !== 'video')
          return addVersions(
            d,
            nodeId,
            files.map((f) => version(f.path)),
          )
        if (id) return settleVideo(d, nodeId, id, files, sizes)
        // 任务号到手时没能写进画布（被外部改写），成功后补一版。
        const late = version(videoOf(files).path)
        const added = addVersions(d, nodeId, [late])
        return added.ok ? settleVideo(added.doc, nodeId, late.id, files, sizes) : added
      })
    })
    this.running.get(key)!.done = done
    return { done }
  }

  /**
   * 取回一版还在远端的视频：只查询与下载，不再提交。`versionId` 缺省取当前版，当前版不是任务记录时取最新那个。
   * 远端已失败或结果已过期时删掉这一版与记录。
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

    const entry = this.begin(key, ws, rel, nodeId, true)
    const done = this.settleRun(key, ws, rel, nodeId, async () => {
      if (!(await this.isFile(ws.root, version.path))) {
        await this.dropVersion(ws.root, rel, nodeId, version.id)
        return { ok: false, message: `任务记录已不存在：${version.path}`, pending: false }
      }
      const task = await this.readTask(ws.root, version.path)
      if (task) entry.task = { ...task, record: version.path, versionId: version.id }
      entry.arrive()
      const outcome = await resumeMedia({
        roots: ws.root,
        media: opts.media,
        signal: this.signalFor(entry, opts.signal),
        onStatus: (status) => this.advance(entry, ws, rel, nodeId, status),
        record: version.path,
      })
      if (!outcome.ok) {
        if (outcome.executed && !outcome.record) {
          await this.dropVersion(ws.root, rel, nodeId, version.id)
        }
        return { ok: false, message: outcome.message, pending: outcome.record !== undefined }
      }
      const sizes = await this.sizesOf(ws.root, outcome.files)
      return this.writeBack(ws.root, rel, outcome.files, (d) =>
        settleVideo(d, nodeId, version.id, outcome.files, sizes),
      )
    })
    this.running.get(key)!.done = done
    return { done }
  }

  /** 运行与取回共用的前置：画布、节点、不在跑。 */
  private async target(
    ws: CanvasWorkspace,
    path: string,
    nodeId: string,
  ): Promise<{ rel: string; key: string; doc: CanvasDoc; node: CanvasGenerateNode }> {
    const abs = await this.locate(ws.root, path)
    const rel = await this.relativeTo(ws.root, abs)
    const key = `${keyOf(ws.root, path)}#${nodeId}`
    if (this.running.has(key)) throw new CanvasFailure('这张卡正在生成', 409)
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
    expectsTask: boolean,
  ): RunEntry {
    if (this.shutdown.signal.aborted || this.deps.updating?.())
      throw new CanvasFailure('应用正在更新或关闭，请稍后重试', 409)
    if (this.running.has(key)) throw new CanvasFailure('这张卡正在生成', 409)
    let arrive = () => {}
    const taskArrived = new Promise<void>((resolve) => {
      arrive = resolve
    })
    const entry: RunEntry = {
      startedAt: Date.now(),
      stop: new AbortController(),
      expectsTask,
      taskArrived,
      arrive,
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

  /** 平台回报的状态变了：记下排队中 / 生成中，发一条 `canvas.run` 让界面重读。认不出的状态词不改。 */
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

  /** 任务记录里的任务号、接口与模型；读不出回 null（取消时当作撤不回）。 */
  private async readTask(
    root: string,
    record: string,
  ): Promise<{ taskId: string; provider: string; model: string } | null> {
    try {
      const r = JSON.parse(await readFile(join(root, record), 'utf8')) as Record<string, unknown>
      const { taskId, provider, model } = r
      return typeof taskId === 'string' && typeof provider === 'string' && typeof model === 'string'
        ? { taskId, provider, model }
        : null
    } catch {
      return null
    }
  }

  /**
   * 取消一张卡正在进行的生成。视频提交之后才有远端任务，任务号还没到手时先等它（与这次生成的结束赛跑）。
   * 撤销由 `cancelTask` 按接口能力做：撤成了停掉本地等待，收尾时删掉这一版与任务记录、不记失败，回 `cancelled`。
   * 撤不回时这次生成照常进行：远端已开始或已结束回 `started`，接口没有撤销、图像与音频这类一次请求回 `unsupported`；
   * 生成在任务号到手之前就结束了回 `ended`。撤销请求本身失败（网络、鉴权）原样抛，生成照常进行。
   */
  async cancel(
    workspaceRoot: string,
    path: string,
    nodeId: string,
    cancelTask: CanvasCancelTask,
  ): Promise<'cancelled' | 'started' | 'unsupported' | 'ended'> {
    const entry = this.running.get(`${keyOf(workspaceRoot, path)}#${nodeId}`)
    if (!entry) throw new CanvasFailure('这张卡没有在生成', 409)
    if (entry.cancelled) return 'cancelled'
    if (!entry.expectsTask) return 'unsupported'
    if (!entry.task) await Promise.race([entry.taskArrived, entry.done])
    const task = entry.task
    if (!task) return 'ended'
    const outcome = await cancelTask(task)
    if (outcome !== 'cancelled') return outcome
    entry.cancelled = true
    entry.stop.abort()
    await entry.done
    return 'cancelled'
  }

  /** 收尾：清在跑、记失败、发结束事件。`work` 抛出也收成失败，`done` 不会拒绝。 */
  private async settleRun(
    key: string,
    ws: CanvasWorkspace,
    rel: string,
    nodeId: string,
    work: () => Promise<CanvasRunResult>,
  ): Promise<CanvasRunResult> {
    let result: CanvasRunResult
    try {
      result = await work()
    } catch (err) {
      result = { ok: false, message: (err as Error).message, pending: false }
    }
    const entry = this.running.get(key)
    // 远端已撤销：这一版与任务记录一起删掉，卡回到这次生成之前的样子，不记失败。
    if (entry?.cancelled && entry.task) {
      if (entry.task.versionId) await this.dropVersion(ws.root, rel, nodeId, entry.task.versionId)
      await rm(join(ws.root, entry.task.record), { force: true })
      result = { ok: false, message: '已取消生成', pending: false }
    }
    this.running.delete(key)
    if (!result.ok && !entry?.cancelled) this.failures.set(key, result.message)
    this.deps.publish({
      type: 'canvas.run',
      workspaceId: ws.id,
      path: rel,
      nodeId,
      ...(result.ok || entry?.cancelled
        ? { state: 'done' }
        : { state: 'failed', message: result.message }),
    })
    return result
  }

  /** 各产物的像素宽高，按工作区相对路径取；读不出的不在表里。 */
  private async sizesOf(root: string, files: GeneratedFile[]): Promise<Map<string, CanvasPixels>> {
    const sizes = new Map<string, CanvasPixels>()
    for (const f of files) {
      const size = await mediaSizeOf(join(root, f.path))
      if (size) sizes.set(f.path, size)
    }
    return sizes
  }

  /** 产物已落盘，回写画布。回写不成（节点或这一版被外部改掉了）时，失败原文写明产物在哪。 */
  private async writeBack(
    root: string,
    rel: string,
    files: GeneratedFile[],
    change: (doc: CanvasDoc) => CanvasResult,
  ): Promise<CanvasRunResult> {
    const paths = files.map((f) => f.path)
    try {
      await this.mutate(root, rel, change)
      return { ok: true, paths }
    } catch (err) {
      return {
        ok: false,
        message: `已生成，但回写画布失败（${(err as Error).message}），产物在 ${paths.join('、')}`,
        pending: false,
      }
    }
  }

  private async dropVersion(root: string, rel: string, nodeId: string, versionId: string) {
    await this.mutate(root, rel, (d) =>
      applyCanvasOps(d, [{ op: 'remove', id: nodeId, version: versionId }]),
    ).catch(() => {})
  }

  private isFile(root: string, path: string): Promise<boolean> {
    return stat(join(root, path)).then(
      (s) => s.isFile(),
      () => false,
    )
  }

  /**
   * 收下浏览器从一个视频节点截的一帧（PNG），按生成的落盘规则写成 `generated/<视频名>_<label>.png`
   * （不覆盖，撞名加 `-2`），在视频右边加一个引用它的节点。返回新节点的 id 与文件路径。
   */
  async captureFrame(
    workspaceRoot: string,
    path: string,
    videoNodeId: string,
    label: string,
    bytes: Uint8Array,
  ): Promise<{ nodeId: string; path: string }> {
    if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
      throw new CanvasFailure('收到的不是 PNG 图片', 422)
    }
    const doc = await this.load(await this.locate(workspaceRoot, path))
    const video = doc.nodes.find((n) => n.id === videoNodeId)
    if (!video) throw new CanvasFailure(`目标已不存在：${videoNodeId}`, 404)
    if (canvasMediaOf(video) !== 'video') throw new CanvasFailure('只能从视频节点取帧', 422)
    const name = `${displayNameOf(video)}_${label}`.replace(/[\\/:*?"<>|]/g, '_')
    // 扩展名写全：`12.4s` 这种名字不带的话，`.4s` 会被当成扩展名，文件落成不认识的类型。
    const [landed] = await landFiles(
      workspaceRoot,
      [{ bytes, mime: 'image/png' }],
      `generated/${name}.png`,
    )
    const { refs } = await this.apply(workspaceRoot, path, [
      { op: 'add_file', ref: '$frame', path: landed!.path, beside: video.id },
    ])
    return { nodeId: refs.$frame!, path: landed!.path }
  }

  /**
   * 时间线导出成片：浏览器边编码边把字节按位置写进 `generated/.<会话号>.part`（`exportWrite`），
   * 完成时（`exportFinish`）核 mp4 文件头、落成 `generated/<时间线名>.mp4`（撞名加 `-2`）、在时间线右边加节点。回会话号。
   *
   * 临时文件的终态：完成时改名；失败、放弃、停服、`EXPORT_IDLE_MS` 没有写入时删掉（标签页关掉、网络断开时没有人会来调
   * `exportAbort`）；进程被结束时留下的由下次启动的 `recover` 删掉。
   */
  async exportStart(workspaceRoot: string, path: string, nodeId: string): Promise<string> {
    const canvas = await this.locate(workspaceRoot, path)
    const node = (await this.load(canvas)).nodes.find((n) => n.id === nodeId)
    if (!node) throw new CanvasFailure(`目标已不存在：${nodeId}`, 404)
    if (node.type !== 'timeline') throw new CanvasFailure('只有时间线能导出成片', 422)
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

  /** 把一块字节写到 `.part` 的 `at` 处。编码器结尾会回写文件开头的索引，所以按位置写、不是追加。 */
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
        throw new CanvasFailure(`时间线已不存在：${session.source}`, 404)
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
   * 占一个成片名字：按撞名规则挑，独占创建空文件占住，被同时完成的另一次导出抢先就再挑。回绝对路径。
   * 不要改成挑完直接改名：改名会覆盖已存在的文件，两次导出同时挑中同一个名字时后一个覆盖前一个。
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

  /** 放弃导出：删掉 `.part`。会话已结束或不属于这个项目时什么也不做。 */
  async exportAbort(workspaceRoot: string, id: string): Promise<void> {
    if (this.exports.get(id)?.root !== workspaceRoot) return
    await this.dropExport(id)
  }

  private exportOf(workspaceRoot: string, id: string): ExportSession {
    const session = this.exports.get(id)
    if (!session || session.root !== workspaceRoot) {
      throw new CanvasFailure('这次导出已经结束或超时，重新导出', 404)
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

  /** 删掉这个项目 `generated/` 里不属于在办会话的导出临时文件，即进程被结束时没来得及删的那些。 */
  private async sweepExports(root: string): Promise<void> {
    const dir = join(root, EXPORT_DIR)
    for (const name of await readdir(dir)) {
      const id = EXPORT_PART.exec(name)?.[1]
      if (id && !this.exports.has(id)) await rm(join(dir, name), { force: true })
    }
  }

  /**
   * 收下从本机选的文件，原名写进工作区 `uploads/`（不覆盖，撞名加 `-2`），加一个引用它的节点：
   * 给了 `beside` 放在那个节点右侧的空位，否则以 `near` 为中心找空位。画布只引用，删节点不删文件。
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
   * 从系统拖入的本机文件（绝对路径）：在工作区里的直接引用，工作区外的按原名复制进 `uploads/`。
   * 第一个以 `near` 为中心找空位，之后的排在上一个右侧。回新节点的 id；有一个不存在或不是文件就停下报错。
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

  /** 工作区里的画布文件（工作区相对路径），按名搜索，跳过依赖与构建产物目录（同文件树的搜索）。 */
  async list(workspaceRoot: string): Promise<string[]> {
    const { matches } = await findByName(workspaceRoot, CANVAS_SUFFIX, {
      hits: Number.POSITIVE_INFINITY,
      entries: Number.POSITIVE_INFINITY,
    })
    return matches
      .filter((m) => m.kind === 'file' && m.path.endsWith(CANVAS_SUFFIX))
      .map((m) => m.path)
  }

  /** 读画布与各节点状态。文件格式错误回 422，原文件不动。 */
  async read(workspaceRoot: string, path: string): Promise<CanvasView> {
    const abs = await this.locate(workspaceRoot, path)
    const doc = await this.load(abs)
    const states: Record<string, CanvasNodeState> = {}
    for (const node of doc.nodes) {
      states[node.id] = await this.stateOf(workspaceRoot, keyOf(workspaceRoot, path), node)
    }
    return { path: await this.relativeTo(workspaceRoot, abs), doc, states }
  }

  /**
   * 应用一批操作并写盘，返回应用后的文档与批内名字对照。
   * 文件节点的路径先按工作区核实并规范成正斜杠相对路径；在跑的卡不能删（409）。
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
   * 撤销与重做：当前文件仍是指纹 `from` 的那一份时，换回本服务记下的指纹 `to` 那一份。
   * 中间被别处改过（Agent、生成回写、手改）回 409、不覆盖；`to` 已不在记录里回 404。
   * 换回的文档是本服务自己读过或写过的，版本记录是真实的。
   */
  restore(workspaceRoot: string, path: string, from: string, to: string): Promise<CanvasStep> {
    return this.enqueue(keyOf(workspaceRoot, path), async () => {
      const abs = await this.locate(workspaceRoot, path)
      const text = this.snapshots.get(abs)?.get(to)
      if (text === undefined) throw new CanvasFailure('这一步已经撤销不了', 404)
      const target = this.parse(text)
      const r = await this.commit(abs, (doc) => {
        if (fingerprint(serializeCanvas(doc)) !== from) {
          throw new CanvasFailure('画布在这之后被改过，撤销不了', 409)
        }
        return { ok: true, doc: target, refs: {} }
      })
      return r.step
    })
  }

  /**
   * 串行修改一个画布文件。`change` 抛 `CanvasFailure` 或回 `ok: false` 都不写盘。
   *
   * 调用当下就排进队列，路径解析在队列里做：先解析再排队的话，同一客户端连发的两次修改
   * 可能按解析完成的先后落盘，后发的先写。
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

  /** 记下一份文档，回它的指纹。 */
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
   * 读 → 应用 → 写 `.part` → 改名前复读 → 改名。应用前后字节相同就不写、不发通知。
   * 前后两份都按规范化文本记下，供撤销换回。
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
    throw new CanvasFailure('画布文件正被别处连续改写，稍后再试', 409)
  }

  /** 一个节点的状态，次序见 `CanvasNodeState`。`canvasKey` 见 `keyOf`。 */
  private async stateOf(
    workspaceRoot: string,
    canvasKey: string,
    node: CanvasNode,
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
        ...(run.phase ? { phase: run.phase } : {}),
      }
    }
    const tasks = node.versions.filter((v) => v.path.endsWith(TASK_SUFFIX))
    const pending = tasks.find((v) => v.id === node.current) ?? tasks.at(-1)
    if (pending) return { state: 'pending', version: pending.id }
    const failure = this.failures.get(key)
    if (failure !== undefined) return { state: 'failed', message: failure }
    const current = node.versions.find((v) => v.id === node.current)
    if (!current) return { state: 'empty' }
    return (await exists(current.path)) ? { state: 'normal' } : { state: 'missing' }
  }

  /** 删节点、删正在生成的那一版：目标在跑时拒绝，否则成功后找不到要回写的地方。 */
  private refuseRemovingRunning(
    workspaceRoot: string,
    path: string,
    doc: CanvasDoc,
    ops: CanvasOp[],
  ): void {
    const canvasKey = keyOf(workspaceRoot, path)
    for (const op of ops) {
      if (op.op !== 'remove' || !this.running.has(`${canvasKey}#${op.id}`)) continue
      const node = doc.nodes.find((n) => n.id === op.id)
      const inFlight =
        op.version === undefined ||
        (node?.type === 'generate' &&
          node.versions.some((v) => v.id === op.version && v.path.endsWith(TASK_SUFFIX)))
      if (inFlight) throw new CanvasFailure('这张卡正在生成，生成结束后再删', 409)
    }
  }

  /**
   * `add_file` / `update` 里的文件路径：必须是工作区里已有的文件，写成正斜杠相对路径；
   * 同时从文件头读出像素宽高填进 `size`，框按文件的比例定。操作自己给了 `w` / `h` 时不读。
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

  /** 时间线片段：文件同 `normalizePath` 核实；出点超过视频时长（读得出时）回 422。 */
  private async normalizeClip(workspaceRoot: string, clip: CanvasClip): Promise<CanvasClip> {
    const abs = await this.existingFile(workspaceRoot, clip.path)
    const path = await this.relativeTo(workspaceRoot, abs)
    const duration = await mediaDurationOf(abs)
    // 容差一帧：界面按播放器读到的时长裁剪，与 `mvhd` 的取整可能差几毫秒。
    if (duration !== null && clip.out > duration + 1 / 30) {
      throw new CanvasFailure(
        `片段超出视频时长：${path} 只有 ${Math.round(duration * 100) / 100} 秒，出点是 ${clip.out} 秒`,
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
      throw new CanvasFailure(`${path} 不存在或不在这个项目里`, 422)
    }
    if (!(await stat(abs)).isFile()) throw new CanvasFailure(`${path} 不是文件`, 422)
    return abs
  }

  private async relativeTo(workspaceRoot: string, abs: string): Promise<string> {
    const rel = relative(await realpath(workspaceRoot), abs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new CanvasFailure(`${abs} 不在工作区里，画布只引用工作区里的文件`, 422)
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

  /** 磁盘变了：推进各客户端的文件快照，不进「本轮改动」。 */
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
 * 交给会话的画布端口：同一个画布服务，绑定这条会话所在的项目。
 * 运行与取回在工具里等到结束；中止信号来自本轮，停止本轮即停止等待，视频那一版留着待取回。
 */
export function canvasPort(service: CanvasService, ws: CanvasWorkspace): CanvasPort {
  return {
    list: () => service.list(ws.root),
    read: (path) => service.read(ws.root, path),
    edit: async (path, ops) => {
      const { refs } = await service.apply(ws.root, path, ops)
      return { view: await service.read(ws.root, path), refs }
    },
    run: async (path, nodeId, media, signal) =>
      (await service.run(ws, path, nodeId, { media, signal })).done,
    retrieve: async (path, nodeId, version, media, signal) =>
      (await service.retrieve(ws, path, nodeId, version, { media, signal })).done,
  }
}
