/**
 * 中间资源投递闸。移植自原版 `resource_sink.py` + `execution/result_authority.py`。
 *
 * ## 判据不是「大」，是「不可重放」
 *
 * 这是整个模块最容易搞错的一点，原版用两张工具名表把它钉死了：
 *
 * - **本地权威**（`read_file` / `grep` / `list_dir` …）：完整正文就在工作区里。
 *   历史被压缩掉之后，模型再读一遍就是了。**这类结果不进 sink**，
 *   哪怕它有 10 MB —— 落一份盘只是把同一份数据存两遍。
 * - **内容权威**（`web_fetch` / `web_search` / `run_command` …）：字节**无法重建**。
 *   那个网页此刻抓到的样子、那条命令这一次的输出，过去了就没了。
 *   这类**必须**先落盘再把有界摘要发给模型。
 *
 * 按「超过 N KB 就落盘」来判会同时犯两个方向的错：把可重放的源码文件存成副本，
 * 又漏掉那些不大但不可重建的东西（一次 200 行的 web_search 结果）。
 *
 * ## 为什么模型必须知道自己看到的是截断的
 *
 * 投递给模型的是摘要 + `resource_id` + **覆盖事实**（投了多少 / 一共多少 / 截没截）。
 * 少了覆盖事实，模型会把 4 KB 摘要当成 2.3 MB 的全部，然后基于不完整信息下结论——
 * 那比根本不给它更糟，因为它不知道自己不知道。
 */

import type { SinkPort } from '@qywork/agent'
import type { ResourceCoverage, ResourceStatus } from '@qywork/core'

export type { SinkPort }

/**
 * 结果的完整正文已经在工作区里、可以随时重读的工具。
 *
 * 加新工具时想清楚：**它的输出能不能靠再调一次原样拿回来？** 能，就进这张表。
 * 判错的方向是不对称的——误列进来会导致压缩后信息永久丢失（不可重建却没落盘），
 * 误列出去只是多存一份。所以拿不准时**不要**列进来。
 */
export const LOCAL_AUTHORITY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'read_memory',
  'read_skill',
  'list_skills',
])

/**
 * 产出不可重建正文的工具。
 *
 * `mcp__` 前缀一律按此处理：第三方 MCP 工具的可重放性我们无从判断，
 * 保守假设它不可重放。
 */
export const CONTENT_AUTHORITY_TOOLS: ReadonlySet<string> = new Set([
  'run_command',
  'web_fetch',
  'web_search',
])

export function isContentAuthority(toolName: string): boolean {
  return CONTENT_AUTHORITY_TOOLS.has(toolName) || toolName.startsWith('mcp__')
}

/**
 * 投递给模型的正文上限（字节）。
 *
 * **它现在是「摘录多长」，不再是「容量闸」。** 容量那一半已经移交给
 * `chargeBatchBudget`（`@qywork/agent`）——那条按模型窗口算、还管一整个波次的
 * 累计量，而这里是一个与窗口无关的常数，当闸用的话在 200k 和 1M 上是两个意思。
 *
 * 所以**不要把它改成窗口比例**：摘录长度是可读性问题（头尾各留一半，
 * 错误信息通常在尾部），不是容量问题。8 KB 的依据仍然是实测——
 * 常见构建/测试输出在 2–6 KB，这个长度能容下绝大多数命令的完整输出。
 * 真正超长的那些走 sink 落盘，模型拿 `resource_id` 按需回读。
 */
export const INLINE_BUDGET_BYTES = 8 * 1024

/** 头尾各留一半：错误信息通常在尾部（stack trace、exit code），只留头部会把它切掉。 */
const HEAD_RATIO = 0.6

export interface LandedResult {
  /** 投递给模型的正文。 */
  text: string
  /** 落盘了才有；未落盘时为 null。 */
  resourceId: string | null
  coverage: ResourceCoverage
  status: ResourceStatus
}

/**
 * 按预算裁剪正文，并给出覆盖事实。
 *
 * 裁剪的是**字节**不是字符，但切点必须落在 UTF-8 字符边界上——
 * 从中间切开一个多字节字符会产生 U+FFFD 替换符，模型读到的是乱码，
 * 而且乱码位置恰好在最需要看清的地方（截断处）。
 */
