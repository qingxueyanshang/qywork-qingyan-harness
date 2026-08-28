import { describe, expect, test } from 'bun:test'
import type { WireMessage } from '../types.ts'
import { mergeContextIntoUsers } from './context.ts'

describe('内部上下文归并', () => {
  test('多段上下文按原顺序并入一条真实用户消息', () => {
    const out = mergeContextIntoUsers([
      { role: 'context', content: '工作区：C:/ws' },
      { role: 'context', content: '## 当前待办\n- 检查缓存' },
      { role: 'user', content: '继续' },
    ])
    expect(out).toEqual([
      { role: 'user', content: '工作区：C:/ws\n\n## 当前待办\n- 检查缓存\n\n继续' },
    ])
  })

  test('多模态时上下文在最前，图片与用户正文顺序不变', () => {
    const image = {
      type: 'image' as const,
      mimeType: 'image/png',
      source: { kind: 'base64' as const, data: 'QQ==' },
    }
    const messages: WireMessage[] = [
      { role: 'context', content: '工作区：C:/ws' },
      { role: 'user', content: [image, { type: 'text', text: '看这张图' }] },
    ]
    expect(mergeContextIntoUsers(messages)[0]!.content).toEqual([
      { type: 'text', text: '工作区：C:/ws' },
      image,
      { type: 'text', text: '看这张图' },
    ])
  })

  test('上下文不能挂到 assistant/tool，也不能孤立上线', () => {
    expect(() =>
      mergeContextIntoUsers([
        { role: 'context', content: '内部' },
        { role: 'assistant', content: '错误归属' },
      ]),
    ).toThrow('内部上下文后必须紧跟真实用户消息')
    expect(() => mergeContextIntoUsers([{ role: 'context', content: '内部' }])).toThrow(
      '内部上下文缺少所属的用户消息',
    )
  })
})
