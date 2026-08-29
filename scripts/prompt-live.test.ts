/**
 * 覆盖 `prompt-live.ts` 的 `wsFor`：接口与模型名到工作区目录名的映射。
 *
 * 只测这一个函数——脚本其余部分要真实端点才跑得起来，单测碰不到。
 */

import { describe, expect, test } from 'bun:test'
import { basename } from 'node:path'
import { repeatedOpenersInRuns, wsFor } from './prompt-live.ts'

const nameOf = (provider: string, model: string) => basename(wsFor({ provider, model } as never))

describe('工作区目录名', () => {
  /**
   * 原始失败形状：`[^\w.-]` 漏写反斜杠成 `[^w.-]` 时，`w` 从「单词字符」退化成
   * 字面的字母 w，除 w、点、横杠之外每个字符都被换成下划线，
   * `deepseek-deepseek-v4-pro` 落成 `________-________-__-___`。
   * 面板上三个 work 的名字与磁盘目录一起变成一排下划线。
   */
  test('常规接口与模型名原样保留，不出现下划线', () => {
    expect(nameOf('deepseek', 'deepseek-v4-pro')).toBe('deepseek-deepseek-v4-pro')
    expect(nameOf('deepseek', 'deepseek-v4-flash-vision-exp')).toBe(
      'deepseek-deepseek-v4-flash-vision-exp',
    )
    expect(nameOf('anthropic', 'claude-opus-5')).toBe('anthropic-claude-opus-5')
  })

  test('点与横杠是合法字符，不被替换', () => {
    expect(nameOf('Grok', 'grok-4.6')).toBe('Grok-grok-4.6')
  })

  /**
   * 模型 id 本身可能含斜杠（`anthropic/claude-3` 这种）。不换掉的话
   * `join` 会多出一层目录，工作区落到一个谁也没预期的路径上。
   */
  test('斜杠换成下划线，不多出一层目录', () => {
    expect(nameOf('openrouter', 'meta/llama-3')).toBe('openrouter-meta_llama-3')
  })
})

describe('重复开头按 run 隔离', () => {
  test('两个任务各说一次相同编号不算重复', () => {
    expect(repeatedOpenersInRuns(['继续第 5 项。', '继续第 5 项。'])).toEqual([])
  })

  test('同一任务里重复相同编号才报告', () => {
    expect(repeatedOpenersInRuns(['继续第 5 项。\n继续执行第 5 项。', '继续第 5 项。'])).toEqual([
      [1, '5', 2],
    ])
  })
})
