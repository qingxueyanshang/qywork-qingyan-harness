import type { Migration } from './shared.ts'

/** 带盘符的路径中 `/` 替换为 `\`，其余路径不变。判据与理由见迁移 55。 */
function windowsSeparators(path: string): string {
  return /^[A-Za-z]:/.test(path) ? path.replaceAll('/', '\\') : path
}

export const migration055: Migration = {
  id: 55,
  name: 'workspace_root_separator',
  /**
   * 工作区根路径按分隔符归一化，同一目录的重复行合并到最早创建的行。
   *
   * `root_path` 是 UNIQUE，但按字符串比较：`C:/x/ws` 与 `C:\x\ws` 指向同一目录却
   * 各占一行，该目录下的会话因此分散在两个项目中。此后的写入与按根路径查找都经由
   * `repos/workspaces.ts` 的 `normalizeWorkspaceRoot`。
   *
   * **本迁移只做分隔符归一化。** `path.resolve` 的基准是写入时的进程工作目录，对已写入
   * 的行无法复现，因此相对路径不合并；符号链接、盘符大小写、8.3 短名同样不合并。
   * 是否为 Windows 路径按盘符判定，不按运行平台：POSIX 上 `\` 是合法的文件名字符。
   *
   * 合并保留最早一行的全部字段（名字、置顶、`last_opened_at`、`removed_at`），
   * 其余行的会话、run、权限规则与审计、账目改为指向该行后删除。
   * `uq_permission_scope` 不允许一个工作区下有两条相同 scope 的规则，两行都有时保留最早一行的规则。
   */
  apply: (db) => {
    // 迁移只执行一次，语句使用 `prepare` 并在用完后 `finalize`。不要改为 `db.query`：它将语句
    // 永久缓存在连接上，占用的缓存槽位会使后续「写入失败 → 读取 → 事务」序列之后的
    // `close()` 无法完全释放，主库文件在进程退出前一直被占用。
    const keeper = new Map<string, string>()
    const merged: [string, string][] = []
    const renamed: [string, string][] = []
    const rowsStmt = db.prepare<{ id: string; root_path: string }, []>(
      'SELECT id, root_path FROM workspaces ORDER BY created_at ASC, id ASC',
    )
    const rows = rowsStmt.all()
    rowsStmt.finalize()
    for (const row of rows) {
      const root = windowsSeparators(row.root_path)
      const first = keeper.get(root)
      if (first === undefined) {
        keeper.set(root, row.id)
        if (root !== row.root_path) renamed.push([row.id, root])
      } else {
        merged.push([row.id, first])
      }
    }

    if (merged.length > 0) {
      const dropRules = db.prepare(
        `DELETE FROM permission_rules WHERE workspace_id = ?
             AND scope IN (SELECT scope FROM permission_rules WHERE workspace_id = ?)`,
      )
      const repoint = [
        'conversations',
        'runs',
        'permission_rules',
        'permission_audit',
        'usage_ledger',
      ].map((table) => db.prepare(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id = ?`))
      const dropWorkspace = db.prepare('DELETE FROM workspaces WHERE id = ?')
      for (const [from, to] of merged) {
        dropRules.run(from, to)
        for (const stmt of repoint) stmt.run(to, from)
        dropWorkspace.run(from)
      }
      for (const stmt of [dropRules, ...repoint, dropWorkspace]) stmt.finalize()
    }
    // 先删除重复行再改名：保留行的目标字符串可能正是某个重复行当前的值，
    // 顺序颠倒会触发 root_path 的 UNIQUE 冲突。
    if (renamed.length > 0) {
      const rename = db.prepare('UPDATE workspaces SET root_path = ? WHERE id = ?')
      for (const [id, root] of renamed) rename.run(root, id)
      rename.finalize()
    }

    const rootsStmt = db.prepare<{ workspace_root: string }, []>(
      'SELECT DISTINCT workspace_root FROM schedules',
    )
    const roots = rootsStmt.all()
    rootsStmt.finalize()
    const renameSchedule = db.prepare(
      'UPDATE schedules SET workspace_root = ? WHERE workspace_root = ?',
    )
    for (const row of roots) {
      const root = windowsSeparators(row.workspace_root)
      if (root === row.workspace_root) continue
      renameSchedule.run(root, row.workspace_root)
    }
    renameSchedule.finalize()
  },
}
