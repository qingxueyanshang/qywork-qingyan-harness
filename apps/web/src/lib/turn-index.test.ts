/** 覆盖 `turn-index.ts`：索引项的取法、摘要与当前项的判定。 */
import { expect, test } from 'bun:test'
import type { TranscriptItem } from './store/index.ts'
import { activeTurn, turnIds, turnPreview } from './turn-index.ts'

const item = (id: string, kind: TranscriptItem['kind'], text = ''): TranscriptItem =>
  ({ id, kind, text }) as TranscriptItem

const items: TranscriptItem[] = [
  item('u1', 'user', '第一个\n问题'),
  item('k1', 'thinking', '思考内容'),
  item('t1', 'text', '## 标题\n**加粗**的 `回复`'),
  item('r1', 'receipt', '子任务回执'),
  item('u2', 'user', '第二个问题'),
  { ...item('u3', 'user'), attachments: [{ path: 'C:/a.png', name: 'a.png' }] } as TranscriptItem,
  item('t3', 'text', '第三段回复'),
]

const earlier = [
  { id: 'e1', text: '更早的  第一问' },
  { id: 'e2', text: '更早的第二问' },
] as never

test('索引项为未加载的条目加已加载的用户消息，回执不计入', () => {
  expect(turnIds(earlier, items)).toEqual(['e1', 'e2', 'u1', 'u2', 'u3'])
})

test('摘要取用户消息开头与其后第一段回复，回复去掉 Markdown 标记', () => {
  expect(turnPreview(earlier, items, 'u1')).toEqual({
    title: '第一个 问题',
    reply: '标题 加粗的 回复',
  })
})

test('下一条用户消息之前没有回复时，回复为空串', () => {
  expect(turnPreview(earlier, items, 'u2')).toEqual({ title: '第二个问题', reply: '' })
})

test('只有附件的消息以附件名为标题', () => {
  expect(turnPreview(earlier, items, 'u3')).toEqual({ title: 'a.png', reply: '第三段回复' })
})

test('未加载的条目只有标题，回复为空串', () => {
  expect(turnPreview(earlier, items, 'e1')).toEqual({ title: '更早的 第一问', reply: '' })
})

test('id 不是用户消息时没有摘要', () => {
  expect(turnPreview(earlier, items, 't1')).toBeNull()
})

test('当前项是顶边不低于判定线的最后一项', () => {
  expect(activeTurn([10, 300, 900], 400)).toBe(1)
  expect(activeTurn([10, 300, 900], 900)).toBe(2)
  expect(activeTurn([500, 800], 400)).toBe(0)
  expect(activeTurn([], 400)).toBe(-1)
})
