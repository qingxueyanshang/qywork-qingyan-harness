/**
 * TrueType 指令解释器：执行 `fpgm`、`prep` 与字形指令，按单色（不平滑）或 ClearType 绘制的条件网格对齐字形点。
 *
 * - 每个 ppem 一个 `SizeHinter`：缩放 cvt，执行 `fpgm` 与 `prep`，保存其后的图形状态、cvt、存储区与 twilight 区。
 *   每个字形从这份保存的状态开始，字形指令对 cvt、存储区与 twilight 区的修改不带到下一个字形，结果与绘制顺序无关。
 * - `prep` 不能改变的状态：执行后投影、自由、对偶向量恢复为 x 轴，rp0–rp2 为 0，三个区指针为字形区，loop 为 1。
 *   每段字形指令开始时另把区指针、三个向量、取整方式（RTG）与 loop 恢复为初值。
 * - 越界的点号、cvt 与存储区序号不报错，按各指令的约定跳过或取 0；栈下溢、除以零、未定义的指令等结构错误抛出 `HintError`，
 *   字形指令出错时保留出错前的点位（`SizeHinter.hint` 的约定）。
 * - GETINFO 的回答与 Windows GDI 实测一致（见 `getInfo`）。
 * - ClearType 绘制（`SizeHinter.clearType`）下执行字形指令（含其调用的函数）时，投影向量的 x 分量不为 0 则：取整状态 RTG、
 *   RTHG、RTDG、RDTG、RUTG 的网格为 1/16 像素（SROUND、S45ROUND 不变）；最小距离取一半；cvt cut-in 取 1/16，且 MIRP
 *   不论是否取整都做 cut-in 判定；自由向量的 x 分量不为 0 时 DELTAP 不移动点。`prep` 与 y 方向与单色绘制相同。
 *   GDI 实测（构造字体逐条指令读取结果，Arial 的 `prep` 写入的 cvt 两种绘制相同）。
 * - ClearType 绘制下字形指令执行过 IUP[x] 与 IUP[y] 之后，字形区的点不再移动（移动类指令只标记触及），FLIPPT、FLIPRGON、
 *   FLIPRGOFF 不再改变点的类型（`settled`）。GDI 实测：Times New Roman 的数字 0 在 ppem 12、14 时于 IUP 之后以 SCFS、
 *   ALIGNRP 与 FLIPRGON 改为直边，GDI 的 ClearType 字形仍为椭圆。不要去掉这一条：Arial、Times New Roman（常规、粗体）
 *   与 Calibri ppem 8–30 的可打印 ASCII 共 8648 个字形中与 GDI 逐像素相同的由 6156 个降为 5465 个。未查明的例外：
 *   Times New Roman 的 k、c、e、d 与 Arial 的 M、N、R、w 在个别 ppem 下 IUP 之后的 SHPIX 在 GDI 中生效，按本规则不移动。
 * - ClearType 绘制为 GDI 的自然宽度方式（`CLEARTYPE_NATURAL_QUALITY`）：WPS 以此请求绘制文字（WPS 表格的屏幕图像、
 *   WPS 演示的导出图与 WPS 文字复制为图片的图元文件实测）。该方式下 GETINFO 不回答兼容宽度，字形不按单色宽度缩放。
 *   不要改为兼容宽度方式（`CLEARTYPE_QUALITY`）：Arial、Times New Roman、微软雅黑 ppem 8–30 的可打印 ASCII 中与
 *   自然宽度方式的 GDI 字形逐像素相同的比例由 60%–68% 降为 9%–29%。
 */

import {
  divFix,
  dot14,
  mulDiv,
  mulDivTrunc,
  mulFix,
  mulFix14,
  normalize,
  pixCeil,
  pixFloor,
  type UnitVector,
} from './fixed.ts'

export const TAG_ON = 0x01
export const TOUCH_X = 0x08
export const TOUCH_Y = 0x10

/** 点区：twilight 区或字形区。`orus` 为字体单位（组合字形为分量提示后的 26.6 坐标），`org`、`cur` 为 26.6。 */
export interface Zone {
  readonly n: number
  readonly orusX: Float64Array
  readonly orusY: Float64Array
  readonly orgX: Float64Array
  readonly orgY: Float64Array
  readonly curX: Float64Array
  readonly curY: Float64Array
  /** `TAG_ON`、`TOUCH_X`、`TOUCH_Y` 的组合。 */
  readonly tags: Uint8Array
  /** 各轮廓最后一个点的序号；twilight 区为空数组。 */
  readonly ends: readonly number[]
}

/** 六个坐标数组是同一块缓冲区的分段：每分配一个类型化数组的固定开销远大于按长度计的开销。 */
export function createZone(n: number, ends: readonly number[] = []): Zone {
  const f = new Float64Array(6 * n)
  return {
    n,
    orusX: f.subarray(0, n),
    orusY: f.subarray(n, 2 * n),
    orgX: f.subarray(2 * n, 3 * n),
    orgY: f.subarray(3 * n, 4 * n),
    curX: f.subarray(4 * n, 5 * n),
    curY: f.subarray(5 * n, 6 * n),
    tags: new Uint8Array(n),
    ends,
  }
}

/** 把 `from` 的各数组复制到点数相同的 `to`。 */
function copyZoneInto(to: Zone, from: Zone): void {
  to.orusX.set(from.orusX)
  to.orusY.set(from.orusY)
  to.orgX.set(from.orgX)
  to.orgY.set(from.orgY)
  to.curX.set(from.curX)
  to.curY.set(from.curY)
  to.tags.set(from.tags)
}

/** 一次字形指令执行所用的 cvt、存储区、twilight 区与栈，由 `SizeHinter.hint` 逐次复用。 */
interface Workspace {
  readonly cvt: Float64Array
  readonly storage: Int32Array
  readonly twilight: Zone
  readonly stack: Int32Array
}

/** 字形指令执行完毕后的扫描转换设置。 */
export interface ScanSettings {
  /** SCANCTRL 判定的丢失控制开关。 */
  readonly scanControl: boolean
  /** SCANTYPE 的值：0、1 为简单丢失控制，4、5 为智能丢失控制，1、5 排除端点短线；其余不做丢失控制。 */
  readonly scanType: number
}

interface GraphicsState {
  rp0: number
  rp1: number
  rp2: number
  dual: UnitVector
  proj: UnitVector
  free: UnitVector
  loop: number
  minimumDistance: number
  roundState: number
  autoFlip: boolean
  cvtCutIn: number
  singleWidthCutIn: number
  singleWidthValue: number
  deltaBase: number
  deltaShift: number
  instructControl: number
  scanControl: boolean
  scanType: number
  gep0: number
  gep1: number
  gep2: number
}

function defaultState(): GraphicsState {
  return {
    rp0: 0,
    rp1: 0,
    rp2: 0,
    dual: { x: 0x4000, y: 0 },
    proj: { x: 0x4000, y: 0 },
    free: { x: 0x4000, y: 0 },
    loop: 1,
    minimumDistance: 64,
    roundState: ROUND_GRID,
    autoFlip: true,
    cvtCutIn: 68,
    singleWidthCutIn: 0,
    singleWidthValue: 0,
    deltaBase: 9,
    deltaShift: 3,
    instructControl: 0,
    scanControl: false,
    scanType: 0,
    gep0: 1,
    gep1: 1,
    gep2: 1,
  }
}

function copyState(s: GraphicsState): GraphicsState {
  return { ...s, dual: { ...s.dual }, proj: { ...s.proj }, free: { ...s.free } }
}

const ROUND_HALF_GRID = 0
const ROUND_GRID = 1
const ROUND_DOUBLE_GRID = 2
const ROUND_DOWN = 3
const ROUND_UP = 4
const ROUND_OFF = 5
const ROUND_SUPER = -1
const ROUND_SUPER_45 = -2

/** 指令程序结构错误：栈越界、未定义的指令、跳转越界、执行步数超出上限等。 */
export class HintError extends Error {
  override name = 'HintError'
}

const FPGM = 0
const PREP = 1
const GLYPH = 2

interface Definition {
  readonly range: number
  readonly start: number
}

interface CallRecord {
  readonly callerRange: number
  readonly callerIp: number
  count: number
  readonly def: Definition
}

