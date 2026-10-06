/**
 * 交给模型之前缩小过大的图片。
 *
 * 先读取文件头，只处理确实超出上限的图片，不对读取到的每张图片重编码。实测（2026-08，photon 0.3.4）：
 * 1440×900 的网页截图为 485 KB，在上限内，重编码为 PNG 之后为 1174 KB，增大到 2.4 倍。
 * 浏览器与截图工具的 PNG 编码器优于该库，因此应原样通过。
 *
 * 具体做法：先从文件头读取宽高（几十字节，不解码），在上限内时不重编码为 PNG。
 * 唯一的例外是在上限内且超过 300 KB 的不透明 PNG：只尝试 JPEG，体积减小一半以上时才替换（`REENCODE_ABOVE_BYTES`）。
 *
 * 超出上限时才解码，输出取体积较小的编码。同一次实测：3200×2400、2764 KB 的图片缩放到长边 1568 之后，
 * PNG 为 1143 KB，JPEG(82) 为 88 KB。两者相差一个数量级，因此必须分别编码并取较小者；只输出 PNG 时压缩几乎无效。
 *
 * 1568 取自各 provider 对内联图片建议的长边；更大的图片也会被服务端缩小，
 * 本地先缩放可节省带宽与存储空间。
 */

/**
 * 长边超过该值时才缩放。
 *
 * 这是图像长边上限的唯一声明。自行产生图像的工具（桌面采集）把它传给采集端，
 * 由采集端按同一数值缩放后返回：两处各设一个上限时，图像几何记录的尺寸与模型看到的
 * 尺寸会不一致。
 */
export const MAX_EDGE = 1568

/** JPEG 质量。82 是文字截图仍可清晰辨认且体积明显减小的取值。 */
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

/**
 * 长边在上限内、但字节数超过本值的 PNG，再尝试一次 JPEG。
 *
 * 图片会保留在之后的每次请求中（`agent` 的 `evictedMedia`），每一步都要重新传输这些字节，中转服务的
 * 响应头时间随请求体增大而增加。实测 1280×720 的渲染截图 PNG 为 560–670 KB，JPEG(82) 为 96–153 KB。
 * 体积减小一半以上时才替换：编码良好的 PNG 截图改用 JPEG 节省有限，还会引入压缩噪点。
 * 有透明像素时不替换：JPEG 没有透明通道，透明处会变为实色，画面与原图不符。
 */
const REENCODE_ABOVE_BYTES = 300 * 1024

/**
 * 必要时把图片缩放到长边 `MAX_EDGE`，或把在上限内的大 PNG 改为更小的 JPEG。
 *
 * 其余情况原样返回同一个引用，不重编码（见文件头的实测数据）。
 * 解码或缩放失败时同样原样返回：图片体积偏大只增加传输量，
 * 不应因此使一次 `read_file` 失败。
 */
export async function shrinkImage(
  bytes: Uint8Array,
  mime: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const size = imageSizeOf(bytes)
  if (!size) return { bytes, mime }
  if (Math.max(size.width, size.height) <= MAX_EDGE) {
    if (mime !== 'image/png' || bytes.length <= REENCODE_ABOVE_BYTES) return { bytes, mime }
    try {
      const photon = await import('@silvia-odwyer/photon-node')
      const img = photon.PhotonImage.new_from_byteslice(bytes)
      const pixels = img.get_raw_pixels()
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! < 255) return { bytes, mime }
      const jpeg = img.get_bytes_jpeg(JPEG_QUALITY)
      return jpeg.length * 2 <= bytes.length ? { bytes: jpeg, mime: 'image/jpeg' } : { bytes, mime }
    } catch {
      return { bytes, mime }
    }
  }

  try {
    // 动态 import：photon 包含 2.2 MB 的 wasm，而绝大多数会话不会遇到超出上限的图片。
    const photon = await import('@silvia-odwyer/photon-node')
    const img = photon.PhotonImage.new_from_byteslice(bytes)
    const scale = MAX_EDGE / Math.max(img.get_width(), img.get_height())
    const out = photon.resize(
      img,
      Math.max(1, Math.round(img.get_width() * scale)),
      Math.max(1, Math.round(img.get_height() * scale)),
      photon.SamplingFilter.Lanczos3,
    )
    // 两种编码都尝试，取较小者。实测两者相差一个数量级，只输出 PNG 时压缩几乎无效。
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
