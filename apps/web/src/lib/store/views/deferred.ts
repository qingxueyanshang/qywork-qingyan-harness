/**
 * 历史页中标记 `deferred` 的工具结果（服务端只随页返回较小的字段）：展开条目时按 step 读取完整结果，
 * 替换会话流中该条目的 `outcome`。
 *
 * 同一条目同时只读取一次。读取失败时记录原因供展开内容显示，下一次展开时重试；失败不改动条目，
 * 已显示的标题与摘要保持不变。
 */

import type { Step } from '@qywork/core'
import { createSignal } from 'solid-js'
import { produce } from 'solid-js/store'
import { client } from '../client.ts'
import { report } from '../client-log.ts'
import { setState, state } from '../state.ts'

const [failures, setFailures] = createSignal<Readonly<Record<string, string>>>({})
const pending = new Set<string>()

/** 该条目最近一次读取完整结果失败的原因；没有失败时为 undefined。 */
export function deferredError(stepId: string): string | undefined {
  return failures()[stepId]
}

export async function loadDeferredOutcome(stepId: string): Promise<void> {
  if (pending.has(stepId)) return
  const cid = Object.keys(state.views).find((id) =>
    state.views[id]?.transcript.some((item) => item.id === stepId),
  )
  if (!cid) return
  pending.add(stepId)
  setFailures(({ [stepId]: _, ...rest }) => rest)
  try {
    const { step } = await client.api<{ step: Step }>(
      `/api/conversations/${encodeURIComponent(cid)}/steps/${encodeURIComponent(stepId)}`,
    )
    const outcome = step.payload?.kind === 'tool_result' ? step.payload.outcome : undefined
    if (!outcome) throw new Error('该记录没有工具结果')
    setState(
      produce((s) => {
        const item = s.views[cid]?.transcript.find((i) => i.id === stepId)
        if (item) item.outcome = outcome
      }),
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    setFailures((all) => ({ ...all, [stepId]: message }))
    report('warn', '读取完整工具结果失败', { message })
  } finally {
    pending.delete(stepId)
  }
}
