/**
 * 工具结果中观察与图像的投递：自绘窗口的判定、动作与等待之后观察的投递方式，
 * 以及图像经由 `images` 通道附加到结果上。
 */

import type { ToolContext, ToolOutcome } from '@qywork/agent'
import {
  type DesktopImageGeometry,
  type DesktopRect,
  imageSizeOf,
  screenPointToImage,
} from '@qywork/core'
import {
  type DesktopResultInput,
  type DesktopResultParts,
  desktopResult,
  structural,
} from '../../desktop-results.ts'
import { MAX_EDGE, shrinkImage } from '../../image.ts'
import {
  type DesktopElement,
  type DesktopImage,
  DesktopPort,
  type DesktopSnapshot,
} from '../port.ts'
import { windowTitle } from './lines.ts'
import type { PortCall } from './run.ts'
import { isWindowRoot } from './target.ts'

/** 判断该控件是否位于标题栏子树中。沿 `parentRef` 向上查找。 */
function inTitleBar(byRef: Map<string, DesktopElement>, element: DesktopElement): boolean {
  const seen = new Set<string>()
  let at: DesktopElement | undefined = element
  while (at && !seen.has(at.ref)) {
    seen.add(at.ref)
    if (at.role === 'title_bar') return true
    at = at.parentRef === undefined ? undefined : byRef.get(at.parentRef)
  }
  return false
}

/**
 * 本次观察中可操作的业务控件数量。
 *
 * 判据只使用观察本身：带可执行的后台动作、不是窗口根、不是无名结构容器（`structural`），
 * 且不在标题栏子树中。标题栏、系统菜单与最小化 / 最大化 / 关闭由系统绘制，任何顶层窗口都有，
 * 计入它们会把自绘界面判定为结构上可操作。无名结构容器不列入控件表，也不计入：Chromium 内核的
 * 窗口未提供网页内容时只剩若干带 scroll_into_view 的无名窗格，计入它们会把这类窗口判定为可操作。
 * 不按应用名判定。
 */
function operableCount(table: DesktopElement[]): number {
  const byRef = new Map(table.map((e) => [e.ref, e]))
  return table.filter(
    (e) =>
      !isWindowRoot(e) &&
      !structural(e) &&
      e.actions.some((a) => a.delivery.includes('background')) &&
      !inTitleBar(byRef, e),
  ).length
}

/**
 * 控件树上没有任何业务控件的窗口。自绘界面属于此类，只能依据图像按坐标操作。
 *
 * 只在整窗、未截断、未筛选的观察上判定：筛选结果为零个控件与窗口没有控件含义不同，
 * 混为一谈会使一次 `role=button` 的空结果被描述为应用不暴露控件。
 *
 * 这是「是否附图」「回执是否输出该说明」与「动作和等待之后是否按差异投递」的共同判据，
 * 各处不要各自判定。
 */
export function isBareWindow(s: DesktopSnapshot): boolean {
  if (s.truncated || s.filteredBy.length > 0) return false
  if (!s.elements.some(isWindowRoot)) return false
  return operableCount(s.elements) === 0
}

/**
 * 在回执中注明自绘窗口。
 *
 * 前台操作状态由端口读取配置得到，不能从控件是否支持前台动作推断。
 */
export function bareWindowNote(s: DesktopSnapshot, foregroundEnabled: boolean): string {
  if (!isBareWindow(s)) return ''
  return ` · 无可操作控件${foregroundEnabled ? '' : ' · 前台操作已关闭'}`
}

/**
 * 动作、序列与等待之后的观察投递。
 *
 * 自绘窗口整份投递并在读数行末尾注明，不按差异投递：其控件表只含窗口根与渲染面，
 * 差异计数恒为零，与画面是否变化无关。
 */
export function followResult(
  ctx: ToolContext,
  input: Omit<DesktopResultInput, 'ctx' | 'place' | 'incremental'>,
): DesktopResultParts {
  const bare = isBareWindow(input.snapshot)
  return desktopResult({
    ...input,
    ctx,
    place: 'observation',
    incremental: !bare,
    lead: `${input.lead}${bareWindowNote(input.snapshot, ctx.port(DesktopPort)?.foregroundEnabled() !== false)}`,
  })
}

/** 把结果生成返回的字段附加到 `ToolOutcome` 上。没有落盘时不写入 `resources` 键。 */
export function delivered(
  parts: DesktopResultParts,
): Pick<ToolOutcome, 'message' | 'data' | 'resources'> {
  return {
    message: parts.message,
    data: parts.data,
    ...(parts.resources ? { resources: parts.resources } : {}),
  }
}

