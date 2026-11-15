import type { Migration } from './shared.ts'

export const migration069: Migration = {
  id: 69,
  name: 'provider_request_hedge',
  /**
   * 响应头之前补发的第二份请求：发出时刻，以及最终采用的是否为它（0/1）。两份请求都已发出、都可能计费，
   * 逐请求表据此与服务商账单对照。NULL 表示未补发或迁移前的旧行；不回填。
   */
  sql: `
ALTER TABLE provider_requests ADD COLUMN hedge_sent_at INTEGER;
ALTER TABLE provider_requests ADD COLUMN hedge_won INTEGER;
`,
}
