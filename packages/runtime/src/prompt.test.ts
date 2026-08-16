/**
 * 尾区注记的装配。
 *
 * 覆盖范围：`prompt.ts` 的 `buildTailNotes`（`buildSystemPrompt` 由
 * `agent/prefix-audit.test.ts` 审）。
 *
 * 锁的是**技能与记忆都只进标题**：正文一旦被塞回尾区，每轮都要全量重发一遍，
 * 而这件事不会有任何报错——只会表现为账单变高、缓存命中变低。
 */

import { describe, expect, test } from 'bun:test'
import { buildTailNotes } from './prompt.ts'

const base = { workspaceRoot: '/tmp/ws', platform: 'linux' }
const note = (notes: ReturnType<typeof buildTailNotes>, group: string) =>
  notes.find((n) => n.group === group)

describe('尾区注记', () => {
  test('记忆一行一条：key + 首行摘要，正文不在里面', () => {
    const notes = buildTailNotes({
      ...base,
      memories: [
        { key: '包管理器', preview: '本项目用 bun' },
        { key: '发版', preview: '推 tag 触发 CI' },
      ],
    })
    const memory = note(notes, 'memory')?.content ?? ''
    expect(memory).toContain('- 包管理器：本项目用 bun')
    expect(memory).toContain('- 发版：推 tag 触发 CI')
    // 正文靠 read_memory 拿，所以那句引导必须在——少了它模型不知道还有正文。
    expect(memory).toContain('read_memory')
  })

  test('技能同理：name + description，正文靠 read_skill', () => {
    const notes = buildTailNotes({
      ...base,
      skills: [{ name: '发版', description: '怎么发一个版本' }],
    })
    const skills = note(notes, 'skills')?.content ?? ''
    expect(skills).toContain('- 发版：怎么发一个版本')
    expect(skills).toContain('read_skill')
  })

  /**
   * 分组必须带出来。一律标 `workspaceState` 的话，面板上「记忆内容」与
   * 「技能清单」两行永远是 0——数据一直在发，只是没人按组去量。
   */
  test('三个桶各归各的，没有内容的桶不产出注记', () => {
    const empty = buildTailNotes(base)
    expect(empty.map((n) => n.group)).toEqual(['workspaceState'])

    const full = buildTailNotes({
      ...base,
      skills: [{ name: 'a', description: 'x' }],
      memories: [{ key: 'b', preview: 'y' }],
    })
    expect(full.map((n) => n.group)).toEqual(['workspaceState', 'skills', 'memory'])
  })
})
