import { For, Index, type JSX } from 'solid-js'
import { useCanvas } from '../board/context.ts'
import type { CanvasController } from '../board/controller.ts'
import { FLOW_STOPS } from '../Flow.tsx'

/**
 * 一层连线，单独成为合成层。拖动节点时连到被拖节点的连线放在上层，其余连线留在下层，拖动期间下层不发生修改。
 * 不要合并为一层：每次移动时被拖节点的连线经过的图块都要重新光栅化，图块中的其他连线（包括生成中的虚线）
 * 随之重画，开销随连线数与刷新率增长。
 */
export function EdgeLayer(p: {
  edges: ReturnType<CanvasController['edgePaths']>
  children?: JSX.Element
}) {
  const canvas = useCanvas()
  return (
    <svg
      class="canvas-edges"
      aria-hidden="true"
      width="1"
      height="1"
      style={{ transform: `translate(${canvas.px()}px, ${canvas.py()}px) scale(${canvas.z()})` }}
    >
      <defs>
        <Index each={p.edges.filter((e) => (e.live ? !canvas.flowGl() : e.hot))}>
          {(e) => (
            <linearGradient
              id={`canvas-flow-${e().id}`}
              gradientUnits="userSpaceOnUse"
              x1={e().x1}
              y1={e().y1}
              x2={e().x2}
              y2={e().y2}
            >
              <For each={FLOW_STOPS}>
                {([offset, token]) => (
                  <stop offset={offset} style={{ 'stop-color': `var(${token})` }} />
                )}
              </For>
            </linearGradient>
          )}
        </Index>
      </defs>
      <Index each={p.edges}>
        {(e) => (
          <>
            <path
              d={e().d}
              classList={{
                live: e().live,
                hot: !e().live && e().hot,
                selected: canvas.edgeSelected() === e().id,
              }}
              // 渐变写在内联样式中：写成 `stroke` 属性会被 `.canvas-edges path` 的描边色覆盖。
              // 生成中的连线由流动虚线层（`FlowLayer`）绘制，这里不描边；生成期间连线层不随推进修改。
              // 无法使用 WebGL 时显示静止的渐变虚线。
              style={
                e().live
                  ? canvas.flowGl()
                    ? { stroke: 'none' }
                    : { stroke: `url("#canvas-flow-${e().id}")` }
                  : e().hot
                    ? { stroke: `url("#canvas-flow-${e().id}")` }
                    : {}
              }
            />
            <path class="canvas-edge-hit" data-edge={e().id} d={e().d} />
          </>
        )}
      </Index>
      {p.children}
    </svg>
  )
}
