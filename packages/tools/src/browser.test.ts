/**
 * 七个内置浏览器工具。**覆盖范围**：`browser.ts` 的参数校验、路径裁决、终态判定、
 * 观察投递与注册元数据。
 *
 * 端口那一侧由 `packages/server/src/browser/*.test.ts` 覆盖。这里用一份记账假端口：
 * 断言的是「宿主传下去的是什么」与「有没有传下去」，不是调了几次。
 */

import { describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BrowserActResult,
  BrowserObservation,
  BrowserOptionsPage,
  BrowserPort,
  BrowserRefusal,
  ToolContext,
  ToolOutcome,
  ToolSpec,
} from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import {
  browserActTool,
  browserDownloadTool,
  browserNavigateTool,
  browserObserveTool,
  browserTabsTool,
  browserTools,
  browserUploadTool,
  browserWaitTool,
} from './browser.ts'

const OB: BrowserObservation = {
  tabId: 'bt_1',
  url: 'https://a/',
  title: 'A',
  observationId: 'ob_1',
  elements: [{ ref: 'e1', role: 'button', name: '提交', tag: 'button' }],
  truncated: false,
}

interface Recorded {
  method: string
  input: unknown
}

function fakeBrowser(over: Partial<BrowserPort> = {}): { port: BrowserPort; calls: Recorded[] } {
  const calls: Recorded[] = []
  const note = (method: string, input: unknown) => {
    calls.push({ method, input })
  }
  const base: BrowserPort = {
    tabs: async () => {
      note('tabs', null)
      return [
        { tabId: 'bt_1', url: 'https://a/', title: 'A', controlled: true },
        { tabId: 'bt_2', url: 'https://b/', title: 'B', controlled: false },
      ]
    },
    open: async (url) => {
      note('open', url)
      return { tabId: 'bt_9', url, title: '', controlled: true }
    },
    bind: async (tabId) => {
      note('bind', tabId)
      return { tabId, url: 'https://a/', title: 'A', controlled: true }
    },
    close: async (tabId) => {
      note('close', tabId)
    },
    navigate: async (input) => {
      note('navigate', input)
      return { observation: OB, settle: 'quiet' }
    },
    observe: async (input) => {
      note('observe', input)
      if (!input.optionsFor) return OB
      return {
        tabId: input.tabId,
        observationId: input.optionsFor.observationId,
        ref: input.optionsFor.ref,
        items: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b', disabled: true },
        ],
        total: 42,
        offset: input.optionsFor.offset ?? 0,
        nextOffset: (input.optionsFor.offset ?? 0) + 2,
      } satisfies BrowserOptionsPage
    },
    act: async (input) => {
      note('act', input)
      return { element: 'button 提交', observation: OB, settle: 'quiet' }
    },
    wait: async (input) => {
      note('wait', input)
      return { found: true, observation: OB }
    },
    upload: async (input) => {
      note('upload', input)
      return { files: input.paths }
    },
    download: async (input) => {
      note('download', input)
      return { path: input.absolutePath, bytes: 3 }
    },
    release: async () => {},
  }
  return { port: { ...base, ...over }, calls }
}

function ctxWith(
  workspaceRoot: string,
  browser?: BrowserPort,
  signal = new AbortController().signal,
): ToolContext {
  return {
    workspaceRoot,
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
    ...(browser ? { browser } : {}),
  }
}

/** 带一个 a.txt 的工作区，上传与下载的路径裁决要真实文件系统。 */
async function workspace(): Promise<string> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'qywork-browser-')))
  await writeFile(join(root, 'a.txt'), 'abc', 'utf8')
  return root
}

const data = (r: ToolOutcome): Record<string, unknown> => r.data ?? {}

