import type { Migration } from './shared.ts'

export const migration060: Migration = {
  id: 60,
  name: 'provider_request_last_content_at',
  /**
   * 观察到最后一段非空正文、思考或新增工具参数到达的时刻。
   * `first_content_at` 无法反映当前已静默多久：持续输出时首个内容的时刻与当前的间隔不断增大。
   * 心跳、空 delta、响应头与用量都不更新本列。NULL 表示迁移前的旧行或本次尚无内容。
   */
  sql: `ALTER TABLE provider_requests ADD COLUMN last_content_at INTEGER;`,
}
