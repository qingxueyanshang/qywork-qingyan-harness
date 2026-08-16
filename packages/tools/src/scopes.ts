/**
 * 记忆 / 技能 / MCP / 插件的三层作用域。
 *
 * ## 为什么要分层
 *
 * 一个 agent 会跨很多个工作区跑。「我常用的那几条记忆、那几个技能、那个 MCP」
 * 不该每换一个仓库就重配一遍——那是全局层。而「这个项目怎么发版」只属于这个
 * 仓库，跟到别处去只会误导——那是用户层。
 *
 * ## 三层，顺序即优先级
 *
 * | 层 | 位置 | 谁写 | 用户可见 |
 * |---|---|---|---|
 * | `builtin` | 随程序发布 | 没人 | 不可见 |
 * | `user` | 工作区 `.agents/` | 你 · AI 默认写这里 | 可见 |
 * | `global` | `~/.qywork/` | 你 | 可见 |
 *
 * **规律是「谁不可写谁最高」，不是「谁具体谁最高」。** 内置压不住用户层的话，
 * 用户层就能悄悄替换掉系统自己的行为。
 *
 * 内置那层**今天还没有内容**（`roots.builtin` 为 null）。它不出现在任何界面上
 * ——本来就不可见——所以这不是 B5 说的空壳：空壳的定义是「界面上有、背后没有」。
 *
 * ## 为什么用户层是 `.agents/` 而不是 `.qy/`
 *
 * `.agents/` 是跨客户端约定（agentskills.io）。别的 CLI 读不到我们的 `~/.qywork/`，
 * 但读得到工作区里这一份——「换个 CLI 也能用」这件事只有这一层做得到。
 * **但它不是万能**：认这条约定的客户端才读得到，各家私有目录的一律读不到。
 *
 * ## 解析规则只能有一份
 *
 * 设置页列出来的那条，必须就是 agent 真正加载的那条。所以加载器和界面**共用
 * 这个模块**，界面不许自己再扫一遍——否则菜单描述的是一个技能，跑的是另一个。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export type Scope = 'builtin' | 'user' | 'global'

/** 优先级从高到低。**先认领的赢**，同名的后来者被丢掉。 */
export const SCOPE_ORDER: readonly Scope[] = ['builtin', 'user', 'global']

/** 工作区里的用户层根目录名。 */
export const AGENTS_DIR = '.agents'

export interface ScopeRoots {
  /** 随程序发布的那份，只读。还没有内容时是 null。 */
  builtin: string | null
  /** `<workspaceRoot>/.agents`。 */
  user: string
  /** `~/.qywork`（`configDir()`）。 */
  global: string
}

/**
 * 全局层的根：`~/.qywork`（`QYWORK_HOME` 可改）。
 *
 * **这里是唯一的定义**，`runtime` 的 `configDir()` 调的就是它。配置文件和全局
 * 记忆 / 技能躺在同一棵树下，两处各算一遍路径必然在某次改环境变量时漂开。
 */
export function globalScopeRoot(): string {
  return process.env.QYWORK_HOME ?? join(homedir(), '.qywork')
}

/**
 * 一个工作区对应的三层根。
 *
 * `builtin` 现在恒为 null——还没有随程序发布的内容。等有了，只需要改这一处。
 */
export function scopeRoots(workspaceRoot: string): ScopeRoots {
  return { builtin: null, user: join(workspaceRoot, AGENTS_DIR), global: globalScopeRoot() }
}

/** 某一层里某个子路径的绝对位置。`builtin` 没有根时返回 null。 */
export function scopeDir(roots: ScopeRoots, scope: Scope, sub: string): string | null {
  const root = scope === 'builtin' ? roots.builtin : roots[scope]
  return root === null ? null : join(root, sub)
}

/** 三层都存在的那些根，按优先级排好。用来遍历。 */
export function scopePaths(roots: ScopeRoots, sub: string): { scope: Scope; dir: string }[] {
  const out: { scope: Scope; dir: string }[] = []
  for (const scope of SCOPE_ORDER) {
    const dir = scopeDir(roots, scope, sub)
    if (dir !== null) out.push({ scope, dir })
  }
  return out
}

/**
 * 逐层扫，同名只留优先级最高的那个。
 *
 * **同名冲突在层内也会发生**（同一个目录里不可能有两个同名子目录，但两个不同的
 * 技能可以在 frontmatter 里声明同一个 `name`）。所以去重按 `keyOf` 的结果做，
 * 不是按「来自哪一层」——层只决定谁先被扫到。
 */
export async function scanScoped<T>(
  roots: ScopeRoots,
  sub: string,
  scan: (dir: string, scope: Scope) => Promise<T[]>,
  keyOf: (item: T) => string,
): Promise<T[]> {
  const seen = new Set<string>()
  const out: T[] = []
  for (const { scope, dir } of scopePaths(roots, sub)) {
    for (const item of await scan(dir, scope)) {
      const key = keyOf(item)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out
}
