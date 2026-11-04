/**
 * BIFF8 工作簿流的 RC4 解密。
 *
 * - 只实现 RC4（FILEPASS 中加密类型为 1、版本 1.1）。密码固定为 `VelvetSweatshop`：保护工作簿结构而未设打开密码时，
 *   Excel 与 WPS 用这个缺省密码加密，打开时不要求输入。校验不通过、XOR 混淆与 RC4 CryptoAPI 一律返回 `null`，
 *   由调用方归入已加密。
 * - 密钥：H0 = MD5(UTF-16LE 密码) 的前 5 字节；H1 = MD5((H0 ‖ salt) 重复 16 次) 的前 5 字节；
 *   第 b 块的密钥为 MD5(H1 ‖ b 的 32 位小端)。每 1024 字节换一次密钥，块号与块内位置按字节在整个流中的偏移计算。
 * - 记录头（类型与长度）不加密，但占用密钥流的位置；BOF、FILEPASS、USREXCL、FILELOCK、INTERFACEHDR、RRDINFO、
 *   RRDHEAD 的数据不加密；BOUNDSHEET 数据的前 4 字节（子流位置）不加密。
 * - 浏览器的 `crypto.subtle` 没有 MD5，且只提供异步接口，因此 MD5 与 RC4 在本文件中实现。
 */

const PASSWORD = 'VelvetSweatshop'
const BLOCK = 1024
const FILEPASS = 0x002f
/** 数据不加密的记录类型。 */
const PLAIN_RECORDS = new Set([0x0809, 0x002f, 0x0194, 0x0195, 0x00e1, 0x0196, 0x0138])
const BOUNDSHEET = 0x0085

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]
const K = Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0,
)

export function md5(input: Uint8Array): Uint8Array {
  const length = input.length
  const padded = new Uint8Array((((length + 8) >> 6) + 1) * 64)
  padded.set(input)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, (length * 8) >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor((length * 8) / 2 ** 32), true)
  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  const m = new Uint32Array(16)
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(block + i * 4, true)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      const sum = (a + f + K[i]! + m[g]!) >>> 0
      a = d
      d = c
      c = b
      b = (b + ((sum << S[i]!) | (sum >>> (32 - S[i]!)))) >>> 0
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }
  const out = new Uint8Array(16)
  const ov = new DataView(out.buffer)
  ov.setUint32(0, a0, true)
  ov.setUint32(4, b0, true)
  ov.setUint32(8, c0, true)
  ov.setUint32(12, d0, true)
  return out
}

/** 以 `key` 初始化的 RC4 密钥流的前 `length` 字节。 */
export function rc4(key: Uint8Array, length: number): Uint8Array {
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255
    const t = s[i]!
    s[i] = s[j]!
    s[j] = t
  }
  const out = new Uint8Array(length)
  for (let k = 0, i = 0, j = 0; k < length; k++) {
    i = (i + 1) & 255
    j = (j + s[i]!) & 255
    const t = s[i]!
    s[i] = s[j]!
    s[j] = t
    out[k] = s[(s[i]! + s[j]!) & 255]!
  }
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let p = 0
  for (const part of parts) {
    out.set(part, p)
    p += part.length
  }
  return out
}

/** 由密码与 salt 得到逐块密钥的生成函数。 */
function blockKeys(salt: Uint8Array): (block: number) => Uint8Array {
  const password = new Uint8Array(PASSWORD.length * 2)
  for (let i = 0; i < PASSWORD.length; i++) password[i * 2] = PASSWORD.charCodeAt(i)
  const h0 = md5(password).subarray(0, 5)
  const repeated = new Uint8Array(21 * 16)
  for (let i = 0; i < 16; i++) repeated.set(concat(h0, salt), i * 21)
  const h1 = md5(repeated).subarray(0, 5)
  return (block) => {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, block, true)
    return md5(concat(h1, b))
  }
}

/**
 * 解密 `stream`：`filepass` 为 FILEPASS 记录在流中的偏移（记录头起点）。不能以缺省密码解密时返回 `null`。
 * 返回新的字节数组，FILEPASS 及其之前的内容原样保留。
 */
export function decryptWorkbook(stream: Uint8Array, filepass: number): Uint8Array | null {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  const length = view.getUint16(filepass + 2, true)
  const body = stream.subarray(filepass + 4, filepass + 4 + length)
  if (body.length < 54) return null
  const bv = new DataView(body.buffer, body.byteOffset, body.byteLength)
  if (bv.getUint16(0, true) !== 1 || bv.getUint16(2, true) !== 1 || bv.getUint16(4, true) !== 1) {
    return null
  }
  const keyOf = blockKeys(body.slice(6, 22))
  const check = rc4(keyOf(0), 32)
  const verifier = body.subarray(22, 38).map((v, i) => v ^ check[i]!)
  const hash = body.subarray(38, 54).map((v, i) => v ^ check[i + 16]!)
  const expected = md5(verifier)
  if (!expected.every((v, i) => v === hash[i])) return null

  const out = stream.slice()
  let current = -1
  let keystream: Uint8Array = new Uint8Array(0)
  const xor = (from: number, to: number) => {
    for (let p = from; p < to; p++) {
      const block = Math.floor(p / BLOCK)
      if (block !== current) {
        current = block
        keystream = rc4(keyOf(block), BLOCK)
      }
      out[p] = stream[p]! ^ keystream[p % BLOCK]!
    }
  }
  for (let p = filepass + 4 + length; p + 4 <= stream.length; ) {
    const id = view.getUint16(p, true)
    const size = view.getUint16(p + 2, true)
    const end = Math.min(p + 4 + size, stream.length)
    if (!PLAIN_RECORDS.has(id)) xor(id === BOUNDSHEET ? p + 8 : p + 4, end)
    p = end
  }
  return out
}

/** 工作簿全局子流中 FILEPASS 记录的偏移；全局子流结束（EOF）前没有时为 -1。 */
export function findFilepass(stream: Uint8Array): number {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  for (let p = 0; p + 4 <= stream.length; p += 4 + view.getUint16(p + 2, true)) {
    const id = view.getUint16(p, true)
    if (id === FILEPASS) return p
    if (id === 0x000a) return -1
  }
  return -1
}
