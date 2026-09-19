/**
 * 五个内置桌面工具。**覆盖范围**：`desktop.ts` 的参数校验、局部查询参数、层级消歧回执、
 * 动作前置条件、三态回执与动作后观察的透传、选择容器的选中项渲染、等待条件与终态、
 * 注册元数据，以及采集模式、
 * 两种取景、图片走 `images` 通道、几何与图像尺寸的核对、不收图片的模型，
 * 以及有限动作序列的逐步执行、引用接续、后置条件、七种停止边界与 `executed` 语义。
 *
 * 端口那一侧由 `packages/server/src/desktop/bridge.test.ts` 与同目录的
 * `coordinator.test.ts` 覆盖。这里用一份记账假端口：断言的是「交给端口的是什么」与
 * 「有没有交下去」，不是调了几次。
 */

import { describe, expect, test } from 'bun:test'
import type {
  DesktopActResult,
  DesktopElement,
  DesktopImage,
  DesktopPort,
  DesktopRefusal,
  DesktopSnapshot,
  ToolContext,
  ToolOutcome,
  ToolSpec,
} from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import type { DesktopAction } from '@qywork/core'
import {
  desktopActSequenceTool,
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
  actions: [{ action: 'invoke', delivery: ['background'] }],
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
  rect: { x: 300, y: 200, width: 120, height: 24 },
  actions: [{ action: 'set_value', delivery: ['background'] }],
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
  actions: [{ action: 'invoke', delivery: ['background'] }],
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
  actions: [{ action: 'invoke', delivery: ['background'] }],
}

const 滑块: DesktopElement = {
  ref: 'w.2#8',
  parentRef: 'w#1',
  depth: 1,
  role: 'slider',
  name: '音量',
  automationId: 'slider',
  enabled: true,
  offscreen: false,
  actions: [{ action: 'set_range_value', delivery: ['background'] }],
  range: { value: 20, min: 0, max: 100, smallChange: 1, largeChange: 10 },
}
const 进度条: DesktopElement = {
  ref: 'w.3#9',
  parentRef: 'w#1',
  depth: 1,
  role: 'progress_bar',
  name: '进度',
  automationId: 'progress',
  enabled: true,
  offscreen: false,
  actions: [{ action: 'set_range_value', delivery: [], unavailable: 'read_only' }],
  range: { value: 35, min: 0, max: 100, smallChange: 0, largeChange: 0 },
}
const 三态复选: DesktopElement = {
  ref: 'w.4#10',
  parentRef: 'w#1',
  depth: 1,
  role: 'check_box',
  name: '三态',
  automationId: 'triCheck',
  enabled: true,
  offscreen: false,
  actions: [{ action: 'set_toggle', delivery: ['background'] }],
  toggle: 'off',
}
const 单选列表: DesktopElement = {
  ref: 'w.5#11',
  parentRef: 'w#1',
  depth: 1,
  role: 'list',
  name: '单选',
  automationId: 'singleList',
  enabled: true,
  offscreen: false,
  actions: [],
  selection: { multiple: false, required: false },
}
const 单选项: DesktopElement = {
  ref: 'w.5.0#12',
  parentRef: 'w.5#11',
  depth: 2,
  role: 'list_item',
  name: 'single-alpha',
  automationId: '',
  enabled: true,
  offscreen: false,
  actions: [
    { action: 'select', delivery: ['background'] },
    { action: 'add_to_selection', delivery: ['background'] },
    { action: 'remove_from_selection', delivery: ['background'] },
  ],
  selected: false,
}
const 树节点: DesktopElement = {
  ref: 'w.6#13',
  parentRef: 'w#1',
  depth: 1,
  role: 'tree_item',
  name: 'treeRoot',
  automationId: 'treeRoot',
  enabled: true,
  offscreen: false,
  actions: [
    { action: 'expand', delivery: ['background'] },
    { action: 'collapse', delivery: ['background'] },
  ],
  expand: 'collapsed',
}
const 长列表: DesktopElement = {
  ref: 'w.7#14',
  parentRef: 'w#1',
  depth: 1,
  role: 'list',
  name: '长列表',
  automationId: 'bigList',
  enabled: true,
  offscreen: false,
  actions: [
    { action: 'scroll', delivery: ['background'] },
    { action: 'realize_item', delivery: ['background'] },
  ],
  scroll: { vertical: 0 },
  selection: { multiple: false, required: false },
}
/** 前台模式开着时读到的按钮：指针动作带 foreground delivery，后台动作照常。 */
const 前台按钮: DesktopElement = {
  ref: 'w.9#16',
  parentRef: 'w#1',
  depth: 1,
  role: 'button',
  name: '前台',
  automationId: 'fgButton',
  enabled: true,
  offscreen: false,
  rect: { x: 400, y: 300, width: 100, height: 30 },
  actions: [
    { action: 'invoke', delivery: ['background'] },
    { action: 'click', delivery: ['foreground'] },
    { action: 'hover', delivery: ['foreground'] },
    { action: 'drag', delivery: ['foreground'] },
    { action: 'wheel', delivery: ['foreground'] },
  ],
}
/** 持有键盘焦点的那一个。键盘动作只挂在它身上。 */
const 焦点框: DesktopElement = {
  ref: 'w.10#17',
  parentRef: 'w#1',
  depth: 1,
  role: 'edit',
  name: '焦点',
  automationId: 'focusBox',
  value: '',
  enabled: true,
  offscreen: false,
  focused: true,
  rect: { x: 400, y: 400, width: 100, height: 24 },
  actions: [
    { action: 'set_value', delivery: ['background'] },
    { action: 'click', delivery: ['foreground'] },
    { action: 'type_text', delivery: ['foreground'] },
    { action: 'press_key', delivery: ['foreground'] },
  ],
}
/** 前台模式开着时的窗口根：窗口动作挂在它身上。 */
const 前台窗口: DesktopElement = {
  ...窗口,
  actions: [
    { action: 'activate', delivery: ['foreground'] },
    { action: 'set_window_state', delivery: ['foreground'] },
    { action: 'close_window', delivery: ['foreground'] },
    { action: 'move_window', delivery: ['foreground'] },
    { action: 'resize_window', delivery: ['foreground'] },
  ],
}
/**
 * 自绘界面的观察：树上只有窗口根，一个业务控件都没有。
 *
 * 它就是系统前台窗口，所以键盘动作挂在根上——这类窗口给不出一个持有焦点的控件。
 */
const 自绘窗口: DesktopElement = {
  ...窗口,
  name: '自绘',
  actions: [
    { action: 'activate', delivery: ['foreground'] },
    { action: 'type_text', delivery: ['foreground'] },
    { action: 'press_key', delivery: ['foreground'] },
  ],
}

const 文档框: DesktopElement = {
  ref: 'w.8#15',
  parentRef: 'w#1',
  depth: 1,
  role: 'edit',
  name: '正文',
  automationId: 'doc',
  value: '第一行中文内容',
  enabled: true,
  offscreen: false,
  actions: [
    { action: 'set_value', delivery: ['background'] },
    { action: 'select_text', delivery: ['background'] },
  ],
  text: true,
}

/** 收起的组合框：控件表里没有它的项，选中项只在 selection.selected 里。 */
const 组合框: DesktopElement = {
  ref: 'w.11#18',
  parentRef: 'w#1',
  depth: 1,
  role: 'combo_box',
  name: '部门',
  automationId: 'deptCombo',
  enabled: true,
  offscreen: false,
  actions: [
    { action: 'expand', delivery: ['background'] },
    { action: 'collapse', delivery: ['background'] },
  ],
  expand: 'collapsed',
  selection: { multiple: false, required: false, selected: ['市场部'] },
}

const TABLE = [
  窗口,
  工具栏,
  工具栏保存,
  表单组,
  输入框,
  表单保存,
  灰按钮,
  滑块,
  进度条,
  三态复选,
  单选列表,
  单选项,
  树节点,
  长列表,
  文档框,
  组合框,
]

/** 前台模式开着时那一份控件表。窗口根换成带窗口动作的那一个。 */
const FOREGROUND_TABLE = [前台窗口, ...TABLE.slice(1), 前台按钮, 焦点框]

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

/**
 * 一段够 `imageSizeOf` 认出宽高的 PNG 字节：签名加 IHDR 头。
 *
 * 不带像素数据是有意的：长边在 `MAX_EDGE` 以内时 `shrinkImage` 一个字节都不动，
 * 这条路径上没有人会去解码它。
 */
function png(width: number, height: number): string {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return Buffer.from(bytes).toString('base64')
}

