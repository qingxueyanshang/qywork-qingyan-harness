import type { Migration } from './shared.ts'

export const migration039: Migration = {
  id: 39,
  name: 'subagent_kind',
  /**
   * 子会话的 `source` 改为记录子 agent 的种类：`role` / `temp` / `cli`。此前一律写
   * `workflow`，角色与临时子 agent 以 `source_ref` 是否为 `ad-hoc` 区分。
   * 新列 `external_session` 存储外部 CLI 的会话句柄，续接时传回该 CLI。
   */
  sql: `
ALTER TABLE conversations ADD COLUMN external_session TEXT;
UPDATE conversations SET source = 'temp', source_ref = NULL
  WHERE source = 'workflow' AND source_ref = 'ad-hoc';
UPDATE conversations SET source = 'role' WHERE source = 'workflow';
`,
}
