/**
 * Art：由对话模型写出、在画布节点中运行的 HTML 页面。
 *
 * 页面的像素尺寸只记录在 HTML 中：`<meta name="viewport" content="width=W, height=H">`。
 * 服务端读它得到版本尺寸（节点框随之调整），界面读它确定页面视口，截图与录制按它输出；
 * 不要另存一份尺寸，两处记录会在 Agent 改写文件后不一致。
 */

import type { CanvasPixels, MentionStyle } from './canvas.ts'
import type { MediaParamDefinition } from './media-params.ts'

/** 没有 viewport 标签时的视口。 */
export const ART_DEFAULT_SIZE: CanvasPixels = { w: 1280, h: 720 }

const SIZES = [
  { ratio: '16:9', value: '1280x720' },
  { ratio: '9:16', value: '720x1280' },
  { ratio: '1:1', value: '1024x1024' },
  { ratio: '4:3', value: '1280x960' },
  { ratio: '3:4', value: '960x1280' },
] as const

/** 生成卡的尺寸参数。取值是 `宽x高`，生成面板按 `shapes` 显示为宽高比。 */
export const ART_SIZE_PARAM: MediaParamDefinition & { label: string } = {
  name: 'size',
  label: '尺寸',
  type: 'enum',
  values: SIZES.map((s) => s.value),
  default: SIZES[0].value,
  shapes: SIZES,
}

/** 要求中指代参考图的写法。生成端口按同一写法在每张图前标注名称，系统提示词中说明这一约定。 */
export const ART_MENTION = { image: '图{n}' } satisfies MentionStyle

/** 参数中的尺寸；缺省或不在可选值中时为 `ART_DEFAULT_SIZE`。 */
export function artSizeOf(params: Record<string, unknown>): CanvasPixels {
  const hit = SIZES.find((s) => s.value === params[ART_SIZE_PARAM.name])
  if (!hit) return ART_DEFAULT_SIZE
  const [w, h] = hit.value.split('x').map(Number) as [number, number]
  return { w, h }
}

const VIEWPORT_RE = /<meta\b[^>]*\bname\s*=\s*["']?viewport\b[^>]*>/i
/** 视口边长的上限：H.264 编码与截图都按该尺寸输出。 */
const MAX_SIDE = 4096

/** HTML 中 viewport 标签声明的宽高；没有标签、只声明了宽度或取值越界时为 `null`。 */
export function artViewportOf(html: string): CanvasPixels | null {
  const tag = VIEWPORT_RE.exec(html)?.[0]
  if (!tag) return null
  const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
  const text = content?.[1] ?? content?.[2] ?? ''
  const w = Number(/\bwidth\s*=\s*(\d+)/i.exec(text)?.[1])
  const h = Number(/\bheight\s*=\s*(\d+)/i.exec(text)?.[1])
  const ok = (n: number) => Number.isInteger(n) && n > 0 && n <= MAX_SIDE
  return ok(w) && ok(h) ? { w, h } : null
}

/**
 * 把 viewport 标签设为 `size`：已有标签时替换，否则放在 `<head>` 之后；没有 `<head>` 时依次放在 `<html>`、
 * `<!doctype>` 之后或文档开头。不要放在 `<!doctype>` 之前：页面会进入怪异模式。
 */
export function withArtViewport(html: string, size: CanvasPixels): string {
  const tag = `<meta name="viewport" content="width=${size.w}, height=${size.h}">`
  if (VIEWPORT_RE.test(html)) return html.replace(VIEWPORT_RE, () => tag)
  return insertAfterHead(html, tag)
}

/** 在 `<head>` 之后插入一段内容，位置规则同 `withArtViewport`。 */
export function insertAfterHead(html: string, content: string): string {
  const anchor =
    /<head\b[^>]*>/i.exec(html) ?? /<html\b[^>]*>/i.exec(html) ?? /<!doctype\b[^>]*>/i.exec(html)
  if (!anchor) return content + html
  const at = anchor.index + anchor[0].length
  return html.slice(0, at) + content + html.slice(at)
}
