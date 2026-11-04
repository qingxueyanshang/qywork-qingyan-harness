/**
 * .ppt 解析：`persist.ts`（Current User、UserEditAtom 链与 PersistDirectoryAtom，快速保存、加密与结构错误）、
 * `document.ts`（幻灯片尺寸、起始编号与顺序）、`presentation.ts`（母版形状、配色方案、背景、切换效果计数与 `readPptImages`）、
 * `drawing.ts`（锚点、旋转后的锚点、组合、母版形状属性继承、图片、能力边界计数）、`text.ts`（客户文本框与大纲中的文字、
 * 母版样式、换行与页码）、`metro.ts`（metroBlob 的形状、文字、背景、母版作用域与图片），以及 `../../officeart/` 的
 * `blip.ts`（Pictures 流中的图片、图元文件解压与 DIB 补文件头）、`pattern.ts`（DIB 与 PNG 图案位图）、`geometry.ts`（预设与调整值、顶点生成的自定义几何）、
 * `style.ts`（配色方案颜色、系统序号颜色、渐变、线条、阴影）与 `records.ts`（复杂属性与不含头长度的数组）。
 */

import { describe, expect, test } from 'bun:test'
import { deflateSync } from 'node:zlib'
import { parsePptx } from '../load.ts'
import type { AutoShape, Group, Picture, Presentation } from '../model.ts'
import { readImages } from '../render/resources.ts'
import { THEME } from '../test-helper.ts'
import {
  art,
  buildPpt,
  colorMapAtom,
  container,
  fields,
  groupShape,
  join,
  metroBlob,
  type PptSpec,
  SCHEME,
  shape,
  textStylesAtom,
  themeAtom,
} from './test-helper.ts'

const EMU = 1587.5
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
/**
 * 绘图组的缺省属性（与 PowerPoint 写出的相同）：填充为配色方案的填充色，线条为文本与线条色，文字不换行、居中。
 * 它是新建形状的缺省，解析时不参与。
 */
const DEFAULTS: PptSpec['defaults'] = [
  [0x0085, 2],
  [0x0087, 1],
  [0x0181, 0x08000004],
  [0x0183, 0x08000000],
  [0x01bf, 0x100010],
  [0x01c0, 0x08000001],
  [0x01ff, 0x80008],
]

async function open(spec: PptSpec): Promise<Presentation> {
  const r = await parsePptx(buildPpt(spec))
  if (!r.ok) throw new Error(JSON.stringify(r.failure))
  return r.value
}

function rgb(hex: number) {
  return {
    r: ((hex >> 16) & 0xff) / 255,
    g: ((hex >> 8) & 0xff) / 255,
    b: (hex & 0xff) / 255,
    a: 1,
  }
}

const solid = (hex: number) => ({ kind: 'solid' as const, color: rgb(hex) })

describe('持久对象与文档容器', () => {
  test('幻灯片尺寸、起始编号与 SlideListWithText 中的顺序', async () => {
    const p = await open({
      size: [7680, 4320],
      firstSlideNumber: 0,
      slides: [{}, {}],
      order: [1, 0],
    })
    expect([p.width, p.height]).toEqual([7680 * EMU, 4320 * EMU])
    expect(p.firstSlideNumber).toBe(0)
    expect(p.slides.map((s) => [s.part, s.number, s.master])).toEqual([
      ['slide/257', 0, 'master/2147483648'],
      ['slide/256', 1, 'master/2147483648'],
    ])
  })

  test('快速保存：较晚的保存覆盖同一编号的持久对象', async () => {
    const p = await open({
      defaults: DEFAULTS,
      slides: [{ shapes: [shape({ id: 1025, anchor: [0, 0, 576, 576] })] }],
      edits: [
        new Map([
          [
            3,
            container(
              0x03ee,
              art(
                0x0002,
                0x03ef,
                fields([4, 0]),
                new Uint8Array(8),
                fields([4, 0x80000000], [4, 0], [2, 7], [2, 0]),
              ),
              container(
                0x040c,
                container(
                  0xf002,
                  container(
                    0xf003,
                    shape({ id: 1024, type: 0, flags: 0x5 }),
                    shape({ id: 1026, anchor: [576, 576, 1152, 1152] }),
                  ),
                ),
              ),
            ),
          ],
        ]),
      ],
    })
    expect(p.slides[0]!.shapes.map((s) => s.id)).toEqual([1026])
  })

  test('加密与缺少 Current User 流', async () => {
    expect(await parsePptx(buildPpt({ slides: [{}], encrypted: true }))).toEqual({
      ok: false,
      failure: { kind: 'encrypted' },
    })
    expect(await parsePptx(buildPpt({ slides: [{}], currentUser: false }))).toEqual({
      ok: false,
      failure: { kind: 'corrupt', reason: 'ppt' },
    })
  })
})