function image(over: Partial<DesktopImage> = {}): DesktopImage {
  return {
    app: '记事本',
    title: '未命名',
    imageRef: 'di_1',
    data: png(506, 453),
    mime: 'image/png',
    geometry: {
      imageWidth: 506,
      imageHeight: 453,
      screen: { x: 87, y: 80, width: 506, height: 453 },
      dpi: 96,
      generation: '80,80,520,460@96#65537',
    },
    source: 'wgc',
    capturedAt: 2,
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
    captureImage: async (input) => {
      note('captureImage', input)
      return image()
    },
    act: async (input) => acted(input),
    readText: async (input) => {
      note('readText', input)
      return {
        app: '记事本',
        title: '未命名',
        text: '这是一段文本',
        truncated: false,
        selectionSupport: 'single',
        selection: [],
      }
    },
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
  test('五个工具都在 desktop 类目下，权限效果单列', () => {
    expect(desktopTools.map((t) => t.name)).toEqual([
      'desktop_windows',
      'desktop_observe',
      'desktop_act',
      'desktop_act_sequence',
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
        input: {
          windowId: 'dw_1',
          observationId: 'do_1',
          ref: 'w.1.0#5',
          action: { kind: 'set_value', value: '张三' },
        },
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
    expect(calls[0]).toMatchObject({ input: { action: { kind: 'set_value', value: '' } } })
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

describe('动作族：参数、目标态与前置条件', () => {
  /** 可用动作表说得出「此刻能不能执行」，只读的那一项 delivery 为空且带原因。 */
  test('delivery 为空的动作在本地就被拒，原因如实带出来', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_range_value',
        ref: 'w.3#9',
        number: 50,
      },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_action_unsupported' })
    expect(r.message).toContain('read_only')
    expect(calls).toEqual([])
  })

  test('数值越界在本地按观察里的区间拒绝，不夹到边界上', async () => {
    const { port, calls } = fakeDesktop()
    const over = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_range_value',
        ref: 'w.2#8',
        number: 120,
      },
      ctxWith(port),
    )
    expect(over).toMatchObject({ executed: false, errorKind: 'desktop_precondition' })
    expect(over.message).toContain('0 到 100')
    expect(calls).toEqual([])

    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_range_value',
        ref: 'w.2#8',
        number: 42,
      },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({ input: { action: { kind: 'set_range_value', value: 42 } } })
  })

  /** 目标态就是目标态：已经在那个状态上时不发动作，也不「切一次」。 */
  test('set_toggle 按目标态发，已经是目标态就不发', async () => {
    const { port, calls } = fakeDesktop()
    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_toggle',
        ref: 'w.4#10',
        state: 'indeterminate',
      },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({
      input: { action: { kind: 'set_toggle', state: 'indeterminate' } },
    })

    const again = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_toggle',
        ref: 'w.4#10',
        state: 'off',
      },
      ctxWith(port),
    )
    expect(again).toMatchObject({ executed: false, errorKind: 'desktop_precondition' })
    expect(calls).toHaveLength(1)
  })

  /** 容器的多选约束在祖先那一格上，本地顺着 parentRef 就判得出来。 */
  test('单选容器上的增选在本地被拒，select 照发', async () => {
    const { port, calls } = fakeDesktop()
    const add = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'add_to_selection', ref: 'w.5.0#12' },
      ctxWith(port),
    )
    expect(add).toMatchObject({ executed: false, errorKind: 'desktop_precondition' })
    expect(calls).toEqual([])

    await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'select', ref: 'w.5.0#12' },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({ input: { action: { kind: 'select' } } })
  })

  test('已经收起的树节点不再 collapse，expand 照发', async () => {
    const { port, calls } = fakeDesktop()
    const again = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'collapse', ref: 'w.6#13' },
      ctxWith(port),
    )
    expect(again).toMatchObject({ executed: false, errorKind: 'desktop_precondition' })
    expect(calls).toEqual([])

    await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'expand', ref: 'w.6#13' },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({ input: { action: { kind: 'expand' } } })
  })

  test('scroll 的方向必填，步长默认一行', async () => {
    const { port, calls } = fakeDesktop()
    const missing = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'scroll', ref: 'w.7#14' },
      ctxWith(port),
    )
    expect(missing).toMatchObject({ executed: false, errorKind: 'invalid_argument' })

    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'scroll',
        ref: 'w.7#14',
        direction: 'down',
      },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({
      input: { action: { kind: 'scroll', direction: 'down', step: 'line' } },
    })
  })

  test('realize_item 要给项名，select_text 要给起点与长度', async () => {
    const { port, calls } = fakeDesktop()
    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'realize_item',
        ref: 'w.7#14',
        itemName: 'row-0900',
      },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({
      input: { action: { kind: 'realize_item', name: 'row-0900' } },
    })

    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'select_text',
        ref: 'w.8#15',
        start: 3,
        length: 4,
      },
      ctxWith(port),
    )
    expect(calls[1]).toMatchObject({
      input: { action: { kind: 'select_text', start: 3, length: 4 } },
    })

    const bare = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'realize_item', ref: 'w.7#14' },
      ctxWith(port),
    )
    expect(bare).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
  })

  /** 不属于这个动作的参数一律拒绝：静默忽略会让「写了值」这件事看起来发生过。 */
  test('参数不属于这个动作就拒绝，不静默忽略', async () => {
    const { port, calls } = fakeDesktop()
    for (const args of [
      { action: 'invoke', ref: 'w.0.0#3', value: 'x' },
      { action: 'expand', ref: 'w.6#13', number: 1 },
      { action: 'set_toggle', ref: 'w.4#10', state: 'on', value: 'x' },
    ]) {
      const r = await run(
        desktopActTool,
        { windowId: 'dw_1', observationId: 'do_1', ...args },
        ctxWith(port),
      )
      expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    }
    expect(calls).toEqual([])
  })
})

describe('按需字段', () => {
  /** 两个开关各自独立，都只在显式关掉时才交给端口。 */
  test('includeValue 与 includeState 只在关掉时下传', async () => {
    const { port, calls } = fakeDesktop()
    await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(calls[0]).toEqual({ method: 'observe', input: { windowId: 'dw_1' } })

    await run(
      desktopObserveTool,
      { windowId: 'dw_1', includeValue: false, includeState: false },
      ctxWith(port),
    )
    expect(calls[1]).toEqual({
      method: 'observe',
      input: { windowId: 'dw_1', includeValue: false, includeState: false },
    })

    await run(desktopObserveTool, { windowId: 'dw_1', includeState: true }, ctxWith(port))
    expect(calls[2]).toEqual({ method: 'observe', input: { windowId: 'dw_1' } })
  })
})

describe('选择容器的选中项', () => {
  /** 收起的组合框在表里没有子控件，选中项只能由容器那一格交出来。 */
  test('收起的组合框把选中项随观察交出来', async () => {
    const { port } = fakeDesktop()
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    const table = (r.data as unknown as DesktopSnapshot).elements
    const combo = table.find((e) => e.automationId === 'deptCombo')
    expect(combo?.selection?.selected).toEqual(['市场部'])
    expect(table.filter((e) => e.parentRef === combo?.ref)).toEqual([])
  })

  /** 改完选中项，同次带回的那份观察里容器已经是新值：模型不必再单独观察一次。 */
  test('动作同次带回的观察里容器的选中项已更新', async () => {
    const { port } = fakeDesktop({
      act: async () => ({
        dispatch: 'submitted',
        actionId: 'da_9',
        observation: snapshot({
          observationId: 'do_2',
          elements: [
            {
              ...单选列表,
              selection: { multiple: false, required: false, selected: ['single-alpha'] },
            },
            { ...单选项, selected: true },
          ],
        }),
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'select', ref: 'w.5.0#12' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    const observation = (r.data as { observation: DesktopSnapshot }).observation
    expect(observation.elements.find((e) => e.ref === 'w.5#11')?.selection?.selected).toEqual([
      'single-alpha',
    ])
  })

  /** 目标本身是容器时那一行就印出选中的是哪几项；名单不全时一并说出来。 */
  test('目标是容器时行上印出选中项与名单不全', async () => {
    const { port } = fakeDesktop({
      act: async () => ({
        dispatch: 'submitted',
        actionId: 'da_10',
        observation: snapshot({
          observationId: 'do_2',
          elements: [
            {
              ...长列表,
              selection: {
                multiple: true,
                required: false,
                selected: ['甲', '乙'],
                truncated: true,
              },
            },
          ],
        }),
      }),
    })
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'scroll',
        ref: 'w.7#14',
        direction: 'down',
      },
      ctxWith(port),
    )
    expect(r.message).toContain('选中 "甲"、"乙" 等')
  })

  /** includeState=false 的那份观察里没有这一格，行上也就不印选中项。 */
  test('不取状态细节时行上不印选中项', async () => {
    const 无状态长列表: DesktopElement = { ...长列表 }
    delete 无状态长列表.selection
    delete 无状态长列表.scroll
    const { port } = fakeDesktop({
      act: async () => ({
        dispatch: 'submitted',
        actionId: 'da_11',
        observation: snapshot({ observationId: 'do_2', elements: [无状态长列表] }),
      }),
    })
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'scroll',
        ref: 'w.7#14',
        direction: 'down',
      },
      ctxWith(port),
    )
    expect(r.message).toContain('w.7#14')
    expect(r.message).not.toContain('选中')
  })
})