/** 每段程序最多执行的指令数：超过时视为死循环。 */
const MAX_STEPS = 1_000_000
/** 栈容量在 `maxp.maxStackElements` 之外的余量：部分字体的该值偏小。 */
const STACK_MARGIN = 32
const MAX_CALL_DEPTH = 64
/** GETINFO 的光栅化器版本号（Windows 10 GDI 实测，单色与 ClearType 相同）。 */
const RASTERIZER_VERSION = 42

/** 各指令出栈、入栈的个数；`-1` 为未定义的指令（可由 IDEF 定义）。循环类指令另按 loop 出栈。 */
const POPS = new Int8Array(256).fill(-1)
const PUSHES = new Int8Array(256)

function define(from: number, to: number, pops: number, pushes: number): void {
  for (let op = from; op <= to; op++) {
    POPS[op] = pops
    PUSHES[op] = pushes
  }
}

define(0x00, 0x05, 0, 0)
define(0x06, 0x0b, 2, 0)
define(0x0c, 0x0d, 0, 2)
define(0x0e, 0x0e, 0, 0)
define(0x0f, 0x0f, 5, 0)
define(0x10, 0x17, 1, 0)
define(0x18, 0x19, 0, 0)
define(0x1a, 0x1a, 1, 0)
define(0x1b, 0x1b, 0, 0)
define(0x1c, 0x1f, 1, 0)
define(0x20, 0x20, 1, 2)
define(0x21, 0x21, 1, 0)
define(0x22, 0x22, 0, 0)
define(0x23, 0x23, 2, 2)
define(0x24, 0x24, 0, 1)
define(0x25, 0x25, 1, 1)
define(0x26, 0x26, 1, 0)
define(0x27, 0x27, 2, 0)
define(0x29, 0x29, 1, 0)
define(0x2a, 0x2a, 2, 0)
define(0x2b, 0x2c, 1, 0)
define(0x2d, 0x2d, 0, 0)
define(0x2e, 0x2f, 1, 0)
define(0x30, 0x33, 0, 0)
define(0x34, 0x38, 1, 0)
define(0x39, 0x39, 0, 0)
define(0x3a, 0x3b, 2, 0)
define(0x3c, 0x3d, 0, 0)
define(0x3e, 0x3f, 2, 0)
define(0x40, 0x41, 0, 0)
define(0x42, 0x42, 2, 0)
define(0x43, 0x43, 1, 1)
define(0x44, 0x44, 2, 0)
define(0x45, 0x47, 1, 1)
define(0x48, 0x48, 2, 0)
define(0x49, 0x4a, 2, 1)
define(0x4b, 0x4c, 0, 1)
define(0x4d, 0x4e, 0, 0)
define(0x4f, 0x4f, 1, 0)
define(0x50, 0x55, 2, 1)
define(0x56, 0x57, 1, 1)
define(0x58, 0x58, 1, 0)
define(0x59, 0x59, 0, 0)
define(0x5a, 0x5b, 2, 1)
define(0x5c, 0x5c, 1, 1)
define(0x5d, 0x5f, 1, 0)
define(0x60, 0x63, 2, 1)
define(0x64, 0x6f, 1, 1)
define(0x70, 0x70, 2, 0)
define(0x71, 0x77, 1, 0)
define(0x78, 0x79, 2, 0)
define(0x7a, 0x7a, 0, 0)
define(0x7c, 0x7d, 0, 0)
define(0x7e, 0x7f, 1, 0)
define(0x80, 0x80, 0, 0)
define(0x81, 0x82, 2, 0)
define(0x85, 0x85, 1, 0)
define(0x86, 0x87, 2, 0)
define(0x88, 0x88, 1, 1)
define(0x89, 0x89, 1, 0)
define(0x8a, 0x8a, 3, 3)
define(0x8b, 0x8c, 2, 1)
define(0x8d, 0x8d, 1, 0)
define(0x8e, 0x8e, 2, 0)
for (let n = 0; n < 8; n++) {
  define(0xb0 + n, 0xb0 + n, 0, n + 1)
  define(0xb8 + n, 0xb8 + n, 0, n + 1)
}
define(0xc0, 0xdf, 1, 0)
define(0xe0, 0xff, 2, 0)

/** 指令在 `code[ip]` 处的长度（含随后的立即数）。 */
function instructionLength(code: Uint8Array, ip: number): number {
  const op = code[ip]!
  if (op === 0x40) return 2 + (code[ip + 1] ?? 0)
  if (op === 0x41) return 2 + 2 * (code[ip + 1] ?? 0)
  if (op >= 0xb0 && op <= 0xb7) return 1 + (op - 0xaf)
  if (op >= 0xb8 && op <= 0xbf) return 1 + 2 * (op - 0xb7)
  return 1
}

/**
 * GETINFO：选择子各位对应的回答（Windows 10 GDI 实测）。版本号、字体变体（选择子位 3）与纵向幻影点（位 4）两种绘制相同；
 * ClearType 绘制另回答 ClearType（位 6），y 方向平滑时回答对称平滑（位 11）；自然宽度方式不回答兼容宽度（位 7），
 * 也不回答 BGR、子像素定位与灰度 ClearType。Arial ppem 12（`gasp` 不要求平滑）的字形指令中位 11 的回答为 0，
 * 构造字体（没有 `gasp`）中为真。
 */
function getInfo(selector: number, clearType: boolean, smoothY: boolean): number {
  let r = 0
  if (selector & 1) r |= RASTERIZER_VERSION
  if (selector & 8) r |= 0x400
  if (selector & 16) r |= 0x800
  if (clearType) {
    if (selector & 64) r |= 0x2000
    if (selector & 2048 && smoothY) r |= 0x40000
  }
  return r
}

/** 字体的指令程序与容量（`maxp`）。cvt 为字体单位。 */
export interface FontPrograms {
  readonly unitsPerEm: number
  readonly fpgm: Uint8Array
  readonly prep: Uint8Array
  readonly cvt: Int16Array
  readonly maxStorage: number
  readonly maxStack: number
  readonly maxTwilight: number
}

/**
 * 某一 ppem 下的指令执行环境。`ok` 为假时 `fpgm` 或 `prep` 出错，该字号不做提示。
 * `clearType` 为真时按 ClearType 绘制的条件执行（见文件头）；`smoothY` 为该字号 ClearType 绘制是否在 y 方向平滑，
 * 只影响 GETINFO 的回答。
 */
export class SizeHinter {
  readonly ppem: number
  /** 字体单位到 26.6 的缩放系数，16.16。 */
  readonly scale: number
  readonly ok: boolean
  private readonly state: GraphicsState
  private readonly cvt: Float64Array
  private readonly storage: Int32Array
  private readonly twilight: Zone
  private readonly functions = new Map<number, Definition>()
  private readonly instructions = new Map<number, Definition>()
  private readonly ranges: Uint8Array[]
  /** 空闲的执行空间；执行中为 `null`。 */
  private workspace: Workspace | null = null

  constructor(
    private readonly font: FontPrograms,
    ppem: number,
    readonly clearType = false,
    readonly smoothY = false,
  ) {
    this.ppem = ppem
    this.scale = Math.floor(
      (ppem * 64 * 0x10000 + Math.floor(font.unitsPerEm / 2)) / font.unitsPerEm,
    )
    this.cvt = Float64Array.from(font.cvt, (v) => mulFix(v, this.scale))
    this.storage = new Int32Array(font.maxStorage)
    this.twilight = createZone(font.maxTwilight)
    this.ranges = [font.fpgm, font.prep, new Uint8Array(0)]
    const empty = createZone(0)
    const exec = () =>
      new Exec(
        this,
        defaultState(),
        this.cvt,
        this.storage,
        this.twilight,
        empty,
        new Int32Array(this.maxStack),
      )
    const prep = exec()
    let ok = true
    try {
      exec().run(FPGM, this.scale)
      prep.run(PREP, this.scale)
    } catch (e) {
      if (!(e instanceof HintError)) throw e
      ok = false
    }
    const s = prep.gs
    s.dual = { x: 0x4000, y: 0 }
    s.proj = { x: 0x4000, y: 0 }
    s.free = { x: 0x4000, y: 0 }
    s.rp0 = s.rp1 = s.rp2 = 0
    s.gep0 = s.gep1 = s.gep2 = 1
    s.loop = 1
    this.state = s
    this.ok = ok
  }

  /** `prep` 关闭了网格对齐（INSTCTRL 选择子 1）。 */
  get disabled(): boolean {
    return (this.state.instructControl & 1) !== 0
  }

