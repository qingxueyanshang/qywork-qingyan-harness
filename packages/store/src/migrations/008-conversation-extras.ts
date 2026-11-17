import type { Migration } from './shared.ts'

export const migration008: Migration = {
  id: 8,
  name: 'conversation_extras',
  /**
   * 会话级的技能 / MCP / 插件 / 记忆关闭项。
   *
   * **必须写入磁盘，不能只存于内存。** 关闭项需要在重启后保留：关闭某个 MCP 后重启应用，
   * 若该 MCP 重新出现，等同于开关未生效。关闭项只属于当前会话，写入全局配置会变成另一种语义，
   * 因此只能单独建表。
   *
   * **只存已关闭项，不存已开启项。** 默认全部开启，没有行即全部开启。反向存储时，每安装一个新技
   * 能都要为所有历史会话补写一行；遗漏补写会使新安装的技能在旧会话中不生效，
   * 且这一路径缺少检查。
   *
   * `key` 形如 `skill:release` / `mcp:github` / `plugin:foo` / `memory:style`，
   * 前缀即类目。不拆成两列：本表只按会话读取全集，
   * 拆开只会增加一个 join 条件。
   */
  sql: `
CREATE TABLE conversation_extras (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  PRIMARY KEY (conversation_id, key)
);
`,
}
