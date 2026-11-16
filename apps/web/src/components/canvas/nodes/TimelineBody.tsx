import type { CanvasTimelineNode } from '@qywork/core'
import { useCanvas } from '../board/context.ts'
import { fileUrlOf } from '../GeneratePanel.tsx'
import { exportTimeline } from '../input/clips.ts'
import { openClipMenu } from '../input/context-menu.ts'
import { Timeline } from '../Timeline.tsx'

/** 时间线节点的内容区。全屏编辑时预览移到全屏层（`FullscreenTimeline`）。 */
export function TimelineBody(p: { node: CanvasTimelineNode }) {
  const canvas = useCanvas()
  return (
    <Timeline
      node={p.node}
      mode="node"
      showPreview={canvas.fullscreen() !== p.node.id}
      urlOf={(path) => fileUrlOf(canvas.view(), path)}
      exporting={canvas.exports()[p.node.id] ?? null}
      setClips={(clips) =>
        canvas.apply([{ op: 'update', id: p.node.id, clips }]).then((r) => r !== null)
      }
      setMuted={(muted) => void canvas.apply([{ op: 'update', id: p.node.id, muted }])}
      onFocus={() => {
        canvas.setEdgeSelected(null)
        if (!canvas.selected().has(p.node.id)) canvas.setSelected(new Set([p.node.id]))
      }}
      onAdd={(anchor, gap) => canvas.setMenu({ kind: 'clip', anchor, nodeId: p.node.id, gap })}
      onClipMenu={(index, t, x, y) => openClipMenu(canvas, p.node.id, index, t, x, y)}
      onExport={() => void exportTimeline(canvas, p.node.id)}
      onCancelExport={() => canvas.exportAborts.get(p.node.id)?.abort()}
      onFullscreen={() => canvas.setFullscreen(p.node.id)}
    />
  )
}
