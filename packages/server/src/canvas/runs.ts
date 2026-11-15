/**
 * 画布上的生成：运行、批量调度、取回、取消与收尾，以及启动时接续未完成的任务。
 * 运行状态记在 `CanvasStates`，画布的写入经 `CanvasDocs`。
 */

import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { mediaDurationOfFile } from '@qywork/agent'
import { taskPhase } from '@qywork/ai'
import {
  activeMediaParams,
  addVersions,
  applyCanvasOps,
  artImageRefs,
  type CanvasBatchRunResult,
  type CanvasCancelOutcome,
  type CanvasDoc,
  type CanvasGenerateNode,
  type CanvasMade,
  type CanvasOp,
  type CanvasPixels,
  type CanvasResult,
  type CanvasRunRecord,
  type CanvasRunResult,
  type CanvasVersion,
  compilePrompt,
  displayNameOf,
  type GenerateOutput,
  inputsOf,
  log,
  type MediaOutput,
  mediaInputsOf,
  mediaOperationFor,
  newCanvasId,
  promptInputProblems,
  type RetryWait,
  recordRun,
  resolveArtRef,
  settleVersion,
  textReferenceProblems,
} from '@qywork/core'
import {
  type GeneratedFile,
  type GenerateSuccess,
  generateMedia,
  type MediaPort,
  resumeMedia,
  TASK_SUFFIX,
  taskHeldElsewhere,
} from '@qywork/tools'
import { mediaSizeOf } from '../media-size.ts'
import {
  type CanvasDocs,
  type CanvasDocsDeps,
  CanvasFailure,
  type CanvasWorkspace,
  pickOf,
  sizeField,
} from './docs.ts'
import { type CanvasStates, type CanvasTask, type CardAt, keyOf, type RunEntry } from './states.ts'

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

/**
 * 引用任务记录的占位版本改为指向产物。视频见 `settleVideo`；其余类别的首个产物替换占位版本、其余产物成为同一卡片的版本
 * （`settleImages`），设计稿页面引用的工作区图片连到该卡（`linkArtImages`）。
 */
function settleOutput(
  doc: CanvasDoc,
  output: GenerateOutput,
  card: CardAt,
  files: GeneratedFile[],
  sizes: Map<string, CanvasPixels>,
  warning: string | undefined,
  artImages: readonly string[],
): CanvasResult {
  if (output === 'video') return settleVideo(doc, card.nodeId, card.versionId, files, sizes)
  const settled = settleImages(doc, card.nodeId, card.versionId, files, sizes, warning)
  return settled.ok && output === 'art'
    ? linkArtImages(settled.doc, card.nodeId, artImages)
    : settled
}

/** 占位版本记下实际使用的接口与模型：使用默认模型发起时占位版本没有记下它们。占位版本已不在时原样返回副本。 */
function withModel(doc: CanvasDoc, card: CardAt, provider: string, model: string): CanvasDoc {
  const next = structuredClone(doc)
  const node = next.nodes.find((n) => n.id === card.nodeId)
  const version =
    node?.type === 'generate' ? node.versions.find((v) => v.id === card.versionId) : undefined
  if (version) version.made = { ...version.made, provider, model }
  return next
}

/** 生成所需的依赖，由 `CanvasService` 的依赖中取用。 */
export interface CanvasRunsDeps
  extends Pick<CanvasDocsDeps, 'paramSpecsOf' | 'publish' | 'mentionStyleOf'> {
  /** 与对话共用更新占位；文件校验结束后、开始生成前再检查一次。 */
  updating?(): boolean
  /** 按配置撤销远端任务，见 `CanvasRuns.cancelTask`。只在服务端装配时提供。 */
  cancelTask?: CanvasCancelTask
}

/**
 * 运行或取回的计费归属由调用方提供：界面发起时使用服务端创建的端口（花费记为不属于任何轮次），
 * Agent 发起时使用其本轮的生成端口（花费计入本轮）。
 */
