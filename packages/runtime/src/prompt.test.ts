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
import { buildTailNotes } from './prompt.ts'

const base = { workspaceRoot: '/tmp/ws', platform: 'linux', mode: 'auto' as const }
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

  test('把模糊模型意图约束到本轮真实配置，并给出可直接调用的精确参数', () => {
    const notes = buildTailNotes({
      ...base,
      models: [
        { provider: '智谱', model: 'glm-5.3-flash' },
        { provider: '官方/中转', model: 'qwen/model-3.8' },
        { provider: '接口甲', model: 'shared-model' },
        { provider: '接口乙', model: 'shared-model' },
      ],
    })
    const models = notes.find((item) => item.content.includes('## 可分配给子 agent'))?.content ?? ''

    expect(models).toContain('provider 参数 `智谱`；model 参数 `glm-5.3-flash`')
    // 两列分开后，接口名与模型 id 各自带斜杠也不需要解析分隔符。
    expect(models).toContain('provider 参数 `官方/中转`；model 参数 `qwen/model-3.8`')
    // 同名模型由 provider 列区分，model 字段仍是配置中的原始 id。
    expect(models).toContain('provider 参数 `接口甲`；model 参数 `shared-model`')
    expect(models).toContain('provider 参数 `接口乙`；model 参数 `shared-model`')
    expect(models).toContain('厂商、系列或简称')
    expect(models).toContain('语义匹配并自主选择')
    expect(models).toContain('不要把用户的模糊写法直接填进工具')
  })

  test('有派活能力但没有配置模型时明确禁止编造，没派活能力则不注入清单', () => {
    const empty = buildTailNotes({ ...base, models: [] })
    expect(empty.some((item) => item.content.includes('当前没有配置可用模型'))).toBe(true)

    const unavailable = buildTailNotes(base)
    expect(unavailable.some((item) => item.content.includes('可分配给子 agent'))).toBe(false)
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
   * 复现的是原始失败形状：第三方 description 以空行或 `## Overview` 开头时，
   * 清单里那一行只剩工具名，模型据此判断不出该不该 `load_tool`。
   */
  test('摘要跳过空行与标题行，取第一句有内容的话', () => {
    const line = (summary: string) => {
      const notes = buildTailNotes({ ...base, externalTools: [{ name: 'mcp__x__t', summary }] })
      return note(notes, 'mcpTools')?.content ?? ''
    }
    expect(line('\n\nSearch repositories.')).toContain('- mcp__x__t：Search repositories.')
    expect(line('## Overview\n\nSearch repositories.')).toContain(
      '- mcp__x__t：Search repositories.',
    )
    expect(line('## Overview\n\nSearch repositories.')).not.toContain('## Overview')
  })

  /**
   * 原始失败形状：压缩把工具结果压成 320 字摘录，workflowId 与 checkpointId 整个不在
   * 里面，模型手上没有任何 id 能续接那张图，只能整张重派——四条子会话白跑。
   */
  test('未完成的图连同 workflowId、检查点与各节点续接情况一起进快照', () => {
    const projection = {
      workflowId: 'st_first',
      goal: '四个模型各做一版\n第二行不进快照',
      maxConcurrent: 4,
      nodes: [
        {
          id: 'build-glm',
          kind: 'subagent' as const,
          target: { kind: 'temp' as const, name: '做 glm 版' },
          task: '做 glm 版',
        },
        {
          id: 'build-qwen',
          kind: 'subagent' as const,
          target: { kind: 'temp' as const, name: '做 qwen 版' },
          task: '做 qwen 版',
        },
        {
          id: 'build-gemini',
          kind: 'subagent' as const,
          target: { kind: 'temp' as const, name: '做 gemini 版' },
          task: '做 gemini 版',
        },
        {
          id: 'audit-builds',
          kind: 'checkpoint' as const,
          label: '主会话验收',
          needs: ['build-glm', 'build-qwen', 'build-gemini'],
        },
      ],
      phase: 'waiting_review' as const,
      checkpointId: 'audit-builds',
      results: {
        'build-glm': {
          nodeId: 'build-glm',
          label: 'glm',
          status: 'done' as const,
          output: '做完了',
          durationMs: 1,
          subagentId: 'cv_glm',
        },
        'build-qwen': {
          nodeId: 'build-qwen',
          label: 'qwen',
          status: 'failed' as const,
          output: '',
          error: '调用中断',
          durationMs: 0,
          subagentId: 'cv_qwen',
        },
      },
      states: {},
      attempts: {},
      approvals: {},
    }
    const all = buildTailNotes({ ...base, workflows: [projection] })
      .filter((n) => n.group === 'workspaceState')
      .map((n) => n.content)
      .join('\n')

    expect(all).toContain('workflowId=st_first')
    expect(all).toContain('当前检查点：audit-builds')
    expect(all).toContain('状态：等待审查')
    // 目标只取首行：多行目标会把这一段撑成一篇正文。
    expect(all).toContain('目标：四个模型各做一版｜')
    expect(all).not.toContain('第二行不进快照')
    expect(all).toContain('build-glm：done，可续接原会话')
    expect(all).toContain('build-qwen：failed：调用中断，可续接原会话')
    // 没跑过的那个照实说，不编一个状态。
    expect(all).toContain('build-gemini：还没有回执')
    // 检查点不是 agent 节点，不逐个列。
    expect(all).not.toContain('- audit-builds：')

    // 一张未完成的图都没有时整段不出现。
    expect(
      buildTailNotes(base)
        .map((n) => n.content)
        .join('\n'),
    ).not.toContain('未完成的 workflow')
  })

  /**
   * 分组必须带出来。一律标 `workspaceState` 的话，面板上「记忆内容」与
   * 「技能清单」两行永远是 0——数据一直在发，只是没人按组去量。
   */
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

  /**
   * 复现的是原始失败形状：`平台：win32` 会让模型对用户复述成「Windows 32 位」。
   * 断言原值**不出现**，而不只是断言新值出现——只测新值的话，
   * 哪天有人把两个都写进去，这个测试照样绿。
   */
  test('平台给人读名，Node 的原值不进提示词', () => {
    const state = (platform: string) =>
      note(buildTailNotes({ ...base, platform }), 'workspaceState')?.content ?? ''

    expect(state('win32')).toContain('平台：Windows')
    expect(state('win32')).not.toContain('win32')
    expect(state('darwin')).toContain('平台：macOS')
    expect(state('darwin')).not.toContain('darwin')
    expect(state('linux')).toContain('平台：Linux')

    // 没收录的取值原样带过去：编一个名字比给出原值更糟。
    expect(state('freebsd')).toContain('平台：freebsd')
  })

  /**
   * 权限模式必须在尾区。不说的话模型只能靠撞：每撞一次多付一轮
   * 「被拒 → 改写 → 重发」，而被拒的那次调用本身已经计过费。
   */
  test('权限模式两种都写清边界，auto 说明拒什么', () => {
    const state = (mode: 'auto' | 'full') =>
      note(buildTailNotes({ ...base, mode }), 'workspaceState')?.content ?? ''

    expect(state('auto')).toContain('权限模式：auto')
    expect(state('auto')).toContain('凭证')
    expect(state('full')).toContain('完全访问')
    // full 下不设裁决，别把 auto 那句边界一起发出去。
    expect(state('full')).not.toContain('会被拒绝')
  })

  /**
   * 复现的是原始失败形状：清单剩两条未完成，模型在一次修复之后结束本轮，
   * 转而询问用户下一条修哪个。成因是清单只在 `write_todos` 那次调用里出现一次，
   * 之后既不重发，压缩时也进不了事实清单。
   */
  test('待办每次请求重发，状态用人读名，未完成时给出继续执行的指令', () => {
    const notes = buildTailNotes({
      ...base,
      todos: [
        { id: 'todo_1', content: '跑测试套件', status: 'completed' },
        { id: 'todo_2', content: '做静态巡检', status: 'in_progress' },
        { id: 'todo_3', content: '汇总 bug 与证据', status: 'pending' },
      ],
    })
    const todo = notes.at(-1)?.content ?? ''
    expect(todo).toContain('1. [已完成] 跑测试套件')
    expect(todo).toContain('2. [进行中] 做静态巡检')
    expect(todo).toContain('3. [未开始] 汇总 bug 与证据')
    // 枚举原值不进提示词，同「平台：win32」那条。
    expect(todo).not.toContain('in_progress')
    expect(todo).toContain('不要结束本轮')
    expect(todo).toContain('parentTodo')
    expect(todo).toContain('先验收')
    expect(todo).toContain('不满意保持未完成')
  })

  test('旧清单全部完成后不再冒充下一轮当前待办', () => {
    const notes = buildTailNotes({
      ...base,
      todos: [{ id: 'todo_1', content: '做一件事', status: 'completed' }],
    })
    const current = notes.filter((item) => item.content.includes('## 当前待办清单'))
    expect(current).toEqual([])
    expect(notes.map((item) => item.content).join('\n')).not.toContain('做一件事')
  })

  test('待办排在最后：它最易变，排前面会把技能与记忆一起挤出缓存', () => {
    const notes = buildTailNotes({
      ...base,
      skills: [{ name: 'a', description: 'x' }],
      memories: [{ key: 'b', preview: 'y' }],
      todos: [{ id: 'todo_1', content: '做一件事', status: 'pending' }],
    })
    expect(notes.map((n) => n.group)).toEqual([
      'workspaceState',
      'skills',
      'memory',
      'workspaceState',
    ])
  })
})
