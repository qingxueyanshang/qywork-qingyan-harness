/**
 * 右侧面板中各客户端共享的页签与最近查看的文件（`workspaces.panel_tabs` / `workspaces.viewing`），按工作区记录。
 *
 * - 页签清单整列读写：页签数通常为个位数；bun:sqlite 同步执行，同一进程内的读改写不会交错。
 * - 同一 id 只有一页（id 由类型与对象确定，见 `sharedPanelTabId`），再次打开同一对象不新增。
 * - 关闭画布或文件页签时，该文件若是最近查看的文件则一并清空：页签已关闭，「这个画布」不再指它。
 */

import type { SharedPanelTab } from '@qywork/core'
import type { Store } from '../db.ts'

/** 落盘的页签：`SharedPanelTab` 去掉工作区，工作区由所在的行确定。 */
export type StoredPanelTab = { id: string; title: string } & (
  | { kind: 'canvas' | 'file'; path: string }
  | { kind: 'plugin'; workbench: string }
)

function parseTabs(raw: string | null | undefined): StoredPanelTab[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? (value as StoredPanelTab[]) : []
  } catch {
    // 该列只由本模块写入；无法解析时没有可恢复的页签。
    return []
  }
}

function readTabs(store: Store, workspaceId: string): StoredPanelTab[] {
  const row = store.db
    .query<{ panel_tabs: string }, [string]>('SELECT panel_tabs FROM workspaces WHERE id = ?')
    .get(workspaceId)
  return parseTabs(row?.panel_tabs)
}

function writeTabs(store: Store, workspaceId: string, tabs: readonly StoredPanelTab[]): void {
  store.db
    .query('UPDATE workspaces SET panel_tabs = ? WHERE id = ?')
    .run(JSON.stringify(tabs), workspaceId)
}

/** 全部未移除工作区的共享页签，按工作区内的打开顺序排列。 */
export function listPanelTabs(store: Store): SharedPanelTab[] {
  const rows = store.db
    .query<{ id: string; panel_tabs: string }, []>(
      `SELECT id, panel_tabs FROM workspaces WHERE removed_at IS NULL AND panel_tabs <> '[]'`,
    )
    .all()
  return rows.flatMap((row) =>
    parseTabs(row.panel_tabs).map((tab) => ({ ...tab, workspaceId: row.id }) as SharedPanelTab),
  )
}

/** 打开一页，追加到末尾。同一 id 已打开时不变。返回清单是否变化。 */
export function openPanelTab(store: Store, workspaceId: string, tab: StoredPanelTab): boolean {
  const tabs = readTabs(store, workspaceId)
  if (tabs.some((t) => t.id === tab.id)) return false
  writeTabs(store, workspaceId, [...tabs, tab])
  return true
}

/** 关闭一页；它是最近查看的文件时一并清空。返回清单是否变化。 */
export function closePanelTab(store: Store, workspaceId: string, id: string): boolean {
  const tabs = readTabs(store, workspaceId)
  const gone = tabs.find((t) => t.id === id)
  if (!gone) return false
  writeTabs(
    store,
    workspaceId,
    tabs.filter((t) => t !== gone),
  )
  if (gone.kind !== 'plugin') clearViewing(store, workspaceId, gone.path)
  return true
}

/** 记录最近查看的文件（工作区相对路径）。 */
export function setViewing(store: Store, workspaceId: string, path: string): void {
  store.db.query('UPDATE workspaces SET viewing = ? WHERE id = ?').run(path, workspaceId)
}

/** 最近查看的是 `path` 时清空；已是其他文件时不变。 */
export function clearViewing(store: Store, workspaceId: string, path: string): void {
  store.db
    .query('UPDATE workspaces SET viewing = NULL WHERE id = ? AND viewing = ?')
    .run(workspaceId, path)
}

/** 最近查看的文件；没有时为 `null`。 */
export function viewingOf(store: Store, workspaceId: string): string | null {
  const row = store.db
    .query<{ viewing: string | null }, [string]>('SELECT viewing FROM workspaces WHERE id = ?')
    .get(workspaceId)
  return row?.viewing ?? null
}
