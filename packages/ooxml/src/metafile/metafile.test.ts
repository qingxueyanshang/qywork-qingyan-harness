/**
 * 图元文件的读取与绘制。覆盖本目录的 `wmf.ts`、`emf.ts`、`builder.ts`（记录换算为绘制命令、对象表、字体与字符集、
 * 不支持的记录、图片框的 96 dpi 尺寸）、`dib.ts`（位图解码）与 `play.ts`（坐标映射、取整规则、裁剪、位图与文字的绘制）。
 *
 * 用例中的文件按记录格式逐字节构造；绘制的期望值为按 GDI 的映射规则换算的结果，取整与对齐规则的 WPS 实测见 `play.ts`。
 */

import { describe, expect, test } from 'bun:test'
import type { PaintContext } from '../drawingml/paint/context.ts'
import { placeableWmf, RecordingContext } from '../drawingml/paint/test-helper.ts'
import { metafileFontSubstitute } from '../text/font-substitutes.ts'
import { decodeDib } from './dib.ts'
import { type MetafileFace, type MetafileFonts, playMetafile, readMetafile } from './index.ts'

/** 小端字节序列。 */
class Bytes {
  private readonly parts: number[] = []
  u8(...v: number[]): this {
    for (const x of v) this.parts.push(x & 0xff)
    return this
  }
  u16(...v: number[]): this {
    for (const x of v) this.u8(x, x >> 8)
    return this
  }
  u32(...v: number[]): this {
    for (const x of v) this.u8(x, x >> 8, x >> 16, x >>> 24)
    return this
  }
  f32(...v: number[]): this {
    const b = new DataView(new ArrayBuffer(4))
    for (const x of v) {
      b.setFloat32(0, x, true)
      this.u8(b.getUint8(0), b.getUint8(1), b.getUint8(2), b.getUint8(3))
    }
    return this
  }
  bytes(b: Uint8Array): this {
    for (const x of b) this.parts.push(x)
    return this
  }
  get length(): number {
    return this.parts.length
  }
  build(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.parts)
  }
}

/** 可放置 WMF：`records` 为 [函数号, ...16 位参数]，末尾自动加 EOF。 */
function wmf(records: readonly (readonly number[])[], bbox = [0, 0, 100, 50], objects = 4) {
  const b = new Bytes()
    .u32(0x9ac6cdd7)
    .u16(0, ...bbox, 96)
    .u32(0)
    .u16(0)
  b.u16(1, 9, 0x0300).u32(0).u16(objects).u32(0).u16(0)
  for (const [fn, ...params] of [...records, [0]]) b.u32(3 + params.length).u16(fn!, ...params)
  return b.build()
}

/** 逐字节的参数（按 16 位打包，奇数长度补 0）。 */
function words(bytes: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < bytes.length; i += 2) out.push(bytes[i]! | ((bytes[i + 1] ?? 0) << 8))
  return out
}

/** EMF：参考设备 1000 × 1000 像素、100 × 100 毫米（每毫米 10 像素），`frame` 为 0.01 毫米。 */
function emf(records: readonly (readonly [number, Bytes])[], frame = [0, 0, 1000, 500]) {
  const body = new Bytes()
  for (const [type, data] of [...records, [14, new Bytes().u32(0, 16, 20)] as const]) {
    body.u32(type, data.length + 8).bytes(data.build())
  }
  const head = new Bytes()
    .u32(1, 108)
    .u32(0, 0, 100, 50)
    .u32(...frame)
    .u32(0x464d4520, 0x10000, 108 + body.length, records.length + 2)
    .u16(4, 0)
    .u32(0, 0, 0)
    .u32(1000, 1000, 100, 100)
    .u32(0, 0, 0)
    .u32(100000, 100000)
  return new Bytes().bytes(head.build()).bytes(body.build()).build()
}

/** 1 位 2 × 2 位图：调色板为白、红，像素为对角红色。 */
function dib1(): { bmi: Bytes; bits: Bytes } {
  const bmi = new Bytes()
    .u32(40, 2, 2)
    .u16(1, 1)
    .u32(0, 0, 0, 0, 2, 0)
    .u8(255, 255, 255, 0, 0, 0, 255, 0)
  const bits = new Bytes().u8(0x40, 0, 0, 0, 0x80, 0, 0, 0)
  return { bmi, bits }
}

/**
 * 字形宽度为 ppem 一半的等宽字体；上升为 ppem 的 0.8，下降为 0.2，平均字符宽度为 em 的一半。`symbol` 为真时是符号字体。
 * `has` 为主机有的字体名，缺省为全部都有；`seen` 记录每次按名称取字体的请求，回退字体记为 `fallback`。
 */
function testFonts(
  seen: { name: string; bold: boolean }[] = [],
  symbol = false,
  has: (name: string) => boolean = () => true,
): MetafileFonts {
  const face: MetafileFace = {
    vertical: (ppem) => ({ ascent: Math.round(ppem * 0.8), descent: Math.round(ppem * 0.2) }),
    emPerCell: 1,
    averageWidth: 0.5,
    symbol,
    advance: (_cp, ppem) => ppem / 2,
    draw: (ctx: PaintContext, text, x, baseline, ppem) => {
      ctx.font = `${ppem}px test`
      ctx.fillText(text, x, baseline)
    },
  }
  return {
    face: (name, bold) => {
      seen.push({ name, bold })
      return has(name) ? face : null
    },
    fallback: (bold) => {
      seen.push({ name: 'fallback', bold })
      return face
    },
  }
}

