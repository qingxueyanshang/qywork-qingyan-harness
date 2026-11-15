import type { Migration } from './shared.ts'

export const migration063: Migration = {
  id: 63,
  name: 'drop_conversation_extras',
  // 没有读写方：会话装配不再按会话关闭技能 / 记忆 / 扩展工具，界面也没有入口。
  sql: `DROP TABLE conversation_extras;`,
}
