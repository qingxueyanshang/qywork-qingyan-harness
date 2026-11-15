import type { Migration } from './shared.ts'

export const migration075: Migration = {
  id: 75,
  name: 'provider_request_cloud_request_id',
  /**
   * 云端模型网关在响应头中返回的请求号，等于云端请求记录的 id，本机与云端按它对照同一次请求。
   * 不是经云端的请求或迁移前的旧行为 NULL；不回填。
   */
  sql: `ALTER TABLE provider_requests ADD COLUMN cloud_request_id TEXT;`,
}
