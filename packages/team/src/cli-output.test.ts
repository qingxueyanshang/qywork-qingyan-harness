import { describe, expect, test } from 'bun:test'
import { createCliOutput } from './cli-output.ts'
import type { CliAgent } from './types.ts'

type Spec = Parameters<typeof createCliOutput>[0]
const codex: Spec = {
  output: 'jsonl',
  protocol: 'codex',
  resultField: 'item.text',
  sessionField: 'thread_id',
  narrate: { text: 'item.text' },
}
const claude: Spec = {
  output: 'jsonl',
  protocol: 'claude',
  resultField: 'result',
  sessionField: 'session_id',
  narrate: { text: 'message.content[].text', tool: 'message.content[].name' },
}
const grok: Spec = {
  output: 'json',
  protocol: 'grok',
  resultField: 'text',
  sessionField: 'sessionId',
}
const message = (text: string) => ({
  type: 'item.completed',
  item: { type: 'agent_message', text },
})

function parse(spec: Spec, events: unknown[]) {
  const parser = createCliOutput(spec)
  const raw =
    spec.output === 'json'
      ? JSON.stringify(events[0], null, 2)
      : events.map((event) => JSON.stringify(event)).join('\n')
  let live = ''
  // 每个字符一个分片，末行没有换行：终态和中文正文都不能丢失。
  for (const char of raw) live += parser.feed(char)
  live += parser.flush()
  return { ...parser.result(), live }
}

describe('CLI 厂商终态', () => {
  test('Codex 的 stdout 错误保留原因与续接会话号', () => {
    const got = parse(codex, [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'error', message: '认证已过期' },
      { type: 'turn.failed', error: { message: '认证已过期' } },
    ])
    expect(got).toMatchObject({ output: '', session: 'thread-1', error: '认证已过期' })
    expect(got.incomplete).toBeTruthy()
  })

  test('Codex 重试恢复后的成功不被中间错误覆盖，思考文本不替换答案', () => {
    const got = parse(codex, [
      { type: 'error', message: '正在重连' },
      message('已修改文件'),
      { type: 'item.completed', item: { type: 'reasoning', text: '内部思考' } },
      { type: 'turn.completed' },
    ])
    expect(got).toMatchObject({ output: '已修改文件', error: '', incomplete: '', hasResult: true })
    expect(got.live).not.toContain('内部思考')
  })

  test('Codex 有中间正文但没有完成事件时仍不算完成', () => {
    const got = parse(codex, [message('开始处理')])
    expect(got.output).toBe('开始处理')
    expect(got.incomplete).toBeTruthy()
  })

  test('Codex 只有思考文本和完成事件时不能算有交付物', () => {
    const got = parse(codex, [
      { type: 'item.completed', item: { type: 'reasoning', text: '先检查目录' } },
      { type: 'turn.completed' },
    ])
    expect(got.hasResult).toBe(false)
    expect(got.output).toBe('')
  })

  test('Claude 的错误终态提取 errors 数组，而不是丢弃或当正文成功', () => {
    const got = parse(claude, [
      { type: 'system', subtype: 'init', session_id: 'claude-1' },
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['服务不可用', '请求未完成'],
      },
    ])
    expect(got.error).toBe('服务不可用\n请求未完成')
    expect(got.session).toBe('claude-1')
    expect(got.incomplete).toBeTruthy()
  })

  test('Claude is_error=true 优先于 success 标签', () => {
    const got = parse(claude, [
      { type: 'result', subtype: 'success', is_error: true, result: '登录失效' },
    ])
    expect(got.error).toBe('登录失效')
    expect(got.incomplete).toBeTruthy()
  })

  test('Claude 的中间工具失败可以恢复，以最终 result 判断', () => {
    const got = parse(claude, [
      { type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } },
      { type: 'result', subtype: 'success', is_error: false, result: '已完成' },
    ])
    expect(got).toMatchObject({ output: '已完成', hasResult: true, error: '', incomplete: '' })
  })

  test('Claude 的取消或延后审批不能以 success 标签报完成', () => {
    for (const terminal_reason of ['aborted_streaming', 'aborted_tools']) {
      const got = parse(claude, [
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '部分产出',
          terminal_reason,
        },
      ])
      expect(got.error).toContain(terminal_reason)
      expect(got.incomplete).toBeTruthy()
    }
    const deferred = parse(claude, [
      {
        type: 'result',
        subtype: 'success',
        result: '等待审批',
        deferred_tool_use: { name: 'Bash' },
      },
    ])
    expect(deferred.error).toContain('等待工具审批')
    expect(deferred.incomplete).toBeTruthy()
  })

  test('Claude 只有工具名称或缺少最终正文时不算有效产出', () => {
    const got = parse(claude, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
      { type: 'result', subtype: 'success', is_error: false },
    ])
    expect(got.live).toContain('[工具 Read]')
    expect(got.output).toBe('')
    expect(got.hasResult).toBe(false)
  })

  test('Grok JSON 错误与非正常停止都保留，而正常 end_turn 可完成', () => {
    expect(parse(grok, [{ type: 'error', message: '无法启动会话' }]).error).toBe('无法启动会话')
    for (const stopReason of ['cancelled', 'max_tokens', 'max_turn_requests', 'refusal']) {
      const got = parse(grok, [{ text: '已做一部分', sessionId: 'grok-1', stopReason }])
      expect(got.error).toContain(stopReason)
      expect(got).toMatchObject({ output: '已做一部分', session: 'grok-1' })
    }
    expect(parse(grok, [{ text: '完成', stopReason: 'end_turn' }])).toMatchObject({
      hasResult: true,
      error: '',
      incomplete: '',
    })
  })

  test('无效结构化输出不能被判定为完成', () => {
    for (const spec of [codex, claude, grok]) {
      const parser = createCliOutput(spec)
      parser.feed('不是 JSON\n')
      parser.flush()
      expect(parser.result().incomplete).toBe('CLI 未返回有效的结构化结果')
    }
  })

  test('纯文本 CLI 保留原文，不按错误关键词推测任务成败', () => {
    const parser = createCliOutput({ output: 'text' } satisfies Pick<CliAgent, 'output'>)
    parser.feed('说明：已修复 error 处理\n')
    parser.flush()
    expect(parser.result()).toMatchObject({
      output: '说明：已修复 error 处理',
      hasResult: true,
      error: '',
      incomplete: '',
    })
  })
})
