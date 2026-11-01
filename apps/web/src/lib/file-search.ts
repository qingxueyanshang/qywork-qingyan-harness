/** 按类别列出、按名称搜索工作区文件。画布的素材选择与看板的文件选择共用。 */

import type { CanvasFileKind } from '@qywork/core'
import { createSignal } from 'solid-js'
import { client, explainApiError } from './store/index.ts'

/** Office 文档的格式，与服务端预览分类 `classify` 的 `office` 取值一致。 */
export type OfficeFormat = 'xlsx' | 'pptx' | 'docx'

/**
 * 交给服务端的筛选：`kinds` 按画布文件类别判定，`office` 按预览分类判定。
 * 只返回这类文件，查询为空时返回这类的全部文件，受服务端的条数上限约束。
 */
export type FileFilter =
  | { readonly kinds: readonly CanvasFileKind[] }
  | { readonly office: OfficeFormat }

/** 停止输入超过此时长后才发送请求。 */
const SEARCH_DELAY_MS = 150
/** 最多列出的条数。 */
const MAX_HITS = 50

/** `accepts` 在服务端筛选的基础上附加筛选，调用方所需范围比类别窄时提供。 */
export function createFileSearch(
  filter: () => FileFilter,
  accepts: (path: string) => boolean = () => true,
) {
  const [hits, setHits] = createSignal<string[]>([])
  const [error, setError] = createSignal<string | null>(null)
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  /** 只采用最后一次输入的结果；输入为空时列出这类的全部文件。 */
  const search = (text: string) => {
    clearTimeout(timer)
    const mine = ++seq
    timer = setTimeout(async () => {
      const f = filter()
      const params = new URLSearchParams(
        'kinds' in f ? { q: text, kinds: f.kinds.join(',') } : { q: text, office: f.office },
      )
      try {
        const r = await client.api<{ matches: { path: string; kind: 'file' | 'dir' }[] }>(
          `/api/files/find?${params}`,
        )
        if (mine !== seq) return
        setHits(
          r.matches
            .filter((m) => m.kind === 'file' && accepts(m.path))
            .map((m) => m.path)
            .slice(0, MAX_HITS),
        )
        setError(null)
      } catch (e) {
        if (mine === seq) setError(explainApiError(e, '搜索失败'))
      }
    }, SEARCH_DELAY_MS)
  }

  return { hits, error, search }
}