describe('形状', () => {
  test('锚点、配色方案颜色、母版形状的属性继承；绘图组的缺省属性不参与', async () => {
    const master = shape({
      id: 2049,
      anchor: [100, 200, 300, 400],
      props: [
        [0x01bf, 0x100000],
        [0x01ff, 0x80000],
      ],
      client: [art(0, 0x0bc3, fields([4, 0], [1, 1], [1, 0], [2, 0]))],
    })
    const p = await open({
      defaults: DEFAULTS,
      master: { shapes: [master, shape({ id: 2050, anchor: [0, 0, 576, 576] })] },
      slides: [
        {
          shapes: [
            shape({
              id: 1025,
              anchor: [576, 1152, 2304, 1728],
              props: [[0x0301, 2049]],
              client: [art(0, 0x0bc3, fields([4, 0], [1, 13], [1, 0], [2, 0]))],
            }),
            shape({
              id: 1026,
              anchor: [0, 0, 288, 144],
              props: [[0x0181, 0x0000ff]],
              textbox: [art(0, 0x0f9f, fields([4, 4])), art(0, 0x0fa0, fields([2, 0x78]))],
            }),
          ],
        },
      ],
    })
    const [decoration, title, box] = p.slides[0]!.shapes as AutoShape[]
    expect(decoration!.origin).toBe('master')
    expect(decoration!.fill).toEqual(solid(0xffffff))
    expect(decoration!.line?.fill).toEqual(solid(0x000000))
    expect(title!.frame).toEqual({
      x: 1152 * EMU,
      y: 576 * EMU,
      width: 1152 * EMU,
      height: 1152 * EMU,
      rotation: 0,
      flipH: false,
      flipV: false,
    })
    expect(title!.placeholder?.type).toBe('title')
    expect(title!.fill).toEqual({ kind: 'none' })
    expect(title!.line).toBeNull()
    expect(box!.fill).toEqual(solid(0xff0000))
    expect(box!.line?.width).toBe(9525)
    expect(box!.text!.body).toMatchObject({ wrap: true, anchor: 't' })
  })

  test('旋转 90° 的锚点为外接矩形，形状框宽高互换；翻转取自 FSP', async () => {
    const p = await open({
      slides: [
        {
          shapes: [
            shape({
              id: 1025,
              flags: 0xa40,
              anchor: [0, 0, 400, 200],
              props: [[0x0004, 90 << 16]],
            }),
          ],
        },
      ],
    })
    expect(p.slides[0]!.shapes[0]!.frame).toEqual({
      x: 100 * EMU,
      y: -100 * EMU,
      width: 200 * EMU,
      height: 400 * EMU,
      rotation: 90,
      flipH: true,
      flipV: false,
    })
  })

  test('组合：子锚点按组合坐标系换算到幻灯片', async () => {
    const p = await open({
      slides: [
        {
          shapes: [
            groupShape(
              { id: 1025, type: 0, anchor: [100, 100, 500, 300], group: [0, 0, 1000, 500] },
              shape({ id: 1026, child: [500, 0, 1000, 250] }),
            ),
          ],
        },
      ],
    })
    const g = p.slides[0]!.shapes[0] as Group
    expect(g.kind).toBe('group')
    expect(g.frame).toMatchObject({
      x: 100 * EMU,
      y: 100 * EMU,
      width: 400 * EMU,
      height: 200 * EMU,
    })
    expect(g.children[0]!.frame).toMatchObject({
      x: 300 * EMU,
      y: 100 * EMU,
      width: 200 * EMU,
      height: 100 * EMU,
    })
  })

  test('预设形状的调整值换算与顶点生成的自定义几何；复杂属性的长度可以不含数组头', async () => {
    const vertices = join(
      fields([2, 3], [2, 3], [2, 0xfff0]),
      fields([2, 0], [2, 0], [2, 100], [2, 0], [2, 100], [2, 50]),
    )
    const segments = join(
      fields([2, 4], [2, 4], [2, 2]),
      fields([2, 0x4000], [2, 0x0002], [2, 0x6001], [2, 0x8000]),
    )
    const p = await open({
      slides: [
        {
          shapes: [
            shape({ id: 1025, type: 2, anchor: [0, 0, 100, 200], props: [[0x0147, 5400]] }),
            shape({
              id: 1026,
              type: 0,
              anchor: [0, 0, 100, 100],
              props: [
                [0x0142, 100],
                [0x0143, 50],
                // 记录的长度不含 6 字节头。
                [0x0145, vertices, 12],
                [0x0146, segments],
              ],
            }),
          ],
        },
      ],
    })
    const [round, custom] = p.slides[0]!.shapes as AutoShape[]
    expect(round!.geometry).toEqual({
      kind: 'preset',
      name: 'roundRect',
      adjust: [{ name: 'adj', formula: 'val 25000' }],
    })
    expect(custom!.geometry).toEqual({
      kind: 'custom',
      adjust: [],
      guides: [],
      textRect: null,
      paths: [
        {
          width: 100,
          height: 50,
          fill: 'norm',
          stroke: true,
          commands: [
            { kind: 'move', to: { x: 0, y: 0 } },
            { kind: 'line', to: { x: 100, y: 0 } },
            { kind: 'line', to: { x: 100, y: 50 } },
            { kind: 'close' },
          ],
        },
      ],
    })
  })

  test('渐变、系统序号颜色、线条样式、阴影与能力边界计数', async () => {
    const p = await open({
      slides: [
        {
          shapes: [
            shape({
              id: 1025,
              anchor: [0, 0, 100, 100],
              props: [
                [0x0180, 7],
                [0x0181, 0x0000ff],
                // 填充色变暗到 0x80/0xFF。
                [0x0183, 0x108001f0],
                [0x018b, 0],
                [0x018c, 100],
                [0x01cb, 25400],
                [0x01ce, 6],
                [0x01d1, 1],
                [0x023f, 0x20002],
              ],
            }),
            shape({ id: 1026, type: 136, anchor: [0, 0, 100, 100], props: [[0x00c0, 2]] }),
          ],
          extra: [art(0, 0x03f9, fields([4, 0], [4, 0], [1, 0], [1, 5], [2, 0], [4, 0]))],
        },
      ],
    })
    const s = p.slides[0]!.shapes[0] as AutoShape
    expect(s.fill).toEqual({
      kind: 'gradient',
      stops: [
        { position: 0, color: rgb(0xff0000) },
        { position: 1, color: { r: 127 / 255, g: 0, b: 0, a: 1 } },
      ],
      shade: { kind: 'linear', angle: 90, scaled: true },
      flip: 'none',
      rotateWithShape: true,
    })
    expect(s.line).toMatchObject({
      width: 25400,
      dash: { kind: 'preset', name: 'dash' },
      tail: { type: 'triangle', width: 'med', length: 'med' },
      head: null,
    })
    expect(s.effects).toMatchObject([
      { kind: 'outerShadow', distance: Math.hypot(25400, 25400), direction: 45 },
    ])
    expect(p.slides[0]!.shapes).toHaveLength(1)
    expect(p.unsupported).toEqual({ textWarp: 1, transition: 1 })
  })

  test('背景：幻灯片使用母版背景时取母版绘图容器中的背景形状', async () => {
    const background = shape({ id: 2047, flags: 0xc00, props: [[0x0181, 0x08000006]] })
    const p = await open({ master: { background }, slides: [{}, { flags: 3 }] })
    expect(p.slides.map((s) => s.background)).toEqual([solid(SCHEME[6]!), null])
  })
})

