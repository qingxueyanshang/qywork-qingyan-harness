/** 时间线的剪辑与导出：判定落点处的时间线与间隙、把视频加入轨道、导出成片。 */

import { canvasMediaOf } from '@qywork/core'
import { createEffect, untrack } from 'solid-js'
import { ApiError } from '../../../lib/client.ts'
import {
  explainApiError,
  exportAbort,
  exportFinish,
  exportRequests,
  exportStart,
  exportWrite,
  setExportRequests,
} from '../../../lib/store/index.ts'
import { type CanvasController, normPath } from '../board/controller.ts'
import { fileUrlOf, mediaOf } from '../GeneratePanel.tsx'
import { renderTimeline } from '../render.ts'
import { gapAt, insertClips, metaOf, sessionOf } from '../timeline.ts'

/** 屏幕上该点下方的时间线；`skip` 中的节点（拖动中的节点）不参与判定。 */
export const timelineAt = (
  canvas: CanvasController,
  clientX: number,
  clientY: number,
  skip: string[] = [],
): string | null => {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const id = el.closest<HTMLElement>('[data-node]')?.dataset.node
    if (id && !skip.includes(id)) return canvas.byId(id)?.type === 'timeline' ? id : null
  }
  return null
}

/** 落点在时间线轨道上时，返回指针处的间隙；落在工具行或预览上时返回 `undefined`（插入末尾）。 */
export const gapFor = (
  canvas: CanvasController,
  id: string,
  clientX: number,
  onTracks: boolean,
): number | undefined => {
  const n = canvas.byId(id)
  if (n?.type !== 'timeline' || !onTracks) return undefined
  const t = sessionOf(id)?.timeAtClient?.(clientX)
  return t === undefined ? undefined : gapAt(n.clips, t)
}

/** 屏幕上该点是否位于时间线 `id` 的轨道上。拖动中指针被画布捕获，事件目标不是指针下的元素，只能按坐标判定。 */
export const onTracksAt = (id: string, clientX: number, clientY: number): boolean =>
  document
    .elementsFromPoint(clientX, clientY)
    .some(
      (el) =>
        el.closest('.canvas-tl-tracks') &&
        el.closest<HTMLElement>('[data-node]')?.dataset.node === id,
    )

/** 拖放事件的目标是否位于轨道上。 */
export const dropOnTracks = (e: DragEvent): boolean =>
  (e.target as Element).closest('.canvas-tl-tracks') !== null

/** 从 `from` 拖线到时间线 `to` 时能否加入：`from` 必须是有文件的视频。 */
export const clipsInto = (canvas: CanvasController, from: string, to: string): boolean => {
  const v = canvas.view()
  return (
    !!v &&
    canvas.byId(to)?.type === 'timeline' &&
    mediaOf(v, from).kind === 'video' &&
    mediaOf(v, from).path !== null
  )
}

/** 拖动节点时指针下的时间线；拖动的节点中没有视频时返回 null。 */
export const timelineUnder = (
  canvas: CanvasController,
  clientX: number,
  clientY: number,
  dragged: string[],
): string | null => {
  const v = canvas.view()
  if (!v || !dragged.some((id) => mediaOf(v, id).kind === 'video' && mediaOf(v, id).path)) {
    return null
  }
  return timelineAt(canvas, clientX, clientY, dragged)
}

/**
 * 在时间线的第 `gap` 个间隙（缺省为末尾）插入完整的视频：时长读取自源文件，非视频或无法读取时长的文件被跳过。
 */
export const addClips = async (
  canvas: CanvasController,
  id: string,
  paths: string[],
  gap?: number,
) => {
  const videos = paths.filter(
    (p) => canvasMediaOf({ id: '', type: 'file', path: p, x: 0, y: 0, w: 0, h: 0 }) === 'video',
  )
  const added = (
    await Promise.all(
      videos.map(async (path) => {
        const d = (await metaOf(fileUrlOf(canvas.view(), path))).duration
        return d > 0 ? [{ path, in: 0, out: Math.floor(d * 1000) / 1000 }] : []
      }),
    )
  ).flat()
  const n = canvas.byId(id)
  if (n?.type !== 'timeline') return
  // 时长读取失败的视频不加入轨道，须写明文件名；不得报告为「只有视频可以加入」。
  const unreadable = videos.filter((p) => !added.some((c) => c.path === p))
  if (unreadable.length) {
    canvas.setFault(`无法读取视频时长：${unreadable.map((p) => p.split('/').pop()).join('、')}`)
  } else if (!added.length) {
    canvas.setFault('只有视频可以加入时间线')
  }
  if (!added.length) return
  await canvas.apply([
    { op: 'update', id, clips: insertClips(n.clips, gap ?? n.clips.length, added) },
  ])
}

