/**
 * LZCOMP 解压：MicroType Express 三个数据块各自使用的压缩方式（MTX 格式规范第 3 节与附录 C）。
 *
 * - 位流按字节从高位到低位读取。首位为是否叠加游程编码，其后 24 位为解压后的长度。
 * - 符号由三棵自适应哈夫曼树解码：符号树（字面字节、复制命令与三个单字节复制命令）、长度树、距离树。
 *   树的初始权重与更新规则必须与编码端逐位一致，否则后续全部符号错位。
 * - 历史缓冲区前预置 `PRELOAD` 字节的固定内容，复制命令可以引用它们。
 */

import { FontFormatError } from '../sfnt.ts'

const PRELOAD = 2 * 32 * 96 + 4 * 256
const LEN_WIDTH = 3
const DIST_WIDTH = 3
const LEN_MIN = 2
const DIST_MIN = 1
/** 距离不小于该值时最短复制长度由 2 变为 3。 */
const MAX_2BYTE_DIST = 512

class BitReader {
  private index = 0
  private buffer = 0
  private count = 0

  constructor(private readonly bytes: Uint8Array) {}

  bit(): number {
    if (this.count === 0) {
      if (this.index >= this.bytes.length) throw new FontFormatError('LZCOMP 数据提前结束')
      this.buffer = this.bytes[this.index++]!
      this.count = 8
    }
    this.count--
    return (this.buffer >> this.count) & 1
  }

  value(bits: number): number {
    let v = 0
    for (let i = 0; i < bits; i++) v = v * 2 + this.bit()
    return v
  }
}

/**
 * 自适应哈夫曼树。节点按权重降序排列（兄弟性质），下标 1 为根；`symbolIndex` 为符号到叶节点的映射。
 */
class AdaptiveHuffman {
  private readonly up: Int32Array
  private readonly left: Int32Array
  private readonly right: Int32Array
  private readonly code: Int32Array
  private readonly weight: Float64Array
  private readonly symbolIndex: Int32Array

  constructor(
    private readonly bits: BitReader,
    range: number,
  ) {
    const size = 2 * range
    this.up = new Int32Array(size)
    this.left = new Int32Array(size)
    this.right = new Int32Array(size)
    this.code = new Int32Array(size)
    this.weight = new Float64Array(size)
    this.symbolIndex = new Int32Array(range)
    for (let i = 2; i < size; i++) {
      this.up[i] = i >> 1
      this.weight[i] = 1
    }
    for (let i = 1; i < range; i++) {
      this.left[i] = 2 * i
      this.right[i] = 2 * i + 1
    }
    for (let i = 0; i < range; i++) {
      this.code[i] = -1
      this.code[range + i] = i
      this.left[range + i] = -1
      this.right[range + i] = -1
      this.symbolIndex[i] = range + i
    }
    this.initWeight(1)
    // 范围在 257–511 之间的为符号树：按编码端的约定预先提高部分符号的权重。
    if (range > 256 && range < 512) {
      this.update(this.symbolIndex[256]!)
      this.update(this.symbolIndex[257]!)
      for (let i = 0; i < 12; i++) this.update(this.symbolIndex[range - 3]!)
      for (let i = 0; i < 6; i++) this.update(this.symbolIndex[range - 2]!)
    } else {
      for (let j = 0; j < 2; j++) for (let i = 0; i < range; i++) this.update(this.symbolIndex[i]!)
    }
  }

  private initWeight(a: number): number {
    if (this.code[a]! < 0) {
      this.weight[a] = this.initWeight(this.left[a]!) + this.initWeight(this.right[a]!)
    }
    return this.weight[a]!
  }

  private swap(a: number, b: number): void {
    const upa = this.up[a]!
    const upb = this.up[b]!
    const arrays = [this.left, this.right, this.code] as const
    for (const arr of arrays) {
      const t = arr[a]!
      arr[a] = arr[b]!
      arr[b] = t
    }
    const w = this.weight[a]!
    this.weight[a] = this.weight[b]!
    this.weight[b] = w
    this.up[a] = upa
    this.up[b] = upb
    for (const n of [a, b]) {
      const c = this.code[n]!
      if (c < 0) {
        this.up[this.left[n]!] = n
        this.up[this.right[n]!] = n
      } else {
        this.symbolIndex[c] = n
      }
    }
  }