  /** @internal 解释器读取程序与定义。 */
  code(range: number): Uint8Array {
    return this.ranges[range]!
  }

  /** @internal */
  defs(kind: 'function' | 'instruction'): Map<number, Definition> {
    return kind === 'function' ? this.functions : this.instructions
  }

  /** @internal */
  get maxStack(): number {
    return this.font.maxStack + STACK_MARGIN
  }

  /**
   * 执行字形指令，原地修改 `zone` 的 `cur` 与触及标志。`zone` 的最后 4 个点为幻影点，调用方已把其中 x 方向的两个点
   * 的 x 与 y 方向的两个点的 y 取整。`composite` 为真时 `orus` 是分量提示后的 26.6 坐标，按缩放系数 1 计算原始距离。
   * 指令出错时保留出错前的点位。
   */
  hint(zone: Zone, instructions: Uint8Array, composite: boolean): ScanSettings {
    const base = (this.state.instructControl & 2) !== 0 ? defaultState() : this.state
    // 每次执行前把执行空间复原为 prep 之后的状态，栈清零；执行中再次调用时另建一份。
    const ws = this.workspace ?? {
      cvt: new Float64Array(this.cvt.length),
      storage: new Int32Array(this.storage.length),
      twilight: createZone(this.twilight.n),
      stack: new Int32Array(this.maxStack),
    }
    this.workspace = null
    ws.cvt.set(this.cvt)
    ws.storage.set(this.storage)
    copyZoneInto(ws.twilight, this.twilight)
    ws.stack.fill(0)
    const exec = new Exec(this, copyState(base), ws.cvt, ws.storage, ws.twilight, zone, ws.stack)
    this.ranges[GLYPH] = instructions
    try {
      exec.run(GLYPH, composite ? 0x10000 : this.scale)
    } catch (e) {
      if (!(e instanceof HintError)) throw e
    } finally {
      this.workspace = ws
    }
    return { scanControl: exec.gs.scanControl, scanType: exec.gs.scanType }
  }
}

/** 一次程序执行的状态。 */
class Exec {
  gs: GraphicsState
  private zp0: Zone
  private zp1: Zone
  private zp2: Zone
  private top = 0
  private args = 0
  private newTop = 0
  private code: Uint8Array = new Uint8Array(0)
  private range = FPGM
  private ip = 0
  private len = 1
  private opcode = 0
  private step = true
  private calls: CallRecord[] = []
  private fDotP = 0x4000
  /** 原始距离（`orus`）的缩放系数，16.16；组合字形为 1。 */
  private orusScale = 0x10000
  private period = 64
  private phase = 0
  private threshold = 32
  /** 正在执行字形指令（含其调用的函数）。 */
  private glyph = false
  /** 本段字形指令已执行的 IUP：1 为 x 方向，2 为 y 方向。 */
  private iupDone = 0

  constructor(
    private readonly size: SizeHinter,
    gs: GraphicsState,
    private readonly cvt: Float64Array,
    private readonly storage: Int32Array,
    private readonly twilight: Zone,
    private readonly pts: Zone,
    private readonly stack: Int32Array,
  ) {
    this.gs = gs
    this.zp0 = this.zp1 = this.zp2 = pts
    this.computeFuncs()
  }

  run(range: number, orusScale: number): void {
    this.orusScale = orusScale
    this.top = 0
    this.calls = []
    this.glyph = range === GLYPH
    this.iupDone = 0
    if (range === GLYPH) {
      const g = this.gs
      this.zp0 = this.zp1 = this.zp2 = this.pts
      g.gep0 = g.gep1 = g.gep2 = 1
      g.proj = { x: 0x4000, y: 0 }
      g.free = { x: 0x4000, y: 0 }
      g.dual = { x: 0x4000, y: 0 }
      g.roundState = ROUND_GRID
      g.loop = 1
      this.computeFuncs()
    }
    this.goto(range, 0)
    let steps = 0
    for (;;) {
      if (this.ip >= this.code.length) {
        if (this.calls.length > 0) throw new HintError('函数没有以 ENDF 结束')
        return
      }
      if (++steps > MAX_STEPS) throw new HintError('指令执行步数超出上限')
      const op = this.code[this.ip]!
      this.opcode = op
      this.len = instructionLength(this.code, this.ip)
      if (this.ip + this.len > this.code.length) throw new HintError('指令越过程序末尾')
      const pops = POPS[op]!
      if (pops < 0) {
        this.unknown(op)
        continue
      }
      if (this.top < pops) throw new HintError('栈下溢')
      this.args = this.top - pops
      this.newTop = this.args + PUSHES[op]!
      if (this.newTop > this.stack.length) throw new HintError('栈溢出')
      this.step = true
      this.execute(op)
      this.top = this.newTop
      if (this.step) this.ip += this.len
    }
  }

  private goto(range: number, ip: number): void {
    this.range = range
    this.code = this.size.code(range)
    this.ip = ip
  }

  private arg(i: number): number {
    return this.stack[this.args + i]!
  }

  private set(i: number, v: number): void {
    this.stack[this.args + i] = v
  }

  /** 循环类指令自栈上逐个取点号。 */
  private popLoop(): number {
    if (this.args <= 0) throw new HintError('栈下溢')
    this.args--
    return this.stack[this.args]!
  }

  // ── 向量与投影 ──

  private computeFuncs(): void {
    const { free, proj } = this.gs
    let f: number
    if (free.x === 0x4000) f = proj.x
    else if (free.y === 0x4000) f = proj.y
    else f = Math.floor((proj.x * free.x + proj.y * free.y) / 0x4000)
    if (Math.abs(f) < 0x400) f = 0x4000
    this.fDotP = f
  }

  private project(dx: number, dy: number): number {
    return dot14(dx, dy, this.gs.proj.x, this.gs.proj.y)
  }

  private dualProject(dx: number, dy: number): number {
    return dot14(dx, dy, this.gs.dual.x, this.gs.dual.y)
  }

  /** ClearType 绘制的字形指令已执行过 IUP[x] 与 IUP[y]：字形区的点不再移动，点的类型不再翻转（见文件头）。 */
  private get settled(): boolean {
    return this.glyph && this.size.clearType && this.iupDone === 3
  }

  /** 点 `p` 沿自由向量移动，使其在投影向量上的坐标增加 `d`，并标记触及。 */
  private move(z: Zone, p: number, d: number): void {
    const { free } = this.gs
    const still = z === this.pts && this.settled
    if (free.x !== 0) {
      if (!still) z.curX[p] = z.curX[p]! + mulDiv(d, free.x, this.fDotP)
      z.tags[p] = z.tags[p]! | TOUCH_X
    }
    if (free.y !== 0) {
      if (!still) z.curY[p] = z.curY[p]! + mulDiv(d, free.y, this.fDotP)
      z.tags[p] = z.tags[p]! | TOUCH_Y
    }
  }

  private moveOrig(z: Zone, p: number, d: number): void {
    const { free } = this.gs
    if (free.x !== 0) z.orgX[p] = z.orgX[p]! + mulDiv(d, free.x, this.fDotP)
    if (free.y !== 0) z.orgY[p] = z.orgY[p]! + mulDiv(d, free.y, this.fDotP)
  }

  /** 两点在原始轮廓上沿对偶向量的距离：twilight 区用 `org`，字形区用 `orus` 再缩放。 */
  private originalDistance(za: Zone, a: number, zb: Zone, b: number, twilight: boolean): number {
    if (twilight) return this.dualProject(za.orgX[a]! - zb.orgX[b]!, za.orgY[a]! - zb.orgY[b]!)
    return mulFix(
      this.dualProject(za.orusX[a]! - zb.orusX[b]!, za.orusY[a]! - zb.orusY[b]!),
      this.orusScale,
    )
  }

  // ── 取整 ──

  /** ClearType 绘制下执行字形指令且投影向量含 x 分量：按 x 方向的条件取整、取最小距离与 cut-in（见文件头）。 */
  private get subpixelX(): boolean {
    return this.glyph && this.size.clearType && this.gs.proj.x !== 0
  }

