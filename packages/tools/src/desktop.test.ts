/**
 * 四个内置桌面工具。**覆盖范围**：`desktop.ts` 的参数校验、局部查询参数、层级消歧回执、
 * 动作前置条件、三态回执与动作后观察的透传、等待条件与终态、注册元数据。
 *
 * 端口那一侧由 `packages/server/src/desktop/bridge.test.ts` 与同目录的
 * `coordinator.test.ts` 覆盖。这里用一份记账假端口：断言的是「交给端口的是什么」与
 * 「有没有交下去」，不是调了几次。
 */

import { describe, expect, test } from 'bun:test'
import type {
  DesktopActResult,
  DesktopElement,
  DesktopPort,
  DesktopRefusal,
  DesktopSnapshot,
  ToolContext,
  ToolOutcome,
  ToolSpec,
} from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import {
  desktopActTool,
  desktopObserveTool,
  desktopTools,
  desktopWaitTool,
  desktopWindowsTool,
} from './desktop.ts'

/** 窗口根。同名按钮分在两个分组下，只有祖先路径区分得开。 */
const 窗口: DesktopElement = {
  ref: 'w#1',
  depth: 0,
  role: 'window',
  name: '另存为',
  automationId: '',
  enabled: true,
  offscreen: false,
  actions: [],
}
const 工具栏: DesktopElement = {
  ref: 'w.0#2',
  parentRef: 'w#1',
  depth: 1,
  role: 'tool_bar',
  name: '',
  automationId: 'bar',
  enabled: true,
  offscreen: false,
  actions: [],
}
const 工具栏保存: DesktopElement = {
  ref: 'w.0.0#3',
  parentRef: 'w.0#2',
  depth: 2,
  role: 'button',
  name: '保存',
  automationId: 'save',
  enabled: true,
  offscreen: false,
  actions: ['invoke'],
}
const 表单组: DesktopElement = {
  ref: 'w.1#4',
  parentRef: 'w#1',
  depth: 1,
  role: 'group',
  name: '文件',
  automationId: 'form',
  enabled: true,
  offscreen: false,
  actions: [],
}
const 输入框: DesktopElement = {
  ref: 'w.1.0#5',
  parentRef: 'w.1#4',
  depth: 2,
  role: 'edit',
  name: '姓名',
  automationId: 'nameBox',
  value: '',
  enabled: true,
  offscreen: false,
  actions: ['set_value'],
}
const 表单保存: DesktopElement = {
  ref: 'w.1.1#6',
  parentRef: 'w.1#4',
  depth: 2,
  role: 'button',
  name: '保存',
  automationId: 'save2',
  enabled: true,
  offscreen: false,
  actions: ['invoke'],
}
const 灰按钮: DesktopElement = {
  ref: 'w.1.2#7',
  parentRef: 'w.1#4',
  depth: 2,
  role: 'button',
  name: '提交',
  automationId: 'submit',
  enabled: false,
  offscreen: false,
  actions: ['invoke'],
}

const TABLE = [窗口, 工具栏, 工具栏保存, 表单组, 输入框, 表单保存, 灰按钮]

function snapshot(over: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return {
    windowId: 'dw_1',
    app: '记事本',
    title: '未命名',
    observationId: 'do_1',
    capturedAt: 1,
    elements: TABLE,
    truncated: false,
    truncatedBy: [],
    filteredBy: [],
    visited: TABLE.length,
    windowEnabled: true,
    ...over,
  }
}

interface Recorded {
  method: string
  input: unknown
}

function fakeDesktop(over: Partial<DesktopPort> = {}): {
  port: DesktopPort
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const note = (method: string, input: unknown) => {
    calls.push({ method, input })
  }
  const acted = (input: unknown): DesktopActResult => {
    note('act', input)
    return {
      dispatch: 'submitted',
      actionId: 'da_1',
      observation: snapshot({
        observationId: 'do_2',
        elements: [{ ...输入框, value: '张三' }],
      }),
    }
  }
  const base: DesktopPort = {
    windows: async () => {
      note('windows', null)
      return [{ windowId: 'dw_1', app: '记事本', title: '未命名' }]
    },
    observe: async (input) => {
      note('observe', input)
      return snapshot({ windowId: input.windowId })
    },
    elements: (windowId, observationId) =>
      windowId === 'dw_1' && observationId === 'do_1' ? TABLE : null,
    setValue: async (input) => acted(input),
    invoke: async (input) => acted(input),
    wait: async (input) => {
      note('wait', input)
      return { found: true, observation: snapshot({ observationId: 'do_3' }) }
    },
    release: async () => {},
  }
  return { port: { ...base, ...over }, calls }
}

