import { type CanvasNode, canvasMediaOf } from '@qywork/core'
import { createMemo, Show } from 'solid-js'
import { useCanvas } from '../board/context.ts'
import { Media } from './Media.tsx'

/** 文件节点的内容区：文件缺失时为占位与移除按钮，否则为媒体或文本预览。 */
export function FileBody(p: { node: Extract<CanvasNode, { type: 'file' }>; selected: boolean }) {
  const canvas = useCanvas()
  const st = createMemo(() => canvas.view()?.states[p.node.id])
  return (
    <Show
      when={st()?.state !== 'missing'}
      fallback={
        <div class="canvas-missing">
          <span class="label">缺失</span>
          <button
            class="canvas-ghost"
            type="button"
            onClick={() => void canvas.apply([{ op: 'remove', id: p.node.id }])}
          >
            移除
          </button>
        </div>
      }
    >
      <Media
        nodeId={p.node.id}
        path={p.node.path}
        kind={canvasMediaOf(p.node)}
        w={p.node.w}
        h={p.node.h}
        controls={p.selected}
      />
    </Show>
  )
}
