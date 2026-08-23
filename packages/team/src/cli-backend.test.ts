/**
 * 覆盖范围：`cli-backend.ts` 的 `extract`——从外部 CLI 的 stdout 里取那段答案。
 *
 * 起进程那一半（`runCli`）由真机冒烟覆盖：它要本机真装着那几家 CLI，
 * 而它们各自的调用参数与输出格式恰恰是这张表最容易过期的地方。
 */

import { describe, expect, test } from 'bun:test'
import { extract } from './cli-backend.ts'

const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n')

describe('取答案', () => {
  test('text 模式原样回整段', () => {
    expect(extract('  可以  \n', { output: 'text' })).toBe('可以')
  })

  test('顶层字段（claude 那种）', () => {
    const out = jsonl([{ type: 'system' }, { result: '可以' }])
    expect(extract(out, { output: 'jsonl', resultField: 'result' })).toBe('可以')
  })

  /**
   * 复现的失败形状：codex 的答案在 `item.text` 上，顶层没有 `result`。
   * 只按顶层键取的话一行都取不到，回退成整段 JSONL，而模型会把那坨当成任务产出。
   */
  test('点分路径（codex 那种），且取最后一条', () => {
    const out = jsonl([
      { type: 'thread.started', thread_id: 'x' },
      { type: 'item.completed', item: { type: 'agent_message', text: '正在读取。' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'cat VERSION' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '0.1.0' } },
      { type: 'turn.completed', usage: { input_tokens: 1 } },
    ])
    expect(extract(out, { output: 'jsonl', resultField: 'item.text' })).toBe('0.1.0')
  })

  test('路径中途不是对象时跳过那一行，不炸', () => {
    const out = jsonl([{ item: '不是对象' }, { item: { text: '答案' } }])
    expect(extract(out, { output: 'jsonl', resultField: 'item.text' })).toBe('答案')
  })

  /** 一行都取不到时回退整段：回空串会让调用方以为「跑成了但没产出」。 */
  test('取不到就回退整段 stdout', () => {
    expect(extract('横幅\n乱七八糟', { output: 'jsonl', resultField: 'result' })).toBe(
      '横幅\n乱七八糟',
    )
  })
})
