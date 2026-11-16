import { Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { useCanvas } from '../board/context.ts'
import { fileUrlOf } from '../GeneratePanel.tsx'
import { exportTimeline } from '../input/clips.ts'
import { openClipMenu } from '../input/context-menu.ts'
import { Timeline } from '../Timeline.tsx'

/** 全屏编辑中的时间线，挂载在文档根节点。 */
export function FullscreenTimeline() {
  const canvas = useCanvas()
  return (
    <Show
      when={(() => {
        const id = canvas.fullscreen()
        const n = id ? canvas.byId(id) : undefined
        return n?.type === 'timeline' ? n : null
      })()}
    >
      {(n) => (
        <Portal>
          <div class="canvas-tl-layer">
            <Timeline
              node={n()}
              mode="full"
              showPreview={true}
              urlOf={(path) => fileUrlOf(canvas.view(), path)}
              exporting={canvas.exports()[n().id] ?? null}
              setClips={(clips) =>
                canvas.apply([{ op: 'update', id: n().id, clips }]).then((r) => r !== null)
              }
              setMuted={(muted) => void canvas.apply([{ op: 'update', id: n().id, muted }])}
              onFocus={() => {}}
              onAdd={(anchor, gap) => canvas.setMenu({ kind: 'clip', anchor, nodeId: n().id, gap })}
              onClipMenu={(index, t, x, y) => openClipMenu(canvas, n().id, index, t, x, y)}
              onExport={() => void exportTimeline(canvas, n().id)}
              onCancelExport={() => canvas.exportAborts.get(n().id)?.abort()}
              onFullscreen={() => canvas.setFullscreen(null)}
            />
          </div>
        </Portal>
      )}
    </Show>
  )
}
