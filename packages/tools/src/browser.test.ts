/**
 * 七个内置浏览器工具。**覆盖范围**：`browser.ts` 的参数校验、路径裁决、终态判定、
 * 观察投递与注册元数据。
 *
 * 端口一侧由 `packages/server/src/browser/*.test.ts` 覆盖。此处使用一个记录调用的假端口：
 * 断言的是宿主传给端口的内容以及是否传递，不是调用次数。
 */

import { describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolContext, ToolOutcome, ToolSpec } from '@qywork/agent'
import { openBatchBudget, Ports, provide, resolveAction } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import {
  type BrowserActInput,
  type BrowserActResult,
  type BrowserObservation,
  type BrowserOptionsPage,
  BrowserPort,
  type BrowserRefusal,
  type LocalFileCheck,
} from './browser/port.ts'
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
  elements: [{ ref: 'e1', role: 'button', name: '提交', tag: 'button' }],
}

interface Recorded {
  method: string
  input: unknown
}

/**
 * 记录调用的假端口。`localFiles` 不计入 `calls`：它在每次调用端口之前设置，不是页面操作；
 * 最近一次设置的裁决由 `files()` 取得。
 */
function fakeBrowser(over: Partial<BrowserPort> = {}): {
  port: BrowserPort
  calls: Recorded[]
  files: () => LocalFileCheck | null
} {
  const calls: Recorded[] = []
  const note = (method: string, input: unknown) => {
    calls.push({ method, input })
  }
  let files: LocalFileCheck | null = null
  const base: BrowserPort = {
    localFiles: (check) => {
      files = check
    },
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
      return { met: true, observation: OB }
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
  return { port: { ...base, ...over }, calls, files: () => files }
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
    state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY, 0),
    sink: null,
    port: new Ports(browser ? [provide(BrowserPort, browser)] : []).get,
    signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
  }
}

/** 含一个 a.txt 的工作区：上传与下载的路径裁决需要真实文件系统。 */
async function workspace(): Promise<string> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'qywork-browser-')))
  await writeFile(join(root, 'a.txt'), 'abc', 'utf8')
  return root
}

const data = (r: ToolOutcome): Record<string, unknown> => r.data ?? {}

/**
 * 原始失败形状：执行后一律以页面标题作为对象，「下载 out.bin」「输入「会议纪要」」「等待 #submit」都显示为「下载 A」等，
 * 无法判断操作的对象。只有调用时的对象不具体（标签页、网页、元素）时才取标题。
 */
describe('执行后的对象', () => {
  const wrapped = (name: string) => browserTools.find((t) => t.name === name)!

  test('下载、上传、输入、等待选择器保留调用时的对象；查看网页取页面标题', async () => {
    const root = await workspace()
    const { port } = fakeBrowser()
    const ctx = ctxWith(root, port)
    const download = await wrapped('browser_download').fn(
      { tabId: 'bt_1', ref: 'e1', path: 'out.bin' },
      ctx,
    )
    expect(download.status).toBe('success')
    expect(download.subject).toBeUndefined()
    const upload = await wrapped('browser_upload').fn({ tabId: 'bt_1', paths: ['a.txt'] }, ctx)
    expect(upload.status).toBe('success')
    expect(upload.subject).toBeUndefined()
    const typed = await wrapped('browser_act').fn(
      { tabId: 'bt_1', action: 'type', ref: 'e1', text: '会议纪要' },
      ctx,
    )
    expect(typed.subject).toBeUndefined()
    const waited = await wrapped('browser_wait').fn({ tabId: 'bt_1', selector: '#submit' }, ctx)
    expect(waited.subject).toBeUndefined()
    const observed = await wrapped('browser_observe').fn({ tabId: 'bt_1' }, ctx)
    expect(observed.subject).toBe('A')
    const clicked = await wrapped('browser_act').fn(
      { tabId: 'bt_1', action: 'click', ref: 'e1' },
      ctx,
    )
    expect(clicked.subject).toBe('button 提交')
  })
})

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
      expect(spec.object).toBeDefined()
      expect(spec.facet).toBe('页面')
      expect(spec.summary.trim()).not.toBe('')
      // 默认串行：不声明 parallelSafe，同一页面上的两个动作不进入同一批。
      expect(spec.parallelSafe).toBeUndefined()
    }
    // 每个工具的 summary 各不相同，不共用同一句。
    expect(new Set(browserTools.map((t) => t.summary)).size).toBe(7)
  })

  test('动作类型：列出标签页为查询，改变页面的操作为调用，目标是标签页编号时不直接显示', () => {
    const kind = (spec: ToolSpec, args: Record<string, unknown>) => resolveAction(spec, args).kind
    expect(kind(browserTabsTool, { action: 'list' })).toBe('query')
    expect(kind(browserTabsTool, { action: 'create' })).toBe('call')
    expect(kind(browserTabsTool, { action: 'close' })).toBe('call')
    expect(kind(browserObserveTool, {})).toBe('read')
    expect(kind(browserWaitTool, {})).toBe('read')
    expect(kind(browserActTool, {})).toBe('call')
    expect(kind(browserNavigateTool, {})).toBe('call')
    expect(kind(browserUploadTool, {})).toBe('call')
    expect(kind(browserDownloadTool, {})).toBe('call')
  })

  test('目标取 tabId，browser_tabs 未提供 tabId 时回退为 browser', () => {
    expect(browserActTool.targetExtractor?.({ tabId: 'bt_1' })).toBe('bt_1')
    expect(browserActTool.targetExtractor?.({})).toBeNull()
    expect(browserTabsTool.targetExtractor?.({ action: 'close', tabId: 'bt_1' })).toBe('bt_1')
    expect(browserTabsTool.targetExtractor?.({ action: 'list' })).toBe('browser')
  })
})

