/**
 * 图片资源：位图或图元文件（WMF、EMF，见 `../../metafile/`），三种文档共用。解码一次，绘制时按裁剪比例映射到目标矩形。
 *
 * - 按字节识别图元文件（`readMetafile`），不按内容类型；含未实现内容的图元文件与无法解码的位图同样为 `null`
 *   （解析时已计入能力边界）。
 * - 位图按调用方给出的插值质量（`ImageQuality`）缩放。图元文件的图片框映射到按裁剪比例扩展后的矩形，并裁剪到目标矩形与图片框的交集；
 *   当前变换只有缩放与平移时在设备坐标中回放（GDI 规则的取整落在设备像素上），含旋转或镜像时在局部坐标中回放。
 * - 图元文件中的文字需要主机字体（`MetafileFonts`）：图元文件含文字而没有字体时不绘制。
 */

import {
  type Metafile,
  type MetafileFonts,
  playMetafile,
  readMetafile,
} from '../../metafile/index.ts'
import type { RelativeRect } from '../fill.ts'
import {
  type CreateCanvas,
  IDENTITY,
  type Matrix,
  type PaintContext,
  type PaintImage,
  setMatrix,
} from './context.ts'
import { type ImageResolution, imageResolution, SCREEN_RESOLUTION } from './resolution.ts'

/** 已解码的图片：位图与文件记录的分辨率，或图元文件的命令与其中已解码的位图（与 `Metafile.bitmaps` 一一对应）。 */
export type PaintPicture =
  | { readonly kind: 'bitmap'; readonly bitmap: PaintImage; readonly resolution: ImageResolution }
  | {
      readonly kind: 'metafile'
      readonly metafile: Metafile
      readonly images: readonly PaintImage[]
    }

