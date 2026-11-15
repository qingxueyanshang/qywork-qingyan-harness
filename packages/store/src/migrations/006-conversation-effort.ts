import type { Migration } from './shared.ts'

export const migration006: Migration = {
  id: 6,
  name: 'conversation_effort',
  /**
   * 思考强度移到会话级，结构与 `model` 完全一致。
   *
   * 迁移前只有 `config.effort` 一个全局值。主循环读取它（并非未接通的链路），
   * 但它与模型不在同一层级：模型是会话级的，一个会话切换到 Haiku 不影响另一个会话，
   * 而思考强度的切换是全局的。两个同级设置分处两层，修改一处会影响其他会话。
   *
   * `NULL` 表示跟随配置中的默认值，不表示关闭思考。因此此列不设 DEFAULT，
   * 设置后将无法区分用户显式选择的档位与尚未选择。
   */
  sql: `ALTER TABLE conversations ADD COLUMN effort TEXT;`,
}