describe('图片', () => {
  const emf = Uint8Array.from([
    1,
    0,
    0,
    0,
    108,
    0,
    0,
    0,
    ...new Uint8Array(32),
    0x20,
    0x45,
    0x4d,
    0x46,
    0,
    0,
    1,
    0,
    ...new Uint8Array(60),
  ])
  /** 图元文件图片记录：一个标识，34 字节图元文件头，其后为 zlib 压缩的数据。 */
  function metafileBlip(type: number, instance: number, data: Uint8Array): Uint8Array {
    const packed = deflateSync(data)
    return art(
      instance << 4,
      type,
      new Uint8Array(16),
      fields(
        [4, data.length],
        [4, 0],
        [4, 0],
        [4, 10],
        [4, 10],
        [4, 0],
        [4, 0],
        [4, packed.length],
        [1, 0],
        [1, 0xfe],
      ),
      packed,
    )
  }
  const dib = join(
    fields(
      [4, 40],
      [4, 8],
      [4, 8],
      [2, 1],
      [2, 1],
      [4, 0],
      [4, 32],
      [4, 0],
      [4, 0],
      [4, 0],
      [4, 0],
    ),
    fields([4, 0], [4, 0xffffff]),
    new Uint8Array(32),
  )

  test('Pictures 流中的 PNG、EMF（zlib 解压）与 DIB（补 BMP 文件头）', async () => {
    const png = art(0x6e00, 0xf01e, new Uint8Array(16), fields([1, 0xff]), PNG)
    const blips = [
      png,
      metafileBlip(0xf01a, 0x3d4, emf),
      art(0x7a80, 0xf01f, new Uint8Array(16), fields([1, 0xff]), dib),
    ]
    const pics = blips.map((_, i) =>
      shape({
        id: 1025 + i,
        type: 75,
        anchor: [0, 0, 100, 100],
        props: [
          [0x4104, i + 1],
          [0x0102, 0x4000],
        ],
      }),
    )
    const bytes = buildPpt({ slides: [{ shapes: pics }], delayBlips: blips })
    const r = await parsePptx(bytes)
    if (!r.ok) throw new Error('parse')
    const shapes = r.value.slides[0]!.shapes as Picture[]
    expect(shapes.map((s) => [s.kind, s.image.part, s.image.crop.left])).toEqual([
      ['picture', 'Pictures/1', 0.25],
      ['picture', 'Pictures/2', 0.25],
      ['picture', 'Pictures/3', 0.25],
    ])
    const images = await readImages(bytes, ['Pictures/1', 'Pictures/2', 'Pictures/3', 'Pictures/9'])
    expect(images.get('Pictures/1')).toEqual({ bytes: PNG, contentType: 'image/png' })
    expect(images.get('Pictures/2')).toEqual({ bytes: emf, contentType: 'image/x-emf' })
    const bmp = images.get('Pictures/3')!
    expect(bmp.contentType).toBe('image/bmp')
    expect([...bmp.bytes.subarray(0, 2)]).toEqual([0x42, 0x4d])
    expect(new DataView(bmp.bytes.buffer, bmp.bytes.byteOffset).getUint32(10, true)).toBe(
      14 + 40 + 8,
    )
    expect(bmp.bytes.subarray(14)).toEqual(dib)
    expect(images.has('Pictures/9')).toBe(false)
  })

  /** 8 × 8、位深 1 的调色板 PNG（白、黑），`rows` 中为 1 的像素为白色。不写校验值：读取时不校验。 */
  function patternPng(rows: readonly number[]): Uint8Array {
    const chunk = (type: string, body: Uint8Array) =>
      join(
        Uint8Array.from([0, 0, 0, body.length]),
        Uint8Array.from([...type].map((c) => c.charCodeAt(0))),
        body,
        new Uint8Array(4),
      )
    const raw = Uint8Array.from(rows.flatMap((r) => [0, ~r & 0xff]))
    return join(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', Uint8Array.from([0, 0, 0, 8, 0, 0, 0, 8, 1, 3, 0, 0, 0])),
      chunk('PLTE', Uint8Array.from([255, 255, 255, 0, 0, 0])),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', new Uint8Array(0)),
    )
  }

  test('无法绘制的图片计入 imageFormat；图案位图（DIB 与 PNG）的浅色像素为前景，按预设图案名填充', async () => {
    const pict = art(0x5420, 0xf01c, new Uint8Array(16), new Uint8Array(40))
    const dibPattern = join(
      fields(
        [4, 40],
        [4, 8],
        [4, 8],
        [2, 1],
        [2, 1],
        [4, 0],
        [4, 32],
        [4, 0],
        [4, 0],
        [4, 0],
        [4, 0],
      ),
      fields([4, 0], [4, 0xffffff]),
      ...Array.from({ length: 8 }, () => fields([1, 0xaa], [1, 0], [1, 0], [1, 0])),
    )
    const pct30 = [0xaa, 0x44, 0xaa, 0x11, 0xaa, 0x44, 0xaa, 0x11]
    const blips = [
      pict,
      art(0x7a80, 0xf01f, new Uint8Array(16), fields([1, 0xff]), dibPattern),
      art(0x6e00, 0xf01e, new Uint8Array(16), fields([1, 0xff]), patternPng(pct30)),
    ]
    const patterned = (id: number, pib: number) =>
      shape({
        id,
        anchor: [0, 0, 100, 100],
        props: [
          [0x0180, 1],
          [0x0181, 0x0000ff],
          [0x0183, 0xffffff],
          [0x4186, pib],
        ],
      })
    const p = await open({
      slides: [
        {
          shapes: [
            shape({ id: 1025, type: 75, anchor: [0, 0, 100, 100], props: [[0x4104, 1]] }),
            patterned(1026, 2),
            patterned(1027, 3),
          ],
        },
      ],
      blips,
    })
    expect(p.unsupported).toEqual({ imageFormat: 1 })
    expect(p.slides[0]!.shapes.map((s) => (s as AutoShape).fill)).toEqual(
      ['narVert', 'pct30'].map((preset) => ({
        kind: 'pattern',
        preset,
        foreground: rgb(0xff0000),
        background: rgb(0xffffff),
      })),
    )
  })
})