export interface ImageDecoder {
  /** 解码图片文件（浏览器中为 `createImageBitmap`）；无法解码时拒绝。 */
  file(bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<PaintImage>
  /** 由非预乘的 RGBA 像素生成图片（浏览器中为 `ImageData` 加 `createImageBitmap`）。 */
  pixels(width: number, height: number, data: Uint8ClampedArray<ArrayBuffer>): Promise<PaintImage>
}

/** 解码一张图片；无法解码或图元文件含未实现的内容时为 `null`。 */
export async function decodePicture(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
  decoder: ImageDecoder,
): Promise<PaintPicture | null> {
  const metafile = readMetafile(bytes)
  try {
    if (metafile === null) {
      const bitmap = await decoder.file(bytes, contentType)
      return { kind: 'bitmap', bitmap, resolution: imageResolution(bytes) }
    }
    if (metafile.unsupported.length > 0) return null
    const images = await Promise.all(
      metafile.bitmaps.map((b) => decoder.pixels(b.width, b.height, b.data)),
    )
    return { kind: 'metafile', metafile, images }
  } catch {
    return null
  }
}

/** 图片的像素尺寸与平铺时换算单元尺寸的分辨率：图元文件为图片框按 96 dpi 的尺寸。 */
export function pictureSize(p: PaintPicture): {
  readonly width: number
  readonly height: number
  readonly resolution: ImageResolution
} {
  if (p.kind === 'bitmap')
    return { width: p.bitmap.width, height: p.bitmap.height, resolution: p.resolution }
  return {
    width: p.metafile.size.width,
    height: p.metafile.size.height,
    resolution: SCREEN_RESOLUTION,
  }
}

/**
 * 位图缩放的插值质量（`imageSmoothingQuality`）。DrawingML 的图片与图片填充为 `high`：与 WPS 演示导出图更接近
 * （实测 37 页平均分 0.9016 → 0.9024）；三个宿主中图表的图片填充同样最接近 `high`（构造图表 7 个区域的 SSIM 之和，
 * WPS 演示 low 6.40、medium 6.52、high 6.52，WPS 文字 6.47、6.66、6.66，WPS 表格 6.37、6.57、6.58）。
 * WPS 文字的嵌入式图片与页面背景为 `low`：docx 语料中缩小 4.4–5.7 倍的嵌入式图片按 `high` 绘制时 38 页之和低 0.097，
 * 按 `medium` 绘制时变化的 53 页中 34 页下降、平均分低 0.0004。WPS 表格锚定在工作表上的图片为 `medium`：构造文件 9 张缩小 1.5–4 倍与放大 2.4–5 倍的
 * 图片区域 SSIM 之和 low 8.17、medium 8.82、high 8.78，放大时 `high` 的平均误差是 `medium` 的 8 倍。
 */
export type ImageQuality = 'low' | 'medium' | 'high'

/**
 * 按 `srcRect` 裁剪绘制位图到目标矩形：裁剪比例为负时图片在目标矩形内缩小，超出原图的部分透明。
 */
export function drawCropped(
  ctx: PaintContext,
  image: PaintImage,
  quality: ImageQuality,
  crop: RelativeRect,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const iw = image.width
  const ih = image.height
  const sx0 = crop.left * iw
  const sx1 = iw - crop.right * iw
  const sy0 = crop.top * ih
  const sy1 = ih - crop.bottom * ih
  if (sx1 <= sx0 || sy1 <= sy0 || w === 0 || h === 0) return
  const kx = w / (sx1 - sx0)
  const ky = h / (sy1 - sy0)
  const cx0 = Math.max(0, sx0)
  const cx1 = Math.min(iw, sx1)
  const cy0 = Math.max(0, sy0)
  const cy1 = Math.min(ih, sy1)
  if (cx1 <= cx0 || cy1 <= cy0) return
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = quality
  ctx.drawImage(
    image,
    cx0,
    cy0,
    cx1 - cx0,
    cy1 - cy0,
    x + (cx0 - sx0) * kx,
    y + (cy0 - sy0) * ky,
    (cx1 - cx0) * kx,
    (cy1 - cy0) * ky,
  )
}

/** 目标矩形（当前变换的坐标）。 */
export interface PictureRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * 把图片按裁剪比例绘制到 `rect`。`matrix` 为上下文的当前变换（`rect` 所在坐标到设备坐标），绘制后恢复。
 * `quality` 只用于位图，`fonts` 只用于图元文件的文字。
 */
export function drawPicture(
  ctx: PaintContext,
  picture: PaintPicture,
  crop: RelativeRect,
  rect: PictureRect,
  matrix: Matrix,
  quality: ImageQuality,
  fonts: MetafileFonts | null,
): void {
  if (picture.kind === 'bitmap') {
    drawCropped(ctx, picture.bitmap, quality, crop, rect.x, rect.y, rect.width, rect.height)
    return
  }
  const mf = picture.metafile
  const fx = 1 - crop.left - crop.right
  const fy = 1 - crop.top - crop.bottom
  if (rect.width === 0 || rect.height === 0 || fx <= 0 || fy <= 0) return
  if (fonts === null && mf.fonts.length > 0) return
  const width = rect.width / fx
  const height = rect.height / fy
  let frame: PictureRect = {
    x: rect.x - crop.left * width,
    y: rect.y - crop.top * height,
    width,
    height,
  }
  let clip = intersect(rect, frame)
  if (clip === null) return
  const m = matrix
  const device = m.b === 0 && m.c === 0 && m.a > 0 && m.d > 0
  ctx.save()
  if (device) {
    frame = mapRect(m, frame)
    clip = mapRect(m, clip)
    setMatrix(ctx, IDENTITY)
  }
  ctx.beginPath()
  ctx.rect(clip.x, clip.y, clip.width, clip.height)
  ctx.clip()
  playMetafile(ctx, mf, picture.images, frame, fonts ?? NO_FONTS)
  ctx.restore()
}

/** 图元文件没有文字记录时不会取得字体。 */
const NO_FONTS: MetafileFonts = {
  face: () => {
    throw new Error('图元文件没有文字记录')
  },
}

function intersect(a: PictureRect, b: PictureRect): PictureRect | null {
  const x0 = Math.max(a.x, b.x)
  const y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.width, b.x + b.width)
  const y1 = Math.min(a.y + a.height, b.y + b.height)
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null
}

function mapRect(m: Matrix, r: PictureRect): PictureRect {
  return { x: m.a * r.x + m.e, y: m.d * r.y + m.f, width: m.a * r.width, height: m.d * r.height }
}

/**
 * 平铺单元所用的位图：位图原样返回；图元文件按图片框在 96 dpi 下的像素尺寸（四舍五入，至少 1 像素）栅格化。
 * 无法创建图层或图元文件含文字而没有字体时为 `null`。
 */
export function pictureRaster(
  picture: PaintPicture,
  createCanvas: CreateCanvas,
  fonts: MetafileFonts | null,
): PaintImage | null {
  if (picture.kind === 'bitmap') return picture.bitmap
  const w = Math.max(1, Math.round(picture.metafile.size.width))
  const h = Math.max(1, Math.round(picture.metafile.size.height))
  if (fonts === null && picture.metafile.fonts.length > 0) return null
  const canvas = createCanvas(w, h)
  const c = canvas.getContext('2d')
  if (c === null) return null
  const none = { left: 0, top: 0, right: 0, bottom: 0 }
  drawPicture(c, picture, none, { x: 0, y: 0, width: w, height: h }, IDENTITY, 'high', fonts)
  return canvas
}
