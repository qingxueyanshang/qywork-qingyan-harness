import type { CanvasNode } from '@qywork/core'
import { For, Show } from 'solid-js'
import { useCanvas } from '../board/context.ts'
import type { Menu } from '../board/controller.ts'
import { mediaOf } from '../GeneratePanel.tsx'
import { capture, shoot } from '../input/create.ts'
import { FrameBar } from '../Player.tsx'

/** 单独选中一个节点时显示在其上方的工具条；取帧时由取帧条占据同一位置。 */
export function SelectionTools() {
  const canvas = useCanvas()
  const isVideo = (n: CanvasNode) =>
    canvas.view() !== null &&
    mediaOf(canvas.view()!, n.id).kind === 'video' &&
    mediaOf(canvas.view()!, n.id).path !== null
  const framing = (nodeId: string) => {
    const m = canvas.menu()
    return m?.kind === 'frame' && m.nodeId === nodeId ? canvas.players.get(nodeId) : undefined
  }
  /**
   * 选中工具条的按钮：视频取帧；Art 截图与录制。`menu` 为按钮打开的菜单（用于标出展开状态），
   * 录制中按钮显示进度，点击即取消，同时间线的导出按钮。
   */
  const tools = () => {
    const n = canvas.single()
    if (!n) return null
    const items: {
      label: string
      tip?: string
      menu?: Menu['kind']
      run: (anchor: HTMLElement) => void
    }[] = []
    if (isVideo(n)) {
      items.push({
        label: '取帧',
        menu: 'frame',
        run: (anchor) => canvas.setMenu({ kind: 'frame', anchor, nodeId: n.id }),
      })
    }
    if (
      canvas.view() &&
      mediaOf(canvas.view()!, n.id).kind === 'art' &&
      mediaOf(canvas.view()!, n.id).path
    ) {
      const progress = canvas.exports()[n.id]
      items.push({ label: '截图', run: () => void shoot(canvas, n.id) })
      items.push(
        progress === undefined
          ? {
              label: '录制',
              menu: 'record',
              run: (anchor) => canvas.setMenu({ kind: 'record', anchor, nodeId: n.id }),
            }
          : {
              label: `${Math.floor(progress * 100)}%`,
              tip: '取消录制',
              run: () => canvas.exportAborts.get(n.id)?.abort(),
            },
      )
    }
    if (!items.length) return null
    const p = canvas.pos(n)
    return {
      node: n,
      items,
      left: canvas.px() + (p.x + n.w / 2) * canvas.z(),
      top: canvas.py() + p.y * canvas.z() - 26,
    }
  }
  return (
    <Show when={tools()}>
      {(t) => (
        <Show
          when={framing(t().node.id)}
          fallback={
            <div class="canvas-tools" style={{ left: `${t().left}px`, top: `${t().top}px` }}>
              <For each={t().items}>
                {(item) => (
                  <button
                    type="button"
                    aria-expanded={
                      item.menu
                        ? canvas.menu()?.kind === item.menu &&
                          (canvas.menu() as { nodeId?: string }).nodeId === t().node.id
                        : undefined
                    }
                    aria-label={item.tip}
                    data-tip={item.tip}
                    onClick={(e) => item.run(e.currentTarget)}
                  >
                    {item.label}
                  </button>
                )}
              </For>
            </div>
          }
        >
          {(player) => (
            <FrameBar
              player={player()}
              style={{ left: `${t().left}px`, top: `${t().top}px` }}
              onCapture={(at, duration) => void capture(canvas, t().node.id, at, duration)}
            />
          )}
        </Show>
      )}
    </Show>
  )
}