export function clampBody(
  body: Uint8Array,
  budget = INLINE_BUDGET_BYTES,
): {
  text: string
  truncated: boolean
  deliveredBytes: number
} {
  const decoder = new TextDecoder('utf-8')
  if (body.byteLength <= budget) {
    return { text: decoder.decode(body), truncated: false, deliveredBytes: body.byteLength }
  }

  const headBytes = Math.floor(budget * HEAD_RATIO)
  const tailBytes = budget - headBytes
  const head = decodeAtBoundary(body.subarray(0, headBytes), 'head')
  const tail = decodeAtBoundary(body.subarray(body.byteLength - tailBytes), 'tail')
  const omitted = body.byteLength - headBytes - tailBytes

  return {
    text: `${head}\n\n… 中间省略 ${omitted.toLocaleString()} 字节 …\n\n${tail}`,
    truncated: true,
    deliveredBytes: headBytes + tailBytes,
  }
}

/**
 * 在 UTF-8 字符边界上解码。
 *
 * 从头切时丢弃末尾不完整的字符，从尾切时丢弃开头不完整的字符。
 * 用 `fatal: true` 逐步回退比自己数续字节位更可靠——续字节的判定规则
 * 在四字节字符和代理对上很容易写错。
 */
function decodeAtBoundary(slice: Uint8Array, side: 'head' | 'tail'): string {
  const strict = new TextDecoder('utf-8', { fatal: true })
  // 最多回退 3 字节：UTF-8 单字符最长 4 字节。
  for (let back = 0; back <= 3 && back < slice.byteLength; back++) {
    const candidate =
      side === 'head' ? slice.subarray(0, slice.byteLength - back) : slice.subarray(back)
    try {
      return strict.decode(candidate)
    } catch {
      // 还在字符中间，再退一格。
    }
  }
  // 四次都失败说明这段根本不是合法 UTF-8（二进制输出）。宽松解码，让替换符如实出现——
  // 它此时是真实信息：「这里不是文本」。
  return new TextDecoder('utf-8').decode(slice)
}

/**
 * 工具产出的统一投递入口。
 *
 * 三条分支：
 * 1. **本地权威工具** —— 原样返回，不落盘。正文可重读，存副本没意义。
 * 2. **内容权威 + 未超预算** —— 原样返回，也不落盘。完整正文已经在上下文里，
 *    再存一份只在「将来被压缩掉」时才有用，而那时压缩层会自己决定要不要固化。
 * 3. **内容权威 + 超预算** —— 落盘，返回头尾摘要 + resource_id + 覆盖事实。
 *
 * 分支 2 是原版的口径，容易被误改成「内容权威一律落盘」。那样每条 `ls` 都会
 * 在正文库里留一行，GC 压力和写放大都不划算。
 */
export function deliver(
  sink: SinkPort | null,
  input: {
    toolName: string
    sourceType: string
    body: Uint8Array
    mimeType?: string | null
    query?: string
    budget?: number
  },
): LandedResult {
  const budget = input.budget ?? INLINE_BUDGET_BYTES
  const clamped = clampBody(input.body, budget)

  const baseCoverage: ResourceCoverage = {
    deliveredBytes: clamped.deliveredBytes,
    totalBytes: input.body.byteLength,
    truncated: clamped.truncated,
    ...(input.query ? { query: input.query } : {}),
  }

  if (!clamped.truncated || !isContentAuthority(input.toolName) || !sink) {
    // 没截断就没有「看不到的部分」，不需要 resource；
    // 本地权威工具即使截断了也不落盘——模型可以自己再读一次。
    return {
      text: clamped.text,
      resourceId: null,
      coverage: baseCoverage,
      status: 'complete',
    }
  }

  try {
    const landed = sink.land({
      toolName: input.toolName,
      sourceType: input.sourceType,
      body: input.body,
      mimeType: input.mimeType ?? null,
      coverage: baseCoverage,
    })
    return {
      text: `${clamped.text}\n\n[完整输出已保存：${landed.resourceId}，共 ${input.body.byteLength.toLocaleString()} 字节。用 read_resource 读取。]`,
      resourceId: landed.resourceId,
      coverage: baseCoverage,
      status: 'complete',
    }
  } catch (err) {
    // 落盘失败不能把工具调用整体判失败——正文的头尾摘要仍然有效，
    // 模型拿着它照样能继续。但**必须**告诉模型完整正文拿不到了，
    // 否则它会去调 read_resource 然后撞一个不存在的 id。
    return {
      text: `${clamped.text}\n\n[完整输出保存失败：${err instanceof Error ? err.message : String(err)}。只有上面这段可用。]`,
      resourceId: null,
      coverage: { ...baseCoverage, landFailed: true },
      status: 'partial',
    }
  }
}
