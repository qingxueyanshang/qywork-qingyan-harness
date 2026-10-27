/** 测试用的最小 mp4：只有 `ftyp`、`mdat` 与带 `mvhd` / `tkhd` 的 `moov`，不含可解码的画面。 */

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length + 8, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}

/** 版本 0 的 `mvhd`：时间单位 1000，时长按毫秒写入。 */
function mvhd(seconds: number): Buffer {
  const b = Buffer.alloc(100)
  b.writeUInt32BE(1000, 12)
  b.writeUInt32BE(Math.round(seconds * 1000), 16)
  return box('mvhd', b)
}

/** 版本 0 的 `tkhd`：单位矩阵位于偏移 40，宽高为 16.16 定点数。 */
function tkhd(w: number, h: number): Buffer {
  const b = Buffer.alloc(84)
  b.writeInt32BE(0x10000, 40)
  b.writeUInt32BE(w * 65536, 76)
  b.writeUInt32BE(h * 65536, 80)
  return box('tkhd', b)
}

/** `moov` 位于 `mdat` 之后；`mdat` 的长度使文件总长不小于 `bytes`。 */
export function mp4Bytes(seconds: number, w: number, h: number, bytes = 4096): Uint8Array {
  const moov = box('moov', mvhd(seconds), box('trak', tkhd(w, h)))
  const ftyp = box('ftyp', Buffer.from('isom0000', 'latin1'))
  const pad = Math.max(0, bytes - moov.length - ftyp.length - 8)
  return new Uint8Array(Buffer.concat([ftyp, box('mdat', Buffer.alloc(pad)), moov]))
}
