/**
 * 四个内置桌面工具。**覆盖范围**：`desktop.ts` 的参数校验、目标唯一匹配、动作前置
 * 条件、三态回执透传与注册元数据。
 *
 * 端口那一侧由 `packages/server/src/desktop/bridge.test.ts` 覆盖。这里用一份记账假
 * 端口：断言的是「交给端口的是什么」与「有没有交下去」，不是调了几次。
 */

import { describe, expect, test } from 'bun:test'
import type {
  DesktopActResult,
  DesktopElement,
  DesktopPort,
  DesktopRefusal,
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

const 输入框: DesktopElement = {
  ref: 'w.0.1',
  role: 'edit',
  name: '姓名',
  automationId: 'nameBox',
  value: '',
  enabled: true,
  offscreen: false,
  actions: ['set_value'],
}
const 保存按钮: DesktopElement = {
  ref: 'w.0.2',
  role: 'button',
  name: '保存',
  automationId: 'save',
  enabled: true,
  offscreen: false,
  actions: ['invoke'],
}
const 另一个保存: DesktopElement = { ...保存按钮, ref: 'w.0.3', automationId: 'save2' }
const 灰按钮: DesktopElement = {
  ...保存按钮,
  ref: 'w.0.4',
  name: '提交',
  automationId: 'submit',
  enabled: false,
}

const TABLE = [输入框, 保存按钮, 另一个保存, 灰按钮]

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
    return { dispatch: 'submitted', actionId: 'da_1', element: { ...输入框, value: '张三' } }
  }
  const base: DesktopPort = {
    windows: async () => {
      note('windows', null)
      return [{ windowId: 'dw_1', app: '记事本', title: '未命名' }]
    },
    observe: async (input) => {
      note('observe', input)
      return {
        windowId: input.windowId,
        app: '记事本',
        title: '未命名',
        observationId: 'do_1',
        capturedAt: 1,
        elements: TABLE,
        truncated: false,
        truncatedBy: [],
      }
    },
    elements: (windowId, observationId) =>
      windowId === 'dw_1' && observationId === 'do_1' ? TABLE : null,
    setValue: async (input) => acted(input),
    invoke: async (input) => acted(input),
    wait: async (input) => {
      note('wait', input)
      return { found: true, element: 保存按钮 }
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
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.0.2' },
      ctxWith(port, controller.signal),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false, errorKind: 'aborted' })
    expect(calls).toEqual([])
  })
})

describe('目标解析', () => {
  test('按 ref 唯一命中时才把它交给端口', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'set_value', ref: 'w.0.1', value: '张三' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls).toEqual([
      {
        method: 'act',
        input: { windowId: 'dw_1', observationId: 'do_1', ref: 'w.0.1', value: '张三' },
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
    expect(calls[0]).toMatchObject({ input: { ref: 'w.0.3' } })
  })

  /** 同名两个按钮，挑第一个就是在另一个控件上执行动作，而且不报错。 */
  test('同名歧义时不执行，把候选交回模型', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', name: '保存' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_target_ambiguous' })
    expect(r.message).toContain('w.0.2')
    expect(r.message).toContain('w.0.3')
    expect(calls).toEqual([])
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
      { windowId: 'dw_1', observationId: 'do_0', action: 'invoke', ref: 'w.0.2' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_observation_stale' })
    expect(calls).toEqual([])
  })

  test('这份观察里没有的 ref 直接拒绝', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.9.9' },
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
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.0.4' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_precondition' })
    expect(calls).toEqual([])
  })

  test('控件不支持这个动作时不派发，并说清它支持什么', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'set_value', ref: 'w.0.2', value: 'x' },
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
      { windowId: 'dw_1', observationId: 'do_1', action: 'set_value', ref: 'w.0.1' },
      ctxWith(port),
    )
    expect(missing).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])

    await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'set_value', ref: 'w.0.1', value: '' },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({ input: { value: '' } })
  })

  test('invoke 带 value 是写错，不静默忽略', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.0.2', value: 'x' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])
  })
})

describe('三态回执透传', () => {
  test('submitted 是成功，结果里带动作身份与重读', async () => {
    const { port } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.0.2' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.data).toMatchObject({ dispatch: 'submitted', actionId: 'da_1' })
  })

  test('not_dispatched 是没执行，executed 为假', async () => {
    const { port } = fakeDesktop({
      invoke: async () => ({
        dispatch: 'not_dispatched',
        actionId: 'da_2',
        reason: 'read_only',
        element: null,
        observationError: '没有重读',
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.0.2' },
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
        element: null,
        observationError: '宿主不可用，动作之后没有重读',
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.0.2' },
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
        element: null,
        observationError: '窗口已关闭',
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.0.2' },
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
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.0.2' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_unavailable' })
  })
})

describe('观察与等待', () => {
  test('观察的上限按参数夹住，读不出数就是参数错', async () => {
    const { port, calls } = fakeDesktop()
    await run(desktopObserveTool, { windowId: 'dw_1', maxNodes: 99_999 }, ctxWith(port))
    expect(calls[0]).toMatchObject({ input: { windowId: 'dw_1', maxNodes: 4000 } })

    const bad = await run(desktopObserveTool, { windowId: 'dw_1', maxDepth: '一堆' }, ctxWith(port))
    expect(bad).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
  })

  test('截断如实报出来，不让调用方读成「没有」', async () => {
    const { port } = fakeDesktop({
      observe: async (input) => ({
        windowId: input.windowId,
        app: '记事本',
        title: '未命名',
        observationId: 'do_1',
        capturedAt: 1,
        elements: TABLE,
        truncated: true,
        truncatedBy: ['max_nodes'],
      }),
    })
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(r.message).toContain('max_nodes')
  })

  test('等待按同一套目标解析，until=value 少了 value 是参数错', async () => {
    const { port, calls } = fakeDesktop()
    const bad = await run(
      desktopWaitTool,
      { windowId: 'dw_1', observationId: 'do_1', until: 'value', ref: 'w.0.1' },
      ctxWith(port),
    )
    expect(bad).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])

    await run(
      desktopWaitTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        until: 'enabled',
        automationId: 'save',
        timeoutMs: 999_999,
      },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({
      method: 'wait',
      input: { ref: 'w.0.2', until: 'enabled', timeoutMs: 60_000 },
    })
  })

  test('没等到不是执行失败，executed 为假', async () => {
    const { port } = fakeDesktop({
      wait: async () => ({ found: false, reason: 'timeout', element: 灰按钮 }),
    })
    const r = await run(
      desktopWaitTool,
      { windowId: 'dw_1', observationId: 'do_1', until: 'enabled', ref: 'w.0.4' },
      ctxWith(port),
    )
    expect(r).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'desktop_wait_timeout',
    })
  })
})

test('窗口发现把不透明 id 与应用名交给模型', async () => {
  const { port } = fakeDesktop()
  const r = await run(desktopWindowsTool, {}, ctxWith(port))
  expect(r.status).toBe('success')
  expect(r.data).toEqual({ windows: [{ windowId: 'dw_1', app: '记事本', title: '未命名' }] })
})
