import { Show } from 'solid-js'
import type { TranscriptItem } from '../../../lib/store/index.ts'
import { RunStatusBar } from './RunStatusBar.tsx'

/** 执行完毕的轮次条目。耗时按落库的起止时刻计算，与实时条目的含义相同。 */
export function RunCard(props: { item: TranscriptItem }) {
  const run = () => props.item.run
  const elapsed = () => {
    const r = run()
    return r?.endedAt == null ? null : (r.endedAt - r.startedAt) / 1000
  }

  return (
    <Show when={run()}>
      {(r) => (
        <RunStatusBar
          usage={r().usage}
          stopReason={r().stopReason}
          elapsed={elapsed()}
          running={false}
          errorMessage={r().errorMessage}
        />
      )}
    </Show>
  )
}
