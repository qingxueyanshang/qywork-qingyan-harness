/** 按类别列出、按名搜索工作区文件。左侧工具条与生成面板的素材选择共用。 */

import type { CanvasFileKind } from '@qywork/core'
import { createSignal } from 'solid-js'
import { client, explainApiError } from '../../lib/store/index.ts'

/** 停止输入这么久之后才发请求。 */
const SEARCH_DELAY_MS = 150
/** 最多列这么多条。 */
const MAX_HITS = 50

/**
 * `kinds` 交给服务端筛（只回这几类文件，查询为空时回这几类的全部，受服务端的条数上限约束）；
 * `accepts` 在此之上再筛一道，调用方要的范围比类别窄时给。
 */
export function createFileSearch(
  kinds: () => readonly CanvasFileKind[],
  accepts: (path: string) => boolean = () => true,
) {
  const [hits, setHits] = createSignal<string[]>([])
  const [error, setError] = createSignal<string | null>(null)
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  /** 只采纳最后一次输入的结果；输入为空时列出这几类的全部。 */
  const search = (text: string) => {
    clearTimeout(timer)
    const mine = ++seq
    timer = setTimeout(async () => {
      try {
        const r = await client.api<{ matches: { path: string; kind: 'file' | 'dir' }[] }>(
          `/api/files/find?${new URLSearchParams({ q: text, kinds: kinds().join(',') })}`,
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