describe('文字', () => {
  /** TextMasterStyleAtom：一个层级，段落左对齐、单倍行距；字符为第 0 种字体、给定字号、配色方案第 1 种颜色。 */
  function masterStyle(type: number, size: number): Uint8Array {
    return art(
      type << 4,
      0x0fa3,
      fields([2, 1]),
      fields([4, 0x1800], [2, 0], [2, 100]),
      fields([4, 0x70000], [2, 0], [2, size], [4, 0x01000000]),
    )
  }

  test('客户文本框与大纲中的文字：段落与字符属性段、母版样式、换行、页码与日期字段、项目符号', async () => {
    const text = 'AB*\rC\vD*'
    const styles = art(
      0,
      0x0fa1,
      // 段落属性段：前 4 个字符为层级 0、有项目符号「-」；其后 5 个字符为层级 1、段前 10 磅（主单位 −80）。
      fields([4, 4], [2, 0], [4, 0x81], [2, 0x1], [2, 0x2d]),
      fields([4, 5], [2, 1], [4, 0x2000], [2, -80]),
      // 字符属性段：第 1 个字符为粗体、东亚字体为第 1 种；其后为 RGB 红色。
      fields([4, 1], [4, 0x200001], [2, 0x1], [2, 1]),
      fields([4, 8], [4, 0x40000], [4, 0xfe0000ff]),
    )
    const p = await open({
      fonts: [
        ['Arial', 0],
        ['宋体', 134],
      ],
      master: { extra: [masterStyle(4, 18), masterStyle(0, 44)] },
      slides: [
        {
          shapes: [
            shape({
              id: 1025,
              type: 202,
              anchor: [0, 0, 576, 576],
              props: [
                [0x01bf, 0x100000],
                [0x01ff, 0x80000],
              ],
              textbox: [
                art(0, 0x0f9f, fields([4, 4])),
                art(
                  0,
                  0x0fa0,
                  fields(...[...text].map((c) => [2, c.charCodeAt(0)] as [2, number])),
                ),
                styles,
                art(0, 0x0fd8, fields([4, 7])),
                art(0, 0x0ff8, fields([4, 2])),
              ],
            }),
            shape({
              id: 1026,
              anchor: [0, 0, 576, 576],
              textbox: [art(0, 0x0f9e, fields([4, 0]))],
            }),
          ],
          texts: [art(0, 0x0f9f, fields([4, 0])), art(0, 0x0fa0, fields([2, 0x54], [2, 0x69]))],
        },
      ],
    })
    const [box, title] = p.slides[0]!.shapes as AutoShape[]
    const red = { kind: 'solid', color: rgb(0xff0000) }
    const black = { kind: 'solid', color: rgb(SCHEME[1]!) }
    expect(box!.textBox).toBe(true)
    const [first, second] = box!.text!.paragraphs
    expect(first).toMatchObject({
      level: 0,
      align: 'l',
      lineSpacing: { unit: 'percent', value: 1 },
      bullet: { kind: 'char', char: '-', font: 'Arial', size: 18 },
      runs: [
        {
          kind: 'text',
          text: 'A',
          style: { latin: 'Arial', ea: '宋体', bold: true, size: 18, fill: black },
        },
        { kind: 'text', text: 'B', style: { bold: false, fill: red } },
        { kind: 'field', field: 'datetime1', text: '' },
      ],
    })
    expect(first!.runs[0]!.style.latinCharset).toBe(0)
    expect(second).toMatchObject({
      level: 1,
      spaceBefore: { unit: 'points', value: 10 },
      bullet: { kind: 'none' },
      runs: [
        { kind: 'text', text: 'C', style: { fill: red } },
        { kind: 'break' },
        { kind: 'text', text: 'D' },
        { kind: 'field', field: 'slidenum', text: '1' },
      ],
    })
    expect(title!.text!.paragraphs.map((q) => q.runs.map((r) => [r.kind, r.style.size]))).toEqual([
      [['text', 44]],
    ])
  })

  test('语言：TextSpecialInfoAtom 中的中日韩语言标识写入字段的语言（繁体中文按完整的语言标识区分），其余语言为空串', async () => {
    const p = await open({
      slides: [
        {
          shapes: [
            shape({
              id: 1025,
              type: 202,
              anchor: [0, 0, 576, 576],
              textbox: [
                art(0, 0x0f9f, fields([4, 4])),
                art(
                  0,
                  0x0fa0,
                  fields([2, 0x201c], [2, 0x7532], [2, 0x201d], [2, 0x41], [2, 0x4e59]),
                ),
                // 前 3 个字符为简体中文（0x0804），其后 1 个为英语（0x0409），最后为繁体中文（0x0404）；第一段另有拼写标志。
                art(
                  0,
                  0x0faa,
                  fields([4, 3], [4, 0x3], [2, 0], [2, 0x0804]),
                  fields([4, 1], [4, 0x2], [2, 0x0409]),
                  fields([4, 2], [4, 0x2], [2, 0x0404]),
                ),
              ],
            }),
          ],
        },
      ],
    })
    const runs = (p.slides[0]!.shapes[0] as AutoShape).text!.paragraphs[0]!.runs
    expect(runs.map((r) => [r.kind === 'text' ? r.text : '', r.style.lang])).toEqual([
      ['\u201c甲\u201d', 'zh-CN'],
      ['A', ''],
      ['乙', 'zh-TW'],
    ])
  })

  /** PlaceholderAtom：位置与占位符类型（14 为正文）。 */
  const placeholderAtom = (type: number) =>
    art(0, 0x0bc3, fields([4, 1], [1, type], [1, 0], [2, 0]))
  const utf16 = (s: string) => fields(...[...s].map((c) => [2, c.charCodeAt(0)] as [2, number]))
  const textShape = (
    id: number,
    type: number,
    text: string,
    client: Uint8Array[] = [],
    extra: Uint8Array[] = [],
  ) =>
    shape({
      id,
      type: 202,
      anchor: [0, 0, 1152, 576],
      client,
      textbox: [art(0, 0x0f9f, fields([4, type])), art(0, 0x0fa0, utf16(text)), ...extra],
    })

  test('母版带 RoundTrip 文字样式时，占位符的文字经 DrawingML 继承链求值（正文的 TextMasterStyleAtom 不参与，半正文的叠加在其上），其余文字取文档的缺省样式', async () => {
    /** 派生类型的 TextMasterStyleAtom：每个层级前有层级号；只给出字号。 */
    const derived = (type: number, size: number) =>
      art(
        type << 4,
        0x0fa3,
        fields([2, 1], [2, 0]),
        fields([4, 0]),
        fields([4, 0x20000], [2, size]),
      )
    const leftOnly = art(
      0,
      0x0fa1,
      fields([4, 2], [2, 0], [4, 0x100], [2, 0]),
      fields([4, 2], [4, 0]),
    )
    const bulletOnly = art(
      0,
      0x0fa1,
      fields([4, 2], [2, 0], [4, 0x1], [2, 0x1]),
      fields([4, 2], [4, 0]),
    )
    const spec = (roundTrip: boolean) => ({
      fonts: [['Arial', 0] as const],
      environment: [masterStyle(4, 12)],
      master: {
        extra: [
          masterStyle(1, 44),
          masterStyle(4, 40),
          derived(7, 30),
          ...(roundTrip
            ? [
                themeAtom(THEME),
                textStylesAtom(
                  '<p:titleStyle/><p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="–"/>' +
                    '<a:defRPr sz="2000"><a:effectLst><a:outerShdw dist="38100" dir="2700000"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst>' +
                    '<a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle/>',
                ),
              ]
            : []),
        ],
      },
      slides: [
        {
          shapes: [
            textShape(1025, 1, '甲', [placeholderAtom(14)]),
            textShape(1026, 7, '乙', [placeholderAtom(14)]),
            textShape(1027, 4, '丙'),
            // 显式层只给出左边距 0：首行缩进取继承链的绝对位置（母版正文的首行在 0）。
            textShape(1028, 1, '丁', [placeholderAtom(14)], [leftOnly]),
            // 其他类型的文字要求显示项目符号而没有给出字符，文档缺省样式不显示项目符号：字符为「•」。
            textShape(1029, 4, '戊', [], [bulletOnly]),
          ],
        },
      ],
    })
    const sizes = (p: Presentation) =>
      (p.slides[0]!.shapes as AutoShape[]).map((s) => s.text!.paragraphs[0]!.runs[0]!.style.size)
    const p = await open(spec(true))
    expect(sizes(p)).toEqual([20, 30, 12, 20, 12])
    const body = (p.slides[0]!.shapes[0] as AutoShape).text!.paragraphs[0]!
    expect(body).toMatchObject({
      marginLeft: 342900,
      indent: -342900,
      bullet: { kind: 'char', char: '–' },
    })
    expect(body.runs[0]!.style.latin).toBe('Calibri')
    // 旧格式记录的文字不取继承链中的文字效果。
    expect(body.runs[0]!.style.effects).toEqual([])
    expect((p.slides[0]!.shapes[3] as AutoShape).text!.paragraphs[0]).toMatchObject({
      marginLeft: 0,
      indent: 0,
    })
    expect((p.slides[0]!.shapes[4] as AutoShape).text!.paragraphs[0]!.bullet).toMatchObject({
      kind: 'char',
      char: '•',
    })
    expect(sizes(await open(spec(false)))).toEqual([44, 30, 40, 44, 40])
  })

  test('StyleTextProp9Atom 的各项依次对应 pp9rt 分组的字符属性段（不按 pp9rt 的值），有项目符号的段落显示所在组的自动编号', async () => {
    const tag = art(
      0x000f,
      0x1388,
      art(
        0x000f,
        0x138a,
        art(0, 0x0fba, utf16('___PPT9')),
        art(
          0,
          0x138b,
          art(
            0,
            0x0fac,
            // 第 0 项：没有字段；第 1 项：有自动编号，方案 1（A.）从 3 起。各项后为 TextCFException9 与 TextSIException 的掩码。
            fields([4, 0], [4, 0], [4, 0]),
            fields([4, 0x3000000], [2, 1], [2, 1], [2, 3], [4, 0], [4, 0]),
          ),
        ),
      ),
    )
    const styles = art(
      0,
      0x0fa1,
      // 3 个段落都有项目符号「•」，项目符号字体为第 1 种（Wingdings）。
      fields([4, 6], [2, 0], [4, 0x93], [2, 0x3], [2, 0x2022], [2, 1]),
      // 第 1 段没有 pp9rt（第 0 组），第 2 段 pp9rt 为 0（第 1 组），第 3 段为 1（第 2 组，超出项数取最后一项）。
      fields([4, 2], [4, 0]),
      fields([4, 2], [4, 0x400], [2, 0]),
      fields([4, 2], [4, 0x400], [2, 1 << 10]),
    )
    const p = await open({
      fonts: [
        ['Arial', 0],
        ['Wingdings', 2],
      ],
      slides: [{ shapes: [textShape(1025, 4, 'A\rB\rC', [tag], [styles])] }],
    })
    const paragraphs = (p.slides[0]!.shapes[0] as AutoShape).text!.paragraphs
    expect(paragraphs.map((q) => q.bullet)).toMatchObject([
      { kind: 'char', char: '•', font: 'Wingdings' },
      { kind: 'number', scheme: 'alphaUcPeriod', number: 3 },
      { kind: 'number', scheme: 'alphaUcPeriod', number: 4 },
    ])
    // 编号按文字的字体绘制，不取段落属性中的项目符号字体。
    for (const q of paragraphs.slice(1)) {
      if (q.bullet.kind !== 'number') throw new Error('不是编号')
      expect(q.bullet.font).toBe(q.runs[0]!.style.latin)
      expect(q.bullet.font).not.toBe('Wingdings')
    }
  })

  test('日期元字符：DateTimeMCAtom 按格式序号；GenericDateMCAtom 按幻灯片的 HeadersFootersAtom，不显示当天日期时为用户输入的日期文字', async () => {
    const hf = (flags: number, user: string) =>
      art(0x003f, 0x0fd9, art(0, 0x0fda, fields([2, 4], [2, flags])), art(0, 0x0fba, utf16(user)))
    const text = (extra: Uint8Array[]) => [textShape(1025, 4, '*,*', [], extra)]
    const p = await open({
      slides: [
        {
          shapes: text([
            art(0, 0x0ff7, fields([4, 0], [1, 2], [1, 0], [2, 0])),
            art(0, 0x0ff8, fields([4, 2])),
          ]),
          extra: [hf(0x3, '')],
        },
        { shapes: text([art(0, 0x0ff8, fields([4, 2]))]), extra: [hf(0x5, '二〇〇一年')] },
      ],
    })
    const runs = (n: number) =>
      (p.slides[n]!.shapes[0] as AutoShape).text!.paragraphs[0]!.runs.map((r) =>
        r.kind === 'field' ? `[${r.field}]` : r.kind === 'text' ? r.text : '',
      )
    expect(runs(0)).toEqual(['[datetime3]', ',', '[datetime5]'])
    expect(runs(1)).toEqual(['*,二〇〇一年'])
  })

  test('超链接：TxInteractiveInfoAtom 的字符区间按超链接色与单下划线显示，动作为 0 的区间不是超链接', async () => {
    const utf16 = (s: string) => fields(...[...s].map((c) => [2, c.charCodeAt(0)] as [2, number]))
    /** InteractiveInfo：InteractiveInfoAtom 的超链接编号与动作，其后为 TxInteractiveInfoAtom 的区间。 */
    const link = (id: number, action: number, start: number, end: number) => [
      container(
        0x0ff2,
        art(
          0,
          0x0ff3,
          fields([4, 0], [4, id], [1, action], [1, 0], [1, 0], [1, 0], [1, 0]),
          new Uint8Array(3),
        ),
      ),
      art(0, 0x0fdf, fields([4, start], [4, end])),
    ]
    const p = await open({
      documentRecords: [
        container(
          0x0409,
          container(0x0fd7, art(0, 0x0fd3, fields([4, 7])), art(0x10, 0x0fba, utf16('http://a/'))),
        ),
      ],
      slides: [
        {
          shapes: [
            shape({
              id: 1025,
              type: 202,
              anchor: [0, 0, 576, 576],
              textbox: [
                art(0, 0x0f9f, fields([4, 4])),
                art(0, 0x0fa0, utf16('AB CD')),
                ...link(7, 4, 0, 2),
                ...link(0, 0, 3, 5),
              ],
            }),
          ],
        },
      ],
    })
    const runs = (p.slides[0]!.shapes[0] as AutoShape).text!.paragraphs[0]!.runs
    expect(
      runs.map((r) => [r.kind === 'text' ? r.text : '', r.kind === 'text' ? r.link : null]),
    ).toEqual([
      ['AB', 'http://a/'],
      [' CD', null],
    ])
    expect(runs[0]!.style).toMatchObject({ underline: 'sng', fill: solid(SCHEME[6]!) })
    expect(runs[1]!.style.underline).toBe('none')
  })
})

