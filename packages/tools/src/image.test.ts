/**
 * 图片尺寸解析与缩放策略。
 *
 * 覆盖范围：`image.ts` 全部（`imageSizeOf` + `shrinkImage`）。
 *
 * 盯的是一个**反直觉的方向**：无条件重编码会把常见的截图变大。所以「在上限内原样
 * 返回同一个引用」这条必须被锁住——它坏掉不报错，只是每张图静默大一倍。
 */

import { describe, expect, test } from 'bun:test'
import { imageSizeOf, shrinkImage } from './image.ts'

/** 造一个只有头部合法的 PNG：`imageSizeOf` 本来就只读头。 */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0x49, 0x48, 0x44, 0x52], 12)
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return b
}

describe('从文件头读宽高', () => {
  test('PNG', () => {
    expect(imageSizeOf(png(1440, 900))).toEqual({ width: 1440, height: 900 })
  })

  test('GIF 是小端', () => {
    const b = new Uint8Array(10)
    b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0)
    b.set([0xa0, 0x05, 0x84, 0x03], 6)
    expect(imageSizeOf(b)).toEqual({ width: 1440, height: 900 })
  })

  /** JPEG 要顺着 marker 走到 SOF，且**高在前宽在后**——反了会把判据整个取反。 */
  test('JPEG 顺着 marker 找 SOF，高在前', () => {
    const b = new Uint8Array(24)
    b.set([0xff, 0xd8], 0)
    // 一个带载荷的 APP0，长度 4（含自己），跳过它才到 SOF。
    b.set([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00], 2)
    b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 8)
    new DataView(b.buffer).setUint16(13, 900) // 高
    new DataView(b.buffer).setUint16(15, 1440) // 宽
    expect(imageSizeOf(b)).toEqual({ width: 1440, height: 900 })
  })

  /** 认不出就是 null——那时按「不确定」原样通过，不为一个陌生的头去整幅解码。 */
  test('认不出的头回 null', () => {
    expect(imageSizeOf(new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })
})

describe('缩放策略', () => {
  /**
   * **在上限内必须原样返回同一个引用。**
   *
   * 实测：一张 1440×900 的网页截图重编码成 PNG 之后大 2.4 倍。
   * 这条断言比对的是引用而不是内容——内容相等挡不住「解了又编回来」。
   */
  test('尺寸够小就一个字节不动', async () => {
    const bytes = png(1440, 900)
    const out = await shrinkImage(bytes, 'image/png')
    expect(out.bytes).toBe(bytes)
    expect(out.mime).toBe('image/png')
  })

  /** 读不出尺寸同样原样通过：宁可多发几个字节，也不冒险解一张认不出的图。 */
  test('认不出尺寸也原样通过', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    expect((await shrinkImage(bytes, 'image/png')).bytes).toBe(bytes)
  })

  /** 超标但解不开（这里的头是伪造的）不能抛——一张图缩不了不该让整轮起不来。 */
  test('超标但解码失败时原样返回，不抛', async () => {
    const bytes = png(4000, 3000)
    const out = await shrinkImage(bytes, 'image/png')
    expect(out.bytes).toBe(bytes)
  })
})
