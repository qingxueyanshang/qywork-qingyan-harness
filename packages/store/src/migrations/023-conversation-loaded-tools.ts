import type { Migration } from './shared.ts'

export const migration023: Migration = {
  id: 23,
  name: 'conversation_loaded_tools',
  /**
   * 记录会话已加载到工具表中的外部工具。
   *
   * **必须写入磁盘。** 服务端**每条消息新建一个 Session**，进程内已加载集合的生命周期
   * 不超过该条消息。不写入磁盘时模型每一轮都需重新 `load_tool`：它在 transcript 中看到上一轮已加载、
   * 工具表中却没有，会反复尝试。每轮固定一次的往返开销高于全部常驻，按需加载因此失去意义。
   *
   * 主键 (conversation_id, tool_name)：同一工具加载两次视为同一操作，
   * `INSERT OR IGNORE` 依赖该约束。主键同时充当外键的索引
   * （级联删除按 conversation_id 前缀查找），因此不另建索引。
   *
   * 存储的是**注册名**（`mcp__<server>__<tool>` / `<插件id>__<tool>`），
   * 即模型调用时使用的名称，也是待加载池中的键。
   */
  sql: /* sql */ `
CREATE TABLE conversation_loaded_tools (
  conversation_id TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tool_name       TEXT    NOT NULL,
  loaded_at       INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, tool_name)
);
`,
}
