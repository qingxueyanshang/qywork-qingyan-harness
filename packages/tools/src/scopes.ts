/**
 * 记忆 / 技能 / MCP / 插件的三层作用域。
 *
 * 分层的原因：agent 会在多个工作区中运行。常用的记忆、技能、MCP 不应每切换一个仓库
 * 就重新配置一次，这些属于全局层。而某个项目的发版流程只属于该
 * 仓库，用于其他仓库只会造成误导，这些属于项目层。
 *
 * 三层的顺序即优先级：
 * | 层 | 位置 | 写入方 | 用户可见 |
 * |---|---|---|---|
 * | `builtin` | 随程序发布 | 无 | 不可见 |
 * | `project` | 工作区 `.agents/` | 用户 · AI 默认写入此层 | 可见 |
 * | `global` | `~/.qywork/` | 用户 · AI 仅在明确指定时写入 | 可见 |
 *
 * 项目层不称为「用户层」。它位于工作区中，随仓库存在；随用户存在的是
 * `global`。该词在其他工具中含义相反（通常家目录一层才称为 user），沿用会使读代码的人
 * 把 `.agents/` 误认作家目录。
 *
 * 优先级规则是不可写的层最高，而不是范围最具体的层最高。内置层不能覆盖项目层时，
 * 项目层就能静默替换系统自身的行为。
 *
 * 内置层目前没有内容（`roots.builtin` 为 null）。它不出现在任何界面上，
 * 因此不属于 B5 所说的空壳：空壳的定义是界面上有入口而没有数据源。
 *
 * 项目层使用 `.agents/` 而不是 `.qy/`：`.agents/` 是跨客户端约定（agentskills.io）。其他
 * CLI 无法读取 `~/.qywork/`，但能读取工作区中的这一份；只有这一层能在更换 CLI 后继续使用。
 * 其适用范围有限：只有遵循该约定的客户端能够读取，各客户端的私有目录不在此列。
 *
 * 解析规则只能有一份。设置页列出的条目必须就是 agent 实际加载的条目。因此加载器与界面
 * 共用本模块，界面不得另行扫描，否则菜单描述的是一个技能，执行的是另一个。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export type Scope = 'builtin' | 'project' | 'global'

/** 优先级从高到低。先认领的条目生效，后出现的同名条目被丢弃。 */
export const SCOPE_ORDER: readonly Scope[] = ['builtin', 'project', 'global']

/** 工作区中项目层根目录的名称。 */
export const AGENTS_DIR = '.agents'

export interface ScopeRoots {
  /** 随程序发布的目录，只读。尚无内容时为 null。 */
  builtin: string | null
  /** `<workspaceRoot>/.agents`。 */
  project: string
  /** `~/.qywork`（`configDir()`）。 */
  global: string
}

/**
 * 全局层的根目录：`~/.qywork`（可由 `QYWORK_HOME` 修改）。
 *
 * 此处是唯一的定义，`runtime` 的 `configDir()` 调用的就是本函数。配置文件与全局
 * 记忆 / 技能位于同一目录树下，两处分别计算路径时，修改环境变量后必然不一致。
 */
export function globalScopeRoot(): string {
  return process.env.QYWORK_HOME ?? join(homedir(), '.qywork')
}

/**
 * 工作区对应的三层根目录。
 *
 * `builtin` 目前恒为 null：尚无随程序发布的内容。有内容后只需修改此处。
 */
export function scopeRoots(workspaceRoot: string): ScopeRoots {
  return { builtin: null, project: join(workspaceRoot, AGENTS_DIR), global: globalScopeRoot() }
}

/** 某一层中某个子路径的绝对路径。`builtin` 没有根目录时返回 null。 */
export function scopeDir(roots: ScopeRoots, scope: Scope, sub: string): string | null {
  const root = scope === 'builtin' ? roots.builtin : roots[scope]
  return root === null ? null : join(root, sub)
}

/** 三层中存在的根目录，按优先级排序，用于遍历。 */
export function scopePaths(roots: ScopeRoots, sub: string): { scope: Scope; dir: string }[] {
  const out: { scope: Scope; dir: string }[] = []
  for (const scope of SCOPE_ORDER) {
    const dir = scopeDir(roots, scope, sub)
    if (dir !== null) out.push({ scope, dir })
  }
  return out
}

/** 一个条目及其是否被更高优先级的层覆盖。 */
export interface ScopedItem<T> {
  item: T
  /** 覆盖该条目的层。未被覆盖时为 null。 */
  shadowedBy: Scope | null
}

/**
 * 逐层扫描，返回全部条目，并标出被覆盖的条目。
 *
 * 这是唯一的遍历实现，`scanScoped` 由它派生。设置页按层分列，因此必须取得
 * 被覆盖的条目：去重后这些条目不再出现，而「在全局层修改后未生效」只能通过
 * 「该条目存在，但被项目层覆盖」来解释。
 *
 * 同名冲突在层内同样会发生（同一目录中不可能有两个同名子目录，但两个不同的
 * 技能可以在 frontmatter 中声明同一个 `name`）。因此按 `keyOf` 的结果判定，
 * 不按来源层判定：层只决定扫描的先后顺序。
 */
export async function scanAllScopes<T>(
  roots: ScopeRoots,
  sub: string,
  scan: (dir: string, scope: Scope) => Promise<T[]>,
  keyOf: (item: T) => string,
): Promise<ScopedItem<T>[]> {
  const owner = new Map<string, Scope>()
  const out: ScopedItem<T>[] = []
  for (const { scope, dir } of scopePaths(roots, sub)) {
    for (const item of await scan(dir, scope)) {
      const key = keyOf(item)
      const first = owner.get(key)
      if (first === undefined) {
        owner.set(key, scope)
        out.push({ item, shadowedBy: null })
      } else {
        out.push({ item, shadowedBy: first })
      }
    }
  }
  return out
}

/**
 * 逐层扫描，同名条目只保留优先级最高的一个。模型看到的就是该结果。
 *
 * 由 `scanAllScopes` 过滤得到，不另行遍历：两套遍历实现终将在某次改动中不一致，
 * 导致设置页列出的条目与模型加载的条目不同。
 */
export async function scanScoped<T>(
  roots: ScopeRoots,
  sub: string,
  scan: (dir: string, scope: Scope) => Promise<T[]>,
  keyOf: (item: T) => string,
): Promise<T[]> {
  const all = await scanAllScopes(roots, sub, scan, keyOf)
  return all.filter((x) => x.shadowedBy === null).map((x) => x.item)
}