  private round(d: number): number {
    // 网格（26.6）：单色与 y 方向为 1 像素，ClearType 的 x 方向为 1/16 像素。
    const grid = this.subpixelX ? 4 : 64
    const half = grid / 2
    let v: number
    switch (this.gs.roundState) {
      case ROUND_HALF_GRID:
        if (d >= 0) v = Math.floor(d / grid) * grid + half
        else v = -(Math.floor(-d / grid) * grid + half)
        return v
      case ROUND_GRID:
        if (d >= 0) {
          v = Math.floor((d + half) / grid) * grid
          return v < 0 ? 0 : v
        }
        v = -Math.floor((-d + half) / grid) * grid
        return v > 0 ? 0 : v
      case ROUND_DOUBLE_GRID:
        if (d >= 0) {
          v = Math.floor((d + half / 2) / half) * half
          return v < 0 ? 0 : v
        }
        v = -Math.floor((-d + half / 2) / half) * half
        return v > 0 ? 0 : v
      case ROUND_DOWN:
        if (d >= 0) return Math.floor(d / grid) * grid
        return -Math.floor(-d / grid) * grid
      case ROUND_UP:
        if (d >= 0) return Math.ceil(d / grid) * grid
        return -Math.ceil(-d / grid) * grid
      case ROUND_SUPER:
        if (d >= 0) {
          v = Math.floor((d - this.phase + this.threshold) / this.period) * this.period + this.phase
          return v < 0 ? this.phase : v
        }
        v = -Math.floor((this.threshold - this.phase - d) / this.period) * this.period - this.phase
        return v > 0 ? -this.phase : v
      case ROUND_SUPER_45:
        if (d >= 0) {
          v = Math.trunc((d - this.phase + this.threshold) / this.period) * this.period + this.phase
          return v < 0 ? this.phase : v
        }
        v =
          -(Math.trunc((this.threshold - this.phase - d) / this.period) * this.period) - this.phase
        return v > 0 ? -this.phase : v
      default:
        return d
    }
  }

  /** SROUND 与 S45ROUND：`gridPeriod` 为 1 像素（0x4000）或 √2/2 像素（0x2d41），按 2.14 计。 */
  private superRound(gridPeriod: number, selector: number): void {
    let period: number
    switch (selector & 0xc0) {
      case 0x00:
        period = Math.trunc(gridPeriod / 2)
        break
      case 0x80:
        period = gridPeriod * 2
        break
      default:
        period = gridPeriod
    }
    let phase: number
    switch (selector & 0x30) {
      case 0x00:
        phase = 0
        break
      case 0x10:
        phase = Math.trunc(period / 4)
        break
      case 0x20:
        phase = Math.trunc(period / 2)
        break
      default:
        phase = Math.trunc((period * 3) / 4)
    }
    const threshold =
      (selector & 0x0f) === 0 ? period - 1 : Math.trunc((((selector & 0x0f) - 4) * period) / 8)
    this.period = period >> 8
    this.phase = phase >> 8
    this.threshold = threshold >> 8
    if (this.period === 0) this.period = 1
  }

  private minimumDistance(): number {
    return this.subpixelX ? this.gs.minimumDistance / 2 : this.gs.minimumDistance
  }

  private cutIn(): number {
    return this.subpixelX ? this.gs.cvtCutIn / 16 : this.gs.cvtCutIn
  }

  // ── 区与边界 ──

  private zone(n: number): Zone | null {
    if (n === 0) return this.twilight
    if (n === 1) return this.pts
    return null
  }

  private static inside(p: number, z: Zone): boolean {
    return p >= 0 && p < z.n
  }

  /** 跳到下一条指令（IF、ELSE、FDEF、IDEF 的跳过）；越过程序末尾时抛出。 */
  private skip(): void {
    this.ip += this.len
    if (this.ip >= this.code.length) throw new HintError('指令越过程序末尾')
    this.opcode = this.code[this.ip]!
    this.len = instructionLength(this.code, this.ip)
    if (this.ip + this.len > this.code.length) throw new HintError('指令越过程序末尾')
  }

  private unknown(op: number): void {
    const def = this.size.defs('instruction').get(op)
    if (def === undefined) throw new HintError(`未定义的指令 0x${op.toString(16)}`)
    this.call(def, 1)
  }

  private call(def: Definition, count: number): void {
    if (this.calls.length >= MAX_CALL_DEPTH) throw new HintError('函数调用嵌套过深')
    this.calls.push({ callerRange: this.range, callerIp: this.ip + this.len, count, def })
    this.goto(def.range, def.start)
    this.step = false
  }

  private define(kind: 'function' | 'instruction', n: number): void {
    if (this.range === GLYPH) throw new HintError('字形指令中不得定义函数')
    this.size.defs(kind).set(n, { range: this.range, start: this.ip + 1 })
    for (;;) {
      this.skip()
      if (this.opcode === 0x89 || this.opcode === 0x2c) throw new HintError('函数定义嵌套')
      if (this.opcode === 0x2d) return
    }
  }

  // ── 指令 ──

