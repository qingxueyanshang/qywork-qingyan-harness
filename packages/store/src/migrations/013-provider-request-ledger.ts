import type { Migration } from './shared.ts'

export const migration013: Migration = {
  id: 13,
  name: 'provider_request_ledger',
  /**
   * 接通逐请求账本，同时删除 `runs` 上的三列。
   *
   * `provider_requests` 建于迁移 1，但一直没有读写，面板只能读取 `runs.context_tokens`；
   * 而这三列每个 step 覆盖一次，一个 run 只保留最后一次请求的读数，
   * 账本中无法得知本轮上下文的增长过程。
   *
   * 增加一列，删除三列：
   *
   * - 增加 `omitted_categories`：面板需要说明哪些内容被省略。压缩将历史替换为摘要、
   *   将工具结果替换为定位符之后，原文仍在账本中，只是未进入本次请求；
   *   该列记录的就是这部分。只有 `sent_categories` 时账目不完整。
   * - 删除 `runs` 的 `context_tokens/limit/percent`：真源改为本表之后，它们就是
   *   第二本账，两本账终将不一致。保留空列不构成兼容，只会留下被误用的可能
   *   （与迁移 5 的处理一致）。
   */
  sql: `
ALTER TABLE provider_requests ADD COLUMN omitted_categories TEXT NOT NULL DEFAULT '{}';
ALTER TABLE runs DROP COLUMN context_tokens;
ALTER TABLE runs DROP COLUMN context_limit;
ALTER TABLE runs DROP COLUMN context_percent;
`,
}
