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

/** 页面的显示尺寸：取自 viewport 标签，没有时为缺省尺寸。画布显示与内部渲染按同一尺寸布局。 */
export function artPageSize(html: string): CanvasPixels {
  return artViewportOf(html) ?? ART_DEFAULT_SIZE
}

/** 封面与内部渲染所取的页面时刻（毫秒）：常见的入场动画在此之前已有画面。 */
export const ART_POSTER_MS = 500

/**
 * 页面使用的 importmap 标签：`three` 与 `three/addons/` 指向 `lib`（引导页所在服务的 `/art/lib/`）。
 * 画布显示（界面 `prepareArt`）与内部渲染（服务端 `prepareArtForRender`）共用。必须位于页面自己的模块脚本之前。
 */
export function artImportMap(lib: string): string {
  const imports = { three: `${lib}three.module.js`, 'three/addons/': `${lib}addons/` }
  return `<script type="importmap">${JSON.stringify({ imports })}</script>`
}

/** 在 `<head>` 之后插入一段内容，位置规则同 `withArtViewport`。 */
export function insertAfterHead(html: string, content: string): string {
  const anchor =
    /<head\b[^>]*>/i.exec(html) ?? /<html\b[^>]*>/i.exec(html) ?? /<!doctype\b[^>]*>/i.exec(html)
  if (!anchor) return content + html
  const at = anchor.index + anchor[0].length
  return html.slice(0, at) + content + html.slice(at)
}

/**
 * 页面中按相对路径引用图片的两种写法：`src="…"` 与 CSS 的 `url(…)`。第 1 组是写法前缀，第 2 组是路径。
 * 画布显示时按它把工作区图片载入页面（界面 `inlineArtImages`），生成后按它核对与补连线（服务端），两处共用。
 */
export const ART_IMAGE_REF_RE =
  /(\bsrc\s*=\s*["']|url\(\s*["']?)([^"'()\s]+?\.(?:png|jpe?g|gif|webp|avif|svg))(?=["')\s])/gi

/** 页面中按相对路径引用的图片，按首次出现去重；网络地址、data URL 与根路径不计入。 */
export function artImageRefs(html: string): string[] {
  const refs = new Set<string>()
  for (const m of html.matchAll(ART_IMAGE_REF_RE)) {
    const rel = m[2]!
    if (/^[a-z]+:|^\/\//i.test(rel) || rel.startsWith('/')) continue
    refs.add(rel)
  }
  return [...refs]
}

/** 页面 `page`（工作区路径）所在目录下的相对路径，规范化为工作区路径；越出工作区根时返回 null。 */
export function resolveArtRef(page: string, rel: string): string | null {
  const parts = page.split('/').slice(0, -1)
  let decoded = rel
  try {
    decoded = decodeURI(rel)
  } catch {}
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(seg)
  }
  return parts.join('/')
}