  private execute(op: number): void {
    const g = this.gs
    if (op >= 0xc0) {
      if (op >= 0xe0) this.mirp(op)
      else this.mdrp(op)
      return
    }
    if (op >= 0xb0) {
      const n = op >= 0xb8 ? op - 0xb7 : op - 0xaf
      const word = op >= 0xb8
      for (let i = 0; i < n; i++) {
        const at = this.ip + 1 + (word ? 2 * i : i)
        this.set(i, word ? ((this.code[at]! << 24) >> 16) | this.code[at + 1]! : this.code[at]!)
      }
      return
    }
    switch (op) {
      case 0x00:
      case 0x01:
      case 0x02:
      case 0x03:
      case 0x04:
      case 0x05: {
        const a = (op & 1) << 14
        const b = a ^ 0x4000
        if (op < 4) {
          g.proj = { x: a, y: b }
          g.dual = { x: a, y: b }
        }
        if ((op & 2) === 0) g.free = { x: a, y: b }
        this.computeFuncs()
        return
      }
      case 0x06:
      case 0x07:
        if (this.vectorToLine(this.arg(1), this.arg(0), op, g.proj)) {
          g.dual = { ...g.proj }
          this.computeFuncs()
        }
        return
      case 0x08:
      case 0x09:
        if (this.vectorToLine(this.arg(1), this.arg(0), op, g.free)) this.computeFuncs()
        return
      case 0x0a:
      case 0x0b: {
        const x = (this.arg(0) << 16) >> 16
        const y = (this.arg(1) << 16) >> 16
        const v = op === 0x0a ? g.proj : g.free
        normalize(x, y, v)
        if (op === 0x0a) g.dual = { ...g.proj }
        this.computeFuncs()
        return
      }
      case 0x0c:
      case 0x0d: {
        const v = op === 0x0c ? g.proj : g.free
        this.set(0, v.x)
        this.set(1, v.y)
        return
      }
      case 0x0e:
        g.free = { ...g.proj }
        this.computeFuncs()
        return
      case 0x0f:
        this.isect()
        return
      case 0x10:
        g.rp0 = this.arg(0) & 0xffff
        return
      case 0x11:
        g.rp1 = this.arg(0) & 0xffff
        return
      case 0x12:
        g.rp2 = this.arg(0) & 0xffff
        return
      case 0x13:
      case 0x14:
      case 0x15:
      case 0x16: {
        const n = this.arg(0)
        const z = this.zone(n)
        if (z === null) return
        if (op === 0x13 || op === 0x16) {
          this.zp0 = z
          g.gep0 = n
        }
        if (op === 0x14 || op === 0x16) {
          this.zp1 = z
          g.gep1 = n
        }
        if (op === 0x15 || op === 0x16) {
          this.zp2 = z
          g.gep2 = n
        }
        return
      }
      case 0x17: {
        const n = this.arg(0)
        if (n < 0) throw new HintError('SLOOP 的参数为负')
        g.loop = Math.min(n, 0xffff)
        return
      }
      case 0x18:
        g.roundState = ROUND_GRID
        return
      case 0x19:
        g.roundState = ROUND_HALF_GRID
        return
      case 0x1a:
        g.minimumDistance = this.arg(0)
        return
      case 0x1b: {
        let depth = 1
        do {
          this.skip()
          if (this.opcode === 0x58) depth++
          else if (this.opcode === 0x59) depth--
        } while (depth !== 0)
        return
      }
      case 0x1c:
        this.jump(this.arg(0))
        return
      case 0x1d:
        g.cvtCutIn = this.arg(0)
        return
      case 0x1e:
        g.singleWidthCutIn = this.arg(0)
        return
      case 0x1f:
        g.singleWidthValue = mulFix(this.arg(0), this.size.scale)
        return
      case 0x20:
        this.set(1, this.arg(0))
        return
      case 0x21:
        return
      case 0x22:
        this.newTop = 0
        return
      case 0x23: {
        const a = this.arg(0)
        this.set(0, this.arg(1))
        this.set(1, a)
        return
      }
      case 0x24:
        this.set(0, this.top)
        return
      case 0x25: {
        const k = this.arg(0)
        this.set(0, k <= 0 || k > this.args ? 0 : this.stack[this.args - k]!)
        return
      }
      case 0x26: {
        const k = this.arg(0)
        if (k <= 0 || k > this.args) return
        const v = this.stack[this.args - k]!
        this.stack.copyWithin(this.args - k, this.args - k + 1, this.args)
        this.stack[this.args - 1] = v
        return
      }
      case 0x27:
        this.alignPoints()
        return
      case 0x29: {
        const p = this.arg(0)
        if (!Exec.inside(p, this.zp0)) return
        let mask = 0xff
        if (g.free.x !== 0) mask &= ~TOUCH_X
        if (g.free.y !== 0) mask &= ~TOUCH_Y
        this.zp0.tags[p] = this.zp0.tags[p]! & mask
        return
      }
      case 0x2a: {
        const def = this.size.defs('function').get(this.arg(1))
        if (def === undefined) throw new HintError('LOOPCALL 调用未定义的函数')
        if (this.arg(0) > 0) this.call(def, this.arg(0))
        return
      }
      case 0x2b: {
        const def = this.size.defs('function').get(this.arg(0))
        if (def === undefined) throw new HintError('CALL 调用未定义的函数')
        this.call(def, 1)
        return
      }
      case 0x2c:
        this.define('function', this.arg(0))
        return
      case 0x2d: {
        const rec = this.calls[this.calls.length - 1]
        if (rec === undefined) throw new HintError('ENDF 不在函数中')
        rec.count--
        this.step = false
        if (rec.count > 0) this.ip = rec.def.start
        else {
          this.calls.pop()
          this.goto(rec.callerRange, rec.callerIp)
        }
        return
      }
      case 0x2e:
      case 0x2f:
        this.mdap(op)
        return
      case 0x30:
      case 0x31:
        this.iup(op === 0x31)
        this.iupDone |= op === 0x31 ? 1 : 2
        return
      case 0x32:
      case 0x33:
        this.shp(op)
        return
      case 0x34:
      case 0x35:
        this.shc(op)
        return
      case 0x36:
      case 0x37:
        this.shz(op)
        return
      case 0x38:
        this.shpix()
        return
      case 0x39:
        this.ip_()
        return
      case 0x3a:
      case 0x3b:
        this.msirp(op)
        return
      case 0x3c:
        this.alignrp()
        return
      case 0x3d:
        g.roundState = ROUND_DOUBLE_GRID
        return
      case 0x3e:
      case 0x3f:
        this.miap(op)
        return
      case 0x40:
      case 0x41: {
        const n = this.code[this.ip + 1]!
        if (this.args + n > this.stack.length) throw new HintError('栈溢出')
        for (let i = 0; i < n; i++) {
          const at = this.ip + 2 + (op === 0x41 ? 2 * i : i)
          this.stack[this.args + i] =
            op === 0x41 ? ((this.code[at]! << 24) >> 16) | this.code[at + 1]! : this.code[at]!
        }
        this.newTop = this.args + n
        return
      }
      case 0x42: {
        const i = this.arg(0)
        if (i >= 0 && i < this.storage.length) this.storage[i] = this.arg(1)
        return
      }
      case 0x43: {
        const i = this.arg(0)
        this.set(0, i >= 0 && i < this.storage.length ? this.storage[i]! : 0)
        return
      }
      case 0x44: {
        const i = this.arg(0)
        if (i >= 0 && i < this.cvt.length) this.cvt[i] = this.arg(1)
        return
      }
      case 0x45: {
        const i = this.arg(0)
        this.set(0, i >= 0 && i < this.cvt.length ? this.cvt[i]! : 0)
        return
      }
      case 0x46:
      case 0x47: {
        const p = this.arg(0)
        const z = this.zp2
        if (!Exec.inside(p, z)) {
          this.set(0, 0)
          return
        }
        this.set(
          0,
          op === 0x47
            ? this.dualProject(z.orgX[p]!, z.orgY[p]!)
            : this.project(z.curX[p]!, z.curY[p]!),
        )
        return
      }
      case 0x48: {
        const p = this.arg(0)
        const z = this.zp2
        if (!Exec.inside(p, z)) return
        const k = this.project(z.curX[p]!, z.curY[p]!)
        this.move(z, p, this.arg(1) - k)
        if (g.gep2 === 0) {
          z.orgX[p] = z.curX[p]!
          z.orgY[p] = z.curY[p]!
        }
        return
      }
      case 0x49:
      case 0x4a:
        this.md(op)
        return
      case 0x4b:
      case 0x4c:
        this.set(0, this.size.ppem)
        return
      case 0x4d:
        g.autoFlip = true
        return
      case 0x4e:
        g.autoFlip = false
        return
      case 0x4f:
        return
      case 0x50:
        this.set(0, this.arg(0) < this.arg(1) ? 1 : 0)
        return
      case 0x51:
        this.set(0, this.arg(0) <= this.arg(1) ? 1 : 0)
        return
      case 0x52:
        this.set(0, this.arg(0) > this.arg(1) ? 1 : 0)
        return
      case 0x53:
        this.set(0, this.arg(0) >= this.arg(1) ? 1 : 0)
        return
      case 0x54:
        this.set(0, this.arg(0) === this.arg(1) ? 1 : 0)
        return
      case 0x55:
        this.set(0, this.arg(0) !== this.arg(1) ? 1 : 0)
        return
      case 0x56:
        this.set(0, (this.round(this.arg(0)) & 127) === 64 ? 1 : 0)
        return
      case 0x57:
        this.set(0, (this.round(this.arg(0)) & 127) === 0 ? 1 : 0)
        return
      case 0x58: {
        if (this.arg(0) !== 0) return
        let depth = 1
        for (;;) {
          this.skip()
          if (this.opcode === 0x58) depth++
          else if (this.opcode === 0x1b) {
            if (depth === 1) return
          } else if (this.opcode === 0x59) {
            depth--
            if (depth === 0) return
          }
        }
      }
      case 0x59:
        return
      case 0x5a:
        this.set(0, this.arg(0) !== 0 && this.arg(1) !== 0 ? 1 : 0)
        return
      case 0x5b:
        this.set(0, this.arg(0) !== 0 || this.arg(1) !== 0 ? 1 : 0)
        return
      case 0x5c:
        this.set(0, this.arg(0) === 0 ? 1 : 0)
        return
      case 0x5d:
      case 0x71:
      case 0x72:
        this.deltaPoint(op)
        return
      case 0x5e:
        g.deltaBase = this.arg(0) & 0xffff
        return
      case 0x5f: {
        const n = this.arg(0)
        if (n < 0 || n > 6) throw new HintError('SDS 的参数超出 0–6')
        g.deltaShift = n
        return
      }
      case 0x60:
        this.set(0, (this.arg(0) + this.arg(1)) | 0)
        return
      case 0x61:
        this.set(0, (this.arg(0) - this.arg(1)) | 0)
        return
      case 0x62:
        if (this.arg(1) === 0) throw new HintError('DIV 除以零')
        this.set(0, mulDivTrunc(this.arg(0), 64, this.arg(1)) | 0)
        return
      case 0x63:
        this.set(0, mulDiv(this.arg(0), this.arg(1), 64) | 0)
        return
      case 0x64:
        this.set(0, Math.abs(this.arg(0)) | 0)
        return
      case 0x65:
        this.set(0, -this.arg(0) | 0)
        return
      case 0x66:
        this.set(0, pixFloor(this.arg(0)))
        return
      case 0x67:
        this.set(0, pixCeil(this.arg(0)))
        return
      case 0x68:
      case 0x69:
      case 0x6a:
      case 0x6b:
        this.set(0, this.round(this.arg(0)))
        return
      case 0x6c:
      case 0x6d:
      case 0x6e:
      case 0x6f:
        return
      case 0x70: {
        const i = this.arg(0)
        if (i >= 0 && i < this.cvt.length) this.cvt[i] = mulFix(this.arg(1), this.size.scale)
        return
      }
      case 0x73:
      case 0x74:
      case 0x75:
        this.deltaCvt(op)
        return
      case 0x76:
        this.superRound(0x4000, this.arg(0))
        g.roundState = ROUND_SUPER
        return
      case 0x77:
        this.superRound(0x2d41, this.arg(0))
        g.roundState = ROUND_SUPER_45
        return
      case 0x78:
        if (this.arg(1) !== 0) this.jump(this.arg(0))
        return
      case 0x79:
        if (this.arg(1) === 0) this.jump(this.arg(0))
        return
      case 0x7a:
        g.roundState = ROUND_OFF
        return
      case 0x7c:
        g.roundState = ROUND_UP
        return
      case 0x7d:
        g.roundState = ROUND_DOWN
        return
      case 0x7e:
      case 0x7f:
        return
      case 0x80:
        this.flipPoints()
        return
      case 0x81:
      case 0x82: {
        if (this.settled) return
        const lo = this.arg(0)
        const hi = this.arg(1)
        const z = this.pts
        if (!Exec.inside(hi, z) || !Exec.inside(lo, z)) return
        for (let p = lo; p <= hi; p++) {
          z.tags[p] = op === 0x81 ? z.tags[p]! | TAG_ON : z.tags[p]! & ~TAG_ON
        }
        return
      }
      case 0x85:
        this.scanControl(this.arg(0))
        return
      case 0x86:
      case 0x87:
        this.sdpvtl(op)
        return
      case 0x88:
        this.set(0, getInfo(this.arg(0), this.size.clearType, this.size.smoothY))
        return
      case 0x89:
        this.define('instruction', this.arg(0) & 0xff)
        return
      case 0x8a: {
        const a = this.arg(2)
        const b = this.arg(1)
        const c = this.arg(0)
        this.set(2, c)
        this.set(1, a)
        this.set(0, b)
        return
      }
      case 0x8b:
        this.set(0, Math.max(this.arg(0), this.arg(1)))
        return
      case 0x8c:
        this.set(0, Math.min(this.arg(0), this.arg(1)))
        return
      case 0x8d:
        if (this.arg(0) >= 0) g.scanType = this.arg(0) & 0xffff
        return
      case 0x8e:
        this.instructControl(this.arg(1), this.arg(0))
        return
      default:
        throw new HintError(`未实现的指令 0x${op.toString(16)}`)
    }
  }