  private update(start: number): void {
    let a = start
    for (; a !== 1; a = this.up[a]!) {
      const weightA = this.weight[a]!
      let b = a - 1
      if (this.weight[b] === weightA) {
        do b--
        while (this.weight[b] === weightA)
        b++
        if (b > 1) {
          this.swap(a, b)
          a = b
        }
      }
      this.weight[a] = weightA + 1
    }
    this.weight[a] = this.weight[a]! + 1
  }

  read(): number {
    let a = 1
    let symbol: number
    do {
      a = this.bits.bit() ? this.right[a]! : this.left[a]!
      symbol = this.code[a]!
    } while (symbol < 0)
    this.update(a)
    return symbol
  }
}

/** 解压一个 LZCOMP 数据块。 */
export function lzcompDecode(data: Uint8Array): Uint8Array {
  const bits = new BitReader(data)
  const runLength = bits.bit() === 1
  const dist = new AdaptiveHuffman(bits, 1 << DIST_WIDTH)
  const len = new AdaptiveHuffman(bits, 1 << LEN_WIDTH)
  const outLength = bits.value(24)
  let ranges = 1
  while (DIST_MIN + 2 ** (DIST_WIDTH * ranges) - 1 < outLength) ranges++
  const dup2 = 256 + (1 << LEN_WIDTH) * ranges
  const sym = new AdaptiveHuffman(bits, dup2 + 3)

  const history = new Uint8Array(PRELOAD + outLength)
  let i = 0
  for (let k = 0; k < 32; k++) {
    for (let j = 0; j < 96; j++) {
      history[i++] = k
      history[i++] = j
    }
  }
  for (let j = 0; i < PRELOAD && j < 256; j++) {
    history[i++] = j
    history[i++] = j
    history[i++] = j
    history[i++] = j
  }

  let pos = PRELOAD
  const end = PRELOAD + outLength
  while (pos < end) {
    const symbol = sym.read()
    if (symbol < 256) {
      history[pos++] = symbol
    } else if (symbol === dup2) {
      history[pos] = history[pos - 2]!
      pos++
    } else if (symbol === dup2 + 1) {
      history[pos] = history[pos - 4]!
      pos++
    } else if (symbol === dup2 + 2) {
      history[pos] = history[pos - 6]!
      pos++
    } else {
      // 复制命令：首个符号给出距离的 3 位组数与长度的前 2 位，长度按 2 位一组续读，最高位为结束标志。
      let bitsValue = symbol - 256
      const distRanges = Math.floor(bitsValue / (1 << LEN_WIDTH)) + 1
      bitsValue %= 1 << LEN_WIDTH
      let length = 0
      for (;;) {
        length = length * 4 + (bitsValue & 3)
        if ((bitsValue & 4) === 0) break
        bitsValue = len.read()
      }
      length += LEN_MIN
      let distance = 0
      for (let r = 0; r < distRanges; r++) distance = distance * 8 + dist.read()
      distance += DIST_MIN
      if (distance >= MAX_2BYTE_DIST) length++
      const start = pos - distance - length + 1
      if (start < 0 || pos + length > end) throw new FontFormatError('LZCOMP 复制越界')
      for (let j = 0; j < length; j++) history[pos++] = history[start + j]!
    }
  }
  const out = history.subarray(PRELOAD)
  return runLength ? runLengthDecode(out) : out.slice()
}

/** 游程编码的还原：首字节为转义字节；转义字节后跟 0 表示转义字节本身，否则为「次数、字节」。 */
function runLengthDecode(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data
  const marker = data[0]!
  const out: number[] = []
  for (let i = 1; i < data.length; i++) {
    const b = data[i]!
    if (b !== marker) {
      out.push(b)
      continue
    }
    const count = data[++i] ?? 0
    if (count === 0) {
      out.push(marker)
      continue
    }
    const value = data[++i] ?? 0
    for (let k = 0; k < count; k++) out.push(value)
  }
  return Uint8Array.from(out)
}
