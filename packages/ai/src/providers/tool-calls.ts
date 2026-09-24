/**
 * 流里拼好的工具调用分片交成 `WireToolCall`。三种协议共用这一处。
 */

import type { ProviderKind } from '@qywork/core'
import { namelessToolCall } from '../errors.ts'
import type { WireToolCall } from '../types.ts'

/** 按 provider 给的序号收拢的一条调用：id、名字与参数 JSON 的拼接原文。 */
export interface ToolCallSlot {
  id: string
  name: string
  json: string
}

/**
 * 按序号排好交出。参数只接受 JSON 对象：空串按无参数处理；解析失败、`null`、数组与
 * 标量都把原文挂在 `argumentsError` 上，`arguments` 置为 `{}`，由 loop 拒绝执行并把
 * 失败结果回给模型。
 *
 * 不要把非对象的解析结果交下去：工具的动作解析在单次执行的错误处理之外读取参数字段，
 * `null` 会在那里抛出 TypeError，整轮 run 随之失败。也不要在解析失败时静默交 `{}`：
 * 那等于告诉模型参数已被接受。
 */
export function collectToolCalls(
  partial: ReadonlyMap<number, ToolCallSlot>,
  provider: ProviderKind,
  model: string,
): WireToolCall[] {
  return [...partial.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, slot]) => {
      if (!slot.name) throw namelessToolCall(provider, model)
      const args = parseArguments(slot.json)
      return {
        id: slot.id,
        name: slot.name,
        arguments: args ?? {},
        ...(args === null ? { argumentsError: slot.json } : {}),
      }
    })
}

/** 空串 = 无参数；返回 `null` 表示原文不是一个 JSON 对象。 */
function parseArguments(json: string): Record<string, unknown> | null {
  if (!json.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