  private jump(offset: number): void {
    if (offset === 0 && this.args === 0) throw new HintError('JMPR 的偏移为 0')
    const ip = this.ip + offset
    if (ip < 0 || ip > this.code.length) throw new HintError('跳转越界')
    this.ip = ip
    this.step = false
  }

  /** SPVTL、SFVTL：自 zp2 的 `a`（栈顶）指向 zp1 的 `b` 的方向；`op` 为奇数时取逆时针垂直方向。两点重合时取 x 轴。 */
  private vectorToLine(a: number, b: number, op: number, out: UnitVector): boolean {
    if (!Exec.inside(a, this.zp2) || !Exec.inside(b, this.zp1)) return false
    let dx = this.zp1.curX[b]! - this.zp2.curX[a]!
    let dy = this.zp1.curY[b]! - this.zp2.curY[a]!
    let perpendicular = (op & 1) !== 0
    if (dx === 0 && dy === 0) {
      dx = 0x4000
      perpendicular = false
    }
    if (perpendicular) {
      const t = dy
      dy = dx
      dx = -t
    }
    normalize(dx, dy, out)
    return true
  }

  private sdpvtl(op: number): void {
    const a = this.arg(1)
    const b = this.arg(0)
    if (!Exec.inside(b, this.zp1) || !Exec.inside(a, this.zp2)) return
    const g = this.gs
    const vector = (
      xs1: Float64Array,
      ys1: Float64Array,
      xs2: Float64Array,
      ys2: Float64Array,
      out: UnitVector,
    ) => {
      let dx = xs1[b]! - xs2[a]!
      let dy = ys1[b]! - ys2[a]!
      let perpendicular = (op & 1) !== 0
      if (dx === 0 && dy === 0) {
        dx = 0x4000
        perpendicular = false
      }
      if (perpendicular) {
        const t = dy
        dy = dx
        dx = -t
      }
      normalize(dx, dy, out)
    }
    vector(this.zp1.orgX, this.zp1.orgY, this.zp2.orgX, this.zp2.orgY, g.dual)
    vector(this.zp1.curX, this.zp1.curY, this.zp2.curX, this.zp2.curY, g.proj)
    this.computeFuncs()
  }

  private scanControl(v: number): void {
    const g = this.gs
    const threshold = v & 0xff
    if (threshold === 0xff) {
      g.scanControl = true
      return
    }
    if (threshold === 0) {
      g.scanControl = false
      return
    }
    const ppem = this.size.ppem
    if (v & 0x100 && ppem <= threshold) g.scanControl = true
    if (v & 0x800 && ppem > threshold) g.scanControl = false
  }

  private instructControl(selector: number, value: number): void {
    if (this.range !== PREP) return
    if (selector < 1 || selector > 3) return
    const flag = 1 << (selector - 1)
    if (value !== 0 && value !== flag) return
    this.gs.instructControl = (this.gs.instructControl & ~flag) | value
  }

  private isect(): void {
    const p = this.arg(0)
    const a0 = this.arg(1)
    const a1 = this.arg(2)
    const b0 = this.arg(3)
    const b1 = this.arg(4)
    const { zp0, zp1, zp2 } = this
    if (
      !Exec.inside(b0, zp0) ||
      !Exec.inside(b1, zp0) ||
      !Exec.inside(a0, zp1) ||
      !Exec.inside(a1, zp1) ||
      !Exec.inside(p, zp2)
    )
      return
    const dbx = zp0.curX[b1]! - zp0.curX[b0]!
    const dby = zp0.curY[b1]! - zp0.curY[b0]!
    const dax = zp1.curX[a1]! - zp1.curX[a0]!
    const day = zp1.curY[a1]! - zp1.curY[a0]!
    const dx = zp0.curX[b0]! - zp1.curX[a0]!
    const dy = zp0.curY[b0]! - zp1.curY[a0]!
    const discriminant = mulDiv(dax, -dby, 0x40) + mulDiv(day, dbx, 0x40)
    const dotproduct = mulDiv(dax, dbx, 0x40) + mulDiv(day, dby, 0x40)
    // 两线夹角小于约 3°（|tan| < 1/19）时视为平行，取两线段中点的中点。
    if (19 * Math.abs(discriminant) > Math.abs(dotproduct)) {
      const v = mulDiv(dx, -dby, 0x40) + mulDiv(dy, dbx, 0x40)
      zp2.curX[p] = zp1.curX[a0]! + mulDiv(v, dax, discriminant)
      zp2.curY[p] = zp1.curY[a0]! + mulDiv(v, day, discriminant)
    } else {
      zp2.curX[p] = Math.trunc((zp1.curX[a0]! + zp1.curX[a1]! + zp0.curX[b0]! + zp0.curX[b1]!) / 4)
      zp2.curY[p] = Math.trunc((zp1.curY[a0]! + zp1.curY[a1]! + zp0.curY[b0]! + zp0.curY[b1]!) / 4)
    }
    zp2.tags[p] = zp2.tags[p]! | TOUCH_X | TOUCH_Y
  }

  private alignPoints(): void {
    const p1 = this.arg(0)
    const p2 = this.arg(1)
    if (!Exec.inside(p1, this.zp1) || !Exec.inside(p2, this.zp0)) return
    const d = Math.trunc(
      this.project(
        this.zp0.curX[p2]! - this.zp1.curX[p1]!,
        this.zp0.curY[p2]! - this.zp1.curY[p1]!,
      ) / 2,
    )
    this.move(this.zp1, p1, d)
    this.move(this.zp0, p2, -d)
  }

  private mdap(op: number): void {
    const p = this.arg(0)
    const z = this.zp0
    if (!Exec.inside(p, z)) return
    let d = 0
    if (op & 1) {
      const cur = this.project(z.curX[p]!, z.curY[p]!)
      d = this.round(cur) - cur
    }
    this.move(z, p, d)
    this.gs.rp0 = this.gs.rp1 = p
  }