/**
 * 导出视频：浏览器一边编码 mp4 一边写入服务端，完成后保存到 `generated/`，来源节点右侧出现新的视频节点。
 * `encode` 把字节交给 `write`，进度经 `progress` 报告。返回新节点的 id；取消或失败时为 `null`。
 *
 * `requested` 表示执行的是大模型请求的导出（`canvas.export`）。该请求发给打开该项目的每个界面，由先开始导出的界面认领，
 * 其余界面开始导出时得到 409：这次导出由另一个界面执行，不是本界面的错误，不显示。用户点击导出时的 409 照常显示。
 */
export const exportVideo = async (
  canvas: CanvasController,
  id: string,
  failText: string,
  encode: (
    write: (bytes: Uint8Array<ArrayBuffer>, at: number) => Promise<void>,
    progress: (ratio: number) => void,
    signal: AbortSignal,
  ) => Promise<void>,
  requested = false,
): Promise<string | null> => {
  if (canvas.exportAborts.has(id)) return null
  const ac = new AbortController()
  canvas.exportAborts.set(id, ac)
  canvas.setExports((x) => ({ ...x, [id]: 0 }))
  let upload: string | null = null
  try {
    const session = await exportStart(canvas.props.path, id)
    upload = session
    await encode(
      (bytes, at) => exportWrite(session, at, bytes),
      (ratio) => canvas.setExports((x) => ({ ...x, [id]: ratio })),
      ac.signal,
    )
    const r = await exportFinish(session)
    upload = null
    canvas.setFault(null)
    void canvas.load()
    return r.nodeId
  } catch (e) {
    // 未完成的文件由服务端删除；该请求失败时，服务端在空闲超时后同样会删除。
    if (upload) void exportAbort(upload).catch(() => {})
    const claimedElsewhere =
      requested && upload === null && e instanceof ApiError && e.status === 409
    if ((e as Error).name !== 'AbortError' && !claimedElsewhere) {
      canvas.setFault(explainApiError(e, failText))
    }
    return null
  } finally {
    canvas.exportAborts.delete(id)
    canvas.setExports(({ [id]: _, ...rest }) => rest)
  }
}

/** 导出时间线成片，完成后选中新节点（全屏编辑中不改变选区）。`requested` 见 `exportVideo`。 */
export const exportTimeline = async (canvas: CanvasController, id: string, requested = false) => {
  const n = canvas.byId(id)
  if (n?.type !== 'timeline' || !n.clips.length) return
  const created = await exportVideo(
    canvas,
    id,
    '导出失败',
    (write, progress, signal) =>
      renderTimeline(
        n.clips.map((c) => ({
          url: fileUrlOf(canvas.view(), c.path),
          name: c.path.split('/').pop() ?? c.path,
          in: c.in,
          out: c.out,
        })),
        !!n.muted,
        progress,
        signal,
        write,
      ),
    requested,
  )
  if (created && !canvas.fullscreen()) canvas.setSelected(new Set([created]))
}

// 大模型请求的导出（`canvas.export`）：本画布读取完成后取走请求，执行与「导出」按钮相同的导出。
export const exportOnRequest = (canvas: CanvasController) => {
  createEffect(() => {
    if (!canvas.view()) return
    const mine = exportRequests().filter((r) => normPath(r.path) === normPath(canvas.props.path))
    if (!mine.length) return
    setExportRequests((all) => all.filter((r) => !mine.includes(r)))
    untrack(() => {
      for (const r of mine) void exportTimeline(canvas, r.nodeId, true)
    })
  })
}
