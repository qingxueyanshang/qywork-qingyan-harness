/** `desktop_observe`：读取窗口的控件表、文档文本或图像。 */

import type { ToolSpec } from '@qywork/agent'
import type { DesktopRect } from '@qywork/core'
import { desktopResult } from '../desktop-results.ts'
import { MAX_EDGE } from '../image.ts'
import type { DesktopElement, DesktopImage, DesktopPort } from './port.ts'
import { ArgError, bounded, given, oneOf, str } from './shared/args.ts'
import { bareWindowNote, delivered, imagePayload, isBareWindow } from './shared/delivery.ts'
import { snapshotLine, windowTitle } from './shared/lines.ts'
import { BASE, onDesktop, type PortCall, windowTarget } from './shared/run.ts'
import { MAX_IMAGE_COORD, resolveTarget, STALE } from './shared/target.ts'

/** 一次读取控件树的节点数上限。端口会再截断一次，此处拦截明显越界的请求。 */
const MAX_NODES = 4000
/** 一次读取控件树的深度上限。 */
const MAX_DEPTH = 40

/** 按控件确定采集区域时向外扩展的像素数上限。扩展过大时区域接近整窗，应直接采集整窗。 */
const MAX_PAD = 400

/** 一次读取文本最多返回的 UTF-16 码元数。超出即截断并标记。 */
const MAX_TEXT_CHARS = 20_000

/** 采集模式。`structure` 与 `text` 均不采集图像。 */
const CAPTURES = ['structure', 'region_image', 'combined', 'text'] as const
type CaptureMode = (typeof CAPTURES)[number]

/** 当前模型不接受图片时的终态。重试必然失败，因此消息中必须给出下一步操作。 */
const NO_VISION = {
  status: 'failure',
  executed: false,
  message: '未执行 · 当前模型不接受图片 · 改用 capture=structure',
  errorKind: 'unsupported',
} as const

/** 按控件确定采集区域：包围盒向外扩展若干像素。 */
function padded(rect: DesktopRect, pad: number): DesktopRect {
  return {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  }
}

