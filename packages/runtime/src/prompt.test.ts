/**
 * 上下文末尾注记的装配。
 *
 * 覆盖范围：`prompt.ts` 的 `buildTailNotes`，`session/turn/prepare.ts` 的 `projectInstructionFiles`，`buildSystemPrompt` 中能力段各行的措辞、
 * 完成的定义、停下等待用户的判定（受阻四类与不是受阻的情形）、执行失败的七类处理方式、追问的意图、
 * 内置工具说明中不出现第二种收尾写法（覆盖 `@qywork/tools` 全部内置工具的 description）
 * 与末尾的 `outputLimitNote`；以及用 `@qywork/agent` 的 `auditFrozenText` 审计真实的系统提示词：
 * 冻结前缀中没有本身会变化的字段，两次构造逐字节相同，会变化的字段只出现在上下文末尾注记中。
 *
 * 锁定的约束是技能、记忆、外部工具都只放入标题：正文（外部工具为完整参数说明）
 * 一旦放回上下文末尾，每轮都要全量重发，且不会产生任何报错，
 * 只会导致费用升高、缓存命中率降低。
 */

import { describe, expect, setSystemTime, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditFrozenText, ToolRegistry } from '@qywork/agent'
import { TODO_BLOCKERS, TODO_FAILURES } from '@qywork/core'
import { registerToolCatalog } from '@qywork/tools'
import { buildSystemPrompt, buildTailNotes, outputLimitNote } from './prompt.ts'
import { projectInstructionFiles } from './session/turn/prepare.ts'

const base = { workspaceRoot: '/tmp/ws', platform: 'linux', mode: 'auto' as const }
const note = (notes: ReturnType<typeof buildTailNotes>, group: string) =>
  notes.find((n) => n.group === group)

