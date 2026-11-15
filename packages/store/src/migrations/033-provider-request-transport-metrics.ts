import type { Migration } from './shared.ts'

export const migration033: Migration = {
  id: 33,
  name: 'provider_request_transport_metrics',
  /**
   * 只记录传输层的观测数据，不保存请求正文：接口/协议用于区分路线，字节数与四个时刻
   * 用于区分请求体积膨胀、首包等待与生成阶段。NULL 表示迁移前的旧行，无数据时不写 0。
   */
  sql: `
ALTER TABLE provider_requests ADD COLUMN provider_name TEXT;
ALTER TABLE provider_requests ADD COLUMN provider_kind TEXT;
ALTER TABLE provider_requests ADD COLUMN request_bytes INTEGER;
ALTER TABLE provider_requests ADD COLUMN first_event_at INTEGER;
ALTER TABLE provider_requests ADD COLUMN first_content_at INTEGER;
ALTER TABLE provider_requests ADD COLUMN completed_at INTEGER;
`,
}
