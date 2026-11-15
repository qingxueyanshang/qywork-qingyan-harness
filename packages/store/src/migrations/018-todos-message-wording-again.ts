import type { Migration } from './shared.ts'

export const migration018: Migration = {
  id: 18,
  name: 'todos_message_wording_again',
  /**
   * 再次转换待办回执中的「计划已更新」：迁移 16 只覆盖其执行时已有的行，
   * 而回执文案晚于动作轴修改，其间运行的轮次写入了新动作与旧文案的组合
   * （卡片标题为「创建待办」，展开内容为「计划已更新（1/3）」）。
   *
   * 幂等：转换完成后不存在以「计划已更新」开头的回执，重复执行命中零行。
   */
  sql: `
UPDATE steps
SET payload = json_set(
  payload,
  '$.outcome.message',
  replace(json_extract(payload, '$.outcome.message'), '计划已更新', '待办已更新')
)
WHERE json_extract(payload, '$.outcome.message') LIKE '计划已更新%';
`,
}
