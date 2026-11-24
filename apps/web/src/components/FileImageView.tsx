import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from 'solid-js'
import { suspendUntil } from '../lib/resource.ts'
import { usePreviewTools } from './preview/tools.ts'
import { readView, writeView } from './preview/view-state.ts'
import ZoomControl from './preview/ZoomControl.tsx'
import { bindZoomInputs, ZOOM_STEP } from './preview/zoom-input.ts'

type Mode = 'fit' | 'width' | number

/** 缩放比例的范围，按钮、滚轮与快捷键共用。 */
const MIN_SCALE = 0.01
const MAX_SCALE = 8

/** 图片的缩放模式与滚动位置，按文件路径记录（`view-state.ts`）。 */
interface ViewRecord {
  mode: Mode
  left: number
  top: number
}

/**
 * 图片的缩放只依赖原始尺寸与预览区尺寸，文件树和路径栏不参与计算。缩放控件经 `usePreviewTools` 放在文件页的标题行中。
 * `src` 带有修改时间作为版本，文件改写后变化；视图状态按 `path` 记录，改写后保留缩放与位置。
 */
export default function FileImageView(props: { src: string; path: string }) {
  let viewport!: HTMLDivElement
  let image!: HTMLImageElement
  const [size, setSize] = createSignal({ width: 0, height: 0 })
  const [space, setSpace] = createSignal({ width: 0, height: 0 })
  const [mode, setMode] = createSignal<Mode>('fit')
  /** 待恢复的滚动位置，在图片尺寸取得后应用一次。 */
  let restoring: ViewRecord | null = null
  const save = () =>
    writeView(props.path, {
      mode: mode(),
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    } satisfies ViewRecord)
  const [failed, setFailed] = createSignal(false)
  /** 图片与预览区的尺寸都已取得：此前缩放比例无从计算，缩放控件与快捷键都不响应。 */
  const ready = () => size().width > 0 && space().width > 0 && !failed()
  /*
   * 首次加载与解码声明为首次读取：切换文件时文件页保留上一个文件，到图片可以显示。
   * 加载与解码在页面文档中另建的图片上进行，完成后写入尺寸：下方的 `<img>` 由 JSX 模板克隆，属于模板的文档，
   * 所在区域挂起期间不加载，区域显示后才开始加载。另建的图片完成后，`<img>` 显示时从缓存取得。
   */
  const first = new Image()
  first.src = props.src
  first.decode().then(
    () => {
      if (size().width === 0 && first.naturalWidth > 0)
        setSize({ width: first.naturalWidth, height: first.naturalHeight })
    },
    () => undefined,
  )
  suspendUntil(() => size().width > 0 || failed())
  const source = createMemo(() => props.src)
  const scale = createMemo(() => {
    const current = mode()
    if (typeof current === 'number') return current
    const { width, height } = size()
    if (!width || !height) return 0
    const available = space()
    return Math.max(
      0,
      current === 'width'
        ? available.width / width
        : Math.min(1, available.width / width, available.height / height),
    )
  })

  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSpace({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(viewport)
    const unbind = bindZoomInputs(
      viewport,
      {
        ready,
        zoomBy: (factor, at) =>
          at ? zoomTo(scale() * factor, at.clientX, at.clientY) : zoom(factor),
        reset: () => selectMode('fit'),
      },
      { wheel: true },
    )
    onCleanup(() => {
      observer.disconnect()
      unbind()
    })
  })

  let zoomFrame = 0
  /** 本帧待调整滚动位置的锚点：图像中的相对位置，以及它缩放后应位于的视口坐标。 */
  let anchor: { x: number; y: number; clientX: number; clientY: number } | null = null
  onCleanup(() => cancelAnimationFrame(zoomFrame))
  const resetScroll = () => {
    cancelAnimationFrame(zoomFrame)
    anchor = null
    viewport.scrollLeft = 0
    viewport.scrollTop = 0
  }
  createEffect(
    on(source, () => {
      restoring = readView<ViewRecord>(props.path) ?? null
      setSize({ width: 0, height: 0 })
      setMode(restoring?.mode ?? 'fit')
      setFailed(false)
      resetScroll()
    }),
  )
  createEffect(on(mode, save, { defer: true }))

  const selectMode = (next: 'fit' | 'width' | number) => {
    setMode(next)
    resetScroll()
  }
  /** 缩放到 `next`，使视口坐标 (`clientX`, `clientY`) 处的图像位置缩放后仍在该处。 */
  const zoomTo = (next: number, clientX: number, clientY: number) => {
    // 同一帧内的多次缩放（连续滚轮）沿用第一次的锚点：此时滚动位置尚未调整，按当前布局计算的锚点已偏离。
    if (!anchor) {
      const before = image.getBoundingClientRect()
      anchor = {
        x: (clientX - before.left) / before.width,
        y: (clientY - before.top) / before.height,
        clientX,
        clientY,
      }
    }
    setMode(Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)))
    cancelAnimationFrame(zoomFrame)
    zoomFrame = requestAnimationFrame(() => {
      const at = anchor
      anchor = null
      if (!at) return
      const after = image.getBoundingClientRect()
      viewport.scrollLeft += after.left + at.x * after.width - at.clientX
      viewport.scrollTop += after.top + at.y * after.height - at.clientY
    })
  }
  /** 以视口中心为锚点按倍数缩放。 */
  const zoom = (factor: number) => {
    const bounds = viewport.getBoundingClientRect()
    zoomTo(
      scale() * factor,
      bounds.left + viewport.clientLeft + viewport.clientWidth / 2,
      bounds.top + viewport.clientTop + viewport.clientHeight / 2,
    )
  }

  usePreviewTools(() => (
    <>
      <button
        class="preview-tools-fit"
        type="button"
        disabled={!ready()}
        aria-pressed={mode() === 'fit'}
        onClick={() => selectMode('fit')}
      >
        适应窗口
      </button>
      <button
        class="preview-tools-extra"
        type="button"
        disabled={!ready()}
        aria-pressed={mode() === 'width'}
        onClick={() => selectMode('width')}
      >
        适应宽度
      </button>
      <button
        class="preview-tools-extra"
        type="button"
        disabled={!ready()}
        aria-pressed={mode() === 1}
        onClick={() => selectMode(1)}
      >
        100%
      </button>
      <ZoomControl
        ratio={ready() ? scale() : 0}
        min={MIN_SCALE}
        max={MAX_SCALE}
        onStep={(direction) => zoom(direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)}
      />
    </>
  ))

  return (
    <div class="image-preview">
      <div class="image-preview-viewport" ref={viewport} data-mode={mode()} onScroll={save}>
        <Show when={failed()}>
          <div class="preview-note">无法加载图片</div>
        </Show>
        <div class="image-preview-stage">
          <img
            ref={image}
            class="preview-media"
            src={source()}
            alt={props.path}
            draggable={false}
            // 绘制前完成解码：异步解码时，图片显示的第一帧中该区域为空白。
            decoding="sync"
            style={{
              width: `${size().width * scale()}px`,
              height: `${size().height * scale()}px`,
              visibility: scale() ? 'visible' : 'hidden',
            }}
            onLoad={(event) => {
              setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
              const at = restoring
              restoring = null
              if (!at) return
              // 尺寸写入后的下一帧图片才按缩放占据空间，此前设置的滚动位置会被限制为 0。
              zoomFrame = requestAnimationFrame(() => {
                viewport.scrollLeft = at.left
                viewport.scrollTop = at.top
              })
            }}
            onError={() => setFailed(true)}
          />
        </div>
      </div>
    </div>
  )
}
