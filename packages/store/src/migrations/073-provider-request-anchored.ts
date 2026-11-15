import type { Migration } from './shared.ts'

export const migration073: Migration = {
  id: 73,
  name: 'provider_request_anchored',
  /**
   * 回执能否作为占用锚点由对话循环收尾时判定并写入该列（`agent` 的 `settleResponse`），下一轮的起点与面板
   * 按该列选取（`latestAnchoredProviderRequest`），不各自判定。已有行按迁移前的判据回填：用量大于 0，
   * 且输入量不超过请求字节数。
   */
  sql: `
ALTER TABLE provider_requests ADD COLUMN anchored INTEGER NOT NULL DEFAULT 0;
UPDATE provider_requests SET anchored = 1
 WHERE purpose = 'turn' AND provider_input_tokens IS NOT NULL
   AND COALESCE(provider_input_tokens, 0) + COALESCE(provider_output_tokens, 0)
     + COALESCE(provider_cached_tokens, 0) + COALESCE(provider_cache_write_tokens, 0) > 0
   AND COALESCE(provider_input_tokens, 0) + COALESCE(provider_cached_tokens, 0)
     + COALESCE(provider_cache_write_tokens, 0) <= request_bytes;
`,
}
