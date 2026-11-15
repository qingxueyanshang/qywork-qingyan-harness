import type { Migration } from './shared.ts'

export const migration071: Migration = {
  id: 71,
  name: 'conversation_permission_mode',
  /**
   * 权限模式由会话保存，见 `Conversation.mode`。迁移无法读取配置，已有会话一律为 `auto`。
   * 子会话的该列不参与裁决：子会话按顶层会话的模式运行（`permissionModeOf`）。
   */
  sql: `ALTER TABLE conversations ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'auto' CHECK (permission_mode IN ('auto','full'));`,
}