describe('读文本与选区', () => {
  test('capture=text 读文档文本与选区，不换观察编号', async () => {
    const { port, calls } = fakeDesktop({
      readText: async (input) => {
        calls.push({ method: 'readText', input })
        return {
          app: '记事本',
          title: '未命名',
          text: '第一行中文内容',
          truncated: true,
          selectionSupport: 'single',
          selection: [{ start: 3, text: '中文', truncated: false }],
        }
      },
    })
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'text', observationId: 'do_1', ref: 'w.8#15', maxChars: 50 },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls).toEqual([
      {
        method: 'readText',
        input: { windowId: 'dw_1', observationId: 'do_1', ref: 'w.8#15', maxChars: 50 },
      },
    ])
    expect(r.data).toMatchObject({ ref: 'w.8#15', truncated: true, selectionSupport: 'single' })
    expect(r.message).toContain('截断')
  })

  test('没有 TextPattern 的控件读不了文本，一帧都不发', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'text', observationId: 'do_1', ref: 'w.0.0#3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ errorKind: 'desktop_action_unsupported' })
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
      act: async () => ({
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
      act: async () => ({
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
      act: async () => ({
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

  /**
   * 调用没返回时目标窗口读不动，宿主换成一份窗口清单。回执要把新出现的那个窗口
   * 点名交出去，模型下一步观察它而不是目标窗口。
   */
  test('调用未返回时回执给出新窗口的 windowId，不报「没有读数」', async () => {
    const { port } = fakeDesktop({
      act: async () => ({
        dispatch: 'submitted',
        actionId: 'da_5',
        reason: '调用尚未返回，目标窗口已被禁用',
        observation: null,
        observationError: 'target_blocked: 动作调用尚未返回，没有重读目标窗口',
        blocking: [
          { windowId: 'dw_1', app: 'fixture.exe', title: '夹具', appeared: false },
          { windowId: 'dw_9', app: 'fixture.exe', title: '另存为', appeared: true },
        ],
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.0.0#3' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.message).toContain('dw_9')
    expect(r.message).toContain('另存为')
    expect(r.message).toContain('desktop_observe')
    // 没出现过的那个窗口不喧宾夺主：只点名新出现的。
    expect(r.message).not.toContain('dw_1 fixture.exe 夹具')
    expect(r.data).toMatchObject({ dispatch: 'submitted' })
  })

  /** 结果未知时仍要说「先读状态，别重放」。 */
  test('调用未返回且没有证据时是 unknown，仍要求先重新观察', async () => {
    const { port } = fakeDesktop({
      act: async () => ({
        dispatch: 'unknown',
        actionId: 'da_6',
        reason: 'call_pending: 动作调用尚未返回，也没有可核实的生效证据',
        observation: null,
        observationError: 'target_blocked: 动作调用尚未返回，没有重读目标窗口',
        blocking: [{ windowId: 'dw_1', app: 'fixture.exe', title: '夹具', appeared: false }],
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'w.0.0#3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: true, errorKind: 'desktop_unknown' })
    expect(r.message).toContain('不要重放')
    // 没有新窗口时如实列当前窗口，不硬说有新窗口。
    expect(r.message).toContain('当前的窗口')
  })

  /** 端口自己声明的执行前拒绝优先于「调进去过」这一判据。 */
  test('端口按 DesktopRefusal 拒绝时不记成已执行', async () => {
    class Refused extends Error implements DesktopRefusal {
      readonly errorKind = 'desktop_unavailable' as const
      readonly executed = false as const
    }
    const { port } = fakeDesktop({
      act: async () => {
        throw new Refused('本次执行的电脑控制已经结束')
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

describe('采集模式', () => {
  /** 默认不采图：多一次采集就是多一次目标进程的合成与一次编码。 */
  test('不给 capture 就只读结构，端口的采集入口一次都不碰', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(calls.map((c) => c.method)).toEqual(['observe'])
    expect(r.data).not.toHaveProperty('images')
    expect(r.data).not.toHaveProperty('imageRef')
  })

  test('capture=structure 同样不采图', async () => {
    const { port, calls } = fakeDesktop()
    await run(desktopObserveTool, { windowId: 'dw_1', capture: 'structure' }, ctxWith(port))
    expect(calls.map((c) => c.method)).toEqual(['observe'])
  })

  test('capture=region_image 只采图，不读树', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image' },
      ctxWith(port),
    )
    expect(calls).toEqual([{ method: 'captureImage', input: { windowId: 'dw_1', maxEdge: 1568 } }])
    expect(r.status).toBe('success')
    expect(r.data).toMatchObject({ imageRef: 'di_1', source: 'wgc', imageCapturedAt: 2 })
  })

  test('capture=combined 两样都要，两个时刻分开记', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'combined' },
      ctxWith(port),
    )
    expect(calls.map((c) => c.method)).toEqual(['observe', 'captureImage'])
    expect(r.data).toMatchObject({ capturedAt: 1, imageCapturedAt: 2, observationId: 'do_1' })
  })

  /** 树已经读到了就交出去：图没采到不该把这一次观察一起作废。 */
  test('combined 采图失败时控件表照样交回，并说清图为什么没有', async () => {
    const { port } = fakeDesktop({
      captureImage: async () => {
        throw new Error('window_minimized: 窗口已最小化，采不到内容')
      },
    })
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'combined' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.data).toMatchObject({ observationId: 'do_1' })
    expect(r.data).not.toHaveProperty('images')
    expect(String(r.data?.imageError)).toContain('window_minimized')
    expect(r.message).toContain('没有采到图')
  })

  test('取景参数只在采图模式下成立', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', around: 'w.1.0#5', observationId: 'do_1' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])
  })

  test('around 与 imageRef 同时给时不挑一个，当场拒绝', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      {
        windowId: 'dw_1',
        capture: 'region_image',
        around: 'w.1.0#5',
        observationId: 'do_1',
        imageRef: 'di_1',
        imageRect: { x: 0, y: 0, width: 10, height: 10 },
      },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])
  })
})

describe('按控件与按图取景', () => {
  test('around 把控件包围盒外扩若干像素交给端口', async () => {
    const { port, calls } = fakeDesktop()
    await run(
      desktopObserveTool,
      {
        windowId: 'dw_1',
        capture: 'region_image',
        observationId: 'do_1',
        around: 'w.1.0#5',
        pad: 20,
      },
      ctxWith(port),
    )
    expect(calls[0]).toEqual({
      method: 'captureImage',
      input: {
        windowId: 'dw_1',
        maxEdge: 1568,
        region: { x: 280, y: 180, width: 160, height: 64 },
      },
    })
  })

  /**
   * combined 先读树，旧观察编号随之作废。拿调用方给的那个编号去解析 around，
   * 解出来的是一份已经不存在的表。
   */
  test('combined 的 around 按这次读到的控件表解析', async () => {
    const { port, calls } = fakeDesktop({
      // 这一份端口只认 do_1；combined 读完树拿到的是 do_1 的内容，但不该再查一次。
      elements: () => null,
      observe: async (input) => snapshot({ windowId: input.windowId, observationId: 'do_9' }),
    })
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'combined', around: 'w.1.0#5', pad: 5 },
      ctxWith(port),
    )
    // `elements` 恒回 null：走到它就会以「观察已失效」收尾，采不到图。
    expect(r.status).toBe('success')
    expect(calls.map((c) => c.method)).toEqual(['captureImage'])
    expect(calls[0]).toMatchObject({
      input: { region: { x: 295, y: 195, width: 130, height: 34 } },
    })
  })

  test('combined 不接受 observationId', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'combined', observationId: 'do_1', around: 'w.1.0#5' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])
  })

  test('没给 pad 就按包围盒本身取景', async () => {
    const { port, calls } = fakeDesktop()
    await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image', observationId: 'do_1', around: 'w.1.0#5' },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({
      input: { region: { x: 300, y: 200, width: 120, height: 24 } },
    })
  })

  /** 没有包围盒的控件取不了景，编一个矩形出来采回的是别处。 */
  test('控件没有包围盒时拒绝取景，一帧都不发', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image', observationId: 'do_1', around: 'w.0.0#3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_no_bounds' })
    expect(calls).toEqual([])
  })

  test('观察失效时 around 在本地就被挡下', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image', observationId: 'do_9', around: 'w.1.0#5' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_observation_stale' })
    expect(calls).toEqual([])
  })

  test('imageRef 加 imageRect 原样交给端口换算', async () => {
    const { port, calls } = fakeDesktop()
    await run(
      desktopObserveTool,
      {
        windowId: 'dw_1',
        capture: 'region_image',
        imageRef: 'di_1',
        imageRect: { x: 10, y: 20, width: 100, height: 50 },
      },
      ctxWith(port),
    )
    expect(calls[0]).toEqual({
      method: 'captureImage',
      input: {
        windowId: 'dw_1',
        maxEdge: 1568,
        imageRef: 'di_1',
        imageRect: { x: 10, y: 20, width: 100, height: 50 },
      },
    })
  })

  test('给了 imageRef 没给 imageRect 时拒绝，一帧都不发', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image', imageRef: 'di_1' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])
  })

  /** 失效的 imageRef 由端口判定，工具原样透传它的拒绝。 */
  test('端口拒绝失效的 imageRef 时原样交回模型', async () => {
    const { port } = fakeDesktop({
      captureImage: async () => {
        const err = Object.assign(new Error('di_1 已经失效：桌面宿主换过代际，请重新采图'), {
          errorKind: 'invalid_argument',
          executed: false,
        })
        throw err
      },
    })
    const r = await run(
      desktopObserveTool,
      {
        windowId: 'dw_1',
        capture: 'region_image',
        imageRef: 'di_1',
        imageRect: { x: 0, y: 0, width: 10, height: 10 },
      },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(r.message).toContain('已经失效')
  })
})

