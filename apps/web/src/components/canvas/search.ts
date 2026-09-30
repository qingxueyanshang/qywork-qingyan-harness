/** 按名搜索工作区文件，只留能放上画布的那些。左侧工具条与生成面板的素材选择共用。 */

import { createSignal } from 'solid-js'
import { client, explainApiError } from '../../lib/store/index.ts'

/** 停止输入这么久之后才发请求。 */
const SEARCH_DELAY_MS = 150
/** 最多列这么多条。 */
const MAX_HITS = 50

export function createFileSearch(accepts: (path: string) => boolean) {
  const [hits, setHits] = createSignal<string[]>([])
  const [error, setError] = createSignal<string | null>(null)
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  /** 只采纳最后一次输入的结果；清空输入即清空结果。 */
  const search = (text: string) => {
    clearTimeout(timer)
    const mine = ++seq
    timer = setTimeout(async () => {
      if (!text.trim()) {
        setHits([])
        setError(null)
        return
      }
      try {
        const r = await client.api<{ matches: { path: string; kind: 'file' | 'dir' }[] }>(
          `/api/files/find?q=${encodeURIComponent(text)}`,
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
