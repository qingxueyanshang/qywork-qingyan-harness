import { For, Show } from 'solid-js'
import type { TranscriptItem } from '../../../lib/store/index.ts'

/**
 * 上下文压缩事件。
 *
 * 压缩不能静默发生：用户需要能据此判断模型为何不再记得之前的内容。
 * 失败必须醒目：压缩失败意味着上下文仍然已满，下一轮很可能直接报错。
 */
export function CompactionCard(props: { item: TranscriptItem }) {
  const c = () => props.item.compaction
  const label = () => {
    const phase = c()?.phase
    if (phase === 'started') return '正在压缩上下文'
    if (c()?.reasonCode === 'aborted') return '压缩已停止'
    if (phase === 'skipped') return compactionSkipLabel(c()?.reasonCode)
    if (phase === 'failed') return compactionFailureLabel(c()?.reasonCode)
    // 必须区分三种结果：只收纳（未调用模型）、压缩完成、已收纳但摘要未完成。
    // 都显示为「已压缩」时，未调用模型的收纳与完整压缩在界面上无法区分。
    if (c()?.summarized === false) {
      return c()?.reasonCode ? '上下文已收纳，摘要未完成' : '上下文已收纳，未调用模型'
    }
    const n = c()?.compactedMessages
    return n ? `上下文已压缩，折叠 ${n} 轮` : '上下文已压缩'
  }
  return (
    <div
      class="compaction"
      classList={{ failed: c()?.phase === 'failed' && c()?.reasonCode !== 'aborted' }}
    >
      <span>{label()}</span>
      <Show when={c()?.phase === 'started'}>
        <div class="compaction-progress" role="progressbar" aria-label="正在压缩上下文">
          <For each={['preparing', 'summarizing', 'saving']}>
            {(stage, index) => (
              <span
                classList={{
                  complete:
                    index() < (c()?.stage === 'saving' ? 2 : c()?.stage === 'summarizing' ? 1 : 0),
                  active: stage === (c()?.stage ?? 'preparing'),
                }}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

/** 没有可压缩的内容。这不是失败，因此不以红色显示，措辞也不含「失败」。 */
function compactionSkipLabel(code: string | undefined): string {
  const map: Record<string, string> = { nothing_to_fold: '无可压缩内容' }
  return (code && map[code]) || '无可压缩内容'
}

/**
 * 压缩失败的文字。未知的原因码不显示：`reasonCode` 是供日志使用的英文标识，
 * 在括号中显示 `empty_summary` 不向用户提供有效信息。
 */
function compactionFailureLabel(code: string | undefined): string {
  const map: Record<string, string> = {
    summary_empty: '压缩失败：摘要为空',
    summary_error: '压缩失败：摘要调用出错',
    no_headroom: '压缩失败：没有可用空间',
    not_smaller: '压缩失败：摘要未比原内容更短',
    over_budget: '压缩失败：摘要过长',
  }
  return (code && map[code]) || '压缩失败'
}
