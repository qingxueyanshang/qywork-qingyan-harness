/**
 * OfficeArt 记录（.xls 的绘图、.doc 的浮动对象与 .ppt 的形状共用的二进制绘图格式）。
 *
 * - 记录头 8 字节：低 4 位为版本、高 12 位为实例，其后 2 字节类型、4 字节长度。版本为 0xF 的记录是容器，数据为子记录序列。
 *   .ppt 的文档记录使用同一种记录头。
 * - 长度超出数据范围的记录截到数据末尾；不足 8 字节的尾部忽略。
 */

export interface ArtRecord {
  readonly version: number
  readonly instance: number
  readonly type: number
  readonly data: Uint8Array
}

export const ART = {
  DGG_CONTAINER: 0xf000,
  BSTORE_CONTAINER: 0xf001,
  DG_CONTAINER: 0xf002,
  SPGR_CONTAINER: 0xf003,
  SP_CONTAINER: 0xf004,
  FBSE: 0xf007,
  FSPGR: 0xf009,
  FSP: 0xf00a,
  FOPT: 0xf00b,
  CLIENT_TEXTBOX: 0xf00d,
  CHILD_ANCHOR: 0xf00f,
  CLIENT_ANCHOR: 0xf010,
  CLIENT_DATA: 0xf011,
  BLIP_EMF: 0xf01a,
  BLIP_WMF: 0xf01b,
  BLIP_PICT: 0xf01c,
  BLIP_JPEG: 0xf01d,
  BLIP_PNG: 0xf01e,
  BLIP_DIB: 0xf01f,
  BLIP_TIFF: 0xf029,
  BLIP_JPEG_CMYK: 0xf02a,
  SECONDARY_FOPT: 0xf121,
  TERTIARY_FOPT: 0xf122,
} as const

/** `data` 中第 `offset` 字节起的一条记录；不足 8 字节时为 `null`。 */
export function readArtRecord(data: Uint8Array, offset: number): ArtRecord | null {
  if (offset < 0 || offset + 8 > data.length) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const head = view.getUint16(offset, true)
  const end = Math.min(offset + 8 + view.getUint32(offset + 4, true), data.length)
  return {
    version: head & 0x0f,
    instance: head >> 4,
    type: view.getUint16(offset + 2, true),
    data: data.subarray(offset + 8, end),
  }
}

export function readArtRecords(data: Uint8Array): ArtRecord[] {
  const out: ArtRecord[] = []
  for (let r = readArtRecord(data, 0); r !== null; ) {
    out.push(r)
    r = readArtRecord(data, r.data.byteOffset - data.byteOffset + r.data.length)
  }
  return out
}

/**
 * 形状属性表（FOPT 及其次级、第三级属性表）。属性编号已去掉 fBid 与 fComplex 两个标志位。
 *
 * - `values`：全部属性的 32 位值；复杂属性的值为附加数据的字节数。
 * - `complex`：复杂属性的附加数据，按属性表中的顺序依次位于属性表之后；超出记录数据的部分截断。
 */
export interface ArtProperties {
  readonly values: ReadonlyMap<number, number>
  readonly complex: ReadonlyMap<number, Uint8Array>
}

export const EMPTY_PROPERTIES: ArtProperties = { values: new Map(), complex: new Map() }

/**
 * 附加数据为数组（6 字节头：元素数、分配数、元素字节数，其后为元素）的属性：顶点、路径段、连接点与其方向、调整柄、公式、
 * 文本矩形、渐变色标、虚线样式、环绕多边形。
 */
const ARRAY_PROPERTIES: ReadonlySet<number> = new Set([
  0x0145, 0x0146, 0x0151, 0x0152, 0x0155, 0x0156, 0x0157, 0x0197, 0x01cf, 0x0383,
])

/** 数组元素的字节数：0xFFF0 表示 8 字节元素只记录低 4 字节。 */
export function arrayElementSize(size: number): number {
  return size === 0xfff0 ? 4 : size
}

/**
 * 数组属性记录的长度可以不含 6 字节头：元素数与元素字节数之积等于记录的长度时，实际长度为记录的长度加 6。
 * 不按此修正时，其后各复杂属性的附加数据整体错位 6 字节。
 */
function arrayLength(view: DataView, start: number, value: number): number {
  if (start + 6 > view.byteLength) return value
  const count = view.getUint16(start, true)
  return count * arrayElementSize(view.getUint16(start + 4, true)) === value ? value + 6 : value
}

export function readProperties(fopt: ArtRecord): ArtProperties {
  const view = new DataView(fopt.data.buffer, fopt.data.byteOffset, fopt.data.byteLength)
  const values = new Map<number, number>()
  const complex = new Map<number, Uint8Array>()
  const count = Math.min(fopt.instance, Math.floor(fopt.data.length / 6))
  let extra = count * 6
  for (let k = 0; k < count; k++) {
    const id = view.getUint16(k * 6, true)
    const value = view.getUint32(k * 6 + 2, true)
    values.set(id & 0x3fff, value)
    if ((id & 0x8000) === 0) continue
    const length =
      ARRAY_PROPERTIES.has(id & 0x3fff) && value > 0 ? arrayLength(view, extra, value) : value
    const end = Math.min(extra + length, fopt.data.length)
    complex.set(id & 0x3fff, fopt.data.subarray(extra, end))
    extra = end
  }
  return { values, complex }
}

/** 布尔属性：每组 64 个属性的最后一个，低 16 位为各标志的值，高 16 位为对应标志是否给出。 */
export function isBooleanProperty(id: number): boolean {
  return (id & 0x3f) === 0x3f
}

/**
 * 依次合并属性表：后者覆盖前者的同名属性；布尔属性按标志合并，只覆盖后者给出的标志。
 * 结果中的布尔属性高 16 位为各表给出的标志之并。
 */
export function mergeProperties(...tables: readonly ArtProperties[]): ArtProperties {
  if (tables.length === 1) return tables[0]!
  const values = new Map<number, number>()
  const complex = new Map<number, Uint8Array>()
  for (const t of tables) {
    for (const [k, v] of t.values) {
      const old = values.get(k)
      if (old !== undefined && isBooleanProperty(k)) {
        const given = v >>> 16
        values.set(k, ((((old & ~given) | (v & given)) & 0xffff) | ((old | v) & 0xffff0000)) >>> 0)
        continue
      }
      values.set(k, v)
      const data = t.complex.get(k)
      if (data === undefined) complex.delete(k)
      else complex.set(k, data)
    }
  }
  return { values, complex }
}

/** 布尔属性 `id` 中第 `bit` 位（值所在的低 16 位）的标志；属性表未给出该标志时为 `fallback`。 */
export function flagOf(props: ArtProperties, id: number, bit: number, fallback: boolean): boolean {
  const v = props.values.get(id)
  if (v === undefined || ((v >>> (16 + bit)) & 1) === 0) return fallback
  return ((v >>> bit) & 1) === 1
}