function ctxWith(desktop?: DesktopPort, signal = new AbortController().signal): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal,
    emit: () => {},
    requestPermission: async () => true,
    ...(desktop ? { desktop } : {}),
  }
}

function run(
  spec: ToolSpec,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  return spec.fn(args, ctx)
}

describe('注册元数据', () => {
  test('四个工具都在 desktop 类目下，权限效果单列', () => {
    expect(desktopTools.map((t) => t.name)).toEqual([
      'desktop_windows',
      'desktop_observe',
      'desktop_act',
      'desktop_wait',
    ])
    for (const spec of desktopTools) {
      expect(spec.category).toBe('desktop')
      expect(spec.permissionEffect).toBe('desktop')
    }
  })

  /** 句柄进了参数表，模型就能自己拼一个目标——那条路必须不存在。 */
  test('参数表里没有窗口句柄，只有不透明 id', () => {
    for (const spec of desktopTools) {
      const props = (spec.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      expect(Object.keys(props)).not.toContain('window')
      expect(Object.keys(props)).not.toContain('handle')
      expect(Object.keys(props)).not.toContain('pid')
    }
  })
})

describe('没有端口与已停止', () => {
  test('没有端口时如实报，不当成执行过', async () => {
    const r = await run(desktopWindowsTool, {}, ctxWith())
    expect(r).toMatchObject({ status: 'failure', executed: false, errorKind: 'unsupported' })
  })

  test('这一轮已停止时不再发起新动作', async () => {
    const controller = new AbortController()
    controller.abort()
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.0.0#3' },
      ctxWith(port, controller.signal),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false, errorKind: 'aborted' })
    expect(calls).toEqual([])
  })
})

describe('目标解析与层级消歧', () => {
  test('按 ref 唯一命中时才把它交给端口', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_value',
        ref: 'w.1.0#5',
        value: '张三',
      },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls).toEqual([
      {
        method: 'act',
        input: { windowId: 'dw_1', observationId: 'do_1', ref: 'w.1.0#5', value: '张三' },
      },
    ])
  })

  test('按 automationId 唯一命中', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', automationId: 'save2' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls[0]).toMatchObject({ input: { ref: 'w.1.1#6' } })
  })

  /**
   * 同名两个按钮，挑第一个就是在另一个控件上执行动作，而且不报错。
   *
   * 回执要能让模型分得开这两个：只有祖先路径说得出「一个在工具栏里、一个在文件组里」。
   */
  test('同名歧义时不执行，候选带祖先路径交回模型', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', name: '保存' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_target_ambiguous' })
    expect(r.message).toContain('w.0.0#3')
    expect(r.message).toContain('w.1.1#6')
    expect(r.message).toContain('window「另存为」 > tool_bar')
    expect(r.message).toContain('window「另存为」 > group「文件」')
    expect(calls).toEqual([])
  })

  /** 祖先不在表里时走到哪算哪，不编一段路径出来。 */
  test('父控件不在这份表里时祖先路径只写到断点', async () => {
    const partial = [表单保存, 灰按钮].map((e) => ({ ...e }))
    const { port } = fakeDesktop({
      elements: () => [...partial, { ...工具栏保存 }],
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', name: '保存' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ errorKind: 'desktop_target_ambiguous' })
    expect(r.message).not.toContain('位于')
  })

  test('加 role 收窄之后仍然不唯一就还是歧义，命中不到就是缺失', async () => {
    const { port } = fakeDesktop()
    const missing = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', name: '查无此名' },
      ctxWith(port),
    )
    expect(missing).toMatchObject({ executed: false, errorKind: 'desktop_target_missing' })
  })

  test('观察过期时要求重新观察，一帧都不发', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_0', action: 'invoke', ref: 'w.0.0#3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_observation_stale' })
    expect(calls).toEqual([])
  })

  test('这份观察里没有的 ref 直接拒绝', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.9.9#9' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_ref_unknown' })
    expect(calls).toEqual([])
  })
})

describe('动作前置条件', () => {
  test('控件被禁用时不派发', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.1.2#7' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_precondition' })
    expect(calls).toEqual([])
  })

  test('控件不支持这个动作时不派发，并说清它支持什么', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'set_value', ref: 'w.0.0#3', value: 'x' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_action_unsupported' })
    expect(r.message).toContain('invoke')
    expect(calls).toEqual([])
  })

  test('set_value 少了 value 是参数错；空串是清空，照发', async () => {
    const { port, calls } = fakeDesktop()
    const missing = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'set_value', ref: 'w.1.0#5' },
      ctxWith(port),
    )
    expect(missing).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])

    await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'set_value', ref: 'w.1.0#5', value: '' },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({ input: { value: '' } })
  })

  test('invoke 带 value 是写错，不静默忽略', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.0.0#3', value: 'x' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])
  })
})