describe('图片通道与几何定稿', () => {
  /** base64 留在 message 里模型读不懂，只照价计费；字节只走 data.images。 */
  test('图像字节走 images 通道，不进回执正文', async () => {
    const { port } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image' },
      ctxWith(port),
    )
    const images = (r.data as { images?: { data: string; mime: string }[] }).images ?? []
    expect(images).toHaveLength(1)
    expect(images[0]?.mime).toBe('image/png')
    expect(images[0]?.data.length).toBeGreaterThan(0)
    expect(r.message).not.toContain(images[0]?.data ?? '')
  })

  test('几何随图一起交回，说得出图像尺寸与它对应的屏幕矩形', async () => {
    const { port } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image' },
      ctxWith(port),
    )
    expect(r.data).toMatchObject({
      geometry: {
        imageWidth: 506,
        imageHeight: 453,
        screen: { x: 87, y: 80, width: 506, height: 453 },
        dpi: 96,
      },
    })
    expect(r.message).toContain('506×453')
    expect(r.message).toContain('87,80')
  })

  /**
   * 几何在采集端定稿，这里只核对。
   *
   * 尺寸对不上意味着模型看到的与几何记的不是同一张图，按图算出来的屏幕坐标就是错的。
   */
  test('图像尺寸与几何对不上时不把这张图交给模型', async () => {
    const { port } = fakeDesktop({
      captureImage: async () => image({ data: png(320, 240) }),
    })
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', errorKind: 'desktop_image_mismatch' })
    expect(r.data).toBeUndefined()
  })

  test('combined 下尺寸对不上时控件表仍然交回，图不交', async () => {
    const { port } = fakeDesktop({
      captureImage: async () => image({ data: png(320, 240) }),
    })
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'combined' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.data).toMatchObject({ observationId: 'do_1' })
    expect(r.data).not.toHaveProperty('images')
    expect(String(r.data?.imageError)).toContain('对不上')
  })

  /** 退路采集画不全的区域是黑的，模型要知道这张图能不能当依据。 */
  test('退路采集在回执里点名', async () => {
    const { port } = fakeDesktop({
      captureImage: async () => image({ source: 'print_window' }),
    })
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image' },
      ctxWith(port),
    )
    expect(r.data).toMatchObject({ source: 'print_window' })
    expect(r.message).toContain('黑的')
  })
})