describe('注册元数据', () => {
  test('七个工具、同一个类目与权限效果', () => {
    expect(browserTools.map((t) => t.name)).toEqual([
      'browser_tabs',
      'browser_navigate',
      'browser_observe',
      'browser_act',
      'browser_wait',
      'browser_upload',
      'browser_download',
    ])
    for (const spec of browserTools) {
      expect(spec.category).toBe('browser')
      expect(spec.permissionEffect).toBe('browser')
      expect(spec.objectLabel).toBe('浏览器控制')
      expect(spec.facet).toBe('页面')
      expect(spec.summary.trim()).not.toBe('')
      // 默认串行：不声明 parallelSafe，同一页上两个动作不进同一波次。
      expect(spec.parallelSafe).toBeUndefined()
    }
    // summary 各写各的，不共用一句。
    expect(new Set(browserTools.map((t) => t.summary)).size).toBe(7)
  })

  test('动作轴：读的是读，动页面的是 call', () => {
    const kind = (spec: ToolSpec, args: Record<string, unknown>) =>
      typeof spec.actionKind === 'function' ? spec.actionKind(args) : spec.actionKind
    expect(kind(browserTabsTool, { action: 'list' })).toBe('read')
    expect(kind(browserTabsTool, { action: 'create' })).toBe('call')
    expect(kind(browserTabsTool, { action: 'close' })).toBe('call')
    expect(kind(browserObserveTool, {})).toBe('read')
    expect(kind(browserWaitTool, {})).toBe('read')
    expect(kind(browserActTool, {})).toBe('call')
    expect(kind(browserNavigateTool, {})).toBe('call')
    expect(kind(browserUploadTool, {})).toBe('call')
    expect(kind(browserDownloadTool, {})).toBe('call')
  })

  test('目标取 tabId，tabs 没给时退回 browser', () => {
    expect(browserActTool.targetExtractor?.({ tabId: 'bt_1' })).toBe('bt_1')
    expect(browserActTool.targetExtractor?.({})).toBeNull()
    expect(browserTabsTool.targetExtractor?.({ action: 'close', tabId: 'bt_1' })).toBe('bt_1')
    expect(browserTabsTool.targetExtractor?.({ action: 'list' })).toBe('browser')
  })
})

