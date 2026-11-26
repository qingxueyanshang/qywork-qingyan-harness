/**
 * 画布文档的读取与写入：对 `*.canvas.json` 的写入只经由本类执行，生成、导出与素材都经它读写文档。
 *
 * - 写入次序：同一个画布文件的修改串行执行（读 → 应用 → 写 `.part` → 改名前复读 → 改名）。队列与提交是私有的，
 *   新的写入方式加在本类中，不要在本类之外另行写入画布文件。
 * - 本服务之外还有其他写入者（Agent 的 `write_file`、CLI 会话、外部编辑器），因此改名前再读取一次：
 *   字节已变化时在新内容上重新应用，不覆盖其他写入者的改动。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { isOutsideRelative, mediaDurationOfFile } from '@qywork/agent'
import {
  type AgentEvent,
  applyCanvasOps,
  artImageRefs,
  type CanvasClip,
  type CanvasDoc,
  type CanvasGenerateNode,
  type CanvasNodeState,
  type CanvasOp,
  type CanvasPixels,
  type CanvasResult,
  type CanvasRunRecord,
  type CanvasTaskInfo,
  type CanvasView,
  canvasFileKind,
  displayNameOf,
  emptyCanvas,
  type GenerateOutput,
  inputsOf,
  isTextCard,
  type MediaParamDefinition,
  type MentionStyle,
  parseCanvas,
  promptInputProblems,
  promptRelabels,
  resolveArtRef,
  serializeCanvas,
  TASK_SUFFIX,
  textPathOf,
  textReferenceProblems,
  toPosixPath,
} from '@qywork/core'
import { renameWithRetry, resolveInWorkspace, resolveWritablePath } from '@qywork/tools'
import { findByName } from '../files.ts'
import { mediaSizeOf } from '../media-size.ts'
import { agentView, checkActiveParams, prepareAgentOps } from './agent-ops.ts'
import { type CanvasStates, keyOf } from './states.ts'

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

/** 改名前复读发现文件已变化时，重新应用的次数上限。 */
const MAX_REAPPLY = 5

/** 卡片选定的接口与模型；未选定时为 undefined，使用默认模型。 */
export function pickOf(node: CanvasGenerateNode): { provider: string; model: string } | undefined {
  return node.provider !== undefined && node.model !== undefined
    ? { provider: node.provider, model: node.model }
    : undefined
}

/** 可选的 `size` 字段：无法读取尺寸时不写入该键。 */
export function sizeField(size: CanvasPixels | null | undefined): { size?: CanvasPixels } {
  return size ? { size } : {}
}

/** 文档读写所需的依赖，由 `CanvasService` 的依赖中取用。 */
export interface CanvasDocsDeps {
  /** 当前模型的参数表，用于投影画布偏好为实际发送参数。 */
  paramSpecsOf?(
    output: GenerateOutput,
    pick: { provider: string; model: string } | undefined,
  ): readonly MediaParamDefinition[] | undefined
  /** 已配置模型 `model` 的接口名，大模型只给出 model 时据此补上 provider（`prepareAgentOps`）。 */
  providersOf?(output: GenerateOutput, model: string): readonly string[]
  /** 接口下为该模型保存的显示名称，核对大模型的修改时报错中按它提及模型（`prepareAgentOps`）。 */
  displayNameOf?(
    output: GenerateOutput,
    pick: { provider: string; model: string },
  ): string | undefined
  /** 发送一条全局事件（不带会话 id）。 */
  publish(event: AgentEvent): void
  /** 本次生成所用模型在提示词中指代素材的方式；未提供时按节点名写入提示词。 */
  mentionStyleOf?(
    output: GenerateOutput,
    pick: { provider: string; model: string } | undefined,
  ): MentionStyle | undefined
  /** 只替换给出的函数，其余使用默认实现。 */
  io?: Partial<CanvasIo>
  /** 新节点、新连线的 id。只在测试中注入，使两条路径写出的文件可以逐字节比较。 */
  newId?: () => string
}

/** 画布所在的项目：根目录用于定位文件，id 写入 `canvas.run` 事件。 */
export interface CanvasWorkspace {
  id: string
  root: string
}

export class CanvasDocs {
  private readonly queues = new Map<string, Promise<unknown>>()
  /** 按画布文件的绝对路径记录本服务读取或写入过的文档（规范化后的文本），键为指纹。只增不改，超出上限时丢弃最早的一份。 */
  private readonly snapshots = new Map<string, Map<string, string>>()
  private readonly io: CanvasIo

