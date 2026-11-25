import type { Migration } from './shared.ts'

export const migration080: Migration = {
  id: 80,
  name: 'workspace_panel',
  /**
   * 右侧面板中各客户端共享的页签（画布、文件预览、插件工作台）与最近查看的文件，按工作区记录在电脑上。
   *
   * 记录在客户端时电脑与手机各一份：电脑上打开的画布不在手机的页签中，手机发出的消息也不带该画布。
   * `panel_tabs` 为 `SharedPanelTab` 的 JSON 数组（不含 `workspaceId`），按打开顺序排列；页签数通常为个位数，
   * 整列读写。`viewing` 为最近在任一客户端的面板中显示的画布或文件，关闭该页签时清空。
   */
  sql: `
ALTER TABLE workspaces ADD COLUMN panel_tabs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspaces ADD COLUMN viewing TEXT;
`,
}
