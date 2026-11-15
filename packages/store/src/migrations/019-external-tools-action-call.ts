import type { Migration } from './shared.ts'

export const migration019: Migration = {
  id: 19,
  name: 'external_tools_action_call',
  /**
   * MCP 与插件工具的动作改为动作轴上的新值 `call`，**已写入磁盘的行同步转换**。
   *
   * 不转换时不会报错：回放历史会话时，同一个 MCP 工具的旧行显示「运行」
   * （destructive 工具显示「删除」，两个 resource 工具显示「读取」），
   * 而当前调用记录为「调用」，同一件事在同一条时间线上有两种说法。
   *
   * **判据是工具名中的 `__`。** 双下划线只由两条命名路径产生：
   * `mcp__<server>__<tool>` 与插件的 `<id>__<tool>`；内置工具名均不含双下划线
   * （`read_file` / `write_todos` / `run_command` 等是单下划线）。
   * 因此含 `__` 等价于外置工具的调用，无需另外维护内置工具名单；
   * 该名单是第二本账，每增加一个内置工具都必须同步修改。
   *
   * **不按旧值筛选，一律改写。** 存量行中外置工具记录过 run（普通 MCP 工具）、
   * delete（destructive hint）、read（两个 resource 工具），以及插件清单自行声明的
   * 任意值；当前它们全部归为 call，因此转换目标只由产生者决定。
   *
   * 幂等：转换完成后再次执行命中相同的行，写入的仍是 `call`。
   * 没有 `action` 的行由 WHERE 排除：否则 `json_set` 会为其新增一个键。
   */
  sql: `
UPDATE steps
SET payload = json_set(payload, '$.action.kind', 'call')
WHERE tool_name IS NOT NULL
  AND instr(tool_name, '__') > 0
  AND json_extract(payload, '$.action.kind') IS NOT NULL;
`,
}
