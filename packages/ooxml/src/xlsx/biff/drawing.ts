/**
 * .xls 工作表中的图片与图表：绘图容器中的顶层图片形状与图表形状。
 *
 * - 形状与 OBJ 记录按先序遍历的顺序一一对应；OBJ 类型为图片且 `pib`（属性 0x0104）指向图片库中可用图片的顶层形状绘制，
 *   组合内的图片、图片库中没有可用图片的形状（PICT、TIFF 等，见 `../../officeart/blip.ts`）与含未实现记录的图元文件不绘制，
 *   由调用方按 OBJ 计数计入 `image`。组合内的图表同样由调用方按 OBJ 计数计入 `chart`。
 * - 锚点为客户锚点：起止单元格与偏移（列宽的 1/1024、行高的 1/256）。裁剪为属性 0x0100–0x0103（上、下、左、右），
 *   16.16 定点数表示的比例。
 * - `order` 为对象在绘图中的序号，序号大的绘制在上层。
 */

import { drawableImage } from '../../drawingml/shape/resolve.ts'
import { type Blip, readBlipStore } from '../../officeart/blip.ts'
import { ART, type ArtProperties, readArtRecords } from '../../officeart/records.ts'
import { flattenShapes, readDrawingShapes } from '../../officeart/shape.ts'
import type { DrawingAnchor, RatioMarker, SheetImage } from '../model.ts'
import { Bytes } from './records.ts'
import { OBJ_CHART, OBJ_PICTURE } from './sheet.ts'

const PROP_PIB = 0x0104
const PROP_CROP_TOP = 0x0100
const PROP_CROP_BOTTOM = 0x0101
const PROP_CROP_LEFT = 0x0102
const PROP_CROP_RIGHT = 0x0103

/** 绘图组数据（MSODRAWINGGROUP）中的图片库；没有时为空。图片记录都内嵌在 FBSE 中。 */
export async function readBlips(group: Uint8Array | null): Promise<(Blip | null)[]> {
  if (group === null) return []
  const dgg = readArtRecords(group).find((r) => r.type === ART.DGG_CONTAINER)
  return dgg ? await readBlipStore(readArtRecords(dgg.data), null) : []
}

function marker(b: Bytes, p: number): RatioMarker {
  return {
    col: b.u16(p),
    colRatio: Math.min(b.u16(p + 2) / 1024, 1),
    row: b.u16(p + 4),
    rowRatio: Math.min(b.u16(p + 6) / 256, 1),
  }
}

function fraction(props: ArtProperties, id: number): number {
  return ((props.values.get(id) ?? 0) | 0) / 65536
}

/** 顶层图表形状：`object` 为其 OBJ 在 `objects` 中的下标。 */
export interface ChartAnchor {
  readonly object: number
  readonly anchor: DrawingAnchor
  readonly order: number
}

export function readDrawing(
  drawing: readonly Uint8Array[],
  objects: readonly { readonly type: number }[],
  blips: readonly (Blip | null)[],
): { images: SheetImage[]; charts: ChartAnchor[] } {
  if (drawing.length === 0) return { images: [], charts: [] }
  const data = new Uint8Array(drawing.reduce((n, d) => n + d.length, 0))
  let p = 0
  for (const d of drawing) {
    data.set(d, p)
    p += d.length
  }
  const top = readDrawingShapes(data)
  const order = new Map(
    flattenShapes(top)
      .filter((s) => s.clientData !== null)
      .map((s, i) => [s, i]),
  )
  const images: SheetImage[] = []
  const charts: ChartAnchor[] = []
  for (const shape of top) {
    const index = order.get(shape)
    const type = index === undefined ? undefined : objects[index]?.type
    if (index === undefined || shape.anchor === null) continue
    const a = new Bytes(shape.anchor)
    if (a.length < 18) continue
    const anchor: DrawingAnchor = { kind: 'cellRatio', from: marker(a, 2), to: marker(a, 10) }
    if (type === OBJ_CHART) charts.push({ object: index, anchor, order: index })
    if (type !== OBJ_PICTURE) continue
    const blip = blips[(shape.properties.values.get(PROP_PIB) ?? 0) - 1]
    if (!blip || !drawableImage(blip.contentType, blip.bytes)) continue
    images.push({
      anchor,
      order: index,
      contentType: blip.contentType,
      bytes: blip.bytes,
      crop: {
        left: fraction(shape.properties, PROP_CROP_LEFT),
        top: fraction(shape.properties, PROP_CROP_TOP),
        right: fraction(shape.properties, PROP_CROP_RIGHT),
        bottom: fraction(shape.properties, PROP_CROP_BOTTOM),
      },
    })
  }
  return { images, charts }
}
