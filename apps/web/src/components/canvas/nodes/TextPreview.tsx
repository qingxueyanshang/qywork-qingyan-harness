import { type CanvasExcerpt, excerptOf } from '@qywork/core'
import { createResource } from 'solid-js'
import { loaded } from '../../../lib/resource.ts'
import { client } from '../../../lib/store/index.ts'
import { useCanvas } from '../board/context.ts'

/**
 * 文本卡的正文：整篇卡为文件开头，摘录卡为摘录的文字（与运行时发送的相同），无法定位时为原因。
 * 摘录可能位于长文件的任意位置，因此读取全文定位；该文件修改后重新读取。
 * 来源写成字符串：画布重新读取后摘录是新对象，内容与修改时间都未变时不重新读取。
 */
export function TextPreview(p: { path: string; excerpt: CanvasExcerpt | undefined }) {
  const canvas = useCanvas()
  const [text] = createResource(
    () =>
      `${p.path}\u0000${p.excerpt ? JSON.stringify(p.excerpt) : ''}\u0000${canvas.view()?.revisions?.[p.path] ?? ''}`,
    async () => {
      const path = p.path
      if (!p.excerpt) {
        return client
          .api<{ content?: string }>(`/api/files/preview?path=${encodeURIComponent(path)}`)
          .then((r) => (r.content ?? '').slice(0, 600))
      }
      const whole = await canvas.fileText(path)
      if (whole === null) return ''
      const r = excerptOf(whole, p.excerpt)
      return r.ok ? r.text : r.error
    },
  )
  // 使用 `loaded()`，不要改为 `text()`：重新读取期间后者使外层 Suspense 显示占位，生成时每次写文件整块画布闪烁一次。
  return <div class="canvas-text">{loaded(text) ?? ''}</div>
}
