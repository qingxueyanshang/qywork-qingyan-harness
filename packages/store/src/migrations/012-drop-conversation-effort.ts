import type { Migration } from './shared.ts'

export const migration012: Migration = {
  id: 12,
  name: 'drop_conversation_effort',
  /**
   * 思考强度**恢复为单一配置项**，删除会话上的该列。
   *
   * 迁移 6 将它移到会话级，理由是模型是会话级的，思考强度应与模型同层。
   * 该理由不成立：它形成了第二条写入路径，输入区的 chip 写会话、设置页的下拉框写
   * `config.effort`，两处各自写入。结果是**在 chip 上选择的档位切换会话后即失效**，
   * 而设置页中的值看似仍在，两处都无法感知对方的修改。
   *
   * 档位不是会话属性：它是配置中与 model 同级的字段，每轮请求时读取。
   */
  sql: `ALTER TABLE conversations DROP COLUMN effort;`,
}