  constructor(
    private readonly deps: CanvasDocsDeps,
    private readonly states: CanvasStates,
  ) {
    this.io = { ...NODE_IO, ...deps.io }
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

  /** 任务记录中的任务号、接口与模型；无法读取时返回 null（取消时视为无法撤销）。 */
  async readTask(
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
   * 工作区中引用文本文件 `path` 的画布卡片，以及其中按文件当前内容已无法定位的摘录卡。
   * 供文件工具在写入 .md / .txt 后告知模型：改动会进入哪些卡下次发送的提示词、哪些摘录卡须重新给出摘录。
   * 同一文件可有多张文本卡（整篇卡与各摘录卡）。无法读取的画布跳过：它们在被读取或运行时各自报错。
   */
  async textReferences(workspaceRoot: string, path: string): Promise<string[]> {
    const lines: string[] = []
    const cache = new Map<string, string | null>()
    for (const canvas of await this.list(workspaceRoot)) {
      let doc: CanvasDoc
      try {
        doc = await this.load(await this.locate(workspaceRoot, canvas))
      } catch {
        continue
      }
      const cards = doc.nodes.filter((n) => n.type === 'file' && n.path === path)
      if (!cards.length) continue
      const ids = new Set(cards.map((n) => n.id))
      const users = [
        ...new Set(doc.edges.filter((e) => ids.has(e.from) && e.role === 'text').map((e) => e.to)),
      ]
      if (users.length) {
        const names = users.map((id) => {
          const n = doc.nodes.find((x) => x.id === id)
          return n ? displayNameOf(n) : id
        })
        lines.push(
          `画布 ${canvas} 中 ${users.length} 张卡引用此文件（${names.join('、')}），下次运行时发送修改后的内容。`,
        )
      }
      for (const card of cards) {
        const texts = await this.textsOf(workspaceRoot, doc, card.id, cache)
        for (const p of textReferenceProblems(doc, card.id, texts)) {
          lines.push(
            `引用失效：画布 ${canvas} 的「${displayNameOf(card)}」${p}；用 edit_canvas 的 update 给出新的 excerpt。`,
          )
        }
      }
    }
    return lines
  }

  /**
   * 文本卡文件当前的内容，按节点 id：`nodeId` 为生成卡时是它引用的文本卡，为文本卡时是它本身；文本生成卡为当前版本的产物（`textPathOf`）。
   * 文件不存在、无法读取或文本生成卡尚无结果时不提供该项，由 `textReferenceProblems` 报为失效（文本生成卡由运行时拒绝）。
   * `cache` 按路径复用同一次读取画布中已读的文件。
   */
  async textsOf(
    root: string,
    doc: CanvasDoc,
    nodeId: string,
    cache = new Map<string, string | null>(),
  ): Promise<Map<string, string>> {
    const texts = new Map<string, string>()
    const sources = [
      nodeId,
      ...inputsOf(doc, nodeId)
        .filter((e) => e.role === 'text')
        .map((e) => e.from),
    ]
    for (const id of sources) {
      const source = doc.nodes.find((n) => n.id === id)
      const path = source && textPathOf(source)
      if (!source || !path) continue
      if (!cache.has(path)) {
        cache.set(path, await readFile(join(root, path), 'utf8').catch(() => null))
      }
      const text = cache.get(path)
      if (typeof text === 'string') texts.set(source.id, text)
    }
    return texts
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
    const relabels: Record<string, string[]> = {}
    const mentions: Record<string, MentionStyle> = {}
    const read = new Map<string, string | null>()
    // 各张卡的文件检查互不依赖，并行执行；文本卡引用的文件先一次读入 `read`，`textsOf` 只取缓存。
    const textPaths = new Set<string>()
    for (const node of doc.nodes) {
      const path = textPathOf(node)
      if (path) textPaths.add(path)
    }
    await Promise.all(
      [...textPaths].map(async (p) => {
        read.set(p, await readFile(join(workspaceRoot, p), 'utf8').catch(() => null))
      }),
    )
    const revisions = await this.revisionsOf(workspaceRoot, doc)
    const lastRuns = new Map<string, CanvasRunRecord>()
    /** 各节点最近一次生成（不含取回）建立的版本。 */
    const newest = new Map<string, string>()
    for (const r of doc.runs ?? []) {
      lastRuns.set(r.node, r)
      if (r.action === 'run' && r.version) newest.set(r.node, r.version)
    }
    const canvasKey = keyOf(workspaceRoot, path)
    const results = await Promise.all(
      doc.nodes.map(async (node) => {
        const texts =
          node.type === 'generate' || isTextCard(node)
            ? await this.textsOf(workspaceRoot, doc, node.id, read)
            : null
        const [state, nodeTasks] = await Promise.all([
          this.states.stateOf(
            workspaceRoot,
            canvasKey,
            node,
            lastRuns.get(node.id),
            newest.get(node.id),
          ),
          node.type === 'generate'
            ? Promise.all(
                node.versions
                  .filter((v) => v.path.endsWith(TASK_SUFFIX))
                  .map(async (v) => [v.id, await this.readTask(workspaceRoot, v.path)] as const),
              )
            : [],
        ])
        const style =
          node.type === 'generate'
            ? (this.deps.mentionStyleOf?.(node.output, pickOf(node)) ?? {})
            : {}
        return {
          node,
          style,
          relabeled:
            node.type === 'generate' && texts ? promptRelabels(doc, node.id, style, texts) : [],
          broken: texts
            ? [
                ...textReferenceProblems(doc, node.id, texts),
                ...(node.type === 'generate' ? promptInputProblems(doc, node.id, texts) : []),
              ]
            : [],
          state,
          nodeTasks,
        }
      }),
    )
    for (const { node, style, relabeled, broken, state, nodeTasks } of results) {
      if (broken.length) references[node.id] = broken
      if (relabeled.length) relabels[node.id] = relabeled
      if (Object.keys(style).length) mentions[node.id] = style
      states[node.id] = state
      for (const [id, task] of nodeTasks) if (task) tasks[id] = task
    }
    const view: CanvasView = {
      path: await this.relativeTo(workspaceRoot, abs),
      doc,
      states,
      ...(Object.keys(tasks).length ? { tasks } : {}),
      ...(Object.keys(references).length ? { references } : {}),
      ...(Object.keys(relabels).length ? { relabels } : {}),
      ...(Object.keys(mentions).length ? { mentions } : {}),
      ...(Object.keys(revisions).length ? { revisions } : {}),
    }
    return agent ? agentView(view, this.deps.paramSpecsOf) : view
  }

  /** `CanvasView.revisions`：卡片显示的文件与 Art 页面引用的图片，各自的修改时间；页面的版本连接页面与各图片的版本。 */
  private async revisionsOf(
    workspaceRoot: string,
    doc: CanvasDoc,
  ): Promise<Record<string, string>> {
    const shown = doc.nodes.flatMap((n) =>
      n.type === 'file'
        ? [n.path]
        : n.type === 'generate'
          ? n.versions.filter((v) => v.id === n.current).map((v) => v.path)
          : n.clips.map((c) => c.path),
    )
    // 并行读取的结果按卡片顺序收集，不在完成时写入：完成先后不定，同一份画布两次读取的键序会不同。
    const images = new Map(
      await Promise.all(
        shown
          .filter((p) => canvasFileKind(p) === 'art')
          .map(async (page) => {
            const html = await readFile(join(workspaceRoot, page), 'utf8').catch(() => '')
            const refs = artImageRefs(html).flatMap((ref) => resolveArtRef(page, ref) ?? [])
            return [page, refs] as const
          }),
      ),
    )
    const revisions: Record<string, string> = Object.fromEntries(
      await Promise.all(
        [...new Set([...shown, ...[...images.values()].flat()])].map(async (p) => {
          const s = await stat(join(workspaceRoot, p)).catch(() => null)
          return [p, s?.isFile() ? String(s.mtimeMs) : ''] as const
        }),
      ),
    )
    for (const [page, refs] of images)
      revisions[page] = [revisions[page], ...refs.map((p) => revisions[p])].join('|')
    return revisions
  }

  /**
   * 应用一批界面操作并写入，整批成立才写入，返回应用后的文档与批内名称对照。
   * 文件节点的路径先按工作区核实，并规范化为正斜杠相对路径；运行中的卡片不能删除（409）。
   * 大模型的操作经由 `applyAgent`。
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
          const prepared = prepareAgentOps(
            doc,
            list,
            specs,
            this.deps.providersOf,
            this.deps.displayNameOf,
          )
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
      if (!node || !this.states.entryOf(workspaceRoot, canvasKey, node)) continue
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
    const duration = mediaDurationOfFile(abs)
    // 容差为一帧：界面按播放器读取的时长裁剪，与 `mvhd` 的取整值可能相差数毫秒。
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

  async relativeTo(workspaceRoot: string, abs: string): Promise<string> {
    const rel = relative(await realpath(workspaceRoot), abs)
    if (!rel || isOutsideRelative(rel)) {
      throw new CanvasFailure(`${abs} 不在工作区中，画布只引用工作区中的文件`, 422)
    }
    return toPosixPath(rel)
  }

  async load(abs: string): Promise<CanvasDoc> {
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
