/**
 * 将流中拼接完成的工具调用分片转换为 `WireToolCall`。三种协议共用此实现。
 */

import type { ProviderKind } from '@qywork/core'
import { namelessToolCall } from '../errors.ts'
import type { WireToolCall } from '../types.ts'

/** 按 provider 给出的序号汇总的一条调用：id、名称与参数 JSON 的拼接原文。 */
export interface ToolCallSlot {
  id: string
  name: string
  json: string
}

/**
 * 按序号排序后返回。参数只接受 JSON 对象：空串按无参数处理；解析失败、`null`、数组与
 * 标量均将原文记录在 `argumentsError` 上，`arguments` 置为 `{}`，由 loop 拒绝执行并将
 * 失败结果返回给模型。
 *
 * 不要向下传递非对象的解析结果：工具的动作解析在单次执行的错误处理之外读取参数字段，
 * `null` 会在该处抛出 TypeError，整轮 run 随之失败。也不要在解析失败时静默传递 `{}`：
 * 这等于告知模型参数已被接受。
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

/**
 * 追踪参数原文的顶层 JSON 值是否已闭合。逐段输入，总耗时与原文长度成正比，不在每段到达时重新解析全文。
 *
 * 用途：部分第三方接口把同一工具的并行调用都标为同一序号，只在第一段给出 id 与名称，之后每次调用
 * 各发一个完整的参数对象。顶层值闭合之后，同一序号再到达的参数不可能是该调用的延续，只能是同名工具的
 * 下一次调用；按序号直接拼接得到 `{…}{…}`，整批调用都被判为参数不是 JSON 对象而拒绝执行。
 */
export class ArgumentsScanner {
  private depth = 0
  private inString = false
  private escaped = false
  private opened = false
  /** 顶层对象或数组已闭合。 */
  closed = false

  push(text: string): void {
    for (const ch of text) {
      if (this.closed) return
      if (this.inString) {
        if (this.escaped) this.escaped = false
        else if (ch === '\\') this.escaped = true
        else if (ch === '"') this.inString = false
        continue
      }
      if (ch === '"') this.inString = true
      else if (ch === '{' || ch === '[') {
        this.depth++
        this.opened = true
      } else if ((ch === '}' || ch === ']') && this.opened) {
        this.depth--
        if (this.depth === 0) this.closed = true
      }
    }
  }
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
