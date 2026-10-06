import { isInlineImage } from '@qywork/core'
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { attachmentBlobUrl } from '../lib/store/index.ts'
import { IconFile } from './Icons.tsx'

/**
 * 附件的缩略图区域。
 *
 * **缩略图区域始终存在。** 图片显示缩略图，其余文件显示通用文件图标。若只为图片提供该区域，两种 chip
 * 高度不同，混排时边缘参差不齐，行高也会随内容变化（CLAUDE.md B9）。
 *
 * **不做「扩展名 → 图标」映射表。** 该表无法覆盖全部类型，未登记的类型仍需通用图标作为后备，结果是多数文件显示
 * 同一个图标，没有实际效果，却多出一张需要维护的表。文件名中已有扩展名，彩色图标不比扩展名提供更多
 * 信息。区分方式是「图片显示内容、其他文件使用统一图标」。
 *
 * **进入视口后才获取。** 一条包含二十张图片的会话，若挂载即获取，会产生二十个并发的大请求。`IntersectionObserver`
 * 使请求按滚动位置分散发出。
 *
 * **blob URL 必须撤销。** `createObjectURL` 创建的引用不会被 GC 回收，卸载时若不 `revoke`，
 * 解码后的位图会一直占用内存直到整页刷新。只撤销本组件创建的 URL：`localUrl` 由调用方提供（粘贴
 * 时已持有的 `File`），其生命周期由调用方管理。
 */
export function AttachmentThumb(props: {
  path: string
  name: string
  /** 粘贴时已持有 `File`，直接使用其 objectURL，省去一次读取。 */
  localUrl?: string
  /** 缩略图区域边长，px。 */
  box: number
}) {
  const [url, setUrl] = createSignal<string | null>(null)
  let own: string | null = null
  let host!: HTMLSpanElement

  const isImage = () => isInlineImage(props.path)

  onMount(() => {
    if (!isImage()) return
    if (props.localUrl) {
      setUrl(props.localUrl)
      return
    }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      io.disconnect()
      void attachmentBlobUrl(props.path).then((u) => {
        if (!u) return
        own = u
        setUrl(u)
      })
    })
    io.observe(host)
    onCleanup(() => io.disconnect())
  })

  onCleanup(() => {
    if (own) URL.revokeObjectURL(own)
  })

  return (
    <span
      ref={host}
      class="attach-thumb"
      style={{ width: `${props.box}px`, height: `${props.box}px` }}
    >
      <Show when={url()} fallback={<IconFile size={Math.round(props.box * 0.6)} />}>
        {(u) => <img src={u()} alt={props.name} />}
      </Show>
    </span>
  )
}