describe('三态回执与动作后观察', () => {
  /** 动作同次带回新观察：模型不必再单独 observe 就能接着发下一个动作。 */
  test('submitted 是成功，结果里带动作身份与新的观察编号', async () => {
    const { port } = fakeDesktop()
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_value',
        ref: 'w.1.0#5',
        value: '张三',
      },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.data).toMatchObject({ dispatch: 'submitted', actionId: 'da_1' })
    const observation = (r.data as { observation: DesktopSnapshot }).observation
    expect(observation.observationId).toBe('do_2')
    expect(r.message).toContain('do_2')
    // 目标控件的新值直接出现在回执里，不用再读一次。
    expect(r.message).toContain('张三')
  })

  test('not_dispatched 是没执行，executed 为假', async () => {
    const { port } = fakeDesktop({
      invoke: async () => ({
        dispatch: 'not_dispatched',
        actionId: 'da_2',
        reason: 'read_only',
        observation: null,
        observationError: '动作没有派发，没有重读',
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.0.0#3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'desktop_not_dispatched',
    })
    expect(r.message).toContain('read_only')
    expect(r.data).toMatchObject({ dispatch: 'not_dispatched' })
  })

  /** 结果未知是禁止重发的那一侧：它必须记成已执行。 */
  test('unknown 记成已执行，并要求先重新观察', async () => {
    const { port } = fakeDesktop({
      invoke: async () => ({
        dispatch: 'unknown',
        actionId: 'da_3',
        reason: 'provider 无响应',
        observation: null,
        observationError: '宿主不可用，动作之后没有重读',
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.0.0#3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: true, errorKind: 'desktop_unknown' })
    expect(r.message).toContain('不要重放')
    expect(r.data).toMatchObject({ dispatch: 'unknown', actionId: 'da_3' })
  })

  /** 重读失败不改执行事实：动作已经发出去了。 */
  test('submitted 但重读失败仍记已执行', async () => {
    const { port } = fakeDesktop({
      invoke: async () => ({
        dispatch: 'submitted',
        actionId: 'da_4',
        observation: null,
        observationError: '窗口已关闭',
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.0.0#3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({
      status: 'failure',
      executed: true,
      errorKind: 'desktop_observation_unavailable',
    })
    expect(r.data).toMatchObject({ dispatch: 'submitted' })
  })

  /** 端口自己声明的执行前拒绝优先于「调进去过」这一判据。 */
  test('端口按 DesktopRefusal 拒绝时不记成已执行', async () => {
    class Refused extends Error implements DesktopRefusal {
      readonly errorKind = 'desktop_unavailable' as const
      readonly executed = false as const
    }
    const { port } = fakeDesktop({
      invoke: async () => {
        throw new Refused('本次执行的电脑操作已经结束')
      },
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.0.0#3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_unavailable' })
  })
})

describe('局部查询与字段选择', () => {
  test('子树根、角色、文字与字段选择逐项交给端口', async () => {
    const { port, calls } = fakeDesktop()
    await run(
      desktopObserveTool,
      {
        windowId: 'dw_1',
        root: 'w.1#4',
        role: 'button',
        query: '保存',
        includeValue: false,
      },
      ctxWith(port),
    )
    expect(calls[0]).toEqual({
      method: 'observe',
      input: {
        windowId: 'dw_1',
        root: 'w.1#4',
        role: 'button',
        query: '保存',
        includeValue: false,
      },
    })
  })

  test('没给筛选参数时一个都不往下传', async () => {
    const { port, calls } = fakeDesktop()
    await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(calls[0]).toEqual({ method: 'observe', input: { windowId: 'dw_1' } })
  })

  test('观察的上限按参数夹住，读不出数就是参数错', async () => {
    const { port, calls } = fakeDesktop()
    await run(desktopObserveTool, { windowId: 'dw_1', maxNodes: 99_999 }, ctxWith(port))
    expect(calls[0]).toMatchObject({ input: { windowId: 'dw_1', maxNodes: 4000 } })

    const bad = await run(desktopObserveTool, { windowId: 'dw_1', maxDepth: '很多' }, ctxWith(port))
    expect(bad).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
  })

  /** 截断与筛选是两件事：一个说「没读全」，一个说「挡掉了」，回执里各说一次。 */
  test('截断与筛选分别如实报出来', async () => {
    const { port } = fakeDesktop({
      observe: async (input) =>
        snapshot({
          windowId: input.windowId,
          truncated: true,
          truncatedBy: ['max_nodes'],
          filteredBy: ['role=button', 'nameContains=保存'],
          visited: 900,
        }),
    })
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(r.message).toContain('max_nodes')
    expect(r.message).toContain('role=button')
    expect(r.data).toMatchObject({ visited: 900 })
  })

  /** 模态窗口挡住时控件一个都动不了，这一句必须出现在读数里。 */
  test('窗口被挡住时观察如实说明', async () => {
    const { port } = fakeDesktop({
      observe: async (input) => snapshot({ windowId: input.windowId, windowEnabled: false }),
    })
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(r.message).toContain('模态窗口')
  })
})

describe('等待', () => {
  test('盯已知控件的条件按同一套目标解析，参数逐项交给端口', async () => {
    const { port, calls } = fakeDesktop()
    await run(
      desktopWaitTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        until: 'enabled',
        automationId: 'save2',
        timeoutMs: 999_999,
      },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({
      method: 'wait',
      input: { ref: 'w.1.1#6', until: 'enabled', timeoutMs: 60_000 },
    })
  })

  test('until=value 少了 value 是参数错', async () => {
    const { port, calls } = fakeDesktop()
    const bad = await run(
      desktopWaitTool,
      { windowId: 'dw_1', observationId: 'do_1', until: 'value', ref: 'w.1.0#5' },
      ctxWith(port),
    )
    expect(bad).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])
  })

  /** 等的是还不存在的控件或窗口，就不该要求它先出现在某一份观察里。 */
  test('appears 与 window 不解析已有控件，按文字条件交给端口', async () => {
    const { port, calls } = fakeDesktop()
    await run(
      desktopWaitTool,
      { windowId: 'dw_1', observationId: 'do_1', until: 'appears', name: '完成', role: 'button' },
      ctxWith(port),
    )
    // appears 找的是控件文字，window 找的是窗口标题：两种条件落在不同字段上，不能混。
    expect(calls[0]).toMatchObject({
      method: 'wait',
      input: { until: 'appears', query: '完成', role: 'button' },
    })
    expect((calls[0]?.input as { ref?: string }).ref).toBeUndefined()

    await run(
      desktopWaitTool,
      { windowId: 'dw_1', observationId: 'do_1', until: 'window', name: '另存为' },
      ctxWith(port),
    )
    expect(calls[1]).toMatchObject({ method: 'wait', input: { until: 'window', title: '另存为' } })
    expect((calls[1]?.input as { query?: string }).query).toBeUndefined()
  })

  test('appears 与 window 缺了条件就是参数错', async () => {
    const { port, calls } = fakeDesktop()
    for (const args of [{ until: 'window' }, { until: 'appears' }]) {
      const r = await run(
        desktopWaitTool,
        { windowId: 'dw_1', observationId: 'do_1', ...args },
        ctxWith(port),
      )
      expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    }
    expect(calls).toEqual([])
  })

  test('等到了带回新的观察编号', async () => {
    const { port } = fakeDesktop()
    const r = await run(
      desktopWaitTool,
      { windowId: 'dw_1', observationId: 'do_1', until: 'enabled', ref: 'w.1.1#6' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.message).toContain('do_3')
  })

  test('到期没等到不是执行失败，executed 为假，并带回当时的控件表', async () => {
    const { port } = fakeDesktop({
      wait: async () => ({
        found: false,
        reason: 'timeout',
        observation: snapshot({ observationId: 'do_9' }),
      }),
    })
    const r = await run(
      desktopWaitTool,
      { windowId: 'dw_1', observationId: 'do_1', until: 'enabled', ref: 'w.1.2#7' },
      ctxWith(port),
    )
    expect(r).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'desktop_wait_timeout',
    })
    expect(r.data).toMatchObject({ found: false, reason: 'timeout' })
    expect(r.message).toContain('do_9')
  })

  test('被撤销时如实回撤销，不当成超时', async () => {
    const { port } = fakeDesktop({
      wait: async () => ({
        found: false,
        reason: 'cancelled',
        observation: null,
        observationError: '本次执行的电脑操作已经结束',
      }),
    })
    const r = await run(
      desktopWaitTool,
      { windowId: 'dw_1', observationId: 'do_1', until: 'gone', ref: 'w.1.2#7' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_observation_unavailable' })
    expect(r.data).toMatchObject({ reason: 'cancelled' })
  })
})

test('窗口发现把不透明 id 与应用名交给模型', async () => {
  const { port } = fakeDesktop()
  const r = await run(desktopWindowsTool, {}, ctxWith(port))
  expect(r.status).toBe('success')
  expect(r.data).toEqual({ windows: [{ windowId: 'dw_1', app: '记事本', title: '未命名' }] })
})
