/**
 * `read_resource`：按需读取已落盘的完整正文。
 *
 * 本工具与 sink 配套。落盘只保证内容不丢失，读取才使内容可用：
 * 模型收到 8 KB 摘要与 resource_id 之后，若需要中间某段，
 * 必须能够取回，否则落盘没有意义。
 *
 * **按字节偏移而不是按行分页。** 落盘的正文可能不是文本（下载的二进制、带 ANSI 控制符的输出）。
 * 按行分页需要先扫描全文查找换行符，这正是分片存储要避免的整块载入。
 * 字节偏移可以直接算出应读取哪些分片。
 *
 * **分页与搜索共用同一续读约定**：`nextOffset` 是本次实际消费到的字节位置，
 * 只有到达正文末尾时才为 null；沿它续读可把正文逐字拼回，不重不漏。
 *
 * **每一页从码点边界开始、到码点边界结束。** 起点落在码点中间时向后对齐到下一个码点起点，
 * `data.offset` 返回对齐后的实际起点。字节预算不足一个完整码点时仍返回该码点：
 * 空页加上不变的 offset 会使沿 `nextOffset` 的续读停在原地。
 * 正文不是合法 UTF-8 时按字节前进，替换符如实出现，表示该段内容不是文本；
 * 页边界可能因此丢弃不足一个码点的字节。
 */

import {
  deliveryCap,
  headBytesWithin,
  outcomeTokens,
  recordBatchSpent,
  type ToolContext,
  type ToolOutcome,
  type ToolSpec,
  tokensToBytes,
  tokensToMaxBytes,
} from '@qywork/agent'
import { badIntMessage, intArg } from './args.ts'
import { MIN_DELIVERY_BYTES } from './sink.ts'

/**
 * 搜索时每页命中内容的字节上限。这是查询结果的分页约定，不是投递上限：
 * 连续阅读（不带 query）默认读取到末尾，只受本轮剩余额度约束。
 */
const SEARCH_PAGE_BYTES = 16 * 1024

/** UTF-8 单个码点最长 4 字节：边界向前或向后的搜索范围都不超过 3 字节。 */
const MAX_UTF8_SPAN = 3

