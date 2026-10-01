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

import { createHash } from 'node:crypto'
import { readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { CanvasPort, MediaPort } from '@qywork/agent'
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
}

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

export class CanvasService {
  private readonly queues = new Map<string, Promise<unknown>>()
  /** 键：`画布绝对路径#节点 id`。多个工作区并存时相对路径会撞。 */
  private readonly running = new Map<
    string,
    { startedAt: number; done?: Promise<CanvasRunResult> }
  >()
  private readonly shutdown = new AbortController()
  private recovering = false
  private recovery: Promise<void> | undefined
  /** 按画布文件的绝对路径记下本服务读过、写过的文档（规范化后的文本），键是指纹。只增不改，超出上限丢最早的。 */
  private readonly snapshots = new Map<string, Map<string, string>>()
  private readonly failures = new Map<string, string>()
  private readonly io: CanvasIo

  constructor(private readonly deps: CanvasServiceDeps) {
    this.io = { ...NODE_IO, ...deps.io }
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

  /** 停止本地等待，保留远端任务记录；等待收尾后再关闭账本。 */
  async stop(): Promise<void> {
    this.shutdown.abort()
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

    this.begin(key, ws, rel, nodeId)
    const done = this.settleRun(key, ws, rel, nodeId, async () => {
      let versionId: string | null = null
      const outcome = await generateMedia({
        roots: ws.root,
        media: opts.media,
        signal: this.signalFor(opts.signal),
        type: node.output,
        prompt,
        inputs,
        params: node.params,
        ...(pick ? { pick } : {}),
        onTask: async ({ record, provider, model }) => {
          const id = newCanvasId()
          await this.mutate(ws.root, rel, (d) =>
            addVersions(d, nodeId, [{ id, path: record, made: made(provider, model) }]),
          ).then(
            () => {
              versionId = id
            },
            () => {},
          )
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

    this.begin(key, ws, rel, nodeId)
    const done = this.settleRun(key, ws, rel, nodeId, async () => {
      if (!(await this.isFile(ws.root, version.path))) {
        await this.dropVersion(ws.root, rel, nodeId, version.id)
        return { ok: false, message: `任务记录已不存在：${version.path}`, pending: false }
      }
      const outcome = await resumeMedia({
        roots: ws.root,
        media: opts.media,
        signal: this.signalFor(opts.signal),
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

  private begin(key: string, ws: CanvasWorkspace, rel: string, nodeId: string): void {
    if (this.shutdown.signal.aborted || this.deps.updating?.())
      throw new CanvasFailure('应用正在更新或关闭，请稍后重试', 409)
    if (this.running.has(key)) throw new CanvasFailure('这张卡正在生成', 409)
    this.running.set(key, { startedAt: Date.now() })
    this.failures.delete(key)
    this.deps.publish({
      type: 'canvas.run',
      workspaceId: ws.id,
      path: rel,
      nodeId,
      state: 'running',
    })
  }

  private signalFor(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal
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
    this.running.delete(key)
    if (!result.ok) this.failures.set(key, result.message)
    this.deps.publish({
      type: 'canvas.run',
      workspaceId: ws.id,
      path: rel,
      nodeId,
      ...(result.ok ? { state: 'done' } : { state: 'failed', message: result.message }),
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
   * 收下浏览器做好的媒体，按生成的落盘规则写进 `generated/`（不覆盖，撞名加 `-2`），在源节点右边加一个引用它的节点。
   * 按文件头分两种：PNG 是从视频节点取的一帧，落成 `<视频名>_<label>.png`；mp4 是时间线导出的成片，落成 `<时间线名>.mp4`，
   * 不带 `label`。返回新节点的 id 与文件路径。
   */
  async landRendered(
    workspaceRoot: string,
    path: string,
    sourceId: string,
    label: string | null,
    bytes: Uint8Array,
  ): Promise<{ nodeId: string; path: string }> {
    const png = PNG_SIGNATURE.every((b, i) => bytes[i] === b)
    const mp4 = !png && new TextDecoder().decode(bytes.subarray(4, 8)) === 'ftyp'
    if (!png && !mp4) throw new CanvasFailure('收到的不是 PNG 图片或 mp4 视频', 422)
    const doc = await this.load(await this.locate(workspaceRoot, path))
    const source = doc.nodes.find((n) => n.id === sourceId)
    if (!source) throw new CanvasFailure(`目标已不存在：${sourceId}`, 404)
    if (png && (canvasMediaOf(source) !== 'video' || !label)) {
      throw new CanvasFailure('图片只能是从视频节点取的帧', 422)
    }
    if (mp4 && (source.type !== 'timeline' || label)) {
      throw new CanvasFailure('视频只能是时间线导出的成片', 422)
    }
    const name = (png ? `${displayNameOf(source)}_${label}` : displayNameOf(source)).replace(
      /[\\/:*?"<>|]/g,
      '_',
    )
    // 扩展名写全：`12.4s` 这种名字不带的话，`.4s` 会被当成扩展名，文件落成不认识的类型。
    const [landed] = await landFiles(
      workspaceRoot,
      [{ bytes, mime: png ? 'image/png' : 'video/mp4' }],
      `generated/${name}${png ? '.png' : '.mp4'}`,
    )
    const { refs } = await this.apply(workspaceRoot, path, [
      { op: 'add_file', ref: '$landed', path: landed!.path, beside: source.id },
    ])
    return { nodeId: refs.$landed!, path: landed!.path }
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
    const startedAt = this.running.get(key)?.startedAt
    if (startedAt !== undefined) return { state: 'running', startedAt }
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