export interface CanvasRunOptions {
  media: MediaPort
  /**
   * 调用方的等待时限（Agent 本轮的中止信号）。中止时 `done` 立即兑现为停止等待，生成照常进行并写回画布：
   * 生成归画布所有，只由卡片自身的停止（`cancel`）与应用关闭结束。已中止时不开始生成。
   * 不要并入生成的执行信号：收尾只把卡片自身的停止视为停止等待，其他中止记为生成失败。
   */
  signal?: AbortSignal
  /** 批量派发时再次检查已有远端任务，防止等待期间新出现的待取回版本被重复提交。 */
  rejectPending?: true
  /** 该卡正在生成时不重复提交，返回该次生成的结果（大模型的画布端口）。不给出时以 409 拒绝（界面）。 */
  join?: true
}

/** 生成记录中在开始时确定、在生成过程中补充的字段；结果、结束时刻与失败原文在收尾时补充。 */
type RunFacts = Omit<CanvasRunRecord, 'node' | 'end' | 'result' | 'message'>

/** 撤销远端任务的结果：`unsupported` 表示接口不支持撤销。由调用方按配置实现，见 `cancel`。 */
export type CanvasCancelTask = (task: {
  taskId: string
  provider: string
  model: string
  type: MediaOutput
}) => Promise<'cancelled' | 'started' | 'unsupported'>

export class CanvasRuns {
  private recovering = false
  private recovery: Promise<void> | undefined

  constructor(
    private readonly docs: CanvasDocs,
    private readonly states: CanvasStates,
    private readonly deps: CanvasRunsDeps,
    /** 应用关闭（`CanvasService.stop`）：结束全部本地等待，不再开始生成。 */
    private readonly shutdown: AbortSignal,
    /** 启动恢复时删除上次进程遗留的导出临时文件（`CanvasExports.sweepExports`）。 */
    private readonly sweepExports: (root: string) => Promise<void>,
  ) {}

