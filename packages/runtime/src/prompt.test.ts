/**
 * 上下文末尾注记的装配。
 *
 * 覆盖范围：`prompt.ts` 的 `buildTailNotes`，`buildSystemPrompt` 中 run_command
 * 一行的措辞与末尾的 `outputLimitNote`（前缀稳定性由 `agent/prefix-audit.test.ts` 审查）。
 *
 * 锁定的约束是技能、记忆、外部工具都只放入标题：正文（外部工具为完整参数说明）
 * 一旦放回上下文末尾，每轮都要全量重发，且不会产生任何报错，
 * 只会导致费用升高、缓存命中率降低。
 */

import { describe, expect, test } from 'bun:test'
import { buildSystemPrompt, buildTailNotes, outputLimitNote } from './prompt.ts'

const base = { workspaceRoot: '/tmp/ws', platform: 'linux', mode: 'auto' as const }
const note = (notes: ReturnType<typeof buildTailNotes>, group: string) =>
  notes.find((n) => n.group === group)

describe('上下文末尾注记', () => {
  test('记忆每条一行：key 与首行摘要，不含正文', () => {
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
    // 正文须通过 read_memory 读取，因此引导语必须保留：缺少引导语时模型不知道存在正文。
    expect(memory).toContain('read_memory')
  })

  test('技能同理：name 与 description，正文通过 read_skill 读取', () => {
    const notes = buildTailNotes({
      ...base,
      skills: [{ name: '发版', description: '怎么发一个版本' }],
    })
    const skills = note(notes, 'skills')?.content ?? ''
    expect(skills).toContain('- 发版：怎么发一个版本')
    expect(skills).toContain('read_skill')
  })

  test('待加载的外部工具同理：工具名与一句摘要，参数说明通过 load_tool 加载', () => {
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
    // 两列分开后，即使接口名与模型 id 含有斜杠，也无需解析分隔符。
    expect(models).toContain('provider 参数 `官方/中转`；model 参数 `qwen/model-3.8`')
    // 同名模型由 provider 列区分，model 字段仍是配置中的原始 id。
    expect(models).toContain('provider 参数 `接口甲`；model 参数 `shared-model`')
    expect(models).toContain('provider 参数 `接口乙`；model 参数 `shared-model`')
    expect(models).toContain('厂商、系列或简称')
    expect(models).toContain('只接受清单中同一行的值')
    expect(models).toContain('按语义判断')
  })

  test('有任务派发能力但没有配置模型时明确禁止编造，没有任务派发能力时不注入清单', () => {
    const empty = buildTailNotes({ ...base, models: [] })
    expect(empty.some((item) => item.content.includes('当前没有配置可用模型'))).toBe(true)

    const unavailable = buildTailNotes(base)
    expect(unavailable.some((item) => item.content.includes('可分配给子 agent'))).toBe(false)
  })

  /**
   * MCP 与插件的 summary 即第三方提供的 description 原文，可能包含多段。
   * 不截断时，这份用于节省 token 的清单本身就会增长到数千 token：实测四个真实
   * server 共 41 个工具，原样拼接为 2620 token，截断到 100 字为 1187 token。
   */
  test('外部工具的摘要只取首行并截断，不放入整段 description', () => {
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
   * 复现原始失败形状：第三方 description 以空行或 `## Overview` 开头时，
   * 清单中该行只剩工具名，模型无法据此判断是否需要 `load_tool`。
   */
  test('摘要跳过空行与标题行，取第一行有内容的文本', () => {
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
   * 原始失败形状：压缩将工具结果缩减为 320 字摘录，workflowId 与 checkpointId 完全不在
   * 其中，模型没有任何 id 可续接该任务图，只能重新派发整张图，四条子会话的工作因此作废。
   */
  test('未完成的任务图连同 workflowId、检查点与各节点续接情况一并写入快照', () => {
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
      approvals: {},
    }
    const all = buildTailNotes({ ...base, workflows: [projection] })
      .filter((n) => n.group === 'workspaceState')
      .map((n) => n.content)
      .join('\n')

    expect(all).toContain('workflowId=st_first')
    expect(all).toContain('当前检查点：audit-builds')
    expect(all).toContain('状态：等待审查')
    // 目标只取首行：多行目标会使该段落变为大段正文。
    expect(all).toContain('目标：四个模型各做一版｜')
    expect(all).not.toContain('第二行不进快照')
    expect(all).toContain('build-glm：done，可续接原会话')
    expect(all).toContain('build-qwen：failed：调用中断，可续接原会话')
    // 未执行过的节点如实说明，不虚构状态。
    expect(all).toContain('build-gemini：尚无回执')
    // 检查点不是 agent 节点，不逐个列出。
    expect(all).not.toContain('- audit-builds：')

    // 没有未完成的任务图时不输出整段。
    expect(
      buildTailNotes(base)
        .map((n) => n.content)
        .join('\n'),
    ).not.toContain('未完成的 workflow')
  })

  /**
   * 必须携带分组。一律标为 `workspaceState` 时，面板上「记忆内容」与
   * 「技能清单」两行始终为 0：数据仍在发送，但未按分组统计。
   */
  test('四个分组各自归类，没有内容的分组不产生注记', () => {
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
   * 复现原始失败形状：`平台：win32` 会使模型向用户复述为「Windows 32 位」。
   * 断言原值不出现，而不只是断言新值出现：只测试新值时，
   * 若两者都被写入，测试仍会通过。
   */
  test('平台使用可读名称，Node 的原值不写入提示词', () => {
    const state = (platform: string) =>
      note(buildTailNotes({ ...base, platform }), 'workspaceState')?.content ?? ''

    expect(state('win32')).toContain('平台：Windows')
    expect(state('win32')).not.toContain('win32')
    expect(state('darwin')).toContain('平台：macOS')
    expect(state('darwin')).not.toContain('darwin')
    expect(state('linux')).toContain('平台：Linux')

    // 未收录的取值原样传递：虚构名称的危害大于给出原值。
    expect(state('freebsd')).toContain('平台：freebsd')
  })

  /**
   * 权限模式必须位于上下文末尾。未告知时模型只能逐次试探：每次被拒绝都多消耗一轮
   * 「被拒 → 改写 → 重发」，而被拒绝的调用本身已计费。
   */
  test('两种权限模式都写明边界，auto 说明拒绝的范围', () => {
    const state = (mode: 'auto' | 'full') =>
      note(buildTailNotes({ ...base, mode }), 'workspaceState')?.content ?? ''

    expect(state('auto')).toContain('权限模式：auto')
    expect(state('auto')).toContain('凭证')
    expect(state('full')).toContain('完全访问')
    // full 下不设裁决，不发送 auto 的边界说明。
    expect(state('full')).not.toContain('会被拒绝')
  })

  /**
   * 复现原始失败形状：清单剩两条未完成，模型在一次修复之后结束本轮，
   * 转而询问用户下一条修复哪一项。成因是清单只在 `write_todos` 调用中出现一次，
   * 之后既不重发，压缩时也不进入事实清单。
   */
  test('待办每次请求重发保留进度，跨轮清单不成为执行指令', () => {
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
    // 枚举原值不写入提示词，理由同「平台：win32」一条。
    expect(todo).not.toContain('in_progress')
    expect(todo).toContain('跨轮保留的任务进度，不是继续执行的指令')
    expect(todo).toContain('接续时先用 write_todos 提交清单')
    expect(todo).not.toContain('清单还有未完成项时本轮不结束')
    // 任务派发的规则只写在工具参数中，待办注记不重复。
    expect(todo).not.toContain('parentTodo')
  })

  test('旧清单全部完成后不再作为下一轮的当前待办', () => {
    const notes = buildTailNotes({
      ...base,
      todos: [{ id: 'todo_1', content: '做一件事', status: 'completed' }],
    })
    const current = notes.filter((item) => item.content.includes('## 当前待办清单'))
    expect(current).toEqual([])
    expect(notes.map((item) => item.content).join('\n')).not.toContain('做一件事')
  })

  test('待办排在最后：它变化最频繁，排在前面会使技能与记忆一并失去缓存', () => {
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

describe('能力段', () => {
  test('有 run_command 时写明 Chrome 须指定 --user-data-dir，位于 .tmp/ 下', () => {
    const prompt = buildSystemPrompt(new Set(['run_command']))
    expect(prompt).toContain('--user-data-dir=.tmp/chrome')
  })

  test('没有 run_command 时不提及 Chrome', () => {
    expect(buildSystemPrompt(new Set(['read_file']))).not.toContain('--user-data-dir')
  })

  /**
   * 桌面工具组注册后才输出该行。缺少该行的后果已实测确认：模型具备这组工具，
   * 仍用 run_command 执行自行编写的截图与按坐标点击脚本。
   */
  test('注册了桌面工具时写明这组工具，并写明不使用 run_command 截图或按坐标点击', () => {
    const prompt = buildSystemPrompt(new Set(['run_command', 'desktop_windows']))
    expect(prompt).toContain('desktop_windows')
    expect(prompt).toContain('desktop_observe')
    expect(prompt).toContain('不得通过 run_command 截图或注入鼠标、键盘事件')
    // 自绘界面的处理路径须完整写明：observe 附带截图、按图动作的回执附带截图、连续动作使用 sequence。
    expect(prompt).toContain('缺少可操作控件')
    expect(prompt).toContain('使用观察结果附带的截图定位')
    expect(prompt).toContain('desktop_act_sequence')
    expect(prompt).toContain('foregroundEnabled')
    expect(prompt).toContain('为 false 时只使用可用的后台动作')
    expect(prompt).toContain('不得重试或自行更改设置')
  })

  /**
   * 原始失败形状：模型将正在运行其他程序的终端视为空闲 shell，向其中输入命令并执行 exit。
   * 该行如实写明已打开的窗口属于用户，不添加操作禁令；这一事实只写在该行。
   */
  test('桌面一行写明已打开的窗口属于用户，是否完成按观察中可见的结果判断，且只出现一次', () => {
    const prompt = buildSystemPrompt(new Set(['run_command', 'desktop_windows']))
    expect(prompt.split('已有桌面窗口及其内容属于用户')).toHaveLength(2)
    expect(prompt).toContain('系统窗口标题仅用于识别窗口，不作为当前页面或会话的确认依据')
    expect(prompt).toContain('证据不足或状态尚未确定时，应重新观察')
    expect(prompt).toContain('未经核验，不得报告任务完成')
    expect(prompt).toContain('不得仅因结果未确认而重复执行可能产生副作用的动作')
    expect(prompt).not.toContain('不必再观察一次')
    expect(prompt).not.toContain('先新建标签页')
  })

  /**
   * 原始失败形状：用户附带画布页截图要求「写进画布的这个提示词里」，工具表含画布工具，
   * 模型仍调用 desktop_windows 与 desktop_observe 操作 QyWork 窗口。能力段缺少画布一行时出现该行为。
   */
  test('注册画布工具时写明画布的定义与对应工具，不限制电脑控制；未注册时不出现', () => {
    const prompt = buildSystemPrompt(
      new Set([
        'create_canvas',
        'read_canvas',
        'edit_canvas',
        'run_canvas',
        'retrieve_canvas',
        'desktop_windows',
      ]),
    )
    expect(prompt).toContain('*.canvas.json')
    expect(prompt).toContain('界面画布页呈现该文件的内容')
    expect(prompt).toContain('使用 read_canvas')
    expect(prompt).toContain('使用 create_canvas')
    expect(prompt).toContain('node 传生成卡 id 数组，单个节点也写成数组')
    expect(prompt).toContain('使用 edit_canvas')
    expect(prompt).toContain('使用 run_canvas')
    expect(prompt).toContain('使用 retrieve_canvas')
    expect(prompt).not.toContain('不得使用电脑控制')
    expect(prompt.indexOf('- 画布：')).toBeLessThan(prompt.indexOf('- 电脑控制：'))
    expect(buildSystemPrompt(new Set(['desktop_windows']))).not.toContain('read_canvas')
    expect(buildSystemPrompt(new Set(['desktop_windows']))).not.toContain('create_canvas')
  })

  test('没有桌面工具时不提及桌面工具', () => {
    const prompt = buildSystemPrompt(new Set(['run_command']))
    expect(prompt).not.toContain('desktop_windows')
  })

  /** 已安装技能可能包含其他产品的生成或导出命令；write_office 工具注册后才写明执行一律使用该工具。 */
  test('注册了 office 时写明先获取操作说明、交付前检查页面，未注册时不提及', () => {
    const prompt = buildSystemPrompt(
      new Set(['run_command', 'read_office_guide', 'read_office', 'write_office', 'view_office']),
    )
    expect(prompt).toContain('不用 run_command 另行实现生成或导出流程')
    expect(prompt).toContain('read_office_guide')
    expect(prompt).toContain('view_office')
    expect(buildSystemPrompt(new Set(['run_command']))).not.toContain('Office')
  })
})

describe('工具图像的生命周期', () => {
  /**
   * 媒体保留在请求中，模型无需重新读取；超出保留上限时最早的一批替换为说明。
   * 规则只陈述传输事实，不代替模型断言其已查看。
   */
  test('系统提示词写明图像与视频保留在后续请求中、指向历史中的原图、超限时替换为说明、细节用 read_history 取回', () => {
    const prompt = buildSystemPrompt(new Set(['read_history']))
    expect(prompt).toContain(
      '图像和视频保留在后续请求中，需要时直接查看历史中的原图和视频，无需重新读取',
    )
    expect(prompt).toContain('最早的一批替换为带 images_omitted 的说明')
    expect(prompt).toContain('read_history 按 call_id 取回')
    expect(prompt).not.toContain('只随紧接着的一次请求发送给你')
    expect(prompt).not.toContain('表示你已看过')
  })
})

describe('输出上限说明', () => {
  test('给出上限时附加在系统提示词末尾，上限按千分位格式写入原文', () => {
    const prompt = buildSystemPrompt(new Set(['run_command']), 128_000)
    expect(prompt.endsWith(outputLimitNote(128_000))).toBe(true)
    expect(prompt).toContain('a single limit of about 128,000 tokens')
  })

  test('未给出上限时不附加，其余部分与附加版本逐字相同', () => {
    const names = new Set(['run_command'])
    const bare = buildSystemPrompt(names)
    expect(bare).not.toContain('Everything Claude produces')
    expect(buildSystemPrompt(names, 128_000)).toBe(`${bare}\n\n${outputLimitNote(128_000)}`)
  })
})
