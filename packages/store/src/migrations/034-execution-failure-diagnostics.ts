import type { Migration } from './shared.ts'

export const migration034: Migration = {
  id: 34,
  name: 'execution_failure_diagnostics',
  /**
   * 补齐两项此前只存在于进程内的事实：run 由谁中断，以及 provider 失败后
   * 重发或不重发的原因。两列都存 JSON，因为它们是同一事实的结构化详情，
   * 不是供 SQL 聚合的第二套状态；终态仍由 runs / provider_requests 的原有列负责。
   */
  sql: `
ALTER TABLE runs ADD COLUMN interruption_detail TEXT;
ALTER TABLE provider_requests ADD COLUMN diagnostic TEXT;
`,
}