describe('发动作之前的终态', () => {
  test('没有端口时七个工具都明确失败，不静默成功', async () => {
    const ctx = ctxWith('/w')
    for (const spec of browserTools) {
      const r = await spec.fn({ tabId: 'bt_1', action: 'list' }, ctx)
      expect(r.status).toBe('failure')
      expect(r.executed).toBe(false)
      expect(r.message).toContain('没有内置浏览器')
    }
  })

  test('已停止就不再发动作', async () => {
    const { port, calls } = fakeBrowser()
    const ac = new AbortController()
    ac.abort()
    const r = await browserActTool.fn(
      { tabId: 'bt_1', observationId: 'ob_1', action: 'click', ref: 'e1' },
      ctxWith('/w', port, ac.signal),
    )
    expect(r.status).toBe('failure')
    expect(r.executed).toBe(false)
    expect(r.message).toContain('已停止')
    expect(calls).toHaveLength(0)
  })

  test('只放行 http 与 https，javascript: 到不了端口', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini']) {
      const r = await browserTabsTool.fn({ action: 'create', url }, ctx)
      expect(r.status).toBe('failure')
      expect(r.executed).toBe(false)
      expect(r.message).toContain('只支持 http 与 https')
    }
    const bad = await browserNavigateTool.fn(
      { tabId: 'bt_1', action: 'goto', url: 'javascript:void 0' },
      ctx,
    )
    expect(bad.executed).toBe(false)
    expect(calls).toHaveLength(0)

    const ok = await browserTabsTool.fn({ action: 'create', url: 'https://a/' }, ctx)
    expect(ok.status).toBe('success')
    expect(calls).toEqual([{ method: 'open', input: 'https://a/' }])
  })

  test('认不出的动作名直接拒绝，不猜一个近似的', async () => {
    const { port, calls } = fakeBrowser()
    const r = await browserActTool.fn(
      { tabId: 'bt_1', observationId: 'ob_1', action: 'swipe', ref: 'e1' },
      ctxWith('/w', port),
    )
    expect(r.message).toContain('action 只能是')
    expect(r.executed).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test('元素动作缺 ref、press 缺 key 都在调端口前判', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const noRef = await browserActTool.fn(
      { tabId: 'bt_1', observationId: 'ob_1', action: 'click' },
      ctx,
    )
    expect(noRef.executed).toBe(false)
    expect(noRef.message).toContain('ref')

    const noKey = await browserActTool.fn(
      { tabId: 'bt_1', observationId: 'ob_1', action: 'press' },
      ctx,
    )
    expect(noKey.executed).toBe(false)
    expect(noKey.message).toContain('key')
    expect(calls).toHaveLength(0)

    // scroll 不带 ref 是合法的，作用于整页。
    const scroll = await browserActTool.fn(
      { tabId: 'bt_1', observationId: 'ob_1', action: 'scroll', deltaY: 300 },
      ctx,
    )
    expect(scroll.status).toBe('success')
    expect(calls.at(-1)?.input).toMatchObject({ action: 'scroll', deltaY: 300 })
  })

  test('非有限数不透传给端口', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const bad = await browserWaitTool.fn({ tabId: 'bt_1', selector: '#x', timeoutMs: 'abc' }, ctx)
    expect(bad.executed).toBe(false)
    expect(bad.message).toContain('timeoutMs')

    const inf = await browserActTool.fn(
      { tabId: 'bt_1', observationId: 'ob_1', action: 'scroll', deltaY: Number.POSITIVE_INFINITY },
      ctx,
    )
    expect(inf.executed).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('动作的适用范围', () => {
  const base = { tabId: 'bt_1', observationId: 'ob_1' }

  test('schema 的动作枚举与运行时接受的动作是同一份', () => {
    const actionEnum = (browserActTool.parameters as { properties: { action: { enum: string[] } } })
      .properties.action.enum
    expect(actionEnum).toEqual([
      'click',
      'dblclick',
      'rightclick',
      'hover',
      'fill',
      'type',
      'select',
      'scroll',
      'press',
      'drag',
    ])
  })

  test('新动作的合法参数原样到端口', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    for (const action of ['hover', 'dblclick', 'rightclick']) {
      const r = await browserActTool.fn({ ...base, action, ref: 'e1' }, ctx)
      expect(r.status).toBe('success')
      expect(calls.at(-1)?.input).toEqual({ ...base, action, ref: 'e1' })
    }

    await browserActTool.fn({ ...base, action: 'drag', ref: 'e1', toRef: 'e2' }, ctx)
    expect(calls.at(-1)?.input).toEqual({ ...base, action: 'drag', ref: 'e1', toRef: 'e2' })

    await browserActTool.fn({ ...base, action: 'type', ref: 'e1', text: '你好' }, ctx)
    expect(calls.at(-1)?.input).toEqual({ ...base, action: 'type', ref: 'e1', text: '你好' })

    await browserActTool.fn({ ...base, action: 'press', key: 'Ctrl+Shift+Enter' }, ctx)
    expect(calls.at(-1)?.input).toEqual({ ...base, action: 'press', key: 'Ctrl+Shift+Enter' })
  })

  test('鼠标动作缺 ref 在调端口前判', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    for (const action of ['click', 'dblclick', 'rightclick', 'hover']) {
      const r = await browserActTool.fn({ ...base, action }, ctx)
      expect(r.executed).toBe(false)
      expect(r.message).toContain('必须给 ref')
    }
    expect(calls).toHaveLength(0)
  })

  test('drag 要两端，两端不能是同一个', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const drag = { ...base, action: 'drag' }

    const noTo = await browserActTool.fn({ ...drag, ref: 'e1' }, ctx)
    expect(noTo.executed).toBe(false)
    expect(noTo.message).toContain('toRef')

    const noFrom = await browserActTool.fn({ ...drag, toRef: 'e2' }, ctx)
    expect(noFrom.executed).toBe(false)
    expect(noFrom.message).toContain('必须给 ref')

    const same = await browserActTool.fn({ ...drag, ref: 'e1', toRef: 'e1' }, ctx)
    expect(same.executed).toBe(false)
    expect(same.message).toContain('不能是同一个元素')
    expect(calls).toHaveLength(0)
  })

  test('用不上的参数拒绝，不静默忽略', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const cases: Record<string, unknown>[] = [
      { action: 'click', ref: 'e1', toRef: 'e2' },
      { action: 'scroll', key: 'Enter' },
      { action: 'hover', ref: 'e1', text: 'x' },
      { action: 'press', key: 'Enter', deltaY: 100 },
      { action: 'drag', ref: 'e1', toRef: 'e2', text: 'x' },
      { action: 'fill', ref: 'e1', text: 'x', key: 'Enter' },
      { action: 'type', ref: 'e1', text: 'x', toRef: 'e2' },
      { action: 'select', ref: 'e1', text: 'x', deltaY: 1 },
    ]
    for (const args of cases) {
      const r = await browserActTool.fn({ ...base, ...args }, ctx)
      expect(r.executed).toBe(false)
      expect(r.message).toContain('不接受')
    }
    expect(calls).toHaveLength(0)
  })

  test('type 的长度与控制字符在调端口前判', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const typing = { ...base, action: 'type', ref: 'e1' }

    const long = await browserActTool.fn({ ...typing, text: 'a'.repeat(2001) }, ctx)
    expect(long.executed).toBe(false)
    expect(long.message).toContain('最多 2000 个字符')

    const control = await browserActTool.fn({ ...typing, text: 'ab' }, ctx)
    expect(control.executed).toBe(false)
    expect(control.message).toContain('U+0007')

    const empty = await browserActTool.fn({ ...typing, text: '' }, ctx)
    expect(empty.executed).toBe(false)
    expect(empty.message).toContain('type 必须给 text')
    expect(calls).toHaveLength(0)

    const edge = await browserActTool.fn({ ...typing, text: 'a'.repeat(2000) }, ctx)
    expect(edge.status).toBe('success')

    // 按 Unicode 码点计数：1001 个 emoji 是 2002 个 UTF-16 单元，仍在上限内。
    const emoji = '😀'.repeat(1001)
    const many = await browserActTool.fn({ ...typing, text: emoji }, ctx)
    expect(many.status).toBe('success')
    expect(calls.at(-1)?.input).toMatchObject({ text: emoji })

    // CRLF 与单独的 CR 归一为换行；制表符保留。
    await browserActTool.fn({ ...typing, text: 'a\r\nb\rc\td' }, ctx)
    expect(calls.at(-1)?.input).toMatchObject({ text: 'a\nb\nc\td' })
  })

  test('press 的键名整串预检', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const press = { ...base, action: 'press' }

    for (const key of ['Enter', 'Ctrl+A', 'Shift+Tab', 'Ctrl+Shift+Enter', 'Plus', 'Ctrl+Plus']) {
      const r = await browserActTool.fn({ ...press, key }, ctx)
      expect(r.status).toBe('success')
      expect(calls.at(-1)?.input).toMatchObject({ key })
    }
    // 段之间的空格归一，端口拿到的是规范写法。
    await browserActTool.fn({ ...press, key: 'Ctrl + A' }, ctx)
    expect(calls.at(-1)?.input).toMatchObject({ key: 'Ctrl+A' })

    const sent = calls.length
    // 主键名与结构在同一处判：认不出的主键同样是参数错，端口一次都不该被调进去。
    for (const key of [
      'Ctrl+',
      '+',
      'Ctrl++A',
      'Ctrl+Ctrl+A',
      'Super+A',
      'Ctrl+A+B',
      'NoSuchKey',
      'F13',
      'Ctrl+NoSuchKey',
      'enter',
    ]) {
      const r = await browserActTool.fn({ ...press, key }, ctx)
      expect(r.status).toBe('failure')
      expect(r.executed).toBe(false)
      expect(r.errorKind).toBe('invalid_argument')
    }
    expect(calls).toHaveLength(sent)

    const unknown = await browserActTool.fn({ ...press, key: 'NoSuchKey' }, ctx)
    expect(unknown.message).toContain('NoSuchKey')
    expect(unknown.message).toContain('Enter')
  })
})

