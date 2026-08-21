import { isInlineImage } from '@qywork/core'
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { attachmentBlobUrl } from '../lib/store/index.ts'
import { IconFile } from './Icons.tsx'

/**
 * 附件的那一格。
 *
 * ## 格子恒定存在
 *
 * 图片放缩略图、其余放一个通用文件图标。**只在图片上给格子的话**，两种 chip
 * 高度不同，混排就是锯齿，行高还会跟着内容跳（CLAUDE.md B9）。
 *
 * ## 不做「扩展名 → 图标」映射表
 *
 * 那张表永远不全，没登记的仍要一个通用兜底，结果是大多数文件显示同一个方块——
 * 等于没做，却多一张要维护的表。文件名里已经有扩展名，一张彩色图标不比那几个字
 * 多说任何事。区分靠的是「图片看得见内容、文件是统一图标」。
 *
 * ## 进视口才取
 *
 * 一条贴了二十张图的会话，挂载即取就是二十条并发的大请求。`IntersectionObserver`
 * 让它按滚动位置摊开。
 *
 * ## blob URL 必须撤销
 *
 * `createObjectURL` 造出来的引用不会被 GC 回收，卸载时不 `revoke` 的话那份解码后的
 * 位图一直占着内存直到整页刷新。**只撤销自己造的那一个**——`localUrl` 是调用方
 * 给的（粘贴时手里那个 `File`），它的生命周期归调用方。
 */
export function AttachmentThumb(props: {
  path: string
  name: string
  /** 粘贴时手里已经有 `File`，直接给它的 objectURL，省掉一次回读。 */
  localUrl?: string
  /** 格子边长，px。 */
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
