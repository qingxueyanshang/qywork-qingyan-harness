import type { Migration } from './shared.ts'

export const migration062: Migration = {
  id: 62,
  name: 'drop_permission_rules_and_audit',
  // 两张表没有任何读写方：权限裁决由 `Session.decide` 按模式与命令实时判定，不存储规则，也不记录审计。
  sql: `
DROP TABLE permission_rules;
DROP TABLE permission_audit;
`,
}
