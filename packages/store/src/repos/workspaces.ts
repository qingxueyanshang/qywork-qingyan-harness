/**
 * `workspaces` 表的读写，以及按会话解析其所在的工作区（`workspaceOf`）。
 */

import { resolve } from 'node:path'
import { type ConversationId, newWorkspaceId, type Workspace, type WorkspaceId } from '@qywork/core'
import type { Store } from '../db.ts'
import type { WorkspaceRow } from '../rows.ts'

/**
 * 工作区根路径的落盘形式：绝对路径 + 本平台分隔符。
 *
 * `root_path` 有 UNIQUE 约束，但按字符串比较。Windows 上同一目录写成 `C:/x/ws` 与
 * `C:\x\ws` 会各建一行，该目录下的会话因此分属两个项目。写入与按根目录查找
 * 都必须先经过本函数，`schedules.ts` 的 `workspace_root` 使用同一函数。
 *
 * 边界：不访问文件系统。符号链接、盘符大小写、8.3 短名不在规范化范围内。
 */
export function normalizeWorkspaceRoot(rootPath: string): string {
  return resolve(rootPath)
}

/**
 * 不存在时插入一行，已存在时更新 `last_opened_at` 与名称。
 *
 * 用一条语句完成，不要拆分为先 SELECT 再 INSERT：同一目录首次被两个进程同时打开时，
 * 两个进程都查询到不存在，后插入的一方触发 `root_path` 的 UNIQUE 冲突，启动随即失败。
 *
 * `removed_at` 一并清空：重新添加已移除的路径即恢复该项目，
 * 其会话随之回到列表，这些数据从未删除（见 `removeWorkspace`）。
 */
export function upsertWorkspace(store: Store, rootPath: string, name: string): Workspace {
  const now = Date.now()
  const row = store.db
    .query<WorkspaceRow, [string, string, string, number, number]>(
      `INSERT INTO workspaces (id, name, root_path, last_opened_at, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(root_path) DO UPDATE
         SET last_opened_at = excluded.last_opened_at, name = excluded.name, removed_at = NULL
       RETURNING *`,
    )
    .get(newWorkspaceId(), name, normalizeWorkspaceRoot(rootPath), now, now)
  if (!row) throw new Error('[QyWork] 写入工作区未返回行')
  return rowToWorkspace(row)
}

/**
 * 侧栏中的顺序：置顶的项目在前，其余按添加顺序排列。不含已移除的项目。
 *
 * 不按最近打开时间排序：按该时间排序时，每次切换都会把项目移到最前，
 * 与显式的置顶按钮作用重叠，且列表位置随切换变化，同一点击位置会对应不同项目。
 *
 * `pinned_at IS NULL` 作为第一排序键：SQLite 中 false(0) 排在 true(1) 之前，
 * 因此有置顶时间的项目排在最前，其间按置顶时间倒序（后置顶的在前）。
 *
 * 最近打开的项目由 `mostRecentWorkspace` 单独查询：它决定启动时打开哪个项目，
 * 与显示顺序是两个问题，合用一条查询会使列表顺序随切换变化。
 */
export function listWorkspaces(store: Store): Workspace[] {
  return store.db
    .query<WorkspaceRow, []>(
      `SELECT * FROM workspaces WHERE removed_at IS NULL
       ORDER BY pinned_at IS NULL, pinned_at DESC, created_at ASC, id ASC`,
    )
    .all()
    .map(rowToWorkspace)
}

/**
 * 最近打开的项目。用于确定启动时打开哪个项目，不用于显示顺序。
 *
 * 与 `listWorkspaces` 分开：显示顺序必须稳定，不随切换重排；
 * 上次使用的项目必须按 `last_opened_at` 确定。一条查询同时承担两个职责时，
 * 为记住启动项目，列表顺序也会随切换变化。
 */
export function mostRecentWorkspace(store: Store): Workspace | null {
  const row = store.db
    .query<WorkspaceRow, []>(
      `SELECT * FROM workspaces WHERE removed_at IS NULL
       ORDER BY last_opened_at DESC, id DESC LIMIT 1`,
    )
    .get()
  return row ? rowToWorkspace(row) : null
}

