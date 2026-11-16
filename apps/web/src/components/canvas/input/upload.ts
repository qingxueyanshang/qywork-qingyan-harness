/** 向画布添加文件：从文件树或系统拖入、从工作区选择、从本机上传、从生成面板添加素材。 */

import type { CanvasNode } from '@qywork/core'
import {
  type DropSink,
  explainApiError,
  importToCanvas,
  uploadToCanvas,
  WORKSPACE_PATH_TYPE,
} from '../../../lib/store/index.ts'
import type { CanvasController } from '../board/controller.ts'
import { addClips, dropOnTracks, gapFor, onTracksAt, timelineAt } from './clips.ts'

export const onDragOver = (e: DragEvent) => {
  const dt = e.dataTransfer
  if (!dt || (!dt.types.includes(WORKSPACE_PATH_TYPE) && !dt.types.includes('Files'))) return
  e.preventDefault()
  dt.dropEffect = 'copy'
}

export const onDrop = (canvas: CanvasController, e: DragEvent) => {
  const path = e.dataTransfer?.getData(WORKSPACE_PATH_TYPE)
  const files = [...(e.dataTransfer?.files ?? [])]
  if (!path && files.length) {
    // 浏览器中处理从系统拖入的文件；桌面外壳中的系统拖放由外壳截获，经由 shell-drop 处理。
    e.preventDefault()
    const into = timelineAt(canvas, e.clientX, e.clientY)
    if (into)
      void uploadClips(canvas, into, files, gapFor(canvas, into, e.clientX, dropOnTracks(e)))
    else void uploadFiles(canvas, files, canvas.toWorld(e.clientX, e.clientY))
    return
  }
  if (!path) return
  e.preventDefault()
  const target = (e.target as HTMLElement).closest<HTMLElement>('[data-node]')
  const onto = target ? canvas.byId(target.dataset.node!) : undefined
  // 拖放到缺失的文件节点上即替换该节点的路径。
  if (onto?.type === 'file' && canvas.view()?.states[onto.id]?.state === 'missing') {
    void canvas.apply([{ op: 'update', id: onto.id, path }])
    return
  }
  if (onto?.type === 'timeline') {
    void addClips(canvas, onto.id, [path], gapFor(canvas, onto.id, e.clientX, dropOnTracks(e)))
    return
  }
  const at = canvas.toWorld(e.clientX, e.clientY)
  void canvas.apply([{ op: 'add_file', path, x: Math.round(at.x - 110), y: Math.round(at.y - 80) }])
}

export const pickFile = (canvas: CanvasController, path: string, first: boolean) => {
  canvas.picks = canvas.picks.then(async () => {
    const after =
      !first && canvas.lastPicked && canvas.byId(canvas.lastPicked) ? canvas.lastPicked : null
    const r = await canvas.apply([
      {
        op: 'add_file',
        ref: '$f',
        path,
        ...(after ? { beside: after } : { near: canvas.center() }),
      },
    ])
    if (r?.refs.$f) canvas.lastPicked = r.refs.$f
  })
}

/** 通过时间线的「+」从本机上传的视频：先添加到画布（时间线右侧），再按路径插入轨道。 */
export const uploadClips = async (
  canvas: CanvasController,
  id: string,
  files: File[],
  gap?: number,
) => {
  const paths: string[] = []
  for (const file of files) {
    try {
      paths.push((await uploadToCanvas(canvas.props.path, file, { beside: id })).path)
    } catch (e) {
      canvas.setFault(explainApiError(e, `上传失败：${file.name}`))
      break
    }
  }
  await canvas.load()
  if (paths.length) await addClips(canvas, id, paths, gap)
}

/** 逐个上传从本机选择的文件：第一个放在视野中央附近的空位，之后的依次放在上一个右侧。任一文件失败即停止并报告原因。 */
export const uploadFiles = async (
  canvas: CanvasController,
  files: File[],
  near = canvas.center(),
) => {
  let prev: string | null = null
  for (const file of files) {
    try {
      const r = await uploadToCanvas(canvas.props.path, file, prev ? { beside: prev } : { near })
      prev = r.nodeId
      canvas.setFault(null)
    } catch (e) {
      canvas.setFault(explainApiError(e, `上传失败：${file.name}`))
      break
    }
  }
  void canvas.load()
}

/**
 * 从生成面板添加到画布的素材：放在卡片左侧、与卡片中线对齐的空位（连线从左向右进入卡片）。
 * 本机文件先上传；返回新节点的 id，添加失败时返回 `null` 并报告原因。
 */
export const placeInput = async (
  canvas: CanvasController,
  card: CanvasNode,
  source: { path: string } | { file: File },
): Promise<string | null> => {
  const at = canvas.pos(card)
  const near = { x: at.x - 210, y: at.y + card.h / 2 }
  if ('path' in source) {
    const r = await canvas.apply([{ op: 'add_file', ref: '$f', path: source.path, near }])
    return r?.refs.$f ?? null
  }
  try {
    const r = await uploadToCanvas(canvas.props.path, source.file, { near })
    canvas.setFault(null)
    await canvas.load()
    return r.nodeId
  } catch (e) {
    canvas.setFault(explainApiError(e, `上传失败：${source.file.name}`))
    return null
  }
}

/** 桌面外壳中系统拖放的接收方：外壳截获拖放并提供绝对路径。 */
export const dropSink = (canvas: CanvasController): DropSink => ({
  hit: (pos) => {
    if (!canvas.props.active) return false
    const r = canvas.stage.getBoundingClientRect()
    return pos.x >= r.left && pos.x <= r.right && pos.y >= r.top && pos.y <= r.bottom
  },
  over: (on) => canvas.stage.classList.toggle('drop-over', on),
  paths: (paths, pos) => {
    if (!paths.length) return
    // 拖放到时间线上：先添加到画布，再把其中的视频插入轨道。
    const into = timelineAt(canvas, pos.x, pos.y)
    const gap = into ? gapFor(canvas, into, pos.x, onTracksAt(into, pos.x, pos.y)) : undefined
    void importToCanvas(canvas.props.path, paths, canvas.toWorld(pos.x, pos.y)).then(
      async ({ ids }) => {
        canvas.setFault(null)
        await canvas.load()
        if (!into) return
        const added = ids.flatMap((id) => {
          const n = canvas.byId(id)
          return n?.type === 'file' ? [n.path] : []
        })
        await addClips(canvas, into, added, gap)
      },
      (e: unknown) => canvas.setFault(explainApiError(e, '无法添加到画布')),
    )
  },
})