describe('发送动作之前的终态', () => {
  test('没有端口时七个工具都明确失败，不静默成功', async () => {
    const ctx = ctxWith('/w')
    for (const spec of browserTools) {
      const r = await spec.fn({ tabId: 'bt_1', action: 'list' }, ctx)
      expect(r.status).toBe('failure')
      expect(r.executed).toBe(false)
      expect(r.message).toContain('没有内置浏览器')
    }
  })

  test('已停止时不再发送动作', async () => {
    const { port, calls } = fakeBrowser()
    const ac = new AbortController()
    ac.abort()
    const r = await browserActTool.fn(
      { tabId: 'bt_1', action: 'click', ref: 'e1' },
      ctxWith('/w', port, ac.signal),
    )
    expect(r.status).toBe('failure')
    expect(r.executed).toBe(false)
    expect(r.message).toContain('已停止')
    expect(calls).toHaveLength(0)
  })

  test('拒绝执行脚本与其他协议，HTTP/HTTPS 仍可打开', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    for (const url of ['javascript:alert(1)', 'data:text/html,test', 'ftp://host/a']) {
      const r = await browserTabsTool.fn({ action: 'create', url }, ctx)
      expect(r.status).toBe('failure')
      expect(r.executed).toBe(false)
      expect(r.errorKind).toBe('invalid_argument')
    }
    const bad = await browserNavigateTool.fn(
      { tabId: 'bt_1', action: 'goto', url: 'javascript:void 0' },
      ctx,
    )
    expect(bad.executed).toBe(false)
    expect(calls).toHaveLength(0)

    for (const url of ['https://a/', 'http://localhost:8766/pelican-bike.html']) {
      const ok = await browserTabsTool.fn({ action: 'create', url }, ctx)
      expect(ok.status).toBe('success')
      expect(calls.filter((c) => c.method === 'open').at(-1)).toEqual({
        method: 'open',
        input: url,
      })
    }
  })

  test('相对路径、Windows 绝对路径与 file URL 打开同一文件，保留中文和特殊字符', async () => {
    const root = await workspace()
    const name = '鹈鹕 骑车 #100%20.html'
    const absolute = join(root, name)
    await writeFile(absolute, '<title>本地预览</title>')
    const url = pathToFileURL(absolute).href
    const { port, calls } = fakeBrowser()
    for (const input of [name, absolute, url]) {
      const r = await browserTabsTool.fn({ action: 'create', url: input }, ctxWith(root, port))
      expect(r.status).toBe('success')
      expect(calls.filter((c) => c.method === 'open').at(-1)).toEqual({
        method: 'open',
        input: url,
      })
    }
    const withSuffix = `${url}?preview=1#scene`
    const r = await browserNavigateTool.fn(
      { tabId: 'bt_1', action: 'goto', url: withSuffix },
      ctxWith(root, port),
    )
    expect(r.status).toBe('success')
    expect(calls.at(-1)).toEqual({
      method: 'navigate',
      input: { tabId: 'bt_1', action: 'goto', url: withSuffix },
    })
  })

  test('本地路径带查询串时只按 ? 之前的部分查找文件，查询串与片段附加到 file URL', async () => {
    const root = await workspace()
    await mkdir(join(root, '.tmp'))
    const page = join(root, '.tmp', 'autotest.html')
    const hashed = join(root, '.tmp', '鹈鹕 #1.html')
    await writeFile(page, '<title>自动测试</title>')
    await writeFile(hashed, '<title>文件名带井号</title>')
    const { port, calls } = fakeBrowser()
    for (const [input, expected] of [
      ['.tmp/autotest.html?mode=flip', `${pathToFileURL(page).href}?mode=flip`],
      [`${page}?mode=flip#end`, `${pathToFileURL(page).href}?mode=flip#end`],
      ['.tmp/鹈鹕 #1.html?mode=flip', `${pathToFileURL(hashed).href}?mode=flip`],
    ] as const) {
      const r = await browserNavigateTool.fn(
        { tabId: 'bt_1', action: 'goto', url: input },
        ctxWith(root, port),
      )
      expect(r.status).toBe('success')
      expect(calls.at(-1)).toEqual({
        method: 'navigate',
        input: { tabId: 'bt_1', action: 'goto', url: expected },
      })
    }
  })

  test('本地文件不存在、是目录或 URL 编码不合法时，不调用浏览器', async () => {
    const root = await workspace()
    const { port, calls } = fakeBrowser()
    for (const [url, kind] of [
      ['missing.html', 'path_not_found'],
      [root, 'invalid_argument'],
      // 使用编码后的分隔符：`fileURLToPath` 在各平台都拒绝它。`%ZZ` 等非法转义会被原样保留，
      // 在 POSIX 上得到合法的绝对路径。
      ['file:///a%2Fb.html', 'invalid_argument'],
    ]) {
      const r = await browserTabsTool.fn({ action: 'create', url }, ctxWith(root, port))
      expect(r).toMatchObject({ status: 'failure', executed: false, errorKind: kind })
    }
    expect(calls).toHaveLength(0)
  })

  test('本地预览与文件工具共用读取范围：工作区外的文件可预览，凭证文件拒绝', async () => {
    const root = await workspace()
    const outside = await workspace()
    const outsideFile = join(outside, 'a.txt')
    const credential = join(outside, '.npmrc')
    await writeFile(credential, 'token\n')
    const link = join(root, 'linked')
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const { port, calls } = fakeBrowser()
    for (const url of [credential, pathToFileURL(credential).href, join(link, '.npmrc')]) {
      for (const spec of [browserTabsTool, browserNavigateTool]) {
        const r = await spec.fn(
          { action: spec === browserTabsTool ? 'create' : 'goto', tabId: 'bt_1', url },
          ctxWith(root, port),
        )
        expect(r).toMatchObject({
          status: 'failure',
          executed: false,
          errorKind: 'credential_path',
        })
      }
    }
    expect(calls).toHaveLength(0)
    for (const url of [outsideFile, pathToFileURL(outsideFile).href, join(link, 'a.txt')]) {
      const r = await browserTabsTool.fn({ action: 'create', url }, ctxWith(root, port))
      expect(r.status).toBe('success')
      expect(calls.filter((c) => c.method === 'open').at(-1)).toEqual({
        method: 'open',
        input: pathToFileURL(outsideFile).href,
      })
    }
  })

  /**
   * 页面加载之后自行读取的本机文件（子资源、框架、页内跳转）由端口按这一裁决拦截。
   *
   * 原始失败形状：端口不知道本次调用的读取范围，只有作为导航目标的地址经过裁决，
   * 页面中指向凭证文件的 iframe 与脚本跳转直接加载，随后的观察返回文件内容。
   */
  test('每次调用端口之前设置本次调用的本机文件裁决：凭证文件拒绝，其余按读取范围放行，完全访问下不裁决', async () => {
    const root = await workspace()
    const outside = await workspace()
    const credential = join(outside, '.npmrc')
    await writeFile(credential, 'token\n')
    const link = join(root, 'linked')
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const { port, files } = fakeBrowser()
    for (const spec of browserTools) {
      const before = files()
      await spec.fn({ action: 'list', tabId: 'bt_1', selector: '#go' }, ctxWith(root, port))
      expect(files()).not.toBe(before)
    }
    const check = files()
    for (const path of [credential, join(link, '.npmrc')]) {
      expect(await check?.(pathToFileURL(path).href)).toContain('凭证')
    }
    for (const path of [join(outside, 'a.txt'), join(root, 'missing.html')]) {
      expect(await check?.(pathToFileURL(path).href)).toBeNull()
    }

    const full = { ...ctxWith(root, port), unrestrictedPaths: true }
    await browserObserveTool.fn({ tabId: 'bt_1' }, full)
    expect(await files()?.(pathToFileURL(credential).href)).toBeNull()
  })

  test('无法识别的动作名直接拒绝，不推测近似的动作', async () => {
    const { port, calls } = fakeBrowser()
    const r = await browserActTool.fn(
      { tabId: 'bt_1', action: 'swipe', ref: 'e1' },
      ctxWith('/w', port),
    )
    expect(r.message).toContain('action 只能是')
    expect(r.executed).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test('元素动作缺少 ref、press 缺少 phases 时在调用端口前拒绝', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const noRef = await browserActTool.fn({ tabId: 'bt_1', action: 'click' }, ctx)
    expect(noRef.executed).toBe(false)
    expect(noRef.message).toContain('ref')

    const noKey = await browserActTool.fn({ tabId: 'bt_1', action: 'press' }, ctx)
    expect(noKey.executed).toBe(false)
    expect(noKey.message).toContain('phases')
    expect(calls).toHaveLength(0)

    // scroll 不带 ref 是合法的，作用于整页。
    const scroll = await browserActTool.fn({ tabId: 'bt_1', action: 'scroll', deltaY: 300 }, ctx)
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
      { tabId: 'bt_1', action: 'scroll', deltaY: Number.POSITIVE_INFINITY },
      ctx,
    )
    expect(inf.executed).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('动作的适用范围', () => {
  const base = { tabId: 'bt_1' }

  test('schema 的动作枚举与运行时接受的动作一致', () => {
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
      'dialog',
    ])
  })

  test('新动作的合法参数原样传给端口', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    for (const action of ['hover', 'dblclick', 'rightclick']) {
      const r = await browserActTool.fn({ ...base, action, ref: 'e1' }, ctx)
      expect(r.status).toBe('success')
      expect(calls.at(-1)?.input).toEqual({ ...base, action, ref: 'e1' })
    }

    const path = [{ ref: 'e2', point: { x: 5, y: 6 }, durationMs: 300 }]
    await browserActTool.fn({ ...base, action: 'drag', ref: 'e1', keys: ['ShiftLeft'], path }, ctx)
    expect(calls.at(-1)?.input).toEqual({
      ...base,
      action: 'drag',
      ref: 'e1',
      keys: ['ShiftLeft'],
      path,
    })

    await browserActTool.fn({ ...base, action: 'type', ref: 'e1', text: '你好' }, ctx)
    expect(calls.at(-1)?.input).toEqual({ ...base, action: 'type', ref: 'e1', text: '你好' })

    const phases = [{ keys: ['KeyW'], durationMs: 1200 }, { keys: ['KeyW', 'Space'] }]
    await browserActTool.fn({ ...base, action: 'press', phases }, ctx)
    expect(calls.at(-1)?.input).toEqual({ ...base, action: 'press', phases })

    await browserActTool.fn(
      { ...base, action: 'click', ref: 'e3', point: { x: 12, y: 0 }, holdMs: 600 },
      ctx,
    )
    expect(calls.at(-1)?.input).toEqual({
      ...base,
      action: 'click',
      ref: 'e3',
      point: { x: 12, y: 0 },
      holdMs: 600,
    })

    await browserActTool.fn({ ...base, action: 'scroll', deltaX: -200 }, ctx)
    expect(calls.at(-1)?.input).toEqual({ ...base, action: 'scroll', deltaX: -200 })
  })

  test('鼠标动作缺少 ref 时在调用端口前拒绝', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    for (const action of ['click', 'dblclick', 'rightclick', 'hover']) {
      const r = await browserActTool.fn({ ...base, action }, ctx)
      expect(r.executed).toBe(false)
      expect(r.message).toContain('必须提供 ref')
    }
    expect(calls).toHaveLength(0)
  })

  test('drag 必须提供路径与起点，起点与终点不能相同', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const drag = { ...base, action: 'drag' }

    const noPath = await browserActTool.fn({ ...drag, ref: 'e1' }, ctx)
    expect(noPath.executed).toBe(false)
    expect(noPath.message).toContain('path')

    const noFrom = await browserActTool.fn({ ...drag, path: [{ ref: 'e2' }] }, ctx)
    expect(noFrom.executed).toBe(false)
    expect(noFrom.message).toContain('必须提供 ref')

    const same = await browserActTool.fn({ ...drag, ref: 'e1', path: [{ ref: 'e1' }] }, ctx)
    expect(same.executed).toBe(false)
    expect(same.message).toContain('同一个点')

    const noStepRef = await browserActTool.fn(
      { ...drag, ref: 'e1', path: [{ durationMs: 10 }] },
      ctx,
    )
    expect(noStepRef.executed).toBe(false)
    expect(noStepRef.message).toContain('path[0].ref')
    expect(calls).toHaveLength(0)

    // 同一元素上的两个不同点构成合法的拖动，canvas 依赖它绘制线条。
    const line = await browserActTool.fn(
      {
        ...drag,
        ref: 'e1',
        point: { x: 10, y: 10 },
        path: [{ ref: 'e1', point: { x: 50, y: 10 } }],
      },
      ctx,
    )
    expect(line.status).toBe('success')
  })

  test('落点、按住时长与按住的键在调用端口前校验', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const cases: [Record<string, unknown>, string][] = [
      [{ action: 'scroll', point: { x: 1, y: 1 } }, 'point 必须与 ref 一起提供'],
      [{ action: 'click', ref: 'e1', point: { x: -1, y: 1 } }, '不能为负'],
      [{ action: 'click', ref: 'e1', point: [1, 2] }, 'point 必须是'],
      [{ action: 'click', ref: 'e1', holdMs: 6000 }, 'holdMs'],
      [{ action: 'click', ref: 'e1', keys: ['Shift'] }, '不是可用的键码'],
      [{ action: 'click', ref: 'e1', keys: 'ShiftLeft' }, '键码数组'],
    ]
    for (const [args, text] of cases) {
      const r = await browserActTool.fn({ ...base, ...args }, ctx)
      expect(r.executed).toBe(false)
      expect(r.message).toContain(text)
    }
    expect(calls).toHaveLength(0)
  })

  test('不适用的参数予以拒绝，不静默忽略', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const cases: Record<string, unknown>[] = [
      { action: 'click', ref: 'e1', path: [{ ref: 'e2' }] },
      { action: 'scroll', phases: [{ keys: ['Enter'] }] },
      { action: 'hover', ref: 'e1', text: 'x' },
      { action: 'hover', ref: 'e1', holdMs: 100 },
      { action: 'dblclick', ref: 'e1', holdMs: 100 },
      { action: 'press', phases: [{ keys: ['Enter'] }], deltaY: 100 },
      { action: 'press', phases: [{ keys: ['Enter'] }], keys: ['ShiftLeft'] },
      { action: 'drag', ref: 'e1', path: [{ ref: 'e2' }], text: 'x' },
      { action: 'fill', ref: 'e1', text: 'x', keys: ['Enter'] },
      { action: 'type', ref: 'e1', text: 'x', point: { x: 1, y: 1 } },
      { action: 'select', ref: 'e1', text: 'x', deltaX: 1 },
    ]
    for (const args of cases) {
      const r = await browserActTool.fn({ ...base, ...args }, ctx)
      expect(r.executed).toBe(false)
      expect(r.message).toContain('不接受')
    }
    expect(calls).toHaveLength(0)
  })

  /**
   * strict schema 把每个参数列为必填，模型为不属于本动作的参数填写 0 与空集合。
   * 原始失败形状：click 附带 `deltaX: 0` 被拒绝为「click 不接受 deltaX」，press 附带 `point: {x:0,y:0}` 同样被拒绝。
   */
  test('不适用的参数取 0、空集合或各项为 0 的对象时照常执行', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const filler = { deltaX: 0, deltaY: 0, holdMs: 0, keys: [], path: [], phases: [], text: '' }
    const cases: Record<string, unknown>[] = [
      { ...filler, action: 'click', ref: 'e1' },
      { ...filler, action: 'press', phases: [{ keys: ['Tab'] }], point: { x: 0, y: 0 } },
      { ...filler, action: 'type', ref: 'e1', text: 'x', point: { x: 0, y: 0 } },
      { ...filler, action: 'scroll', deltaY: 300, point: { x: 0, y: 0 } },
    ]
    for (const args of cases) {
      const r = await browserActTool.fn({ ...base, ...args }, ctx)
      expect(r.message).not.toContain('不接受')
    }
    expect(calls).toHaveLength(cases.length)
  })

  /**
   * 原始失败形状取自会话账本：模型每次点击都附带下列填充值，`point: {x:0,y:0}` 按元素左上角执行，
   * 圆角按钮的左上角命中父元素，同一个按钮连续点击 190 次没有响应。落点缺省时端口取元素中心。
   */
  test('ref 与 path 上的 point 取 {x:0,y:0} 时按缺省处理，落点为元素中心', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const filler = { deltaX: 0, deltaY: 0, holdMs: 0, keys: [], path: [], phases: [], text: '' }
    const click = await browserActTool.fn(
      { ...base, ...filler, action: 'click', ref: 'e40', point: { x: 0, y: 0 }, screenshot: false },
      ctx,
    )
    expect(click.status).toBe('success')
    const drag = await browserActTool.fn(
      { ...base, action: 'drag', ref: 'e1', path: [{ ref: 'e2', point: { x: 0, y: 0 } }] },
      ctx,
    )
    expect(drag.status).toBe('success')
    const [clicked, dragged] = calls.map((c) => c.input as BrowserActInput)
    expect(clicked).not.toHaveProperty('point')
    expect(dragged).not.toHaveProperty('point')
    expect(dragged?.path).toEqual([{ ref: 'e2' }])
  })

  test('type 的长度与控制字符在调用端口前校验', async () => {
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
    expect(empty.message).toContain('type 必须提供 text')
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

  test('press 的阶段整体预检，键码与上限和端口使用同一张表', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const press = { ...base, action: 'press' }

    const good = [
      [{ keys: ['Enter'] }],
      [{ keys: ['ControlLeft', 'KeyA'] }],
      [{ keys: ['ShiftLeft', 'Tab'] }],
      [{ keys: ['Space'] }, { keys: [], durationMs: 200 }, { keys: ['Space'], durationMs: 500 }],
    ]
    for (const phases of good) {
      const r = await browserActTool.fn({ ...press, phases }, ctx)
      expect(r.status).toBe('success')
      expect(calls.at(-1)?.input).toMatchObject({ phases })
    }
    // strict 改写会把未填写的 durationMs 写为 null，按缺失处理。键码两端的空白会被去除。
    await browserActTool.fn({ ...press, phases: [{ keys: [' KeyW '], durationMs: null }] }, ctx)
    expect(calls.at(-1)?.input).toMatchObject({ phases: [{ keys: ['KeyW'] }] })

    const sent = calls.length
    const tooMany = Array.from({ length: 33 }, () => ({ keys: ['KeyW'] }))
    const wide = [
      { keys: ['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyI'] },
    ]
    for (const phases of [
      [],
      'KeyW',
      [{ keys: ['W'] }],
      [{ keys: ['Ctrl+A'] }],
      [{ keys: ['KeyW', 'KeyW'] }],
      [{ keys: [] }],
      [{ keys: ['KeyW'], durationMs: 6000 }],
      [{ keys: ['KeyW'], durationMs: -1 }],
      [{ keys: ['KeyW'], durationMs: 'abc' }],
      [
        { keys: ['KeyW'], durationMs: 5000 },
        { keys: ['KeyW'], durationMs: 5000 },
        { keys: [], durationMs: 1 },
      ],
      tooMany,
      wide,
    ]) {
      const r = await browserActTool.fn({ ...press, phases }, ctx)
      expect(r.status).toBe('failure')
      expect(r.executed).toBe(false)
      expect(r.errorKind).toBe('invalid_argument')
    }
    expect(calls).toHaveLength(sent)

    const unknown = await browserActTool.fn({ ...press, phases: [{ keys: ['NoSuchKey'] }] }, ctx)
    expect(unknown.message).toContain('NoSuchKey')
    expect(unknown.message).toContain('ControlLeft')
  })
})

