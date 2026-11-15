import type { Migration } from './shared.ts'

export const migration077: Migration = {
  id: 77,
  name: 'request_envelopes',
  /**
   * 请求信封的明细（`monitor/envelopes.ts`），键为请求行的 `cache_route_fingerprint`，同一指纹一行。
   * 主请求写入时该指纹尚无明细才写入；迁移前的请求没有明细，不回填。
   * 指纹列的索引供删除会话时判定明细是否仍被引用，无索引时每行判定都是全表扫描。
   */
  sql: `
CREATE TABLE request_envelopes (
  fingerprint TEXT PRIMARY KEY,
  items       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_provider_fingerprint ON provider_requests(cache_route_fingerprint);
`,
}
