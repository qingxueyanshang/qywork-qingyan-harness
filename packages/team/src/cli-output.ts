/**
 * 外部 CLI 的 stdout 只解析一次：实时正文、最终结果、会话号与终态都取自同一输出流。
 * 协议由厂商表声明；纯文本 CLI 只能结合退出码与非空正文判断，不能推测自然语言是否表示失败。
 */
import { createLineFramer } from '@qywork/core'
import type { CliAgent } from './types.ts'

type OutputSpec = Pick<CliAgent, 'output' | 'protocol' | 'resultField' | 'sessionField' | 'narrate'>

/**
 * JSONL 的单行上限（字符）。一行是一个事件，工具结果中的图片以 base64 内嵌其中；厂商未给出单个事件的上限，
 * 取 64 Mi 字符，高于本仓库读取图片的上限 10 MiB（`tools` 包 `files.ts` 的 `MAX_IMAGE_BYTES`）base64 后的约 1400 万字符。
 * 超过时该行及之后的输出不再解析，结果报告为失败。
 */
const MAX_LINE_CHARS = 64 * 1024 * 1024

/** 按点分路径取字符串，段尾 [] 遍历数组。 */
function pick(root: unknown, path: string): string[] {
  const keys = path.split('.')
  const walk = (value: unknown, depth: number): string[] => {
    if (depth === keys.length) return typeof value === 'string' && value.trim() ? [value] : []
    if (!value || typeof value !== 'object') return []
    const key = keys[depth]!
    const array = key.endsWith('[]')
    const next = (value as Record<string, unknown>)[array ? key.slice(0, -2) : key]
    return array
      ? Array.isArray(next)
        ? next.flatMap((item) => walk(item, depth + 1))
        : []
      : walk(next, depth + 1)
  }
  return walk(root, 0)
}

export function createCliOutput(agent: OutputSpec) {
  /** `text` 与 `json` 格式的全部输出：前者即结果，后者是一份完整的 JSON。 */
  let buffer = ''
  const lines = createLineFramer(MAX_LINE_CHARS)
  let overflow = ''
  let result = ''
  let session = ''
  let error = ''
  let completed = false
  let parsedAny = false
  const parts: string[] = []

  const take = (line: string): string => {
    if (!line.trim()) return ''
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // jsonl 允许厂商横幅；缺少有效终态时仍会判失败，不把横幅当交付物。
      return ''
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    parsedAny = true
    const event = parsed as Record<string, unknown>
    const last = (path: string) => pick(event, path).at(-1) ?? ''
    const item = event.item as Record<string, unknown> | undefined
    const isCodexMessage = event.type === 'item.completed' && item?.type === 'agent_message'
    const isResult =
      agent.protocol === 'codex'
        ? isCodexMessage
        : agent.protocol === 'claude'
          ? event.type === 'result'
          : true
    if (isResult) result = last(agent.resultField ?? 'result') || result
    if (agent.sessionField) session = last(agent.sessionField) || session

    if (agent.protocol === 'codex') {
      if (event.type === 'error' || event.type === 'turn.failed') {
        completed = false
        error = last('error.message') || last('message') || error || 'Codex 执行失败'
      } else if (event.type === 'turn.completed') {
        // 连接重试等中间错误可以恢复，成败以最终的 turn 事件为准。
        completed = true
        error = ''
      } else if (event.type === 'turn.started') {
        completed = false
        result = ''
      }
    } else if (agent.protocol === 'claude' && event.type === 'result') {
      const stopped = ['aborted_streaming', 'aborted_tools'].includes(last('terminal_reason'))
      const deferred = !!event.deferred_tool_use
      completed = event.subtype === 'success' && event.is_error !== true && !stopped && !deferred
      error = completed
        ? ''
        : pick(event, 'errors[]').join('\n') ||
          (stopped
            ? `Claude 提前停止（${last('terminal_reason')}）`
            : deferred
              ? 'Claude 等待工具审批，任务尚未完成'
              : last('result') || `Claude 执行失败（${last('subtype') || '未知终态'}）`)
      // success 但没有 result 的流也不算有最终产出，不能用之前的工具名补齐。
      result = last(agent.resultField ?? 'result')
    } else if (agent.protocol === 'grok') {
      completed = event.stopReason === 'end_turn' && event.type !== 'error'
      error =
        event.type === 'error'
          ? last('message') || 'Grok 执行失败'
          : event.stopReason && !completed
            ? `Grok 提前停止（${last('stopReason')}）`
            : ''
    }

    const narrate = agent.output === 'jsonl' ? agent.narrate : undefined
    if (!narrate) return ''
    // Codex 的 reasoning / plan 也可能有 item.text，不能作为答案或完成凭据。
    if (agent.protocol === 'codex' && !isCodexMessage) return ''
    const texts = pick(event, narrate.text)
    parts.push(...texts)
    const tools = narrate.tool ? pick(event, narrate.tool).map((name) => `[工具 ${name}]`) : []
    const live = [...texts, ...tools]
    return live.length ? `${live.join('\n')}\n` : ''
  }

  return {
    feed(chunk: string): string {
      if (agent.output === 'jsonl') {
        const framed = lines.push(chunk)
        if (framed.overflow) {
          overflow = `CLI 输出中有一行超过 ${MAX_LINE_CHARS} 个字符，该行及之后的输出未解析`
        }
        return framed.lines.map(take).join('')
      }
      buffer += chunk
      return agent.output === 'text' ? chunk : ''
    },
    flush(): string {
      if (agent.output === 'jsonl') return take(lines.end())
      const rest = buffer
      buffer = ''
      if (agent.output === 'json') return take(rest)
      result = rest.trim()
      return ''
    },
    result() {
      const output = result || (agent.output === 'jsonl' ? parts.join('\n').trim() : '')
      return {
        output,
        session,
        // 溢出优先：其后的终态事件未经解析，此前的完成判定不再可信。
        error: overflow || error,
        // 结构化协议必须有真实的最终正文；中间输出只用于保留失败现场。
        hasResult: !!(agent.protocol ? result.trim() : output.trim()),
        incomplete:
          agent.protocol && !completed
            ? parsedAny
              ? 'CLI 未返回成功终态'
              : 'CLI 未返回有效的结构化结果'
            : '',
      }
    },
  }
}
