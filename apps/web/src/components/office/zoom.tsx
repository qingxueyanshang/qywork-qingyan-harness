/**
 * Office 预览的缩放：比例信号、标题行中的缩放控件（`usePreviewTools`）与按键。表格、演示文稿、文档与 PDF 的页面视图
 * （`../preview/PdfPages.tsx`）共用。
 *
 * Ctrl+滚轮与双指捏合由视口自身处理（`createZoomScroll`），此处只注册按键。比例由视口的 `onChange` 经 `note` 传入。
 */

import { type Accessor, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { usePreviewTools } from '../preview/tools.ts'
import ZoomControl from '../preview/ZoomControl.tsx'
import { bindZoomInputs, ZOOM_STEP } from '../preview/zoom-input.ts'
import { MAX_ZOOM, MIN_ZOOM, type ViewPosition } from './viewport.ts'

interface Zoomable {
  zoomBy(factor: number): void
  reset(): void
}

/** 在组件函数体中调用：按键在挂载时注册、卸载时注销。`scroller` 在挂载后取值。 */
export function officeZoom(
  scroller: () => HTMLElement,
  target: () => Zoomable | null,
  ready: Accessor<boolean>,
) {
  const [zoom, setZoom] = createSignal(0)
  onMount(() => {
    const unbind = bindZoomInputs(
      scroller(),
      {
        ready,
        zoomBy: (factor) => target()?.zoomBy(factor),
        reset: () => target()?.reset(),
      },
      { wheel: false },
    )
    onCleanup(unbind)
  })
  usePreviewTools(() => (
    <Show when={ready()}>
      <ZoomControl
        ratio={zoom()}
        min={MIN_ZOOM}
        max={MAX_ZOOM}
        onStep={(direction) => target()?.zoomBy(direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)}
      />
    </Show>
  ))
  return { note: (at: ViewPosition) => setZoom(at.zoom) }
}