export const desktopObserveTool: ToolSpec = {
  ...BASE,
  name: 'desktop_observe',
  description:
    '观察一个窗口。capture=structure（默认）读取控件表，region_image 采图，combined 两者兼有，text 读取文档文本与选区。' +
    '先用 structure，控件树中未找到目标时才采图。' +
    'capture=text 只读取标有 text:true 的控件；读取容器内部控件用 structure 并将 root 设为容器 ref。' +
    'around、imageRef、imageRect 只用于采图；不采图时省略，必须填写时使用 null，imageRect 不要填 {}。' +
    '控件表提供角色、名称、automationId、value、enabled、depth 与控件状态，includeRect 为真时另提供 rect；' +
    '没有名称、值与状态的 pane / group / custom 容器不列出；' +
    '控件按前序排列，depth 按列出的祖先计算，父控件是前面最近的、depth 小一层的控件；' +
    '每个控件的 actionSet 是 actionSets 的下标，该项按投递方式列出控件此刻可执行的动作：' +
    'background 经控件接口发出，foreground 发送指针与键盘事件或调用窗口接口，unavailable 是此刻无法执行的动作与原因；' +
    '控件上缺失的 enabled、offscreen、automationId 取 defaults 的值。' +
    '回执中的「无可操作控件」表示自绘界面，本次调用已附带整窗图，动作按图提供坐标，无需再次采图；' +
    '「未读取完整」表示控件树采集不完整，调整 maxNodes 或 maxDepth 后重读；其中 field_unavailable 表示个别控件的选中项或可见文字无法读取，重读不会改变，其余控件照常可用；' +
    'foregroundEnabled 表示当前前台操作开关，与控件支持哪些动作分别判断；为 false 时不能激活窗口或注入鼠标与键盘事件。' +
    '「窗口被遮挡或已最小化」时应用可能未提供内部内容；仅在 foregroundEnabled 为 true 且窗口提供 activate 时激活后再观察。' +
    '浏览器自动填充的账号密码在页面上发生点击或按键之前无法读取，输入框 value 为空不代表框中未填写，点击输入框后再读取；' +
    '「已投递 N/M 个控件」表示本次只返回了其中一部分，完整控件表已按结果中的 resource id 保存，' +
    '用 read_resource 读取，无需重读。' +
    '动作与等待按本轮对该窗口最近一份观察解析 ref，本轮未观察过的窗口须先观察；' +
    'ref 按控件分配，同一个控件在新观察中编号不变；窗口移动后旧 imageRef 失效。',
  parameters: {
    type: 'object',
    properties: {
      windowId: { type: 'string', description: '取自 desktop_windows' },
      capture: { type: 'string', enum: CAPTURES, description: '观察内容，默认 structure' },
      maxNodes: { type: 'integer', description: `最多读取的控件数，上限 ${MAX_NODES}` },
      maxDepth: { type: 'integer', description: `最多读取的层数，上限 ${MAX_DEPTH}` },
      root: {
        type: 'string',
        description: '只读取该控件下的子树，取自上一份观察的 ref；之后的动作按该范围重读',
      },
      role: { type: 'string', description: '结果只列出该角色的控件，其余控件仍在本次观察中' },
      query: {
        type: 'string',
        description: '结果只列出名称、稳定标识或值包含这段文字的控件，其余控件仍在本次观察中',
      },
      includeValue: { type: 'boolean', description: '是否读取控件当前值，默认读取' },
      includeRect: {
        type: 'boolean',
        description:
          '控件表是否包含 rect（屏幕物理像素包围盒），默认不包含；仅在按位置判断布局或计算拖拽偏移时需要',
      },
      includeState: {
        type: 'boolean',
        description: '是否读取 range / toggle / expand / selected / selection / scroll，默认读取',
      },
      ref: {
        type: 'string',
        description: 'capture=text 要读取的控件，取自同一份观察且标有 text:true',
      },
      automationId: { type: 'string', description: 'capture=text 按稳定标识定位，要求唯一命中' },
      name: { type: 'string', description: 'capture=text 按名称定位，要求唯一命中' },
      maxChars: {
        type: 'integer',
        description: `capture=text 最多返回的字数，上限 ${MAX_TEXT_CHARS}`,
      },
      around: { type: 'string', description: '只采集该控件周围的区域，值为控件 ref' },
      pad: { type: 'integer', description: `around 向外扩展的像素数，上限 ${MAX_PAD}` },
      imageRef: { type: 'string', description: '要放大的图像，取自上一次采图' },
      imageRect: {
        type: 'object',
        description: 'imageRef 所指图像中的一块区域，图像坐标；不采图时省略或填 null，不要填 {}',
        properties: {
          x: { type: 'integer' },
          y: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
        },
        required: ['x', 'y', 'width', 'height'],
        additionalProperties: false,
      },
    },
    required: ['windowId'],
    additionalProperties: false,
  },
  verb: '查看',
  object: () => '窗口',
  summary: '读取窗口的控件列表或截取窗口图像',
  targetExtractor: windowTarget,

  fn: (args, ctx) =>
    onDesktop(ctx, async (desktop, send) => {
      const windowId = str(args.windowId, 'windowId')
      const capture: CaptureMode = given(args.capture)
        ? oneOf(args.capture, CAPTURES, 'capture')
        : 'structure'
      if (capture !== 'region_image' && capture !== 'combined' && framingGiven(args)) {
        throw new ArgError(
          `未执行 · capture=${capture} 不接受采集区域参数 around / imageRef / imageRect；` +
            '不采图时省略这些参数，必须填写时使用 null，imageRect 不要填 {}',
        )
      }
      if (capture === 'text') {
        const elements = desktop.observation(windowId)?.elements ?? null
        const element = resolveTarget(elements, args)
        if (element.text !== true) {
          const hint =
            element.value !== undefined
              ? '当前值已在观察的 value 中，空字符串表示值为空'
              : elements?.some((item) => item.parentRef === element.ref)
                ? `要查看内部控件，请用 capture=structure、root=${element.ref} 读取子树`
                : '当前观察也未提供 value，请查看控件表中已有的名称和状态'
          throw new ArgError(
            `未执行 · ${element.ref} 不支持文档文本读取 · ${hint}`,
            'desktop_action_unsupported',
          )
        }
        const maxChars = given(args.maxChars)
          ? bounded(args.maxChars, 'maxChars', 1, MAX_TEXT_CHARS)
          : MAX_TEXT_CHARS
        const read = await send(() => desktop.readText({ windowId, ref: element.ref, maxChars }))
        const selection = read.selection.length
          ? read.selection
              .map((s) => `${s.start} 起 ${JSON.stringify(s.text)}${s.truncated ? ' 截断' : ''}`)
              .join(' · ')
          : '无'
        return {
          status: 'success',
          message:
            `${element.ref} 文本 ${read.text.length} 字${read.truncated ? ' 截断' : ''}` +
            ` · 选区 ${selection}`,
          data: { ref: element.ref, ...read },
        }
      }
      // 不接受图片的模型在采集之前即拒绝：采集模型无法查看的图像需要付出完整的采集与编码开销。
      if (capture !== 'structure' && ctx.vision === false) return NO_VISION

      if (capture === 'region_image') {
        const image = await captureFor(desktop, send, windowId, args, null)
        const payload = await imagePayload(image)
        if ('error' in payload) {
          return {
            status: 'failure',
            message: payload.error,
            errorKind: 'desktop_image_mismatch',
          }
        }
        return { status: 'success', message: payload.line, data: payload.data }
      }

      // 参数在交给端口之前解析完毕：解析放入 `send` 的回调中时，一次参数错误会被记为
      // 已交给端口，而这意味着不允许重发。
      const input = {
        windowId,
        ...(given(args.maxNodes)
          ? { maxNodes: bounded(args.maxNodes, 'maxNodes', 1, MAX_NODES) }
          : {}),
        ...(given(args.maxDepth)
          ? { maxDepth: bounded(args.maxDepth, 'maxDepth', 1, MAX_DEPTH) }
          : {}),
        ...(given(args.root) ? { root: str(args.root, 'root') } : {}),
        ...(args.includeValue === false ? { includeValue: false } : {}),
        ...(args.includeState === false ? { includeState: false } : {}),
      }
      const filter =
        given(args.role) || given(args.query)
          ? {
              ...(given(args.role) ? { role: str(args.role, 'role') } : {}),
              ...(given(args.query) ? { query: str(args.query, 'query') } : {}),
            }
          : undefined
      const snapshot = await send(() => desktop.observe(input))
      const line =
        `${snapshot.app} · ${windowTitle(snapshot.title)} · ${snapshotLine(snapshot)}` +
        bareWindowNote(snapshot, desktop.foregroundEnabled())
      // 自绘窗口的 structure 观察直接附带整窗图：控件表中没有任何业务控件，调用方
      // 只能依据图像按坐标操作，两次往返之间没有可执行的判断。判据与「无可操作控件」
      // 说明相同，见 `isBareWindow`。
      const alsoImage = capture === 'combined' || (isBareWindow(snapshot) && ctx.vision !== false)
      const parts = desktopResult({
        ctx,
        toolName: 'desktop_observe',
        snapshot,
        place: 'top',
        targetRef: null,
        ...(filter ? { filter } : {}),
        ...(args.includeRect === true ? { includeRect: true } : {}),
        lead: line,
      })
      if (!alsoImage) {
        return { status: 'success', ...delivered(parts) }
      }
      // 控件表已经取得：图像采集失败时也必须返回控件表，并说明缺少图像的原因。
      const captured = await captureFor(desktop, send, windowId, args, snapshot.elements).then(
        (image) => imagePayload(image),
        (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
      )
      // 图像字节经由 `data.images` 传递，不计入投递上限：它不是文本，也不进入存盘正文。
      if ('error' in captured) {
        return {
          status: 'success',
          ...delivered({
            ...parts,
            message: `${parts.message} · 未采集到图像 · ${captured.error}`,
            data: { ...parts.data, imageError: captured.error },
          }),
        }
      }
      return {
        status: 'success',
        ...delivered({
          ...parts,
          message: `${parts.message} · ${captured.line}`,
          data: { ...parts.data, ...captured.data },
        }),
      }
    }),
}

/** 本次调用是否提供了采集区域参数。提供时要求 capture 不是 structure。 */
function framingGiven(args: Record<string, unknown>): boolean {
  return given(args.around) || given(args.imageRef) || given(args.imageRect)
}

/**
 * 按参数决定采集区域。
 *
 * 三种采集区域互斥：整窗、`around` 加 `pad`、`imageRef` 加 `imageRect`。同时提供后两种时不选择其一，
 * 立即拒绝：选错时采集到的是另一块界面。
 *
 * `fresh` 是本次调用刚读取的控件表，`combined` 传入该表，`region_image` 传入 `null`。
 * `around` 只在本次读取的控件表中解析：`combined` 读取控件树之后旧观察编号已经作废，
 * 用调用方提供的编号解析时，依据的是一份已不存在的表。
 */
async function captureFor(
  desktop: DesktopPort,
  send: PortCall,
  windowId: string,
  args: Record<string, unknown>,
  fresh: DesktopElement[] | null,
): Promise<DesktopImage> {
  const around = given(args.around)
  const byImage = given(args.imageRef)
  if (around && byImage) throw new ArgError('around 与 imageRef 只能提供一个')
  if (around) {
    const ref = str(args.around, 'around')
    const table = fresh ?? desktop.observation(windowId)?.elements ?? null
    if (!table) throw new ArgError(STALE, 'desktop_observation_stale')
    const element = table.find((e) => e.ref === ref)
    if (!element) {
      throw new ArgError(`该观察中没有 ${ref}。`, 'desktop_ref_unknown')
    }
    const box = element.rect
    if (!box) {
      throw new ArgError(
        `${ref} 没有包围盒，无法确定采集区域；改为采集整窗或更换控件。`,
        'desktop_no_bounds',
      )
    }
    const pad = given(args.pad) ? bounded(args.pad, 'pad', 0, MAX_PAD) : 0
    const region = padded(box, pad)
    return send(() => desktop.captureImage({ windowId, maxEdge: MAX_EDGE, region }))
  }
  if (byImage) {
    const imageRef = str(args.imageRef, 'imageRef')
    const raw = args.imageRect
    if (!raw || typeof raw !== 'object') throw new ArgError('提供 imageRef 时必须提供 imageRect')
    const box = raw as Record<string, unknown>
    const imageRect: DesktopRect = {
      x: bounded(box.x, 'imageRect.x', 0, MAX_IMAGE_COORD),
      y: bounded(box.y, 'imageRect.y', 0, MAX_IMAGE_COORD),
      width: bounded(box.width, 'imageRect.width', 1, MAX_IMAGE_COORD),
      height: bounded(box.height, 'imageRect.height', 1, MAX_IMAGE_COORD),
    }
    return send(() => desktop.captureImage({ windowId, maxEdge: MAX_EDGE, imageRef, imageRect }))
  }
  return send(() => desktop.captureImage({ windowId, maxEdge: MAX_EDGE }))
}
