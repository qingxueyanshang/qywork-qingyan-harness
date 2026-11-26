/** 新建节点：生成卡与时间线、从已有节点新建后续生成卡、视频取帧、Art 截图与录制。 */

import {
  blankBox,
  type CanvasEdgeRole,
  frameLabel,
  GENERATE_OUTPUTS,
  type GenerateOutput,
  isChatOutput,
  isTextCard,
} from '@qywork/core'
import { captureFrame, explainApiError } from '../../../lib/store/index.ts'
import { pngOf, recordArt } from '../art.ts'
import type { CanvasController } from '../board/controller.ts'
import { captureVideoFrame } from '../frame.ts'
import { fileUrlOf, mediaOf } from '../GeneratePanel.tsx'
import { exportVideo } from './clips.ts'

export const addGenerate = async (
  canvas: CanvasController,
  output: GenerateOutput,
  near = canvas.center(),
) => {
  canvas.setMenu(null)
  const r = await canvas.apply([{ op: 'add_generate', ref: '$n', output, near }])
  if (r?.refs.$n) canvas.setSelected(new Set([r.refs.$n]))
}

export const addTimeline = async (canvas: CanvasController, near = canvas.center()) => {
  canvas.setMenu(null)
  const r = await canvas.apply([{ op: 'add_timeline', ref: '$t', near }])
  if (r?.refs.$t) canvas.setSelected(new Set([r.refs.$t]))
}

/**
 * Art 录制：从实时页面当前的状态起录制 `seconds` 秒。Art 节点保持选中：取消选中会关闭实时页面，
 * 用户调整的视角随之丢失。
 */
export const recordNode = (canvas: CanvasController, id: string, seconds: number) => {
  canvas.setMenu(null)
  const live = canvas.arts.get(id)
  if (!live) return canvas.setFault('页面尚未加载')
  void exportVideo(canvas, id, '录制失败', async (write, progress, signal) => {
    await live.handle.ready
    await recordArt(live.handle, live.size, seconds, progress, signal, write)
  })
}

/** Art 截图：截取实时页面当前的画面，保存为 PNG 节点放在右侧。Art 节点保持选中，理由同 `recordNode`。 */
export const shoot = async (canvas: CanvasController, id: string) => {
  const live = canvas.arts.get(id)
  if (!live) return canvas.setFault('页面尚未加载')
  try {
    await live.handle.ready
    await captureFrame(canvas.props.path, id, '截图', await pngOf(await live.handle.capture()))
    canvas.setFault(null)
    void canvas.load()
  } catch (e) {
    canvas.setFault(explainApiError(e, '截图失败'))
  }
}

/**
 * 从节点新建一张后续生成卡，并把该节点连接为输入：文本卡以 `text` 连接（提示词中插入引用），视频节点作为参考视频，
 * 图片作为首帧（视频生成）或参考（图像生成与使用对话模型的卡）。
 * 给出 `at` 时，卡片左边沿中点（输入连线的终点）位于该点，与已有节点重叠时也不移动。
 * 不要改为 `near`：它以该点为卡片中心，且与已有节点相交时下移，落点靠近源节点时卡片被移到源节点下方。
 */
export const extend = async (
  canvas: CanvasController,
  nodeId: string,
  output: GenerateOutput,
  at?: { x: number; y: number },
) => {
  canvas.setMenu(null)
  const source = canvas.byId(nodeId)
  const kind = mediaOf(canvas.view()!, nodeId).kind
  if (!source) return
  let role: CanvasEdgeRole
  if (isTextCard(source)) role = 'text'
  else if (!kind || kind === 'art') return
  else
    role =
      output === 'image' || isChatOutput(output)
        ? 'reference'
        : kind === 'image'
          ? 'first_frame'
          : kind
  const place = at
    ? { x: Math.round(at.x), y: Math.round(at.y - blankBox(output).h / 2) }
    : { beside: nodeId }
  const r = await canvas.apply([
    { op: 'add_generate', ref: '$n', output, ...place },
    { op: 'connect', from: nodeId, to: '$n', role },
  ])
  if (r?.refs.$n) canvas.setSelected(new Set([r.refs.$n]))
}

/** 可以从该节点新建的后续生成卡类别。文本卡可以接到任何生成卡；Art 节点不能作为输入。 */
export const extendable = (canvas: CanvasController, nodeId: string): GenerateOutput[] => {
  const source = canvas.byId(nodeId)
  if (source && isTextCard(source)) return [...GENERATE_OUTPUTS]
  const kind = canvas.view() ? mediaOf(canvas.view()!, nodeId).kind : null
  if (kind === null || kind === 'art') return []
  return GENERATE_OUTPUTS.filter((o) =>
    o === 'image' || isChatOutput(o) ? kind === 'image' : o === 'video',
  )
}

export const capture = async (
  canvas: CanvasController,
  nodeId: string,
  at: number,
  duration: number,
) => {
  canvas.setMenu(null)
  const media = canvas.view() ? mediaOf(canvas.view()!, nodeId) : null
  if (!media?.path) return
  try {
    const blob = await captureVideoFrame(fileUrlOf(canvas.view(), media.path), at)
    const r = await captureFrame(canvas.props.path, nodeId, frameLabel(at, duration), blob)
    canvas.setFault(null)
    canvas.setSelected(new Set([r.nodeId]))
    void canvas.load()
  } catch (e) {
    canvas.setFault(explainApiError(e, '取帧失败'))
  }
}