  /** 扫描中的恢复同样视为忙碌，防止在找到待接续的卡片之前取得更新占位。 */
  get busyCount(): number {
    return Math.max(this.states.running.size, Number(this.recovering))
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
          for (const path of await this.docs.list(ws.root)) {
            if (this.shutdown.aborted) return
            const view = await this.docs.read(ws.root, path).catch(() => null)
            if (!view) continue
            for (const node of view.doc.nodes) {
              if (node.type !== 'generate') continue
              const versions = node.versions.filter((v) => v.path.endsWith(TASK_SUFFIX))
              if (!versions.length) continue
              pending.push(
                (async () => {
                  for (const version of versions) {
                    if (this.shutdown.aborted) return
                    try {
                      // 另一个服务进程（共用同一工作区）仍在等待该任务时由它收尾，本进程不取回。
                      if (await taskHeldElsewhere(join(ws.root, version.path))) continue
                      const port = media(ws, version)
                      if (!port) continue
                      const { done } = await this.retrieve(ws, path, node.id, version.id, {
                        media: port,
                      })
                      await done
                    } catch (err) {
                      // 用户已先行取回同一卡片时由该次调用继续处理；其余错误保留任务记录供手动重试。
                      if (!(err instanceof CanvasFailure && err.status === 409)) {
                        this.states.failures.set(`${keyOf(ws.root, path)}#${node.id}`, String(err))
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

  /**
   * 只调度本次指定的节点，不自动扩展到其他上游。执行仍走 run，共用状态、版本与计费。
   * 批内依赖失败时跳过下游，依赖已满足的节点全部同时提交，不设并发上限：并发由接口一侧决定；中止后已开始的节点照常生成（`CanvasRunOptions.signal`），
   * 等待中的节点不再派发。正在生成的节点不重复提交，等待该次生成的结果（`join`）。
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
    const view = await this.docs.read(ws.root, path)
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
        if (opts.signal?.aborted || this.shutdown.aborted) {
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
        waiting.delete(id)
        active.set(
          id,
          (async (): Promise<Entry> => {
            try {
              const { done } = await this.run(ws, path, id, {
                ...opts,
                rejectPending: true,
                join: true,
              })
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
   * 运行一张生成卡。运行中（未给出 `join`）、输入尚无结果、提示词为空均在返回之前以 `CanvasFailure` 抛出；
   * 返回的 `done` 在生成结束且画布回写之后兑现，不会拒绝。
   *
   * 提交之前写入任务记录并追加一个引用它的占位版本（所有类别相同），结束时按引用该记录的版本写回（`cardsOf`）：
   * 成功时该版本改为指向产物，多张图像对应多个版本；没有可取回的结果时删除该版本（`settleRun`）。
   * 取得任务号或图片来源之后，停止、查询被拒绝或进程退出均可取回。
   */
  async run(
    ws: CanvasWorkspace,
    path: string,
    nodeId: string,
    opts: CanvasRunOptions,
  ): Promise<{ done: Promise<CanvasRunResult> }> {
    const { rel, key, node, doc, running } = await this.target(ws, path, nodeId)
    if (running) {
      if (opts.join) return { done: this.joined(running, opts.signal) }
      throw new CanvasFailure('该卡片正在生成', 409)
    }
    if (opts.rejectPending && node.versions.some((v) => v.path.endsWith(TASK_SUFFIX)))
      throw new CanvasFailure('已有待取回版本，请使用 retrieve_canvas，不要重复提交生成', 409)
    if (!node.prompt.trim()) throw new CanvasFailure(`「${node.name}」的提示词为空`, 422)
    const inputs: CanvasMade['inputs'] = []
    // art 在当前页面上修改：当前版本的文件作为第一项参考输入。文件已不存在时从头生成。
    const page =
      node.output === 'art' ? node.versions.find((v) => v.id === node.current)?.path : undefined
    if (page && (await this.isFile(ws.root, page))) inputs.push({ role: 'reference', path: page })
    // 文本卡不作为素材发送：提示词中的引用在编译时展开为文件当前的内容，引用不成立时不提交。
    const texts = await this.docs.textsOf(ws.root, doc, nodeId)
    const broken = textReferenceProblems(doc, nodeId, texts)
    if (broken.length) {
      throw new CanvasFailure(`「${node.name}」的提示词引用不成立：${broken.join('；')}`, 422)
    }
    const mismatched = promptInputProblems(doc, nodeId, texts)
    if (mismatched.length) {
      throw new CanvasFailure(`「${node.name}」${mismatched.join('；')}`, 422)
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
    const pick = pickOf(node)
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
      const written: { result?: CanvasRunResult } = {}
      const outcome = await generateMedia({
        roots: ws.root,
        media: opts.media,
        signal: this.signalFor(entry),
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
        onRetry: (retry) => this.retrying(entry, ws, rel, nodeId, retry),
        onSpend: (spend) => {
          facts.cost = spend.cost
          facts.currency = spend.currency
        },
        logFields: { canvas: rel, node: nodeId },
        type: node.output,
        prompt,
        inputs,
        params,
        ...(pick ? { pick } : {}),
        // 提交之前登记引用任务记录的占位版本：此后无论画布改名、移动还是复制，归属都按引用该记录的版本确定。
        // 写入失败时抛出，`generateMedia` 删除记录、不提交生成。
        onRecord: async (record) => {
          entry.record = { path: record, key: keyOf(ws.root, record) }
          const id = newCanvasId()
          await this.docs.mutate(ws.root, rel, (d) =>
            addVersions(d, nodeId, [
              { id, path: record, made: made(pick?.provider ?? '', pick?.model ?? '') },
            ]),
          )
          facts.version = id
          entry.version = id
        },
        onTask: async ({ record, taskId, provider, model }) => {
          facts.provider = provider
          facts.model = model
          await this.remodel(ws.root, record, provider, model)
          // 有任务号的生成停止时按任务号撤销（`cancel`）：视频，以及走云端的出图与音频（云端撤销尚未发往上游的任务，
          // 已发往上游的答复已开始）。Art 由对话模型生成，没有任务号。
          if (taskId && node.output !== 'art')
            this.submitted(entry, ws, rel, nodeId, {
              taskId,
              provider,
              model,
              type: node.output,
              record,
              versionId: entry.version ?? null,
            })
        },
        attach: async (landed) => {
          const back = await this.attachResult(ws.root, rel, entry, node, landed, params, facts)
          written.result = back.result
          return back.settled
        },
      })
      if (!outcome.ok) {
        return {
          ok: false,
          message: outcome.message,
          pending: outcome.record !== undefined,
          ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}),
        }
      }
      // 成功的结果一定经过 `attach`。
      return written.result!
    })
    entry.done = done
    return { done: this.joined(entry, opts.signal) }
  }

  /**
   * 产物已落盘：交给 `writeBack` 写回此刻引用任务记录的每一张卡，生成与取回共用。占位版本改为指向产物（`settleOutput`），
   * 版本记下实际使用的接口与模型。
   */
  private async attachResult(
    root: string,
    rel: string,
    entry: RunEntry,
    node: CanvasGenerateNode,
    landed: GenerateSuccess,
    params: Record<string, unknown>,
    facts: RunFacts,
  ): Promise<{ result: CanvasRunResult; settled: boolean }> {
    facts.provider = landed.provider
    facts.model = landed.model
    const files = landed.files
    const output = node.output === 'video' ? videoOf(files).path : files[0]?.path
    if (output) facts.output = output
    const sizes = await this.sizesOf(root, files)
    const images = node.output === 'art' ? await this.artImagesOf(root, files[0]?.path) : null
    const warning =
      [
        landed.warning,
        images?.missing.length ? `页面引用的图片不存在：${images.missing.join('、')}` : '',
      ]
        .filter(Boolean)
        .join('；') || undefined
    const back = await this.writeBack(
      root,
      rel,
      entry.record!.path,
      { files, sizes, params },
      (d, card) =>
        settleOutput(
          withModel(d, card, landed.provider, landed.model),
          node.output,
          card,
          files,
          sizes,
          landed.warning,
          images?.found ?? [],
        ),
      warning,
    )
    entry.cards = back.cards
    return back
  }

  /** 任务号或图片来源到达时记下实际使用的接口与模型：使用默认模型发起时占位版本没有记下它们。写入失败不影响生成。 */
  private async remodel(root: string, record: string, provider: string, model: string) {
    for (const card of (await this.cardsOf(root, record)).cards) {
      await this.docs
        .mutate(root, card.path, (d) => ({
          ok: true as const,
          doc: withModel(d, card, provider, model),
          refs: {},
        }))
        .catch(() => {})
    }
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
    const { rel, key, node, running } = await this.target(ws, path, nodeId)
    const tasks = node.versions.filter((v) => v.path.endsWith(TASK_SUFFIX))
    const version =
      versionId !== undefined
        ? tasks.find((v) => v.id === versionId)
        : (tasks.find((v) => v.id === node.current) ?? tasks.at(-1))
    if (!version) throw new CanvasFailure(`「${node.name}」没有待取回的任务`, 422)
    // 同一任务记录已在等待（画布改名或移动之前发起的生成或取回）：并入该次等待，它收尾时写回此刻引用该记录的画布。
    if (running?.record?.key === keyOf(ws.root, version.path)) {
      return { done: this.joined(running, opts.signal) }
    }
    if (running) throw new CanvasFailure('该卡片正在生成', 409)

    const facts: RunFacts = {
      action: 'retrieve',
      start: new Date().toISOString(),
      version: version.id,
    }
    opts.signal?.throwIfAborted()
    const entry = this.begin(key, ws, rel, nodeId, 'retrieve')
    entry.version = version.id
    entry.record = { path: version.path, key: keyOf(ws.root, version.path) }
    const done = this.settleRun(key, ws, rel, nodeId, facts, async () => {
      if (!(await this.isFile(ws.root, version.path))) {
        return { ok: false, message: `任务记录已不存在：${version.path}`, pending: false }
      }
      const task = await this.docs.readTask(ws.root, version.path)
      if (task && node.output !== 'art')
        this.submitted(entry, ws, rel, nodeId, {
          taskId: task.taskId,
          provider: task.provider,
          model: task.model,
          type: node.output,
          record: version.path,
          versionId: version.id,
        })
      const written: { result?: CanvasRunResult } = {}
      const outcome = await resumeMedia({
        roots: ws.root,
        media: opts.media,
        signal: this.signalFor(entry),
        onStatus: (status) => this.advance(entry, ws, rel, nodeId, status),
        onRetry: (retry) => this.retrying(entry, ws, rel, nodeId, retry),
        onSpend: (spend) => {
          facts.cost = spend.cost
          facts.currency = spend.currency
        },
        logFields: { canvas: rel, node: nodeId },
        record: version.path,
        attach: async (landed) => {
          const back = await this.attachResult(
            ws.root,
            rel,
            entry,
            node,
            landed,
            version.made.params,
            facts,
          )
          written.result = back.result
          return back.settled
        },
      })
      if (!outcome.ok) {
        return {
          ok: false,
          message: outcome.message,
          pending: outcome.record !== undefined,
          ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}),
        }
      }
      // 成功的结果一定经过 `attach`。
      return written.result!
    })
    entry.done = done
    return { done: this.joined(entry, opts.signal) }
  }

  /** 运行与取回共用的前置检查：画布、节点，以及该卡是否正在生成或取回（`entryOf`），由调用方决定并入还是拒绝。 */
  private async target(
    ws: CanvasWorkspace,
    path: string,
    nodeId: string,
  ): Promise<{
    rel: string
    key: string
    doc: CanvasDoc
    node: CanvasGenerateNode
    running: RunEntry | undefined
  }> {
    const abs = await this.docs.locate(ws.root, path)
    const rel = await this.docs.relativeTo(ws.root, abs)
    const key = `${keyOf(ws.root, path)}#${nodeId}`
    const doc = await this.docs.load(abs)
    const node = doc.nodes.find((n) => n.id === nodeId)
    if (!node) throw new CanvasFailure(`目标已不存在：${nodeId}`, 404)
    if (node.type !== 'generate') throw new CanvasFailure('只有生成节点能运行', 422)
    return {
      rel,
      key,
      doc,
      node,
      running: this.states.entryOf(ws.root, keyOf(ws.root, path), node),
    }
  }

  /**
   * 正在进行的生成或取回的结果。`signal` 中止时只结束等待，生成照常进行并回写画布。
   * 不要在中止时把 `pending` 记为真：该卡仍在本地生成，结果会自行写回，不需要取回。
   */
  private joined(entry: RunEntry, signal: AbortSignal | undefined): Promise<CanvasRunResult> {
    const done = entry.done!
    if (!signal) return done
    const stopped: CanvasRunResult = {
      ok: false,
      message: '已停止等待；该卡的生成照常进行，结束后写回画布',
      pending: false,
    }
    if (signal.aborted) return Promise.resolve(stopped)
    return new Promise((resolve, reject) => {
      const stop = () => resolve(stopped)
      signal.addEventListener('abort', stop, { once: true })
      // 收尾抛出（删除任务记录、移除占位版本时的文件错误）时同样交给等待方：不处理时既成为未处理的拒绝，
      // 等待方也不会结束。
      void done.then(
        (r) => {
          signal.removeEventListener('abort', stop)
          resolve(r)
        },
        (err: unknown) => {
          signal.removeEventListener('abort', stop)
          reject(err)
        },
      )
    })
  }

  private begin(
    key: string,
    ws: CanvasWorkspace,
    rel: string,
    nodeId: string,
    action: 'run' | 'retrieve' = 'run',
  ): RunEntry {
    if (this.shutdown.aborted || this.deps.updating?.())
      throw new CanvasFailure('应用正在更新或关闭，请稍后重试', 409)
    if (this.states.running.has(key)) throw new CanvasFailure('该卡片正在生成', 409)
    const entry: RunEntry = {
      startedAt: Date.now(),
      action,
      stop: new AbortController(),
    }
    this.states.running.set(key, entry)
    this.states.failures.delete(key)
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

  /**
   * 请求被拒绝后的重试等待（`MediaCall.onRetry`），生成与取回共用：记在运行条目上供卡片显示，发送一条 `canvas.run`。
   * 取回的重试来自云端一侧（走云端的任务在云端被上游拒绝后重试）。
   */
  private retrying(
    entry: RunEntry,
    ws: CanvasWorkspace,
    rel: string,
    nodeId: string,
    retry: RetryWait | null,
  ): void {
    if (retry) entry.retry = retry
    else delete entry.retry
    // 等待重试期间接口没有受理请求，此时停止不产生费用；请求重新发出后恢复为已发出。
    if (entry.requestSent !== undefined && !entry.task) entry.requestSent = retry === null
    this.deps.publish({
      type: 'canvas.run',
      workspaceId: ws.id,
      path: rel,
      nodeId,
      state: 'running',
    })
  }

  /** 生成与轮询的中止信号：只有卡片自身的停止与应用关闭。调用方的信号只结束等待（`joined`）。 */
  private signalFor(entry: RunEntry): AbortSignal {
    return AbortSignal.any([entry.stop.signal, this.shutdown])
  }

  /**
   * 撤销远端任务，交给 `cancel`：界面的取消与大模型的 `cancel_canvas` 使用同一个函数（`deps.cancelTask`）。
   * 未提供时抛出，`cancel` 按撤销请求失败处理：停止本地等待并保留任务。
   */
  readonly cancelTask: CanvasCancelTask = (task) => {
    if (!this.deps.cancelTask) throw new Error('未配置撤销远端任务的方式')
    return this.deps.cancelTask(task)
  }

  /**
   * 取消一张卡片正在进行的生成。
   *
   * 直连接口的图像、音频等单次请求没有远端任务可撤销：停止本地等待，收尾时记为结果未知，返回 `stopped`。
   * 走云端的出图与音频有任务号，与视频相同按任务号撤销：云端撤销尚未发往上游的任务并退回积分，已发往上游的答复已开始。
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
    const canvasKey = keyOf(workspaceRoot, path)
    const node = (await this.docs.load(await this.docs.locate(workspaceRoot, path))).nodes.find(
      (n) => n.id === nodeId,
    )
    const entry = node ? this.states.entryOf(workspaceRoot, canvasKey, node) : undefined
    if (!entry) throw new CanvasFailure('该卡片未在生成', 409)
    if (entry.cancelled) return 'cancelled'
    // 每次停止写一行日志：停止之后仍被计费或仍有结果时，据此确认停止的时刻、停止时是否已有任务号与远端的答复。
    const ended = (outcome: CanvasCancelOutcome, remote?: string): CanvasCancelOutcome => {
      log.info('canvas', `停止生成：${outcome}`, {
        canvas: path,
        node: nodeId,
        ...(entry.task ? { job: entry.task.taskId } : {}),
        ...(remote ? { remote } : {}),
      })
      return outcome
    }
    if (!entry.task) {
      entry.stop.abort()
      const result = await entry.done
      return ended(result?.ok ? 'ended' : entry.requestSent === false ? 'not_submitted' : 'stopped')
    }
    const task = entry.task
    let remote: string
    try {
      remote = await cancelTask(task)
      if (remote === 'cancelled') entry.cancelled = true
    } catch (err) {
      remote = `failed: ${err instanceof Error ? err.message : String(err)}`
      entry.stopMessage = `未能确认远端取消：${err instanceof Error ? err.message : String(err)}`
    }
    entry.stop.abort()
    const result = await entry.done
    return ended(result?.ok ? 'ended' : entry.cancelled ? 'cancelled' : 'stopped', remote)
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
    const entry = this.states.running.get(key)
    // 远端已撤销：删除任务记录，占位版本随后删除，卡片恢复到本次生成之前的状态，不记录失败。
    if (!result.ok && entry?.cancelled && entry.task) {
      await rm(join(ws.root, entry.task.record), { force: true })
      result = { ok: false, message: '已取消生成', pending: false }
    }
    // 无回执时停止等待：远端仍可能完成。任务记录只在能取回时保留（`generateMedia`），已成功的结果照常保留。
    const stopped = !result.ok && !entry?.cancelled && entry?.stop.signal.aborted === true
    const unsent = stopped && entry.requestSent === false
    if (stopped) {
      const pending = !!entry.record && (await this.isFile(ws.root, entry.record.path))
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
    /*
     * 任务记录已不存在即没有可取回的结果（远端失败、撤销、停止等待时记录不能取回、提交之前被拒绝、记录已被删除）：
     * 删除引用该记录的占位版本，它此刻所在的每张画布都删除。生成、取回、撤销与停止只在此处删除，不在各自的分支中另行处理。
     * 判据是记录是否仍在，不是 `pending`：服务退出时等待被中止，记录能取回而结果不标为待取回，占位版本须留给启动恢复。
     */
    if (!result.ok && entry?.record && !(await this.isFile(ws.root, entry.record.path))) {
      entry.cards = await this.dropTask(ws.root, entry.record.path)
    }
    const task = entry?.task
    const provider = facts.provider ?? task?.provider
    const model = facts.model ?? task?.model
    const record: Omit<CanvasRunRecord, 'node'> = {
      ...facts,
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
    // 生成记录与结束事件写到收尾时确定的位置：画布在生成期间改名或移动后，写到它此刻所在的画布。
    const homes = entry?.cards?.length ? entry.cards : [{ path: rel, nodeId, versionId: null }]
    for (const home of homes) {
      // 画布文件已被删除或损坏时无法写入记录；生成本身的结果不因此改变。
      await this.docs
        .mutate(ws.root, home.path, (d) => recordRun(d, { ...record, node: home.nodeId }))
        .catch(() => {})
    }
    this.states.running.delete(key)
    for (const home of homes) {
      if (!result.ok && !entry?.cancelled && !unsent) {
        this.states.failures.set(`${keyOf(ws.root, home.path)}#${home.nodeId}`, result.message)
      }
      this.deps.publish({
        type: 'canvas.run',
        workspaceId: ws.id,
        path: home.path,
        nodeId: home.nodeId,
        ...(result.ok || entry?.cancelled || unsent
          ? { state: 'done' }
          : { state: 'failed', message: result.message }),
      })
    }
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
   * 一次生成此刻的归属：工作区中引用该任务记录的每一个版本（画布被复制时可能有多张）。每次生成在提交之前写入任务记录，
   * 卡片的占位版本引用它，因此归属只按记录判定，不以发起时记下的画布路径或卡片 id 推测：画布可能在生成期间被改名、移动、复制或删除。
   * 无法读取的画布列入 `unreadable`：其中是否引用该记录无法判定。
   */
  private async cardsOf(
    root: string,
    record: string,
  ): Promise<{ cards: CardAt[]; unreadable: string[] }> {
    const cards: CardAt[] = []
    const unreadable: string[] = []
    for (const path of await this.docs.list(root)) {
      let doc: CanvasDoc
      try {
        doc = await this.docs.load(await this.docs.locate(root, path))
      } catch {
        unreadable.push(path)
        continue
      }
      for (const node of doc.nodes) {
        if (node.type !== 'generate') continue
        for (const v of node.versions) {
          if (v.path === record) cards.push({ path, nodeId: node.id, versionId: v.id })
        }
      }
    }
    return { cards, unreadable }
  }

  /**
   * 产物已落盘，写回此刻引用任务记录的每一张卡（`cardsOf`）。成功时返回各产物的像素宽高与时长、实际发送的参数，以及回写后卡片当前版本的路径，
   * 供调用方核对结果：一次生成有多个产物时只有当前版本显示在卡片上；写回的画布不是发起时的画布（`rel`）时给出 `canvas`。
   *
   * `settled` 表示任务记录可以删除：已全部写回，或已确认没有画布引用该记录（卡片、版本或画布已删除，产物留在原位置，结果写明）。
   * 有引用而写入失败、或没有找到引用而有画布无法读取时为 false：任务记录保留并写明已落盘的产物，画布恢复后对该卡取回即接上产物，
   * 不重新下载（`generateMedia` 的 `attach`）。
   */
  private async writeBack(
    root: string,
    rel: string,
    record: string,
    made: {
      files: GeneratedFile[]
      sizes: Map<string, CanvasPixels>
      params: Record<string, unknown>
    },
    change: (doc: CanvasDoc, card: CardAt) => CanvasResult,
    warning: string | undefined,
  ): Promise<{ result: CanvasRunResult; settled: boolean; cards: CardAt[] }> {
    const paths = made.files.map((f) => f.path)
    const where = paths.join('、')
    const { cards, unreadable } = await this.cardsOf(root, record)
    const failed: string[] = []
    let shown: { card: CardAt; current: string | undefined } | undefined
    for (const card of cards) {
      try {
        const { doc } = await this.docs.mutate(root, card.path, (d) => change(d, card))
        const node = doc.nodes.find((n) => n.id === card.nodeId)
        const current =
          node?.type === 'generate'
            ? node.versions.find((v) => v.id === node.current)?.path
            : undefined
        if (!shown || card.path === rel) shown = { card, current }
      } catch (err) {
        failed.push(`${card.path}：${(err as Error).message}`)
      }
    }
    if (shown && !failed.length) {
      const outputs = await Promise.all(
        paths.map(async (path) => {
          const duration = mediaDurationOfFile(join(root, path))
          return {
            path,
            ...sizeField(made.sizes.get(path)),
            ...(duration === null ? {} : { duration }),
          }
        }),
      )
      const result: CanvasRunResult = {
        ok: true,
        outputs,
        params: made.params,
        ...(shown.current ? { current: shown.current } : {}),
        ...(shown.card.path !== rel ? { canvas: shown.card.path } : {}),
        ...(warning ? { warning } : {}),
      }
      return { result, settled: true, cards }
    }
    if (failed.length || (!cards.length && unreadable.length)) {
      const reason = failed.length ? failed.join('；') : `无法读取 ${unreadable.join('、')}`
      return {
        result: {
          ok: false,
          message: `已生成，但回写画布失败（${reason}），产物位于 ${where}；任务记录 ${record} 已保留，画布恢复后对该卡取回即接上产物，不重新下载`,
          pending: true,
        },
        settled: false,
        cards,
      }
    }
    return {
      result: {
        ok: false,
        message: `已生成，但没有画布引用该次生成（卡片、版本或画布已删除）；产物位于 ${where}，任务记录已删除`,
        pending: false,
      },
      settled: true,
      cards,
    }
  }

  /**
   * 删除引用任务记录的占位版本（没有可取回的结果时，见 `settleRun`），按记录找到它此刻所在的每张画布。返回删除的位置，生成记录写到这里。
   */
  private async dropTask(root: string, record: string): Promise<CardAt[]> {
    const { cards } = await this.cardsOf(root, record)
    for (const card of cards) {
      await this.docs
        .mutate(root, card.path, (d) =>
          applyCanvasOps(d, [{ op: 'remove', id: card.nodeId, version: card.versionId }]),
        )
        .catch(() => {})
    }
    return cards
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

  /** 等待启动恢复与各次生成收尾完成。先中止 `shutdown`（`CanvasService.stop`），否则等待到生成自行结束。 */
  async drain(): Promise<void> {
    await this.recovery?.catch(() => {})
    await Promise.all([...this.states.running.values()].map((run) => run.done))
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
