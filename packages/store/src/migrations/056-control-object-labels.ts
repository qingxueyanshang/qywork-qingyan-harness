import type { Migration } from './shared.ts'

export const migration056: Migration = {
  id: 56,
  name: 'control_object_labels',
  /**
   * 两组控制类工具的对象名改为「电脑控制」「浏览器控制」，已写入磁盘的 step 同步转换。
   *
   * 对象名随 step 写入数据库，会话回放按写入的值拼接「动词 + 对象」。只修改工具声明时，
   * 同一会话中改名前后的步骤会显示两个不同的名称。
   *
   * 只转换这两组工具自身的 step：按工具名前缀限定，不按对象名全表替换，
   * 因为「浏览器」也可能是其他工具或插件声明的对象名。桌面工具没有具体目标时将对象名
   * 同时写入了 `target`，该字段一并转换。
   *
   * 一次性转换，不是兼容层：转换完成后，代码中没有分支识别旧名称。
   */
  sql: `
UPDATE steps
SET payload = json_set(payload, '$.action.objectLabel', '电脑控制')
WHERE tool_name LIKE 'desktop\\_%' ESCAPE '\\'
  AND json_extract(payload, '$.action.objectLabel') = '电脑操作';

UPDATE steps
SET payload = json_set(payload, '$.action.target', '电脑控制')
WHERE tool_name LIKE 'desktop\\_%' ESCAPE '\\'
  AND json_extract(payload, '$.action.target') = '电脑操作';

UPDATE steps
SET payload = json_set(payload, '$.action.objectLabel', '浏览器控制')
WHERE tool_name LIKE 'browser\\_%' ESCAPE '\\'
  AND json_extract(payload, '$.action.objectLabel') = '浏览器';
`,
}
