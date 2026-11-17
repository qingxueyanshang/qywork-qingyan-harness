import type { Migration } from './shared.ts'

export const migration021: Migration = {
  id: 21,
  name: 'memory_tool_split',
  /**
   * `memory` 一个工具名对应四个动作，拆分为 `read_memory` / `write_memory` /
   * `delete_memory` 三个工具，**已落库的旧行按行内的 `args.action` 分别改名**。
   *
   * 不转换时不会报错：回放历史时模型会取得当前工具表中不存在的名称
   * （`transcript.ts` 将账本中的 `tool_name` 与 `args` 原样重放为一次工具调用）。
   *
   * `list` 归入 `read_memory`：语义最接近，且该动作已不再是工具，
   * 全部 key 每轮都列在上下文末尾。缺少 `action` 或值非法的行一并归入：这些行
   * 无法确定动作，归为读取最稳妥。
   *
   * **`args.action` 一并删除。** 改名后该行已不是原调用的
   * 逐字记录，保留该字段会呈现一个当前不合法的调用结构：三个新 schema 都是
   * `additionalProperties: false`，模型仿照历史写入一个 `action` 会浪费一轮请求。
   * 一条 UPDATE 中有两个赋值：SQL 赋值右侧读取的是修改前的行，因此新名称仍由旧
   * `action` 计算。
   *
   * 幂等：转换完成后不存在 `tool_name = 'memory'` 的行，重复执行命中零行。
   */
  sql: `
UPDATE steps
SET tool_name = CASE json_extract(payload, '$.args.action')
    WHEN 'write'  THEN 'write_memory'
    WHEN 'delete' THEN 'delete_memory'
    ELSE 'read_memory'
  END,
  payload = json_remove(payload, '$.args.action')
WHERE tool_name = 'memory';
`,
}
