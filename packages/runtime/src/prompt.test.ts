/**
 * 尾区注记的装配。
 *
 * 覆盖范围：`prompt.ts` 的 `buildTailNotes`（`buildSystemPrompt` 由
 * `agent/prefix-audit.test.ts` 审）。
 *
 * 锁的是**技能、记忆、外部工具都只进标题**：正文（外部工具是完整参数说明）
 * 一旦被塞回尾区，每轮都要全量重发一遍，而这件事不会有任何报错——
 * 只会表现为账单变高、缓存命中变低。
 */

import { describe, expect, test } from 'bun:test'
import { buildTailNotes, buildTodoNote } from './prompt.ts'

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

  test('待加载的外部工具同理：工具名 + 一句话，参数说明靠 load_tool', () => {
    const notes = buildTailNotes({
      ...base,
      externalTools: [{ name: 'mcp__github__search', summary: '搜仓库' }],
    })
    const tools = note(notes, 'mcpTools')?.content ?? ''
    expect(tools).toContain('- mcp__github__search：搜仓库')
    expect(tools).toContain('load_tool')
  })

  /**
   * MCP 与插件的 summary 就是第三方给的 description 原文，可以是好几段。
   * 不截的话这份「省 token 的清单」自己就能涨到几千 token——实测四个真实
   * server 共 41 个工具，原样拼 2620 token，截到 100 字 1187 token。
   */
  test('外部工具的一句话只取首行并截断，不把整段 description 搬进来', () => {
    const notes = buildTailNotes({
      ...base,
      externalTools: [{ name: 'mcp__x__fat', summary: `第一行\n第二行\n${'长'.repeat(500)}` }],
    })
    const tools = note(notes, 'mcpTools')?.content ?? ''
    expect(tools).toContain('- mcp__x__fat：第一行')
    expect(tools).not.toContain('第二行')

    const long = buildTailNotes({
      ...base,
      externalTools: [{ name: 'mcp__x__fat', summary: '长'.repeat(500) }],
    })
    expect((note(long, 'mcpTools')?.content ?? '').length).toBeLessThan(200)
  })

  /**
   * 分组必须带出来。一律标 `workspaceState` 的话，面板上「记忆内容」与
   * 「技能清单」两行永远是 0——数据一直在发，只是没人按组去量。
   */
  /**
   * 清单在历史里只有快照，一轮任务会留下好几份，最新那份埋在几万 token 的执行记录
   * 中间，没有标记说明哪份是现在的。实测一轮 59 步的任务在第 33 步之后再没更新过
   * 清单，收尾时账本停在 5/7 而回答宣布做完了。
   *
   * 锁的是它**不在尾区**：尾区在 transcript 之前，而缓存断点之三建立在「一个 run 内
   * 尾区逐字节不变」这条上，清单每提交一次就变。位置由 `agent/loop.test.ts` 锁。
   */
  test('待办渲染：逐条状态 + 与工具回执同一个进度口径', () => {
    const text = buildTodoNote([
      { id: 'todo_1', content: '审计注入面', status: 'completed' },
      { id: 'todo_2', content: '查运行态日志', status: 'in_progress' },
      { id: 'todo_3', content: '汇总报告', status: 'pending' },
    ])
    expect(text).toContain('当前待办（1/3）')
    expect(text).toContain('[x] 审计注入面')
    expect(text).toContain('[>] 查运行态日志')
    expect(text).toContain('[ ] 汇总报告')
  })

  test('空清单不产出这一段，也不混进尾区', () => {
    expect(buildTodoNote([])).toBeNull()
    for (const n of buildTailNotes(base)) expect(n.content).not.toContain('当前待办')
  })

  test('四个桶各归各的，没有内容的桶不产出注记', () => {
    const empty = buildTailNotes(base)
    expect(empty.map((n) => n.group)).toEqual(['workspaceState'])

    const full = buildTailNotes({
      ...base,
      skills: [{ name: 'a', description: 'x' }],
      memories: [{ key: 'b', preview: 'y' }],
      externalTools: [{ name: 'mcp__d__c', summary: 'z' }],
    })
    expect(full.map((n) => n.group)).toEqual(['workspaceState', 'skills', 'memory', 'mcpTools'])
  })
})
