/** CRC-32（反射多项式 0xEDB88320），用于校验 ZIP 成员解压结果。 */

const TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** 返回无符号 32 位整数，与 ZIP 头中的 CRC 字段直接比较。 */
export function crc32(data: Uint8Array): number {
  let c = -1
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
