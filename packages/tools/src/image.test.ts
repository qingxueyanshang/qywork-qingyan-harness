/**
 * 图片尺寸解析与缩放策略。
 *
 * 覆盖范围：`image.ts` 全部（`imageSizeOf` + `shrinkImage`，含上限内大 PNG 改用 JPEG 的规则）。
 *
 * 重点是一个反直觉的结论：无条件重编码会使常见的截图变大。因此必须锁定「在上限内
 * 原样返回同一个引用」：该行为失效时不会报错，每张图片的体积会静默增大一倍以上。
 */

import { describe, expect, test } from 'bun:test'
import { imageSizeOf, shrinkImage } from './image.ts'

/** 构造只有头部合法的 PNG：`imageSizeOf` 只读取文件头。 */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0x49, 0x48, 0x44, 0x52], 12)
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return b
}

describe('从文件头读取宽高', () => {
  test('PNG', () => {
    expect(imageSizeOf(png(1440, 900))).toEqual({ width: 1440, height: 900 })
  })

  test('GIF 使用小端序', () => {
    const b = new Uint8Array(10)
    b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0)
    b.set([0xa0, 0x05, 0x84, 0x03], 6)
    expect(imageSizeOf(b)).toEqual({ width: 1440, height: 900 })
  })

  /** JPEG 需要沿 marker 查找 SOF，且高在前、宽在后：顺序颠倒时判据完全相反。 */
  test('JPEG 沿 marker 查找 SOF，高在前', () => {
    const b = new Uint8Array(24)
    b.set([0xff, 0xd8], 0)
    // 带载荷的 APP0，长度 4（含长度字段本身），跳过它之后是 SOF。
    b.set([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00], 2)
    b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 8)
    new DataView(b.buffer).setUint16(13, 900) // 高
    new DataView(b.buffer).setUint16(15, 1440) // 宽
    expect(imageSizeOf(b)).toEqual({ width: 1440, height: 900 })
  })

  /** 无法识别时返回 null：此时按不确定处理并原样通过，不为未知格式的文件头执行整幅解码。 */
  test('无法识别的文件头返回 null', () => {
    expect(imageSizeOf(new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })
})

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
