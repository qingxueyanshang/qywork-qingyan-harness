/** 按 `read_file` 的投递格式估算读取整个文本文件所需的 token 数。读取工具与附件说明共用，两处写出的估算一致。 */

import { deliveredTokens } from '@qywork/agent'
import type { TokenDensity } from '@qywork/ai'

/**
 * 正文按样本行的投递估算与字节数之比换算到整个文件，行号前缀按行数另计。
 *
 * 行号不要并入按字节换算的部分：开头的样本行号位数少，并入后估算偏低；也不要省略行号与 JSON 转义，
 * 按默认档每行约 10 token，九千行的文件只计正文时比实际读取少约四分之一，模型据此会判断为能放入剩余空间。
 * `totalBytes` 与样本同为 UTF-8 字节数；样本为空时返回 0。
 */
export function readTokens(
  sample: readonly string[],
  totalBytes: number,
  totalLines: number,
  density: TokenDensity,
): number {
  const text = sample.join('\n')
  const sampleBytes = Buffer.byteLength(text)
  if (sampleBytes === 0) return 0
  const k = Math.min(sample.length, 1000)
  const perPrefix = deliveredTokens(JSON.stringify(`${totalLines}\t`.repeat(k)), density) / k
  return Math.round(
    (deliveredTokens(JSON.stringify(text), density) * totalBytes) / sampleBytes +
      perPrefix * totalLines,
  )
}