describe('部分完成与结果未知', () => {
  test('partial 是失败，回执与新观察都在，消息说明不要重放', async () => {
    const { port } = fakeBrowser({
      act: async () => ({
        element: 'textarea 备注',
        execution: { state: 'partial', confirmedUnits: 12 },
        observation: OB,
        settle: 'quiet',
      }),
    })
    const r = await browserActTool.fn(
      { tabId: 'bt_1', observationId: 'ob_0', action: 'type', ref: 'e1', text: '一二三' },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('failure')
    expect(r.executed).toBe(true)
    expect(r.errorKind).toBe('browser_partial')
    expect(r.message).toContain('已确认 12 个单元')
    expect(r.message).toContain('不要重放')
    expect(data(r)).toMatchObject({
      element: 'textarea 备注',
      execution: { state: 'partial', confirmedUnits: 12 },
      observationId: 'ob_1',
      settle: 'quiet',
    })
    expect(data(r).elements).toHaveLength(1)
  })

  test('unknown 没有观察时保留回执与观察失败原因', async () => {
    const { port } = fakeBrowser({
      act: async () => ({
        execution: { state: 'unknown' },
        observation: null,
        observationError: '连接已断开',
      }),
    })
    const r = await browserActTool.fn(
      { tabId: 'bt_1', observationId: 'ob_0', action: 'drag', ref: 'e1', toRef: 'e2' },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('failure')
    expect(r.executed).toBe(true)
    expect(r.errorKind).toBe('browser_unknown')
    expect(r.message).toContain('结果未知')
    expect(r.message).toContain('连接已断开')
    expect(r.message).toContain('不要重放')
    expect(data(r)).toEqual({ execution: { state: 'unknown' }, observationError: '连接已断开' })
  })

  test('completed 与缺席都按普通成功投递', async () => {
    const { port } = fakeBrowser({
      act: async () => ({
        element: 'button 提交',
        execution: { state: 'completed', confirmedUnits: 2 },
        observation: OB,
      }),
    })
    const r = await browserActTool.fn(
      { tabId: 'bt_1', observationId: 'ob_0', action: 'dblclick', ref: 'e1' },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('success')
    expect(r.errorKind).toBeUndefined()
    expect(data(r)).toMatchObject({
      execution: { state: 'completed', confirmedUnits: 2 },
      observationId: 'ob_1',
    })
  })

  test('端口回执里的其他字段原样带出，不逐个挑', async () => {
    // 字段名由动作那一侧定（fill 的规范化值、约束结果）；这里验的是投递不挑字段。
    const receipt = {
      element: 'input 生日',
      point: { x: 10, y: 20 },
      normalizedValue: '2026-09-16',
      constraint: 'rangeUnderflow',
      observation: OB,
    } as BrowserActResult
    const { port } = fakeBrowser({ act: async () => receipt })
    const r = await browserActTool.fn(
      { tabId: 'bt_1', observationId: 'ob_0', action: 'fill', ref: 'e1', text: '2026-09-16' },
      ctxWith('/w', port),
    )
    expect(data(r)).toMatchObject({
      element: 'input 生日',
      point: { x: 10, y: 20 },
      normalizedValue: '2026-09-16',
      constraint: 'rangeUnderflow',
    })
  })
})

describe('null 与空串的缺席语义', () => {
  test('observe 的可选字段写成 null 时按没给算', async () => {
    const { port, calls } = fakeBrowser()
    const r = await browserObserveTool.fn(
      { tabId: 'bt_1', frame: null, offset: null, screenshot: null, optionsFor: null },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('success')
    expect(calls).toEqual([{ method: 'observe', input: { tabId: 'bt_1' } }])
  })

  test('fill 的空串是清空，null 才是未提供', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    await browserActTool.fn(
      { tabId: 'bt_1', observationId: 'ob_1', action: 'fill', ref: 'e1', text: '' },
      ctx,
    )
    expect(calls.at(-1)?.input).toMatchObject({ text: '' })

    await browserActTool.fn(
      { tabId: 'bt_1', observationId: 'ob_1', action: 'fill', ref: 'e1', text: null },
      ctx,
    )
    expect(calls.at(-1)?.input).not.toHaveProperty('text')
  })

  test('等待时长截到范围内，没给时用默认值', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    await browserWaitTool.fn({ tabId: 'bt_1', selector: '#x' }, ctx)
    expect(calls.at(-1)?.input).toMatchObject({ timeoutMs: 10_000 })
    await browserWaitTool.fn({ tabId: 'bt_1', selector: '#x', timeoutMs: 5 }, ctx)
    expect(calls.at(-1)?.input).toMatchObject({ timeoutMs: 100 })
    await browserWaitTool.fn({ tabId: 'bt_1', selector: '#x', timeoutMs: 999_999 }, ctx)
    expect(calls.at(-1)?.input).toMatchObject({ timeoutMs: 60_000 })
  })
})

describe('观察的投递', () => {
  test('截图走 images，普通字段里不留 base64', async () => {
    const shot = { ...OB, image: { data: 'QUJD', mime: 'image/png' } }
    const { port } = fakeBrowser({ observe: async () => shot })
    const r = await browserObserveTool.fn({ tabId: 'bt_1', screenshot: true }, ctxWith('/w', port))
    expect(data(r).images).toEqual([{ data: 'QUJD', mime: 'image/png' }])
    expect(data(r)).not.toHaveProperty('image')
    expect(JSON.stringify({ ...data(r), images: null })).not.toContain('QUJD')
  })

  test('动作带回观察时展开到顶层，observationId 可直接用', async () => {
    const { port } = fakeBrowser()
    const r = await browserActTool.fn(
      { tabId: 'bt_1', observationId: 'ob_0', action: 'click', ref: 'e1' },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('success')
    expect(data(r)).toMatchObject({
      element: 'button 提交',
      observationId: 'ob_1',
      url: 'https://a/',
      settle: 'quiet',
    })
    expect(data(r).elements).toHaveLength(1)
  })

  test('navigate 同样带回观察，不另回一份 tab/url/title', async () => {
    const { port } = fakeBrowser()
    const r = await browserNavigateTool.fn(
      { tabId: 'bt_1', action: 'goto', url: 'https://a/' },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('success')
    expect(data(r)).toMatchObject({ observationId: 'ob_1', url: 'https://a/' })
    expect(data(r)).not.toHaveProperty('tab')
  })

  test('观察缺席时失败但 executed 为真，回执保留、不给旧编号', async () => {
    const { port } = fakeBrowser({
      act: async () => ({
        element: 'button 提交',
        observation: null,
        observationError: '采集超时',
      }),
    })
    const r = await browserActTool.fn(
      { tabId: 'bt_1', observationId: 'ob_0', action: 'click', ref: 'e1' },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('failure')
    expect(r.executed).toBe(true)
    expect(data(r)).toEqual({ element: 'button 提交', observationError: '采集超时' })
    expect(data(r)).not.toHaveProperty('observationId')
    expect(r.message).toContain('采集超时')
    expect(r.message).toContain('不要重复动作')
  })

  test('wait 超时仍可带观察，状态按 found 定', async () => {
    const { port } = fakeBrowser({
      wait: async () => ({ found: false, reason: 'timeout', observation: OB }),
    })
    const r = await browserWaitTool.fn({ tabId: 'bt_1', selector: '#x' }, ctxWith('/w', port))
    expect(r.status).toBe('failure')
    expect(r.executed).toBe(true)
    expect(data(r)).toMatchObject({ found: false, reason: 'timeout', observationId: 'ob_1' })
    expect(r.message).toContain('没等到 #x')
  })

  test('端口进去之后出错记 executed:true', async () => {
    const { port } = fakeBrowser({
      act: async () => {
        throw new Error('连接已断开')
      },
    })
    const r = await browserActTool.fn(
      { tabId: 'bt_1', observationId: 'ob_0', action: 'click', ref: 'e1' },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('failure')
    expect(r.executed).toBe(true)
    expect(r.message).toContain('连接已断开')
  })

  /**
   * 端口自己声明的执行前拒绝盖过「进没进过端口」的推断。
   *
   * 页面已经被另一个执行者占住时这次调用一帧都没发出去，标成已执行会让模型认为
   * 页面已被动过而不再重试。判据只能是契约字段，不是错误文案。
   */
  test('端口按契约拒绝时记 executed:false，错误种类原样带出', async () => {
    const refusal: BrowserRefusal = { errorKind: 'browser_busy', executed: false }
    const refuse = () => {
      throw Object.assign(new Error('标签页 bt_1 正被另一个任务操作'), refusal)
    }
    const { port } = fakeBrowser({
      act: async () => refuse(),
      observe: async () => refuse(),
      close: async () => refuse(),
    })
    const outcomes = [
      await browserActTool.fn(
        { tabId: 'bt_1', observationId: 'ob_0', action: 'click', ref: 'e1' },
        ctxWith('/w', port),
      ),
      await browserObserveTool.fn({ tabId: 'bt_1' }, ctxWith('/w', port)),
      await browserTabsTool.fn({ action: 'close', tabId: 'bt_1' }, ctxWith('/w', port)),
    ]
    for (const r of outcomes) {
      expect(r.status).toBe('failure')
      expect(r.executed).toBe(false)
      expect(r.errorKind).toBe('browser_busy')
      expect(r.message).toContain('正被另一个任务操作')
    }
  })

  /** 看不见的 tabId 与 busy 同样一帧未发，回执是参数不合法，不是「已执行但失败」。 */
  test('看不见的 tabId 按契约拒绝时记 executed:false 与 invalid_argument', async () => {
    const refusal: BrowserRefusal = { errorKind: 'invalid_argument', executed: false }
    const deny = (message: string) => async () => {
      throw Object.assign(new Error(message), refusal)
    }
    const outcomes = [
      await browserObserveTool.fn(
        { tabId: 'bt_9' },
        ctxWith('/w', fakeBrowser({ observe: deny('标签页 bt_9 不在本工作区') }).port),
      ),
      await browserTabsTool.fn(
        { action: 'close', tabId: 'bt_9' },
        ctxWith('/w', fakeBrowser({ close: deny('标签页 bt_9 不归本会话') }).port),
      ),
      await browserObserveTool.fn(
        { tabId: 'bt_9' },
        ctxWith('/w', fakeBrowser({ observe: deny('标签页 bt_9 不归本会话') }).port),
      ),
      await browserObserveTool.fn(
        { tabId: 'bt_9' },
        ctxWith('/w', fakeBrowser({ observe: deny('认不出的标签页 bt_9') }).port),
      ),
    ]
    for (const r of outcomes) {
      expect(r.status).toBe('failure')
      expect(r.executed).toBe(false)
      expect(r.errorKind).toBe('invalid_argument')
      expect(r.message).toContain('bt_9')
    }
  })
})

describe('选项读取', () => {
  test('optionsFor 到达端口，选项页展开到 data，范围与下一页写进消息', async () => {
    const { port, calls } = fakeBrowser()
    const r = await browserObserveTool.fn(
      { tabId: 'bt_1', optionsFor: { observationId: 'ob_1', ref: 'e3', offset: 0 } },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('success')
    expect(calls).toEqual([
      {
        method: 'observe',
        input: { tabId: 'bt_1', optionsFor: { observationId: 'ob_1', ref: 'e3', offset: 0 } },
      },
    ])
    expect(data(r)).toMatchObject({ ref: 'e3', total: 42, offset: 0, nextOffset: 2 })
    expect(data(r).items).toHaveLength(2)
    // 选项页不是观察：不给元素表，也不冒充一个新的 observationId。
    expect(data(r)).not.toHaveProperty('elements')
    expect(data(r).observationId).toBe('ob_1')
    expect(r.message).toContain('1-2/42')
    expect(r.message).toContain('optionsFor.offset=2')
  })

  test('optionsFor 与 frame、screenshot、offset 混用在调端口前拒绝', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const optionsFor = { observationId: 'ob_1', ref: 'e3' }
    for (const extra of [{ frame: 'f1' }, { screenshot: true }, { offset: 10 }]) {
      const r = await browserObserveTool.fn({ tabId: 'bt_1', optionsFor, ...extra }, ctx)
      expect(r.status).toBe('failure')
      expect(r.executed).toBe(false)
      expect(r.message).toContain('不能与')
    }
    expect(calls).toHaveLength(0)
  })

  test('optionsFor 的必填项与取值范围在调端口前判', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const cases = [
      { optionsFor: { ref: 'e3' } },
      { optionsFor: { observationId: 'ob_1' } },
      { optionsFor: { observationId: 'ob_1', ref: 'e3', offset: -1 } },
      { optionsFor: { observationId: 'ob_1', ref: 'e3', offset: 'abc' } },
      { optionsFor: 'e3' },
    ]
    for (const args of cases) {
      const r = await browserObserveTool.fn({ tabId: 'bt_1', ...args }, ctx)
      expect(r.status).toBe('failure')
      expect(r.executed).toBe(false)
      expect(r.message).toContain('optionsFor')
    }
    expect(calls).toHaveLength(0)
  })
})

describe('路径裁决', () => {
  test('上传路径先过工作区裁决，越界时一个都不到端口', async () => {
    const root = await workspace()
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith(root, port)
    const args = { tabId: 'bt_1', observationId: 'ob_1', ref: 'e1' }

    const ok = await browserUploadTool.fn({ ...args, paths: ['a.txt'] }, ctx)
    expect(ok.status).toBe('success')
    expect(data(ok).files).toEqual([join(root, 'a.txt')])

    const out = await browserUploadTool.fn({ ...args, paths: ['a.txt', '../../hosts'] }, ctx)
    expect(out.status).toBe('failure')
    expect(out.executed).toBe(false)
    // 路径拒绝原样端出去，不压成一句通用错误。
    expect(out.errorKind).toBe('path_out_of_workspace')
    expect(calls.filter((c) => c.method === 'upload')).toHaveLength(1)
  })

  test('上传数量越界在调端口前拒绝', async () => {
    const root = await workspace()
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith(root, port)
    const args = { tabId: 'bt_1', observationId: 'ob_1', ref: 'e1' }

    const none = await browserUploadTool.fn({ ...args, paths: [] }, ctx)
    expect(none.executed).toBe(false)
    const many = await browserUploadTool.fn(
      { ...args, paths: Array.from({ length: 11 }, () => 'a.txt') },
      ctx,
    )
    expect(many.executed).toBe(false)
    expect(many.message).toContain('最多上传 10 个文件')
    expect(calls).toHaveLength(0)
  })

  test('下载先裁决路径再触发，端口拿到绝对路径', async () => {
    const root = await workspace()
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith(root, port)
    const args = { tabId: 'bt_1', observationId: 'ob_1', ref: 'e1' }

    const ok = await browserDownloadTool.fn({ ...args, path: 'out.bin' }, ctx)
    expect(ok.status).toBe('success')
    expect(calls.at(-1)?.input).toMatchObject({
      absolutePath: join(root, 'out.bin'),
      timeoutMs: 120_000,
    })

    const out = await browserDownloadTool.fn({ ...args, path: '../../out.bin' }, ctx)
    expect(out.executed).toBe(false)
    expect(out.errorKind).toBe('path_out_of_workspace')
    expect(calls.filter((c) => c.method === 'download')).toHaveLength(1)
  })

  test('被宿主拦下的下载是失败，原因原样带回', async () => {
    const root = await workspace()
    const { port } = fakeBrowser({
      download: async () => ({ blocked: '目标已存在', suggestedName: 'report.bin' }),
    })
    const r = await browserDownloadTool.fn(
      { tabId: 'bt_1', observationId: 'ob_1', ref: 'e1', path: 'out.bin' },
      ctxWith(root, port),
    )
    expect(r.status).toBe('failure')
    expect(r.message).toContain('目标已存在')
    expect(data(r)).toMatchObject({ blocked: '目标已存在', suggestedName: 'report.bin' })
  })
})

describe('标签页', () => {
  test('list 分清归本会话的页与用户开的页', async () => {
    const { port } = fakeBrowser()
    const r = await browserTabsTool.fn({ action: 'list' }, ctxWith('/w', port))
    expect(r.status).toBe('success')
    expect(r.message).toContain('2 个标签页')
    expect(r.message).toContain('1 个是用户开的')
    expect(data(r).tabs).toHaveLength(2)
  })

  test('bind 与 close 要 tabId，缺了在调端口前拒绝', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    expect((await browserTabsTool.fn({ action: 'bind' }, ctx)).executed).toBe(false)
    expect((await browserTabsTool.fn({ action: 'close' }, ctx)).executed).toBe(false)
    expect(calls).toHaveLength(0)

    const closed = await browserTabsTool.fn({ action: 'close', tabId: 'bt_1' }, ctx)
    expect(closed.status).toBe('success')
    expect(calls).toEqual([{ method: 'close', input: 'bt_1' }])
  })
})
