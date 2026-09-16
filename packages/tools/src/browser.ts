/**
 * 内置浏览器的七个工具。
 *
 * 一次调用一个有限动作：发一条端口命令就返回，由 Agent 循环再决定下一步。
 * 这里不自己循环、不重试有副作用的动作——重试一次点击等于在网站上多提交一次。
 *
 * 四条边界：
 *
 * 1. **端口只从 `ctx.browser` 取。** 参数里自报的会话、Run、工作区根一概不读。
 *    没有端口时这七个工具不注册（`index.ts` 按通道注册），工具体里仍判一次并如实报错。
 * 2. **注册表不按 schema 校验实参。** 必需参数、取值范围、数值有限性都在这里判，
 *    判完之前不调端口。
 * 3. **`null` 与空串按缺席算。** OpenAI 兼容协议的 strict 改写会把可选字段标成
 *    nullable，模型因此常把没填的字段显式写成 `null`；按「给了一个非法值」拒绝的话，
 *    一次正常调用会被一个没打算填的字段挡下来。例外是 `fill` 的 `text`：
 *    空串表示清空输入框，只有 `null` 才算未提供。
 * 4. **上传下载的路径先裁决再交给端口。** 走这一轮会话的根目录清单（`rootsOf`），
 *    与内置文件工具同一份判定；端口只按裁决后的绝对路径操作。
 *
 * `executed` 的判据是**端口有没有被调进去**：参数、路径、停止状态在调用前拒绝，
 * `executed: false`；调进端口之后的异常一律 `executed: true`，动作可能已经发到网站。
 */

import type {
  BrowserActionKind,
  BrowserObservation,
  BrowserPort,
  FollowUpObservation,
  ToolContext,
  ToolOutcome,
  ToolSpec,
} from '@qywork/agent'
import { resolveInWorkspace, rootsOf } from './paths.ts'

/** 一次等待的上限。超过这个值的请求按它截断，不接受任意时长。 */
const MAX_WAIT_MS = 60_000
/** 等待时长的下限。更短的请求按它抬上来。 */
const MIN_WAIT_MS = 100
/** 调用方没给时长时等多久。 */
const DEFAULT_WAIT_MS = 10_000
/** 一次下载从触发到落盘的上限。 */
const DOWNLOAD_TIMEOUT_MS = 120_000
/** 单次上传的文件数上限。 */
const MAX_UPLOAD_FILES = 10

/**
 * 调用端口之前判出来的参数错。
 *
 * 带 `errorKind` 是为了与路径拒绝（`PathEscapeError` 等）走同一条出口：
 * 两者都是判定不是故障，结果里 `executed` 必须是 `false`。
 */
class ArgError extends Error {
  readonly errorKind = 'invalid_argument'
  constructor(message: string) {
    super(message)
    this.name = 'ArgError'
  }
}

/** 这个可选参数给了没有。`null` 与空串按缺席算，理由见文件头第 3 条。 */
function given(raw: unknown): boolean {
  return raw !== undefined && raw !== null && String(raw).trim() !== ''
}

function str(raw: unknown, field: string): string {
  const value = String(raw ?? '').trim()
  if (!value) throw new ArgError(`缺少 ${field}`)
  return value
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], field: string): T {
  const value = String(raw ?? '')
  if (!allowed.includes(value as T)) {
    throw new ArgError(`${field} 只能是 ${allowed.join(' / ')}，收到 ${JSON.stringify(raw)}`)
  }
  return value as T
}

/** 有限性先判再截断：`NaN` 与 `Infinity` 一旦透传，端口那侧算出来的是一个无界的时限。 */
function finite(raw: unknown, field: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value))
    throw new ArgError(`${field} 必须是数字，收到 ${JSON.stringify(raw)}`)
  return value
}

function nonNegative(raw: unknown, field: string): number {
  const value = finite(raw, field)
  if (value < 0) throw new ArgError(`${field} 必须是非负整数`)
  return Math.floor(value)
}

/**
 * 只放行网页协议。
 *
 * `file:` 能读本机任意文件、`javascript:` 在当前页面执行脚本，两者都绕过这里
 * 全部的边界；模型给出的地址一律按不可信处理。
 */