  private miap(op: number): void {
    const p = this.arg(0)
    const entry = this.arg(1)
    const z = this.zp0
    const g = this.gs
    if (!Exec.inside(p, z) || entry < 0 || entry >= this.cvt.length) {
      g.rp0 = g.rp1 = p & 0xffff
      return
    }
    let d = this.cvt[entry]!
    if (g.gep0 === 0) {
      z.orgX[p] = mulFix14(d, g.free.x)
      z.orgY[p] = mulFix14(d, g.free.y)
      z.curX[p] = z.orgX[p]!
      z.curY[p] = z.orgY[p]!
    }
    const orgDist = this.project(z.curX[p]!, z.curY[p]!)
    if (op & 1) {
      if (Math.abs(d - orgDist) > this.cutIn()) d = orgDist
      d = this.round(d)
    }
    this.move(z, p, d - orgDist)
    g.rp0 = g.rp1 = p
  }

  private mdrp(op: number): void {
    const p = this.arg(0)
    const g = this.gs
    const { zp0, zp1 } = this
    if (!Exec.inside(p, zp1) || !Exec.inside(g.rp0, zp0)) {
      g.rp1 = g.rp0
      g.rp2 = p & 0xffff
      if (op & 16) g.rp0 = p & 0xffff
      return
    }
    let orgDist = this.originalDistance(zp1, p, zp0, g.rp0, g.gep0 === 0 || g.gep1 === 0)
    if (
      g.singleWidthCutIn > 0 &&
      orgDist < g.singleWidthValue + g.singleWidthCutIn &&
      orgDist > g.singleWidthValue - g.singleWidthCutIn
    )
      orgDist = orgDist >= 0 ? g.singleWidthValue : -g.singleWidthValue
    let d = op & 4 ? this.round(orgDist) : orgDist
    if (op & 8) {
      const min = this.minimumDistance()
      if (orgDist >= 0) {
        if (d < min) d = min
      } else if (d > -min) d = -min
    }
    const cur = this.project(zp1.curX[p]! - zp0.curX[g.rp0]!, zp1.curY[p]! - zp0.curY[g.rp0]!)
    this.move(zp1, p, d - cur)
    g.rp1 = g.rp0
    g.rp2 = p
    if (op & 16) g.rp0 = p
  }

  private mirp(op: number): void {
    const p = this.arg(0)
    const entry = this.arg(1) + 1
    const g = this.gs
    const { zp0, zp1 } = this
    if (!Exec.inside(p, zp1) || entry < 0 || entry > this.cvt.length || !Exec.inside(g.rp0, zp0)) {
      g.rp1 = g.rp0
      if (op & 16) g.rp0 = p & 0xffff
      g.rp2 = p & 0xffff
      return
    }
    // cvt[-1] 视为 0。
    let cvtDist = entry === 0 ? 0 : this.cvt[entry - 1]!
    if (Math.abs(cvtDist - g.singleWidthValue) < g.singleWidthCutIn)
      cvtDist = cvtDist >= 0 ? g.singleWidthValue : -g.singleWidthValue
    if (g.gep1 === 0) {
      zp1.orgX[p] = zp0.orgX[g.rp0]! + mulFix14(cvtDist, g.free.x)
      zp1.orgY[p] = zp0.orgY[g.rp0]! + mulFix14(cvtDist, g.free.y)
      zp1.curX[p] = zp1.orgX[p]!
      zp1.curY[p] = zp1.orgY[p]!
    }
    const orgDist = this.dualProject(
      zp1.orgX[p]! - zp0.orgX[g.rp0]!,
      zp1.orgY[p]! - zp0.orgY[g.rp0]!,
    )
    const curDist = this.project(zp1.curX[p]! - zp0.curX[g.rp0]!, zp1.curY[p]! - zp0.curY[g.rp0]!)
    // 符号按补码判定：0 视为正。
    if (g.autoFlip && orgDist < 0 !== cvtDist < 0) cvtDist = -cvtDist
    // 只在两点位于同一区时做 cut-in 判定；差值大于 cut-in 时取轮廓上的距离。单色绘制只在取整时判定。
    if (
      (op & 4 || this.subpixelX) &&
      g.gep0 === g.gep1 &&
      Math.abs(cvtDist - orgDist) > this.cutIn()
    )
      cvtDist = orgDist
    let d = op & 4 ? this.round(cvtDist) : cvtDist
    if (op & 8) {
      const min = this.minimumDistance()
      if (orgDist >= 0) {
        if (d < min) d = min
      } else if (d > -min) d = -min
    }
    this.move(zp1, p, d - curDist)
    g.rp1 = g.rp0
    if (op & 16) g.rp0 = p
    g.rp2 = p
  }

  private msirp(op: number): void {
    const p = this.arg(0)
    const d = this.arg(1)
    const g = this.gs
    const { zp0, zp1 } = this
    if (!Exec.inside(p, zp1) || !Exec.inside(g.rp0, zp0)) return
    if (g.gep1 === 0) {
      zp1.orgX[p] = zp0.orgX[g.rp0]!
      zp1.orgY[p] = zp0.orgY[g.rp0]!
      this.moveOrig(zp1, p, d)
      zp1.curX[p] = zp1.orgX[p]!
      zp1.curY[p] = zp1.orgY[p]!
    }
    const cur = this.project(zp1.curX[p]! - zp0.curX[g.rp0]!, zp1.curY[p]! - zp0.curY[g.rp0]!)
    this.move(zp1, p, d - cur)
    g.rp1 = g.rp0
    g.rp2 = p
    if (op & 1) g.rp0 = p
  }

  private md(op: number): void {
    const b = this.arg(1)
    const a = this.arg(0)
    const { zp0, zp1 } = this
    if (!Exec.inside(a, zp0) || !Exec.inside(b, zp1)) {
      this.set(0, 0)
      return
    }
    const g = this.gs
    const d =
      op === 0x49
        ? this.project(zp0.curX[a]! - zp1.curX[b]!, zp0.curY[a]! - zp1.curY[b]!)
        : this.originalDistance(zp0, a, zp1, b, g.gep0 === 0 || g.gep1 === 0)
    this.set(0, d)
  }

  private alignrp(): void {
    const g = this.gs
    const { zp0, zp1 } = this
    if (this.top < g.loop || !Exec.inside(g.rp0, zp0)) {
      g.loop = 1
      this.newTop = this.args
      return
    }
    while (g.loop > 0) {
      const p = this.popLoop()
      if (Exec.inside(p, zp1)) {
        const d = this.project(zp1.curX[p]! - zp0.curX[g.rp0]!, zp1.curY[p]! - zp0.curY[g.rp0]!)
        this.move(zp1, p, -d)
      }
      g.loop--
    }
    g.loop = 1
    this.newTop = this.args
  }

  /** SHP、SHC、SHZ 的参考点位移：`op` 为奇数时取 zp0 的 rp1，否则取 zp1 的 rp2。 */
  private displacement(op: number): { dx: number; dy: number; zone: Zone; ref: number } | null {
    const zone = op & 1 ? this.zp0 : this.zp1
    const ref = op & 1 ? this.gs.rp1 : this.gs.rp2
    if (!Exec.inside(ref, zone)) return null
    const d = this.project(zone.curX[ref]! - zone.orgX[ref]!, zone.curY[ref]! - zone.orgY[ref]!)
    return {
      dx: mulDiv(d, this.gs.free.x, this.fDotP),
      dy: mulDiv(d, this.gs.free.y, this.fDotP),
      zone,
      ref,
    }
  }

  private shift(p: number, dx: number, dy: number, touch: boolean): void {
    const z = this.zp2
    if (z === this.pts && this.settled) return
    if (this.gs.free.x !== 0) {
      z.curX[p] = z.curX[p]! + dx
      if (touch) z.tags[p] = z.tags[p]! | TOUCH_X
    }
    if (this.gs.free.y !== 0) {
      z.curY[p] = z.curY[p]! + dy
      if (touch) z.tags[p] = z.tags[p]! | TOUCH_Y
    }
  }

  private shp(op: number): void {
    const g = this.gs
    if (this.top < g.loop) {
      g.loop = 1
      this.newTop = this.args
      return
    }
    const d = this.displacement(op)
    if (d === null) return
    while (g.loop > 0) {
      const p = this.popLoop()
      if (Exec.inside(p, this.zp2)) this.shift(p, d.dx, d.dy, true)
      g.loop--
    }
    g.loop = 1
    this.newTop = this.args
  }

