/**
 * 从文件头读取图片的像素宽高，不解码画面。估算图片的 token 数（`ai` 的 `estimateImage`）、
 * 记录工具图片的尺寸（`store` 的 `storeToolImages`）与缩放判定（`tools` 的 `shrinkImage`）共用。
 */

export interface ImageSize {
  width: number
  height: number
}

function u16be(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0)
}
function u32be(b: Uint8Array, at: number): number {
  return (
    (b[at] ?? 0) * 0x1000000 + ((b[at + 1] ?? 0) << 16) + ((b[at + 2] ?? 0) << 8) + (b[at + 3] ?? 0)
  )
}
function u16le(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8)
}
function ascii(b: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false
  return true
}

/**
 * 从文件头读取宽高，不解码。
 *
 * 只识别 `isInlineImage` 允许的四种格式。无法读取时返回 null，按不确定处理
 * 并原样通过；宁可多发送一些字节，也不为无法识别的文件头执行整幅解码。
 */
export function imageSizeOf(bytes: Uint8Array): ImageSize | null {
  // PNG：签名 8 字节 + IHDR 长度/类型 8 字节，宽高紧跟其后。
  if (bytes.length >= 24 && ascii(bytes, 1, 'PNG') && ascii(bytes, 12, 'IHDR')) {
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) }
  }
  // GIF：`GIF87a` / `GIF89a` 之后是小端的逻辑屏幕宽高。
  if (bytes.length >= 10 && ascii(bytes, 0, 'GIF')) {
    return { width: u16le(bytes, 6), height: u16le(bytes, 8) }
  }
  // WebP 有三种块，宽高的位置各不相同。
  if (bytes.length >= 30 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) {
    if (ascii(bytes, 12, 'VP8X')) {
      // 24 位小端，存储的是减一之后的值。
      const w = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16))
      const h = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16))
      return { width: w, height: h }
    }
    if (ascii(bytes, 12, 'VP8L')) {
      // 0x2f 签名之后是 4 字节小端：低 14 位为宽减一，其后 14 位为高减一。
      const raw =
        ((bytes[21] ?? 0) |
          ((bytes[22] ?? 0) << 8) |
          ((bytes[23] ?? 0) << 16) |
          ((bytes[24] ?? 0) << 24)) >>>
        0
      return { width: 1 + (raw & 0x3fff), height: 1 + ((raw >>> 14) & 0x3fff) }
    }
    if (ascii(bytes, 12, 'VP8 ')) {
      return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
    }
    return null
  }
  // JPEG：沿 marker 查找第一个 SOF，宽高位于其载荷中。
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at++
        continue
      }
      const marker = bytes[at + 1] ?? 0
      // SOF0–SOF15，跳过 DHT(c4) / JPG(c8) / DAC(cc)：它们不含尺寸。
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { width: u16be(bytes, at + 7), height: u16be(bytes, at + 5) }
      }
      // 无载荷的 marker（填充、RSTn、SOI/EOI）直接跳过两字节。
      if (
        marker === 0xd8 ||
        marker === 0xd9 ||
        marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        at += 2
        continue
      }
      at += 2 + u16be(bytes, at + 2)
    }
  }
  return null
}