function webUrl(raw: unknown): string {
  const value = str(raw, 'url')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ArgError(`地址无法解析：${value}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ArgError(`只支持 http 与 https，收到 ${parsed.protocol}`)
  }
  return parsed.toString()
}

const NO_PORT = {
  status: 'failure',
  executed: false,
  message: '本次执行没有内置浏览器，无法操作页面。',
  errorKind: 'unsupported',
} as const

const STOPPED = {
  status: 'failure',
  executed: false,
  message: '本次执行已停止，不再操作浏览器。',
  errorKind: 'aborted',
} as const

/** 把端口调用包起来，调用发生的那一刻记下来。 */
type PortCall = <T>(call: () => Promise<T>) => Promise<T>

function declaredKind(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  const kind = (err as Error & { errorKind?: unknown }).errorKind
  return typeof kind === 'string' && kind ? kind : undefined
}

/**
 * 七个工具共用的前置判定与终态。
 *
 * 停止之后不再发起新动作：等待中的那一次由端口自己拒绝，这里挡的是新来的。
 * 异常的 `executed` 取自 `send` 有没有被调过——不这样判的话，
 * 「参数写错」与「点击已发出但连接断了」会得到同一个结果，而后者禁止重发。
 */
async function onBrowser(
  ctx: ToolContext,
  body: (browser: BrowserPort, send: PortCall) => Promise<ToolOutcome>,
): Promise<ToolOutcome> {
  const browser = ctx.browser
  if (!browser) return NO_PORT
  if (ctx.signal.aborted) return STOPPED

  let entered = false
  const send: PortCall = (call) => {
    entered = true
    return call()
  }
  try {
    return await body(browser, send)
  } catch (err) {
    return {
      status: 'failure',
      executed: entered,
      message: err instanceof Error ? err.message : String(err),
      errorKind: declaredKind(err) ?? (entered ? 'browser_failed' : 'invalid_argument'),
    }
  }
}

/**
 * 观察的投递形状。
 *
 * 截图字节走 `images`：`agent/loop.ts` 的 `imagesOf` 按这个键取图，
 * 留在普通 JSON 字段里的 base64 模型读不懂，只照价计费。
 */
function observationData(ob: BrowserObservation): Record<string, unknown> {
  const { image, ...rest } = ob
  return { ...rest, ...(image ? { images: [image] } : {}) }
}

function observationLine(ob: BrowserObservation): string {
  return (
    `${ob.title || '(无标题)'} · ${ob.url} · ${ob.elements.length} 个元素` +
    (ob.truncated ? '（还有更多，用 offset 继续取）' : '')
  )
}

/**
 * 把动作回执与后续观察合成一个结果。
 *
 * 观察在就展开到 `data` 顶层，其中的 `observationId` 可直接用于下一次动作；
 * 观察缺席时结果是失败而 `executed` 为真——动作已经发到网站，重复一次等于多提交一次。
 * 缺席时不沿用旧的 `observationId`。
 */
function withFollowUp(
  receipt: Record<string, unknown>,
  follow: FollowUpObservation,
  opts: { lead: string; ok: boolean; advice: string },
): ToolOutcome {
  if (follow.observation) {
    const ob = follow.observation
    return {
      status: opts.ok ? 'success' : 'failure',
      ...(opts.ok ? {} : { executed: true }),
      message: `${opts.lead}${observationLine(ob)}`,
      data: {
        ...receipt,
        ...observationData(ob),
        ...(follow.settle ? { settle: follow.settle } : {}),
      },
    }
  }
  return {
    status: 'failure',
    executed: true,
    message: `${opts.lead}没有取得新的观察：${follow.observationError}。${opts.advice}`,
    data: { ...receipt, observationError: follow.observationError },
    errorKind: 'browser_observation_unavailable',
  }
}

/** 六个页面工具的目标是那一页；`browser_tabs` 的 list 与 create 没有页可指，见各自的 spec。 */
function tabTarget(args: Record<string, unknown>): string | null {
  return given(args.tabId) ? String(args.tabId).trim() : null
}

const BASE = {
  category: 'browser',
  facet: '页面',
  objectLabel: '浏览器',
  permissionEffect: 'browser',
} as const

export const browserTabsTool: ToolSpec = {
  ...BASE,
  name: 'browser_tabs',
  description:
    '列出内置浏览器的标签页，或新建、接管、关闭一页。' +
    'create 打开的页归本会话，后续消息可直接对它 observe 与 act；' +
    '开页不附带观察，先 browser_observe 或 browser_wait 再操作。' +
    'list 返回的 controlled=false 是用户手动打开的页，' +
    '只有用户明确要求使用该页时才用 action=bind 接管。其他会话的页不在列表内。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'create', 'bind', 'close'] },
      url: { type: 'string', description: 'action=create 时要打开的 http/https 地址' },
      tabId: {
        type: 'string',
        description: 'action=bind 要接管、action=close 要关闭的标签页',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  // list 只读一份清单；create / bind / close 改变本会话手里有哪些页。
  actionKind: (args) => (args.action === 'list' ? 'read' : 'call'),
  summary: '列出、新建、接管或关闭浏览器标签页',
  // list 与 create 没有可指的页，授权预览退回「browser」而不是留空。
  targetExtractor: (args) => tabTarget(args) ?? 'browser',

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      const action = oneOf(args.action, ['list', 'create', 'bind', 'close'] as const, 'action')

      if (action === 'create') {
        const url = webUrl(args.url)
        const tab = await send(() => browser.open(url))
        return {
          status: 'success',
          message: `已打开 ${tab.tabId}：${tab.url}。先 browser_observe 或 browser_wait 再操作。`,
          data: { tab },
        }
      }

      if (action === 'bind') {
        const tabId = str(args.tabId, 'tabId')
        const tab = await send(() => browser.bind(tabId))
        return { status: 'success', message: `已接管 ${tab.tabId}：${tab.url}`, data: { tab } }
      }

      if (action === 'close') {
        const tabId = str(args.tabId, 'tabId')
        await send(() => browser.close(tabId))
        return { status: 'success', message: `已关闭 ${tabId}`, data: { tabId } }
      }

      const tabs = await send(() => browser.tabs())
      const mine = tabs.filter((t) => t.controlled).length
      const user = tabs.length - mine
      return {
        status: 'success',
        message:
          `${tabs.length} 个标签页，其中 ${mine} 个归本会话（可直接操作）` +
          (user ? `，${user} 个是用户开的（用户点名后可 bind 接管）` : ''),
        data: { tabs },
      }
    }),
}

export const browserNavigateTool: ToolSpec = {
  ...BASE,
  name: 'browser_navigate',
  description:
    '在已控制的标签页里跳转、后退、前进或重新加载。' +
    '取得新观察时结果里直接带回元素表与 observationId，据此继续下一步，不必再调 browser_observe。' +
    'observationId 与元素 ref 属于产生它的那一份观察与那一份文档，换文档后要用新的一份。' +
    '未取得观察时结果为失败，先 browser_observe 确认当前页面，不要重复跳转。',
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      action: { type: 'string', enum: ['goto', 'back', 'forward', 'reload'] },
      url: { type: 'string', description: 'action=goto 时的 http/https 地址' },
    },
    required: ['tabId', 'action'],
    additionalProperties: false,
  },
  actionKind: 'call',
  summary: '在标签页里跳转、后退、前进或重新加载',
  targetExtractor: tabTarget,

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      const tabId = str(args.tabId, 'tabId')
      const action = oneOf(args.action, ['goto', 'back', 'forward', 'reload'] as const, 'action')
      const input = {
        tabId,
        action,
        ...(action === 'goto' ? { url: webUrl(args.url) } : {}),
      }
      const follow = await send(() => browser.navigate(input))
      return withFollowUp({}, follow, {
        lead: `${action} 已发出。`,
        ok: true,
        advice: '先 browser_observe 确认当前页面，不要重复跳转。',
      })
    }),
}

export const browserObserveTool: ToolSpec = {
  ...BASE,
  name: 'browser_observe',
  description:
    '返回页面的实际地址、标题、可操作元素与正文。返回的 observationId 与元素 ref 是 act 的前提。' +
    'truncated=true 时用 offset 取后续元素。' +
    'screenshot=true 才截图，仅在元素表不足以判断版面时使用。' +
    'frame 只看某个跨站 iframe，取自元素的 frame 字段。',
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      frame: { type: 'string', description: '只看某个跨站 iframe，取自元素的 frame 字段' },
      screenshot: { type: 'boolean' },
      offset: { type: 'integer', description: '从第几个元素开始返回' },
    },
    required: ['tabId'],
    additionalProperties: false,
  },
  actionKind: 'read',
  summary: '读一页的地址、标题与可操作元素',
  targetExtractor: tabTarget,

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      const input = {
        tabId: str(args.tabId, 'tabId'),
        ...(given(args.frame) ? { frame: str(args.frame, 'frame') } : {}),
        ...(args.screenshot === true ? { screenshot: true } : {}),
        ...(given(args.offset) ? { offset: nonNegative(args.offset, 'offset') } : {}),
      }
      const ob = await send(() => browser.observe(input))
      return { status: 'success', message: observationLine(ob), data: observationData(ob) }
    }),
}

export const browserActTool: ToolSpec = {
  ...BASE,
  name: 'browser_act',
  description:
    '对观察返回的元素执行动作：click 点击、fill 覆盖输入框内容、select 选下拉项、' +
    'scroll 滚动、press 按功能键。observationId 取自 observe、act、navigate 或 wait 返回的那一份。' +
    '动作之后取得新观察时结果里直接带回新的元素表与 observationId，据此继续下一步，' +
    '不必再调 browser_observe；settle=quiet 只表示页面短暂没有变化，不代表网站业务已完成，' +
    '后续目标还没出现时用 browser_wait。' +
    '未取得观察时结果为失败而动作可能已经发出，先 browser_observe 确认，不要重复同一个动作。',
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      observationId: { type: 'string' },
      action: { type: 'string', enum: ['click', 'fill', 'select', 'scroll', 'press'] },
      ref: { type: 'string', description: '元素编号。scroll 与 press 可省略，作用于整页' },
      text: { type: 'string', description: 'fill 要输入的文本，或 select 要选中的选项' },
      key: {
        type: 'string',
        description:
          'press 的按键：Enter Tab Escape Backspace Delete ArrowUp ArrowDown ArrowLeft ArrowRight Home End PageUp PageDown Space',
      },
      deltaY: { type: 'number', description: 'scroll 的滚动量，向下为正' },
    },
    required: ['tabId', 'observationId', 'action'],
    additionalProperties: false,
  },
  actionKind: 'call',
  summary: '在观察到的元素上点击、输入、选择、滚动或按键',
  targetExtractor: tabTarget,

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      const action: BrowserActionKind = oneOf(
        args.action,
        ['click', 'fill', 'select', 'scroll', 'press'] as const,
        'action',
      )
      const ref = given(args.ref) ? str(args.ref, 'ref') : undefined
      // 元素动作没有 ref 就无从定位，press 没有 key 就没有要按的键：两者在调端口前判，
      // 否则一次必然失败的调用会被记成「动作已发出」，而那是禁止重试的一侧。
      if (ref === undefined && action !== 'scroll' && action !== 'press') {
        throw new ArgError(`${action} 必须给 ref`)
      }
      if (action === 'press' && !given(args.key)) throw new ArgError('press 必须给 key')

      const input = {
        tabId: str(args.tabId, 'tabId'),
        observationId: str(args.observationId, 'observationId'),
        action,
        ...(ref !== undefined ? { ref } : {}),
        // 空文本对 fill 是有意义的（清空输入框），所以它只按 null 判缺席。
        ...(args.text !== undefined && args.text !== null ? { text: String(args.text) } : {}),
        ...(given(args.key) ? { key: str(args.key, 'key') } : {}),
        ...(given(args.deltaY) ? { deltaY: finite(args.deltaY, 'deltaY') } : {}),
      }
      const r = await send(() => browser.act(input))
      return withFollowUp(
        { ...(r.element ? { element: r.element } : {}), ...(r.point ? { point: r.point } : {}) },
        r,
        {
          lead: `${action} 已发出${r.element ? `：${r.element}` : ''}。`,
          ok: true,
          advice: '动作已发出，先 browser_observe 确认页面状态，不要重复动作。',
        },
      )
    }),
}

export const browserWaitTool: ToolSpec = {
  ...BASE,
  name: 'browser_wait',
  description:
    '等待一个 CSS 选择器在当前主文档出现，用于替代反复 observe 轮询。' +
    `默认 ${DEFAULT_WAIT_MS} 毫秒，上限 ${MAX_WAIT_MS} 毫秒。` +
    '取得新观察时结果里直接带回元素表与 observationId，据此继续下一步，不必再调 browser_observe；' +
    '未取得观察时先 browser_observe 确认页面状态。' +
    '选择器只查主文档，跨站 iframe 用 browser_observe 的 frame 参数。',
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      selector: { type: 'string' },
      timeoutMs: { type: 'integer' },
    },
    required: ['tabId', 'selector'],
    additionalProperties: false,
  },
  actionKind: 'read',
  summary: '等一个 CSS 选择器出现',
  targetExtractor: tabTarget,

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      const selector = str(args.selector, 'selector')
      const input = {
        tabId: str(args.tabId, 'tabId'),
        selector,
        timeoutMs: given(args.timeoutMs)
          ? Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, finite(args.timeoutMs, 'timeoutMs')))
          : DEFAULT_WAIT_MS,
      }
      const r = await send(() => browser.wait(input))
      return withFollowUp({ found: r.found, ...(r.reason ? { reason: r.reason } : {}) }, r, {
        lead: r.found ? `${selector} 已出现。` : `没等到 ${selector}（${r.reason ?? 'timeout'}）。`,
        ok: r.found,
        advice: '先 browser_observe 确认页面状态。',
      })
    }),
}

export const browserUploadTool: ToolSpec = {
  ...BASE,
  name: 'browser_upload',
  description:
    '把工作区内的文件交给页面上的文件输入框，ref 必须指向 input[type=file]。' +
    `路径按工作区规则裁决，越界拒绝。一次最多 ${MAX_UPLOAD_FILES} 个文件。` +
    '结果不附带观察，需要读页面状态时再调 browser_observe。',
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      observationId: { type: 'string' },
      ref: { type: 'string' },
      paths: { type: 'array', items: { type: 'string' } },
    },
    required: ['tabId', 'observationId', 'ref', 'paths'],
    additionalProperties: false,
  },
  actionKind: 'call',
  summary: '把工作区文件交给页面的文件输入框',
  targetExtractor: tabTarget,

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      const raw = Array.isArray(args.paths) ? args.paths : [args.paths]
      if (raw.length === 0 || raw.length > MAX_UPLOAD_FILES) {
        throw new ArgError(`一次最多上传 ${MAX_UPLOAD_FILES} 个文件`)
      }
      // 全部裁决完再调端口：逐个边裁边交的话，第三个越界时前两个已经进了输入框。
      const paths: string[] = []
      for (const one of raw) {
        paths.push(await resolveInWorkspace(rootsOf(ctx), String(one ?? ''), { mustExist: true }))
      }
      const input = {
        tabId: str(args.tabId, 'tabId'),
        observationId: str(args.observationId, 'observationId'),
        ref: str(args.ref, 'ref'),
        paths,
      }
      const r = await send(() => browser.upload(input))
      return {
        status: 'success',
        message: `已交给文件输入框 ${r.files.length} 个文件`,
        data: { files: r.files },
      }
    }),
}

export const browserDownloadTool: ToolSpec = {
  ...BASE,
  name: 'browser_download',
  description:
    '点击下载链接或按钮，把文件保存到工作区内的指定路径。目标文件已存在时拒绝。' +
    '结果带 blocked 表示下载被宿主拦截，原因随结果给出。' +
    '结果不附带观察，需要读页面状态时再调 browser_observe。',
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      observationId: { type: 'string' },
      ref: { type: 'string', description: '触发下载的元素编号' },
      path: { type: 'string', description: '工作区内的目标路径' },
    },
    required: ['tabId', 'observationId', 'ref', 'path'],
    additionalProperties: false,
  },
  actionKind: 'call',
  summary: '触发下载并保存到工作区路径',
  targetExtractor: tabTarget,

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      // 先裁决路径再触发：授权按这个绝对路径登记，顺序反过来就成了
      // 「先让网站开始下载，再看它能不能落盘」。
      const absolutePath = await resolveInWorkspace(rootsOf(ctx), str(args.path, 'path'), {
        mustExist: false,
      })
      const input = {
        tabId: str(args.tabId, 'tabId'),
        observationId: str(args.observationId, 'observationId'),
        ref: str(args.ref, 'ref'),
        absolutePath,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      }
      const r = await send(() => browser.download(input))
      if (r.blocked) {
        return {
          status: 'failure',
          message: `下载被拦下：${r.blocked}${r.suggestedName ? `（${r.suggestedName}）` : ''}`,
          data: { ...r },
          errorKind: 'download_blocked',
        }
      }
      return { status: 'success', message: `已保存到 ${r.path}，${r.bytes} 字节`, data: { ...r } }
    }),
}

/** 注册顺序在这里定，`index.ts` 按通道整组注册或整组不注册。 */
export const browserTools: ToolSpec[] = [
  browserTabsTool,
  browserNavigateTool,
  browserObserveTool,
  browserActTool,
  browserWaitTool,
  browserUploadTool,
  browserDownloadTool,
]
