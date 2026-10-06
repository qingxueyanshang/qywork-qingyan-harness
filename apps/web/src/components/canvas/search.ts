/** 按类别列出、按名称搜索工作区文件。左侧工具条与生成面板的素材选择共用。 */

import type { CanvasFileKind } from '@qywork/core'
import { createSignal } from 'solid-js'
import { client, explainApiError } from '../../lib/store/index.ts'

/** 停止输入超过此时长后才发送请求。 */
const SEARCH_DELAY_MS = 150
/** 最多列出的条数。 */
const MAX_HITS = 50

/**
 * `kinds` 交给服务端筛选（只返回这几类文件，查询为空时返回这几类的全部文件，受服务端的条数上限约束）；
 * `accepts` 在此基础上附加筛选，调用方所需范围比类别窄时提供。
 */
export function createFileSearch(
  kinds: () => readonly CanvasFileKind[],
  accepts: (path: string) => boolean = () => true,
) {
  const [hits, setHits] = createSignal<string[]>([])
  const [error, setError] = createSignal<string | null>(null)
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  /** 只采用最后一次输入的结果；输入为空时列出这几类的全部文件。 */
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