describe('不收图片的模型', () => {
  /** 采一张模型看不到的图要付出整条采集与编码的代价，所以在采之前就回绝。 */
  test('vision=false 时采图模式在发请求之前回绝', async () => {
    const { port, calls } = fakeDesktop()
    const ctx = { ...ctxWith(port), vision: false as const }
    for (const capture of ['region_image', 'combined']) {
      const r = await run(desktopObserveTool, { windowId: 'dw_1', capture }, ctx)
      expect(r).toMatchObject({ status: 'failure', executed: false, errorKind: 'unsupported' })
      expect(r.message).toContain('capture=structure')
    }
    expect(calls).toEqual([])
  })

  test('vision=false 不影响结构化观察', async () => {
    const { port, calls } = fakeDesktop()
    const ctx = { ...ctxWith(port), vision: false as const }
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctx)
    expect(r.status).toBe('success')
    expect(calls.map((c) => c.method)).toEqual(['observe'])
  })

  /** 三态里只有 `false` 拦：`null` 是没有出处，按放行算。 */
  test('vision=null 时照常采图', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls.map((c) => c.method)).toEqual(['captureImage'])
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
        observationError: '本次执行的电脑控制已经结束',
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

/**
 * 前台动作：本地只按可用动作表裁决，真正的准入在宿主那一侧。
 *
 * 表里没有 foreground delivery 就是用户没启用，工具在派发之前拒；表里有就照常交下去，
 * 后台失败不会在这里被换成前台重试。
 */
describe('前台动作', () => {
  function foregroundPort(over: Partial<DesktopPort> = {}) {
    const base = fakeDesktop(over)
    return {
      ...base,
      port: {
        ...base.port,
        elements: (windowId: string, observationId: string) =>
          windowId === 'dw_1' && observationId === 'do_1' ? FOREGROUND_TABLE : null,
      } as DesktopPort,
    }
  }

  test('前台模式关着时表里没有前台动作，请求在派发之前被拒', async () => {
    const { port, calls } = fakeDesktop()
    for (const action of ['click', 'type_text', 'activate', 'close_window']) {
      const r = await run(
        desktopActTool,
        {
          windowId: 'dw_1',
          observationId: 'do_1',
          action,
          ref: 'w.0.0#3',
          ...(action === 'type_text' ? { text: '张三' } : {}),
        },
        ctxWith(port),
      )
      expect(r).toMatchObject({
        status: 'failure',
        executed: false,
        errorKind: 'desktop_action_unsupported',
      })
    }
    expect(calls).toEqual([])
  })

  test('表里有 foreground delivery 时照常交给端口', async () => {
    const { port, calls } = foregroundPort()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'click', ref: 'w.9#16', button: 'right' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls).toEqual([
      {
        method: 'act',
        input: {
          windowId: 'dw_1',
          observationId: 'do_1',
          ref: 'w.9#16',
          action: { kind: 'click', button: 'right', count: 1 },
        },
      },
    ])
  })

  test('双击按 count 表达，上限是 2', async () => {
    const { port, calls } = foregroundPort()
    await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'click', ref: 'w.9#16', count: 2 },
      ctxWith(port),
    )
    expect((calls[0]?.input as { action: unknown }).action).toEqual({
      kind: 'click',
      button: 'left',
      count: 2,
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'click', ref: 'w.9#16', count: 9 },
      ctxWith(port),
    )
    // 越界按上限夹，不拒：三击没有额外语义，两下已经是双击。
    expect(r.status).toBe('success')
    expect((calls[1]?.input as { action: { count: number } }).action.count).toBe(2)
  })

  test('键盘动作只挂在持有焦点的控件上', async () => {
    const { port, calls } = foregroundPort()
    const blocked = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'type_text', ref: 'w.9#16', text: '张三' },
      ctxWith(port),
    )
    expect(blocked).toMatchObject({ executed: false, errorKind: 'desktop_action_unsupported' })
    const ok = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'type_text',
        ref: 'w.10#17',
        text: '张三',
      },
      ctxWith(port),
    )
    expect(ok.status).toBe('success')
    expect((calls[0]?.input as { action: unknown }).action).toEqual({
      kind: 'type_text',
      text: '张三',
    })
  })

  /**
   * 自绘界面：树上只有窗口根，键盘动作挂在它身上，投递时不带控件。
   *
   * 少了这条路，`type_text` 对这类应用整条不可用——它们永远给不出一个持有键盘焦点的
   * 控件，而模型只能绕去 shell 自己写脚本。
   */
  function 自绘Port(over: Partial<DesktopPort> = {}) {
    const base = fakeDesktop(over)
    return {
      ...base,
      port: {
        ...base.port,
        elements: (windowId: string, observationId: string) =>
          windowId === 'dw_1' && observationId === 'do_1' ? [自绘窗口] : null,
      } as DesktopPort,
    }
  }

  test('窗口根挂着键盘动作时，不点名控件的输入按窗口投递', async () => {
    const { port, calls } = 自绘Port()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'type_text', text: '你好 hello' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls).toEqual([
      {
        method: 'act',
        input: {
          windowId: 'dw_1',
          observationId: 'do_1',
          action: { kind: 'type_text', text: '你好 hello' },
        },
      },
    ])
  })

  test('点名窗口根与不点名发的是同一种请求，都不带 ref', async () => {
    const { port, calls } = 自绘Port()
    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'press_key',
        ref: 'w#1',
        key: 'a',
        modifiers: ['ctrl'],
      },
      ctxWith(port),
    )
    expect(calls[0]?.input).toEqual({
      windowId: 'dw_1',
      observationId: 'do_1',
      action: { kind: 'press_key', key: 'a', modifiers: ['ctrl'] },
    })
  })

  test('窗口根没有键盘动作时，不点名控件的输入在派发之前被拒', async () => {
    const { port, calls } = foregroundPort()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'type_text', text: '张三' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_action_unsupported' })
    expect(calls).toEqual([])
  })

  /**
   * `type_text` 之后读回来的值里没有这段文字时不许报成功。
   *
   * 派发事实与读回是两件事：`SendInput` 收下了全部事件只说明事件进了系统输入队列，
   * 目标控件里落成什么字要按动作后的重读判。少了这一条，一次把
   * 「哦哦行，那你先用这个号跑吧」打成「哦哦行，，先用这个号跑吧」的输入在回执里
   * 与打对了完全一样。
   */
  function typedPort(value: string | null) {
    // 值缺席要把键去掉，不是给空串：空串是「控件里此刻是空的」，缺席是「这个控件不回值」。
    const { value: _dropped, ...无值框 } = 焦点框
    return foregroundPort({
      act: async () => ({
        dispatch: 'submitted' as const,
        actionId: 'da_9',
        observation: snapshot({
          observationId: 'do_2',
          elements: [value === null ? 无值框 : { ...焦点框, value }],
        }),
      }),
    })
  }

  const 输入 = (port: DesktopPort, text: string) =>
    run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'type_text', ref: 'w.10#17', text },
      ctxWith(port),
    )

  test('type_text 读回的值里没有这段文字时按读回不一致返回，不报成功', async () => {
    const { port } = typedPort('哦哦行，，先用这个号跑吧')
    const r = await 输入(port, '哦哦行，那你先用这个号跑吧')
    expect(r).toMatchObject({
      status: 'failure',
      executed: true,
      errorKind: 'desktop_readback_mismatch',
    })
    expect(r.message).toContain('读回不一致')
    expect(r.message).toContain('不要重发同一段')
    // 控件此刻的内容由观察那一行给，读回这句不再印一遍。
    expect(r.message).toContain('"哦哦行，，先用这个号跑吧"')
  })

  test('type_text 落在已有内容后面时读回按含不含判，仍然是成功', async () => {
    const { port } = typedPort('原有内容哦哦行，那你先用这个号跑吧')
    const r = await 输入(port, '哦哦行，那你先用这个号跑吧')
    expect(r.status).toBe('success')
    expect(r.message).not.toContain('读回不一致')
    expect(r.message).not.toContain('取图核对')
  })

  test('type_text 的目标读不回控件值时回执指出改用取图核对', async () => {
    const { port } = typedPort(null)
    const r = await 输入(port, '张三')
    expect(r.status).toBe('success')
    expect(r.message).toContain('取图核对')
    expect(r.message).not.toContain('读回不一致')
  })

  test('读回只管 type_text，别的动作不按输入文字判', async () => {
    const { port } = typedPort('别的值')
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_value',
        ref: 'w.10#17',
        value: '张三',
      },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.message).not.toContain('读回不一致')
    expect(r.message).not.toContain('取图核对')
  })

  test('键盘之外的动作不点名控件仍然要求目标', async () => {
    const { port, calls } = 自绘Port()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'click' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(r.message).toContain('给 ref、automationId 或 name')
    expect(calls).toEqual([])
  })

  /**
   * 自绘界面的观察回执要自己说清「这里没有控件」与下一步，不然模型只会反复读树，
   * 或者绕去 shell 写截图脚本。
   */
  test('树上只有窗口与标题栏时，观察回执指出要取图并给坐标', async () => {
    const 标题栏: DesktopElement = {
      ref: 'w.1#20',
      parentRef: 'w#1',
      depth: 1,
      role: 'title_bar',
      name: '',
      automationId: 'TitleBar',
      value: '自绘',
      enabled: true,
      offscreen: false,
      actions: [{ action: 'set_value', delivery: ['background'] }],
    }
    const 关闭按钮: DesktopElement = {
      ref: 'w.1.3#21',
      parentRef: 'w.1#20',
      depth: 2,
      role: 'button',
      name: '关闭',
      automationId: 'Close',
      enabled: true,
      offscreen: false,
      actions: [{ action: 'invoke', delivery: ['background'] }],
    }
    const 画布: DesktopElement = {
      ref: 'w.0#22',
      parentRef: 'w#1',
      depth: 1,
      role: 'pane',
      name: '',
      automationId: 'canvas',
      enabled: true,
      offscreen: false,
      actions: [{ action: 'click', delivery: ['foreground'] }],
    }
    const bare = [自绘窗口, 画布, 标题栏, 关闭按钮]
    const { port } = fakeDesktop({
      observe: async () => snapshot({ elements: bare }),
    })
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'structure' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.message).toContain('这个窗口没有暴露可操作的控件')
    expect(r.message).toContain('imageX')
    expect(r.message).toContain('type_text')
    // 前台开着（表里有 foreground），不该再说「要用户去设置里打开」。
    expect(r.message).not.toContain('前台操作此刻没有启用')
  })

  test('前台操作关着时，同一句话补上要用户去设置里打开', async () => {
    const 后台窗口: DesktopElement = { ...窗口, actions: [] }
    const 画布: DesktopElement = {
      ref: 'w.0#22',
      parentRef: 'w#1',
      depth: 1,
      role: 'pane',
      name: '',
      automationId: 'canvas',
      enabled: true,
      offscreen: false,
      actions: [],
    }
    const { port } = fakeDesktop({
      observe: async () => snapshot({ elements: [后台窗口, 画布] }),
    })
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(r.message).toContain('这个窗口没有暴露可操作的控件')
    expect(r.message).toContain('前台操作此刻没有启用')
  })

  /** 筛出零个控件与「这个窗口没有控件」是两回事，混起来就成了一句假话。 */
  test('筛过或截断的观察不说这句话', async () => {
    const { port } = fakeDesktop({
      observe: async () => snapshot({ elements: [自绘窗口], filteredBy: ['role=button'] }),
    })
    const filtered = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(filtered.message).not.toContain('没有暴露可操作的控件')

    const { port: cut } = fakeDesktop({
      observe: async () =>
        snapshot({ elements: [自绘窗口], truncated: true, truncatedBy: ['max_nodes'] }),
    })
    const truncated = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(cut))
    expect(truncated.message).not.toContain('没有暴露可操作的控件')
  })

  /** 有业务控件的窗口不该被说成自绘界面。 */
  test('树里有可操作的业务控件时不说这句话', async () => {
    const { port } = fakeDesktop()
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(r.message).not.toContain('没有暴露可操作的控件')
  })

  test('组合键的修饰键按词表校验，重复的只留一份', async () => {
    const { port, calls } = foregroundPort()
    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'press_key',
        ref: 'w.10#17',
        key: 'a',
        modifiers: ['ctrl', 'ctrl'],
      },
      ctxWith(port),
    )
    expect((calls[0]?.input as { action: unknown }).action).toEqual({
      kind: 'press_key',
      key: 'a',
      modifiers: ['ctrl'],
    })
    const bad = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'press_key',
        ref: 'w.10#17',
        key: 'a',
        modifiers: ['hyper'],
      },
      ctxWith(port),
    )
    expect(bad).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
  })

  test('拖拽终点二选一：控件或像素偏移，都给即拒', async () => {
    const { port, calls } = foregroundPort()
    const byOffset = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'drag', ref: 'w.9#16', dx: 80, dy: 0 },
      ctxWith(port),
    )
    expect(byOffset.status).toBe('success')
    expect(calls[0]?.input).toMatchObject({
      action: { kind: 'drag', to: { kind: 'offset', dx: 80, dy: 0 } },
    })
    const both = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'drag',
        ref: 'w.9#16',
        toRef: 'w.1.0#5',
        dx: 80,
      },
      ctxWith(port),
    )
    expect(both).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    const none = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'drag', ref: 'w.9#16' },
      ctxWith(port),
    )
    expect(none).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
  })

  test('按图定位与按控件定位互斥，且只有指针动作接受图像点', async () => {
    const { port, calls } = foregroundPort()
    const byImage = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'click',
        imageRef: 'di_1',
        imageX: 40,
        imageY: 50,
      },
      ctxWith(port),
    )
    expect(byImage.status).toBe('success')
    expect(calls[0]?.input).toEqual({
      windowId: 'dw_1',
      observationId: 'do_1',
      at: { imageRef: 'di_1', x: 40, y: 50 },
      action: { kind: 'click', button: 'left', count: 1 },
    })
    const both = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'click',
        ref: 'w.9#16',
        imageRef: 'di_1',
        imageX: 1,
        imageY: 1,
      },
      ctxWith(port),
    )
    expect(both).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    const wrongKind = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'activate',
        imageRef: 'di_1',
        imageX: 1,
        imageY: 1,
      },
      ctxWith(port),
    )
    expect(wrongKind).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
  })

  test('失效的 imageRef 由端口拒绝，回执按未执行记', async () => {
    const { port } = foregroundPort({
      act: async () => {
        throw Object.assign(new Error('di_1 已经失效：桌面宿主换过代际，请重新采图'), {
          errorKind: 'invalid_argument',
          executed: false,
        } satisfies DesktopRefusal)
      },
    })
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'click',
        imageRef: 'di_1',
        imageX: 1,
        imageY: 1,
      },
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false, errorKind: 'invalid_argument' })
    expect(r.message).toContain('重新采图')
  })

  test('窗口动作认 windowState，不与复选的 state 混用', async () => {
    const { port, calls } = foregroundPort()
    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_window_state',
        ref: 'w#1',
        windowState: 'maximized',
      },
      ctxWith(port),
    )
    expect((calls[0]?.input as { action: unknown }).action).toEqual({
      kind: 'set_window_state',
      state: 'maximized',
    })
    const wrongParam = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_window_state',
        ref: 'w#1',
        state: 'maximized',
      },
      ctxWith(port),
    )
    expect(wrongParam).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
  })

  test('部分派发按未知记，回执带上已发出多少与下一步', async () => {
    const { port } = foregroundPort({
      act: async () => ({
        dispatch: 'unknown',
        actionId: 'da_7',
        reason: 'input_partial: 12 个输入事件只发出了 4 个，已发出的部分可能已经生效',
        observation: null,
        observationError: '目标窗口读不回来',
      }),
    })
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'type_text',
        ref: 'w.10#17',
        text: '张三',
      },
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: true, errorKind: 'desktop_unknown' })
    expect(r.message).toContain('只发出了 4 个')
    expect(r.message).toContain('不要重放这个动作')
  })

  test('前台模式未启用时宿主的拒绝按未执行透传', async () => {
    const { port } = foregroundPort({
      act: async () => ({
        dispatch: 'not_dispatched',
        actionId: 'da_8',
        reason: 'foreground_disabled: 前台操作没有启用，这次请求没有派发，桌面没有被动过',
        observation: null,
        observationError: '动作没有派发，没有重读',
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'click', ref: 'w.9#16' },
      ctxWith(port),
    )
    expect(r).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'desktop_not_dispatched',
    })
    expect(r.message).toContain('foreground_disabled')
  })

  test('关闭窗口带回提示框的窗口 id，让调用方接着观察它', async () => {
    const { port } = foregroundPort({
      act: async () => ({
        dispatch: 'submitted',
        actionId: 'da_9',
        reason: '调用尚未返回，目标进程出现了新的顶层窗口',
        blocking: [
          { windowId: 'dw_1', app: '记事本', title: '未命名', appeared: false },
          { windowId: 'dw_2', app: '记事本', title: '', appeared: true },
        ],
        observation: null,
        observationError: 'target_blocked: 动作调用尚未返回，没有重读目标窗口',
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'close_window', ref: 'w#1' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.message).toContain('dw_2')
    expect(r.message).not.toContain('dw_1 记事本 未命名')
  })

  test('前台动作没有新增工具入口，工具名不变', () => {
    expect(desktopTools.map((t) => t.name)).toEqual([
      'desktop_windows',
      'desktop_observe',
      'desktop_act',
      'desktop_act_sequence',
      'desktop_wait',
    ])
  })

  test('前台动作不进序列，整组在派发之前被拒', async () => {
    const { port, calls } = foregroundPort()
    for (const action of ['click', 'type_text', 'press_key', 'activate', 'close_window']) {
      const r = await run(
        desktopActSequenceTool,
        {
          windowId: 'dw_1',
          observationId: 'do_1',
          steps: [
            { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
            {
              action,
              ref: 'w.9#16',
              ...(action === 'type_text' ? { text: '李四' } : {}),
              ...(action === 'press_key' ? { key: 'enter' } : {}),
            },
          ],
        },
        ctxWith(port),
      )
      expect(r).toMatchObject({ status: 'failure', executed: false })
      expect(r.message).toContain('desktop_act')
    }
    expect(calls).toEqual([])
  })
})

/**
 * 有限动作序列：一次调用交付一组已确定的后台动作。
 *
 * 这里的假端口比上面那份多一层状态：动作按语义落在一份可变的控件表上，每次动作换一个
 * 观察编号。序列的判据是「上一步带回的那份表」，一个永远回同一份表的假端口证明不了
 * 引用接续。
 */
describe('有限动作序列', () => {
  type ActOverride = {
    dispatch?: DesktopActResult['dispatch']
    reason?: string
    blocking?: { windowId: string; app: string; title: string; appeared: boolean }[]
    observation?: DesktopSnapshot | null
    observationError?: string
  }

  function sequencePort(options: { acts?: (ActOverride | null)[]; onAct?: () => void } = {}) {
    const calls: Recorded[] = []
    let table = TABLE.map((e) => ({ ...e }))
    let observationId = 'do_1'
    let nextObservation = 1
    let nextAction = 0

    const bump = (): DesktopSnapshot => {
      nextObservation += 1
      observationId = `do_${nextObservation}`
      return snapshot({ observationId, elements: table })
    }
    const apply = (ref: string | undefined, action: DesktopAction): void => {
      const at = table.findIndex((e) => e.ref === ref)
      const target = table[at]
      if (!target) return
      if (action.kind === 'set_value') table[at] = { ...target, value: action.value }
      if (action.kind === 'set_toggle') table[at] = { ...target, toggle: action.state }
      if (action.kind === 'select') table[at] = { ...target, selected: true }
    }
    const adopt = (over: ActOverride): void => {
      if (!over.observation) return
      table = over.observation.elements.map((e) => ({ ...e }))
      observationId = over.observation.observationId
    }

    const port: DesktopPort = {
      windows: async () => [{ windowId: 'dw_1', app: '记事本', title: '未命名' }],
      observe: async () => snapshot({ observationId, elements: table }),
      elements: (windowId, asked) =>
        windowId === 'dw_1' && asked === observationId ? table : null,
      captureImage: async () => image(),
      act: async (input) => {
        calls.push({ method: 'act', input })
        nextAction += 1
        options.onAct?.()
        const over = options.acts?.[nextAction - 1] ?? null
        const dispatch = over?.dispatch ?? 'submitted'
        if (dispatch === 'submitted') apply(input.ref, input.action)
        const actionId = `da_${nextAction}`
        if (!over) return { dispatch, actionId, observation: bump() }
        if (over.observation === null) {
          return {
            dispatch,
            actionId,
            ...(over.reason === undefined ? {} : { reason: over.reason }),
            ...(over.blocking ? { blocking: over.blocking } : {}),
            observation: null,
            observationError: over.observationError ?? '目标窗口此刻读不动',
          }
        }
        if (over.observation) adopt(over)
        return {
          dispatch,
          actionId,
          ...(over.reason === undefined ? {} : { reason: over.reason }),
          observation: over.observation ?? bump(),
        }
      },
      readText: async () => ({
        app: '记事本',
        title: '未命名',
        text: '',
        truncated: false,
        selectionSupport: 'none',
        selection: [],
      }),
      wait: async (input) => {
        calls.push({ method: 'wait', input })
        return { found: false, reason: 'timeout', observation: bump() }
      },
      release: async () => {},
    }
    return { port, calls, current: () => table }
  }

  function seq(steps: Record<string, unknown>[]): Record<string, unknown> {
    return { windowId: 'dw_1', observationId: 'do_1', steps }
  }

  test('逐步执行，每步一个 actionId，动作按顺序带着当时那份观察编号发出', async () => {
    const { port, calls, current } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
        { action: 'set_toggle', ref: 'w.4#10', state: 'on' },
        { action: 'select', ref: 'w.5.0#12' },
      ]),
      ctxWith(port),
    )

    expect(r.status).toBe('success')
    expect(r.executed).toBe(true)
    expect(calls.map((c) => c.method)).toEqual(['act', 'act', 'act'])
    const inputs = calls.map((c) => c.input as { observationId: string; ref: string })
    expect(inputs.map((i) => i.ref)).toEqual(['w.1.0#5', 'w.4#10', 'w.5.0#12'])
    // 每一步按上一步带回的那个编号发出，不是原地复用第一个。
    expect(inputs.map((i) => i.observationId)).toEqual(['do_1', 'do_2', 'do_3'])

    const data = r.data as {
      steps: { index: number; actionId: string; dispatch: string; durationMs: number }[]
      dispatched: number[]
      notExecuted: number[]
      observation: DesktopSnapshot
    }
    expect(data.steps.map((s) => s.actionId)).toEqual(['da_1', 'da_2', 'da_3'])
    expect(new Set(data.steps.map((s) => s.actionId)).size).toBe(3)
    expect(data.steps.every((s) => s.dispatch === 'submitted')).toBe(true)
    expect(data.steps.every((s) => typeof s.durationMs === 'number')).toBe(true)
    expect(data.dispatched).toEqual([1, 2, 3])
    expect(data.notExecuted).toEqual([])
    expect(data.observation.observationId).toBe('do_4')
    expect(r.message).toContain('3 步全部执行')

    // 夹具自己的状态说得出这三步真落下去了。
    const table = current()
    expect(table.find((e) => e.ref === 'w.1.0#5')?.value).toBe('张三')
    expect(table.find((e) => e.ref === 'w.4#10')?.toggle).toBe('on')
    expect(table.find((e) => e.ref === 'w.5.0#12')?.selected).toBe(true)
  })

  test('序列只调端口，不经过任何模型请求通道', async () => {
    const { port, calls } = sequencePort()
    await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
        { action: 'invoke', ref: 'w.0.0#3' },
      ]),
      ctxWith(port),
    )
    expect(calls.every((c) => c.method === 'act' || c.method === 'wait')).toBe(true)
  })

  test('每一步经进度通道上报一次', async () => {
    const { port } = sequencePort()
    const sent: { channel: string; delta: string }[] = []
    const ctx: ToolContext = {
      ...ctxWith(port),
      emit: (channel, delta) => {
        sent.push({ channel, delta })
      },
    }
    await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
        { action: 'invoke', ref: 'w.0.0#3' },
      ]),
      ctx,
    )
    expect(sent).toHaveLength(2)
    expect(sent.every((s) => s.channel === 'progress')).toBe(true)
    expect(sent[0]?.delta).toContain('1 set_value w.1.0#5 已执行')
    expect(sent[1]?.delta).toContain('2 invoke w.0.0#3 已执行')
  })

  test('第 2 步结果未知时停下，第 3 步不执行', async () => {
    const { port, calls } = sequencePort({
      acts: [null, { dispatch: 'unknown', reason: '调用超时' }],
    })
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
        { action: 'set_toggle', ref: 'w.4#10', state: 'on' },
        { action: 'invoke', ref: 'w.0.0#3' },
      ]),
      ctxWith(port),
    )

    expect(calls).toHaveLength(2)
    expect(r).toMatchObject({ status: 'failure', executed: true, errorKind: 'desktop_unknown' })
    const data = r.data as { dispatched: number[]; notExecuted: number[]; stoppedAt: number }
    expect(data.dispatched).toEqual([1, 2])
    expect(data.notExecuted).toEqual([3])
    expect(data.stoppedAt).toBe(2)
    expect(r.message).toContain('结果未知')
    expect(r.message).toContain('不要重放')
    expect(r.message).toContain('未执行：3 invoke')
  })

  test('某步没有执行时停下，已派发的前缀如实保留', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
        { action: 'invoke', ref: 'w.1.2#7' },
        { action: 'invoke', ref: 'w.0.0#3' },
      ]),
      ctxWith(port),
    )

    // 第 2 步的目标是禁用控件：本地判完就停，一帧都没发。
    expect(calls).toHaveLength(1)
    expect(r).toMatchObject({
      status: 'failure',
      executed: true,
      errorKind: 'desktop_precondition',
    })
    const data = r.data as { dispatched: number[]; notExecuted: number[] }
    expect(data.dispatched).toEqual([1])
    expect(data.notExecuted).toEqual([2, 3])
    expect(r.message).toContain('2 invoke w.1.2#7 没有执行')
  })

  test('第一步就没有执行时整组记未执行', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'invoke', ref: 'w.1.2#7' },
        { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
      ]),
      ctxWith(port),
    )
    expect(calls).toEqual([])
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect((r.data as { dispatched: number[] }).dispatched).toEqual([])
  })

  test('后置条件按动作带回的观察判，满足就不发等待', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        {
          action: 'set_value',
          ref: 'w.1.0#5',
          value: '张三',
          expect: { until: 'value', value: '张三' },
        },
        {
          action: 'set_toggle',
          ref: 'w.4#10',
          state: 'on',
          expect: { until: 'toggle', state: 'on' },
        },
        { action: 'select', ref: 'w.5.0#12', expect: { until: 'selected' } },
      ]),
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls.map((c) => c.method)).toEqual(['act', 'act', 'act'])
    const data = r.data as { steps: { expect?: { until: string; met: boolean } }[] }
    expect(data.steps.map((s) => s.expect)).toEqual([
      { until: 'value', met: true },
      { until: 'toggle', met: true },
      { until: 'selected', met: true },
    ])
    expect(r.message).toContain('后置条件 value 已满足')
  })

  test('后置条件没等到即截断后缀', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        {
          action: 'set_value',
          ref: 'w.1.0#5',
          value: '张三',
          expect: { until: 'value', value: '李四', timeoutMs: 200 },
        },
        { action: 'invoke', ref: 'w.0.0#3' },
      ]),
      ctxWith(port),
    )
    // 观察里判不成立才发等待，等待到期仍不成立就停。
    expect(calls.map((c) => c.method)).toEqual(['act', 'wait'])
    expect(r).toMatchObject({
      status: 'failure',
      executed: true,
      errorKind: 'desktop_postcondition',
    })
    const data = r.data as { dispatched: number[]; notExecuted: number[] }
    expect(data.dispatched).toEqual([1])
    expect(data.notExecuted).toEqual([2])
    expect(r.message).toContain('后置条件 value 未满足')
  })

  test('toggle 与 selected 没有宿主等待，不成立当场停', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        {
          action: 'set_toggle',
          ref: 'w.4#10',
          state: 'on',
          expect: { until: 'toggle', state: 'indeterminate' },
        },
      ]),
      ctxWith(port),
    )
    expect(calls.map((c) => c.method)).toEqual(['act'])
    expect(r).toMatchObject({ status: 'failure', errorKind: 'desktop_postcondition' })
  })

  test('调用没有返回时截断后缀，并带回新出现的窗口 id', async () => {
    const { port, calls } = sequencePort({
      acts: [
        null,
        {
          observation: null,
          blocking: [
            { windowId: 'dw_1', app: '记事本', title: '未命名', appeared: false },
            { windowId: 'dw_9', app: '记事本', title: '未保存', appeared: true },
          ],
        },
      ],
    })
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
        { action: 'invoke', ref: 'w.0.0#3' },
        { action: 'invoke', ref: 'w.1.1#6' },
      ]),
      ctxWith(port),
    )
    expect(calls).toHaveLength(2)
    expect(r).toMatchObject({ status: 'failure', executed: true, errorKind: 'desktop_blocked' })
    expect(r.message).toContain('dw_9')
    expect(r.message).not.toContain('最后观察')
    const data = r.data as { blocking: { windowId: string }[]; notExecuted: number[] }
    expect(data.blocking.map((w) => w.windowId)).toEqual(['dw_1', 'dw_9'])
    expect(data.notExecuted).toEqual([3])
  })

  test('动作之后读不到控件表时截断后缀', async () => {
    const { port, calls } = sequencePort({
      acts: [{ observation: null, observationError: '宿主不可用' }],
    })
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
        { action: 'invoke', ref: 'w.0.0#3' },
      ]),
      ctxWith(port),
    )
    expect(calls).toHaveLength(1)
    expect(r).toMatchObject({
      status: 'failure',
      executed: true,
      errorKind: 'desktop_observation_unavailable',
    })
    expect(r.message).toContain('宿主不可用')
  })

  test('步与步之间检查取消，已派发的不重放', async () => {
    const controller = new AbortController()
    const { port, calls } = sequencePort({ onAct: () => controller.abort() })
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
        { action: 'invoke', ref: 'w.0.0#3' },
      ]),
      ctxWith(port, controller.signal),
    )
    expect(calls).toHaveLength(1)
    expect(r).toMatchObject({ status: 'failure', executed: true, errorKind: 'aborted' })
    expect((r.data as { notExecuted: number[] }).notExecuted).toEqual([2])
  })

  test('超过长度上限整组被拒，一步都不派发', async () => {
    const { port, calls } = sequencePort()
    const steps = Array.from({ length: 11 }, () => ({
      action: 'set_value',
      ref: 'w.1.0#5',
      value: '张三',
    }))
    const r = await run(desktopActSequenceTool, seq(steps), ctxWith(port))
    expect(calls).toEqual([])
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(r.message).toContain('最多 10 步')
  })

  test('close_window 不论在哪一步都被拒，一步都不派发', async () => {
    const { port, calls } = sequencePort()
    const notLast = await run(
      desktopActSequenceTool,
      seq([
        { action: 'close_window', ref: 'w#1' },
        { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
      ]),
      ctxWith(port),
    )
    const last = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
        { action: 'close_window', ref: 'w#1' },
      ]),
      ctxWith(port),
    )
    for (const r of [notLast, last]) {
      expect(r).toMatchObject({ status: 'failure', executed: false })
      expect(r.message).toContain('desktop_act')
    }
    expect(calls).toEqual([])
  })

  test('不认的动作名整组被拒', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([{ action: 'frobnicate', ref: 'w.1.0#5' }]),
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(calls).toEqual([])
  })

  test('步里给了不属于这个动作的参数即整组拒绝', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([{ action: 'invoke', ref: 'w.0.0#3', value: '张三' }]),
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(r.message).toContain('invoke 不接受 value')
    expect(calls).toEqual([])
  })

  test('步与后置条件里用不上的参数填空位时照常执行', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        {
          action: 'set_value',
          ref: 'w.1.0#5',
          automationId: '',
          name: '',
          role: '',
          value: '张三',
          number: null,
          state: '',
          direction: '',
          step: '',
          itemName: '',
          start: null,
          length: null,
          expect: {
            until: 'value',
            value: '张三',
            state: '',
            name: '',
            role: '',
            timeoutMs: null,
          },
        },
      ]),
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'success', executed: true })
    expect(calls.filter((c) => c.method === 'act')).toHaveLength(1)
  })

  test('toggle 与 selected 不接受 timeoutMs', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        {
          action: 'set_toggle',
          ref: 'w.4#10',
          state: 'on',
          expect: { until: 'toggle', state: 'on', timeoutMs: 500 },
        },
      ]),
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(r.message).toContain('timeoutMs')
    expect(calls).toEqual([])
  })

  test('引用接续：子树之外的旧 ref 在新编号下仍然解析得到', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
        { action: 'invoke', ref: 'w.0.0#3' },
      ]),
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    const second = calls[1]?.input as { observationId: string; ref: string }
    expect(second.ref).toBe('w.0.0#3')
    expect(second.observationId).toBe('do_2')
  })

  test('引用接续：新观察里没有这个 ref 就停下来交回模型，不另找一个顶上', async () => {
    const rebuilt = TABLE.map((e) => (e.ref === 'w.4#10' ? { ...e, ref: 'w.4#77' } : { ...e }))
    const { port, calls } = sequencePort({
      acts: [{ observation: snapshot({ observationId: 'do_9', elements: rebuilt }) }],
    })
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
        { action: 'set_toggle', ref: 'w.4#10', state: 'on' },
      ]),
      ctxWith(port),
    )
    expect(calls).toHaveLength(1)
    expect(r).toMatchObject({
      status: 'failure',
      executed: true,
      errorKind: 'desktop_ref_unknown',
    })
    expect(r.message).toContain('2 set_toggle w.4#10 没有执行')
  })

  test('引用接续：按 automationId 定位的步骤在新观察里重新解析', async () => {
    const rebuilt = TABLE.map((e) => (e.ref === 'w.4#10' ? { ...e, ref: 'w.4#77' } : { ...e }))
    const { port, calls } = sequencePort({
      acts: [{ observation: snapshot({ observationId: 'do_9', elements: rebuilt }) }],
    })
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
        { action: 'set_toggle', automationId: 'triCheck', state: 'on' },
      ]),
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    const second = calls[1]?.input as { observationId: string; ref: string }
    expect(second.ref).toBe('w.4#77')
    expect(second.observationId).toBe('do_9')
  })

  test('目标歧义时停在那一步，候选按祖先路径列出', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
        { action: 'invoke', name: '保存' },
      ]),
      ctxWith(port),
    )
    expect(calls).toHaveLength(1)
    expect(r).toMatchObject({
      status: 'failure',
      executed: true,
      errorKind: 'desktop_target_ambiguous',
    })
    expect(r.message).toContain('匹配到 2 个控件')
  })

  test('起手那份观察已经失效时一步都不派发', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      {
        windowId: 'dw_1',
        observationId: 'do_404',
        steps: [{ action: 'set_value', ref: 'w.1.0#5', value: '张三' }],
      },
      ctxWith(port),
    )
    expect(calls).toEqual([])
    expect(r).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'desktop_observation_stale',
    })
  })

  test('本轮已停止时整组不发起', async () => {
    const controller = new AbortController()
    controller.abort()
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([{ action: 'set_value', ref: 'w.1.0#5', value: '张三' }]),
      ctxWith(port, controller.signal),
    )
    expect(calls).toEqual([])
    expect(r).toMatchObject({ status: 'failure', executed: false, errorKind: 'aborted' })
  })

  test('没有端口时如实报，不当成执行过', async () => {
    const r = await run(
      desktopActSequenceTool,
      seq([{ action: 'invoke', ref: 'w.0.0#3' }]),
      ctxWith(),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false, errorKind: 'unsupported' })
  })

  test('端口声明执行前拒绝时这一步记没有执行', async () => {
    const refusal: DesktopRefusal = { errorKind: 'desktop_unavailable', executed: false }
    const { port } = sequencePort()
    const failing: DesktopPort = {
      ...port,
      act: async () => {
        throw Object.assign(new Error('电脑控制此刻不可用'), refusal)
      },
    }
    const r = await run(
      desktopActSequenceTool,
      seq([{ action: 'set_value', ref: 'w.1.0#5', value: '张三' }]),
      ctxWith(failing),
    )
    expect(r).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'desktop_unavailable',
    })
  })

  test('端口没声明执行事实时按可能已生效收尾', async () => {
    const { port } = sequencePort()
    const failing: DesktopPort = {
      ...port,
      act: async () => {
        throw new Error('连接断了')
      },
    }
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'w.1.0#5', value: '张三' },
        { action: 'invoke', ref: 'w.0.0#3' },
      ]),
      ctxWith(failing),
    )
    expect(r).toMatchObject({ status: 'failure', executed: true, errorKind: 'desktop_unknown' })
    expect(r.message).toContain('不要重放')
    const data = r.data as { dispatched: number[]; notExecuted: number[] }
    expect(data.dispatched).toEqual([1])
    expect(data.notExecuted).toEqual([2])
  })
})