describe('WMF 的读取', () => {
  test('可放置文件头给出图片框；没有可放置文件头时计为不支持', () => {
    const mf = readMetafile(wmf([[0x020c, 50, 100]], [10, 20, 110, 70]))!
    expect(mf.kind).toBe('wmf')
    expect(mf.frame).toEqual({ left: 10, top: 20, right: 110, bottom: 70 })
    expect(mf.unsupported).toEqual([])
    expect(mf.ops).toEqual([{ op: 'windowExt', x: 100, y: 50 }])
    const plain = new Bytes().u16(1, 9, 0x0300).u32(12).u16(0).u32(3).u16(0).u32(3).u16(0).build()
    expect(readMetafile(plain)!.unsupported).toEqual(['header:nonPlaceable'])
    expect(readMetafile(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  test('对象表按编号最小的空位分配；删除后空位再用，选入时按编号取对象', () => {
    const mf = readMetafile(
      wmf([
        [0x02fa, 0, 0, 0, 0xff, 0], // 画笔 → 0 号
        [0x02fc, 0, 0x00ff, 0, 0], // 红色画刷 → 1 号
        [0x01f0, 0], // 删除 0 号
        [0x02fc, 0, 0xff00, 0, 0], // 绿色画刷 → 0 号
        [0x012d, 0],
        [0x012d, 1],
      ]),
    )!
    expect(mf.ops).toEqual([
      { op: 'brush', brush: { kind: 'solid', color: { r: 0, g: 255, b: 0 } } },
      { op: 'brush', brush: { kind: 'solid', color: { r: 255, g: 0, b: 0 } } },
    ])
  })

  test('EXTTEXTOUT 按字体的字符集解码，双字节字符的前进宽度为两字节之和；记录字体名', () => {
    // 宋体，GB2312_CHARSET；「提交」的 GBK 编码与逐字节的前进宽度。
    const face = [0xcb, 0xce, 0xcc, 0xe5, 0]
    const font = [-15, 0, 0, 0, 400, ...words([0, 0, 0, 134, 0, 0, 0, 0, ...face, 0, 0, 0])]
    const text = [0xcc, 0xe1, 0xbd, 0xbb]
    const mf = readMetafile(
      wmf([
        [0x02fb, ...font],
        [0x012d, 0],
        [0x0a32, 8, 4, 4, 0, ...words(text), 15, 0, 15, 0],
      ]),
    )!
    expect(mf.unsupported).toEqual([])
    expect(mf.fonts).toEqual(['宋体'])
    expect(mf.ops.at(-1)).toEqual({
      op: 'text',
      p: { x: 4, y: 8 },
      text: '提交',
      dx: [15, 15],
      symbol: null,
      opaque: null,
      clip: null,
    })
  })

  test('未选入字体时绘制文字与未实现的记录计为不支持', () => {
    const noFont = readMetafile(wmf([[0x0a32, 0, 0, 1, 0, 0x41]]))!
    expect(noFont.unsupported).toEqual(['text:stockFont'])
    expect(readMetafile(wmf([[0x0817, 0, 0, 0, 0, 0, 0, 0, 0]]))!.unsupported).toEqual(['ARC'])
  })

  test('SYMBOL_CHARSET 按符号编码；DEFAULT_CHARSET 按系统代码页并另给出符号编码；字体名按系统代码页', () => {
    // WPS 实测（构造文件）：Symbol 的 SYMBOL_CHARSET 字节 61 62 显示为 αβ；Times New Roman 的 DEFAULT_CHARSET 字节
    // E9 96 41 显示为「闁A」；字符集为 DEFAULT_CHARSET、字体名为「宋体」的 GBK 字节时按宋体绘制。
    const font = (charset: number, face: readonly number[]) => [
      -20 & 0xffff,
      0,
      0,
      0,
      400,
      ...words([0, 0, 0, charset, 0, 0, 0, 0, ...face, 0]),
    ]
    const mf = readMetafile(
      wmf([
        [0x02fb, ...font(2, [0x53, 0x79, 0x6d])],
        [0x012d, 0],
        [0x0a32, 0, 0, 2, 0, ...words([0x61, 0x62]), 5, 6],
        [0x02fb, ...font(1, [0x54, 0x4e, 0x52])],
        [0x012d, 1],
        [0x0a32, 0, 0, 3, 0, ...words([0xe9, 0x96, 0x41]), 7, 8, 9],
        [0x02fb, ...font(1, [0xcb, 0xce, 0xcc, 0xe5])],
        [0x012d, 2],
        [0x0a32, 0, 0, 1, 0, 0x41],
      ]),
    )!
    expect(mf.unsupported).toEqual([])
    expect(mf.fonts).toEqual(['Sym', 'Wingdings', 'TNR', '宋体'])
    const texts = mf.ops.flatMap((o) => (o.op === 'text' ? [[o.text, o.dx, o.symbol]] : []))
    expect(texts).toEqual([
      ['\uf061\uf062', [5, 6], null],
      ['闁A', [15, 9], { text: '\uf0e9\uf096\uf041', dx: [7, 8, 9] }],
      ['A', null, { text: '', dx: null }],
    ])
  })

  test('没有可放置文件头时以记录设置的窗口为图片框；SETMAPPERFLAGS 不影响绘制', () => {
    // WPS 演示实测（构造文件）：窗口原点 (0, 40)、范围 (80, -40) 时内容映射到图片矩形，文字正立，基线在 30 像素处。
    const records: number[][] = [
      [0x0103, 8],
      [0x020b, 40, 0],
      [0x020c, -40 & 0xffff, 80],
      [0x0231, 1, 0],
      [0x02fb, -20 & 0xffff, 0, 0, 0, 400, ...words([0, 0, 0, 0, 0, 0, 0, 0, 0x41, 0])],
      [0x012d, 0],
      [0x0102, 1],
      [0x012e, 24],
      [0x0a32, 10, 4, 1, 0, 0x41],
    ]
    const b = new Bytes().u16(1, 9, 0x0300).u32(0).u16(4).u32(0).u16(0)
    for (const [fn, ...params] of [...records, [0]]) b.u32(3 + params.length).u16(fn!, ...params)
    const mf = readMetafile(b.build())!
    expect(mf.unsupported).toEqual([])
    expect(mf.frame).toEqual({ left: 0, top: 40, right: 80, bottom: 0 })
    const ctx = new RecordingContext()
    playMetafile(ctx, mf, [], { x: 0, y: 0, width: 80, height: 40 }, testFonts())
    expect(ctx.named('fillText').map((c) => c.args)).toEqual([['A', 4, 30]])
  })

  test('没有字符的 EXTTEXTOUT 只填充不透明矩形，不需要字体', () => {
    const mf = readMetafile(wmf([[0x0a32, 0, 0, 0, 2, 3, 3, 141, 33]]))!
    expect(mf.unsupported).toEqual([])
    expect(mf.ops).toEqual([
      {
        op: 'text',
        p: { x: 0, y: 0 },
        text: '',
        dx: null,
        symbol: null,
        opaque: { left: 3, top: 3, right: 141, bottom: 33 },
        clip: null,
      },
    ])
  })

  test('STRETCHDIB 的源矩形按自下而上的行序换算；没有位图的 DIBBITBLT 按光栅操作填充', () => {
    const { bmi, bits } = dib1()
    const dib = words([...bmi.build(), ...bits.build()])
    const mf = readMetafile(
      wmf([
        // SRCCOPY，DIB_RGB_COLORS；源 (0, 1, 2, 1)；目标 (10, 20, 40, 30)。
        [0x0f43, 0x0020, 0x00cc, 0, 1, 2, 1, 0, 30, 40, 20, 10, ...dib],
        // PATCOPY，保留字，源 (0, 0)，宽高 5 × 6，目标 (7, 8)。
        [0x0940, 0x0021, 0x00f0, 0, 0, 0, 6, 5, 8, 7],
      ]),
    )!
    expect(mf.unsupported).toEqual([])
    expect(mf.ops).toEqual([
      {
        op: 'bitmap',
        dest: { left: 10, top: 20, right: 50, bottom: 50 },
        src: { x: 0, y: 0, width: 2, height: 1 },
        bitmap: 0,
        alpha: 1,
        rop: 'copy',
      },
      { op: 'patBlt', box: { left: 7, top: 8, right: 12, bottom: 14 }, fill: 'brush' },
    ])
  })
})

describe('WMF 的区域、调色板与画笔', () => {
  test('CREATEREGION 的扫描线矩形由 PAINTREGION 以当前画刷、FILLREGION 以指定画刷填充', () => {
    // 区域：2 条扫描线，(10, 5)–(20, 7) 与 (10, 7)–(14, 9)、(16, 7)–(20, 9)。
    const region = [
      0, 6, 0, 0, 0, 2, 4, 10, 5, 20, 9, 2, 5, 7, 10, 20, 2, 4, 7, 9, 10, 14, 16, 20, 4,
    ]
    const mf = readMetafile(
      wmf([
        [0x06ff, ...region],
        [0x02fc, 0, 0x00ff, 0, 0],
        [0x012d, 1],
        [0x012b, 0],
        [0x02fc, 0, 0xff00, 0, 0],
        [0x0228, 0, 2],
      ]),
    )!
    expect(mf.unsupported).toEqual([])
    const rects = [
      { left: 10, top: 5, right: 20, bottom: 7 },
      { left: 10, top: 7, right: 14, bottom: 9 },
      { left: 16, top: 7, right: 20, bottom: 9 },
    ]
    expect(mf.ops.filter((o) => o.op === 'fillRegion')).toEqual([
      { op: 'fillRegion', rects, brush: null },
      { op: 'fillRegion', rects, brush: { kind: 'solid', color: { r: 0, g: 255, b: 0 } } },
    ])
    const ctx = new RecordingContext()
    playMetafile(ctx, mf, [], { x: 0, y: 0, width: 200, height: 100 }, testFonts())
    expect(ctx.named('rect').map((c) => c.args)).toEqual([
      [20, 10, 20, 4],
      [20, 14, 8, 4],
      [32, 14, 8, 4],
      [20, 10, 20, 4],
      [20, 14, 8, 4],
      [32, 14, 8, 4],
    ])
    expect(ctx.named('fill').map((c) => c.fillStyle)).toEqual(['rgb(255,0,0)', 'rgb(0,255,0)'])
  })

  test('调色板的创建与选入不改变绘制，占用对象表的位置；引用调色板序号的颜色计为不支持', () => {
    const mf = readMetafile(
      wmf([
        [0x00f7, 0x0300, 1, 0x00ff, 0],
        [0x0234, 0],
        [0x0035],
        [0x02fc, 0, 0x00ff, 0, 0],
        [0x012d, 1],
      ]),
    )!
    expect(mf.unsupported).toEqual([])
    expect(mf.ops).toEqual([
      { op: 'brush', brush: { kind: 'solid', color: { r: 255, g: 0, b: 0 } } },
    ])
    expect(readMetafile(wmf([[0x0209, 3, 0x0100]]))!.unsupported).toEqual(['color:paletteIndex'])
  })

  test('DIBBITBLT 的 SRCAND 以 multiply、SRCPAINT 以 lighter 合成，其余光栅操作计为不支持', () => {
    // 透明位图的写法：先以黑白掩码按位与，再以黑底图像按位或。
    const { bmi, bits } = dib1()
    const dib = words([...bmi.build(), ...bits.build()])
    const blt = (lo: number, hi: number) => [0x0940, lo, hi, 0, 0, 2, 2, 10, 10, ...dib]
    const mf = readMetafile(wmf([blt(0x00c6, 0x0088), blt(0x0086, 0x00ee)]))!
    expect(mf.unsupported).toEqual([])
    expect(mf.ops.map((o) => (o.op === 'bitmap' ? o.rop : o.op))).toEqual(['and', 'paint'])
    const ctx = new RecordingContext()
    playMetafile(
      ctx,
      mf,
      [
        { width: 2, height: 2 },
        { width: 2, height: 2 },
      ],
      {
        x: 0,
        y: 0,
        width: 100,
        height: 50,
      },
      testFonts(),
    )
    expect(ctx.named('drawImage').map((c) => c.composite)).toEqual(['multiply', 'lighter'])
    expect(readMetafile(wmf([blt(0x0046, 0x0066)]))!.unsupported).toEqual(['bitmap:rop660046'])
  })

  test('SCALEVIEWPORTEXT 与 SCALEWINDOWEXT 按分子与分母缩放视口与窗口的范围', () => {
    const draw = (scale: number[]) => {
      const mf = readMetafile(wmf([scale, [0x041b, 40, 90, 10, 10]]))!
      expect(mf.unsupported).toEqual([])
      const ctx = new RecordingContext()
      playMetafile(ctx, mf, [], { x: 0, y: 0, width: 100, height: 50 }, testFonts())
      return ctx.named('moveTo')[0]!.args
    }
    // 视口的范围乘以 1/2、窗口的范围乘以 2：矩形 (10, 10)–(90, 40) 映射为 (5, 5)–(45, 20)。
    expect(draw([0x0412, 2, 1, 2, 1])).toEqual([5, 5])
    expect(draw([0x0410, 1, 2, 1, 2])).toEqual([5, 5])
  })

  test('PS_INSIDEFRAME：线宽大于 1 像素时矩形缩进到外接矩形之内，线宽 1 像素时与实线相同；DSTCOPY 不绘制', () => {
    const draw = (width: number) => {
      const mf = readMetafile(
        wmf([
          [0x02fa, 6, width, 0, 0, 0],
          [0x012d, 0],
          [0x041b, 40, 90, 10, 10],
          [0x0940, 0x0029, 0x00aa, 0, 0, 0, 6, 5, 8, 7],
        ]),
      )!
      expect(mf.unsupported).toEqual([])
      const ctx = new RecordingContext()
      playMetafile(ctx, mf, [], { x: 0, y: 0, width: 100, height: 50 }, testFonts())
      return ctx
    }
    // 线宽 5：外接矩形 (10, 10)–(90, 40) 各边缩进 2，描边的中心线为 (12.5, 12.5)–(87.5, 37.5)。
    expect(draw(5).named('moveTo').at(-1)!.args).toEqual([12.5, 12.5])
    expect(draw(1).named('moveTo').at(-1)!.args).toEqual([10.5, 10.5])
    expect(draw(1).named('fillRect')).toEqual([])
  })
})

describe('EMF 的读取', () => {
  test('图片框按参考设备的像素与毫米数换算为像素；库存对象按系统定义取值', () => {
    const mf = readMetafile(
      emf([
        [37, new Bytes().u32(0x80000004)],
        [37, new Bytes().u32(0x80000008)],
        [43, new Bytes().u32(1, 2, 30, 40)],
      ]),
    )!
    expect(mf.frame).toEqual({ left: 0, top: 0, right: 100, bottom: 50 })
    expect(mf.device).toEqual({ x: 10, y: 10 })
    expect(mf.ops).toEqual([
      { op: 'brush', brush: { kind: 'solid', color: { r: 0, g: 0, b: 0 } } },
      {
        op: 'pen',
        pen: {
          style: 'null',
          width: 0,
          cosmetic: true,
          color: { r: 0, g: 0, b: 0 },
          cap: 'round',
          join: 'round',
        },
      },
      { op: 'rectangle', box: { left: 1, top: 2, right: 30, bottom: 40 }, shrink: false },
    ])
  })

  test('EXTTEXTOUTW 读取 UTF-16 文字与前进宽度；库存字体与旋转的世界变换下的文字计为不支持', () => {
    const font = new Bytes().u32(1, -20 >>> 0, 0, 0, 0, 700).u8(0, 0, 0, 1, 0, 0, 0, 0)
    for (const c of 'Arial') font.u16(c.charCodeAt(0))
    font.u16(...new Array(32 - 5).fill(0))
    const text = (opts: number) =>
      new Bytes()
        .u32(0, 0, 0, 0, 1)
        .f32(1, 1)
        .u32(5, 6, 2, 76, opts, 0, 0, 0, 0, 80)
        .u16(0x41, 0x4e2d)
        .u32(7, 9)
    const ok = readMetafile(
      emf([
        [82, font],
        [37, new Bytes().u32(1)],
        [84, text(0)],
      ]),
    )!
    expect(ok.unsupported).toEqual([])
    expect(ok.fonts).toEqual(['Arial', '宋体'])
    expect(ok.ops).toEqual([
      {
        op: 'font',
        font: {
          height: -20,
          width: 0,
          weight: 700,
          italic: false,
          face: 'Arial',
          charset: 1,
          pitchAndFamily: 0,
        },
      },
      {
        op: 'text',
        p: { x: 5, y: 6 },
        text: 'A中',
        dx: [7, 9],
        symbol: null,
        opaque: null,
        clip: null,
      },
    ])
    const stock = readMetafile(
      emf([
        [37, new Bytes().u32(0x8000000d)],
        [84, text(0)],
      ]),
    )!
    expect(stock.unsupported).toEqual(['text:stockFont'])
    const rotated = readMetafile(
      emf([
        [82, font],
        [37, new Bytes().u32(1)],
        [35, new Bytes().f32(0, 1, -1, 0, 0, 0)],
        [84, text(0)],
      ]),
    )!
    expect(rotated.unsupported).toEqual(['text:rotated'])
    expect(
      readMetafile(
        emf([
          [82, font],
          [37, new Bytes().u32(1)],
          [84, text(0x10)],
        ]),
      )!.unsupported,
    ).toEqual(['EXTTEXTOUT:options10'])
  })

  test('ALPHABLEND 的位图按预乘的不透明度解码；常量不透明度记入命令', () => {
    const bmi = new Bytes().u32(40, 1, 1).u16(1, 32).u32(0, 0, 0, 0, 0, 0)
    const rec = new Bytes()
      .u32(0, 0, 0, 0)
      .u32(10, 20, 30, 40)
      .u32(0x01800000)
      .u32(0, 0)
      .f32(1, 0, 0, 1, 0, 0)
      .u32(0, 0, 108, 40, 148, 4, 1, 1)
      .bytes(bmi.build())
      .u8(0, 0, 64, 128)
    const mf = readMetafile(emf([[114, rec]]))!
    expect(mf.unsupported).toEqual([])
    expect(mf.ops).toEqual([
      {
        op: 'bitmap',
        dest: { left: 10, top: 20, right: 40, bottom: 60 },
        src: { x: 0, y: 0, width: 1, height: 1 },
        bitmap: 0,
        alpha: 128 / 255,
        rop: 'copy',
      },
    ])
    expect([...mf.bitmaps[0]!.data]).toEqual([128, 0, 0, 128])
  })

  test('EMF+ 只有注释记录时计为不支持，双格式按 EMF 记录绘制；目标不变的光栅操作不绘制', () => {
    const plus = (flags: number) =>
      new Bytes().u32(28, 0x2b464d45).u16(0x4001, flags).u32(28, 16).u32(0xdbc01002, 1, 96, 96)
    expect(readMetafile(emf([[70, plus(0)]]))!.unsupported).toEqual(['EMF+'])
    expect(readMetafile(emf([[70, plus(1)]]))!.unsupported).toEqual([])
    const nop = new Bytes().u32(0, 0, 0, 0, 0, 0, 5, 5, 0x00aa0029).u32(...new Array(15).fill(0))
    const mf = readMetafile(emf([[76, nop]]))!
    expect(mf.unsupported).toEqual([])
    expect(mf.ops).toEqual([])
  })
})

describe('图片框的 96 dpi 尺寸', () => {
  test('WMF 按可放置文件头的每英寸单位数换算，EMF 按 rclFrame（0.01 毫米）换算', () => {
    expect(readMetafile(placeableWmf([], 96))!.size).toEqual({ width: 100, height: 50 })
    expect(readMetafile(placeableWmf([], 192))!.size).toEqual({ width: 50, height: 25 })
    const e = readMetafile(emf([], [0, 0, 2540, 1270]))!.size
    expect([e.width, e.height]).toEqual([96, 48])
  })
})

describe('位图解码', () => {
  test('1 位调色板与 24 位自下而上的行序转为自上而下的 RGBA', () => {
    const { bmi, bits } = dib1()
    expect([...decodeDib(bmi.build(), bits.build(), false)!.data]).toEqual([
      255, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255,
    ])
    const h24 = new Bytes().u32(40, 1, 2).u16(1, 24).u32(0, 0, 0, 0, 0, 0).build()
    // 第一行（文件中在前）为底行：蓝；第二行为顶行：绿。
    const b24 = new Bytes().u8(255, 0, 0, 0, 0, 255, 0, 0).build()
    expect([...decodeDib(h24, b24, false)!.data]).toEqual([0, 255, 0, 255, 0, 0, 255, 255])
  })

  test('16 位 BI_BITFIELDS 按掩码取值；不支持的压缩方式返回 null', () => {
    const h = new Bytes()
      .u32(40, 1, 1)
      .u16(1, 16)
      .u32(3, 0, 0, 0, 0, 0)
      .u32(0xf800, 0x07e0, 0x001f)
      .build()
    expect([...decodeDib(h, new Bytes().u16(0xf800).u16(0).build(), false)!.data]).toEqual([
      255, 0, 0, 255,
    ])
    const rle = new Bytes().u32(40, 1, 1).u16(1, 8).u32(1, 0, 0, 0, 0, 0).build()
    expect(decodeDib(rle, new Uint8Array(4), false)).toBeNull()
  })
})

describe('绘制', () => {
  test('WMF 的窗口映射到目标矩形；矩形的边界取整到像素，空画笔时填充区域右边与底边各少 1 像素', () => {
    const mf = readMetafile(
      wmf([
        [0x020c, 50, 100],
        [0x02fc, 0, 0x00ff, 0, 0],
        [0x012d, 0],
        [0x02fa, 5, 0, 0, 0, 0],
        [0x012d, 1],
        [0x041b, 30, 50, 10, 10],
      ]),
    )!
    const ctx = new RecordingContext()
    playMetafile(ctx, mf, [], { x: 100, y: 200, width: 200, height: 100 }, testFonts())
    const fill = ctx.named('fill')
    expect(fill).toHaveLength(1)
    expect(fill[0]!.fillStyle).toBe('rgb(255,0,0)')
    // (10, 10)–(50, 30) 映射为 (120, 220)–(200, 260)，空画笔时为 (120, 220)–(199, 259)。
    expect(ctx.named('moveTo')[0]!.args).toEqual([120, 220])
    expect(ctx.named('lineTo').map((c) => c.args)).toEqual([
      [199, 220],
      [199, 259],
      [120, 259],
    ])
    expect(ctx.named('stroke')).toHaveLength(0)
  })

  test('EMF 的图片框映射到目标矩形；1 像素画笔的描边落在像素中心，矩形不含右边与底边', () => {
    const mf = readMetafile(emf([[43, new Bytes().u32(10, 10, 30, 20)]]))!
    const ctx = new RecordingContext()
    playMetafile(ctx, mf, [], { x: 0, y: 0, width: 200, height: 100 }, testFonts())
    // 图片框 100 × 50 像素映射到 200 × 100：缺省画刷为白色，缺省画笔为 1 像素黑色。
    expect(ctx.named('fill')[0]!.fillStyle).toBe('rgb(255,255,255)')
    const stroke = ctx.named('stroke')[0]!
    expect(stroke.strokeStyle).toBe('rgb(0,0,0)')
    expect(stroke.lineWidth).toBe(1)
    expect(ctx.named('moveTo').map((c) => c.args)).toEqual([
      [20, 20],
      [20.5, 20.5],
    ])
    expect(
      ctx
        .named('lineTo')
        .slice(3)
        .map((c) => c.args),
    ).toEqual([
      [59.5, 20.5],
      [59.5, 39.5],
      [20.5, 39.5],
    ])
  })

  test('位图按变换绘制到目标矩形，平滑缩放；裁剪矩形在绘制前设置', () => {
    const { bmi, bits } = dib1()
    const dib = words([...bmi.build(), ...bits.build()])
    const mf = readMetafile(
      wmf([
        [0x0416, 40, 80, 0, 0],
        [0x0f43, 0x0020, 0x00cc, 0, 2, 2, 0, 0, 20, 40, 10, 10, ...dib],
      ]),
    )!
    const image = { width: 2, height: 2 }
    const ctx = new RecordingContext()
    playMetafile(ctx, mf, [image], { x: 0, y: 0, width: 200, height: 100 }, testFonts())
    expect(ctx.named('rect')[0]!.args).toEqual([0, 0, 160, 80])
    expect(ctx.named('clip')).toHaveLength(1)
    const draw = ctx.named('drawImage')[0]!
    expect(draw.args).toEqual([image, 0, 0, 2, 2, 0, 0, 40, 20])
    expect(draw.matrix).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 20, f: 20 })
  })

  test('文字：字号为 lfHeight 换算后取整的 ppem，居中对齐按前进宽度之和，顶端对齐按上升', () => {
    const font = [-10, 0, 0, 0, 700, ...words([0, 0, 0, 0, 0, 0, 0, 0, 0x41, 0])]
    const mf = readMetafile(
      wmf([
        [0x02fb, ...font],
        [0x012d, 0],
        [0x0102, 1],
        [0x012e, 6],
        [0x0a32, 10, 50, 2, 0, 0x4241, 8, 12],
      ]),
    )!
    const seen: { name: string; bold: boolean }[] = []
    const ctx = new RecordingContext()
    playMetafile(ctx, mf, [], { x: 0, y: 0, width: 200, height: 100 }, testFonts(seen))
    expect(seen).toEqual([{ name: 'A', bold: true }])
    // ppem = 10 × 2 = 20；上升 16；参考点 (100, 20)，宽度 (8 + 12) × 2 = 40，居中时自 80 起。
    expect(ctx.named('fillText').map((c) => [c.args, c.font])).toEqual([
      [['A', 80, 36], '20px test'],
      [['B', 96, 36], '20px test'],
    ])
    expect(ctx.named('fillRect')).toHaveLength(0)
  })

  test('背景模式为不透明时以背景色填充字符单元；保存与恢复设备上下文的状态', () => {
    const font = [-10, 0, 0, 0, 400, ...words([0, 0, 0, 0, 0, 0, 0, 0, 0x41, 0])]
    const mf = readMetafile(
      wmf([
        [0x02fb, ...font],
        [0x012d, 0],
        [0x001e],
        [0x0201, 0x00ff, 0],
        [0x0127, -1 & 0xffff],
        [0x0a32, 0, 0, 1, 0, 0x41, 10],
      ]),
    )!
    const ctx = new RecordingContext()
    playMetafile(ctx, mf, [], { x: 0, y: 0, width: 100, height: 50 }, testFonts())
    const cell = ctx.named('fillRect')[0]!
    expect(cell.fillStyle).toBe('rgb(255,255,255)')
    expect(cell.args).toEqual([0, 0, 10, 10])
  })

  test('TA_UPDATECP：参考点为当前位置，左对齐时移到文字右端、右对齐时移到左端，居中时不移动', () => {
    // WPS 实测（构造文件，字号 20 像素）：左对齐时「ab」「cd」「ef」（前进宽度 12、12）「g」依次相接，其后的 LINETO
    // 自文字右端起；右对齐时各段依次向左排列；居中时两段文字重叠。
    const font = [-20 & 0xffff, 0, 0, 0, 400, ...words([0, 0, 0, 0, 0, 0, 0, 0, 0x41, 0])]
    const run = (align: number, x: number, tail: number[][]) => {
      const mf = readMetafile(
        wmf(
          [
            [0x02fb, ...font],
            [0x012d, 0],
            [0x0102, 1],
            [0x012e, align],
            [0x0214, 30, x],
            [0x0a32, 0, 0, 2, 0, 0x6261],
            [0x0a32, 0, 0, 2, 0, 0x6463],
            ...tail,
          ],
          [0, 0, 120, 40],
        ),
      )!
      expect(mf.unsupported).toEqual([])
      const ctx = new RecordingContext()
      playMetafile(ctx, mf, [], { x: 0, y: 0, width: 120, height: 40 }, testFonts())
      return ctx
    }
    const left = run(25, 4, [
      [0x0a32, 0, 0, 2, 0, 0x6665, 12, 12],
      [0x0a32, 0, 0, 1, 0, 0x67],
      [0x0213, 30, 110],
    ])
    expect(left.named('fillText').map((c) => [c.args[0], c.args[1]])).toEqual([
      ['a', 4],
      ['b', 14],
      ['c', 24],
      ['d', 34],
      ['e', 44],
      ['f', 56],
      ['g', 68],
    ])
    expect(left.named('moveTo').at(-1)!.args).toEqual([78.5, 30.5])
    const right = run(27, 116, [[0x0a32, 0, 0, 2, 0, 0x6665, 12, 12]])
    expect(right.named('fillText').map((c) => [c.args[0], c.args[1]])).toEqual([
      ['a', 96],
      ['b', 106],
      ['c', 76],
      ['d', 86],
      ['e', 52],
      ['f', 64],
    ])
    const center = run(31, 60, [])
    expect(center.named('fillText').map((c) => [c.args[0], c.args[1]])).toEqual([
      ['a', 50],
      ['b', 60],
      ['c', 50],
      ['d', 60],
    ])
  })

  test('DEFAULT_CHARSET 的文字在所选字体为符号字体时按符号编码绘制', () => {
    // WPS 实测（构造文件）：Symbol 的 DEFAULT_CHARSET 字节 61 62 E5 显示为 αβ∑。
    const font = [-20 & 0xffff, 0, 0, 0, 400, ...words([0, 0, 0, 1, 0, 0, 0, 0, 0x41, 0])]
    const mf = readMetafile(
      wmf([
        [0x02fb, ...font],
        [0x012d, 0],
        [0x0102, 1],
        [0x0a32, 30, 4, 3, 0, ...words([0x61, 0x62, 0xe5])],
      ]),
    )!
    const draw = (symbol: boolean) => {
      const ctx = new RecordingContext()
      playMetafile(ctx, mf, [], { x: 0, y: 0, width: 100, height: 50 }, testFonts([], symbol))
      return ctx.named('fillText').map((c) => c.args[0])
    }
    expect(draw(true)).toEqual(['\uf061', '\uf062', '\uf0e5'])
    expect(draw(false)).toEqual(['a', 'b', '\ufffd'])
  })

  test('lfWidth 不为 0 时字形与按字体度量的前进宽度按 lfWidth 与平均字符宽度之比横向缩放', () => {
    // WPS 实测（构造文件）：Times New Roman 20 像素「Rqx」，lfWidth 6 时宽 22 像素、14 时宽 56 像素（原宽 31 像素，
    // 按比例 0.75、1.75 为 23、54 像素）。
    const font = [-20 & 0xffff, 6, 0, 0, 400, ...words([0, 0, 0, 0, 0, 0, 0, 0, 0x41, 0])]
    const mf = readMetafile(
      wmf([
        [0x02fb, ...font],
        [0x012d, 0],
        [0x0102, 1],
        [0x0a32, 30, 4, 2, 0, 0x6261],
      ]),
    )!
    expect(mf.unsupported).toEqual([])
    const ctx = new RecordingContext()
    playMetafile(ctx, mf, [], { x: 0, y: 0, width: 100, height: 50 }, testFonts())
    // 平均字符宽度 10 像素，缩放 0.6；字的前进宽度 10 × 0.6 = 6；顶端对齐，基线在 30 + 上升 16 处。
    const texts = ctx.named('fillText')
    expect(texts.map((c) => c.args)).toEqual([
      ['a', 0, 0],
      ['b', 0, 0],
    ])
    expect(texts.map((c) => [c.matrix.a, c.matrix.e, c.matrix.f])).toEqual([
      [0.6, 4, 46],
      [0.6, 10, 46],
    ])
  })

  test('SETMETARGN：当前裁剪并入元区域，此后取消裁剪不取消元区域', () => {
    const mf = readMetafile(
      emf([
        [30, new Bytes().u32(10, 10, 60, 30)],
        [28, new Bytes()],
        [75, new Bytes().u32(0, 5)],
        [43, new Bytes().u32(0, 0, 1000, 500)],
      ]),
    )!
    expect(mf.unsupported).toEqual([])
    const ctx = new RecordingContext()
    playMetafile(ctx, mf, [], { x: 0, y: 0, width: 100, height: 50 }, testFonts())
    // 图片框为参考设备的 100 × 50 像素，映射到 100 × 50 的目标：裁剪矩形 (10, 10)–(60, 30) 保持不变。
    expect(ctx.named('rect')[0]!.args).toEqual([10, 10, 50, 20])
    expect(ctx.named('clip')).toHaveLength(1)
  })

  test('含不支持内容的图元文件不绘制', () => {
    const mf = readMetafile(
      wmf([
        [0x041b, 30, 50, 10, 10],
        [0x0817, 0, 0, 0, 0, 0, 0, 0, 0],
      ]),
    )!
    const ctx = new RecordingContext()
    playMetafile(ctx, mf, [], { x: 0, y: 0, width: 100, height: 50 }, testFonts())
    expect(ctx.calls).toEqual([])
  })
})

describe('主机没有的字体名', () => {
  test('按 Windows 字体替换表，再按字符集与字体族替代（WPS 文字与 WPS 演示实测）', () => {
    const cases: [string, number, number, string | null][] = [
      ['NoSuchFontQY', 0, 0x00, 'Arial'],
      ['Bookman Old Style', 0, 0x10, 'Times New Roman'],
      ['NoSuchFontQY', 0, 0x12, 'Times New Roman'],
      ['NoSuchFontQY', 0, 0x30, 'Courier New'],
      ['NoSuchFontQY', 0, 0x32, 'Arial'],
      ['NoSuchFontQY', 0, 0x01, 'Courier New'],
      ['NoSuchFontQY', 0, 0x40, 'Arial'],
      ['NoSuchFontQY', 1, 0x00, '宋体'],
      ['Euclid', 1, 0x10, 'Times New Roman'],
      ['NoSuchFontQY', 1, 0x01, '新宋体'],
      ['NoSuchFontQY', 2, 0x00, 'Wingdings'],
      ['NoSuchFontQY', 2, 0x10, 'Symbol'],
      ['NoSuchFontQY', 2, 0x01, 'Symbol'],
      ['NoSuchFontQY', 2, 0x30, 'Wingdings'],
      ['仿宋_GB2312', 134, 0x31, '新宋体'],
      ['宋体-方正超大字符集', 134, 0x40, '宋体'],
      ['NoSuchFontQY', 134, 0x10, 'MingLiU-ExtB'],
      ['NoSuchFontQY', 128, 0x00, 'MS PGothic'],
      ['NoSuchFontQY', 128, 0x30, 'MS Gothic'],
      ['NoSuchFontQY', 129, 0x20, 'Gadugi'],
      ['NoSuchFontQY', 136, 0x00, 'Ebrima'],
      ['NoSuchFontQY', 204, 0x01, 'Consolas'],
      ['NoSuchFontQY', 238, 0x30, 'Courier New'],
      ['NoSuchFontQY', 161, 0x40, 'Segoe Script'],
      ['NoSuchFontQY', 255, 0x50, 'Gabriola'],
      ['times', 0, 0x20, 'Times New Roman'],
      ['HELVETICA', 0, 0x10, 'Arial'],
      ['MS Shell Dlg', 0, 0x10, 'Microsoft Sans Serif'],
      ['FangSong_GB2312', 134, 0x00, '仿宋'],
      ['Helv', 0, 0x10, 'Times New Roman'],
      ['NoSuchFontQY', 222, 0x00, null],
    ]
    for (const [face, charset, pitchAndFamily, expected] of cases)
      expect([
        face,
        charset,
        pitchAndFamily,
        metafileFontSubstitute({ face, charset, pitchAndFamily }),
      ]).toEqual([face, charset, pitchAndFamily, expected])
  })

  test('绘制时依次取字体名、替代字体与回退字体；字体名列表含替代字体', () => {
    const font = (charset: number, pitch: number, face: string) => [
      -20 & 0xffff,
      0,
      0,
      0,
      400,
      ...words([0, 0, 0, charset, 0, 0, 0, pitch, ...[...face].map((c) => c.charCodeAt(0)), 0]),
    ]
    const mf = readMetafile(
      wmf([
        [0x02fb, ...font(0, 0x10, 'Bookman Old Style')],
        [0x012d, 0],
        [0x0a32, 30, 4, 1, 0, 0x41],
        [0x02fb, ...font(2, 0, 'NoSym')],
        [0x012d, 1],
        [0x0a32, 30, 4, 1, 0, 0x61],
        [0x02fb, ...font(222, 0, 'NoThai')],
        [0x012d, 2],
        [0x0a32, 30, 4, 1, 0, 0x41],
      ]),
    )!
    expect(mf.unsupported).toEqual([])
    expect(mf.fonts).toEqual([
      'Bookman Old Style',
      'Times New Roman',
      'NoSym',
      'Wingdings',
      'NoThai',
    ])
    const seen: { name: string; bold: boolean }[] = []
    const has = (name: string) => name === 'Times New Roman'
    playMetafile(
      new RecordingContext(),
      mf,
      [],
      { x: 0, y: 0, width: 100, height: 50 },
      testFonts(seen, false, has),
    )
    expect(seen.map((s) => s.name)).toEqual([
      'Bookman Old Style',
      'Times New Roman',
      'NoSym',
      'Wingdings',
      'fallback',
      'NoThai',
      'fallback',
    ])
  })
})