describe('metroBlob', () => {
  const sp = (inner: string, name = '文本框 4') =>
    `<p:sp><p:nvSpPr><p:cNvPr id="5" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>${inner}</p:sp>`
  const box = (x: number, y: number, cx: number, cy: number) =>
    `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
  const chars = (text: string) =>
    art(0, 0x0fa0, fields(...[...text].map((c) => [2, c.charCodeAt(0)] as [2, number])))
  /** PlaceholderAtom：位置、占位符类型（1 为标题）。 */
  const placeholder = (position: number) =>
    art(0, 0x0bc3, fields([4, position], [1, 1], [1, 0], [2, 0]))
  const titleXml = (ph: string, spPr: string, bodyPr: string) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="标题 1"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>${spPr}` +
    `<p:txBody>${bodyPr}<a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>  </a:t></a:r></a:p></p:txBody></p:sp>`

  test('形状按其中的 DrawingML 绘制：几何、填充与位置取自 XML，字符取自旧格式记录，没有 endParaRPr 的段落结束符取最后一个文字段', async () => {
    const xml = sp(
      `<p:spPr>${box(914400, 0, 914400, 457200)}<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>` +
        '<a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></p:spPr>' +
        '<p:txBody><a:bodyPr/><a:lstStyle/>' +
        '<a:p><a:r><a:rPr lang="zh-CN" sz="2000" b="1"/><a:t>  </a:t></a:r>' +
        '<a:r><a:rPr lang="en-US" sz="2400"/><a:t>   </a:t></a:r></a:p>' +
        '<a:p><a:r><a:rPr lang="en-US" sz="1000"/><a:t>_</a:t></a:r><a:endParaRPr lang="en-US" sz="3000"/></a:p>' +
        '</p:txBody>',
    )
    const p = await open({
      slides: [
        {
          shapes: [
            shape({
              id: 1025,
              type: 202,
              anchor: [0, 0, 576, 288],
              props: [
                [0x0181, 0x0000ff],
                [0x01bf, 0x100010],
                [0x03a9, metroBlob(xml)],
              ],
              textbox: [art(0, 0x0f9f, fields([4, 4])), chars('甲乙C\vD\rE')],
            }),
          ],
        },
      ],
    })
    const s = p.slides[0]!.shapes[0] as AutoShape
    expect(s).toMatchObject({
      kind: 'shape',
      id: 1025,
      name: '文本框 4',
      textBox: true,
      geometry: { kind: 'preset', name: 'ellipse' },
      fill: solid(0x00ff00),
      frame: { x: 914400, y: 0, width: 914400, height: 457200 },
    })
    expect(
      s.text!.paragraphs.map((q) => [
        q.runs.map((r) => [r.kind, r.kind === 'text' ? r.text : '', r.style.size]),
        q.end.size,
      ]),
    ).toEqual([
      [
        [
          ['text', '甲乙', 20],
          ['text', 'C', 24],
          ['break', '', 24],
          ['text', 'D', 24],
        ],
        24,
      ],
      [[['text', 'E', 10]], 30],
    ])
  })

  test('组合与图片带 metroBlob 时是一个形状的替代；XML 中没有 xfrm 的占位符取旧格式锚点并继承母版占位符', async () => {
    const rect = sp(`<p:spPr>${box(0, 0, 100, 100)}</p:spPr>`, '矩形')
    const p = await open({
      master: {
        shapes: [
          shape({
            id: 1,
            anchor: [0, 0, 576, 576],
            client: [placeholder(0)],
            props: [
              [
                0x03a9,
                metroBlob(
                  titleXml(
                    '<p:ph type="title"/>',
                    `<p:spPr>${box(0, 0, 10, 10)}</p:spPr>`,
                    '<a:bodyPr anchor="b"/>',
                  ),
                ),
              ],
            ],
          }),
        ],
      },
      slides: [
        {
          shapes: [
            groupShape(
              {
                id: 1025,
                anchor: [0, 0, 576, 576],
                group: [0, 0, 10, 10],
                props: [[0x03a9, metroBlob(rect)]],
              },
              shape({ id: 1026, child: [0, 0, 5, 5] }),
            ),
            shape({
              id: 1027,
              type: 75,
              anchor: [0, 0, 576, 576],
              props: [
                [0x0104, 1],
                [0x03a9, metroBlob(rect)],
              ],
            }),
            shape({
              id: 1028,
              anchor: [288, 0, 576, 576],
              client: [placeholder(-1)],
              props: [
                [
                  0x03a9,
                  metroBlob(
                    titleXml('<p:ph type="title" idx="4294967295"/>', '<p:spPr/>', '<a:bodyPr/>'),
                  ),
                ],
              ],
              textbox: [art(0, 0x0f9f, fields([4, 0])), chars('标题')],
            }),
          ],
        },
      ],
    })
    const [group, picture, title] = p.slides[0]!.shapes as AutoShape[]
    expect([group!.kind, group!.id, group!.name, group!.frame.width]).toEqual([
      'shape',
      1025,
      '矩形',
      100,
    ])
    expect([picture!.kind, picture!.id]).toEqual(['shape', 1027])
    expect(title).toMatchObject({
      kind: 'shape',
      id: 1028,
      frame: { x: 0, y: 288 * EMU, width: 576 * EMU, height: 288 * EMU },
      placeholder: { type: 'title', masterShape: 2 },
      text: { body: { anchor: 'b' } },
    })
    expect(title!.text!.paragraphs[0]!.runs.map((r) => (r.kind === 'text' ? r.text : ''))).toEqual([
      '标题',
    ])
  })

  test('主题、颜色映射与文字样式取自母版的 RoundTrip 记录；背景形状的 p:background 按主题的背景填充样式求值', async () => {
    const map =
      'bg1="lt1" tx1="dk1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
      'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"'
    const p = await open({
      master: {
        background: shape({
          id: 1024,
          flags: 0xc00,
          props: [
            [
              0x03a9,
              metroBlob(
                '<p:background><p:bgRef idx="1001"><a:schemeClr val="bg2"/></p:bgRef></p:background>',
              ),
            ],
          ],
        }),
        extra: [
          themeAtom(THEME),
          colorMapAtom(map),
          textStylesAtom(
            '<p:titleStyle><a:lvl1pPr><a:defRPr sz="4000"/></a:lvl1pPr></p:titleStyle><p:bodyStyle/><p:otherStyle/>',
          ),
        ],
      },
      slides: [
        {
          shapes: [
            shape({
              id: 1025,
              anchor: [0, 0, 576, 576],
              props: [
                [
                  0x03a9,
                  metroBlob(
                    sp(
                      `<p:spPr>${box(0, 0, 100, 100)}<a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr>` +
                        '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>甲</a:t></a:r></a:p></p:txBody>',
                    ),
                  ),
                ],
              ],
            }),
            shape({
              id: 1026,
              anchor: [0, 0, 576, 576],
              client: [placeholder(-1)],
              props: [
                [
                  0x03a9,
                  metroBlob(
                    titleXml(
                      '<p:ph type="title" idx="4294967295"/>',
                      `<p:spPr>${box(0, 0, 100, 100)}</p:spPr>`,
                      '<a:bodyPr/>',
                    ),
                  ),
                ],
              ],
              textbox: [art(0, 0x0f9f, fields([4, 0])), chars('乙丙')],
            }),
          ],
        },
      ],
    })
    const slide = p.slides[0]!
    expect(slide.background).toEqual(solid(0x44546a))
    const [plain, title] = slide.shapes as AutoShape[]
    expect(plain!.fill).toEqual(solid(0x4472c4))
    expect(plain!.text!.paragraphs[0]!.runs[0]).toMatchObject({ kind: 'text', text: '甲' })
    expect(title!.text!.paragraphs[0]!.runs[0]).toMatchObject({
      kind: 'text',
      text: '乙丙',
      style: { size: 40 },
    })
  })

  test('connectorXml：根元素为 p:sp、内容为连接线的子元素，按连接线绘制', async () => {
    const xml =
      '<p:sp><p:nvCxnSpPr><p:cNvPr id="6" name="直接连接符 5"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>' +
      `<p:spPr>${box(0, 0, 914400, 0)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>` +
      '<a:ln w="28575"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></p:spPr></p:sp>'
    const p = await open({
      slides: [
        {
          shapes: [
            shape({
              id: 1025,
              type: 20,
              flags: 0xb00,
              anchor: [0, 0, 576, 0],
              props: [[0x03a9, metroBlob(xml, {}, 'connectorXml')]],
            }),
          ],
        },
      ],
    })
    const line = p.slides[0]!.shapes[0]!
    expect(line.kind).toBe('connector')
    if (line.kind !== 'connector') return
    expect(line.line).toMatchObject({ width: 28575, fill: solid(0xff0000) })
  })

  test('pictureXml：根元素为 p:pic，按图片绘制，图片部件名带来源前缀', async () => {
    const xml =
      '<p:pic><p:nvPicPr><p:cNvPr id="7" name="图片 6"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
      '<p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
      `<p:spPr>${box(0, 0, 914400, 914400)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
    const p = await open({
      slides: [
        {
          shapes: [
            shape({
              id: 1025,
              type: 75,
              anchor: [0, 0, 576, 576],
              props: [[0x03a9, metroBlob(xml, { 'image1.png': PNG }, 'pictureXml')]],
            }),
          ],
        },
      ],
    })
    const picture = p.slides[0]!.shapes[0]!
    expect(picture.kind).toBe('picture')
    if (picture.kind !== 'picture') return
    expect(picture.image.part).toBe('slide/256/shape/1025/drs/media/image1.png')
  })

  test('metroBlob 中的图片部件名带来源前缀，readImages 按部件名读取；包无法打开时按旧格式记录换算', async () => {
    const part = 'slide/256/shape/1025/drs/media/image1.png'
    const data = buildPpt({
      slides: [
        {
          shapes: [
            shape({
              id: 1025,
              anchor: [0, 0, 576, 576],
              props: [
                [
                  0x03a9,
                  metroBlob(
                    sp(
                      `<p:spPr>${box(0, 0, 100, 100)}<a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:spPr>`,
                    ),
                    { 'image1.png': PNG },
                  ),
                ],
              ],
            }),
            shape({
              id: 1026,
              anchor: [0, 0, 576, 576],
              props: [
                [0x0181, 0x0000ff],
                [0x01bf, 0x100010],
                [0x03a9, Uint8Array.from([1, 2, 3])],
              ],
            }),
          ],
        },
      ],
    })
    const r = await parsePptx(data)
    if (!r.ok) throw new Error(JSON.stringify(r.failure))
    const [picture, plain] = r.value.slides[0]!.shapes as AutoShape[]
    expect(picture!.fill).toMatchObject({ kind: 'picture', image: { part } })
    expect(r.value.slides[0]!.unsupported).toEqual({})
    expect(plain!.fill).toEqual(solid(0xff0000))
    const images = await readImages(data, [part])
    expect(images.get(part)).toEqual({ bytes: PNG, contentType: 'image/png' })
  })
})
