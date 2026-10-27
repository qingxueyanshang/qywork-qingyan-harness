/** 覆盖 `image-size.ts`：PNG、GIF、JPEG 文件头与无法识别的输入。 */

import { describe, expect, test } from 'bun:test'
import { imageSizeOf } from './image-size.ts'

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