describe('上下文末尾注记', () => {
  test('运行环境一节紧随工作区状态行，归入工作区状态；未提供时不出现', () => {
    const environment = '## 运行环境（本轮开始时读取本机目录）\n- Python：未找到。'
    const notes = buildTailNotes({ ...base, environment })
    const states = notes.filter((n) => n.group === 'workspaceState').map((n) => n.content)
    expect(states.at(-1)).toBe(environment)
    expect(states.at(-2)).toStartWith('工作区：/tmp/ws')
    expect(buildTailNotes(base).some((n) => n.content.includes('运行环境'))).toBe(false)
  })

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

  test('把模糊模型意图约束到本轮真实配置，并给出可直接调用的精确参数', () => {
    const notes = buildTailNotes({
      ...base,
      models: [
        { provider: '智谱', model: 'glm-5.3-flash' },
        { provider: '官方/兼容', model: 'qwen/model-3.8' },
        { provider: '接口甲', model: 'shared-model' },
        { provider: '接口乙', model: 'shared-model' },
      ],
    })
    const models = notes.find((item) => item.content.includes('## 可分配给子 agent'))?.content ?? ''

    expect(models).toContain('provider 参数 `智谱`；model 参数 `glm-5.3-flash`')
    // 两列分开后，即使接口名与模型 id 含有斜杠，也无需解析分隔符。
    expect(models).toContain('provider 参数 `官方/兼容`；model 参数 `qwen/model-3.8`')
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
      pendingMcp: [{ name: 'd', command: 'z' }],
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
   * 原始失败形状：仓库根的 AGENTS.md / CLAUDE.md 不进入上下文，qywork 工作区中模型 13 次直接运行 `bun test`，
   * 而 CLAUDE.md 写明了测试命令。快照只列文件与行数，正文由模型读取。
   */
  test('工作区根的项目说明文件列在工作区状态中，只列文件与行数，不含正文', async () => {
    const root = await mkdtemp(join(process.env.QYWORK_TEST_TEMP ?? tmpdir(), 'instructions-'))
    await writeFile(join(root, 'AGENTS.md'), '# 约定\n测试命令：bun run test\n', 'utf8')
    const files = await projectInstructionFiles(root)
    expect(files).toEqual([{ file: 'AGENTS.md', lines: 2 }])

    const state = note(buildTailNotes({ ...base, projectInstructions: files }), 'workspaceState')
    expect(state?.content).toContain('项目说明：AGENTS.md（2 行）')
    expect(state?.content).not.toContain('bun run test')
    expect(note(buildTailNotes(base), 'workspaceState')?.content).not.toContain('项目说明')
    expect(await projectInstructionFiles(join(root, 'missing'))).toEqual([])
  })

  test('当前日期取本机时区：东八区凌晨不写成前一天', () => {
    const before = process.env.TZ
    process.env.TZ = 'Asia/Shanghai'
    // UTC 2026-11-18 17:30 即东八区 2026-11-19 01:30。
    setSystemTime(new Date('2026-11-18T17:30:00Z'))
    try {
      const state = note(buildTailNotes(base), 'workspaceState')?.content ?? ''
      expect(state).toContain('当前日期：2026-11-19')
    } finally {
      setSystemTime()
      if (before === undefined) delete process.env.TZ
      else process.env.TZ = before
    }
  })

  /**
   * 原始失败：1M 窗口的模型在 50–67 万 token 时多次声称「上下文快耗尽、只剩一两次调用」，
   * 跳过验证并提前结束。快照中写明实测占用、窗口与自动压缩的位置，只占一行。
   */
  test('上下文占用写成一行：本轮开始时已用、窗口与自动压缩的比例；未提供时不出现', () => {
    const state = (context?: { used: number; window: number; compactAt: number }) =>
      note(buildTailNotes({ ...base, ...(context ? { context } : {}) }), 'workspaceState')
        ?.content ?? ''
    const lines = state({ used: 523_456, window: 1_000_000, compactAt: 800_000 })
      .split('\n')
      .filter((l) => l.startsWith('上下文：'))
    expect(lines).toEqual(['上下文：本轮开始时已用约 52.3 万 / 100 万 token，约 80% 时自动压缩'])
    expect(state({ used: 2_139, window: 128_000, compactAt: 102_400 })).toContain(
      '上下文：本轮开始时已用不足 1 万 / 12.8 万 token，约 80% 时自动压缩',
    )
    expect(state()).not.toContain('上下文：')
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
    expect(state('auto')).toContain('把 Python 包装入全局环境')
    expect(state('full')).toContain('完全访问')
    // full 下不设裁决，不发送 auto 的边界说明。
    expect(state('full')).not.toContain('会被拒绝')
  })

  /**
   * 复现原始失败形状：清单剩两条未完成，模型在一次修复之后结束本轮，
   * 转而询问用户下一条修复哪一项。成因是清单只在 `write_todos` 调用中出现一次，
   * 之后既不重发，压缩时也不进入事实清单。
   *
   * 另一侧的原始失败形状（rn_0mw836uj900011mjmsy）：清单有未完成项，用户问「为什么又停下来」，
   * 快照写着「不是继续执行的指令」，模型只解释、不执行。追问未完成的项即要求接续。
   */
  test('待办每次请求重发保留进度；要求继续或追问未完成的项时接续，无关的消息不接续', () => {
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
    expect(todo).toContain(
      '追问其中某项为什么没有完成、为什么停下时，先用 write_todos 提交清单并认领该项',
    )
    expect(todo).toContain('本次消息与这些项无关时不接续')
    expect(todo).not.toContain('不是继续执行的指令')
    expect(todo).not.toContain('清单还有未完成项时本轮不结束')
    // 任务派发的规则只写在工具参数中，待办注记不重复。
    expect(todo).not.toContain('parentTodo')
  })

  /** 用户在下一轮补齐条件时，模型需要知道每个受阻项在等什么、每个失败项为何失败，才能接续。 */
  test('受阻与失败的待办在快照中写明受阻条件与失败原因', () => {
    const notes = buildTailNotes({
      ...base,
      todos: [
        { id: 'todo_1', content: '生成样张', status: 'completed' },
        {
          id: 'todo_2',
          content: '生成其余 17 页',
          status: 'blocked',
          blocker: 'spend',
          need: '用户同意生成其余 17 页的费用',
        },
        {
          id: 'todo_3',
          content: '生成第 4 页',
          status: 'failed',
          failure: 'denied',
          cause: 'HTTP 403 无访问权限',
          attempts: '不重试',
        },
      ],
    })
    const todo = notes.at(-1)?.content ?? ''
    expect(todo).toContain('2. [受阻] 生成其余 17 页（花费待确认：用户同意生成其余 17 页的费用）')
    expect(todo).toContain('3. [失败] 生成第 4 页（无法重试：HTTP 403 无访问权限，已尝试：不重试）')
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

/**
 * 原始失败形状：没有任何事项需要用户时，模型结束本轮并询问用户，核对与查找也交给用户；
 * 一次运行失败即停止整项工作。停下的条件分散在系统提示、待办段落与画布工具说明中，
 * 且标准含糊（「实质不同的结果」「需要用户决定的事」）。
 *
 * 第二个原始失败形状（rn_0mw82olx30000u8rlnp）：联动检查仍报 82 条，模型按「处理后仍存在的差异在最终回复中说明，
 * 该项按完成处理」把清单全部标为 completed。完成只在一处定义，未完成的项只能以受阻或失败结束。
 */
describe('完成、停下等待用户与执行失败的判定', () => {
  const prompt = buildSystemPrompt(new Set(['run_command', 'desktop_windows', 'run_canvas']))

  test('完成只定义一次：结果满足要求且已核对；说明差异之后该项仍未完成', () => {
    expect(prompt.split('一项工作完成，指').length).toBe(2)
    expect(prompt).toContain('结果满足用户的要求，并且已经实际核对')
    expect(prompt).toContain(
      '检查器或脚本报告错误、审核未通过、核对发现结果与要求不一致时，该项未完成',
    )
    expect(prompt).toContain('在最终回复中说明差异之后，该项仍未完成')
    expect(prompt).toContain('本轮只有两种结束方式')
    expect(prompt).not.toContain('按完成处理')
  })

  test('受阻四类各定义一次，取值与 write_todos 的 blocker 枚举一致，单步任务同样经由受阻停下', () => {
    expect(TODO_BLOCKERS).toEqual(['spend', 'user_only', 'review', 'irreversible'])
    for (const kind of TODO_BLOCKERS) expect(prompt.split(`- ${kind}：`)).toHaveLength(2)
    expect(prompt).not.toContain('- service：')
    expect(prompt).toContain(
      '停下等待用户只有一种方式：用 write_todos 把该项标为 blocked（单步任务同样如此）',
    )
    expect(prompt).toContain('受阻只有以下四类，每一类都是在等待用户')
    expect(prompt).toContain(
      '清单中没有 pending 与 in_progress 且有受阻项时，在回复中说明需要用户做什么，本轮随即结束',
    )
  })

  test('执行失败按七类处理，取值与 write_todos 的 failure 枚举一致，间隔取自重试间隔表', () => {
    expect(prompt).toContain('执行失败不是受阻，不等待用户')
    for (const kind of TODO_FAILURES) expect(prompt.split(`- ${kind} `)).toHaveLength(2)
    for (const line of [
      '- transient 暂时故障（5xx、429 限流、请求得到应答之前连接中断）：以相同参数在 30 秒、2 分钟、5 分钟后各重试一次。',
      '生成的提交由系统自动重试，回执写明已做的重试；回执报告失败时，按其中的原因决定是否再次运行。',
      '子 agent 的请求已由系统按同一间隔自动重发，失败回执写明重发次数与各次的失败原因；同一接口反复失败时，优先改用其他接口或模型派发。',
      '- invalid_request 请求有误（4xx 参数校验失败、参考图数量不符、引用失效、参数取值无效）：按原因修改输入后重试；同一错误再次出现时换一种改法，共尝试 3 次。',
      '- denied 重试无法解决（余额或额度用尽、403 无访问权限、接口要求重新登录）：不重试。',
      '- unknown 结果未知（请求已发出，但没有收到应答或任务号，或发出后超时）：远端可能已经受理并计费，先取回，不重新提交',
      '- retry_limit 生成结果不符合要求：查明原因，修改提示词后重新运行；同一张卡片的图片最多重新运行 3 次，视频最多 2 次',
      '- no_progress 检查或审核未通过：按报告修改后重新核对；连续三轮修改后问题数没有减少、评分没有提高时停止，attempts 写出每一轮的问题数或评分。',
      '接口返回了明确的 HTTP 错误即请求已得到应答，按前三类处理；请求发出后没有任何应答，或回执写明远端结果未知，按结果未知处理。',
      '原因位于工作区的文件、脚本或画布中且可以修改时，不属于以上任何一类：修改该处后继续执行。',
      '用 write_todos 标为 failed，failure 填写对应的类别，cause 写失败原因，attempts 写做过的尝试及每次的改动',
      '最终回复在一处列出每个失败项的原因、尝试次数与每次的改动，以及仍缺少的内容',
    ]) {
      expect(prompt).toContain(line)
    }
  })

  test('列出不是受阻的情形，几种做法时选择最接近用户意图的一种并在最终回复中说明', () => {
    for (const item of [
      '界面中暂未找到目标',
      '检查器或脚本报告错误',
      '所需信息可以自行查找或核对',
      '存在几种可行做法（选择最接近用户意图的一种，在最终回复中说明）',
      '时长或数量与要求不一致',
      '审核未通过',
    ]) {
      expect(prompt).toContain(item)
    }
    expect(prompt).toContain('需求存在几种理解时，按最接近用户意图的一种执行')
  })

  test('不再出现分散的停止写法：向用户确认、改回 pending 后结束、在回复中提出需要用户决定的事', () => {
    expect(prompt).not.toContain('才向用户确认')
    expect(prompt).not.toContain('改回 pending')
    expect(prompt).not.toContain('需要用户决定的事在回复中提出')
    expect(prompt).not.toContain('以相同参数立即再试一次')
  })

  /**
   * 原始失败形状：用户连续发「为什么不解决？」「为什么又停下来」，模型两轮都以 0 次工具调用结束，
   * 自述「把你上一句当成了只需解释的问题」。成因是系统提示把这类反问归入「只询问原因，不恢复旧任务」。
   * 另一侧（rn_0mw9ivl4b0000vid6ut）：用户提问后模型不回答即连续执行。
   */
  test('追问为什么没有执行即要求完成：先回答再执行；只询问信息或无关时只回答', () => {
    expect(prompt).toContain(
      '用户追问某项工作为什么没有执行、为什么中止、结果为什么未达到要求时，该追问即要求完成这项工作：先简要说明原因，再在同一轮中执行。',
    )
    expect(prompt).toContain('用户只询问信息、所问内容与当前任务无关或明确要求暂停时，只作回答。')
    expect(prompt).toContain('用户的消息包含问题时，开始执行之前先简要回答。')
    expect(prompt).not.toContain('用户只询问原因、进度或要求暂停时，不恢复旧任务')
  })

  /** 原始失败形状（rn_0mw7zod8p0001f21jpy）：用户纠正后本轮唯一的动作是 write_memory。 */
  test('写记忆在完成纠正所要求的修改之后', () => {
    const withMemory = buildSystemPrompt(new Set(['write_memory']))
    expect(withMemory).toContain('先完成本次纠正所要求的修改，再写入记忆。')
  })
})

/**
 * 完成与停下的定义只在系统提示「工作方式」一节。工具说明与系统提示同时发送给模型，
 * 其中任何一处另写一种收尾方式，模型就会按较宽松的一种结束本轮：账本中的实例是画布工具说明的
 * 「该节点按完成处理」与系统提示的「差异在最终回复中说明，该项按完成处理」。
 * 本组对全部内置工具的说明与系统提示一并扫描，新增工具写入这类句式时门禁失败。
 */
describe('工具说明不另写收尾方式', () => {
  const registry = new ToolRegistry()
  registerToolCatalog(registry, ['image', 'video', 'audio'])
  const specs = registry.list()
  const prompt = buildSystemPrompt(new Set(specs.map((s) => s.name)))
  const texts = [
    { name: '系统提示', text: prompt },
    ...specs.map((s) => ({ name: s.name, text: s.description })),
  ]
  const EXITS = [
    '按完成处理',
    '视为完成',
    '停止并告知用户',
    '请告知用户',
    '并等待用户',
    '由用户决定',
    '先询问用户',
    '向用户确认',
    '带问题继续',
    '不恢复旧任务',
  ]

  test('注册的内置工具包含画布、桌面与待办：扫描范围覆盖已知的停止写法所在位置', () => {
    for (const name of [
      'run_canvas',
      'desktop_windows',
      'desktop_act',
      'write_todos',
      'update_goal',
    ]) {
      expect(specs.some((s) => s.name === name)).toBe(true)
    }
  })

  for (const phrase of EXITS) {
    test(`不出现「${phrase}」`, () => {
      const hits = texts.filter((t) => t.text.includes(phrase)).map((t) => t.name)
      expect(hits).toEqual([])
    })
  }
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
   * 原始失败形状：用户要求「额外开一个分支会话」，模型只有 subagent 可用，派发了临时子 agent，
   * 会话列表中没有出现新会话。
   */
  test('注册了 new_conversation 时写明新开会话的用法，并与子 agent 区分', () => {
    const line = buildSystemPrompt(new Set(['new_conversation', 'subagent']))
      .split('\n')
      .find((l) => l.startsWith('- 新开会话：'))
    expect(line).toContain('分支会话')
    expect(line).toContain('new_conversation')
    expect(line).toContain('会话列表')
    expect(line).toContain('subagent')
    expect(buildSystemPrompt(new Set(['subagent']))).not.toContain('new_conversation')
  })

  /**
   * 原始失败形状（2026-11-19 真实模型回归）：Office 一行写「制作前先用 read_office_guide 获取说明」，read_office_guide 按需，
   * DeepSeek 与 Claude 按该行直接以空参数调用，报「缺少必填参数：format」后才读取定义。
   */
  test('按需工具对应的能力行注明先用 load_tool 读取定义，常驻工具的行不变', () => {
    const prompt = buildSystemPrompt(
      new Set(['run_command', 'read_office_guide', 'load_tool']),
      undefined,
      new Set(['read_office_guide']),
    )
    const office = prompt.split('\n').find((line) => line.startsWith('- Office 操作说明'))
    expect(office).toContain('read_office_guide 为按需工具，调用前先用 load_tool 读取定义。')
    const command = prompt.split('\n').find((line) => line.startsWith('- 命令：'))
    expect(command).not.toContain('按需工具')
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
    // 原始失败形状：模型无法看到微信搜索框弹出的结果列表，改为请用户自行打开会话。截图已合成同一应用的弹出窗口。
    expect(prompt).toContain(
      '截图包含同一应用位于该窗口之上的下拉框、菜单与搜索结果等弹出窗口，回执写明其位置；输入文字后依据回执附带的截图查看弹出的内容，再按图点击其中的项目。',
    )
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
   * 原始失败形状：「自动审批」下模型可以用电脑控制点击 qywork 输入区的权限模式开关，把会话切换为完全访问。
   * 该行只写定义：自身窗口在两种模式下各自可做什么，不写禁令。
   */
  test('桌面一行定义 qywork 自身窗口在两种权限模式下的可操作范围', () => {
    const prompt = buildSystemPrompt(new Set(['run_command', 'desktop_windows']))
    expect(prompt).toContain(
      'qywork 自身的窗口在「自动审批」模式下可观察、不可操作，在「完全访问」模式下可观察、可操作。',
    )
    expect(prompt).not.toContain('观察与操作 qywork 窗口')
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
        'cancel_canvas',
        'capture_canvas_frame',
        'desktop_windows',
      ]),
    )
    expect(prompt).toContain('*.canvas.json')
    expect(prompt).toContain('界面画布页呈现该文件的内容')
    expect(prompt).toContain('使用 read_canvas')
    expect(prompt).toContain('使用 create_canvas')
    expect(prompt).toContain('node 传生成卡名称数组，单张卡也写成数组')
    expect(prompt).toContain('使用 edit_canvas')
    expect(prompt).toContain('使用 run_canvas')
    expect(prompt).toContain('使用 retrieve_canvas')
    expect(prompt).toContain('使用 cancel_canvas')
    expect(prompt).toContain('使用 capture_canvas_frame')
    expect(prompt).not.toContain('不得使用电脑控制')
    expect(prompt.indexOf('- 画布：')).toBeLessThan(prompt.indexOf('- 电脑控制：'))
    expect(buildSystemPrompt(new Set(['desktop_windows']))).not.toContain('read_canvas')
    expect(buildSystemPrompt(new Set(['desktop_windows']))).not.toContain('create_canvas')
  })

  /**
   * 原始失败形状：用户要求打开页面查看，模型认为用户无法看到内置浏览器的页面，用 `start` 启动系统 Chrome，
   * 之后用电脑控制激活窗口、按 F5、截图。能力段缺少内置浏览器一行，而电脑控制一行写有完整用法。
   */
  test('注册了浏览器工具时写明页面显示在右侧面板、用户可见，并排在电脑控制之前；未注册时不出现', () => {
    const prompt = buildSystemPrompt(new Set(['browser_tabs', 'desktop_windows']))
    expect(prompt).toContain('- 内置浏览器：')
    expect(prompt).toContain('打开的页面以页签显示在界面右侧面板中，用户可以直接查看')
    expect(prompt.indexOf('- 内置浏览器：')).toBeLessThan(prompt.indexOf('- 电脑控制：'))
    expect(buildSystemPrompt(new Set(['desktop_windows']))).not.toContain('内置浏览器')
  })

  /**
   * 原始失败形状：模型向用户已打开的 cmd 窗口输入「Docker Desktop」，又在 Windows Terminal 中按 Win+R，
   * 都是为了启动应用，最后用 run_command 的 `start` 才成功。电脑控制一行写明执行命令与启动应用的工具，
   * 以及需要操作终端窗口的情形。
   */
  test('电脑控制一行写明执行命令与启动应用优先使用 run_command，以及操作终端窗口的情形', () => {
    const prompt = buildSystemPrompt(new Set(['run_command', 'desktop_windows']))
    expect(prompt).toContain('执行命令、启动应用优先使用 run_command')
    expect(prompt).toContain('任务针对已打开终端中正在运行的程序')
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

/** 审计器本身的用例在 `agent/src/prefix-audit.test.ts`；本组审计的是真实的系统提示词，产生费用的是它。 */
describe('审计真实的系统提示词', () => {
  /** 门槛工具全部存在，能力段全部发出：审计的是最长的前缀。 */
  const GATES = [
    'run_command',
    'write_memory',
    'move_memory',
    'read_skill',
    'write_skill',
    'move_skill',
    'write_mcp_server',
    'move_mcp_server',
    'load_tool',
    'subagent',
    'workflow',
    'create_schedule',
    'read_goal',
    'read_history',
    'web_search',
  ]
  const ALL = new Set(GATES)

  test('三层冻结前缀中没有本身会变化的字段', () => {
    expect(auditFrozenText(buildSystemPrompt(ALL))).toEqual([])
    expect(auditFrozenText(buildSystemPrompt(ALL, 128_000))).toEqual([])
  })

  test('两次构造逐字节相同', () => {
    expect(buildSystemPrompt(ALL)).toBe(buildSystemPrompt(ALL))
  })

  /** 缺少任何一条，模型都无法得知自己具备该能力，因此每个类目都必须发出。 */
  test('能力段向模型说明每个类目', () => {
    const p = buildSystemPrompt(ALL)
    for (const tool of GATES) expect(p).toContain(tool)
    // 两个派发工具的选择判据必须写入提示词：单项任务用一个子 agent；两个及以上、需要验收或有先后依赖时用 workflow。
    expect(p).toContain('单项任务用 subagent 委派给一个子 agent')
    expect(p).toContain('两个及以上子 agent')
    expect(p).toContain('revise 让指定的节点在其原有子会话中继续')
    expect(p).toContain('批准之后仍可 revise')
    // 完成是事件：两种派发方式都要说明回执会自动送达，否则模型会为等待回执反复调用。
    expect(p).toContain('回执以消息形式送达本会话，不要为等待回执反复调用')
    expect(p).toContain('各节点的回执与检查点回执都以消息形式送达本会话')
    // CLI 的派发判据：只在用户点名或明确要求时派发，不是默认目标。
    expect(p).toContain('仅在用户用 `@cli:id` 点名或明确要求时派发')
  })

  /**
   * 复现原始失败形状：`run_command` / `subagent` / `workflow` / `load_tool`
   * 按通道注册，固定写入提示词会使没有对应通道的会话读取到不存在的工具。
   */
  test('缺少通道时不发送对应行，其余照常', () => {
    const p = buildSystemPrompt(new Set(['write_memory', 'read_skill']))
    expect(p).not.toContain('run_command')
    expect(p).not.toContain('subagent')
    expect(p).not.toContain('load_tool')
    expect(p).toContain('write_memory')
    expect(p).toContain('read_skill')

    // 没有任何门槛工具时整段不出现，不保留空标题。
    expect(buildSystemPrompt(new Set())).not.toContain('## 能力')
  })

  test('输入区显式引用绑定技能、外部工具与子 agent', () => {
    const p = buildSystemPrompt(
      new Set(['read_skill', 'load_tool', 'define_role', 'subagent', 'mcp__github__search']),
    )
    expect(p).toContain('#技能名')
    expect(p).toContain('@工具注册名')
    expect(p).toContain('@角色id')
    expect(p).toContain('/role')
    expect(p).toContain('可长期复用')
    expect(p).not.toContain('`@subagent`')
    expect(p).toContain('先用 load_tool 读取完整定义')
  })

  /**
   * 上下文末尾注记应包含日期。本用例反向验证：会变化的字段确实位于
   * 断点之外。本用例通过才能说明分层确实生效，而不是两侧都不含可变字段而看似正确。
   */
  test('上下文末尾注记包含会变化的内容（验证分层生效）', () => {
    const notes = buildTailNotes({ workspaceRoot: '/tmp/ws', platform: 'linux', mode: 'auto' })
      .map((n) => n.content)
      .join('\n')
    const kinds = auditFrozenText(notes).map((h) => h.kind)
    expect(kinds).toContain('date')
    expect(kinds).toContain('abs-path')
  })
})
