/**
 * `read_resource` —— 把落盘的完整正文按需读回来。
 *
 * 这是 sink 的另一半。落盘只解决「不丢」，读回才解决「要用」：
 * 模型收到 8 KB 摘要和一个 resource_id 之后，如果发现需要中间那段，
 * 必须有办法拿到，否则落盘等于扔进黑洞。
 *
 * **为什么按字节偏移而不是按行。** 落盘的正文可能不是文本（下载的二进制、带 ANSI 控制符的输出）。
 * 按行分页要求先扫全文找换行符，那正是分片存储要避免的整块载入。
 * 字节偏移可以直接算出该读哪几个分片。
 *
 * **分页与搜索共用一条续读约定**：`nextOffset` 是本次实际消费到的字节位置，
 * 只有到达正文末尾才为 null；沿着它续读能把正文逐字拼回，不重不漏。
 *
 * **每一页从码点边界开始、到码点边界结束。** 起点落在码点中间时向后对齐到下一个码点起点，
 * `data.offset` 回报对齐后的实际起点。字节预算装不下一个完整码点时仍返回该码点——
 * 空页加上不变的 offset 会让沿 `nextOffset` 的续读停在原地。
 * 正文不是合法 UTF-8 时按字节前进，替换符如实出现：它此时是「这段不是文本」这个事实，
 * 页边可能因此丢弃不足一个码点的字节。
 */

import type { ToolContext, ToolOutcome, ToolSpec } from '@qywork/agent'
import { badIntMessage, intArg } from './args.ts'

/** 单次读取的上限。与 sink 的投递预算一致，翻倍是因为这次是模型**主动**要的。 */
const MAX_READ_BYTES = 16 * 1024

/** UTF-8 单个码点最长 4 字节：边界向前或向后的搜索范围都不超过 3 字节。 */
const MAX_UTF8_SPAN = 3

