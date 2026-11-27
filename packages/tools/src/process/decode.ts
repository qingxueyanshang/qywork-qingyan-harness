/** 子进程输出的解码：逐行判定按 UTF-8 还是按本机代码页解码。 */

/**
 * 代码页号 → `TextDecoder` 支持的标签。
 *
 * 只列出需要换名的代码页：Bun 不支持 `windows-936` / `x-cp936`，支持 `gb18030`。
 * 未列出的按 `windows-<页号>` 拼接（1250–1258 系列），无法识别的回退到 UTF-8。
 */
const CODE_PAGE_LABELS: Record<string, string> = {
  '932': 'shift_jis',
  '936': 'gb18030',
  '949': 'euc-kr',
  '950': 'big5',
  '65001': 'utf-8',
}

/** 探测结果只计算一次：代码页是机器属性，不随调用变化。 */
let cachedCharset: string | null = null

/**
 * 按运行时计算出的标签创建解码器。
 *
 * Bun 把标签类型收窄为字面量联合，而代码页在运行时计算，不属于该联合。
 * 类型断言的正确性由构造本身保证：无法识别的标签在此处立即抛出异常，调用方捕获后回退到 UTF-8，
 * 无效标签不会进入解码阶段。
 */
export function decoderFor(label: string): TextDecoder {
  return new TextDecoder(label as ConstructorParameters<typeof TextDecoder>[0])
}

/**
 * 本机原生程序向管道写入字节时使用的字符集，也是本机按「ANSI」保存的文本文件的编码。
 *
 * Windows 下读取注册表中的 ACP：`chcp` 取得的是控制台代码页，而 sidecar 由外壳启动时
 * 没有控制台，该方式的结果不稳定。探测失败、无法拼接标签或不是 Windows 时，
 * 一律按 UTF-8 处理。
 */
export function localCharset(): string {
  if (cachedCharset !== null) return cachedCharset
  cachedCharset = 'utf-8'
  if (process.platform !== 'win32') return cachedCharset
  try {
    const out = Bun.spawnSync([
      'reg',
      'query',
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage',
      '/v',
      'ACP',
    ])
    const page = new TextDecoder().decode(out.stdout).match(/ACP\s+REG_SZ\s+(\d+)/)?.[1]
    if (!page) return cachedCharset
    const label = CODE_PAGE_LABELS[page] ?? `windows-${page}`
    // 是否支持由 TextDecoder 判定，不要在此处另维护一份支持清单。
    decoderFor(label)
    cachedCharset = label
  } catch {
    // 保持 utf-8
  }
  return cachedCharset
}

/**
 * 未遇到换行时暂存字节的上限。超过时在 `isSafeCut` 的位置先行解码，
 * 不含换行的输出（单行的大段 JSON、二进制内容）不在内存中无限累积。
 */
const MAX_PENDING_BYTES = 64 * 1024

const LF = 0x0a
const CR = 0x0d

/**
 * 该字节之后可以切分。字节值小于 0x40 时，它在 UTF-8 中是单字节字符，在 GBK、Big5、Shift_JIS、
 * EUC-KR 中既不是双字节字符的首字节，也不是尾字节（尾字节最小为 0x40）。
 * 不要放宽为全部 ASCII：0x40–0x7E 在这些代码页中可以是尾字节，在该处切分会拆开一个字符。
 */
function isSafeCut(byte: number): boolean {
  return byte < 0x40
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
const lossyUtf8 = new TextDecoder('utf-8')

/**
 * 解码一段不跨行的字节。
 *
 * 判据是这一段中的证据：合法的非 ASCII UTF-8 字符多于非法序列时按 UTF-8 解码，非法处记为 U+FFFD；
 * 否则按本机代码页解码。按字节截断的命令（`cut -c`、`head -c`、`tail -c`）只在截断处留下一至三个
 * 非法字节，同一行的其余中文仍是合法 UTF-8；GBK 中文按 UTF-8 解码时几乎每个字都是非法序列。
 */
function decodeSegment(bytes: Uint8Array): string {
  try {
    return strictUtf8.decode(bytes)
  } catch {
    // 不是严格合法的 UTF-8，按下方的计数判定。
  }
  const lossy = lossyUtf8.decode(bytes)
  let valid = 0
  let invalid = 0
  for (const ch of lossy) {
    if (ch === '�') invalid++
    else if ((ch.codePointAt(0) ?? 0) >= 0x80) valid++
  }
  return valid > invalid ? lossy : decoderFor(localCharset()).decode(bytes)
}

/** 按行解码：先整体尝试严格 UTF-8，失败时逐行判定，一行中的截断不影响其他行。 */
function decodeLines(bytes: Uint8Array): string {
  try {
    return strictUtf8.decode(bytes)
  } catch {
    // 含非法序列，逐行判定。
  }
  let out = ''
  let start = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b !== LF && b !== CR) continue
    out += decodeSegment(bytes.subarray(start, i + 1))
    start = i + 1
  }
  if (start < bytes.length) out += decodeSegment(bytes.subarray(start))
  return out
}

function isAscii(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b >= 0x80) return false
  return true
}

export interface OutputDecoder {
  /**
   * 解码一片字节。完整的行立即解码；末尾不完整的一行全部是 ASCII 时立即解码，
   * 含非 ASCII 字节时暂存，等到换行、超过 `MAX_PENDING_BYTES` 或 `end` 时再解码。
   */
  write(chunk: Uint8Array): string
  /** 流结束时调用，解码暂存的字节。不调用时输出末尾不完整的一行会丢失。 */
  end(): string
}

/**
 * 子进程输出的解码器。
 *
 * 不能固定为 UTF-8：Windows 上原生程序按系统代码页输出字节（实测 `powershell`、
 * mingw 的 `curl` 均为 GBK），按 UTF-8 解码会得到大量 U+FFFD，模型会把这些乱码
 * 当作事实，据此做出错误判断，再用一整轮去证伪。也不能固定为代码页：
 * 同一台机器上 node、设置了 `PYTHONIOENCODING` 的 python 输出 UTF-8。
 *
 * 判定以行为单位（`decodeSegment`），不以整条流为单位：不要改为遇到第一个非法序列即整条流改用代码页。
 * UTF-8 输出中出现非法字节的常见原因是按字节截断，而不是换了编码；整条流切换时，截断处之后的
 * 全部中文都按代码页解码为乱码，模型据此读错文件内容与路径。
 * 切分位置只用 `\n`、`\r` 与 `isSafeCut`：它们在 UTF-8 与这些代码页中都不会落在一个字符的中间。
 */
export function makeOutputDecoder(): OutputDecoder {
  let pending = new Uint8Array(0)
  return {
    write(chunk) {
      const buf = new Uint8Array(pending.length + chunk.length)
      buf.set(pending)
      buf.set(chunk, pending.length)
      let cut = Math.max(buf.lastIndexOf(LF), buf.lastIndexOf(CR)) + 1
      if (cut === 0 && buf.length > MAX_PENDING_BYTES) {
        cut = buf.findLastIndex(isSafeCut) + 1 || buf.length
      }
      let out = cut > 0 ? decodeLines(buf.subarray(0, cut)) : ''
      pending = buf.slice(cut)
      if (isAscii(pending)) {
        out += lossyUtf8.decode(pending)
        pending = new Uint8Array(0)
      }
      return out
    },
    end() {
      const out = pending.length ? decodeSegment(pending) : ''
      pending = new Uint8Array(0)
      return out
    },
  }
}