/**
 * 置顶 / 取消置顶。
 *
 * id 不存在或已处于目标状态时返回 false，由调用方返回 404。
 * 与 `removeWorkspace` 的约定相同：静默视为成功时，界面显示已生效，刷新后恢复原状。
 */
export function setWorkspacePinned(store: Store, id: WorkspaceId, pinned: boolean): boolean {
  const sql = pinned
    ? 'UPDATE workspaces SET pinned_at = ? WHERE id = ? AND pinned_at IS NULL'
    : 'UPDATE workspaces SET pinned_at = NULL WHERE id = ? AND pinned_at IS NOT NULL'
  const q = store.db.query(sql)
  return (pinned ? q.run(Date.now(), id) : q.run(id)).changes > 0
}

/**
 * 按路径查找工作区行。不过滤 `removed_at`：已移除的项目也必须能查询到。
 *
 * 用途：`upsertWorkspace` 会覆盖名称，而切换项目使用同一个
 * upsert。不先查询时，每次切换都会把用户设置的项目名重置为目录名。
 */
export function getWorkspaceByPath(store: Store, rootPath: string): Workspace | null {
  const row = store.db
    .query<WorkspaceRow, [string]>('SELECT * FROM workspaces WHERE root_path = ?')
    .get(normalizeWorkspaceRoot(rootPath))
  return row ? rowToWorkspace(row) : null
}

export function getWorkspace(store: Store, id: WorkspaceId): Workspace | null {
  const row = store.db
    .query<WorkspaceRow, [string]>('SELECT * FROM workspaces WHERE id = ?')
    .get(id)
  return row ? rowToWorkspace(row) : null
}

/**
 * 将项目从列表中移除，不修改任何数据。
 *
 * 写入 `removed_at` 标记，不执行 `DELETE`。该行必须保留：`conversations.workspace_id` 是
 * `ON DELETE CASCADE`，且 `workspaceOf` 需要 join 该行才能确定会话在哪个根目录下运行；
 * 删除该行后，其会话将无法打开。
 *
 * 因此移除只影响列表中是否显示（`listWorkspaces` 过滤该行），不影响读取
 * （`workspaceOf` / `getWorkspace` 不过滤）。重新添加同一路径即完整恢复：
 * `root_path` 有 UNIQUE 约束，`upsertWorkspace` 命中同一行并清除该标记。
 *
 * `usage_ledger` 不受影响：该表有意不设外键，本月花费不应因项目
 * 从列表中移除而减少（理由见迁移 3，`migrations/003-usage-ledger.ts`）。
 *
 * 返回是否实际改动了一行。id 不存在或已处于移除状态时返回 false，
 * 由调用方返回 404：静默视为成功时，界面显示已移除，刷新后该项目重新出现。
 */
export function removeWorkspace(store: Store, id: WorkspaceId): boolean {
  return (
    store.db
      .query('UPDATE workspaces SET removed_at = ? WHERE id = ? AND removed_at IS NULL')
      .run(Date.now(), id).changes > 0
  )
}

/**
 * 会话运行所在的目录。
 *
 * 本函数是会话根目录的唯一权威。服务进程不得自行持有 `workspaceRoot` 常量
 * （启动时的 `--cwd`）：否则一个进程只能服务一个项目，切换项目必须重启，
 * 且该常量本身就是这两张表的一份缓存。
 *
 * 未查到时返回 `null`，调用方必须停止：回退到默认根目录等于让 A 项目的
 * 会话在 B 项目的目录中运行命令，而工具的路径约束正是以该根目录为边界。
 */
export function workspaceOf(store: Store, id: ConversationId): Workspace | null {
  const row = store.db
    .query<WorkspaceRow, [string]>(
      `SELECT w.* FROM conversations c
       JOIN workspaces w ON w.id = c.workspace_id
       WHERE c.id = ?`,
    )
    .get(id)
  return row ? rowToWorkspace(row) : null
}

function rowToWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    name: r.name,
    rootPath: r.root_path,
    lastOpenedAt: r.last_opened_at,
    createdAt: r.created_at,
    // 在 exactOptionalPropertyTypes 下，键不存在与键值为 undefined 不同，
    // 因此先判断 null，再决定是否添加该键。
    ...(r.pinned_at === null || r.pinned_at === undefined ? {} : { pinnedAt: r.pinned_at }),
  }
}
