import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from 'solid-js'

/** 图片的缩放只依赖原始尺寸与预览区尺寸，文件树和路径栏不参与计算。 */
export default function FileImageView(props: { src: string; alt: string }) {
  let viewport!: HTMLDivElement
  let image!: HTMLImageElement
  const [size, setSize] = createSignal({ width: 0, height: 0 })
  const [space, setSpace] = createSignal({ width: 0, height: 0 })
  const [mode, setMode] = createSignal<'fit' | 'width' | number>('fit')
  const [failed, setFailed] = createSignal(false)
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
    onCleanup(() => observer.disconnect())
  })

  let zoomFrame = 0
  onCleanup(() => cancelAnimationFrame(zoomFrame))
  const resetScroll = () => {
    cancelAnimationFrame(zoomFrame)
    viewport.scrollLeft = 0
    viewport.scrollTop = 0
  }
  createEffect(
    on(source, () => {
      setSize({ width: 0, height: 0 })
      setMode('fit')
      setFailed(false)
      resetScroll()
    }),
  )

  const selectMode = (next: 'fit' | 'width' | number) => {
    setMode(next)
    resetScroll()
  }
  const zoom = (factor: number) => {
    const bounds = viewport.getBoundingClientRect()
    const before = image.getBoundingClientRect()
    const centerX = bounds.left + viewport.clientLeft + viewport.clientWidth / 2
    const centerY = bounds.top + viewport.clientTop + viewport.clientHeight / 2
    const x = (centerX - before.left) / before.width
    const y = (centerY - before.top) / before.height
    setMode(Math.min(8, Math.max(0.01, scale() * factor)))
    cancelAnimationFrame(zoomFrame)
    // 缩放后保留视口中心对应的图像位置，长图中段不会跳回开头。
    zoomFrame = requestAnimationFrame(() => {
      const after = image.getBoundingClientRect()
      viewport.scrollLeft += after.left + x * after.width - centerX
      viewport.scrollTop += after.top + y * after.height - centerY
    })
  }

  return (
    <div class="image-preview">
      <fieldset
        class="image-preview-tools"
        aria-label="图片缩放"
        disabled={!size().width || !space().width || failed()}
      >
        <button type="button" aria-pressed={mode() === 'fit'} onClick={() => selectMode('fit')}>
          适应窗口
        </button>
        <button type="button" aria-pressed={mode() === 'width'} onClick={() => selectMode('width')}>
          适应宽度
        </button>
        <button type="button" aria-pressed={mode() === 1} onClick={() => selectMode(1)}>
          100%
        </button>
        <span class="image-preview-zoom">
          <button
            type="button"
            aria-label="缩小图片"
            disabled={scale() <= 0.01}
            onClick={() => zoom(1 / 1.25)}
          >
            −
          </button>
          <output aria-label="缩放比例">{scale() ? `${Math.round(scale() * 100)}%` : '—'}</output>
          <button
            type="button"
            aria-label="放大图片"
            disabled={!scale() || scale() >= 8}
            onClick={() => zoom(1.25)}
          >
            +
          </button>
        </span>
      </fieldset>
      <div class="image-preview-viewport" ref={viewport} data-mode={mode()}>
        <Show when={failed()}>
          <div class="preview-note">无法加载图片</div>
        </Show>
        <div class="image-preview-stage">
          <img
            ref={image}
            class="preview-media"
            src={source()}
            alt={props.alt}
            draggable={false}
            style={{
              width: `${size().width * scale()}px`,
              height: `${size().height * scale()}px`,
              visibility: scale() ? 'visible' : 'hidden',
            }}
            onLoad={(event) =>
              setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setFailed(true)}
          />
        </div>
      </div>
    </div>
  )
}
