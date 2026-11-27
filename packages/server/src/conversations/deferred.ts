/**
 * 会话历史页中工具结果的瘦身：`outcome.data` 中较大的正文字段不随页返回，结果标记 `deferred`，
 * 界面展开该条目时再按 step 读取完整结果。
 *
 * 历史页随每次切换会话与项目经远程隧道传输，实测其中约四成字节是文件正文、命令输出、匹配列表与
 * 浏览器、桌面观察的元素表，而它们只在展开条目后才显示（界面的 `StepBody`），元素表从不显示。
 *
 * 约束：只推迟 `DEFERRABLE_KEYS` 中的字段，不按大小推迟任意字段。派发任务图与 workflow 卡片在折叠状态下
 * 读取 `data` 的其他字段（`workflowId`、`dispatched`、`output`），按大小推迟会使这些卡片在展开之前缺少内容；
 * 工具行标题读取 `outcome.subject`，不读取 `data`。新增展开后才显示的正文字段时加入本表。
 */

import type { ToolOutcomeWire } from '@qywork/core'

/** 单个字段序列化后超过该长度（字符）时推迟读取。 */
export const DEFERRED_FIELD_CHARS = 4096

/** 只在展开后显示或从不显示的字段。桌面动作的观察位于 `data.observation` 下，同样按本表判断。 */
const DEFERRABLE_KEYS = new Set([
  'content',
  'stdout',
  'stderr',
  'matches',
  'entries',
  'files',
  'elements',
  'view',
])

export function deferLargeData(outcome: ToolOutcomeWire): ToolOutcomeWire {
  const data = outcome.data
  if (!data) return outcome
  let deferred = false
  const trim = (obj: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      if (DEFERRABLE_KEYS.has(key) && JSON.stringify(value ?? null).length > DEFERRED_FIELD_CHARS) {
        deferred = true
      } else {
        out[key] = value
      }
    }
    return out
  }
  const trimmed = trim(data)
  const observation = data.observation
  if (observation && typeof observation === 'object' && !Array.isArray(observation)) {
    trimmed.observation = trim(observation as Record<string, unknown>)
  }
  return deferred ? { ...outcome, data: trimmed, deferred: true } : outcome
}
