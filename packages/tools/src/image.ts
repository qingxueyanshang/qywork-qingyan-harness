/**
 * 交给模型之前把过大的图缩下来。
 *
 * **先读头，只对真超标的动手，不能读到图就重编码。** 实测（2026-08，photon 0.3.4）：一张 1440×900
 * 的网页截图 485 KB，本来就在上限内，重编码成 PNG 之后是 **1174 KB——大了 2.4 倍**。浏览器与截图
 * 工具的 PNG 编码器比这个库好得多，原样通过才是对的。
 *
 * 所以先从文件头把宽高抠出来（几十字节，不解码），在上限内就一个字节不动。
 * 绝大多数截图走的都是这一条。
 *
 * **超标了才解码，输出取更小的那个。** 同一次实测：3200×2400 的 2764 KB 缩到 1568 长边之后，PNG 是
 * 1143 KB、JPEG(82) 是 88 KB。差一个数量级，**必须两个都编一遍取小的**——只出 PNG 等于没压。
 *
 * 1568 这个数来自各家对内联图片的建议长边；再大也会被服务端缩回去，
 * 本地先缩是为了省下那份带宽和库容。
 */

/** 长边超过它才动手。 */
const MAX_EDGE = 1568

/** JPEG 质量。82 是文字截图仍然读得清、体积又降下来的那一档。 */
const JPEG_QUALITY = 82

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
 * 从文件头读宽高，**不解码**。
 *
 * 只认 `isInlineImage` 放行的那四种格式。读不出来返回 null——那时按「不确定」
 * 处理，原样通过；宁可多发几个字节，也不为一个认不出的头去做整幅解码。
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
      // 24 位小端，存的是「减一之后」的值。
      const w = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16))
      const h = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16))
      return { width: w, height: h }
    }
    if (ascii(bytes, 12, 'VP8L')) {
      // 0x2f 签名之后是 4 字节小端：低 14 位宽减一，接着 14 位高减一。
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
  // JPEG：顺着 marker 走到第一个 SOF，宽高在它的载荷里。
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at++
        continue
      }
      const marker = bytes[at + 1] ?? 0
      // SOF0–SOF15，跳过 DHT(c4) / JPG(c8) / DAC(cc)——它们不带尺寸。
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { width: u16be(bytes, at + 7), height: u16be(bytes, at + 5) }
      }
      // 无载荷的 marker（填充、RSTn、SOI/EOI）直接跳两字节。
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

/**
 * 需要的话把图缩到长边 `MAX_EDGE`。
 *
 * **在上限内原样返回同一个引用**，不重编码（见文件头那段实测）。
 * 解码或缩放失败也原样返回——一张图发大一点只是费流量，
 * 而为此让一次 `read_file` 失败是本末倒置。
 */
export async function shrinkImage(
  bytes: Uint8Array,
  mime: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const size = imageSizeOf(bytes)
  if (!size || Math.max(size.width, size.height) <= MAX_EDGE) return { bytes, mime }

  try {
    // 动态 import：photon 带着 2.2 MB 的 wasm，而绝大多数会话一张超标的图都碰不到。
    const photon = await import('@silvia-odwyer/photon-node')
    const img = photon.PhotonImage.new_from_byteslice(bytes)
    const scale = MAX_EDGE / Math.max(img.get_width(), img.get_height())
    const out = photon.resize(
      img,
      Math.max(1, Math.round(img.get_width() * scale)),
      Math.max(1, Math.round(img.get_height() * scale)),
      photon.SamplingFilter.Lanczos3,
    )
    // 两种编码都试，取小的。实测差一个数量级——只出 PNG 等于没压。
    const png = out.get_bytes()
    const jpeg = out.get_bytes_jpeg(JPEG_QUALITY)
    const best =
      jpeg.length < png.length
        ? { bytes: jpeg, mime: 'image/jpeg' }
        : { bytes: png, mime: 'image/png' }
    return best.bytes.length < bytes.length ? best : { bytes, mime }
  } catch {
    return { bytes, mime }
  }
}
