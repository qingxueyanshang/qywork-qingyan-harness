/**
 * 图片尺寸解析与缩放策略。
 *
 * 覆盖范围：`image.ts` 全部（`imageSizeOf` + `shrinkImage`，含上限内大 PNG 改用 JPEG 的规则）。
 *
 * 重点是一个反直觉的结论：无条件重编码会使常见的截图变大。因此必须锁定「在上限内
 * 原样返回同一个引用」：该行为失效时不会报错，每张图片的体积会静默增大一倍以上。
 */

import { describe, expect, test } from 'bun:test'
import { imageSizeOf } from '@qywork/core'
import { downscaleNote, shrinkImage, zoomImage } from './image.ts'

/** 构造只有头部合法的 PNG：`imageSizeOf` 只读取文件头。 */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0x49, 0x48, 0x44, 0x52], 12)
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return b
}

describe('缩放策略', () => {
  /**
   * **在上限内必须原样返回同一个引用。**
   *
   * 实测：1440×900 的网页截图重编码为 PNG 之后体积增大到 2.4 倍。
   * 该断言比较引用而不是内容：内容相等无法排除先解码再重新编码的情况。
   */
  test('尺寸在上限内时字节不变', async () => {
    const bytes = png(1440, 900)
    const out = await shrinkImage(bytes, 'image/png')
    expect(out.bytes).toBe(bytes)
    expect(out.mime).toBe('image/png')
  })

  /** 无法读取尺寸时同样原样通过：宁可多发送一些字节，也不解码无法识别的图片。 */
  test('无法识别尺寸时原样通过', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    expect((await shrinkImage(bytes, 'image/png')).bytes).toBe(bytes)
  })

  /** 超出上限但无法解码（此处文件头是伪造的）时不能抛错；单张图片无法压缩，不应导致整轮失败。 */
  test('超出上限但解码失败时原样返回，不抛出异常', async () => {
    const bytes = png(4000, 3000)
    const out = await shrinkImage(bytes, 'image/png')
    expect(out.bytes).toBe(bytes)
  })
})

/** 带颗粒的渐变画面，接近渲染截图：PNG 无法有效压缩，JPEG 可减小一个数量级。 */
async function scene(alpha: number): Promise<Uint8Array> {
  const photon = await import('@silvia-odwyer/photon-node')
  const w = 640
  const h = 360
  const raw = new Uint8Array(w * h * 4)
  let seed = 7
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const n = seed % 24
      const o = (y * w + x) * 4
      raw[o] = (x / w) * 200 + n
      raw[o + 1] = (y / h) * 180 + n
      raw[o + 2] = 120 + Math.sin(x / 9) * 60 + n
      raw[o + 3] = alpha
    }
  return new photon.PhotonImage(raw, w, h).get_bytes()
}

describe('上限内的大 PNG', () => {
  test('不透明且超过 300 KB：改用体积小一半以上的 JPEG', async () => {
    const bytes = await scene(255)
    expect(bytes.length).toBeGreaterThan(300 * 1024)
    const out = await shrinkImage(bytes, 'image/png')
    expect(out.mime).toBe('image/jpeg')
    expect(out.bytes.length * 2).toBeLessThanOrEqual(bytes.length)
    expect(imageSizeOf(out.bytes)).toEqual({ width: 640, height: 360 })
  })

  /** JPEG 没有透明通道：转换后透明处变为实色，模型看到的画面与原图不符。 */
  test('有透明像素：原样返回', async () => {
    const bytes = await scene(128)
    const out = await shrinkImage(bytes, 'image/png')
    expect(out.bytes).toBe(bytes)
    expect(out.mime).toBe('image/png')
  })

  /** 只处理 PNG：JPEG 已经过压缩，GIF 转为 JPEG 会丢失动画。 */
  test('不是 PNG：原样返回', async () => {
    const bytes = await scene(255)
    const out = await shrinkImage(bytes, 'image/gif')
    expect(out.bytes).toBe(bytes)
  })
})

describe('局部放大', () => {
  async function blank(width: number, height: number, alpha = 255) {
    const photon = await import('@silvia-odwyer/photon-node')
    const px = new Uint8Array(width * height * 4).fill(255)
    for (let i = 3; i < px.length; i += 4) px[i] = alpha
    return new photon.PhotonImage(px, width, height).get_bytes()
  }

  /** 越界的比例收到图内；截取至少 1 像素，放大不超过 4 倍。 */
  test('越界的区域收到图内，放大不超过 4 倍', async () => {
    const z = await zoomImage(await blank(1000, 500), {
      left: 0.9,
      top: 0.9,
      width: 0.5,
      height: 0.5,
    })
    expect(z.box).toEqual({ x: 900, y: 450, width: 100, height: 50 })
    expect(z.size).toEqual({ width: 400, height: 200 })
    expect(z.scale).toBe(4)
    expect(z.source).toEqual({ width: 1000, height: 500 })
  })

  /** 截取范围大于上限时缩小到长边 1568，与整图发送一致。 */
  test('截取范围超过上限时缩小', async () => {
    const z = await zoomImage(await blank(4000, 1000), { left: 0, top: 0, width: 1, height: 1 })
    expect(z.size.width).toBe(1568)
    expect(z.scale).toBeLessThan(1)
  })

  /** 有透明像素时只用 PNG：JPEG 没有透明通道。 */
  test('有透明像素时输出 PNG', async () => {
    const z = await zoomImage(await blank(200, 100, 128), { left: 0, top: 0, width: 1, height: 1 })
    expect(z.mime).toBe('image/png')
  })

  test('缩小说明：只在发送尺寸小于原图时给出', () => {
    expect(downscaleNote({ width: 2560, height: 1360 }, { width: 1568, height: 833 })).toBe(
      '，原图 2560×1360，缩小为 1568×833 发送；细线、描边、小字看不清时用 read_file 的 region 截取局部放大',
    )
    expect(downscaleNote({ width: 800, height: 600 }, { width: 800, height: 600 })).toBe('')
    expect(downscaleNote(null, { width: 1, height: 1 })).toBe('')
  })
})
