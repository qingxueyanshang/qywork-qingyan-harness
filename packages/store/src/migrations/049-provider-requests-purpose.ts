import type { Migration } from './shared.ts'

export const migration049: Migration = {
  id: 49,
  name: 'provider_requests_purpose',
  /**
   * 轮内压缩产生的摘要请求按本轮的普通请求写入（占用一个 turn 编号，usage 计入本轮），
   * 以本列与主请求区分：上下文锚点、命中率只统计 turn，摘要长度统计只统计 summary。
   * 旧行均为主请求。
   */
  sql: `
ALTER TABLE provider_requests ADD COLUMN purpose TEXT NOT NULL DEFAULT 'turn' CHECK (purpose IN ('turn','summary'));
`,
}
