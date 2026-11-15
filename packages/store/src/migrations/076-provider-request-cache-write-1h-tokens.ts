import type { Migration } from './shared.ts'

export const migration076: Migration = {
  id: 76,
  name: 'provider_request_cache_write_1h_tokens',
  /**
   * 缓存写入中按 1 小时档写入的部分，`provider_cache_write_tokens` 含该部分。上游未回报分档时为 NULL；
   * 迁移前的行没有分档记录，不回填。
   */
  sql: `ALTER TABLE provider_requests ADD COLUMN provider_cache_write_1h_tokens INTEGER;`,
}
