import type { Migration } from './shared.ts'

export const migration058: Migration = {
  id: 58,
  name: 'provider_request_headers_at',
  /**
   * 观察到响应头到达的时刻。它与 `first_event_at` 含义不同：响应头已到达而首个
   * 协议事件未到达的区间，是接口接受请求之后、模型产出之前的等待，只有本列能将其
   * 与连接尚未建立区分开。NULL 表示迁移前的旧行或响应头未到达。
   */
  sql: `ALTER TABLE provider_requests ADD COLUMN headers_at INTEGER;`,
}
