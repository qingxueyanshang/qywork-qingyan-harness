import { type Migration, renameToolHeadBatch } from './shared.ts'

export const migration084: Migration = {
  id: 84,
  name: 'web_tool_head',
  /**
   * 网页搜索与获取两个工具的开头由「网络访问」改为「联网搜索」：「网络访问」范围大于这组工具（命令与网页控制同样访问网络），
   * 且与设置页的权限名称「网络访问」重名。历史工具行的开头写在 payload 中（迁移 81），理由与分批执行同迁移 83。
   */
  background: (db, _content, after) => renameToolHeadBatch(db, after, '网络访问', '联网搜索'),
}
