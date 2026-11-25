/**
 * 画布页：`*.canvas.json` 的查看与编辑。
 *
 * 画布文件与节点状态以服务端为准（`readCanvas`）：文件快照序号或画布事件序号变化时重新读取，
 * 每次修改提交一批操作，响应体即应用后的画布。本地只额外保存两项：视口（不保存到文件）与拖动中的位置。
 * 拖动中的节点在松开指针提交之前始终使用本地位置，其间的重新读取不改变它的位置。
 *
 * 渲染使用 DOM + CSS transform 实现平移缩放，用一层 SVG 绘制连线：节点中有播放器，面板中有输入框。
 *
 * 本文件只做装配：创建控制器（`board/controller.ts`）、注册监听、组装画布区。节点在 `nodes/`，
 * 连线层与浮层在 `layers/`，键盘、指针、右键菜单、时间线与上传在 `input/`。
 */

import { GENERATE_OUTPUTS } from '@qywork/core'
import { For, onCleanup, onMount, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { attachLongPress } from '../../lib/long-press.ts'
import { isDesktopShell, registerDropSink } from '../../lib/store/index.ts'
import { IconCanvas, IconRedo, IconScissors, IconUndo } from '../Icons.tsx'
import { CanvasContext } from './board/context.ts'
import { createCanvasController } from './board/controller.ts'
import { FlowLayer } from './Flow.tsx'
import { exportOnRequest } from './input/clips.ts'
import { addGenerate, addTimeline } from './input/create.ts'
import { cutLink, onKeyDown, onKeyUp, onPaste, releaseSpace } from './input/keyboard.ts'
import {
  onDblClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onWheel,
  pressContext,
} from './input/pointer.ts'
import { dropSink, onDragOver, onDrop, pickFile, uploadFiles } from './input/upload.ts'
import { CanvasMenus } from './layers/CanvasMenus.tsx'
import { EdgeLayer } from './layers/EdgeLayer.tsx'
import { FullscreenTimeline } from './layers/FullscreenTimeline.tsx'
import { PanelHost } from './layers/PanelHost.tsx'
import { SelectionTools } from './layers/SelectionTools.tsx'
import { Node } from './nodes/Node.tsx'
import { Rail } from './Rail.tsx'

export default function CanvasPanel(props: { path: string; active: boolean }) {
  const canvas = createCanvasController(props)
  onMount(() => {
    const ro = new ResizeObserver(() =>
      canvas.setSize({ w: canvas.stage.clientWidth, h: canvas.stage.clientHeight }),
    )
    ro.observe(canvas.stage)
    // 滚轮监听必须设为 `passive: false` 才能阻止页面滚动。
    const wheel = (e: WheelEvent) => onWheel(canvas, e)
    canvas.stage.addEventListener('wheel', wheel, { passive: false })
    // 桌面外壳中的系统拖放由外壳截获并提供绝对路径：画布区注册为接收方。
    if (isDesktopShell()) {
      const unregister = registerDropSink(dropSink(canvas))
      onCleanup(unregister)
    }
    const keydown = (e: KeyboardEvent) => onKeyDown(canvas, e)
    const keyup = (e: KeyboardEvent) => onKeyUp(canvas, e)
    const blur = () => releaseSpace(canvas)
    const paste = (e: ClipboardEvent) => onPaste(canvas, e)
    window.addEventListener('keydown', keydown)
    window.addEventListener('keyup', keyup)
    window.addEventListener('blur', blur)
    window.addEventListener('paste', paste)
    onCleanup(() => {
      ro.disconnect()
      canvas.stage.removeEventListener('wheel', wheel)
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('keyup', keyup)
      window.removeEventListener('blur', blur)
      window.removeEventListener('paste', paste)
    })
  })
  exportOnRequest(canvas)
  return (
    <CanvasContext.Provider value={canvas}>
      <div
        class="canvas-stage"
        ref={(el) => {
          canvas.stage = el
          attachLongPress(el, (x, y, target) => pressContext(canvas, x, y, target))
        }}
        role="application"
        aria-label="画布"
        style={{ '--z': String(canvas.z()) }}
        onPointerDown={(e) => onPointerDown(canvas, e)}
        onPointerMove={(e) => onPointerMove(canvas, e)}
        onPointerUp={(e) => onPointerUp(canvas, e)}
        onPointerCancel={(e) => onPointerUp(canvas, e)}
        onPointerLeave={() => {
          if (!canvas.drag) canvas.pointerAt = null
        }}
        onDragOver={onDragOver}
        onDrop={(e) => onDrop(canvas, e)}
        onDblClick={() => onDblClick(canvas)}
        // 画布中禁用浏览器自带的拖拽：选中的文字或图片被拖起后指针事件被接管，节点无法拖动，光标变为禁止符号。
        onDragStart={(e) => e.preventDefault()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          class="canvas-grid"
          style={{
            width: `calc(100% + ${canvas.grid()}px)`,
            height: `calc(100% + ${canvas.grid()}px)`,
            'background-size': `${canvas.grid()}px ${canvas.grid()}px`,
            transform: `translate(${canvas.gridShift(canvas.px())}px, ${canvas.gridShift(canvas.py())}px)`,
          }}
        />
        <Show
          when={canvas.view() && !canvas.broken()}
          fallback={<div class="canvas-note">{canvas.broken() ?? ''}</div>}
        >
          <EdgeLayer edges={canvas.edgePaths().filter((e) => !e.moving)} />
          <EdgeLayer edges={canvas.edgePaths().filter((e) => e.moving)}>
            <Show when={canvas.linking()}>
              {(l) => {
                const d = () => {
                  const a = canvas.byId(l().from)
                  if (!a) return ''
                  const p = canvas.pos(a)
                  const x1 = p.x + a.w
                  const y1 = p.y + a.h / 2
                  const dx = Math.max(40, (l().x - x1) / 2)
                  return `M${x1} ${y1} C${x1 + dx} ${y1} ${l().x - dx} ${l().y} ${l().x} ${l().y}`
                }
                return <path class="canvas-edge-draft" d={d()} />
              }}
            </Show>
            <For each={canvas.guides()}>
              {(g) => <line class="canvas-guide" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} />}
            </For>
          </EdgeLayer>
          <FlowLayer
            edges={canvas.edgePaths().filter((e) => e.live)}
            px={canvas.px()}
            py={canvas.py()}
            z={canvas.z()}
            onReady={canvas.setFlowGl}
          />
          <div
            class="canvas-world"
            style={{
              transform: `translate(${canvas.px()}px, ${canvas.py()}px) scale(${canvas.z()})`,
            }}
          >
            <For each={canvas.nodes().map((n) => n.id)}>{(id) => <Node id={id} />}</For>
          </div>

          <For each={canvas.edgePaths().filter((e) => e.id === canvas.edgeSelected())}>
            {(e) => (
              <button
                class="canvas-edge-cut"
                type="button"
                aria-label="断开"
                data-edge={e.id}
                style={{
                  left: `${canvas.px() + e.mx * canvas.z()}px`,
                  top: `${canvas.py() + e.my * canvas.z()}px`,
                }}
                onClick={() =>
                  void cutLink(canvas, e.id).then((ok) => {
                    if (!ok) return
                    if (canvas.edgeSelected() === e.id) canvas.setEdgeSelected(null)
                  })
                }
              >
                <IconScissors size={14} />
              </button>
            )}
          </For>

          <SelectionTools />

          <PanelHost />
        </Show>

        <FullscreenTimeline />

        <Show when={canvas.marquee()}>
          {(m) => (
            <div
              class="canvas-marquee"
              style={{
                left: `${m().x}px`,
                top: `${m().y}px`,
                width: `${m().w}px`,
                height: `${m().h}px`,
              }}
            />
          )}
        </Show>

        <Show when={canvas.fault()}>{(f) => <div class="canvas-fault">{f()}</div>}</Show>

        <Rail
          outputs={[...GENERATE_OUTPUTS]}
          disabled={!canvas.view() || !!canvas.broken()}
          onGenerate={(o) => void addGenerate(canvas, o)}
          onTimeline={() => void addTimeline(canvas)}
          onPick={(path, first) => pickFile(canvas, path, first)}
          onUpload={(files) => void uploadFiles(canvas, files)}
        />

        <span class="canvas-drop-anchor" ref={canvas.dropAnchor} />
        <input
          ref={canvas.contextUpload}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])]
            e.currentTarget.value = ''
            if (files.length) void uploadFiles(canvas, files, canvas.uploadAt ?? canvas.center())
          }}
        />

        {/* 撤销与重做：键盘之外的入口，触屏上只能经此操作。 */}
        <div class="canvas-dock">
          <button class="zoom" type="button" onClick={() => canvas.fit(true)}>
            {Math.round(canvas.z() * 100)}%
          </button>
          <button
            type="button"
            aria-label="撤销"
            data-tip="撤销"
            disabled={canvas.depth().undo === 0}
            onClick={() => void canvas.travel(true)}
          >
            <IconUndo size={14} />
          </button>
          <button
            type="button"
            aria-label="重做"
            data-tip="重做"
            disabled={canvas.depth().redo === 0}
            onClick={() => void canvas.travel(false)}
          >
            <IconRedo size={14} />
          </button>
        </div>

        {/* 菜单挂载到文档根节点：画布区自成层叠上下文，菜单留在其中会被全屏时间线（z-index 55）遮挡。
          可见性按本页是否处于前台判定：挂载在根节点后，菜单不再随本页一同隐藏。 */}
        <Portal>
          <CanvasMenus />
        </Portal>
        <Show when={!canvas.view() && !canvas.broken()}>
          <div class="canvas-note">
            <IconCanvas size={20} />
          </div>
        </Show>
      </div>
    </CanvasContext.Provider>
  )
}
