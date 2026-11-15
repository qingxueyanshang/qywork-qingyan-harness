import { definePort } from '@qywork/agent'
import type {
  CanvasBatchRunResult,
  CanvasCancelOutcome,
  CanvasOp,
  CanvasRunResult,
  CanvasView,
} from '@qywork/core'
import type { MediaPort } from '../generate/port.ts'

/** `CanvasPort.edit` 的结果。 */
export interface CanvasEditResult {
  view: CanvasView
  refs: Record<string, string>
  skipped: { at: number; error: string }[]
  changed: string[]
  moved: string[]
  removed: string[]
  replaced: { at: number; count: number }[]
}

/** `CanvasPort.render` 的一项：渲染出的截图（PNG 的 base64）与页面脚本报错，或该卡无法渲染的原因。 */
export type CanvasRender =
  | { name: string; size: { w: number; h: number }; png: string; errors: string[] }
  | { name: string; failure: string }

/**
 * 画布端口：Agent 读取、修改、运行画布，由服务端画布服务执行。与界面使用同一个实例，
 * 因此画布的写入次序与运行中卡片的状态只有一份。实现由 server 注入；
 * 没有服务端的会话（CLI）不注入，画布工具不注册。
 *
 * 失败以抛出 `Error` 表示，`message` 原样交给大模型。
 */
export interface CanvasPort {
  /** 在指定工作区路径创建空画布；已有文件不覆盖。返回规范化的工作区相对路径。 */
  create(path: string): Promise<string>
  /** 工作区中的画布文件，以工作区相对路径表示。 */
  list(): Promise<string[]>
  /**
   * 引用文本文件 `path`（工作区相对路径）的画布卡片与其中已不成立的引用，每项一行；没有引用时为空。
   * 文件工具写入 .md / .txt 后附在结果中。
   */
  textReferences(path: string): Promise<string[]>
  /**
   * 设计稿卡按页面的显示尺寸渲染并截图，`nodes` 为卡片名称或 id。在内置浏览器的隐藏页中进行，
   * 界面不受影响。内置浏览器不可用时不提供该方法。
   */
  render?(path: string, nodes: string[]): Promise<CanvasRender[]>
  read(path: string): Promise<CanvasView>
  /**
   * 逐条应用一批操作：不成立的条目跳过，`skipped` 中的 `at` 为该条在 `ops` 中的序号；其余照常生效。
   * `changed` 为本批新增或内容有变化的节点 id，`moved` 为只改变了位置或尺寸的节点 id，
   * `removed` 为本批删除的节点名称，`replaced` 为每条 `replace_text` 在该卡提示词中替换的处数（按 `ops` 的序号）。
   */
  edit(path: string, ops: CanvasOp[]): Promise<CanvasEditResult>
  /**
   * 运行一张生成卡并等待结束。花费记入 `media`：Agent 传入本轮的生成端口，花费计入本轮。
   * 生成归画布所有：`signal` 中止时只结束等待，生成照常进行并写回画布。
   */
  run(path: string, nodeId: string, media: MediaPort, signal: AbortSignal): Promise<CanvasRunResult>
  /**
   * 只运行指定节点，依赖已满足的节点同时提交，批内依赖按顺序执行。`signal` 中止后已开始的节点照常生成，
   * 尚未派发的节点不再提交。
   */
  runBatch(
    path: string,
    nodeIds: string[],
    media: MediaPort,
    signal: AbortSignal,
  ): Promise<CanvasBatchRunResult>
  /** 取回仍在远端的某一版视频。省略 `version` 时取当前版本或最新的待取回版本。`signal` 同 `run`。 */
  retrieve(
    path: string,
    nodeId: string,
    version: string | undefined,
    media: MediaPort,
    signal: AbortSignal,
  ): Promise<CanvasRunResult>
  /**
   * 取消一张卡正在进行的生成，与界面卡片上的取消相同：有任务号的生成（视频，以及走云端的出图与音频）按接口能力撤销，
   * 无法撤销时停止等待并保留任务。该卡未在生成时抛出。
   */
  cancel(path: string, nodeId: string): Promise<CanvasCancelOutcome>
  /**
   * 保存从视频卡截取的一帧（PNG）并在该卡右侧添加引用它的图片卡，与界面取帧相同。
   * `label` 为帧的名称（`frameLabel`）。返回新卡的 id 与文件的工作区路径。
   */
  captureFrame(
    path: string,
    nodeId: string,
    label: string,
    png: Uint8Array,
  ): Promise<{ nodeId: string; path: string }>
  /**
   * 导出一条时间线并等待完成：由界面执行与「导出」按钮相同的导出，成片保存在 `generated/`，时间线右侧新增视频卡。
   * 返回新卡的 id 与成片的工作区路径。没有界面接手、导出失败或 `signal` 中止时抛出。
   */
  exportTimeline(
    path: string,
    nodeId: string,
    signal: AbortSignal,
  ): Promise<{ nodeId: string; path: string }>
}

export const CanvasPort = definePort<CanvasPort>('canvas')
