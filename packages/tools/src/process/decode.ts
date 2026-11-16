/** 子进程输出的解码：先按 UTF-8 解码，遇到非法序列时改用本机代码页。 */

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
function decoderFor(label: string): TextDecoder {
  return new TextDecoder(label as ConstructorParameters<typeof TextDecoder>[0])
}

/**
 * 本机原生程序向管道写入字节时使用的字符集。
 *
 * Windows 下读取注册表中的 ACP：`chcp` 取得的是控制台代码页，而 sidecar 由外壳启动时
 * 没有控制台，该方式的结果不稳定。探测失败、无法拼接标签或不是 Windows 时，
 * 一律按 UTF-8 处理。
 */
function consoleCharset(): string {
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
 * 子进程输出的解码器。
 *
 * 不能固定为 UTF-8：Windows 上原生程序按系统代码页输出字节（实测 `powershell`、
 * mingw 的 `curl` 均为 GBK），按 UTF-8 解码会得到大量 U+FFFD，模型会把这些乱码
 * 当作事实，据此做出错误判断，再用一整轮去证伪。也不能固定为代码页：
 * 同一台机器上 node、设置了 `PYTHONIOENCODING` 的 python 输出 UTF-8。
 *
 * 判据是字节本身：严格 UTF-8 解码器对跨片的不完整字符不抛出异常（`{ stream: true }` 会把
 * 它保留在内部缓冲中），只对非法序列抛出异常。抛出异常即说明该流不是 UTF-8。
 *
 * 判定后不再切换回 UTF-8。同一条流中交替出现两种编码不是实际场景，而反复切换会截断跨片
 * 字符。代价是切换时缓冲中至多三个字节的不完整字符会丢失，不为此增加第二套缓冲。
 */
export function makeOutputDecoder(): (chunk: Uint8Array) => string {
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  let fallback: TextDecoder | null = null
  return (chunk) => {
    if (fallback) return fallback.decode(chunk, { stream: true })
    try {
      return utf8.decode(chunk, { stream: true })
    } catch {
      fallback = decoderFor(consoleCharset())
      return fallback.decode(chunk, { stream: true })
    }
  }
}