  private shc(op: number): void {
    const c = this.arg(0)
    const z = this.zp2
    const twilight = this.gs.gep2 === 0
    const contours = twilight ? 1 : z.ends.length
    if (c < 0 || c >= contours) return
    const d = this.displacement(op)
    if (d === null) return
    const start = c === 0 ? 0 : z.ends[c - 1]! + 1
    const limit = twilight ? z.n : z.ends[c]! + 1
    for (let i = start; i < limit; i++) {
      if (d.zone !== z || d.ref !== i) this.shift(i, d.dx, d.dy, true)
    }
  }

  private shz(op: number): void {
    const e = this.arg(0)
    if (e < 0 || e > 1) return
    const d = this.displacement(op)
    if (d === null) return
    const z = this.zp2
    // 不移动幻影点，也不标记触及。
    const limit = this.gs.gep2 === 0 ? z.n : z.ends.length > 0 ? z.ends[z.ends.length - 1]! + 1 : 0
    for (let i = 0; i < limit; i++) {
      if (d.zone !== z || d.ref !== i) this.shift(i, d.dx, d.dy, false)
    }
  }

  private shpix(): void {
    const g = this.gs
    if (this.top < g.loop + 1) {
      g.loop = 1
      this.newTop = this.args
      return
    }
    const amount = this.arg(0)
    const dx = mulFix14(amount, g.free.x)
    const dy = mulFix14(amount, g.free.y)
    while (g.loop > 0) {
      const p = this.popLoop()
      if (Exec.inside(p, this.zp2)) this.shift(p, dx, dy, true)
      g.loop--
    }
    g.loop = 1
    this.newTop = this.args
  }

  private ip_(): void {
    const g = this.gs
    const { zp0, zp1, zp2 } = this
    if (this.top < g.loop || !Exec.inside(g.rp1, zp0)) {
      g.loop = 1
      this.newTop = this.args
      return
    }
    const twilight = g.gep0 === 0 || g.gep1 === 0 || g.gep2 === 0
    const r1 = g.rp1
    const baseX = twilight ? zp0.orgX[r1]! : zp0.orusX[r1]!
    const baseY = twilight ? zp0.orgY[r1]! : zp0.orusY[r1]!
    let oldRange = 0
    let curRange = 0
    if (Exec.inside(g.rp2, zp1)) {
      const r2 = g.rp2
      oldRange = twilight
        ? this.dualProject(zp1.orgX[r2]! - baseX, zp1.orgY[r2]! - baseY)
        : this.dualProject(zp1.orusX[r2]! - baseX, zp1.orusY[r2]! - baseY)
      curRange = this.project(zp1.curX[r2]! - zp0.curX[r1]!, zp1.curY[r2]! - zp0.curY[r1]!)
    }
    while (g.loop > 0) {
      const p = this.popLoop()
      g.loop--
      if (!Exec.inside(p, zp2)) continue
      const orgDist = twilight
        ? this.dualProject(zp2.orgX[p]! - baseX, zp2.orgY[p]! - baseY)
        : this.dualProject(zp2.orusX[p]! - baseX, zp2.orusY[p]! - baseY)
      const curDist = this.project(zp2.curX[p]! - zp0.curX[r1]!, zp2.curY[p]! - zp0.curY[r1]!)
      let newDist = 0
      if (orgDist !== 0) newDist = oldRange !== 0 ? mulDiv(orgDist, curRange, oldRange) : orgDist
      this.move(zp2, p, newDist - curDist)
    }
    g.loop = 1
    this.newTop = this.args
  }

  private flipPoints(): void {
    const g = this.gs
    if (this.top < g.loop) {
      g.loop = 1
      this.newTop = this.args
      return
    }
    while (g.loop > 0) {
      const p = this.popLoop()
      if (Exec.inside(p, this.pts) && !this.settled) this.pts.tags[p] = this.pts.tags[p]! ^ TAG_ON
      g.loop--
    }
    g.loop = 1
    this.newTop = this.args
  }

  private deltaStep(arg: number): number {
    let b = (arg & 0xf) - 8
    if (b >= 0) b++
    return b * (1 << (6 - this.gs.deltaShift))
  }

  private deltaPoint(op: number): void {
    const n = this.arg(0)
    const add = op === 0x71 ? 16 : op === 0x72 ? 32 : 0
    for (let k = 0; k < n; k++) {
      if (this.args < 2) {
        this.args = 0
        break
      }
      this.args -= 2
      const p = this.stack[this.args + 1]! & 0xffff
      const arg = this.stack[this.args]!
      if (!Exec.inside(p, this.zp0)) continue
      if (this.glyph && this.size.clearType && this.gs.free.x !== 0) continue
      if (this.size.ppem === ((arg & 0xf0) >> 4) + add + this.gs.deltaBase)
        this.move(this.zp0, p, this.deltaStep(arg))
    }
    this.newTop = this.args
  }

  private deltaCvt(op: number): void {
    const n = this.arg(0)
    const add = op === 0x74 ? 16 : op === 0x75 ? 32 : 0
    for (let k = 0; k < n; k++) {
      if (this.args < 2) {
        this.args = 0
        break
      }
      this.args -= 2
      const i = this.stack[this.args + 1]!
      const arg = this.stack[this.args]!
      if (i < 0 || i >= this.cvt.length) continue
      if (this.size.ppem === ((arg & 0xf0) >> 4) + add + this.gs.deltaBase)
        this.cvt[i] = this.cvt[i]! + this.deltaStep(arg)
    }
    this.newTop = this.args
  }

  /** IUP：未触及的点按同一轮廓中前后两个触及点在原始轮廓上的位置插值或平移。 */
  private iup(x: boolean): void {
    const z = this.pts
    if (z.ends.length === 0) return
    const mask = x ? TOUCH_X : TOUCH_Y
    const cur = x ? z.curX : z.curY
    const org = x ? z.orgX : z.orgY
    const orus = x ? z.orusX : z.orusY
    const shift = (p1: number, p2: number, p: number) => {
      const d = cur[p]! - org[p]!
      if (d === 0) return
      for (let i = p1; i < p; i++) cur[i] = cur[i]! + d
      for (let i = p + 1; i <= p2; i++) cur[i] = cur[i]! + d
    }
    const interpolate = (p1: number, p2: number, ref1: number, ref2: number) => {
      if (p1 > p2) return
      if (ref1 >= z.n || ref2 >= z.n) return
      let o1 = orus[ref1]!
      let o2 = orus[ref2]!
      if (o1 > o2) {
        const t = o1
        o1 = o2
        o2 = t
        const r = ref1
        ref1 = ref2
        ref2 = r
      }
      const org1 = org[ref1]!
      const org2 = org[ref2]!
      const cur1 = cur[ref1]!
      const cur2 = cur[ref2]!
      const d1 = cur1 - org1
      const d2 = cur2 - org2
      if (cur1 === cur2 || o1 === o2) {
        for (let i = p1; i <= p2; i++) {
          const v = org[i]!
          cur[i] = v <= org1 ? v + d1 : v >= org2 ? v + d2 : cur1
        }
        return
      }
      let scale = 0
      let valid = false
      for (let i = p1; i <= p2; i++) {
        const v = org[i]!
        if (v <= org1) cur[i] = v + d1
        else if (v >= org2) cur[i] = v + d2
        else {
          if (!valid) {
            valid = true
            scale = divFix(cur2 - cur1, o2 - o1)
          }
          cur[i] = cur1 + mulFix(orus[i]! - o1, scale)
        }
      }
    }
    let point = 0
    for (let c = 0; c < z.ends.length; c++) {
      let end = z.ends[c]!
      const first = point
      if (end >= z.n) end = z.n - 1
      while (point <= end && (z.tags[point]! & mask) === 0) point++
      if (point <= end) {
        const firstTouched = point
        let curTouched = point
        point++
        while (point <= end) {
          if ((z.tags[point]! & mask) !== 0) {
            interpolate(curTouched + 1, point - 1, curTouched, point)
            curTouched = point
          }
          point++
        }
        if (curTouched === firstTouched) shift(first, end, curTouched)
        else {
          interpolate(curTouched + 1, end, curTouched, firstTouched)
          if (firstTouched > 0) interpolate(first, firstTouched - 1, curTouched, firstTouched)
        }
      }
      point = end + 1
    }
  }
}