/**
 * 把一张图像附加到工具结果的图像通道上。
 *
 * 字节经由 `data.images` 传递，不进入 `message`：模型无法理解 base64 字符串，留在正文中只会按长度计费。
 *
 * 经过 `shrinkImage` 之后按几何核对尺寸：采集端已按 `MAX_EDGE` 缩放，此处预期不修改任何
 * 字节。若实际发生缩放或尺寸不一致，说明几何记录的不是模型收到的图像，按图计算的屏幕
 * 坐标是错误的，此时不提供图像。
 */
export async function imagePayload(
  image: DesktopImage,
): Promise<{ data: Record<string, unknown>; line: string } | { error: string }> {
  const raw = Uint8Array.from(Buffer.from(image.data, 'base64'))
  const fit = await shrinkImage(raw, image.mime)
  const size = imageSizeOf(fit.bytes)
  const g = image.geometry
  if (!size || size.width !== g.imageWidth || size.height !== g.imageHeight) {
    return {
      error:
        `图与几何不一致 · 几何 ${g.imageWidth}×${g.imageHeight} · ` +
        `图 ${size ? `${size.width}×${size.height}` : '无法读取尺寸'}`,
    }
  }
  const hint = image.source === 'print_window' ? ' · 备用方式采集，未重绘的区域为黑色' : ''
  return {
    data: {
      app: image.app,
      title: image.title,
      imageRef: image.imageRef,
      geometry: g,
      source: image.source,
      imageCapturedAt: image.capturedAt,
      images: [{ data: Buffer.from(fit.bytes).toString('base64'), mime: fit.mime }],
    },
    line:
      `${image.imageRef} ${g.imageWidth}×${g.imageHeight} 像素 · ` +
      `屏幕 ${g.screen.x},${g.screen.y} ${g.screen.width}×${g.screen.height} · ` +
      `DPI ${g.dpi}${hint}${popupNote(g)}`,
  }
}

/**
 * 图像中合成的弹出窗口（下拉框、菜单、对话框）的说明，位置按图像坐标给出。没有时为空串。
 *
 * 必须写明它们是独立的窗口：按图点击其中的位置投递给它们，而目标窗口的控件表通常不含其中的控件；
 * 不写明时模型会按目标窗口的控件表判断下拉框中有什么。
 */
function popupNote(g: DesktopImageGeometry): string {
  if (g.popups.length === 0) return ''
  const items = g.popups.map((p) => {
    const at = imageAreaOf(g, p.screen)
    const where = at ? ` 图像 ${at.x},${at.y} ${at.width}×${at.height}` : ''
    return `${p.title ? `「${windowTitle(p.title)}」` : windowTitle(p.title)}${where}`
  })
  return (
    ` · 图中合成了同一应用的 ${g.popups.length} 个弹出窗口：${items.join('；')}。` +
    '弹出窗口是独立的窗口，按图点击其中的位置投递给它；目标窗口的控件表可能不含其中的控件，' +
    '有标题的弹出窗口也列在窗口清单中，可单独观察'
  )
}

/** 屏幕矩形在图像中对应的区域，按图像覆盖范围截取；与图像没有交集时为 `null`。 */
function imageAreaOf(g: DesktopImageGeometry, rect: DesktopRect): DesktopRect | null {
  const left = Math.max(rect.x, g.screen.x)
  const top = Math.max(rect.y, g.screen.y)
  const right = Math.min(rect.x + rect.width, g.screen.x + g.screen.width)
  const bottom = Math.min(rect.y + rect.height, g.screen.y + g.screen.height)
  if (right <= left || bottom <= top) return null
  const from = screenPointToImage(g, left, top)
  const to = screenPointToImage(g, right - 1, bottom - 1)
  if (!from || !to) return null
  return { x: from.x, y: from.y, width: to.x - from.x + 1, height: to.y - from.y + 1 }
}

/**
 * 按图定位的动作与条目带有 `shot` 的动作在回执上附一张动作后的整窗图；动作、序列或等待
 * 之后的快照为自绘窗口（`isBareWindow`）时同样附图。
 *
 * 在动作回执返回后立即采集；控件重读不保证异步界面状态已稳定，任务结果仍需依据观察核验。
 * 请求动作或窗口准备使旧观察失效时附图；纯拒绝且旧观察仍有效时不附图。
 * 采集失败不改变动作派发事实。
 */
export async function withShot(
  outcome: ToolOutcome,
  refresh: boolean,
  desktop: DesktopPort,
  send: PortCall,
  windowId: string,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (!refresh || ctx.vision === false) return outcome
  const shot = await send(() => desktop.captureImage({ windowId, maxEdge: MAX_EDGE })).then(
    (image) => imagePayload(image),
    (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
  )
  if ('error' in shot) {
    return { ...outcome, message: `${outcome.message} · 未采集到图像 · ${shot.error}` }
  }
  return {
    ...outcome,
    message: `${outcome.message} · ${shot.line}`,
    data: { ...outcome.data, ...shot.data },
  }
}
