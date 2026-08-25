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
 * 代价是切点可能落在字符中间——由 `clampBody` 的边界回退处理，
 * 模型看到的永远是合法 UTF-8。
 */

import type { ToolContext, ToolOutcome, ToolSpec } from '@qywork/agent'
import { badIntMessage, intArg } from './args.ts'
import { clampBody } from './sink.ts'

/** 单次读取的上限。与 sink 的投递预算一致，翻倍是因为这次是模型**主动**要的。 */
const MAX_READ_BYTES = 16 * 1024

export const readResourceTool: ToolSpec = {
  name: 'read_resource',
  description:
    '读取之前工具调用落盘的完整输出。当某次工具结果提示「完整输出已保存：rs_xxx」时，' +
    '用这个工具取回原始内容。知道要找什么就传 query 直接搜（返回命中行与行号），' +
    '要连续阅读才用 offset/length 分段。',
  parameters: {
    type: 'object',
    properties: {
      resource_id: { type: 'string', description: '资源 id，形如 rs_xxx' },
      offset: { type: 'integer', description: '起始字节偏移，默认 0' },
      length: {
        type: 'integer',
        description: `读取字节数，默认且最大 ${MAX_READ_BYTES}`,
      },
      query: {
        type: 'string',
        description:
          '在整份正文里搜这个子串，只返回命中的行（带行号与字节偏移）。' +
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

    const query = typeof args.query === 'string' ? args.query : ''
    if (query) return searchResource(ctx.sink, resourceId, stat.sizeBytes, query)

    // 两个数都必须先读得出整数：`NaN >= sizeBytes` 为假，越界那道闸门会被 NaN 穿过去。
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

    const length = Math.min(MAX_READ_BYTES, Math.max(1, rawLength), stat.sizeBytes - offset)

    const raw = ctx.sink.read(resourceId, offset, length)
    if (!raw) {
      return {
        status: 'failure',
        message: `正文读取失败：${resourceId}`,
        errorKind: 'resource_read_failed',
      }
    }

    // 走同一套边界回退，保证切点不落在多字节字符中间。
    // 这里预算给足，clampBody 不会再截，只做解码。
    const decoded = clampBody(raw, raw.byteLength)
    const nextOffset = offset + raw.byteLength
    const hasMore = nextOffset < stat.sizeBytes

    return {
      status: 'success',
      // 位置信息必须在 message 里而不只在 data 里：模型读的是 message。
      message: hasMore
        ? `已读取 ${offset}–${nextOffset} / ${stat.sizeBytes} 字节。后续用 offset=${nextOffset} 继续。`
        : `已读取 ${offset}–${nextOffset} / ${stat.sizeBytes} 字节（到末尾）。`,
      data: {
        content: decoded.text,
        offset,
        nextOffset: hasMore ? nextOffset : null,
        totalBytes: stat.sizeBytes,
        mimeType: stat.mimeType,
      },
    }
  },
}

/** 扫描步长。与内容库的分片大小对齐，避免一次读跨太多分片。 */
const SCAN_STEP = 256 * 1024

/**
 * 在整份正文里搜子串，返回命中的行。
 *
 * 加这个是因为实测发现：只给字节偏移的话，模型为了定位「第 2000 行」
 * 会连发五次 read_resource 手工二分猜偏移——每次都是一轮完整的模型往返。
 * 有了 query 一次就够。
 *
 * 流式扫描，任何时刻内存里只有一个步长加一行残片：
 * 正文可能有几百 MB，整块载入正是分片存储要避免的事。
 */
function searchResource(
  sink: NonNullable<ToolContext['sink']>,
  resourceId: string,
  totalBytes: number,
  query: string,
): ToolOutcome {
  const decoder = new TextDecoder('utf-8')
  const hits: { line: number; offset: number; text: string }[] = []
  let carry = ''
  // carry 的起始字节偏移。行内偏移靠它累加，不能用行号乘估算——行长不定。
  let carryStart = 0
  let lineNo = 0
  let budget = MAX_READ_BYTES
  let truncated = false

  for (let pos = 0; pos < totalBytes && !truncated; pos += SCAN_STEP) {
    const raw = sink.read(resourceId, pos, Math.min(SCAN_STEP, totalBytes - pos))
    if (!raw) break
    // stream:true 让跨步长边界的多字节字符正确续接，不产生替换符。
    const chunk = carry + decoder.decode(raw, { stream: true })
    const lines = chunk.split('\n')
    // 最后一段可能是半行，留给下一轮。
    carry = lines.pop() ?? ''

    let consumed = 0
    for (const line of lines) {
      lineNo++
      const lineOffset = carryStart + consumed
      consumed += Buffer.byteLength(line, 'utf8') + 1
      if (!line.includes(query)) continue
      const text = line.length > 500 ? `${line.slice(0, 500)}…` : line
      budget -= text.length
      if (budget <= 0) {
        truncated = true
        break
      }
      hits.push({ line: lineNo, offset: lineOffset, text })
    }
    carryStart += consumed
  }
  // 末尾没有换行符的最后一行也要参与匹配。
  if (!truncated && carry) {
    lineNo++
    if (carry.includes(query)) {
      hits.push({ line: lineNo, offset: carryStart, text: carry.slice(0, 500) })
    }
  }

  if (hits.length === 0) {
    return {
      status: 'success',
      // 没命中是**成功**不是失败：「确实不在里面」是有效结论。
      // 判失败等于告诉模型这个工具出了故障，它会重试或换路。
      message: `在 ${totalBytes.toLocaleString()} 字节里没有找到「${query}」（共 ${lineNo} 行）`,
      data: { hits: [], totalLines: lineNo, totalBytes },
    }
  }

  return {
    status: 'success',
    message:
      `命中 ${hits.length} 行${truncated ? '（已达输出上限，可能还有更多）' : ''}：\n` +
      hits.map((h) => `${h.line}: ${h.text}`).join('\n'),
    // offset 一并给出，模型想看命中行的上下文时可以直接拿它当 offset 再读一次。
    data: { hits, totalLines: lineNo, totalBytes, truncated },
  }
}