/**
 * strict 工具 schema 把每个可选参数都列进 `required` 并在类型里加 `null`，
 * 模型因此为用不上的参数填 `null`。这些 `null` 必须与「没给」等价。
 */
describe('可选参数填空位', () => {
  /** 按 strict 形状补齐：schema 里的每个键都在，没点名的填 null。 */
  function strictArgs(spec: ToolSpec, named: Record<string, unknown>): Record<string, unknown> {
    const props = (spec.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(props)) out[key] = key in named ? named[key] : null
    return out
  }

  test('structure 观察带着 imageRect: null 仍然读树', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      strictArgs(desktopObserveTool, { windowId: 'dw_1', capture: 'structure' }),
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls.map((c) => c.method)).toEqual(['observe'])
  })

  test('invoke 带着另外二十来个 null 参数仍然派发', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      strictArgs(desktopActTool, {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'invoke',
        ref: 'w.0.0#3',
      }),
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls.filter((c) => c.method === 'act')).toHaveLength(1)
    expect((calls.find((c) => c.method === 'act')?.input as { action: unknown }).action).toEqual({
      kind: 'invoke',
    })
  })

  test('空位填空串时同样派发：模型两种填法都见过', async () => {
    const { port, calls } = fakeDesktop()
    const padded = strictArgs(desktopActTool, {
      windowId: 'dw_1',
      observationId: 'do_1',
      action: 'set_value',
      ref: 'w.1.0#5',
      value: '张三',
    })
    // 字符串型的空位填空串，数值型的填 null——实测里模型就是这么混着填的。
    for (const [key, v] of Object.entries(padded)) if (v === null) padded[key] = ''
    padded.number = null
    padded.imageRect = null
    const r = await run(desktopActTool, padded, ctxWith(port))
    expect(r.status).toBe('success')
    expect(calls.filter((c) => c.method === 'act')).toHaveLength(1)
  })

  test('真的给了不属于这个动作的值仍然当场拒绝', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      strictArgs(desktopActTool, {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'invoke',
        ref: 'w.0.0#3',
        value: '张三',
      }),
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(r.message).toContain('invoke 不接受 value')
    expect(calls).toEqual([])
  })
})
