import type { Migration } from './shared.ts'

export const migration066: Migration = {
  id: 66,
  name: 'provider_request_occupancy_tokens',
  /**
   * 发出本次请求时运行中的上下文读数（`RunState.meter`：上一次回执的输入与输出加上其后的
   * 本地增量），即界面读数条显示的值。面板对尚无回执的请求直接读取本列，不重新计算。
   * NULL 表示摘要请求或迁移前的旧行；不回填。
   */
  sql: `ALTER TABLE provider_requests ADD COLUMN occupancy_tokens INTEGER;`,
}