export const readResourceTool: ToolSpec = {
  name: 'read_resource',
  description:
    '读取之前工具调用落盘的完整输出。当某次工具结果提示「完整输出已保存：rs_xxx」时，' +
    '用这个工具取回原始内容。知道要找什么就传 query 直接搜（返回命中行、行号与命中处的字节偏移），' +
    '要连续阅读才用 offset/length 分段。两种读法都返回 nextOffset：' +
    '不为 null 就说明还没到末尾，原样传回 offset 继续。',
  parameters: {
    type: 'object',
    properties: {
      resource_id: { type: 'string', description: '资源 id，形如 rs_xxx' },
      offset: {
        type: 'integer',
        description: '起始字节偏移，默认 0。带 query 时是开始查找的位置。',
      },
      length: {
        type: 'integer',
        description: `读取字节数，默认且最大 ${MAX_READ_BYTES}。带 query 时不生效。`,
      },
      query: {
        type: 'string',
        description:
          '从 offset 开始搜这个子串，只返回命中的整行。' +
          '单行超过一页时只返回命中附近的片段（wholeLine 为 false），要整行就拿 lineOffset 当 offset 再读。' +
          '知道要找什么时优先用它，比猜 offset 快得多。',
      },
    },
    required: ['resource_id'],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '资源',
  category: 'session',
  facet: '中间内容',
  summary: '按区间读回落盘的大结果',
  targetExtractor: (a) => (typeof a.resource_id === 'string' ? a.resource_id : null),
  // 读的是本进程自己落盘的内容，不触碰工作区也不出网，没有需要用户批准的副作用。
  permissionEffect: 'internal_control',
  parallelSafe: true,
  resourceKeys: (a) => [`resource:${String(a.resource_id ?? '')}`],

  async fn(args, ctx) {
    const resourceId = String(args.resource_id ?? '').trim()
    if (!resourceId) return { status: 'failure', message: '缺少 resource_id' }

    if (!ctx.sink) {
      // 没有正文库时如实说，不要编一个「资源不存在」——后者会让模型把它当成 id
      // 写错，然后浪费几轮去猜正确的 id。
      return {
        status: 'failure',
        message: '本次执行没有启用正文库，无法读取落盘资源',
        errorKind: 'sink_unavailable',
      }
    }

    const stat = ctx.sink.stat(resourceId)
    if (!stat) {
      return {
        status: 'failure',
        message: `资源不存在或正文已被回收：${resourceId}`,
        errorKind: 'resource_not_found',
      }
    }

    // 两个数都必须先读得出整数：`NaN >= sizeBytes` 为假，越界那道闸门会被 NaN 穿过去。
    // 校验要在分流之前：搜索同样按 offset 起算，放进分支里就是让 query 绕开这道闸门。
    const rawOffset = intArg(args.offset, 0)
    const rawLength = intArg(args.length, MAX_READ_BYTES)
    if (rawOffset === null || rawLength === null) {
      const bad = rawOffset === null ? 'offset' : 'length'
      return {
        status: 'failure',
        message: badIntMessage(bad, args[bad]),
        errorKind: 'invalid_args',
      }
    }

    const offset = Math.max(0, rawOffset)
    if (offset >= stat.sizeBytes) {
      return {
        status: 'failure',
        message: `偏移 ${offset} 超出正文长度 ${stat.sizeBytes}`,
        errorKind: 'range_out_of_bounds',
      }
    }

    const query = typeof args.query === 'string' ? args.query : ''
    if (query) return searchResource(ctx.sink, resourceId, stat.sizeBytes, query, offset)

    const budget = Math.min(MAX_READ_BYTES, Math.max(1, rawLength))
    // 多读的两段各有用处：起点对齐最多跳 3 字节，预算内装不下一个完整码点时最多补 3 字节。
    const span = Math.min(budget + MAX_UTF8_SPAN * 2, stat.sizeBytes - offset)
    const raw = ctx.sink.read(resourceId, offset, span)
    if (!raw) return readFailure(resourceId)

    const start = offset + alignStart(raw)
    const page = decodePage(raw.subarray(start - offset), budget)
    const nextOffset = start + page.consumed
    const hasMore = nextOffset < stat.sizeBytes

    return {
      status: 'success',
      // 位置信息必须在 message 里而不只在 data 里：模型读的是 message。
      message: hasMore
        ? `已读取 ${start}–${nextOffset} / ${stat.sizeBytes} 字节。后续用 offset=${nextOffset} 继续。`
        : `已读取 ${start}–${nextOffset} / ${stat.sizeBytes} 字节（到末尾）。`,
      data: {
        content: page.text,
        offset: start,
        nextOffset: hasMore ? nextOffset : null,
        totalBytes: stat.sizeBytes,
        mimeType: stat.mimeType,
      },
    }
  },
}

function readFailure(resourceId: string): ToolOutcome {
  return {
    status: 'failure',
    message: `正文读取失败：${resourceId}`,
    errorKind: 'resource_read_failed',
  }
}

/** UTF-8 续字节形如 `10xxxxxx`，码点起点一定不是续字节。 */
function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

/**
 * 起点落在码点中间时要跳过的字节数。
 *
 * 连续超过 3 个续字节说明这段不是合法 UTF-8，跳过整段则无字节可读；
 * 两种情况都返回 0，按原起点宽松解码。
 */
function alignStart(bytes: Uint8Array): number {
  let skip = 0
  while (skip < bytes.byteLength && isContinuation(bytes[skip]!)) {
    skip++
    if (skip > MAX_UTF8_SPAN) return 0
  }
  return skip < bytes.byteLength ? skip : 0
}

/**
 * 从码点边界解出一页，返回文本与实际消费的字节数。`bytes` 必须从码点边界开始。
 *
 * 先在预算内找最靠后的码点边界；预算内一个完整码点都装不下时向后多取几字节把它补全，
 * 不要改成返回空页——调用方沿 `nextOffset` 续读会停在同一个偏移上。
 */
function decodePage(bytes: Uint8Array, budget: number): { text: string; consumed: number } {
  const strict = new TextDecoder('utf-8', { fatal: true })
  const capped = Math.min(budget, bytes.byteLength)
  for (let end = capped; end >= Math.max(1, capped - MAX_UTF8_SPAN); end--) {
    try {
      return { text: strict.decode(bytes.subarray(0, end)), consumed: end }
    } catch {
      // 切点还在码点中间，退一格再试。
    }
  }
  for (let end = capped + 1; end <= Math.min(bytes.byteLength, capped + MAX_UTF8_SPAN); end++) {
    try {
      return { text: strict.decode(bytes.subarray(0, end)), consumed: end }
    } catch {
      // 码点还没补全，多取一字节再试。
    }
  }
  const consumed = Math.max(1, capped)
  return { text: new TextDecoder('utf-8').decode(bytes.subarray(0, consumed)), consumed }
}

/** 扫描步长。与内容库的分片大小对齐，避免一次读跨太多分片。 */
const SCAN_STEP = 256 * 1024

/** 单行超过整页预算时，片段在命中位置两侧各留的字符数。 */
const HIT_CONTEXT_CHARS = 200

/**
 * 命中的一行。`offset` 是命中处的字节位置，`lineOffset` 是该行行首。
 *
 * `wholeLine` 为假时 `text` 是命中附近的片段：整行从 `lineOffset` 按字节读。它只说这一行
 * 给没给全，与搜索是否到达正文末尾（`nextOffset`）、原观察采集是否完整是三件事。
 */
interface Hit {
  line: number
  offset: number
  lineOffset: number
  text: string
  wholeLine: boolean
}

/**
 * 截出命中附近的文本。只用于单行超过整页预算的情形。
 *
 * 不要改成取行首若干字：命中可能在行尾，从行首截出来的那段里没有命中。
 * 两端截掉内容时补省略号。
 */
function hitWindow(line: string, index: number, matchLength: number): string {
  const from = Math.max(0, index - HIT_CONTEXT_CHARS)
  const to = Math.min(line.length, index + matchLength + HIT_CONTEXT_CHARS)
  const head = from > 0 ? '…' : ''
  const tail = to < line.length ? '…' : ''
  return `${head}${line.slice(from, to)}${tail}`
}

/**
 * 数 `[0, until)` 里的换行符，用来把命中行号保持在全文口径。
 *
 * 只比较字节：`0x0a` 不会作为多字节码点的一部分出现，不必解码。
 * 代价是 offset 不为 0 时多读一遍前缀，与本次扫描同量级。读失败返回 null。
 */
function countLinesBefore(
  sink: NonNullable<ToolContext['sink']>,
  resourceId: string,
  until: number,
): number | null {
  let count = 0
  for (let pos = 0; pos < until; pos += SCAN_STEP) {
    const raw = sink.read(resourceId, pos, Math.min(SCAN_STEP, until - pos))
    if (!raw) return null
    for (const byte of raw) if (byte === 0x0a) count++
  }
  return count
}

/**
 * 从 `offset` 起搜子串，按命中行返回，并给出续查位置。
 *
 * 加这个是因为实测发现：只给字节偏移的话，模型为了定位「第 2000 行」
 * 会连发五次 read_resource 手工二分猜偏移——每次都是一轮完整的模型往返。
 * 有了 query 一次就够。
 *
 * 流式扫描，任何时刻内存里只有一个步长加一行残片：
 * 正文可能有几百 MB，整块载入正是分片存储要避免的事。
 *
 * 输出量用满时停在**第一条尚未投递的命中所在行的行首**，把这个位置作为 `nextOffset`
 * 返回；下一页从那里接着查，已投递的命中都在它之前，因此不重不漏。
 *
 * 边界：`offset` 落在行中间时，该行只有 offset 之后的部分参与匹配，行号仍是全文口径。
 */
function searchResource(
  sink: NonNullable<ToolContext['sink']>,
  resourceId: string,
  totalBytes: number,
  query: string,
  offset: number,
): ToolOutcome {
  const before = countLinesBefore(sink, resourceId, offset)
  if (before === null) return readFailure(resourceId)

  const decoder = new TextDecoder('utf-8')
  const hits: Hit[] = []
  let lineNo = before
  let budget = MAX_READ_BYTES
  let nextOffset: number | null = null
  let start = offset
  let carry = ''
  let carryStart = offset

  /**
   * 收一行的命中：装得下就给整行，不从中间切开一条记录。
   *
   * 整行装不下剩余预算且本页已有命中时不收，返回 false，调用方以该行行首作为续查位置。
   * 本页第一条命中的整行仍装不下时，说明单行超过整页预算，只给命中附近的片段：
   * 否则续查会停在同一行。
   */
  const take = (line: string, lineStart: number): boolean => {
    lineNo++
    const index = line.indexOf(query)
    if (index < 0) return true
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (lineBytes > budget && hits.length > 0) return false
    const text = lineBytes <= budget ? line : hitWindow(line, index, query.length)
    budget -= Buffer.byteLength(text, 'utf8')
    hits.push({
      line: lineNo,
      offset: lineStart + Buffer.byteLength(line.slice(0, index), 'utf8'),
      lineOffset: lineStart,
      text,
      // 命中本身占满整行时片段就是整行。
      wholeLine: text === line,
    })
    return true
  }

  for (let pos = offset; pos < totalBytes && nextOffset === null; pos += SCAN_STEP) {
    const raw = sink.read(resourceId, pos, Math.min(SCAN_STEP, totalBytes - pos))
    if (!raw) return readFailure(resourceId)
    let slice = raw
    if (pos === offset) {
      // 起点对齐只跳续字节，而续字节里不会有换行符，行号口径不受影响。
      start = offset + alignStart(raw)
      carryStart = start
      slice = raw.subarray(start - offset)
    }
    // stream:true 让跨步长边界的多字节字符正确续接，不产生替换符。
    const chunk = carry + decoder.decode(slice, { stream: true })
    const lines = chunk.split('\n')
    // 最后一段可能是半行，留给下一轮。
    carry = lines.pop() ?? ''

    let consumed = 0
    for (const line of lines) {
      const lineStart = carryStart + consumed
      consumed += Buffer.byteLength(line, 'utf8') + 1
      if (!take(line, lineStart)) {
        nextOffset = lineStart
        break
      }
    }
    carryStart += consumed
  }
  // 末尾没有换行符的最后一行也要参与匹配。
  if (nextOffset === null && carry && !take(carry, carryStart)) nextOffset = carryStart

  const scannedTo = nextOffset ?? totalBytes
  const data = { hits, offset: start, nextOffset, totalBytes }
  if (hits.length === 0) {
    return {
      status: 'success',
      // 没命中是**成功**不是失败：「确实不在里面」是有效结论。
      // 判失败等于告诉模型这个工具出了故障，它会重试或换路。
      message: `在 ${start}–${scannedTo} / ${totalBytes} 字节里没有找到「${query}」`,
      data,
    }
  }

  return {
    status: 'success',
    // 只报数量和位置：命中正文在 data.hits 里，message 再印一遍等于同一份内容发两遍。
    message:
      `命中 ${hits.length} 行，已搜 ${start}–${scannedTo} / ${totalBytes} 字节。` +
      (nextOffset === null ? '已到正文末尾。' : `后续用 offset=${nextOffset} 继续搜索。`),
    data,
  }
}
