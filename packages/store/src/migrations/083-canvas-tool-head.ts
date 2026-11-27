import { type Migration, renameToolHeadBatch } from './shared.ts'

export const migration083: Migration = {
  id: 83,
  name: 'canvas_tool_head',
  /**
   * 画布类工具的开头由「画布读写」改为「画布控制」：这组工具除读取与修改画布外还运行生成、取回、取消、截取与导出。
   * 历史工具行的开头写在 payload 中（迁移 81），不改写时历史显示旧名称，与新写入的行和设置页的分组名不一致。
   * 分批执行，理由同迁移 81。
   */
  background: (db, _content, after) => renameToolHeadBatch(db, after, '画布读写', '画布控制'),
}