describe('部分完成与结果未知', () => {
  test('partial 视为失败，保留回执与新观察，消息说明不要重放', async () => {
    const { port } = fakeBrowser({
      act: async () => ({
        element: 'textarea 备注',
        execution: { state: 'partial', confirmedUnits: 12 },
        observation: OB,
        settle: 'quiet',
      }),
    })
    const r = await browserActTool.fn(
      { tabId: 'bt_1', action: 'type', ref: 'e1', text: '一二三' },
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
      settle: 'quiet',
    })
    expect(data(r).elements).toHaveLength(1)
  })

  test('unknown 没有观察时保留回执与观察失败原因', async () => {
    const { port } = fakeBrowser({
      act: async () => ({
        execution: { state: 'unknown', reason: '控制连接已断开', unreleased: ['KeyW'] },
        observation: null,
        observationError: '连接已断开',
      }),
    })
    const r = await browserActTool.fn(
      {
        tabId: 'bt_1',
        action: 'press',
        phases: [{ keys: ['KeyW'], durationMs: 1000 }],
      },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('failure')
    expect(r.executed).toBe(true)
    expect(r.errorKind).toBe('browser_unknown')
    expect(r.message).toContain('结果未知（控制连接已断开）')
    // 页面可能仍认为该键处于按下状态：结果中说明这一点，调用方才不会把后续异常归因于页面本身。
    expect(r.message).toContain('未确认松开：KeyW')
    expect(r.message).toContain('连接已断开')
    expect(r.message).toContain('不要重放')
    expect(data(r)).toEqual({
      execution: { state: 'unknown', reason: '控制连接已断开', unreleased: ['KeyW'] },
      observationError: '连接已断开',
    })
  })

  test('completed 与缺失均按普通成功投递', async () => {
    const { port } = fakeBrowser({
      act: async () => ({
        element: 'button 提交',
        execution: { state: 'completed', confirmedUnits: 2 },
        observation: OB,
      }),
    })
    const r = await browserActTool.fn(
      { tabId: 'bt_1', action: 'dblclick', ref: 'e1' },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('success')
    expect(r.errorKind).toBeUndefined()
    expect(data(r)).toMatchObject({
      execution: { state: 'completed', confirmedUnits: 2 },
    })
  })

  test('点击改用键盘完成时 message 写明实际方式，回执保留 via', async () => {
    const { port } = fakeBrowser({
      act: async () => ({
        element: '已阅读并了解平台审核规则',
        via: 'keyboard',
        execution: { state: 'completed', confirmedUnits: 2 },
        observation: OB,
      }),
    })
    const r = await browserActTool.fn(
      { tabId: 'bt_1', action: 'click', ref: 'e1' },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('success')
    expect(r.message).toContain(
      'click 已发出：已阅读并了解平台审核规则（控件本身无法点击，已聚焦后按空格）',
    )
    expect(data(r)).toMatchObject({ via: 'keyboard' })
  })

  test('端口回执中的其他字段原样返回，不逐个挑选', async () => {
    // 字段名由动作一侧决定（fill 的规范化值、约束结果）；此处验证投递时不筛选字段。
    const receipt = {
      element: 'input 生日',
      point: { x: 10, y: 20 },
      normalizedValue: '2026-09-16',
      constraint: 'rangeUnderflow',
      observation: OB,
    } as BrowserActResult
    const { port } = fakeBrowser({ act: async () => receipt })
    const r = await browserActTool.fn(
      { tabId: 'bt_1', action: 'fill', ref: 'e1', text: '2026-09-16' },
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

describe('null 与空字符串的缺失语义', () => {
  test('observe 的可选字段写为 null 时按未提供处理', async () => {
    const { port, calls } = fakeBrowser()
    const r = await browserObserveTool.fn(
      { tabId: 'bt_1', frame: null, offset: null, screenshot: null, optionsFor: null },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('success')
    expect(calls).toEqual([{ method: 'observe', input: { tabId: 'bt_1' } }])
  })

  test('fill 的空字符串表示清空，只有 null 表示未提供', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    await browserActTool.fn({ tabId: 'bt_1', action: 'fill', ref: 'e1', text: '' }, ctx)
    expect(calls.at(-1)?.input).toMatchObject({ text: '' })

    await browserActTool.fn({ tabId: 'bt_1', action: 'fill', ref: 'e1', text: null }, ctx)
    expect(calls.at(-1)?.input).not.toHaveProperty('text')
  })

  test('等待时长截断到允许范围内，未提供时使用默认值', async () => {
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
  test('截图经由 images 返回，普通字段中不保留 base64', async () => {
    const shot = { ...OB, image: { data: 'QUJD', mime: 'image/png' } }
    const { port } = fakeBrowser({ observe: async () => shot })
    const r = await browserObserveTool.fn({ tabId: 'bt_1', screenshot: true }, ctxWith('/w', port))
    expect(data(r).images).toEqual([{ data: 'QUJD', mime: 'image/png' }])
    expect(data(r)).not.toHaveProperty('image')
    expect(JSON.stringify({ ...data(r), images: null })).not.toContain('QUJD')
  })

  test('动作返回观察时展开到顶层，元素编号可直接使用', async () => {
    const { port } = fakeBrowser()
    const r = await browserActTool.fn(
      { tabId: 'bt_1', action: 'click', ref: 'e1' },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('success')
    expect(data(r)).toMatchObject({
      element: 'button 提交',
      url: 'https://a/',
      settle: 'quiet',
    })
    expect(data(r).elements).toHaveLength(1)
  })

  test('act 的 screenshot 适用于全部动作，传给端口，截图经由 images 返回', async () => {
    const image = { data: 'QUJD', mime: 'image/png' }
    const { port, calls } = fakeBrowser({
      act: async (input) => {
        calls.push({ method: 'act', input })
        return {
          element: 'button 提交',
          observation: input.screenshot ? { ...OB, image } : OB,
          settle: 'quiet',
        }
      },
    })
    const ctx = ctxWith('/w', port)
    const clicked = await browserActTool.fn(
      { tabId: 'bt_1', action: 'click', ref: 'e1', screenshot: true },
      ctx,
    )
    expect(calls.at(-1)?.input).toMatchObject({ screenshot: true })
    expect(data(clicked).images).toEqual([image])
    expect(data(clicked)).not.toHaveProperty('image')

    const pressed = await browserActTool.fn(
      {
        tabId: 'bt_1',
        action: 'press',
        phases: [{ keys: ['Enter'] }],
        screenshot: true,
      },
      ctx,
    )
    expect(pressed.status).toBe('success')
    expect(data(pressed).images).toEqual([image])

    for (const screenshot of [undefined, null, false]) {
      const plain = await browserActTool.fn(
        { tabId: 'bt_1', action: 'click', ref: 'e1', screenshot },
        ctx,
      )
      expect(calls.at(-1)?.input).not.toHaveProperty('screenshot')
      expect(data(plain)).not.toHaveProperty('images')
    }
  })

  test('动作未完成时 act 的截图同样经由 images 返回', async () => {
    const image = { data: 'QUJD', mime: 'image/png' }
    const { port } = fakeBrowser({
      act: async () => ({
        element: 'input 姓名',
        execution: { state: 'partial', confirmedUnits: 1 },
        observation: { ...OB, image },
        settle: 'quiet',
      }),
    })
    const r = await browserActTool.fn(
      {
        tabId: 'bt_1',
        action: 'type',
        ref: 'e1',
        text: 'ab',
        screenshot: true,
      },
      ctxWith('/w', port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: true, errorKind: 'browser_partial' })
    expect(data(r).images).toEqual([image])
  })

  test('navigate 同样返回观察，不另外返回 tab/url/title', async () => {
    const { port } = fakeBrowser()
    const r = await browserNavigateTool.fn(
      { tabId: 'bt_1', action: 'goto', url: 'https://a/' },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('success')
    expect(data(r)).toMatchObject({ url: 'https://a/' })
    expect(data(r)).not.toHaveProperty('tab')
  })

  test('观察缺失时结果为失败但 executed 为真，保留回执，不返回旧编号', async () => {
    const { port } = fakeBrowser({
      act: async () => ({
        element: 'button 提交',
        observation: null,
        observationError: '采集超时',
      }),
    })
    const r = await browserActTool.fn(
      { tabId: 'bt_1', action: 'click', ref: 'e1' },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('failure')
    expect(r.executed).toBe(true)
    expect(data(r)).toEqual({ element: 'button 提交', observationError: '采集超时' })
    expect(data(r)).not.toHaveProperty('elements')
    expect(r.message).toContain('采集超时')
    expect(r.message).toContain('不要重复动作')
  })

  test('wait 超时仍可返回观察，状态由 met 决定', async () => {
    const { port } = fakeBrowser({
      wait: async () => ({ met: false, reason: 'timeout', observation: OB }),
    })
    const r = await browserWaitTool.fn({ tabId: 'bt_1', selector: '#x' }, ctxWith('/w', port))
    expect(r.status).toBe('failure')
    expect(r.executed).toBe(true)
    expect(data(r)).toMatchObject({ met: false, reason: 'timeout' })
    expect(r.message).toContain('未等到 #x')
    expect(r.errorKind).toBe('timeout')

    // 文档已更换不是超时：不写错误类别，工具行显示「失败」。
    const gone = fakeBrowser({
      wait: async () => ({ met: false, reason: 'gone', observation: OB }),
    })
    const left = await browserWaitTool.fn(
      { tabId: 'bt_1', selector: '#x' },
      ctxWith('/w', gone.port),
    )
    expect(left.status).toBe('failure')
    expect(left.errorKind).toBeUndefined()
  })

  test('wait 的状态缺省为可见；text / value 必须提供 expected，空字符串是合法的期望值', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)

    await browserWaitTool.fn({ tabId: 'bt_1', selector: '#go' }, ctx)
    expect(calls.at(-1)?.input).toEqual({
      tabId: 'bt_1',
      selector: '#go',
      state: 'visible',
      timeoutMs: 10_000,
    })

    const r = await browserWaitTool.fn(
      { tabId: 'bt_1', selector: '#score', state: 'text', expected: '120' },
      ctx,
    )
    expect(calls.at(-1)?.input).toMatchObject({ state: 'text', expected: '120' })
    expect(r.message).toContain('#score 文本包含 "120"，已达到')
    expect(data(r)).toMatchObject({ met: true, state: 'text' })

    await browserWaitTool.fn({ tabId: 'bt_1', selector: '#q', state: 'value', expected: '' }, ctx)
    expect(calls.at(-1)?.input).toMatchObject({ state: 'value', expected: '' })

    const sent = calls.length
    const bad: [Record<string, unknown>, string][] = [
      [{ selector: '#q', state: 'text' }, '必须提供 expected'],
      [{ selector: '#q', state: 'visible', expected: 'x' }, '不接受 expected'],
      [{ selector: '#q', state: 'shown' }, 'state 只能是'],
      [{ state: 'hidden' }, '须与 selector 一起提供'],
    ]
    for (const [args, text] of bad) {
      const one = await browserWaitTool.fn({ tabId: 'bt_1', ...args }, ctx)
      expect(one.executed).toBe(false)
      expect(one.message).toContain(text)
    }
    expect(calls).toHaveLength(sent)
  })

  test('未提供 selector 时等待完整时长后再观察，不使用选择器等待', async () => {
    const { port, calls } = fakeBrowser()
    const started = Date.now()
    const r = await browserWaitTool.fn({ tabId: 'bt_1', timeoutMs: 150 }, ctxWith('/w', port))
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
    expect(r.status).toBe('success')
    expect(calls).toEqual([{ method: 'observe', input: { tabId: 'bt_1' } }])
    expect(data(r)).toMatchObject({ waitedMs: 150 })
    expect(r.message).toContain('已等待 150 毫秒')
  })

  /** 原始失败形状：按时长等待之后的观察不参与比较，元素表与上一次相同时仍整份投递。 */
  test('按时长等待之后与动作相同地和上一次整页观察比较，只给出变化', async () => {
    const { port } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    await browserObserveTool.fn({ tabId: 'bt_1' }, ctx)
    const r = await browserWaitTool.fn({ tabId: 'bt_1', timeoutMs: 100 }, ctx)
    expect(r.status).toBe('success')
    expect(r.message).toContain('元素表与上次观察相同')
    expect(data(r)).toMatchObject({
      waitedMs: 100,
      changes: { unchanged: 1, added: [], changed: [], removed: [] },
    })
    expect(data(r)).not.toHaveProperty('elements')
    expect(r).not.toHaveProperty('changes')
  })

  test('导航与等待的 screenshot 传给端口，按时长等待时随观察一并截图', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    await browserNavigateTool.fn({ tabId: 'bt_1', action: 'reload', screenshot: true }, ctx)
    await browserWaitTool.fn({ tabId: 'bt_1', selector: '#x', screenshot: true }, ctx)
    await browserWaitTool.fn({ tabId: 'bt_1', timeoutMs: 100, screenshot: true }, ctx)
    await browserNavigateTool.fn({ tabId: 'bt_1', action: 'reload', screenshot: false }, ctx)
    expect(calls.map((c) => c.input)).toEqual([
      { tabId: 'bt_1', action: 'reload', screenshot: true },
      { tabId: 'bt_1', selector: '#x', state: 'visible', timeoutMs: 10_000, screenshot: true },
      { tabId: 'bt_1', screenshot: true },
      { tabId: 'bt_1', action: 'reload' },
    ])
  })

  test('按时长等待期间取消：不再观察，按已停止结束', async () => {
    const { port, calls } = fakeBrowser()
    const stop = new AbortController()
    const pending = browserWaitTool.fn(
      { tabId: 'bt_1', timeoutMs: 60_000 },
      ctxWith('/w', port, stop.signal),
    )
    stop.abort()
    expect(await pending).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'aborted',
    })
    expect(calls).toHaveLength(0)
  })

  test('进入端口之后出错时记为 executed:true', async () => {
    const { port } = fakeBrowser({
      act: async () => {
        throw new Error('连接已断开')
      },
    })
    const r = await browserActTool.fn(
      { tabId: 'bt_1', action: 'click', ref: 'e1' },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('failure')
    expect(r.executed).toBe(true)
    expect(r.message).toContain('连接已断开')
  })

  test('按端口提供的依据区分连接准备失败与动作发出后断开，向模型保留恢复指引', async () => {
    for (const executed of [false, true]) {
      const error = Object.assign(
        new Error(
          executed
            ? '控制连接断开，结果可能不明；先 browser_observe 核对，不要重复点击'
            : '控制连接准备失败，操作未执行；先 browser_observe 重连',
        ),
        { errorKind: 'browser_disconnected', ...(executed ? {} : { executed: false }) },
      )
      const { port } = fakeBrowser({
        act: async () => {
          throw error
        },
      })
      const result = await browserActTool.fn(
        { tabId: 'bt_1', action: 'click', ref: 'e1' },
        ctxWith('/w', port),
      )
      expect(result).toMatchObject({
        status: 'failure',
        executed,
        errorKind: 'browser_disconnected',
      })
      expect(result.message).toContain('browser_observe')
    }
  })

  /**
   * 端口自身声明的执行前拒绝优先于「是否进入过端口」的推断。
   *
   * 页面已被另一个执行者占用时，本次调用未发出任何帧，标记为已执行会使模型认为
   * 页面已被改动而不再重试。判据只能是契约字段，不能是错误文案。
   */
  test('端口按契约拒绝时记为 executed:false，错误种类原样返回', async () => {
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
      await browserActTool.fn({ tabId: 'bt_1', action: 'click', ref: 'e1' }, ctxWith('/w', port)),
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

  /** 不可见的 tabId 与 busy 相同，未发出任何帧，回执为参数不合法，而不是「已执行但失败」。 */
  test('不可见的 tabId 按契约拒绝时记为 executed:false 与 invalid_argument', async () => {
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
        ctxWith('/w', fakeBrowser({ observe: deny('无法识别的标签页 bt_9') }).port),
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
  test('optionsFor 传到端口，选项页展开到 data，范围与下一页写入消息', async () => {
    const { port, calls } = fakeBrowser()
    const r = await browserObserveTool.fn(
      { tabId: 'bt_1', optionsFor: { ref: 'e3', offset: 0 } },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('success')
    expect(calls).toEqual([
      {
        method: 'observe',
        input: { tabId: 'bt_1', optionsFor: { ref: 'e3', offset: 0 } },
      },
    ])
    expect(data(r)).toMatchObject({ ref: 'e3', total: 42, offset: 0, nextOffset: 2 })
    expect(data(r).items).toHaveLength(2)
    // 选项页不是观察：不返回元素表，也不改变元素编号。
    expect(data(r)).not.toHaveProperty('elements')
    expect(data(r).ref).toBe('e3')
    expect(r.message).toContain('1-2/42')
    expect(r.message).toContain('optionsFor.offset=2')
  })

  /**
   * 原始失败形状：模型为无关参数填写 `offset: 0`、`query: ""`、`screenshot: false`，读取选项被拒绝，
   * 报错列出全部四个参数，模型无法判断应删去哪一项，同一调用连续重复两次。
   */
  test('optionsFor 附带取 0 与空值的无关参数时照常读取；拒绝时只列出实际提供的参数', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const optionsFor = { ref: 'e3', offset: 0 }
    const ok = await browserObserveTool.fn(
      { tabId: 'bt_1', optionsFor, offset: 0, query: '', screenshot: false, frame: '' },
      ctx,
    )
    expect(ok.status).toBe('success')
    expect(calls).toHaveLength(1)
    const stale = await browserObserveTool.fn(
      { tabId: 'bt_1', optionsFor, frame: 'F1', offset: 0, query: '', screenshot: false },
      ctx,
    )
    expect(stale.executed).toBe(false)
    expect(stale.message).toContain('optionsFor 不能与 frame 同时提供')
  })

  test('optionsFor 与 frame、screenshot、query 同时提供时在调用端口前拒绝', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const optionsFor = { ref: 'e3' }
    for (const extra of [{ frame: 'f1' }, { screenshot: true }, { query: '提交' }]) {
      const r = await browserObserveTool.fn({ tabId: 'bt_1', optionsFor, ...extra }, ctx)
      expect(r.status).toBe('failure')
      expect(r.executed).toBe(false)
      expect(r.message).toContain('不能与')
    }
    expect(calls).toHaveLength(0)
  })

  test('optionsFor 的必填项与取值范围在调用端口前校验', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const cases = [
      { optionsFor: { ref: '' } },
      { optionsFor: {} },
      { optionsFor: { ref: 'e3', offset: -1 } },
      { optionsFor: { ref: 'e3', offset: 'abc' } },
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
  test('上传路径先经过读取范围裁决，任一文件被拒时没有任何文件传到端口', async () => {
    const root = await workspace()
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith(root, port)
    const args = { tabId: 'bt_1', ref: 'e1' }

    const ok = await browserUploadTool.fn({ ...args, paths: ['a.txt'] }, ctx)
    expect(ok.status).toBe('success')
    expect(data(ok).files).toEqual([join(root, 'a.txt')])

    const out = await browserUploadTool.fn({ ...args, paths: ['a.txt', '.npmrc'] }, ctx)
    expect(out.status).toBe('failure')
    expect(out.executed).toBe(false)
    // 路径拒绝原样返回，不合并为一句通用错误。
    expect(out.errorKind).toBe('credential_path')
    expect(calls.filter((c) => c.method === 'upload')).toHaveLength(1)
  })

  test('上传数量超限时在调用端口前拒绝', async () => {
    const root = await workspace()
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith(root, port)
    const args = { tabId: 'bt_1', ref: 'e1' }

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

  /**
   * 下载目标与其他写入工具经同一个入口（`resolveWritablePath`）：写入范围相同，`.qy/` 同样受保护。
   * 被拒绝的目标取家目录中、工作区之外的位置：家目录与系统目录之外的位置在自动审批下可写。
   */
  test('下载先裁决路径再触发，端口收到绝对路径；写入范围与受保护目录与其他写入工具相同', async () => {
    const root = await workspace()
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith(root, port)
    const args = { tabId: 'bt_1', ref: 'e1' }

    const ok = await browserDownloadTool.fn({ ...args, path: 'out.bin' }, ctx)
    expect(ok.status).toBe('success')
    expect(calls.at(-1)?.input).toMatchObject({
      absolutePath: join(root, 'out.bin'),
      idleMs: 120_000,
    })

    // 文件系统根目录下不存在的目录：不位于家目录或系统目录中。端口是模拟的，不创建文件。
    const elsewhere = join(resolve('/'), `qywork-absent-${process.pid}`, 'out.bin')
    const far = await browserDownloadTool.fn({ ...args, path: elsewhere }, ctx)
    expect(far.status).toBe('success')
    expect(calls.at(-1)?.input).toMatchObject({ absolutePath: elsewhere })

    const inHome = join(homedir(), `qywork-absent-${process.pid}`, 'out.bin')
    const out = await browserDownloadTool.fn({ ...args, path: inHome }, ctx)
    expect(out.executed).toBe(false)
    expect(out.errorKind).toBe('path_out_of_workspace')

    const guarded = await browserDownloadTool.fn({ ...args, path: '.qy/out.bin' }, ctx)
    expect(guarded.executed).toBe(false)
    expect(guarded.message).toContain('扩展配置')
    expect(calls.filter((c) => c.method === 'download')).toHaveLength(2)
  })

  test('被宿主拦截的下载视为失败，原因原样返回', async () => {
    const root = await workspace()
    const { port } = fakeBrowser({
      download: async () => ({ blocked: '目标已存在', suggestedName: 'report.bin' }),
    })
    const r = await browserDownloadTool.fn(
      { tabId: 'bt_1', ref: 'e1', path: 'out.bin' },
      ctxWith(root, port),
    )
    expect(r.status).toBe('failure')
    expect(r.message).toContain('目标已存在')
    expect(data(r)).toMatchObject({ blocked: '目标已存在', suggestedName: 'report.bin' })
  })
})

describe('标签页', () => {
  test('list 区分归属本会话的页面与用户打开的页面', async () => {
    const { port } = fakeBrowser()
    const r = await browserTabsTool.fn({ action: 'list' }, ctxWith('/w', port))
    expect(r.status).toBe('success')
    expect(r.message).toContain('2 个标签页')
    expect(r.message).toContain('1 个是用户打开的')
    expect(data(r).tabs).toHaveLength(2)
  })

  test('bind 与 close 必须提供 tabId，缺少时在调用端口前拒绝', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    expect((await browserTabsTool.fn({ action: 'bind' }, ctx)).executed).toBe(false)
    expect((await browserTabsTool.fn({ action: 'close' }, ctx)).executed).toBe(false)
    expect(calls).toHaveLength(0)

    const closed = await browserTabsTool.fn({ action: 'close', tabId: 'bt_1' }, ctx)
    expect(closed.status).toBe('success')
    expect(calls).toEqual([{ method: 'close', input: 'bt_1' }])
  })

  /** 网址长度没有上限，message 只包含简短的执行事实；端口收到的值与 data 中的值都是原值。 */
  test('打开页面的回执中超长网址被截短，端口与 data 收到原值', async () => {
    const { port, calls } = fakeBrowser()
    const url = `https://a/${'p'.repeat(500)}`
    const r = await browserTabsTool.fn({ action: 'create', url }, ctxWith('/w', port))

    expect(r.status).toBe('success')
    expect(r.message.length).toBeLessThan(300)
    expect(r.message).toContain('https://a/pppp')
    // 建页之后直接观察一次，结果附带该页的元素表。
    expect(calls).toEqual([
      { method: 'open', input: url },
      { method: 'observe', input: { tabId: 'bt_9' } },
    ])
    expect(data(r).elements).toEqual(OB.elements)
    expect((data(r) as { tab: { url: string } }).tab.url).toBe(url)
  })
})

/**
 * 动作结果写明页面上发生的事，并与上一次整页观察比较。
 * 原始失败形状：同一个按钮被点击 190 次，每次结果只有「已发出」与一份相同的整表，模型无从判断点击没有生效。
 */
describe('动作结果写明发生了什么', () => {
  const quiet = { navigated: false, requests: 0, domChanged: false }

  /** 先整页观察一次作为基底，再执行一次返回指定观察与动作事实的点击。 */
  async function observeThenClick(
    after: BrowserObservation,
    activity: Record<string, unknown> = quiet,
  ): Promise<ToolOutcome> {
    const { port } = fakeBrowser({
      act: async () => ({ element: '开通', observation: after, settle: 'quiet', activity }),
    } as unknown as Partial<BrowserPort>)
    const ctx = ctxWith('/w', port)
    await browserObserveTool.fn({ tabId: 'bt_1' }, ctx)
    return browserActTool.fn({ tabId: 'bt_1', action: 'click', ref: 'e1' }, ctx)
  }

  test('页面没有任何变化时写明各项事实，只列变化，并声明没有效果', async () => {
    const r = await observeThenClick(OB)
    expect(r.message).toContain('动作之后：未跳转、未发出请求、DOM 无变化')
    expect(r.message).toContain('元素表与上次观察相同')
    expect(r.message).toContain('这次动作没有产生可观察的效果')
    expect(r.noEffect).toBe(true)
    expect(data(r)).not.toHaveProperty('elements')
    expect(data(r).changes).toEqual({ unchanged: 1, added: [], changed: [], removed: [] })
  })

  test('发出了请求或 DOM 有变化时不声明没有效果', async () => {
    const sent = await observeThenClick(OB, { ...quiet, requests: 2 })
    expect(sent.message).toContain('发出请求 2 个')
    expect(sent.noEffect).toBeUndefined()
    const dom = await observeThenClick(OB, { ...quiet, domChanged: true })
    expect(dom.message).toContain('DOM 有变化')
    expect(dom.noEffect).toBeUndefined()
  })

  test('元素变化逐项列出，未变化的元素不重复投递', async () => {
    const after: BrowserObservation = {
      ...OB,
      elements: [
        { ref: 'e1', role: 'button', name: '已开通', tag: 'button' },
        { ref: 'e2', role: 'StaticText', name: '开通成功', tag: '#text' },
      ],
    }
    const base = {
      ...OB,
      elements: [
        ...OB.elements,
        { ref: 'e3', role: 'link', name: '一', tag: 'a' },
        { ref: 'e4', role: 'link', name: '二', tag: 'a' },
        { ref: 'e5', role: 'link', name: '三', tag: 'a' },
      ],
    }
    const { port } = fakeBrowser({
      observe: async () => base,
      act: async () => ({
        element: '开通',
        observation: { ...after, elements: [...after.elements, ...base.elements.slice(1)] },
        settle: 'quiet',
        activity: { ...quiet, requests: 1, domChanged: true },
      }),
    } as unknown as Partial<BrowserPort>)
    const ctx = ctxWith('/w', port)
    await browserObserveTool.fn({ tabId: 'bt_1' }, ctx)
    const r = await browserActTool.fn({ tabId: 'bt_1', action: 'click', ref: 'e1' }, ctx)
    expect(r.message).toContain('与上次观察相比：新增 1、改变 1、消失 0')
    const changes = data(r).changes as {
      changed: { name: string }[]
      added: { name: string }[]
      unchanged: number
    }
    expect(changes.changed.map((e) => e.name)).toEqual(['已开通'])
    expect(changes.added.map((e) => e.name)).toEqual(['开通成功'])
    expect(changes.unchanged).toBe(3)
    expect(r.noEffect).toBeUndefined()
  })

  test('页面含 canvas 时不声明没有效果，并说明画面变化不在元素表中', async () => {
    const canvas: BrowserObservation = {
      ...OB,
      elements: [{ ref: 'e1', role: 'canvas', name: '', tag: 'canvas' }],
    }
    const { port } = fakeBrowser({
      observe: async () => canvas,
      act: async () => ({
        element: 'canvas',
        observation: canvas,
        settle: 'quiet',
        activity: quiet,
      }),
    } as unknown as Partial<BrowserPort>)
    const ctx = ctxWith('/w', port)
    await browserObserveTool.fn({ tabId: 'bt_1' }, ctx)
    const r = await browserActTool.fn({ tabId: 'bt_1', action: 'click', ref: 'e1' }, ctx)
    expect(r.noEffect).toBeUndefined()
    expect(r.message).toContain('canvas')
  })

  test('动作打开的新标签页与被拦截的下载写入结果', async () => {
    const r = await observeThenClick(OB, {
      ...quiet,
      requests: 1,
      opened: [{ tabId: 'bt_7', url: 'https://a/new', title: '新页', controlled: true }],
      downloadsBlocked: [{ reason: 'unauthorized', suggestedName: 'a.zip' }],
    })
    expect(r.message).toContain('打开了新标签页 bt_7（https://a/new）')
    expect(r.message).toContain('下载被拦截（unauthorized：a.zip）')
    expect(r.noEffect).toBeUndefined()
  })

  test('本次执行中尚未整页观察过该页时整份投递元素表', async () => {
    const { port } = fakeBrowser({
      act: async () => ({ element: '开通', observation: OB, settle: 'quiet', activity: quiet }),
    } as unknown as Partial<BrowserPort>)
    const r = await browserActTool.fn(
      { tabId: 'bt_1', action: 'click', ref: 'e1' },
      ctxWith('/w', port),
    )
    expect(data(r).elements).toEqual(OB.elements)
    expect(r.noEffect).toBeUndefined()
  })
})

describe('对话框', () => {
  test('动作弹出对话框时结果为成功，写明对话框文字与处理方法，不设默认选择', async () => {
    const { port } = fakeBrowser({
      act: async () => ({
        observation: null,
        observationError: '页面弹出对话框，处理之前无法读取页面',
        activity: {
          requests: 0,
          domChanged: true,
          dialog: { type: 'confirm', message: '确定删除？' },
        },
      }),
    } as unknown as Partial<BrowserPort>)
    const r = await browserActTool.fn(
      { tabId: 'bt_1', action: 'click', ref: 'e1' },
      ctxWith('/w', port),
    )
    expect(r.status).toBe('success')
    expect(r.message).toContain('页面弹出确认框：「确定删除？」')
    expect(r.message).toContain('accept=true 确定，accept=false 取消')
  })

  test('dialog 动作必须明确提供 accept，提供后原样传给端口', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    const missing = await browserActTool.fn({ tabId: 'bt_1', action: 'dialog' }, ctx)
    expect(missing.executed).toBe(false)
    expect(missing.message).toContain('accept')
    await browserActTool.fn({ tabId: 'bt_1', action: 'dialog', accept: false }, ctx)
    expect(calls.map((c) => c.input)).toEqual([{ tabId: 'bt_1', action: 'dialog', accept: false }])
  })

  test('其他动作附带 accept 的填充值 false 时照常执行，附带 true 时按不适用的参数拒绝', async () => {
    const { port, calls } = fakeBrowser()
    const ctx = ctxWith('/w', port)
    await browserActTool.fn({ tabId: 'bt_1', action: 'click', ref: 'e1', accept: false }, ctx)
    const wrong = await browserActTool.fn(
      { tabId: 'bt_1', action: 'click', ref: 'e1', accept: true },
      ctx,
    )
    expect(wrong.message).toContain('click 不接受 accept')
    expect(calls).toHaveLength(1)
  })
})

describe('建页附带观察', () => {
  test('建页之后观察失败时建页仍为成功，写明未取得观察的原因', async () => {
    const { port } = fakeBrowser({
      observe: async () => {
        throw new Error('标签页 bt_9 正被另一个任务操作')
      },
    })
    const r = await browserTabsTool.fn({ action: 'create', url: 'https://a/' }, ctxWith('/w', port))
    expect(r.status).toBe('success')
    expect(r.message).toContain('已打开 bt_9')
    expect(r.message).toContain('未取得观察：标签页 bt_9 正被另一个任务操作')
    expect(data(r)).toHaveProperty('tab')
    expect(data(r)).not.toHaveProperty('elements')
  })
})

describe('换成另一份文档之后不比较', () => {
  /** 原始失败形状：刷新之后编号全部更换，结果写「新增 5、消失 5」，读起来像页面内容被改动。 */
  test('刷新或跳转之后与上次观察没有共同元素时不写变化计数，整份投递', async () => {
    const reloaded: BrowserObservation = {
      ...OB,
      elements: [{ ref: 'e9', role: 'button', name: '提交', tag: 'button' }],
    }
    const { port } = fakeBrowser({
      navigate: async () => ({ observation: reloaded, settle: 'quiet' }),
    })
    const ctx = ctxWith('/w', port)
    await browserObserveTool.fn({ tabId: 'bt_1' }, ctx)
    const r = await browserNavigateTool.fn({ tabId: 'bt_1', action: 'reload' }, ctx)
    expect(r.message).not.toContain('与上次观察相比')
    expect(data(r).elements).toEqual(reloaded.elements)
  })

  test('两次都没有元素时仍写明相同', async () => {
    const empty: BrowserObservation = { ...OB, elements: [] }
    const { port } = fakeBrowser({ observe: async () => empty })
    const ctx = ctxWith('/w', port)
    await browserObserveTool.fn({ tabId: 'bt_1' }, ctx)
    const r = await browserObserveTool.fn({ tabId: 'bt_1' }, ctx)
    expect(r.message).toContain('元素表与上次观察相同')
  })
})
