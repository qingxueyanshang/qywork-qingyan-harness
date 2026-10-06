/**
 * 覆盖 `prompt-live.ts` 的 `wsFor`（接口与模型名到工作区目录名的映射）与 `repeatedOpenersInRuns`（按 run 检查重复开头）。
 *
 * 只测试这两个函数：脚本其余部分需要真实端点才能运行，单元测试无法覆盖。
 */

import { describe, expect, test } from 'bun:test'
import { basename } from 'node:path'
import { repeatedOpenersInRuns, wsFor } from './prompt-live.ts'

const nameOf = (provider: string, model: string) => basename(wsFor({ provider, model } as never))

describe('工作区目录名', () => {
  /**
   * 原始失败形状：`[^\w.-]` 漏写反斜杠成为 `[^w.-]` 时，`w` 由「单词字符」变为
   * 字面的字母 w，除 w、点、连字符之外的每个字符都被替换为下划线，
   * `deepseek-deepseek-v4-pro` 变为 `________-________-__-___`。
   * 面板上的 work 名称与磁盘目录名均变为下划线串。
   */
  test('常规接口与模型名原样保留，不出现下划线', () => {
    expect(nameOf('deepseek', 'deepseek-v4-pro')).toBe('deepseek-deepseek-v4-pro')
    expect(nameOf('deepseek', 'deepseek-flash')).toBe('deepseek-deepseek-flash')
    expect(nameOf('anthropic', 'claude-opus-5')).toBe('anthropic-claude-opus-5')
  })

  test('点与连字符是合法字符，不被替换', () => {
    expect(nameOf('Grok', 'grok-4.6')).toBe('Grok-grok-4.6')
  })

  /**
   * 模型 id 本身可能含斜杠（如 `anthropic/claude-3`）。不替换时
   * `join` 会多出一层目录，工作区位于非预期的路径。
   */
  test('斜杠替换为下划线，不多出一层目录', () => {
    expect(nameOf('openrouter', 'meta/llama-3')).toBe('openrouter-meta_llama-3')
  })
})

describe('重复开头按 run 隔离', () => {
  test('两个任务各出现一次相同编号不算重复', () => {
    expect(repeatedOpenersInRuns(['继续第 5 项。', '继续第 5 项。'])).toEqual([])
  })

  test('同一任务中重复相同编号才报告', () => {
    expect(repeatedOpenersInRuns(['继续第 5 项。\n继续执行第 5 项。', '继续第 5 项。'])).toEqual([
      [1, '5', 2],
    ])
  })
})