export const readResourceTool: ToolSpec = {
  name: 'read_resource',
  description:
    '读取之前工具调用保存的完整输出。当某次工具结果提示「完整输出已保存：rs_xxx」时，' +
    '用本工具取回原始内容。已知查找目标时传 query 直接搜索（返回命中行、行号与命中处的字节偏移），' +
    '仅在需要连续阅读时使用 offset/length 分段读取。两种方式都返回 nextOffset：' +
    '不为 null 表示尚未到达末尾，将其原样作为 offset 传回以继续读取。',
  parameters: {
    type: 'object',
    properties: {
      resource_id: { type: 'string', description: '资源 id，形如 rs_xxx' },
      offset: {
        type: 'integer',
        description: '起始字节偏移，默认 0。带 query 时为开始查找的位置。',
      },
      length: {
        type: 'integer',
        description:
          '读取字节数，默认读取到末尾；超出上下文剩余空间时只返回可容纳的部分。带 query 时不生效。',
      },
      query: {
        type: 'string',
        description:
          '从 offset 开始搜索该子串，只返回命中的整行。' +
          '单行超过一页时只返回命中附近的片段（wholeLine 为 false），需要整行时以 lineOffset 作为 offset 再次读取。' +
          '已知查找目标时优先使用 query，比推测 offset 快得多。',
      },
    },
    required: ['resource_id'],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '资源',
  category: 'session',
  facet: '中间内容',
  summary: '按区间读取已保存的较长结果',
  targetExtractor: (a) => (typeof a.resource_id === 'string' ? a.resource_id : null),
  // 读取的是本进程自身落盘的内容，不访问工作区与网络，没有需要用户批准的副作用。
  permissionEffect: 'internal_control',
  parallelSafe: true,
  resourceKeys: (a) => [`resource:${String(a.resource_id ?? '')}`],

  async fn(args, ctx) {
    const resourceId = String(args.resource_id ?? '').trim()
    if (!resourceId) return { status: 'failure', message: '缺少 resource_id' }

    if (!ctx.sink) {
      // 没有正文库时如实报告，不要报告「资源不存在」：后者会使模型认为 id
      // 写错，进而花费多轮推测正确的 id。
      return {
        status: 'failure',
        message: '本次执行未启用正文库，无法读取已保存的资源',
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

    // 两个参数都必须先解析为整数：`NaN >= sizeBytes` 为假，NaN 会通过越界校验。
    // 校验必须在分支之前：搜索同样从 offset 起算，把校验放进分支会使带 query 的调用绕过越界校验。
    const rawOffset = intArg(args.offset, 0)
    const rawLength = intArg(args.length, stat.sizeBytes)
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
    // 先从余额中扣除位置说明与 data 其余字段的用量，再把剩余额度折算为正文字节。
    const frame = outcomeTokens(
      pageOutcome('', stat.sizeBytes, stat.sizeBytes - 1, stat.sizeBytes, stat.mimeType),
      ctx.density,
    )
    const room = Math.max(0, deliveryCap(ctx) - frame)
    if (query) {
      const found = searchResource(
        ctx.sink,
        resourceId,
        stat.sizeBytes,
        query,
        offset,
        Math.min(SEARCH_PAGE_BYTES, Math.max(tokensToBytes(room, ctx.density), MIN_DELIVERY_BYTES)),
      )
      recordBatchSpent(ctx, outcomeTokens(found, ctx.density))
      return found
    }

    /*
     * 先按字节上界读取一段，再按实际估算确定可容纳的字节数：保守折算对常用文本只能得到约一半。
     * 余量不足时仍投递最小的一份，不报告失败：报告失败的回合不产出正文。
     */
    const wanted = Math.min(
      Math.max(tokensToMaxBytes(room, ctx.density), MIN_DELIVERY_BYTES),
      Math.max(1, rawLength),
    )
    // 多读取的两段各有用途：起点对齐最多跳过 3 字节，预算不足一个完整码点时最多补足 3 字节。
    const span = Math.min(wanted + MAX_UTF8_SPAN * 2, stat.sizeBytes - offset)
    const raw = ctx.sink.read(resourceId, offset, span)
    if (!raw) return readFailure(resourceId)

    const start = offset + alignStart(raw)
    const body = raw.subarray(start - offset)
    const budget = Math.min(
      Math.max(headBytesWithin(body, room, ctx.density), MIN_DELIVERY_BYTES),
      Math.max(1, rawLength),
    )
    const page = decodePage(body, budget)
    const outcome = pageOutcome(
      page.text,
      start,
      start + page.consumed,
      stat.sizeBytes,
      stat.mimeType,
    )
    // 页长已按余额确定，此处记录实际投递量；码点补全最多多出 3 字节。
    recordBatchSpent(ctx, outcomeTokens(outcome, ctx.density))
    return outcome
  },
}

function pageOutcome(
  text: string,
  start: number,
  nextOffset: number,
  totalBytes: number,
  mimeType: string | null,
): ToolOutcome {
  const hasMore = nextOffset < totalBytes
  return {
    status: 'success',
    // 位置信息必须写在 message 中，而不只在 data 中：模型读取的是 message。
    message: hasMore
      ? `已读取 ${start}–${nextOffset} / ${totalBytes} 字节。后续用 offset=${nextOffset} 继续。`
      : `已读取 ${start}–${nextOffset} / ${totalBytes} 字节（到末尾）。`,
    data: {
      content: text,
      offset: start,
      nextOffset: hasMore ? nextOffset : null,
      totalBytes,
      mimeType,
    },
  }
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
 * 连续超过 3 个续字节说明该段不是合法 UTF-8；整段都是续字节时跳过后无字节可读。
 * 两种情况都返回 0，从原起点宽松解码。
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
 * 从码点边界解码一页，返回文本与实际消费的字节数。`bytes` 必须从码点边界开始。
 *
 * 先在预算内查找最靠后的码点边界；预算不足一个完整码点时向后多取几个字节将其补全。
 * 不要改为返回空页：调用方沿 `nextOffset` 续读会停在同一个偏移上。
 */
function decodePage(bytes: Uint8Array, budget: number): { text: string; consumed: number } {
  const strict = new TextDecoder('utf-8', { fatal: true })
  const capped = Math.min(budget, bytes.byteLength)
  for (let end = capped; end >= Math.max(1, capped - MAX_UTF8_SPAN); end--) {
    try {
      return { text: strict.decode(bytes.subarray(0, end)), consumed: end }
    } catch {
      // 切点仍在码点中间，后退一个字节重试。
    }
  }
  for (let end = capped + 1; end <= Math.min(bytes.byteLength, capped + MAX_UTF8_SPAN); end++) {
    try {
      return { text: strict.decode(bytes.subarray(0, end)), consumed: end }
    } catch {
      // 码点尚未补全，多取一个字节重试。
    }
  }
  const consumed = Math.max(1, capped)
  return { text: new TextDecoder('utf-8').decode(bytes.subarray(0, consumed)), consumed }
}

/** 扫描步长。与内容库的分片大小对齐，避免一次读取跨越过多分片。 */
const SCAN_STEP = 256 * 1024

/** 单行超过整页预算时，片段在命中位置两侧各留的字符数。 */
const HIT_CONTEXT_CHARS = 200

/**
 * 命中的一行。`offset` 是命中处的字节位置，`lineOffset` 是该行行首。
 *
 * `wholeLine` 为假时 `text` 是命中附近的片段，整行需从 `lineOffset` 按字节读取。它只表示该行
 * 是否完整返回，与搜索是否到达正文末尾（`nextOffset`）、原始观察采集是否完整相互独立。
 */
interface Hit {
  line: number
  offset: number
  lineOffset: number
  text: string
  wholeLine: boolean
}

/**
 * 截取命中附近的文本，只用于单行超过整页预算的情形。
 *
 * 不要改为截取行首若干字符：命中可能位于行尾，从行首截取的片段中不含命中。
 * 两端有内容被截掉时补省略号。
 */
function hitWindow(line: string, index: number, matchLength: number): string {
  const from = Math.max(0, index - HIT_CONTEXT_CHARS)
  const to = Math.min(line.length, index + matchLength + HIT_CONTEXT_CHARS)
  const head = from > 0 ? '…' : ''
  const tail = to < line.length ? '…' : ''
  return `${head}${line.slice(from, to)}${tail}`
}

/**
 * 统计 `[0, until)` 中的换行符，使命中行号按全文计算。
 *
 * 只比较字节：`0x0a` 不会作为多字节码点的一部分出现，无需解码。
 * 代价是 offset 不为 0 时多读取一遍前缀，开销与本次扫描同一量级。读取失败时返回 null。
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
 * 从 `offset` 起搜索子串，按命中行返回，并给出续查位置。
 *
 * 只提供字节偏移时，模型为定位「第 2000 行」会连续调用五次 read_resource
 * 手工二分查找偏移，每次都是一轮完整的模型往返（实测）。提供 query 后一次调用即可。
 *
 * 流式扫描，任何时刻内存中只有一个步长的数据加一行残片：
 * 正文可能有数百 MB，整块载入正是分片存储要避免的。
 *
 * 输出量用满时停在**第一条尚未投递的命中所在行的行首**，以该位置作为 `nextOffset`
 * 返回；下一页从该位置继续查找，已投递的命中都在它之前，因此不重不漏。
 *
 * 边界：`offset` 落在行中间时，该行只有 offset 之后的部分参与匹配，行号仍按全文计算。
 */
function searchResource(
  sink: NonNullable<ToolContext['sink']>,
  resourceId: string,
  totalBytes: number,
  query: string,
  offset: number,
  pageBytes: number,
): ToolOutcome {
  const before = countLinesBefore(sink, resourceId, offset)
  if (before === null) return readFailure(resourceId)

  const decoder = new TextDecoder('utf-8')
  const hits: Hit[] = []
  let lineNo = before
  let budget = pageBytes
  let nextOffset: number | null = null
  let start = offset
  let carry = ''
  let carryStart = offset

  /**
   * 收集一行的命中：未超出预算时返回整行，不从中间切开一条记录。
   *
   * 整行超出剩余预算且本页已有命中时不收集，返回 false，调用方以该行行首作为续查位置。
   * 本页第一条命中的整行仍超出预算时，说明单行超过整页预算，只返回命中附近的片段，
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
      // 片段覆盖整行时同样视为整行。
      wholeLine: text === line,
    })
    return true
  }

  for (let pos = offset; pos < totalBytes && nextOffset === null; pos += SCAN_STEP) {
    const raw = sink.read(resourceId, pos, Math.min(SCAN_STEP, totalBytes - pos))
    if (!raw) return readFailure(resourceId)
    let slice = raw
    if (pos === offset) {
      // 起点对齐只跳过续字节，续字节中不含换行符，行号计算不受影响。
      start = offset + alignStart(raw)
      carryStart = start
      slice = raw.subarray(start - offset)
    }
    // stream:true 使跨步长边界的多字节字符正确拼接，不产生替换符。
    const chunk = carry + decoder.decode(slice, { stream: true })
    const lines = chunk.split('\n')
    // 最后一段可能是不完整的行，留到下一轮处理。
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
  // 末尾没有换行符的最后一行同样参与匹配。
  if (nextOffset === null && carry && !take(carry, carryStart)) nextOffset = carryStart

  const scannedTo = nextOffset ?? totalBytes
  const data = { hits, offset: start, nextOffset, totalBytes }
  if (hits.length === 0) {
    return {
      status: 'success',
      // 未命中是**成功**而不是失败：「确实不包含」是有效结论。
      // 判为失败等于告诉模型工具出现故障，模型会重试或改用其他方式。
      message: `在 ${start}–${scannedTo} / ${totalBytes} 字节中未找到「${query}」`,
      data,
    }
  }

  return {
    status: 'success',
    // 只报告数量与位置：命中正文在 data.hits 中，message 中再列一遍会使同一内容发送两次。
    message:
      `命中 ${hits.length} 行，已搜索 ${start}–${scannedTo} / ${totalBytes} 字节。` +
      (nextOffset === null ? '已到正文末尾。' : `后续用 offset=${nextOffset} 继续搜索。`),
    data,
  }
}
