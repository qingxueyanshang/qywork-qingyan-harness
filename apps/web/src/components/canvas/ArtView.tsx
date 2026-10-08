/**
 * Art 节点的显示：未单独选中时显示封面（`Bitmap`），单独选中时运行实时页面，指针、滚轮与键盘交给页面。
 *
 * 实时页面按 viewport 声明的尺寸布局，再整体缩放到节点框：设计稿按桌面尺寸排版，而不是按缩小后的节点尺寸。
 * 页面脚本的第一条错误显示在节点上。截图与录制经 `register` 交出的句柄执行。
 */

import type { CanvasPixels } from '@qywork/core'
import { createResource, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { type ArtHandle, artSizeOfHtml, connectArt, dropStalePoster } from './art.ts'
import { Bitmap } from './Bitmap.tsx'

/** 实时页面的句柄与视口。 */
export interface ArtLive {
  handle: ArtHandle
  size: CanvasPixels
}

export function ArtView(props: {
  url: string
  /** 节点框的画布宽高与当前缩放，封面按显示尺寸解码。 */
  w: number
  h: number
  z: number
  live: boolean
  register: (live: ArtLive | null) => void
}) {
  // 每次进入实时状态重新读取：Agent 可能已改写该文件，封面缓存不影响实时页面。
  const [html] = createResource(
    () => (props.live ? props.url : null),
    async (url) => {
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`页面读取失败：${res.status}`)
      const html = await res.text()
      dropStalePoster(url, html)
      return html
    },
  )
  return (
    <Show
      when={props.live && html.state === 'ready' ? html() : null}
      fallback={
        <Bitmap
          kind="art"
          src={props.url}
          width={props.w * props.z * window.devicePixelRatio}
          height={props.h * props.z * window.devicePixelRatio}
        />
      }
      keyed
    >
      {(page) => {
        const size = artSizeOfHtml(page)
        const [error, setError] = createSignal<string | null>(null)
        let frame!: HTMLIFrameElement
        onMount(() => {
          const handle = connectArt(frame, page, {
            manual: false,
            onError: (m) => setError((e) => e ?? m),
          })
          props.register({ handle, size })
          onCleanup(() => {
            props.register(null)
            handle.dispose()
          })
        })
        return (
          <>
            <iframe
              ref={frame}
              class="canvas-art-frame"
              sandbox="allow-scripts"
              title="Art"
              width={size.w}
              height={size.h}
              style={{ transform: `scale(${props.w / size.w}, ${props.h / size.h})` }}
            />
            <Show when={error()}>
              {(m) => (
                <div class="canvas-media-notice failed" role="alert">
                  <strong>页面脚本出错</strong>
                  <span>{m()}</span>
                </div>
              )}
            </Show>
          </>
        )
      }}
    </Show>
  )
}
